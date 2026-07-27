import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  VideoMeta,
  ExportRequest,
  ExportResult,
  ExportProgress,
  ToolStatus
} from '../shared/types'

/** The only surface the renderer gets — no raw Node access in the UI. */
const api = {
  toolStatus: (): Promise<ToolStatus> => ipcRenderer.invoke('tools:status'),
  rescanTools: (): Promise<ToolStatus> => ipcRenderer.invoke('tools:rescan'),
  openVideo: (): Promise<string | null> => ipcRenderer.invoke('dialog:openVideo'),
  probe: (filePath: string): Promise<VideoMeta> => ipcRenderer.invoke('video:probe', filePath),
  suggestOutput: (inputPath: string): Promise<string> =>
    ipcRenderer.invoke('path:suggestOutput', inputPath),
  saveClipDialog: (suggestedName: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:saveClip', suggestedName),
  exportClip: (req: ExportRequest): Promise<ExportResult> => ipcRenderer.invoke('clip:export', req),
  revealFile: (filePath: string): Promise<void> => ipcRenderer.invoke('shell:revealFile', filePath),

  /** Electron 33 removed File.path; this is the supported replacement. */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),

  /** Returns an unsubscribe fn so React effects can clean up. */
  onExportProgress: (cb: (p: ExportProgress) => void): (() => void) => {
    const listener = (_e: unknown, p: ExportProgress): void => cb(p)
    ipcRenderer.on('clip:progress', listener)
    return () => ipcRenderer.removeListener('clip:progress', listener)
  }
}

export type FlowClipAPI = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore fallback when context isolation is off
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}
