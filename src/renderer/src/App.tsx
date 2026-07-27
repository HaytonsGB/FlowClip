import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  VideoMeta,
  AspectPreset,
  ExportProgress,
  ToolStatus
} from '../../shared/types'
import { ASPECT_LABELS, ASPECT_DIMS, mediaUrl } from '../../shared/types'
import { TrimBar } from './components/TrimBar'
import { formatBytes, formatTime, clamp } from './lib/format'

type Status =
  | { kind: 'idle' }
  | { kind: 'exporting'; percent: number; speed: string }
  | { kind: 'done'; path: string }
  | { kind: 'error'; message: string }

const ASPECTS: AspectPreset[] = ['vertical', 'square', 'wide', 'source']

/**
 * Fraction of the source frame the export will keep, as {w,h} in 0..1.
 * Mirrors ffmpeg's scale-to-cover then centre-crop so the on-screen guide shows
 * exactly what survives the export.
 */
function cropGuide(
  meta: VideoMeta | null,
  aspect: AspectPreset
): { w: number; h: number } | null {
  if (!meta || aspect === 'source' || !meta.width || !meta.height) return null
  const { w, h } = ASPECT_DIMS[aspect]
  const target = w / h
  const source = meta.width / meta.height
  return target < source ? { w: target / source, h: 1 } : { w: 1, h: source / target }
}

