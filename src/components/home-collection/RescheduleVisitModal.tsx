'use client'
// SP5: move a booked visit to another date/window, with a reason code. A date change clears the
// assigned collector (server side).
import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { RESCHEDULE_REASONS, RESCHEDULE_REASON_LABEL, type RescheduleReason } from '@/lib/home-collection/rules'
import { rescheduleVisit } from '@/components/home-collection/api'
import { FIELD, WindowSelect } from '@/components/home-collection/WindowSelect'

export function RescheduleVisitModal({
  visit, onClose,
}: { visit: { id: number; patientName: string; visitDate: string; windowId: number }; onClose: () => void }) {
  const router = useRouter()
  const id = useId()
  const [visitDate, setVisitDate] = useState(visit.visitDate)
  const [windowId, setWindowId] = useState('')
  const [reason, setReason] = useState<RescheduleReason | ''>('')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setError(null)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(visitDate)) { setError('Pick a valid date.'); return }
    if (!windowId) { setError('Pick a collection window.'); return }
    if (!reason) { setError('Pick a reason.'); return }
    setSubmitting(true)
    const r = await rescheduleVisit(visit.id, { visitDate, windowId: Number(windowId), reason, ...(note.trim() ? { note: note.trim() } : {}) })
    setSubmitting(false)
    if (!r.ok) { setError(r.error); return }
    router.refresh()
    onClose()
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Reschedule visit: {visit.patientName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor={`${id}-date`} className="block text-xs text-muted-foreground">New date</label>
              <input id={`${id}-date`} type="date" value={visitDate} onChange={(e) => { setVisitDate(e.target.value); setWindowId('') }} className={FIELD} />
            </div>
            <WindowSelect id={`${id}-window`} date={visitDate} value={windowId} onChange={setWindowId} />
          </div>
          <div>
            <label htmlFor={`${id}-reason`} className="block text-xs text-muted-foreground">Reason</label>
            <select id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value as RescheduleReason | '')} className={FIELD}>
              <option value="">Pick a reason</option>
              {RESCHEDULE_REASONS.map((r) => <option key={r} value={r}>{RESCHEDULE_REASON_LABEL[r]}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor={`${id}-note`} className="block text-xs text-muted-foreground">Note (optional)</label>
            <input id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} className={FIELD} />
          </div>
          {visitDate !== visit.visitDate && <p className="text-xs text-muted-foreground">Changing the date removes the assigned collector.</p>}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
          <Button onClick={submit} disabled={submitting}>{submitting ? 'Saving…' : 'Reschedule'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
