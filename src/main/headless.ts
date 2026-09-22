/**
 * Headless server entry point: the same services as the desktop app, without a
 * window. Run it on the machine that stays on; desktop and mobile clients
 * connect to it. Bundled by `npm run build:headless` into one file.
 *
 *   node binance-manager-server.js                 start (default port 7777)
 *   node binance-manager-server.js run --port 7799 start on another port
 *   node binance-manager-server.js keys            store Binance API keys (prompts)
 *   node binance-manager-server.js keys --status   show whether keys are stored
 *   node binance-manager-server.js keys --clear    remove stored keys
 *   node binance-manager-server.js token           print the pairing token
 *   node binance-manager-server.js token --new     generate a new pairing token
 *   node binance-manager-server.js settings --testnet on|off --automation on|off
 *
 * Environment: BINANCE_MANAGER_DATA (data folder, default ~/.binance-manager),
 * BINANCE_MANAGER_PASSPHRASE (derive the key-encryption key from a passphrase
 * instead of the generated master.key file).
 */
import { join } from 'node:path'
import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import type { BotLogEntry, RemoteStatus } from '../shared/types'
import { invokeLocal, isRemoteChannel, noteRemoteSettings, registerCommands, remoteInfo } from './commands'
import { getClient } from './context'
import { platform, setPlatform } from './platform'
import { nodePlatform } from './platform/node'
import { remote } from './remote'
import { automation } from './services/automation'
import { dataDir, db } from './store/db'
import { clearKeys, keyStatus, saveKeys } from './store/secrets'

/**
 * Inside the Android app the server runs on an embedded Node.js (nodejs-mobile).
 * The `bridge` module exists only there: it gives a writable data folder and a
 * message channel to the app's UI.
 */
interface MobileBridge {
  channel: { send(event: string, ...args: unknown[]): void; on(event: string, cb: (...args: unknown[]) => void): void }
  getDataPath(): string
}
function loadBridge(): MobileBridge | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('bridge') as MobileBridge
  } catch {
    return null
  }
}
const bridge = loadBridge()
if (bridge && !process.env.BINANCE_MANAGER_DATA) process.env.BINANCE_MANAGER_DATA = join(bridge.getDataPath(), 'binance-manager')

setPlatform(nodePlatform)

const args = process.argv.slice(2)
const command = args.find((a) => !a.startsWith('-')) ?? 'run'
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const has = (name: string): boolean => args.includes(name)
const ts = (): string => new Date().toISOString().replace('T', ' ').slice(0, 19)
const log = (...a: unknown[]): void => console.log(`[${ts()}]`, ...a)

let lastClients = -1
function onEvent(channel: string, payload: unknown): void {
  switch (channel) {
    case 'bot:log': {
      const e = payload as BotLogEntry
      log(`[bot ${e.botName}] ${e.level.toUpperCase()}: ${e.message}`)
      break
    }
    case 'remote:status': {
      const s = payload as RemoteStatus
      if (s.server?.running && s.server.clients !== lastClients) {
        if (lastClients >= 0) log(`clients connected: ${s.server.clients}`)
        lastClients = s.server.clients
      }
      break
    }
    case 'settings:changed':
      noteRemoteSettings(payload)
      log('settings changed')
      break
    case 'rtrade:changed':
      log('managed positions updated')
      break
    default:
      break
  }
}

async function run(): Promise<void> {
  const portFlag = flag('--port')
  const port = portFlag ? parseInt(portFlag, 10) : undefined
  if (portFlag && (!port || port < 1 || port > 65535)) throw new Error(`Invalid port ${portFlag}`)

  await remote.start({ invoke: invokeLocal, isRemoteChannel, info: remoteInfo, onEvent })
  const cfg = remote.getConfig()
  if (cfg.mode !== 'server' || (port !== undefined && port !== cfg.server.port)) {
    await remote.setConfig({ mode: 'server', server: { port: port ?? cfg.server.port, token: cfg.server.token } })
  }
  const st = remote.status()
  if (!st.server?.running) throw new Error(`Server did not start: ${st.server?.error ?? 'unknown error'}`)

  const settings = db.getSettings()
  const ks = keyStatus()
  log(`Binance Manager headless server ${platform().version()}`)
  log(`data folder: ${dataDir()}`)
  log(`listening on port ${st.server.port}` + (st.server.addresses.length ? ` (${st.server.addresses.map((a) => `${a}:${st.server?.port}`).join(', ')})` : ''))
  log(`pairing token: ${remote.getConfig().server.token}`)
  log(ks.hasKeys ? `API keys: ${ks.apiKeyPreview}` : 'API keys: none yet. Run "keys" here, or add them from a client in Settings.')
  log(`environment: ${settings.testnet ? 'TESTNET' : 'LIVE'} · automation master switch: ${settings.automationEnabled ? 'on' : 'off'}`)
  if (bridge) {
    // Tell the app's UI where to connect, now and whenever it asks again (e.g. after the screen was recreated).
    const announce = (): void => {
      const s = remote.status()
      bridge.channel.send('server:ready', {
        port: s.server?.port ?? remote.getConfig().server.port,
        token: remote.getConfig().server.token,
        addresses: s.server?.addresses ?? [],
        version: platform().version()
      })
    }
    bridge.channel.on('server:info', announce)
    announce()
    log('embedded mode: announced to the app UI')
  } else {
    log('press Ctrl+C to stop')
  }

  automation.start()

  let stopping = false
  const stop = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    log('shutting down')
    automation.stop()
    await remote.stop()
    process.exit(0)
  }
  process.on('SIGINT', () => void stop())
  process.on('SIGTERM', () => void stop())
}

