export function cls(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

/** Format a number with sensible precision: big numbers get 2 decimals, tiny ones more. */
export function fmtNum(n: number | null | undefined, maxDecimals?: number): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  const abs = Math.abs(n)
  let decimals = maxDecimals
  if (decimals === undefined) {
    if (abs >= 1000) decimals = 2
    else if (abs >= 1) decimals = 4
    else if (abs >= 0.01) decimals = 6
    else if (abs === 0) decimals = 2
    else decimals = 8
  }
  return n.toLocaleString('en-US', { minimumFractionDigits: Math.min(2, decimals), maximumFractionDigits: decimals })
}

export function fmtMoney(n: number | null | undefined, quote = 'USDT', decimals = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return `${n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })} ${quote}`
}

export function fmtSigned(n: number | null | undefined, quote?: string, decimals = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  const s = `${n > 0 ? '+' : ''}${n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`
  return quote ? `${s} ${quote}` : s
}

export function fmtPct(n: number | null | undefined, decimals = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return `${n > 0 ? '+' : ''}${n.toFixed(decimals)}%`
}

export function fmtDate(t: number | null | undefined): string {
  if (!t) return '—'
  return new Date(t).toLocaleString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function fmtShortDate(t: number): string {
  return new Date(t).toLocaleDateString('en-GB', { month: 'short', day: '2-digit' })
}

export function fmtDuration(ms: number): string {
  if (!ms || ms < 0) return '—'
  const m = Math.round(ms / 60000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

export function pnlClass(n: number | null | undefined): string {
  if (n === null || n === undefined || n === 0) return 'text-muted'
  return n > 0 ? 'text-gain' : 'text-loss'
}

export function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Split a symbol like BTCUSDT into base and quote using a list of known quotes. */
const KNOWN_QUOTES = ['USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD', 'BTC', 'ETH', 'BNB', 'EUR', 'TRY', 'BRL', 'JPY']
export function splitSymbol(symbol: string): { base: string; quote: string } {
  for (const q of KNOWN_QUOTES) {
    if (symbol.endsWith(q) && symbol.length > q.length) return { base: symbol.slice(0, -q.length), quote: q }
  }
  return { base: symbol, quote: '' }
}
