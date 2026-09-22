import { Loader2, X } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { cls } from '../lib/format'

export function Card({
  title,
  action,
  children,
  className
}: {
  title?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <section className={cls('card fade-in', className)}>
      {(title || action) && (
        <header className="mb-3 flex items-center justify-between gap-3">
          {title && <h2 className="text-sm font-semibold text-text">{title}</h2>}
          {action && <div className="flex items-center gap-2">{action}</div>}
        </header>
      )}
      {children}
    </section>
  )
}

export function StatCard({
  label,
  value,
  sub,
  tone,
  className
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  tone?: 'gain' | 'loss' | 'neutral'
  className?: string
}): JSX.Element {
  const toneCls = tone === 'gain' ? 'text-gain' : tone === 'loss' ? 'text-loss' : 'text-text'
  return (
    <div className={cls('card flex flex-col gap-1', className)}>
      <div className="text-xs font-medium tracking-wide text-muted uppercase">{label}</div>
      <div className={cls('num text-2xl font-semibold', toneCls)}>{value}</div>
      {sub && <div className="text-xs text-muted">{sub}</div>}
    </div>
  )
}

export function Badge({
  children,
  tone = 'neutral',
  className,
  title
}: {
  children: ReactNode
  tone?: 'gain' | 'loss' | 'neutral' | 'accent' | 'info'
  className?: string
  title?: string
}): JSX.Element {
  const tones: Record<string, string> = {
    gain: 'bg-gain/15 text-gain',
    loss: 'bg-loss/15 text-loss',
    neutral: 'bg-panel-2 text-muted',
    accent: 'bg-accent/15 text-accent',
    info: 'bg-info/15 text-info'
  }
  return (
    <span className={cls('inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium', tones[tone], className)} title={title}>
      {children}
    </span>
  )
}

export function Spinner({ className }: { className?: string }): JSX.Element {
  return <Loader2 className={cls('h-4 w-4 animate-spin', className)} />
}

export function EmptyState({
  title,
  hint,
  action
}: {
  title: string
  hint?: ReactNode
  action?: ReactNode
}): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <div className="text-sm font-medium text-text">{title}</div>
      {hint && <div className="max-w-md text-xs text-muted">{hint}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export function Field({
  label,
  hint,
  children,
  className
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <label className={cls('flex flex-col gap-1', className)}>
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-muted/80">{hint}</span>}
    </label>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label?: ReactNode
  disabled?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cls('flex items-center gap-2 text-sm', disabled && 'opacity-50')}
    >
      <span
        className={cls(
          'relative inline-block h-5 w-9 rounded-full transition',
          checked ? 'bg-accent' : 'bg-border'
        )}
      >
        <span
          className={cls(
            'absolute top-0.5 h-4 w-4 rounded-full bg-white transition',
            checked ? 'left-[18px]' : 'left-0.5'
          )}
        />
      </span>
      {label && <span>{label}</span>}
    </button>
  )
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  width = 'max-w-lg'
}: {
  open: boolean
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: string
}): JSX.Element | null {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className={cls('fade-in w-full rounded-xl border border-border bg-panel shadow-2xl', width)}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border px-5 py-3">
          <h3 className="text-sm font-semibold">{title}</h3>
          <button className="rounded p-1 text-muted hover:bg-panel-2 hover:text-text" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</footer>}
      </div>
    </div>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className
}: {
  value: T
  options: { value: T; label: ReactNode; tone?: 'gain' | 'loss' }[]
  onChange: (v: T) => void
  className?: string
}): JSX.Element {
  return (
    <div className={cls('inline-flex rounded-md border border-border bg-bg p-0.5', className)}>
      {options.map((o) => {
        const active = o.value === value
        const activeCls =
          o.tone === 'gain' ? 'bg-gain text-black' : o.tone === 'loss' ? 'bg-loss text-white' : 'bg-panel-2 text-text'
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={cls(
              'rounded px-3 py-1 text-xs font-medium transition',
              active ? activeCls : 'text-muted hover:text-text'
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
