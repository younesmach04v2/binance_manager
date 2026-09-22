import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { createContext, useCallback, useContext, useMemo, useState, type JSX, type ReactNode } from 'react'
import { cls, uid } from '../lib/format'

type ToastKind = 'success' | 'error' | 'info' | 'warn'

interface Toast {
  id: string
  kind: ToastKind
  title: string
  detail?: string
}

interface ToastApi {
  push: (kind: ToastKind, title: string, detail?: string) => void
  success: (title: string, detail?: string) => void
  error: (title: string, detail?: string) => void
  info: (title: string, detail?: string) => void
  warn: (title: string, detail?: string) => void
}

const Ctx = createContext<ToastApi | null>(null)

export function useToast(): ToastApi {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useToast must be used inside ToastProvider')
  return ctx
}

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([])

  const dismiss = useCallback((id: string) => setToasts((t) => t.filter((x) => x.id !== id)), [])

  const push = useCallback(
    (kind: ToastKind, title: string, detail?: string) => {
      const id = uid()
      setToasts((t) => [...t, { id, kind, title, detail }].slice(-5))
      setTimeout(() => dismiss(id), kind === 'error' ? 9000 : 5000)
    },
    [dismiss]
  )

  const api = useMemo<ToastApi>(
    () => ({
      push,
      success: (t, d) => push('success', t, d),
      error: (t, d) => push('error', t, d),
      info: (t, d) => push('info', t, d),
      warn: (t, d) => push('warn', t, d)
    }),
    [push]
  )

  const icons: Record<ToastKind, JSX.Element> = {
    success: <CheckCircle2 className="h-4 w-4 text-gain" />,
    error: <XCircle className="h-4 w-4 text-loss" />,
    info: <Info className="h-4 w-4 text-info" />,
    warn: <AlertTriangle className="h-4 w-4 text-accent" />
  }

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[100] flex w-80 flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cls(
              'pointer-events-auto fade-in flex items-start gap-2 rounded-lg border border-border bg-panel p-3 shadow-xl'
            )}
          >
            <div className="mt-0.5">{icons[t.kind]}</div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{t.title}</div>
              {t.detail && <div className="selectable mt-0.5 text-xs break-words text-muted">{t.detail}</div>}
            </div>
            <button className="text-muted hover:text-text" onClick={() => dismiss(t.id)}>
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}
