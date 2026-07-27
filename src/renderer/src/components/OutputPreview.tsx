import { useEffect, useRef } from 'react'
import type { Region, Rect } from '../../../shared/types'

interface Props {
  videoRef: React.RefObject<HTMLVideoElement>
  regions: Region[]
  canvas: { w: number; h: number }
  /** Redraw trigger for paused edits, where rAF alone would show a stale frame. */
  revision: number
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

export function OutputPreview({ videoRef, regions, canvas, revision }: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

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
        for (const region of regions) {
          const dx = region.dst.x * canvas.w
          const dy = region.dst.y * canvas.h
          const dw = region.dst.w * canvas.w
          const dh = region.dst.h * canvas.h
          if (dw < 1 || dh < 1) continue

          try {
            if (region.fit === 'contain') {
              // Whole source, scaled down and centred; the slack stays black.
              const sw = region.src.w * vw
              const sh = region.src.h * vh
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
          } catch {
            // Frame not decodable yet; the next tick will pick it up.
          }
        }
      }
      raf = requestAnimationFrame(draw)
    }

    draw()
    return () => cancelAnimationFrame(raf)
  }, [videoRef, regions, canvas.w, canvas.h, revision])

  return <canvas ref={canvasRef} width={canvas.w} height={canvas.h} className="output-canvas" />
}
