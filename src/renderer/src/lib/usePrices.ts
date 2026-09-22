import { useEffect, useRef, useState } from 'react'

const STREAM_URL = 'wss://stream.binance.com:9443/stream'

interface MiniTicker {
  s: string // symbol
  c: string // close (last) price
  o: string // open 24h ago
}

/**
 * Live last prices for a set of symbols from Binance's public mini-ticker
 * stream. Returns a map of symbol -> price and 24h change percent. The socket
 * is reconnected automatically and re-subscribed when the symbol list changes.
 */
export function useLivePrices(symbols: string[]): {
  prices: Record<string, number>
  changes: Record<string, number>
  connected: boolean
} {
  const [prices, setPrices] = useState<Record<string, number>>({})
  const [changes, setChanges] = useState<Record<string, number>>({})
  const [connected, setConnected] = useState(false)
  const key = [...new Set(symbols)].sort().join(',')
  const pending = useRef<Record<string, MiniTicker>>({})

  useEffect(() => {
    if (!key) return
    const list = key.split(',')
    let ws: WebSocket | null = null
    let closed = false
    let retry = 1000
    let flushTimer: ReturnType<typeof setInterval> | null = null

    const flush = (): void => {
      const batch = pending.current
      if (Object.keys(batch).length === 0) return
      pending.current = {}
      setPrices((p) => {
        const next = { ...p }
        for (const t of Object.values(batch)) next[t.s] = parseFloat(t.c)
        return next
      })
      setChanges((c) => {
        const next = { ...c }
        for (const t of Object.values(batch)) {
          const o = parseFloat(t.o)
          next[t.s] = o > 0 ? ((parseFloat(t.c) - o) / o) * 100 : 0
        }
        return next
      })
    }

    const connect = (): void => {
      if (closed) return
      const streams = list.map((s) => `${s.toLowerCase()}@miniTicker`).join('/')
      ws = new WebSocket(`${STREAM_URL}?streams=${streams}`)
      ws.onopen = () => {
        setConnected(true)
        retry = 1000
      }
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as { data?: MiniTicker }
          if (msg.data?.s) pending.current[msg.data.s] = msg.data
        } catch {
          /* ignore malformed frames */
        }
      }
      ws.onclose = () => {
        setConnected(false)
        if (!closed) {
          setTimeout(connect, retry)
          retry = Math.min(retry * 2, 30000)
        }
      }
      ws.onerror = () => ws?.close()
    }

    connect()
    flushTimer = setInterval(flush, 500)

    return () => {
      closed = true
      if (flushTimer) clearInterval(flushTimer)
      ws?.close()
    }
  }, [key])

  return { prices, changes, connected }
}
