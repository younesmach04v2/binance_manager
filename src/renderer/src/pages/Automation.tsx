import type { Bot, BotLogEntry, DcaBot, PriceRuleBot, Side } from '@shared/types'
import { Pause, Play, Plus, Trash2, Zap } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useApp } from '../App'
import { SymbolPicker } from '../components/SymbolPicker'
import { useToast } from '../components/Toast'
import { Badge, Card, EmptyState, Field, Modal, Segmented, Spinner, Toggle } from '../components/ui'
import { api } from '../lib/api'
import { cls, fmtDate, fmtNum, splitSymbol, uid } from '../lib/format'

export default function Automation() {
  const { settings, keys } = useApp()
  const toast = useToast()
  const [bots, setBots] = useState<Bot[]>([])
  const [log, setLog] = useState<BotLogEntry[]>([])
  const [editing, setEditing] = useState<Bot | 'new' | null>(null)
  const [running, setRunning] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [b, l] = await Promise.all([api.bots.list(), api.bots.log()])
      setBots(b)
      setLog(l)
    } catch (e) {
      toast.error('Failed to load bots', (e as Error).message)
    }
  }, [toast])

  useEffect(() => {
    void load()
    const offChanged = api.on('bots:changed', () => void api.bots.list().then(setBots))
    const offLog = api.on('bot:log', (e) => setLog((l) => [e as BotLogEntry, ...l].slice(0, 500)))
    return () => {
      offChanged()
      offLog()
    }
  }, [load])

  const save = async (bot: Bot): Promise<void> => {
    try {
      setBots(await api.bots.save(bot))
      setEditing(null)
    } catch (e) {
      toast.error('Could not save bot', (e as Error).message)
    }
  }

  const toggle = async (b: Bot): Promise<void> => {
    const now = Date.now()
    if (b.type === 'DCA') {
      const next: DcaBot = { ...b, enabled: !b.enabled, nextRunAt: !b.enabled && b.nextRunAt < now ? now : b.nextRunAt }
      await save(next)
    } else {
      const next: PriceRuleBot = { ...b, enabled: !b.enabled, triggered: false, triggeredAt: null, lastError: null }
      await save(next)
    }
  }

  const remove = async (b: Bot): Promise<void> => {
    if (!window.confirm(`Delete bot "${b.name}"?`)) return
    setBots(await api.bots.remove(b.id))
  }

  const runNow = async (b: Bot): Promise<void> => {
    if (!window.confirm(`Run "${b.name}" now?${b.dryRun ? ' (dry run: nothing will be placed)' : ' This places a real order.'}`)) return
    setRunning(b.id)
    try {
      await api.bots.runNow(b.id)
      toast.success('Bot ran', 'See the activity log for the result.')
    } catch (e) {
      toast.error('Run failed', (e as Error).message)
    } finally {
      setRunning(null)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Automation</h1>
          <p className="text-sm text-muted">
            Recurring buys and price-triggered orders, run from this app while it is open.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Toggle
            checked={settings.automationEnabled}
            onChange={(v) => api.settings.set({ automationEnabled: v })}
            label={<span className="text-xs">Master switch</span>}
          />
          <button className="btn btn-primary" onClick={() => setEditing('new')}>
            <Plus className="h-4 w-4" /> New bot
          </button>
        </div>
      </header>

      {!settings.automationEnabled && bots.some((b) => b.enabled) && (
        <div className="rounded-md border border-accent/40 bg-accent/10 px-4 py-2 text-xs">
          Bots are paused: the master switch is off. Turn it on to let enabled bots run.
        </div>
      )}
      {!keys.hasKeys && (
        <div className="rounded-md border border-loss/40 bg-loss/10 px-4 py-2 text-xs text-loss">
          Bots need API keys with spot trading permission. Add them in Settings.
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
        <div className="flex flex-col gap-3">
          {bots.length === 0 ? (
            <Card>
              <EmptyState
                title="No bots yet"
                hint="Create a DCA schedule (buy a fixed amount every N hours) or a price rule (market buy/sell when a price is crossed). Every bot starts in dry-run mode so you can watch what it would do first."
                action={
                  <button className="btn btn-primary" onClick={() => setEditing('new')}>
                    <Plus className="h-4 w-4" /> Create a bot
                  </button>
                }
              />
            </Card>
          ) : (
            bots.map((b) => (
              <BotCard
                key={b.id}
                bot={b}
                master={settings.automationEnabled}
                running={running === b.id}
                onToggle={() => toggle(b)}
                onEdit={() => setEditing(b)}
                onDelete={() => remove(b)}
                onRun={() => runNow(b)}
              />
            ))
          )}
        </div>

        <Card
          title="Activity log"
          className="self-start"
          action={
            log.length > 0 && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={async () => {
                  await api.bots.clearLog()
                  setLog([])
                }}
              >
                Clear
              </button>
            )
          }
        >
          {log.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted">Nothing yet.</div>
          ) : (
            <ul className="max-h-[60vh] space-y-2 overflow-auto text-xs">
              {log.map((e) => (
                <li key={e.id} className="border-b border-border pb-2 last:border-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{e.botName}</span>
                    <span className="num text-muted">{fmtDate(e.time)}</span>
                  </div>
                  <div className={cls('selectable mt-0.5', e.level === 'error' ? 'text-loss' : e.level === 'warn' ? 'text-accent' : 'text-muted')}>
                    {e.message}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {editing && (
        <BotForm
          initial={editing === 'new' ? null : editing}
          defaultSymbol={settings.watchlist[0] ?? 'BTCUSDT'}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      )}
    </div>
  )
}

function BotCard({
  bot,
  master,
  running,
  onToggle,
  onEdit,
  onDelete,
  onRun
}: {
  bot: Bot
  master: boolean
  running: boolean
  onToggle: () => void
  onEdit: () => void
  onDelete: () => void
  onRun: () => void
}) {
  const { quote } = splitSymbol(bot.symbol)
  const status =
    bot.type === 'PRICE_RULE' && bot.triggered ? (
      <Badge tone="info">triggered</Badge>
    ) : bot.enabled && master ? (
      <Badge tone="gain">running</Badge>
    ) : bot.enabled ? (
      <Badge tone="accent">paused (master off)</Badge>
    ) : (
      <Badge>disabled</Badge>
    )

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{bot.name}</span>
            <Badge tone="neutral">{bot.type === 'DCA' ? 'DCA' : 'Price rule'}</Badge>
            <span className="num text-xs text-muted">{bot.symbol}</span>
            {bot.dryRun && <Badge tone="accent">dry run</Badge>}
            {status}
          </div>
          <div className="mt-2 text-sm text-muted">
            {bot.type === 'DCA' ? (
              <>
                Buy <span className="num text-text">{fmtNum(bot.quoteAmount, 2)} {quote}</span> every{' '}
                <span className="num text-text">{bot.intervalHours}h</span>
                {bot.maxRuns !== null && (
                  <>
                    {' '}
                    · <span className="num text-text">{bot.runsCompleted}/{bot.maxRuns}</span> runs
                  </>
                )}
                {bot.maxRuns === null && bot.runsCompleted > 0 && (
                  <>
                    {' '}
                    · <span className="num text-text">{bot.runsCompleted}</span> runs so far
                  </>
                )}
                {bot.enabled && (
                  <>
                    {' '}
                    · next <span className="num text-text">{fmtDate(bot.nextRunAt)}</span>
                  </>
                )}
              </>
            ) : (
              <>
                When price goes <span className="text-text">{bot.condition.toLowerCase()}</span>{' '}
                <span className="num text-text">{fmtNum(bot.triggerPrice)}</span> → market{' '}
                <span className={bot.action.side === 'BUY' ? 'text-gain' : 'text-loss'}>{bot.action.side}</span>{' '}
                <span className="num text-text">
                  {bot.action.quantity !== undefined ? fmtNum(bot.action.quantity) : `${fmtNum(bot.action.quoteOrderQty, 2)} ${quote} of`}
                </span>{' '}
                {bot.symbol}
                {bot.triggeredAt && (
                  <>
                    {' '}
                    · fired <span className="num text-text">{fmtDate(bot.triggeredAt)}</span>
                  </>
                )}
              </>
            )}
          </div>
          {bot.lastError && <div className="selectable mt-1 text-xs text-loss">Last error: {bot.lastError}</div>}
        </div>
        <div className="flex items-center gap-1">
          <button className="btn btn-ghost btn-sm" onClick={onRun} disabled={running} title="Run now">
            {running ? <Spinner /> : <Zap className="h-3.5 w-3.5" />}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onToggle} title={bot.enabled ? 'Disable' : 'Enable'}>
            {bot.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onEdit}>
            Edit
          </button>
          <button className="btn btn-ghost btn-sm text-loss" onClick={onDelete} title="Delete">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </Card>
  )
}

function BotForm({
  initial,
  defaultSymbol,
  onClose,
  onSave
}: {
  initial: Bot | null
  defaultSymbol: string
  onClose: () => void
  onSave: (bot: Bot) => Promise<void>
}) {
  const [type, setType] = useState<Bot['type']>(initial?.type ?? 'DCA')
  const [name, setName] = useState(initial?.name ?? '')
  const [symbol, setSymbol] = useState(initial?.symbol ?? defaultSymbol)
  const [dryRun, setDryRun] = useState(initial?.dryRun ?? true)
  const [amount, setAmount] = useState(initial?.type === 'DCA' ? String(initial.quoteAmount) : '')
  const [interval, setInterval_] = useState(initial?.type === 'DCA' ? String(initial.intervalHours) : '24')
  const [maxRuns, setMaxRuns] = useState(initial?.type === 'DCA' && initial.maxRuns !== null ? String(initial.maxRuns) : '')
  const [startNow, setStartNow] = useState(true)
  const [condition, setCondition] = useState<'ABOVE' | 'BELOW'>(initial?.type === 'PRICE_RULE' ? initial.condition : 'BELOW')
  const [trigger, setTrigger] = useState(initial?.type === 'PRICE_RULE' ? String(initial.triggerPrice) : '')
  const [side, setSide] = useState<Side>(initial?.type === 'PRICE_RULE' ? initial.action.side : 'SELL')
  const [byQuote, setByQuote] = useState(initial?.type === 'PRICE_RULE' ? initial.action.quoteOrderQty !== undefined : false)
  const [actAmount, setActAmount] = useState(
    initial?.type === 'PRICE_RULE' ? String(initial.action.quantity ?? initial.action.quoteOrderQty ?? '') : ''
  )
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const { base, quote } = splitSymbol(symbol)

  const submit = async (): Promise<void> => {
    setErr(null)
    const n = (s: string): number | null => {
      const v = parseFloat(s)
      return Number.isFinite(v) && v > 0 ? v : null
    }
    if (!symbol) return setErr('Pick a symbol')
    const now = Date.now()
    const common = {
      id: initial?.id ?? uid(),
      symbol,
      dryRun,
      createdAt: initial?.createdAt ?? now,
      lastRunAt: initial?.lastRunAt ?? null,
      lastError: null,
      enabled: initial?.enabled ?? true
    }
    let bot: Bot
    if (type === 'DCA') {
      const quoteAmount = n(amount)
      const intervalHours = n(interval)
      if (!quoteAmount) return setErr('Enter the amount to buy each time')
      if (!intervalHours) return setErr('Enter the interval in hours')
      const prev = initial?.type === 'DCA' ? initial : null
      bot = {
        ...common,
        type: 'DCA',
        name: name.trim() || `DCA ${symbol} every ${intervalHours}h`,
        quoteAmount,
        intervalHours,
        maxRuns: maxRuns.trim() ? Math.max(1, parseInt(maxRuns, 10) || 1) : null,
        runsCompleted: prev?.runsCompleted ?? 0,
        nextRunAt: prev ? prev.nextRunAt : startNow ? now : now + intervalHours * 3_600_000
      }
    } else {
      const triggerPrice = n(trigger)
      const amt = n(actAmount)
      if (!triggerPrice) return setErr('Enter the trigger price')
      if (!amt) return setErr('Enter the order amount')
      bot = {
        ...common,
        type: 'PRICE_RULE',
        name: name.trim() || `${side} ${symbol} ${condition.toLowerCase()} ${triggerPrice}`,
        condition,
        triggerPrice,
        action: byQuote ? { side, quoteOrderQty: amt } : { side, quantity: amt },
        triggered: false,
        triggeredAt: null
      }
    }
    setSaving(true)
    await onSave(bot)
    setSaving(false)
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={initial ? `Edit ${initial.name}` : 'New bot'}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={saving}>
            {saving && <Spinner />} {initial ? 'Save' : 'Create'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {!initial && (
          <Segmented
            value={type}
            onChange={setType}
            options={[
              { value: 'DCA', label: 'Recurring buy (DCA)' },
              { value: 'PRICE_RULE', label: 'Price rule' }
            ]}
          />
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" hint="optional">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Symbol">
            <SymbolPicker value={symbol} onChange={setSymbol} />
          </Field>
        </div>

        {type === 'DCA' ? (
          <>
            <div className="grid grid-cols-3 gap-3">
              <Field label={`Amount (${quote || 'quote'})`}>
                <input className="input num" type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} />
              </Field>
              <Field label="Every (hours)">
                <input className="input num" type="number" min={0.1} step={1} value={interval} onChange={(e) => setInterval_(e.target.value)} />
              </Field>
              <Field label="Max runs" hint="blank = forever">
                <input className="input num" type="number" min={1} value={maxRuns} onChange={(e) => setMaxRuns(e.target.value)} />
              </Field>
            </div>
            {!initial && <Toggle checked={startNow} onChange={setStartNow} label={<span className="text-xs">Make the first buy right away</span>} />}
          </>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="When price goes">
                <select className="input" value={condition} onChange={(e) => setCondition(e.target.value as 'ABOVE' | 'BELOW')}>
                  <option value="BELOW">below</option>
                  <option value="ABOVE">above</option>
                </select>
              </Field>
              <Field label={`Trigger price (${quote || 'quote'})`}>
                <input className="input num" type="number" min={0} value={trigger} onChange={(e) => setTrigger(e.target.value)} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Then market">
                <Segmented
                  value={side}
                  onChange={setSide}
                  options={[
                    { value: 'BUY', label: 'Buy', tone: 'gain' },
                    { value: 'SELL', label: 'Sell', tone: 'loss' }
                  ]}
                />
              </Field>
              <Field label={byQuote ? `Amount (${quote || 'quote'})` : `Quantity (${base || 'base'})`}>
                <input className="input num" type="number" min={0} value={actAmount} onChange={(e) => setActAmount(e.target.value)} />
              </Field>
            </div>
            <Toggle checked={byQuote} onChange={setByQuote} label={<span className="text-xs">Specify amount in {quote || 'quote'} instead of quantity</span>} />
            <p className="text-[11px] text-muted">
              Checked every 15 seconds. Fires once, then disables itself. A SELL below the current price acts as a
              stop-loss; a BUY above acts as a breakout entry. For protection that also works while the app is closed,
              use an OCO or stop-limit order from the Trade page instead.
            </p>
          </>
        )}

        <div className="rounded-md border border-border p-3">
          <Toggle checked={dryRun} onChange={setDryRun} label={<span className="text-sm">Dry run: log what would happen, place nothing</span>} />
          {!dryRun && (
            <p className="mt-1 text-xs text-loss">This bot will place real market orders on the active environment.</p>
          )}
        </div>

        {err && <div className="text-xs text-loss">{err}</div>}
      </div>
    </Modal>
  )
}
