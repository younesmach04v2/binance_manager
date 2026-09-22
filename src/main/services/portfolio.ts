import type { Holding, Portfolio, Settings, Trade } from '../../shared/types'
import type { BinanceClient } from '../binance/client'
import { db } from '../store/db'

const BRIDGES = ['USDT', 'BTC', 'ETH', 'BNB', 'USDC', 'FDUSD']

/** Assets counted as cash rather than as an open position. */
export const STABLES = new Set(['USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD', 'DAI', 'USDP', 'USD1', 'EUR', 'EURI'])

/** Price of one unit of `asset` expressed in `quote`, using direct, inverse or bridged pairs. */
export function priceIn(asset: string, quote: string, prices: Map<string, number>): number | null {
  if (asset === quote) return 1
  const direct = prices.get(asset + quote)
  if (direct) return direct
  const inverse = prices.get(quote + asset)
  if (inverse) return 1 / inverse
  for (const bridge of BRIDGES) {
    if (bridge === asset || bridge === quote) continue
    const a = prices.get(asset + bridge)
    const b = priceIn(bridge, quote, prices)
    if (a && b) return a * b
  }
  return null
}

export interface CostBasis {
  qty: number // net quantity acquired through synced trades
  cost: number // total cost of that quantity, in the portfolio quote asset
  realized: number // realized P&L from sells, in the portfolio quote asset
}

/** Fee paid in the portfolio quote asset. Base-asset fees are handled by reducing quantity instead. */
export function feeInQuote(t: Trade, quoteAsset: string, prices: Map<string, number>, factor: number): number {
  if (t.commissionAsset === t.baseAsset) return 0
  if (t.commissionAsset === t.quoteAsset) return t.commission * factor
  const p = priceIn(t.commissionAsset, quoteAsset, prices)
  return p ? t.commission * p : 0
}

/** Conversion factor from a trade's own quote asset to the portfolio quote asset (1 when identical). */
export function quoteFactor(tradeQuote: string, quoteAsset: string, prices: Map<string, number>): number {
  if (tradeQuote === quoteAsset) return 1
  return priceIn(tradeQuote, quoteAsset, prices) ?? 1
}

/**
 * Weighted-average cost basis per base asset. Sells beyond the known position
 * (assets that were deposited rather than bought) are ignored, so realized P&L
 * only covers quantity with a known entry price.
 */
export function computeCostBasis(
  trades: Trade[],
  quoteAsset: string,
  prices: Map<string, number>
): Map<string, CostBasis> {
  const sorted = [...trades].sort((a, b) => a.time - b.time || a.id - b.id)
  const out = new Map<string, CostBasis>()
  for (const t of sorted) {
    const basis = out.get(t.baseAsset) ?? { qty: 0, cost: 0, realized: 0 }
    const factor = quoteFactor(t.quoteAsset, quoteAsset, prices)
    const fee = feeInQuote(t, quoteAsset, prices, factor)
    const baseFee = t.commissionAsset === t.baseAsset ? t.commission : 0

    if (t.isBuyer) {
      basis.qty += t.qty - baseFee
      basis.cost += t.quoteQty * factor + fee
    } else if (basis.qty > 0) {
      const avg = basis.cost / basis.qty
      const sellQty = Math.min(t.qty, basis.qty)
      const proceeds = (sellQty / t.qty) * t.quoteQty * factor
      basis.realized += proceeds - sellQty * avg - fee
      basis.cost -= sellQty * avg
      basis.qty -= sellQty
      if (basis.qty < 1e-12) {
        basis.qty = 0
        basis.cost = 0
      }
    }
    out.set(t.baseAsset, basis)
  }
  return out
}

export function recordHistory(testnet: boolean, value: number): void {
  const store = db.history(testnet)
  const pts = store.get()
  const last = pts[pts.length - 1]
  const now = Date.now()
  if (last && now - last.t < 5 * 60 * 1000) return
  const next = [...pts, { t: now, value }]
  store.set(next.length > 50000 ? next.slice(-50000) : next)
}

