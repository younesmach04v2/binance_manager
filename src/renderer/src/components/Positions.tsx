import type { AdoptRequest, ExchangePosition, LimitEntry, ManagedPhase, ManagedTrade, ReduceBy } from '@shared/types'
import { ChevronDown, ChevronUp, Clock, RefreshCw, Shield, ShieldAlert, ShieldCheck, ShieldOff, Trash2, TrendingUp } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useApp } from '../App'
import { describeReduce, quantityFor } from '@shared/reduce'
import { api } from '../lib/api'
import { useRefreshSeconds } from '../lib/useMetered'
import { cls, fmtDate, fmtNum, fmtPct, fmtSigned, pnlClass } from '../lib/format'
import { useLivePrices } from '../lib/usePrices'
import { useToast } from './Toast'
import { Badge, Card, EmptyState, Field, Modal, Spinner, Toggle } from './ui'

export const OPEN_PHASES = new Set<ManagedPhase>(['PENDING', 'PROTECTED', 'BE', 'TRAILING', 'UNPROTECTED'])

export const PHASE: Record<ManagedPhase, { label: string; tone: 'gain' | 'loss' | 'neutral' | 'accent' | 'info' }> = {
  PENDING: { label: 'waiting to fill', tone: 'accent' },
  PROTECTED: { label: 'protected', tone: 'gain' },
  BE: { label: 'break-even', tone: 'info' },
  TRAILING: { label: 'trailing', tone: 'info' },
  UNPROTECTED: { label: 'NOT PROTECTED', tone: 'loss' },
  CLOSED_TP: { label: 'target hit', tone: 'gain' },
  CLOSED_SL: { label: 'stopped out', tone: 'loss' },
  CLOSED_MANUAL: { label: 'closed manually', tone: 'neutral' },
  CANCELLED_ENTRY: { label: 'entry cancelled', tone: 'neutral' },
  RELEASED: { label: 'released', tone: 'neutral' }
}

export type PositionAction = 'up' | 'close' | 'cancel' | 'release'

