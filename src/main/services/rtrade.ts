import { randomUUID } from 'node:crypto'
import type {
  AdoptRequest,
  LadderStep,
  LimitEntry,
  ManagedPhase,
  ManagedTrade,
  Order,
  PartialLeg,
  ReduceBy,
  RTradePreview,
  RTradeRequest,
  SymbolInfo
} from '../../shared/types'
import { BinanceError, normaliseOrder, roundToStep, type BinanceClient, type RawOrder } from '../binance/client'
import { broadcast } from '../context'
import { describeReduce, quantityFor } from '../../shared/reduce'
import { db } from '../store/db'
import { placeOrder } from './orders'

/**
 * R-multiple quick trades ("1R", "2R BE", "3R BE"...).
 *
 * Plain command:  market buy -> one OCO (take-profit at N R + stop).
 * BE command:     market buy -> main OCO for the rest of the position + a
 *                 resting "partial" OCO whose target sits at the break-even
 *                 trigger (default +1R, 50 % of the size). A stop ladder then
 *                 moves the main stop: at +1R -> entry (and the partial half is
 *                 sold if its limit has not filled yet), from +3R -> stop trails
 *                 two R behind every whole R (3R -> +1R, 4R -> +2R ...).
 *
 * The entry can also be a LIMIT resting on the book instead of a market buy.
 * Where the symbol supports OTOCO the target and stop travel with it as one
 * order list, so Binance places them itself the moment the entry fills; the
 * app then swaps them for legs sized to the real fill and runs the ladder.
 *
 * Every exit order lives on the exchange, so the position is protected even
 * when the app is closed. The ladder and outcome tracking run on the
 * automation tick.
 */

function fail(message: string): never {
  throw new BinanceError(message, -2, 0)
}

const OPEN_PHASES = new Set<ManagedTrade['phase']>(['PENDING', 'PROTECTED', 'BE', 'TRAILING', 'UNPROTECTED'])

/** Still being watched: either waiting for its entry or holding coins. */
export function isOpenTrade(t: ManagedTrade): boolean {
  return OPEN_PHASES.has(t.phase)
}

/** Holds coins on the exchange right now (a resting entry does not). */
export function isLiveTrade(t: ManagedTrade): boolean {
  return isOpenTrade(t) && t.phase !== 'PENDING'
}

/** The entry order is still on the book, so nothing has been bought yet. */
function waitingEntry(t: ManagedTrade): LimitEntry | null {
  return t.limitEntry && t.limitEntry.status === 'WAITING' ? t.limitEntry : null
}

const fmtPrice = (si: SymbolInfo, p: number): string => roundToStep(p, si.filters.tickSize, si.filters.pricePrecision)
const fmtQty = (si: SymbolInfo, q: number): string => roundToStep(q, si.filters.stepSize, si.filters.quantityPrecision)
const numPrice = (si: SymbolInfo, p: number): number => parseFloat(fmtPrice(si, p))
const numQty = (si: SymbolInfo, q: number): number => parseFloat(fmtQty(si, q))
const stopKindFor = (si: SymbolInfo): 'MARKET' | 'LIMIT' => (si.orderTypes.includes('STOP_LOSS') ? 'MARKET' : 'LIMIT')
const rOf = (t: ManagedTrade): number => t.entryPrice - t.initialStop
const p8 = (n: number): string => n.toPrecision(8)

function log(t: ManagedTrade, message: string): void {
  t.log = [...t.log, { time: Date.now(), message }].slice(-150)
}

function saveTrade(testnet: boolean, t: ManagedTrade): void {
  db.managed(testnet).update((list) => {
    const idx = list.findIndex((x) => x.id === t.id)
    return idx >= 0 ? list.map((x) => (x.id === t.id ? t : x)) : [...list, t]
  })
  broadcast('rtrade:changed')
}

function refreshPhase(t: ManagedTrade): void {
  if (!isOpenTrade(t)) return
  if (waitingEntry(t)) t.phase = 'PENDING'
  else if (t.ocoOrderListId === null) t.phase = 'UNPROTECTED'
  else if (t.stopR === null) t.phase = 'PROTECTED'
  else if (t.stopR <= 0) t.phase = 'BE'
  else t.phase = 'TRAILING'
}

/** Price the stop sits at for a given ladder rung. */
function stopPriceFor(si: SymbolInfo, t: Pick<ManagedTrade, 'entryPrice' | 'beOffsetPct'>, R: number, stopR: number): number {
  return numPrice(si, stopR === 0 ? t.entryPrice * (1 + t.beOffsetPct / 100) : t.entryPrice + stopR * R)
}

/**
 * Build the stop ladder for a BE command. First rung: at beTriggerR sell
 * partialPct and put the stop at entry. Then from trailStartR, every whole R
 * below the target moves the stop to (R reached - trailGapR).
 */
export function buildLadder(
  tpR: number,
  beTriggerR: number | null,
  partialPct: number,
  trailStartR: number | null,
  trailGapR: number
): LadderStep[] {
  const steps: LadderStep[] = []
  if (beTriggerR === null || beTriggerR <= 0) return steps
  if (beTriggerR < tpR - 1e-9) steps.push({ atR: beTriggerR, stopR: 0, closePct: Math.max(0, Math.min(90, partialPct)), done: false, doneAt: null })
  if (trailStartR !== null && trailStartR > 0 && trailGapR > 0) {
    for (let k = trailStartR; k < tpR - 1e-9; k += 1) {
      const prev = steps[steps.length - 1]
      const stopR = k - trailGapR
      if (prev && (k <= prev.atR || stopR <= prev.stopR)) continue
      if (!prev && stopR < 0) continue
      steps.push({ atR: k, stopR, closePct: 0, done: false, doneAt: null })
    }
  }
  return steps
}

/** Can the position be split into a partial leg and a main leg that both pass the exchange filters? */
function splitQty(si: SymbolInfo, qty: number, pct: number, stop: number): { partial: number; main: number } | null {
  if (pct <= 0) return null
  const f = si.filters
  const partial = numQty(si, (qty * pct) / 100)
  const main = numQty(si, qty - partial)
  const ok = (q: number): boolean => q >= f.minQty && q > 0 && q * stop >= f.minNotional
  return ok(partial) && ok(main) ? { partial, main } : null
}

