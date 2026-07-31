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
  /** 0 when silent. Mono needs care: a plain upmix to stereo costs 3 dB. */
  audioChannels: number
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

/**
 * Where a layer draws from. Absent means the clip's own footage, which is what
 * every layer was before images existed.
 */
export type LayerSource = { kind: 'image'; path: string; fileName: string }

export interface Region {
  id: string
  label: string
  /** Crop from the source. For an image layer this crops the image. */
  src: Rect
  dst: Rect
  /** Undefined = the clip's video. */
  source?: LayerSource
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

export function isImageLayer(region: Region): boolean {
  return region.source?.kind === 'image'
}

/**
 * A logo or image layer. Defaults to a modest corner placement and `contain`,
 * since a logo stretched to fill its slot is never what anyone wants.
 */
export function newImageRegion(path: string, fileName: string): Region {
  return {
    id: rid(),
    label: fileName.replace(/\.[^.]+$/, '').slice(0, 24) || 'Image',
    source: { kind: 'image', path, fileName },
    src: { x: 0, y: 0, w: 1, h: 1 },
    dst: { x: 0.06, y: 0.05, w: 0.26, h: 0.1 },
    // Always contained: a stretched logo is never wanted. No backdrop either —
    // the slack stays transparent so a PNG's own transparency survives.
    fit: 'contain'
  }
}

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

/**
 * One clip in the project: a source file plus everything done to it.
 *
 * Trim, layout and captions live per clip rather than per project, because two
 * pieces of footage rarely want the same crop — a facecam sits in a different
 * corner in every recording.
 */
/**
 * Colour grade applied to a whole clip.
 *
 * Deliberately limited to what maps cleanly onto both ffmpeg's `eq` filter and
 * a canvas filter, so the preview and the export cannot disagree.
 */
export interface ColourAdjust {
  /** -1..1, 0 = unchanged. */
  brightness: number
  /** 0..2, 1 = unchanged. */
  contrast: number
  /** 0..2, 1 = unchanged. */
  saturation: number
}

export const NEUTRAL_COLOUR: ColourAdjust = {
  brightness: 0,
  contrast: 1,
  saturation: 1
}

export function isNeutralColour(c: ColourAdjust | undefined): boolean {
  if (!c) return true
  return c.brightness === 0 && c.contrast === 1 && c.saturation === 1
}

export interface Clip {
  id: string
  meta: VideoMeta
  inSec: number
  outSec: number
  regions: Region[]
  words: CaptionWord[]
  /** This clip's own audio level. 1 = unchanged. */
  volume?: number
  colour?: ColourAdjust
  /**
   * Playback rate. 0.5 is half speed, 2 is double. Changes how long the clip
   * occupies the timeline, so anything measuring duration must divide by it.
   */
  speed?: number
  /**
   * Seconds spent easing into this clip's layout from the previous clip's.
   *
   * Only used where the cut is continuous footage — the same file, picking up
   * exactly where the last clip stopped — which is what a split produces. There
   * the two sides are the same moment framed differently, so moving between the
   * framings reads as a deliberate push in rather than a jump. 0 is a hard cut.
   */
  easeSec?: number
  /**
   * Seconds of crossfade between the previous clip and this one.
   *
   * The two overlap for that long, so the finished video is shorter than the
   * clips laid end to end — which is what a dissolve is. Used for cuts between
   * genuinely different moments; a cut inside continuous footage wants
   * [[easeSec]] instead, and setting one clears the other.
   */
  fadeSec?: number
  /** Preset the layout came from, and whether it has since been edited. */
  activePreset: string | null
  presetDirty: boolean
}

/** Long enough to read as a move, short enough not to feel slow. */
export const DEFAULT_EASE_SEC = 0.35
export const EASE_STEPS = [0, 0.2, 0.35, 0.6, 1]
export const FADE_STEPS = [0, 0.25, 0.5, 1]

/**
 * How long clip `index` overlaps the one before it.
 *
 * Capped at half of either clip, since a dissolve longer than the material has
 * nothing left to dissolve into, and zero for the first clip — there is nothing
 * in front of it to fade from.
 */
export function fadeBefore(clips: Clip[], index: number): number {
  if (index <= 0 || index >= clips.length) return 0
  const want = clips[index].fadeSec ?? 0
  if (want <= 0) return 0
  const room = Math.min(
    clipTimelineDuration(clips[index - 1]),
    clipTimelineDuration(clips[index])
  )
  return Math.max(0, Math.min(want, room / 2))
}

/** Two rects are the same slot if nothing has moved by as much as a thousandth. */
function sameRect(a: Rect, b: Rect): boolean {
  return (
    Math.abs(a.x - b.x) < 0.001 &&
    Math.abs(a.y - b.y) < 0.001 &&
    Math.abs(a.w - b.w) < 0.001 &&
    Math.abs(a.h - b.h) < 0.001
  )
}

function lerpRect(a: Rect, b: Rect, t: number): Rect {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    w: a.w + (b.w - a.w) * t,
    h: a.h + (b.h - a.h) * t
  }
}

