import { NodeJS } from 'capacitor-nodejs'
import { api } from './api'
import { KeepAlive, type KeepAliveStatus } from './native'

/**
 * The built-in server: the same headless Node.js server, running inside the
 * Android app on an embedded Node runtime, kept alive by a foreground service.
 * The UI then connects to it on 127.0.0.1 exactly like to any other server.
 *
 * Node can be started only once per app process, while Android may recreate
 * the screen (and this JavaScript) many times during that process's life. So
 * before starting the engine we probe the local port with the saved token; if
 * the server answers, it is already running and we just connect. Readiness is
 * taken from the server's own `server:ready` announcement or from the probe,
 * never from the plugin's whenReady(), which only knows about engines started
 * by the current screen.
 */

const FLAG_KEY = 'binance-manager.embedded'
const INFO_KEY = 'binance-manager.embedded.info'
const DEFAULT_PORT = 7777

export interface EmbeddedInfo {
  port: number
  token: string
  addresses: string[]
  version: string
}

let info: EmbeddedInfo | null = null
let starting: Promise<EmbeddedInfo> | null = null

export function embeddedEnabled(): boolean {
  try {
    return localStorage.getItem(FLAG_KEY) === '1'
  } catch {
    return false
  }
}

export function embeddedInfo(): EmbeddedInfo | null {
  if (info) return info
  try {
    const raw = localStorage.getItem(INFO_KEY)
    if (raw) return JSON.parse(raw) as EmbeddedInfo
  } catch {
    /* ignore */
  }
  return null
}

function remember(i: EmbeddedInfo): void {
  info = i
  try {
    localStorage.setItem(INFO_KEY, JSON.stringify(i))
  } catch {
    /* ignore */
  }
}

/** Is a Binance Manager server answering on this port with this token? */
async function probe(i: EmbeddedInfo, timeoutMs = 1500): Promise<boolean> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`http://127.0.0.1:${i.port}/info`, { headers: { authorization: `Bearer ${i.token}` }, signal: ctrl.signal })
    if (!res.ok) return false
    const body = (await res.json()) as { ok: boolean; data?: { name?: string } }
    return body.ok && body.data?.name === 'binance-manager'
  } catch {
    return false
  } finally {
    clearTimeout(t)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Resolve with the server's announcement (port, token, addresses). */
function waitForAnnouncement(timeoutMs: number): Promise<EmbeddedInfo> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The built-in server did not start within ${timeoutMs / 1000}s`)), timeoutMs)
    void NodeJS.addListener('server:ready', (event) => {
      const payload = (event.args?.[0] ?? null) as EmbeddedInfo | null
      if (!payload || !payload.token) return
      clearTimeout(timer)
      resolve(payload)
    })
  })
}

/** Start the Node engine if it is not already running and return its port and pairing token. */
export async function startEmbeddedServer(): Promise<EmbeddedInfo> {
  if (starting) return starting
  starting = (async () => {
    const log = (...a: unknown[]): void => console.info('[embedded]', ...a)
    const saved = embeddedInfo()
    log('start requested; saved =', saved ? `${saved.port}` : 'none')
    if (saved) {
      // A previous screen may have started it in this same process: give it a few tries.
      for (let attempt = 0; attempt < 3; attempt++) {
        if (await probe(saved)) {
          log('already running on', saved.port)
          info = saved
          return saved
        }
        await sleep(700)
      }
    }
    const announced = waitForAnnouncement(45_000)
    announced.then((i) => log('announcement received: port', i.port), () => undefined)
    // Process-wide guard (survives screen recreation): never call NodeJS.start() twice in one process.
    const { started } = await KeepAlive.engineStarted().catch(() => ({ started: false }))
    if (started) {
      log('engine already started in this process; waiting for it to answer')
    } else {
      await KeepAlive.markEngineStarted().catch(() => undefined)
      // The plugin's start() promise only settles when the Node program ends, which for a server is never:
      // do not await it. Readiness comes from the server's announcement and the port probe below.
      NodeJS.start()
        .then(() => log('the embedded server process ended'))
        .catch((e: Error) => log('NodeJS.start rejected:', e.message))
      log('NodeJS.start requested')
    }
    // Ask a possibly already-running engine to announce itself again; harmless if it is just starting.
    try {
      await NodeJS.send({ eventName: 'server:info', args: [] })
      log('server:info sent')
    } catch (e) {
      log('server:info not sent:', (e as Error).message)
    }
    // Whichever comes first: the announcement, or a known port answering (saved details, else the default port
    // with the token the server keeps on disk, which the announcement will also carry).
    const fallback = saved ?? (started ? { port: DEFAULT_PORT, token: '', addresses: [], version: '' } : null)
    const viaProbe = fallback
      ? (async () => {
          for (;;) {
            await sleep(1000)
            if (fallback.token && (await probe(fallback))) return fallback
          }
        })()
      : new Promise<EmbeddedInfo>(() => undefined)
    const i = await Promise.race([announced, viaProbe])
    // Make sure the HTTP side is really up before handing it to the UI.
    let up = false
    for (let attempt = 0; attempt < 20 && !up; attempt++) {
      up = await probe(i)
      if (!up) await sleep(500)
    }
    log('http probe', up ? 'ok' : 'FAILED', 'on port', i.port)
    remember(i)
    return i
  })()
  try {
    return await starting
  } finally {
    starting = null
  }
}

/** Point the UI's remote connection at the built-in server. */
async function connectLocally(i: EmbeddedInfo): Promise<void> {
  const cfg = await api.remote.get()
  const url = `http://127.0.0.1:${i.port}`
  if (cfg.client.url !== url || cfg.client.token !== i.token) {
    await api.remote.set({ mode: 'client', client: { url, altUrls: [], token: i.token } })
  }
}

/** Turn the built-in server on: notification permission, foreground service, Node engine, local connection. */
export async function enableEmbedded(): Promise<{ info: EmbeddedInfo; keepAlive: KeepAliveStatus }> {
  await KeepAlive.requestNotifications().catch(() => ({ granted: false }))
  const keepAlive = await KeepAlive.start()
  console.info('[embedded] foreground service:', keepAlive.running ? 'running' : 'not running')
  const i = await startEmbeddedServer()
  await connectLocally(i)
  console.info('[embedded] connected locally to port', i.port)
  localStorage.setItem(FLAG_KEY, '1')
  return { info: i, keepAlive }
}

/** Turn it off: the foreground service stops; the Node engine ends when Android closes the app process. */
export async function disableEmbedded(): Promise<KeepAliveStatus> {
  localStorage.removeItem(FLAG_KEY)
  return KeepAlive.stop()
}

/** At app start: if the built-in server was enabled before, bring it back (after a reboot or a relaunch). */
export async function ensureEmbeddedRunning(): Promise<void> {
  if (!embeddedEnabled()) return
  try {
    await KeepAlive.start()
    const i = await startEmbeddedServer()
    await connectLocally(i)
  } catch (e) {
    console.error('[embedded] could not resume the built-in server:', (e as Error).message)
  }
}

export function keepAliveStatus(): Promise<KeepAliveStatus> {
  return KeepAlive.status()
}

export function requestBatteryExemption(): Promise<KeepAliveStatus> {
  return KeepAlive.requestBatteryExemption()
}

export { DEFAULT_PORT }
