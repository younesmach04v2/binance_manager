/**
 * Discovery tool for the Binance Stocks (/sapi/v1/equity/*) API.
 *
 * READ-ONLY BY CONSTRUCTION: every path in this file is a GET query endpoint.
 * Nothing here places, cancels, mints or redeems anything. The mutating
 * endpoints (order/place, order/cancel, tokenized/mint, tokenized/redeem) are
 * listed in MUTATING below purely so they are documented and explicitly skipped.
 *
 * Your keys never leave your machine and are never written to a file:
 *
 *   PowerShell:
 *     $env:BINANCE_API_KEY="..."; $env:BINANCE_API_SECRET="..."
 *     node scripts/discover-stocks-api.mjs
 *
 *   bash:
 *     BINANCE_API_KEY=... BINANCE_API_SECRET=... node scripts/discover-stocks-api.mjs
 *
 * Use a READ-ONLY key if you can (Enable Reading only, Spot trading off).
 *
 * The point is the error messages: Binance answers a missing parameter by
 * naming it, so calling each endpoint bare reveals its required parameters.
 */
import { createHmac } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

/** Env vars if set, otherwise just ask. Either way the keys stay on this machine. */
async function credentials() {
  if (process.env.BINANCE_API_KEY && process.env.BINANCE_API_SECRET) {
    return [process.env.BINANCE_API_KEY, process.env.BINANCE_API_SECRET]
  }
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    console.log('Paste your Binance API key and secret. They are used only for this run and never saved.\n')
    const key = (await rl.question('API key:    ')).trim()
    const secret = (await rl.question('API secret: ')).trim()
    if (!key || !secret) {
      console.error('\nBoth are required.')
      process.exit(1)
    }
    return [key, secret]
  } finally {
    rl.close()
  }
}

const [KEY, SECRET] = await credentials()

const BASE = 'https://api.binance.com'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Documented here so it is unmistakable that we never call them. */
const MUTATING = [
  'POST /sapi/v1/equity/order/place',
  'POST /sapi/v1/equity/order/cancel',
  'POST /sapi/v1/equity/order/cancel-all',
  'POST /sapi/v1/equity/tokenized/mint',
  'POST /sapi/v1/equity/tokenized/redeem'
]

/** Confirmed to exist (they answered -2014 unauthenticated), all GET. */
const CONFIRMED = [
  '/sapi/v1/equity/market/quote',
  '/sapi/v1/equity/order/open-orders',
  '/sapi/v1/equity/order/detail',
  '/sapi/v1/equity/order/history',
  '/sapi/v1/equity/trade/history',
  '/sapi/v1/equity/tokenized/convert-status',
  '/sapi/v1/equity/tokenized/history'
]

/** Candidates for the ~11 endpoints still unaccounted for. All GET. */
const CANDIDATES = [
  '/sapi/v1/equity/account/info',
  '/sapi/v1/equity/account/balance',
  '/sapi/v1/equity/account/detail',
  '/sapi/v1/equity/account/summary',
  '/sapi/v1/equity/asset/balance',
  '/sapi/v1/equity/asset/list',
  '/sapi/v1/equity/position/list',
  '/sapi/v1/equity/position/detail',
  '/sapi/v1/equity/holding/list',
  '/sapi/v1/equity/market/symbols',
  '/sapi/v1/equity/market/instruments',
  '/sapi/v1/equity/market/list',
  '/sapi/v1/equity/market/kline',
  '/sapi/v1/equity/market/klines',
  '/sapi/v1/equity/market/depth',
  '/sapi/v1/equity/market/ticker',
  '/sapi/v1/equity/market/detail',
  '/sapi/v1/equity/market/session',
  '/sapi/v1/equity/market/schedule',
  '/sapi/v1/equity/market/status',
  '/sapi/v1/equity/market/trading-session',
  '/sapi/v1/equity/symbol/list',
  '/sapi/v1/equity/symbol/detail',
  '/sapi/v1/equity/instrument/list',
  '/sapi/v1/equity/config/list',
  '/sapi/v1/equity/session/current',
  '/sapi/v1/equity/session/schedule',
  '/sapi/v1/equity/trade/detail',
  '/sapi/v1/equity/order/list',
  // Sessions matter here: the Stocks page shows pre-market / market-open /
  // post-market / overnight, and market orders are typically limit-only outside
  // regular hours. Whichever endpoint reports the current session decides
  // whether the app may use MARKET at all.
  '/sapi/v1/equity/market/trading-hours',
  '/sapi/v1/equity/market/trading-schedule',
  '/sapi/v1/equity/trading/session',
  '/sapi/v1/equity/trading/schedule',
  '/sapi/v1/equity/common/session',
  '/sapi/v1/equity/common/config',
  '/sapi/v1/equity/market/exchange-info',
  '/sapi/v1/equity/market/instrument'
]

function signed(params = {}) {
  const q = new URLSearchParams({ ...params, timestamp: String(Date.now()), recvWindow: '10000' }).toString()
  return `${q}&signature=${createHmac('sha256', SECRET).update(q).digest('hex')}`
}

async function call(path, params = {}) {
  const res = await fetch(`${BASE}${path}?${signed(params)}`, { headers: { 'X-MBX-APIKEY': KEY } })
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: res.status, body }
}

const short = (b) => {
  const s = typeof b === 'string' ? b : JSON.stringify(b)
  return s.length > 400 ? `${s.slice(0, 400)}…` : s
}

async function main() {
  console.log('Binance Stocks API discovery — read-only.\nSkipping these mutating endpoints entirely:')
  for (const m of MUTATING) console.log(`  skip  ${m}`)

  console.log('\n================ CONFIRMED ENDPOINTS (bare call reveals required params) ================')
  for (const p of CONFIRMED) {
    const r = await call(p)
    console.log(`\nGET ${p}\n  ${r.status}  ${short(r.body)}`)
    await sleep(250)
  }

  // The instrument id is EQ_AAPL, taken from the Stocks page URL
  // (binance.com/en/stocks/EQ_AAPL). Try that first, then fallbacks, and try the
  // parameter under several names since we do not know what it is called yet.
  console.log('\n================ SYMBOL FORM PROBE on market/quote ================')
  for (const field of ['symbol', 'symbols', 'instrumentId', 'equitySymbol', 'stockSymbol']) {
    for (const sym of ['EQ_AAPL', 'AAPL', 'EQ_AAPL_USDC']) {
      const r = await call('/sapi/v1/equity/market/quote', { [field]: sym })
      console.log(`  ${field}=${String(sym).padEnd(13)} ${r.status}  ${short(r.body)}`)
      await sleep(220)
    }
  }

  console.log('\n================ HUNTING THE REMAINING ENDPOINTS ================')
  const found = []
  for (const p of CANDIDATES) {
    const r = await call(p)
    if (r.status !== 404) {
      found.push(p)
      console.log(`  FOUND ${String(r.status).padEnd(4)} ${p}\n        ${short(r.body)}`)
    }
    await sleep(200)
  }
  if (!found.length) console.log('  (none of the candidates existed)')

  console.log('\n================ SUMMARY ================')
  console.log(`confirmed queried: ${CONFIRMED.length}`)
  console.log(`new endpoints found: ${found.length}`)
  for (const f of found) console.log(`  ${f}`)
  console.log('\nPaste this whole output back into Claude Code.')
}

main().catch((e) => {
  console.error('failed:', e.message)
  process.exit(1)
})
