import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { routes } from '@/lib/navigate'
import { useNavigation } from '@/contexts/NavigationContext'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { UnifiedDiffViewer, type DiffViewerSettings } from '@craft-agent/ui'
import type { ChangedFileItem, GitActionResult, GitFileDiffResult, GitStatusResult } from '../../../shared/types'
import { Panel } from './Panel'
import { PanelHeader } from './PanelHeader'
import { useTheme } from '@/context/ThemeContext'
import { getPathBasename, joinPlatformPath } from '@/lib/platform'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/Codicon'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { useAppShellContext } from '@/context/AppShellContext'
import { ChangesCommitComposer } from './ChangesCommitComposer'
import { ChangesConflictEditor } from './ChangesConflictEditor'

const detailStatusClassName: Record<ChangedFileItem['status'], string> = {
  modified: 'text-amber-500',
  added: 'text-emerald-500',
  deleted: 'text-red-500',
  renamed: 'text-blue-500',
  untracked: 'text-emerald-500',
  conflict: 'text-red-600',
}

function getDetailStatusCode(status: ChangedFileItem['status']): string {
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

interface ChangesDetailPanelProps {
  workspaceRootPath?: string
  filePath?: string | null
}

export function ChangesDetailPanel({ workspaceRootPath, filePath }: ChangesDetailPanelProps) {
  const { t } = useTranslation()
  const { navigate } = useNavigation()
  const { resolvedMode } = useTheme()
  const { activeWorkspaceId, llmConnections, workspaceDefaultLlmConnection } = useAppShellContext()
  const [diffResult, setDiffResult] = useState<GitFileDiffResult | null>(null)
  const [statusResult, setStatusResult] = useState<GitStatusResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [actionBusyKey, setActionBusyKey] = useState<string | null>(null)
  const [pendingDiscard, setPendingDiscard] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [diffViewerSettings, setDiffViewerSettings] = useState<Partial<DiffViewerSettings>>({})

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

  useEffect(() => {
    let stale = false
    if (!workspaceRootPath || !filePath) {
      setDiffResult(null)
      setStatusResult(null)
      return
    }

    setLoading(true)
    Promise.all([
      window.electronAPI.getGitFileDiff(workspaceRootPath, filePath),
      window.electronAPI.getGitStatus(workspaceRootPath),
    ]).then(([diff, status]) => {
      if (!stale) {
        setDiffResult(diff)
        setStatusResult(status)
      }
    }).finally(() => {
      if (!stale) setLoading(false)
    })

    return () => { stale = true }
  }, [filePath, workspaceRootPath])

  const selectedFile = useMemo<ChangedFileItem | null>(() => {
    if (!filePath || !statusResult?.ok) return null
    return statusResult.files.find(file => file.path === filePath) ?? null
  }, [filePath, statusResult])
  const summary = statusResult?.ok ? statusResult.summary : null
  const hasStagedFiles = (summary?.staged ?? 0) > 0
  const canPull = (summary?.behind ?? 0) > 0
  const canPush = (summary?.ahead ?? 0) > 0
  const isConflictMode = selectedFile?.status === 'conflict'
  const absoluteFilePath = useMemo(() => {
    if (!workspaceRootPath || !filePath) return filePath ?? ''
    return joinPlatformPath(workspaceRootPath, filePath)
  }, [filePath, workspaceRootPath])

  const runGitAction = React.useCallback(async (busyKey: string, action: () => Promise<GitActionResult>) => {
    setActionBusyKey(busyKey)
    try {
      const result = await action()
      if (!result.ok) {
        toast.error(t('changes.actionFailed'), {
          description: result.message || t('changes.unknownError'),
        })
        return result
      }

      const successMessage =
        busyKey === 'commit' ? t('changes.commitSuccess')
          : busyKey === 'fetch' ? t('changes.fetchSuccess')
            : busyKey === 'pull' ? t('changes.pullSuccess')
              : busyKey === 'push' ? t('changes.pushSuccess')
                : busyKey.startsWith('unstage:') ? t('changes.unstageFileSuccess')
                  : busyKey.startsWith('stage:') ? t('changes.stageFileSuccess')
                    : t('changes.discardFileSuccess')

      toast.success(successMessage, { description: result.message || undefined })

      if (workspaceRootPath && filePath) {
        const [diff, status] = await Promise.all([
          window.electronAPI.getGitFileDiff(workspaceRootPath, filePath),
          window.electronAPI.getGitStatus(workspaceRootPath),
        ])
        setDiffResult(diff)
        setStatusResult(status)

        if (busyKey.startsWith('discard:') && status.ok && !status.files.some(file => file.path === filePath)) {
          navigate(routes.view.changes())
        }
      }

      return result
    } catch (error) {
      toast.error(t('changes.actionFailed'), {
        description: error instanceof Error ? error.message : t('changes.unknownError'),
      })
      return { ok: false, reason: 'unknown_error' as const }
    } finally {
      setActionBusyKey(null)
    }
  }, [filePath, navigate, t, workspaceRootPath])

  const handleCommit = React.useCallback(async () => {
    if (!workspaceRootPath || !commitMessage.trim()) return
    const result = await runGitAction('commit', () => window.electronAPI.commitGitChanges(workspaceRootPath, { message: commitMessage.trim() }))
    if (result.ok) {
      setCommitMessage('')
    }
  }, [commitMessage, runGitAction, workspaceRootPath])

  if (!filePath) {
    return (
      <Panel variant="grow">
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          {t('changes.selectAFile')}
        </div>
      </Panel>
    )
  }

  return (
    <Panel variant="grow">
      <PanelHeader title={getPathBasename(filePath) || filePath} />
      <div className="border-b border-border/40 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {selectedFile && (
                <span className={cn('shrink-0 text-xs font-semibold', detailStatusClassName[selectedFile.status])}>
                  {getDetailStatusCode(selectedFile.status)}
                </span>
              )}
              <div className="truncate text-sm font-medium text-foreground">{getPathBasename(filePath) || filePath}</div>
            </div>
            <div className="mt-1 truncate text-xs text-muted-foreground">{t('changes.pathLabel')}: {filePath}</div>
            {selectedFile?.oldPath && selectedFile.status === 'renamed' && (
              <div className="mt-1 truncate text-xs text-muted-foreground">{t('changes.renamedFromLabel')}: {selectedFile.oldPath}</div>
            )}
            {selectedFile && (
              <div className="mt-2 flex flex-wrap gap-2">
                {isConflictMode && <StatusBadge label={t('changes.conflictsLabel')} tone="warning" />}
                <StatusBadge label={t(`changes.${selectedFile.status}`)} />
                {selectedFile.staged && <StatusBadge label={t('changes.stagedLabel')} tone="success" />}
                {selectedFile.unstaged && <StatusBadge label={t('changes.unstaged')} tone="warning" />}
                {(selectedFile.additions > 0 || selectedFile.deletions > 0) && (
                  <StatusBadge
                    label={t('changes.changeStats', { additions: selectedFile.additions, deletions: selectedFile.deletions })}
                  />
                )}
              </div>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {!isConflictMode && (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!workspaceRootPath || !!actionBusyKey || !canPush}
                  onClick={() => workspaceRootPath && void runGitAction('push', () => window.electronAPI.pushGitChanges(workspaceRootPath))}
                >
                  <Codicon name="repo-push" className="mr-1.5 text-[14px] leading-none" />
                  {t('changes.push')}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!workspaceRootPath || !!actionBusyKey}
                  onClick={() => workspaceRootPath && void runGitAction('fetch', () => window.electronAPI.fetchGitChanges(workspaceRootPath))}
                >
                  <Codicon name="repo-fetch" className="mr-1.5 text-[14px] leading-none" />
                  {t('changes.fetch')}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!workspaceRootPath || !!actionBusyKey || !canPull}
                  onClick={() => workspaceRootPath && void runGitAction('pull', () => window.electronAPI.pullGitChanges(workspaceRootPath))}
                >
                  <Codicon name="repo-pull" className="mr-1.5 text-[14px] leading-none" />
                  {t('changes.pull')}
                </Button>
              </>
            )}
            {selectedFile?.staged && !selectedFile?.unstaged ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={!workspaceRootPath || !!actionBusyKey || !selectedFile?.staged}
                onClick={() => workspaceRootPath && filePath && void runGitAction(`unstage:${filePath}`, () => window.electronAPI.unstageGitFile(workspaceRootPath, filePath))}
              >
                <Codicon name="remove" className="mr-1.5 text-[14px] leading-none" />
                {t('changes.unstageFile')}
              </Button>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!workspaceRootPath || !!actionBusyKey || !selectedFile?.unstaged}
                  onClick={() => setPendingDiscard(true)}
                >
                  <Codicon name="discard" className="mr-1.5 text-[14px] leading-none" />
                  {t('changes.discardFile')}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!workspaceRootPath || !!actionBusyKey || !selectedFile?.unstaged}
                  onClick={() => workspaceRootPath && filePath && void runGitAction(`stage:${filePath}`, () => window.electronAPI.stageGitFile(workspaceRootPath, filePath))}
                >
                  <Codicon name="add" className="mr-1.5 text-[14px] leading-none" />
                  {t('changes.stageFile')}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
      {!isConflictMode && (
        <div className="border-b border-border/40 px-4 py-3">
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
      )}

      <Dialog open={pendingDiscard} onOpenChange={setPendingDiscard}>
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('changes.discardFileConfirmTitle')}</DialogTitle>
            <DialogDescription>{t('changes.discardFileConfirmDescription', { path: filePath })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDiscard(false)}>{t('common.cancel')}</Button>
            <Button
              variant="destructive"
              disabled={!workspaceRootPath || !!actionBusyKey}
              onClick={async () => {
                if (!workspaceRootPath || !filePath) return
                const result = await runGitAction(`discard:${filePath}`, () => window.electronAPI.discardGitFile(workspaceRootPath, filePath))
                if (result.ok) setPendingDiscard(false)
              }}
            >
              {t('changes.discardFile')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {loading ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : selectedFile?.status === 'conflict' ? (
        <ChangesConflictEditor
          filePath={absoluteFilePath}
          loading={loading}
          actionBusy={!!actionBusyKey}
          onRefresh={() => {
            if (!workspaceRootPath || !filePath) return
            setLoading(true)
            Promise.all([
              window.electronAPI.getGitFileDiff(workspaceRootPath, filePath),
              window.electronAPI.getGitStatus(workspaceRootPath),
            ]).then(([diff, status]) => {
              setDiffResult(diff)
              setStatusResult(status)
            }).finally(() => setLoading(false))
          }}
          onStage={() => {
            if (!workspaceRootPath || !filePath) return
            void runGitAction(`stage:${filePath}`, () => window.electronAPI.stageGitFile(workspaceRootPath, filePath)).then(async (result) => {
              if (!result?.ok) return
              const latestStatus = await window.electronAPI.getGitStatus(workspaceRootPath)
              if (!latestStatus.ok) return
              const remainingConflicts = latestStatus.files.filter(file => file.status === 'conflict' && file.path !== filePath)
              if (remainingConflicts[0]?.path) {
                navigate(routes.view.changes(remainingConflicts[0].path))
              }
            })
          }}
        />
      ) : diffResult?.ok ? (
        <div className="min-h-0 flex-1 overflow-auto px-4 pb-4 pt-4">
          <UnifiedDiffViewer
            unifiedDiff={diffResult.diff}
            filePath={filePath}
            theme={resolvedMode === 'dark' ? 'dark' : 'light'}
            diffStyle={diffViewerSettings.diffStyle ?? 'unified'}
            disableBackground={diffViewerSettings.disableBackground ?? false}
            disableFileHeader={false}
            className="h-full"
          />
        </div>
      ) : (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          {t('changes.unableToLoadDiff')}
        </div>
      )}
    </Panel>
  )
}

function StatusBadge({ label, tone = 'default' }: { label: string; tone?: 'default' | 'success' | 'warning' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
        tone === 'success' && 'border-emerald-500/30 bg-emerald-500/8 text-emerald-600',
        tone === 'warning' && 'border-amber-500/30 bg-amber-500/8 text-amber-600',
        tone === 'default' && 'border-border/60 bg-foreground/[0.03] text-muted-foreground'
      )}
    >
      {label}
    </span>
  )
}