async function keys(): Promise<void> {
  if (has('--status')) {
    const ks = keyStatus()
    console.log(ks.hasKeys ? `keys stored: ${ks.apiKeyPreview}` : 'no keys stored')
    return
  }
  if (has('--clear')) {
    clearKeys()
    console.log('keys removed')
    return
  }
  const [apiKey, secret] = await readKeyAndSecret()
  if (!apiKey || !secret) throw new Error('Both the API key and the secret are required')
  saveKeys(apiKey, secret)
  console.log(`keys saved (${keyStatus().apiKeyPreview}) in ${platform().userDir()}`)
  if (!has('--no-test')) {
    try {
      const a = await getClient().account()
      console.log(`connection OK: ${a.accountType} account, canTrade=${a.canTrade}, canWithdraw=${a.canWithdraw}, ${a.balances.length} assets with balance`)
      if (a.canWithdraw) console.log('WARNING: this key can withdraw. Disable withdrawals in Binance API Management.')
    } catch (e) {
      console.error(`connection test failed: ${(e as Error).message}`)
      process.exitCode = 1
    }
  }
}

/** Interactive prompts on a terminal; two lines from stdin when piped (e.g. from a secrets manager). */
async function readKeyAndSecret(): Promise<[string, string]> {
  if (!stdin.isTTY) {
    const text = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = []
      stdin.on('data', (c: Buffer) => chunks.push(c))
      stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      stdin.on('error', reject)
    })
    const lines = text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
    return [lines[0] ?? '', lines[1] ?? '']
  }
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    const apiKey = (await rl.question('Binance API key: ')).trim()
    const secret = (await rl.question('Binance API secret (typed text is visible): ')).trim()
    return [apiKey, secret]
  } finally {
    rl.close()
  }
}

async function token(): Promise<void> {
  if (has('--new')) {
    await remote.regenerateToken()
    console.log('new pairing token generated; clients must enter it again')
  }
  console.log(remote.getConfig().server.token)
}

function settings(): void {
  const onOff = (v: string | undefined, name: string): boolean | undefined => {
    if (v === undefined) return undefined
    if (v === 'on' || v === 'true') return true
    if (v === 'off' || v === 'false') return false
    throw new Error(`--${name} expects on or off`)
  }
  const patch: Record<string, boolean> = {}
  const t = onOff(flag('--testnet'), 'testnet')
  const a = onOff(flag('--automation'), 'automation')
  if (t !== undefined) patch.testnet = t
  if (a !== undefined) patch.automationEnabled = a
  const s = Object.keys(patch).length ? db.setSettings(patch) : db.getSettings()
  console.log(`environment: ${s.testnet ? 'TESTNET' : 'LIVE'}`)
  console.log(`automation master switch: ${s.automationEnabled ? 'on' : 'off'}`)
  console.log(`quote asset: ${s.quoteAsset}`)
}

function usage(): void {
  console.log(`Binance Manager headless server ${platform().version()}

  run [--port N]                         start the server (default)
  keys [--status | --clear | --no-test]  store, show or remove the Binance API keys
  token [--new]                          print (or regenerate) the pairing token
  settings [--testnet on|off] [--automation on|off]

Data: ${platform().userDir()}  (override with BINANCE_MANAGER_DATA)`)
}

async function main(): Promise<void> {
  registerCommands()
  switch (command) {
    case 'run':
      return run()
    case 'keys':
      return keys()
    case 'token':
      return token()
    case 'settings':
      return settings()
    case 'help':
    case '--help':
    case '-h':
      return usage()
    default:
      usage()
      throw new Error(`Unknown command "${command}"`)
  }
}

main().catch((e: Error) => {
  console.error(`error: ${e.message}`)
  process.exit(1)
})
