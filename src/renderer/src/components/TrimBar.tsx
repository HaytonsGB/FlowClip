import { useCallback, useRef } from 'react'
import { clamp, formatTime } from '../lib/format'

interface Props {
  duration: number
  current: number
  inSec: number
  outSec: number
  onSeek: (sec: number) => void
  onChangeIn: (sec: number) => void
  onChangeOut: (sec: number) => void
}

type Handle = 'in' | 'out' | 'playhead'

/** Scrub track with draggable in/out handles. Everything is % of duration. */
export function TrimBar({
  duration,
  current,
  inSec,
  outSec,
  onSeek,
  onChangeIn,
  onChangeOut
}: Props): JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null)

  const secAtClientX = useCallback(
    (clientX: number): number => {
      const el = trackRef.current
      if (!el || duration <= 0) return 0
      const rect = el.getBoundingClientRect()
      const ratio = clamp((clientX - rect.left) / rect.width, 0, 1)
      return ratio * duration
    },
    [duration]
  )

  const startDrag = useCallback(
    (handle: Handle) =>
      (e: React.PointerEvent): void => {
        e.preventDefault()
        e.stopPropagation()
        const move = (ev: PointerEvent): void => {
          const sec = secAtClientX(ev.clientX)
          // Keep a minimum 0.1s window so the clip can never invert.
          if (handle === 'in') onChangeIn(clamp(sec, 0, outSec - 0.1))
          else if (handle === 'out') onChangeOut(clamp(sec, inSec + 0.1, duration))
          else onSeek(sec)
        }
        const up = (): void => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      },
    [secAtClientX, onChangeIn, onChangeOut, onSeek, inSec, outSec, duration]
  )

  const pct = (sec: number): string => `${duration > 0 ? (sec / duration) * 100 : 0}%`

  return (
    <div className="trimbar">
      <div
        className="trimbar-track"
        ref={trackRef}
        onPointerDown={(e) => onSeek(secAtClientX(e.clientX))}
      >
        <div className="trimbar-dim" style={{ left: 0, width: pct(inSec) }} />
        <div className="trimbar-dim" style={{ left: pct(outSec), right: 0 }} />
        <div
          className="trimbar-selection"
          style={{ left: pct(inSec), width: pct(outSec - inSec) }}
        />
        <div className="trimbar-playhead" style={{ left: pct(current) }} />
        <div
          className="trimbar-handle in"
          style={{ left: pct(inSec) }}
          onPointerDown={startDrag('in')}
          role="slider"
          aria-label="Clip start"
          aria-valuenow={inSec}
          tabIndex={0}
        />
        <div
          className="trimbar-handle out"
          style={{ left: pct(outSec) }}
          onPointerDown={startDrag('out')}
          role="slider"
          aria-label="Clip end"
          aria-valuenow={outSec}
          tabIndex={0}
        />
      </div>
      <div className="trimbar-labels">
        <span>In {formatTime(inSec)}</span>
        <span className="trimbar-length">Clip {formatTime(outSec - inSec)}</span>
        <span>Out {formatTime(outSec)}</span>
      </div>
    </div>
  )
}
