import * as React from 'react'
import { cn } from '@/lib/utils'
import { Codicon } from '@/components/ui/Codicon'
import type { GitRecentCommitItem } from '../../../shared/types'

export interface GitGraphParentEdge {
  parentHash: string
  lane: number
  primary: boolean
}

export interface GitGraphRow {
  commitHash: string
  nodeLane: number
  topLanes: number[]
  bottomLanes: number[]
  topLaneHashes: Array<string | null>
  bottomLaneHashes: Array<string | null>
  parentEdges: GitGraphParentEdge[]
  mergeLanes: number[]
  mergeRouteLevels: number[]
  mergeBundleKeys: string[]
  mergeBundleChannelLevels: number[]
}

export interface GitGraphLayout {
  laneCount: number
  rows: GitGraphRow[]
}

export interface GitGraphSliceRange {
  start: number
  end: number
}

interface GitGraphBuildState {
  activeLanes: Array<string | null>
  preferredLaneByHash: Map<string, number>
  mergeRouteUsage: Map<string, number>
  preferredBundleChannelLevelByKey: Map<string, number>
  bundleChannelUsage: Map<string, number>
  maxLaneIndex: number
}

type RefBadgeKind = 'head' | 'branch' | 'remote' | 'tag' | 'default'

function getRefBadgeKind(ref: string): RefBadgeKind {
  if (ref === 'HEAD' || ref.startsWith('HEAD -> ')) return 'head'
  if (ref.startsWith('tag: ')) return 'tag'
  if (/^(origin|upstream|fork)\//.test(ref)) return 'remote'
  if (/^[^\s,]+$/.test(ref) || ref === 'main' || ref === 'master' || ref === 'develop' || ref === 'dev' || ref.startsWith('release/') || ref.startsWith('feature/') || ref.startsWith('hotfix/')) {
    return 'branch'
  }
  return 'default'
}

function getRefBadgeLabel(ref: string): string {
  return ref.startsWith('tag: ') ? ref.slice(5) : ref
}

function getRefBadgeSortWeight(ref: string): number {
  const kind = getRefBadgeKind(ref)
  switch (kind) {
    case 'head': return 0
    case 'branch': return 1
    case 'remote': return 2
    case 'tag': return 3
    default: return 4
  }
}

function sortRefNames(refNames: string[]): string[] {
  return [...refNames].sort((a, b) => {
    const weightDiff = getRefBadgeSortWeight(a) - getRefBadgeSortWeight(b)
    if (weightDiff !== 0) return weightDiff
    return getRefBadgeLabel(a).localeCompare(getRefBadgeLabel(b), undefined, { sensitivity: 'base' })
  })
}

function getRefBadgeClassName(kind: RefBadgeKind): string {
  switch (kind) {
    case 'head':
      return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    case 'tag':
      return 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300'
    case 'remote':
      return 'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300'
    case 'branch':
      return 'border-violet-500/25 bg-violet-500/10 text-violet-700 dark:text-violet-300'
    default:
      return 'border-border/60 bg-foreground/[0.03] text-foreground/80'
  }
}

function getRefBadgeIcon(kind: RefBadgeKind): string | null {
  switch (kind) {
    case 'head':
      return 'target'
    case 'tag':
      return 'tag'
    case 'remote':
      return 'cloud'
    case 'branch':
      return 'git-branch'
    default:
      return null
  }
}

export function GitRefBadges({ refNames, className, compact = false }: { refNames: string[]; className?: string; compact?: boolean }) {
  if (refNames.length === 0) return null

  const sortedRefNames = sortRefNames(refNames)

  return (
    <div className={cn(compact ? 'mt-0.5 flex flex-wrap gap-1' : 'mt-2 flex flex-wrap gap-1', className)}>
      {sortedRefNames.map((ref) => {
        const kind = getRefBadgeKind(ref)
        const icon = getRefBadgeIcon(kind)
        return (
          <span
            key={ref}
            className={cn(
              compact
                ? 'inline-flex items-center gap-1 rounded border px-1.5 py-[1px] text-[10px] font-medium leading-4'
                : 'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium',
              getRefBadgeClassName(kind)
            )}
          >
            {icon ? <Codicon name={icon as any} className="text-[10px] leading-none" /> : null}
            <span>{getRefBadgeLabel(ref)}</span>
          </span>
        )
      })}
    </div>
  )
}

const LANE_COLOR_CLASSES = [
  {
    stroke: 'stroke-emerald-500',
    nodeFill: 'fill-emerald-500',
    ring: 'stroke-emerald-500',
    bg: 'bg-emerald-500',
    border: 'border-emerald-500',
  },
  {
    stroke: 'stroke-violet-500',
    nodeFill: 'fill-violet-500',
    ring: 'stroke-violet-500',
    bg: 'bg-violet-500',
    border: 'border-violet-500',
  },
  {
    stroke: 'stroke-sky-500',
    nodeFill: 'fill-sky-500',
    ring: 'stroke-sky-500',
    bg: 'bg-sky-500',
    border: 'border-sky-500',
  },
  {
    stroke: 'stroke-amber-500',
    nodeFill: 'fill-amber-500',
    ring: 'stroke-amber-500',
    bg: 'bg-amber-500',
    border: 'border-amber-500',
  },
  {
    stroke: 'stroke-pink-500',
    nodeFill: 'fill-pink-500',
    ring: 'stroke-pink-500',
    bg: 'bg-pink-500',
    border: 'border-pink-500',
  },
] as const

function getLaneColors(laneIndex: number) {
  return LANE_COLOR_CLASSES[laneIndex % LANE_COLOR_CLASSES.length]
}

function findOpenLane(lanes: Array<string | null>, preferredStart = 0): number {
  for (let index = preferredStart; index < lanes.length; index += 1) {
    if (lanes[index] === null) return index
  }
  const emptyIndex = lanes.findIndex(lane => lane === null)
  return emptyIndex >= 0 ? emptyIndex : lanes.length
}

function trimTrailingEmptyLanes(lanes: Array<string | null>): Array<string | null> {
  const next = [...lanes]
  while (next.length > 0 && next[next.length - 1] === null) next.pop()
  return next
}

function createInitialBuildState(): GitGraphBuildState {
  return {
    activeLanes: [],
    preferredLaneByHash: new Map<string, number>(),
    mergeRouteUsage: new Map<string, number>(),
    preferredBundleChannelLevelByKey: new Map<string, number>(),
    bundleChannelUsage: new Map<string, number>(),
    maxLaneIndex: 0,
  }
}

function cloneBuildState(state: GitGraphBuildState): GitGraphBuildState {
  return {
    activeLanes: [...state.activeLanes],
    preferredLaneByHash: new Map(state.preferredLaneByHash),
    mergeRouteUsage: new Map(state.mergeRouteUsage),
    preferredBundleChannelLevelByKey: new Map(state.preferredBundleChannelLevelByKey),
    bundleChannelUsage: new Map(state.bundleChannelUsage),
    maxLaneIndex: state.maxLaneIndex,
  }
}

function buildGitGraphRowsWithState(commits: GitRecentCommitItem[], inputState?: GitGraphBuildState, allHashes?: Set<string>): { layout: GitGraphLayout; state: GitGraphBuildState } {
  const visibleHashes = allHashes ?? new Set(commits.map(commit => commit.hash))
  const state = inputState ? cloneBuildState(inputState) : createInitialBuildState()

  const reserveMergeRouteLevel = (fromLane: number, toLane: number): number => {
    const minLane = Math.min(fromLane, toLane)
    const maxLane = Math.max(fromLane, toLane)
    const touchedKeys: string[] = []
    let level = 0

    for (let lane = minLane; lane < maxLane; lane += 1) {
      const intervalKey = `${lane}:${lane + 1}`
      touchedKeys.push(intervalKey)
      level = Math.max(level, state.mergeRouteUsage.get(intervalKey) ?? 0)
    }

    for (const intervalKey of touchedKeys) {
      state.mergeRouteUsage.set(intervalKey, level + 1)
    }

    return level
  }

  const reserveBundleChannelLevel = (bundleKey: string, fromLane: number, toLane: number): number => {
    const minLane = Math.min(fromLane, toLane)
    const maxLane = Math.max(fromLane, toLane)
    const touchedKeys: string[] = []
    const preferredLevel = state.preferredBundleChannelLevelByKey.get(bundleKey)
    let level = preferredLevel ?? 0

    for (let lane = minLane; lane < maxLane; lane += 1) {
      const channelKey = `${lane}:${lane + 1}`
      touchedKeys.push(channelKey)
      level = Math.max(level, state.bundleChannelUsage.get(channelKey) ?? 0)
    }

    for (const channelKey of touchedKeys) {
      state.bundleChannelUsage.set(channelKey, level + 1)
    }

    state.preferredBundleChannelLevelByKey.set(bundleKey, level)
    return level
  }

  const rows = commits.map((commit) => {
    let nodeLane = state.activeLanes.indexOf(commit.hash)
    if (nodeLane === -1) {
      const preferredLane = state.preferredLaneByHash.get(commit.hash)
      nodeLane = preferredLane !== undefined ? findOpenLane(state.activeLanes, preferredLane) : findOpenLane(state.activeLanes)
      state.activeLanes[nodeLane] = commit.hash
    }

    const topLaneHashes = [...state.activeLanes]
    const topLanes = topLaneHashes.flatMap((laneHash, index) => laneHash ? [index] : [])
    const nextLanes = [...state.activeLanes]
    const mergeLanes: number[] = []
    const visibleParents = commit.parentHashes.filter(parentHash => visibleHashes.has(parentHash))
    const primaryParent = visibleParents[0]

    if (primaryParent) {
      // Keep the first-parent line on the current lane even if the same parent
      // is already active on another lane. That duplicate is intentional: it
      // lets a side branch continue vertically until the shared ancestor row,
      // where it connects sideways into the main-line node. If we collapse to
      // the existing lane here, commits like E in A-B-C-D plus B-E-D draw an
      // incorrect horizontal edge at E instead of at B.
      nextLanes[nodeLane] = primaryParent
      state.preferredLaneByHash.set(primaryParent, nodeLane)
    } else {
      nextLanes[nodeLane] = null
    }

    visibleParents.slice(1).forEach((parentHash, parentOffset) => {
      let parentLane = nextLanes.findIndex(laneHash => laneHash === parentHash)
      if (parentLane === -1) {
        const preferredLane = state.preferredLaneByHash.get(parentHash)
        parentLane = preferredLane !== undefined
          ? findOpenLane(nextLanes, preferredLane)
          : findOpenLane(nextLanes, nodeLane + parentOffset + 1)
        nextLanes[parentLane] = parentHash
      }
      state.preferredLaneByHash.set(parentHash, parentLane)
      if (!mergeLanes.includes(parentLane)) {
        mergeLanes.push(parentLane)
      }
    })

    // If the same commit is active in multiple lanes, this row is the common
    // ancestor where a side branch terminates (when viewed top-to-bottom). Keep
    // the commit on its node lane, but close duplicate lanes below this row so
    // the branch connects horizontally into the node instead of continuing under
    // the fork point.
    for (let laneIndex = 0; laneIndex < nextLanes.length; laneIndex += 1) {
      if (laneIndex !== nodeLane && nextLanes[laneIndex] === commit.hash) {
        nextLanes[laneIndex] = null
      }
    }

    state.activeLanes = trimTrailingEmptyLanes(nextLanes)
    const bottomLaneHashes = [...state.activeLanes]
    const bottomLanes = bottomLaneHashes.flatMap((laneHash, index) => laneHash ? [index] : [])
    const parentEdges = visibleParents.flatMap((parentHash, index) => {
      const lane = bottomLaneHashes[nodeLane] === parentHash
        ? nodeLane
        : bottomLaneHashes.findIndex(laneHash => laneHash === parentHash)
      return lane >= 0 ? [{ parentHash, lane, primary: index === 0 }] : []
    })

    state.maxLaneIndex = Math.max(state.maxLaneIndex, nodeLane, ...topLanes, ...bottomLanes, ...mergeLanes)

    const mergeBundleKeys = mergeLanes.map((laneIndex) => {
      const intervalStart = Math.min(nodeLane, laneIndex)
      const intervalEnd = Math.max(nodeLane, laneIndex)
      const distance = Math.abs(nodeLane - laneIndex)
      const tier = distance <= 1 ? 'near' : distance <= 3 ? 'mid' : 'far'
      const side = laneIndex < nodeLane ? 'left' : 'right'
      return `${side}:${intervalStart}:${intervalEnd}:${tier}`
    })
    const mergeRouteLevels = mergeLanes.map((laneIndex) => reserveMergeRouteLevel(nodeLane, laneIndex))
    const mergeBundleChannelLevels = mergeLanes.map((laneIndex, index) => reserveBundleChannelLevel(mergeBundleKeys[index]!, nodeLane, laneIndex))

    return {
      commitHash: commit.hash,
      nodeLane,
      topLanes,
      bottomLanes,
      topLaneHashes,
      bottomLaneHashes,
      parentEdges,
      mergeLanes,
      mergeRouteLevels,
      mergeBundleKeys,
      mergeBundleChannelLevels,
    }
  })

  return {
    layout: {
      laneCount: Math.max(3, state.maxLaneIndex + 1),
      rows,
    },
    state,
  }
}

export function buildGitGraphRows(commits: GitRecentCommitItem[]): GitGraphLayout {
  return buildGitGraphRowsWithState(commits).layout
}

export function buildGitGraphRowsForSlice(commits: GitRecentCommitItem[], range?: GitGraphSliceRange): GitGraphLayout {
  if (!range) return buildGitGraphRows(commits)
  const safeStart = Math.max(0, Math.min(range.start, commits.length))
  const safeEnd = Math.max(safeStart, Math.min(range.end, commits.length))
  // Build a single set of ALL commit hashes so that parent resolution works across slice boundaries
  const allHashes = new Set(commits.map(commit => commit.hash))
  if (safeStart === 0) {
    return buildGitGraphRowsWithState(commits.slice(0, safeEnd), undefined, allHashes).layout
  }

  const prefixState = buildGitGraphRowsWithState(commits.slice(0, safeStart), undefined, allHashes).state
  const sliceResult = buildGitGraphRowsWithState(commits.slice(safeStart, safeEnd), prefixState, allHashes)

  return {
    laneCount: Math.max(3, prefixState.maxLaneIndex + 1, sliceResult.layout.laneCount),
    rows: sliceResult.layout.rows,
  }
}

interface GitHistoryGraphMetrics {
  laneSpacing: number
  sidePadding: number
  width: number
}

export interface GitHistoryRowMeasurement {
  top: number
  center: number
  bottom: number
  height: number
}

export interface GitHistoryGraphSlotHandle {
  setRowRef: (index: number, element: HTMLElement | null) => void
}

function getGitHistoryGraphMetrics(laneCount: number): GitHistoryGraphMetrics {
  const laneSpacing = laneCount > 4 ? 12 : 14
  const sidePadding = 8
  return {
    laneSpacing,
    sidePadding,
    width: sidePadding * 2 + Math.max(0, laneCount - 1) * laneSpacing,
  }
}

/**
 * Build a smooth edge path between a child commit and its parent.
 *
 * The path is always a **per-row segment** (half-row above the node to
 * half-row below).  Three shapes:
 *
 *   1. Straight vertical   — same lane top and bottom
 *   2. Curve-out (fork)     — leave the node’s lane, arrive at target lane
 *   3. Curve-in  (merge)    — leave the source lane, arrive at the node’s lane
 *
 * Using per-row segments means the vertical pass-through lines and the
 * edge segments tile together seamlessly, with no overlaps or gaps.
 *
 * For curves we use a single cubic Bézier whose control points keep the
 * tangent vertical at both ends, producing a smooth, natural arc:
 *
 *     startX,startY
 *        │
 *        ╲      ← smooth Bézier
 *         ╲
 *          │
 *     endX,endY
 */
function buildEdgePath(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): string {
  if (startX === endX) {
    return `M ${startX} ${startY} L ${endX} ${endY}`
  }

  const dy = endY - startY
  const absDy = Math.abs(dy)
  const direction = dy >= 0 ? 1 : -1
  const lead = direction * Math.min(10, absDy * 0.35)
  const controlOffset = direction * Math.max(6, Math.min(18, absDy * 0.45))
  const bendStartY = startY + lead
  const bendControlY = endY - controlOffset

  // Leave the node vertically first, then bend toward the target lane.  This
  // avoids the reversed-looking S curve at fork points while still arriving at
  // the next segment with a vertical tangent.
  return [
    `M ${startX} ${startY}`,
    `L ${startX} ${bendStartY}`,
    `C ${startX} ${bendControlY} ${endX} ${bendControlY} ${endX} ${endY}`,
  ].join(' ')
}

export function GitHistoryGraphSpacer({ laneCount, index, measure }: { laneCount: number; index?: number; measure?: GitHistoryGraphSlotHandle }) {
  const metrics = getGitHistoryGraphMetrics(laneCount)
  return <div ref={index !== undefined && measure ? (element) => measure.setRowRef(index, element) : undefined} className="self-stretch shrink-0" style={{ width: metrics.width }} aria-hidden="true" />
}

export function GitHistoryGraphRow({ layout, row, rowIndex }: { layout: GitGraphLayout; row: GitGraphRow; rowIndex: number }) {
  const metrics = getGitHistoryGraphMetrics(layout.laneCount)
  const lineThickness = 2
  const nodeRadius = rowIndex === 0 ? 8 : 5
  const laneX = (laneIndex: number) => metrics.sidePadding + laneIndex * metrics.laneSpacing

  const elements: React.ReactNode[] = []
  const addVertical = (key: string, laneIndex: number, topPercent: number, bottomPercent: number, colorLane = laneIndex) => {
    const top = Math.min(topPercent, bottomPercent)
    const height = Math.abs(bottomPercent - topPercent)
    if (height <= 0.1) return
    elements.push(
      <div
        key={key}
        className={cn('absolute', getLaneColors(colorLane).bg)}
        style={{
          left: laneX(laneIndex) - lineThickness / 2,
          top: `${top}%`,
          width: lineThickness,
          height: `${height}%`,
        }}
      />
    )
  }
  const addHorizontal = (key: string, fromLane: number, toLane: number, yPercent: number, colorLane = Math.max(fromLane, toLane)) => {
    const fromX = laneX(fromLane)
    const toX = laneX(toLane)
    const left = Math.min(fromX, toX)
    const width = Math.abs(toX - fromX)
    if (width <= 0.5) return
    elements.push(
      <div
        key={key}
        className={cn('absolute', getLaneColors(colorLane).bg)}
        style={{
          left,
          top: `calc(${yPercent}% - ${lineThickness / 2}px)`,
          width,
          height: lineThickness,
        }}
      />
    )
  }

  // Pass-through lanes span the full row. Adjacent rows meet exactly at the row
  // boundary, so rows do not overlap but lines remain visually connected.
  const laneUnion = Array.from(new Set([...row.topLanes, ...row.bottomLanes]))
  for (const laneIndex of laneUnion) {
    if (laneIndex === row.nodeLane) continue
    const topHash = row.topLaneHashes[laneIndex]
    const bottomHash = row.bottomLaneHashes[laneIndex]
    if (!topHash || !bottomHash || topHash !== bottomHash) continue
    addVertical(`v-${row.commitHash}-${laneIndex}`, laneIndex, 0, 100)
  }

  // Lanes from another branch that terminate at this commit (common ancestor / fork
  // point in top-to-bottom history) enter the dot from the side. They keep their
  // own lane color and do not overlap the main lane.
  for (const laneIndex of row.topLanes) {
    if (laneIndex === row.nodeLane) continue
    const topHash = row.topLaneHashes[laneIndex]
    const bottomHash = row.bottomLaneHashes[laneIndex]
    if (topHash !== row.commitHash || bottomHash === topHash) continue
    addVertical(`ft-${row.commitHash}-${laneIndex}`, laneIndex, 0, 50, laneIndex)
    addHorizontal(`fh-${row.commitHash}-${laneIndex}`, laneIndex, row.nodeLane, 50, laneIndex)
  }

  if (rowIndex > 0 && row.topLaneHashes[row.nodeLane] === row.commitHash) {
    addVertical(`nt-${row.commitHash}`, row.nodeLane, 0, 50)
  }

  for (const edge of row.parentEdges) {
    const colorLane = edge.lane
    if (edge.lane === row.nodeLane) {
      addVertical(`e-${row.commitHash}-${edge.parentHash}`, row.nodeLane, 50, 100, colorLane)
      continue
    }

    // Cross-lane merge edge: leave/enter the commit from the side, then continue
    // on the branch lane. The branch lane keeps its own color and never overlaps
    // the main lane.
    addHorizontal(`eh-${row.commitHash}-${edge.parentHash}`, row.nodeLane, edge.lane, 50, colorLane)
    addVertical(`e2-${row.commitHash}-${edge.parentHash}`, edge.lane, 50, 100, colorLane)
  }

  elements.push(
    <div
      key={`dot-${row.commitHash}`}
      className={cn(
        'absolute z-10 rounded-full',
        rowIndex === 0 ? 'bg-background border-2' : getLaneColors(row.nodeLane).bg,
        rowIndex === 0 && getLaneColors(row.nodeLane).border,
      )}
      style={{
        left: laneX(row.nodeLane) - nodeRadius,
        top: `calc(50% - ${nodeRadius}px)`,
        width: nodeRadius * 2,
        height: nodeRadius * 2,
      }}
    />
  )
  if (rowIndex === 0) {
    elements.push(
      <div
        key={`dot-inner-${row.commitHash}`}
        className={cn('absolute z-20 rounded-full', getLaneColors(row.nodeLane).bg)}
        style={{ left: laneX(row.nodeLane) - 3, top: 'calc(50% - 3px)', width: 6, height: 6 }}
      />
    )
  }

  return (
    <div className="relative self-stretch shrink-0" style={{ width: metrics.width }} aria-hidden="true">
      {elements}
    </div>
  )
}

function areRowMeasurementsEqual(a: Array<GitHistoryRowMeasurement | null>, b: Array<GitHistoryRowMeasurement | null>): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]
    const right = b[index]
    if (!left || !right) {
      if (left !== right) return false
      continue
    }
    if (
      Math.abs(left.top - right.top) > 0.5 ||
      Math.abs(left.center - right.center) > 0.5 ||
      Math.abs(left.bottom - right.bottom) > 0.5 ||
      Math.abs(left.height - right.height) > 0.5
    ) {
      return false
    }
  }
  return true
}

