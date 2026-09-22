import { randomBytes } from 'node:crypto'
import type { IpcResult } from '../../shared/api'
import type { DiscoveredServer, RemoteConfig, RemoteInfo, RemoteStatus, RemoteTestResult } from '../../shared/types'
import { JsonStore } from '../store/db'
import { normalizeUrl, RemoteClient } from './client'
import { discoverServers } from './discover'
import { RemoteServer } from './server'

export interface RemoteDeps {
  invoke(channel: string, args: unknown[]): Promise<IpcResult<unknown>>
  isRemoteChannel(channel: string): boolean
  info(): RemoteInfo
  /** Deliver an event to this machine's own windows. */
  onEvent(channel: string, payload: unknown): void
}

/** Per-channel request timeouts when forwarding to a server. */
const TIMEOUTS: Record<string, number> = {
  'trades:sync': 15 * 60_000,
  'rtrade:open': 90_000,
  'rtrade:close': 90_000,
  'rtrade:moveBE': 90_000,
  'rtrade:reduce': 90_000,
  'positions:reduce': 90_000,
  'portfolio:get': 60_000,
  'analytics:get': 60_000
}
const DEFAULT_TIMEOUT = 30_000

// This file is never forwarded: each machine decides for itself whether it is a server or a client.
const store = new JsonStore<RemoteConfig>('remote.json', () => ({
  mode: 'standalone',
  server: { port: 7777, token: '' },
  client: { url: '', altUrls: [], token: '' }
}))

const newToken = (): string => randomBytes(24).toString('hex')

/** How often a disconnected client may sweep the network looking for its server. */
const REDISCOVER_EVERY_MS = 60_000
/** A spare address only has to answer quickly; it is a probe, not a connection. */
const ALT_PROBE_MS = 2500

/** Normalised, de-duplicated spare addresses, never repeating the one in use. */
function cleanAlts(list: unknown, current: string): string[] {
  const seen = new Set<string>()
  for (const raw of Array.isArray(list) ? list : []) {
    const u = normalizeUrl(String(raw ?? ''))
    if (u && u !== current) seen.add(u)
  }
  return [...seen]
}

class RemoteManager {
  private deps: RemoteDeps | null = null
  private server: RemoteServer | null = null
  private client: RemoteClient | null = null
  private rediscovering = false
  private lastRediscoverAt = 0

  getConfig(): RemoteConfig {
    const cfg = store.get()
    if (!cfg.server.token) store.set({ ...cfg, server: { ...cfg.server, token: newToken() } })
    return store.get()
  }

  mode(): RemoteConfig['mode'] {
    return store.get().mode
  }

  async start(deps: RemoteDeps): Promise<void> {
    this.deps = deps
    this.server = new RemoteServer({ ...deps, onClientsChanged: () => this.emitStatus() })
    this.client = new RemoteClient(
      (channel, payload) => deps.onEvent(channel, payload),
      () => {
        this.emitStatus()
        void this.maybeRediscover()
      }
    )
    await this.apply()
  }

  async stop(): Promise<void> {
    await this.server?.stop()
    this.client?.disconnect()
  }

  private async apply(): Promise<void> {
    if (!this.server || !this.client) return
    const cfg = this.getConfig()
    if (cfg.mode === 'server') {
      this.client.disconnect()
      try {
        await this.server.start(cfg.server.port, cfg.server.token)
        console.log(`[remote] serving on port ${cfg.server.port}`)
      } catch (e) {
        console.error('[remote] server failed to start:', (e as Error).message)
      }
    } else if (cfg.mode === 'client') {
      await this.server.stop()
      this.client.disconnect()
      this.client.configure(cfg.client.url, cfg.client.token)
      this.client.connect()
    } else {
      await this.server.stop()
      this.client.disconnect()
    }
    this.emitStatus()
  }

  /**
   * A server on a phone or laptop gets a new DHCP address every so often, which
   * would otherwise mean editing the address by hand. When the connection has
   * been down for a while, look for the same server elsewhere on the network
   * and move to it. Throttled, and skipped when the token is the problem,
   * since no amount of searching fixes that.
   */
  private async maybeRediscover(): Promise<void> {
    if (this.rediscovering) return
    const cfg = store.get()
    if (cfg.mode !== 'client' || !cfg.client.token) return
    if (!this.client || this.client.connected) return
    if (/token/i.test(this.client.lastError ?? '')) return
    if (Date.now() - this.lastRediscoverAt < REDISCOVER_EVERY_MS) return

    this.rediscovering = true
    this.lastRediscoverAt = Date.now()
    try {
      // A spare address is three probes, a network sweep is 254, so try the spares first.
      const viaAlt = await this.firstAlive(cfg.client.altUrls, cfg.client.token)
      if (viaAlt) {
        await this.moveTo(viaAlt, 'spare address')
        return
      }
      const hits = await this.discover(cfg.client.token)
      const moved = hits.find((h) => normalizeUrl(h.url) !== normalizeUrl(cfg.client.url))
      if (!moved) return
      await this.moveTo(normalizeUrl(moved.url), 'network search')
    } catch (e) {
      console.warn('[remote] rediscovery failed:', (e as Error).message)
    } finally {
      this.rediscovering = false
    }
  }