/**
 * The layout part-way through an ease, for the preview.
 *
 * The conditions here deliberately mirror the ones the export applies: only
 * cover layers drawn from the footage, and only where the slot itself has not
 * moved. A preview that eased something the render hard-cuts would be worse
 * than no preview at all.
 */
export function easedRegions(from: Region[], to: Region[], progress: number): Region[] {
  // Smoothstep, matching the expression driving the render.
  const p = progress <= 0 ? 0 : progress >= 1 ? 1 : progress
  const e = p * p * (3 - 2 * p)
  return to.map((r, i) => {
    const a = from[i]
    if (!a || a.source || r.source) return r
    // A fitted layer keeps its own shape, so it only eases when both framings
    // share one — matching the condition the render applies.
    if (r.fit === 'contain') {
      const from = a.src.w / a.src.h
      const to = r.src.w / r.src.h
      if (Math.abs(from - to) > 0.02) return r
    }
    if (!sameRect(a.dst, r.dst)) return r
    return { ...r, src: lerpRect(a.src, r.src, e) }
  })
}

/**
 * The layout a clip should ease *from*, or null when the cut is a hard one.
 *
 * A clip can only ease from footage that actually ran into it: the same file,
 * ending exactly where this one starts. Anything else is a genuine cut between
 * two different moments, where sliding the framing would look like a mistake
 * rather than a move.
 */
export function easeSource(prev: Clip | null | undefined, clip: Clip): Region[] | null {
  if (!prev || !(clip.easeSec && clip.easeSec > 0)) return null
  if (prev.meta.path !== clip.meta.path) return null
  // Contiguous to within half a frame at 60fps.
  if (Math.abs(prev.outSec - clip.inSec) > 0.008) return null
  // Regions are matched by position, so the layouts have to line up.
  if (prev.regions.length !== clip.regions.length || clip.regions.length === 0) return null

  const moved = clip.regions.some((r, i) => {
    const p = prev.regions[i]
    return !sameRect(p.src, r.src) || !sameRect(p.dst, r.dst)
  })
  return moved ? prev.regions : null
}

let clipSeq = 0

export function newClip(meta: VideoMeta): Clip {
  return {
    id: `c${Date.now().toString(36)}${(clipSeq++).toString(36)}`,
    meta,
    inSec: 0,
    outSec: meta.durationSec,
    regions: [],
    words: [],
    volume: 1,
    colour: { ...NEUTRAL_COLOUR },
    activePreset: null,
    presetDirty: false
  }
}

/** Shortest half a split may leave, so a stray click cannot make a sliver. */
export const MIN_SPLIT_SEC = 0.2

export function canSplit(clip: Clip, atSourceSec: number): boolean {
  return (
    atSourceSec > clip.inSec + MIN_SPLIT_SEC && atSourceSec < clip.outSec - MIN_SPLIT_SEC
  )
}

/**
 * Cuts a clip in two at a point in its source.
 *
 * Both halves keep the same layout, since they are the same footage, but their
 * region ids are regenerated so selection cannot address a box in the wrong
 * clip. Captions follow whichever half their words fall into.
 */
