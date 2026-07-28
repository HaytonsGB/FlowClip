import { useCallback, useEffect, useRef, useState } from 'react'

interface Options<T> {
  /** Current value to track. */
  value: T
  /** Applies a restored value. */
  apply: (value: T) => void
  /**
   * Edits closer together than this collapse into one step, so dragging a trim
   * handle is a single undo rather than one per pointer move.
   */
  coalesceMs?: number
  limit?: number
}

/**
 * Undo/redo over a single state object.
 *
 * History is captured by watching the value rather than asking every mutation
 * site to record itself — with edits spread across trimming, layout, captions
 * and the timeline, anything opt-in would quietly miss some.
 */
export function useUndo<T>({
  value,
  apply,
  coalesceMs = 400,
  limit = 100
}: Options<T>): {
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
} {
  const past = useRef<T[]>([])
  const future = useRef<T[]>([])
  /** Last value committed to history; the one an edit would undo back to. */
  const baseline = useRef<T | null>(null)
  /** Set while applying a restored value, so it is not recorded as an edit. */
  const restoring = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)

  useEffect(() => {
    if (baseline.current === null) {
      baseline.current = value
      return
    }
    if (restoring.current) {
      restoring.current = false
      baseline.current = value
      return
    }
    if (value === baseline.current) return

    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      if (baseline.current !== null) {
        past.current.push(baseline.current)
        if (past.current.length > limit) past.current.shift()
      }
      baseline.current = value
      future.current = []
      setCanUndo(past.current.length > 0)
      setCanRedo(false)
    }, coalesceMs)
  }, [value, coalesceMs, limit])

  const undo = useCallback(() => {
    // Flush a pending capture first, or the edit in progress is lost silently.
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
      if (baseline.current !== null) past.current.push(baseline.current)
      baseline.current = value
    }
    const previous = past.current.pop()
    if (previous === undefined) return
    future.current.push(value)
    restoring.current = true
    apply(previous)
    setCanUndo(past.current.length > 0)
    setCanRedo(true)
  }, [value, apply])

  const redo = useCallback(() => {
    const next = future.current.pop()
    if (next === undefined) return
    past.current.push(value)
    restoring.current = true
    apply(next)
    setCanUndo(true)
    setCanRedo(future.current.length > 0)
  }, [value, apply])

  return { undo, redo, canUndo, canRedo }
}
