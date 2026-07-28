import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  VideoMeta,
  AspectPreset,
  ExportProgress,
  ToolStatus,
  Region,
  FitMode,
  BackdropMode,
  CaptionStyle,
  CaptionPreset,
  WhisperModelId,
  Clip
} from '../../shared/types'
import {
  ASPECT_DIMS,
  LAYOUT_PRESETS,
  centeredSrc,
  mediaUrl,
  newRegion,
  newClip,
  splitClip,
  canSplit,
  projectFps,
  defaultCaptionStyle,
  CAPTION_PRESETS
} from '../../shared/types'
import { CaptionsPanel, type CaptionJob } from './components/CaptionsPanel'
import { TranscriptPanel } from './components/TranscriptPanel'
import { CaptionHandle } from './components/CaptionHandle'
import { retimeLine, replaceLine, insertCaption } from '../../shared/captions'
import {
  layoutClips,
  totalDuration,
  resolveTime,
  projectTimeOf,
  spanOf
} from '../../shared/timeline'
import { ProjectTimeline } from './components/ProjectTimeline'
import { RegionRect } from './components/RegionRect'
import { LayersPanel } from './components/LayersPanel'
import { OutputPreview } from './components/OutputPreview'
import { useFit } from './lib/useFit'
import { useUndo } from './lib/useUndo'
import { serialiseProject, type ProjectFile } from '../../shared/project'
import { ToolRail, type ToolId } from './components/ToolRail'
import { ToolPanel } from './components/ToolPanel'
import {
  PlayIcon,
  PauseIcon,
  ExportIcon,
  ScissorsIcon,
  UndoIcon,
  RedoIcon,
  SaveIcon,
  FolderIcon
} from './components/Icons'
import { formatBytes, formatTime, clamp } from './lib/format'
import markUrl from './assets/mark.png'