export function splitClip(clip: Clip, atSourceSec: number): [Clip, Clip] | null {
  if (!canSplit(clip, atSourceSec)) return null

  const cloneRegions = (): Region[] => clip.regions.map((r) => ({ ...r, id: rid() }))

  const head: Clip = {
    ...clip,
    outSec: atSourceSec,
    regions: cloneRegions(),
    words: clip.words.filter((w) => w.start < atSourceSec)
  }

  const tail: Clip = {
    ...clip,
    id: `c${Date.now().toString(36)}${(clipSeq++).toString(36)}`,
    inSec: atSourceSec,
    regions: cloneRegions(),
    words: clip.words.filter((w) => w.start >= atSourceSec),
    // Armed but dormant: both halves share a layout, so nothing eases until one
    // of them is reframed — which is exactly when a split is worth easing.
    easeSec: clip.easeSec ?? DEFAULT_EASE_SEC
  }

  return [head, tail]
}

export const SPEED_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4]

export function clipSpeed(clip: Clip): number {
  const s = clip.speed ?? 1
  return s > 0 ? s : 1
}

/**
 * How long a clip occupies the timeline once its speed is applied.
 *
 * Half speed makes a 4s trim last 8s; double makes it last 2s. Everything that
 * lays out or exports the timeline has to agree on this, so it lives here.
 */
export function clipTimelineDuration(clip: Clip): number {
  return Math.max(0, clip.outSec - clip.inSec) / clipSpeed(clip)
}

/** Total runtime of the project — the sum of the trimmed clips. */
export function projectDuration(clips: Clip[]): number {
  return clips.reduce((n, c) => n + clipTimelineDuration(c), 0)
}

/**
 * A music bed or sound effect laid over the finished video.
 *
 * Audio belongs to the project rather than a clip: a music bed runs across cuts,
 * and tying it to one clip would mean it stopped at that clip's end.
 */
export interface AudioTrack {
  id: string
  path: string
  fileName: string
  durationSec: number
  kind: 'music' | 'sfx'
  /** Where it starts in project time. */
  startSec: number
  /** Trim within the audio file itself. */
  inSec: number
  outSec: number
  /** 1 = unchanged. Music defaults low so it sits under speech. */
  volume: number
  fadeInSec: number
  fadeOutSec: number
}

let audioSeq = 0

export function newAudioTrack(
  path: string,
  fileName: string,
  durationSec: number,
  kind: 'music' | 'sfx',
  startSec: number
): AudioTrack {
  return {
    id: `a${Date.now().toString(36)}${(audioSeq++).toString(36)}`,
    path,
    fileName,
    durationSec,
    kind,
    startSec: kind === 'music' ? 0 : startSec,
    inSec: 0,
    outSec: durationSec,
    // A bed at full volume buries whatever is being said over it.
    volume: kind === 'music' ? 0.35 : 0.9,
    fadeInSec: kind === 'music' ? 0.5 : 0,
    fadeOutSec: kind === 'music' ? 1 : 0
  }
}

/**
 * A piece of text laid over the video — a hook, a punchline, a label.
 *
 * Lives on the project with a project-time range, because text is usually
 * placed against the finished piece rather than against whichever clip happens
 * to be underneath it.
 */
/**
 * An image laid over the video for part of its length.
 *
 * Project-level and timed like text, rather than a layer on one clip: a sticker
 * is placed against the finished piece and usually wants to sit across a cut.
 */
export interface Sticker {
  id: string
  path: string
  fileName: string
  startSec: number
  endSec: number
  /** Centre of the sticker, normalised to the canvas. */
  x: number
  y: number
  /** Width as a fraction of the canvas width; height follows the image. */
  size: number
  opacity: number
}

let stickerSeq = 0

export function newSticker(
  path: string,
  fileName: string,
  startSec: number,
  endSec: number
): Sticker {
  return {
    id: `k${Date.now().toString(36)}${(stickerSeq++).toString(36)}`,
    path,
    fileName,
    startSec,
    endSec,
    x: 0.5,
    y: 0.5,
    size: 0.28,
    opacity: 1
  }
}