/** A managed position with every field at its opening value; callers fill in the legs. */
function newTrade(
  si: SymbolInfo,
  base: {
    command: string
    tpR: number
    beOffsetPct: number
    entryPrice: number
    qty: number
    initialStop: number
    takeProfit: number
    ladder: LadderStep[]
    entryOrderId: number
    /** R to size the risk and ladder levels with; defaults to entry - stop. */
    r?: number
    limitEntry?: LimitEntry | null
    phase?: ManagedPhase
  }
): ManagedTrade {
  const R = base.r ?? base.entryPrice - base.initialStop
  return {
    id: randomUUID(),
    symbol: si.symbol,
    baseAsset: si.baseAsset,
    quoteAsset: si.quoteAsset,
    createdAt: Date.now(),
    command: base.command,
    tpR: base.tpR,
    beTriggerR: base.ladder[0]?.atR ?? null,
    beOffsetPct: base.beOffsetPct,
    entryPrice: base.entryPrice,
    qtyInitial: base.qty,
    qty: base.qty,
    riskQuote: base.qty * R,
    initialStop: base.initialStop,
    currentStop: base.initialStop,
    stopR: null,
    takeProfit: numPrice(si, base.takeProfit),
    beTriggerPrice: base.ladder[0] ? base.entryPrice + base.ladder[0].atR * R : null,
    ladder: base.ladder,
    partial: null,
    limitEntry: base.limitEntry ?? null,
    entryOrderId: base.entryOrderId,
    ocoOrderListId: null,
    tpOrderId: null,
    slOrderId: null,
    phase: base.phase ?? 'UNPROTECTED',
    beMovedAt: null,
    closedAt: null,
    exitPrice: null,
    realizedPnl: null,
    lastError: null,
    log: []
  }
}

/** Write the ladder plan into the trade log at opening time. */
function logPlan(si: SymbolInfo, t: ManagedTrade, R: number): void {
  for (const s of t.ladder) {
    log(
      t,
      `Plan: at +${s.atR}R (${p8(t.entryPrice + s.atR * R)})${s.closePct > 0 ? ` sell ${s.closePct}%,` : ''} stop -> ${s.stopR === 0 ? 'entry' : `+${s.stopR}R`} (${stopPriceFor(si, t, R, s.stopR)})`
    )
  }
}

// ---------------------------------------------------------------- preview

export async function previewRTrade(client: BinanceClient, req: RTradeRequest): Promise<RTradePreview> {
  const si = await client.symbolInfo(req.symbol)
  if (!si) fail(`Unknown symbol ${req.symbol}`)
  if (si.status !== 'TRADING') fail(`${req.symbol} is not currently trading`)
  if (!si.ocoAllowed) fail(`${req.symbol} does not support OCO orders, so stop and target cannot be placed together`)
  if (!(req.stopPrice > 0)) fail('Enter a stop-loss price')
  if (!(req.tpR > 0)) fail('Take-profit must be a positive number of R')

  const last = await client.price(req.symbol)
  const entryType = req.entryType === 'LIMIT' ? 'LIMIT' : 'MARKET'
  const isLimit = entryType === 'LIMIT'
  if (isLimit && !(req.limitPrice !== undefined && req.limitPrice > 0)) fail('Enter the price the limit buy should rest at')
  // Every number below is computed from the price the entry is expected to happen at.
  const entry = isLimit ? numPrice(si, req.limitPrice as number) : last
  if (!(entry > 0)) fail('The limit price is below the smallest tick this symbol allows')
  if (req.stopPrice >= entry) {
    fail(isLimit ? `The stop (${req.stopPrice}) must be below the limit price (${entry}) for a long` : `The stop (${req.stopPrice}) must be below the current price (${last}) for a long`)
  }

  const r = entry - req.stopPrice
  let qty: number
  switch (req.sizing.mode) {
    case 'risk':
      if (!(req.sizing.riskQuote > 0)) fail('Enter the amount to risk')
      qty = req.sizing.riskQuote / r
      break
    case 'quote':
      if (!(req.sizing.quoteAmount > 0)) fail('Enter the amount to spend')
      qty = req.sizing.quoteAmount / entry
      break
    case 'quantity':
      if (!(req.sizing.quantity > 0)) fail('Enter a quantity')
      qty = req.sizing.quantity
      break
  }
  const f = si.filters
  qty = numQty(si, qty)
  if (qty < f.minQty || qty <= 0) {
    fail(`Quantity ${qty} is below the minimum ${f.minQty} ${si.baseAsset}. Increase the size or move the stop closer.`)
  }
  if (qty * entry < f.minNotional) {
    fail(`Position value ${(qty * entry).toFixed(2)} ${si.quoteAsset} is below the minimum ${f.minNotional}. Increase the size or move the stop closer.`)
  }

  const takeProfit = numPrice(si, entry + req.tpR * r)
  const ladder = buildLadder(req.tpR, req.beTriggerR, req.partialPct, req.trailStartR, req.trailGapR)
  const notes: string[] = []
  const attachedProtection = isLimit && si.otoAllowed
  let partialQty: number | null = null
  const first = ladder[0]
  if (first && first.closePct > 0) {
    const split = splitQty(si, qty, first.closePct, req.stopPrice)
    if (split) partialQty = split.partial
    else {
      first.closePct = 0
      notes.push(`Position too small to split: the whole size stays in one leg (no partial sale at +${first.atR}R).`)
    }
  }
  if (isLimit) {
    if (entry >= last) {
      notes.push(`The limit price ${entry} is at or above the market ${last}, so Binance fills it straight away like a market buy.`)
    }
    if (!attachedProtection) {
      notes.push(`${si.symbol} does not accept an entry with its exits attached, so the buy rests on its own and the app places the stop and target when it fills (within 15 seconds, and only while the server runs).`)
    } else if (qty * req.stopPrice < f.minNotional) {
      notes.push(`At the stop the position is worth less than the ${f.minNotional} ${si.quoteAsset} minimum, so Binance may refuse the attached stop; the app would then protect the fill itself.`)
    }
  }
  const proxy = { entryPrice: entry, beOffsetPct: req.beOffsetPct }
  return {
    symbol: si.symbol,
    baseAsset: si.baseAsset,
    quoteAsset: si.quoteAsset,
    lastPrice: last,
    entryType,
    entryPrice: entry,
    attachedProtection,
    stopPrice: req.stopPrice,
    rDistance: r,
    rPct: (r / entry) * 100,
    quantity: qty,
    partialQty,
    positionValue: qty * entry,
    riskQuote: qty * r,
    takeProfit,
    rewardQuote: qty * (takeProfit - entry),
    beTriggerPrice: first ? entry + first.atR * r : null,
    beStopPrice: first ? stopPriceFor(si, proxy, r, 0) : null,
    ladder: ladder.map((s) => ({
      atR: s.atR,
      stopR: s.stopR,
      closePct: s.closePct,
      triggerPrice: entry + s.atR * r,
      stopPrice: stopPriceFor(si, proxy, r, s.stopR)
    })),
    notes,
    stopKind: stopKindFor(si)
  }
}

// ---------------------------------------------------------------- open

