/**
 * Hook for persisting TurnCard expanded/collapsed state across session switches.
 *
 * Stores expansion state in a single localStorage key as a bounded LRU map
 * (max 100 sessions). Only expanded IDs are stored since collapsed is the default.
 *
 * Shape: { [sessionId]: { turns: string[], groups: string[], lastAccessed: number } }
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import * as storage from '@/lib/local-storage'

const MAX_SESSIONS = 100

/** Entry for a single session's expansion state */
interface ExpansionEntry {
  turns: string[]
  groups: string[]
  lastAccessed: number
}

/** Full map stored in localStorage */
type ExpansionMap = Record<string, ExpansionEntry>

function emitStreamingDebugLog(label: string, payload: Record<string, unknown>): void {
  if ((window as Window & { process?: { env?: Record<string, string | undefined> } }).process?.env?.CRAFT_DEBUG_STREAMING_STEPS !== '1') return
  if (typeof window === 'undefined' || !window.electronAPI?.debugLog) return

  const safePayload = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>
  void Promise.resolve(window.electronAPI.debugLog(label, safePayload)).catch(() => {})
}

/**
 * Read the full expansion map from localStorage.
 * Returns empty object on parse failure.
 */
function readMap(): ExpansionMap {
  return storage.get<ExpansionMap>(storage.KEYS.turnCardExpansion, {})
}

/**
 * Write the expansion map to localStorage, pruning to MAX_SESSIONS
 * by dropping the oldest entries (lowest lastAccessed).
 */
function writeMap(map: ExpansionMap): void {
  const entries = Object.entries(map)
  if (entries.length > MAX_SESSIONS) {
    // Sort by lastAccessed ascending, keep only the most recent MAX_SESSIONS
    entries.sort((a, b) => a[1].lastAccessed - b[1].lastAccessed)
    const pruned: ExpansionMap = {}
    const keep = entries.slice(entries.length - MAX_SESSIONS)
    for (const [key, value] of keep) {
      pruned[key] = value
    }
    storage.set(storage.KEYS.turnCardExpansion, pruned)
  } else {
    storage.set(storage.KEYS.turnCardExpansion, map)
  }
}

/**
 * Persist TurnCard expansion state for the given session.
 * Returns controlled state + callbacks to pass to TurnCard components.
 */
