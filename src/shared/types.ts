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

/**
 * What fills the slack around a `contain` layer. `blur` reuses the layer's own
 * frame, scaled to cover and blurred behind it — the standard way to avoid dead
 * black bars in a vertical clip.
 */
export type BackdropMode = 'blur' | 'black'

export interface Region {
  id: string
  label: string
  src: Rect
  dst: Rect
  fit?: FitMode
  /** Only meaningful when `fit` is 'contain'. Defaults to 'blur'. */
  backdrop?: BackdropMode
  /** Corner radius as a fraction of the slot's shorter side. 0 = square. */
  radius?: number
  /** Border thickness as a fraction of the slot's shorter side. 0 = none. */
  border?: number
  /**
   * Keep `src` locked to the centred crop that exactly fills `dst`. Set on
   * gameplay boxes so the main action never needs to be eyeballed, and cleared
   * as soon as the user drags that box themselves.
   */
  auto?: boolean
}

/** Preset steps for the corner and border controls. */
export const RADIUS_STEPS = [
  { id: 'sharp', label: 'Sharp', value: 0 },
  { id: 'soft', label: 'Soft', value: 0.06 },
  { id: 'round', label: 'Round', value: 0.16 }
]

export const BORDER_STEPS = [
  { id: 'none', label: 'None', value: 0 },
  { id: 'thin', label: 'Thin', value: 0.01 },
  { id: 'thick', label: 'Thick', value: 0.025 }
]

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

/** One word with its timing on the source timeline, in seconds. */
export interface CaptionWord {
  text: string
  start: number
  end: number
}

export type WhisperModelId = 'tiny.en' | 'base.en' | 'small.en'

export interface WhisperModelMeta {
  file: string
  url: string
  label: string
  sizeMb: number
  note: string
}

const HF = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

export const WHISPER_MODELS: Record<WhisperModelId, WhisperModelMeta> = {
  'tiny.en': {
    file: 'ggml-tiny.en.bin',
    url: `${HF}/ggml-tiny.en.bin`,
    label: 'Tiny',
    sizeMb: 75,
    note: 'Fastest, roughest — fine for clear speech'
  },
  'base.en': {
    file: 'ggml-base.en.bin',
    url: `${HF}/ggml-base.en.bin`,
    label: 'Base',
    sizeMb: 142,
    note: 'Good balance — recommended'
  },
  'small.en': {
    file: 'ggml-small.en.bin',
    url: `${HF}/ggml-small.en.bin`,
    label: 'Small',
    sizeMb: 466,
    note: 'Most accurate, noticeably slower'
  }
}

export type CaptionPreset = 'pop' | 'clean' | 'bold' | 'karaoke'

export interface CaptionStyle {
  preset: CaptionPreset
  /** Font family resolved from the system by libass. */
  font: string
  /** Cap height as a fraction of the canvas height. */
  size: number
  /** #rrggbb */
  colour: string
  /** #rrggbb applied to the word currently being spoken. */
  highlight: string
  outline: number
  /** Vertical placement, 0 = top, 1 = bottom. */
  position: number
  uppercase: boolean
  /** Words shown together on a line. 1 gives the one-word-at-a-time look. */
  wordsPerLine: number
}

export const CAPTION_PRESETS: Record<CaptionPreset, Omit<CaptionStyle, 'preset'>> = {
  pop: {
    font: 'Arial Black',
    size: 0.062,
    colour: '#ffffff',
    highlight: '#22e0f0',
    outline: 4,
    position: 0.72,
    uppercase: true,
    wordsPerLine: 3
  },
  clean: {
    font: 'Segoe UI',
    size: 0.045,
    colour: '#ffffff',
    highlight: '#ffffff',
    outline: 3,
    position: 0.82,
    uppercase: false,
    wordsPerLine: 5
  },
  bold: {
    font: 'Impact',
    size: 0.085,
    colour: '#ffffff',
    highlight: '#ffe14d',
    outline: 5,
    position: 0.5,
    uppercase: true,
    wordsPerLine: 1
  },
  karaoke: {
    font: 'Arial Black',
    size: 0.055,
    colour: '#ffffff',
    highlight: '#f472e6',
    outline: 4,
    position: 0.76,
    uppercase: true,
    wordsPerLine: 4
  }
}

export const CAPTION_PRESET_LABELS: Record<CaptionPreset, string> = {
  pop: 'Pop',
  clean: 'Clean',
  bold: 'Big & bold',
  karaoke: 'Karaoke'
}

export function defaultCaptionStyle(preset: CaptionPreset = 'pop'): CaptionStyle {
  return { preset, ...CAPTION_PRESETS[preset] }
}

export interface ModelProgress {
  received: number
  total: number
  /** 0..1 */
  percent: number
}

/** Burned-in caption track. Absent means no captions on this export. */
export interface CaptionTrack {
  words: CaptionWord[]
  style: CaptionStyle
}

export interface CompositeExportRequest {
  inputPath: string
  outputPath: string
  startSec: number
  endSec: number
  regions: Region[]
  captions?: CaptionTrack
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
  /** Burning captions forces a re-encode even on an otherwise plain trim. */
  captions?: CaptionTrack
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
