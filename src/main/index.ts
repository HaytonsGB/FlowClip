import { app, shell, BrowserWindow, ipcMain, dialog, protocol, net } from 'electron'
import { join, basename, extname, dirname } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import {
  probe,
  runExport,
  runCompositeExport,
  runProjectExport,
  toolStatus,
  rescanTools,
  filmstrip
} from './ffmpeg'
import { transcribe, downloadModel, isModelReady, whisperPath } from './whisper'
import { saveProject, loadProject, writeAutosave, readAutosave, clearAutosave } from './project'
import { PROJECT_EXT, type ProjectFile } from '../shared/project'
import { MEDIA_SCHEME } from '../shared/types'
import type {
  ExportRequest,
  ExportResult,
  CompositeExportRequest,
  ProjectExportRequest,
  WhisperModelId
} from '../shared/types'

const VIDEO_EXTS = ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'flv', 'wmv']

let mainWindow: BrowserWindow | null = null

/** resources/ sits next to the app in dev and inside the bundle once packaged. */
function resourcePath(name: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, name)
    : join(app.getAppPath(), 'resources', name)
}

/**
 * The renderer runs on http:// in dev, so it cannot load file:// media directly.
 * This privileged scheme streams local files instead. `stream: true` is what makes
 * range requests — and therefore seeking within a video — work.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#070912',
    title: 'FlowClip',
    icon: resourcePath('logo.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.flowclip.app')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
  registerMediaProtocol()
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/**
 * Serves `flowclip://media/?src=<encoded absolute path>`.
 *
 * The path travels as a query param rather than in the URL path: standard schemes
 * canonicalise pathnames, which mangles Windows drive letters and backslashes.
 */
function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    try {
      const src = new URL(request.url).searchParams.get('src')
      if (!src) return new Response('missing src', { status: 400 })
      return await net.fetch(pathToFileURL(src).toString(), { headers: request.headers })
    } catch (err) {
      return new Response(err instanceof Error ? err.message : 'media error', { status: 404 })
    }
  })
}

function registerIpc(): void {
  ipcMain.handle('tools:status', () => toolStatus())
  ipcMain.handle('tools:rescan', () => rescanTools())

  ipcMain.handle('dialog:openVideo', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Open a video',
      properties: ['openFile'],
      filters: [
        { name: 'Video', extensions: VIDEO_EXTS },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('video:probe', async (_e, filePath: string) => probe(filePath))

  ipcMain.handle('video:filmstrip', async (_e, filePath: string, durationSec: number) =>
    filmstrip(filePath, durationSec)
  )

  ipcMain.handle('dialog:saveClip', async (_e, suggestedName: string) => {
    const result = await dialog.showSaveDialog({
      title: 'Export clip',
      defaultPath: suggestedName,
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }]
    })
    if (result.canceled || !result.filePath) return null
    return result.filePath
  })

  ipcMain.handle('clip:export', async (event, req: ExportRequest): Promise<ExportResult> => {
    try {
      await runExport(req, (p) => {
        // Guard against a window closed mid-export.
        if (!event.sender.isDestroyed()) event.sender.send('clip:progress', p)
      })
      return { ok: true, outputPath: req.outputPath }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(
    'clip:exportComposite',
    async (event, req: CompositeExportRequest): Promise<ExportResult> => {
      try {
        await runCompositeExport(req, (p) => {
          if (!event.sender.isDestroyed()) event.sender.send('clip:progress', p)
        })
        return { ok: true, outputPath: req.outputPath }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    'clip:exportProject',
    async (event, req: ProjectExportRequest): Promise<ExportResult> => {
      try {
        await runProjectExport(req, (p) => {
          if (!event.sender.isDestroyed()) event.sender.send('clip:progress', p)
        })
        return { ok: true, outputPath: req.outputPath }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle('whisper:status', (_e, modelId: WhisperModelId) => ({
    binaryReady: whisperPath() !== null,
    modelReady: isModelReady(modelId)
  }))

  ipcMain.handle('whisper:downloadModel', async (event, modelId: WhisperModelId) => {
    try {
      await downloadModel(modelId, (p) => {
        if (!event.sender.isDestroyed()) event.sender.send('whisper:modelProgress', p)
      })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(
    'whisper:transcribe',
    async (
      event,
      req: { inputPath: string; startSec: number; endSec: number; modelId: WhisperModelId }
    ) => {
      try {
        const words = await transcribe(
          req.inputPath,
          req.startSec,
          req.endSec,
          req.modelId,
          (stage) => {
            if (!event.sender.isDestroyed()) event.sender.send('whisper:stage', stage)
          }
        )
        return { ok: true, words }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle('project:save', async (_e, project: ProjectFile, existingPath?: string) => {
    try {
      let target = existingPath
      if (!target) {
        const result = await dialog.showSaveDialog({
          title: 'Save project',
          defaultPath: `Untitled.${PROJECT_EXT}`,
          filters: [{ name: 'FlowClip project', extensions: [PROJECT_EXT] }]
        })
        if (result.canceled || !result.filePath) return { ok: false, cancelled: true }
        target = result.filePath
      }
      saveProject(target, project)
      return { ok: true, path: target }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('project:open', async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: 'Open project',
        properties: ['openFile'],
        filters: [{ name: 'FlowClip project', extensions: [PROJECT_EXT] }]
      })
      if (result.canceled || !result.filePaths.length) return { ok: false, cancelled: true }
      const loaded = loadProject(result.filePaths[0])
      return { ok: true, path: result.filePaths[0], ...loaded }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('project:autosave', (_e, project: ProjectFile) => {
    writeAutosave(project)
  })

  ipcMain.handle('project:recovery', () => readAutosave())
  ipcMain.handle('project:clearRecovery', () => clearAutosave())

  ipcMain.handle('shell:revealFile', (_e, filePath: string) => {
    shell.showItemInFolder(filePath)
  })

  /** Suggest "<name>_clip.mp4" next to the source file. */
  ipcMain.handle('path:suggestOutput', (_e, inputPath: string) => {
    const base = basename(inputPath, extname(inputPath))
    return join(dirname(inputPath), `${base}_clip.mp4`)
  })
}
