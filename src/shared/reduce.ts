import type { ReduceBy } from './types'

/**
 * Turning a reduction request into a quantity, shared by the server that
 * places the order and the UI that previews it, so the confirmation dialog
 * and the order can never disagree about what "5 of risk" means.
 */

export interface ReduciblePosition {
  qty: number
  price: number
  entry: number | null
  stop: number | null
}

/**
 * `risk` divides by the distance from entry to stop: taking 5 USDT of risk off
 * a position whose stop sits 0.02 below entry means selling 250 units. Once
 * the stop is at or above entry the position can no longer lose, so there is
 * no risk to remove and the request is refused rather than quietly treated as
 * something else.
 */
export function quantityFor(by: ReduceBy, pos: ReduciblePosition): number {
  switch (by.mode) {
    case 'pct':
      return by.value >= 100 ? pos.qty : (pos.qty * by.value) / 100
    case 'qty':
      return by.value
    case 'quote':
      if (!(pos.price > 0)) throw new Error('No price for this symbol yet, so an amount cannot be converted to a quantity.')
      return by.value / pos.price
    case 'risk': {
      if (pos.entry === null || pos.stop === null) {
        throw new Error('This position has no known entry and stop, so risk cannot be measured. Reduce by percent, quantity or amount.')
      }
      const perUnit = pos.entry - pos.stop
      if (perUnit <= 0) {
        throw new Error('The stop is at or above entry, so there is no risk left to take off. Reduce by percent, quantity or amount.')
      }
      return by.value / perUnit
    }
  }
}

/** How the reduction was asked for, for confirmations and the position log. */
export function describeReduce(by: ReduceBy): string {
  switch (by.mode) {
    case 'pct':
      return `${by.value}%`
    case 'qty':
      return `${by.value} units`
    case 'quote':
      return `${by.value} of value`
    case 'risk':
      return `${by.value} of risk`
  }
}
