import { createHmac } from 'node:crypto'
import type { Kline, Order, SymbolInfo, Ticker24h, Trade } from '../../shared/types'

export class BinanceError extends Error {
  constructor(
    message: string,
    public code: number,
    public status: number
  ) {
    super(message)
    this.name = 'BinanceError'
  }
}

export interface ClientCredentials {
  apiKey: string
  apiSecret: string
}

const BASE_URLS = {
  live: 'https://api.binance.com',
  testnet: 'https://testnet.binance.vision'
}

type Params = Record<string, string | number | boolean | undefined>

/**
 * Minimal Binance Spot REST client. Handles HMAC-SHA256 signing, server time
 * drift, and normalises Binance error payloads into BinanceError.
 */
export class BinanceClient {
  private timeOffset = 0
  private lastTimeSync = 0
  private exchangeInfoCache: { at: number; symbols: Map<string, SymbolInfo> } | null = null

  constructor(
    private creds: ClientCredentials | null,
    public readonly testnet: boolean
  ) {}

  get baseUrl(): string {
    return this.testnet ? BASE_URLS.testnet : BASE_URLS.live
  }

  get hasCredentials(): boolean {
    return !!(this.creds?.apiKey && this.creds?.apiSecret)
  }

  // ---------- low level ----------

  private async syncTime(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v3/time`)
    const data = (await res.json()) as { serverTime: number }
    this.timeOffset = data.serverTime - Date.now()
    this.lastTimeSync = Date.now()
  }

  private serialize(params: Params): string {
    const parts: string[] = []
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    }
    return parts.join('&')
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params: Params = {},
    signed = false,
    retried = false
  ): Promise<T> {
    const headers: Record<string, string> = {}
    let query = ''

    if (signed) {
      if (!this.creds) throw new BinanceError('API keys are not configured. Add them in Settings.', -1, 0)
      if (Date.now() - this.lastTimeSync > 10 * 60 * 1000) await this.syncTime()
      const withTs = { ...params, timestamp: Date.now() + this.timeOffset, recvWindow: 10000 }
      query = this.serialize(withTs)
      const signature = createHmac('sha256', this.creds.apiSecret).update(query).digest('hex')
      query += `&signature=${signature}`
      headers['X-MBX-APIKEY'] = this.creds.apiKey
    } else {
      query = this.serialize(params)
      if (this.creds?.apiKey) headers['X-MBX-APIKEY'] = this.creds.apiKey
    }

    const url = `${this.baseUrl}${path}${query ? `?${query}` : ''}`
    let res: Response
    try {
      res = await fetch(url, { method, headers })
    } catch (e) {
      throw new BinanceError(`Network error: ${(e as Error).message}`, -1, 0)
    }

    const text = await res.text()
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }

    if (!res.ok) {
      const b = body as { code?: number; msg?: string } | null
      const msg = b?.msg ?? `HTTP ${res.status}`
      const code = b?.code ?? -1
      // -1021 = timestamp outside recvWindow: resync the clock and retry once.
      if (code === -1021 && signed && !retried) {
        await this.syncTime()
        return this.request<T>(method, path, params, signed, true)
      }
      if (res.status === 429 || res.status === 418) {
        throw new BinanceError(`Rate limited by Binance (${res.status}). Wait a minute before retrying.`, code, res.status)
      }
      // Make the two most common key problems actionable.
      if (code === -2015) {
        throw new BinanceError(
          `${msg}. Binance rejected this key from the server's current IP address or the key lacks this permission. In Binance → API Management set the key to "Unrestricted" (or add this IP to its trusted list) and check that Spot trading is enabled and has not expired.`,
          code,
          res.status
        )
      }
      if (code === -1022 || code === -2014) {
        throw new BinanceError(`${msg}. The API key or secret is wrong; paste them again in Settings.`, code, res.status)
      }
      throw new BinanceError(msg, code, res.status)
    }
    return body as T
  }

  // ---------- public market data ----------

  async ping(): Promise<boolean> {
    await this.request('GET', '/api/v3/ping')
    return true
  }

  async exchangeInfo(force = false): Promise<Map<string, SymbolInfo>> {
    if (!force && this.exchangeInfoCache && Date.now() - this.exchangeInfoCache.at < 60 * 60 * 1000) {
      return this.exchangeInfoCache.symbols
    }
    const data = await this.request<{ symbols: RawSymbol[] }>('GET', '/api/v3/exchangeInfo')
    const map = new Map<string, SymbolInfo>()
    for (const s of data.symbols) map.set(s.symbol, normaliseSymbol(s))
    this.exchangeInfoCache = { at: Date.now(), symbols: map }
    return map
  }

  async symbolInfo(symbol: string): Promise<SymbolInfo | null> {
    const info = await this.exchangeInfo()
    return info.get(symbol) ?? null
  }

  async price(symbol: string): Promise<number> {
    const d = await this.request<{ price: string }>('GET', '/api/v3/ticker/price', { symbol })
    return parseFloat(d.price)
  }

  async allPrices(): Promise<Map<string, number>> {
    const data = await this.request<{ symbol: string; price: string }[]>('GET', '/api/v3/ticker/price')
    const map = new Map<string, number>()
    for (const p of data) map.set(p.symbol, parseFloat(p.price))
    return map
  }

  async ticker24h(symbols: string[]): Promise<Ticker24h[]> {
    if (symbols.length === 0) return []
    const data = await this.request<Raw24h[]>('GET', '/api/v3/ticker/24hr', {
      symbols: JSON.stringify(symbols)
    })
    return data.map((t) => ({
      symbol: t.symbol,
      lastPrice: parseFloat(t.lastPrice),
      priceChangePercent: parseFloat(t.priceChangePercent),
      highPrice: parseFloat(t.highPrice),
      lowPrice: parseFloat(t.lowPrice),
      volume: parseFloat(t.volume),
      quoteVolume: parseFloat(t.quoteVolume)
    }))
  }

  async klines(symbol: string, interval: string, limit = 200): Promise<Kline[]> {
    const data = await this.request<(string | number)[][]>('GET', '/api/v3/klines', { symbol, interval, limit })
    return data.map((k) => ({
      t: Number(k[0]),
      o: parseFloat(String(k[1])),
      h: parseFloat(String(k[2])),
      l: parseFloat(String(k[3])),
      c: parseFloat(String(k[4])),
      v: parseFloat(String(k[5]))
    }))
  }

  // ---------- account (signed) ----------

  async account(): Promise<RawAccount> {
    return this.request<RawAccount>('GET', '/api/v3/account', { omitZeroBalances: true }, true)
  }

  /** Key permissions and IP restriction (not available on the testnet). */
  async apiRestrictions(): Promise<RawApiRestrictions | null> {
    if (this.testnet) return null
    try {
      return await this.request<RawApiRestrictions>('GET', '/sapi/v1/account/apiRestrictions', {}, true)
    } catch (e) {
      console.warn('[binance] apiRestrictions unavailable:', (e as Error).message)
      return null
    }
  }

  /**
   * Funding wallet balances. Not part of the spot account, so it takes its own
   * signed call. Unavailable on the testnet, and the key may not be allowed to
   * read it, so a failure is reported as an empty wallet rather than an error.
   */
  async fundingAssets(): Promise<RawFundingAsset[]> {
    if (this.testnet) return []
    try {
      return await this.request<RawFundingAsset[]>('POST', '/sapi/v1/asset/get-funding-asset', {}, true)
    } catch (e) {
      console.warn('[binance] funding wallet unavailable:', (e as Error).message)
      return []
    }
  }

  /**
   * Fetch all trades for a symbol with id greater than afterId (or all trades
   * from the beginning when afterId is undefined). Pages through 1000 at a time.
   */
  async myTrades(symbol: string, afterId?: number): Promise<RawTrade[]> {
    const all: RawTrade[] = []
    let cursor = afterId === undefined ? 0 : afterId + 1
    for (let page = 0; page < 100; page++) {
      const batch = await this.request<RawTrade[]>(
        'GET',
        '/api/v3/myTrades',
        { symbol, fromId: cursor, limit: 1000 },
        true
      )
      all.push(...batch)
      if (batch.length < 1000) break
      cursor = batch[batch.length - 1].id + 1
    }
    return all
  }

  async openOrders(symbol?: string): Promise<Order[]> {
    const data = await this.request<RawOrder[]>('GET', '/api/v3/openOrders', { symbol }, true)
    return data.map(normaliseOrder)
  }

  async getOrder(symbol: string, orderId: number): Promise<Order> {
    const o = await this.request<RawOrder>('GET', '/api/v3/order', { symbol, orderId }, true)
    return normaliseOrder(o)
  }

  async allOrders(symbol: string, limit = 100): Promise<Order[]> {
    const data = await this.request<RawOrder[]>('GET', '/api/v3/allOrders', { symbol, limit }, true)
    return data.map(normaliseOrder)
  }

  async placeOrder(params: Params, test = false): Promise<RawOrder | Record<string, never>> {
    const path = test ? '/api/v3/order/test' : '/api/v3/order'
    return this.request<RawOrder>('POST', path, { ...params, newOrderRespType: 'FULL' }, true)
  }

  /**
   * One-cancels-the-other order list: a take-profit limit plus a stop-loss.
   * The stop leg is a market stop (STOP_LOSS) when stopKind is MARKET, otherwise
   * a stop-limit with the given limit price.
   */
  async placeOco(params: {
    symbol: string
    side: 'BUY' | 'SELL'
    quantity: string
    takeProfitPrice: string
    stopPrice: string
    stopLimitPrice: string
    stopKind?: 'MARKET' | 'LIMIT'
  }): Promise<RawOcoResponse> {
    // SELL: above leg = LIMIT_MAKER take profit, below leg = stop.
    // BUY:  above leg = stop (breakout entry), below leg = LIMIT_MAKER.
    const sell = params.side === 'SELL'
    const market = params.stopKind === 'MARKET'
    const stopLeg = (prefix: 'above' | 'below'): Params =>
      market
        ? { [`${prefix}Type`]: 'STOP_LOSS', [`${prefix}StopPrice`]: params.stopPrice }
        : {
            [`${prefix}Type`]: 'STOP_LOSS_LIMIT',
            [`${prefix}StopPrice`]: params.stopPrice,
            [`${prefix}Price`]: params.stopLimitPrice,
            [`${prefix}TimeInForce`]: 'GTC'
          }
    const body: Params = sell
      ? {
          symbol: params.symbol,
          side: 'SELL',
          quantity: params.quantity,
          aboveType: 'LIMIT_MAKER',
          abovePrice: params.takeProfitPrice,
          ...stopLeg('below')
        }
      : {
          symbol: params.symbol,
          side: 'BUY',
          quantity: params.quantity,
          ...stopLeg('above'),
          belowType: 'LIMIT_MAKER',
          belowPrice: params.takeProfitPrice
        }
    return this.request<RawOcoResponse>('POST', '/api/v3/orderList/oco', body, true)
  }

  /**
   * OTOCO list: a resting LIMIT entry (the "working" order) plus a take-profit
   * and a stop that Binance places itself the moment the entry is fully filled.
   * Long side only, which is all this app trades: BUY working, SELL pending.
   */
  async placeLimitEntryWithOco(params: {
    symbol: string
    entryPrice: string
    entryQuantity: string
    exitQuantity: string
    takeProfitPrice: string
    stopPrice: string
    stopLimitPrice: string
    stopKind?: 'MARKET' | 'LIMIT'
  }): Promise<RawOcoResponse> {
    const below: Params =
      params.stopKind === 'MARKET'
        ? { pendingBelowType: 'STOP_LOSS', pendingBelowStopPrice: params.stopPrice }
        : {
            pendingBelowType: 'STOP_LOSS_LIMIT',
            pendingBelowStopPrice: params.stopPrice,
            pendingBelowPrice: params.stopLimitPrice,
            pendingBelowTimeInForce: 'GTC'
          }
    return this.request<RawOcoResponse>(
      'POST',
      '/api/v3/orderList/otoco',
      {
        symbol: params.symbol,
        workingType: 'LIMIT',
        workingSide: 'BUY',
        workingPrice: params.entryPrice,
        workingQuantity: params.entryQuantity,
        workingTimeInForce: 'GTC',
        pendingSide: 'SELL',
        pendingQuantity: params.exitQuantity,
        pendingAboveType: 'LIMIT_MAKER',
        pendingAbovePrice: params.takeProfitPrice,
        ...below
      },
      true
    )
  }

  /** The individual fills of one order, which carry the commission the summary endpoints omit. */
  async orderTrades(symbol: string, orderId: number): Promise<RawTrade[]> {
    return this.request<RawTrade[]>('GET', '/api/v3/myTrades', { symbol, orderId }, true)
  }

  async cancelOrder(symbol: string, orderId: number): Promise<RawOrder> {
    return this.request<RawOrder>('DELETE', '/api/v3/order', { symbol, orderId }, true)
  }

  async cancelOrderList(symbol: string, orderListId: number): Promise<unknown> {
    return this.request('DELETE', '/api/v3/orderList', { symbol, orderListId }, true)
  }
}

