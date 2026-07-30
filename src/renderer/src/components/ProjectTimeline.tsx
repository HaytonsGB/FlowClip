import { useCallback, useMemo, useRef } from 'react'
import type { Clip } from '../../../shared/types'
import { layoutClips, totalDuration, type ClipSpan } from '../../../shared/timeline'
import { clamp, formatTime } from '../lib/format'
import { PlusIcon, TrashIcon, ArrowLeftIcon, ArrowRightIcon } from './Icons'

interface Props {
  clips: Clip[]
  activeId: string | null
  strips: Record<string, string>
  /** Playhead position in project time. */
  projectSec: number
  onSeek: (projectSec: number) => void
  onSelect: (clipId: string) => void
  onTrim: (clipId: string, patch: { inSec?: number; outSec?: number }) => void
  onMove: (clipId: string, dir: -1 | 1) => void
  onRemove: (clipId: string) => void
  onAdd: () => void
}

type Edge = 'in' | 'out'

/** Roughly one label per 90px, snapped to a sensible interval. */
function tickStep(duration: number): number {
  const targets = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
  return targets.find((t) => duration / t <= 12) ?? 900
}

/**
 * The whole project on one track: clips laid end to end after trimming, with a
 * single playhead running across all of them.
 *
 * Trimming is done by dragging a clip's edges, which is also what sets its
 * length here — so the track always shows the finished running order rather
 * than the raw sources.
 */
export function ProjectTimeline({
  clips,
  activeId,
  strips,
  projectSec,
  onSeek,
  onSelect,
  onTrim,
  onMove,
  onRemove,
  onAdd
}: Props): JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null)
  const spans = useMemo(() => layoutClips(clips), [clips])
  const total = totalDuration(spans)

  const ticks = useMemo(() => {
    if (total <= 0) return []
    const step = tickStep(total)
    const out: number[] = []
    for (let t = 0; t <= total; t += step) out.push(t)
    return out
  }, [total])

  const secAtClientX = useCallback(
    (clientX: number): number => {
      const el = trackRef.current
      if (!el || total <= 0) return 0
      const rect = el.getBoundingClientRect()
      return clamp((clientX - rect.left) / rect.width, 0, 1) * total
    },
    [total]
  )

  /**
   * Scrubbing: seek on press, then follow the pointer until release.
   *
   * Listeners go on the window rather than the track so the scrub survives the
   * pointer leaving the timeline, which it does constantly when dragging near
   * either end.
   */
  const startScrub = useCallback(
    (e: React.PointerEvent): void => {
      onSeek(secAtClientX(e.clientX))
      const move = (ev: PointerEvent): void => onSeek(secAtClientX(ev.clientX))
      const up = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [onSeek, secAtClientX]
  )

  /**
   * Dragging an edge changes that clip's trim. Movement is converted through the
   * project scale, so a drag covers the same distance on screen regardless of
   * how long the clip is.
   */
  const startTrim = useCallback(
    (span: ClipSpan, edge: Edge) =>
      (e: React.PointerEvent): void => {
        e.preventDefault()
        e.stopPropagation()
        onSelect(span.clip.id)

        const el = trackRef.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        const startX = e.clientX
        const startIn = span.clip.inSec
        const startOut = span.clip.outSec

        const move = (ev: PointerEvent): void => {
          const delta = ((ev.clientX - startX) / rect.width) * total
          if (edge === 'in') {
            onTrim(span.clip.id, {
              inSec: clamp(startIn + delta, 0, startOut - 0.1)
            })
          } else {
            onTrim(span.clip.id, {
              outSec: clamp(startOut + delta, startIn + 0.1, span.clip.meta.durationSec)
            })
          }
        }
        const up = (): void => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      },
    [onSelect, onTrim, total]
  )

  const pct = (sec: number): string => `${total > 0 ? (sec / total) * 100 : 0}%`

  return (
    <div className="trimbar">
      <div className="ruler">
        {ticks.map((t) => (
          <span key={t} className="ruler-tick" style={{ left: pct(t) }}>
            {formatTime(t).replace(/\.\d$/, '')}
          </span>
        ))}
      </div>

      <div className="trimbar-stage">
        <div
          className="trimbar-track project"
          ref={trackRef}
          onPointerDown={startScrub}
        >
          {spans.map((span) => {
            const isActive = span.clip.id === activeId
            const strip = strips[span.clip.id]
            // The filmstrip covers the whole source, so shift and scale it to
            // show only the trimmed part.
            const srcDur = span.clip.meta.durationSec || 1
            const visible = span.duration / srcDur
            return (
              <div
                key={span.clip.id}
                className={`tl-clip ${isActive ? 'active' : ''}`}
                style={{
                  left: pct(span.start),
                  width: pct(span.duration),
                  backgroundImage: strip ? `url("${strip}")` : undefined,
                  backgroundSize: visible > 0 ? `${(1 / visible) * 100}% 100%` : '100% 100%',
                  backgroundPosition: `${
                    srcDur - span.duration > 0
                      ? (span.clip.inSec / (srcDur - span.duration)) * 100
                      : 0
                  }% center`
                }}
                onPointerDown={(e) => {
                  e.stopPropagation()
                  onSelect(span.clip.id)
                  startScrub(e)
                }}
                title={span.clip.meta.fileName}
              >
                <span className="tl-clip-name">{span.clip.meta.fileName}</span>

                <span className="tl-clip-actions" onPointerDown={(e) => e.stopPropagation()}>
                  <button
                    className="icon-btn"
                    disabled={span.index === 0}
                    title="Move earlier"
                    onClick={() => onMove(span.clip.id, -1)}
                  >
                    <ArrowLeftIcon size={11} />
                  </button>
                  <button
                    className="icon-btn"
                    disabled={span.index === spans.length - 1}
                    title="Move later"
                    onClick={() => onMove(span.clip.id, 1)}
                  >
                    <ArrowRightIcon size={11} />
                  </button>
                  <button
                    className="icon-btn danger"
                    title="Remove from project"
                    onClick={() => onRemove(span.clip.id)}
                  >
                    <TrashIcon size={11} />
                  </button>
                </span>

                {isActive && (
                  <>
                    <span
                      className="tl-handle in"
                      onPointerDown={startTrim(span, 'in')}
                      title="Drag to trim the start"
                    />
                    <span
                      className="tl-handle out"
                      onPointerDown={startTrim(span, 'out')}
                      title="Drag to trim the end"
                    />
                  </>
                )}
              </div>
            )
          })}

          <div className="trimbar-playhead" style={{ left: pct(projectSec) }} />
        </div>
      </div>

      <div className="trimbar-labels">
        <span>
          Playhead <b>{formatTime(projectSec)}</b>
        </span>
        <span className="trimbar-length">
          {clips.length} clip{clips.length === 1 ? '' : 's'} · {formatTime(total)}
        </span>
        <button className="btn small add-clip" onClick={onAdd}>
          <PlusIcon size={13} /> Add clip
        </button>
      </div>
    </div>
  )
}