export async function openRTrade(client: BinanceClient, testnet: boolean, req: RTradeRequest): Promise<ManagedTrade> {
  if (!client.hasCredentials) fail('API keys are not configured. Add them in Settings.')
  const preview = await previewRTrade(client, req)
  const si = (await client.symbolInfo(req.symbol)) as SymbolInfo
  if (preview.entryType === 'LIMIT') return openLimitRTrade(client, testnet, req, preview, si)

  // 1. Market buy.
  const buy = await placeOrder(client, { symbol: req.symbol, side: 'BUY', type: 'MARKET', quantity: preview.quantity })
  const raw = buy.raw as RawOrder
  const executed = parseFloat(raw.executedQty)
  const spent = parseFloat(raw.cummulativeQuoteQty)
  if (!(executed > 0)) fail('The market buy did not fill')
  const entry = spent / executed
  const baseFee = (raw.fills ?? [])
    .filter((x) => x.commissionAsset === si.baseAsset)
    .reduce((s, x) => s + parseFloat(x.commission), 0)
  const bought = numQty(si, executed - baseFee)

  // 2. R from the actual fill (planned R if the fill is already at/below the stop).
  const actualR = entry - req.stopPrice
  const R = actualR > 0 ? actualR : preview.rDistance
  const ladder = buildLadder(req.tpR, req.beTriggerR, req.partialPct, req.trailStartR, req.trailGapR)
  const trade = newTrade(si, {
    command: req.command,
    tpR: req.tpR,
    beOffsetPct: req.beOffsetPct,
    entryPrice: entry,
    qty: bought,
    initialStop: req.stopPrice,
    takeProfit: entry + req.tpR * R,
    ladder,
    entryOrderId: raw.orderId,
    r: R
  })
  log(
    trade,
    `${req.command}: bought ${bought} ${si.baseAsset} at ${p8(entry)} for ${spent.toFixed(2)} ${si.quoteAsset} (order #${raw.orderId}). R = ${R.toPrecision(6)}, target ${trade.takeProfit}`
  )
  logPlan(si, trade, R)

  // 3. Split off the partial leg, then protect the position.
  splitPartial(si, trade, R, null)
  if (actualR <= 0) {
    log(trade, `Warning: the fill is at or below the stop ${req.stopPrice}; the stop cannot be placed until price recovers`)
  } else {
    if (trade.partial) await placePartialLeg(client, si, trade)
    await protect(client, si, trade, req.stopPrice)
  }
  refreshPhase(trade)
  saveTrade(testnet, trade)
  return trade
}

/**
 * Move the first ladder rung's share of the position into its own resting leg.
 * When `market` is given, a rung whose target is already below the market is
 * dropped instead: a limit-maker there would be rejected.
 */
function splitPartial(si: SymbolInfo, t: ManagedTrade, R: number, market: number | null): void {
  const first = t.ladder[0]
  if (!first || first.closePct <= 0) return
  const tp = numPrice(si, t.entryPrice + first.atR * R)
  const split = market !== null && tp <= market ? null : splitQty(si, t.qtyInitial, first.closePct, t.initialStop)
  if (!split) {
    log(
      t,
      market !== null && tp <= market
        ? `Price is already past the +${first.atR}R level; no resting partial, the ladder moves the stop on its next check`
        : 'Position too small to split; the whole size stays in one leg'
    )
    first.closePct = 0
    return
  }
  t.partial = {
    pct: first.closePct,
    qty: split.partial,
    tp,
    ocoOrderListId: null,
    tpOrderId: null,
    slOrderId: null,
    status: 'OPEN',
    fillQty: 0,
    fillPrice: null,
    filledAt: null
  }
  t.qty = split.main
}

// ---------------------------------------------------------------- limit entry

/** Quantity the exit legs may sell: the buy minus the commission Binance takes out of the base asset. */
async function sellableQty(client: BinanceClient, si: SymbolInfo, qty: number): Promise<number> {
  let feeRate = 0.001
  try {
    const a = await client.account()
    const bps = Math.max(a.makerCommission ?? 0, a.takerCommission ?? 0)
    if (Number.isFinite(bps) && bps > 0) feeRate = bps / 10_000
  } catch {
    // Not fatal: the default 0.1 % is Binance's standard spot rate.
  }
  return numQty(si, qty * (1 - feeRate))
}

/**
 * Rest a LIMIT buy instead of buying at market. With OTOCO the target and stop
 * are part of the same order list and Binance places them the instant the buy
 * fills, so the position is never naked even if this server is down. The app
 * takes the legs over on its next check and runs the ladder from the real fill.
 */
async function openLimitRTrade(
  client: BinanceClient,
  testnet: boolean,
  req: RTradeRequest,
  preview: RTradePreview,
  si: SymbolInfo
): Promise<ManagedTrade> {
  const limit = preview.entryPrice
  const qty = preview.quantity
  const R = preview.rDistance
  const ladder = buildLadder(req.tpR, req.beTriggerR, req.partialPct, req.trailStartR, req.trailGapR)
  const expiresAt = req.expireMinutes && req.expireMinutes > 0 ? Date.now() + req.expireMinutes * 60_000 : null
  const entry: LimitEntry = {
    limitPrice: limit,
    quantity: qty,
    orderId: 0,
    listId: null,
    pendingTpOrderId: null,
    pendingSlOrderId: null,
    placedAt: Date.now(),
    expiresAt,
    filledQty: 0,
    status: 'WAITING'
  }
  const trade = newTrade(si, {
    command: req.command,
    tpR: req.tpR,
    beOffsetPct: req.beOffsetPct,
    entryPrice: limit,
    qty,
    initialStop: req.stopPrice,
    takeProfit: limit + req.tpR * R,
    ladder,
    entryOrderId: 0,
    limitEntry: entry,
    phase: 'PENDING'
  })
  log(
    trade,
    `${req.command}: limit buy ${qty} ${si.baseAsset} resting at ${fmtPrice(si, limit)} (market ${p8(preview.lastPrice)}). R = ${R.toPrecision(6)}, stop ${req.stopPrice}, target ${trade.takeProfit}`
  )
  logPlan(si, trade, R)

  let placed = false
  if (si.otoAllowed) {
    const exitQty = await sellableQty(client, si, qty)
    try {
      const gap = db.getSettings().quickTrade.stopGapPct
      const res = await client.placeLimitEntryWithOco({
        symbol: si.symbol,
        entryPrice: fmtPrice(si, limit),
        entryQuantity: fmtQty(si, qty),
        exitQuantity: fmtQty(si, exitQty),
        takeProfitPrice: fmtPrice(si, trade.takeProfit),
        stopPrice: fmtPrice(si, req.stopPrice),
        stopLimitPrice: fmtPrice(si, req.stopPrice * (1 - gap / 100)),
        stopKind: stopKindFor(si)
      })
      const reports = res.orderReports.map(normaliseOrder)
      const working = reports.find((o) => o.side === 'BUY')
      const tp = reports.find((o) => o.side === 'SELL' && o.type === 'LIMIT_MAKER')
      const sl = reports.find((o) => o.side === 'SELL' && o.type !== 'LIMIT_MAKER')
      if (!working) throw new BinanceError('Binance accepted the order list but did not return the entry order', -2, 0)
      entry.orderId = working.orderId
      entry.listId = res.orderListId
      entry.pendingTpOrderId = tp?.orderId ?? null
      entry.pendingSlOrderId = sl?.orderId ?? null
      trade.entryOrderId = working.orderId
      placed = true
      log(
        trade,
        `Order list #${res.orderListId}: entry #${working.orderId}; when it fills Binance places the target ${fmtPrice(si, trade.takeProfit)} and the stop ${fmtPrice(si, req.stopPrice)} for ${exitQty} ${si.baseAsset} on its own`
      )
    } catch (e) {
      log(trade, `Could not attach the stop and target to the entry: ${(e as Error).message}. Resting a plain limit buy instead.`)
    }
  } else {
    log(trade, `${si.symbol} does not accept an entry with its exits attached; resting a plain limit buy.`)
  }

  if (!placed) {
    const res = await placeOrder(client, { symbol: si.symbol, side: 'BUY', type: 'LIMIT', quantity: qty, price: limit, timeInForce: 'GTC' })
    const o = res.orders[0]
    if (!o) fail('Binance did not return the limit order')
    entry.orderId = o.orderId
    trade.entryOrderId = o.orderId
    log(trade, `Limit buy #${o.orderId} resting at ${fmtPrice(si, limit)}; the app places the stop and target when it fills`)
  }
  if (expiresAt !== null) log(trade, `The entry is cancelled if it has not filled within ${req.expireMinutes} minutes`)
  saveTrade(testnet, trade)
  return trade
}

