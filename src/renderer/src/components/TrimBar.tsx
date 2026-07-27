import { useCallback, useMemo, useRef } from 'react'
import { clamp, formatTime } from '../lib/format'

interface Props {
  duration: number
  current: number
  inSec: number
  outSec: number
  /** flowclip:// URL of the tiled filmstrip, once ffmpeg has rendered it. */
  stripUrl: string
  onSeek: (sec: number) => void
  onChangeIn: (sec: number) => void
  onChangeOut: (sec: number) => void
}

type Handle = 'in' | 'out' | 'playhead'

/** Roughly one label per 90px, snapped to a sensible interval. */
function tickStep(duration: number): number {
  const targets = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
  return targets.find((t) => duration / t <= 12) ?? 900
}

/** Scrub track with draggable in/out handles. Everything is % of duration. */
export function TrimBar({
  duration,
  current,
  inSec,
  outSec,
  stripUrl,
  onSeek,
  onChangeIn,
  onChangeOut
}: Props): JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null)

  const ticks = useMemo(() => {
    if (duration <= 0) return []
    const step = tickStep(duration)
    const out: number[] = []
    for (let t = 0; t <= duration; t += step) out.push(t)
    return out
  }, [duration])

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
      <div className="ruler">
        {ticks.map((t) => (
          <span key={t} className="ruler-tick" style={{ left: pct(t) }}>
            {formatTime(t).replace(/\.\d$/, '')}
          </span>
        ))}
      </div>

      {/* Handles sit in an unclipped layer above the track, otherwise the track's
          overflow:hidden slices them in half at 0% and 100%. */}
      <div className="trimbar-stage">
        <div
          className="trimbar-track"
          ref={trackRef}
          style={stripUrl ? { backgroundImage: `url("${stripUrl}")` } : undefined}
          onPointerDown={(e) => onSeek(secAtClientX(e.clientX))}
        >
          <div className="trimbar-dim" style={{ left: 0, width: pct(inSec) }} />
          <div className="trimbar-dim" style={{ left: pct(outSec), right: 0 }} />
          <div
            className="trimbar-selection"
            style={{ left: pct(inSec), width: pct(outSec - inSec) }}
          >
            <span className="selection-badge">{formatTime(outSec - inSec)}</span>
          </div>
          <div className="trimbar-playhead" style={{ left: pct(current) }} />
        </div>

        <div className="handle-layer">
          <div
            className="trimbar-handle in"
            style={{ left: pct(inSec) }}
            onPointerDown={startDrag('in')}
            role="slider"
            aria-label="Clip start"
            aria-valuenow={inSec}
            title="Drag to set where the clip starts"
            tabIndex={0}
          >
            <span className="grip" />
          </div>
          <div
            className="trimbar-handle out"
            style={{ left: pct(outSec) }}
            onPointerDown={startDrag('out')}
            role="slider"
            aria-label="Clip end"
            aria-valuenow={outSec}
            title="Drag to set where the clip ends"
            tabIndex={0}
          >
            <span className="grip" />
          </div>
        </div>
      </div>

      <div className="trimbar-labels">
        <span>
          Start <b>{formatTime(inSec)}</b>
        </span>
        <span className="trimbar-length">Clip length {formatTime(outSec - inSec)}</span>
        <span>
          End <b>{formatTime(outSec)}</b>
        </span>
      </div>
    </div>
  )
}
