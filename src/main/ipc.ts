import { ipcMain } from 'electron'
import { channels, dispatch, registerCommands } from './commands'

/** Wire every command to Electron IPC. Commands run locally or, in client mode, on the server. */
export function registerIpc(): void {
  registerCommands()
  for (const channel of channels()) {
    ipcMain.handle(channel, (_event, ...args: unknown[]) => dispatch(channel, args))
  }
}
