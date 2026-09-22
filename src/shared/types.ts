// Types shared between the Electron main process and the React renderer.

export type Side = 'BUY' | 'SELL'
export type OrderType = 'MARKET' | 'LIMIT' | 'STOP_LOSS_LIMIT' | 'TAKE_PROFIT_LIMIT' | 'OCO'
export type TimeInForce = 'GTC' | 'IOC' | 'FOK'

export interface QuickTradeSettings {
  riskQuote: number // default amount to risk per trade, in the quote asset
  riskPct: number // default percent of account value to risk per trade
  includeFunding: boolean // count the funding wallet as part of the account for percent sizing
  excludeOpenPositions: boolean // size on free capital: take off what open positions already tie up
  sizingMode: 'risk' | 'riskPct' | 'quote' | 'quantity'
  beTriggerR: number // first ladder step: at this many R, sell partialPct and move the stop to entry
  beOffsetPct: number // break-even stop = entry * (1 + beOffsetPct / 100)
  stopGapPct: number // for stop-limit stops: limit price this far below the stop
  partialPct: number // percent of the position sold at the break-even step (0 = keep everything)
  trailStartR: number // from this many R onward, every whole R moves the stop up...
  trailGapR: number // ...to (reached R - trailGapR). 3/2 means: at 3R stop -> 1R, at 4R stop -> 2R
}

export interface Settings {
  testnet: boolean
  quoteAsset: string // asset used to value the portfolio, e.g. USDT
  watchlist: string[] // symbols like BTCUSDT
  trackedSymbols: string[] // symbols whose trade history is synced
  refreshIntervalSec: number
  automationEnabled: boolean
  hideDustBelow: number // hide holdings worth less than this (in quote asset)
  quickTrade: QuickTradeSettings
}

export interface KeyStatus {
  hasKeys: boolean
  encryptionAvailable: boolean
  apiKeyPreview: string | null // first/last 4 chars
}

export interface AccountSummary {
  canTrade: boolean
  canWithdraw: boolean
  canDeposit: boolean
  accountType: string
  permissions: string[]
  updateTime: number
  balances: number
  /** From the API-key restrictions endpoint; null when unavailable (testnet). */
  keyRestrictions: {
    ipRestrict: boolean
    enableReading: boolean
    enableSpotTrading: boolean
    enableWithdrawals: boolean
    enableFutures: boolean
    tradingAuthorityExpiration: number | null
  } | null
}

export interface Holding {
  asset: string
  free: number
  locked: number
  total: number
  price: number | null // in quote asset
  value: number | null
  allocationPct: number
  avgCost: number | null // weighted average entry from synced trades
  tradedQty: number // net quantity accounted for by synced trades
  costBasisCoverage: 'full' | 'partial' | 'none'
  unrealizedPnl: number | null
  unrealizedPnlPct: number | null
  realizedPnl: number // from synced trades, in quote asset
  change24hPct: number | null
}

export interface Portfolio {
  quoteAsset: string
  totalValue: number // spot wallet only
  fundingValue: number // funding wallet, valued in the quote asset (0 on the testnet)
  positionsValue: number // value of every non-cash holding, i.e. what open positions tie up
  totalUnrealizedPnl: number
  totalRealizedPnl: number
  holdings: Holding[]
  updatedAt: number
  testnet: boolean
}

export interface ValuePoint {
  t: number
  value: number
}

export interface Trade {
  id: number
  symbol: string
  baseAsset: string
  quoteAsset: string
  orderId: number
  price: number
  qty: number
  quoteQty: number
  commission: number
  commissionAsset: string
  time: number
  isBuyer: boolean
  isMaker: boolean
}

export interface JournalEntry {
  tradeId: number
  tags: string[]
  note: string
  updatedAt: number
}

export interface TradeWithJournal extends Trade {
  journal?: JournalEntry
}

export interface RoundTrip {
  id: string
  symbol: string
  openTime: number
  closeTime: number
  durationMs: number
  qty: number
  entryAvg: number
  exitAvg: number
  cost: number
  proceeds: number
  fees: number // in quote asset (approximate for BNB fees)
  pnl: number
  pnlPct: number
  tradeIds: number[]
  tags: string[]
}

