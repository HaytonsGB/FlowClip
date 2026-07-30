/**
 * Turns word timings into an ASS subtitle file for burn-in.
 *
 * ASS rather than drawtext because libass gives real outlines, per-word colour
 * overrides and reliable centring, and one filter handles the whole track
 * instead of a drawtext node per word.
 */
import { mkdirSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { app } from 'electron'
import type { CaptionWord, CaptionStyle, TextOverlay } from '../shared/types'
import { groupIntoLines, wordWindows } from '../shared/captions'

/** ASS colours are &HAABBGGRR — reversed from hex, with alpha first. */
function assColour(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  const rgb = m ? m[1] : 'ffffff'
  const r = rgb.slice(0, 2)
  const g = rgb.slice(2, 4)
  const b = rgb.slice(4, 6)
  return `&H00${b}${g}${r}`.toUpperCase()
}

function assTime(sec: number): string {
  const s = Math.max(0, sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const rest = s % 60
  const cs = Math.floor((rest % 1) * 100)
  return `${h}:${String(m).padStart(2, '0')}:${String(Math.floor(rest)).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

/** Braces and newlines are override syntax in ASS and must not reach libass raw. */
function escapeText(text: string): string {
  return text.replace(/[{}]/g, '').replace(/\\/g, '').replace(/\r?\n/g, ' ')
}


/**
 * One Dialogue event per word: the whole line is drawn, with the active word
 * recoloured inline. Emitting per word rather than using \k karaoke keeps the
 * timing exactly as whisper reported it.
 */
export function buildAss(
  words: CaptionWord[],
  style: CaptionStyle,
  canvas: { w: number; h: number },
  clipStartSec: number,
  texts: TextOverlay[] = []
): string {
  const fontSize = Math.round(style.size * canvas.h)
  const primary = assColour(style.colour)
  const highlight = assColour(style.highlight)
  // Alignment 2 anchors to the bottom, so the margin is measured up from there.
  const marginV = Math.round((1 - style.position) * canvas.h)

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${canvas.w}`,
    `PlayResY: ${canvas.h}`,
    // 0 = wrap long lines evenly. WrapStyle 2 disables wrapping entirely, which
    // silently clips wide lines off both edges of the frame.
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Caption,${style.font},${fontSize},${primary},${primary},&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,${style.outline},2,2,60,60,${marginV},1`,
    // Overlays are positioned absolutely, so alignment 5 anchors them by their
    // centre and \pos does the placing.
    `Style: Overlay,Arial Black,${fontSize},${primary},${primary},&H00000000,&H90000000,1,0,0,0,100,100,0,0,1,4,1,5,20,20,20,1`,
    // BorderStyle 3 fills a panel behind the text using OutlineColour. It is a
    // style field, not something an inline override can switch on, so the boxed
    // look needs a style of its own.
    `Style: OverlayBox,Arial Black,${fontSize},${primary},${primary},&H00141414,&H00141414,1,0,0,0,100,100,0,0,3,10,0,5,20,20,20,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ]

  const events: string[] = []
  for (const group of groupIntoLines(words, style.wordsPerLine)) {
    const line = group.words
    const windows = wordWindows(group)
    for (let i = 0; i < line.length; i++) {
      const span = windows[i]
      const text = line
        .map((w, j) => {
          const raw = style.uppercase ? w.text.toUpperCase() : w.text
          const safe = escapeText(raw)
          // Recolour just the word being spoken, then restore for the rest.
          return j === i ? `{\\c${highlight}}${safe}{\\c${primary}}` : safe
        })
        .join(' ')

      // Times are relative to the exported clip, which starts at the trim point.
      const start = span.start - clipStartSec
      const end = Math.max(start + 0.05, span.end - clipStartSec)
      events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Caption,,0,0,0,,${text}`)
    }
  }

  // Layer 1 so overlays sit above the caption track rather than under it.
  for (const t of texts) {
    const body = escapeText(t.uppercase ? t.text.toUpperCase() : t.text)
    if (!body.trim()) continue

    const px = Math.round(t.x * canvas.w)
    const py = Math.round(t.y * canvas.h)
    const overrides = [
      `\\pos(${px},${py})`,
      `\\fs${Math.round(t.size * canvas.h)}`,
      `\\c${assColour(t.colour)}`,
      `\\fn${t.font}`
    ].join('')

    const start = t.startSec - clipStartSec
    const end = Math.max(start + 0.05, t.endSec - clipStartSec)
    const styleName = t.boxed ? 'OverlayBox' : 'Overlay'
    events.push(
      `Dialogue: 1,${assTime(start)},${assTime(end)},${styleName},,0,0,0,,{${overrides}}${body}`
    )
  }

  return [...header, ...events].join('\n')
}

/** Writes the track to temp and returns a path ffmpeg's subtitles filter accepts. */
export function writeAss(
  words: CaptionWord[],
  style: CaptionStyle,
  canvas: { w: number; h: number },
  clipStartSec: number,
  texts: TextOverlay[] = []
): string {
  const dir = join(app.getPath('temp'), 'flowclip-subs')
  mkdirSync(dir, { recursive: true })
  const body = buildAss(words, style, canvas, clipStartSec, texts)
  const key = createHash('sha1').update(body).digest('hex').slice(0, 16)
  const out = join(dir, `${key}.ass`)
  writeFileSync(out, body, 'utf8')
  return out
}

/**
 * Escapes a Windows path for use inside a filter argument.
 *
 * The subtitles filter parses its own argument string, so the drive colon and
 * the backslashes both need escaping or the path is read as further options.
 */
export function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:')
}