export function useTurnCardExpansion(sessionId: string | undefined, autoExpandedTurnIds: string[] = []) {
  const autoExpandedTurnIdSet = new Set(autoExpandedTurnIds)
  // Initialize state from localStorage for this session
  const [expandedTurns, setExpandedTurns] = useState<Set<string>>(() => {
    if (!sessionId) return new Set()
    const map = readMap()
    const entry = map[sessionId]
    return entry ? new Set(entry.turns) : new Set()
  })

  const [expandedActivityGroups, setExpandedActivityGroups] = useState<Set<string>>(() => {
    if (!sessionId) return new Set()
    const map = readMap()
    const entry = map[sessionId]
    return entry ? new Set(entry.groups) : new Set()
  })

  // Track sessionId so we can save/restore on session switch
  const prevSessionIdRef = useRef(sessionId)
  const manuallyCollapsedTurnsRef = useRef<Set<string>>(new Set())

  // When sessionId changes, save current state and load new session's state
  useEffect(() => {
    if (prevSessionIdRef.current === sessionId) return

    // Load the new session's expansion state from localStorage
    if (sessionId) {
      const map = readMap()
      const entry = map[sessionId]
      const nextTurns = entry ? new Set(entry.turns) : new Set<string>()
      const nextGroups = entry ? new Set(entry.groups) : new Set<string>()
      setExpandedTurns(nextTurns)
      setExpandedActivityGroups(nextGroups)
      manuallyCollapsedTurnsRef.current = new Set()
      emitStreamingDebugLog('[streaming-steps-debug][expansion] load session state', {
        previousSessionId: prevSessionIdRef.current ?? null,
        sessionId,
        expandedTurns: [...nextTurns],
        expandedGroups: [...nextGroups],
      })
    } else {
      setExpandedTurns(new Set())
      setExpandedActivityGroups(new Set())
      manuallyCollapsedTurnsRef.current = new Set()
      emitStreamingDebugLog('[streaming-steps-debug][expansion] clear session state', {
        previousSessionId: prevSessionIdRef.current ?? null,
      })
    }

    prevSessionIdRef.current = sessionId
  }, [sessionId])

  useEffect(() => {
    if (!sessionId || autoExpandedTurnIds.length === 0) return

    const collapsedTurns = manuallyCollapsedTurnsRef.current
    const nextAutoExpanded = autoExpandedTurnIds.filter(turnId => !collapsedTurns.has(turnId))
    if (nextAutoExpanded.length === 0) {
      emitStreamingDebugLog('[streaming-steps-debug][expansion] skip auto expand', {
        sessionId,
        autoExpandedTurnIds,
        collapsedTurns: [...collapsedTurns],
      })
      return
    }

    setExpandedTurns(prev => {
      const missingTurnIds = nextAutoExpanded.filter(turnId => !prev.has(turnId))
      if (missingTurnIds.length === 0) return prev

      const next = new Set(prev)
      for (const turnId of missingTurnIds) {
        next.add(turnId)
      }

      emitStreamingDebugLog('[streaming-steps-debug][expansion] auto expand active turns', {
        sessionId,
        autoExpandedTurnIds,
        appliedTurnIds: missingTurnIds,
        collapsedTurns: [...collapsedTurns],
        before: [...prev],
        after: [...next],
      })

      return next
    })
  }, [autoExpandedTurnIds, sessionId])

  const isTurnExpanded = useCallback((turnId: string) => {
    if (expandedTurns.has(turnId)) return true
    if (manuallyCollapsedTurnsRef.current.has(turnId)) return false
    return autoExpandedTurnIdSet.has(turnId)
  }, [autoExpandedTurnIdSet, expandedTurns])

  // Persist to localStorage whenever expansion state changes.
  // Uses a ref to avoid stale closures and only writes when we have a valid session.
  const expandedTurnsRef = useRef(expandedTurns)
  const expandedGroupsRef = useRef(expandedActivityGroups)
  expandedTurnsRef.current = expandedTurns
  expandedGroupsRef.current = expandedActivityGroups

  useEffect(() => {
    if (!sessionId) return
    const map = readMap()
    const turns = [...expandedTurnsRef.current]
    const groups = [...expandedGroupsRef.current]

    // Only write an entry if there's something expanded; remove entry if empty
    if (turns.length === 0 && groups.length === 0) {
      if (map[sessionId]) {
        delete map[sessionId]
        writeMap(map)
      }
      emitStreamingDebugLog('[streaming-steps-debug][expansion] persist empty', {
        sessionId,
      })
      return
    }

    map[sessionId] = {
      turns,
      groups,
      lastAccessed: Date.now(),
    }
    writeMap(map)
    emitStreamingDebugLog('[streaming-steps-debug][expansion] persist state', {
      sessionId,
      expandedTurns: turns,
      expandedGroups: groups,
    })
  }, [sessionId, expandedTurns, expandedActivityGroups])

  // Toggle a single turn's expansion state
  const toggleTurn = useCallback((turnId: string, expanded: boolean) => {
    setExpandedTurns(prev => {
      const next = new Set(prev)
      if (expanded) {
        next.add(turnId)
        manuallyCollapsedTurnsRef.current.delete(turnId)
      } else {
        next.delete(turnId)
        manuallyCollapsedTurnsRef.current.add(turnId)
      }
      emitStreamingDebugLog('[streaming-steps-debug][expansion] toggle turn', {
        sessionId: sessionId ?? null,
        turnId,
        expanded,
        before: [...prev],
        after: [...next],
        manuallyCollapsedTurns: [...manuallyCollapsedTurnsRef.current],
      })
      return next
    })
  }, [sessionId])

  return {
    expandedTurns,
    isTurnExpanded,
    toggleTurn,
    expandedActivityGroups,
    setExpandedActivityGroups,
  }
}
