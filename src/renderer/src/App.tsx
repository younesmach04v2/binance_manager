import type { AppInfo, KeyStatus, RemoteStatus, Settings } from '@shared/types'
import { Activity, BarChart3, BookOpen, Bot, Crosshair, KeyRound, Layers, LayoutDashboard, Radio, Settings as SettingsIcon } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { ToastProvider } from './components/Toast'
import { Badge } from './components/ui'
import { api } from './lib/api'
import { cls } from './lib/format'
import Analytics from './pages/Analytics'
import Automation from './pages/Automation'
import Dashboard from './pages/Dashboard'
import Journal from './pages/Journal'
import Positions from './pages/Positions'
import QuickTrade from './pages/QuickTrade'
import SettingsPage, { RemoteCard } from './pages/Settings'
import Trade from './pages/Trade'

export type Page = 'dashboard' | 'quick' | 'positions' | 'trade' | 'journal' | 'analytics' | 'automation' | 'settings'

interface AppState {
  settings: Settings
  keys: KeyStatus
  remote: RemoteStatus | null
  /** True inside the Android/iOS app: no local server, client mode only. */
  mobile: boolean
  reload: () => Promise<void>
  go: (page: Page) => void
}

const AppCtx = createContext<AppState | null>(null)

export function useApp(): AppState {
  const ctx = useContext(AppCtx)
  if (!ctx) throw new Error('useApp must be used inside App')
  return ctx
}

const NAV: { id: Page; label: string; short: string; icon: ReactNode }[] = [
  { id: 'dashboard', label: 'Portfolio', short: 'Portfolio', icon: <LayoutDashboard className="h-4 w-4" /> },
  { id: 'quick', label: 'Quick trade (R)', short: 'Quick', icon: <Crosshair className="h-4 w-4" /> },
  { id: 'positions', label: 'Positions', short: 'Positions', icon: <Layers className="h-4 w-4" /> },
  { id: 'trade', label: 'Trade', short: 'Trade', icon: <Activity className="h-4 w-4" /> },
  { id: 'journal', label: 'Journal', short: 'Journal', icon: <BookOpen className="h-4 w-4" /> },
  { id: 'analytics', label: 'Analytics', short: 'Stats', icon: <BarChart3 className="h-4 w-4" /> },
  { id: 'automation', label: 'Automation', short: 'Bots', icon: <Bot className="h-4 w-4" /> },
  { id: 'settings', label: 'Settings', short: 'Settings', icon: <SettingsIcon className="h-4 w-4" /> }
]

const NO_KEYS: KeyStatus = { hasKeys: false, encryptionAvailable: true, apiKeyPreview: null }