export interface Analytics {
  quoteAsset: string
  roundTrips: RoundTrip[]
  closedCount: number
  wins: number
  losses: number
  winRate: number
  totalPnl: number
  totalFees: number
  avgWin: number
  avgLoss: number
  profitFactor: number | null
  expectancy: number
  largestWin: number
  largestLoss: number
  avgHoldMs: number
  bySymbol: { symbol: string; trades: number; pnl: number; winRate: number }[]
  byTag: { tag: string; trades: number; pnl: number; winRate: number }[]
  cumulative: { t: number; pnl: number }[]
  openPositions: number
}

export interface SymbolFilters {
  minQty: number
  maxQty: number
  stepSize: number
  minPrice: number
  tickSize: number
  minNotional: number
  quantityPrecision: number
  pricePrecision: number
}

export interface SymbolInfo {
  symbol: string
  baseAsset: string
  quoteAsset: string
  status: string
  ocoAllowed: boolean
  /** Supports OTO/OTOCO lists: an entry order that carries its own exit orders. */
  otoAllowed: boolean
  orderTypes: string[]
  filters: SymbolFilters
}

export interface Ticker24h {
  symbol: string
  lastPrice: number
  priceChangePercent: number
  highPrice: number
  lowPrice: number
  volume: number
  quoteVolume: number
}

export interface Kline {
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
}

export interface OrderRequest {
  symbol: string
  side: Side
  type: OrderType
  quantity?: number
  quoteOrderQty?: number
  price?: number
  stopPrice?: number
  takeProfitPrice?: number // OCO only
  timeInForce?: TimeInForce
  test?: boolean
}

export interface Order {
  symbol: string
  orderId: number
  orderListId: number
  clientOrderId: string
  price: number
  origQty: number
  executedQty: number
  cummulativeQuoteQty: number
  status: string
  timeInForce: string
  type: string
  side: Side
  stopPrice: number
  time: number
  updateTime: number
}

export interface OrderResult {
  ok: boolean
  test: boolean
  orders: Order[]
  raw: unknown
}

export type BotType = 'DCA' | 'PRICE_RULE'

export interface BotBase {
  id: string
  type: BotType
  name: string
  symbol: string
  enabled: boolean
  dryRun: boolean
  createdAt: number
  lastRunAt: number | null
  lastError: string | null
}

export interface DcaBot extends BotBase {
  type: 'DCA'
  quoteAmount: number
  intervalHours: number
  nextRunAt: number
  runsCompleted: number
  maxRuns: number | null
}

export interface PriceRuleBot extends BotBase {
  type: 'PRICE_RULE'
  condition: 'ABOVE' | 'BELOW'
  triggerPrice: number
  action: { side: Side; quantity?: number; quoteOrderQty?: number }
  triggered: boolean
  triggeredAt: number | null
}

export type Bot = DcaBot | PriceRuleBot

export interface BotLogEntry {
  id: string
  botId: string
  botName: string
  time: number
  level: 'info' | 'warn' | 'error'
  message: string
}

// ---------- R-multiple quick trades ----------

export type RSizing =
  | { mode: 'risk'; riskQuote: number }
  | { mode: 'quote'; quoteAmount: number }
  | { mode: 'quantity'; quantity: number }

/** MARKET buys now; LIMIT rests on the book and opens the position when it fills. */
export type REntryType = 'MARKET' | 'LIMIT'

export interface RTradeRequest {
  symbol: string
  stopPrice: number
  tpR: number // take-profit distance in multiples of R (entry - stop)
  beTriggerR: number | null // first ladder step at this many R (sell partialPct, stop -> entry); null = plain TP/SL
  beOffsetPct: number
  partialPct: number // percent sold at the break-even step
  trailStartR: number | null // from this R on, trail the stop trailGapR behind each whole R; null = no trailing
  trailGapR: number
  sizing: RSizing
  command: string // label shown in the UI, e.g. "2R BE"
  entryType?: REntryType // default MARKET
  limitPrice?: number // required for a LIMIT entry: the price the buy rests at
  expireMinutes?: number | null // cancel the resting entry if it has not filled after this long
}

