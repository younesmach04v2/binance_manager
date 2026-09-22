import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Api, AppEvent, IpcResult } from '../shared/api'

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>
  if (res.ok) return res.data
  const err = new Error(res.error) as Error & { code?: number }
  err.code = res.code
  throw err
}

const api: Api = {
  app: {
    info: () => invoke('app:info'),
    openExternal: (url) => invoke('app:openExternal', url)
  },
  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch)
  },
  keys: {
    status: () => invoke('keys:status'),
    save: (apiKey, apiSecret) => invoke('keys:save', apiKey, apiSecret),
    clear: () => invoke('keys:clear'),
    test: () => invoke('keys:test')
  },
  account: {
    balances: () => invoke('account:balances')
  },
  portfolio: {
    get: () => invoke('portfolio:get'),
    history: (since) => invoke('portfolio:history', since)
  },
  trades: {
    sync: (symbols) => invoke('trades:sync', symbols),
    list: () => invoke('trades:list'),
    discoverSymbols: () => invoke('trades:discoverSymbols'),
    clear: () => invoke('trades:clear')
  },
  journal: {
    update: (tradeId, patch) => invoke('journal:update', tradeId, patch),
    tags: () => invoke('journal:tags')
  },
  analytics: {
    get: () => invoke('analytics:get')
  },
  orders: {
    place: (req) => invoke('orders:place', req),
    open: (symbol) => invoke('orders:open', symbol),
    cancel: (symbol, orderId, orderListId) => invoke('orders:cancel', symbol, orderId, orderListId),
    history: (symbol) => invoke('orders:history', symbol)
  },
  market: {
    symbol: (symbol) => invoke('market:symbol', symbol),
    symbols: () => invoke('market:symbols'),
    ticker24h: (symbols) => invoke('market:ticker24h', symbols),
    klines: (symbol, interval, limit) => invoke('market:klines', symbol, interval, limit),
    prices: (symbols) => invoke('market:prices', symbols)
  },
  bots: {
    list: () => invoke('bots:list'),
    save: (bot) => invoke('bots:save', bot),
    remove: (id) => invoke('bots:remove', id),
    runNow: (id) => invoke('bots:runNow', id),
    log: () => invoke('bots:log'),
    clearLog: () => invoke('bots:clearLog')
  },
  positions: {
    list: () => invoke('positions:list'),
    close: (req) => invoke('positions:close', req),
    reduce: (req) => invoke('positions:reduce', req)
  },
  rtrade: {
    preview: (req) => invoke('rtrade:preview', req),
    open: (req) => invoke('rtrade:open', req),
    adopt: (req) => invoke('rtrade:adopt', req),
    list: () => invoke('rtrade:list'),
    moveBE: (id) => invoke('rtrade:moveBE', id),
    reduce: (id, by) => invoke('rtrade:reduce', id, by),
    close: (id) => invoke('rtrade:close', id),
    cancelEntry: (id) => invoke('rtrade:cancelEntry', id),
    release: (id) => invoke('rtrade:release', id),
    remove: (id) => invoke('rtrade:remove', id)
  },
  remote: {
    get: () => invoke('remote:get'),
    set: (patch) => invoke('remote:set', patch),
    status: () => invoke('remote:status'),
    test: (url, token) => invoke('remote:test', url, token),
    discover: (token, ports) => invoke('remote:discover', token, ports),
    regenerateToken: () => invoke('remote:regenerateToken')
  },
  on: (channel: AppEvent, cb) => {
    const listener = (_e: IpcRendererEvent, payload: unknown): void => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