// ---------- raw payload shapes ----------

interface RawSymbol {
  symbol: string
  baseAsset: string
  quoteAsset: string
  status: string
  ocoAllowed: boolean
  otoAllowed?: boolean
  orderTypes?: string[]
  filters: { filterType: string; [k: string]: string | number | boolean }[]
}

interface Raw24h {
  symbol: string
  lastPrice: string
  priceChangePercent: string
  highPrice: string
  lowPrice: string
  volume: string
  quoteVolume: string
}

export interface RawAccount {
  makerCommission: number
  takerCommission: number
  canTrade: boolean
  canWithdraw: boolean
  canDeposit: boolean
  updateTime: number
  accountType: string
  permissions: string[]
  balances: { asset: string; free: string; locked: string }[]
}

export interface RawFundingAsset {
  asset: string
  free: string
  locked: string
  freeze: string
  withdrawing: string
}

export interface RawApiRestrictions {
  ipRestrict: boolean
  createTime: number
  enableReading: boolean
  enableSpotAndMarginTrading: boolean
  enableWithdrawals: boolean
  enableInternalTransfer: boolean
  enableMargin: boolean
  enableFutures: boolean
  permitsUniversalTransfer: boolean
  tradingAuthorityExpirationTime?: number
}

export interface RawTrade {
  symbol: string
  id: number
  orderId: number
  price: string
  qty: string
  quoteQty: string
  commission: string
  commissionAsset: string
  time: number
  isBuyer: boolean
  isMaker: boolean
}

