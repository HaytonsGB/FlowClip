import type { AudioTrack, ColourAdjust } from '../../../shared/types'
import { NEUTRAL_COLOUR, isNeutralColour, SPEED_STEPS, EASE_STEPS } from '../../../shared/types'
import { ResetIcon } from './Icons'

interface Props {
  /** The clip's own audio level. */
  volume: number
  colour: ColourAdjust
  hasAudio: boolean
  /** Music and effects, shown here so levels can be balanced against each other. */
  tracks: AudioTrack[]
  speed: number
  /** Seconds spent moving into this clip's layout; 0 is a hard cut. */
  easeSec?: number
  /** Whether this clip follows continuous footage, so an ease is possible. */
  canEase: boolean
  onEase: (v: number) => void
  /** Trimmed length of the clip in source seconds, for the timing hint. */
  clipSourceSec: number
  onSpeed: (v: number) => void
  onVolume: (v: number) => void
  onTrackVolume: (id: string, v: number) => void
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
  tracks,
  speed,
  easeSec,
  canEase,
  onEase,
  clipSourceSec,
  onSpeed,
  onVolume,
  onTrackVolume,
  onColour,
  onReset
}: Props): JSX.Element {
  return (
    <div className="panel">
      {/* Every level in one place: balancing a clip against its music is the
          whole point, and that cannot be done from two separate panels. */}
      <div className="layout-row">
        <span className="panel-label">Clip</span>
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
        <button className="btn small ghost" onClick={onReset} title="Reset this clip">
          <ResetIcon size={14} /> Reset all
        </button>
      </div>

      {tracks.map((t) => (
        <div className="layout-row" key={t.id}>
          <span className={`panel-label track ${t.kind}`} title={t.fileName}>
            {t.kind === 'music' ? 'Music' : 'SFX'}
          </span>
          <label className="mini-field wide">
            <input
              type="range"
              min={0}
              max={1.5}
              step={0.05}
              value={t.volume}
              onChange={(e) => onTrackVolume(t.id, Number(e.target.value))}
            />
            <b className="audio-vol">{Math.round(t.volume * 100)}%</b>
          </label>
          <span className="track-name">{t.fileName}</span>
        </div>
      ))}

      <div className="layout-row">
        <span className="panel-label">Speed</span>
        <div className="aspect-picker">
          {SPEED_STEPS.map((s) => (
            <button
              key={s}
              className={`chip ${Math.abs(speed - s) < 0.001 ? 'active' : ''}`}
              onClick={() => onSpeed(s)}
              title={
                s < 1 ? 'Slow motion' : s > 1 ? 'Sped up' : 'Normal speed'
              }
            >
              {s}×
            </button>
          ))}
        </div>
        {Math.abs(speed - 1) > 0.001 && (
          <span className="panel-hint inline">
            {(clipSourceSec / speed).toFixed(1)}s on the timeline, from {clipSourceSec.toFixed(1)}s
            of footage
          </span>
        )}
      </div>

      {/* Only offered where it can actually do something: a cut in the middle
          of continuous footage, which is what a split leaves behind. */}
      {canEase && (
        <div className="layout-row">
          <span className="panel-label">Ease in</span>
          <div className="aspect-picker">
            {EASE_STEPS.map((s) => (
              <button
                key={s}
                className={`chip ${Math.abs((easeSec ?? 0) - s) < 0.001 ? 'active' : ''}`}
                onClick={() => onEase(s)}
                title={s === 0 ? 'Cut straight to this layout' : `Move into place over ${s}s`}
              >
                {s === 0 ? 'Cut' : `${s}s`}
              </button>
            ))}
          </div>
          <span className="panel-hint inline">
            {easeSec
              ? 'Reframe this clip and it will move into the new framing instead of jumping.'
              : 'Hard cut into this clip’s framing.'}
          </span>
        </div>
      )}

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
        Levels and colour apply to the selected clip, so a dark or loud take can be fixed
        without touching the rest. Music levels are shared across the project.
      </p>
    </div>
  )
}
