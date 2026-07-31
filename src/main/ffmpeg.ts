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
  AudioTrack,
  Rect
} from '../shared/types'
import { ASPECT_DIMS, isImageLayer, isNeutralColour, defaultCaptionStyle } from '../shared/types'
import type { Region } from '../shared/types'
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
    audioChannels: Number(audio?.channels ?? 0),
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

/**
 * atempo only accepts 0.5–2.0, so anything outside that is reached by chaining
 * several of them. Quarter speed is two 0.5 stages; quadruple is two 2.0 stages.
 */
function atempoChain(speed: number): string[] {
  const out: string[] = []
  let remaining = speed
  while (remaining > 2.0001) {
    out.push('atempo=2.0')
    remaining /= 2
  }
  while (remaining < 0.4999) {
    out.push('atempo=0.5')
    remaining *= 2
  }
  if (Math.abs(remaining - 1) > 0.001) out.push(`atempo=${remaining.toFixed(4)}`)
  return out
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

interface PixelRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * The part of a crop a cover fill actually shows.
 *
 * `scale=…:increase,crop` fills the slot and throws the overflow away, so the
 * visible rectangle is the centred part of the crop matching the slot's aspect.
 * The ease has to move between *those*, or it would drift against the framing
 * the rest of the export uses.
 */
function coverVisible(s: PixelRect, d: { w: number; h: number }): PixelRect {
  const srcAspect = s.w / s.h
  const dstAspect = d.w / d.h
  if (srcAspect > dstAspect) {
    const w = s.h * dstAspect
    return { x: s.x + (s.w - w) / 2, y: s.y, w, h: s.h }
  }
  const h = s.w / dstAspect
  return { x: s.x, y: s.y + (s.h - h) / 2, w: s.w, h }
}

/**
 * Moves a region's framing from one crop to another over the start of a clip.
 *
 * `crop` cannot resize per frame — a filter's output size is fixed when the
 * graph is configured — so the move is done with `zoompan`, which keeps the
 * output size and varies the zoom and offset instead. Expressions run off `on`,
 * the output frame index, and hold the destination framing once the ease ends.
 */
function easeFilter(
  fromSrc: PixelRect,
  toSrc: PixelRect,
  d: { w: number; h: number },
  easeSec: number,
  fps: number,
  src: { w: number; h: number }
): string | null {
  // zoompan's window is always the aspect of whatever it is handed, so the
  // frame is first cropped to a fixed box that has the slot's shape and holds
  // both framings. Everything after that moves inside a box of the right shape.
  const aspect = d.w / d.h
  const x0 = Math.min(fromSrc.x, toSrc.x)
  const y0 = Math.min(fromSrc.y, toSrc.y)
  const x1 = Math.max(fromSrc.x + fromSrc.w, toSrc.x + toSrc.w)
  const y1 = Math.max(fromSrc.y + fromSrc.h, toSrc.y + toSrc.h)

  let uw = Math.ceil(Math.max(x1 - x0, (y1 - y0) * aspect))
  let uh = Math.ceil(uw / aspect)
  // Too big to sit inside the frame at the right shape: the move would have to
  // distort or invent picture, so let the cut stay hard instead.
  if (uw > src.w || uh > src.h) return null
  const ux = Math.round(Math.max(0, Math.min((x0 + x1) / 2 - uw / 2, src.w - uw)))
  const uy = Math.round(Math.max(0, Math.min((y0 + y1) / 2 - uh / 2, src.h - uh)))
  uw = evenClamp(uw, src.w)
  uh = evenClamp(uh, src.h)

  const frames = Math.max(1, Math.round(easeSec * fps))
  // Smoothstep, so the move eases in and out rather than starting at full pelt.
  const p = `min(1,on/${frames})`
  const e = `(${p})*(${p})*(3-2*(${p}))`
  const lerp = (a: number, b: number): string =>
    Math.abs(a - b) < 0.01 ? b.toFixed(3) : `(${a.toFixed(3)}+${(b - a).toFixed(3)}*${e})`

  // zoompan takes a window of (iw/z, ih/z) positioned at (x,y) in *input*
  // coordinates — not in the scaled image — so the offsets are used directly.
  const z = `(${uw}/${lerp(fromSrc.w, toSrc.w)})`
  const x = lerp(fromSrc.x - ux, toSrc.x - ux)
  const y = lerp(fromSrc.y - uy, toSrc.y - uy)
  return (
    `crop=${uw}:${uh}:${ux}:${uy},` +
    `zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${d.w}x${d.h}:fps=${fps}`
  )
}

/**
 * Builds a filter graph that paints each region onto a blank canvas:
 * split the source once per region, crop and scale each, then overlay them in
 * order. This is what lets a vertical export keep the facecam, the gameplay and
 * the minimap instead of centre-cropping to one of them.
 */
export async function buildCompositeArgs(req: CompositeExportRequest): Promise<string[]> {
  const { regions, srcWidth, srcHeight, canvas } = req
  const easeFrom = req.easeFrom
  const easeSec = req.easeSec ?? 0
  if (regions.length === 0) throw new Error('Add at least one box to the layout')

  const rate = req.speed && req.speed > 0 ? req.speed : 1

  /**
   * Segment bounds snapped to the output frame grid.
   *
   * Video cannot end part-way through a frame, so ffmpeg rounds a fractional
   * `-t` *up* to the next whole frame. A cut at 4.017s on a 30fps timeline
   * therefore emits 4.033s of picture while the next segment still starts at
   * 4.017 — the overlap appears in both, and every join replays a fraction of a
   * frame. On split footage that reads as a stutter at each cut.
   *
   * Snapping both ends to the frame grid makes each segment a whole number of
   * frames that butts exactly against its neighbour.
   */
  const frame = 1 / (req.fps && req.fps > 0 ? req.fps : 30)
  const snap = (sec: number): number => Math.round(sec / frame) * frame
  const startSec = snap(req.startSec)
  const endSec = Math.max(startSec + frame, snap(req.endSec))
  const duration = endSec - startSec

  /**
   * What the segment lasts once retimed. `-t` caps the *output*, so a clip at
   * double speed must be capped at half its source length or ffmpeg keeps
   * reading past the trim to fill the time. Snapped again because dividing by
   * the rate can land back off the grid.
   */
  const outDuration = Math.max(frame, snap(duration / rate))
  const steps: string[] = [
    `color=c=black:s=${canvas.w}x${canvas.h}:d=${outDuration.toFixed(3)}[bg]`
  ]

  /**
   * Extra ffmpeg inputs after the video, in the order they are declared. Image
   * layers and corner masks both land here, so indices are handed out from one
   * counter rather than each guessing where the other stopped.
   */
  const extraInputs: string[] = []
  let nextInput = 1
  const addInput = (args: string[]): number => {
    extraInputs.push(...args)
    return nextInput++
  }

  // The grade applies to the whole clip, so it goes on once before the split
  // rather than being repeated on every layer.
  const speed = rate
  const grade = isNeutralColour(req.colour)
    ? 'null'
    : `eq=brightness=${(req.colour?.brightness ?? 0).toFixed(3)}` +
      `:contrast=${(req.colour?.contrast ?? 1).toFixed(3)}` +
      `:saturation=${(req.colour?.saturation ?? 1).toFixed(3)}`

  // setpts scales presentation times: dividing by the rate makes the clip play
  // faster. Applied with the grade, before the split, so every layer inherits it.
  const retime = speed === 1 ? grade : `${grade},setpts=PTS/${speed}`

  // Image layers draw from their own input, so only video layers are split off
  // the source; ffmpeg cannot consume one stream twice.
  const videoRegions = regions.filter((r) => !isImageLayer(r))
  if (videoRegions.length > 0) {
    const labels = videoRegions.map((r) => `[s_${r.id}]`).join('')
    steps.push(
      videoRegions.length === 1
        ? `[0:v]${retime}${labels}`
        : `[0:v]${retime},split=${videoRegions.length}${labels}`
    )
  }

  for (const [i, region] of regions.entries()) {
    const d = toPixels(region.dst, canvas.w, canvas.h)
    const shaped = `sh${i}`

    // An image layer is scaled to fit its slot and overlaid as-is. It is never
    // padded or backed, so a PNG's transparency reaches the canvas intact.
    if (isImageLayer(region) && region.source) {
      const idx = addInput(['-loop', '1', '-i', region.source.path])
      steps.push(
        `[${idx}:v]scale=${d.w}:${d.h}:force_original_aspect_ratio=decrease,` +
          `setsar=1,format=rgba[${shaped}]`
      )
      await finishRegion(region, i, shaped, d)
      continue
    }

    const s = toPixels(region.src, srcWidth, srcHeight)
    const crop = `crop=${s.w}:${s.h}:${s.x}:${s.y}`
    const fill = `scale=${d.w}:${d.h}:force_original_aspect_ratio=increase,crop=${d.w}:${d.h}`

    const from = `[s_${region.id}]`

    // A framing that moves into place, rather than snapping, when this clip
    // picks up where the last one stopped. Only the cover path can do it: a
    // contained layer is letterboxed by `pad`, and zoompan crops rather than
    // pads, so easing one would quietly change what it shows.
    const prev = easeFrom?.[i]
    if (prev && !prev.source && region.fit !== 'contain' && easeSec > 0 && req.fps) {
      const before = toPixels(prev.src, srcWidth, srcHeight)
      const beforeDst = toPixels(prev.dst, canvas.w, canvas.h)
      if (beforeDst.w === d.w && beforeDst.h === d.h) {
        const ease = easeFilter(
          coverVisible(before, d),
          coverVisible(s, d),
          d,
          easeSec,
          req.fps,
          { w: srcWidth, h: srcHeight }
        )
        if (ease) {
          steps.push(`${from}${ease},setsar=1[${shaped}]`)
          await finishRegion(region, i, shaped, d)
          continue
        }
      }
    }

    if (region.fit !== 'contain') {
      steps.push(`${from}${crop},${fill},setsar=1[${shaped}]`)
    } else if (region.backdrop === 'black') {
      steps.push(
        `${from}${crop},scale=${d.w}:${d.h}:force_original_aspect_ratio=decrease,` +
          `pad=${d.w}:${d.h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[${shaped}]`
      )
    } else {
      // Blurred backdrop: one copy fills the slot and is blurred, the other
      // keeps the whole frame and sits centred on top.
      const bw = Math.max(16, evenClamp(d.w / 8, d.w))
      const bh = Math.max(16, evenClamp(d.h / 8, d.h))
      steps.push(`${from}split=2[a${i}][b${i}]`)
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

    await finishRegion(region, i, shaped, d)
  }

  /** Applies border and rounded corners, leaving the layer as [r{i}]. */
  async function finishRegion(
    region: Region,
    i: number,
    shaped: string,
    d: { w: number; h: number }
  ): Promise<void> {
    const shorter = Math.min(d.w, d.h)
    const borderPx = Math.round((region.border ?? 0) * shorter)
    const radiusPx = Math.min(
      Math.floor(shorter / 2),
      Math.round((region.radius ?? 0) * shorter)
    )

    let current = shaped
    if (borderPx > 0) {
      steps.push(`[${current}]drawbox=x=0:y=0:w=iw:h=ih:color=white@1:t=${borderPx}[bd${i}]`)
      current = `bd${i}`
    }

    if (radiusPx > 1) {
      const maskPath = await roundedMask(d.w, d.h, radiusPx)
      const maskIndex = addInput(['-loop', '1', '-i', maskPath])
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

  // One subtitle pass carries both captions and text overlays, so text works
  // whether or not the clip was transcribed.
  const hasWords = Boolean(req.captions && req.captions.words.length > 0)
  const hasTexts = Boolean(req.texts && req.texts.length > 0)
  if (hasWords || hasTexts) {
    const assPath = writeAss(
      req.captions?.words ?? [],
      req.captions?.style ?? defaultCaptionStyle(),
      canvas,
      req.startSec,
      req.texts ?? []
    )
    steps.push(`${finalLabel}subtitles='${escapeFilterPath(assPath)}'[cap]`)
    finalLabel = '[cap]'
  }
  // Joining segments by stream copy only works if they agree on frame rate and
  // audio layout, and a silent source would otherwise produce a segment with no
  // audio stream at all to join against.
  const forJoin = req.fps !== undefined
  const needSilence = forJoin && req.hasAudio === false
  // Declared last, so it takes whatever index the images and masks left free.
  const silenceIndex = needSilence
    ? addInput(['-f', 'lavfi', '-t', outDuration.toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo'])
    : -1
  const audioMap = needSilence ? ['-map', `${silenceIndex}:a`] : ['-map', '0:a?']

  const audioFilters: string[] = []

  /**
   * Mono needs duplicating into both channels, not spreading across them.
   * `-ac 2` distributes the energy and costs exactly 3 dB — measured: a mono
   * source at -21.1 dB came out at -24.1 dB. `pan` copies it instead, so the
   * level survives.
   */
  if (forJoin && !needSilence && req.audioChannels === 1) {
    audioFilters.push('pan=stereo|c0=c0|c1=c0')
  }
  // The clip's own level, set against any music laid over it later.
  if (req.volume !== undefined && req.volume !== 1 && !needSilence) {
    audioFilters.push(`volume=${req.volume.toFixed(3)}`)
  }
  // Audio has to be retimed to match, or it drifts out of sync with the picture.
  if (speed !== 1 && !needSilence) audioFilters.push(...atempoChain(speed))
  /**
   * Pad the audio so `-t` can cut it to exactly the video's length.
   *
   * Video is a whole number of frames while audio ends wherever the samples run
   * out, leaving each segment's audio a few milliseconds short of its picture.
   * Joined by stream copy those shortfalls accumulate — measured at 17ms per
   * join — and the sound creeps ahead of the picture across the export.
   */
  if (forJoin) audioFilters.push('apad')
  const audioFilterArgs = audioFilters.length ? ['-af', audioFilters.join(',')] : []

  if (forJoin) {
    steps.push(`${finalLabel}fps=${req.fps}[out]`)
    finalLabel = '[out]'
  }

  return [
    '-hide_banner',
    '-y',
    '-ss', startSec.toFixed(6),
    '-i', req.inputPath,
    ...extraInputs,
    '-t', outDuration.toFixed(6),
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
    ...audioFilterArgs,
    ...(forJoin ? ['-ar', '48000', '-ac', '2'] : []),
    '-movflags', '+faststart',
    req.outputPath
  ]
}

/**
 * Mixes music and effects over a finished video.
 *
 * Runs as a pass over the joined result rather than per clip, because a music
 * bed spans cuts and would otherwise stop at the end of whichever clip owned it.
 * The video is stream-copied, so this costs an audio encode and nothing more.
 */
export async function mixAudio(
  videoPath: string,
  outputPath: string,
  tracks: AudioTrack[],
  videoHasAudio: boolean
): Promise<void> {
  const { ffmpegPath } = toolStatus()
  if (!ffmpegPath) throw new Error('ffmpeg not found')
  if (!tracks.length) throw new Error('No audio to mix')

  const inputs: string[] = ['-i', videoPath]
  const steps: string[] = []
  const mixLabels: string[] = []

  if (videoHasAudio) mixLabels.push('[0:a]')

  tracks.forEach((t, i) => {
    inputs.push('-i', t.path)
    const idx = i + 1
    const label = `m${i}`
    const delayMs = Math.max(0, Math.round(t.startSec * 1000))
    const parts = [
      `atrim=${t.inSec.toFixed(3)}:${Math.max(t.inSec + 0.05, t.outSec).toFixed(3)}`,
      'asetpts=PTS-STARTPTS',
      `volume=${t.volume.toFixed(3)}`
    ]
    if (t.fadeInSec > 0) parts.push(`afade=t=in:st=0:d=${t.fadeInSec.toFixed(2)}`)
    if (t.fadeOutSec > 0) {
      const len = Math.max(0.1, t.outSec - t.inSec)
      parts.push(
        `afade=t=out:st=${Math.max(0, len - t.fadeOutSec).toFixed(2)}:d=${t.fadeOutSec.toFixed(2)}`
      )
    }
    // adelay must come after the trim, or it pads the untrimmed stream.
    if (delayMs > 0) parts.push(`adelay=${delayMs}|${delayMs}`)
    // Stereo throughout, so amix does not have to reconcile layouts.
    parts.push('aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo')

    steps.push(`[${idx}:a]${parts.join(',')}[${label}]`)
    mixLabels.push(`[${label}]`)
  })

  // duration=first keeps the result the length of the video, so a long music
  // bed cannot extend it. normalize=0 stops amix quietly halving every level
  // as tracks are added.
  steps.push(
    `${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=first:normalize=0[aout]`
  )

  const args = [
    '-hide_banner', '-y',
    ...inputs,
    '-filter_complex', steps.join(';'),
    '-map', '0:v',
    '-c:v', 'copy',
    '-map', '[aout]',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '48000',
    '-ac', '2',
    '-movflags', '+faststart',
    outputPath
  ]

  await new Promise<void>((resolve, reject) => {
    execFile(ffmpegPath, args, { maxBuffer: 10 * 1024 * 1024 }, (err, _o, stderr) => {
      if (err) reject(new Error(stderr || err.message))
      else resolve()
    })
  })
}

/** Duration of an audio file, for laying it out on the timeline. */
export async function probeAudio(filePath: string): Promise<number> {
  const { ffprobePath } = toolStatus()
  if (!ffprobePath) throw new Error('ffprobe not found')
  const out = await new Promise<string>((resolve, reject) => {
    execFile(
      ffprobePath,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath],
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    )
  })
  const n = Number(out.trim())
  if (!Number.isFinite(n) || n <= 0) throw new Error('Could not read that audio file')
  return n
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
  /** Intermediates that are not concat inputs but still need clearing up. */
  const temps: string[] = []
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
        hasAudio: seg.hasAudio,
        audioChannels: seg.audioChannels,
        volume: seg.volume,
        colour: seg.colour,
        speed: seg.speed,
        texts: seg.texts
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

    const music = req.audio ?? []
    // With music to mix, the join lands in a temp file and the mix pass writes
    // the real output; without it, the join writes there directly.
    const joined = music.length
      ? join(work, `joined_${Date.now().toString(36)}.mp4`)
      : req.outputPath
    if (music.length) temps.push(joined)

    if (parts.length === 1) {
      copyFileSync(parts[0], joined)
    } else {
      // The demuxer wants forward slashes and quoted paths, one per line.
      const listPath = join(work, `list_${Date.now().toString(36)}.txt`)
      temps.push(listPath)
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
          // Video is already frame-aligned, so it copies through untouched. The
          // audio is re-encoded as one continuous stream: every segment's AAC
          // carries its own encoder priming, and butting those together by copy
          // leaves a small gap at each join that is audible on a hard cut.
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-b:a', '192k',
          '-ar', '48000',
          '-ac', '2',
          '-movflags', '+faststart',
          joined
        ],
        grandTotal,
        () => {
          /* the join is a copy and effectively instant */
        }
      )
    }

    if (music.length) {
      onProgress({ percent: 0.98, timeSec: grandTotal, speed: 'mixing audio' })
      // Every segment carries an audio stream by now, generated if the source
      // had none, so the video's own audio is always there to mix against.
      await mixAudio(joined, req.outputPath, music, true)
    }
  } finally {
    for (const p of [...parts, ...temps]) rmSync(p, { force: true })
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
