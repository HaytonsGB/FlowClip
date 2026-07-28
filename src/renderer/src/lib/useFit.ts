import { useEffect, useState } from 'react'

export interface FitBox {
  w: number
  h: number
}

/**
 * Largest box of `ratio` (w/h) that fits inside an element, in pixels.
 *
 * Measured rather than expressed in CSS: percentage heights inside flex and
 * grid resolve against indefinite heights and silently collapse or overflow.
 *
 * Returns a *callback* ref rather than taking a ref object. A ref object does
 * not tell React when it is filled in, so an element that mounts later — the
 * output pane only exists once Layout or Captions is open — would never be
 * observed, and the pane would stay blank until something unrelated happened to
 * re-run the effect.
 */
export function useFit(ratio: number): [(el: HTMLElement | null) => void, FitBox | null] {
  const [element, setElement] = useState<HTMLElement | null>(null)
  const [box, setBox] = useState<FitBox | null>(null)

  useEffect(() => {
    if (!element || ratio <= 0) {
      setBox(null)
      return
    }
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      if (width <= 0 || height <= 0) return
      const w = Math.min(width, height * ratio)
      setBox({ w, h: w / ratio })
    })
    ro.observe(element)
    return () => ro.disconnect()
  }, [element, ratio])

  return [setElement, box]
}
