import { useCallback } from 'react'
import type { Rect } from '../../../shared/types'
import { clamp } from '../lib/format'

type Corner = 'nw' | 'ne' | 'sw' | 'se'

interface Props {
  rect: Rect
  onChange: (r: Rect) => void
  /** Element the rect is measured against — the letterboxed picture or canvas. */
  boundsRef: React.RefObject<HTMLElement>
  label: string
  tone: 'src' | 'dst'
  selected: boolean
  onSelect: () => void
  /** Locks the box to this width/height ratio while resizing. */
  lockAspect?: number
}

const MIN = 0.06

/** Draggable, resizable rectangle in normalised (0..1) space. */
export function RegionRect({
  rect,
  onChange,
  boundsRef,
  label,
  tone,
  selected,
  onSelect,
  lockAspect
}: Props): JSX.Element {
  const drag = useCallback(
    (mode: 'move' | Corner) =>
      (e: React.PointerEvent): void => {
        e.preventDefault()
        e.stopPropagation()
        onSelect()

        const bounds = boundsRef.current?.getBoundingClientRect()
        if (!bounds || bounds.width === 0 || bounds.height === 0) return

        const startX = e.clientX
        const startY = e.clientY
        const start = { ...rect }

        const move = (ev: PointerEvent): void => {
          const dx = (ev.clientX - startX) / bounds.width
          const dy = (ev.clientY - startY) / bounds.height

          if (mode === 'move') {
            onChange({
              ...start,
              x: clamp(start.x + dx, 0, 1 - start.w),
              y: clamp(start.y + dy, 0, 1 - start.h)
            })
            return
          }

          // Keep the opposite corner pinned and grow from the dragged one.
          const right = start.x + start.w
          const bottom = start.y + start.h
          let next: Rect

          if (mode === 'se') {
            next = {
              x: start.x,
              y: start.y,
              w: clamp(start.w + dx, MIN, 1 - start.x),
              h: clamp(start.h + dy, MIN, 1 - start.y)
            }
          } else if (mode === 'sw') {
            const x = clamp(start.x + dx, 0, right - MIN)
            next = { x, y: start.y, w: right - x, h: clamp(start.h + dy, MIN, 1 - start.y) }
          } else if (mode === 'ne') {
            const y = clamp(start.y + dy, 0, bottom - MIN)
            next = { x: start.x, y, w: clamp(start.w + dx, MIN, 1 - start.x), h: bottom - y }
          } else {
            const x = clamp(start.x + dx, 0, right - MIN)
            const y = clamp(start.y + dy, 0, bottom - MIN)
            next = { x, y, w: right - x, h: bottom - y }
          }

          if (lockAspect && lockAspect > 0) {
            // Derive height from width so the box keeps the output slot's shape.
            const h = clamp(next.w / lockAspect, MIN, 1)
            if (mode === 'ne' || mode === 'nw') next.y = clamp(bottom - h, 0, 1 - h)
            next.h = h
          }

          onChange(next)
        }

        const up = (): void => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      },
    [rect, onChange, boundsRef, onSelect, lockAspect]
  )

  return (
    <div
      className={`region ${tone} ${selected ? 'selected' : ''}`}
      style={{
        left: `${rect.x * 100}%`,
        top: `${rect.y * 100}%`,
        width: `${rect.w * 100}%`,
        height: `${rect.h * 100}%`
      }}
      onPointerDown={drag('move')}
    >
      <span className="region-label">{label}</span>
      {(['nw', 'ne', 'sw', 'se'] as Corner[]).map((c) => (
        <span key={c} className={`region-handle ${c}`} onPointerDown={drag(c)} />
      ))}
    </div>
  )
}