/** Take the exits Binance attached to a filled entry off the book; cancelling either leg of an OCO cancels both. */
async function cancelAttachedExits(client: BinanceClient, t: ManagedTrade, e: LimitEntry): Promise<CancelResult> {
  const viaList = await cancelList(client, t, e.listId as number)
  if (viaList !== 'failed') return viaList
  const legId = e.pendingSlOrderId ?? e.pendingTpOrderId
  if (legId === null) return 'failed'
  try {
    await client.cancelOrder(t.symbol, legId)
    return 'cancelled'
  } catch (err) {
    const b = err as BinanceError
    if (b.code === -2011 || /unknown|not found|already/i.test(b.message)) return 'gone'
    log(t, `Could not cancel the attached exits: ${b.message}`)
    return 'failed'
  }
}

/**
 * The entry bought something: recompute everything from the real fill, take the
 * exchange-side legs over with exact quantities, and hand the position to the
 * ladder. From here it is indistinguishable from a market-bought position.
 */
async function activateEntry(client: BinanceClient, si: SymbolInfo, t: ManagedTrade, order: Order, market: number | null): Promise<void> {
  const e = t.limitEntry as LimitEntry
  e.status = 'FILLED'
  e.filledQty = order.executedQty
  const entry = order.cummulativeQuoteQty / order.executedQty

  let baseFee = 0
  try {
    const fills = await client.orderTrades(t.symbol, e.orderId)
    baseFee = fills.filter((x) => x.commissionAsset === si.baseAsset).reduce((s, x) => s + parseFloat(x.commission), 0)
  } catch (err) {
    log(t, `Could not read the entry's fees (${(err as Error).message}); assuming none were charged in ${si.baseAsset}`)
  }
  const bought = numQty(si, order.executedQty - baseFee)
  const actualR = entry - t.initialStop
  const R = actualR > 0 ? actualR : e.limitPrice - t.initialStop

  t.entryPrice = entry
  t.qtyInitial = bought
  t.qty = bought
  t.riskQuote = bought * R
  t.takeProfit = numPrice(si, entry + t.tpR * R)
  t.beTriggerPrice = t.ladder[0] ? entry + t.ladder[0].atR * R : null
  log(
    t,
    `Entry filled: bought ${bought} ${si.baseAsset} at ${p8(entry)} for ${order.cummulativeQuoteQty.toFixed(2)} ${si.quoteAsset} (order #${e.orderId}). R = ${R.toPrecision(6)}, target ${t.takeProfit}`
  )
  if (order.executedQty < e.quantity) {
    log(t, `Only ${order.executedQty} of ${e.quantity} ${si.baseAsset} filled; managing what was bought`)
  }

  // Binance only places the attached legs once the entry fills completely.
  const attached = e.listId !== null && order.status === 'FILLED'
  if (attached) {
    t.ocoOrderListId = e.listId
    t.tpOrderId = e.pendingTpOrderId
    t.slOrderId = e.pendingSlOrderId
    const res = await cancelAttachedExits(client, t, e)
    if (res === 'gone') {
      log(t, 'The attached stop or target has already executed; recording the outcome')
      await resolveMain(client, si, t)
      return
    }
    if (res === 'failed') {
      // Better to keep Binance's exits than to leave the position naked; retried on a later check.
      log(t, 'Could not take the attached exits over; keeping the ones Binance placed')
      return
    }
    t.ocoOrderListId = null
    t.tpOrderId = null
    t.slOrderId = null
    log(t, 'Replaced the attached exits with legs sized to the actual fill')
  }

  splitPartial(si, t, R, market)
  if (actualR <= 0) {
    log(t, `Warning: the fill is at or below the stop ${t.initialStop}; the stop cannot be placed until price recovers`)
    return
  }
  if (t.partial) await placePartialLeg(client, si, t)
  await protect(client, si, t, t.currentStop)
}

/** Take the resting entry off the book. A partial fill is protected instead of discarded. */
async function cancelLimitEntry(client: BinanceClient, si: SymbolInfo, t: ManagedTrade, why: string, market: number | null): Promise<void> {
  const e = t.limitEntry as LimitEntry
  let gone = false
  try {
    if (e.listId !== null) await client.cancelOrderList(t.symbol, e.listId)
    else await client.cancelOrder(t.symbol, e.orderId)
  } catch (err) {
    const b = err as BinanceError
    if (b.code === -2011 || /unknown|not found|already/i.test(b.message)) gone = true
    else throw err
  }
  let order: Order | null = null
  try {
    order = await client.getOrder(t.symbol, e.orderId)
  } catch (err) {
    // Without knowing what the entry did, assuming it bought nothing could strand coins with no stop.
    log(t, `${why}: the order was cancelled but Binance did not say what it had filled (${(err as Error).message}); the next check settles it`)
    return
  }
  if (order.executedQty > 0) {
    log(t, `${why}: the entry had already bought ${order.executedQty} ${t.baseAsset}; protecting it instead`)
    await activateEntry(client, si, t, order, market)
    return
  }
  e.status = 'CANCELLED'
  e.filledQty = 0
  t.phase = 'CANCELLED_ENTRY'
  t.closedAt = Date.now()
  log(t, gone ? `${why}: the entry order was already off the book; nothing was bought` : `${why}: entry order #${e.orderId} cancelled; nothing was bought`)
}

/** One pass over a position whose entry is still resting. */
async function tickLimitEntry(client: BinanceClient, si: SymbolInfo, t: ManagedTrade, market: number | null): Promise<void> {
  const e = t.limitEntry as LimitEntry
  const order = await client.getOrder(t.symbol, e.orderId)
  e.filledQty = order.executedQty
  const settled = ['FILLED', 'CANCELED', 'EXPIRED', 'EXPIRED_IN_MATCH', 'REJECTED'].includes(order.status)
  if (!settled) {
    if (e.expiresAt !== null && Date.now() >= e.expiresAt) await cancelLimitEntry(client, si, t, 'The entry did not fill in time', market)
    return
  }
  if (order.executedQty > 0) {
    await activateEntry(client, si, t, order, market)
    return
  }
  e.status = 'CANCELLED'
  t.phase = 'CANCELLED_ENTRY'
  t.closedAt = Date.now()
  log(t, `Entry order #${e.orderId} is ${order.status.toLowerCase().replace(/_/g, ' ')} without a fill; nothing was bought`)
}

