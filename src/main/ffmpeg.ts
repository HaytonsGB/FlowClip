/**
 * Thin wrapper around the bundled ffmpeg / ffprobe binaries.
 *
 * Resolution order: binaries we ship in resources/bin, then whatever is on PATH.
 * Shipping our own means a user never has to install ffmpeg themselves.
 */
import { spawn, execFile } from 'child_process'
import { existsSync, mkdirSync, statSync } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { app } from 'electron'
import type {
  VideoMeta,
  ExportRequest,
  ExportProgress,
  ToolStatus,
  CompositeExportRequest,
  Rect
} from '../shared/types'
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
 * Renders evenly-spaced frames tiled into one wide strip, used as the timeline
 * background so the track shows the actual footage. Cached per file so
 * reopening a clip is instant.
 */
export async function filmstrip(
  inputPath: string,
  durationSec: number,
  count = 24,
  height = 56
): Promise<string> {
  const { ffmpegPath } = toolStatus()
  if (!ffmpegPath) throw new Error('ffmpeg not found')
  if (durationSec <= 0) throw new Error('Cannot build a filmstrip for a zero-length video')

  const outDir = join(app.getPath('temp'), 'flowclip-strips')
  mkdirSync(outDir, { recursive: true })

  const stat = statSync(inputPath)
  const key = createHash('sha1')
    .update(`${inputPath}:${stat.size}:${stat.mtimeMs}:${count}:${height}`)
    .digest('hex')
    .slice(0, 16)
  const outPath = join(outDir, `${key}.jpg`)
  if (existsSync(outPath)) return outPath

  // fps picks `count` frames across the whole clip; tile glues them side by side.
  const fps = count / durationSec
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-i', inputPath,
    '-vf', `fps=${fps.toFixed(6)},scale=-1:${height},tile=${count}x1`,
    '-frames:v', '1',
    '-q:v', '4',
    outPath
  ]

  await new Promise<void>((resolve, reject) => {
    execFile(ffmpegPath, args, (err, _stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message))
      else resolve()
    })
  })

  return outPath
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

/** yuv420p needs even dimensions, and crop offsets must stay inside the frame. */
function evenClamp(value: number, max: number): number {
  const v = Math.round(value / 2) * 2
  return Math.max(0, Math.min(v, max))
}

/** Convert a normalised rect to even pixel values inside a WxH frame. */
function toPixels(rect: Rect, W: number, H: number): { x: number; y: number; w: number; h: number } {
  const w = Math.max(2, evenClamp(rect.w * W, W))
  const h = Math.max(2, evenClamp(rect.h * H, H))
  return {
    x: evenClamp(rect.x * W, W - w),
    y: evenClamp(rect.y * H, H - h),
    w,
    h
  }
}

/**
 * Builds a filter graph that paints each region onto a blank canvas:
 * split the source once per region, crop and scale each, then overlay them in
 * order. This is what lets a vertical export keep the facecam, the gameplay and
 * the minimap instead of centre-cropping to one of them.
 */
export function buildCompositeArgs(req: CompositeExportRequest): string[] {
  const { regions, srcWidth, srcHeight, canvas } = req
  if (regions.length === 0) throw new Error('Add at least one box to the layout')

  const duration = Math.max(0.05, req.endSec - req.startSec)
  const steps: string[] = [`color=c=black:s=${canvas.w}x${canvas.h}:d=${duration.toFixed(3)}[bg]`]

  // One split output per region; ffmpeg cannot consume a stream twice.
  const labels = regions.map((_, i) => `[s${i}]`).join('')
  steps.push(`[0:v]split=${regions.length}${labels}`)

  regions.forEach((region, i) => {
    const s = toPixels(region.src, srcWidth, srcHeight)
    const d = toPixels(region.dst, canvas.w, canvas.h)
    const crop = `crop=${s.w}:${s.h}:${s.x}:${s.y}`
    const fill = `scale=${d.w}:${d.h}:force_original_aspect_ratio=increase,crop=${d.w}:${d.h}`

    if (region.fit !== 'contain') {
      steps.push(`[s${i}]${crop},${fill},setsar=1[r${i}]`)
      return
    }

    const shrink = `scale=${d.w}:${d.h}:force_original_aspect_ratio=decrease`

    if (region.backdrop === 'black') {
      steps.push(
        `[s${i}]${crop},${shrink},` +
          `pad=${d.w}:${d.h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[r${i}]`
      )
      return
    }

    // Blurred backdrop: one copy fills the slot and is blurred, the other keeps
    // the whole frame and sits centred on top.
    const bw = Math.max(16, evenClamp(d.w / 8, d.w))
    const bh = Math.max(16, evenClamp(d.h / 8, d.h))
    steps.push(`[s${i}]split=2[a${i}][b${i}]`)
    steps.push(
      // Blurring a downscaled copy then scaling back up is far cheaper than
      // blurring at full size, and the result is indistinguishable once soft.
      `[a${i}]${crop},scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},` +
        `gblur=sigma=6,scale=${d.w}:${d.h},eq=brightness=-0.07:saturation=1.1,setsar=1[bg${i}]`
    )
    steps.push(`[b${i}]${crop},${shrink},setsar=1[fg${i}]`)
    steps.push(`[bg${i}][fg${i}]overlay=(W-w)/2:(H-h)/2[r${i}]`)
  })

  // Chain the overlays: bg + r0 -> o0, o0 + r1 -> o1, ...
  regions.forEach((region, i) => {
    const base = i === 0 ? '[bg]' : `[o${i - 1}]`
    const d = toPixels(region.dst, canvas.w, canvas.h)
    steps.push(`${base}[r${i}]overlay=${d.x}:${d.y}[o${i}]`)
  })

  const finalLabel = `[o${regions.length - 1}]`

  return [
    '-hide_banner',
    '-y',
    '-ss', req.startSec.toFixed(3),
    '-i', req.inputPath,
    '-t', duration.toFixed(3),
    '-filter_complex', steps.join(';'),
    '-map', finalLabel,
    // '?' keeps the export working when the source has no audio track.
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    req.outputPath
  ]
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
  return runFfmpeg(
    buildExportArgs(req),
    Math.max(0.05, req.endSec - req.startSec),
    onProgress
  )
}

export function runCompositeExport(
  req: CompositeExportRequest,
  onProgress: (p: ExportProgress) => void
): Promise<void> {
  return runFfmpeg(
    buildCompositeArgs(req),
    Math.max(0.05, req.endSec - req.startSec),
    onProgress
  )
}

function runFfmpeg(
  baseArgs: string[],
  totalSec: number,
  onProgress: (p: ExportProgress) => void
): Promise<void> {
  const { ffmpegPath } = toolStatus()
  if (!ffmpegPath) return Promise.reject(new Error('ffmpeg not found'))

  const args = ['-progress', 'pipe:1', '-nostats', ...baseArgs]

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