export function useGitHistoryRowMeasurements<RowElement extends HTMLElement = HTMLElement>(itemCount: number) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const rowElementsRef = React.useRef<Array<RowElement | null>>([])
  const frameRef = React.useRef<number | null>(null)
  const [rowMeasurements, setRowMeasurements] = React.useState<Array<GitHistoryRowMeasurement | null>>([])

  const measure = React.useCallback(() => {
    frameRef.current = null
    const container = containerRef.current
    if (!container) {
      setRowMeasurements((prev) => (prev.length === 0 ? prev : []))
      return
    }

    const containerRect = container.getBoundingClientRect()
    const next: Array<GitHistoryRowMeasurement | null> = []
    for (let index = 0; index < itemCount; index += 1) {
      const element = rowElementsRef.current[index]
      if (!element) {
        next[index] = null
        continue
      }
      const rect = element.getBoundingClientRect()
      const top = rect.top - containerRect.top
      const bottom = rect.bottom - containerRect.top
      next[index] = {
        top,
        center: top + rect.height / 2,
        bottom,
        height: rect.height,
      }
    }

    setRowMeasurements((prev) => (areRowMeasurementsEqual(prev, next) ? prev : next))
  }, [itemCount])

  const scheduleMeasure = React.useCallback(() => {
    if (typeof window === 'undefined') return
    if (frameRef.current !== null) return
    frameRef.current = window.requestAnimationFrame(measure)
  }, [measure])

  const setRowRef = React.useCallback((index: number, element: RowElement | null) => {
    rowElementsRef.current[index] = element
    scheduleMeasure()
  }, [scheduleMeasure])

  const handle = React.useMemo<GitHistoryGraphSlotHandle>(() => ({
    setRowRef: (index, element) => setRowRef(index, element as RowElement | null),
  }), [setRowRef])

  React.useLayoutEffect(() => {
    rowElementsRef.current.length = itemCount
    scheduleMeasure()
  }, [itemCount, scheduleMeasure])

  React.useEffect(() => {
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', scheduleMeasure)
      return () => window.removeEventListener('resize', scheduleMeasure)
    }

    const observer = new ResizeObserver(scheduleMeasure)
    const container = containerRef.current
    if (container) observer.observe(container)
    for (let index = 0; index < itemCount; index += 1) {
      const rowElement = rowElementsRef.current[index]
      if (rowElement) observer.observe(rowElement)
    }
    window.addEventListener('resize', scheduleMeasure)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', scheduleMeasure)
    }
  }, [itemCount, rowMeasurements, scheduleMeasure])

  React.useEffect(() => {
    return () => {
      if (frameRef.current !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(frameRef.current)
      }
    }
  }, [])

  return { containerRef, rowMeasurements, setRowRef, handle }
}