/** One rung of the stop ladder. */
export interface LadderStep {
  atR: number // price level that triggers the step, in R above entry
  stopR: number // where the stop goes, in R above entry (0 = break-even)
  closePct: number // percent of the position sold when the step triggers (only the first step uses this)
  done: boolean
  doneAt: number | null
}

export interface LadderPlan extends Pick<LadderStep, 'atR' | 'stopR' | 'closePct'> {
  triggerPrice: number
  stopPrice: number
}

export interface RTradePreview {
  symbol: string
  baseAsset: string
  quoteAsset: string
  lastPrice: number
  entryType: REntryType
  /** Price every number below is computed from: the limit price, or the last price for a market entry. */
  entryPrice: number
  /** True when Binance itself will attach the take-profit and stop to the resting entry (OTOCO). */
  attachedProtection: boolean
  stopPrice: number
  rDistance: number
  rPct: number
  quantity: number
  partialQty: number | null // quantity of the resting partial-profit leg, if the position can be split
  positionValue: number
  riskQuote: number
  takeProfit: number
  rewardQuote: number
  beTriggerPrice: number | null
  beStopPrice: number | null
  ladder: LadderPlan[]
  notes: string[]
  stopKind: 'MARKET' | 'LIMIT'
}

export type ManagedPhase =
  | 'PENDING' // limit entry resting on the book; nothing bought yet
  | 'PROTECTED' // entry filled, OCO (TP + SL) live at the initial stop
  | 'BE' // stop is at break-even
  | 'TRAILING' // stop is above entry
  | 'UNPROTECTED' // position exists but the main OCO could not be placed
  | 'CLOSED_TP'
  | 'CLOSED_SL'
  | 'CLOSED_MANUAL'
  | 'CANCELLED_ENTRY' // the limit entry was cancelled or expired without filling
  | 'RELEASED' // app stopped managing; orders left on the exchange

/** The resting partial-profit leg: its own OCO with the target at the break-even trigger. */
export interface PartialLeg {
  pct: number
  qty: number
  tp: number
  ocoOrderListId: number | null
  tpOrderId: number | null
  slOrderId: number | null
  status: 'OPEN' | 'FILLED' | 'CANCELLED'
  fillQty: number
  fillPrice: number | null // average
  filledAt: number | null
}

/**
 * A resting LIMIT buy that opens the position when it fills. When the symbol
 * allows OTOCO, the take-profit and stop are part of the same order list, so
 * Binance places them itself the moment the entry fills; the app then swaps
 * them for legs sized to the actual fill and runs the ladder.
 */
export interface LimitEntry {
  limitPrice: number
  quantity: number // quantity of the working BUY order
  orderId: number
  listId: number | null // OTOCO list id; null = plain limit order with no attached exits
  pendingTpOrderId: number | null // exchange-side take-profit that activates on fill
  pendingSlOrderId: number | null // exchange-side stop that activates on fill
  placedAt: number
  expiresAt: number | null // cancel the entry after this time if it has not filled
  filledQty: number
  status: 'WAITING' | 'FILLED' | 'CANCELLED'
}

export interface ManagedTrade {
  id: string
  symbol: string
  baseAsset: string
  quoteAsset: string
  createdAt: number
  command: string
  tpR: number
  beTriggerR: number | null
  beOffsetPct: number
  entryPrice: number
  qtyInitial: number // bought quantity net of base-asset fees
  qty: number // quantity protected by the main OCO (initial minus the partial leg)
  riskQuote: number
  initialStop: number
  currentStop: number
  stopR: number | null // current stop in R above entry; null = still at the initial stop
  takeProfit: number
  beTriggerPrice: number | null
  ladder: LadderStep[]
  partial: PartialLeg | null
  /** Set for a limit entry; null when the position was opened with a market buy. */
  limitEntry: LimitEntry | null
  entryOrderId: number
  ocoOrderListId: number | null
  tpOrderId: number | null
  slOrderId: number | null
  phase: ManagedPhase
  beMovedAt: number | null
  closedAt: number | null
  exitPrice: number | null // exit of the main leg
  realizedPnl: number | null // gross, in quote asset, partial leg included
  lastError: string | null
  log: { time: number; message: string }[]
}

