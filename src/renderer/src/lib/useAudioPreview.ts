import { useEffect, useRef } from 'react'
import type { AudioTrack } from '../../../shared/types'
import { mediaUrl } from '../../../shared/types'

/** Past this much drift, the element is nudged back rather than left to slide. */
const RESYNC_SEC = 0.35

/**
 * Plays music and effects alongside the preview.
 *
 * The export mixes audio with ffmpeg, but the preview has to hear it too — a mix
 * you cannot hear is one you cannot judge. Each track gets its own audio element
 * positioned against project time, so a bed keeps playing across a cut even
 * though the video element underneath is swapping sources.
 */
export function useAudioPreview(
  tracks: AudioTrack[],
  projectSec: number,
  playing: boolean
): void {
  const elements = useRef(new Map<string, HTMLAudioElement>())

  // Create and dispose elements as tracks come and go.
  useEffect(() => {
    const map = elements.current
    const wanted = new Set(tracks.map((t) => t.id))

    for (const [id, el] of map) {
      if (!wanted.has(id)) {
        el.pause()
        el.src = ''
        map.delete(id)
      }
    }

    for (const t of tracks) {
      let el = map.get(t.id)
      if (!el) {
        el = new Audio(mediaUrl(t.path))
        el.preload = 'auto'
        map.set(t.id, el)
      }
      // Elements cap at 1; the export honours the full range, so a track pushed
      // above 100% sounds louder in the file than it does here.
      el.volume = Math.max(0, Math.min(1, t.volume))
    }
  }, [tracks])

  // Position and start or stop each track against the playhead.
  useEffect(() => {
    for (const t of tracks) {
      const el = elements.current.get(t.id)
      if (!el) continue

      const local = projectSec - t.startSec + t.inSec
      const within = local >= t.inSec && local < t.outSec

      if (playing && within) {
        if (el.paused) {
          el.currentTime = local
          void el.play().catch(() => undefined)
        } else if (Math.abs(el.currentTime - local) > RESYNC_SEC) {
          // Scrubbing, or drift after the video stalled at a clip boundary.
          el.currentTime = local
        }
      } else if (!el.paused) {
        el.pause()
      }
    }
  }, [tracks, projectSec, playing])

  // Silence everything if the component goes away mid-playback.
  useEffect(() => {
    const map = elements.current
    return () => {
      for (const el of map.values()) {
        el.pause()
        el.src = ''
      }
      map.clear()
    }
  }, [])
}