const rLabel = (r: number): string => (r === 0 ? 'entry' : `${r > 0 ? '+' : ''}${r}R`)
const num = (s: string): number | undefined => {
  const n = parseFloat(s)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

// ---------------------------------------------------------------- data

export function usePositions(pollMs = 20_000) {
  // Stretched when this device or the server is on a mobile connection.
  const everyMs = useRefreshSeconds(Math.round(pollMs / 1000)) * 1000
  const [managed, setManaged] = useState<ManagedTrade[]>([])
  const [exchange, setExchange] = useState<ExchangePosition[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    const [m, x] = await Promise.allSettled([api.rtrade.list(), api.positions.list()])
    if (m.status === 'fulfilled') setManaged(m.value)
    if (x.status === 'fulfilled') {
      setExchange(x.value)
      setError(null)
    } else {
      setError((x.reason as Error).message)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void reload()
    const t = setInterval(() => void reload(), everyMs)
    const off = api.on('rtrade:changed', () => void reload())
    return () => {
      clearInterval(t)
      off()
    }
  }, [reload, everyMs])

  return { managed, exchange, loading, error, reload }
}

// ---------------------------------------------------------------- open positions (managed + exchange)

export function OpenPositions({ title = 'Open positions' }: { title?: string }) {
  const { keys } = useApp()
  const toast = useToast()
  const { managed, exchange, loading, error, reload } = usePositions()
  const open = useMemo(() => managed.filter((t) => OPEN_PHASES.has(t.phase)), [managed])
  const { prices } = useLivePrices([...open.map((t) => t.symbol), ...exchange.map((p) => p.symbol)])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [acting, setActing] = useState<string | null>(null)
  const [adopting, setAdopting] = useState<ExchangePosition | null>(null)

  const actManaged = async (t: ManagedTrade, kind: PositionAction): Promise<void> => {
    const next = t.ladder.find((s) => !s.done)
    const question = {
      up: `Move the stop of ${t.symbol} to ${next ? rLabel(next.stopR) : 'break-even'} now?${next && next.closePct > 0 && t.partial?.status === 'OPEN' ? ` This also sells the ${next.closePct}% partial at market.` : ''}`,
      close: `Sell everything left of ${t.symbol} at market and close this position?`,
      cancel: `Take the ${t.symbol} entry off the book? Nothing has been bought, so this simply cancels the order and its attached stop and target.`,
      release: `Stop managing ${t.symbol}? Its orders stay on Binance, but the app will no longer move the stop or track the outcome.`
    }[kind]
    if (!window.confirm(question)) return
    setActing(t.id)
    try {
      if (kind === 'up') await api.rtrade.moveBE(t.id)
      else if (kind === 'close') await api.rtrade.close(t.id)
      else if (kind === 'cancel') await api.rtrade.cancelEntry(t.id)
      else await api.rtrade.release(t.id)
      await reload()
      toast.success('Done', 'See the position log for details.')
    } catch (e) {
      toast.error('Action failed', (e as Error).message)
    } finally {
      setActing(null)
    }
  }

  /** Sell part of a managed position and keep the rest under the ladder. */
  const reduceManaged = async (t: ManagedTrade, by: ReduceBy): Promise<void> => {
    const part = quantityFor(by, { qty: t.qty, price: t.entryPrice, entry: t.entryPrice, stop: t.currentStop })
    const resting = t.partial && t.partial.status === 'OPEN' ? ` The ${t.partial.pct}% resting at its rung is left alone.` : ''
    if (
      !window.confirm(
        `Sell ${describeReduce(by)} of ${t.symbol} at market - about ${fmtNum(part)} ${t.baseAsset}, leaving ${fmtNum(t.qty - part)}?` +
          ` The stop and target are replaced for what is left, at the same prices.${resting}`
      )
    ) {
      return
    }
    setActing(t.id)
    try {
      await api.rtrade.reduce(t.id, by)
      await reload()
      toast.success(`${t.symbol} reduced by ${describeReduce(by)}`, 'See the position log for the fill.')
    } catch (e) {
      toast.error('Could not reduce', (e as Error).message)
    } finally {
      setActing(null)
    }
  }

  const closeExchange = async (p: ExchangePosition): Promise<void> => {
    if (!window.confirm(`Cancel the ${p.orders.length} open order${p.orders.length === 1 ? '' : 's'} on ${p.symbol} and sell ${fmtNum(p.qty)} ${p.baseAsset} at market?`)) return
    setActing(p.symbol)
    try {
      const r = await api.positions.close({
        symbol: p.symbol,
        cancelOrderIds: p.orders.filter((o) => o.orderListId < 0).map((o) => o.orderId),
        cancelOrderListIds: p.orderListIds
      })
      toast.success(`${p.symbol} closed`, r.sold > 0 ? `Sold ${fmtNum(r.sold)} at ${fmtNum(r.price)}` : 'Nothing was free to sell')
      await reload()
    } catch (e) {
      toast.error('Close failed', (e as Error).message)
    } finally {
      setActing(null)
    }
  }

  /** Sell part of a plain holding; its stop and target are re-placed for the rest. */
  const reduceExchange = async (p: ExchangePosition, by: ReduceBy): Promise<void> => {
    const part = quantityFor(by, { qty: p.qty, price: p.price ?? 0, entry: p.entryPrice, stop: p.stopPrice })
    const guarded = p.stopPrice !== null && p.targetPrice !== null
    if (
      !window.confirm(
        `Sell ${describeReduce(by)} of ${p.symbol} at market - about ${fmtNum(part)} ${p.baseAsset}, leaving ${fmtNum(p.qty - part)}?` +
          (guarded
            ? ` Its open orders are cancelled first, then the same stop and target go back on what is left.`
            : ` It has no stop and target to put back, so the remainder is left unprotected.`)
      )
    ) {
      return
    }
    setActing(p.symbol)
    try {
      const r = await api.positions.reduce({
        symbol: p.symbol,
        by,
        cancelOrderIds: p.orders.filter((o) => o.orderListId < 0).map((o) => o.orderId),
        cancelOrderListIds: p.orderListIds,
        stopPrice: p.stopPrice,
        targetPrice: p.targetPrice,
        entryPrice: p.entryPrice
      })
      await reload()
      if (r.note) toast.warn(`${p.symbol} reduced`, r.note)
      else {
        toast.success(
          `${p.symbol} reduced by ${describeReduce(by)}`,
          `Sold ${fmtNum(r.sold)} at ${fmtNum(r.price)} · ${fmtNum(r.remaining)} left${r.reprotected === 'oco' ? ', stop and target back on' : ''}`
        )
      }
    } catch (e) {
      toast.error('Could not reduce', (e as Error).message)
    } finally {
      setActing(null)
    }
  }

  const total = open.length + exchange.length

  return (
    <>
      <Card
        title={`${title} (${total})`}
        action={
          <button className="btn btn-ghost btn-sm" onClick={() => void reload()} disabled={loading}>
            <RefreshCw className={cls('h-3.5 w-3.5', loading && 'animate-spin')} />
          </button>
        }
      >
        {!keys.hasKeys ? (
          <EmptyState title="Connect your Binance account" hint="Positions come from your balances and open orders; add API keys in Settings." />
        ) : total === 0 ? (
          <EmptyState
            title={loading ? 'Loading positions…' : 'No open positions'}
            hint="Every coin you hold (other than stablecoins) shows up here with the stop and target protecting it, whether you bought it with an R command or not."
          />
        ) : (
          <div className="flex flex-col gap-3">
            {open.map((t) => (
              <PositionCard
                key={t.id}
                t={t}
                price={prices[t.symbol]}
                acting={acting === t.id}
                expanded={expanded === t.id}
                onToggle={() => setExpanded((e) => (e === t.id ? null : t.id))}
                onAct={(k) => void actManaged(t, k)}
                onReduce={(by) => void reduceManaged(t, by)}
              />
            ))}
            {exchange.map((p) => (
              <ExchangePositionCard
                key={p.symbol}
                p={p}
                price={prices[p.symbol]}
                acting={acting === p.symbol}
                expanded={expanded === p.symbol}
                onToggle={() => setExpanded((e) => (e === p.symbol ? null : p.symbol))}
                onAdopt={() => setAdopting(p)}
                onClose={() => void closeExchange(p)}
                onReduce={(by) => void reduceExchange(p, by)}
              />
            ))}
          </div>
        )}
        {error && keys.hasKeys && <div className="selectable mt-3 text-xs text-loss">Exchange positions unavailable: {error}</div>}
      </Card>
      {adopting && (
        <AdoptModal
          p={adopting}
          price={prices[adopting.symbol] ?? adopting.price ?? undefined}
          onClose={() => setAdopting(null)}
          onDone={() => {
            setAdopting(null)
            void reload()
          }}
        />
      )}
    </>
  )
}

// ---------------------------------------------------------------- managed position card

/**
 * Quick percentages plus a typed amount in percent, units, value or risk.
 *
 * On a phone the two halves wrap onto separate lines rather than being
 * squeezed: a seamless desktop toolbar leaves the field and its button too
 * narrow to use at 400px.
 */
function ReduceControl({ quote, base, disabled, canRisk, onReduce }: {
  quote: string
  base: string
  disabled: boolean
  canRisk: boolean
  onReduce: (by: ReduceBy) => void
}) {
  const [mode, setMode] = useState<ReduceBy['mode']>('risk')
  const [value, setValue] = useState('')
  const unit = { pct: '%', qty: base, quote, risk: quote }[mode]

  const go = (): void => {
    const v = parseFloat(value)
    if (Number.isFinite(v) && v > 0) onReduce({ mode, value: v } as ReduceBy)
  }

  return (
    <div className="flex w-full flex-wrap items-center gap-1 sm:w-auto sm:flex-nowrap">
      <span className="shrink-0 text-xs text-muted">Reduce</span>
      <div className="flex shrink-0 items-center overflow-hidden rounded-md border border-border">
        {[25, 50, 75].map((pct) => (
          <button
            key={pct}
            className="btn btn-ghost btn-sm num !rounded-none !px-2"
            disabled={disabled}
            onClick={() => onReduce({ mode: 'pct', value: pct })}
            title={`Sell ${pct}% of this position now`}
          >
            {pct}%
          </button>
        ))}
      </div>
      <div className="flex w-full items-center overflow-hidden rounded-md border border-border sm:w-auto">
        <input
          className="input num !h-7 !w-full !min-w-0 !flex-1 !rounded-none !border-0 !px-2 !text-xs sm:!w-16 sm:!flex-none"
          type="number"
          min={0}
          step="any"
          value={value}
          placeholder={unit}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && go()}
          title={`Amount in ${unit}`}
        />
        <select
          className="input num !h-7 !w-[4.75rem] !shrink-0 !rounded-none !border-0 !border-l !border-border !px-1 !text-xs"
          value={mode}
          disabled={disabled}
          onChange={(e) => setMode(e.target.value as ReduceBy['mode'])}
          title={canRisk ? 'What the number means' : 'Risk needs a known entry and stop on this position'}
        >
          <option value="risk" disabled={!canRisk}>
            risk
          </option>
          <option value="pct">percent</option>
          <option value="qty">qty</option>
          <option value="quote">value</option>
        </select>
        <button
          className="btn btn-ghost btn-sm !shrink-0 !rounded-none !border-l !border-border !px-3"
          disabled={disabled || !parseFloat(value)}
          onClick={go}
          title="Sell this much now"
        >
          Go
        </button>
      </div>
    </div>
  )
}

