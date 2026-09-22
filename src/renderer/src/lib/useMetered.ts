import { useEffect, useState } from 'react'
import { useApp } from '../App'

/**
 * How often to poll, given who is paying for the traffic.
 *
 * Two sides can be on a mobile connection and either one makes a refresh
 * expensive: this device, and the server it is pulling from. A PC on home
 * Wi-Fi polling a phone on cellular spends the phone's allowance, which the
 * PC cannot see for itself, so the server reports it over the wire.
 */

const SLOW_SEC = 60

interface NetworkInformation extends EventTarget {
  type?: string
  effectiveType?: string
}

/** True when this device is on cellular. Unknown counts as not cellular. */
function onCellular(): boolean {
  const c = (navigator as Navigator & { connection?: NetworkInformation }).connection
  if (!c) return false
  if (c.type) return c.type === 'cellular'
  // Desktop Chromium often leaves `type` unset; effectiveType says nothing
  // about the link being metered, so stay on the normal rate.
  return false
}

export function useMetered(): { metered: boolean; reason: 'this device' | 'the server' | null } {
  const { remote } = useApp()
  const [local, setLocal] = useState(onCellular)

  useEffect(() => {
    const c = (navigator as Navigator & { connection?: NetworkInformation }).connection
    if (!c) return
    const update = (): void => setLocal(onCellular())
    c.addEventListener('change', update)
    return () => c.removeEventListener('change', update)
  }, [])

  const server = remote?.client?.serverMetered === true
  return { metered: local || server, reason: local ? 'this device' : server ? 'the server' : null }
}

/** The configured interval, stretched to 60s whenever someone is on cellular. */
export function useRefreshSeconds(configuredSec: number): number {
  const { metered } = useMetered()
  const base = Math.max(10, configuredSec)
  return metered ? Math.max(SLOW_SEC, base) : base
}
