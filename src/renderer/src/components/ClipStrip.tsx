import type { Clip } from '../../../shared/types'
import { projectDuration } from '../../../shared/types'
import { PlusIcon, TrashIcon, ArrowUpIcon, ArrowDownIcon } from './Icons'
import { formatTime } from '../lib/format'

interface Props {
  clips: Clip[]
  activeId: string | null
  strips: Record<string, string>
  onSelect: (id: string) => void
  onMove: (id: string, dir: -1 | 1) => void
  onRemove: (id: string) => void
  onAdd: () => void
}

/**
 * The project as an ordered row of clips.
 *
 * Editing stays one clip at a time — selecting a card loads it into the editor
 * below — but the row makes the running order and total length visible, which
 * is what the timeline is actually for at this stage.
 */
export function ClipStrip({
  clips,
  activeId,
  strips,
  onSelect,
  onMove,
  onRemove,
  onAdd
}: Props): JSX.Element {
  const total = projectDuration(clips)

  return (
    <div className="clipstrip">
      <div className="clipstrip-head">
        <span className="panel-label">Clips</span>
        <span className="clipstrip-total">
          {clips.length} · {formatTime(total)} total
        </span>
      </div>

      <div className="clipstrip-row">
        {clips.map((c, i) => (
          <div
            key={c.id}
            className={`clipcard ${activeId === c.id ? 'active' : ''}`}
            onClick={() => onSelect(c.id)}
            title={c.meta.fileName}
            style={
              strips[c.id] ? { backgroundImage: `url("${strips[c.id]}")` } : undefined
            }
          >
            <span className="clipcard-index">{i + 1}</span>
            <div className="clipcard-info">
              <span className="clipcard-name">{c.meta.fileName}</span>
              <span className="clipcard-dur">{formatTime(c.outSec - c.inSec)}</span>
            </div>
            <div className="clipcard-actions">
              <button
                className="icon-btn"
                disabled={i === 0}
                title="Move earlier"
                onClick={(e) => {
                  e.stopPropagation()
                  onMove(c.id, -1)
                }}
              >
                <ArrowUpIcon size={12} />
              </button>
              <button
                className="icon-btn"
                disabled={i === clips.length - 1}
                title="Move later"
                onClick={(e) => {
                  e.stopPropagation()
                  onMove(c.id, 1)
                }}
              >
                <ArrowDownIcon size={12} />
              </button>
              <button
                className="icon-btn danger"
                title="Remove from project"
                onClick={(e) => {
                  e.stopPropagation()
                  onRemove(c.id)
                }}
              >
                <TrashIcon size={12} />
              </button>
            </div>
          </div>
        ))}

        <button className="clipcard add" onClick={onAdd} title="Add another clip">
          <PlusIcon size={18} />
          <span>Add clip</span>
        </button>
      </div>
    </div>
  )
}