export interface RawOrder {
  symbol: string
  orderId: number
  orderListId: number
  clientOrderId: string
  price: string
  origQty: string
  executedQty: string
  cummulativeQuoteQty: string
  status: string
  timeInForce: string
  type: string
  side: 'BUY' | 'SELL'
  stopPrice?: string
  time?: number
  transactTime?: number
  updateTime?: number
  fills?: { price: string; qty: string; commission: string; commissionAsset: string }[]
}

export interface RawOcoResponse {
  orderListId: number
  contingencyType?: string
  listStatusType: string
  listOrderStatus: string
  transactionTime: number
  symbol: string
  orders: { symbol: string; orderId: number; clientOrderId: string }[]
  orderReports: RawOrder[]
}

// ---------- normalisers ----------

function precisionOf(step: number): number {
  if (!step || step >= 1) return 0
  const s = step.toExponential().split('e')
  const mant = s[0].replace('.', '').replace(/0+$/, '')
  return Math.max(0, -parseInt(s[1], 10) + mant.length - 1)
}

function normaliseSymbol(s: RawSymbol): SymbolInfo {
  const f = (type: string) => s.filters.find((x) => x.filterType === type) ?? {}
  const lot = f('LOT_SIZE') as { minQty?: string; maxQty?: string; stepSize?: string }
  const price = f('PRICE_FILTER') as { minPrice?: string; tickSize?: string }
  const notional = f('NOTIONAL') as { minNotional?: string }
  const minNotionalOld = f('MIN_NOTIONAL') as { minNotional?: string }
  const stepSize = parseFloat(lot.stepSize ?? '0')
  const tickSize = parseFloat(price.tickSize ?? '0')
  return {
    symbol: s.symbol,
    baseAsset: s.baseAsset,
    quoteAsset: s.quoteAsset,
    status: s.status,
    ocoAllowed: s.ocoAllowed,
    otoAllowed: s.otoAllowed ?? false,
    orderTypes: s.orderTypes ?? [],
    filters: {
      minQty: parseFloat(lot.minQty ?? '0'),
      maxQty: parseFloat(lot.maxQty ?? '0'),
      stepSize,
      minPrice: parseFloat(price.minPrice ?? '0'),
      tickSize,
      minNotional: parseFloat(notional.minNotional ?? minNotionalOld.minNotional ?? '0'),
      quantityPrecision: precisionOf(stepSize),
      pricePrecision: precisionOf(tickSize)
    }
  }
}