// ---------------------------------------------------------------- adopt an existing position

/**
 * Bring a position that was bought outside the R commands under the stop ladder:
 * cancel its current orders, then place the managed legs exactly as after a
 * fresh buy. The entry price is whatever the user confirms (default: average cost).
 */
export async function adoptPosition(client: BinanceClient, testnet: boolean, req: AdoptRequest): Promise<ManagedTrade> {
  if (!client.hasCredentials) fail('API keys are not configured. Add them in Settings.')
  const si = await client.symbolInfo(req.symbol)
  if (!si) fail(`Unknown symbol ${req.symbol}`)
  if (si.status !== 'TRADING') fail(`${req.symbol} is not currently trading`)
  if (!si.ocoAllowed) fail(`${req.symbol} does not support OCO orders`)
  if (!(req.entryPrice > 0)) fail('Enter the entry price')
  if (!(req.stopPrice > 0) || req.stopPrice >= req.entryPrice) fail('The stop must be below the entry price')
  if (!(req.takeProfit > req.entryPrice)) fail('The target must be above the entry price')
  const last = await client.price(req.symbol)
  if (req.stopPrice >= last) fail(`The stop (${req.stopPrice}) must be below the current price (${last})`)
  if (req.takeProfit <= last) fail(`The target (${req.takeProfit}) must be above the current price (${last})`)

  const swallowGone = (e: unknown): void => {
    const err = e as BinanceError
    if (err.code !== -2011 && !/unknown|not found/i.test(err.message)) throw e
  }
  for (const listId of req.cancelOrderListIds) await client.cancelOrderList(req.symbol, listId).catch(swallowGone)
  for (const orderId of req.cancelOrderIds) await client.cancelOrder(req.symbol, orderId).catch(swallowGone)

  const account = await client.account()
  const free = parseFloat(account.balances.find((b) => b.asset === si.baseAsset)?.free ?? '0')
  const qty = numQty(si, Math.min(req.qty, free))
  if (qty < si.filters.minQty || qty <= 0) fail(`Only ${free} ${si.baseAsset} is free to protect; nothing to manage`)

  const R = req.entryPrice - req.stopPrice
  const tpR = (req.takeProfit - req.entryPrice) / R
  const ladder = buildLadder(tpR, req.beTriggerR, req.partialPct, req.trailStartR, req.trailGapR)
  const trade = newTrade(si, {
    command: req.command || `${tpR.toFixed(1)}R${ladder.length ? ' BE' : ''}`,
    tpR,
    beOffsetPct: req.beOffsetPct,
    entryPrice: req.entryPrice,
    qty,
    initialStop: req.stopPrice,
    takeProfit: req.takeProfit,
    ladder,
    entryOrderId: 0
  })
  log(trade, `Adopted ${qty} ${si.baseAsset} at entry ${p8(req.entryPrice)} (current ${p8(last)}). R = ${R.toPrecision(6)}, stop ${req.stopPrice}, target ${trade.takeProfit} (+${tpR.toFixed(2)}R)`)
  logPlan(si, trade, R)

  splitPartial(si, trade, R, last)
  if (trade.partial) await placePartialLeg(client, si, trade)
  await protect(client, si, trade, req.stopPrice)
  refreshPhase(trade)
  saveTrade(testnet, trade)
  return trade
}

// ---------------------------------------------------------------- exchange helpers

async function placeOcoLeg(
  client: BinanceClient,
  si: SymbolInfo,
  symbol: string,
  qty: number,
  tp: number,
  stop: number
): Promise<{ listId: number; tpId: number | null; slId: number | null }> {
  const gap = db.getSettings().quickTrade.stopGapPct
  const res = await client.placeOco({
    symbol,
    side: 'SELL',
    quantity: fmtQty(si, qty),
    takeProfitPrice: fmtPrice(si, tp),
    stopPrice: fmtPrice(si, stop),
    stopLimitPrice: fmtPrice(si, stop * (1 - gap / 100)),
    stopKind: stopKindFor(si)
  })
  const reports = res.orderReports.map(normaliseOrder)
  return {
    listId: res.orderListId,
    tpId: reports.find((o) => o.type === 'LIMIT_MAKER')?.orderId ?? null,
    slId: reports.find((o) => o.type !== 'LIMIT_MAKER')?.orderId ?? null
  }
}

/** Place (or re-place) the main OCO for t.qty. UNPROTECTED with lastError on failure. */
async function protect(client: BinanceClient, si: SymbolInfo, t: ManagedTrade, stop: number): Promise<void> {
  try {
    const leg = await placeOcoLeg(client, si, t.symbol, t.qty, t.takeProfit, stop)
    t.ocoOrderListId = leg.listId
    t.tpOrderId = leg.tpId
    t.slOrderId = leg.slId
    t.currentStop = stop
    t.lastError = null
    log(t, `Main leg: ${t.qty} ${t.baseAsset}, target ${fmtPrice(si, t.takeProfit)} / stop ${fmtPrice(si, stop)} (${stopKindFor(si).toLowerCase()} stop), OCO #${leg.listId}`)
  } catch (e) {
    const msg = (e as Error).message
    t.ocoOrderListId = null
    t.tpOrderId = null
    t.slOrderId = null
    t.lastError = msg
    log(t, `Could not place the main stop/target: ${msg}`)
  }
  refreshPhase(t)
}

async function placePartialLeg(client: BinanceClient, si: SymbolInfo, t: ManagedTrade): Promise<void> {
  const p = t.partial as PartialLeg
  try {
    const leg = await placeOcoLeg(client, si, t.symbol, p.qty, p.tp, t.currentStop)
    p.ocoOrderListId = leg.listId
    p.tpOrderId = leg.tpId
    p.slOrderId = leg.slId
    log(t, `Partial leg: ${p.qty} ${t.baseAsset} resting at ${fmtPrice(si, p.tp)} (+${t.ladder[0]?.atR ?? '?'}R) with stop ${fmtPrice(si, t.currentStop)}, OCO #${leg.listId}`)
  } catch (e) {
    log(t, `Could not place the partial leg: ${(e as Error).message}. Managing the full size in one leg instead.`)
    t.qty = t.qtyInitial
    t.partial = null
    if (t.ladder[0]) t.ladder[0].closePct = 0
  }
}

type CancelResult = 'cancelled' | 'gone' | 'failed'

/** Cancel an OCO list. 'gone' means it had already executed or been cancelled. */
async function cancelList(client: BinanceClient, t: ManagedTrade, listId: number): Promise<CancelResult> {
  try {
    await client.cancelOrderList(t.symbol, listId)
    return 'cancelled'
  } catch (e) {
    const err = e as BinanceError
    if (err.code === -2011 || /unknown|not found|already/i.test(err.message)) return 'gone'
    log(t, `Could not cancel OCO #${listId}: ${err.message}`)
    return 'failed'
  }
}

