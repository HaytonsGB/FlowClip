import type { TextOverlay } from '../../../shared/types'
import { TextIcon, PlusIcon, TrashIcon } from './Icons'
import { formatTime } from '../lib/format'

interface Props {
  texts: TextOverlay[]
  selectedId: string | null
  projectSec: number
  onAdd: () => void
  onSelect: (id: string) => void
  onPatch: (id: string, patch: Partial<TextOverlay>) => void
  onRemove: (id: string) => void
  onSeek: (sec: number) => void
}

const FONTS = ['Arial Black', 'Impact', 'Segoe UI', 'Georgia', 'Comic Sans MS']

export function TextPanel({
  texts,
  selectedId,
  projectSec,
  onAdd,
  onSelect,
  onPatch,
  onRemove,
  onSeek
}: Props): JSX.Element {
  const selected = texts.find((t) => t.id === selectedId) ?? null

  return (
    <div className="panel">
      <div className="layout-row">
        <button className="btn" onClick={onAdd} title={`Add text at ${formatTime(projectSec)}`}>
          <TextIcon size={16} /> Add text at {formatTime(projectSec)}
        </button>

        <div className="region-list">
          {texts.map((t) => (
            <span
              key={t.id}
              className={`region-pill ${selectedId === t.id ? 'active' : ''}`}
              onClick={() => {
                onSelect(t.id)
                onSeek(t.startSec)
              }}
              title={`${formatTime(t.startSec)} – ${formatTime(t.endSec)}`}
            >
              {t.text.slice(0, 14) || '(empty)'}
              <button
                className="region-del"
                onClick={(e) => {
                  e.stopPropagation()
                  onRemove(t.id)
                }}
              >
                <TrashIcon size={12} />
              </button>
            </span>
          ))}
        </div>
      </div>

      {selected ? (
        <>
          <div className="layout-row">
            <span className="panel-label">Text</span>
            <input
              className="line-text"
              value={selected.text}
              onChange={(e) => onPatch(selected.id, { text: e.target.value })}
              spellCheck={false}
              placeholder="Type your hook"
            />
            <label className="mini-field colour">
              Colour
              <input
                type="color"
                value={selected.colour}
                onChange={(e) => onPatch(selected.id, { colour: e.target.value })}
              />
            </label>
          </div>

          <div className="layout-row">
            <span className="panel-label">Style</span>
            <select
              className="mini-select"
              value={selected.font}
              onChange={(e) => onPatch(selected.id, { font: e.target.value })}
            >
              {FONTS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>

            <label className="mini-field">
              Size
              <input
                type="range"
                min={0.025}
                max={0.14}
                step={0.005}
                value={selected.size}
                onChange={(e) => onPatch(selected.id, { size: Number(e.target.value) })}
              />
            </label>

            <div className="fit-toggle">
              <button
                className={`fit-opt ${selected.boxed ? '' : 'on'}`}
                onClick={() => onPatch(selected.id, { boxed: false })}
                title="Outlined text"
              >
                Outline
              </button>
              <button
                className={`fit-opt ${selected.boxed ? 'on' : ''}`}
                onClick={() => onPatch(selected.id, { boxed: true })}
                title="Text on a filled panel"
              >
                Boxed
              </button>
            </div>

            <div className="fit-toggle">
              <button
                className={`fit-opt ${selected.uppercase ? 'on' : ''}`}
                onClick={() => onPatch(selected.id, { uppercase: !selected.uppercase })}
              >
                CAPS
              </button>
            </div>
          </div>

          <div className="layout-row">
            <span className="panel-label">Timing</span>
            <button
              className="btn small"
              onClick={() => onPatch(selected.id, { startSec: Math.min(projectSec, selected.endSec - 0.2) })}
              title="Start this text at the playhead"
            >
              Start here
            </button>
            <button
              className="btn small"
              onClick={() => onPatch(selected.id, { endSec: Math.max(projectSec, selected.startSec + 0.2) })}
              title="End this text at the playhead"
            >
              End here
            </button>
            <span className="panel-hint inline">
              {formatTime(selected.startSec)} – {formatTime(selected.endSec)} · drag it on the
              Output to place it
            </span>
          </div>
        </>
      ) : (
        <p className="panel-hint">
          <PlusIcon size={13} /> Add text for a hook on the opening frame, a punchline, or a
          label. Each piece has its own time range and is dragged into place on the output.
        </p>
      )}
    </div>
  )
}
