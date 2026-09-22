import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { WebSocket, WebSocketServer } from 'ws'
import type { IpcResult } from '../../shared/api'
import type { RemoteInfo } from '../../shared/types'

/**
 * Exposes the app's command layer to other copies of the app on the network.
 *
 *   POST /rpc     { channel, args }  -> IpcResult   (same handlers the local UI uses)
 *   GET  /info                       -> server identity
 *   WS   /events                     -> pushes { channel, payload } for every broadcast
 *
 * Every request needs `Authorization: Bearer <pairing token>`. Ten wrong tokens
 * from one address block it for ten minutes.
 */

export interface ServerDeps {
  invoke(channel: string, args: unknown[]): Promise<IpcResult<unknown>>
  isRemoteChannel(channel: string): boolean
  info(): RemoteInfo
  /** Called when a client connects or disconnects. */
  onClientsChanged?: () => void
}

const MAX_BODY = 1_000_000
const MAX_FAILURES = 10
const BLOCK_MS = 10 * 60_000

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length === 0 || ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

// Browser-based clients (the Android app's WebView) call from another origin; auth is the bearer token, so any origin may ask.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-max-age': '600'
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(status, { ...CORS, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) })
  res.end(data)
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('Body too large'))
        req.destroy()
      } else {
        chunks.push(c)
      }
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export class RemoteServer {
  private http: Server | null = null
  private wss: WebSocketServer | null = null
  private sockets = new Set<WebSocket>()
  private failures = new Map<string, { n: number; until: number }>()
  private token = ''
  port = 0
  error: string | null = null

  constructor(private readonly deps: ServerDeps) {}

  get running(): boolean {
    return this.http !== null && this.http.listening
  }

  get clientCount(): number {
    return this.sockets.size
  }

  /** LAN IPv4 addresses a client can use. */
  addresses(): string[] {
    const out: string[] = []
    for (const list of Object.values(networkInterfaces())) {
      for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address)
    }
    return out
  }

  async start(port: number, token: string): Promise<void> {
    await this.stop()
    this.token = token
    this.error = null

    const http = createServer((req, res) => {
      this.handle(req, res).catch((e) => json(res, 500, { ok: false, error: (e as Error).message }))
    })
    const wss = new WebSocketServer({ noServer: true })
    http.on('upgrade', (req, socket, head) => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname
      if (path !== '/events' || !this.authorized(req)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const drop = (): void => {
          if (this.sockets.delete(ws)) this.deps.onClientsChanged?.()
        }
        this.sockets.add(ws)
        ws.on('close', drop)
        ws.on('error', drop)
        ws.send(JSON.stringify({ channel: 'remote:hello', payload: this.deps.info() }))
        this.deps.onClientsChanged?.()
      })
    })

    await new Promise<void>((resolve, reject) => {
      const onError = (e: Error): void => reject(e)
      http.once('error', onError)
      http.listen(port, '0.0.0.0', () => {
        http.off('error', onError)
        resolve()
      })
    }).catch((e: Error) => {
      this.error = e.message.includes('EADDRINUSE') ? `Port ${port} is already in use` : e.message
      throw e
    })
    http.on('error', (e) => {
      this.error = e.message
    })
    this.http = http
    this.wss = wss
    this.port = port
  }

  async stop(): Promise<void> {
    for (const ws of this.sockets) ws.close(1001, 'server stopping')
    this.sockets.clear()
    this.wss?.close()
    this.wss = null
    const http = this.http
    this.http = null
    if (http) {
      http.closeAllConnections()
      await new Promise<void>((r) => http.close(() => r()))
    }
  }

  /** Send an event to every connected client. */
  push(channel: string, payload: unknown): void {
    if (this.sockets.size === 0) return
    const msg = JSON.stringify({ channel, payload })
    for (const ws of this.sockets) if (ws.readyState === WebSocket.OPEN) ws.send(msg)
  }

  private authorized(req: IncomingMessage): boolean {
    const ip = req.socket.remoteAddress ?? 'unknown'
    const f = this.failures.get(ip)
    if (f && f.until > Date.now()) return false
    const header = req.headers.authorization ?? ''
    let presented = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    // Browser WebSockets cannot send headers, so the events upgrade may carry the token as ?token=
    if (!presented && req.headers.upgrade) {
      presented = new URL(req.url ?? '/', 'http://localhost').searchParams.get('token') ?? ''
    }
    const ok = safeEqual(presented, this.token)
    if (ok) {
      this.failures.delete(ip)
      return true
    }
    const n = (f?.n ?? 0) + 1
    this.failures.set(ip, { n, until: n >= MAX_FAILURES ? Date.now() + BLOCK_MS : 0 })
    return false
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'OPTIONS') {
      // CORS preflight carries no Authorization header; it only asks what is allowed.
      res.writeHead(204, CORS)
      res.end()
      return
    }
    if (!this.authorized(req)) return json(res, 401, { ok: false, error: 'Unauthorized' })
    const path = new URL(req.url ?? '/', 'http://localhost').pathname

    if (req.method === 'GET' && path === '/info') return json(res, 200, { ok: true, data: this.deps.info() })

    if (req.method === 'POST' && path === '/rpc') {
      let body: { channel?: unknown; args?: unknown }
      try {
        body = JSON.parse(await readBody(req, MAX_BODY)) as { channel?: unknown; args?: unknown }
      } catch (e) {
        return json(res, 400, { ok: false, error: `Bad request: ${(e as Error).message}` })
      }
      const channel = typeof body.channel === 'string' ? body.channel : ''
      if (!this.deps.isRemoteChannel(channel)) return json(res, 404, { ok: false, error: `Unknown channel ${channel}` })
      const result = await this.deps.invoke(channel, Array.isArray(body.args) ? body.args : [])
      return json(res, 200, result)
    }

    json(res, 404, { ok: false, error: 'Not found' })
  }
}
