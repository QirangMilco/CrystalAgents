import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

const CONFLICT_MARKER_PATTERN = /^(<<<<<<<|=======|>>>>>>>)/m

interface ConflictBlock {
  index: number
  startMarker: string
  endMarker: string
  ours: string
  theirs: string
  startOffset: number
  endOffset: number
}

interface ChangesConflictEditorProps {
  filePath: string
  loading?: boolean
  actionBusy?: boolean
  onStage?: () => void
  onRefresh?: () => void
}

function parseConflictBlocks(content: string): ConflictBlock[] {
  const lines = content.split('\n')
  const blocks: ConflictBlock[] = []
  let offset = 0
  let i = 0

  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (!line.startsWith('<<<<<<<')) {
      offset += line.length + 1
      i += 1
      continue
    }

    const startOffset = offset
    const startMarker = line
    i += 1
    offset += line.length + 1

    const ours: string[] = []
    while (i < lines.length && !(lines[i] ?? '').startsWith('=======')) {
      ours.push(lines[i] ?? '')
      offset += (lines[i] ?? '').length + 1
      i += 1
    }

    if (i >= lines.length) break
    const divider = lines[i] ?? ''
    offset += divider.length + 1
    i += 1

    const theirs: string[] = []
    while (i < lines.length && !(lines[i] ?? '').startsWith('>>>>>>>')) {
      theirs.push(lines[i] ?? '')
      offset += (lines[i] ?? '').length + 1
      i += 1
    }

    if (i >= lines.length) break
    const endMarker = lines[i] ?? ''
    offset += endMarker.length + 1
    i += 1

    blocks.push({
      index: blocks.length,
      startMarker,
      endMarker,
      ours: ours.join('\n'),
      theirs: theirs.join('\n'),
      startOffset,
      endOffset: offset,
    })
  }

  return blocks
}

export function ChangesConflictEditor({ filePath, loading = false, actionBusy = false, onStage, onRefresh }: ChangesConflictEditorProps) {
  const { t } = useTranslation()
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [activeConflictIndex, setActiveConflictIndex] = useState(0)
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    let stale = false
    window.electronAPI.readFile(filePath)
      .then((next) => {
        if (!stale) {
          setContent(next)
          setActiveConflictIndex(0)
        }
      })
      .catch((error) => {
        if (!stale) {
          toast.error(t('changes.conflictEditorLoadFailed'), {
            description: error instanceof Error ? error.message : t('changes.unknownError'),
          })
        }
      })
    return () => { stale = true }
  }, [filePath, t])

  const blocks = useMemo(() => parseConflictBlocks(content), [content])
  const activeBlock = blocks[activeConflictIndex] ?? null
  const hasConflictMarkers = CONFLICT_MARKER_PATTERN.test(content)

  useEffect(() => {
    if (!activeBlock || !textareaRef.current) return
    const textarea = textareaRef.current
    const start = Math.max(0, activeBlock.startOffset)
    const end = Math.max(start, Math.min(content.length, activeBlock.endOffset))
    textarea.focus()
    textarea.setSelectionRange(start, end)
    const lineHeight = 20
    const topLineEstimate = content.slice(0, start).split('\n').length - 1
    textarea.scrollTop = Math.max(0, topLineEstimate * lineHeight - lineHeight * 3)
  }, [activeBlock, content])

  const replaceActiveConflict = React.useCallback((replacement: string) => {
    if (!activeBlock) return
    const nextContent = content.slice(0, activeBlock.startOffset) + replacement + content.slice(activeBlock.endOffset)
    setContent(nextContent)
    const nextBlocks = parseConflictBlocks(nextContent)
    setActiveConflictIndex((current) => {
      if (nextBlocks.length === 0) return 0
      return Math.min(current, nextBlocks.length - 1)
    })
  }, [activeBlock, content])

  const handleSave = React.useCallback(async () => {
    setSaving(true)
    try {
      await window.electronAPI.writeFileText(filePath, content)
      if (CONFLICT_MARKER_PATTERN.test(content)) {
        toast.warning(t('changes.conflictEditorSavedWithMarkers'))
      } else {
        toast.success(t('changes.conflictEditorSaved'))
      }
      onRefresh?.()
    } catch (error) {
      toast.error(t('changes.conflictEditorSaveFailed'), {
        description: error instanceof Error ? error.message : t('changes.unknownError'),
      })
    } finally {
      setSaving(false)
    }
  }, [content, filePath, onRefresh, t])

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 px-4 pb-4 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 bg-background/60 px-3 py-2">
        <div className="text-sm text-muted-foreground">
          {blocks.length > 0
            ? t('changes.conflictEditorPosition', { current: activeConflictIndex + 1, total: blocks.length })
            : t('changes.conflictEditorNoConflicts')}
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="secondary" disabled={blocks.length === 0 || activeConflictIndex <= 0} onClick={() => setActiveConflictIndex((current) => Math.max(0, current - 1))}>
            <ChevronLeft className="mr-1.5 h-3.5 w-3.5" />
            {t('changes.conflictEditorPrevious')}
          </Button>
          <Button type="button" size="sm" variant="secondary" disabled={blocks.length === 0 || activeConflictIndex >= blocks.length - 1} onClick={() => setActiveConflictIndex((current) => Math.min(blocks.length - 1, current + 1))}>
            {t('changes.conflictEditorNext')}
            <ChevronRight className="ml-1.5 h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {activeBlock && (
        <div className="grid shrink-0 gap-3 lg:grid-cols-2">
          <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.04] p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-emerald-600">{t('changes.conflictEditorOurs')}</div>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs text-foreground/90">{activeBlock.ours}</pre>
            <div className="mt-3 flex gap-2">
              <Button type="button" size="sm" variant="secondary" onClick={() => replaceActiveConflict(activeBlock.ours)}>{t('changes.conflictEditorAcceptOurs')}</Button>
            </div>
          </div>
          <div className="rounded-lg border border-blue-500/20 bg-blue-500/[0.04] p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-blue-600">{t('changes.conflictEditorTheirs')}</div>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs text-foreground/90">{activeBlock.theirs}</pre>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="secondary" onClick={() => replaceActiveConflict(activeBlock.theirs)}>{t('changes.conflictEditorAcceptTheirs')}</Button>
              <Button type="button" size="sm" variant="secondary" onClick={() => replaceActiveConflict(`${activeBlock.ours}\n${activeBlock.theirs}`)}>{t('changes.conflictEditorAcceptBoth')}</Button>
            </div>
          </div>
        </div>
      )}

      {hasConflictMarkers && (
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/8 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          {t('changes.conflictEditorMarkersRemaining')}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border/60 bg-background/60">
        <Textarea
          ref={textareaRef}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          className={cn('h-full min-h-[320px] w-full resize-none rounded-none border-0 bg-transparent font-mono text-xs leading-5')}
        />
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" size="sm" variant="secondary" disabled={saving || loading} onClick={() => onRefresh?.()}>
          {loading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
          {t('changes.refresh')}
        </Button>
        <Button type="button" size="sm" variant="secondary" disabled={saving || actionBusy || hasConflictMarkers} onClick={() => onStage?.()}>
          {t('changes.stageFile')}
        </Button>
        <Button type="button" size="sm" disabled={saving} onClick={() => void handleSave()}>
          {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
          {t('common.save')}
        </Button>
      </div>
    </div>
  )
}
