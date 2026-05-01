import * as React from 'react'
import type { GitGraphSliceRange } from './git-history-ui'

interface UseViewportSliceRangeOptions {
  itemHeight: number
  itemCount: number
  buffer?: number
}

export function useViewportSliceRange(
  viewportRef: React.RefObject<HTMLElement | null>,
  { itemHeight, itemCount, buffer = 10 }: UseViewportSliceRangeOptions,
): GitGraphSliceRange {
  const [range, setRange] = React.useState<GitGraphSliceRange>({
    start: 0,
    end: Math.min(itemCount, buffer * 2 || itemCount),
  })

  React.useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) {
      setRange({ start: 0, end: itemCount })
      return
    }

    const updateRange = () => {
      const visibleStart = Math.max(0, Math.floor(viewport.scrollTop / itemHeight))
      const visibleCount = Math.max(1, Math.ceil(viewport.clientHeight / itemHeight))
      const start = Math.max(0, visibleStart - buffer)
      const end = Math.min(itemCount, visibleStart + visibleCount + buffer)
      setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }))
    }

    updateRange()
    viewport.addEventListener('scroll', updateRange, { passive: true })
    window.addEventListener('resize', updateRange)

    return () => {
      viewport.removeEventListener('scroll', updateRange)
      window.removeEventListener('resize', updateRange)
    }
  }, [buffer, itemCount, itemHeight, viewportRef])

  React.useEffect(() => {
    setRange((prev) => ({
      start: Math.min(prev.start, Math.max(0, itemCount - 1)),
      end: Math.min(Math.max(prev.end, prev.start + 1), itemCount),
    }))
  }, [itemCount])

  return range
}
