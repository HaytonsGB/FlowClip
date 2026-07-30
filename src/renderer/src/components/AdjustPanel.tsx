import type { ColourAdjust } from '../../../shared/types'
import { NEUTRAL_COLOUR, isNeutralColour } from '../../../shared/types'
import { ResetIcon } from './Icons'

interface Props {
  /** The clip's own audio level. */
  volume: number
  colour: ColourAdjust
  hasAudio: boolean
  onVolume: (v: number) => void
  onColour: (patch: Partial<ColourAdjust>) => void
  onReset: () => void
}

/** Grades that suit gameplay footage, which is usually flat and a bit dark. */
const LOOKS: { id: string; label: string; value: ColourAdjust }[] = [
  { id: 'none', label: 'None', value: NEUTRAL_COLOUR },
  { id: 'punch', label: 'Punchy', value: { brightness: 0.03, contrast: 1.18, saturation: 1.25 } },
  { id: 'vivid', label: 'Vivid', value: { brightness: 0.05, contrast: 1.1, saturation: 1.5 } },
  { id: 'flat', label: 'Soft', value: { brightness: 0.06, contrast: 0.9, saturation: 0.9 } },
  { id: 'mono', label: 'Mono', value: { brightness: 0.02, contrast: 1.15, saturation: 0 } }
]

function matches(a: ColourAdjust, b: ColourAdjust): boolean {
  return (
    Math.abs(a.brightness - b.brightness) < 0.005 &&
    Math.abs(a.contrast - b.contrast) < 0.005 &&
    Math.abs(a.saturation - b.saturation) < 0.005
  )
}

export function AdjustPanel({
  volume,
  colour,
  hasAudio,
  onVolume,
  onColour,
  onReset
}: Props): JSX.Element {
  return (
    <div className="panel">
      <div className="layout-row">
        <span className="panel-label">Audio</span>
        {hasAudio ? (
          <label className="mini-field wide">
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={volume}
              onChange={(e) => onVolume(Number(e.target.value))}
            />
            <b className="audio-vol">{Math.round(volume * 100)}%</b>
          </label>
        ) : (
          <span className="panel-hint inline">This clip has no audio track.</span>
        )}
        <button className="btn small ghost" onClick={onReset} title="Back to neutral">
          <ResetIcon size={14} /> Reset all
        </button>
      </div>

      <div className="layout-row">
        <span className="panel-label">Look</span>
        <div className="aspect-picker">
          {LOOKS.map((l) => (
            <button
              key={l.id}
              className={`chip ${matches(colour, l.value) ? 'active' : ''}`}
              onClick={() => onColour(l.value)}
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>

      <div className="layout-row">
        <span className="panel-label">Colour</span>
        <label className="mini-field">
          Bright
          <input
            type="range"
            min={-0.4}
            max={0.4}
            step={0.01}
            value={colour.brightness}
            onChange={(e) => onColour({ brightness: Number(e.target.value) })}
          />
        </label>
        <label className="mini-field">
          Contrast
          <input
            type="range"
            min={0.5}
            max={1.8}
            step={0.02}
            value={colour.contrast}
            onChange={(e) => onColour({ contrast: Number(e.target.value) })}
          />
        </label>
        <label className="mini-field">
          Saturation
          <input
            type="range"
            min={0}
            max={2}
            step={0.02}
            value={colour.saturation}
            onChange={(e) => onColour({ saturation: Number(e.target.value) })}
          />
        </label>
        {!isNeutralColour(colour) && <span className="graded-dot" title="Graded" />}
      </div>

      <p className="panel-hint">
        Both apply to the selected clip only, so a dark take can be lifted without touching the
        rest. Audio is set against any music laid over the top.
      </p>
    </div>
  )
}
