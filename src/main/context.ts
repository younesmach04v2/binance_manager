import { BinanceClient } from './binance/client'
import { platform } from './platform'
import { remote } from './remote'
import { db } from './store/db'
import { loadKeys } from './store/secrets'

let cached: { client: BinanceClient; testnet: boolean; keyFingerprint: string } | null = null

/** Returns a Binance client for the current settings and stored keys (cached until either changes). */
export function getClient(): BinanceClient {
  const settings = db.getSettings()
  const keys = loadKeys()
  const fingerprint = keys ? `${keys.apiKey}:${keys.apiSecret.length}` : 'none'
  if (!cached || cached.testnet !== settings.testnet || cached.keyFingerprint !== fingerprint) {
    cached = { client: new BinanceClient(keys, settings.testnet), testnet: settings.testnet, keyFingerprint: fingerprint }
  }
  return cached.client
}

export function invalidateClient(): void {
  cached = null
}

/** Send an event to this machine's own UI only (no-op on a headless server). */
export function sendToWindows(channel: string, payload?: unknown): void {
  platform().sendToWindows(channel, payload)
}

/** Send an event to the local UI and, in server mode, to every connected client. */
export function broadcast(channel: string, payload?: unknown): void {
  sendToWindows(channel, payload)
  remote.pushToClients(channel, payload)
}
