import { networkInterfaces } from 'node:os'

/**
 * Is this machine reaching the network over a mobile connection?
 *
 * A server running on a phone is usually the one paying for the traffic its
 * clients pull, and the clients cannot see that from their own side: a PC on
 * home Wi-Fi polling a phone on cellular spends the phone's allowance, not its
 * own. So the server reports this and clients slow down when it is true.
 *
 * Android names its mobile interfaces rmnet, ccmni or pdp_ip; Wi-Fi and
 * Ethernet are wlan or eth. Judging by name is crude, but it is all a Node
 * process inside the app can see, and it errs towards "not metered" when
 * unsure, so an unrecognised setup keeps its normal refresh rate.
 */

const MOBILE = /^(rmnet|ccmni|pdp_ip|v4-rmnet|seth_w|usb_rmnet)/i
const FIXED = /^(wlan|eth|en|wl|Wi-Fi|Ethernet)/i

export function isMetered(): boolean {
  let mobile = false
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.internal || a.family !== 'IPv4') continue
      // A tunnel (Tailscale and friends) rides on whatever is underneath it, so it says nothing.
      if (/^(tun|tailscale|wg)/i.test(name)) continue
      if (FIXED.test(name)) return false
      if (MOBILE.test(name)) mobile = true
    }
  }
  return mobile
}
