import WebSocket from 'ws'
import type { IpcResult } from '../../shared/api'
import type { RemoteInfo } from '../../shared/types'

export function normalizeUrl(raw: string): string {
  let u = raw.trim()
  if (!u) return ''
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`
  return u.replace(/\/+$/, '')
}

/**
 * Talks to a Binance Manager running in server mode: forwards commands over
 * HTTP and keeps a WebSocket open for its events, reconnecting with backoff.
 */
export class RemoteClient {
  private url = ''
  private token = ''
  private ws: WebSocket | null = null
  private closed = true
  private retry = 1000
  private timer: NodeJS.Timeout | null = null

  connected = false
  lastError: string | null = null
  serverInfo: RemoteInfo | null = null
  lastEventAt: number | null = null

  constructor(
    private readonly onEvent: (channel: string, payload: unknown) => void,
    private readonly onStatus: () => void
  ) {}

  configure(url: string, token: string): void {
    this.url = normalizeUrl(url)
    this.token = token.trim()
  }

  async call(channel: string, args: unknown[], timeoutMs: number): Promise<IpcResult<unknown>> {
    if (!this.url) return { ok: false, error: 'No server address configured. Open Settings → Remote access.' }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(`${this.url}/rpc`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ channel, args }),
        signal: ctrl.signal
      })
      if (res.status === 401) {
        this.fail('Server rejected the pairing token')
        return { ok: false, error: 'The server rejected the pairing token. Check it in Settings → Remote access.' }
      }
      const data = (await res.json()) as IpcResult<unknown>
      if (this.lastError) {
        this.lastError = null
        this.onStatus()
      }
      return data
    } catch (e) {
      const msg = ctrl.signal.aborted ? `timed out after ${Math.round(timeoutMs / 1000)}s` : (e as Error).message
      this.fail(msg)
      return { ok: false, error: `Cannot reach the server at ${this.url}: ${msg}` }
    } finally {
      clearTimeout(timer)
    }
  }

  /** One-off identity check used by the "Test connection" button. */
  static async info(url: string, token: string, timeoutMs = 8000): Promise<RemoteInfo> {
    const base = normalizeUrl(url)
    if (!base) throw new Error('Enter the server address, e.g. 192.168.1.20:7777')
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(`${base}/info`, { headers: { authorization: `Bearer ${token.trim()}` }, signal: ctrl.signal })
      if (res.status === 401) throw new Error('The server rejected the pairing token')
      if (!res.ok) throw new Error(`The server responded with HTTP ${res.status}`)
      const body = (await res.json()) as IpcResult<RemoteInfo>
      if (!body.ok) throw new Error(body.error)
      if (body.data?.name !== 'binance-manager') throw new Error('That address is not a Binance Manager server')
      return body.data
    } catch (e) {
      if (ctrl.signal.aborted) throw new Error('Connection timed out')
      throw e
    } finally {
      clearTimeout(timer)
    }
  }

  connect(): void {
    this.closed = false
    this.open()
  }

  disconnect(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.removeAllListeners()
      ws.on('error', () => undefined)
      ws.close()
    }
    this.serverInfo = null
    if (this.connected) {
      this.connected = false
      this.onStatus()
    }
  }

  private fail(msg: string): void {
    if (this.lastError !== msg) {
      this.lastError = msg
      this.onStatus()
    }
  }

  private open(): void {
    if (this.closed || !this.url) return
    const ws = new WebSocket(`${this.url.replace(/^http/i, 'ws')}/events`, {
      headers: { authorization: `Bearer ${this.token}` }
    })
    this.ws = ws
    ws.on('open', () => {
      this.connected = true
      this.retry = 1000
      this.lastError = null
      this.onStatus()
    })
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(String(data)) as { channel: string; payload: unknown }
        this.lastEventAt = Date.now()
        if (msg.channel === 'remote:hello') {
          this.serverInfo = msg.payload as RemoteInfo
          this.onStatus()
          return
        }
        this.onEvent(msg.channel, msg.payload)
      } catch {
        /* ignore malformed frames */
      }
    })
    ws.on('error', (e) => {
      const m = e.message
      this.lastError = /401/.test(m) ? 'The server rejected the pairing token' : m
    })
    ws.on('close', () => {
      if (this.ws === ws) this.ws = null
      const was = this.connected
      this.connected = false
      if (was || this.lastError) this.onStatus()
      if (!this.closed) {
        this.timer = setTimeout(() => this.open(), this.retry)
        this.retry = Math.min(this.retry * 2, 30_000)
      }
    })
  }
}
