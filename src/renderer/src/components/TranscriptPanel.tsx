import { useMemo, useState } from 'react'
import type { CaptionWord } from '../../../shared/types'
import { groupIntoLines, type CaptionLine } from '../../../shared/captions'
import { TrashIcon } from './Icons'
import { formatTime } from '../lib/format'

interface Props {
  words: CaptionWord[]
  wordsPerLine: number
  currentSec: number
  onEditLine: (line: CaptionLine, text: string) => void
  onEditWord: (index: number, text: string) => void
  onRemoveWord: (index: number) => void
  onSeek: (sec: number) => void
}

/**
 * Transcript editor, in the sidebar rather than under the timeline — stacked
 * below, it crushed the preview it is meant to be checked against.
 */
export function TranscriptPanel({
  words,
  wordsPerLine,
  currentSec,
  onEditLine,
  onEditWord,
  onRemoveWord,
  onSeek
}: Props): JSX.Element {
  const [mode, setMode] = useState<'line' | 'word'>('line')
  const lines = useMemo(() => groupIntoLines(words, wordsPerLine), [words, wordsPerLine])

  return (
    <aside className="layers transcript-side">
      <div className="pane-head">
        <span className="pane-title layers-title">Transcript</span>
        <span className="pane-sub">{lines.length} lines</span>
      </div>

      <div className="fit-toggle">
        <button
          className={`fit-opt ${mode === 'line' ? 'on' : ''}`}
          onClick={() => setMode('line')}
        >
          Lines
        </button>
        <button
          className={`fit-opt ${mode === 'word' ? 'on' : ''}`}
          onClick={() => setMode('word')}
        >
          Words
        </button>
      </div>

      <div className="layers-list">
        {words.length === 0 && <p className="layers-empty">No captions yet.</p>}

        {mode === 'line'
          ? lines.map((line) => {
              const live = currentSec >= line.start && currentSec < line.end
              return (
                <div
                  className={`caption-line ${live ? 'live' : ''}`}
                  key={`${line.offset}-${line.start}`}
                >
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
                  />
                  <button
                    className="word-del always"
                    onClick={() => onEditLine(line, '')}
                    title="Delete this line"
                  >
                    <TrashIcon size={12} />
                  </button>
                </div>
              )
            })
          : (
            <div className="transcript">
              {words.map((w, i) => (
                <span className="word-chip" key={`${i}-${w.start}`}>
                  <input
                    value={w.text}
                    onChange={(e) => onEditWord(i, e.target.value)}
                    size={Math.max(2, w.text.length)}
                    title={`${formatTime(w.start)} → ${formatTime(w.end)}`}
                    spellCheck={false}
                  />
                  <button className="word-del" onClick={() => onRemoveWord(i)} title="Remove">
                    <TrashIcon size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
      </div>
    </aside>
  )
}
