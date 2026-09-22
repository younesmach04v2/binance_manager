import type { Order, OrderRequest, Side, SymbolInfo, Ticker24h } from '@shared/types'
import { RefreshCw, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useApp } from '../App'
import { SymbolPicker } from '../components/SymbolPicker'
import { useToast } from '../components/Toast'
import { Badge, Card, EmptyState, Field, Modal, Segmented, Spinner, Toggle } from '../components/ui'
import { api } from '../lib/api'
import { cls, fmtDate, fmtNum, fmtPct, splitSymbol } from '../lib/format'
import { useLivePrices } from '../lib/usePrices'

type FormType = 'MARKET' | 'LIMIT' | 'STOP_LOSS_LIMIT' | 'OCO'

const TYPE_HELP: Record<FormType, string> = {
  MARKET: 'Fills immediately at the best available price.',
  LIMIT: 'Rests on the book until your price is reached.',
  STOP_LOSS_LIMIT: 'When the stop price is hit, a limit order is placed. Used for stop-losses (SELL) or breakout entries (BUY).',
  OCO: 'One-cancels-the-other: a take-profit limit and a stop-loss placed together on an existing holding. Whichever fills cancels the other.'
}

const num = (s: string): number | undefined => {
  const n = parseFloat(s)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export default function Trade() {
  const { settings, keys, go } = useApp()
  const toast = useToast()
  const [symbol, setSymbol] = useState(settings.watchlist[0] ?? 'BTCUSDT')
  const [info, setInfo] = useState<SymbolInfo | null>(null)
  const [ticker, setTicker] = useState<Ticker24h | null>(null)
  const [side, setSide] = useState<Side>('BUY')
  const [type, setType] = useState<FormType>('MARKET')
  const [byQuote, setByQuote] = useState(true)
  const [f, setF] = useState({ qty: '', quoteAmt: '', price: '', stop: '', limit: '', tp: '' })
  const [balances, setBalances] = useState<Record<string, { free: number; locked: number }>>({})
  const [openOrders, setOpenOrders] = useState<Order[]>([])
  const [history, setHistory] = useState<Order[]>([])
  const [confirm, setConfirm] = useState<OrderRequest | null>(null)
  const [busy, setBusy] = useState(false)
  const [loadingAcct, setLoadingAcct] = useState(false)

  const { prices, changes } = useLivePrices([symbol])
  const last = prices[symbol] ?? ticker?.lastPrice ?? null
  const change = changes[symbol] ?? ticker?.priceChangePercent ?? null

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF((s) => ({ ...s, [k]: e.target.value }))

  const loadSymbol = useCallback(async () => {
    try {
      const [i, t] = await Promise.all([api.market.symbol(symbol), api.market.ticker24h([symbol])])
      setInfo(i)
      setTicker(t[0] ?? null)
      if (!i) toast.warn(`Unknown symbol ${symbol}`)
    } catch (e) {
      toast.error('Failed to load symbol', (e as Error).message)
    }
  }, [symbol, toast])

  const loadAccount = useCallback(async () => {
    if (!keys.hasKeys) return
    setLoadingAcct(true)
    try {
      const [b, oo] = await Promise.all([api.account.balances(), api.orders.open()])
      setBalances(b)
      setOpenOrders(oo)
    } catch (e) {
      toast.error('Failed to load account', (e as Error).message)
    } finally {
      setLoadingAcct(false)
    }
  }, [keys.hasKeys, toast])

  useEffect(() => void loadSymbol(), [loadSymbol])
  useEffect(() => void loadAccount(), [loadAccount])
  useEffect(() => {
    if (!keys.hasKeys) return
    api.orders
      .history(symbol)
      .then((h) => setHistory([...h].reverse().slice(0, 15)))
      .catch(() => setHistory([]))
  }, [symbol, keys.hasKeys, openOrders.length])

  const base = info?.baseAsset ?? splitSymbol(symbol).base
  const quote = info?.quoteAsset ?? splitSymbol(symbol).quote
  const avail = (side === 'BUY' ? balances[quote]?.free : balances[base]?.free) ?? 0
  const qPrec = info?.filters.quantityPrecision ?? 6
  const pPrec = info?.filters.pricePrecision ?? 2
  const floorTo = (n: number, prec: number): string => (Math.floor(n * 10 ** prec) / 10 ** prec).toFixed(prec)

  const refPrice = (): number | null => (type === 'MARKET' ? last : (num(f.price) ?? last))

  const applyPct = (pct: number): void => {
    if (side === 'BUY') {
      if (type === 'MARKET' && byQuote) {
        setF((s) => ({ ...s, quoteAmt: floorTo(avail * pct, 2) }))
      } else {
        const p = refPrice()
        if (p) setF((s) => ({ ...s, qty: floorTo((avail * pct) / p, qPrec) }))
      }
    } else {
      setF((s) => ({ ...s, qty: floorTo(avail * pct, qPrec) }))
    }
  }

  const build = (): OrderRequest | string => {
    const qty = num(f.qty)
    const quoteAmt = num(f.quoteAmt)
    const price = num(f.price)
    const stop = num(f.stop)
    const limit = num(f.limit)
    const tp = num(f.tp)
    switch (type) {
      case 'MARKET':
        if (byQuote) return quoteAmt ? { symbol, side, type, quoteOrderQty: quoteAmt } : 'Enter an amount to spend'
        return qty ? { symbol, side, type, quantity: qty } : 'Enter a quantity'
      case 'LIMIT':
        if (!qty) return 'Enter a quantity'
        if (!price) return 'Enter a limit price'
        return { symbol, side, type, quantity: qty, price }
      case 'STOP_LOSS_LIMIT':
        if (!qty) return 'Enter a quantity'
        if (!stop) return 'Enter a stop (trigger) price'
        return { symbol, side, type, quantity: qty, stopPrice: stop, price: limit }
      case 'OCO':
        if (!qty) return 'Enter a quantity'
        if (!tp) return 'Enter a take-profit price'
        if (!stop) return 'Enter a stop price'
        return { symbol, side, type: 'OCO', quantity: qty, takeProfitPrice: tp, stopPrice: stop, price: limit }
    }
  }

  const estTotal = (): number | null => {
    if (type === 'MARKET' && byQuote) return num(f.quoteAmt) ?? null
    const qty = num(f.qty)
    const p = type === 'MARKET' ? last : type === 'LIMIT' ? (num(f.price) ?? last) : (num(f.stop) ?? last)
    return qty && p ? qty * p : null
  }

  const submit = async (test: boolean): Promise<void> => {
    if (!keys.hasKeys) {
      toast.warn('Add API keys with trading permission first')
      return
    }
    const req = build()
    if (typeof req === 'string') {
      toast.warn(req)
      return
    }
    if (!test) {
      setConfirm(req)
      return
    }
    setBusy(true)
    try {
      await api.orders.place({ ...req, test: true })
      toast.success('Order is valid', 'Binance accepted the parameters without placing anything.')
    } catch (e) {
      toast.error('Order rejected', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const place = async (): Promise<void> => {
    if (!confirm) return
    setBusy(true)
    try {
      const res = await api.orders.place(confirm)
      const o = res.orders[0]
      toast.success(
        `${confirm.side} ${confirm.symbol} placed`,
        o ? `${o.type} · ${o.status}${o.executedQty ? ` · filled ${fmtNum(o.executedQty)}` : ''} · #${o.orderId}` : undefined
      )
      setConfirm(null)
      setF((s) => ({ ...s, qty: '', quoteAmt: '' }))
      await loadAccount()
    } catch (e) {
      toast.error('Order failed', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const cancel = async (o: Order): Promise<void> => {
    try {
      await api.orders.cancel(o.symbol, o.orderId, o.orderListId >= 0 ? o.orderListId : undefined)
      toast.success(`Cancelled ${o.side} ${o.symbol} #${o.orderId}`)
      await loadAccount()
    } catch (e) {
      toast.error('Cancel failed', (e as Error).message)
    }
  }

  const total = estTotal()
  const minNotional = info?.filters.minNotional ?? 0

  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Trade</h1>
          <p className="text-sm text-muted">Spot orders on {settings.testnet ? 'the Binance testnet' : 'Binance live'}.</p>
        </div>
        {settings.testnet ? <Badge tone="accent">TESTNET · fake funds</Badge> : <Badge tone="loss">LIVE · real funds</Badge>}
      </header>

      <div className="grid gap-5 xl:grid-cols-[400px_1fr]">
        {/* ---------------- order form ---------------- */}
        <Card className="self-start">
          <div className="flex flex-col gap-4">
            <SymbolPicker value={symbol} onChange={setSymbol} />

            <div className="flex items-baseline justify-between rounded-md bg-panel-2 px-3 py-2">
              <span className="text-xs text-muted">Last price</span>
              <span className="num text-lg font-semibold">
                {last !== null ? fmtNum(last, pPrec) : '—'}{' '}
                <span className={cls('text-xs', change !== null && change >= 0 ? 'text-gain' : 'text-loss')}>
                  {fmtPct(change)}
                </span>
              </span>
            </div>

            <div className="flex items-center justify-between gap-2">
              <Segmented
                value={side}
                onChange={setSide}
                options={[
                  { value: 'BUY', label: 'Buy', tone: 'gain' },
                  { value: 'SELL', label: 'Sell', tone: 'loss' }
                ]}
              />
              <Segmented
                value={type}
                onChange={(t) => {
                  setType(t)
                  if (t === 'OCO') setSide('SELL')
                }}
                options={[
                  { value: 'MARKET', label: 'Market' },
                  { value: 'LIMIT', label: 'Limit' },
                  { value: 'STOP_LOSS_LIMIT', label: 'Stop' },
                  { value: 'OCO', label: 'OCO' }
                ]}
              />
            </div>
            <p className="text-[11px] text-muted">{TYPE_HELP[type]}</p>

            {type === 'MARKET' && (
              <Toggle
                checked={byQuote}
                onChange={setByQuote}
                label={<span className="text-xs">Enter amount in {quote || 'quote'} instead of quantity</span>}
              />
            )}

            {type === 'MARKET' && byQuote ? (
              <Field label={`Amount (${quote})`}>
                <input className="input num" type="number" min={0} value={f.quoteAmt} onChange={set('quoteAmt')} />
              </Field>
            ) : (
              <Field label={`Quantity (${base})`} hint={info ? `step ${info.filters.stepSize}, min ${info.filters.minQty}` : undefined}>
                <input className="input num" type="number" min={0} value={f.qty} onChange={set('qty')} />
              </Field>
            )}

            {type === 'LIMIT' && (
              <Field label={`Limit price (${quote})`}>
                <input className="input num" type="number" min={0} value={f.price} onChange={set('price')} />
              </Field>
            )}

            {type === 'STOP_LOSS_LIMIT' && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Stop (trigger) price">
                  <input className="input num" type="number" min={0} value={f.stop} onChange={set('stop')} />
                </Field>
                <Field label="Limit price" hint="blank = 0.5% past the stop">
                  <input className="input num" type="number" min={0} value={f.limit} onChange={set('limit')} />
                </Field>
              </div>
            )}

            {type === 'OCO' && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Take-profit price">
                  <input className="input num" type="number" min={0} value={f.tp} onChange={set('tp')} />
                </Field>
                <Field label="Stop price">
                  <input className="input num" type="number" min={0} value={f.stop} onChange={set('stop')} />
                </Field>
                <Field label="Stop limit price" hint="blank = 0.5% past the stop" className="col-span-2">
                  <input className="input num" type="number" min={0} value={f.limit} onChange={set('limit')} />
                </Field>
              </div>
            )}

            <div className="flex items-center justify-between text-xs">
              <span className="text-muted">
                Available: <span className="num text-text">{fmtNum(avail)}</span> {side === 'BUY' ? quote : base}
              </span>
              <div className="flex gap-1">
                {[0.25, 0.5, 0.75, 1].map((p) => (
                  <button key={p} className="btn btn-ghost btn-sm num" onClick={() => applyPct(p)}>
                    {p * 100}%
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-xs">
              <span className="text-muted">Estimated total</span>
              <span className={cls('num', total !== null && total < minNotional ? 'text-loss' : 'text-text')}>
                {total !== null ? `${fmtNum(total, 2)} ${quote}` : '—'}
                {minNotional > 0 && <span className="text-muted"> · min {minNotional}</span>}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button className="btn btn-ghost" disabled={busy || type === 'OCO'} onClick={() => submit(true)}>
                {busy && <Spinner />} Test order
              </button>
              <button
                className={cls('btn', side === 'BUY' ? 'btn-gain' : 'btn-danger')}
                disabled={busy || !info}
                onClick={() => submit(false)}
              >
                {side === 'BUY' ? 'Buy' : 'Sell'} {base}
              </button>
            </div>
            {!keys.hasKeys && (
              <button className="text-xs text-accent hover:underline" onClick={() => go('settings')}>
                Add API keys to trade →
              </button>
            )}
          </div>
        </Card>

        {/* ---------------- right column ---------------- */}
        <div className="flex min-w-0 flex-col gap-5">
          <Card title={`${symbol} · 24h`}>
            {ticker ? (
              <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-5">
                <Stat label="Change" value={fmtPct(ticker.priceChangePercent)} cls={ticker.priceChangePercent >= 0 ? 'text-gain' : 'text-loss'} />
                <Stat label="High" value={fmtNum(ticker.highPrice, pPrec)} />
                <Stat label="Low" value={fmtNum(ticker.lowPrice, pPrec)} />
                <Stat label={`Volume (${base})`} value={fmtNum(ticker.volume, 2)} />
                <Stat label={`Volume (${quote})`} value={fmtNum(ticker.quoteVolume, 0)} />
              </div>
            ) : (
              <div className="text-xs text-muted">Loading…</div>
            )}
          </Card>

          <Card
            title={`Open orders (${openOrders.length})`}
            action={
              <button className="btn btn-ghost btn-sm" onClick={loadAccount} disabled={loadingAcct}>
                <RefreshCw className={cls('h-3.5 w-3.5', loadingAcct && 'animate-spin')} /> Refresh
              </button>
            }
          >
            {openOrders.length === 0 ? (
              <EmptyState title="No open orders" hint={keys.hasKeys ? undefined : 'Connect API keys to see your orders.'} />
            ) : (
              <div className="max-h-80 overflow-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Symbol</th>
                      <th>Side</th>
                      <th>Type</th>
                      <th className="text-right">Price</th>
                      <th className="text-right">Stop</th>
                      <th className="text-right">Qty</th>
                      <th className="text-right">Filled</th>
                      <th>Placed</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {openOrders.map((o) => (
                      <tr key={o.orderId}>
                        <td className="num">{o.symbol}</td>
                        <td>
                          <Badge tone={o.side === 'BUY' ? 'gain' : 'loss'}>{o.side}</Badge>
                        </td>
                        <td className="text-xs text-muted">
                          {o.type}
                          {o.orderListId >= 0 && ' · OCO'}
                        </td>
                        <td className="num text-right">{o.price ? fmtNum(o.price) : 'market'}</td>
                        <td className="num text-right">{o.stopPrice ? fmtNum(o.stopPrice) : '—'}</td>
                        <td className="num text-right">{fmtNum(o.origQty)}</td>
                        <td className="num text-right">{fmtNum(o.executedQty)}</td>
                        <td className="text-xs text-muted">{fmtDate(o.time)}</td>
                        <td className="text-right">
                          <button className="btn btn-ghost btn-sm text-loss" onClick={() => cancel(o)} title="Cancel order">
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title={`Recent orders · ${symbol}`}>
            {history.length === 0 ? (
              <EmptyState title="No order history for this symbol" />
            ) : (
              <div className="max-h-72 overflow-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Side</th>
                      <th>Type</th>
                      <th>Status</th>
                      <th className="text-right">Price</th>
                      <th className="text-right">Qty</th>
                      <th className="text-right">Filled</th>
                      <th className="text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((o) => (
                      <tr key={o.orderId}>
                        <td className="text-xs text-muted">{fmtDate(o.updateTime)}</td>
                        <td className={o.side === 'BUY' ? 'text-gain' : 'text-loss'}>{o.side}</td>
                        <td className="text-xs">{o.type}</td>
                        <td className="text-xs">
                          <Badge tone={o.status === 'FILLED' ? 'gain' : o.status === 'CANCELED' ? 'neutral' : 'info'}>{o.status}</Badge>
                        </td>
                        <td className="num text-right">
                          {o.executedQty > 0 ? fmtNum(o.cummulativeQuoteQty / o.executedQty) : o.price ? fmtNum(o.price) : '—'}
                        </td>
                        <td className="num text-right">{fmtNum(o.origQty)}</td>
                        <td className="num text-right">{fmtNum(o.executedQty)}</td>
                        <td className="num text-right">{fmtNum(o.cummulativeQuoteQty, 2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      </div>

      <Modal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={
          <span className="flex items-center gap-2">
            Confirm {confirm?.side} order {settings.testnet ? <Badge tone="accent">TESTNET</Badge> : <Badge tone="loss">LIVE</Badge>}
          </span>
        }
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setConfirm(null)} disabled={busy}>
              Cancel
            </button>
            <button className={cls('btn', confirm?.side === 'BUY' ? 'btn-gain' : 'btn-danger')} onClick={place} disabled={busy}>
              {busy && <Spinner />} Confirm {confirm?.side}
            </button>
          </>
        }
      >
        {confirm && (
          <div className="grid grid-cols-2 gap-y-2 text-sm">
            <Row k="Symbol" v={confirm.symbol} />
            <Row k="Type" v={confirm.type} />
            {confirm.quantity !== undefined && <Row k="Quantity" v={`${fmtNum(confirm.quantity)} ${base}`} />}
            {confirm.quoteOrderQty !== undefined && <Row k="Spend" v={`${fmtNum(confirm.quoteOrderQty, 2)} ${quote}`} />}
            {confirm.price !== undefined && <Row k={confirm.type === 'LIMIT' ? 'Limit price' : 'Stop limit price'} v={fmtNum(confirm.price)} />}
            {confirm.stopPrice !== undefined && <Row k="Stop price" v={fmtNum(confirm.stopPrice)} />}
            {confirm.takeProfitPrice !== undefined && <Row k="Take-profit" v={fmtNum(confirm.takeProfitPrice)} />}
            {total !== null && <Row k="Estimated total" v={`${fmtNum(total, 2)} ${quote}`} />}
            {!settings.testnet && (
              <div className="col-span-2 mt-2 rounded-md border border-loss/40 bg-loss/10 p-2 text-xs text-loss">
                This will use real funds on your Binance account.
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}

function Stat({ label, value, cls: c }: { label: string; value: string; cls?: string }) {
  return (
    <div>
      <div className="text-muted">{label}</div>
      <div className={cls('num text-sm', c)}>{value}</div>
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <div className="text-muted">{k}</div>
      <div className="num text-right">{v}</div>
    </>
  )
}
