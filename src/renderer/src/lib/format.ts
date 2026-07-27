/** m:ss.d — compact enough for the trim readout, precise enough to cut on. */
export function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  const d = Math.floor((sec % 1) * 10)
  return `${m}:${String(s).padStart(2, '0')}.${d}`
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '—'
  const mb = bytes / (1024 * 1024)
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}
