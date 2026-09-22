import type { QuickTradeSettings, REntryType, RTradePreview, RTradeRequest, SymbolInfo } from '@shared/types'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useApp } from '../App'
import { Mini, OpenPositions, PositionHistory } from '../components/Positions'
import { SymbolPicker } from '../components/SymbolPicker'
import { useToast } from '../components/Toast'
import { Badge, Card, Field, Modal, Segmented, Spinner, Toggle } from '../components/ui'
import { api } from '../lib/api'
import { cls, fmtNum, fmtPct, splitSymbol } from '../lib/format'
import { useLivePrices } from '../lib/usePrices'

const COMMANDS: { label: string; tpR: number; be: boolean }[] = [
  { label: '1R', tpR: 1, be: false },
  { label: '2R', tpR: 2, be: false },
  { label: '3R', tpR: 3, be: false },
  { label: '2R BE', tpR: 2, be: true },
  { label: '3R BE', tpR: 3, be: true }
]

const num = (s: string): number | undefined => {
  const n = parseFloat(s)
  return Number.isFinite(n) && n > 0 ? n : undefined
}
const rLabel = (r: number): string => (r === 0 ? 'entry' : `${r > 0 ? '+' : ''}${r}R`)

export default function QuickTrade() {
  const { settings, keys, go } = useApp()
  const toast = useToast()
  const qt = settings.quickTrade

  const [symbol, setSymbol] = useState(settings.watchlist[0] ?? 'BTCUSDT')
  const [info, setInfo] = useState<SymbolInfo | null>(null)
  const [entryType, setEntryType] = useState<REntryType>('MARKET')
  const [limit, setLimit] = useState('')
  const [expireMin, setExpireMin] = useState('')
  const [stop, setStop] = useState('')
  const [mode, setMode] = useState<QuickTradeSettings['sizingMode']>(qt.sizingMode)
  const [size, setSize] = useState(qt.sizingMode === 'riskPct' ? String(qt.riskPct) : qt.sizingMode === 'risk' ? String(qt.riskQuote) : '')
  const [customR, setCustomR] = useState('4')
  const [customBe, setCustomBe] = useState(true)
  const [adv, setAdv] = useState({
    beTriggerR: String(qt.beTriggerR),
    partialPct: String(qt.partialPct),
    trailStartR: String(qt.trailStartR),
    trailGapR: String(qt.trailGapR),
    beOffsetPct: String(qt.beOffsetPct),
    stopGapPct: String(qt.stopGapPct)
  })
  const setA = (k: keyof typeof adv) => (e: React.ChangeEvent<HTMLInputElement>) => setAdv((a) => ({ ...a, [k]: e.target.value }))
  const [showAdv, setShowAdv] = useState(false)
  const [preview, setPreview] = useState<{ req: RTradeRequest; p: RTradePreview } | null>(null)
  const [busy, setBusy] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  // Account value, for percent sizing: spot plus the funding wallet, since both
  // are money you own. Read once per environment and again after each trade.
  const [equity, setEquity] = useState<{ spot: number; funding: number; positions: number; asset: string } | null>(null)
  const [equityErr, setEquityErr] = useState<string | null>(null)
  // Converts the portfolio's quote asset into the pair's; null while unknown, unused when they match.
  const [fxRate, setFxRate] = useState<number | null>(null)
  const [includeFunding, setIncludeFunding] = useState(qt.includeFunding)
  const [excludePositions, setExcludePositions] = useState(qt.excludeOpenPositions)

  const { prices } = useLivePrices([symbol])
  const last = prices[symbol]

  useEffect(() => {
    api.market
      .symbol(symbol)
      .then(setInfo)
      .catch(() => setInfo(null))
  }, [symbol])

  const pPrec = info?.filters.pricePrecision ?? 2
  const { base, quote } = info ? { base: info.baseAsset, quote: info.quoteAsset } : splitSymbol(symbol)

  useEffect(() => {
    if (!keys.hasKeys) {
      setEquity(null)
      setEquityErr(null)
      return
    }
    let alive = true
    api.portfolio
      .get()
      .then((p) => {
        if (!alive) return
        setEquity({ spot: p.totalValue, funding: p.fundingValue, positions: p.positionsValue, asset: p.quoteAsset })
        setEquityErr(null)
      })
      .catch((e) => {
        if (!alive) return
        setEquity(null)
        setEquityErr((e as Error).message)
      })
    return () => {
      alive = false
    }
  }, [keys.hasKeys, settings.testnet, refreshKey])

  // The portfolio is valued in one asset; a pair quoted in another has to be converted.
  useEffect(() => {
    const from = equity?.asset
    if (!from || from === quote) {
      setFxRate(null)
      return
    }
    let alive = true
    const direct = `${from}${quote}`
    const inverse = `${quote}${from}`
    api.market
      .prices([direct, inverse])
      .then((m) => {
        if (alive) setFxRate(m[direct] > 0 ? m[direct] : m[inverse] > 0 ? 1 / m[inverse] : null)
      })
      .catch(() => {
        if (alive) setFxRate(null)
      })
    return () => {
      alive = false
    }
  }, [equity?.asset, quote])

  /** Converts a figure from the portfolio's quote asset into this pair's, null when it cannot. */
  const inQuote = (v: number): number | null => {
    if (equity === null) return null
    if (equity.asset === quote) return v
    return fxRate === null ? null : v * fxRate
  }
  // Each switch adds or removes one part of the base the percent is taken from.
  const fundingCounted = equity === null || !includeFunding ? 0 : equity.funding
  const positionsCounted = equity === null || !excludePositions ? 0 : equity.positions
  /** The account the percent applies to, in this pair's quote asset; null when it cannot be valued there. */
  const equityInQuote = equity === null ? null : inQuote(Math.max(0, equity.spot + fundingCounted - positionsCounted))
  const beR = num(adv.beTriggerR) ?? 1
  const partialPct = Math.max(0, Math.min(90, parseFloat(adv.partialPct) || 0))
  const trailStart = num(adv.trailStartR) ?? null
  const trailGap = num(adv.trailGapR) ?? 2

  // Everything is measured from where the entry is expected to happen.
  const isLimit = entryType === 'LIMIT'
  const entryRef = isLimit ? num(limit) : last
  const limitOffPct = last !== undefined && entryRef !== undefined && isLimit ? (entryRef / last - 1) * 100 : null

  const setStopPct = (pct: number): void => {
    if (entryRef === undefined) return
    setStop((entryRef * (1 - pct / 100)).toFixed(pPrec))
  }
  const setLimitPct = (pct: number): void => {
    if (last === undefined) return
    setLimit((last * (1 - pct / 100)).toFixed(pPrec))
  }

  // Percent sizing turns into an amount in the pair's quote asset before anything else uses it.
  const isPct = mode === 'riskPct'
  const pctRisk = useMemo(() => {
    const p = num(size)
    if (!isPct || p === undefined || equityInQuote === null) return null
    return (equityInQuote * p) / 100
  }, [isPct, size, equityInQuote])

  /** The amount (or quantity) the commands are sized with, whatever the mode. */
  const sizeValue = isPct ? (pctRisk ?? undefined) : num(size)

  // Client-side estimate shown while typing; the confirmed numbers come from the server.
  const est = useMemo(() => {
    const sp = num(stop)
    const n = sizeValue
    if (entryRef === undefined || !sp || sp >= entryRef || !n) return null
    const r = entryRef - sp
    const qty = mode === 'risk' || isPct ? n / r : mode === 'quote' ? n / entryRef : n
    return { entry: entryRef, r, rPct: (r / entryRef) * 100, qty, value: qty * entryRef, risk: qty * r }
  }, [stop, sizeValue, mode, isPct, entryRef])

  const buildReq = (label: string, tpR: number, be: boolean): RTradeRequest | string => {
    const sp = num(stop)
    if (isLimit && !num(limit)) return 'Enter the price the limit buy should rest at'
    if (!sp) return 'Enter a stop-loss price first'
    const n = sizeValue
    if (!n) {
      if (!isPct) return 'Enter the position size'
      if (num(size) === undefined) return 'Enter the percent of your account to risk'
      if (!keys.hasKeys) return 'Add API keys so the app can read your account value'
      if (equity === null) return equityErr ? `Cannot read your account value: ${equityErr}` : 'Still reading your account value — try again in a moment'
      return `Cannot value your ${equity.asset} account in ${quote}`
    }
    if (!(tpR > 0)) return 'Take-profit must be a positive number of R'
    return {
      symbol,
      stopPrice: sp,
      tpR,
      beTriggerR: be ? beR : null,
      beOffsetPct: parseFloat(adv.beOffsetPct) || 0,
      partialPct: be ? partialPct : 0,
      trailStartR: be ? trailStart : null,
      trailGapR: trailGap,
      sizing: mode === 'risk' || isPct ? { mode: 'risk', riskQuote: n } : mode === 'quote' ? { mode: 'quote', quoteAmount: n } : { mode: 'quantity', quantity: n },
      command: label,
      entryType,
      limitPrice: isLimit ? num(limit) : undefined,
      expireMinutes: isLimit ? (num(expireMin) ?? null) : null
    }
  }

  const persistDefaults = (patch: Partial<QuickTradeSettings> = {}): void => {
    void api.settings.set({
      quickTrade: {
        riskQuote: mode === 'risk' ? (num(size) ?? qt.riskQuote) : qt.riskQuote,
        riskPct: isPct ? (num(size) ?? qt.riskPct) : qt.riskPct,
        includeFunding,
        excludeOpenPositions: excludePositions,
        sizingMode: mode,
        beTriggerR: beR,
        beOffsetPct: parseFloat(adv.beOffsetPct) || 0,
        stopGapPct: num(adv.stopGapPct) ?? 1,
        partialPct,
        trailStartR: trailStart ?? 0,
        trailGapR: trailGap,
        ...patch
      }
    })
  }

  const toggleFunding = (v: boolean): void => {
    setIncludeFunding(v)
    persistDefaults({ includeFunding: v })
  }

  const togglePositions = (v: boolean): void => {
    setExcludePositions(v)
    persistDefaults({ excludeOpenPositions: v })
  }

  const run = async (label: string, tpR: number, be: boolean): Promise<void> => {
    if (!keys.hasKeys) {
      toast.warn('Add API keys with spot trading permission first')
      return
    }
    const req = buildReq(label, tpR, be)
    if (typeof req === 'string') {
      toast.warn(req)
      return
    }
    setBusy(true)
    try {
      const p = await api.rtrade.preview(req)
      persistDefaults()
      setPreview({ req, p })
    } catch (e) {
      toast.error('Cannot open this trade', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const confirm = async (): Promise<void> => {
    if (!preview) return
    setBusy(true)
    try {
      const t = await api.rtrade.open(preview.req)
      if (t.phase === 'PENDING') {
        toast.success(
          `${t.command} ${t.symbol} entry placed`,
          `Limit ${fmtNum(t.limitEntry?.limitPrice)} · SL ${fmtNum(t.currentStop)} · TP ${fmtNum(t.takeProfit)}. ${
            t.limitEntry?.listId !== null ? 'Binance places the stop and target when it fills.' : 'The app places the stop and target when it fills.'
          }`
        )
      } else if (t.phase === 'UNPROTECTED') {
        toast.error(`${t.command} ${t.symbol}: bought but NOT protected`, t.lastError ?? 'The stop and target could not be placed. Watch this position.')
      } else {
        toast.success(`${t.command} ${t.symbol} opened`, `Entry ${fmtNum(t.entryPrice)} · SL ${fmtNum(t.currentStop)} · TP ${fmtNum(t.takeProfit)}${t.partial ? ` · ${t.partial.pct}% resting at ${fmtNum(t.partial.tp)}` : ''}`)
      }
      setPreview(null)
      setStop('')
      setRefreshKey((k) => k + 1)
    } catch (e) {
      toast.error('Trade failed', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const tpEstimate = (tpR: number): string => (est ? fmtNum(est.entry + tpR * est.r, pPrec) : '—')

  // Shows the percent resolving to a real amount, so the sizing is never a guess.
  const pctHint = ((): string => {
    if (!keys.hasKeys) return 'add API keys so the app can read your account value'
    if (equity === null) return equityErr ? `could not read your account value: ${equityErr}` : 'reading your account value…'
    if (equityInQuote === null) return `cannot value your ${equity.asset} account in ${quote}`
    // Spell the base out whenever it is not simply the spot wallet.
    const spotHere = inQuote(equity.spot)
    const fundingHere = inQuote(fundingCounted)
    const positionsHere = inQuote(positionsCounted)
    const parts = [`spot ${fmtNum(spotHere ?? 0, 2)}`]
    if (fundingCounted > 0 && fundingHere !== null) parts.push(`+ funding ${fmtNum(fundingHere, 2)}`)
    if (positionsCounted > 0 && positionsHere !== null) parts.push(`− positions ${fmtNum(positionsHere, 2)}`)
    const made = parts.length > 1 ? ` (${parts.join(' ')})` : ''
    const p = num(size)
    if (p === undefined) return `account ${fmtNum(equityInQuote, 2)} ${quote}${made}`
    return `${fmtNum(p)}% of ${fmtNum(equityInQuote, 2)} ${quote}${made} = ${fmtNum((equityInQuote * p) / 100, 2)} ${quote}`
  })()
  const beSummary = `at +${beR}R sell ${partialPct}% and stop → entry${trailStart ? `; from +${trailStart}R the stop trails ${trailGap}R behind` : ''}`

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Quick trade</h1>
          <p className="text-sm text-muted">
            R commands: buy at market or rest a limit, sized from your stop, target at N × R. "BE" adds the ladder: {beSummary}.
          </p>
        </div>
        {settings.testnet ? <Badge tone="accent">TESTNET · fake funds</Badge> : <Badge tone="loss">LIVE · real funds</Badge>}
      </header>

      <div className="grid gap-5 xl:grid-cols-[440px_1fr]">
        {/* ------------------------------------------------ command panel */}
        <Card className="self-start">
          <div className="flex flex-col gap-4">
            <SymbolPicker value={symbol} onChange={setSymbol} />

            <div className="flex items-baseline justify-between rounded-md bg-panel-2 px-3 py-2">
              <span className="text-xs text-muted">Last price</span>
              <span className="num text-lg font-semibold">{last !== undefined ? fmtNum(last, pPrec) : '—'}</span>
            </div>

            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-muted">Entry</span>
              <Segmented
                value={entryType}
                onChange={setEntryType}
                options={[
                  { value: 'MARKET', label: 'Market' },
                  { value: 'LIMIT', label: 'Limit' }
                ]}
              />
            </div>

            {isLimit && (
              <>
                <Field
                  label={`Limit buy price (${quote})`}
                  hint={limitOffPct !== null ? `${fmtPct(limitOffPct)} from the market` : 'the buy rests here until price comes to it'}
                >
                  <div className="flex gap-2">
                    <input className="input num" type="number" min={0} value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="where you want to be filled" />
                    <div className="flex shrink-0 gap-1">
                      {[0.5, 1, 2].map((p) => (
                        <button key={p} className="btn btn-ghost btn-sm num" onClick={() => setLimitPct(p)} disabled={last === undefined} title={`Rest ${p}% below the current price`}>
                          -{p}%
                        </button>
                      ))}
                    </div>
                  </div>
                </Field>
                <Field label="Cancel the entry after (minutes)" hint="blank: it rests until it fills or you cancel it">
                  <input className="input num" type="number" min={1} step={15} value={expireMin} onChange={(e) => setExpireMin(e.target.value)} placeholder="never" />
                </Field>
              </>
            )}

            <Field label={`Stop-loss price (${quote})`}>
              <div className="flex gap-2">
                <input className="input num" type="number" min={0} value={stop} onChange={(e) => setStop(e.target.value)} placeholder="where the idea is wrong" />
                <div className="flex shrink-0 gap-1">
                  {[0.5, 1, 2, 3].map((p) => (
                    <button
                      key={p}
                      className="btn btn-ghost btn-sm num"
                      onClick={() => setStopPct(p)}
                      disabled={entryRef === undefined}
                      title={`Stop ${p}% below the ${isLimit ? 'limit price' : 'current price'}`}
                    >
                      -{p}%
                    </button>
                  ))}
                </div>
              </div>
            </Field>

            <div className="flex flex-col gap-3">
              <Field label="Size by">
                <Segmented
                  className="self-start"
                  value={mode}
                  onChange={(m) => {
                    setMode(m)
                    setSize(m === 'risk' ? String(qt.riskQuote) : m === 'riskPct' ? String(qt.riskPct) : '')
                  }}
                  options={[
                    { value: 'risk', label: 'Risk' },
                    { value: 'riskPct', label: 'Risk %' },
                    { value: 'quote', label: 'Amount' },
                    { value: 'quantity', label: 'Qty' }
                  ]}
                />
              </Field>
              <Field
                label={isPct ? 'Risk per trade (% of account)' : mode === 'risk' ? `Risk per trade (${quote})` : mode === 'quote' ? `Amount to spend (${quote})` : `Quantity (${base})`}
                hint={isPct ? pctHint : undefined}
              >
                <div className="flex gap-2">
                  <input className="input num" type="number" min={0} step={isPct ? 0.25 : undefined} value={size} onChange={(e) => setSize(e.target.value)} />
                  {isPct && (
                    <div className="flex shrink-0 gap-1">
                      {[0.5, 1, 2].map((p) => (
                        <button key={p} className="btn btn-ghost btn-sm num" onClick={() => setSize(String(p))} title={`Risk ${p}% of your account on this trade`}>
                          {p}%
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </Field>
              {isPct && equity !== null && (equity.funding > 0 || equity.positions > 0) && (
                <div className="flex flex-col gap-2">
                  {equity.funding > 0 && (
                    <Toggle
                      checked={includeFunding}
                      onChange={toggleFunding}
                      label={<span className="text-xs text-muted">Count the funding wallet as part of the account</span>}
                    />
                  )}
                  {equity.positions > 0 && (
                    <Toggle
                      checked={excludePositions}
                      onChange={togglePositions}
                      label={<span className="text-xs text-muted">Subtract what open positions already tie up</span>}
                    />
                  )}
                </div>
              )}
            </div>

            <div className="grid grid-cols-4 gap-2 rounded-md border border-border p-3 text-xs">
              <Mini label="R distance" value={est ? `${fmtNum(est.r, pPrec)}` : '—'} sub={est ? fmtPct(-est.rPct) : undefined} />
              <Mini label="Quantity" value={est ? fmtNum(est.qty) : '—'} sub={base} />
              <Mini label="Position" value={est ? fmtNum(est.value, 2) : '—'} sub={quote} />
              <Mini label="Risk (1R)" value={est ? fmtNum(est.risk, 2) : '—'} sub={quote} cls="text-loss" />
            </div>

            <div className="grid grid-cols-3 gap-2">
              {COMMANDS.map((c) => (
                <button
                  key={c.label}
                  className={cls('btn flex-col gap-0 py-2', c.be ? 'btn-primary' : 'btn-gain')}
                  disabled={busy || !est}
                  onClick={() => run(c.label, c.tpR, c.be)}
                  title={`${isLimit ? 'Rest a limit buy; ' : 'Buy at market; '}${c.be ? `target ${c.tpR}R; ${beSummary}` : `target ${c.tpR}R, plain stop`}`}
                >
                  <span className="text-base font-bold">{c.label}</span>
                  <span className="num text-[10px] opacity-80">TP {tpEstimate(c.tpR)}</span>
                </button>
              ))}
              <div className="flex items-stretch gap-1 rounded-md border border-border p-1">
                <input className="input num !w-14 !px-2 !py-1 text-center" type="number" min={0.1} step={0.5} value={customR} onChange={(e) => setCustomR(e.target.value)} title="Custom target in R" />
                <button className="btn btn-ghost btn-sm !px-2" onClick={() => setCustomBe((v) => !v)} title="Toggle the ladder for the custom command">
                  <span className={customBe ? 'text-accent' : 'text-muted'}>BE</span>
                </button>
                <button className="btn btn-gain btn-sm flex-1" disabled={busy || !est || !num(customR)} onClick={() => run(`${customR}R${customBe ? ' BE' : ''}`, num(customR) ?? 0, customBe)}>
                  Go
                </button>
              </div>
            </div>

            <button className="flex items-center gap-1 text-xs text-muted hover:text-text" onClick={() => setShowAdv((v) => !v)}>
              {showAdv ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />} Ladder settings
            </button>
            {showAdv && (
              <div className="grid grid-cols-3 gap-3">
                <Field label="Break-even at (R)" hint="first rung">
                  <input className="input num" type="number" min={0.1} step={0.5} value={adv.beTriggerR} onChange={setA('beTriggerR')} />
                </Field>
                <Field label="Sell at break-even (%)" hint="0 = keep all">
                  <input className="input num" type="number" min={0} max={90} step={5} value={adv.partialPct} onChange={setA('partialPct')} />
                </Field>
                <Field label="BE stop offset (%)" hint="0.2 covers fees">
                  <input className="input num" type="number" step={0.05} value={adv.beOffsetPct} onChange={setA('beOffsetPct')} />
                </Field>
                <Field label="Trail from (R)" hint="blank = no trailing">
                  <input className="input num" type="number" min={1} step={1} value={adv.trailStartR} onChange={setA('trailStartR')} />
                </Field>
                <Field label="Trail gap (R)" hint="3R → stop +1R with gap 2">
                  <input className="input num" type="number" min={0.5} step={0.5} value={adv.trailGapR} onChange={setA('trailGapR')} />
                </Field>
                <Field label="Stop-limit gap (%)" hint="pairs without market stops">
                  <input className="input num" type="number" min={0.1} step={0.1} value={adv.stopGapPct} onChange={setA('stopGapPct')} />
                </Field>
              </div>
            )}

            <p className="text-[11px] text-muted">
              {isLimit
                ? `The buy rests at your price with the target and stop attached to it, so Binance places them itself the moment it fills. Nothing is bought and nothing is risked until then. `
                : 'Plain commands place one OCO (target + stop). BE commands place two: half the size with the target and stop, the other half with its target resting at +' +
                  beR +
                  'R. '}
              Every exit order lives on Binance even if this app closes; the stop moves and outcome tracking run every 15 seconds while the server is
              running.
            </p>
            {!keys.hasKeys && (
              <button className="text-xs text-accent hover:underline" onClick={() => go('settings')}>
                Add API keys to trade →
              </button>
            )}
          </div>
        </Card>

        {/* ------------------------------------------------ positions (all of them) */}
        <div className="flex min-w-0 flex-col gap-5" key={refreshKey}>
          <OpenPositions />
          <PositionHistory />
        </div>
      </div>

      <Modal
        open={!!preview}
        onClose={() => setPreview(null)}
        title={
          <span className="flex items-center gap-2">
            Confirm {preview?.req.command} on {preview?.p.symbol}
            {settings.testnet ? <Badge tone="accent">TESTNET</Badge> : <Badge tone="loss">LIVE</Badge>}
          </span>
        }
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setPreview(null)} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn-gain" onClick={confirm} disabled={busy}>
              {busy && <Spinner />} {preview?.p.entryType === 'LIMIT' ? 'Place the entry' : 'Buy & protect'}
            </button>
          </>
        }
      >
        {preview && (
          <div className="flex flex-col gap-3 text-sm">
            <div className="grid grid-cols-2 gap-y-1.5">
              <Row
                k={preview.p.entryType === 'LIMIT' ? 'Limit buy' : 'Market buy'}
                v={`${fmtNum(preview.p.quantity)} ${preview.p.baseAsset} ≈ ${fmtNum(preview.p.positionValue, 2)} ${preview.p.quoteAsset}`}
              />
              {preview.p.entryType === 'LIMIT' ? (
                <>
                  <Row k="Rests at" v={`${fmtNum(preview.p.entryPrice)} (market ${fmtNum(preview.p.lastPrice)})`} />
                  <Row k="Cancel after" v={preview.req.expireMinutes ? `${preview.req.expireMinutes} min` : 'never — rests until filled'} />
                </>
              ) : (
                <Row k="Entry (approx.)" v={fmtNum(preview.p.lastPrice)} />
              )}
              <Row k="Stop-loss" v={`${fmtNum(preview.p.stopPrice)} (${fmtPct(-preview.p.rPct)})`} cls="text-loss" />
              <Row k="Target" v={`${fmtNum(preview.p.takeProfit)} (+${preview.req.tpR}R)`} cls="text-gain" />
              <Row k="Risk (1R)" v={`${fmtNum(preview.p.riskQuote, 2)} ${preview.p.quoteAsset}`} cls="text-loss" />
              <Row k="Reward at target" v={`${fmtNum(preview.p.rewardQuote, 2)} ${preview.p.quoteAsset}`} cls="text-gain" />
              <Row k="Stop type" v={preview.p.stopKind === 'MARKET' ? 'market stop' : `stop-limit, ${adv.stopGapPct}% gap`} />
            </div>
            {preview.p.ladder.length > 0 && (
              <div className="rounded-md border border-border p-3">
                <div className="mb-1 text-xs font-medium text-muted uppercase">Stop ladder</div>
                <ol className="space-y-1 text-xs">
                  {preview.p.ladder.map((s) => (
                    <li key={s.atR} className="flex gap-2">
                      <span className="num w-24 shrink-0 text-accent">at +{s.atR}R</span>
                      <span className="num text-muted">({fmtNum(s.triggerPrice)})</span>
                      <span>
                        {s.closePct > 0 && preview.p.partialQty !== null && (
                          <>
                            sell {s.closePct}% ({fmtNum(preview.p.partialQty)} {preview.p.baseAsset}) resting at that price,{' '}
                          </>
                        )}
                        stop → <span className="num">{fmtNum(s.stopPrice)}</span> ({rLabel(s.stopR)})
                      </span>
                    </li>
                  ))}
                  <li className="flex gap-2">
                    <span className="num w-24 shrink-0 text-gain">at +{preview.req.tpR}R</span>
                    <span className="num text-muted">({fmtNum(preview.p.takeProfit)})</span>
                    <span>target fills the rest</span>
                  </li>
                </ol>
              </div>
            )}
            {preview.p.notes.map((n) => (
              <div key={n} className="rounded-md border border-accent/40 bg-accent/10 p-2 text-xs">
                {n}
              </div>
            ))}
            {preview.p.entryType === 'LIMIT' && (
              <div className={cls('rounded-md border p-2 text-xs', preview.p.attachedProtection ? 'border-gain/40 bg-gain/10' : 'border-accent/40 bg-accent/10')}>
                {preview.p.attachedProtection
                  ? 'The target and stop travel with the entry as one order list: Binance places them itself the instant the buy fills, even if this server is off.'
                  : 'This symbol will not take the exits attached to the entry, so the app places them when it sees the fill — within 15 seconds, and only while the server runs.'}
              </div>
            )}
            <p className="text-xs text-muted">The exact entry, R, target and ladder prices are recomputed from the actual fill. The stop stays where you set it.</p>
            {!settings.testnet && <div className="rounded-md border border-loss/40 bg-loss/10 p-2 text-xs text-loss">This will use real funds on your Binance account.</div>}
          </div>
        )}
      </Modal>
    </div>
  )
}

function Row({ k, v, cls: c }: { k: string; v: string; cls?: string }) {
  return (
    <>
      <div className="text-muted">{k}</div>
      <div className={cls('num text-right', c)}>{v}</div>
    </>
  )
}
