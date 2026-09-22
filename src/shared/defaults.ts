import type { Settings } from './types'

/** Default settings, shared by the server (persisted store) and clients (fallback while the server is unreachable). */
export const DEFAULT_SETTINGS: Settings = {
  testnet: false,
  quoteAsset: 'USDT',
  watchlist: ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT'],
  trackedSymbols: [],
  refreshIntervalSec: 30,
  automationEnabled: false,
  hideDustBelow: 1,
  quickTrade: {
    riskQuote: 10,
    riskPct: 1,
    includeFunding: true,
    excludeOpenPositions: false,
    sizingMode: 'risk',
    beTriggerR: 1,
    beOffsetPct: 0,
    stopGapPct: 1,
    partialPct: 50,
    trailStartR: 3,
    trailGapR: 2
  }
}