function recordPartialFill(t: ManagedTrade, qty: number, price: number, why: string): void {
  const p = t.partial as PartialLeg
  if (!(qty > 0)) return
  const prevQty = p.fillQty
  p.fillPrice = p.fillPrice === null ? price : (p.fillPrice * prevQty + price * qty) / (prevQty + qty)
  p.fillQty = prevQty + qty
  t.realizedPnl = (t.realizedPnl ?? 0) + (price - t.entryPrice) * qty
  const R = rOf(t)
  log(t, `${why}: sold ${qty} ${t.baseAsset} at ${p8(price)}${R > 0 ? ` (${((price - t.entryPrice) / R).toFixed(2)}R)` : ''}`)
}

/** The partial leg's orders are no longer open: find out what happened. */
async function resolvePartial(client: BinanceClient, t: ManagedTrade): Promise<'tp' | 'sl' | 'none'> {
  const p = t.partial as PartialLeg
  const tp = p.tpOrderId !== null ? await client.getOrder(t.symbol, p.tpOrderId).catch(() => null) : null
  const sl = p.slOrderId !== null ? await client.getOrder(t.symbol, p.slOrderId).catch(() => null) : null
  const filled = tp && tp.executedQty > 0 ? tp : sl && sl.executedQty > 0 ? sl : null
  if (filled) recordPartialFill(t, filled.executedQty, filled.cummulativeQuoteQty / filled.executedQty, filled === tp ? 'Partial target filled' : 'Partial leg stopped')
  else log(t, 'Partial leg orders are gone without a fill (cancelled outside the app)')
  p.status = filled ? 'FILLED' : 'CANCELLED'
  p.filledAt = Date.now()
  p.ocoOrderListId = null
  p.tpOrderId = null
  p.slOrderId = null
  return filled ? (filled === tp ? 'tp' : 'sl') : 'none'
}

/** Cancel the partial leg and sell whatever of it is still unsold at market. */
async function closePartialAtMarket(client: BinanceClient, si: SymbolInfo, t: ManagedTrade, why: string): Promise<void> {
  const p = t.partial as PartialLeg
  if (p.status !== 'OPEN') return
  if (p.ocoOrderListId !== null) {
    const r = await cancelList(client, t, p.ocoOrderListId)
    if (r === 'failed') return
    if (r === 'gone') {
      await resolvePartial(client, t)
      return
    }
  }
  let executed = 0
  if (p.tpOrderId !== null) {
    const o = await client.getOrder(t.symbol, p.tpOrderId).catch(() => null)
    if (o && o.executedQty > 0) {
      executed = o.executedQty
      recordPartialFill(t, o.executedQty, o.cummulativeQuoteQty / o.executedQty, 'Partial target partly filled')
    }
  }
  const remaining = numQty(si, p.qty - executed)
  if (remaining >= si.filters.minQty && remaining > 0) {
    const res = await placeOrder(client, { symbol: t.symbol, side: 'SELL', type: 'MARKET', quantity: remaining })
    const o = res.orders[0]
    if (o && o.executedQty > 0) recordPartialFill(t, o.executedQty, o.cummulativeQuoteQty / o.executedQty, `${why}: partial sold at market`)
  }
  p.status = 'FILLED'
  p.filledAt = Date.now()
  p.ocoOrderListId = null
  p.tpOrderId = null
  p.slOrderId = null
}

function finalize(t: ManagedTrade, phase: ManagedTrade['phase'], exitPrice: number | null, qtySold: number, message: string): void {
  t.phase = phase
  t.closedAt = Date.now()
  t.exitPrice = exitPrice
  if (exitPrice !== null) t.realizedPnl = (t.realizedPnl ?? 0) + (exitPrice - t.entryPrice) * qtySold
  t.ocoOrderListId = null
  t.tpOrderId = null
  t.slOrderId = null
  log(t, message)
}

/** The main leg's orders are no longer open: record the outcome. */
async function resolveMain(client: BinanceClient, si: SymbolInfo, t: ManagedTrade): Promise<void> {
  const tp = t.tpOrderId !== null ? await client.getOrder(t.symbol, t.tpOrderId).catch(() => null) : null
  const sl = t.slOrderId !== null ? await client.getOrder(t.symbol, t.slOrderId).catch(() => null) : null
  const filled = tp && tp.executedQty > 0 ? tp : sl && sl.executedQty > 0 ? sl : null
  if (filled) {
    const exit = filled.cummulativeQuoteQty / filled.executedQty
    const isTp = filled === tp
    const R = rOf(t)
    finalize(
      t,
      isTp ? 'CLOSED_TP' : 'CLOSED_SL',
      exit,
      filled.executedQty,
      `${isTp ? 'Target' : 'Stop'} filled: sold ${filled.executedQty} at ${p8(exit)}${R > 0 ? ` (${((exit - t.entryPrice) / R).toFixed(2)}R)` : ''} (order #${filled.orderId})`
    )
  } else {
    finalize(t, 'CLOSED_MANUAL', null, 0, 'Both main-leg orders are gone without a fill (cancelled outside the app); marked closed')
  }
  if (t.partial && t.partial.status === 'OPEN') {
    try {
      await closePartialAtMarket(client, si, t, 'Main leg closed')
    } catch (e) {
      log(t, `Could not close the partial leg: ${(e as Error).message}`)
    }
  }
}

/** Sell everything that is left at market and finalize. */
async function sellAndFinalize(client: BinanceClient, si: SymbolInfo, t: ManagedTrade, phase: ManagedTrade['phase'], why: string): Promise<void> {
  if (t.ocoOrderListId !== null) {
    const r = await cancelList(client, t, t.ocoOrderListId)
    if (r === 'failed') return
    if (r === 'gone') {
      await resolveMain(client, si, t)
      return
    }
    t.ocoOrderListId = null
    t.tpOrderId = null
    t.slOrderId = null
  }
  let partialRemaining = 0
  if (t.partial && t.partial.status === 'OPEN') {
    if (t.partial.ocoOrderListId !== null) {
      const r = await cancelList(client, t, t.partial.ocoOrderListId)
      if (r === 'failed') return
      if (r === 'gone') await resolvePartial(client, t)
    }
    if (t.partial.status === 'OPEN') {
      partialRemaining = Math.max(0, t.partial.qty - t.partial.fillQty)
      t.partial.status = 'FILLED'
      t.partial.filledAt = Date.now()
      t.partial.ocoOrderListId = null
      t.partial.tpOrderId = null
      t.partial.slOrderId = null
    }
  }
  const account = await client.account()
  const free = parseFloat(account.balances.find((b) => b.asset === t.baseAsset)?.free ?? '0')
  const qty = numQty(si, Math.min(t.qty + partialRemaining, free))
  if (qty < si.filters.minQty || qty <= 0) {
    finalize(t, 'CLOSED_MANUAL', null, 0, `${why}: nothing left to sell (free ${free} ${t.baseAsset}); marked closed`)
    return
  }
  const res = await placeOrder(client, { symbol: t.symbol, side: 'SELL', type: 'MARKET', quantity: qty })
  const o = res.orders[0]
  const exit = o && o.executedQty > 0 ? o.cummulativeQuoteQty / o.executedQty : null
  finalize(t, phase, exit, o?.executedQty ?? qty, `${why}: sold ${o?.executedQty ?? qty} at ${exit !== null ? p8(exit) : '?'} (order #${o?.orderId ?? '?'})`)
}

