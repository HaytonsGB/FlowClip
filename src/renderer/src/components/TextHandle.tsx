import { useCallback } from 'react'
import type { TextOverlay } from '../../../shared/types'
import { clamp } from '../lib/format'

interface Props {
  overlay: TextOverlay
  selected: boolean
  boundsRef: React.RefObject<HTMLElement>
  onSelect: () => void
  onChange: (patch: Partial<TextOverlay>) => void
}

/**
 * Drag target for a text overlay on the composed output.
 *
 * Unlike the caption block this moves in both axes, because ASS positions
 * overlays absolutely with \pos — so a horizontal offset is something the export
 * can actually honour.
 */
export function TextHandle({
  overlay,
  selected,
  boundsRef,
  onSelect,
  onChange
}: Props): JSX.Element {
  const startDrag = useCallback(
    (e: React.PointerEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      onSelect()

      const bounds = boundsRef.current?.getBoundingClientRect()
      if (!bounds || !bounds.width || !bounds.height) return

      const startX = e.clientX
      const startY = e.clientY
      const originX = overlay.x
      const originY = overlay.y

      const move = (ev: PointerEvent): void => {
        onChange({
          x: clamp(originX + (ev.clientX - startX) / bounds.width, 0.02, 0.98),
          y: clamp(originY + (ev.clientY - startY) / bounds.height, 0.02, 0.98)
        })
      }
      const up = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [overlay.x, overlay.y, boundsRef, onSelect, onChange]
  )

  return (
    <div
      className={`text-handle ${selected ? 'selected' : ''}`}
      style={{ left: `${overlay.x * 100}%`, top: `${overlay.y * 100}%` }}
      onPointerDown={startDrag}
      title="Drag to place this text"
    />
  )
}
