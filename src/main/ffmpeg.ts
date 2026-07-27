/**
 * Thin wrapper around the bundled ffmpeg / ffprobe binaries.
 *
 * Resolution order: binaries we ship in resources/bin, then whatever is on PATH.
 * Shipping our own means a user never has to install ffmpeg themselves.
 */
import { spawn, execFile } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { VideoMeta, ExportRequest, ExportProgress, ToolStatus } from '../shared/types'
import { ASPECT_DIMS } from '../shared/types'

const EXE = process.platform === 'win32' ? '.exe' : ''

/** resources/bin in dev, the unpacked resources dir once packaged. */
function binDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'bin')
    : join(app.getAppPath(), 'resources', 'bin')
}

function resolveTool(name: string): string | null {
  const bundled = join(binDir(), `${name}${EXE}`)
  if (existsSync(bundled)) return bundled
  // Fall back to PATH — spawn resolves a bare name itself.
  return which(name) ? name : null
}

/** Synchronous-enough PATH probe; ffmpeg lookups happen once at startup. */
function which(name: string): boolean {
  const paths = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
  return paths.some((p) => p && existsSync(join(p, `${name}${EXE}`)))
}

let cached: ToolStatus | null = null

export function toolStatus(): ToolStatus {
  if (!cached) {
    const ffmpegPath = resolveTool('ffmpeg')
    const ffprobePath = resolveTool('ffprobe')
    cached = { ffmpegPath, ffprobePath, ready: Boolean(ffmpegPath && ffprobePath) }
  }
  return cached
}

/** Clear the cache so a freshly downloaded ffmpeg is picked up without a restart. */
export function rescanTools(): ToolStatus {
  cached = null
  return toolStatus()
}

export async function probe(filePath: string): Promise<VideoMeta> {
  const { ffprobePath } = toolStatus()
  if (!ffprobePath) throw new Error('ffprobe not found')

  const args = ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath]
  const raw = await new Promise<string>((resolve, reject) => {
    execFile(ffprobePath, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })

  const data = JSON.parse(raw)
  const video = data.streams?.find((s: { codec_type: string }) => s.codec_type === 'video')
  const audio = data.streams?.find((s: { codec_type: string }) => s.codec_type === 'audio')
  if (!video) throw new Error('No video stream found in that file')

  return {
    path: filePath,
    fileName: filePath.split(/[\\/]/).pop() ?? filePath,
    durationSec: Number(data.format?.duration ?? 0),
    width: Number(video.width ?? 0),
    height: Number(video.height ?? 0),
    fps: parseFps(video.r_frame_rate),
    hasAudio: Boolean(audio),
    sizeBytes: Number(data.format?.size ?? 0)
  }
}

function parseFps(rate: string | undefined): number {
  if (!rate) return 0
  const [num, den] = rate.split('/').map(Number)
  if (!den) return num || 0
  return Math.round((num / den) * 100) / 100
}

/**
 * Build the -vf chain for a target aspect: scale up to cover the frame, then
 * centre-crop the overflow. This is the "fill, don't letterbox" behaviour that
 * vertical social clips want.
 */
function reframeFilter(aspect: ExportRequest['aspect']): string | null {
  if (aspect === 'source') return null
  const { w, h } = ASPECT_DIMS[aspect]
  return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`
}

export function buildExportArgs(req: ExportRequest): string[] {
  const duration = Math.max(0.05, req.endSec - req.startSec)
  const filter = reframeFilter(req.aspect)
  const mustEncode = req.reencode || filter !== null

  const args: string[] = ['-hide_banner', '-y']

  // -ss before -i seeks fast (keyframe-accurate); good enough and much quicker.
  args.push('-ss', req.startSec.toFixed(3), '-i', req.inputPath, '-t', duration.toFixed(3))

  if (mustEncode) {
    if (filter) args.push('-vf', filter)
    args.push(
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '20',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k'
    )
  } else {
    args.push('-c', 'copy')
  }

  // Lets players start before the whole file is downloaded — matters for uploads.
  args.push('-movflags', '+faststart', req.outputPath)
  return args
}

/** Pulls `out_time_ms=` / `speed=` lines out of ffmpeg's -progress stream. */
function parseProgress(chunk: string, totalSec: number): ExportProgress | null {
  const timeMatch = /out_time_ms=(\d+)/.exec(chunk)
  if (!timeMatch) return null
  const timeSec = Number(timeMatch[1]) / 1_000_000
  const speedMatch = /speed=\s*([0-9.]+x)/.exec(chunk)
  return {
    percent: totalSec > 0 ? Math.min(1, timeSec / totalSec) : 0,
    timeSec,
    speed: speedMatch?.[1] ?? ''
  }
}

export function runExport(
  req: ExportRequest,
  onProgress: (p: ExportProgress) => void
): Promise<void> {
  const { ffmpegPath } = toolStatus()
  if (!ffmpegPath) return Promise.reject(new Error('ffmpeg not found'))

  const totalSec = Math.max(0.05, req.endSec - req.startSec)
  const args = ['-progress', 'pipe:1', '-nostats', ...buildExportArgs(req)]

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args)
    let stderrTail = ''

    proc.stdout.on('data', (d: Buffer) => {
      const p = parseProgress(d.toString(), totalSec)
      if (p) onProgress(p)
    })

    proc.stderr.on('data', (d: Buffer) => {
      // Keep only the tail; ffmpeg is chatty but the last lines hold the error.
      stderrTail = (stderrTail + d.toString()).slice(-4000)
    })

    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderrTail.trim() || `ffmpeg exited with code ${code}`))
    })
  })
}
