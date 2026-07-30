import { useEffect, useRef, useState } from 'react'
import type { Region, Rect, CaptionWord, CaptionStyle, ColourAdjust } from '../../../shared/types'
import { mediaUrl } from '../../../shared/types'
import { groupIntoLines, wordWindows } from '../../../shared/captions'

interface Props {
  videoRef: React.RefObject<HTMLVideoElement>
  regions: Region[]
  canvas: { w: number; h: number }
  /** Redraw trigger for paused edits, where rAF alone would show a stale frame. */
  revision: number
  words?: CaptionWord[]
  captionStyle?: CaptionStyle
  /** Grade for the active clip, applied to the footage only. */
  colour?: ColourAdjust
}

/**
 * Approximates the burned-in ASS track for the preview: the same line grouping
 * and the same active-word highlight, so what plays here matches the export.
 */
function drawCaptions(
  ctx: CanvasRenderingContext2D,
  canvas: { w: number; h: number },
  words: CaptionWord[],
  style: CaptionStyle,
  timeSec: number
): void {
  // Shared with the ASS writer so the preview shows exactly what the export does:
  // the line stays up for its whole span, and only the highlight moves.
  const group = groupIntoLines(words, style.wordsPerLine).find(
    (g) => timeSec >= g.start && timeSec < g.end
  )
  if (!group) return

  const windows = wordWindows(group)
  const local = windows.findIndex((w) => timeSec >= w.start && timeSec < w.end)
  if (local < 0) return
  const lineStart = group.offset
  const index = lineStart + local
  const line = group.words

  const fontSize = style.size * canvas.h
  ctx.font = `900 ${fontSize}px "${style.font}", "Segoe UI", sans-serif`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'

  const parts = line.map((w) => (style.uppercase ? w.text.toUpperCase() : w.text))
  const space = ctx.measureText(' ').width
  const widths = parts.map((p) => ctx.measureText(p).width)
  const total = widths.reduce((a, b) => a + b, 0) + space * (parts.length - 1)

  let x = (canvas.w - total) / 2
  const y = (1 - style.position) * canvas.h

  ctx.lineJoin = 'round'
  ctx.lineWidth = style.outline * (canvas.h / 1920) * 4
  ctx.strokeStyle = '#000000'

  parts.forEach((part, i) => {
    const active = lineStart + i === index
    ctx.strokeText(part, x, y)
    ctx.fillStyle = active ? style.highlight : style.colour
    ctx.fillText(part, x, y)
    x += widths[i] + space
  })
}

/**
 * Shrinks a source rect to the destination's aspect ratio, centred. Mirrors
 * ffmpeg's `scale=force_original_aspect_ratio=increase` + `crop`, so the preview
 * frames identically to the export rather than stretching.
 */
function coverCrop(src: Rect, srcW: number, srcH: number, dstAspect: number): number[] {
  let sx = src.x * srcW
  let sy = src.y * srcH
  let sw = src.w * srcW
  let sh = src.h * srcH
  const srcAspect = sw / sh

  if (srcAspect > dstAspect) {
    const w = sh * dstAspect
    sx += (sw - w) / 2
    sw = w
  } else {
    const h = sw / dstAspect
    sy += (sh - h) / 2
    sh = h
  }
  return [sx, sy, sw, sh]
}

