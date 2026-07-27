/**
 * Thin wrapper around the bundled ffmpeg / ffprobe binaries.
 *
 * Resolution order: binaries we ship in resources/bin, then whatever is on PATH.
 * Shipping our own means a user never has to install ffmpeg themselves.
 */
import { spawn, execFile } from 'child_process'
import { existsSync, mkdirSync, statSync, writeFileSync, rmSync, copyFileSync } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { app } from 'electron'
import type {
  VideoMeta,
  ExportRequest,
  ExportProgress,
  ToolStatus,
  CompositeExportRequest,
  ProjectExportRequest,
  Rect
} from '../shared/types'
import { ASPECT_DIMS } from '../shared/types'
import { writeAss, escapeFilterPath } from './captions'

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

export function buildExportArgs(req: ExportRequest, srcSize?: { w: number; h: number }): string[] {
  const duration = Math.max(0.05, req.endSec - req.startSec)
  const filter = reframeFilter(req.aspect)
  const hasCaptions = Boolean(req.captions && req.captions.words.length > 0)
  const mustEncode = req.reencode || filter !== null || hasCaptions

  const args: string[] = ['-hide_banner', '-y']

  // -ss before -i seeks fast (keyframe-accurate); good enough and much quicker.
  args.push('-ss', req.startSec.toFixed(3), '-i', req.inputPath, '-t', duration.toFixed(3))

  if (mustEncode) {
    const chain: string[] = []
    if (filter) chain.push(filter)
    if (hasCaptions && req.captions) {
      // Caption sizes are relative to the frame, so the track is laid out
      // against whatever the output ends up being.
      const canvas =
        req.aspect === 'source' ? (srcSize ?? { w: 1080, h: 1920 }) : ASPECT_DIMS[req.aspect]
      const assPath = writeAss(req.captions.words, req.captions.style, canvas, req.startSec)
      chain.push(`subtitles='${escapeFilterPath(assPath)}'`)
    }
    if (chain.length) args.push('-vf', chain.join(','))
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

/**
 * Renders a white-on-black rounded-rectangle mask, cached by size and radius.
 *
 * ffmpeg has no round-rect primitive, so the shape comes from a per-pixel `geq`
 * expression. That is far too slow to run per frame, but rendering one still
 * image and alpha-merging it costs nothing.
 */
async function roundedMask(w: number, h: number, radius: number): Promise<string> {
  const { ffmpegPath } = toolStatus()
  if (!ffmpegPath) throw new Error('ffmpeg not found')

  const outDir = join(app.getPath('temp'), 'flowclip-masks')
  mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, `mask_${w}x${h}_r${radius}.png`)
  if (existsSync(outPath)) return outPath

  const r = radius
  const rx = w - r
  const by = h - r
  // Opaque everywhere except outside the quarter-circle at each corner.
  const expr =
    `if(lt(X,${r})*lt(Y,${r}),if(lte(hypot(${r}-X,${r}-Y),${r}),255,0),` +
    `if(gt(X,${rx})*lt(Y,${r}),if(lte(hypot(X-${rx},${r}-Y),${r}),255,0),` +
    `if(lt(X,${r})*gt(Y,${by}),if(lte(hypot(${r}-X,Y-${by}),${r}),255,0),` +
    `if(gt(X,${rx})*gt(Y,${by}),if(lte(hypot(X-${rx},Y-${by}),${r}),255,0),255))))`

  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=${w}x${h}`,
    '-vf', `format=gray,geq=lum='${expr}'`,
    '-frames:v', '1',
    outPath
  ]

  await new Promise<void>((resolve, reject) => {
    execFile(ffmpegPath, args, (err, _o, stderr) => {
      if (err) reject(new Error(stderr || err.message))
      else resolve()
    })
  })
  return outPath
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
export async function buildCompositeArgs(req: CompositeExportRequest): Promise<string[]> {
  const { regions, srcWidth, srcHeight, canvas } = req
  if (regions.length === 0) throw new Error('Add at least one box to the layout')

  const duration = Math.max(0.05, req.endSec - req.startSec)
  const steps: string[] = [`color=c=black:s=${canvas.w}x${canvas.h}:d=${duration.toFixed(3)}[bg]`]

  // One split output per region; ffmpeg cannot consume a stream twice.
  const labels = regions.map((_, i) => `[s${i}]`).join('')
  steps.push(`[0:v]split=${regions.length}${labels}`)

  /** Mask images become extra inputs, so input 0 stays the video. */
  const maskInputs: string[] = []

  for (const [i, region] of regions.entries()) {
    const s = toPixels(region.src, srcWidth, srcHeight)
    const d = toPixels(region.dst, canvas.w, canvas.h)
    const crop = `crop=${s.w}:${s.h}:${s.x}:${s.y}`
    const fill = `scale=${d.w}:${d.h}:force_original_aspect_ratio=increase,crop=${d.w}:${d.h}`
    const shaped = `sh${i}`

    if (region.fit !== 'contain') {
      steps.push(`[s${i}]${crop},${fill},setsar=1[${shaped}]`)
    } else if (region.backdrop === 'black') {
      steps.push(
        `[s${i}]${crop},scale=${d.w}:${d.h}:force_original_aspect_ratio=decrease,` +
          `pad=${d.w}:${d.h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[${shaped}]`
      )
    } else {
      // Blurred backdrop: one copy fills the slot and is blurred, the other
      // keeps the whole frame and sits centred on top.
      const bw = Math.max(16, evenClamp(d.w / 8, d.w))
      const bh = Math.max(16, evenClamp(d.h / 8, d.h))
      steps.push(`[s${i}]split=2[a${i}][b${i}]`)
      steps.push(
        // Blurring a downscaled copy then scaling back up is far cheaper than
        // blurring at full size, and indistinguishable once soft.
        `[a${i}]${crop},scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},` +
          `gblur=sigma=6,scale=${d.w}:${d.h},eq=brightness=-0.07:saturation=1.1,setsar=1[bg${i}]`
      )
      steps.push(
        `[b${i}]${crop},scale=${d.w}:${d.h}:force_original_aspect_ratio=decrease,setsar=1[fg${i}]`
      )
      steps.push(`[bg${i}][fg${i}]overlay=(W-w)/2:(H-h)/2[${shaped}]`)
    }

    // Border and rounded corners apply to the finished slot-sized layer.
    const shorter = Math.min(d.w, d.h)
    const borderPx = Math.round((region.border ?? 0) * shorter)
    const radiusPx = Math.min(
      Math.floor(shorter / 2),
      Math.round((region.radius ?? 0) * shorter)
    )

    let current = shaped
    if (borderPx > 0) {
      steps.push(
        `[${current}]drawbox=x=0:y=0:w=iw:h=ih:color=white@1:t=${borderPx}[bd${i}]`
      )
      current = `bd${i}`
    }

    if (radiusPx > 1) {
      const maskPath = await roundedMask(d.w, d.h, radiusPx)
      const maskIndex = maskInputs.length + 1
      maskInputs.push(maskPath)
      steps.push(`[${current}]format=rgba[rg${i}]`)
      steps.push(`[rg${i}][${maskIndex}:v]alphamerge[r${i}]`)
    } else {
      steps.push(`[${current}]null[r${i}]`)
    }
  }

  // Chain the overlays: bg + r0 -> o0, o0 + r1 -> o1, ...
  regions.forEach((region, i) => {
    const base = i === 0 ? '[bg]' : `[o${i - 1}]`
    const d = toPixels(region.dst, canvas.w, canvas.h)
    steps.push(`${base}[r${i}]overlay=${d.x}:${d.y}[o${i}]`)
  })

  let finalLabel = `[o${regions.length - 1}]`

  if (req.captions && req.captions.words.length > 0) {
    const assPath = writeAss(req.captions.words, req.captions.style, canvas, req.startSec)
    steps.push(`${finalLabel}subtitles='${escapeFilterPath(assPath)}'[cap]`)
    finalLabel = '[cap]'
  }
  // -loop keeps each still mask supplying frames for the whole clip.
  const maskArgs = maskInputs.flatMap((p) => ['-loop', '1', '-i', p])

  // Joining segments by stream copy only works if they agree on frame rate and
  // audio layout, and a silent source would otherwise produce a segment with no
  // audio stream at all to join against.
  const forJoin = req.fps !== undefined
  const needSilence = forJoin && req.hasAudio === false
  const silenceArgs = needSilence
    ? ['-f', 'lavfi', '-t', duration.toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo']
    : []
  const audioMap = needSilence
    ? ['-map', `${maskInputs.length + 1}:a`]
    : ['-map', '0:a?']

  if (forJoin) {
    steps.push(`${finalLabel}fps=${req.fps}[out]`)
    finalLabel = '[out]'
  }

  return [
    '-hide_banner',
    '-y',
    '-ss', req.startSec.toFixed(3),
    '-i', req.inputPath,
    ...maskArgs,
    ...silenceArgs,
    '-t', duration.toFixed(3),
    '-filter_complex', steps.join(';'),
    '-map', finalLabel,
    ...audioMap,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    ...(forJoin ? ['-r', String(req.fps), '-video_track_timescale', '90000'] : []),
    '-c:a', 'aac',
    '-b:a', '192k',
    ...(forJoin ? ['-ar', '48000', '-ac', '2'] : []),
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
  onProgress: (p: ExportProgress) => void,
  srcSize?: { w: number; h: number }
): Promise<void> {
  return runFfmpeg(
    buildExportArgs(req, srcSize),
    Math.max(0.05, req.endSec - req.startSec),
    onProgress
  )
}

export async function runCompositeExport(
  req: CompositeExportRequest,
  onProgress: (p: ExportProgress) => void
): Promise<void> {
  const args = await buildCompositeArgs(req)
  return runFfmpeg(args, Math.max(0.05, req.endSec - req.startSec), onProgress)
}

/**
 * Renders each clip through the existing composite path, then joins them.
 *
 * Segments are rendered separately rather than built into one giant filter graph
 * so every clip keeps its own layout and captions. Because they all land on the
 * same canvas, frame rate and audio format, the join itself is a stream copy —
 * no second encode, no generation loss.
 */
export async function runProjectExport(
  req: ProjectExportRequest,
  onProgress: (p: ExportProgress) => void
): Promise<void> {
  const { ffmpegPath } = toolStatus()
  if (!ffmpegPath) throw new Error('ffmpeg not found')
  if (req.segments.length === 0) throw new Error('Add at least one clip')

  const work = join(app.getPath('temp'), 'flowclip-segments')
  mkdirSync(work, { recursive: true })

  const totals = req.segments.map((s) => Math.max(0.05, s.endSec - s.startSec))
  const grandTotal = totals.reduce((a, b) => a + b, 0)
  const parts: string[] = []
  let done = 0

  try {
    for (const [i, seg] of req.segments.entries()) {
      const out = join(work, `seg_${Date.now().toString(36)}_${i}.mp4`)
      const args = await buildCompositeArgs({
        inputPath: seg.inputPath,
        outputPath: out,
        startSec: seg.startSec,
        endSec: seg.endSec,
        regions: seg.regions,
        srcWidth: seg.srcWidth,
        srcHeight: seg.srcHeight,
        canvas: req.canvas,
        captions: seg.captions,
        fps: req.fps,
        hasAudio: seg.hasAudio
      })

      const base = done
      await runFfmpeg(args, totals[i], (p) => {
        onProgress({
          percent: grandTotal > 0 ? (base + p.timeSec) / grandTotal : 0,
          timeSec: base + p.timeSec,
          speed: p.speed
        })
      })
      done += totals[i]
      parts.push(out)
    }

    if (parts.length === 1) {
      copyFileSync(parts[0], req.outputPath)
      return
    }

    // The demuxer wants forward slashes and quoted paths, one per line.
    const listPath = join(work, `list_${Date.now().toString(36)}.txt`)
    writeFileSync(
      listPath,
      parts.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'),
      'utf8'
    )

    await runFfmpeg(
      [
        '-hide_banner', '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', listPath,
        '-c', 'copy',
        '-movflags', '+faststart',
        req.outputPath
      ],
      grandTotal,
      () => {
        /* the join is a copy and effectively instant */
      }
    )
    rmSync(listPath, { force: true })
  } finally {
    for (const p of parts) rmSync(p, { force: true })
  }
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