type Status =
  | { kind: 'idle' }
  | { kind: 'exporting'; percent: number; speed: string }
  | { kind: 'done'; path: string }
  | { kind: 'saved'; path: string }
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
  /** The project: an ordered list of clips, edited one at a time. */
  const [clips, setClips] = useState<Clip[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  /** Filmstrip per clip, keyed by clip id — building one is not free. */
  const [strips, setStrips] = useState<Record<string, string>>({})
  /** Playhead in project time, spanning every clip. */
  const [projectSec, setProjectSec] = useState(0)
  /** Source time to apply once a newly selected clip has loaded. */
  const pendingSeek = useRef<number | null>(null)
  /** Whether the user wants playback running, independent of element state. */
  const wantPlay = useRef(false)
  /** Source the element has actually loaded, to spot a no-op src change. */
  const loadedSrc = useRef('')
  const [playing, setPlaying] = useState(false)
  const [aspect, setAspect] = useState<AspectPreset>('vertical')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [videoBox, setVideoBox] = useState<{ w: number; h: number } | null>(null)
  const [tool, setTool] = useState<ToolId>('trim')
  const [selectedRegion, setSelectedRegion] = useState<string | null>(null)
  const [capStyle, setCapStyle] = useState<CaptionStyle>(() => defaultCaptionStyle())
  const [modelId, setModelId] = useState<WhisperModelId>('base.en')
  const [modelReady, setModelReady] = useState(false)
  const [capJob, setCapJob] = useState<CaptionJob>({ kind: 'idle' })
  /** Where the project was last saved, so Ctrl+S can save in place. */
  const [projectPath, setProjectPath] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [recovery, setRecovery] = useState<{ project: ProjectFile; savedAt: string } | null>(
    null
  )
  /** Bumped on any region edit so the paused canvas preview repaints. */
  const [revision, setRevision] = useState(0)
  const pictureRef = useRef<HTMLDivElement>(null)
  const outPaneRef = useRef<HTMLDivElement>(null)
  const outFrameRef = useRef<HTMLDivElement>(null)

  /**
   * The clip being edited. Everything below reads and writes through it, so the
   * rest of the editor stays written against "the current clip" rather than
   * having to know about the project.
   */
  const active = clips.find((c) => c.id === activeId) ?? null

  /** Setter shim supporting both a value and an updater, like useState. */
  function makeSetter<K extends keyof Clip>(key: K) {
    return (value: Clip[K] | ((prev: Clip[K]) => Clip[K])): void => {
      setClips((cs) =>
        cs.map((c) =>
          c.id === activeId
            ? {
                ...c,
                [key]:
                  typeof value === 'function'
                    ? (value as (prev: Clip[K]) => Clip[K])(c[key])
                    : value
              }
            : c
        )
      )
    }
  }

  /** Applies a loaded project, replacing whatever is open. */
  const adoptProject = useCallback((p: ProjectFile, path: string | null) => {
    setClips(p.clips)
    setAspect(p.aspect ?? 'vertical')
    if (p.captionStyle) setCapStyle(p.captionStyle)
    setActiveId(p.clips[0]?.id ?? null)
    setSelectedRegion(null)
    setProjectSec(0)
    setProjectPath(path)
    setDirty(false)
    setRevision((n) => n + 1)

    // Filmstrips are derived, not stored — rebuild them in the background.
    for (const c of p.clips) {
      window.api
        .filmstrip(c.meta.path, c.meta.durationSec)
        .then((strip) => setStrips((s) => ({ ...s, [c.id]: mediaUrl(strip) })))
        .catch(() => undefined)
    }
  }, [])

  const saveProjectAs = useCallback(
    async (forceDialog = false) => {
      if (!clips.length) return
      const res = await window.api.saveProject(
        serialiseProject(clips, aspect, capStyle),
        forceDialog ? undefined : (projectPath ?? undefined)
      )
      if (res.cancelled) return
      if (res.ok && res.path) {
        setProjectPath(res.path)
        setDirty(false)
        setStatus({ kind: 'saved', path: res.path })
      } else if (res.error) {
        setStatus({ kind: 'error', message: res.error })
      }
    },
    [clips, aspect, capStyle, projectPath]
  )

  const openProject = useCallback(async () => {
    const res = await window.api.openProject()
    if (res.cancelled) return
    if (!res.ok || !res.project) {
      if (res.error) setStatus({ kind: 'error', message: res.error })
      return
    }
    adoptProject(res.project, res.path ?? null)
    if (res.missing?.length) {
      setStatus({
        kind: 'error',
        message: `Opened, but ${res.missing.length} source file${
          res.missing.length === 1 ? '' : 's'
        } could not be found:\n${res.missing.join('\n')}`
      })
    }
  }, [adoptProject])

  /** Undo covers the clips — trims, layouts and captions all live on them. */
  const { undo, redo, canUndo, canRedo } = useUndo<Clip[]>({
    value: clips,
    apply: (restored) => {
      setClips(restored)
      // The selected clip may have been removed or split away.
      if (!restored.some((c) => c.id === activeId)) setActiveId(restored[0]?.id ?? null)
      setSelectedRegion(null)
      setRevision((n) => n + 1)
    }
  })

  const spans = useMemo(() => layoutClips(clips), [clips])
  const total = totalDuration(spans)
  /** Clip-local playhead, still what the tools and caption preview expect. */
  const current = active
    ? (resolveTime(spans, projectSec)?.sourceSec ?? active.inSec)
    : 0

  const meta = active?.meta ?? null
  const srcUrl = meta ? mediaUrl(meta.path) : ''
  const inSec = active?.inSec ?? 0
  const outSec = active?.outSec ?? 0
  const regions = active?.regions ?? []
  const words = active?.words ?? []
  const activePreset = active?.activePreset ?? null
  const presetDirty = active?.presetDirty ?? false

  const setInSec = makeSetter('inSec')
  const setOutSec = makeSetter('outSec')
  const setRegions = makeSetter('regions')
  const setWords = makeSetter('words')
  const setActivePreset = makeSetter('activePreset')
  const setPresetDirty = makeSetter('presetDirty')

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
    // Offer whatever the last session left behind, rather than restoring it
    // silently over what the user might be about to open.
    window.api.getRecovery().then(setRecovery)
  }, [])

  /**
   * Autosave, so a crash or a closed window does not cost the edit. Throttled
   * because it fires on every trim and caption change.
   */
  useEffect(() => {
    if (!clips.length) return
    setDirty(true)
    const t = setTimeout(() => {
      window.api.autosaveProject(serialiseProject(clips, aspect, capStyle))
    }, 1500)
    return () => clearTimeout(t)
  }, [clips, aspect, capStyle])

  useEffect(() => {
    return window.api.onExportProgress((p: ExportProgress) => {
      setStatus((s) =>
        s.kind === 'exporting' ? { kind: 'exporting', percent: p.percent, speed: p.speed } : s
      )
    })
  }, [])

  /** Appends a file to the project and selects it. */
  const loadPath = useCallback(async (filePath: string) => {
    try {
      const m = await window.api.probe(filePath)
      const clip = newClip(m)
      // Start on the single centred box — same result as a plain reframe, but
      // now it is an editable layout rather than a fixed crop.
      clip.regions = LAYOUT_PRESETS[0].build({
        srcAspect: m.height ? m.width / m.height : 16 / 9,
        canvasW: 1080,
        canvasH: 1920
      })
      clip.activePreset = LAYOUT_PRESETS[0].id

      setClips((cs) => [...cs, clip])
      setActiveId(clip.id)
      setSelectedRegion(clip.regions[0]?.id ?? null)
      setProjectSec(0)
      setStatus({ kind: 'idle' })
      setRevision((n) => n + 1)

      // Thumbnails are a nicety. Isolated in its own try because a missing
      // bridge method throws synchronously and would otherwise surface as an
      // "this video failed to load" error.
      try {
        const strip = await window.api.filmstrip(filePath, m.durationSec)
        setStrips((s) => ({ ...s, [clip.id]: mediaUrl(strip) }))
      } catch {
        /* the timeline just stays plain */
      }
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }, [])

  const openFile = useCallback(async () => {
    const filePath = await window.api.openVideo()
    if (filePath) await loadPath(filePath)
  }, [loadPath])

  const removeClip = useCallback(
    (id: string) => {
      setClips((cs) => {
        const next = cs.filter((c) => c.id !== id)
        if (id === activeId) setActiveId(next[0]?.id ?? null)
        return next
      })
      setStrips((s) => {
        const next = { ...s }
        delete next[id]
        return next
      })
    },
    [activeId]
  )

  /** Cuts the clip under the playhead in two, keeping the playhead where it is. */
  const splitAtPlayhead = useCallback(() => {
    if (!active) return
    const parts = splitClip(active, current)
    if (!parts) return
    const [head, tail] = parts
    setClips((cs) => cs.flatMap((c) => (c.id === active.id ? [head, tail] : [c])))
    // Carry on in the second half, which is where the playhead now sits.
    setActiveId(tail.id)
    setSelectedRegion(null)
  }, [active, current])

  const moveClip = useCallback((id: string, dir: -1 | 1) => {
    setClips((cs) => {
      const i = cs.findIndex((c) => c.id === id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= cs.length) return cs
      const next = [...cs]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }, [])

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

  /**
   * Seeks in project time, switching the loaded clip when the target lands in a
   * different one. The switch is asynchronous — the element has to load the new
   * source first — so the wanted source time is stashed and applied on load.
   */
  const seekProject = useCallback(
    (sec: number) => {
      const resolved = resolveTime(spans, sec)
      if (!resolved) return
      setProjectSec(clamp(sec, 0, Math.max(0, total - 0.001)))

      const v = videoRef.current
      if (resolved.span.clip.id !== activeId) {
        pendingSeek.current = resolved.sourceSec
        setActiveId(resolved.span.clip.id)
        setSelectedRegion(null)
      } else if (v) {
        v.currentTime = resolved.sourceSec
      }
    },
    [spans, total, activeId]
  )

  /** Seeks using a time in the active clip's own source, which is what the
      tools and the transcript work in. */
  const seek = useCallback(
    (sourceSec: number) => {
      const span = active ? spanOf(spans, active.id) : null
      if (span) seekProject(projectTimeOf(span, sourceSec))
    },
    [active, spans, seekProject]
  )

  const togglePlay = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) {
      // Restart from the top if the playhead is sitting at the very end.
      if (projectSec >= total - 0.05) seekProject(0)
      // Tracks intent rather than element state: the element is paused between
      // clips while the next source loads, and again when one ends.
      wantPlay.current = true
      void v.play()
    } else {
      wantPlay.current = false
      v.pause()
    }
  }, [projectSec, total, seekProject])

  /** Applies a seek that was waiting on the new source to finish loading. */
  const applyPendingSeek = useCallback(() => {
    const v = videoRef.current
    if (!v || pendingSeek.current === null) return
    v.currentTime = pendingSeek.current
    pendingSeek.current = null
    if (wantPlay.current) void v.play()
  }, [])

  const onLoadedMetadata = useCallback(() => {
    loadedSrc.current = srcUrl
    applyPendingSeek()
  }, [srcUrl, applyPendingSeek])

  /**
   * Two clips can come from the same file — two moments of one recording — in
   * which case the element's source never changes and no load event fires. The
   * waiting seek would then never be applied, so it is applied here instead.
   */
  useEffect(() => {
    const v = videoRef.current
    if (!v || pendingSeek.current === null) return
    if (loadedSrc.current === srcUrl && v.readyState >= 1) applyPendingSeek()
  }, [activeId, srcUrl, applyPendingSeek])

  /** Moves to the next clip, or stops if this was the last one. */
  const advanceClip = useCallback(() => {
    const v = videoRef.current
    if (!v || !active) return
    const span = spanOf(spans, active.id)
    const next = span ? spans[span.index + 1] : null

    if (next) {
      pendingSeek.current = next.clip.inSec
      setProjectSec(next.start)
      setActiveId(next.clip.id)
      setSelectedRegion(null)
    } else {
      v.pause()
      wantPlay.current = false
      setProjectSec(total)
    }
  }, [active, spans, total])

  const onTimeUpdate = useCallback(() => {
    const v = videoRef.current
    if (!v || !active) return

    // Rolled past this clip's out point — only meaningful for a trimmed clip;
    // one playing to its natural end is caught by 'ended' instead, because
    // timeupdate fires a few times a second and can skip this window entirely.
    if (v.currentTime >= active.outSec - 0.05) {
      advanceClip()
      return
    }

    const span = spanOf(spans, active.id)
    if (span) setProjectSec(projectTimeOf(span, v.currentTime))
  }, [active, spans, advanceClip])

  const doExport = useCallback(async () => {
    if (!meta) return
    const suggested = await window.api.suggestOutput(meta.path)
    const outputPath = await window.api.saveClipDialog(suggested)
    if (!outputPath) return

    setStatus({ kind: 'exporting', percent: 0, speed: '' })

    const trackFor = (c: Clip) =>
      c.words.length > 0 ? { words: c.words, style: capStyle } : undefined

    let result
    if (clips.length > 1) {
      // Several clips: render each on the shared canvas, then join them.
      if (!canvasDims) {
        setStatus({
          kind: 'error',
          message: 'Joining clips needs a fixed canvas — pick 9:16, 1:1 or 16:9 rather than Source.'
        })
        return
      }
      result = await window.api.exportProject({
        outputPath,
        canvas: canvasDims,
        fps: projectFps(clips),
        segments: clips.map((c) => ({
          inputPath: c.meta.path,
          startSec: c.inSec,
          endSec: c.outSec,
          regions: c.regions,
          srcWidth: c.meta.width,
          srcHeight: c.meta.height,
          hasAudio: c.meta.hasAudio,
          captions: trackFor(c)
        }))
      })
    } else if (canvasDims && regions.length > 0) {
      result = await window.api.exportComposite({
        inputPath: meta.path,
        outputPath,
        startSec: inSec,
        endSec: outSec,
        regions,
        srcWidth: meta.width,
        srcHeight: meta.height,
        canvas: canvasDims,
        captions: trackFor(active!)
      })
    } else {
      // A plain trim can stream-copy, which stays far faster.
      result = await window.api.exportClip({
        inputPath: meta.path,
        outputPath,
        startSec: inSec,
        endSec: outSec,
        aspect,
        reencode: false,
        captions: trackFor(active!)
      })
    }

    if (result.ok && result.outputPath) setStatus({ kind: 'done', path: result.outputPath })
    else setStatus({ kind: 'error', message: result.error ?? 'Export failed' })
  }, [meta, active, clips, inSec, outSec, aspect, canvasDims, regions, capStyle])

  // Space toggles play, I/O set the trim points — the shortcuts editors expect.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!meta) return
      const target = e.target as HTMLElement
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        redo()
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void saveProjectAs(e.shiftKey)
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        void openProject()
        return
      }
      if (e.ctrlKey || e.metaKey) return

      if (e.code === 'Space') {
        e.preventDefault()
        togglePlay()
      } else if (e.key === 's' || e.key === 'S') {
        e.preventDefault()
        splitAtPlayhead()
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
    updateRegion,
    splitAtPlayhead,
    undo,
    redo,
    saveProjectAs,
    openProject
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
          {clips.length > 0 && (
            <span className="project-name" title={projectPath ?? 'Not saved yet'}>
              {projectPath ? projectPath.split(/[\\/]/).pop() : 'Untitled project'}
              {dirty && <b className="dot" title="Unsaved changes" />}
            </span>
          )}
          <button className="btn" onClick={openProject} title="Open a project (Ctrl+O)">
            <FolderIcon size={15} /> Open
          </button>
          <button
            className="btn"
            onClick={() => saveProjectAs(false)}
            disabled={!clips.length}
            title="Save the project (Ctrl+S)"
          >
            <SaveIcon size={15} /> Save
          </button>
          <button className="btn" onClick={openFile}>
            Add video
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

      {recovery && clips.length === 0 && (
        <div className="banner warn recovery">
          <span>
            FlowClip closed with an unsaved project — {recovery.project.clips.length} clip
            {recovery.project.clips.length === 1 ? '' : 's'} from{' '}
            {new Date(recovery.savedAt).toLocaleString()}.
          </span>
          <span className="recovery-actions">
            <button
              className="btn small primary"
              onClick={() => {
                adoptProject(recovery.project, null)
                setRecovery(null)
              }}
            >
              Restore it
            </button>
            <button
              className="btn small ghost"
              onClick={() => {
                void window.api.clearRecovery()
                setRecovery(null)
              }}
            >
              Discard
            </button>
          </span>
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
              onLoadedMetadata={onLoadedMetadata}
              onEnded={advanceClip}
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
                {formatTime(projectSec)} <span className="dim">/ {formatTime(total)}</span>
              </span>

              <span className="mark-group">
                <button
                  className="btn small"
                  onClick={splitAtPlayhead}
                  disabled={!active || !canSplit(active, current)}
                  title="Split the clip at the playhead (S)"
                >
                  <ScissorsIcon size={15} /> Split
                </button>
                <button
                  className="btn small ghost"
                  onClick={undo}
                  disabled={!canUndo}
                  title="Undo (Ctrl+Z)"
                >
                  <UndoIcon size={15} />
                </button>
                <button
                  className="btn small ghost"
                  onClick={redo}
                  disabled={!canRedo}
                  title="Redo (Ctrl+Shift+Z)"
                >
                  <RedoIcon size={15} />
                </button>
              </span>

              <span className="spacer" />
              <span className="meta-chip">
                {meta.width}×{meta.height}
              </span>
              <span className="meta-chip">{meta.fps} fps</span>
              <span className="meta-chip">{formatBytes(meta.sizeBytes)}</span>
            </div>

            <ProjectTimeline
              clips={clips}
              activeId={activeId}
              strips={strips}
              projectSec={projectSec}
              onSeek={seekProject}
              onSelect={(id) => {
                if (id !== activeId) {
                  const span = spanOf(spans, id)
                  if (span) {
                    pendingSeek.current = span.clip.inSec
                    setProjectSec(span.start)
                  }
                  setActiveId(id)
                  setSelectedRegion(null)
                }
              }}
              onTrim={(id, patch) =>
                setClips((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)))
              }
              onMove={moveClip}
              onRemove={removeClip}
              onAdd={openFile}
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
            {status.kind === 'saved' && (
              <div className="banner ok">
                Project saved.{' '}
                <button className="link" onClick={() => window.api.revealFile(status.path)}>
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
