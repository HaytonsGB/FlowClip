import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join, basename, extname, dirname } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { probe, runExport, toolStatus, rescanTools } from './ffmpeg'
import type { ExportRequest, ExportResult } from '../shared/types'

const VIDEO_EXTS = ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'flv', 'wmv']

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0d12',
    title: 'FlowClip',
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
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

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

  ipcMain.handle('shell:revealFile', (_e, filePath: string) => {
    shell.showItemInFolder(filePath)
  })

  /** Suggest "<name>_clip.mp4" next to the source file. */
  ipcMain.handle('path:suggestOutput', (_e, inputPath: string) => {
    const base = basename(inputPath, extname(inputPath))
    return join(dirname(inputPath), `${base}_clip.mp4`)
  })
}