/** Apply ladder rungs that are due: sell the partial (first rung) and move the main stop to the highest due rung. */
async function applySteps(client: BinanceClient, si: SymbolInfo, t: ManagedTrade, steps: LadderStep[], price: number, why: string): Promise<boolean> {
  if (steps.length === 0 || t.ocoOrderListId === null) return false
  const R = rOf(t)
  if (R <= 0) return false
  const target = steps[steps.length - 1]
  const newStop = stopPriceFor(si, t, R, target.stopR)
  if (newStop >= price) {
    log(t, `${why}: the new stop ${newStop} is not below the current price ${price}; waiting`)
    return false
  }
  if (steps.some((s) => s.closePct > 0) && t.partial && t.partial.status === 'OPEN') {
    await closePartialAtMarket(client, si, t, why)
  }
  if (newStop <= t.currentStop) {
    for (const s of steps) {
      s.done = true
      s.doneAt = Date.now()
    }
    log(t, `${why}: stop already at ${t.currentStop}, nothing to move`)
    return true
  }
  const r = await cancelList(client, t, t.ocoOrderListId)
  if (r === 'failed') return false
  if (r === 'gone') {
    log(t, `${why}: the main leg already executed; recording the outcome`)
    return false
  }
  t.ocoOrderListId = null
  t.tpOrderId = null
  t.slOrderId = null
  const from = t.currentStop
  for (const s of steps) {
    s.done = true
    s.doneAt = Date.now()
  }
  t.stopR = target.stopR
  if (target.stopR === 0) t.beMovedAt = Date.now()
  log(t, `${why}: moving stop ${from} -> ${newStop} (${target.stopR === 0 ? 'break-even' : `+${target.stopR}R`})`)
  await protect(client, si, t, newStop)
  return true
}

// ---------------------------------------------------------------- manager tick

export async function tickManagedTrades(client: BinanceClient, testnet: boolean, prices: Map<string, number> | null): Promise<void> {
  const store = db.managed(testnet)
  const open = store.get().filter(isOpenTrade)
  if (open.length === 0) return

  for (const original of open) {
    const t = structuredClone(original)
    // Clear it for this pass: a failure sets it again below, so an error from an
    // earlier check (a dropped connection, a restart) stops being shown once the
    // position is being watched normally again.
    const previousError = t.lastError
    t.lastError = null
    try {
      const si = await client.symbolInfo(t.symbol)
      if (!si) continue
      const price = prices?.get(t.symbol) ?? (await client.price(t.symbol))

      // 0. Nothing bought yet: watch the resting entry until it fills or goes away.
      if (waitingEntry(t)) {
        await tickLimitEntry(client, si, t, price)
        refreshPhase(t)
        if (JSON.stringify(t) !== JSON.stringify(original)) saveTrade(testnet, t)
        continue
      }

      const needOrders = t.ocoOrderListId !== null || (t.partial !== null && t.partial.status === 'OPEN' && t.partial.ocoOrderListId !== null)
      const openOrders = needOrders ? await client.openOrders(t.symbol) : []
      const isLive = (id: number | null): boolean => id !== null && openOrders.some((o) => o.orderId === id)

      // 1. Partial leg bookkeeping.
      if (t.partial && t.partial.status === 'OPEN' && t.partial.ocoOrderListId !== null && !isLive(t.partial.tpOrderId) && !isLive(t.partial.slOrderId)) {
        const outcome = await resolvePartial(client, t)
        if (outcome === 'tp' && t.ladder[0] && !t.ladder[0].done && t.ocoOrderListId !== null && isLive(t.slOrderId)) {
          await applySteps(client, si, t, [t.ladder[0]], price, 'Partial target filled')
        }
      }

      // 2. Main leg.
      if (t.ocoOrderListId === null) {
        if (price <= t.currentStop) {
          await sellAndFinalize(client, si, t, 'CLOSED_SL', `Software stop: price ${price} is at/below the stop ${t.currentStop} while unprotected`)
        } else {
          await protect(client, si, t, t.currentStop)
          if (t.ocoOrderListId === null && /insufficient balance/i.test(t.lastError ?? '')) {
            finalize(t, 'CLOSED_MANUAL', null, 0, 'The coins are no longer in the account; marked closed')
          }
        }
      } else if (!isLive(t.tpOrderId) && !isLive(t.slOrderId)) {
        await resolveMain(client, si, t)
      } else {
        const R = rOf(t)
        const due = R > 0 ? t.ladder.filter((s) => !s.done && price >= t.entryPrice + s.atR * R) : []
        if (due.length) await applySteps(client, si, t, due, price, `Price ${price} reached +${due[due.length - 1].atR}R`)
      }
    } catch (e) {
      const msg = (e as Error).message
      t.lastError = msg
      // Only log a change, so a persistent fault does not fill the log every 15s.
      if (previousError !== msg) log(t, `Check failed: ${msg}`)
    }
    refreshPhase(t)
    if (JSON.stringify(t) !== JSON.stringify(original)) saveTrade(testnet, t)
  }
}

// ---------------------------------------------------------------- manual actions

function find(testnet: boolean, id: string): ManagedTrade {
  const t = db.managed(testnet).get().find((x) => x.id === id)
  if (!t) fail('Position not found')
  return structuredClone(t)
}

export function listTrades(testnet: boolean): ManagedTrade[] {
  return [...db.managed(testnet).get()].sort((a, b) => b.createdAt - a.createdAt)
}

/** Move the stop to the next ladder rung now (or to break-even when there is no ladder). */
/**
 * Sell part of a live position at market and carry on managing the rest.
 *
 * Entry, R and the ladder are deliberately untouched: only the quantity
 * shrinks. The exits have to be replaced rather than edited, because the
 * resting OCO covers a size that is no longer held, and Binance would reject
 * the sells the moment either leg triggered.
 *
 * The percentage applies to the main leg - the part carrying the stop and
 * target. A partial leg still resting at its rung is left alone, so a "50%"
 * here means half of what the stop protects, not half of every open order.
 */
