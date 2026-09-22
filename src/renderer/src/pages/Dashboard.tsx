import type { Holding, Portfolio, ValuePoint } from '@shared/types'
import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Area, AreaChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useApp } from '../App'
import { useMetered, useRefreshSeconds } from '../lib/useMetered'
import { useToast } from '../components/Toast'
import { Badge, Card, EmptyState, StatCard } from '../components/ui'
import { api } from '../lib/api'
import { ACCENT, chartTheme, colorFor, compact, OTHER_COLOR } from '../lib/chart'
import { cls, fmtDate, fmtMoney, fmtNum, fmtPct, fmtShortDate, fmtSigned, pnlClass } from '../lib/format'
import { useLivePrices } from '../lib/usePrices'

export default function Dashboard() {
  const { settings, keys, go } = useApp()
  const toast = useToast()
  const [pf, setPf] = useState<Portfolio | null>(null)
  const [history, setHistory] = useState<ValuePoint[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const quote = settings.quoteAsset
  const refreshSec = useRefreshSeconds(settings.refreshIntervalSec)
  const { metered, reason } = useMetered()

  // The value curve only ever grows, so ask for the whole thing once and for
  // new points after that. Over a metered link (a phone server reached from
  // another network) re-sending the curve every refresh is the dominant cost.
  const lastPointAt = useRef(0)

  const load = useCallback(async () => {
    if (!keys.hasKeys) return
    setLoading(true)
    try {
      const since = lastPointAt.current
      const [p, h] = await Promise.all([api.portfolio.get(), api.portfolio.history(since || undefined)])
      setPf(p)
      // A server older than this change ignores `since` and sends the whole
      // curve, so drop anything already held rather than duplicating it.
      const fresh = since ? h.filter((pt) => pt.t > since) : h
      if (fresh.length > 0) lastPointAt.current = fresh[fresh.length - 1].t
      setHistory((prev) => (since ? [...prev, ...fresh] : fresh))
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [keys.hasKeys])

  // Live and testnet keep separate curves, so start the accumulation over.
  useEffect(() => {
    lastPointAt.current = 0
    setHistory([])
  }, [settings.testnet])

  useEffect(() => {
    void load()
    const id = setInterval(() => void load(), refreshSec * 1000)
    return () => clearInterval(id)
  }, [load, refreshSec, settings.testnet])

  const holdingSymbols = useMemo(
    () => (pf?.holdings ?? []).filter((h) => h.asset !== quote).map((h) => h.asset + quote),
    [pf, quote]
  )
  const { prices: live, changes: liveChg } = useLivePrices([...holdingSymbols, ...settings.watchlist])

  // Re-price the snapshot with live ticks so values move between refreshes.
  const rows: Holding[] = useMemo(() => {
    if (!pf) return []
    return pf.holdings.map((h) => {
      const lp = h.asset === quote ? 1 : live[h.asset + quote]
      if (lp === undefined) return h
      const covered = Math.min(h.total, h.tradedQty)
      return {
        ...h,
        price: lp,
        value: lp * h.total,
        unrealizedPnl: h.avgCost !== null ? (lp - h.avgCost) * covered : null,
        unrealizedPnlPct: h.avgCost ? (lp / h.avgCost - 1) * 100 : null,
        change24hPct: liveChg[h.asset + quote] ?? h.change24hPct
      }
    })
  }, [pf, live, liveChg, quote])

  const snapshotVisible = (pf?.holdings ?? []).reduce((s, h) => s + (h.value ?? 0), 0)
  const liveVisible = rows.reduce((s, h) => s + (h.value ?? 0), 0)
  const totalValue = (pf?.totalValue ?? 0) + (liveVisible - snapshotVisible)
  const totalUnrealized = rows.reduce((s, h) => s + (h.unrealizedPnl ?? 0), 0)
  const change24h = rows.reduce(
    (s, h) => (h.value && h.change24hPct !== null ? s + (h.value - h.value / (1 + h.change24hPct / 100)) : s),
    0
  )
  const change24hPct = totalValue - change24h > 0 ? (change24h / (totalValue - change24h)) * 100 : 0

  const allocation = useMemo(() => {
    const sorted = [...rows].filter((h) => (h.value ?? 0) > 0).sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
    const top = sorted.slice(0, 8)
    const rest = sorted.slice(8)
    const names = top.map((h) => h.asset)
    const items = top.map((h) => ({ name: h.asset, value: h.value ?? 0, color: colorFor(h.asset, names) }))
    if (rest.length) items.push({ name: 'Other', value: rest.reduce((s, h) => s + (h.value ?? 0), 0), color: OTHER_COLOR })
    const sum = items.reduce((s, i) => s + i.value, 0)
    return items.map((i) => ({ ...i, pct: sum > 0 ? (i.value / sum) * 100 : 0 }))
  }, [rows])

  const chartData = useMemo(() => {
    const pts = history.length > 600 ? history.filter((_, i) => i % Math.ceil(history.length / 600) === 0) : history
    return pts.map((p) => ({ t: p.t, value: p.value }))
  }, [history])

  if (!keys.hasKeys) {
    return (
      <Card>
        <EmptyState
          title="Connect your Binance account"
          hint="Add an API key with read permission to see balances, live valuation, cost basis and P&L. Trading permission is only needed for the Trade and Automation pages."
          action={
            <button className="btn btn-primary" onClick={() => go('settings')}>
              Add API keys
            </button>
          }
        />
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            Portfolio {pf?.testnet && <Badge tone="accent">TESTNET</Badge>}
          </h1>
          <p className="text-sm text-muted">
            {pf ? `Snapshot ${fmtDate(pf.updatedAt)} · live prices via WebSocket` : 'Loading balances…'}
            {metered && ` · refreshing every ${refreshSec}s to save data (${reason} is on cellular)`}
          </p>
        </div>
        <button className="btn btn-ghost" onClick={load} disabled={loading}>
          <RefreshCw className={cls('h-4 w-4', loading && 'animate-spin')} /> Refresh
        </button>
      </header>

      {error && <div className="rounded-md border border-loss/40 bg-loss/10 px-4 py-2 text-sm text-loss">{error}</div>}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total value" value={fmtMoney(totalValue, quote)} sub={`${rows.length} assets shown`} />
        <StatCard
          label="24h change"
          value={fmtSigned(change24h, quote)}
          sub={fmtPct(change24hPct)}
          tone={change24h > 0 ? 'gain' : change24h < 0 ? 'loss' : 'neutral'}
        />
        <StatCard
          label="Unrealized P&L"
          value={fmtSigned(totalUnrealized, quote)}
          sub="on holdings with a known cost basis"
          tone={totalUnrealized > 0 ? 'gain' : totalUnrealized < 0 ? 'loss' : 'neutral'}
        />
        <StatCard
          label="Realized P&L"
          value={fmtSigned(pf?.totalRealizedPnl ?? 0, quote)}
          sub="from synced trade history"
          tone={(pf?.totalRealizedPnl ?? 0) > 0 ? 'gain' : (pf?.totalRealizedPnl ?? 0) < 0 ? 'loss' : 'neutral'}
        />
      </div>

      <div className="grid gap-5 xl:grid-cols-3">
        <Card title="Portfolio value" className="xl:col-span-2">
          {chartData.length < 2 ? (
            <div className="flex h-56 items-center justify-center text-xs text-muted">
              A value point is recorded every 5 minutes while the app is open. Check back soon.
            </div>
          ) : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="pv" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={ACCENT} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={ACCENT} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={chartTheme.grid} vertical={false} />
                  <XAxis dataKey="t" tickFormatter={(t) => fmtShortDate(Number(t))} tick={chartTheme.tick} tickLine={false} axisLine={false} minTickGap={48} />
                  <YAxis domain={['auto', 'auto']} tickFormatter={(v) => compact(Number(v))} tick={chartTheme.tick} tickLine={false} axisLine={false} width={56} />
                  <Tooltip
                    contentStyle={chartTheme.tooltip}
                    labelStyle={chartTheme.tooltipLabel}
                    cursor={chartTheme.cursor}
                    labelFormatter={(t) => fmtDate(Number(t))}
                    formatter={(v) => [fmtMoney(Number(v), quote), 'Value']}
                  />
                  <Area type="monotone" dataKey="value" stroke={ACCENT} strokeWidth={2} fill="url(#pv)" dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: '#111827' }} isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card title="Allocation">
          {allocation.length === 0 ? (
            <div className="flex h-56 items-center justify-center text-xs text-muted">No priced holdings.</div>
          ) : (
            <div className="flex h-56 items-center gap-3">
              <div className="h-full w-1/2">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={allocation} dataKey="value" nameKey="name" innerRadius="60%" outerRadius="90%" paddingAngle={2} stroke="#111827" strokeWidth={2} isAnimationActive={false}>
                      {allocation.map((a) => (
                        <Cell key={a.name} fill={a.color} />
                      ))}
                    </Pie>
                    <Tooltip contentStyle={chartTheme.tooltip} formatter={(v, name) => [fmtMoney(Number(v), quote), String(name)]} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <ul className="flex-1 space-y-1 overflow-y-auto text-xs">
                {allocation.map((a) => (
                  <li key={a.name} className="flex items-center gap-2">
                    <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: a.color }} />
                    <span className="flex-1">{a.name}</span>
                    <span className="num text-muted">{a.pct.toFixed(1)}%</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      </div>

      <Card title="Holdings" className="p-0">
        <div className="max-h-[60vh] overflow-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Asset</th>
                <th className="text-right">Amount</th>
                <th className="text-right">Price</th>
                <th className="text-right">Value</th>
                <th className="text-right">Alloc</th>
                <th className="text-right">Avg cost</th>
                <th className="text-right">Unrealized P&L</th>
                <th className="text-right">Realized</th>
                <th className="text-right">24h</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((h) => (
                <tr key={h.asset}>
                  <td>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{h.asset}</span>
                      {h.costBasisCoverage === 'partial' && (
                        <Badge tone="accent" className="!text-[10px]" >partial basis</Badge>
                      )}
                    </div>
                  </td>
                  <td className="num text-right">
                    {fmtNum(h.total)}
                    {h.locked > 0 && <div className="text-[10px] text-muted">{fmtNum(h.locked)} in orders</div>}
                  </td>
                  <td className="num text-right">{h.price !== null ? fmtNum(h.price) : '—'}</td>
                  <td className="num text-right">{h.value !== null ? fmtNum(h.value, 2) : '—'}</td>
                  <td className="num text-right text-muted">{h.allocationPct.toFixed(1)}%</td>
                  <td className="num text-right">{h.avgCost !== null ? fmtNum(h.avgCost) : <span className="text-muted">—</span>}</td>
                  <td className={cls('num text-right', pnlClass(h.unrealizedPnl))}>
                    {h.unrealizedPnl !== null ? (
                      <>
                        {fmtSigned(h.unrealizedPnl)}
                        <div className="text-[10px]">{fmtPct(h.unrealizedPnlPct)}</div>
                      </>
                    ) : (
                      <span className="text-muted" title="No buy trades synced for this asset">—</span>
                    )}
                  </td>
                  <td className={cls('num text-right', pnlClass(h.realizedPnl))}>{h.realizedPnl ? fmtSigned(h.realizedPnl) : '—'}</td>
                  <td className={cls('num text-right', pnlClass(h.change24hPct))}>{fmtPct(h.change24hPct)}</td>
                </tr>
              ))}
              {rows.length === 0 && pf && (
                <tr>
                  <td colSpan={9} className="py-8 text-center text-xs text-muted">
                    No holdings above {settings.hideDustBelow} {quote}.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {pf && pf.holdings.some((h) => h.costBasisCoverage !== 'full') && (
          <div className="border-t border-border px-4 py-2 text-[11px] text-muted">
            Cost basis comes from synced trades (Journal → Sync). Assets that were deposited rather than bought show no
            average cost, and "partial basis" means only part of the position has a known entry price.
          </div>
        )}
      </Card>

      {settings.watchlist.length > 0 && (
        <Card title="Watchlist">
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {settings.watchlist.map((s) => (
              <button key={s} className="rounded-lg border border-border bg-bg p-3 text-left hover:border-accent/50" onClick={() => go('trade')}>
                <div className="num text-xs text-muted">{s}</div>
                <div className="num mt-1 text-base font-semibold">{live[s] !== undefined ? fmtNum(live[s]) : '…'}</div>
                <div className={cls('num text-xs', pnlClass(liveChg[s]))}>{fmtPct(liveChg[s])}</div>
              </button>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}
