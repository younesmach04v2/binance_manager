import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KeyStatus } from '../../shared/types'
import type { ClientCredentials } from '../binance/client'
import { platform } from '../platform'

/**
 * API keys are encrypted by the host platform (OS keychain in the desktop app,
 * AES-256-GCM master key on the headless server) and never leave the process
 * that owns them.
 */
const keyFile = (): string => join(platform().userDir(), 'keys.bin')

export function encryptionAvailable(): boolean {
  return platform().encryptionAvailable()
}

export function saveKeys(apiKey: string, apiSecret: string): void {
  if (!encryptionAvailable()) {
    throw new Error('Encryption is not available; refusing to store API keys in plain text.')
  }
  const payload = JSON.stringify({ apiKey: apiKey.trim(), apiSecret: apiSecret.trim() })
  writeFileSync(keyFile(), platform().encrypt(payload), { mode: 0o600 })
}

export function loadKeys(): ClientCredentials | null {
  const file = keyFile()
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(platform().decrypt(readFileSync(file))) as ClientCredentials
    if (!parsed.apiKey || !parsed.apiSecret) return null
    return parsed
  } catch (e) {
    console.error('[secrets] failed to decrypt keys:', (e as Error).message)
    return null
  }
}

export function clearKeys(): void {
  const file = keyFile()
  if (existsSync(file)) unlinkSync(file)
}

export function keyStatus(): KeyStatus {
  const keys = loadKeys()
  return {
    hasKeys: !!keys,
    encryptionAvailable: encryptionAvailable(),
    apiKeyPreview: keys ? `${keys.apiKey.slice(0, 4)}…${keys.apiKey.slice(-4)}` : null
  }
}
