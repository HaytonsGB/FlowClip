import { useCallback } from 'react'
import type { CaptionStyle } from '../../../shared/types'
import { clamp } from '../lib/format'

interface Props {
  style: CaptionStyle
  /** The output frame the caption sits in; drags are measured against it. */
  boundsRef: React.RefObject<HTMLElement>
  onChange: (patch: Partial<CaptionStyle>) => void
}

/**
 * Drag target over the composed output for placing captions.
 *
 * Captions are horizontally centred by the renderer, so this only moves
 * vertically — dragging sideways would imply a horizontal offset the ASS style
 * does not carry.
 */
export function CaptionHandle({ style, boundsRef, onChange }: Props): JSX.Element {
  const startDrag = useCallback(
    (e: React.PointerEvent): void => {
      e.preventDefault()
      const bounds = boundsRef.current?.getBoundingClientRect()
      if (!bounds || bounds.height === 0) return

      const startY = e.clientY
      const startPos = style.position

      const move = (ev: PointerEvent): void => {
        const dy = (ev.clientY - startY) / bounds.height
        // position is measured up from the bottom, so dragging down lowers it.
        onChange({ position: clamp(startPos - dy, 0.04, 0.96) })
      }
      const up = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [style.position, boundsRef, onChange]
  )

  const resize = useCallback(
    (e: React.PointerEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      const bounds = boundsRef.current?.getBoundingClientRect()
      if (!bounds || bounds.height === 0) return

      const startY = e.clientY
      const startSize = style.size

      const move = (ev: PointerEvent): void => {
        const dy = (ev.clientY - startY) / bounds.height
        onChange({ size: clamp(startSize + dy, 0.025, 0.14) })
      }
      const up = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [style.size, boundsRef, onChange]
  )

  // Roughly two lines tall, so the band covers what the captions occupy.
  const heightPct = style.size * 240

  return (
    <div
      className="caption-handle"
      style={{
        top: `${(1 - style.position) * 100}%`,
        height: `${heightPct}%`
      }}
      onPointerDown={startDrag}
      title="Drag to move the captions"
    >
      <span className="caption-handle-label">Captions</span>
      <span className="caption-handle-size" onPointerDown={resize} title="Drag to resize" />
    </div>
  )
}
