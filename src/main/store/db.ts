import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SETTINGS } from '../../shared/defaults'
import type { Bot, BotLogEntry, JournalEntry, ManagedTrade, Settings, Trade, ValuePoint } from '../../shared/types'
import { platform } from '../platform'

export { DEFAULT_SETTINGS }

export function dataDir(): string {
  const dir = join(platform().userDir(), 'data')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** Tiny JSON-file backed store with an in-memory cache and atomic writes. */
export class JsonStore<T> {
  private cache: T | undefined

  constructor(
    private readonly file: string,
    private readonly defaults: () => T
  ) {}

  private path(): string {
    return join(dataDir(), this.file)
  }

  get(): T {
    if (this.cache === undefined) {
      const p = this.path()
      if (existsSync(p)) {
        try {
          this.cache = JSON.parse(readFileSync(p, 'utf8')) as T
        } catch (e) {
          console.error(`[db] failed to read ${p}:`, e)
        }
      }
      if (this.cache === undefined) this.cache = this.defaults()
    }
    return this.cache
  }

  set(value: T): void {
    this.cache = value
    const p = this.path()
    const tmp = `${p}.tmp`
    writeFileSync(tmp, JSON.stringify(value))
    renameSync(tmp, p)
  }

  update(fn: (current: T) => T): T {
    const next = fn(this.get())
    this.set(next)
    return next
  }
}

const envStores = new Map<string, JsonStore<unknown>>()

function envStore<T>(name: string, testnet: boolean, defaults: () => T): JsonStore<T> {
  const key = `${name}-${testnet ? 'testnet' : 'live'}.json`
  let store = envStores.get(key) as JsonStore<T> | undefined
  if (!store) {
    store = new JsonStore<T>(key, defaults)
    envStores.set(key, store as JsonStore<unknown>)
  }
  return store
}

const settingsStore = new JsonStore<Partial<Settings>>('settings.json', () => ({}))

export const db = {
  getSettings(): Settings {
    const stored = settingsStore.get()
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      quickTrade: { ...DEFAULT_SETTINGS.quickTrade, ...(stored.quickTrade ?? {}) }
    }
  },
  setSettings(patch: Partial<Settings>): Settings {
    settingsStore.update((s) => ({ ...s, ...patch }))
    return db.getSettings()
  },
  /** Trades keyed by symbol. Live and testnet accounts are stored separately. */
  trades: (testnet: boolean) => envStore<Record<string, Trade[]>>('trades', testnet, () => ({})),
  /** Journal entries keyed by trade id (as string). */
  journal: (testnet: boolean) => envStore<Record<string, JournalEntry>>('journal', testnet, () => ({})),
  bots: (testnet: boolean) => envStore<Bot[]>('bots', testnet, () => []),
  /** R-multiple quick trades managed by the app (SL/TP + break-even ladder). */
  managed: (testnet: boolean) => envStore<ManagedTrade[]>('managed', testnet, () => []),
  botLog: (testnet: boolean) => envStore<BotLogEntry[]>('botlog', testnet, () => []),
  history: (testnet: boolean) => envStore<ValuePoint[]>('history', testnet, () => [])
}
