/**
 * Maps between project time and clip-local time.
 *
 * The timeline shows clips laid end to end after trimming, so project time runs
 * 0..totalDuration while each clip's video element still seeks in its own source
 * time. Everything that scrubs, plays or draws needs to convert between the two,
 * so the conversion lives here rather than being re-derived per component.
 */
import type { Clip, TextOverlay } from './types'

export interface ClipSpan {
  clip: Clip
  index: number
  /** Project-time bounds of this clip, in seconds. */
  start: number
  end: number
  /** Trimmed length. */
  duration: number
}

export function layoutClips(clips: Clip[]): ClipSpan[] {
  const spans: ClipSpan[] = []
  let cursor = 0
  clips.forEach((clip, index) => {
    const duration = Math.max(0, clip.outSec - clip.inSec)
    spans.push({ clip, index, start: cursor, end: cursor + duration, duration })
    cursor += duration
  })
  return spans
}

export function totalDuration(spans: ClipSpan[]): number {
  return spans.length ? spans[spans.length - 1].end : 0
}

/** The clip playing at a project time, and how far into its source that is. */
export function resolveTime(
  spans: ClipSpan[],
  projectSec: number
): { span: ClipSpan; sourceSec: number } | null {
  if (!spans.length) return null
  // Past the end, hold on the final frame rather than returning nothing.
  const t = Math.max(0, Math.min(projectSec, totalDuration(spans) - 0.001))
  const span = spans.find((s) => t >= s.start && t < s.end) ?? spans[spans.length - 1]
  return { span, sourceSec: span.clip.inSec + (t - span.start) }
}

/** Project time for a position inside a clip's source. */
export function projectTimeOf(span: ClipSpan, sourceSec: number): number {
  return span.start + (sourceSec - span.clip.inSec)
}

export function spanOf(spans: ClipSpan[], clipId: string): ClipSpan | null {
  return spans.find((s) => s.clip.id === clipId) ?? null
}

/**
 * The overlays visible during one clip, retimed into that clip's source time.
 *
 * Text is placed against the finished piece, but each clip is rendered on its
 * own before the join, so an overlay spanning a cut has to be clipped to each
 * side of it and shifted onto that clip's own clock.
 */
export function textsForSpan(span: ClipSpan, texts: TextOverlay[]): TextOverlay[] {
  const out: TextOverlay[] = []
  for (const t of texts) {
    const from = Math.max(t.startSec, span.start)
    const to = Math.min(t.endSec, span.end)
    if (to - from <= 0.02) continue
    out.push({
      ...t,
      startSec: span.clip.inSec + (from - span.start),
      endSec: span.clip.inSec + (to - span.start)
    })
  }
  return out
}