export function GitHistoryGraphHtml({
  layout,
  rowMeasurements,
  estimatedRowHeight,
  className,
}: {
  layout: GitGraphLayout
  rowMeasurements: Array<GitHistoryRowMeasurement | null>
  estimatedRowHeight: number
  className?: string
}) {
  const metrics = getGitHistoryGraphMetrics(layout.laneCount)
  const measuredBottom = rowMeasurements.reduce((max, measurement, index) => Math.max(max, measurement?.bottom ?? ((index + 1) * estimatedRowHeight)), estimatedRowHeight)
  const totalHeight = Math.max(estimatedRowHeight, measuredBottom)
  const laneX = (laneIndex: number) => metrics.sidePadding + laneIndex * metrics.laneSpacing
  const fallbackCenterY = (absoluteRowIndex: number) => absoluteRowIndex * estimatedRowHeight + estimatedRowHeight / 2
  const getRowGeometry = (absoluteRowIndex: number) => {
    const measurement = rowMeasurements[absoluteRowIndex]
    const previousMeasurement = rowMeasurements[absoluteRowIndex - 1]
    const nextMeasurement = rowMeasurements[absoluteRowIndex + 1]
    const cy = measurement?.center ?? fallbackCenterY(absoluteRowIndex)
    return {
      cy,
      topY: measurement
        ? previousMeasurement ? (previousMeasurement.center + measurement.center) / 2 : measurement.top
        : cy - estimatedRowHeight / 2,
      bottomY: measurement
        ? nextMeasurement ? (measurement.center + nextMeasurement.center) / 2 : measurement.bottom
        : cy + estimatedRowHeight / 2,
    }
  }

  const lineThickness = 2
  const horizontalYInset = 10

  return (
    <div className={cn('pointer-events-none absolute left-0 top-0', className)} style={{ width: metrics.width, height: totalHeight }} aria-hidden="true">
      {layout.rows.flatMap((row, absoluteIndex) => {
        const { cy, topY, bottomY } = getRowGeometry(absoluteIndex)
        const elements: React.ReactNode[] = []
        const addVertical = (key: string, laneIndex: number, y1: number, y2: number, colorLane = laneIndex) => {
          const top = Math.min(y1, y2)
          const height = Math.abs(y2 - y1)
          if (height <= 0.5) return
          elements.push(
            <div
              key={key}
              className={cn('absolute rounded-full', getLaneColors(colorLane).bg)}
              style={{
                left: laneX(laneIndex) - lineThickness / 2,
                top,
                width: lineThickness,
                height,
              }}
            />
          )
        }
        const addHorizontal = (key: string, fromLane: number, toLane: number, y: number, colorLane = Math.max(fromLane, toLane)) => {
          const fromX = laneX(fromLane)
          const toX = laneX(toLane)
          const left = Math.min(fromX, toX)
          const width = Math.abs(toX - fromX)
          if (width <= 0.5) return
          elements.push(
            <div
              key={key}
              className={cn('absolute rounded-full', getLaneColors(colorLane).bg)}
              style={{
                left,
                top: y - lineThickness / 2,
                width,
                height: lineThickness,
              }}
            />
          )
        }

        // Pass-through vertical lines.
        const laneUnion = Array.from(new Set([...row.topLanes, ...row.bottomLanes]))
        for (const laneIndex of laneUnion) {
          if (laneIndex === row.nodeLane) continue
          const topHash = row.topLaneHashes[laneIndex]
          const bottomHash = row.bottomLaneHashes[laneIndex]
          if (!topHash || !bottomHash || topHash !== bottomHash) continue
          addVertical(`v-${row.commitHash}-${laneIndex}`, laneIndex, topY, bottomY)
        }

        // Arrival line into this node.
        if (row.topLaneHashes[row.nodeLane] === row.commitHash) {
          addVertical(`nt-${row.commitHash}`, row.nodeLane, topY, cy)
        }

        // Parent edges rendered as orthogonal polylines: down, across, down.
        for (const edge of row.parentEdges) {
          const colorLane = edge.lane === row.nodeLane ? edge.lane : Math.max(edge.lane, row.nodeLane)
          if (edge.lane === row.nodeLane) {
            addVertical(`e-${row.commitHash}-${edge.parentHash}`, row.nodeLane, cy, bottomY, colorLane)
            continue
          }
          const y = Math.min(bottomY - 3, Math.max(cy + 3, cy + horizontalYInset + Math.abs(edge.lane - row.nodeLane) * 2))
          addVertical(`e1-${row.commitHash}-${edge.parentHash}`, row.nodeLane, cy, y, colorLane)
          addHorizontal(`eh-${row.commitHash}-${edge.parentHash}`, row.nodeLane, edge.lane, y, colorLane)
          addVertical(`e2-${row.commitHash}-${edge.parentHash}`, edge.lane, y, bottomY, colorLane)
        }

        const isHead = absoluteIndex === 0
        elements.push(
          <div
            key={`dot-${row.commitHash}`}
            className={cn(
              'absolute rounded-full',
              isHead ? 'bg-background border-2' : getLaneColors(row.nodeLane).bg,
              isHead && getLaneColors(row.nodeLane).border,
            )}
            style={{
              left: laneX(row.nodeLane) - (isHead ? 8 : 5),
              top: cy - (isHead ? 8 : 5),
              width: isHead ? 16 : 10,
              height: isHead ? 16 : 10,
            }}
          />
        )
        if (isHead) {
          elements.push(
            <div
              key={`dot-inner-${row.commitHash}`}
              className={cn('absolute rounded-full', getLaneColors(row.nodeLane).bg)}
              style={{ left: laneX(row.nodeLane) - 3, top: cy - 3, width: 6, height: 6 }}
            />
          )
        }

        return elements
      })}
    </div>
  )
}

