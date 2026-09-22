import { execFile } from 'node:child_process'
import { networkInterfaces } from 'node:os'
import { promisify } from 'node:util'
import type { IpcResult } from '../../shared/api'
import type { DiscoveredServer, RemoteInfo } from '../../shared/types'

/**
 * Finds a Binance Manager server on the local network, so a client does not
 * have to be told an address that DHCP keeps moving (a phone running the
 * server is the usual case).
 *
 * Every host on this machine's own /24 is asked for `GET /info` with the
 * pairing token. Only a server that answers with the right name counts, so a
 * random web server on the same port is never mistaken for one.
 */

const execFileAsync = promisify(execFile)

const PROBE_TIMEOUT_MS = 500
/** A tailnet peer may be several networks away, so give it longer than a LAN host. */
const PEER_TIMEOUT_MS = 4000

/** Where the Tailscale CLI usually lives, per platform. */
const TAILSCALE_BINARIES = [
  'tailscale',
  'C:/Program Files/Tailscale/tailscale.exe', // forward slashes: Windows accepts them and they survive escaping
  '/usr/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
]

/**
 * IPv4 addresses of the online machines on this machine's tailnet.
 *
 * A tailnet spreads its peers across a /10, so they cannot be swept for; but
 * the local Tailscale client already knows every one of them, and asking it
 * turns "search the network" into a handful of probes that work from any
 * network. Empty when Tailscale is not installed or not running.
 */
async function tailnetPeers(): Promise<string[]> {
  for (const bin of TAILSCALE_BINARIES) {
    try {
      const { stdout } = await execFileAsync(bin, ['status', '--json'], { timeout: 5000, maxBuffer: 8 << 20 })
      const parsed = JSON.parse(stdout) as { Peer?: Record<string, { TailscaleIPs?: string[]; Online?: boolean }> }
      const out: string[] = []
      for (const peer of Object.values(parsed.Peer ?? {})) {
        if (peer.Online === false) continue
        const v4 = (peer.TailscaleIPs ?? []).find((ip) => ip.includes('.'))
        if (v4) out.push(v4)
      }
      return out
    } catch {
      // Wrong path for this platform, or Tailscale is not running: try the next.
    }
  }
  return []
}
const BATCH = 64

/**
 * Tailscale and other CGNAT overlays hand out 100.64.0.0/10. Those peers are
 * scattered across a /10, so sweeping the /24 around our own address finds
 * nothing, and every probe would cross the tunnel on someone's mobile data.
 * A server reached that way is kept as a spare address instead.
 */
function isOverlay(parts: number[]): boolean {
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127
}

/** Every address on this machine's LAN /24 subnets, excluding our own. */
function candidates(): string[] {
  const out = new Set<string>()
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      const parts = a.address.split('.').map(Number)
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) continue
      if (isOverlay(parts)) continue
      // A /24 sweep covers home networks; a wider subnet still gets its own /24.
      const prefix = `${parts[0]}.${parts[1]}.${parts[2]}`
      for (let host = 1; host <= 254; host++) {
        if (host === parts[3]) continue
        out.add(`${prefix}.${host}`)
      }
    }
  }
  return [...out]
}

async function probe(host: string, port: number, token: string, timeoutMs = PROBE_TIMEOUT_MS, viaTailnet = false): Promise<DiscoveredServer | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const started = Date.now()
  try {
    const res = await fetch(`http://${host}:${port}/info`, {
      headers: { authorization: `Bearer ${token}` },
      signal: ctrl.signal
    })
    if (!res.ok) return null
    const body = (await res.json()) as IpcResult<RemoteInfo>
    if (!body.ok || body.data?.name !== 'binance-manager') return null
    return { ...body.data, url: `${host}:${port}`, viaTailnet, latencyMs: Date.now() - started }
  } catch {
    // Refused, unreachable or too slow: not a server we can use.
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Scan the LAN for servers that accept this token. Ports are tried in the
 * order given; the first port that answers on a host wins, so the usual
 * single-port scan stays at one probe per address.
 */
export async function discoverServers(token: string, ports: number[]): Promise<DiscoveredServer[]> {
  const trimmed = token.trim()
  if (!trimmed) throw new Error('Enter the pairing token first: it is what proves a server is yours.')
  const list = [...new Set(ports.filter((p) => Number.isInteger(p) && p > 0 && p < 65536))]
  if (list.length === 0) list.push(7777)

  const found: DiscoveredServer[] = []

  // Tailnet peers first: there are only a few, and unlike the LAN they are
  // reachable whatever network either machine is on.
  const peers = await tailnetPeers()
  const peerHits = await Promise.all(
    peers.map(async (host) => {
      for (const port of list) {
        const hit = await probe(host, port, trimmed, PEER_TIMEOUT_MS, true)
        if (hit) return hit
      }
      return null
    })
  )
  for (const hit of peerHits) if (hit) found.push(hit)

  const hosts = candidates()
  for (let i = 0; i < hosts.length; i += BATCH) {
    const batch = hosts.slice(i, i + BATCH)
    const results = await Promise.all(
      batch.map(async (host) => {
        for (const port of list) {
          const hit = await probe(host, port, trimmed)
          if (hit) return hit
        }
        return null
      })
    )
    for (const r of results) if (r) found.push(r)
  }
  // A tailnet address keeps working when the machines move apart, so offer it
  // first even though a LAN address will usually answer faster.
  return found.sort((a, b) => Number(b.viaTailnet) - Number(a.viaTailnet) || a.latencyMs - b.latencyMs)
}
