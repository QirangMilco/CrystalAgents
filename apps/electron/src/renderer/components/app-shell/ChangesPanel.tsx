import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { MultiDiffPreviewOverlay, Tooltip, TooltipContent, TooltipTrigger, type DiffViewerSettings, type FileChange } from '@craft-agent/ui'
import type { ChangedFileItem, GitActionResult, GitStatusResult } from '../../../shared/types'
import { HeaderIconButton } from '@/components/ui/HeaderIconButton'
import { Codicon } from '@/components/ui/Codicon'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { useTheme } from '@/context/ThemeContext'
import { Button } from '@/components/ui/button'
import { getPathBasename, joinPlatformPath, PATH_SEP } from '@/lib/platform'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { routes } from '@/lib/navigate'
import { useNavigation } from '@/contexts/NavigationContext'
import { useAppShellContext } from '@/context/AppShellContext'
import { ChangesCommitComposer } from './ChangesCommitComposer'
import { buildGitGraphRows, GitHistoryGraphRow, GitRefBadges } from './git-history-ui'
import { ChangesConflictOverlay } from './ChangesConflictOverlay'
import type { GitRecentCommitItem } from '../../../shared/types'

interface ChangesPanelProps {
  workspaceRootPath?: string
  selectedFilePath?: string | null
  focusModeOverlay?: boolean
  onSelectFile?: (filePath: string) => void
  onStatusChange?: (status: GitStatusResult | null) => void
}

type DiffOverlayState = {
  changes: FileChange[]
  focusedChangeId: string
} | null

type ConflictOverlayState = {
  relativePath: string
  absolutePath: string
} | null

type PendingDiscardAction =
  | { type: 'file'; file: ChangedFileItem }
  | { type: 'all' }
  | null

const statusClassName: Record<ChangedFileItem['status'], string> = {
  modified: 'text-amber-500',
  added: 'text-emerald-500',
  deleted: 'text-red-500',
  renamed: 'text-blue-500',
  untracked: 'text-emerald-500',
  conflict: 'text-red-600',
}

function getStatusCode(status: ChangedFileItem['status']): string {
  switch (status) {
    case 'added': return 'A'
    case 'deleted': return 'D'
    case 'renamed': return 'R'
    case 'untracked': return 'U'
    case 'conflict': return '!'
    case 'modified':
    default:
      return 'M'
  }
}

function getFailureMessage(t: ReturnType<typeof useTranslation>['t'], result: Extract<GitStatusResult, { ok: false }>): string {
  switch (result.reason) {
    case 'not_repo': return t('changes.currentFolderNotGitRepo')
    case 'git_unavailable': return t('changes.gitUnavailable')
    case 'unknown_error':
    default:
      return t('changes.unknownError')
  }
}

function splitFilePath(filePath: string): { filename: string; directory: string } {
  const normalized = filePath.replaceAll('\\', PATH_SEP)
  const parts = normalized.split(PATH_SEP).filter(Boolean)
  const filename = getPathBasename(normalized) || filePath
  const directory = parts.length > 1 ? parts.slice(0, -1).join(PATH_SEP) : ''
  return { filename, directory }
}

function sortChangedFiles(files: ChangedFileItem[]): ChangedFileItem[] {
  return [...files].sort((a, b) => {
    const aParts = splitFilePath(a.path)
    const bParts = splitFilePath(b.path)
    return aParts.filename.localeCompare(bParts.filename, undefined, { sensitivity: 'base' })
      || aParts.directory.localeCompare(bParts.directory, undefined, { sensitivity: 'base' })
      || a.path.localeCompare(b.path, undefined, { sensitivity: 'base' })
  })
}

