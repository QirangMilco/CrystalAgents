import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Check, ChevronDown, Loader2, Sparkles } from 'lucide-react'
import type { GitGeneratedCommitMessageResult, LlmConnectionWithStatus } from '../../../shared/types'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useAutoGrow } from '@/components/app-shell/input/useAutoGrow'
import { DropdownMenu, DropdownMenuTrigger, StyledDropdownMenuContent, StyledDropdownMenuItem, StyledDropdownMenuSeparator } from '@/components/ui/styled-dropdown'
import { Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui'
import { cn } from '@/lib/utils'
import { resolveEffectiveConnectionSlug } from '@config/llm-connections'
import { getModelShortName } from '@config/models'

const DEFAULT_COMMIT_PROMPT = 'Summarize the staged changes as a conventional git commit message. Prefer a concise subject. Use the current UI language, but keep conventional commit type keywords like feat/fix/refactor/docs/test/chore in English.'

interface ChangesCommitComposerProps {
  workspaceId?: string | null
  workspaceRootPath?: string
  llmConnections: LlmConnectionWithStatus[]
  workspaceDefaultConnection?: string
  disabled?: boolean
  hasStagedFiles: boolean
  actionBusyKey?: string | null
  value: string
  onChange: (value: string) => void
  onCommit: () => void | Promise<void>
}

function getConnectionSubtitle(connection: LlmConnectionWithStatus): string {
  const model = connection.miniModel || connection.defaultModel
  return model ? getModelShortName(model) : connection.name
}

export function ChangesCommitComposer({
  workspaceId,
  workspaceRootPath,
  llmConnections,
  workspaceDefaultConnection,
  disabled = false,
  hasStagedFiles,
  actionBusyKey,
  value,
  onChange,
  onCommit,
}: ChangesCommitComposerProps) {
  const { t } = useTranslation()
  const { ref, adjustHeight } = useAutoGrow<HTMLTextAreaElement>({ minHeight: 36, maxHeight: 140 })
  const [selectedConnectionSlug, setSelectedConnectionSlug] = useState<string | undefined>()
  const [customPrompt, setCustomPrompt] = useState(DEFAULT_COMMIT_PROMPT)
  const [isGenerating, setIsGenerating] = useState(false)

  const effectiveConnectionSlug = useMemo(() => resolveEffectiveConnectionSlug(
    selectedConnectionSlug,
    workspaceDefaultConnection,
    llmConnections,
  ), [llmConnections, selectedConnectionSlug, workspaceDefaultConnection])

  const effectiveConnection = useMemo(
    () => llmConnections.find(connection => connection.slug === effectiveConnectionSlug) ?? null,
    [effectiveConnectionSlug, llmConnections],
  )

  useEffect(() => {
    adjustHeight()
  }, [adjustHeight, value])

  const canGenerate = !!workspaceId && !!workspaceRootPath && !disabled && !isGenerating && !actionBusyKey
  const canCommit = !!value.trim() && !disabled && !actionBusyKey

  const handleGenerate = React.useCallback(async () => {
    if (!workspaceId || !workspaceRootPath || !canGenerate) return
    setIsGenerating(true)
    try {
      const result = await window.electronAPI.generateGitCommitMessage({
        workspaceId,
        dirPath: workspaceRootPath,
        connectionSlug: effectiveConnectionSlug,
        customPrompt,
      })

      if (!result.ok) {
        toast.error(t('changes.commitMessageGenerateFailed'), {
          description: result.message || t('changes.unknownError'),
        })
        return
      }

      const generated = (result as GitGeneratedCommitMessageResult).message.trim()
      onChange(generated)
      toast.success(t('changes.commitMessageGenerated'))
    } catch (error) {
      toast.error(t('changes.commitMessageGenerateFailed'), {
        description: error instanceof Error ? error.message : t('changes.unknownError'),
      })
    } finally {
      setIsGenerating(false)
    }
  }, [canGenerate, customPrompt, effectiveConnectionSlug, onChange, t, workspaceId, workspaceRootPath])

  return (
    <>
      <div className="space-y-2">
        <div className="flex items-start gap-2">
          <Textarea
            ref={ref}
            value={value}
            onChange={(event) => {
              onChange(event.target.value)
              adjustHeight()
            }}
            placeholder={t('changes.commitPlaceholder')}
            rows={1}
            disabled={disabled}
            className="min-h-9 resize-none overflow-y-auto px-3 py-2 text-sm leading-5"
          />
          <div className="flex shrink-0 items-start">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="min-w-[2.5rem] rounded-r-none px-2.5"
                  onClick={() => void handleGenerate()}
                  disabled={!canGenerate}
                  aria-label={isGenerating ? t('changes.generatingCommitMessage') : t('changes.generateCommitMessage')}
                >
                  {isGenerating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{isGenerating ? t('changes.generatingCommitMessage') : t('changes.generateCommitMessage')}</TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="rounded-l-none border-l border-foreground/10 px-2"
                  disabled={disabled}
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <StyledDropdownMenuContent align="end" minWidth="min-w-72 max-w-[22rem]">
                <div className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  {t('changes.commitMessageModel')}
                </div>
                {llmConnections.map((connection) => {
                  const isSelected = connection.slug === effectiveConnectionSlug
                  return (
                    <StyledDropdownMenuItem key={connection.slug} onClick={() => setSelectedConnectionSlug(connection.slug)}>
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm text-foreground">{connection.name}</div>
                          <div className="truncate text-xs text-muted-foreground">{getConnectionSubtitle(connection)}</div>
                        </div>
                        {isSelected && <Check className="h-3.5 w-3.5 text-foreground/70" />}
                      </div>
                    </StyledDropdownMenuItem>
                  )
                })}
                <StyledDropdownMenuSeparator />
                <div className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  {t('changes.commitMessagePrompt')}
                </div>
                <div className="w-full max-w-[20rem] px-2 pb-2">
                  <Textarea
                    value={customPrompt}
                    onChange={(event) => setCustomPrompt(event.target.value)}
                    rows={5}
                    className="min-h-[96px] w-full max-w-full resize-y text-sm"
                  />
                </div>
              </StyledDropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 text-xs text-muted-foreground">
            {isGenerating ? (
              <span className="inline-flex items-center gap-1.5 text-foreground/80">
                <Loader2 className="h-3 w-3 animate-spin" />
                {t('changes.generatingCommitMessage')}
              </span>
            ) : effectiveConnection ? (
              <span className="truncate">
                {t('changes.commitMessageUsingModel', {
                  provider: effectiveConnection.name,
                  model: getConnectionSubtitle(effectiveConnection),
                })}
              </span>
            ) : t('changes.commitMessageNoModel')}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button type="button" size="sm" onClick={() => void onCommit()} disabled={!canCommit}>
              {t('changes.commit')}
            </Button>
          </div>
        </div>
      </div>

    </>
  )
}
