/**
 * Caption line grouping, shared by the ASS writer, the canvas preview and the
 * transcript editor.
 *
 * All three must agree: if the preview groups words differently from the export,
 * what you arrange is not what renders.
 */
import type { CaptionWord } from './types'

/** A pause longer than this starts a new line, since it reads as a new thought. */
const GAP_BREAK_SEC = 0.7

export interface CaptionLine {
  words: CaptionWord[]
  /** Index of this line's first word in the flat word array. */
  offset: number
  start: number
  end: number
}

export function groupIntoLines(words: CaptionWord[], perLine: number): CaptionLine[] {
  const size = Math.max(1, perLine)
  const lines: CaptionLine[] = []
  let current: CaptionWord[] = []
  let offset = 0

  const flush = (): void => {
    if (!current.length) return
    lines.push({
      words: current,
      offset,
      start: current[0].start,
      end: current[current.length - 1].end
    })
    offset += current.length
    current = []
  }

  for (const word of words) {
    const prev = current[current.length - 1]
    if (current.length >= size || (prev && word.start - prev.end > GAP_BREAK_SEC)) flush()
    current.push(word)
  }
  flush()
  return lines
}

/**
 * Rewrites a line's text, spreading its original time span across the new words.
 *
 * Editing text should never desynchronise the clip, so the line keeps its start
 * and end and each word gets a share proportional to its length — longer words
 * take longer to say, so that tracks speech better than an even split.
 */
export function retimeLine(line: CaptionLine, text: string): CaptionWord[] {
  const parts = text.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return []

  const span = Math.max(0.1, line.end - line.start)
  const totalChars = parts.reduce((n, p) => n + p.length, 0) || parts.length

  let cursor = line.start
  return parts.map((part, i) => {
    const share = (part.length || 1) / totalChars
    const start = cursor
    // Pin the final word to the line's end so rounding cannot drift.
    const end = i === parts.length - 1 ? line.end : start + span * share
    cursor = end
    return { text: part, start, end }
  })
}

/** Replaces the words of one line within the full transcript. */
export function replaceLine(
  words: CaptionWord[],
  line: CaptionLine,
  replacement: CaptionWord[]
): CaptionWord[] {
  return [
    ...words.slice(0, line.offset),
    ...replacement,
    ...words.slice(line.offset + line.words.length)
  ]
}
