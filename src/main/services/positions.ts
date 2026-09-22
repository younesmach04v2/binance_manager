import type { ClosePositionRequest, ClosePositionResult, ExchangePosition, Order, ReducePositionRequest, ReducePositionResult, Settings } from '../../shared/types'
import { BinanceError, roundToStep, type BinanceClient } from '../binance/client'
import { db } from '../store/db'
import { placeOrder } from './orders'
import { quantityFor } from '../../shared/reduce'
import { buildPortfolio, STABLES } from './portfolio'
import { isLiveTrade } from './rtrade'

const QUOTES = ['USDT', 'USDC', 'FDUSD', 'BTC', 'ETH', 'BNB']

function fail(message: string): never {
  throw new BinanceError(message, -2, 0)
}

/**
 * Every non-stable holding that is not already an app-managed position, with
 * the stop and target its open SELL orders currently give it.
 */
export async function listExchangePositions(client: BinanceClient, settings: Settings): Promise<ExchangePosition[]> {
  const [portfolio, openOrders, info] = await Promise.all([buildPortfolio(client, settings), client.openOrders(), client.exchangeInfo()])
  const managedSymbols = new Set(
    db
      .managed(settings.testnet)
      .get()
      .filter(isLiveTrade)
      .map((t) => t.symbol)
  )
  const bySymbol = new Map<string, Order[]>()
  for (const o of openOrders) {
    const list = bySymbol.get(o.symbol) ?? []
    list.push(o)
    bySymbol.set(o.symbol, list)
  }

  const out: ExchangePosition[] = []
  for (const h of portfolio.holdings) {
    if (STABLES.has(h.asset) || h.asset === settings.quoteAsset) continue
    // Prefer the pair with open orders, then the portfolio quote, then other common quotes.
    let symbol = [...bySymbol.keys()].find((s) => info.get(s)?.baseAsset === h.asset)
    if (!symbol) symbol = [settings.quoteAsset, ...QUOTES].map((q) => h.asset + q).find((s) => info.has(s))
    if (!symbol) continue
    if (managedSymbols.has(symbol)) continue
    const si = info.get(symbol)
    const sells = (bySymbol.get(symbol) ?? []).filter((o) => o.side === 'SELL')
    const stops = sells.filter((o) => o.type.includes('STOP') && o.stopPrice > 0).sort((a, b) => b.origQty - a.origQty)
    const targets = sells
      .filter((o) => (o.type === 'LIMIT_MAKER' || o.type === 'LIMIT') && o.price > 0 && (h.price === null || o.price > h.price))
      .sort((a, b) => b.origQty - a.origQty)
    out.push({
      symbol,
      baseAsset: h.asset,
      quoteAsset: si?.quoteAsset ?? settings.quoteAsset,
      qty: h.total,
      free: h.free,
      locked: h.locked,
      price: h.price,
      value: h.value,
      entryPrice: h.avgCost,
      costBasisCoverage: h.costBasisCoverage,
      unrealizedPnl: h.unrealizedPnl,
      unrealizedPnlPct: h.unrealizedPnlPct,
      change24hPct: h.change24hPct,
      stopPrice: stops[0]?.stopPrice ?? null,
      stopType: stops[0]?.type ?? null,
      targetPrice: targets[0]?.price ?? null,
      orders: sells,
      orderListIds: Array.from(new Set(sells.map((o) => o.orderListId).filter((id) => id >= 0)))
    })
  }
  return out.sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
}

/**
 * Sell part of a plain holding and put its protection back on what is left.
 *
 * The open SELL orders cover the size held now, so they have to come down
 * before selling; the remainder would otherwise be guarded by an OCO for a
 * quantity that no longer exists, which Binance rejects when it triggers. The
 * same stop and target prices are then re-placed for the smaller size.
 */
