'use client'
import { useId, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { ApiResult } from './api'
import { FIELD, LABEL } from './format'

/**
 * Confirm step for a destructive action that needs a written reason
 * (cancel follow-up, cancel booking, cancel visit). Nothing is sent until the
 * user confirms; server errors stay in the dialog in a role="alert".
 */
export function ReasonDialog({
  title, description, confirmLabel, onSubmit, onClose, onDone,
}: {
  title: string
  description: string
  confirmLabel: string
  onSubmit: (reason: string) => Promise<ApiResult>
  onClose: () => void
  onDone: () => void
}) {
  const uid = useId()
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function confirm() {
    const trimmed = reason.trim()
    if (!trimmed) { setError('Please give a reason.'); return }
    setBusy(true); setError(null)
    const res = await onSubmit(trimmed)
    setBusy(false)
    if (res.ok) { onDone(); return }
    setError(res.error)
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <form noValidate className="space-y-3" onSubmit={(e) => { e.preventDefault(); void confirm() }}>
          <p className="text-sm text-foreground">{description}</p>
          <div>
            <label htmlFor={`${uid}-reason`} className={LABEL}>Reason</label>
            <textarea id={`${uid}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={3} className={FIELD} required />
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Keep</Button>
            <Button type="submit" variant="destructive" disabled={busy}>{busy ? 'Working…' : `Confirm: ${confirmLabel}`}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
