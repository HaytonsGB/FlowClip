import type { ElectronAPI } from '@electron-toolkit/preload'
import type { FlowClipAPI } from './index'

declare global {
  interface Window {
    electron: ElectronAPI
    api: FlowClipAPI
  }
}

export {}
