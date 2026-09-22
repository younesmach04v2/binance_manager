import { registerPlugin } from '@capacitor/core'

/** Android-only: the foreground service that keeps the built-in server alive (see android/.../KeepAlivePlugin.java). */
export interface KeepAliveStatus {
  running: boolean
  autoStart: boolean
  batteryUnrestricted: boolean
  notificationsGranted: boolean
}

export interface KeepAlivePlugin {
  status(): Promise<KeepAliveStatus>
  start(): Promise<KeepAliveStatus>
  stop(): Promise<KeepAliveStatus>
  requestNotifications(): Promise<{ granted: boolean }>
  requestBatteryExemption(): Promise<KeepAliveStatus>
  /** Has the Node engine been started in this app process (by any screen)? */
  engineStarted(): Promise<{ started: boolean }>
  markEngineStarted(): Promise<void>
}

export const KeepAlive = registerPlugin<KeepAlivePlugin>('KeepAlive')