export function GitHistoryGraphCanvas({
  layout,
  rowMeasurements,
  estimatedRowHeight,
  className,
}: {
  layout: GitGraphLayout
  rowMeasurements: Array<GitHistoryRowMeasurement | null>
  estimatedRowHeight: number
  className?: string
}) {
  const metrics = getGitHistoryGraphMetrics(layout.laneCount)
  const measuredBottom = rowMeasurements.reduce((max, measurement, index) => Math.max(max, measurement?.bottom ?? ((index + 1) * estimatedRowHeight)), estimatedRowHeight)
  const totalHeight = Math.max(estimatedRowHeight, measuredBottom)
  const laneX = (laneIndex: number) => metrics.sidePadding + laneIndex * metrics.laneSpacing
  const fallbackCenterY = (absoluteRowIndex: number) => absoluteRowIndex * estimatedRowHeight + estimatedRowHeight / 2
  const getRowGeometry = (absoluteRowIndex: number) => {
    const measurement = rowMeasurements[absoluteRowIndex]
    const previousMeasurement = rowMeasurements[absoluteRowIndex - 1]
    const nextMeasurement = rowMeasurements[absoluteRowIndex + 1]
    const cy = measurement?.center ?? fallbackCenterY(absoluteRowIndex)
    return {
      cy,
      topY: measurement
        ? previousMeasurement ? (previousMeasurement.center + measurement.center) / 2 : measurement.top
        : cy - estimatedRowHeight / 2,
      bottomY: measurement
        ? nextMeasurement ? (measurement.center + nextMeasurement.center) / 2 : measurement.bottom
        : cy + estimatedRowHeight / 2,
    }
  }

  return (
    <div className={cn('pointer-events-none absolute left-0 top-0', className)} style={{ width: metrics.width, height: totalHeight }} aria-hidden="true">
      <svg className="absolute left-0 top-0 overflow-visible" width={metrics.width} height={totalHeight} viewBox={`0 0 ${metrics.width} ${totalHeight}`}>
        {layout.rows.flatMap((row, absoluteIndex) => {
          const { cy, topY, bottomY } = getRowGeometry(absoluteIndex)
          const elements: React.ReactNode[] = []

          // ---- 1. Pass-through vertical lines (other lanes) ----
          const laneUnion = Array.from(new Set([...row.topLanes, ...row.bottomLanes]))
          for (const laneIndex of laneUnion) {
            if (laneIndex === row.nodeLane) continue
            const topHash = row.topLaneHashes[laneIndex]
            const bottomHash = row.bottomLaneHashes[laneIndex]
            if (!topHash || !bottomHash) continue
            if (topHash !== bottomHash) continue
            const colors = getLaneColors(laneIndex)
            elements.push(
              <line
                key={`v-${row.commitHash}-${laneIndex}`}
                x1={laneX(laneIndex)} y1={topY}
                x2={laneX(laneIndex)} y2={bottomY}
                className={cn('stroke-[2.2]', colors.stroke)}
                strokeLinecap="round"
              />
            )
          }

          // ---- 2. Node’s top connector (arrival from above) ----
          {
            const topHash = row.topLaneHashes[row.nodeLane]
            if (topHash === row.commitHash) {
              const colors = getLaneColors(row.nodeLane)
              elements.push(
                <line
                  key={`nt-${row.commitHash}`}
                  x1={laneX(row.nodeLane)} y1={topY}
                  x2={laneX(row.nodeLane)} y2={cy}
                  className={cn('stroke-[2.2]', colors.stroke)}
                  strokeLinecap="round"
                />
              )
            }
          }

          // ---- 3. Parent-edge segments (from node center downward) ----
          for (const edge of row.parentEdges) {
            const branchLane = edge.lane === row.nodeLane
              ? edge.lane
              : Math.max(edge.lane, row.nodeLane)
            const colors = getLaneColors(branchLane)

            if (edge.lane === row.nodeLane) {
              // Same-lane: straight from center to bottom
              elements.push(
                <line
                  key={`e-${row.commitHash}-${edge.parentHash}`}
                  x1={laneX(row.nodeLane)} y1={cy}
                  x2={laneX(edge.lane)}    y2={bottomY}
                  className={cn('stroke-[2.2]', colors.stroke)}
                  strokeLinecap="round"
                />
              )
            } else {
              // Cross-lane: bezier from center to bottom on target lane
              const path = buildEdgePath(
                laneX(row.nodeLane), cy,
                laneX(edge.lane),    bottomY,
              )
              elements.push(
                <path
                  key={`e-${row.commitHash}-${edge.parentHash}`}
                  d={path}
                  className={cn('fill-none stroke-[2.2]', colors.stroke)}
                  strokeLinecap="round"
                />
              )
            }
          }

          // ---- 4. Node dot ----
          if (absoluteIndex === 0) {
            elements.push(
              <circle key={`nr-${row.commitHash}`} cx={laneX(row.nodeLane)} cy={cy} r={8}
                className={cn('fill-background stroke-[2.2]', getLaneColors(row.nodeLane).ring)} />,
              <circle key={`nd-${row.commitHash}`} cx={laneX(row.nodeLane)} cy={cy} r={3}
                className={cn(getLaneColors(row.nodeLane).nodeFill)} />
            )
          } else {
            elements.push(
              <circle key={`nd-${row.commitHash}`} cx={laneX(row.nodeLane)} cy={cy} r={5}
                className={cn(getLaneColors(row.nodeLane).nodeFill)} />
            )
          }

          return elements
        })}
      </svg>
    </div>
  )
}
