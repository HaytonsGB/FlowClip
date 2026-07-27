/** Types shared between the Electron main process and the renderer UI. */

/** Custom scheme used to stream local media into the renderer. */
export const MEDIA_SCHEME = 'flowclip'

/** Build a renderer-loadable URL for a file on disk. */
export function mediaUrl(filePath: string): string {
  return `${MEDIA_SCHEME}://media/?src=${encodeURIComponent(filePath)}`
}

export interface VideoMeta {
  path: string
  fileName: string
  durationSec: number
  width: number
  height: number
  fps: number
  hasAudio: boolean
  sizeBytes: number
}

/** Social export targets. `source` keeps the original aspect ratio. */
export type AspectPreset = 'source' | 'vertical' | 'square' | 'wide'

/** A rectangle in 0..1 space, so layouts survive any source resolution. */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * One box in the composed output: take `src` out of the source video and paint
 * it into `dst` on the output canvas. Several of these stacked is how a gaming
 * clip keeps its facecam, gameplay and minimap instead of centre-cropping them
 * away.
 */
/**
 * How a box's source fills its output slot.
 * - `cover` crops the overflow so the slot is filled edge to edge.
 * - `contain` keeps the whole source visible and letterboxes the remainder,
 *   which is what you want for gameplay in a stacked layout: the action stays
 *   whole instead of losing its sides to a shorter slot.
 */
export type FitMode = 'cover' | 'contain'

export interface Region {
  id: string
  label: string
  src: Rect
  dst: Rect
  fit?: FitMode
  /**
   * Keep `src` locked to the centred crop that exactly fills `dst`. Set on
   * gameplay boxes so the main action never needs to be eyeballed, and cleared
   * as soon as the user drags that box themselves.
   */
  auto?: boolean
}

/**
 * The centred source crop whose aspect matches a destination slot — the largest
 * rectangle that fills the slot without distortion. Same maths ffmpeg applies
 * with scale-to-cover plus centre crop.
 */
export function centeredSrc(
  srcWidth: number,
  srcHeight: number,
  dst: Rect,
  canvasW: number,
  canvasH: number
): Rect {
  const dstAspect = (dst.w * canvasW) / (dst.h * canvasH)
  const srcAspect = srcWidth / srcHeight
  if (!Number.isFinite(dstAspect) || dstAspect <= 0) return { x: 0, y: 0, w: 1, h: 1 }

  if (dstAspect < srcAspect) {
    const w = dstAspect / srcAspect
    return { x: (1 - w) / 2, y: 0, w, h: 1 }
  }
  const h = srcAspect / dstAspect
  return { x: 0, y: (1 - h) / 2, w: 1, h }
}

export interface LayoutContext {
  /** Source video aspect, width / height. */
  srcAspect: number
  canvasW: number
  canvasH: number
}

export interface LayoutPreset {
  id: string
  name: string
  description: string
  build: (ctx: LayoutContext) => Region[]
}

/**
 * Height (0..1 of the canvas) of a full-width band holding the entire source
 * frame. Sizing the gameplay slot to exactly this means it stays whole with no
 * letterbox bars.
 */
function fullWidthBand(ctx: LayoutContext): number {
  const px = ctx.canvasW / ctx.srcAspect
  return Math.min(1, px / ctx.canvasH)
}

/** A canvas nearly as wide as the source wants overlays, not stacked bands. */
function isWideCanvas(ctx: LayoutContext): boolean {
  return fullWidthBand(ctx) > 0.92
}

let regionSeq = 0
function rid(): string {
  return `r${Date.now().toString(36)}${(regionSeq++).toString(36)}`
}

