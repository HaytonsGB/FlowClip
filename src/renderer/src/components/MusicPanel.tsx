import type { AudioTrack } from '../../../shared/types'
import { MusicIcon, PlusIcon, TrashIcon } from './Icons'
import { formatTime } from '../lib/format'

interface Props {
  tracks: AudioTrack[]
  projectSec: number
  totalSec: number
  onAdd: (kind: 'music' | 'sfx') => void
  onRemove: (id: string) => void
  onPatch: (id: string, patch: Partial<AudioTrack>) => void
  onSeek: (sec: number) => void
  error: string | null
}

export function MusicPanel({
  tracks,
  projectSec,
  totalSec,
  onAdd,
  onRemove,
  onPatch,
  onSeek,
  error
}: Props): JSX.Element {
  return (
    <div className="panel">
      <div className="panel-actions">
        <button className="btn" onClick={() => onAdd('music')} title="A track that runs underneath">
          <MusicIcon size={16} /> Add music
        </button>
        <button
          className="btn"
          onClick={() => onAdd('sfx')}
          title={`Drop a sound effect at ${formatTime(projectSec)}`}
        >
          <PlusIcon size={15} /> Add effect at {formatTime(projectSec)}
        </button>
      </div>

      {error && <div className="banner err">{error}</div>}

      {tracks.length === 0 ? (
        <p className="panel-hint">
          Music plays under the whole video and is mixed after the clips are joined, so it carries
          across cuts. Effects land wherever the playhead is.
        </p>
      ) : (
        <div className="audio-list">
          {tracks.map((t) => (
            <div key={t.id} className={`audio-row ${t.kind}`}>
              <span className="audio-kind">{t.kind === 'music' ? 'MUSIC' : 'SFX'}</span>
              <span className="audio-name" title={t.fileName}>
                {t.fileName}
              </span>

              <button
                className="line-time"
                onClick={() => onSeek(t.startSec)}
                title="Jump to where it starts"
              >
                {formatTime(t.startSec)}
              </button>

              <label className="mini-field">
                Vol
                <input
                  type="range"
                  min={0}
                  max={1.5}
                  step={0.05}
                  value={t.volume}
                  onChange={(e) => onPatch(t.id, { volume: Number(e.target.value) })}
                />
                <b className="audio-vol">{Math.round(t.volume * 100)}%</b>
              </label>

              {/* An effect is placed; a bed always starts at the top. */}
              {t.kind === 'sfx' && (
                <button
                  className="btn small ghost"
                  onClick={() => onPatch(t.id, { startSec: Math.min(projectSec, totalSec) })}
                  title="Move it to the playhead"
                >
                  Move here
                </button>
              )}

              <button
                className="icon-btn danger"
                onClick={() => onRemove(t.id)}
                title="Remove this track"
              >
                <TrashIcon size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
