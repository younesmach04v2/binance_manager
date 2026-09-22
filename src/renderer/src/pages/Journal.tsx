import type { TradeWithJournal } from '@shared/types'
import { Pencil, RefreshCw, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useApp } from '../App'
import { SymbolPicker } from '../components/SymbolPicker'
import { useToast } from '../components/Toast'
import { Badge, Card, EmptyState, Field, Modal, Spinner } from '../components/ui'
import { api } from '../lib/api'
import { cls, fmtDate, fmtNum } from '../lib/format'

const PAGE = 100

export default function Journal() {
  const { settings, keys } = useApp()
  const toast = useToast()
  const [trades, setTrades] = useState<TradeWithJournal[]>([])
  const [tags, setTags] = useState<string[]>([])
  const [syncing, setSyncing] = useState(false)
  const [filter, setFilter] = useState({ symbol: '', side: 'ALL' as 'ALL' | 'BUY' | 'SELL', tag: '', q: '' })
  const [limit, setLimit] = useState(PAGE)
  const [editing, setEditing] = useState<TradeWithJournal | null>(null)
  const [addSymbol, setAddSymbol] = useState('')

  const load = useCallback(async () => {
    try {
      const [t, tg] = await Promise.all([api.trades.list(), api.journal.tags()])
      setTrades(t)
      setTags(tg)
    } catch (e) {
      toast.error('Failed to load trades', (e as Error).message)
    }
  }, [toast])

  useEffect(() => void load(), [load])

  const sync = async (symbols?: string[]): Promise<void> => {
    if (!keys.hasKeys) {
      toast.warn('Add API keys in Settings first')
      return
    }
    setSyncing(true)
    try {
      const r = await api.trades.sync(symbols)
      toast.success(
        `Synced ${r.symbols.length} symbol${r.symbols.length === 1 ? '' : 's'}`,
        `${r.newTrades} new trades · ${r.totalTrades} total`
      )
      if (r.errors.length) {
        toast.warn(
          `${r.errors.length} symbol${r.errors.length === 1 ? '' : 's'} failed`,
          r.errors.slice(0, 3).map((e) => `${e.symbol}: ${e.message}`).join(' · ')
        )
      }
      await load()
    } catch (e) {
      toast.error('Sync failed', (e as Error).message)
    } finally {
      setSyncing(false)
    }
  }

  const track = async (): Promise<void> => {
    const s = addSymbol.trim().toUpperCase()
    if (!s) return
    if (!settings.trackedSymbols.includes(s)) {
      await api.settings.set({ trackedSymbols: [...settings.trackedSymbols, s] })
    }
    setAddSymbol('')
    await sync([s])
  }

  const symbols = useMemo(() => [...new Set(trades.map((t) => t.symbol))].sort(), [trades])

  const filtered = useMemo(() => {
    const q = filter.q.trim().toLowerCase()
    return trades.filter(
      (t) =>
        (!filter.symbol || t.symbol === filter.symbol) &&
        (filter.side === 'ALL' || (filter.side === 'BUY') === t.isBuyer) &&
        (!filter.tag || t.journal?.tags.includes(filter.tag)) &&
        (!q || (t.journal?.note ?? '').toLowerCase().includes(q) || t.symbol.toLowerCase().includes(q))
    )
  }, [trades, filter])

  const volume = filtered.reduce((s, t) => s + t.quoteQty, 0)
  const shown = filtered.slice(0, limit)

  const saveJournal = async (tradeId: number, patch: { tags: string[]; note: string }): Promise<void> => {
    try {
      const entry = await api.journal.update(tradeId, patch)
      setTrades((ts) => ts.map((t) => (t.id === tradeId ? { ...t, journal: entry } : t)))
      setTags((tg) => [...new Set([...tg, ...entry.tags])].sort())
      setEditing(null)
      toast.success('Journal entry saved')
    } catch (e) {
      toast.error('Could not save', (e as Error).message)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Trade journal</h1>
          <p className="text-sm text-muted">
            Your fills from Binance, with your own tags and notes. {trades.length.toLocaleString()} trades across{' '}
            {symbols.length} symbols.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SymbolPicker value={addSymbol} onChange={setAddSymbol} placeholder="Track another symbol…" className="w-56" />
          <button className="btn btn-ghost" onClick={track} disabled={!addSymbol || syncing}>
            Add
          </button>
          <button className="btn btn-primary" onClick={() => sync()} disabled={syncing}>
            {syncing ? <Spinner /> : <RefreshCw className="h-4 w-4" />} Sync from Binance
          </button>
        </div>
      </header>

      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute top-2.5 left-2.5 h-3.5 w-3.5 text-muted" />
            <input
              className="input w-56 pl-8"
              placeholder="Search notes or symbol"
              value={filter.q}
              onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))}
            />
          </div>
          <select className="input w-40" value={filter.symbol} onChange={(e) => setFilter((f) => ({ ...f, symbol: e.target.value }))}>
            <option value="">All symbols</option>
            {symbols.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <select
            className="input w-32"
            value={filter.side}
            onChange={(e) => setFilter((f) => ({ ...f, side: e.target.value as typeof f.side }))}
          >
            <option value="ALL">Buy & sell</option>
            <option value="BUY">Buys</option>
            <option value="SELL">Sells</option>
          </select>
          <select className="input w-40" value={filter.tag} onChange={(e) => setFilter((f) => ({ ...f, tag: e.target.value }))}>
            <option value="">All tags</option>
            {tags.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <div className="ml-auto text-xs text-muted">
            {filtered.length.toLocaleString()} trades · volume <span className="num text-text">{fmtNum(volume, 2)}</span>
          </div>
        </div>
      </Card>

      <Card className="p-0">
        {trades.length === 0 ? (
          <EmptyState
            title="No trades synced yet"
            hint="Sync pulls your fill history for every asset you hold (against USDT, USDC, FDUSD, BTC, ETH and BNB) plus any symbol you add above. The first sync can take a minute."
            action={
              <button className="btn btn-primary" onClick={() => sync()} disabled={syncing}>
                {syncing ? <Spinner /> : <RefreshCw className="h-4 w-4" />} Sync now
              </button>
            }
          />
        ) : (
          <div className="max-h-[65vh] overflow-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Symbol</th>
                  <th>Side</th>
                  <th className="text-right">Price</th>
                  <th className="text-right">Quantity</th>
                  <th className="text-right">Total</th>
                  <th className="text-right">Fee</th>
                  <th>Tags</th>
                  <th>Note</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((t) => (
                  <tr key={`${t.symbol}-${t.id}`} className="cursor-pointer" onClick={() => setEditing(t)}>
                    <td className="text-xs whitespace-nowrap text-muted">{fmtDate(t.time)}</td>
                    <td className="num">{t.symbol}</td>
                    <td>
                      <Badge tone={t.isBuyer ? 'gain' : 'loss'}>{t.isBuyer ? 'BUY' : 'SELL'}</Badge>
                      {t.isMaker && <span className="ml-1 text-[10px] text-muted">maker</span>}
                    </td>
                    <td className="num text-right">{fmtNum(t.price)}</td>
                    <td className="num text-right">
                      {fmtNum(t.qty)} <span className="text-xs text-muted">{t.baseAsset}</span>
                    </td>
                    <td className="num text-right">
                      {fmtNum(t.quoteQty, 2)} <span className="text-xs text-muted">{t.quoteAsset}</span>
                    </td>
                    <td className="num text-right text-xs text-muted">
                      {fmtNum(t.commission)} {t.commissionAsset}
                    </td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {t.journal?.tags.map((tag) => (
                          <span key={tag} className="tag">
                            {tag}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="max-w-[240px] truncate text-xs text-muted" title={t.journal?.note}>
                      {t.journal?.note}
                    </td>
                    <td>
                      <Pencil className="h-3.5 w-3.5 text-muted" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length > limit && (
              <div className="flex justify-center border-t border-border p-3">
                <button className="btn btn-ghost btn-sm" onClick={() => setLimit((l) => l + PAGE)}>
                  Show {Math.min(PAGE, filtered.length - limit)} more
                </button>
              </div>
            )}
          </div>
        )}
      </Card>

      {editing && <EditModal trade={editing} allTags={tags} onClose={() => setEditing(null)} onSave={saveJournal} />}
    </div>
  )
}

function EditModal({
  trade,
  allTags,
  onClose,
  onSave
}: {
  trade: TradeWithJournal
  allTags: string[]
  onClose: () => void
  onSave: (id: number, patch: { tags: string[]; note: string }) => Promise<void>
}) {
  const [tags, setTags] = useState<string[]>(trade.journal?.tags ?? [])
  const [tagInput, setTagInput] = useState('')
  const [note, setNote] = useState(trade.journal?.note ?? '')
  const [saving, setSaving] = useState(false)

  const addTag = (raw: string): void => {
    const t = raw.trim().toLowerCase()
    if (t && !tags.includes(t)) setTags((ts) => [...ts, t])
    setTagInput('')
  }

  const suggestions = allTags.filter((t) => !tags.includes(t) && (!tagInput || t.includes(tagInput.toLowerCase()))).slice(0, 8)

  return (
    <Modal
      open
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <Badge tone={trade.isBuyer ? 'gain' : 'loss'}>{trade.isBuyer ? 'BUY' : 'SELL'}</Badge>
          <span className="num">{trade.symbol}</span>
          <span className="text-xs text-muted">{fmtDate(trade.time)}</span>
        </span>
      }
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={saving}
            onClick={async () => {
              setSaving(true)
              await onSave(trade.id, { tags: tagInput ? [...tags, tagInput.trim().toLowerCase()] : tags, note })
              setSaving(false)
            }}
          >
            {saving && <Spinner />} Save
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-3 gap-2 rounded-md bg-panel-2 p-3 text-xs">
          <div>
            <div className="text-muted">Price</div>
            <div className="num">{fmtNum(trade.price)}</div>
          </div>
          <div>
            <div className="text-muted">Quantity</div>
            <div className="num">
              {fmtNum(trade.qty)} {trade.baseAsset}
            </div>
          </div>
          <div>
            <div className="text-muted">Total</div>
            <div className="num">
              {fmtNum(trade.quoteQty, 2)} {trade.quoteAsset}
            </div>
          </div>
        </div>

        <Field label="Tags" hint="Press Enter or comma to add. Tags group trades in Analytics (e.g. breakout, dca, mistake).">
          <div className="input flex flex-wrap items-center gap-1 py-1">
            {tags.map((t) => (
              <span key={t} className="tag gap-1 text-text">
                {t}
                <button className="text-muted hover:text-loss" onClick={() => setTags((ts) => ts.filter((x) => x !== t))}>
                  ×
                </button>
              </span>
            ))}
            <input
              className="min-w-[8ch] flex-1 bg-transparent py-1 text-sm outline-none"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ',') {
                  e.preventDefault()
                  addTag(tagInput)
                } else if (e.key === 'Backspace' && !tagInput && tags.length) {
                  setTags((ts) => ts.slice(0, -1))
                }
              }}
              placeholder={tags.length ? '' : 'add a tag'}
            />
          </div>
        </Field>
        {suggestions.length > 0 && (
          <div className="-mt-2 flex flex-wrap gap-1">
            {suggestions.map((s) => (
              <button key={s} className={cls('tag hover:text-text')} onClick={() => addTag(s)}>
                + {s}
              </button>
            ))}
          </div>
        )}

        <Field label="Note">
          <textarea
            className="input min-h-[120px] resize-y"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why did you take this trade? What was the plan, and what actually happened?"
          />
        </Field>
      </div>
    </Modal>
  )
}
