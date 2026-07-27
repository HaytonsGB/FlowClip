import { useEffect, useState, type RefObject } from 'react'

/**
 * Largest box of `ratio` (w/h) that fits inside the observed element, in pixels.
 *
 * Measured rather than expressed in CSS: percentage heights inside flex/grid
 * resolve against indefinite heights and silently collapse or overflow.
 */
export function useFit(
  ref: RefObject<HTMLElement>,
  ratio: number
): { w: number; h: number } | null {
  const [box, setBox] = useState<{ w: number; h: number } | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el || ratio <= 0) return
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      if (width <= 0 || height <= 0) return
      const w = Math.min(width, height * ratio)
      setBox({ w, h: w / ratio })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref, ratio])

  return box
}
