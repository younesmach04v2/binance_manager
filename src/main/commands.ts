import type { IpcResult } from '../shared/api'
import type { AccountSummary, AdoptRequest, Bot, ClosePositionRequest, OrderRequest, ReduceBy, ReducePositionRequest, RemoteConfig, RemoteInfo, RTradeRequest, Settings } from '../shared/types'
import { broadcast, getClient, invalidateClient } from './context'
import { platform } from './platform'
import { remote } from './remote'
import { automation } from './services/automation'
import { cancelOrder, placeOrder } from './services/orders'
import { buildPortfolio } from './services/portfolio'
import { closeExchangePosition, listExchangePositions, reduceExchangePosition } from './services/positions'
import { adoptPosition, cancelEntry, closeNow, listTrades as listManaged, moveStopUp, openRTrade, previewRTrade, reducePosition, releaseTrade, removeTrade } from './services/rtrade'
import { allTags, allTrades, computeAnalytics, discoverSymbols, listTrades, syncTrades, updateJournal } from './services/trades'
import { isMetered } from './metered'
import { dataDir, db } from './store/db'
import { clearKeys, keyStatus, saveKeys } from './store/secrets'

/**
 * Every command the UI can issue, by channel name. The Electron app wires this
 * registry to IPC; the remote server exposes it over HTTP; the headless server
 * uses it without any UI at all.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (...args: any[]) => unknown

const registry = new Map<string, Handler>()

/** Channels that always run on the machine the user is sitting at and are never forwarded to a server. */
const LOCAL_ONLY = new Set(['app:info', 'app:openExternal', 'remote:get', 'remote:set', 'remote:status', 'remote:test', 'remote:discover', 'remote:regenerateToken'])

function handle(channel: string, fn: Handler): void {
  registry.set(channel, fn)
}

export function channels(): Iterable<string> {
  return registry.keys()
}

export function isRemoteChannel(channel: string): boolean {
  return registry.has(channel) && !LOCAL_ONLY.has(channel)
}

/** Run a command on this machine, wrapping failures as { ok: false, error }. */
export async function invokeLocal(channel: string, args: unknown[]): Promise<IpcResult<unknown>> {
  const fn = registry.get(channel)
  if (!fn) return { ok: false, error: `Unknown command ${channel}` }
  try {
    return { ok: true, data: await fn(...args) }
  } catch (e) {
    const err = e as Error & { code?: number }
    console.error(`[cmd] ${channel} failed:`, err.message)
    return { ok: false, error: err.message || String(e), code: err.code }
  }
}

// In client mode the UI shows the server's settings; keep the last copy so the app still renders when the server is down.
let lastRemoteSettings: Settings | null = null
export function noteRemoteSettings(s: unknown): void {
  if (s && typeof s === 'object') lastRemoteSettings = s as Settings
}

/** Run locally, or forward to the server when this machine is a client. */
export async function dispatch(channel: string, args: unknown[]): Promise<IpcResult<unknown>> {
  if (remote.mode() === 'client' && isRemoteChannel(channel)) {
    const res = await remote.call(channel, args)
    if (channel === 'settings:get' || channel === 'settings:set') {
      if (res.ok) noteRemoteSettings(res.data)
      else if (channel === 'settings:get') return { ok: true, data: lastRemoteSettings ?? db.getSettings() }
    }
    return res
  }
  return invokeLocal(channel, args)
}

export function remoteInfo(): RemoteInfo {
  return {
    name: 'binance-manager',
    version: platform().version(),
    mode: remote.mode(),
    testnet: db.getSettings().testnet,
    hasKeys: keyStatus().hasKeys,
    metered: isMetered(),
    time: Date.now()
  }
}

const testnet = (): boolean => db.getSettings().testnet