export async function reduceExchangePosition(client: BinanceClient, req: ReducePositionRequest): Promise<ReducePositionResult> {
  if (!client.hasCredentials) fail('API keys are not configured. Add them in Settings.')
  if (!(req.by.value > 0)) fail('Enter an amount above zero')
  const si = await client.symbolInfo(req.symbol)
  if (!si) fail(`Unknown symbol ${req.symbol}`)

  const held = parseFloat((await client.account()).balances.find((b) => b.asset === si.baseAsset)?.free ?? '0')
  const locked = await client.openOrders(req.symbol)
  const price = await client.price(req.symbol)
  // Everything the open SELL orders are holding becomes free once they are cancelled.
  const reserved = locked.filter((o) => o.side === 'SELL').reduce((sum, o) => sum + Math.max(0, o.origQty - o.executedQty), 0)
  const total = parseFloat(roundToStep(held + reserved, si.filters.stepSize, si.filters.quantityPrecision))

  const asked = quantityFor(req.by, { qty: total, price, entry: req.entryPrice, stop: req.stopPrice })
  const want = parseFloat(roundToStep(asked, si.filters.stepSize, si.filters.quantityPrecision))
  const left = parseFloat(roundToStep(total - want, si.filters.stepSize, si.filters.quantityPrecision))
  if (want >= total) fail(`That is the whole position (${total} ${si.baseAsset}). Use "Close at market" instead.`)
  if (want < si.filters.minQty || want * price < si.filters.minNotional) {
    fail(`That works out to ${want} ${si.baseAsset}, below what ${req.symbol} allows. Reduce by more, or close the position.`)
  }
  if (left < si.filters.minQty || left * price < si.filters.minNotional) {
    fail(`That would leave ${left} ${si.baseAsset}, too small for ${req.symbol} to trade. Close the position instead.`)
  }

  const swallowGone = (e: unknown): void => {
    const err = e as BinanceError
    if (err.code !== -2011 && !/unknown|not found/i.test(err.message)) throw e
  }
  for (const listId of req.cancelOrderListIds) await client.cancelOrderList(req.symbol, listId).catch(swallowGone)
  for (const orderId of req.cancelOrderIds) await client.cancelOrder(req.symbol, orderId).catch(swallowGone)

  const res = await placeOrder(client, { symbol: req.symbol, side: 'SELL', type: 'MARKET', quantity: want })
  const o = res.orders[0]
  const sold = o?.executedQty ?? want
  const exit = o && o.executedQty > 0 ? o.cummulativeQuoteQty / o.executedQty : null

  // Re-protect the remainder with the levels it had, when both are known.
  let reprotected: ReducePositionResult['reprotected'] = 'none'
  let note: string | null = null
  const free = parseFloat((await client.account()).balances.find((b) => b.asset === si.baseAsset)?.free ?? '0')
  const keep = parseFloat(roundToStep(Math.min(left, free), si.filters.stepSize, si.filters.quantityPrecision))
  if (req.stopPrice && req.targetPrice && req.targetPrice > req.stopPrice && si.ocoAllowed && keep >= si.filters.minQty) {
    try {
      await placeOrder(client, {
        symbol: req.symbol,
        side: 'SELL',
        type: 'OCO',
        quantity: keep,
        takeProfitPrice: req.targetPrice,
        stopPrice: req.stopPrice
      })
      reprotected = 'oco'
    } catch (e) {
      note = `Sold, but the stop and target could not be put back: ${(e as Error).message}`
    }
  } else if (req.stopPrice || req.targetPrice) {
    note = 'Sold. The remainder has no stop and target back on it: only one of the two levels was known.'
  }

  return { sold, price: exit, orderId: o?.orderId ?? null, remaining: keep, reprotected, note }
}

/** Cancel the position's orders, then sell what is free at market. */
export async function closeExchangePosition(client: BinanceClient, req: ClosePositionRequest): Promise<ClosePositionResult> {
  if (!client.hasCredentials) fail('API keys are not configured. Add them in Settings.')
  const si = await client.symbolInfo(req.symbol)
  if (!si) fail(`Unknown symbol ${req.symbol}`)
  const swallowGone = (e: unknown): void => {
    const err = e as BinanceError
    if (err.code !== -2011 && !/unknown|not found/i.test(err.message)) throw e
  }
  for (const listId of req.cancelOrderListIds) await client.cancelOrderList(req.symbol, listId).catch(swallowGone)
  for (const orderId of req.cancelOrderIds) await client.cancelOrder(req.symbol, orderId).catch(swallowGone)

  const account = await client.account()
  const free = parseFloat(account.balances.find((b) => b.asset === si.baseAsset)?.free ?? '0')
  const want = req.qty ?? free
  const qty = parseFloat(roundToStep(Math.min(want, free), si.filters.stepSize, si.filters.quantityPrecision))
  if (qty < si.filters.minQty || qty <= 0) return { sold: 0, price: null, orderId: null }
  const res = await placeOrder(client, { symbol: req.symbol, side: 'SELL', type: 'MARKET', quantity: qty })
  const o = res.orders[0]
  return {
    sold: o?.executedQty ?? qty,
    price: o && o.executedQty > 0 ? o.cummulativeQuoteQty / o.executedQty : null,
    orderId: o?.orderId ?? null
  }
}
