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
  /** Guide lines (0..1) that edges and centres snap to. */
  snapX?: number[]
  snapY?: number[]
}

const MIN = 0.06
/** Within ~1.2% of a guide, edges lock to it. */
const SNAP_TOL = 0.012

/** Nearest target within tolerance, else the value unchanged. */
function snapTo(value: number, targets: number[] | undefined): number {
  if (!targets?.length) return value
  let best = value
  let bestDelta = SNAP_TOL
  for (const t of targets) {
    const d = Math.abs(value - t)
    if (d < bestDelta) {
      bestDelta = d
      best = t
    }
  }
  return best
}

/**
 * Snap a box's position by whichever of its two edges is closest to a guide,
 * so dragging locks to edges and centre lines without fighting the pointer.
 */
function snapSpan(pos: number, size: number, targets: number[] | undefined): number {
  if (!targets?.length) return pos
  const leading = snapTo(pos, targets)
  const trailing = snapTo(pos + size, targets) - size
  const centre = snapTo(pos + size / 2, targets) - size / 2
  let best = pos
  let bestDelta = Number.POSITIVE_INFINITY
  for (const c of [leading, trailing, centre]) {
    const d = Math.abs(c - pos)
    if (d > 0 && d < bestDelta) {
      bestDelta = d
      best = c
    }
  }
  return bestDelta === Number.POSITIVE_INFINITY ? pos : best
}

/** Draggable, resizable rectangle in normalised (0..1) space. */
export function RegionRect({
  rect,
  onChange,
  boundsRef,
  label,
  tone,
  selected,
  onSelect,
  lockAspect,
  snapX,
  snapY
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
            const rawX = clamp(start.x + dx, 0, 1 - start.w)
            const rawY = clamp(start.y + dy, 0, 1 - start.h)
            onChange({
              ...start,
              x: clamp(snapSpan(rawX, start.w, snapX), 0, 1 - start.w),
              y: clamp(snapSpan(rawY, start.h, snapY), 0, 1 - start.h)
            })
            return
          }

          // Keep the opposite corner pinned and grow from the dragged one.
          const right = start.x + start.w
          const bottom = start.y + start.h
          let next: Rect

          // Snap the edge being dragged, not the anchored one.
          const edgeR = clamp(snapTo(start.x + start.w + dx, snapX), start.x + MIN, 1)
          const edgeB = clamp(snapTo(start.y + start.h + dy, snapY), start.y + MIN, 1)
          const edgeL = clamp(snapTo(start.x + dx, snapX), 0, right - MIN)
          const edgeT = clamp(snapTo(start.y + dy, snapY), 0, bottom - MIN)

          if (mode === 'se') {
            next = { x: start.x, y: start.y, w: edgeR - start.x, h: edgeB - start.y }
          } else if (mode === 'sw') {
            next = { x: edgeL, y: start.y, w: right - edgeL, h: edgeB - start.y }
          } else if (mode === 'ne') {
            next = { x: start.x, y: edgeT, w: edgeR - start.x, h: bottom - edgeT }
          } else {
            next = { x: edgeL, y: edgeT, w: right - edgeL, h: bottom - edgeT }
          }

          // Shift keeps the box's on-screen shape. Normalised units are not
          // square, so the ratio is measured in pixels.
          const ratio =
            ev.shiftKey && start.h > 0
              ? (start.w * bounds.width) / (start.h * bounds.height)
              : lockAspect
          if (ratio && ratio > 0) {
            const h = clamp((next.w * bounds.width) / (ratio * bounds.height), MIN, 1)
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
      className={`region ${tone} ${selected ? 'selected' : ''} ${
        // Sits above the box normally; a box near the top has nowhere to put it
        // there, so it drops underneath instead of being clipped off the frame.
        rect.y < 0.06 ? 'label-below' : ''
      }`}
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
