import type { AspectPreset, Region } from '../../../shared/types'
import { ASPECT_LABELS, LAYOUT_PRESETS } from '../../../shared/types'
import { TOOLS, type ToolId } from './ToolRail'
import { MarkInIcon, MarkOutIcon, ResetIcon, PlusIcon, TrashIcon } from './Icons'

const ASPECTS: AspectPreset[] = ['vertical', 'square', 'wide', 'source']

/** What each not-yet-built tool will do, so the rail isn't a wall of dead ends. */
const PLANNED: Record<string, string[]> = {
  captions: [
    'Auto-transcribe speech locally with Whisper — no upload, no subscription',
    'Word-by-word animated captions in viral styles',
    'Edit any word the transcript gets wrong'
  ],
  audio: [
    'Drop in a music track and trim it to the clip',
    'Sound effects library for punch-ins and transitions',
    'Duck the music automatically under speech'
  ],
  text: [
    'Big bold meme text with outlines and shadows',
    'Hook text that animates in on the first frame',
    'Position and time each caption on the timeline'
  ],
  stickers: [
    'Emoji and sticker overlays',
    'Drop in your own images and logos',
    'Scale, rotate and keyframe them over time'
  ],
  effects: [
    'Zoom punches and shake on the beat',
    'Transitions between cuts',
    'Colour filters and grading presets'
  ]
}

interface Props {
  tool: ToolId
  aspect: AspectPreset
  onAspect: (a: AspectPreset) => void
  onSetIn: () => void
  onSetOut: () => void
  onReset: () => void
  regions: Region[]
  selectedId: string | null
  activePreset: string | null
  onSelectRegion: (id: string) => void
  onApplyPreset: (id: string) => void
  onAddRegion: () => void
  onRemoveRegion: (id: string) => void
}

export function ToolPanel({
  tool,
  aspect,
  onAspect,
  onSetIn,
  onSetOut,
  onReset,
  regions,
  selectedId,
  activePreset,
  onSelectRegion,
  onApplyPreset,
  onAddRegion,
  onRemoveRegion
}: Props): JSX.Element {
  if (tool === 'trim') {
    return (
      <div className="panel">
        <div className="panel-actions">
          <button className="btn" onClick={onSetIn} title="Start the clip here (I)">
            <MarkInIcon size={16} /> Set start
          </button>
          <button className="btn" onClick={onSetOut} title="End the clip here (O)">
            <MarkOutIcon size={16} /> Set end
          </button>
          <button className="btn ghost" onClick={onReset} title="Select the whole video">
            <ResetIcon size={16} /> Reset
          </button>
        </div>
        <p className="panel-hint">
          Drag the cyan and magenta handles on the timeline, or park the playhead and use these
          buttons. Playback loops inside your selection so you preview the real clip.
        </p>
      </div>
    )
  }

  if (tool === 'layout') {
    return (
      <div className="panel">
        <div className="layout-row">
          <span className="panel-label">Canvas</span>
          <div className="aspect-picker">
            {ASPECTS.map((a) => (
              <button
                key={a}
                className={`chip ${aspect === a ? 'active' : ''}`}
                onClick={() => onAspect(a)}
              >
                {ASPECT_LABELS[a]}
              </button>
            ))}
          </div>
          <span className="panel-label preset">Preset</span>
          <div className="aspect-picker">
            {LAYOUT_PRESETS.map((p) => (
              <button
                key={p.id}
                className={`chip ${activePreset === p.id ? 'active' : ''}`}
                onClick={() => onApplyPreset(p.id)}
                title={p.description}
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>

        <div className="layout-row">
          <span className="panel-label">Boxes</span>
          <div className="region-list">
            {regions.map((r, i) => (
              <span
                key={r.id}
                className={`region-pill ${selectedId === r.id ? 'active' : ''}`}
                onClick={() => onSelectRegion(r.id)}
              >
                <i className="region-dot" data-index={i % 4} />
                {r.label}
                <button
                  className="region-del"
                  title={`Remove ${r.label}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    onRemoveRegion(r.id)
                  }}
                >
                  <TrashIcon size={12} />
                </button>
              </span>
            ))}
            <button className="btn small" onClick={onAddRegion}>
              <PlusIcon size={14} /> Add box
            </button>
          </div>
        </div>

        <p className="panel-hint">
          Pick a box to select it, then drag it on the <b>Source</b> to choose what it grabs, or on
          the <b>Output</b> to place it.
        </p>
      </div>
    )
  }

  const meta = TOOLS.find((t) => t.id === tool)
  const Icon = meta?.icon
  return (
    <div className="panel">
      <div className="soon-card">
        <div className="soon-head">
          {Icon && <Icon size={18} />}
          <strong>{meta?.label}</strong>
          <span className="soon-tag">not built yet · {meta?.milestone}</span>
        </div>
        <ul className="soon-list">
          {(PLANNED[tool] ?? []).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
    </div>
  )
}