export function PositionCard({
  t,
  price,
  acting,
  expanded,
  onToggle,
  onAct,
  onReduce
}: {
  t: ManagedTrade
  price: number | undefined
  acting: boolean
  expanded: boolean
  onToggle: () => void
  onAct: (kind: PositionAction) => void
  onReduce: (by: ReduceBy) => void
}) {
  if (t.phase === 'PENDING' && t.limitEntry) {
    return <PendingEntryCard t={t} entry={t.limitEntry} price={price} acting={acting} expanded={expanded} onToggle={onToggle} onAct={onAct} />
  }
  const r = t.entryPrice - t.initialStop
  const nowR = price !== undefined && r > 0 ? (price - t.entryPrice) / r : null
  const openQty = t.qty + (t.partial && t.partial.status === 'OPEN' ? t.partial.qty - t.partial.fillQty : 0)
  const pnl = price !== undefined ? (price - t.entryPrice) * openQty + (t.realizedPnl ?? 0) : t.realizedPnl
  const lo = Math.min(t.initialStop, t.currentStop)
  const hi = t.takeProfit
  const pos = (v: number): number => (hi > lo ? Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100)) : 0)
  const ph = PHASE[t.phase]
  const Icon = t.phase === 'UNPROTECTED' ? ShieldAlert : t.phase === 'TRAILING' ? TrendingUp : t.phase === 'BE' ? ShieldCheck : Shield
  const next = t.ladder.find((s) => !s.done)
  const canMoveUp = t.ocoOrderListId !== null && (next !== undefined || t.stopR === null)

  return (
    <div className={cls('rounded-lg border p-3', t.phase === 'UNPROTECTED' ? 'border-loss/60 bg-loss/5' : 'border-border bg-bg')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="num font-semibold">{t.symbol}</span>
          <Badge tone="accent">{t.command}</Badge>
          <Badge tone={ph.tone} className="gap-1">
            <Icon className="h-3 w-3" /> {ph.label}
            {t.stopR !== null && t.stopR > 0 && <span className="num">· stop {rLabel(t.stopR)}</span>}
          </Badge>
          <span className="text-xs text-muted">{fmtDate(t.createdAt)}</span>
        </div>
        <div className="flex w-full flex-wrap items-center justify-end gap-1 sm:w-auto">
          {canMoveUp && (
            <button className="btn btn-ghost btn-sm" disabled={acting} onClick={() => onAct('up')} title={next ? `Apply the next rung now: stop → ${rLabel(next.stopR)}` : 'Move the stop to entry now'}>
              Move stop {next ? `→ ${rLabel(next.stopR)}` : '→ entry'}
            </button>
          )}
          <ReduceControl
            quote={t.quoteAsset}
            base={t.baseAsset}
            disabled={acting}
            canRisk={t.entryPrice > t.currentStop}
            onReduce={onReduce}
          />
          <button className="btn btn-danger btn-sm" disabled={acting} onClick={() => onAct('close')}>
            {acting ? <Spinner /> : 'Close at market'}
          </button>
          <button className="btn btn-ghost btn-sm" disabled={acting} onClick={() => onAct('release')} title="Stop managing; leave orders on Binance">
            Release
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onToggle} title="Show log">
            {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-4 gap-2 text-xs sm:grid-cols-7">
        <Mini label="Entry" value={fmtNum(t.entryPrice)} />
        <Mini label="Stop" value={fmtNum(t.currentStop)} sub={t.stopR === null ? (next ? `→ ${rLabel(next.stopR)} at +${next.atR}R` : 'initial') : rLabel(t.stopR)} cls={t.stopR === null ? 'text-loss' : 'text-info'} />
        <Mini label="Target" value={fmtNum(t.takeProfit)} sub={`+${t.tpR.toFixed(t.tpR % 1 ? 1 : 0)}R`} cls="text-gain" />
        <Mini label="Open qty" value={fmtNum(openQty)} sub={openQty < t.qtyInitial ? `of ${fmtNum(t.qtyInitial)} ${t.baseAsset}` : t.baseAsset} />
        <Mini label="Last" value={price !== undefined ? fmtNum(price) : '…'} />
        <Mini label="Now" value={nowR !== null ? `${nowR > 0 ? '+' : ''}${nowR.toFixed(2)}R` : '—'} cls={pnlClass(nowR)} />
        <Mini label="P&L (gross)" value={pnl !== null && pnl !== undefined ? fmtSigned(pnl) : '—'} sub={t.realizedPnl ? `${fmtSigned(t.realizedPnl)} realized` : t.quoteAsset} cls={pnlClass(pnl)} />
      </div>

      {t.partial && (
        <div className="mt-2 text-xs text-muted">
          Partial {t.partial.pct}%:{' '}
          {t.partial.status === 'OPEN' ? (
            <>
              <span className="num text-text">{fmtNum(t.partial.qty)}</span> {t.baseAsset} resting at <span className="num text-text">{fmtNum(t.partial.tp)}</span> (+{t.ladder[0]?.atR ?? 1}R)
            </>
          ) : t.partial.fillQty > 0 ? (
            <>
              sold <span className="num text-text">{fmtNum(t.partial.fillQty)}</span> at <span className="num text-text">{fmtNum(t.partial.fillPrice)}</span>
            </>
          ) : (
            'cancelled'
          )}
        </div>
      )}

      {t.ladder.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {t.ladder.map((s) => (
            <span key={s.atR} className={cls('tag num', s.done ? 'text-gain' : 'text-muted')} title={s.done ? `done ${fmtDate(s.doneAt)}` : 'pending'}>
              {s.done ? '✓ ' : ''}+{s.atR}R → {s.closePct > 0 ? `sell ${s.closePct}%, ` : ''}stop {rLabel(s.stopR)}
            </span>
          ))}
        </div>
      )}

      <ProgressBar lo={lo} hi={hi} entry={t.entryPrice} stop={t.stopR !== null ? t.currentStop : null} marks={r > 0 ? t.ladder.map((s) => ({ at: t.entryPrice + s.atR * r, done: s.done })) : []} price={price} pos={pos} />

      {t.lastError && <div className="selectable mt-2 text-xs text-loss">{t.lastError}</div>}
      {expanded && <LogList t={t} />}
    </div>
  )
}

