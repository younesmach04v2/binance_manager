import type { Api, AppEvent, IpcResult } from '@shared/api'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { DiscoveredServer, RemoteConfig, RemoteInfo, RemoteStatus, RemoteTestResult, Settings } from '@shared/types'

/**
 * `window.api` for builds without Electron (the Android app): every command is
 * sent to a Binance Manager server over HTTP, events arrive over a WebSocket,
 * and the connection details live in localStorage. Mirrors the desktop app's
 * client mode, so the React pages are identical.
 */

declare const __APP_VERSION__: string

const CONN_KEY = 'binance-manager.remote'
const SETTINGS_KEY = 'binance-manager.settings-cache'
const TIMEOUTS: Record<string, number> = {
  'trades:sync': 15 * 60_000,
  'rtrade:open': 90_000,
  'rtrade:close': 90_000,
  'rtrade:cancelEntry': 90_000,
  'rtrade:moveBE': 90_000,
  'rtrade:reduce': 90_000,
  'positions:reduce': 90_000,
  'portfolio:get': 60_000,
  'analytics:get': 60_000
}
const DEFAULT_TIMEOUT = 30_000

interface Conn {
  url: string
  token: string
}

export function normalizeUrl(raw: string): string {
  let u = raw.trim()
  if (!u) return ''
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`
  return u.replace(/\/+$/, '')
}

function loadConn(): Conn {
  try {
    const raw = localStorage.getItem(CONN_KEY)
    if (raw) {
      const c = JSON.parse(raw) as Partial<Conn>
      return { url: normalizeUrl(String(c.url ?? '')), token: String(c.token ?? '').trim() }
    }
  } catch {
    /* fall through */
  }
  return { url: '', token: '' }
}

function cacheSettings(s: unknown): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
  } catch {
    /* ignore */
  }
}

function cachedSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Settings) }
  } catch {
    /* ignore */
  }
  return DEFAULT_SETTINGS
}

export function createRemoteApi(platformName = 'android'): Api {
  let conn = loadConn()
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const emit = (channel: string, payload: unknown): void => {
    for (const cb of listeners.get(channel) ?? []) {
      try {
        cb(payload)
      } catch (e) {
        console.error(e)
      }
    }
  }

  // ---------------- live events over WebSocket ----------------
  let ws: WebSocket | null = null
  let closed = true
  let connected = false
  let lastError: string | null = null
  let serverInfo: RemoteInfo | null = null
  let lastEventAt: number | null = null
  let retry = 1000
  let timer: ReturnType<typeof setTimeout> | null = null

  const status = (): RemoteStatus => ({
    mode: 'client',
    server: null,
    client: {
      connected,
      url: conn.url,
      lastError,
      serverVersion: serverInfo?.version ?? null,
      serverMetered: serverInfo?.metered ?? null,
      serverTestnet: serverInfo?.testnet ?? null,
      lastEventAt
    }
  })
  const emitStatus = (): void => emit('remote:status', status())
  const fail = (msg: string): void => {
    if (lastError !== msg) {
      lastError = msg
      emitStatus()
    }
  }

  const open = (): void => {
    if (closed || !conn.url) return
    const w = new WebSocket(`${conn.url.replace(/^http/i, 'ws')}/events?token=${encodeURIComponent(conn.token)}`)
    ws = w
    w.onopen = () => {
      connected = true
      retry = 1000
      lastError = null
      emitStatus()
    }
    w.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as { channel: string; payload: unknown }
        lastEventAt = Date.now()
        if (msg.channel === 'remote:hello') {
          serverInfo = msg.payload as RemoteInfo
          emitStatus()
          return
        }
        if (msg.channel === 'settings:changed') cacheSettings(msg.payload)
        emit(msg.channel, msg.payload)
      } catch {
        /* ignore malformed frames */
      }
    }
    w.onerror = () => {
      if (!lastError) lastError = 'Cannot reach the server'
    }
    w.onclose = () => {
      if (ws === w) ws = null
      const was = connected
      connected = false
      if (was || lastError) emitStatus()
      if (!closed) {
        timer = setTimeout(open, retry)
        retry = Math.min(retry * 2, 30_000)
      }
    }
  }
  const connect = (): void => {
    closed = false
    open()
  }
  const disconnect = (): void => {
    closed = true
    if (timer) clearTimeout(timer)
    timer = null
    const w = ws
    ws = null
    if (w) {
      w.onopen = w.onmessage = w.onerror = w.onclose = null
      w.close()
    }
    serverInfo = null
    if (connected) {
      connected = false
      emitStatus()
    }
  }

  // ---------------- commands over HTTP ----------------
  async function call<T>(channel: string, args: unknown[]): Promise<T> {
    if (!conn.url) throw new Error('No server configured. Open Settings → Remote access.')
    const ctrl = new AbortController()
    const timeout = setTimeout(() => ctrl.abort(), TIMEOUTS[channel] ?? DEFAULT_TIMEOUT)
    let res: Response
    try {
      res = await fetch(`${conn.url}/rpc`, {
        method: 'POST',
        headers: { authorization: `Bearer ${conn.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ channel, args }),
        signal: ctrl.signal
      })
    } catch (e) {
      const msg = ctrl.signal.aborted ? 'timed out' : (e as Error).message
      fail(msg)
      throw new Error(`Cannot reach the server at ${conn.url}: ${msg}`)
    } finally {
      clearTimeout(timeout)
    }
    if (res.status === 401) {
      fail('Server rejected the pairing token')
      throw new Error('The server rejected the pairing token. Check it in Settings → Remote access.')
    }
    const body = (await res.json()) as IpcResult<T>
    if (!body.ok) {
      const err = new Error(body.error) as Error & { code?: number }
      err.code = body.code
      throw err
    }
    if (lastError) {
      lastError = null
      emitStatus()
    }
    return body.data
  }

  async function test(url: string, token: string): Promise<RemoteTestResult> {
    const base = normalizeUrl(url)
    if (!base) throw new Error('Enter the server address, e.g. 192.168.1.20:7777')
    const t0 = Date.now()
    const ctrl = new AbortController()
    const timeout = setTimeout(() => ctrl.abort(), 8000)
    try {
      const res = await fetch(`${base}/info`, { headers: { authorization: `Bearer ${token.trim()}` }, signal: ctrl.signal })
      if (res.status === 401) throw new Error('The server rejected the pairing token')
      if (!res.ok) throw new Error(`The server responded with HTTP ${res.status}`)
      const body = (await res.json()) as IpcResult<RemoteInfo>
      if (!body.ok) throw new Error(body.error)
      if (body.data?.name !== 'binance-manager') throw new Error('That address is not a Binance Manager server')
      return { ...body.data, latencyMs: Date.now() - t0 }
    } catch (e) {
      if (ctrl.signal.aborted) throw new Error('Connection timed out')
      throw e
    } finally {
      clearTimeout(timeout)
    }
  }

  const api: Api = {
    app: {
      info: async () => ({
        version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev',
        dataPath: conn.url ? `on the server at ${conn.url}` : 'on the server',
        platform: platformName
      }),
      openExternal: async (url) => {
        window.open(url, '_blank')
      }
    },
    settings: {
      get: async () => {
        try {
          const s = await call<Settings>('settings:get', [])
          cacheSettings(s)
          return s
        } catch {
          return cachedSettings()
        }
      },
      set: async (patch) => {
        const s = await call<Settings>('settings:set', [patch])
        cacheSettings(s)
        return s
      }
    },
    keys: {
      status: () => call('keys:status', []),
      save: (apiKey, apiSecret) => call('keys:save', [apiKey, apiSecret]),
      clear: () => call('keys:clear', []),
      test: () => call('keys:test', [])
    },
    account: { balances: () => call('account:balances', []) },
    portfolio: {
      get: () => call('portfolio:get', []),
      history: (since) => call('portfolio:history', [since])
    },
    trades: {
      sync: (symbols) => call('trades:sync', [symbols]),
      list: () => call('trades:list', []),
      discoverSymbols: () => call('trades:discoverSymbols', []),
      clear: () => call('trades:clear', [])
    },
    journal: {
      update: (tradeId, patch) => call('journal:update', [tradeId, patch]),
      tags: () => call('journal:tags', [])
    },
    analytics: { get: () => call('analytics:get', []) },
    orders: {
      place: (req) => call('orders:place', [req]),
      open: (symbol) => call('orders:open', [symbol]),
      cancel: (symbol, orderId, orderListId) => call('orders:cancel', [symbol, orderId, orderListId]),
      history: (symbol) => call('orders:history', [symbol])
    },
    market: {
      symbol: (symbol) => call('market:symbol', [symbol]),
      symbols: () => call('market:symbols', []),
      ticker24h: (symbols) => call('market:ticker24h', [symbols]),
      klines: (symbol, interval, limit) => call('market:klines', [symbol, interval, limit]),
      prices: (symbols) => call('market:prices', [symbols])
    },
    bots: {
      list: () => call('bots:list', []),
      save: (bot) => call('bots:save', [bot]),
      remove: (id) => call('bots:remove', [id]),
      runNow: (id) => call('bots:runNow', [id]),
      log: () => call('bots:log', []),
      clearLog: () => call('bots:clearLog', [])
    },
    positions: {
      list: () => call('positions:list', []),
      close: (req) => call('positions:close', [req]),
      reduce: (req) => call('positions:reduce', [req])
    },
    rtrade: {
      preview: (req) => call('rtrade:preview', [req]),
      open: (req) => call('rtrade:open', [req]),
      adopt: (req) => call('rtrade:adopt', [req]),
      list: () => call('rtrade:list', []),
      moveBE: (id) => call('rtrade:moveBE', [id]),
      reduce: (id, by) => call('rtrade:reduce', [id, by]),
      close: (id) => call('rtrade:close', [id]),
      cancelEntry: (id) => call('rtrade:cancelEntry', [id]),
      release: (id) => call('rtrade:release', [id]),
      remove: (id) => call('rtrade:remove', [id])
    },
    remote: {
      get: async (): Promise<RemoteConfig> => ({ mode: 'client', server: { port: 7777, token: '' }, client: { ...conn, altUrls: [] } }),
      // A browser cannot enumerate this device's network interfaces, so it has no subnet to sweep.
      discover: async (): Promise<DiscoveredServer[]> => {
        throw new Error('Searching the network works in the desktop app. Here, enter the address shown on the server.')
      },
      set: async (patch) => {
        if (patch.mode && patch.mode !== 'client') throw new Error('A phone can only be a client. Run the server on a computer that stays on.')
        if (patch.client) {
          disconnect()
          conn = {
            url: normalizeUrl(String(patch.client.url ?? conn.url)),
            token: String(patch.client.token ?? conn.token).trim()
          }
          localStorage.setItem(CONN_KEY, JSON.stringify(conn))
          lastError = null
          if (conn.url) connect()
          emitStatus()
        }
        return api.remote.get()
      },
      status: async () => status(),
      test,
      regenerateToken: async () => {
        throw new Error('The pairing token is generated on the server')
      }
    },
    on: (channel: AppEvent, cb) => {
      let set = listeners.get(channel)
      if (!set) {
        set = new Set()
        listeners.set(channel, set)
      }
      set.add(cb)
      return () => {
        set?.delete(cb)
      }
    }
  }

  if (conn.url) connect()
  // Phones suspend sockets in the background; reconnect promptly when the app is back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && conn.url && !closed && !connected) {
      if (timer) clearTimeout(timer)
      retry = 1000
      open()
    }
  })
  return api
}
