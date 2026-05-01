import * as React from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { UnifiedDiffViewer, type DiffViewerSettings } from '@craft-agent/ui'
import type { GitCommitDetailResult } from '../../../shared/types'
import { useTheme } from '@/context/ThemeContext'
import { Codicon } from '@/components/ui/Codicon'
import { GitRefBadges } from './git-history-ui'

interface ChangesHistoryCommitDetailProps {
  workspaceRootPath?: string
  commitHash?: string
}

export function ChangesHistoryCommitDetail({ workspaceRootPath, commitHash }: ChangesHistoryCommitDetailProps) {
  const { t } = useTranslation()
  const { resolvedMode } = useTheme()
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<GitCommitDetailResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [diffViewerSettings, setDiffViewerSettings] = useState<Partial<DiffViewerSettings>>({})

  useEffect(() => {
    window.electronAPI.readPreferences().then(({ content }) => {
      try {
        const prefs = JSON.parse(content)
        if (prefs.diffViewer) setDiffViewerSettings(prefs.diffViewer)
      } catch {
        // ignore
      }
    })
  }, [])

  useEffect(() => {
    let stale = false
    if (!workspaceRootPath || !commitHash) {
      setResult(null)
      setError(null)
      return
    }

    setLoading(true)
    setError(null)
    window.electronAPI.getGitCommitDiff(workspaceRootPath, commitHash)
      .then((response) => {
        if (stale) return
        if (!response.ok) {
          setError(response.message || t('changes.unableToLoadDiff'))
          setResult(null)
          return
        }
        setResult(response)
      })
      .catch((err) => {
        if (stale) return
        setError(err instanceof Error ? err.message : t('changes.unableToLoadDiff'))
        setResult(null)
      })
      .finally(() => {
        if (!stale) setLoading(false)
      })

    return () => { stale = true }
  }, [commitHash, t, workspaceRootPath])

  if (!commitHash) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t('changes.selectHistoryEntry')}
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    )
  }

  if (error || !result) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        {error || t('changes.unableToLoadDiff')}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col border-l border-border/40">
      <div className="border-b border-border/40 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <div className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{result.commit.subject}</div>
              <span className="inline-flex shrink-0 items-center rounded bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[11px] text-foreground/85">
                {result.commit.shortHash}
              </span>
            </div>
            <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span>{result.commit.authorName}</span>
              <span>·</span>
              <span>{new Date(result.commit.authoredAt).toLocaleString()}</span>
              <GitRefBadges refNames={result.commit.refNames} compact className="mt-0" />
            </div>
          </div>
          <Codicon name="history" className="mt-0.5 text-[16px] leading-none text-muted-foreground" />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-4 pt-4">
        <UnifiedDiffViewer
          unifiedDiff={result.diff}
          filePath={result.commit.shortHash}
          theme={resolvedMode === 'dark' ? 'dark' : 'light'}
          diffStyle={diffViewerSettings.diffStyle ?? 'unified'}
          disableBackground={diffViewerSettings.disableBackground ?? false}
          disableFileHeader={false}
          className="h-full"
        />
      </div>
    </div>
  )
}
