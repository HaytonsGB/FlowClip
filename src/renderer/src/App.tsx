import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  VideoMeta,
  AspectPreset,
  ExportProgress,
  ToolStatus,
  Region
} from '../../shared/types'
import {
  ASPECT_DIMS,
  LAYOUT_PRESETS,
  mediaUrl,
  newRegion
} from '../../shared/types'
import { RegionRect } from './components/RegionRect'
import { OutputPreview } from './components/OutputPreview'
import { useFit } from './lib/useFit'
import { TrimBar } from './components/TrimBar'
import { ToolRail, type ToolId } from './components/ToolRail'
import { ToolPanel } from './components/ToolPanel'
import { PlayIcon, PauseIcon, ExportIcon } from './components/Icons'
import { formatBytes, formatTime, clamp } from './lib/format'
import markUrl from './assets/mark.png'

type Status =
  | { kind: 'idle' }
  | { kind: 'exporting'; percent: number; speed: string }
  | { kind: 'done'; path: string }
  | { kind: 'error'; message: string }

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
  const [stripUrl, setStripUrl] = useState('')
  const [tool, setTool] = useState<ToolId>('trim')
  const [regions, setRegions] = useState<Region[]>([])
  const [selectedRegion, setSelectedRegion] = useState<string | null>(null)
  /** Bumped on any region edit so the paused canvas preview repaints. */
  const [revision, setRevision] = useState(0)
  const pictureRef = useRef<HTMLDivElement>(null)
  const outPaneRef = useRef<HTMLDivElement>(null)
  const outFrameRef = useRef<HTMLDivElement>(null)

  /** null on 'source', which means "no compositing, just trim". */
  const canvasDims = aspect === 'source' ? null : ASPECT_DIMS[aspect]

  /** Element box. The picture inside it is letterboxed by object-fit: contain. */
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
      setStripUrl('')
      // Start on the single centred box — same result as a plain reframe, but
      // now it is an editable layout rather than a fixed crop.
      const initial = LAYOUT_PRESETS[0].build()
      setRegions(initial)
      setSelectedRegion(initial[0]?.id ?? null)
      setRevision((n) => n + 1)
      // Thumbnails are a nicety. Isolated in its own try because a missing
      // bridge method throws synchronously and would otherwise surface as an
      // "this video failed to load" error.
      try {
        const strip = await window.api.filmstrip(filePath, m.durationSec)
        setStripUrl(mediaUrl(strip))
      } catch {
        setStripUrl('')
      }
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

    // A canvas plus boxes means compositing; 'source' is a plain trim, which can
    // stream-copy and stays much faster.
    const result =
      canvasDims && regions.length > 0
        ? await window.api.exportComposite({
            inputPath: meta.path,
            outputPath,
            startSec: inSec,
            endSec: outSec,
            regions,
            srcWidth: meta.width,
            srcHeight: meta.height,
            canvas: canvasDims
          })
        : await window.api.exportClip({
            inputPath: meta.path,
            outputPath,
            startSec: inSec,
            endSec: outSec,
            aspect,
            reencode: false
          })

    if (result.ok && result.outputPath) setStatus({ kind: 'done', path: result.outputPath })
    else setStatus({ kind: 'error', message: result.error ?? 'Export failed' })
  }, [meta, inSec, outSec, aspect, canvasDims, regions])

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
  const outBox = useFit(outPaneRef, canvasDims ? canvasDims.w / canvasDims.h : 1)

  const updateRegion = useCallback((id: string, patch: Partial<Region>) => {
    setRegions((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)))
    setRevision((n) => n + 1)
  }, [])

  const applyPreset = useCallback((presetId: string) => {
    const preset = LAYOUT_PRESETS.find((p) => p.id === presetId)
    if (!preset) return
    const next = preset.build()
    setRegions(next)
    setSelectedRegion(next[0]?.id ?? null)
    setRevision((n) => n + 1)
  }, [])

  /** Where the picture actually sits inside the element after letterboxing. */
  const pictureBox = useMemo(() => {
    if (!meta || !videoBox || !meta.width || !meta.height) return null
    const ratio = meta.width / meta.height
    const w = Math.min(videoBox.w, videoBox.h * ratio)
    return { w, h: w / ratio }
  }, [meta, videoBox])

  return (
    <div className="app" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <header className="topbar">
        <div className="brand">
          <img className="brand-mark" src={markUrl} alt="" />
          <span className="brand-name">FlowClip</span>
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
            <img className="dropzone-mark" src={markUrl} alt="" />
            <h1>Drop a video here</h1>
            <p>Trim it, reframe it for TikTok or Shorts, export it. All local, all yours.</p>
            <button className="btn primary" onClick={openFile}>
              Choose a video
            </button>
          </div>
        </main>
      ) : (
        <main className="editor">
          <ToolRail active={tool} onSelect={setTool} disabled={false} />
          <div className="workspace">
          <section className={`stage ${tool === 'layout' ? 'split' : ''}`}>
          <div className="pane">
            {tool === 'layout' && (
              <div className="pane-head">
                <span className="pane-title">Source</span>
                <span className="pane-sub">
                  {meta.width}×{meta.height} — drag a box to pick what it grabs
                </span>
              </div>
            )}
            <div className="pane-body">
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
            {tool !== 'layout' && guide && pictureBox && (
              <div
                className="frame-guide"
                style={{
                  width: `${pictureBox.w * guide.w}px`,
                  height: `${pictureBox.h * guide.h}px`
                }}
                aria-hidden="true"
              />
            )}

            {/* Source boxes, aligned to the letterboxed picture rather than the pane. */}
            {tool === 'layout' && pictureBox && (
              <div
                className="overlay-frame"
                ref={pictureRef}
                style={{ width: `${pictureBox.w}px`, height: `${pictureBox.h}px` }}
              >
                {regions.map((r) => (
                  <RegionRect
                    key={r.id}
                    rect={r.src}
                    onChange={(src) => updateRegion(r.id, { src })}
                    boundsRef={pictureRef}
                    label={r.label}
                    tone="src"
                    selected={selectedRegion === r.id}
                    onSelect={() => setSelectedRegion(r.id)}
                  />
                ))}
              </div>
            )}
            </div>
          </div>

          {tool === 'layout' && (
            <div className="pane output">
              <div className="pane-head">
                <span className="pane-title out">Output</span>
                <span className="pane-sub">
                  {canvasDims ? `${canvasDims.w}×${canvasDims.h} — drag to place` : 'no canvas'}
                </span>
              </div>
              <div className="pane-body" ref={outPaneRef}>
              {canvasDims && outBox ? (
                <div
                  className="overlay-frame"
                  ref={outFrameRef}
                  style={{ width: `${outBox.w}px`, height: `${outBox.h}px` }}
                >
                  <OutputPreview
                    videoRef={videoRef}
                    regions={regions}
                    canvas={canvasDims}
                    revision={revision}
                  />
                  {regions.map((r) => (
                    <RegionRect
                      key={r.id}
                      rect={r.dst}
                      onChange={(dst) => updateRegion(r.id, { dst })}
                      boundsRef={outFrameRef}
                      label={r.label}
                      tone="dst"
                      selected={selectedRegion === r.id}
                      onSelect={() => setSelectedRegion(r.id)}
                    />
                  ))}
                </div>
              ) : (
                <p className="pane-empty">
                  Pick a canvas other than <b>Source</b> to compose a layout.
                </p>
              )}
              </div>
            </div>
          )}
          </section>

          <section className="controls">
            <div className="transport">
              <button className="btn round" onClick={togglePlay} title="Play / pause (Space)">
                {playing ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
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
              stripUrl={stripUrl}
              onSeek={seek}
              onChangeIn={setInSec}
              onChangeOut={setOutSec}
            />

            <div className="row">
              <ToolPanel
                tool={tool}
                aspect={aspect}
                onAspect={setAspect}
                onSetIn={() => setInSec(clamp(current, 0, outSec - 0.1))}
                onSetOut={() => setOutSec(clamp(current, inSec + 0.1, meta.durationSec))}
                onReset={() => {
                  setInSec(0)
                  setOutSec(meta.durationSec)
                }}
                regions={regions}
                selectedId={selectedRegion}
                onSelectRegion={setSelectedRegion}
                onApplyPreset={applyPreset}
                onAddRegion={() => {
                  const r = newRegion(`Box ${regions.length + 1}`)
                  setRegions((rs) => [...rs, r])
                  setSelectedRegion(r.id)
                  setRevision((n) => n + 1)
                }}
                onRemoveRegion={(id) => {
                  setRegions((rs) => rs.filter((r) => r.id !== id))
                  setRevision((n) => n + 1)
                }}
              />
              <button
                className="btn primary export"
                onClick={doExport}
                disabled={status.kind === 'exporting' || !tools?.ready}
                title="Render the selected range to a new file"
              >
                <ExportIcon size={17} />
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
          </div>
        </main>
      )}
    </div>
  )
}

export default App
