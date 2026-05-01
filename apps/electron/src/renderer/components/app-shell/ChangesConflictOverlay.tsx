import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { getPathBasename } from '@/lib/platform'
import { ChangesConflictEditor } from './ChangesConflictEditor'

interface ChangesConflictOverlayProps {
  open: boolean
  filePath: string
  loading?: boolean
  actionBusy?: boolean
  onClose: () => void
  onStage?: () => void
  onRefresh?: () => void
}

export function ChangesConflictOverlay({
  open,
  filePath,
  loading = false,
  actionBusy = false,
  onClose,
  onStage,
  onRefresh,
}: ChangesConflictOverlayProps) {
  const { t } = useTranslation()

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="h-[min(88vh,52rem)] max-w-5xl overflow-hidden p-0">
        <DialogHeader className="border-b border-border/40 px-4 py-3">
          <DialogTitle className="truncate text-left text-sm font-medium">
            {t('changes.conflictsLabel')} · {getPathBasename(filePath) || filePath}
          </DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-hidden">
          <ChangesConflictEditor
            filePath={filePath}
            loading={loading}
            actionBusy={actionBusy}
            onStage={onStage}
            onRefresh={onRefresh}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