/** A holding on the exchange that is not (yet) managed by the app, with whatever protection its open orders give it. */
export interface ExchangePosition {
  symbol: string
  baseAsset: string
  quoteAsset: string
  qty: number
  free: number
  locked: number
  price: number | null
  value: number | null
  entryPrice: number | null // weighted average cost from synced trades
  costBasisCoverage: 'full' | 'partial' | 'none'
  unrealizedPnl: number | null
  unrealizedPnlPct: number | null
  change24hPct: number | null
  stopPrice: number | null // from an open SELL stop order
  stopType: string | null
  targetPrice: number | null // from an open SELL limit order above the market
  orders: Order[] // open SELL orders on this symbol
  orderListIds: number[]
}

/** Bring an existing position under the stop ladder, replacing its current orders. */
export interface AdoptRequest {
  symbol: string
  qty: number
  entryPrice: number
  stopPrice: number
  takeProfit: number
  cancelOrderIds: number[]
  cancelOrderListIds: number[]
  beTriggerR: number | null
  beOffsetPct: number
  partialPct: number
  trailStartR: number | null
  trailGapR: number
  command?: string
}

export interface ClosePositionRequest {
  symbol: string
  qty?: number // default: everything free after cancelling the orders
  cancelOrderIds: number[]
  cancelOrderListIds: number[]
}

export interface ClosePositionResult {
  sold: number
  price: number | null
  orderId: number | null
}

/**
 * How much of a position to sell. `risk` is the amount of quote currency you
 * want to stop having at stake, converted with the position's own entry and
 * stop; it is refused when the stop is already at or above entry, because
 * there is no loss left to take off the table.
 */
export type ReduceBy =
  | { mode: 'pct'; value: number } // percent of the position
  | { mode: 'qty'; value: number } // base asset units
  | { mode: 'quote'; value: number } // quote currency of position value
  | { mode: 'risk'; value: number } // quote currency of risk removed

/** Sell part of a plain exchange holding and put its protection back on the rest. */
export interface ReducePositionRequest {
  symbol: string
  by: ReduceBy
  cancelOrderIds: number[]
  cancelOrderListIds: number[]
  /** Re-placed for the remainder when both are known, so the rest is not left naked. */
  stopPrice: number | null
  targetPrice: number | null
  /** Average cost, needed only to size a reduction by risk. */
  entryPrice: number | null
}

export interface ReducePositionResult extends ClosePositionResult {
  remaining: number
  reprotected: 'oco' | 'none'
  note: string | null
}

// ---------- remote access (server / client) ----------

export type RemoteMode = 'standalone' | 'server' | 'client'

export interface RemoteConfig {
  mode: RemoteMode
  server: { port: number; token: string }
  /**
   * `url` is the address in use; `altUrls` are others the same server answers
   * on — typically a LAN address for home and a Tailscale one for everywhere
   * else. The client moves between them on its own and never forgets one.
   */
  client: { url: string; altUrls: string[]; token: string }
}

export interface RemoteStatus {
  mode: RemoteMode
  server: { running: boolean; port: number; addresses: string[]; clients: number; error: string | null } | null
  client: {
    connected: boolean
    url: string
    lastError: string | null
    serverVersion: string | null
    serverTestnet: boolean | null
    /** The server says it is on a mobile connection: clients poll it less often. */
    serverMetered: boolean | null
    lastEventAt: number | null
  } | null
}

export interface RemoteInfo {
  name: string
  version: string
  mode: RemoteMode
  testnet: boolean
  hasKeys: boolean
  /** The server is on a mobile connection, so it pays for what clients pull. */
  metered: boolean
  time: number
}

export interface RemoteTestResult extends RemoteInfo {
  latencyMs: number
}

/** A server found by scanning the local network. */
export interface DiscoveredServer extends RemoteTestResult {
  url: string // host:port, ready to paste into the client's address field
  viaTailnet: boolean // found through Tailscale, so it works from any network
}

export interface SyncResult {
  symbols: string[]
  newTrades: number
  totalTrades: number
  errors: { symbol: string; message: string }[]
}

export interface AppInfo {
  version: string
  dataPath: string
  platform: string
}
