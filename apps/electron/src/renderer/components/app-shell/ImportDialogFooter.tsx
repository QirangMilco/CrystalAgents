import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'

interface ImportDialogFooterProps {
  phase: 'preview' | 'result'
  importing: boolean
  canImport: boolean
  cancelLabel: string
  confirmLabel: string
  closeLabel: string
  loadingIndicator?: ReactNode
  onCancel: () => void
  onConfirm: () => void
  onClose: () => void
}

export function ImportDialogFooter({
  phase,
  importing,
  canImport,
  cancelLabel,
  confirmLabel,
  closeLabel,
  loadingIndicator,
  onCancel,
  onConfirm,
  onClose,
}: ImportDialogFooterProps) {
  return (
    <DialogFooter>
      {phase === 'preview' ? (
        <>
          <Button variant="outline" size="sm" onClick={onCancel} disabled={importing}>
            {cancelLabel}
          </Button>
          <Button size="sm" onClick={onConfirm} disabled={importing || !canImport}>
            {importing ? loadingIndicator : null}
            {confirmLabel}
          </Button>
        </>
      ) : (
        <Button variant="outline" size="sm" onClick={onClose}>
          {closeLabel}
        </Button>
      )}
    </DialogFooter>
  )
}