// ---------------------------------------------------------------- resting limit entry (nothing bought yet)

function PendingEntryCard({
  t,
  entry,
  price,
  acting,
  expanded,
  onToggle,
  onAct
}: {
  t: ManagedTrade
  entry: LimitEntry
  price: number | undefined
  acting: boolean
  expanded: boolean
  onToggle: () => void
  onAct: (kind: PositionAction) => void
}) {
  const r = t.entryPrice - t.initialStop
  const away = price !== undefined && entry.limitPrice > 0 ? (price / entry.limitPrice - 1) * 100 : null
  const attached = entry.listId !== null

  return (
    <div className="rounded-lg border border-accent/50 bg-accent/5 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="num font-semibold">{t.symbol}</span>
          <Badge tone="accent">{t.command}</Badge>
          <Badge tone="accent" className="gap-1">
            <Clock className="h-3 w-3" /> {PHASE.PENDING.label}
          </Badge>
          <Badge tone={attached ? 'gain' : 'neutral'} title={attached ? 'Binance places the stop and target itself when the entry fills' : 'The app places the stop and target when it sees the fill'}>
            {attached ? 'exits attached' : 'exits on fill'}
          </Badge>
          <span className="text-xs text-muted">{fmtDate(t.createdAt)}</span>
        </div>
        <div className="flex w-full flex-wrap items-center justify-end gap-1 sm:w-auto">
          <button className="btn btn-danger btn-sm" disabled={acting} onClick={() => onAct('cancel')} title="Take the entry off the book">
            {acting ? <Spinner /> : 'Cancel entry'}
          </button>
          <button className="btn btn-ghost btn-sm" disabled={acting} onClick={() => onAct('release')} title="Stop managing; leave the order on Binance">
            Release
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onToggle} title="Show log">
            {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-4 gap-2 text-xs sm:grid-cols-7">
        <Mini label="Buy at" value={fmtNum(entry.limitPrice)} sub="limit, resting" cls="text-accent" />
        <Mini label="Stop" value={fmtNum(t.initialStop)} sub="if filled" cls="text-loss" />
        <Mini label="Target" value={fmtNum(t.takeProfit)} sub={`+${t.tpR.toFixed(t.tpR % 1 ? 1 : 0)}R`} cls="text-gain" />
        <Mini label="Qty" value={fmtNum(entry.quantity)} sub={t.baseAsset} />
        <Mini label="Last" value={price !== undefined ? fmtNum(price) : '…'} sub={away !== null ? `${fmtPct(away)} away` : undefined} />
        <Mini label="Risk if filled" value={fmtNum(entry.quantity * r, 2)} sub={t.quoteAsset} cls="text-loss" />
        <Mini label="Cancels" value={entry.expiresAt !== null ? fmtDate(entry.expiresAt) : 'never'} sub={entry.expiresAt !== null ? 'if unfilled' : 'rests until filled'} />
      </div>

      {entry.filledQty > 0 && (
        <div className="mt-2 text-xs text-muted">
          Partly filled: <span className="num text-text">{fmtNum(entry.filledQty)}</span> of {fmtNum(entry.quantity)} {t.baseAsset}
        </div>
      )}

      {t.ladder.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {t.ladder.map((s) => (
            <span key={s.atR} className="tag num text-muted">
              +{s.atR}R → {s.closePct > 0 ? `sell ${s.closePct}%, ` : ''}stop {rLabel(s.stopR)}
            </span>
          ))}
        </div>
      )}

      <p className="mt-2 text-[11px] text-muted">
        Nothing is bought and nothing is risked until this fills.{' '}
        {attached
          ? 'The stop and target are part of the same order list, so Binance places them the instant it fills.'
          : 'The app places the stop and target when it sees the fill, so keep the server running.'}
      </p>

      {t.lastError && <div className="selectable mt-2 text-xs text-loss">{t.lastError}</div>}
      {expanded && <LogList t={t} />}
    </div>
  )
}

