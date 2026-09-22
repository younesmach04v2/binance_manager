import { app, BrowserWindow, safeStorage, shell } from 'electron'
import type { Platform } from './index'

/** Electron desktop: OS keychain encryption (DPAPI on Windows), data under the app's userData folder. */
export const electronPlatform: Platform = {
  name: 'electron',
  version: () => app.getVersion(),
  userDir: () => app.getPath('userData'),
  encryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (text) => safeStorage.encryptString(text),
  decrypt: (data) => safeStorage.decryptString(data),
  sendToWindows: (channel, payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload)
    }
  },
  openExternal: (url) => shell.openExternal(url)
}
