# Binance Manager

A Windows desktop app for Binance **spot** trading. It runs entirely on your PC: your API keys are encrypted with
Windows DPAPI and only ever used by the Electron main process, never by the UI layer or any third-party server.

## What it does

| Page | Features |
|------|----------|
| **Portfolio** | Balances valued in USDT (or USDC/FDUSD/BTC), live prices over WebSocket, 24h change, allocation chart, portfolio value history, weighted-average cost basis, unrealized and realized P&L per asset. |
| **Quick trade (R)** | One-click `1R`, `2R`, `3R`, `2R BE`, `3R BE` commands: buy at market **or rest a limit buy**, sized from your stop, then one OCO with the take-profit at N × R and the stop. A limit entry carries its target and stop with it, so Binance places them itself the moment it fills. "BE" variants move the stop to break-even automatically once price has run 1R. Live R multiple, gross P&L, position log, close/release actions, and a history with R achieved. |
| **Positions** | Every open position in one view with the same card design: app-managed R positions, limit entries still waiting to fill, and plain holdings with the stop and target their open Binance orders give them. Live R multiple and P&L, "Close at market", "Cancel entry", and "Manage with ladder", which replaces a position's orders with the break-even ladder. |
| **Trade** | Market, limit, stop-limit and OCO (take-profit + stop-loss) orders with exchange-filter validation, a dry "test order" button, a confirmation dialog, open orders with cancel, and recent order history. |
| **Journal** | Syncs your fill history from Binance, lets you tag trades and write notes, filter by symbol/side/tag/text. |
| **Analytics** | Closed round trips (buy from zero, sell back to zero): win rate, profit factor, expectancy, average win/loss, largest win/loss, average hold time, cumulative P&L, P&L by symbol and by tag. |
| **Automation** | DCA bots (buy X quote every N hours, optional run limit) and price rules (market buy/sell once a price is crossed). Every bot starts in dry-run mode; a master switch pauses everything. Bots run only while the app is open. |
| **Settings** | API keys, live/testnet switch, quote asset, dust threshold, refresh interval, watchlist, data location. |

## Getting started

```bash
npm install
npm run dev        # hot-reloading development build
npm run build      # compile to out/
npm start          # (or: npx electron .) run the compiled app
npm run dist:win   # build the Windows installer into dist/
```

Requires Node.js 20+ (built with Node 24).

