import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Platform } from './index'

declare const __APP_VERSION__: string

/**
 * Headless server (plain Node, no window). Keys are encrypted with AES-256-GCM
 * under a key that comes from BINANCE_MANAGER_PASSPHRASE if set, otherwise from
 * a random master.key file created next to the data (owner-only permissions on
 * Linux/macOS). Data lives in BINANCE_MANAGER_DATA or ~/.binance-manager.
 */
const MAGIC = Buffer.from('BM1')

function userDir(): string {
  const dir = process.env.BINANCE_MANAGER_DATA || join(homedir(), '.binance-manager')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

let cachedKey: Buffer | null = null
function masterKey(): Buffer {
  if (cachedKey) return cachedKey
  const pass = process.env.BINANCE_MANAGER_PASSPHRASE
  if (pass) {
    cachedKey = scryptSync(pass, 'binance-manager-v1', 32)
    return cachedKey
  }
  const file = join(userDir(), 'master.key')
  if (!existsSync(file)) writeFileSync(file, randomBytes(32), { mode: 0o600 })
  cachedKey = readFileSync(file)
  if (cachedKey.length !== 32) throw new Error(`${file} is corrupt (expected 32 bytes)`)
  return cachedKey
}

export const nodePlatform: Platform = {
  name: 'node',
  version: () => (typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'),
  userDir,
  encryptionAvailable: () => true,
  encrypt: (text) => {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', masterKey(), iv)
    const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
    return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body])
  },
  decrypt: (data) => {
    if (!data.subarray(0, 3).equals(MAGIC)) {
      throw new Error('keys.bin was not written by the headless server (it may come from the desktop app, which uses the OS keychain)')
    }
    const iv = data.subarray(3, 15)
    const tag = data.subarray(15, 31)
    const body = data.subarray(31)
    const decipher = createDecipheriv('aes-256-gcm', masterKey(), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  },
  sendToWindows: () => undefined,
  openExternal: async () => {
    throw new Error('No browser on a headless server')
  }
}