export function normaliseOrder(o: RawOrder): Order {
  return {
    symbol: o.symbol,
    orderId: o.orderId,
    orderListId: o.orderListId ?? -1,
    clientOrderId: o.clientOrderId,
    price: parseFloat(o.price),
    origQty: parseFloat(o.origQty),
    executedQty: parseFloat(o.executedQty),
    cummulativeQuoteQty: parseFloat(o.cummulativeQuoteQty),
    status: o.status,
    timeInForce: o.timeInForce,
    type: o.type,
    side: o.side,
    stopPrice: parseFloat(o.stopPrice ?? '0'),
    time: o.time ?? o.transactTime ?? Date.now(),
    updateTime: o.updateTime ?? o.transactTime ?? Date.now()
  }
}

export function normaliseTrade(t: RawTrade, baseAsset: string, quoteAsset: string): Trade {
  return {
    id: t.id,
    symbol: t.symbol,
    baseAsset,
    quoteAsset,
    orderId: t.orderId,
    price: parseFloat(t.price),
    qty: parseFloat(t.qty),
    quoteQty: parseFloat(t.quoteQty),
    commission: parseFloat(t.commission),
    commissionAsset: t.commissionAsset,
    time: t.time,
    isBuyer: t.isBuyer,
    isMaker: t.isMaker
  }
}

/** Round a quantity or price down to the exchange step size and format as a string. */
export function roundToStep(value: number, step: number, precision: number): string {
  if (!step) return String(value)
  const rounded = Math.floor(value / step + 1e-9) * step
  return rounded.toFixed(precision)
}
