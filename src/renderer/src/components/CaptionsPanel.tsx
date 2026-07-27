import type {
  CaptionWord,
  CaptionStyle,
  CaptionPreset,
  WhisperModelId
} from '../../../shared/types'
import {
  CAPTION_PRESET_LABELS,
  CAPTION_PRESETS,
  WHISPER_MODELS
} from '../../../shared/types'
import { CaptionsIcon } from './Icons'

export type CaptionJob =
  | { kind: 'idle' }
  | { kind: 'downloading'; percent: number }
  | { kind: 'working'; stage: string }
  | { kind: 'error'; message: string }

interface Props {
  words: CaptionWord[]
  style: CaptionStyle
  modelId: WhisperModelId
  modelReady: boolean
  job: CaptionJob
  onModel: (id: WhisperModelId) => void
  onTranscribe: () => void
  onPreset: (p: CaptionPreset) => void
  onStyle: (patch: Partial<CaptionStyle>) => void
  onClear: () => void
}

const PRESETS = Object.keys(CAPTION_PRESET_LABELS) as CaptionPreset[]
const MODELS = Object.keys(WHISPER_MODELS) as WhisperModelId[]

export function CaptionsPanel({
  words,
  style,
  modelId,
  modelReady,
  job,
  onModel,
  onTranscribe,
  onPreset,
  onStyle,
  onClear
}: Props): JSX.Element {
  const busy = job.kind === 'downloading' || job.kind === 'working'

  return (
    <div className="panel">
      <div className="layout-row">
        <span className="panel-label">Model</span>
        <div className="aspect-picker">
          {MODELS.map((m) => (
            <button
              key={m}
              className={`chip ${modelId === m ? 'active' : ''}`}
              onClick={() => onModel(m)}
              disabled={busy}
              title={`${WHISPER_MODELS[m].note} · ${WHISPER_MODELS[m].sizeMb} MB`}
            >
              {WHISPER_MODELS[m].label}
            </button>
          ))}
        </div>

        <button className="btn primary" onClick={onTranscribe} disabled={busy}>
          <CaptionsIcon size={16} />
          {words.length > 0 ? 'Re-transcribe' : 'Generate captions'}
        </button>

        {words.length > 0 && (
          <button className="btn ghost small" onClick={onClear} disabled={busy}>
            Clear
          </button>
        )}
      </div>

      {job.kind === 'downloading' && (
        <div className="progress">
          <div className="progress-bar" style={{ width: `${job.percent * 100}%` }} />
          <span className="progress-label">
            Downloading {WHISPER_MODELS[modelId].label} model — {Math.round(job.percent * 100)}%
          </span>
        </div>
      )}
      {job.kind === 'working' && <div className="banner warn caption-status">{job.stage}…</div>}
      {job.kind === 'error' && <div className="banner err">{job.message}</div>}

      {words.length > 0 && (
        <>
          <div className="layout-row">
            <span className="panel-label">Style</span>
            <div className="aspect-picker">
              {PRESETS.map((p) => (
                <button
                  key={p}
                  className={`chip ${style.preset === p ? 'active' : ''}`}
                  onClick={() => onPreset(p)}
                  title={`${CAPTION_PRESETS[p].font} · ${CAPTION_PRESETS[p].wordsPerLine} word(s) per line`}
                >
                  {CAPTION_PRESET_LABELS[p]}
                </button>
              ))}
            </div>

            <label className="mini-field">
              Size
              <input
                type="range"
                min={0.03}
                max={0.12}
                step={0.005}
                value={style.size}
                onChange={(e) => onStyle({ size: Number(e.target.value) })}
              />
            </label>
            <label className="mini-field colour">
              Word
              <input
                type="color"
                value={style.highlight}
                onChange={(e) => onStyle({ highlight: e.target.value })}
              />
            </label>
          </div>

          <p className="panel-hint">
            Drag the caption block on the <b>Output</b> to place it. Edit the wording in the
            transcript on the right — rewriting a line keeps its timing.
          </p>
        </>
      )}

      {words.length === 0 && job.kind === 'idle' && (
        <p className="panel-hint">
          Transcribes the trimmed range on your machine — nothing is uploaded.
          {!modelReady && ` The ${WHISPER_MODELS[modelId].label} model (${WHISPER_MODELS[modelId].sizeMb} MB) downloads once on first use.`}
        </p>
      )}
    </div>
  )
}
