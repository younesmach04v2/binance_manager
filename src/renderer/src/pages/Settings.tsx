import type { AccountSummary, AppInfo, DiscoveredServer, RemoteConfig, RemoteMode, RemoteTestResult, Settings } from '@shared/types'
import { Copy, ExternalLink, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useApp } from '../App'
import { SymbolPicker } from '../components/SymbolPicker'
import { useToast } from '../components/Toast'
import { Badge, Card, Field, Segmented, Spinner, Toggle } from '../components/ui'
import { api } from '../lib/api'
import { cls, fmtDate } from '../lib/format'

const QUOTES = ['USDT', 'USDC', 'FDUSD', 'BTC']

export default function SettingsPage() {
  const { settings, keys, remote, reload } = useApp()
  const toast = useToast()
  const [apiKey, setApiKey] = useState('')
  const [secret, setSecret] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [summary, setSummary] = useState<AccountSummary | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [wl, setWl] = useState('')
  const isClient = remote?.mode === 'client'

  useEffect(() => {
    api.app
      .info()
      .then(setInfo)
      .catch(() => setInfo(null))
  }, [])

  const update = async (patch: Partial<Settings>, msg = 'Settings saved'): Promise<void> => {
    try {
      await api.settings.set(patch)
      toast.success(msg)
    } catch (e) {
      toast.error('Could not save settings', (e as Error).message)
    }
  }

  const saveKeys = async (): Promise<void> => {
    setSaving(true)
    try {
      await api.keys.save(apiKey, secret)
      setApiKey('')
      setSecret('')
      setSummary(null)
      await reload()
      toast.success('API keys saved', isClient ? 'Stored encrypted on the server.' : 'Stored encrypted with Windows DPAPI on this machine.')
    } catch (e) {
      toast.error('Could not save keys', (e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const testKeys = async (): Promise<void> => {
    setTesting(true)
    try {
      const s = await api.keys.test()
      setSummary(s)
      toast.success('Connected to Binance', `${s.accountType} account, ${s.balances} assets with balance`)
    } catch (e) {
      setSummary(null)
      toast.error('Connection failed', (e as Error).message)
    } finally {
      setTesting(false)
    }
  }

  const clearKeys = async (): Promise<void> => {
    if (!window.confirm(`Remove the stored API keys from ${isClient ? 'the server' : 'this machine'}?`)) return
    await api.keys.clear()
    setSummary(null)
    await reload()
    toast.info('API keys removed')
  }

  const clearTrades = async (): Promise<void> => {
    if (!window.confirm('Delete all synced trade history for this environment? Journal notes are kept.')) return
    await api.trades.clear()
    toast.info('Trade history cleared', 'Run a sync in the Journal to download it again.')
  }

  const addWatch = async (): Promise<void> => {
    const s = wl.trim().toUpperCase()
    if (!s || settings.watchlist.includes(s)) return
    await update({ watchlist: [...settings.watchlist, s] }, `${s} added to watchlist`)
    setWl('')
  }

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-muted">
          API access, environment, portfolio display, remote access and data.
          {isClient && ' You are connected to a server: everything except "Remote access" applies to the server.'}
        </p>
      </header>

      <div className="grid gap-5 lg:grid-cols-2">
        <RemoteCard />

        <Card
          title={isClient ? 'Binance API keys (on the server)' : 'Binance API keys'}
          action={keys.hasKeys ? <Badge tone="gain">configured · {keys.apiKeyPreview}</Badge> : <Badge tone="loss">not configured</Badge>}
        >
          <div className="flex flex-col gap-3">
            <p className="text-xs text-muted">
              Create keys at Binance → Profile → API Management. Enable <b>Enable Reading</b>, and <b>Enable Spot &amp; Margin Trading</b> only if
              you want to place orders from this app. Never enable withdrawals. Restricting the key to the server's IP address is strongly
              recommended.{' '}
              <button className="inline-flex items-center gap-1 text-accent hover:underline" onClick={() => api.app.openExternal('https://www.binance.com/en/my/settings/api-management')}>
                Open API Management <ExternalLink className="h-3 w-3" />
              </button>
            </p>
            {isClient && (
              <div className="rounded-md border border-accent/40 bg-accent/10 p-2 text-xs">
                Keys typed here travel over your network to the server. Only do this on a trusted LAN or VPN.
              </div>
            )}
            <Field label="API key">
              <input className="input num" value={apiKey} onChange={(e) => setApiKey(e.target.value)} spellCheck={false} />
            </Field>
            <Field label="Secret key" hint="Encrypted with the OS keychain on the machine that holds it; the UI never sees it again.">
              <input className="input num" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} spellCheck={false} />
            </Field>
            {!keys.encryptionAvailable && (
              <div className="rounded-md border border-loss/40 bg-loss/10 p-2 text-xs text-loss">OS encryption is unavailable; keys cannot be stored safely.</div>
            )}
            <div className="flex flex-wrap gap-2">
              <button className="btn btn-primary" disabled={saving || !apiKey || !secret} onClick={saveKeys}>
                {saving && <Spinner />} Save keys
              </button>
              <button className="btn btn-ghost" disabled={testing || !keys.hasKeys} onClick={testKeys}>
                {testing && <Spinner />} Test connection
              </button>
              {keys.hasKeys && (
                <button className="btn btn-ghost text-loss" onClick={clearKeys}>
                  <Trash2 className="h-4 w-4" /> Remove
                </button>
              )}
            </div>
            {summary && (
              <div className="grid grid-cols-2 gap-2 rounded-md bg-panel-2 p-3 text-xs">
                <div className="text-muted">Account type</div>
                <div>{summary.accountType}</div>
                <div className="text-muted">Permissions</div>
                <div className="num">{summary.permissions.join(', ')}</div>
                <div className="text-muted">Can trade</div>
                <div className={summary.canTrade ? 'text-gain' : 'text-loss'}>{summary.canTrade ? 'yes' : 'no'}</div>
                <div className="text-muted">Can withdraw</div>
                <div className={summary.canWithdraw ? 'text-loss' : 'text-gain'}>{summary.canWithdraw ? 'yes (disable this!)' : 'no (good)'}</div>
                {summary.keyRestrictions && (
                  <>
                    <div className="text-muted">Key: spot trading</div>
                    <div>{summary.keyRestrictions.enableSpotTrading ? 'enabled' : 'disabled (read-only key)'}</div>
                    <div className="text-muted">Key: withdrawals</div>
                    <div className={summary.keyRestrictions.enableWithdrawals ? 'text-loss' : 'text-gain'}>
                      {summary.keyRestrictions.enableWithdrawals ? 'ENABLED (turn this off in Binance)' : 'disabled (good)'}
                    </div>
                    <div className="text-muted">Key: IP restriction</div>
                    <div className={summary.keyRestrictions.ipRestrict ? 'text-accent' : ''}>
                      {summary.keyRestrictions.ipRestrict
                        ? 'restricted to trusted IPs: only works while this server keeps a whitelisted public IP'
                        : 'unrestricted: works from any network'}
                    </div>
                    {summary.keyRestrictions.tradingAuthorityExpiration && (
                      <>
                        <div className="text-muted">Key: trading expires</div>
                        <div className={summary.keyRestrictions.tradingAuthorityExpiration < Date.now() ? 'text-loss' : 'text-accent'}>
                          {fmtDate(summary.keyRestrictions.tradingAuthorityExpiration)}
                        </div>
                      </>
                    )}
                  </>
                )}
                <div className="text-muted">Last update</div>
                <div>{fmtDate(summary.updateTime)}</div>
              </div>
            )}
          </div>
        </Card>

        <Card title="Environment">
          <div className="flex flex-col gap-4">
            <Toggle
              checked={settings.testnet}
              onChange={(v) => update({ testnet: v }, v ? 'Switched to testnet' : 'Switched to live trading')}
              label={
                <span>
                  Use Binance <b>Spot Testnet</b>
                </span>
              }
            />
            <p className="text-xs text-muted">
              The testnet is a sandbox with fake funds. It needs its own API keys from{' '}
              <button className="text-accent hover:underline" onClick={() => api.app.openExternal('https://testnet.binance.vision')}>
                testnet.binance.vision
              </button>
              . Trades, journal notes, bots and history are stored separately per environment, so switching back and forth is safe.
            </p>
            <div className="border-t border-border pt-4">
              <Toggle
                checked={settings.automationEnabled}
                onChange={(v) => update({ automationEnabled: v }, v ? 'Automation enabled' : 'Automation disabled')}
                label="Master switch: allow bots to run"
              />
              <p className="mt-1 text-xs text-muted">
                When off, no bot places orders regardless of its own state. Bots and stop ladders run on the machine that holds the keys
                {isClient ? ' (the server)' : ''}, while it is open.
              </p>
            </div>
          </div>
        </Card>

        <Card title="Portfolio display">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Value everything in">
              <select className="input" value={settings.quoteAsset} onChange={(e) => update({ quoteAsset: e.target.value })}>
                {QUOTES.map((q) => (
                  <option key={q}>{q}</option>
                ))}
              </select>
            </Field>
            <Field label="Hide holdings below" hint="in the quote asset">
              <input
                className="input num"
                type="number"
                min={0}
                step={0.5}
                defaultValue={settings.hideDustBelow}
                onBlur={(e) => {
                  const v = parseFloat(e.target.value)
                  if (Number.isFinite(v) && v !== settings.hideDustBelow) update({ hideDustBelow: v })
                }}
              />
            </Field>
            <Field label="Refresh every" hint="seconds">
              <input
                className="input num"
                type="number"
                min={10}
                step={5}
                defaultValue={settings.refreshIntervalSec}
                onBlur={(e) => {
                  const v = Math.max(10, parseInt(e.target.value, 10) || 30)
                  if (v !== settings.refreshIntervalSec) update({ refreshIntervalSec: v })
                }}
              />
            </Field>
          </div>
        </Card>

        <Card title="Watchlist">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              {settings.watchlist.map((s) => (
                <span key={s} className="tag num gap-1 text-text">
                  {s}
                  <button className="text-muted hover:text-loss" onClick={() => update({ watchlist: settings.watchlist.filter((x) => x !== s) }, `${s} removed`)}>
                    ×
                  </button>
                </span>
              ))}
              {settings.watchlist.length === 0 && <span className="text-xs text-muted">No symbols yet.</span>}
            </div>
            <div className="flex gap-2">
              <SymbolPicker value={wl} onChange={setWl} className="flex-1" />
              <button className="btn btn-ghost" onClick={addWatch} disabled={!wl}>
                Add
              </button>
            </div>
          </div>
        </Card>

        <Card title="Data" className="lg:col-span-2">
          <div className="grid gap-3 text-xs sm:grid-cols-2">
            <div>
              <div className="text-muted">Local data folder</div>
              <div className="selectable num mt-1 break-all">{info?.dataPath ?? '…'}</div>
              <div className="mt-2 text-muted">
                Trades, journal, bots, positions and value history live here as JSON on the machine that holds the keys. Keys are in an
                encrypted file one level up. The remote-access settings are the only thing stored per machine.
              </div>
            </div>
            <div className="flex flex-col items-start gap-2">
              <button className="btn btn-ghost text-loss" onClick={clearTrades}>
                <Trash2 className="h-4 w-4" /> Clear synced trades ({settings.testnet ? 'testnet' : 'live'})
              </button>
              <div className="text-muted">Version {info?.version ?? '…'}</div>
            </div>
          </div>
        </Card>
      </div>
    </div>
  )
}

interface EmbeddedState {
  enabled: boolean
  running: boolean
  autoStart: boolean
  batteryUnrestricted: boolean
  notificationsGranted: boolean
  port: number | null
  token: string | null
  addresses: string[]
  busy: boolean
  error: string | null
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    /* the value is selectable on screen, so it can still be copied by hand */
  }
}

/** Android only: the built-in 24/7 server running inside this phone. */
function EmbeddedServerSection() {
  const { remote, reload } = useApp()
  const toast = useToast()
  const [st, setSt] = useState<EmbeddedState>({
    enabled: false,
    running: false,
    autoStart: false,
    batteryUnrestricted: true,
    notificationsGranted: true,
    port: null,
    token: null,
    addresses: [],
    busy: false,
    error: null
  })

  const refresh = async (): Promise<void> => {
    try {
      const m = await import('../lib/embedded')
      const ka = await m.keepAliveStatus()
      const info = m.embeddedInfo()
      setSt((s) => ({
        ...s,
        enabled: m.embeddedEnabled(),
        port: info?.port ?? null,
        token: info?.token ?? null,
        addresses: info?.addresses ?? [],
        ...ka,
        error: null
      }))
    } catch (e) {
      setSt((s) => ({ ...s, error: (e as Error).message }))
    }
  }

  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), 5000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggle = async (on: boolean): Promise<void> => {
    setSt((s) => ({ ...s, busy: true, error: null }))
    try {
      const m = await import('../lib/embedded')
      if (on) {
        const r = await m.enableEmbedded()
        toast.success('Built-in server running', `Listening on port ${r.info.port}. This phone now holds the keys and runs the ladders.`)
        if (!r.keepAlive.batteryUnrestricted) toast.warn('Allow unrestricted battery use', 'Otherwise Android may pause the server when the screen is off.')
      } else {
        if (!window.confirm('Stop the built-in server? Ladders and bots will pause until it runs again. Orders already on Binance stay in place.')) return
        await m.disableEmbedded()
        toast.info('Built-in server stopped', 'It fully shuts down once the app is closed.')
      }
      await reload()
    } catch (e) {
      console.error('[embedded] toggle failed:', (e as Error).message)
      toast.error('Could not change the built-in server', (e as Error).message)
      setSt((s) => ({ ...s, error: (e as Error).message }))
    } finally {
      setSt((s) => ({ ...s, busy: false }))
      await refresh()
    }
  }

  const battery = async (): Promise<void> => {
    const m = await import('../lib/embedded')
    await m.requestBatteryExemption()
    setTimeout(() => void refresh(), 1500)
  }

  const local = remote?.client?.url.includes('127.0.0.1') ?? false

  return (
    <div className="rounded-lg border border-accent/40 bg-accent/5 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">Run the server on this phone</div>
          <p className="mt-1 text-xs text-muted">
            Keeps your keys, positions, stop ladders and bots on this phone 24/7 with no PC and no cloud. A permanent notification stays visible
            while it runs. Keep the phone charged and connected to the internet.
          </p>
        </div>
        <Toggle checked={st.enabled} onChange={(v) => void toggle(v)} disabled={st.busy} />
      </div>
      {st.enabled && (
        <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
          <div className="flex items-center justify-between rounded-md bg-panel-2 px-3 py-2">
            <span className="text-muted">Background service</span>
            <span className={st.running ? 'text-gain' : 'text-loss'}>{st.running ? 'running' : 'stopped'}</span>
          </div>
          <div className="flex items-center justify-between rounded-md bg-panel-2 px-3 py-2">
            <span className="text-muted">Server</span>
            <span className={local && remote?.client?.connected ? 'text-gain' : 'text-loss'}>
              {local && remote?.client?.connected ? `connected on :${st.port ?? '…'}` : 'not connected'}
            </span>
          </div>
          <div className="flex items-center justify-between rounded-md bg-panel-2 px-3 py-2">
            <span className="text-muted">Notifications</span>
            <span className={st.notificationsGranted ? 'text-gain' : 'text-accent'}>{st.notificationsGranted ? 'allowed' : 'blocked'}</span>
          </div>
          <div className="flex items-center justify-between gap-2 rounded-md bg-panel-2 px-3 py-2">
            <span className="text-muted">Battery</span>
            {st.batteryUnrestricted ? (
              <span className="text-gain">unrestricted</span>
            ) : (
              <button className="btn btn-primary btn-sm" onClick={() => void battery()}>
                Allow unrestricted
              </button>
            )}
          </div>
          <p className="text-[11px] text-muted sm:col-span-2">
            Your PC can connect to this phone too: give it one of these addresses and this token. After a reboot, tap the notification once to
            resume.
          </p>
          {st.addresses.length > 0 && (
            <div className="rounded-md bg-panel-2 px-3 py-2 sm:col-span-2">
              <div className="text-muted">Address for the PC</div>
              <div className="mt-1 flex flex-wrap gap-2">
                {[...st.addresses]
                  .sort((x, y) => Number(isTailscale(y)) - Number(isTailscale(x)))
                  .map((a) => (
                    <button
                      key={a}
                      className={cls('tag num hover:text-accent', isTailscale(a) ? 'text-gain' : 'text-text')}
                      onClick={() => void copyText(`${a}:${st.port ?? 7777}`)}
                    >
                      {a}:{st.port ?? 7777}
                      {isTailscale(a) && ' · anywhere'}
                    </button>
                  ))}
              </div>
            </div>
          )}
          {st.token && (
            <div className="rounded-md bg-panel-2 px-3 py-2 sm:col-span-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted">Pairing token</span>
                <button className="btn btn-ghost btn-sm" onClick={() => void copyText(st.token ?? '')}>
                  Copy
                </button>
              </div>
              <div className="selectable num mt-1 break-all text-[11px]">{st.token}</div>
            </div>
          )}
        </div>
      )}
      {st.error && <div className="selectable mt-2 text-xs text-loss">{st.error}</div>}
    </div>
  )
}

