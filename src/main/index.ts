import { app, BrowserWindow, session, shell } from 'electron'
import { join } from 'node:path'
import { invokeLocal, isRemoteChannel, noteRemoteSettings, remoteInfo } from './commands'
import { sendToWindows } from './context'
import { registerIpc } from './ipc'
import { setPlatform } from './platform'
import { electronPlatform } from './platform/electron'
import { remote } from './remote'
import { automation } from './services/automation'

setPlatform(electronPlatform)

const isDev = !!process.env['ELECTRON_RENDERER_URL']

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0f17',
    title: 'Binance Manager',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win.show())

  // Any link that tries to open a new window goes to the system browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] as string)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  // Content Security Policy for the packaged app. Dev builds skip it so Vite HMR works.
  if (!isDev) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
              'connect-src wss://stream.binance.com:9443 wss://stream.binance.com:443 wss://stream.testnet.binance.vision'
          ]
        }
      })
    })
  }

  registerIpc()
  createWindow()
  // Server mode exposes the command registry to other copies of the app; client mode forwards to one.
  await remote.start({
    invoke: invokeLocal,
    isRemoteChannel,
    info: remoteInfo,
    onEvent: (channel, payload) => {
      if (channel === 'settings:changed') noteRemoteSettings(payload)
      sendToWindows(channel, payload)
    }
  })
  automation.start()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  automation.stop()
  void remote.stop().finally(() => app.quit())
})