  /** The first of these addresses that answers as our server, or null. */
  private async firstAlive(urls: string[], token: string): Promise<string | null> {
    for (const url of urls) {
      try {
        await RemoteClient.info(url, token, ALT_PROBE_MS)
        return normalizeUrl(url)
      } catch {
        // Unreachable from this network right now; try the next one.
      }
    }
    return null
  }

  /** Switch to another address, keeping the old one as a spare for when we move back. */
  private async moveTo(url: string, why: string): Promise<void> {
    const cfg = store.get()
    if (normalizeUrl(cfg.client.url) === url) return
    console.log(`[remote] reaching the server at ${url} (${why}); reconnecting`)
    store.set({
      ...cfg,
      client: { ...cfg.client, url, altUrls: cleanAlts([cfg.client.url, ...cfg.client.altUrls], url) }
    })
    await this.apply()
  }

  async setConfig(patch: Partial<RemoteConfig>): Promise<RemoteConfig> {
    const cur = this.getConfig()
    const next: RemoteConfig = {
      mode: patch.mode ?? cur.mode,
      server: { ...cur.server, ...(patch.server ?? {}) },
      client: { ...cur.client, ...(patch.client ?? {}) }
    }
    next.server.port = Math.min(65535, Math.max(1, Math.round(Number(next.server.port) || 7777)))
    next.client.url = normalizeUrl(String(next.client.url ?? ''))
    next.client.altUrls = cleanAlts(next.client.altUrls, next.client.url)
    next.client.token = String(next.client.token ?? '').trim()
    store.set(next)
    await this.apply()
    return next
  }

  async regenerateToken(): Promise<RemoteConfig> {
    const cur = this.getConfig()
    store.set({ ...cur, server: { ...cur.server, token: newToken() } })
    await this.apply()
    return this.getConfig()
  }

  status(): RemoteStatus {
    const cfg = this.getConfig()
    return {
      mode: cfg.mode,
      server:
        cfg.mode === 'server' && this.server
          ? {
              running: this.server.running,
              port: cfg.server.port,
              addresses: this.server.addresses(),
              clients: this.server.clientCount,
              error: this.server.error
            }
          : null,
      client:
        cfg.mode === 'client' && this.client
          ? {
              connected: this.client.connected,
              url: cfg.client.url,
              lastError: this.client.lastError,
              serverVersion: this.client.serverInfo?.version ?? null,
              serverTestnet: this.client.serverInfo?.testnet ?? null,
              serverMetered: this.client.serverInfo?.metered ?? null,
              lastEventAt: this.client.lastEventAt
            }
          : null
    }
  }

  async test(url: string, token: string): Promise<RemoteTestResult> {
    const t = Date.now()
    const info = await RemoteClient.info(url, token)
    return { ...info, latencyMs: Date.now() - t }
  }

  /**
   * Look for servers on this machine's network. Tries the port already
   * configured here before the default, so an unusual port still gets found.
   */
  async discover(token: string, ports?: number[]): Promise<DiscoveredServer[]> {
    const cfg = store.get()
    const configured = Number(new URL(normalizeUrl(cfg.client.url) || 'http://x:7777').port || 7777)
    const list = ports?.length ? ports : [configured, cfg.server.port, 7777]
    return discoverServers(token.trim() || cfg.client.token, list)
  }

  /** Forward a command to the server (client mode). */
  call(channel: string, args: unknown[]): Promise<IpcResult<unknown>> {
    if (!this.client) return Promise.resolve({ ok: false, error: 'Remote client is not started' })
    return this.client.call(channel, args, TIMEOUTS[channel] ?? DEFAULT_TIMEOUT)
  }

  /** Push an event to connected clients (server mode); no-op otherwise. */
  pushToClients(channel: string, payload: unknown): void {
    this.server?.push(channel, payload)
  }

  private emitStatus(): void {
    this.deps?.onEvent('remote:status', this.status())
  }
}

export const remote = new RemoteManager()
