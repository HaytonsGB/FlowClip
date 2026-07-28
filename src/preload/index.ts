import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { ProjectFile } from '../shared/project'
import type {
  VideoMeta,
  ExportRequest,
  ExportResult,
  ExportProgress,
  ToolStatus,
  CompositeExportRequest,
  ProjectExportRequest,
  WhisperModelId,
  CaptionWord,
  ModelProgress
} from '../shared/types'

/** The only surface the renderer gets — no raw Node access in the UI. */
const api = {
  toolStatus: (): Promise<ToolStatus> => ipcRenderer.invoke('tools:status'),
  rescanTools: (): Promise<ToolStatus> => ipcRenderer.invoke('tools:rescan'),
  openVideo: (): Promise<string | null> => ipcRenderer.invoke('dialog:openVideo'),
  probe: (filePath: string): Promise<VideoMeta> => ipcRenderer.invoke('video:probe', filePath),
  filmstrip: (filePath: string, durationSec: number): Promise<string> =>
    ipcRenderer.invoke('video:filmstrip', filePath, durationSec),
  suggestOutput: (inputPath: string): Promise<string> =>
    ipcRenderer.invoke('path:suggestOutput', inputPath),
  saveClipDialog: (suggestedName: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:saveClip', suggestedName),
  exportClip: (req: ExportRequest): Promise<ExportResult> => ipcRenderer.invoke('clip:export', req),
  exportComposite: (req: CompositeExportRequest): Promise<ExportResult> =>
    ipcRenderer.invoke('clip:exportComposite', req),
  exportProject: (req: ProjectExportRequest): Promise<ExportResult> =>
    ipcRenderer.invoke('clip:exportProject', req),
  revealFile: (filePath: string): Promise<void> => ipcRenderer.invoke('shell:revealFile', filePath),

  saveProject: (
    project: ProjectFile,
    existingPath?: string
  ): Promise<{ ok: boolean; path?: string; cancelled?: boolean; error?: string }> =>
    ipcRenderer.invoke('project:save', project, existingPath),
  openProject: (): Promise<{
    ok: boolean
    path?: string
    project?: ProjectFile
    missing?: string[]
    cancelled?: boolean
    error?: string
  }> => ipcRenderer.invoke('project:open'),
  autosaveProject: (project: ProjectFile): Promise<void> =>
    ipcRenderer.invoke('project:autosave', project),
  getRecovery: (): Promise<{ project: ProjectFile; savedAt: string } | null> =>
    ipcRenderer.invoke('project:recovery'),
  clearRecovery: (): Promise<void> => ipcRenderer.invoke('project:clearRecovery'),

  /** Electron 33 removed File.path; this is the supported replacement. */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),

  whisperStatus: (
    modelId: WhisperModelId
  ): Promise<{ binaryReady: boolean; modelReady: boolean }> =>
    ipcRenderer.invoke('whisper:status', modelId),
  downloadModel: (modelId: WhisperModelId): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('whisper:downloadModel', modelId),
  transcribe: (req: {
    inputPath: string
    startSec: number
    endSec: number
    modelId: WhisperModelId
  }): Promise<{ ok: boolean; words?: CaptionWord[]; error?: string }> =>
    ipcRenderer.invoke('whisper:transcribe', req),

  onModelProgress: (cb: (p: ModelProgress) => void): (() => void) => {
    const listener = (_e: unknown, p: ModelProgress): void => cb(p)
    ipcRenderer.on('whisper:modelProgress', listener)
    return () => ipcRenderer.removeListener('whisper:modelProgress', listener)
  },
  onTranscribeStage: (cb: (stage: string) => void): (() => void) => {
    const listener = (_e: unknown, s: string): void => cb(s)
    ipcRenderer.on('whisper:stage', listener)
    return () => ipcRenderer.removeListener('whisper:stage', listener)
  },

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
