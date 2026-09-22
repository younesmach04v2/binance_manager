import type { Analytics as AnalyticsData } from '@shared/types'
import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useApp } from '../App'
import { useToast } from '../components/Toast'
import { Card, EmptyState, StatCard } from '../components/ui'
import { api } from '../lib/api'
import { ACCENT, chartTheme, compact, GAIN, LOSS } from '../lib/chart'
import { cls, fmtDate, fmtDuration, fmtMoney, fmtNum, fmtPct, fmtShortDate, fmtSigned, pnlClass } from '../lib/format'

export default function Analytics() {
  const { keys, go } = useApp()
  const toast = useToast()
  const [a, setA] = useState<AnalyticsData | null>(null)
  const [loading, setLoading] = useState(false)
  const [limit, setLimit] = useState(50)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setA(await api.analytics.get())
    } catch (e) {
      toast.error('Failed to compute analytics', (e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => void load(), [load])

  const q = a?.quoteAsset ?? 'USDT'
  const tone = (n: number): 'gain' | 'loss' | 'neutral' => (n > 0 ? 'gain' : n < 0 ? 'loss' : 'neutral')

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Analytics</h1>
          <p className="text-sm text-muted">
            Performance of closed round trips: a position opened from zero and sold back down to zero.
          </p>
        </div>
        <button className="btn btn-ghost" onClick={load} disabled={loading}>
          <RefreshCw className={cls('h-4 w-4', loading && 'animate-spin')} /> Recompute
        </button>
      </header>

      {a && a.closedCount === 0 ? (
        <Card>
          <EmptyState
            title="No closed trades yet"
            hint={
              keys.hasKeys
                ? `Sync your trade history in the Journal. Round trips appear once an asset has been fully bought and sold. ${a.openPositions} position${a.openPositions === 1 ? ' is' : 's are'} currently open.`
                : 'Add API keys and sync your trade history in the Journal first.'
            }
            action={
              <button className="btn btn-primary" onClick={() => go(keys.hasKeys ? 'journal' : 'settings')}>
                {keys.hasKeys ? 'Go to Journal' : 'Add API keys'}
              </button>
            }
          />
        </Card>
      ) : a ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <StatCard label="Net P&L" value={fmtSigned(a.totalPnl, q)} sub={`${a.closedCount} closed · ${a.openPositions} open`} tone={tone(a.totalPnl)} />
            <StatCard label="Win rate" value={`${a.winRate.toFixed(1)}%`} sub={`${a.wins} wins · ${a.losses} losses`} />
            <StatCard
              label="Profit factor"
              value={a.profitFactor === null ? '∞' : a.profitFactor.toFixed(2)}
              sub="gross wins ÷ gross losses"
              tone={a.profitFactor === null || a.profitFactor >= 1 ? 'gain' : 'loss'}
            />
            <StatCard label="Expectancy" value={fmtSigned(a.expectancy, q)} sub="average P&L per closed trade" tone={tone(a.expectancy)} />
            <StatCard label="Avg hold" value={fmtDuration(a.avgHoldMs)} sub={`fees paid ${fmtMoney(a.totalFees, q)}`} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Average win" value={fmtSigned(a.avgWin, q)} tone="gain" />
            <StatCard label="Average loss" value={fmtSigned(a.avgLoss, q)} tone="loss" />
            <StatCard label="Largest win" value={fmtSigned(a.largestWin, q)} tone="gain" />
            <StatCard label="Largest loss" value={fmtSigned(a.largestLoss, q)} tone="loss" />
          </div>

          <div className="grid gap-5 xl:grid-cols-2">
            <Card title="Cumulative P&L">
              <div className="h-60">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={a.cumulative} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke={chartTheme.grid} vertical={false} />
                    <XAxis dataKey="t" tickFormatter={(t) => fmtShortDate(Number(t))} tick={chartTheme.tick} tickLine={false} axisLine={false} minTickGap={48} />
                    <YAxis tickFormatter={(v) => compact(Number(v))} tick={chartTheme.tick} tickLine={false} axisLine={false} width={56} />
                    <ReferenceLine y={0} stroke={chartTheme.axis} strokeDasharray="3 3" />
                    <Tooltip
                      contentStyle={chartTheme.tooltip}
                      labelStyle={chartTheme.tooltipLabel}
                      cursor={chartTheme.cursor}
                      labelFormatter={(t) => fmtDate(Number(t))}
                      formatter={(v) => [fmtSigned(Number(v), q), 'Cumulative P&L']}
                    />
                    <Line type="monotone" dataKey="pnl" stroke={ACCENT} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: '#111827' }} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <Card title="P&L by symbol">
              <div className="h-60">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={[...a.bySymbol].sort((x, y) => Math.abs(y.pnl) - Math.abs(x.pnl)).slice(0, 15)} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="30%">
                    <CartesianGrid stroke={chartTheme.grid} vertical={false} />
                    <XAxis dataKey="symbol" tick={chartTheme.tick} tickLine={false} axisLine={false} interval={0} angle={-30} textAnchor="end" height={48} />
                    <YAxis tickFormatter={(v) => compact(Number(v))} tick={chartTheme.tick} tickLine={false} axisLine={false} width={56} />
                    <ReferenceLine y={0} stroke={chartTheme.axis} />
                    <Tooltip contentStyle={chartTheme.tooltip} labelStyle={chartTheme.tooltipLabel} cursor={{ fill: '#1f2a3d', opacity: 0.4 }} formatter={(v) => [fmtSigned(Number(v), q), 'P&L']} />
                    <Bar dataKey="pnl" isAnimationActive={false} maxBarSize={28}>
                      {[...a.bySymbol].sort((x, y) => Math.abs(y.pnl) - Math.abs(x.pnl)).slice(0, 15).map((s) => (
                        <Cell key={s.symbol} fill={s.pnl >= 0 ? GAIN : LOSS} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </div>

          <div className="grid gap-5 xl:grid-cols-2">
            <Card title="By symbol" className="p-0">
              <div className="max-h-72 overflow-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Symbol</th>
                      <th className="text-right">Trades</th>
                      <th className="text-right">Win rate</th>
                      <th className="text-right">P&L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.bySymbol.map((s) => (
                      <tr key={s.symbol}>
                        <td className="num">{s.symbol}</td>
                        <td className="num text-right">{s.trades}</td>
                        <td className="num text-right">{s.winRate.toFixed(0)}%</td>
                        <td className={cls('num text-right', pnlClass(s.pnl))}>{fmtSigned(s.pnl)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card title="By tag" className="p-0">
              {a.byTag.length === 0 ? (
                <div className="px-4 py-8 text-center text-xs text-muted">
                  Tag trades in the Journal (for example "breakout", "dca", "fomo") to compare how each approach performs.
                </div>
              ) : (
                <div className="max-h-72 overflow-auto">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Tag</th>
                        <th className="text-right">Trades</th>
                        <th className="text-right">Win rate</th>
                        <th className="text-right">P&L</th>
                      </tr>
                    </thead>
                    <tbody>
                      {a.byTag.map((t) => (
                        <tr key={t.tag}>
                          <td>
                            <span className="tag">{t.tag}</span>
                          </td>
                          <td className="num text-right">{t.trades}</td>
                          <td className="num text-right">{t.winRate.toFixed(0)}%</td>
                          <td className={cls('num text-right', pnlClass(t.pnl))}>{fmtSigned(t.pnl)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>

          <Card title={`Closed round trips (${a.closedCount})`} className="p-0">
            <div className="max-h-[60vh] overflow-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Opened</th>
                    <th>Closed</th>
                    <th className="text-right">Held</th>
                    <th className="text-right">Qty</th>
                    <th className="text-right">Entry</th>
                    <th className="text-right">Exit</th>
                    <th className="text-right">Fees</th>
                    <th className="text-right">P&L</th>
                    <th>Tags</th>
                  </tr>
                </thead>
                <tbody>
                  {a.roundTrips.slice(0, limit).map((r) => (
                    <tr key={r.id}>
                      <td className="num">{r.symbol}</td>
                      <td className="text-xs whitespace-nowrap text-muted">{fmtDate(r.openTime)}</td>
                      <td className="text-xs whitespace-nowrap text-muted">{fmtDate(r.closeTime)}</td>
                      <td className="num text-right text-xs">{fmtDuration(r.durationMs)}</td>
                      <td className="num text-right">{fmtNum(r.qty)}</td>
                      <td className="num text-right">{fmtNum(r.entryAvg)}</td>
                      <td className="num text-right">{fmtNum(r.exitAvg)}</td>
                      <td className="num text-right text-xs text-muted">{fmtNum(r.fees, 2)}</td>
                      <td className={cls('num text-right', pnlClass(r.pnl))}>
                        {fmtSigned(r.pnl)}
                        <div className="text-[10px]">{fmtPct(r.pnlPct)}</div>
                      </td>
                      <td>
                        <div className="flex flex-wrap gap-1">
                          {r.tags.map((t) => (
                            <span key={t} className="tag">
                              {t}
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {a.roundTrips.length > limit && (
                <div className="flex justify-center border-t border-border p-3">
                  <button className="btn btn-ghost btn-sm" onClick={() => setLimit((l) => l + 50)}>
                    Show more
                  </button>
                </div>
              )}
            </div>
          </Card>

          <p className="text-[11px] text-muted">
            P&L is proceeds minus cost minus fees paid in {q} or BNB (BNB fees are converted at today's price, so
            they are approximate). Fees taken in the traded asset reduce the quantity instead. Trades in other quote
            currencies are converted at current rates.
          </p>
        </>
      ) : (
        <Card>
          <div className="py-12 text-center text-xs text-muted">Computing…</div>
        </Card>
      )}
    </div>
  )
}