// ---------------------------------------------------------------- exchange position card (not managed by the app)

function ExchangePositionCard({
  p,
  price,
  acting,
  expanded,
  onToggle,
  onAdopt,
  onClose,
  onReduce
}: {
  p: ExchangePosition
  price: number | undefined
  acting: boolean
  expanded: boolean
  onToggle: () => void
  onAdopt: () => void
  onClose: () => void
  onReduce: (by: ReduceBy) => void
}) {
  const last = price ?? p.price ?? undefined
  const entry = p.entryPrice
  const r = entry !== null && p.stopPrice !== null ? entry - p.stopPrice : null
  const nowR = r !== null && r > 0 && last !== undefined && entry !== null ? (last - entry) / r : null
  const pnl = entry !== null && last !== undefined ? (last - entry) * p.qty : null
  const pnlPct = entry !== null && last !== undefined && entry > 0 ? (last / entry - 1) * 100 : null
  const hasStop = p.stopPrice !== null
  const protection = hasStop ? (p.targetPrice !== null ? 'stop + target on Binance' : 'stop on Binance') : p.targetPrice !== null ? 'target only · NO STOP' : 'NO STOP'
  const lo = p.stopPrice
  const hi = p.targetPrice
  const pos = (v: number): number => (lo !== null && hi !== null && hi > lo ? Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100)) : 0)

  return (
    <div className={cls('rounded-lg border p-3', hasStop ? 'border-border bg-bg' : 'border-loss/60 bg-loss/5')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="num font-semibold">{p.symbol}</span>
          <Badge tone="neutral">not managed</Badge>
          <Badge tone={hasStop ? 'info' : 'loss'} className="gap-1">
            {hasStop ? <Shield className="h-3 w-3" /> : <ShieldOff className="h-3 w-3" />} {protection}
          </Badge>
          {p.costBasisCoverage !== 'full' && (
            <Badge tone="accent" title="Entry price is unknown or only partly known: sync the Journal or set it when you manage the position">
              {p.costBasisCoverage === 'none' ? 'entry unknown' : 'partial basis'}
            </Badge>
          )}
        </div>
        <div className="flex w-full flex-wrap items-center justify-end gap-1 sm:w-auto">
          <button className="btn btn-primary btn-sm" disabled={acting} onClick={onAdopt} title="Replace its orders with the break-even ladder">
            Manage with ladder
          </button>
          <ReduceControl
            quote={p.quoteAsset}
            base={p.baseAsset}
            disabled={acting}
            canRisk={p.entryPrice !== null && p.stopPrice !== null && p.entryPrice > p.stopPrice}
            onReduce={onReduce}
          />
          <button className="btn btn-danger btn-sm" disabled={acting} onClick={onClose}>
            {acting ? <Spinner /> : 'Close at market'}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onToggle} title="Show orders">
            {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-4 gap-2 text-xs sm:grid-cols-7">
        <Mini label="Entry" value={entry !== null ? fmtNum(entry) : '—'} sub={entry !== null ? 'avg cost' : 'sync trades'} />
        <Mini label="Stop" value={p.stopPrice !== null ? fmtNum(p.stopPrice) : 'none'} sub={p.stopType ? p.stopType.toLowerCase().replace(/_/g, ' ') : undefined} cls={p.stopPrice !== null ? 'text-loss' : 'text-loss font-semibold'} />
        <Mini label="Target" value={p.targetPrice !== null ? fmtNum(p.targetPrice) : '—'} sub={p.targetPrice !== null && r !== null && r > 0 && entry !== null ? `+${((p.targetPrice - entry) / r).toFixed(1)}R` : undefined} cls="text-gain" />
        <Mini label="Qty" value={fmtNum(p.qty)} sub={p.locked > 0 ? `${fmtNum(p.locked)} in orders` : p.baseAsset} />
        <Mini label="Last" value={last !== undefined ? fmtNum(last) : '…'} sub={p.change24hPct !== null ? `${fmtPct(p.change24hPct)} 24h` : undefined} />
        <Mini label="Now" value={nowR !== null ? `${nowR > 0 ? '+' : ''}${nowR.toFixed(2)}R` : pnlPct !== null ? fmtPct(pnlPct) : '—'} cls={pnlClass(nowR ?? pnlPct)} />
        <Mini label="P&L (gross)" value={pnl !== null ? fmtSigned(pnl) : '—'} sub={p.value !== null ? `${fmtNum(p.value, 2)} ${p.quoteAsset} value` : p.quoteAsset} cls={pnlClass(pnl)} />
      </div>

      {lo !== null && hi !== null && hi > lo && <ProgressBar lo={lo} hi={hi} entry={entry} stop={null} marks={[]} price={last} pos={pos} />}

      {expanded && (
        <div className="mt-3 border-t border-border pt-2 text-xs">
          {p.orders.length === 0 ? (
            <div className="text-muted">No open orders on this symbol.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th className="text-right">Trigger</th>
                  <th className="text-right">Price</th>
                  <th className="text-right">Qty</th>
                  <th>Placed</th>
                </tr>
              </thead>
              <tbody>
                {p.orders.map((o) => (
                  <tr key={o.orderId}>
                    <td>
                      {o.type.toLowerCase().replace(/_/g, ' ')}
                      {o.orderListId >= 0 && <span className="ml-1 text-muted">· OCO</span>}
                    </td>
                    <td className="num text-right">{o.stopPrice ? fmtNum(o.stopPrice) : '—'}</td>
                    <td className="num text-right">{o.price ? fmtNum(o.price) : 'market'}</td>
                    <td className="num text-right">{fmtNum(o.origQty)}</td>
                    <td className="text-muted">{fmtDate(o.time)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- adopt into the ladder

function AdoptModal({ p, price, onClose, onDone }: { p: ExchangePosition; price: number | undefined; onClose: () => void; onDone: () => void }) {
  const { settings } = useApp()
  const toast = useToast()
  const qt = settings.quickTrade
  const [entry, setEntry] = useState(p.entryPrice !== null ? String(+p.entryPrice.toPrecision(8)) : price !== undefined ? String(+price.toPrecision(8)) : '')
  const [stop, setStop] = useState(p.stopPrice !== null ? String(p.stopPrice) : '')
  const [target, setTarget] = useState(p.targetPrice !== null ? String(p.targetPrice) : '')
  const [qty, setQty] = useState(String(+p.qty.toPrecision(8)))
  const [ladder, setLadder] = useState(true)
  const [adv, setAdv] = useState({
    beTriggerR: String(qt.beTriggerR),
    partialPct: String(qt.partialPct),
    trailStartR: String(qt.trailStartR),
    trailGapR: String(qt.trailGapR),
    beOffsetPct: String(qt.beOffsetPct)
  })
  const setA = (k: keyof typeof adv) => (e: React.ChangeEvent<HTMLInputElement>) => setAdv((a) => ({ ...a, [k]: e.target.value }))
  const [busy, setBusy] = useState(false)

  const e = num(entry)
  const s = num(stop)
  const tp = num(target)
  const q = num(qty)
  const R = e !== undefined && s !== undefined && e > s ? e - s : null
  const tpR = R !== null && tp !== undefined && tp > (e as number) ? (tp - (e as number)) / R : null
  const beR = num(adv.beTriggerR) ?? 1
  const partialPct = Math.max(0, Math.min(90, parseFloat(adv.partialPct) || 0))
  const trailStart = num(adv.trailStartR) ?? null
  const trailGap = num(adv.trailGapR) ?? 2

  // Same rung logic as the server, for the preview.
  const rungs: { atR: number; stopR: number; pct: number }[] = []
  if (ladder && tpR !== null && beR < tpR) {
    rungs.push({ atR: beR, stopR: 0, pct: partialPct })
    if (trailStart) for (let k = trailStart; k < tpR - 1e-9; k += 1) if (k > rungs[rungs.length - 1].atR && k - trailGap > rungs[rungs.length - 1].stopR) rungs.push({ atR: k, stopR: k - trailGap, pct: 0 })
  }
  const pastBe = ladder && R !== null && e !== undefined && price !== undefined && price >= e + beR * R

  const submit = async (): Promise<void> => {
    if (e === undefined || s === undefined || tp === undefined || q === undefined) {
      toast.warn('Enter entry, stop, target and quantity')
      return
    }
    if (R === null) {
      toast.warn('The stop must be below the entry')
      return
    }
    if (tpR === null) {
      toast.warn('The target must be above the entry')
      return
    }
    setBusy(true)
    try {
      const req: AdoptRequest = {
        symbol: p.symbol,
        qty: q,
        entryPrice: e,
        stopPrice: s,
        takeProfit: tp,
        cancelOrderIds: p.orders.filter((o) => o.orderListId < 0).map((o) => o.orderId),
        cancelOrderListIds: p.orderListIds,
        beTriggerR: ladder ? beR : null,
        beOffsetPct: parseFloat(adv.beOffsetPct) || 0,
        partialPct: ladder ? partialPct : 0,
        trailStartR: ladder ? trailStart : null,
        trailGapR: trailGap
      }
      const t = await api.rtrade.adopt(req)
      if (t.phase === 'UNPROTECTED') toast.error(`${p.symbol}: orders replaced but NOT protected`, t.lastError ?? 'The stop and target could not be placed. Watch this position.')
      else toast.success(`${p.symbol} is now managed`, `Stop ${fmtNum(t.currentStop)} · target ${fmtNum(t.takeProfit)}${t.partial ? ` · ${t.partial.pct}% resting at ${fmtNum(t.partial.tp)}` : ''}`)
      onDone()
    } catch (err) {
      toast.error('Could not manage this position', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          Manage {p.symbol} with the ladder {settings.testnet ? <Badge tone="accent">TESTNET</Badge> : <Badge tone="loss">LIVE</Badge>}
        </span>
      }
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={busy}>
            {busy && <Spinner />} Replace orders &amp; manage
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-sm">
        <p className="text-xs text-muted">
          The app cancels the {p.orders.length} current order{p.orders.length === 1 ? '' : 's'} on {p.symbol} and places its own stop and target, then runs the ladder
          from these numbers. R is the distance from entry to stop.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label={`Entry price (${p.quoteAsset})`} hint={p.entryPrice !== null ? 'average cost from your trades' : 'unknown: enter what you paid'}>
            <input className="input num" type="number" min={0} value={entry} onChange={(ev) => setEntry(ev.target.value)} />
          </Field>
          <Field label={`Quantity (${p.baseAsset})`} hint={`${fmtNum(p.qty)} held`}>
            <input className="input num" type="number" min={0} value={qty} onChange={(ev) => setQty(ev.target.value)} />
          </Field>
          <Field label="Stop-loss price" hint={p.stopPrice !== null ? 'from your current stop order' : 'required'}>
            <input className="input num" type="number" min={0} value={stop} onChange={(ev) => setStop(ev.target.value)} />
          </Field>
          <Field label="Target price" hint={tpR !== null ? `+${tpR.toFixed(2)}R` : p.targetPrice !== null ? 'from your current target order' : 'required'}>
            <input className="input num" type="number" min={0} value={target} onChange={(ev) => setTarget(ev.target.value)} />
          </Field>
        </div>
        <div className="rounded-md border border-border p-3">
          <Toggle checked={ladder} onChange={setLadder} label={<span className="text-sm">Break-even ladder</span>} />
          {ladder && (
            <div className="mt-3 grid grid-cols-3 gap-3">
              <Field label="Break-even at (R)">
                <input className="input num" type="number" min={0.1} step={0.5} value={adv.beTriggerR} onChange={setA('beTriggerR')} />
              </Field>
              <Field label="Sell there (%)">
                <input className="input num" type="number" min={0} max={90} step={5} value={adv.partialPct} onChange={setA('partialPct')} />
              </Field>
              <Field label="BE offset (%)">
                <input className="input num" type="number" step={0.05} value={adv.beOffsetPct} onChange={setA('beOffsetPct')} />
              </Field>
              <Field label="Trail from (R)">
                <input className="input num" type="number" min={1} step={1} value={adv.trailStartR} onChange={setA('trailStartR')} />
              </Field>
              <Field label="Trail gap (R)">
                <input className="input num" type="number" min={0.5} step={0.5} value={adv.trailGapR} onChange={setA('trailGapR')} />
              </Field>
            </div>
          )}
        </div>
        {R !== null && q !== undefined && (
          <div className="rounded-md bg-panel-2 p-3 text-xs">
            <div className="grid grid-cols-2 gap-y-1">
              <span className="text-muted">Risk (1R)</span>
              <span className="num text-right text-loss">{fmtNum(q * R, 2)} {p.quoteAsset}</span>
              {tp !== undefined && tpR !== null && (
                <>
                  <span className="text-muted">Reward at target</span>
                  <span className="num text-right text-gain">{fmtNum(q * (tp - (e as number)), 2)} {p.quoteAsset} (+{tpR.toFixed(2)}R)</span>
                </>
              )}
              {price !== undefined && (
                <>
                  <span className="text-muted">Now</span>
                  <span className={cls('num text-right', pnlClass(price - (e as number)))}>{`${price >= (e as number) ? '+' : ''}${((price - (e as number)) / R).toFixed(2)}R`}</span>
                </>
              )}
            </div>
            {rungs.length > 0 && (
              <ol className="mt-2 space-y-0.5 border-t border-border pt-2">
                {rungs.map((s) => (
                  <li key={s.atR} className="flex gap-2">
                    <span className="num w-16 shrink-0 text-accent">at +{s.atR}R</span>
                    <span>
                      {s.pct > 0 && `sell ${s.pct}%, `}stop → {rLabel(s.stopR)}
                    </span>
                  </li>
                ))}
              </ol>
            )}
            {pastBe && <div className="mt-2 text-accent">Price is already past +{beR}R: no resting partial is placed; the ladder moves the stop on its first check.</div>}
          </div>
        )}
        {!settings.testnet && <div className="rounded-md border border-loss/40 bg-loss/10 p-2 text-xs text-loss">This replaces real orders on your Binance account. The position is unprotected for about a second while they are swapped.</div>}
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------- history of managed positions

export function PositionHistory() {
  const { managed, reload } = usePositions(60_000)
  const toast = useToast()
  const closed = useMemo(() => managed.filter((t) => !OPEN_PHASES.has(t.phase)), [managed])
  const [expanded, setExpanded] = useState<string | null>(null)

  const remove = async (t: ManagedTrade): Promise<void> => {
    if (!window.confirm('Remove this entry from the history?')) return
    try {
      await api.rtrade.remove(t.id)
      await reload()
    } catch (e) {
      toast.error('Could not remove', (e as Error).message)
    }
  }

  return (
    <Card title={`History (${closed.length})`} className="p-0">
      {closed.length === 0 ? (
        <div className="px-4 py-8 text-center text-xs text-muted">Closed positions will be listed here with their outcome and R achieved.</div>
      ) : (
        <div className="max-h-[50vh] overflow-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Command</th>
                <th>Outcome</th>
                <th>Opened</th>
                <th>Closed</th>
                <th className="text-right">Entry</th>
                <th className="text-right">Exit</th>
                <th className="text-right">R</th>
                <th className="text-right">P&L (gross)</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {closed.map((t) => {
                const r = t.entryPrice - t.initialStop
                const rGot = t.realizedPnl !== null && t.riskQuote > 0 ? t.realizedPnl / t.riskQuote : null
                return (
                  <tr key={t.id} className="cursor-pointer" onClick={() => setExpanded((x) => (x === t.id ? null : t.id))}>
                    <td className="num">{t.symbol}</td>
                    <td>
                      <Badge tone="accent">{t.command}</Badge>
                    </td>
                    <td>
                      <Badge tone={PHASE[t.phase].tone}>{PHASE[t.phase].label}</Badge>
                    </td>
                    <td className="text-xs whitespace-nowrap text-muted">{fmtDate(t.createdAt)}</td>
                    <td className="text-xs whitespace-nowrap text-muted">{fmtDate(t.closedAt)}</td>
                    <td className="num text-right">{fmtNum(t.entryPrice)}</td>
                    <td className="num text-right">
                      {t.exitPrice !== null ? fmtNum(t.exitPrice) : '—'}
                      {t.partial && t.partial.fillQty > 0 && t.partial.fillPrice !== null && <div className="text-[10px] text-muted">½ at {fmtNum(t.partial.fillPrice)}</div>}
                    </td>
                    <td className={cls('num text-right', pnlClass(rGot))}>{rGot !== null && r > 0 ? `${rGot > 0 ? '+' : ''}${rGot.toFixed(2)}R` : '—'}</td>
                    <td className={cls('num text-right', pnlClass(t.realizedPnl))}>{t.realizedPnl !== null ? fmtSigned(t.realizedPnl, t.quoteAsset) : '—'}</td>
                    <td className="text-right">
                      <button
                        className="btn btn-ghost btn-sm text-loss"
                        onClick={(ev) => {
                          ev.stopPropagation()
                          void remove(t)
                        }}
                        title="Remove from history"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {closed.find((t) => t.id === expanded) && (
            <div className="px-4 pb-3">
              <LogList t={closed.find((t) => t.id === expanded) as ManagedTrade} />
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------- small pieces

function ProgressBar({
  lo,
  hi,
  entry,
  stop,
  marks,
  price,
  pos
}: {
  lo: number
  hi: number
  entry: number | null
  stop: number | null
  marks: { at: number; done: boolean }[]
  price: number | undefined
  pos: (v: number) => number
}) {
  return (
    <>
      <div className="relative mt-3 h-1.5 rounded-full bg-border">
        {entry !== null && (
          <>
            <div className="absolute inset-y-0 left-0 rounded-full bg-loss/40" style={{ width: `${pos(entry)}%` }} />
            <div className="absolute inset-y-0 rounded-full bg-gain/40" style={{ left: `${pos(entry)}%`, right: 0 }} />
            <div className="absolute -top-1 h-3.5 w-0.5 bg-text" style={{ left: `${pos(entry)}%` }} title="entry" />
          </>
        )}
        {marks.map((m) => (
          <div key={m.at} className={cls('absolute -top-1 h-3.5 w-0.5', m.done ? 'bg-gain' : 'bg-accent')} style={{ left: `${pos(m.at)}%` }} title="ladder rung" />
        ))}
        {stop !== null && <div className="absolute -top-1 h-3.5 w-0.5 bg-info" style={{ left: `${pos(stop)}%` }} title={`stop ${fmtNum(stop)}`} />}
        {price !== undefined && <div className="absolute -top-1 h-3.5 w-3.5 -translate-x-1/2 rounded-full border-2 border-bg bg-info" style={{ left: `${pos(price)}%` }} title={`last ${fmtNum(price)}`} />}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted">
        <span className="num">SL {fmtNum(lo)}</span>
        <span className="num">TP {fmtNum(hi)}</span>
      </div>
    </>
  )
}

export function LogList({ t }: { t: ManagedTrade }) {
  return (
    <ul className="mt-3 space-y-1 border-t border-border pt-2 text-xs">
      {[...t.log].reverse().map((l, i) => (
        <li key={i} className="flex gap-3">
          <span className="num shrink-0 text-muted">{fmtDate(l.time)}</span>
          <span className="selectable">{l.message}</span>
        </li>
      ))}
    </ul>
  )
}

export function Mini({ label, value, sub, cls: c }: { label: string; value: string; sub?: string; cls?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] tracking-wide text-muted uppercase">{label}</div>
      <div className={cls('num truncate text-sm', c)}>{value}</div>
      {sub && <div className="truncate text-[10px] text-muted">{sub}</div>}
    </div>
  )
}
