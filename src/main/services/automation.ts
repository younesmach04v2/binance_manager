import { randomUUID } from 'node:crypto'
import type { Bot, BotLogEntry, DcaBot, PriceRuleBot } from '../../shared/types'
import type { BinanceClient } from '../binance/client'
import { broadcast, getClient } from '../context'
import { remote } from '../remote'
import { db } from '../store/db'
import { placeOrder } from './orders'
import { isOpenTrade, tickManagedTrades } from './rtrade'

const TICK_MS = 15_000
const RETRY_MS = 15 * 60_000

/**
 * Runs enabled bots on a timer inside the main process. Bots only act while
 * the global automation switch in Settings is on and API keys are present.
 * A bot in dry-run mode logs what it would do instead of placing orders.
 */
class AutomationEngine {
  private timer: NodeJS.Timeout | null = null
  private running = false

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      // A client machine never trades on its own; the server it is connected to runs the bots and ladders.
      if (remote.mode() === 'client') return
      const settings = db.getSettings()
      const client = getClient()
      if (!client.hasCredentials) return

      // Quick-trade positions (SL/TP + break-even) are always watched; they are not bots.
      const hasManaged = db.managed(settings.testnet).get().some(isOpenTrade)
      const active = settings.automationEnabled ? db.bots(settings.testnet).get().filter((b) => b.enabled) : []
      const rules = active.filter((b): b is PriceRuleBot => b.type === 'PRICE_RULE')
      if (!hasManaged && active.length === 0) return

      let prices: Map<string, number> | null = null
      if (rules.length || hasManaged) {
        try {
          prices = await client.allPrices()
        } catch (e) {
          console.warn('[automation] price fetch failed:', (e as Error).message)
        }
      }

      if (hasManaged) {
        try {
          await tickManagedTrades(client, settings.testnet, prices)
        } catch (e) {
          console.error('[automation] managed trades tick failed:', e)
        }
      }
      if (active.length === 0) return

      const now = Date.now()
      for (const bot of active) {
        if (bot.type === 'DCA') {
          if (now >= bot.nextRunAt) await this.runDca(bot, client, settings.testnet)
        } else if (prices) {
          const p = prices.get(bot.symbol)
          if (p !== undefined) await this.evalRule(bot, p, client, settings.testnet, false)
        }
      }
    } catch (e) {
      console.error('[automation] tick failed:', e)
    } finally {
      this.running = false
    }
  }

  /** Execute a bot immediately, ignoring its schedule or trigger condition. */
  async runNow(id: string): Promise<void> {
    const settings = db.getSettings()
    const bot = db.bots(settings.testnet).get().find((b) => b.id === id)
    if (!bot) throw new Error('Bot not found')
    const client = getClient()
    if (!client.hasCredentials) throw new Error('API keys are not configured')
    if (bot.type === 'DCA') {
      await this.runDca(bot, client, settings.testnet)
    } else {
      const price = (await client.allPrices()).get(bot.symbol)
      if (price === undefined) throw new Error(`No price for ${bot.symbol}`)
      await this.evalRule(bot, price, client, settings.testnet, true)
    }
  }

  private save(testnet: boolean, bot: Bot): void {
    db.bots(testnet).update((list) => list.map((b) => (b.id === bot.id ? bot : b)))
    broadcast('bots:changed')
  }

  private log(testnet: boolean, bot: Bot, level: BotLogEntry['level'], message: string): void {
    const entry: BotLogEntry = {
      id: randomUUID(),
      botId: bot.id,
      botName: bot.name,
      time: Date.now(),
      level,
      message
    }
    db.botLog(testnet).update((list) => [...list, entry].slice(-2000))
    broadcast('bot:log', entry)
  }

  private async runDca(bot: DcaBot, client: BinanceClient, testnet: boolean): Promise<void> {
    const now = Date.now()
    const next: DcaBot = { ...bot }
    try {
      if (bot.dryRun) {
        this.log(testnet, bot, 'info', `DRY RUN: would market-buy ${bot.quoteAmount} of ${bot.symbol}`)
      } else {
        const res = await placeOrder(client, {
          symbol: bot.symbol,
          side: 'BUY',
          type: 'MARKET',
          quoteOrderQty: bot.quoteAmount
        })
        const o = res.orders[0]
        const avg = o && o.executedQty > 0 ? o.cummulativeQuoteQty / o.executedQty : 0
        this.log(
          testnet,
          bot,
          'info',
          `Bought ${o?.executedQty ?? '?'} ${bot.symbol} for ${o?.cummulativeQuoteQty.toFixed(2) ?? bot.quoteAmount} (avg ${avg.toPrecision(6)}), order #${o?.orderId ?? '?'}`
        )
      }
      next.runsCompleted = bot.runsCompleted + 1
      next.lastRunAt = now
      next.lastError = null
      next.nextRunAt = now + bot.intervalHours * 3_600_000
      if (bot.maxRuns !== null && next.runsCompleted >= bot.maxRuns) {
        next.enabled = false
        this.log(testnet, bot, 'info', `Completed all ${bot.maxRuns} runs; bot disabled`)
      }
    } catch (e) {
      const msg = (e as Error).message
      next.lastError = msg
      next.nextRunAt = now + RETRY_MS
      this.log(testnet, bot, 'error', `Buy failed: ${msg}. Retrying in 15 minutes.`)
    }
    this.save(testnet, next)
  }

  private async evalRule(
    bot: PriceRuleBot,
    price: number,
    client: BinanceClient,
    testnet: boolean,
    force: boolean
  ): Promise<void> {
    const hit = bot.condition === 'ABOVE' ? price >= bot.triggerPrice : price <= bot.triggerPrice
    if (!hit && !force) return

    const now = Date.now()
    const next: PriceRuleBot = { ...bot, enabled: false, lastRunAt: now }
    const desc = `${bot.action.side} ${bot.action.quantity ? `${bot.action.quantity} ${bot.symbol}` : `${bot.action.quoteOrderQty} worth of ${bot.symbol}`}`
    try {
      const why = force ? 'manual run' : `price ${price} is ${bot.condition.toLowerCase()} ${bot.triggerPrice}`
      if (bot.dryRun) {
        this.log(testnet, bot, 'info', `DRY RUN (${why}): would market ${desc}`)
      } else {
        const res = await placeOrder(client, {
          symbol: bot.symbol,
          side: bot.action.side,
          type: 'MARKET',
          quantity: bot.action.quantity,
          quoteOrderQty: bot.action.quoteOrderQty
        })
        const o = res.orders[0]
        this.log(
          testnet,
          bot,
          'info',
          `Triggered (${why}): ${bot.action.side} ${o?.executedQty ?? '?'} ${bot.symbol} for ${o?.cummulativeQuoteQty.toFixed(2) ?? '?'}, order #${o?.orderId ?? '?'}`
        )
      }
      next.triggered = true
      next.triggeredAt = now
      next.lastError = null
    } catch (e) {
      const msg = (e as Error).message
      next.lastError = msg
      this.log(testnet, bot, 'error', `Rule fired but the order failed: ${msg}. Bot disabled.`)
    }
    this.save(testnet, next)
  }
}

export const automation = new AutomationEngine()