If the app exits immediately with `Cannot read properties of undefined (reading 'whenReady')`, the environment
variable `ELECTRON_RUN_AS_NODE` is set (some editor-integrated terminals inherit it). Unset it and run again:

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE; npm start
```

### API keys

1. Binance → Profile → **API Management** → Create API.
2. Enable **Enable Reading**. Enable **Enable Spot & Margin Trading** only if you want to place orders from the app.
3. Never enable withdrawals. Restrict the key to your IP address if you can.
4. Paste the key and secret into **Settings** in the app and press **Test connection**.

To experiment safely, turn on **Use Binance Spot Testnet** in Settings and create separate keys at
<https://testnet.binance.vision>. Trades, notes, bots and history are stored per environment.

## R commands

1. Pick the symbol and the **entry**: *Market* buys straight away, *Limit* rests a buy at a price you choose
   (see [Limit entries](#limit-entries-buy-limit--tp--sl--ladder) below).
2. Type the **stop-loss price** (or use the -0.5% / -1% / -2% / -3% buttons, which measure from the limit price when
   there is one).
3. Choose how to size: **Risk** (how much you lose if the stop is hit), **Amount** to spend, or **Qty**.
   With Risk, quantity = risk ÷ (entry − stop).
4. Press a command. `NR` sets the take-profit N × R above the entry, where R = entry − stop.
   `NR BE` adds the **stop ladder**:
   - at **+1R**: sell **50 %** of the position and move the stop to **entry** (break-even);
   - from **+3R** on, every whole R moves the stop up to two R behind: at 3R the stop goes to +1R, at 4R to +2R,
     and so on, until the target closes the rest.
5. Confirm. The app buys (or rests the entry), computes R from the actual fill, and places the orders on Binance: for a
   plain command one OCO (target limit-maker + stop); for a BE command a main OCO for half the size with the target and
   stop, plus a second OCO for the other half whose target rests at +1R. Both halves are protected by the same stop.

While the app is open it checks each position every 15 seconds: when +1R is reached it makes sure the half has been
sold (the resting limit usually already did it) and re-places the main stop at entry; at each higher rung it moves
the stop up; it detects which leg filled and records the outcome and R achieved. If a position ever ends up without a
stop it retries, or sells at market if price is already at the stop. **Move stop up** applies the next rung by hand,
**Close at market** exits immediately, **Release** stops managing but leaves the orders on Binance. The partial
percentage, the break-even trigger, the trailing start and gap, and the fee offset are all adjustable under
*Advanced* and remembered.

### Limit entries: buy limit + TP + SL + ladder

Switch **Entry** to *Limit* and type the price you want to be filled at. Everything else works the same — the stop, the
size and the target are all measured from your limit price instead of the market — but the order goes on the book
instead of buying now, and the position appears under *Open positions* as **waiting to fill**. Nothing is bought and
nothing is risked until it fills.

Where Binance allows it (`otoAllowed`, true for essentially every spot pair) the buy and its exits go up as a single
**OTOCO** order list: the take-profit and the stop belong to the same list and Binance places them itself the instant
the entry fills. The position is therefore never naked, even if this app — or the phone running the server — is off
at that moment. The card says *exits attached* when this is the case and *exits on fill* when the symbol refused it and
the app has to place them on its next check instead.

When the app sees the fill it recomputes the entry, R, the target and every ladder level from the real fill price,
replaces Binance's attached pair with legs sized to the quantity you actually hold (fees come out of the base asset,
so it is slightly less than you bought), splits off the partial leg for a BE command, and from then on the position is
indistinguishable from one opened at market. If price has already run past +1R by then, the partial is skipped and the
ladder simply moves the stop on its first pass.

Optionally set **Cancel the entry after** so an unfilled order is taken off the book automatically; leave it blank and
it rests until it fills or you press **Cancel entry** on the card. Cancelling an entry that has meanwhile filled in part
protects what was bought rather than discarding it.

## Remote access: one server, several clients

Bots and stop ladders only run while the app is open, so run one copy on a machine that stays on and use the others
as remote controls.

1. On the always-on machine: Settings → **Remote access** → **Server**. Pick a port (default 7777), copy the pairing
   token, press **Start server**. Allow that TCP port through Windows Firewall for your private network. The card lists
   the addresses clients can use.
2. On your PC: Settings → **Remote access** → **Client**, enter `server-ip:7777` and the token, **Test connection**, then
   **Connect as client**.

The client shows the server's portfolio, journal, positions and settings, and every command (orders, R commands,
bots, syncs, key changes) is executed on the server. Live prices still stream to the client directly from Binance.
Events (position updates, bot logs, settings changes) are pushed to clients over a WebSocket, and the client
reconnects automatically. A client never trades on its own, even if it has keys stored from earlier use.

Security: requests carry the pairing token as a bearer token over plain HTTP, and ten wrong tokens from one address
block it for ten minutes. Use it on a LAN or over a VPN (Tailscale, WireGuard); do not forward the port to the open
internet. Anyone with the token can trade with the server's keys, so regenerate it if it leaks.

## Headless server (no window): Raspberry Pi, mini PC, old laptop

The same server can run as a plain Node process, so the always-on machine does not need a screen or Electron.

```bash
npm run build:headless          # -> out/headless/binance-manager-server.js (one file, no node_modules needed)
```

Copy that file to the machine that stays on (Node.js 20 or newer must be installed there) and run:

```bash
node binance-manager-server.js keys        # store the Binance API keys (or add them later from a client)
node binance-manager-server.js             # start; prints the port, the LAN addresses and the pairing token
node binance-manager-server.js token       # print the pairing token again
node binance-manager-server.js settings --testnet on   # flip options without a UI
```

Data lives in `~/.binance-manager` (override with `BINANCE_MANAGER_DATA`). Keys are encrypted with AES-256-GCM under a
random `master.key` created next to them, or under a passphrase if `BINANCE_MANAGER_PASSPHRASE` is set. A `keys.bin`
written by the desktop app is not readable by the headless server and vice versa, so enter the keys once on the
machine that will hold them.

To keep it running after a reboot on Linux, create `/etc/systemd/system/binance-manager.service`:

```ini
[Unit]
Description=Binance Manager server
After=network-online.target

[Service]
User=pi
ExecStart=/usr/bin/node /home/pi/binance-manager-server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

then `sudo systemctl enable --now binance-manager`. On Windows use Task Scheduler ("At startup", run
`node C:\path\binance-manager-server.js`) or a tool such as NSSM. Desktop and mobile clients connect exactly as
described above.

## Android app

The Android app is the same React UI wrapped with Capacitor, and it can work in two ways:

- **Phone as the 24/7 server (no PC, no cloud).** Settings → Remote access → *Run the server on this phone*. The app
  starts the same headless server on an embedded Node.js runtime inside the phone, keeps it alive with a foreground
  service (a permanent notification) and a wake lock, and connects its own UI to it on `127.0.0.1`. Your keys,
  positions, stop ladders and bots live on the phone. Allow *unrestricted battery* when asked, keep the phone charged
  and online, and after a reboot tap the notification once to resume. Your PC can connect to the phone as a client
  using the phone's Wi-Fi address and the token shown in the app.
- **Phone as a remote control.** Enter the address and pairing token of a desktop app in Server mode or of the
  headless server, over your LAN or a VPN.

Live prices stream to the phone directly from Binance in both cases. The APK only includes 64-bit ARM (every Android
phone since about 2017); change `abiFilters` in `android/app/build.gradle` to add others.

How the 24/7 mode works and what to expect:

- The server is the same code as the headless server, running on an embedded Node.js 18 runtime (nodejs-mobile) inside
  the app process. A foreground service with a persistent notification and a partial wake lock keeps that process alive;
  the app asks for notification permission and for the *unrestricted battery* exemption, both needed so Doze does not
  pause it. Stock Android (Pixel) keeps such services running indefinitely; some manufacturers (Xiaomi, Huawei, some
  Samsung modes) kill them unless you also whitelist the app in their own battery settings.
- Data (keys encrypted with AES-256-GCM, trades, positions, bots) lives in the app's private storage on the phone and
  survives app updates. Uninstalling the app deletes it.
- After a reboot the service comes back on its own, but the engine starts when the app is opened: tap the notification
  once. Force-stopping the app or swiping it away also stops the server until the next launch. Orders already on
  Binance (stop, target, resting partial) are unaffected either way.
- On Android 16+ the phone shows a one-time "page size" compatibility notice after each install because the Node
  library is built for 4 KB pages; it runs normally in compatibility mode.
- Other clients (your PC, another phone) connect to the phone with its Wi-Fi or VPN address, port 7777 by default, and
  the token shown in Settings → Remote access.

Requirements to build: Android Studio with the SDK, JDK 21, and CMake plus NDK 27 (Gradle installs the NDK on first
build). Building takes about two minutes the first time.

Build requirements: Android Studio (for the SDK) and a JDK 21. The Gradle project reads the JDK from
`android/gradle.properties` (`org.gradle.java.home`); point it at Android Studio's bundled `jbr` folder or any JDK 21.

```bash
npm run build:mobile      # web bundle -> out/mobile
npm run android:sync      # copy it into the Android project
npm run android:apk       # -> android/app/build/outputs/apk/debug/app-debug.apk
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
npm run android:open      # or open the android/ folder in Android Studio
```

The debug APK is for your own phones. A Play Store or signed release build needs a keystore: in Android Studio use
Build → Generate Signed App Bundle/APK.

## How the numbers are computed

- **Cost basis** uses the weighted-average method over your synced trades. Assets that were deposited rather than
  bought have no known entry price and show no unrealized P&L; a position that is only partly covered is flagged
  "partial basis".
- **Realized P&L** is booked on each sell against the average cost at that time, minus fees.
- **Fees** paid in the quote asset or BNB are subtracted from P&L (BNB is converted at today's price, so this is
  approximate). Fees taken in the traded asset reduce the quantity you hold instead.
- **Round trips** in Analytics close when the position falls to 0.1% or less of its peak size, which tolerates dust
  left behind by base-asset fees.
- Trades in a quote currency other than your portfolio quote are converted at current rates.

## Where data lives

`%APPDATA%\binance-manager\`

- `keys.bin` – API key and secret, encrypted with DPAPI (only readable by your Windows user).
- `data\*.json` – settings, synced trades, journal, bots, bot log and value history, per environment.

Delete the folder to reset the app.

## Limitations and cautions

- Spot only. No margin or futures.
- Bots run inside the app; if the app is closed they stop. Exits already on the exchange are unaffected: a managed
  position's OCO, and a limit entry whose target and stop are attached to it, both survive a shutdown. Only the ladder
  (moving the stop up) and outcome tracking need the app running.
- Trade discovery syncs every asset you hold against USDT, USDC, FDUSD, BTC, ETH and BNB, plus any symbol you add in
  the Journal. A pair you traded but no longer hold must be added manually once; after that it stays tracked.
- Binance rate limits apply. The sync pauses briefly between symbols; a very large history may take a couple of minutes
  the first time.
- This software places real orders when not in testnet or dry-run mode. Use at your own risk.

## Tech

Electron 44 · React 19 · TypeScript 7 · Vite 7 via electron-vite · Tailwind CSS 4 · Recharts 3. No Binance SDK:
the REST client (`src/main/binance/client.ts`) signs requests with HMAC-SHA256 using Node's crypto module.
