/** Types shared between the Electron main process and the renderer UI. */

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