function App(): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [tools, setTools] = useState<ToolStatus | null>(null)
  const [meta, setMeta] = useState<VideoMeta | null>(null)
  const [srcUrl, setSrcUrl] = useState<string>('')
  const [current, setCurrent] = useState(0)
  const [inSec, setInSec] = useState(0)
  const [outSec, setOutSec] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [aspect, setAspect] = useState<AspectPreset>('vertical')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [videoBox, setVideoBox] = useState<{ w: number; h: number } | null>(null)

  /**
   * The crop guide has to sit exactly over the letterboxed picture, so measure
   * the element rather than chaining CSS percentages — those resolve against an
   * indefinite height here and silently collapse.
   */
  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setVideoBox({ w: width, h: height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [meta])

  useEffect(() => {
    window.api.toolStatus().then(setTools)
  }, [])

  useEffect(() => {
    return window.api.onExportProgress((p: ExportProgress) => {
      setStatus((s) =>
        s.kind === 'exporting' ? { kind: 'exporting', percent: p.percent, speed: p.speed } : s
      )
    })
  }, [])

  const loadPath = useCallback(async (filePath: string) => {
    try {
      const m = await window.api.probe(filePath)
      setMeta(m)
      setSrcUrl(mediaUrl(filePath))
      setInSec(0)
      setOutSec(m.durationSec)
      setCurrent(0)
      setStatus({ kind: 'idle' })
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }, [])

  const openFile = useCallback(async () => {
    const filePath = await window.api.openVideo()
    if (filePath) await loadPath(filePath)
  }, [loadPath])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const file = e.dataTransfer.files?.[0]
      if (!file) return
      const path = window.api.pathForFile(file)
      if (path) void loadPath(path)
    },
    [loadPath]
  )

  const togglePlay = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) {
      // Restart inside the selection if the playhead drifted outside it.
      if (v.currentTime < inSec || v.currentTime >= outSec) v.currentTime = inSec
      void v.play()
    } else {
      v.pause()
    }
  }, [inSec, outSec])

  const seek = useCallback((sec: number) => {
    const v = videoRef.current
    if (v) v.currentTime = sec
    setCurrent(sec)
  }, [])

  // Loop playback within the trimmed selection so you preview the actual clip.
  const onTimeUpdate = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (v.currentTime >= outSec) {
      v.pause()
      v.currentTime = inSec
      setCurrent(inSec)
    } else {
      setCurrent(v.currentTime)
    }
  }, [inSec, outSec])

  const doExport = useCallback(async () => {
    if (!meta) return
    const suggested = await window.api.suggestOutput(meta.path)
    const outputPath = await window.api.saveClipDialog(suggested)
    if (!outputPath) return

    setStatus({ kind: 'exporting', percent: 0, speed: '' })
    const result = await window.api.exportClip({
      inputPath: meta.path,
      outputPath,
      startSec: inSec,
      endSec: outSec,
      aspect,
      reencode: false
    })
    if (result.ok && result.outputPath) setStatus({ kind: 'done', path: result.outputPath })
    else setStatus({ kind: 'error', message: result.error ?? 'Export failed' })
  }, [meta, inSec, outSec, aspect])

  // Space toggles play, I/O set the trim points — the shortcuts editors expect.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!meta) return
      const target = e.target as HTMLElement
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return
      if (e.code === 'Space') {
        e.preventDefault()
        togglePlay()
      } else if (e.key === 'i' || e.key === 'I') {
        setInSec(clamp(current, 0, outSec - 0.1))
      } else if (e.key === 'o' || e.key === 'O') {
        setOutSec(clamp(current, inSec + 0.1, meta.durationSec))
      } else if (e.key === 'ArrowLeft') {
        seek(clamp(current - (e.shiftKey ? 5 : 1 / 30), 0, meta.durationSec))
      } else if (e.key === 'ArrowRight') {
        seek(clamp(current + (e.shiftKey ? 5 : 1 / 30), 0, meta.durationSec))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [meta, current, inSec, outSec, togglePlay, seek])

  const missingTools = tools && !tools.ready
  const guide = cropGuide(meta, aspect)

  return (
    <div className="app" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◣</span>
          <span className="brand-name">
            Flow<span className="brand-accent">Clip</span>
          </span>
        </div>
        <div className="topbar-actions">
          <button className="btn" onClick={openFile}>
            Open video
          </button>
        </div>
      </header>

      {missingTools && (
        <div className="banner warn">
          <strong>ffmpeg not found.</strong> FlowClip needs it to read and export video. Run{' '}
          <code>npm run setup:ffmpeg</code> in the project folder, then{' '}
          <button
            className="link"
            onClick={() => window.api.rescanTools().then(setTools)}
          >
            re-check
          </button>
          .
        </div>
      )}

      {!meta ? (
        <main className="dropzone">
          <div className="dropzone-inner">
            <div className="dropzone-icon">◣</div>
            <h1>Drop a video here</h1>
            <p>Trim it, reframe it for TikTok or Shorts, export it. All local, all yours.</p>
            <button className="btn primary" onClick={openFile}>
              Choose a video
            </button>
          </div>
        </main>
      ) : (
        <main className="editor">
          <section className="stage">
            <video
              ref={videoRef}
              src={srcUrl}
              className="video"
              onTimeUpdate={onTimeUpdate}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onClick={togglePlay}
              onError={() => {
                const err = videoRef.current?.error
                setStatus({
                  kind: 'error',
                  message: `Couldn't play this file in the preview${
                    err?.message ? ` — ${err.message}` : ''
                  }. The codec may not be supported by Chromium (exporting can still work).`
                })
              }}
            />
            {guide && videoBox && (
              <div
                className="frame-guide"
                style={{
                  width: `${videoBox.w * guide.w}px`,
                  height: `${videoBox.h * guide.h}px`
                }}
                aria-hidden="true"
              />
            )}
          </section>

          <section className="controls">
            <div className="transport">
              <button className="btn round" onClick={togglePlay}>
                {playing ? '❚❚' : '▶'}
              </button>
              <span className="time">
                {formatTime(current)} <span className="dim">/ {formatTime(meta.durationSec)}</span>
              </span>
              <span className="spacer" />
              <span className="meta-chip">
                {meta.width}×{meta.height}
              </span>
              <span className="meta-chip">{meta.fps} fps</span>
              <span className="meta-chip">{formatBytes(meta.sizeBytes)}</span>
            </div>

            <TrimBar
              duration={meta.durationSec}
              current={current}
              inSec={inSec}
              outSec={outSec}
              onSeek={seek}
              onChangeIn={setInSec}
              onChangeOut={setOutSec}
            />

            <div className="row">
              <div className="aspect-picker">
                {ASPECTS.map((a) => (
                  <button
                    key={a}
                    className={`chip ${aspect === a ? 'active' : ''}`}
                    onClick={() => setAspect(a)}
                  >
                    {ASPECT_LABELS[a]}
                  </button>
                ))}
              </div>
              <button
                className="btn primary export"
                onClick={doExport}
                disabled={status.kind === 'exporting' || !tools?.ready}
              >
                {status.kind === 'exporting' ? 'Exporting…' : 'Export clip'}
              </button>
            </div>

            {status.kind === 'exporting' && (
              <div className="progress">
                <div className="progress-bar" style={{ width: `${status.percent * 100}%` }} />
                <span className="progress-label">
                  {Math.round(status.percent * 100)}% {status.speed && `· ${status.speed}`}
                </span>
              </div>
            )}
            {status.kind === 'done' && (
              <div className="banner ok">
                Exported. <button className="link" onClick={() => window.api.revealFile(status.path)}>
                  Show in folder
                </button>
              </div>
            )}
            {status.kind === 'error' && <div className="banner err">{status.message}</div>}

            <p className="hint">
              <kbd>Space</kbd> play · <kbd>I</kbd> set in · <kbd>O</kbd> set out ·{' '}
              <kbd>←</kbd>/<kbd>→</kbd> step frame · <kbd>Shift</kbd> +arrows to jump 5s
            </p>
          </section>
        </main>
      )}
    </div>
  )
}

export default App