/**
 * The stickers visible during one clip, retimed onto that clip's own clock.
 *
 * Same reasoning as text: each clip is rendered before the join, so anything
 * spanning a cut has to be clipped to each side and shifted.
 */
export function stickersForSpan(
  span: { start: number; end: number; clip: Clip },
  stickers: Sticker[]
): Sticker[] {
  const out: Sticker[] = []
  for (const s of stickers) {
    const from = Math.max(s.startSec, span.start)
    const to = Math.min(s.endSec, span.end)
    if (to - from <= 0.02) continue
    out.push({
      ...s,
      startSec: span.clip.inSec + (from - span.start) * clipSpeed(span.clip),
      endSec: span.clip.inSec + (to - span.start) * clipSpeed(span.clip)
    })
  }
  return out
}

export interface TextOverlay {
  id: string
  text: string
  startSec: number
  endSec: number
  /** Centre of the text, normalised to the canvas. */
  x: number
  y: number
  /** Cap height as a fraction of canvas height. */
  size: number
  colour: string
  /** Filled panel behind the text, the classic meme look. */
  boxed: boolean
  uppercase: boolean
  font: string
}

let textSeq = 0

export function newTextOverlay(startSec: number, endSec: number): TextOverlay {
  return {
    id: `t${Date.now().toString(36)}${(textSeq++).toString(36)}`,
    text: 'YOUR TEXT',
    startSec,
    endSec,
    x: 0.5,
    y: 0.18,
    size: 0.058,
    colour: '#ffffff',
    boxed: false,
    uppercase: true,
    font: 'Arial Black'
  }
}

/** Burned-in caption track. Absent means no captions on this export. */
export interface CaptionTrack {
  words: CaptionWord[]
  style: CaptionStyle
}

/** One segment of a multi-clip export: a clip plus how to render it. */
export interface ProjectSegment {
  inputPath: string
  startSec: number
  endSec: number
  regions: Region[]
  srcWidth: number
  srcHeight: number
  /** Silent sources need generated silence, or they cannot be joined. */
  hasAudio: boolean
  /** Mono is upmixed with care; a plain conversion to stereo costs 3 dB. */
  audioChannels: number
  volume?: number
  colour?: ColourAdjust
  speed?: number
  captions?: CaptionTrack
  /** Overlays intersecting this segment, already converted to source time. */
  texts?: TextOverlay[]
  /** Layout to ease in from, matched to `regions` by position. */
  easeFrom?: Region[]
  easeSec?: number
  /** Crossfade into this segment from the previous one, in seconds. */
  fadeSec?: number
}

export interface ProjectExportRequest {
  outputPath: string
  segments: ProjectSegment[]
  canvas: { w: number; h: number }
  /** Mixed over the finished video, after the clips are joined. */
  audio?: AudioTrack[]
  /** Every segment is rendered at this rate so the join can be a stream copy. */
  fps: number
}

/** Project frame rate: the fastest source, capped so 120fps captures stay sane. */
export function projectFps(clips: { meta: VideoMeta }[]): number {
  const best = clips.reduce((n, c) => Math.max(n, c.meta.fps || 0), 0)
  if (!best) return 30
  return Math.min(60, Math.round(best))
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
  /**
   * Forces the output frame rate. Set when the clip is one segment of a
   * multi-clip export, where every segment must match to be concatenated.
   */
  fps?: number
  /** Whether the source carries audio; only consulted when `fps` is set. */
  hasAudio?: boolean
  /** Source channel count, so mono can be upmixed without losing 3 dB. */
  audioChannels?: number
  /** The clip's own audio level. 1 = unchanged. */
  volume?: number
  colour?: ColourAdjust
  /** Playback rate; the output is shorter than the trim when above 1. */
  speed?: number
  /** Overlays for this segment, already retimed into its source clock. */
  texts?: TextOverlay[]
  /** Layout to ease in from, matched to `regions` by position. */
  easeFrom?: Region[]
  easeSec?: number
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
