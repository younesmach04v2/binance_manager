import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { cls } from '../lib/format'

let cache: string[] | null = null
let inflight: Promise<string[]> | null = null

/** All TRADING spot symbols, fetched once per session. */
export function loadSymbols(): Promise<string[]> {
  if (cache) return Promise.resolve(cache)
  if (!inflight) {
    inflight = api.market
      .symbols()
      .then((s) => {
        cache = s
        return s
      })
      .finally(() => {
        inflight = null
      })
  }
  return inflight
}

export function SymbolPicker({
  value,
  onChange,
  placeholder = 'Search symbol, e.g. BTCUSDT',
  className,
  autoFocus
}: {
  value: string
  onChange: (symbol: string) => void
  placeholder?: string
  className?: string
  autoFocus?: boolean
}) {
  const [symbols, setSymbols] = useState<string[]>(cache ?? [])
  const [query, setQuery] = useState(value)
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(0)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    loadSymbols()
      .then(setSymbols)
      .catch(() => setSymbols([]))
  }, [])

  useEffect(() => setQuery(value), [value])

  useEffect(() => {
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const matches = useMemo(() => {
    const q = query.toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (!q) return symbols.filter((s) => s.endsWith('USDT')).slice(0, 30)
    return symbols
      .filter((s) => s.includes(q))
      .sort((a, b) => Number(!a.startsWith(q)) - Number(!b.startsWith(q)) || a.length - b.length || a.localeCompare(b))
      .slice(0, 30)
  }, [query, symbols])

  const commit = (s: string): void => {
    onChange(s)
    setQuery(s)
    setOpen(false)
  }

  return (
    <div ref={ref} className={cls('relative', className)}>
      <input
        className="input num uppercase"
        value={query}
        autoFocus={autoFocus}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => {
          setQuery(e.target.value.toUpperCase())
          setHi(0)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setHi((h) => Math.min(h + 1, matches.length - 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setHi((h) => Math.max(h - 1, 0))
          } else if (e.key === 'Enter') {
            const pick = symbols.includes(query) ? query : matches[hi]
            if (pick) commit(pick)
          } else if (e.key === 'Escape') {
            setOpen(false)
          }
        }}
      />
      {open && matches.length > 0 && (
        <ul className="absolute z-30 mt-1 max-h-64 w-full overflow-auto rounded-md border border-border bg-panel py-1 shadow-xl">
          {matches.map((s, i) => (
            <li
              key={s}
              onMouseDown={() => commit(s)}
              onMouseEnter={() => setHi(i)}
              className={cls(
                'num cursor-pointer px-3 py-1.5 text-sm',
                i === hi ? 'bg-panel-2 text-text' : 'text-muted hover:text-text'
              )}
            >
              {s}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
