import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import type { GitRecentCommitItem } from '../../../shared/types'
import { Panel } from './Panel'
import { PanelHeader } from './PanelHeader'
import { ChangesHistoryCommitDetail } from './ChangesHistoryCommitDetail'
import { useNavigation } from '@/contexts/NavigationContext'
import { routes } from '@/lib/navigate'
import { cn } from '@/lib/utils'
import { buildGitGraphRows, GitHistoryGraphRow, GitRefBadges } from './git-history-ui'

interface ChangesHistoryPanelProps {
  workspaceRootPath?: string
  selectedCommitHash?: string
}

export function ChangesHistoryPanel({ workspaceRootPath, selectedCommitHash }: ChangesHistoryPanelProps) {
  const { t } = useTranslation()
  const { navigate } = useNavigation()
  const [loading, setLoading] = useState(false)
  const [commits, setCommits] = useState<GitRecentCommitItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [historyLimit, setHistoryLimit] = useState(40)
  const refreshInFlightRef = React.useRef(false)
  const panelRef = React.useRef<HTMLDivElement | null>(null)
  const historyViewportRef = React.useRef<HTMLDivElement | null>(null)
  const commitsSignatureRef = React.useRef<string | null>(null)

  const loadCommits = React.useCallback(async (options?: { silent?: boolean }) => {
    if (!workspaceRootPath) {
      setCommits((prev) => (prev.length === 0 ? prev : []))
      setError(t('changes.currentFolderNotGitRepo'))
      return
    }

    if (!options?.silent) setLoading(true)
    if (!options?.silent) setError(null)
    try {
      const result = await window.electronAPI.getGitRecentCommits(workspaceRootPath, historyLimit)
      if (!result.ok) {
        commitsSignatureRef.current = '[]'
        setError(result.message || t('changes.unknownError'))
        setCommits((prev) => (prev.length === 0 ? prev : []))
        return
      }
      setError(null)
      const signature = JSON.stringify(result.commits.map(commit => [commit.hash, commit.subject, commit.refNames.join(','), commit.parentHashes.join(',')]))
      const changed = commitsSignatureRef.current !== signature
      commitsSignatureRef.current = signature
      setCommits((prev) => (changed ? result.commits : prev))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('changes.unknownError'))
      setCommits((prev) => (prev.length === 0 ? prev : []))
    } finally {
      if (!options?.silent) setLoading(false)
    }
  }, [historyLimit, t, workspaceRootPath])

  useEffect(() => {
    setHistoryLimit(40)
  }, [workspaceRootPath])

  useEffect(() => {
    void loadCommits()
  }, [loadCommits])

  useEffect(() => {
    if (!workspaceRootPath) return

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const refresh = async () => {
      if (cancelled || document.hidden || refreshInFlightRef.current) return
      if (!panelRef.current || !panelRef.current.offsetParent) return
      refreshInFlightRef.current = true
      try {
        await loadCommits({ silent: true })
      } finally {
        refreshInFlightRef.current = false
      }
    }

    const scheduleNext = () => {
      if (cancelled) return
      timer = setTimeout(async () => {
        await refresh()
        scheduleNext()
      }, 5000)
    }

    const handleVisibility = () => {
      if (!document.hidden) {
        void refresh()
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
  }, [loadCommits, workspaceRootPath])

  const effectiveSelectedHash = useMemo(() => selectedCommitHash || commits[0]?.hash, [commits, selectedCommitHash])

  React.useEffect(() => {
    const viewport = historyViewportRef.current
    if (!viewport) return

    const maybeLoadMore = () => {
      const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
      if (distanceToBottom < 240) {
        setHistoryLimit((prev) => Math.min(prev + 40, 240))
      }
    }

    viewport.addEventListener('scroll', maybeLoadMore, { passive: true })
    return () => viewport.removeEventListener('scroll', maybeLoadMore)
  }, [])
  const graphLayout = useMemo(() => buildGitGraphRows(commits), [commits])

  return (
    <Panel variant="grow">
      <PanelHeader title={t('changes.historyLabel')} />
      {loading ? (
        <div className="flex h-full items-center justify-center text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : error ? (
        <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
          {error}
        </div>
      ) : commits.length === 0 ? (
        <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
          {t('changes.noRecentCommits')}
        </div>
      ) : (
        <div ref={panelRef} className="min-h-0 flex-1 overflow-hidden">
          <div className="flex h-full min-h-0">
            <div ref={historyViewportRef} className="min-h-0 w-[320px] shrink-0 overflow-auto border-r border-border/40 px-3 py-3">
              <div className="relative">
                <div>
                  {commits.map((commit, index) => {
                    const isSelected = effectiveSelectedHash === commit.hash
                    return (
                      <button
                        key={commit.hash}
                        type="button"
                        className={cn(
                          'relative flex w-full items-stretch rounded-lg text-left transition-colors',
                          isSelected ? 'bg-foreground/8 text-foreground' : 'text-foreground/90 hover:bg-foreground/[0.04]'
                        )}
                        onClick={() => navigate(routes.view.changesHistory(commit.hash))}
                      >
                        <GitHistoryGraphRow layout={graphLayout} row={graphLayout.rows[index]!} rowIndex={index} />
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
              </div>
            </div>
            <ChangesHistoryCommitDetail workspaceRootPath={workspaceRootPath} commitHash={effectiveSelectedHash} />
          </div>
        </div>
      )}
    </Panel>
  )
}