export async function reducePosition(client: BinanceClient, testnet: boolean, id: string, by: ReduceBy): Promise<ManagedTrade> {
  const t = find(testnet, id)
  if (!isOpenTrade(t)) fail('Position is already closed')
  if (waitingEntry(t)) fail('Nothing has been bought yet. Cancel the entry instead, or reduce it once it fills.')
  if (!(by.value > 0)) fail('Enter an amount above zero')

  const si = (await client.symbolInfo(t.symbol)) as SymbolInfo
  const price = await client.price(t.symbol)
  const wanted = numQty(si, quantityFor(by, { qty: t.qty, price, entry: t.entryPrice, stop: t.currentStop }))
  const pct = Math.round((wanted / t.qty) * 100)
  const remainingAfter = numQty(si, t.qty - wanted)

  if (wanted >= t.qty) fail(`That is the whole position (${t.qty} ${t.baseAsset}). Use "Close at market" instead.`)
  if (wanted <= 0 || wanted < si.filters.minQty || wanted * price < si.filters.minNotional) {
    fail(`That works out to ${wanted} ${t.baseAsset}, below what ${t.symbol} allows. Reduce by more, or close the position.`)
  }
  // What is left has to stand on its own as an order, or there is no position to keep.
  if (remainingAfter < si.filters.minQty || remainingAfter * price < si.filters.minNotional) {
    fail(`That would leave ${remainingAfter} ${t.baseAsset}, too small for ${t.symbol} to protect. Close the position instead.`)
  }

  // Take the exits down first: selling underneath a live OCO strands it on a size that is gone.
  if (t.ocoOrderListId !== null) {
    const r = await cancelList(client, t, t.ocoOrderListId)
    if (r === 'failed') fail('Could not cancel the current stop and target, so nothing was sold. Try again.')
    if (r === 'gone') {
      await resolveMain(client, si, t)
      refreshPhase(t)
      saveTrade(testnet, t)
      fail('The position closed on its own while reducing it; nothing was sold.')
    }
    t.ocoOrderListId = null
    t.tpOrderId = null
    t.slOrderId = null
  }

  const account = await client.account()
  const free = parseFloat(account.balances.find((b) => b.asset === t.baseAsset)?.free ?? '0')
  const qty = numQty(si, Math.min(wanted, free))
  if (qty < si.filters.minQty || qty <= 0) {
    // The coins are not there: put the exits back on what is actually held.
    await protect(client, si, t, t.currentStop)
    saveTrade(testnet, t)
    fail(`Only ${free} ${t.baseAsset} is free, which is not enough to sell. The stop and target have been put back.`)
  }

  let sold = 0
  try {
    const res = await placeOrder(client, { symbol: t.symbol, side: 'SELL', type: 'MARKET', quantity: qty })
    const o = res.orders[0]
    sold = o?.executedQty ?? qty
    const exit = o && o.executedQty > 0 ? o.cummulativeQuoteQty / o.executedQty : null
    const R = rOf(t)
    log(
      t,
      `Reduced by ${describeReduce(by)} (~${pct}%): sold ${sold} ${t.baseAsset} at ${exit !== null ? p8(exit) : '?'}` +
        (exit !== null && R > 0 ? ` (${((exit - t.entryPrice) / R).toFixed(2)}R)` : '') +
        ` (order #${o?.orderId ?? '?'})`
    )
  } catch (e) {
    // The sell failed, so the size is unchanged: restore the protection we took down.
    await protect(client, si, t, t.currentStop)
    refreshPhase(t)
    saveTrade(testnet, t)
    fail(`Could not sell: ${(e as Error).message}. The stop and target have been put back.`)
  }

  t.qty = numQty(si, Math.max(0, t.qty - sold))
  if (t.qty < si.filters.minQty || t.qty * price < si.filters.minNotional) {
    // Whatever is left cannot be protected on its own; treat the reduction as a close.
    await sellAndFinalize(client, si, t, 'CLOSED_MANUAL', 'Remainder too small to protect after reducing')
  } else {
    await protect(client, si, t, t.currentStop)
  }

  refreshPhase(t)
  saveTrade(testnet, t)
  return t
}

export async function moveStopUp(client: BinanceClient, testnet: boolean, id: string): Promise<ManagedTrade> {
  const t = find(testnet, id)
  if (!isOpenTrade(t)) fail('Position is already closed')
  if (waitingEntry(t)) fail('The entry has not filled yet, so there is no stop to move')
  if (t.ocoOrderListId === null) fail('The position has no live stop to move; wait for it to be protected first')
  let next = t.ladder.find((s) => !s.done)
  if (!next) {
    if (t.stopR !== null) fail('The stop is already at the last configured level')
    next = { atR: 0, stopR: 0, closePct: 0, done: false, doneAt: null }
    t.ladder = [...t.ladder, next]
  }
  const si = (await client.symbolInfo(t.symbol)) as SymbolInfo
  const price = await client.price(t.symbol)
  const moved = await applySteps(client, si, t, [next], price, 'Manual')
  refreshPhase(t)
  saveTrade(testnet, t)
  if (!moved) fail(`Cannot move the stop to ${next.stopR === 0 ? 'break-even' : `+${next.stopR}R`} while price is ${price}`)
  return t
}

export async function closeNow(client: BinanceClient, testnet: boolean, id: string): Promise<ManagedTrade> {
  const t = find(testnet, id)
  if (!isOpenTrade(t)) fail('Position is already closed')
  const si = (await client.symbolInfo(t.symbol)) as SymbolInfo
  const price = await client.price(t.symbol).catch(() => null)
  if (waitingEntry(t)) {
    // Cancelling can still turn up a partial fill; sell whatever it protected.
    await cancelLimitEntry(client, si, t, 'Closed by user', price)
    if (isOpenTrade(t)) await sellAndFinalize(client, si, t, 'CLOSED_MANUAL', 'Closed at market by user')
  } else {
    await sellAndFinalize(client, si, t, 'CLOSED_MANUAL', 'Closed at market by user')
  }
  refreshPhase(t)
  saveTrade(testnet, t)
  return t
}

/** Take a resting entry off the book without opening the position. */
export async function cancelEntry(client: BinanceClient, testnet: boolean, id: string): Promise<ManagedTrade> {
  const t = find(testnet, id)
  if (!isOpenTrade(t)) fail('Position is already closed')
  if (!waitingEntry(t)) fail('This position has no entry order waiting to fill')
  const si = (await client.symbolInfo(t.symbol)) as SymbolInfo
  const price = await client.price(t.symbol).catch(() => null)
  await cancelLimitEntry(client, si, t, 'Cancelled by user', price)
  refreshPhase(t)
  saveTrade(testnet, t)
  return t
}

export function releaseTrade(testnet: boolean, id: string): ManagedTrade {
  const t = find(testnet, id)
  if (!isOpenTrade(t)) fail('Position is already closed')
  t.phase = 'RELEASED'
  t.closedAt = Date.now()
  log(
    t,
    waitingEntry(t)
      ? 'Released: the app stopped managing this position; the entry order and its attached exits stay on the exchange'
      : 'Released: the app stopped managing this position; any SL/TP orders stay on the exchange'
  )
  saveTrade(testnet, t)
  return t
}

export function removeTrade(testnet: boolean, id: string): ManagedTrade[] {
  const t = find(testnet, id)
  if (isOpenTrade(t)) fail('Close or release the position before removing it')
  db.managed(testnet).update((list) => list.filter((x) => x.id !== id))
  broadcast('rtrade:changed')
  return listTrades(testnet)
}
