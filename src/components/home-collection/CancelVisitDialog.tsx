'use client'
// SP5: cancel a booked visit with a reason code. Its tests go back to "ordered" and keep their
// sample IDs. `reasons` lets a collector screen offer only the doorstep reasons.
import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { VISIT_CANCEL_REASON_LABEL, type VisitCancelReason } from '@/lib/home-collection/rules'
import { cancelVisit } from '@/components/home-collection/api'
import { FIELD } from '@/components/home-collection/WindowSelect'

/** Staff reasons: 'tests_cancelled' is recorded by the system when the last test is cancelled. */
export const STAFF_CANCEL_REASONS: readonly VisitCancelReason[] = ['patient_request', 'patient_unavailable', 'patient_refused', 'address_not_found', 'other']

export function CancelVisitDialog({
  visit, reasons = STAFF_CANCEL_REASONS, onClose,
}: { visit: { id: number; patientName: string }; reasons?: readonly VisitCancelReason[]; onClose: () => void }) {
  const router = useRouter()
  const id = useId()
  const [reason, setReason] = useState<VisitCancelReason | ''>('')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setError(null)
    if (!reason) { setError('Pick a reason.'); return }
    setSubmitting(true)
    const r = await cancelVisit(visit.id, { reason, ...(note.trim() ? { note: note.trim() } : {}) })
    setSubmitting(false)
    if (!r.ok) { setError(r.error); return }
    router.refresh()
    onClose()
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Cancel visit: {visit.patientName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">The tests go back to the waiting list and keep their sample IDs.</p>
          <div>
            <label htmlFor={`${id}-reason`} className="block text-xs text-muted-foreground">Reason</label>
            <select id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value as VisitCancelReason | '')} className={FIELD}>
              <option value="">Pick a reason</option>
              {reasons.map((r) => <option key={r} value={r}>{VISIT_CANCEL_REASON_LABEL[r]}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor={`${id}-note`} className="block text-xs text-muted-foreground">Note (optional)</label>
            <input id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} className={FIELD} />
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Keep visit</Button>
          <Button variant="destructive" onClick={submit} disabled={submitting}>{submitting ? 'Cancelling…' : 'Cancel visit'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
