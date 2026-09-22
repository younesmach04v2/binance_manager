import type {
  AccountSummary,
  AdoptRequest,
  Analytics,
  AppInfo,
  Bot,
  BotLogEntry,
  ClosePositionRequest,
  ClosePositionResult,
  DiscoveredServer,
  ExchangePosition,
  JournalEntry,
  KeyStatus,
  Kline,
  ManagedTrade,
  Order,
  OrderRequest,
  OrderResult,
  Portfolio,
  ReduceBy,
  ReducePositionRequest,
  ReducePositionResult,
  RemoteConfig,
  RemoteStatus,
  RemoteTestResult,
  RTradePreview,
  RTradeRequest,
  Settings,
  SymbolInfo,
  SyncResult,
  Ticker24h,
  TradeWithJournal,
  ValuePoint
} from './types'

/** The API exposed to the renderer via contextBridge as window.api. */
export interface Api {
  app: {
    info(): Promise<AppInfo>
    openExternal(url: string): Promise<void>
  }
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
  }
  keys: {
    status(): Promise<KeyStatus>
    save(apiKey: string, apiSecret: string): Promise<KeyStatus>
    clear(): Promise<KeyStatus>
    test(): Promise<AccountSummary>
  }
  account: {
    balances(): Promise<Record<string, { free: number; locked: number }>>
  }
  portfolio: {
    get(): Promise<Portfolio>
    /** Only points newer than `since`, so a metered client does not re-download the whole curve. */
    history(since?: number): Promise<ValuePoint[]>
  }
  trades: {
    sync(symbols?: string[]): Promise<SyncResult>
    list(): Promise<TradeWithJournal[]>
    discoverSymbols(): Promise<string[]>
    clear(): Promise<void>
  }
  journal: {
    update(tradeId: number, patch: { tags?: string[]; note?: string }): Promise<JournalEntry>
    tags(): Promise<string[]>
  }
  analytics: {
    get(): Promise<Analytics>
  }
  orders: {
    place(req: OrderRequest): Promise<OrderResult>
    open(symbol?: string): Promise<Order[]>
    cancel(symbol: string, orderId: number, orderListId?: number): Promise<void>
    history(symbol: string): Promise<Order[]>
  }
  market: {
    symbol(symbol: string): Promise<SymbolInfo | null>
    symbols(): Promise<string[]>
    ticker24h(symbols: string[]): Promise<Ticker24h[]>
    klines(symbol: string, interval: string, limit?: number): Promise<Kline[]>
    prices(symbols: string[]): Promise<Record<string, number>>
  }
  bots: {
    list(): Promise<Bot[]>
    save(bot: Bot): Promise<Bot[]>
    remove(id: string): Promise<Bot[]>
    runNow(id: string): Promise<void>
    log(): Promise<BotLogEntry[]>
    clearLog(): Promise<void>
  }
  rtrade: {
    preview(req: RTradeRequest): Promise<RTradePreview>
    open(req: RTradeRequest): Promise<ManagedTrade>
    adopt(req: AdoptRequest): Promise<ManagedTrade>
    list(): Promise<ManagedTrade[]>
    moveBE(id: string): Promise<ManagedTrade>
    /** Sell `pct` of the main leg at market and keep managing the rest. */
    reduce(id: string, by: ReduceBy): Promise<ManagedTrade>
    close(id: string): Promise<ManagedTrade>
    cancelEntry(id: string): Promise<ManagedTrade>
    release(id: string): Promise<ManagedTrade>
    remove(id: string): Promise<ManagedTrade[]>
  }
  positions: {
    list(): Promise<ExchangePosition[]>
    close(req: ClosePositionRequest): Promise<ClosePositionResult>
    /** Sell part of a holding and put its stop and target back on the rest. */
    reduce(req: ReducePositionRequest): Promise<ReducePositionResult>
  }
  remote: {
    get(): Promise<RemoteConfig>
    set(patch: Partial<RemoteConfig>): Promise<RemoteConfig>
    status(): Promise<RemoteStatus>
    test(url: string, token: string): Promise<RemoteTestResult>
    discover(token: string, ports?: number[]): Promise<DiscoveredServer[]>
    regenerateToken(): Promise<RemoteConfig>
  }
  on(channel: AppEvent, cb: (payload: unknown) => void): () => void
}

export type AppEvent = 'bot:log' | 'bots:changed' | 'settings:changed' | 'rtrade:changed' | 'remote:status'

/** IPC result envelope so errors cross the bridge with a clean message. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string; code?: number }
