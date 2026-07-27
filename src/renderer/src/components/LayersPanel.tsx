import type { Region, FitMode } from '../../../shared/types'
import { PlusIcon, TrashIcon, ArrowUpIcon, ArrowDownIcon } from './Icons'

interface Props {
  regions: Region[]
  selectedId: string | null
  onSelect: (id: string) => void
  onMove: (id: string, dir: -1 | 1) => void
  onRemove: (id: string) => void
  onAdd: () => void
  onFit: (id: string, fit: FitMode) => void
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
  onFit
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
