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
import { useMemo, useState } from 'react'
import { groupIntoLines, type CaptionLine } from '../../../shared/captions'
import { CaptionsIcon, TrashIcon } from './Icons'
import { formatTime } from '../lib/format'

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
  onEditWord: (index: number, text: string) => void
  onRemoveWord: (index: number) => void
  onEditLine: (line: CaptionLine, text: string) => void
  onSeek: (sec: number) => void
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
  onEditWord,
  onRemoveWord,
  onEditLine,
  onSeek,
  onClear
}: Props): JSX.Element {
  const busy = job.kind === 'downloading' || job.kind === 'working'
  const [mode, setMode] = useState<'line' | 'word'>('line')
  const lines = useMemo(
    () => groupIntoLines(words, style.wordsPerLine),
    [words, style.wordsPerLine]
  )

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
            <label className="mini-field">
              Height
              <input
                type="range"
                min={0.1}
                max={0.92}
                step={0.02}
                value={style.position}
                onChange={(e) => onStyle({ position: Number(e.target.value) })}
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

          <div className="edit-mode">
            <button
              className={`chip ${mode === 'line' ? 'active' : ''}`}
              onClick={() => setMode('line')}
            >
              Line by line
            </button>
            <button
              className={`chip ${mode === 'word' ? 'active' : ''}`}
              onClick={() => setMode('word')}
            >
              Word by word
            </button>
            <span className="edit-count">
              {lines.length} lines · {words.length} words
            </span>
          </div>

          {mode === 'line' ? (
            <div className="transcript lines" role="list">
              {lines.map((line) => (
                <div className="caption-line" key={`${line.offset}-${line.start}`} role="listitem">
                  <button
                    className="line-time"
                    onClick={() => onSeek(line.start)}
                    title="Jump to this line"
                  >
                    {formatTime(line.start)}
                  </button>
                  <input
                    className="line-text"
                    defaultValue={line.words.map((w) => w.text).join(' ')}
                    onBlur={(e) => onEditLine(line, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                    }}
                    spellCheck={false}
                    placeholder="(empty — will be removed)"
                  />
                  <button
                    className="word-del always"
                    onClick={() => onEditLine(line, '')}
                    title="Delete this line"
                  >
                    <TrashIcon size={12} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="transcript" role="list">
              {words.map((w, i) => (
                <span className="word-chip" key={`${i}-${w.start}`} role="listitem">
                  <input
                    value={w.text}
                    onChange={(e) => onEditWord(i, e.target.value)}
                    size={Math.max(2, w.text.length)}
                    title={`${formatTime(w.start)} → ${formatTime(w.end)}`}
                    spellCheck={false}
                  />
                  <button
                    className="word-del"
                    onClick={() => onRemoveWord(i)}
                    title="Remove this word"
                  >
                    <TrashIcon size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}

          <p className="panel-hint">
            {mode === 'line'
              ? 'Rewrite a whole line and press Enter — the line keeps its timing and the words re-space themselves across it. Click a timestamp to jump there.'
              : 'Fix individual words Whisper misheard. Each word keeps its own timing.'}
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
