import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  VideoMeta,
  AspectPreset,
  ExportProgress,
  ToolStatus,
  Region,
  FitMode,
  BackdropMode,
  CaptionWord,
  CaptionStyle,
  CaptionPreset,
  WhisperModelId
} from '../../shared/types'
import {
  ASPECT_DIMS,
  LAYOUT_PRESETS,
  centeredSrc,
  mediaUrl,
  newRegion,
  defaultCaptionStyle,
  CAPTION_PRESETS
} from '../../shared/types'
import { CaptionsPanel, type CaptionJob } from './components/CaptionsPanel'
import { TranscriptPanel } from './components/TranscriptPanel'
import { CaptionHandle } from './components/CaptionHandle'
import { retimeLine, replaceLine, insertCaption } from '../../shared/captions'
import { RegionRect } from './components/RegionRect'
import { LayersPanel } from './components/LayersPanel'
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
  const [activePreset, setActivePreset] = useState<string | null>(null)
  /** Set once the user arranges boxes themselves, which freezes the preset. */
  const [presetDirty, setPresetDirty] = useState(false)
  const [words, setWords] = useState<CaptionWord[]>([])
  const [capStyle, setCapStyle] = useState<CaptionStyle>(() => defaultCaptionStyle())
  const [modelId, setModelId] = useState<WhisperModelId>('base.en')
  const [modelReady, setModelReady] = useState(false)
  const [capJob, setCapJob] = useState<CaptionJob>({ kind: 'idle' })
  /** Bumped on any region edit so the paused canvas preview repaints. */
  const [revision, setRevision] = useState(0)
  const pictureRef = useRef<HTMLDivElement>(null)
  const outPaneRef = useRef<HTMLDivElement>(null)
  const outFrameRef = useRef<HTMLDivElement>(null)

  /** null on 'source', which means "no compositing, just trim". */
  const canvasDims = aspect === 'source' ? null : ASPECT_DIMS[aspect]
  /** Tools that need the composed output pane beside the source. */
  const showComposite = tool === 'layout' || tool === 'captions'
  /** Region boxes are only draggable in Layout; elsewhere they would be noise. */
  const editRegions = tool === 'layout'

  const updateRegion = useCallback((id: string, patch: Partial<Region>) => {
    setRegions((rs) =>
      rs.map((r) =>
        r.id === id
          ? // Dragging the source by hand means it is no longer auto-centred.
            { ...r, ...patch, ...(patch.src ? { auto: false } : {}) }
          : r
      )
    )
    setPresetDirty(true)
    setRevision((n) => n + 1)
  }, [])

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
      const initial = LAYOUT_PRESETS[0].build({
        srcAspect: m.height ? m.width / m.height : 16 / 9,
        canvasW: 1080,
        canvasH: 1920
      })
      setRegions(initial)
      setSelectedRegion(initial[0]?.id ?? null)
      setActivePreset(LAYOUT_PRESETS[0].id)
      setPresetDirty(false)
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
    const captions = words.length > 0 ? { words, style: capStyle } : undefined

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
            canvas: canvasDims,
            captions
          })
        : await window.api.exportClip({
            inputPath: meta.path,
            outputPath,
            startSec: inSec,
            endSec: outSec,
            aspect,
            reencode: false,
            captions
          })

    if (result.ok && result.outputPath) setStatus({ kind: 'done', path: result.outputPath })
    else setStatus({ kind: 'error', message: result.error ?? 'Export failed' })
  }, [meta, inSec, outSec, aspect, canvasDims, regions, words, capStyle])

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
      } else if (e.key.startsWith('Arrow')) {
        // In Layout the arrows nudge the selected box; elsewhere they scrub.
        const region = tool === 'layout' ? regions.find((r) => r.id === selectedRegion) : null
        if (region) {
          e.preventDefault()
          const step = e.shiftKey ? 0.05 : 0.004
          const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
          const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
          updateRegion(region.id, {
            dst: {
              ...region.dst,
              x: clamp(region.dst.x + dx, 0, 1 - region.dst.w),
              y: clamp(region.dst.y + dy, 0, 1 - region.dst.h)
            }
          })
          return
        }
        if (e.key === 'ArrowLeft') {
          seek(clamp(current - (e.shiftKey ? 5 : 1 / 30), 0, meta.durationSec))
        } else if (e.key === 'ArrowRight') {
          seek(clamp(current + (e.shiftKey ? 5 : 1 / 30), 0, meta.durationSec))
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    meta,
    current,
    inSec,
    outSec,
    togglePlay,
    seek,
    tool,
    regions,
    selectedRegion,
    updateRegion
  ])

  const missingTools = tools && !tools.ready
  const guide = cropGuide(meta, aspect)
  const outBox = useFit(outPaneRef, canvasDims ? canvasDims.w / canvasDims.h : 1)

  /** Resolve any auto-centred boxes against the real source and canvas sizes. */
  const centreAuto = useCallback(
    (rs: Region[], m: VideoMeta | null, canvas: { w: number; h: number } | null): Region[] => {
      if (!m || !canvas) return rs
      return rs.map((r) =>
        r.auto ? { ...r, src: centeredSrc(m.width, m.height, r.dst, canvas.w, canvas.h) } : r
      )
    },
    []
  )

  const buildPreset = useCallback(
    (presetId: string, m: VideoMeta | null, canvas: { w: number; h: number } | null) => {
      const preset = LAYOUT_PRESETS.find((p) => p.id === presetId)
      if (!preset || !m || !canvas || !m.height) return null
      return centreAuto(
        preset.build({
          srcAspect: m.width / m.height,
          canvasW: canvas.w,
          canvasH: canvas.h
        }),
        m,
        canvas
      )
    },
    [centreAuto]
  )

  const applyPreset = useCallback(
    (presetId: string) => {
      const next = buildPreset(presetId, meta, canvasDims)
      if (!next) return
      setRegions(next)
      setSelectedRegion(next[0]?.id ?? null)
      setActivePreset(presetId)
      setPresetDirty(false)
      setRevision((n) => n + 1)
    },
    [buildPreset, meta, canvasDims]
  )

  useEffect(() => {
    window.api.whisperStatus(modelId).then((s) => setModelReady(s.modelReady))
  }, [modelId])

  useEffect(() => window.api.onModelProgress((p) =>
    setCapJob({ kind: 'downloading', percent: p.percent })
  ), [])

  useEffect(() => window.api.onTranscribeStage((stage) =>
    setCapJob({ kind: 'working', stage })
  ), [])

  const runTranscribe = useCallback(async () => {
    if (!meta) return
    try {
      const status = await window.api.whisperStatus(modelId)
      if (!status.binaryReady) {
        setCapJob({ kind: 'error', message: 'whisper.cpp is missing from this build.' })
        return
      }
      if (!status.modelReady) {
        setCapJob({ kind: 'downloading', percent: 0 })
        const dl = await window.api.downloadModel(modelId)
        if (!dl.ok) {
          setCapJob({ kind: 'error', message: dl.error ?? 'Model download failed' })
          return
        }
        setModelReady(true)
      }

      setCapJob({ kind: 'working', stage: 'Preparing' })
      const res = await window.api.transcribe({
        inputPath: meta.path,
        startSec: inSec,
        endSec: outSec,
        modelId
      })
      if (res.ok && res.words) {
        setWords(res.words)
        setCapJob({ kind: 'idle' })
      } else {
        setCapJob({ kind: 'error', message: res.error ?? 'Transcription failed' })
      }
    } catch (err) {
      setCapJob({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }, [meta, inSec, outSec, modelId])

  const addRegion = useCallback(() => {
    const r = newRegion(`Box ${regions.length + 1}`)
    setRegions((rs) => [...rs, r])
    setSelectedRegion(r.id)
    setActivePreset(null)
    setPresetDirty(true)
    setRevision((n) => n + 1)
  }, [regions.length])

  const removeRegion = useCallback((id: string) => {
    setRegions((rs) => rs.filter((r) => r.id !== id))
    setActivePreset(null)
    setPresetDirty(true)
    setRevision((n) => n + 1)
  }, [])

  /** dir 1 brings a layer forward (later in paint order), -1 sends it back. */
  const moveRegion = useCallback((id: string, dir: -1 | 1) => {
    setRegions((rs) => {
      const i = rs.findIndex((r) => r.id === id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= rs.length) return rs
      const next = [...rs]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
    setPresetDirty(true)
    setRevision((n) => n + 1)
  }, [])

  const setFit = useCallback(
    (id: string, fit: FitMode) => {
      setRegions((rs) =>
        rs.map((r) =>
          r.id === id
            ? // Fit shows the whole frame, so an auto-centred crop no longer applies.
              { ...r, fit, ...(fit === 'contain' ? { auto: false } : {}) }
            : r
        )
      )
      setPresetDirty(true)
      setRevision((n) => n + 1)
    },
    []
  )

  const setBackdrop = useCallback((id: string, backdrop: BackdropMode) => {
    setRegions((rs) => rs.map((r) => (r.id === id ? { ...r, backdrop } : r)))
    setPresetDirty(true)
    setRevision((n) => n + 1)
  }, [])

  const setStyle = useCallback((id: string, patch: { radius?: number; border?: number }) => {
    setRegions((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)))
    setPresetDirty(true)
    setRevision((n) => n + 1)
  }, [])

  /**
   * A layout that suits 9:16 is wrong on 16:9, so re-solve the preset whenever
   * the canvas changes. Skipped once the user has moved anything themselves —
   * their arrangement outranks the preset.
   */
  useEffect(() => {
    if (!meta || !canvasDims) return
    if (activePreset && !presetDirty) {
      const next = buildPreset(activePreset, meta, canvasDims)
      if (next) {
        setRegions(next)
        setSelectedRegion((cur) => (next.some((r) => r.id === cur) ? cur : next[0]?.id ?? null))
        setRevision((n) => n + 1)
        return
      }
    }
    setRegions((rs) => centreAuto(rs, meta, canvasDims))
    setRevision((n) => n + 1)
    // Deliberately keyed on canvas/meta only: adding presetDirty here would
    // re-run the moment an edit marks it dirty and undo that edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, canvasDims?.w, canvasDims?.h])

  /**
   * Snap guides for the output pane: the canvas edges and centre, plus every
   * other layer's edges, so boxes butt up cleanly instead of nearly touching.
   */
  const snapGuides = useMemo(() => {
    const xs = [0, 0.5, 1]
    const ys = [0, 0.5, 1]
    for (const r of regions) {
      if (r.id === selectedRegion) continue
      xs.push(r.dst.x, r.dst.x + r.dst.w)
      ys.push(r.dst.y, r.dst.y + r.dst.h)
    }
    return { xs, ys }
  }, [regions, selectedRegion])

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
          {/* Captions need the composed output on screen too, so you can see
              where they land against the layout you built. */}
          <section className={`stage ${showComposite ? 'split' : ''}`}>
          <div className="pane">
            {showComposite && (
              <div className="pane-head">
                <span className="pane-title">Source</span>
                <span className="pane-sub">
                  {meta.width}×{meta.height}
                  {editRegions ? ' — drag a box to pick what it grabs' : ''}
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
            {!showComposite && guide && pictureBox && (
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
            {editRegions && pictureBox && (
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

          {showComposite && (
            <div className="pane output">
              <div className="pane-head">
                <span className="pane-title out">Output</span>
                <span className="pane-sub">
                  {canvasDims
                    ? `${canvasDims.w}×${canvasDims.h}${editRegions ? ' — drag to place' : ''}`
                    : 'no canvas'}
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
                    words={words}
                    captionStyle={capStyle}
                  />
                  {tool === 'captions' && words.length > 0 && (
                    <CaptionHandle
                      style={capStyle}
                      boundsRef={outFrameRef}
                      onChange={(patch) => setCapStyle((s) => ({ ...s, ...patch }))}
                    />
                  )}
                  {editRegions &&
                    regions.map((r) => (
                      <RegionRect
                        key={r.id}
                        rect={r.dst}
                        onChange={(dst) => updateRegion(r.id, { dst })}
                        boundsRef={outFrameRef}
                        label={r.label}
                        tone="dst"
                        selected={selectedRegion === r.id}
                        onSelect={() => setSelectedRegion(r.id)}
                        snapX={snapGuides.xs}
                        snapY={snapGuides.ys}
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

          {/* Available even with no transcript, so captions can be written by
              hand on a clip that has no speech to transcribe. */}
          {tool === 'captions' && (
            <TranscriptPanel
              words={words}
              wordsPerLine={capStyle.wordsPerLine}
              currentSec={current}
              onSeek={seek}
              onEditLine={(line, text) =>
                setWords((ws) => replaceLine(ws, line, retimeLine(line, text)))
              }
              onEditWord={(i, text) =>
                setWords((ws) => ws.map((w, j) => (j === i ? { ...w, text } : w)))
              }
              onRemoveWord={(i) => setWords((ws) => ws.filter((_, j) => j !== i))}
              onAddLine={() => setWords((ws) => insertCaption(ws, current))}
            />
          )}

          {tool === 'layout' && (
            <LayersPanel
              regions={regions}
              selectedId={selectedRegion}
              onSelect={setSelectedRegion}
              onMove={moveRegion}
              onRemove={removeRegion}
              onAdd={addRegion}
              onFit={setFit}
              onBackdrop={setBackdrop}
              onStyle={setStyle}
            />
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
              {tool === 'captions' ? (
                <CaptionsPanel
                  words={words}
                  style={capStyle}
                  modelId={modelId}
                  modelReady={modelReady}
                  job={capJob}
                  onModel={setModelId}
                  onTranscribe={runTranscribe}
                  onPreset={(p: CaptionPreset) =>
                    setCapStyle({ preset: p, ...CAPTION_PRESETS[p] })
                  }
                  onStyle={(patch) => setCapStyle((s) => ({ ...s, ...patch }))}
                  onClear={() => {
                    setWords([])
                    setCapJob({ kind: 'idle' })
                  }}
                />
              ) : (
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
                activePreset={activePreset}
                onApplyPreset={applyPreset}
              />
              )}
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
