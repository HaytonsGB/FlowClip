import type { Region, FitMode, BackdropMode } from '../../../shared/types'
import { RADIUS_STEPS, BORDER_STEPS } from '../../../shared/types'
import { PlusIcon, TrashIcon, ArrowUpIcon, ArrowDownIcon } from './Icons'

interface Props {
  regions: Region[]
  selectedId: string | null
  onSelect: (id: string) => void
  onMove: (id: string, dir: -1 | 1) => void
  onRemove: (id: string) => void
  onAdd: () => void
  onFit: (id: string, fit: FitMode) => void
  onBackdrop: (id: string, backdrop: BackdropMode) => void
  onStyle: (id: string, patch: { radius?: number; border?: number }) => void
}

/** Closest step to the current value, so the right chip reads as selected. */
function nearestStep(steps: { value: number }[], value: number): number {
  return steps.reduce(
    (best, s) => (Math.abs(s.value - value) < Math.abs(best - value) ? s.value : best),
    steps[0].value
  )
}

/**
 * Layer stack for the composed output. Listed top-of-stack first, matching what
 * you see on the canvas — the array itself is in paint order, so it is reversed
 * for display.
 */
export function LayersPanel({
  regions,
  selectedId,
  onSelect,
  onMove,
  onRemove,
  onAdd,
  onFit,
  onBackdrop,
  onStyle
}: Props): JSX.Element {
  const top = [...regions].reverse()

  return (
    <aside className="layers">
      <div className="pane-head">
        <span className="pane-title layers-title">Layers</span>
      </div>

      <div className="layers-list">
        {top.length === 0 && <p className="layers-empty">No boxes yet.</p>}

        {top.map((r, i) => {
          const isTop = i === 0
          const isBottom = i === top.length - 1
          return (
            <div
              key={r.id}
              className={`layer ${selectedId === r.id ? 'active' : ''}`}
              onClick={() => onSelect(r.id)}
            >
              <div className="layer-row">
                <span className="layer-name">{r.label}</span>
                <div className="layer-order">
                  <button
                    className="icon-btn"
                    disabled={isTop}
                    title="Bring forward"
                    onClick={(e) => {
                      e.stopPropagation()
                      onMove(r.id, 1)
                    }}
                  >
                    <ArrowUpIcon size={13} />
                  </button>
                  <button
                    className="icon-btn"
                    disabled={isBottom}
                    title="Send backward"
                    onClick={(e) => {
                      e.stopPropagation()
                      onMove(r.id, -1)
                    }}
                  >
                    <ArrowDownIcon size={13} />
                  </button>
                  <button
                    className="icon-btn danger"
                    title={`Remove ${r.label}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      onRemove(r.id)
                    }}
                  >
                    <TrashIcon size={13} />
                  </button>
                </div>
              </div>

              <div className="fit-toggle" onClick={(e) => e.stopPropagation()}>
                <button
                  className={`fit-opt ${r.fit !== 'contain' ? 'on' : ''}`}
                  onClick={() => onFit(r.id, 'cover')}
                  title="Fill the slot, cropping the overflow"
                >
                  Fill
                </button>
                <button
                  className={`fit-opt ${r.fit === 'contain' ? 'on' : ''}`}
                  onClick={() => onFit(r.id, 'contain')}
                  title="Keep the whole frame, letterboxing the slack"
                >
                  Fit
                </button>
              </div>

              {/* Only a fitted layer has slack to fill. */}
              {r.fit === 'contain' && (
                <div className="fit-toggle backdrop" onClick={(e) => e.stopPropagation()}>
                  <button
                    className={`fit-opt ${r.backdrop !== 'black' ? 'on' : ''}`}
                    onClick={() => onBackdrop(r.id, 'blur')}
                    title="Fill the slack with a blurred copy of this layer"
                  >
                    Blur bg
                  </button>
                  <button
                    className={`fit-opt ${r.backdrop === 'black' ? 'on' : ''}`}
                    onClick={() => onBackdrop(r.id, 'black')}
                    title="Leave the slack black"
                  >
                    Black
                  </button>
                </div>
              )}

              {/* Styling only on the selected layer, to keep the rail readable. */}
              {selectedId === r.id && (
                <div className="layer-style" onClick={(e) => e.stopPropagation()}>
                  <span className="style-label">Corners</span>
                  <div className="fit-toggle">
                    {RADIUS_STEPS.map((s) => (
                      <button
                        key={s.id}
                        className={`fit-opt ${
                          nearestStep(RADIUS_STEPS, r.radius ?? 0) === s.value ? 'on' : ''
                        }`}
                        onClick={() => onStyle(r.id, { radius: s.value })}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>

                  <span className="style-label">Border</span>
                  <div className="fit-toggle">
                    {BORDER_STEPS.map((s) => (
                      <button
                        key={s.id}
                        className={`fit-opt ${
                          nearestStep(BORDER_STEPS, r.border ?? 0) === s.value ? 'on' : ''
                        }`}
                        onClick={() => onStyle(r.id, { border: s.value })}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <button className="btn small add-layer" onClick={onAdd}>
        <PlusIcon size={14} /> Add layer
      </button>
    </aside>
  )
}
