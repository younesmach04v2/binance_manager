import type { OrderRequest, OrderResult, SymbolInfo } from '../../shared/types'
import { BinanceError, normaliseOrder, roundToStep, type BinanceClient, type RawOrder } from '../binance/client'

function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
}

function ensure(cond: unknown, message: string): asserts cond {
  if (!cond) throw new BinanceError(message, -2, 0)
}

/**
 * Validate an order against the exchange filters, format quantities to the
 * allowed precision, then submit. `req.test` sends to the test endpoint, which
 * validates without placing anything.
 */
export async function placeOrder(client: BinanceClient, req: OrderRequest): Promise<OrderResult> {
  const si: SymbolInfo | null = await client.symbolInfo(req.symbol)
  ensure(si, `Unknown symbol ${req.symbol}`)
  ensure(si.status === 'TRADING', `${req.symbol} is not currently trading (${si.status})`)
  const f = si.filters

  const fmtQty = (q: number): string => {
    ensure(q > 0, 'Quantity must be positive')
    const s = roundToStep(q, f.stepSize, f.quantityPrecision)
    ensure(parseFloat(s) >= f.minQty, `Quantity below minimum ${f.minQty} ${si.baseAsset}`)
    return s
  }
  const fmtPrice = (p: number, label = 'Price'): string => {
    ensure(p > 0, `${label} must be positive`)
    return roundToStep(p, f.tickSize, f.pricePrecision)
  }
  const checkNotional = (qty: number, price: number): void => {
    ensure(qty * price >= f.minNotional, `Order value must be at least ${f.minNotional} ${si.quoteAsset}`)
  }

  if (req.type === 'OCO') {
    ensure(!req.test, 'Binance has no test endpoint for OCO orders. Use the testnet to try them safely.')
    ensure(si.ocoAllowed, `${req.symbol} does not support OCO orders`)
    ensure(req.quantity, 'OCO orders need a quantity')
    ensure(req.takeProfitPrice, 'OCO orders need a take-profit price')
    ensure(req.stopPrice, 'OCO orders need a stop price')
    if (req.side === 'SELL') ensure(req.takeProfitPrice > req.stopPrice, 'For a SELL OCO the take-profit must be above the stop')
    else ensure(req.stopPrice > req.takeProfitPrice, 'For a BUY OCO the stop must be above the take-profit')
    const stopLimit = req.price ?? req.stopPrice * (req.side === 'SELL' ? 0.995 : 1.005)
    const quantity = fmtQty(req.quantity)
    checkNotional(parseFloat(quantity), Math.min(req.takeProfitPrice, req.stopPrice))
    const res = await client.placeOco({
      symbol: req.symbol,
      side: req.side,
      quantity,
      takeProfitPrice: fmtPrice(req.takeProfitPrice, 'Take-profit'),
      stopPrice: fmtPrice(req.stopPrice, 'Stop'),
      stopLimitPrice: fmtPrice(stopLimit, 'Stop limit')
    })
    return { ok: true, test: false, orders: res.orderReports.map(normaliseOrder), raw: res }
  }

  const params: Record<string, string | number | undefined> = {
    symbol: req.symbol,
    side: req.side,
    type: req.type
  }

  switch (req.type) {
    case 'MARKET': {
      if (req.quoteOrderQty) {
        ensure(req.quoteOrderQty >= f.minNotional, `Order value must be at least ${f.minNotional} ${si.quoteAsset}`)
        params.quoteOrderQty = trimZeros(req.quoteOrderQty.toFixed(8))
      } else {
        ensure(req.quantity, 'Market orders need a quantity or a quote amount')
        params.quantity = fmtQty(req.quantity)
      }
      break
    }
    case 'LIMIT': {
      ensure(req.quantity, 'Limit orders need a quantity')
      ensure(req.price, 'Limit orders need a price')
      params.quantity = fmtQty(req.quantity)
      params.price = fmtPrice(req.price)
      params.timeInForce = req.timeInForce ?? 'GTC'
      checkNotional(parseFloat(params.quantity), parseFloat(params.price))
      break
    }
    case 'STOP_LOSS_LIMIT':
    case 'TAKE_PROFIT_LIMIT': {
      ensure(req.quantity, 'Stop orders need a quantity')
      ensure(req.stopPrice, 'Stop orders need a stop (trigger) price')
      const limit = req.price ?? req.stopPrice * (req.side === 'SELL' ? 0.995 : 1.005)
      params.quantity = fmtQty(req.quantity)
      params.stopPrice = fmtPrice(req.stopPrice, 'Stop')
      params.price = fmtPrice(limit, 'Limit')
      params.timeInForce = req.timeInForce ?? 'GTC'
      checkNotional(parseFloat(params.quantity), parseFloat(params.price))
      break
    }
    default:
      throw new BinanceError(`Unsupported order type ${String(req.type)}`, -2, 0)
  }

  const raw = await client.placeOrder(params, !!req.test)
  if (req.test) return { ok: true, test: true, orders: [], raw }
  return { ok: true, test: false, orders: [normaliseOrder(raw as RawOrder)], raw }
}

export async function cancelOrder(
  client: BinanceClient,
  symbol: string,
  orderId: number,
  orderListId?: number
): Promise<void> {
  if (orderListId !== undefined && orderListId >= 0) {
    await client.cancelOrderList(symbol, orderListId)
  } else {
    await client.cancelOrder(symbol, orderId)
  }
}