export function OutputPreview({
  videoRef,
  regions,
  canvas,
  revision,
  words,
  captionStyle,
  colour
}: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  /** Decoded image layers, kept across frames so the draw loop stays cheap. */
  const images = useRef(new Map<string, HTMLImageElement>())
  const [imagesReady, setImagesReady] = useState(0)

  useEffect(() => {
    for (const region of regions) {
      const path = region.source?.path
      if (!path || images.current.has(path)) continue
      const img = new Image()
      // Loaded through the same privileged scheme the video uses, since the
      // renderer cannot read from disk directly.
      img.src = mediaUrl(path)
      img.onload = () => setImagesReady((n) => n + 1)
      images.current.set(path, img)
    }
  }, [regions])

  useEffect(() => {
    const el = canvasRef.current
    const video = videoRef.current
    if (!el || !video) return
    const ctx = el.getContext('2d')
    if (!ctx) return

    let raf = 0
    const draw = (): void => {
      ctx.fillStyle = '#05070f'
      ctx.fillRect(0, 0, canvas.w, canvas.h)

      const vw = video.videoWidth
      const vh = video.videoHeight
      if (vw && vh) {
        // Mirrors ffmpeg's eq filter. Its brightness is an offset in -1..1 while
        // the canvas filter is a multiplier around 1, hence the conversion.
        // Re-applied per layer, since an image layer clears it.
        const grade = colour
          ? `brightness(${(1 + colour.brightness).toFixed(3)}) ` +
            `contrast(${colour.contrast.toFixed(3)}) ` +
            `saturate(${colour.saturation.toFixed(3)})`
          : 'none'

        for (const region of regions) {
          ctx.filter = grade
          const dx = region.dst.x * canvas.w
          const dy = region.dst.y * canvas.h
          const dw = region.dst.w * canvas.w
          const dh = region.dst.h * canvas.h
          if (dw < 1 || dh < 1) continue

          const shorter = Math.min(dw, dh)
          const radius = Math.min(shorter / 2, (region.radius ?? 0) * shorter)
          const border = (region.border ?? 0) * shorter

          // Image layers are contained and overlaid as-is, never padded or
          // backed, so a transparent PNG stays transparent.
          if (region.source?.kind === 'image') {
            ctx.filter = 'none'
            const img = images.current.get(region.source.path)
            if (img?.complete && img.naturalWidth > 0) {
              const scale = Math.min(dw / img.naturalWidth, dh / img.naturalHeight)
              const w = img.naturalWidth * scale
              const h = img.naturalHeight * scale
              ctx.drawImage(img, dx + (dw - w) / 2, dy + (dh - h) / 2, w, h)
            }
            continue
          }

          try {
            // Clip to the rounded slot so corners match the exported mask.
            ctx.save()
            ctx.beginPath()
            ctx.roundRect(dx, dy, dw, dh, radius)
            ctx.clip()

            if (region.fit === 'contain') {
              const sw = region.src.w * vw
              const sh = region.src.h * vh

              if (region.backdrop !== 'black') {
                // Same frame scaled to cover, blurred, sitting behind the fit.
                const [bx, by, bw2, bh2] = coverCrop(region.src, vw, vh, dw / dh)
                ctx.save()
                ctx.beginPath()
                ctx.rect(dx, dy, dw, dh)
                ctx.clip()
                ctx.filter = `blur(${Math.max(4, dw / 22)}px) brightness(0.9) saturate(1.1)`
                ctx.drawImage(video, bx, by, bw2, bh2, dx, dy, dw, dh)
                ctx.restore()
              }

              // Whole source, scaled down and centred on top.
              const scale = Math.min(dw / sw, dh / sh)
              const w = sw * scale
              const h = sh * scale
              ctx.drawImage(
                video,
                region.src.x * vw,
                region.src.y * vh,
                sw,
                sh,
                dx + (dw - w) / 2,
                dy + (dh - h) / 2,
                w,
                h
              )
            } else {
              const [sx, sy, sw, sh] = coverCrop(region.src, vw, vh, dw / dh)
              ctx.drawImage(video, sx, sy, sw, sh, dx, dy, dw, dh)
            }

            if (border > 0) {
              // Stroked inside the clip, so only the inner half shows — the
              // same result as ffmpeg's drawbox on the slot.
              ctx.lineWidth = border * 2
              ctx.strokeStyle = '#ffffff'
              ctx.beginPath()
              ctx.roundRect(dx, dy, dw, dh, radius)
              ctx.stroke()
            }
            ctx.restore()
          } catch {
            // Frame not decodable yet; the next tick will pick it up.
            ctx.restore()
          }
        }
      }

      // Captions and image layers are drawn ungraded — the grade belongs to the
      // footage, not to text laid over it.
      ctx.filter = 'none'

      if (words?.length && captionStyle) {
        drawCaptions(ctx, canvas, words, captionStyle, video.currentTime)
      }

      raf = requestAnimationFrame(draw)
    }

    draw()
    return () => cancelAnimationFrame(raf)
  }, [
    videoRef,
    regions,
    canvas,
    canvas.w,
    canvas.h,
    revision,
    words,
    captionStyle,
    colour,
    imagesReady
  ])

  return <canvas ref={canvasRef} width={canvas.w} height={canvas.h} className="output-canvas" />
}
