/**
 * The few things the services need from the host: where to store data, how
 * to encrypt the API keys, how to reach the UI. The Electron app and the
 * headless server each plug in their own implementation at startup, so every
 * service module stays free of Electron imports.
 */
export interface Platform {
  name: 'electron' | 'node'
  version(): string
  /** Root folder for this app's files (data/ lives inside, keys.bin next to it). */
  userDir(): string
  encryptionAvailable(): boolean
  encrypt(text: string): Buffer
  decrypt(data: Buffer): string
  /** Deliver an event to this machine's own UI windows (no-op when headless). */
  sendToWindows(channel: string, payload?: unknown): void
  openExternal(url: string): Promise<void>
}

let current: Platform | null = null

export function setPlatform(p: Platform): void {
  current = p
}

export function platform(): Platform {
  if (!current) throw new Error('Platform not initialised: call setPlatform() at startup')
  return current
}