export const LAYOUT_PRESETS: LayoutPreset[] = [
  {
    id: 'gameplay',
    name: 'Gameplay only',
    description: 'One centred crop filling the frame',
    build: (): Region[] => [
      {
        id: rid(),
        label: 'Gameplay',
        auto: true,
        src: { x: 0.28, y: 0, w: 0.44, h: 1 },
        dst: { x: 0, y: 0, w: 1, h: 1 }
      }
    ]
  },
  {
    id: 'cam-top',
    name: 'Camera + gameplay',
    description: 'Facecam above the gameplay, or picture-in-picture on a wide canvas',
    build: (ctx) => {
      const camera: Region = {
        id: rid(),
        label: 'Camera',
        fit: 'cover',
        src: { x: 0.02, y: 0.56, w: 0.26, h: 0.4 },
        dst: { x: 0, y: 0, w: 1, h: 1 }
      }
      const gameplay: Region = {
        id: rid(),
        label: 'Gameplay',
        // The whole frame; a shorter slot must never crop the action.
        fit: 'contain',
        src: { x: 0, y: 0, w: 1, h: 1 },
        dst: { x: 0, y: 0, w: 1, h: 1 }
      }

      if (isWideCanvas(ctx)) {
        // Gameplay fills the frame; the camera becomes a corner inset.
        gameplay.dst = { x: 0, y: 0, w: 1, h: 1 }
        camera.dst = { x: 0.02, y: 0.63, w: 0.24, h: 0.35 }
        return [gameplay, camera]
      }

      // Gameplay takes exactly the band it needs, camera fills what is left.
      const gh = fullWidthBand(ctx)
      camera.dst = { x: 0, y: 0, w: 1, h: 1 - gh }
      gameplay.dst = { x: 0, y: 1 - gh, w: 1, h: gh }
      return [camera, gameplay]
    }
  },
  {
    id: 'cam-gameplay-map',
    name: 'Camera + gameplay + minimap',
    description: 'Adds a box for the minimap or kill feed',
    build: (ctx) => {
      const camera: Region = {
        id: rid(),
        label: 'Camera',
        fit: 'cover',
        src: { x: 0.02, y: 0.56, w: 0.26, h: 0.4 },
        dst: { x: 0, y: 0, w: 1, h: 1 }
      }
      const gameplay: Region = {
        id: rid(),
        label: 'Gameplay',
        fit: 'contain',
        src: { x: 0, y: 0, w: 1, h: 1 },
        dst: { x: 0, y: 0, w: 1, h: 1 }
      }
      const minimap: Region = {
        id: rid(),
        label: 'Minimap',
        fit: 'cover',
        src: { x: 0.78, y: 0.04, w: 0.2, h: 0.26 },
        dst: { x: 0, y: 0, w: 1, h: 1 }
      }

      if (isWideCanvas(ctx)) {
        gameplay.dst = { x: 0, y: 0, w: 1, h: 1 }
        camera.dst = { x: 0.02, y: 0.63, w: 0.24, h: 0.35 }
        minimap.dst = { x: 0.79, y: 0.03, w: 0.19, h: 0.28 }
        return [gameplay, camera, minimap]
      }

      const gh = fullWidthBand(ctx)
      const spare = 1 - gh
      const camH = spare * 0.62
      camera.dst = { x: 0, y: 0, w: 1, h: camH }
      gameplay.dst = { x: 0, y: camH, w: 1, h: gh }
      minimap.dst = { x: 0, y: camH + gh, w: 1, h: spare - camH }
      return [camera, gameplay, minimap]
    }
  }
]

export function newRegion(label = 'Box'): Region {
  return {
    id: rid(),
    label,
    src: { x: 0.35, y: 0.35, w: 0.3, h: 0.3 },
    dst: { x: 0.1, y: 0.4, w: 0.5, h: 0.2 }
  }
}

export interface CompositeExportRequest {
  inputPath: string
  outputPath: string
  startSec: number
  endSec: number
  regions: Region[]
  /** Source pixel dimensions, needed to turn normalised crops into pixels. */
  srcWidth: number
  srcHeight: number
  canvas: { w: number; h: number }
}

export interface ExportRequest {
  inputPath: string
  outputPath: string
  startSec: number
  endSec: number
  aspect: AspectPreset
  /** Re-encode instead of stream-copy. Required for any reframing. */
  reencode: boolean
}

export interface ExportProgress {
  /** 0..1 */
  percent: number
  timeSec: number
  speed: string
}

export interface ExportResult {
  ok: boolean
  outputPath?: string
  error?: string
}

export interface ToolStatus {
  ffmpegPath: string | null
  ffprobePath: string | null
  ready: boolean
}

export const ASPECT_LABELS: Record<AspectPreset, string> = {
  source: 'Source',
  vertical: '9:16 — TikTok / Shorts',
  square: '1:1 — Feed',
  wide: '16:9 — YouTube'
}

/** Target pixel dimensions per preset. `source` is handled without scaling. */
export const ASPECT_DIMS: Record<Exclude<AspectPreset, 'source'>, { w: number; h: number }> = {
  vertical: { w: 1080, h: 1920 },
  square: { w: 1080, h: 1080 },
  wide: { w: 1920, h: 1080 }
}
