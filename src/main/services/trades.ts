import type {
  Analytics,
  JournalEntry,
  RoundTrip,
  Settings,
  SyncResult,
  Trade,
  TradeWithJournal
} from '../../shared/types'
import { normaliseTrade, type BinanceClient } from '../binance/client'
import { db } from '../store/db'
import { feeInQuote, quoteFactor } from './portfolio'

const DISCOVERY_QUOTES = ['USDT', 'USDC', 'FDUSD', 'BTC', 'ETH', 'BNB']

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Symbols worth syncing: every held asset against common quotes, plus anything already tracked. */
export async function discoverSymbols(client: BinanceClient, settings: Settings): Promise<string[]> {
  const [account, info] = await Promise.all([client.account(), client.exchangeInfo()])
  const existing = db.trades(settings.testnet).get()

  const assets = new Set<string>(account.balances.map((b) => b.asset))
  for (const list of Object.values(existing)) for (const t of list) assets.add(t.baseAsset)

  const quotes = Array.from(new Set([settings.quoteAsset, ...DISCOVERY_QUOTES]))
  const symbols = new Set<string>([...settings.trackedSymbols, ...Object.keys(existing)])
  for (const asset of assets) {
    for (const q of quotes) {
      if (asset === q) continue
      const sym = asset + q
      if (info.has(sym)) symbols.add(sym)
    }
  }
  return Array.from(symbols)
    .filter((s) => info.has(s))
    .sort()
}

/** Incrementally pull trade history for each symbol and merge into the local store. */
export async function syncTrades(client: BinanceClient, testnet: boolean, symbols: string[]): Promise<SyncResult> {
  const info = await client.exchangeInfo()
  const store = db.trades(testnet)
  const data: Record<string, Trade[]> = { ...store.get() }
  const errors: SyncResult['errors'] = []
  let newTrades = 0

  for (const symbol of symbols) {
    const si = info.get(symbol)
    if (!si) {
      errors.push({ symbol, message: 'Unknown symbol' })
      continue
    }
    const existing = data[symbol] ?? []
    const lastId = existing.length ? Math.max(...existing.map((t) => t.id)) : undefined
    try {
      const raw = await client.myTrades(symbol, lastId)
      if (raw.length) {
        const seen = new Set(existing.map((t) => t.id))
        const fresh = raw.filter((t) => !seen.has(t.id)).map((t) => normaliseTrade(t, si.baseAsset, si.quoteAsset))
        newTrades += fresh.length
        data[symbol] = [...existing, ...fresh].sort((a, b) => a.time - b.time || a.id - b.id)
      } else if (!data[symbol]) {
        data[symbol] = []
      }
    } catch (e) {
      errors.push({ symbol, message: (e as Error).message })
    }
    await sleep(80) // stay well under the request-weight limit
  }

  // Drop symbols that never had a trade so the store stays small.
  for (const [sym, list] of Object.entries(data)) if (list.length === 0) delete data[sym]
  store.set(data)

  const totalTrades = Object.values(data).reduce((n, l) => n + l.length, 0)
  return { symbols, newTrades, totalTrades, errors }
}

export function allTrades(testnet: boolean): Trade[] {
  return Object.values(db.trades(testnet).get()).flat()
}

export function listTrades(testnet: boolean): TradeWithJournal[] {
  const journal = db.journal(testnet).get()
  return allTrades(testnet)
    .map((t) => ({ ...t, journal: journal[String(t.id)] }))
    .sort((a, b) => b.time - a.time || b.id - a.id)
}

export function updateJournal(
  testnet: boolean,
  tradeId: number,
  patch: { tags?: string[]; note?: string }
): JournalEntry {
  const store = db.journal(testnet)
  const key = String(tradeId)
  const current = store.get()[key] ?? { tradeId, tags: [], note: '', updatedAt: 0 }
  const next: JournalEntry = {
    tradeId,
    tags: (patch.tags ?? current.tags).map((t) => t.trim().toLowerCase()).filter(Boolean),
    note: patch.note ?? current.note,
    updatedAt: Date.now()
  }
  store.update((j) => ({ ...j, [key]: next }))
  return next
}

export function allTags(testnet: boolean): string[] {
  const tags = new Set<string>()
  for (const e of Object.values(db.journal(testnet).get())) for (const t of e.tags) tags.add(t)
  return Array.from(tags).sort()
}

interface OpenPosition {
  symbol: string
  qty: number
  maxQty: number
  cost: number
  proceeds: number
  fees: number
  tradeIds: number[]
  openTime: number
}

/**
 * Build closed round trips (position opened from zero and closed back to ~zero)
 * per symbol and derive performance statistics from them.
 */