export function registerCommands(): void {
  if (registry.size > 0) return

  // ---- app (always local) ----
  handle('app:info', () => ({ version: platform().version(), dataPath: dataDir(), platform: process.platform }))
  handle('app:openExternal', (url: string) => {
    if (/^https?:\/\//i.test(url)) return platform().openExternal(url)
    throw new Error('Only http(s) links can be opened')
  })

  // ---- remote access (always local) ----
  handle('remote:get', () => remote.getConfig())
  handle('remote:set', (patch: Partial<RemoteConfig>) => remote.setConfig(patch))
  handle('remote:status', () => remote.status())
  handle('remote:test', (url: string, token: string) => remote.test(url, token))
  handle('remote:discover', (token: string, ports?: number[]) => remote.discover(token, ports))
  handle('remote:regenerateToken', () => remote.regenerateToken())

  // ---- settings & keys ----
  handle('settings:get', () => db.getSettings())
  handle('settings:set', (patch: Partial<Settings>) => {
    const next = db.setSettings(patch)
    invalidateClient()
    broadcast('settings:changed', next)
    return next
  })
  handle('keys:status', () => keyStatus())
  handle('keys:save', (apiKey: string, apiSecret: string) => {
    if (!apiKey?.trim() || !apiSecret?.trim()) throw new Error('Both the API key and secret are required')
    saveKeys(apiKey, apiSecret)
    invalidateClient()
    return keyStatus()
  })
  handle('keys:clear', () => {
    clearKeys()
    invalidateClient()
    return keyStatus()
  })
  handle('keys:test', async (): Promise<AccountSummary> => {
    const client = getClient()
    const [a, r] = await Promise.all([client.account(), client.apiRestrictions()])
    return {
      canTrade: a.canTrade,
      canWithdraw: a.canWithdraw,
      canDeposit: a.canDeposit,
      accountType: a.accountType,
      permissions: a.permissions,
      updateTime: a.updateTime,
      balances: a.balances.length,
      keyRestrictions: r
        ? {
            ipRestrict: r.ipRestrict,
            enableReading: r.enableReading,
            enableSpotTrading: r.enableSpotAndMarginTrading,
            enableWithdrawals: r.enableWithdrawals,
            enableFutures: r.enableFutures,
            tradingAuthorityExpiration: r.tradingAuthorityExpirationTime ?? null
          }
        : null
    }
  })

  // ---- portfolio ----
  handle('account:balances', async () => {
    const a = await getClient().account()
    const out: Record<string, { free: number; locked: number }> = {}
    for (const b of a.balances) out[b.asset] = { free: parseFloat(b.free), locked: parseFloat(b.locked) }
    return out
  })
  handle('portfolio:get', () => buildPortfolio(getClient(), db.getSettings()))
  handle('portfolio:history', (since?: number) => {
    const pts = db.history(testnet()).get()
    return typeof since === 'number' && since > 0 ? pts.filter((p) => p.t > since) : pts
  })

  // ---- trades & journal ----
  handle('trades:sync', async (symbols?: string[]) => {
    const settings = db.getSettings()
    const client = getClient()
    const list = symbols?.length ? symbols : await discoverSymbols(client, settings)
    return syncTrades(client, settings.testnet, list)
  })
  handle('trades:list', () => listTrades(testnet()))
  handle('trades:discoverSymbols', () => discoverSymbols(getClient(), db.getSettings()))
  handle('trades:clear', () => {
    db.trades(testnet()).set({})
  })
  handle('journal:update', (tradeId: number, patch: { tags?: string[]; note?: string }) => updateJournal(testnet(), tradeId, patch))
  handle('journal:tags', () => allTags(testnet()))

  // ---- analytics ----
  handle('analytics:get', async () => {
    const settings = db.getSettings()
    let prices = new Map<string, number>()
    try {
      prices = await getClient().allPrices()
    } catch (e) {
      console.warn('[analytics] prices unavailable, fee conversion approximate:', (e as Error).message)
    }
    return computeAnalytics(allTrades(settings.testnet), db.journal(settings.testnet).get(), settings.quoteAsset, prices)
  })

  // ---- orders ----
  handle('orders:place', (req: OrderRequest) => placeOrder(getClient(), req))
  handle('orders:open', (symbol?: string) => getClient().openOrders(symbol))
  handle('orders:cancel', (symbol: string, orderId: number, orderListId?: number) => cancelOrder(getClient(), symbol, orderId, orderListId))
  handle('orders:history', (symbol: string) => getClient().allOrders(symbol, 200))

  // ---- market data ----
  handle('market:symbol', (symbol: string) => getClient().symbolInfo(symbol))
  handle('market:symbols', async () => {
    const info = await getClient().exchangeInfo()
    return Array.from(info.values())
      .filter((s) => s.status === 'TRADING')
      .map((s) => s.symbol)
      .sort()
  })
  handle('market:ticker24h', (symbols: string[]) => getClient().ticker24h(symbols))
  handle('market:klines', (symbol: string, interval: string, limit?: number) => getClient().klines(symbol, interval, limit))
  handle('market:prices', async (symbols: string[]) => {
    const all = await getClient().allPrices()
    const out: Record<string, number> = {}
    for (const s of symbols) {
      const p = all.get(s)
      if (p !== undefined) out[s] = p
    }
    return out
  })

  // ---- R-multiple quick trades ----
  handle('rtrade:preview', (req: RTradeRequest) => previewRTrade(getClient(), req))
  handle('rtrade:open', (req: RTradeRequest) => openRTrade(getClient(), testnet(), req))
  handle('rtrade:adopt', (req: AdoptRequest) => adoptPosition(getClient(), testnet(), req))
  handle('rtrade:list', () => listManaged(testnet()))

  // ---- all open positions on the exchange (holdings + their open orders) ----
  handle('positions:list', () => listExchangePositions(getClient(), db.getSettings()))
  handle('positions:close', async (req: ClosePositionRequest) => {
    const r = await closeExchangePosition(getClient(), req)
    broadcast('rtrade:changed')
    return r
  })
  handle('positions:reduce', async (req: ReducePositionRequest) => {
    const r = await reduceExchangePosition(getClient(), req)
    broadcast('rtrade:changed')
    return r
  })
  handle('rtrade:moveBE', (id: string) => moveStopUp(getClient(), testnet(), id))
  handle('rtrade:reduce', (id: string, by: ReduceBy) => reducePosition(getClient(), testnet(), id, by))
  handle('rtrade:close', (id: string) => closeNow(getClient(), testnet(), id))
  handle('rtrade:cancelEntry', (id: string) => cancelEntry(getClient(), testnet(), id))
  handle('rtrade:release', (id: string) => releaseTrade(testnet(), id))
  handle('rtrade:remove', (id: string) => removeTrade(testnet(), id))

  // ---- automation ----
  handle('bots:list', () => db.bots(testnet()).get())
  handle('bots:save', (bot: Bot) => {
    const store = db.bots(testnet())
    const list = store.get()
    const exists = list.some((b) => b.id === bot.id)
    const next = exists ? list.map((b) => (b.id === bot.id ? bot : b)) : [...list, bot]
    store.set(next)
    broadcast('bots:changed')
    return next
  })
  handle('bots:remove', (id: string) => {
    const store = db.bots(testnet())
    const next = store.get().filter((b) => b.id !== id)
    store.set(next)
    broadcast('bots:changed')
    return next
  })
  handle('bots:runNow', (id: string) => automation.runNow(id))
  handle('bots:log', () => [...db.botLog(testnet()).get()].reverse())
  handle('bots:clearLog', () => {
    db.botLog(testnet()).set([])
  })
}