export async function buildPortfolio(client: BinanceClient, settings: Settings): Promise<Portfolio> {
  const quote = settings.quoteAsset
  const [account, prices, info, funding] = await Promise.all([client.account(), client.allPrices(), client.exchangeInfo(), client.fundingAssets()])

  const tradesBySymbol = db.trades(settings.testnet).get()
  const trades = Object.values(tradesBySymbol).flat()
  const basis = computeCostBasis(trades, quote, prices)

  const raw = account.balances
    .map((b) => ({ asset: b.asset, free: parseFloat(b.free), locked: parseFloat(b.locked) }))
    .filter((b) => b.free + b.locked > 0)

  const tickerSymbols = raw
    .map((b) => b.asset + quote)
    .filter((s) => info.has(s))
  let change24h = new Map<string, number>()
  try {
    const tickers = await client.ticker24h(tickerSymbols)
    change24h = new Map(tickers.map((t) => [t.symbol, t.priceChangePercent]))
  } catch (e) {
    console.warn('[portfolio] 24h tickers unavailable:', (e as Error).message)
  }

  let totalValue = 0
  const holdings: Holding[] = raw.map((b) => {
    const total = b.free + b.locked
    const price = priceIn(b.asset, quote, prices)
    const value = price === null ? null : price * total
    if (value !== null) totalValue += value

    const cb = basis.get(b.asset)
    let avgCost: number | null = null
    let unrealizedPnl: number | null = null
    let unrealizedPnlPct: number | null = null
    let coverage: Holding['costBasisCoverage'] = 'none'
    if (cb && cb.qty > 0 && price !== null) {
      avgCost = cb.cost / cb.qty
      const covered = Math.min(total, cb.qty)
      unrealizedPnl = (price - avgCost) * covered
      unrealizedPnlPct = avgCost > 0 ? (price / avgCost - 1) * 100 : null
      coverage = cb.qty >= total * 0.98 ? 'full' : 'partial'
    }

    return {
      asset: b.asset,
      free: b.free,
      locked: b.locked,
      total,
      price,
      value,
      allocationPct: 0,
      avgCost,
      tradedQty: cb?.qty ?? 0,
      costBasisCoverage: coverage,
      unrealizedPnl,
      unrealizedPnlPct,
      realizedPnl: cb?.realized ?? 0,
      change24hPct: change24h.get(b.asset + quote) ?? (b.asset === quote ? 0 : null)
    }
  })

  for (const h of holdings) h.allocationPct = totalValue > 0 && h.value !== null ? (h.value / totalValue) * 100 : 0

  const visible = holdings
    .filter((h) => h.value === null || h.value >= settings.hideDustBelow)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))

  let totalRealized = 0
  for (const cb of basis.values()) totalRealized += cb.realized
  const totalUnrealized = holdings.reduce((s, h) => s + (h.unrealizedPnl ?? 0), 0)

  // On spot every non-cash holding is an open position, managed by the app or
  // not, so this covers both without the two lists overlapping. Summed over all
  // holdings rather than the visible ones, to match totalValue.
  let positionsValue = 0
  for (const h of holdings) {
    if (h.value === null || STABLES.has(h.asset) || h.asset === quote) continue
    positionsValue += h.value
  }

  // The funding wallet is money you hold but cannot trade with directly. It is
  // reported separately so the spot total and its history keep their meaning.
  // `withdrawing` is on its way out of the account, so it is left out.
  let fundingValue = 0
  for (const f of funding) {
    const held = parseFloat(f.free) + parseFloat(f.locked) + parseFloat(f.freeze)
    if (!(held > 0)) continue
    const price = priceIn(f.asset, quote, prices)
    if (price !== null) fundingValue += price * held
  }

  recordHistory(settings.testnet, totalValue)

  return {
    quoteAsset: quote,
    totalValue,
    fundingValue,
    positionsValue,
    totalUnrealizedPnl: totalUnrealized,
    totalRealizedPnl: totalRealized,
    holdings: visible,
    updatedAt: Date.now(),
    testnet: settings.testnet
  }
}