const NEWLINE = String.fromCharCode(10)

/** Split the spare-address box into a clean list. */
function altsOf(text: string): string[] {
  return text.split(/[\n,]+/).map((a) => a.trim()).filter(Boolean)
}

/** Tailscale hands out 100.64.0.0/10 addresses, which are reachable from any network. */
function isTailscale(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number)
  return a === 100 && b >= 64 && b <= 127
}

export function RemoteCard() {
  const { remote, reload, mobile } = useApp()
  const toast = useToast()
  const [cfg, setCfg] = useState<RemoteConfig | null>(null)
  const [mode, setMode] = useState<RemoteMode>('standalone')
  const [port, setPort] = useState('7777')
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [test, setTest] = useState<RemoteTestResult | null>(null)
  const [alts, setAlts] = useState('')
  const [found, setFound] = useState<DiscoveredServer[] | null>(null)
  const [scanning, setScanning] = useState(false)

  const load = async (): Promise<void> => {
    try {
      const c = await api.remote.get()
      setCfg(c)
      setMode(c.mode)
      setPort(String(c.server.port))
      setUrl(c.client.url)
      setAlts(c.client.altUrls.join('\n'))
      setToken(c.client.token)
    } catch (e) {
      toast.error('Could not load remote settings', (e as Error).message)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const apply = async (patch: Partial<RemoteConfig>, msg: string): Promise<void> => {
    setBusy(true)
    try {
      const c = await api.remote.set(patch)
      setCfg(c)
      setMode(c.mode)
      await reload()
      toast.success(msg)
    } catch (e) {
      toast.error('Could not apply', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const runTest = async (): Promise<void> => {
    setBusy(true)
    setTest(null)
    try {
      const r = await api.remote.test(url, token)
      setTest(r)
      toast.success('Server reachable', `Binance Manager ${r.version} · ${r.testnet ? 'testnet' : 'live'} · keys ${r.hasKeys ? 'present' : 'missing'} · ${r.latencyMs} ms`)
    } catch (e) {
      toast.error('Test failed', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const altList = (): string[] => altsOf(alts)

  /** Sweep the LAN so a server whose IP keeps moving does not have to be typed in. */
  const findServer = async (): Promise<void> => {
    setScanning(true)
    setFound(null)
    setTest(null)
    try {
      const list = await api.remote.discover(token)
      setFound(list)
      if (list.length === 0) {
        toast.warn('No server found on this network', 'Check that the server is running, that both devices are on the same Wi-Fi, and that the token matches.')
      } else {
        setUrl(list[0].url)
        toast.success(
          list.length === 1 ? 'Found your server' : `Found ${list.length} addresses`,
          `${list[0].url} · ${list[0].viaTailnet ? 'over Tailscale, works from any network' : 'this network only'} · ${list[0].latencyMs} ms`
        )
        // Anything else it answers on is worth keeping as a spare.
        const spares = list.slice(1).map((f) => f.url)
        if (spares.length > 0) setAlts((a) => [...new Set([...altsOf(a), ...spares])].join(NEWLINE))
      }
    } catch (e) {
      toast.error('Search failed', (e as Error).message)
    } finally {
      setScanning(false)
    }
  }

  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      toast.info('Copied to clipboard')
    } catch {
      toast.warn('Could not copy; select the text and copy it manually')
    }
  }

  const regenerate = async (): Promise<void> => {
    if (!window.confirm('Generate a new pairing token? Every client will have to enter the new one.')) return
    setBusy(true)
    try {
      setCfg(await api.remote.regenerateToken())
      toast.success('New token generated')
    } finally {
      setBusy(false)
    }
  }

  const srv = remote?.server
  const cli = remote?.client

  return (
    <Card
      title="Remote access"
      className="lg:col-span-2"
      action={
        remote?.mode === 'server' ? (
          <Badge tone={srv?.running ? 'gain' : 'loss'}>{srv?.running ? `server running · ${srv.clients} client${srv.clients === 1 ? '' : 's'}` : 'server not running'}</Badge>
        ) : remote?.mode === 'client' ? (
          <Badge tone={cli?.connected ? 'gain' : 'loss'}>{cli?.connected ? 'connected' : 'not connected'}</Badge>
        ) : (
          <Badge>standalone</Badge>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {mobile && <EmbeddedServerSection />}
        <p className="text-xs text-muted">
          {mobile ? (
            <>
              Or connect this phone to a server elsewhere: the desktop app in Server mode or the headless server on a machine that stays on. Use
              your LAN or a VPN such as Tailscale or WireGuard; the pairing token is sent in plain HTTP, so do not expose the port directly to
              the internet.
            </>
          ) : (
            <>
              Run one copy of the app as the <b>server</b> on a machine that stays on: it holds the API keys, syncs trades, runs the bots and stop
              ladders. Run other copies as <b>clients</b>: they show the same portfolio, journal and positions and send every command to the
              server. Use it on your LAN or over a VPN such as Tailscale or WireGuard; the pairing token is sent in plain HTTP, so do not expose
              the port directly to the internet.
            </>
          )}
        </p>

        {!mobile && (
          <Segmented
            value={mode}
            onChange={(m) => setMode(m)}
            options={[
              { value: 'standalone', label: 'Standalone' },
              { value: 'server', label: 'Server (holds the keys)' },
              { value: 'client', label: 'Client (connects to a server)' }
            ]}
          />
        )}

        {mode === 'server' && cfg && (
          <div className="grid gap-3 sm:grid-cols-[120px_1fr]">
            <Field label="Port">
              <input className="input num" type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} />
            </Field>
            <Field label="Pairing token" hint="Enter this on each client. Anyone with it can trade with your keys.">
              <div className="flex gap-2">
                <input className="input num selectable" readOnly value={cfg.server.token} />
                <button className="btn btn-ghost" onClick={() => copy(cfg.server.token)} title="Copy">
                  <Copy className="h-4 w-4" />
                </button>
                <button className="btn btn-ghost" onClick={regenerate} disabled={busy} title="Generate a new token">
                  <RefreshCw className="h-4 w-4" />
                </button>
              </div>
            </Field>
            <div className="sm:col-span-2">
              <button className="btn btn-primary" disabled={busy} onClick={() => apply({ mode: 'server', server: { port: parseInt(port, 10) || 7777, token: cfg.server.token } }, 'Server mode applied')}>
                {busy && <Spinner />} {remote?.mode === 'server' ? 'Apply' : 'Start server'}
              </button>
            </div>
            {remote?.mode === 'server' && srv && (
              <div className="rounded-md bg-panel-2 p-3 text-xs sm:col-span-2">
                {srv.error && <div className="mb-1 text-loss">{srv.error}</div>}
                {srv.running ? (
                  <>
                    <div className="text-muted">Clients connect to one of these addresses:</div>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {srv.addresses.length === 0 && <span className="num">localhost:{srv.port}</span>}
                      {[...srv.addresses]
                        .sort((x, y) => Number(isTailscale(y)) - Number(isTailscale(x)))
                        .map((a) => (
                          <button
                            key={a}
                            className={cls('tag num hover:text-accent', isTailscale(a) ? 'text-gain' : 'text-text')}
                            onClick={() => copy(`${a}:${srv.port}`)}
                            title={isTailscale(a) ? 'Tailscale address: reachable from any network. Click to copy.' : 'Local network address: only from this Wi-Fi. Click to copy.'}
                          >
                            {a}:{srv.port}
                            {isTailscale(a) && ' · anywhere'}
                          </button>
                        ))}
                    </div>
                    <div className="mt-2 text-muted">
                      {srv.addresses.some(isTailscale)
                        ? 'The green address is your Tailscale one: it keeps working when the client is on another Wi-Fi or on mobile data. The others only work on this network.'
                        : 'These only work while both devices are on this network. Install Tailscale on both to get an address that follows this device anywhere.'}
                    </div>
                    <div className="mt-2 text-muted">
                      Allow TCP port {srv.port} through Windows Firewall for your private network. {srv.clients} client{srv.clients === 1 ? '' : 's'} connected.
                    </div>
                  </>
                ) : (
                  <div className="text-muted">Server is not listening.</div>
                )}
              </div>
            )}
          </div>
        )}

        {mode === 'client' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Server address" hint="IP or host and port, e.g. 192.168.1.20:7777">
              <div className="flex gap-2">
                <input className="input num" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="192.168.1.20:7777" spellCheck={false} />
                <button
                  className="btn btn-ghost shrink-0"
                  disabled={scanning}
                  onClick={findServer}
                  title={token ? 'Search your tailnet and this network for a server that accepts your token' : 'Enter the pairing token first: it is what tells your server apart from anything else on this port'}
                >
                  {scanning && <Spinner />} Find
                </button>
              </div>
            </Field>
            <Field label="Pairing token" hint="from the server's Remote access card">
              <input className="input num" type="password" value={token} onChange={(e) => setToken(e.target.value)} spellCheck={false} />
            </Field>
            <Field
              label="Other addresses to try"
              className="sm:col-span-2"
              hint="one per line — put your Tailscale address here and it is used automatically whenever the one above cannot be reached"
            >
              <textarea
                className="input num min-h-[52px] resize-y"
                value={alts}
                onChange={(e) => setAlts(e.target.value)}
                placeholder={'100.101.102.103:7777\npixel-9a:7777'}
                spellCheck={false}
              />
            </Field>
            <div className="flex flex-wrap gap-2 sm:col-span-2">
              <button className="btn btn-ghost" disabled={busy || !url || !token} onClick={runTest}>
                {busy && <Spinner />} Test connection
              </button>
              <button className="btn btn-primary" disabled={busy || !url || !token} onClick={() => apply({ mode: 'client', client: { url, altUrls: altList(), token } }, 'Client mode applied')}>
                {remote?.mode === 'client' ? 'Apply & reconnect' : 'Connect as client'}
              </button>
            </div>
            {found && found.length > 1 && (
              <div className="flex flex-col gap-1 rounded-md bg-panel-2 p-3 text-xs sm:col-span-2">
                <span className="text-muted">Servers found on this network:</span>
                {found.map((f) => (
                  <button key={f.url} className="text-left hover:text-accent" onClick={() => setUrl(f.url)}>
                    <span className="num">{f.url}</span>
                    {f.viaTailnet ? <span className="text-gain"> · anywhere</span> : <span className="text-muted"> · this network</span>} · keys{' '}
                    {f.hasKeys ? 'present' : 'missing'} · <span className="num">{f.latencyMs} ms</span>
                  </button>
                ))}
              </div>
            )}
            {test && (
              <div className="rounded-md bg-panel-2 p-3 text-xs sm:col-span-2">
                Server <span className="num">{test.version}</span> · {test.testnet ? 'testnet' : 'live'} · API keys {test.hasKeys ? 'present' : 'missing'} · round trip{' '}
                <span className="num">{test.latencyMs} ms</span>
              </div>
            )}
            {remote?.mode === 'client' && cli && (
              <div className={cls('rounded-md p-3 text-xs sm:col-span-2', cli.connected ? 'bg-panel-2' : 'border border-loss/40 bg-loss/10')}>
                {cli.connected ? (
                  <>
                    Connected to <span className="num">{cli.url}</span>
                    {cli.serverVersion && <> · server {cli.serverVersion}</>}
                    {cli.serverTestnet !== null && <> · {cli.serverTestnet ? 'testnet' : 'live'}</>}
                    {cli.lastEventAt && <> · last event {fmtDate(cli.lastEventAt)}</>}
                  </>
                ) : (
                  <>
                    Not connected to <span className="num">{cli.url || '(no address)'}</span>
                    {cli.lastError && <>: {cli.lastError}</>}. Retrying automatically.
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {!mobile && mode === 'standalone' && remote?.mode !== 'standalone' && (
          <button className="btn btn-ghost self-start" disabled={busy} onClick={() => apply({ mode: 'standalone' }, 'Back to standalone')}>
            {busy && <Spinner />} Switch to standalone
          </button>
        )}
      </div>
    </Card>
  )
}