export function computeAnalytics(
  trades: Trade[],
  journal: Record<string, JournalEntry>,
  quoteAsset: string,
  prices: Map<string, number>
): Analytics {
  const bySymbol = new Map<string, Trade[]>()
  for (const t of trades) {
    const list = bySymbol.get(t.symbol) ?? []
    list.push(t)
    bySymbol.set(t.symbol, list)
  }

  const roundTrips: RoundTrip[] = []
  let openPositions = 0

  for (const [symbol, list] of bySymbol) {
    list.sort((a, b) => a.time - b.time || a.id - b.id)
    const factor = quoteFactor(list[0].quoteAsset, quoteAsset, prices)
    let pos: OpenPosition | null = null

    for (const t of list) {
      const fee = feeInQuote(t, quoteAsset, prices, factor)
      const baseFee = t.commissionAsset === t.baseAsset ? t.commission : 0
      if (t.isBuyer) {
        if (!pos) pos = { symbol, qty: 0, maxQty: 0, cost: 0, proceeds: 0, fees: 0, tradeIds: [], openTime: t.time }
        pos.qty += t.qty - baseFee
        pos.maxQty = Math.max(pos.maxQty, pos.qty)
        pos.cost += t.quoteQty * factor
        pos.fees += fee
        pos.tradeIds.push(t.id)
      } else {
        if (!pos) continue // selling assets that were deposited, not bought: no round trip
        pos.qty -= t.qty
        pos.proceeds += t.quoteQty * factor
        pos.fees += fee
        pos.tradeIds.push(t.id)
        const dust = Math.max(1e-9, pos.maxQty * 0.001)
        if (pos.qty <= dust) {
          const pnl = pos.proceeds - pos.cost - pos.fees
          const tags = new Set<string>()
          for (const id of pos.tradeIds) for (const tag of journal[String(id)]?.tags ?? []) tags.add(tag)
          roundTrips.push({
            id: `${symbol}-${pos.tradeIds[0]}-${t.id}`,
            symbol,
            openTime: pos.openTime,
            closeTime: t.time,
            durationMs: t.time - pos.openTime,
            qty: pos.maxQty,
            entryAvg: pos.maxQty > 0 ? pos.cost / pos.maxQty : 0,
            exitAvg: pos.maxQty > 0 ? pos.proceeds / pos.maxQty : 0,
            cost: pos.cost,
            proceeds: pos.proceeds,
            fees: pos.fees,
            pnl,
            pnlPct: pos.cost > 0 ? (pnl / pos.cost) * 100 : 0,
            tradeIds: pos.tradeIds,
            tags: Array.from(tags)
          })
          pos = null
        }
      }
    }
    if (pos) openPositions++
  }

  roundTrips.sort((a, b) => a.closeTime - b.closeTime)

  const wins = roundTrips.filter((r) => r.pnl > 0)
  const losses = roundTrips.filter((r) => r.pnl < 0)
  const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)
  const grossWin = sum(wins.map((r) => r.pnl))
  const grossLoss = -sum(losses.map((r) => r.pnl))
  const totalPnl = sum(roundTrips.map((r) => r.pnl))

  const group = (key: (r: RoundTrip) => string[]): { key: string; trades: number; pnl: number; winRate: number }[] => {
    const m = new Map<string, RoundTrip[]>()
    for (const r of roundTrips) for (const k of key(r)) m.set(k, [...(m.get(k) ?? []), r])
    return Array.from(m.entries())
      .map(([k, rs]) => ({
        key: k,
        trades: rs.length,
        pnl: sum(rs.map((r) => r.pnl)),
        winRate: (rs.filter((r) => r.pnl > 0).length / rs.length) * 100
      }))
      .sort((a, b) => b.pnl - a.pnl)
  }

  let running = 0
  const cumulative = roundTrips.map((r) => {
    running += r.pnl
    return { t: r.closeTime, pnl: running }
  })

  return {
    quoteAsset,
    roundTrips: [...roundTrips].reverse(),
    closedCount: roundTrips.length,
    wins: wins.length,
    losses: losses.length,
    winRate: roundTrips.length ? (wins.length / roundTrips.length) * 100 : 0,
    totalPnl,
    totalFees: sum(roundTrips.map((r) => r.fees)),
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? -grossLoss / losses.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    expectancy: roundTrips.length ? totalPnl / roundTrips.length : 0,
    largestWin: wins.length ? Math.max(...wins.map((r) => r.pnl)) : 0,
    largestLoss: losses.length ? Math.min(...losses.map((r) => r.pnl)) : 0,
    avgHoldMs: roundTrips.length ? sum(roundTrips.map((r) => r.durationMs)) / roundTrips.length : 0,
    bySymbol: group((r) => [r.symbol]).map(({ key, ...rest }) => ({ symbol: key, ...rest })),
    byTag: group((r) => r.tags).map(({ key, ...rest }) => ({ tag: key, ...rest })),
    cumulative,
    openPositions
  }
}