export default function App() {
  const [page, setPage] = useState<Page>('dashboard')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [keys, setKeys] = useState<KeyStatus>(NO_KEYS)
  const [remote, setRemote] = useState<RemoteStatus | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    const [s, k, r] = await Promise.allSettled([api.settings.get(), api.keys.status(), api.remote.status()])
    if (s.status === 'fulfilled') {
      setSettings(s.value)
      setError(null)
    } else {
      setError((s.reason as Error).message)
    }
    setKeys(k.status === 'fulfilled' ? k.value : NO_KEYS)
    if (r.status === 'fulfilled') setRemote(r.value)
  }, [])

  useEffect(() => {
    void reload()
    api.app
      .info()
      .then(setInfo)
      .catch(() => setInfo(null))
    const offSettings = api.on('settings:changed', (s) => setSettings(s as Settings))
    const offRemote = api.on('remote:status', (st) => {
      setRemote(st as RemoteStatus)
      void reload()
    })
    return () => {
      offSettings()
      offRemote()
    }
  }, [reload])

  if (!settings) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        {error ? (
          <>
            <div className="text-loss">Failed to start: {error}</div>
            <button className="btn btn-ghost" onClick={() => void reload()}>
              Retry
            </button>
          </>
        ) : (
          <div className="text-muted">Loading…</div>
        )}
      </div>
    )
  }

  const mobile = info?.platform === 'android' || info?.platform === 'ios'
  const isClient = remote?.mode === 'client'
  const isServer = remote?.mode === 'server'
  const connected = !!remote?.client?.connected
  const clientDown = isClient && !!remote?.client && !connected
  const needsServer = isClient && !remote?.client?.url
  const state: AppState = { settings, keys, remote, mobile, reload, go: setPage }

  if (needsServer) {
    return (
      <ToastProvider>
        <AppCtx.Provider value={state}>
          <div className="mx-auto flex min-h-full max-w-2xl flex-col justify-center gap-4 p-4 pt-[calc(env(safe-area-inset-top)+1rem)]">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent text-lg font-bold text-black">B</div>
              <div>
                <h1 className="text-lg font-semibold leading-tight">Connect to your server</h1>
                <p className="text-xs text-muted">
                  This {mobile ? 'phone' : 'machine'} is a remote control. Enter the address and pairing token shown on the server's Remote access
                  card.
                </p>
              </div>
            </div>
            <RemoteCard />
          </div>
        </AppCtx.Provider>
      </ToastProvider>
    )
  }

  return (
    <ToastProvider>
      <AppCtx.Provider value={state}>
        <div className="flex h-full flex-col md:flex-row">
          {/* ---- compact top bar (phones) ---- */}
          <header className="flex items-center justify-between gap-2 border-b border-border bg-panel px-4 pt-[calc(env(safe-area-inset-top)+0.5rem)] pb-2 md:hidden">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-sm font-bold text-black">B</div>
              <span className="text-sm font-semibold">{NAV.find((n) => n.id === page)?.label ?? 'Binance Manager'}</span>
            </div>
            <div className="flex items-center gap-2 text-[11px]">
              {settings.testnet ? <Badge tone="accent">TESTNET</Badge> : <Badge tone="gain">LIVE</Badge>}
              {isClient && (
                <span className={cls('flex items-center gap-1', connected ? 'text-gain' : 'text-loss')} title={connected ? 'connected to server' : 'server unreachable'}>
                  <Radio className="h-3.5 w-3.5" />
                </span>
              )}
              <button onClick={() => setPage('settings')} className={cls('rounded-md p-1.5', page === 'settings' ? 'bg-panel-2 text-text' : 'text-muted hover:text-text')} title="Settings">
                <SettingsIcon className="h-4 w-4" />
              </button>
            </div>
          </header>

          {/* ---- sidebar (desktop) ---- */}
          <aside className="hidden w-56 shrink-0 flex-col border-r border-border bg-panel md:flex">
            <div className="flex items-center gap-2 px-5 py-5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent font-bold text-black">B</div>
              <div>
                <div className="text-sm font-semibold leading-tight">Binance Manager</div>
                <div className="text-[11px] text-muted">Spot trading desk</div>
              </div>
            </div>
            <nav className="flex flex-1 flex-col gap-0.5 px-3">
              {NAV.map((n) => (
                <button
                  key={n.id}
                  onClick={() => setPage(n.id)}
                  className={cls(
                    'flex items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition',
                    page === n.id ? 'bg-panel-2 text-text' : 'text-muted hover:bg-panel-2/60 hover:text-text'
                  )}
                >
                  {n.icon}
                  {n.label}
                </button>
              ))}
            </nav>
            <div className="flex flex-col gap-2 border-t border-border px-5 py-4 text-xs">
              {remote && remote.mode !== 'standalone' && (
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1 text-muted">
                    <Radio className="h-3 w-3" /> {isServer ? 'Server' : 'Client'}
                  </span>
                  {isServer && remote.server && (
                    <span className={remote.server.running ? 'text-gain' : 'text-loss'}>
                      {remote.server.running ? `on :${remote.server.port} · ${remote.server.clients} client${remote.server.clients === 1 ? '' : 's'}` : 'not running'}
                    </span>
                  )}
                  {isClient && remote.client && <span className={connected ? 'text-gain' : 'text-loss'}>{connected ? 'connected' : 'unreachable'}</span>}
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-muted">Environment</span>
                {settings.testnet ? <Badge tone="accent">TESTNET</Badge> : <Badge tone="gain">LIVE</Badge>}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted">{isClient ? 'Server keys' : 'API keys'}</span>
                <span className={cls('num flex items-center gap-1', keys.hasKeys ? 'text-text' : 'text-loss')}>
                  <KeyRound className="h-3 w-3" />
                  {keys.hasKeys ? keys.apiKeyPreview : 'missing'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted">Automation</span>
                <span className={settings.automationEnabled ? 'text-gain' : 'text-muted'}>{settings.automationEnabled ? 'on' : 'off'}</span>
              </div>
            </div>
          </aside>

          <main className="min-w-0 flex-1 overflow-y-auto pb-[calc(env(safe-area-inset-bottom)+4rem)] md:pb-0">
            {clientDown && page !== 'settings' && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-loss/30 bg-loss/10 px-4 py-2 text-xs md:px-6">
                <span>
                  Cannot reach the server at {remote?.client?.url || '(no address)'}
                  {remote?.client?.lastError ? `: ${remote.client.lastError}` : ''}. Data may be stale and commands will fail until it is back.
                </span>
                <button className="btn btn-ghost btn-sm" onClick={() => setPage('settings')}>
                  Remote settings
                </button>
              </div>
            )}
            {!clientDown && !keys.hasKeys && page !== 'settings' && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-accent/30 bg-accent/10 px-4 py-2 text-xs md:px-6">
                <span>
                  {isClient
                    ? 'The server has no Binance API keys yet. Add them in Settings (they are stored on the server).'
                    : 'No Binance API keys configured. Add read-only keys to see your portfolio, or trading keys to place orders.'}
                </span>
                <button className="btn btn-primary btn-sm" onClick={() => setPage('settings')}>
                  Open Settings
                </button>
              </div>
            )}
            <div className="mx-auto max-w-[1440px] p-3 md:p-6">
              {page === 'dashboard' && <Dashboard />}
              {page === 'quick' && <QuickTrade />}
              {page === 'positions' && <Positions />}
              {page === 'trade' && <Trade />}
              {page === 'journal' && <Journal />}
              {page === 'analytics' && <Analytics />}
              {page === 'automation' && <Automation />}
              {page === 'settings' && <SettingsPage />}
            </div>
          </main>

          {/* ---- bottom tab bar (phones) ---- */}
          <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-panel pb-[env(safe-area-inset-bottom)] md:hidden">
            {NAV.filter((n) => n.id !== 'settings').map((n) => (
              <button
                key={n.id}
                onClick={() => setPage(n.id)}
                className={cls('flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px]', page === n.id ? 'text-accent' : 'text-muted')}
              >
                {n.icon}
                <span>{n.short}</span>
              </button>
            ))}
          </nav>
        </div>
      </AppCtx.Provider>
    </ToastProvider>
  )
}