export function ChangesPanel({
  workspaceRootPath,
  selectedFilePath,
  focusModeOverlay = false,
  onSelectFile,
  onStatusChange,
}: ChangesPanelProps) {
  const { t } = useTranslation()
  const { resolvedMode } = useTheme()
  const { navigate } = useNavigation()
  const { activeWorkspaceId, llmConnections, workspaceDefaultLlmConnection } = useAppShellContext()
  const [statusResult, setStatusResult] = useState<GitStatusResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [actionBusyKey, setActionBusyKey] = useState<string | null>(null)
  const [overlayState, setOverlayState] = useState<DiffOverlayState>(null)
  const [conflictOverlayState, setConflictOverlayState] = useState<ConflictOverlayState>(null)
  const [diffViewerSettings, setDiffViewerSettings] = useState<Partial<DiffViewerSettings>>({})
  const [commitMessage, setCommitMessage] = useState('')
  const [pendingDiscardAction, setPendingDiscardAction] = useState<PendingDiscardAction>(null)
  const [historyItems, setHistoryItems] = useState<GitRecentCommitItem[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyLimit, setHistoryLimit] = useState(40)
  const refreshInFlightRef = React.useRef(false)
  const panelRef = React.useRef<HTMLDivElement | null>(null)
  const historyViewportRef = React.useRef<HTMLDivElement | null>(null)
  const statusSignatureRef = React.useRef<string | null>(null)
  const historySignatureRef = React.useRef<string | null>(null)

  const loadStatus = React.useCallback(async (options?: { silent?: boolean; forceNotify?: boolean }) => {
    if (!workspaceRootPath) {
      const result = { ok: false, reason: 'not_repo' } as GitStatusResult
      const signature = JSON.stringify(result)
      const changed = statusSignatureRef.current !== signature
      statusSignatureRef.current = signature
      setStatusResult((prev) => (changed ? result : prev))
      if (changed || options?.forceNotify) {
        onStatusChange?.(result)
      }
      return result
    }

    if (!options?.silent) setLoading(true)
    try {
      const result = await window.electronAPI.getGitStatus(workspaceRootPath)
      const signature = JSON.stringify(result)
      const changed = statusSignatureRef.current !== signature
      statusSignatureRef.current = signature
      setStatusResult((prev) => (changed ? result : prev))
      if (changed || options?.forceNotify) {
        onStatusChange?.(result)
      }
      return result
    } finally {
      if (!options?.silent) setLoading(false)
    }
  }, [onStatusChange, workspaceRootPath])

  const loadHistory = React.useCallback(async (options?: { silent?: boolean }) => {
    if (!workspaceRootPath) {
      setHistoryItems((prev) => (prev.length === 0 ? prev : []))
      return null
    }

    if (!options?.silent) setHistoryLoading(true)
    try {
      const result = await window.electronAPI.getGitRecentCommits(workspaceRootPath, historyLimit)
      if (!result.ok) {
        historySignatureRef.current = '[]'
        setHistoryItems((prev) => (prev.length === 0 ? prev : []))
        return result
      }
      const signature = JSON.stringify(result.commits.map(commit => [commit.hash, commit.subject, commit.refNames.join(','), commit.parentHashes.join(',')]))
      const changed = historySignatureRef.current !== signature
      historySignatureRef.current = signature
      setHistoryItems((prev) => (changed ? result.commits : prev))
      return result
    } finally {
      if (!options?.silent) setHistoryLoading(false)
    }
  }, [historyLimit, workspaceRootPath])

  useEffect(() => {
    setHistoryLimit(40)
  }, [workspaceRootPath])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  useEffect(() => {
    if (!workspaceRootPath) return

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const refreshIfVisible = async () => {
      if (cancelled || document.hidden || actionBusyKey || refreshInFlightRef.current) return
      if (!panelRef.current || !panelRef.current.offsetParent) return
      refreshInFlightRef.current = true
      try {
        await Promise.all([loadStatus({ silent: true }), loadHistory({ silent: true })])
      } finally {
        refreshInFlightRef.current = false
      }
    }

    const scheduleNext = () => {
      if (cancelled) return
      timer = setTimeout(async () => {
        await refreshIfVisible()
        scheduleNext()
      }, 5000)
    }

    const handleVisibility = () => {
      if (!document.hidden) {
        void refreshIfVisible()
      }
    }

    scheduleNext()
    window.addEventListener('focus', handleVisibility)
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      window.removeEventListener('focus', handleVisibility)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [actionBusyKey, loadHistory, loadStatus, workspaceRootPath])

  useEffect(() => {
    window.electronAPI.readPreferences().then(({ content }) => {
      try {
        const prefs = JSON.parse(content)
        if (prefs.diffViewer) setDiffViewerSettings(prefs.diffViewer)
      } catch {
        // Ignore malformed preferences; the diff viewer can use defaults.
      }
    })
  }, [])

  const handleDiffViewerSettingsChange = React.useCallback((settings: DiffViewerSettings) => {
    setDiffViewerSettings(settings)
    window.electronAPI.readPreferences().then(({ content }) => {
      try {
        const prefs = JSON.parse(content)
        prefs.diffViewer = settings
        prefs.updatedAt = Date.now()
        window.electronAPI.writePreferences(JSON.stringify(prefs, null, 2))
      } catch {
        window.electronAPI.writePreferences(JSON.stringify({ diffViewer: settings, updatedAt: Date.now() }, null, 2))
      }
    })
  }, [])

  const files = statusResult?.ok ? statusResult.files : []
  const summary = statusResult?.ok ? statusResult.summary : null

  const totalFiles = files.length
  const repoName = useMemo(() => workspaceRootPath ? getPathBasename(workspaceRootPath) || workspaceRootPath : '', [workspaceRootPath])
  const unstagedFilesCount = useMemo(() => files.filter(file => file.unstaged).length, [files])
  const conflictFiles = useMemo(() => sortChangedFiles(files.filter(file => file.status === 'conflict')), [files])
  const stagedFiles = useMemo(() => sortChangedFiles(files.filter(file => file.staged && file.status !== 'conflict')), [files])
  const unstagedFiles = useMemo(() => sortChangedFiles(files.filter(file => file.unstaged && file.status !== 'conflict')), [files])
  const groupedFiles = useMemo(() => ([
    { key: 'conflicts', label: t('changes.conflictsLabel'), files: conflictFiles },
    { key: 'staged', label: t('changes.stagedLabel'), files: stagedFiles },
    { key: 'unstaged', label: t('changes.unstagedLabel'), files: unstagedFiles },
  ].filter(group => group.files.length > 0)), [conflictFiles, stagedFiles, t, unstagedFiles])
  const hasUnstagedFiles = unstagedFilesCount > 0
  const hasStagedFiles = (summary?.staged ?? 0) > 0
  const hasConflicts = (summary?.conflicts ?? 0) > 0
  const canFetch = !!workspaceRootPath && !actionBusyKey
  const canPull = (summary?.behind ?? 0) > 0
  const canPush = (summary?.ahead ?? 0) > 0
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})

  const getActionSuccessMessage = React.useCallback((busyKey: string) => {
    if (busyKey === 'stage-all') return t('changes.stageAllSuccess')
    if (busyKey === 'unstage-all') return t('changes.unstageAllSuccess')
    if (busyKey === 'discard-all') return t('changes.discardAllSuccess')
    if (busyKey === 'commit') return t('changes.commitSuccess')
    if (busyKey === 'fetch') return t('changes.fetchSuccess')
    if (busyKey === 'pull') return t('changes.pullSuccess')
    if (busyKey === 'push') return t('changes.pushSuccess')
    if (busyKey.startsWith('stage:')) return t('changes.stageFileSuccess')
    if (busyKey.startsWith('unstage:')) return t('changes.unstageFileSuccess')
    if (busyKey.startsWith('discard:')) return t('changes.discardFileSuccess')
    return t('sidebar.changes')
  }, [t])

  const runGitAction = React.useCallback(async (
    busyKey: string,
    action: () => Promise<GitActionResult>,
  ) => {
    setActionBusyKey(busyKey)
    try {
      const result = await action()
      if (!result.ok) {
        toast.error(t('changes.actionFailed'), {
          description: result.message || t('changes.unknownError'),
        })
        return result
      }

      toast.success(getActionSuccessMessage(busyKey), {
        description: result.message || undefined,
      })
      await Promise.all([loadStatus({ silent: true }), loadHistory({ silent: true })])
      return result
    } catch (error) {
      toast.error(t('changes.actionFailed'), {
        description: error instanceof Error ? error.message : t('changes.unknownError'),
      })
      return { ok: false, reason: 'unknown_error' as const }
    } finally {
      setActionBusyKey(null)
    }
  }, [getActionSuccessMessage, loadHistory, loadStatus, t])

  const handleOpenOverlayDiff = React.useCallback(async (file: ChangedFileItem) => {
    if (!workspaceRootPath) return

    if (file.status === 'conflict') {
      setConflictOverlayState({
        relativePath: file.path,
        absolutePath: joinPlatformPath(workspaceRootPath, file.path),
      })
      return
    }

    const result = await window.electronAPI.getGitFileDiff(workspaceRootPath, file.path)
    if (!result.ok) return

    const changeId = `git-${file.path}`
    setOverlayState({
      focusedChangeId: changeId,
      changes: [{
        id: changeId,
        filePath: file.path,
        toolType: file.status === 'added' || file.status === 'untracked' ? 'Write' : 'Edit',
        original: '',
        modified: '',
        unifiedDiff: result.diff,
      }],
    })
  }, [workspaceRootPath])

  const handleSelectFile = React.useCallback(async (file: ChangedFileItem) => {
    if (focusModeOverlay) {
      await handleOpenOverlayDiff(file)
      return
    }

    onSelectFile?.(file.path)
    navigate(routes.view.changes(file.path))
  }, [focusModeOverlay, handleOpenOverlayDiff, navigate, onSelectFile])

  const handleSelectHistoryCommit = React.useCallback(async (commit: GitRecentCommitItem) => {
    if (focusModeOverlay) {
      if (!workspaceRootPath) return
      const result = await window.electronAPI.getGitCommitDiff(workspaceRootPath, commit.hash)
      if (!result.ok) return

      const changeId = `git-commit-${commit.hash}`
      setOverlayState({
        focusedChangeId: changeId,
        changes: [{
          id: changeId,
          filePath: `${commit.shortHash} · ${commit.subject}`,
          toolType: 'Edit',
          original: '',
          modified: '',
          unifiedDiff: result.diff,
        }],
      })
      return
    }

    navigate(routes.view.changesHistory(commit.hash))
  }, [focusModeOverlay, navigate, workspaceRootPath])

  const historySelected = selectedFilePath?.startsWith('__history__:') ?? false
  const selectedHistoryCommitHash = selectedFilePath?.startsWith('__history__:') ? selectedFilePath.slice(12) : null

  const handleCommit = React.useCallback(async () => {
    if (!workspaceRootPath || !commitMessage.trim()) return
    const result = await runGitAction('commit', () => window.electronAPI.commitGitChanges(workspaceRootPath, { message: commitMessage.trim() }))
    if (result.ok) {
      setCommitMessage('')
    }
  }, [commitMessage, runGitAction, workspaceRootPath])

  const confirmDiscard = React.useCallback(async () => {
    if (!workspaceRootPath || !pendingDiscardAction) return
    if (pendingDiscardAction.type === 'all') {
      const result = await runGitAction('discard-all', () => window.electronAPI.discardAllGitFiles(workspaceRootPath))
      if (result.ok) setPendingDiscardAction(null)
      return
    }

    const result = await runGitAction(`discard:${pendingDiscardAction.file.path}`, () => window.electronAPI.discardGitFile(workspaceRootPath, pendingDiscardAction.file.path))
    if (result.ok) setPendingDiscardAction(null)
  }, [pendingDiscardAction, runGitAction, workspaceRootPath])

  useEffect(() => {
    if (focusModeOverlay) return
    if (!selectedFilePath) return
    if (!statusResult?.ok) return

    if (selectedFilePath.startsWith('__history__:')) {
      const commitHash = selectedFilePath.slice(12)
      if (!commitHash || historyItems.some(commit => commit.hash === commitHash)) return
      if (historyItems[0]?.hash) {
        navigate(routes.view.changesHistory(historyItems[0].hash))
      }
      return
    }

    if (files.some(file => file.path === selectedFilePath)) return
    if (files[0]?.path) {
      navigate(routes.view.changes(files[0].path))
    }
  }, [files, focusModeOverlay, historyItems, navigate, selectedFilePath, statusResult])

  const toggleGroup = React.useCallback((groupKey: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [groupKey]: !prev[groupKey] }))
  }, [])

  const changesSectionCollapsed = !!collapsedGroups.changes
  const historySectionCollapsed = !!collapsedGroups.history
  const historyGraphLayout = useMemo(() => buildGitGraphRows(historyItems), [historyItems])

  React.useEffect(() => {
    const viewport = historyViewportRef.current
    if (!viewport) return

    const maybeLoadMore = () => {
      const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
      if (distanceToBottom < 220) {
        setHistoryLimit((prev) => Math.min(prev + 40, 240))
      }
    }

    viewport.addEventListener('scroll', maybeLoadMore, { passive: true })
    return () => viewport.removeEventListener('scroll', maybeLoadMore)
  }, [])

  return (
    <div ref={panelRef} className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border/40 px-3 py-3">
        {summary ? (
          <>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-foreground">
                  {repoName || summary.branch}
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  {repoName && (
                    <>
                      <span className="truncate">{summary.branch}</span>
                      <span aria-hidden="true">·</span>
                    </>
                  )}
                  <span>{t('changes.filesChangedCount', { count: totalFiles })}</span>
                </div>
              </div>
              <HeaderIconButton
                icon={loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Codicon name="refresh" className="text-[14px] leading-none" />}
                tooltip={t('changes.refresh')}
                aria-label={t('changes.refresh')}
                disabled={loading}
                onClick={() => void loadStatus()}
              />
            </div>
            <div className="mt-3">
              <ChangesCommitComposer
                workspaceId={activeWorkspaceId}
                workspaceRootPath={workspaceRootPath}
                llmConnections={llmConnections}
                workspaceDefaultConnection={workspaceDefaultLlmConnection}
                disabled={!workspaceRootPath || !hasStagedFiles}
                hasStagedFiles={hasStagedFiles}
                actionBusyKey={actionBusyKey}
                value={commitMessage}
                onChange={setCommitMessage}
                onCommit={() => void handleCommit()}
              />
            </div>
          </>
        ) : (
          <div className="text-xs text-muted-foreground">{t('sidebar.changes')}</div>
        )}
      </div>

      {!statusResult || loading ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : !statusResult.ok ? (
        <ChangesEmptyState message={getFailureMessage(t, statusResult)} />
      ) : files.length === 0 && historyItems.length === 0 ? (
        <ChangesEmptyState message={t('changes.noChanges')} />
      ) : (
        <ScrollArea className="min-h-0 flex-1" viewportRef={historyViewportRef}>
          <div className="py-1">
            <div className="pb-2">
                <div
                  role="button"
                  tabIndex={0}
                  className="mx-2 flex cursor-pointer items-center justify-between gap-2 rounded-md px-2 pt-2 pb-1 hover:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  onClick={() => toggleGroup('changes')}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      toggleGroup('changes')
                    }
                  }}
                >
                  <div className="flex min-w-0 items-center gap-1.5 px-1 py-0.5 text-left">
                    {changesSectionCollapsed
                      ? <Codicon name="chevron-right" className="text-[14px] leading-none" />
                      : <Codicon name="chevron-down" className="text-[14px] leading-none" />}
                    <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
                      {t('changes.changesSectionLabel')}
                    </span>
                  </div>
                  <span />
                </div>
                {!changesSectionCollapsed && groupedFiles.map(group => {
                  const isCollapsed = !!collapsedGroups[group.key]
                  return (
                    <div key={group.key} className="pb-2 pl-3">
                      <div
                        role="button"
                        tabIndex={0}
                        className="mx-2 flex cursor-pointer items-center justify-between gap-2 rounded-md px-2 pt-2 pb-1 hover:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        onClick={() => toggleGroup(group.key)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            toggleGroup(group.key)
                          }
                        }}
                      >
                        <div className="flex min-w-0 items-center gap-1.5 px-1 py-0.5 text-left">
                          {isCollapsed
                            ? <Codicon name="chevron-right" className="text-[14px] leading-none" />
                            : <Codicon name="chevron-down" className="text-[14px] leading-none" />}
                          <span className={cn(
                            'text-[11px] font-medium uppercase tracking-wider',
                            group.key === 'conflicts' ? 'text-red-600/80' : 'text-muted-foreground/70'
                          )}>
                            {group.label}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                          {group.key === 'conflicts' && (
                            <>
                              <HeaderIconButton
                                icon={<Codicon name="discard" className="text-[14px] leading-none" />}
                                tooltip={t('changes.discardAll')}
                                aria-label={t('changes.discardAll')}
                                disabled={!workspaceRootPath || !!actionBusyKey || !hasConflicts}
                                onClick={() => setPendingDiscardAction({ type: 'all' })}
                              />
                              <HeaderIconButton
                                icon={<Codicon name="add" className="text-[14px] leading-none" />}
                                tooltip={t('changes.stageAll')}
                                aria-label={t('changes.stageAll')}
                                disabled={!workspaceRootPath || !!actionBusyKey || !hasConflicts}
                                onClick={() => workspaceRootPath && void runGitAction('stage-all', () => window.electronAPI.stageAllGitFiles(workspaceRootPath))}
                              />
                            </>
                          )}
                          {group.key === 'staged' && (
                            <HeaderIconButton
                              icon={<Codicon name="remove" className="text-[14px] leading-none" />}
                              tooltip={t('changes.unstageAll')}
                              aria-label={t('changes.unstageAll')}
                              disabled={!workspaceRootPath || !!actionBusyKey || !hasStagedFiles}
                              onClick={() => workspaceRootPath && void runGitAction('unstage-all', () => window.electronAPI.unstageAllGitFiles(workspaceRootPath))}
                            />
                          )}
                          {group.key === 'unstaged' && (
                            <>
                              <HeaderIconButton
                                icon={<Codicon name="discard" className="text-[14px] leading-none" />}
                                tooltip={t('changes.discardAll')}
                                aria-label={t('changes.discardAll')}
                                disabled={!workspaceRootPath || !!actionBusyKey || !hasUnstagedFiles}
                                onClick={() => setPendingDiscardAction({ type: 'all' })}
                              />
                              <HeaderIconButton
                                icon={<Codicon name="add" className="text-[14px] leading-none" />}
                                tooltip={t('changes.stageAll')}
                                aria-label={t('changes.stageAll')}
                                disabled={!workspaceRootPath || !!actionBusyKey || !hasUnstagedFiles}
                                onClick={() => workspaceRootPath && void runGitAction('stage-all', () => window.electronAPI.stageAllGitFiles(workspaceRootPath))}
                              />
                            </>
                          )}
                          <span className={cn(
                            'inline-flex min-w-7 items-center justify-center rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums shadow-minimal',
                            group.key === 'conflicts'
                              ? 'bg-red-500/12 text-red-600'
                              : 'bg-foreground/[0.08] text-foreground/90'
                          )}>
                            {group.files.length}
                          </span>
                        </div>
                      </div>
                      {!isCollapsed && group.files.map(file => {
                        const { filename, directory } = splitFilePath(file.path)
                        const isSelected = selectedFilePath === file.path
                        return (
                          <div
                            key={`${group.key}:${file.rawStatus ?? ''}:${file.path}`}
                            className={cn(
                              'group mx-2 ml-4 flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors',
                              isSelected && 'bg-foreground/8',
                              !isSelected && 'hover:bg-foreground/[0.04]'
                            )}
                          >
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  className={cn(
                                    'flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                                    isSelected ? 'text-foreground' : 'text-foreground/95'
                                  )}
                                  onClick={() => void handleSelectFile(file)}
                                >
                                  <span className={cn('w-4 shrink-0 text-center text-xs font-medium', statusClassName[file.status])}>
                                    {getStatusCode(file.status)}
                                  </span>
                                  <span className="min-w-0 flex-1 overflow-hidden">
                                    <span className="grid min-w-0 grid-cols-[minmax(0,max-content)_minmax(0,1fr)] items-baseline gap-2 overflow-hidden">
                                      <span className="min-w-0 truncate text-sm font-medium text-foreground">{filename}</span>
                                      {directory ? (
                                        <span className="min-w-0 truncate text-[11px] text-muted-foreground">{directory}</span>
                                      ) : (
                                        <span />
                                      )}
                                    </span>
                                  </span>
                                </button>
                              </TooltipTrigger>
                              <TooltipContent className="max-w-md break-all text-xs">{file.path}</TooltipContent>
                            </Tooltip>
                            <div className="flex shrink-0 items-center gap-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
                              {group.key === 'staged' ? (
                                <HeaderIconButton
                                  icon={<Codicon name="remove" className="text-[14px] leading-none" />}
                                  tooltip={t('changes.unstageFile')}
                                  aria-label={t('changes.unstageFile')}
                                  disabled={!workspaceRootPath || !!actionBusyKey || !file.staged}
                                  onClick={() => workspaceRootPath && void runGitAction(`unstage:${file.path}`, () => window.electronAPI.unstageGitFile(workspaceRootPath, file.path))}
                                />
                              ) : (
                                <>
                                  <HeaderIconButton
                                    icon={<Codicon name="discard" className="text-[14px] leading-none" />}
                                    tooltip={t('changes.discardFile')}
                                    aria-label={t('changes.discardFile')}
                                    disabled={!workspaceRootPath || !!actionBusyKey || !file.unstaged}
                                    onClick={() => setPendingDiscardAction({ type: 'file', file })}
                                  />
                                  <HeaderIconButton
                                    icon={<Codicon name="add" className="text-[14px] leading-none" />}
                                    tooltip={t('changes.stageFile')}
                                    aria-label={t('changes.stageFile')}
                                    disabled={!workspaceRootPath || !!actionBusyKey || !file.unstaged}
                                    onClick={() => workspaceRootPath && void runGitAction(`stage:${file.path}`, () => window.electronAPI.stageGitFile(workspaceRootPath, file.path))}
                                  />
                                </>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )
                })}
              </div>

            <div className="pb-2">
                <div
                  role="button"
                  tabIndex={0}
                  className="mx-2 flex cursor-pointer items-center justify-between gap-2 rounded-md px-2 pt-2 pb-1 hover:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  onClick={() => toggleGroup('history')}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      toggleGroup('history')
                    }
                  }}
                >
                  <div className="flex min-w-0 items-center gap-1.5 px-1 py-0.5 text-left">
                    {historySectionCollapsed
                      ? <Codicon name="chevron-right" className="text-[14px] leading-none" />
                      : <Codicon name="chevron-down" className="text-[14px] leading-none" />}
                    <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
                      {t('changes.historyLabel')}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                    <HeaderIconButton
                      icon={<Codicon name="repo-push" className="text-[14px] leading-none" />}
                      tooltip={t('changes.push')}
                      aria-label={t('changes.push')}
                      disabled={!workspaceRootPath || !!actionBusyKey || !canPush}
                      onClick={() => workspaceRootPath && void runGitAction('push', () => window.electronAPI.pushGitChanges(workspaceRootPath))}
                    />
                    <HeaderIconButton
                      icon={<Codicon name="repo-fetch" className="text-[14px] leading-none" />}
                      tooltip={t('changes.fetch')}
                      aria-label={t('changes.fetch')}
                      disabled={!canFetch}
                      onClick={() => workspaceRootPath && void runGitAction('fetch', () => window.electronAPI.fetchGitChanges(workspaceRootPath))}
                    />
                    <HeaderIconButton
                      icon={<Codicon name="repo-pull" className="text-[14px] leading-none" />}
                      tooltip={t('changes.pull')}
                      aria-label={t('changes.pull')}
                      disabled={!workspaceRootPath || !!actionBusyKey || !canPull}
                      onClick={() => workspaceRootPath && void runGitAction('pull', () => window.electronAPI.pullGitChanges(workspaceRootPath))}
                    />
                  </div>
                </div>
                {!historySectionCollapsed && (
                  historyLoading ? (
                    <div className="px-4 py-3 text-xs text-muted-foreground">{t('changes.loadingRecentCommits')}</div>
                  ) : historyItems.length === 0 ? (
                    <div className="px-4 py-3 text-xs text-muted-foreground">{t('changes.noRecentCommits')}</div>
                  ) : (
                    <div className="relative">
                      {historyItems.map((commit, index) => {
                        const isSelected = historySelected && selectedHistoryCommitHash === commit.hash
                        return (
                          <button
                            key={commit.hash}
                            type="button"
                            className={cn(
                              'relative mx-2 flex w-[calc(100%-1rem)] items-stretch rounded-lg text-left transition-colors',
                              isSelected ? 'bg-foreground/8 text-foreground' : 'text-foreground/90 hover:bg-foreground/[0.04]'
                            )}
                            onClick={() => void handleSelectHistoryCommit(commit)}
                          >
                            <GitHistoryGraphRow layout={historyGraphLayout} row={historyGraphLayout.rows[index]!} rowIndex={index} />
                            <div className="min-w-0 flex-1 px-2 py-1.5 pr-3">
                              <div className="flex min-w-0 items-center gap-2">
                                <div className="min-w-0 flex-1 truncate text-sm font-medium">{commit.subject}</div>
                                <span className="shrink-0 rounded bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-foreground/80">{commit.shortHash}</span>
                              </div>
                              <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                                <span className="truncate">{commit.authorName}</span>
                                <GitRefBadges refNames={commit.refNames} compact className="mt-0" />
                              </div>
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  )
                )}
              </div>
          </div>
        </ScrollArea>
      )}

      <Dialog open={!!pendingDiscardAction} onOpenChange={(open) => { if (!open) setPendingDiscardAction(null) }}>
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {pendingDiscardAction?.type === 'all' ? t('changes.discardAllConfirmTitle') : t('changes.discardFileConfirmTitle')}
            </DialogTitle>
            <DialogDescription>
              {pendingDiscardAction?.type === 'all'
                ? t('changes.discardAllConfirmDescription')
                : t('changes.discardFileConfirmDescription', { path: pendingDiscardAction?.type === 'file' ? pendingDiscardAction.file.path : '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDiscardAction(null)}>{t('common.cancel')}</Button>
            <Button variant="destructive" onClick={() => void confirmDiscard()} disabled={!workspaceRootPath || !!actionBusyKey}>
              {pendingDiscardAction?.type === 'all' ? t('changes.discardAll') : t('changes.discardFile')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {conflictOverlayState && (
        <ChangesConflictOverlay
          open={true}
          filePath={conflictOverlayState.absolutePath}
          loading={loading}
          actionBusy={!!actionBusyKey}
          onClose={() => setConflictOverlayState(null)}
          onRefresh={() => {
            void Promise.all([
              loadStatus({ silent: true, forceNotify: true }),
              loadHistory({ silent: true }),
            ])
          }}
          onStage={() => {
            if (!workspaceRootPath) return
            void runGitAction(`stage:${conflictOverlayState.relativePath}`, () => window.electronAPI.stageGitFile(workspaceRootPath, conflictOverlayState.relativePath)).then((result) => {
              if (!result?.ok) return
              const files = statusResult?.ok ? statusResult.files : []
              const remainingConflicts = files.filter(file => file.status === 'conflict' && file.path !== conflictOverlayState.relativePath)
              if (remainingConflicts[0]?.path) {
                setConflictOverlayState({
                  relativePath: remainingConflicts[0].path,
                  absolutePath: joinPlatformPath(workspaceRootPath, remainingConflicts[0].path),
                })
              } else {
                setConflictOverlayState(null)
              }
            })
          }}
        />
      )}

      {overlayState && (
        <MultiDiffPreviewOverlay
          isOpen={true}
          onClose={() => setOverlayState(null)}
          changes={overlayState.changes}
          consolidated={true}
          focusedChangeId={overlayState.focusedChangeId}
          theme={resolvedMode === 'dark' ? 'dark' : 'light'}
          diffViewerSettings={diffViewerSettings}
          onDiffViewerSettingsChange={handleDiffViewerSettingsChange}
        />
      )}
    </div>
  )
}

function ChangesEmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
      <div className="flex max-w-[220px] flex-col items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-foreground/5">
          <Codicon name="source-control" className="text-[16px] leading-none" />
        </div>
        <p>{message}</p>
      </div>
    </div>
  )
}
