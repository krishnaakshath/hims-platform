'use client'
import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { CONTACT_CHANNELS, CONTACT_OUTCOMES } from '@/lib/follow-ups/validation'
import type { ContactChannel, ContactOutcome } from '@/lib/follow-ups/view'
import { logContactAttempt } from './api'
import { CHANNEL_LABEL, FIELD, LABEL, OUTCOME_LABEL } from './format'

/** Append-only log entry: how the patient was reached (or not) about a follow-up. */
export function ContactAttemptModal({ followUpId, patientLabel, onClose }: { followUpId: number; patientLabel?: string; onClose: () => void }) {
  const router = useRouter()
  const uid = useId()
  const [channel, setChannel] = useState<ContactChannel>('phone')
  const [outcome, setOutcome] = useState<ContactOutcome | ''>('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit() {
    setError(null)
    if (!outcome) { setError('Choose what happened.'); return }
    setBusy(true)
    const res = await logContactAttempt(followUpId, { channel, outcome, ...(note.trim() ? { note: note.trim() } : {}) })
    setBusy(false)
    if (!res.ok) { setError(res.error); return }
    router.refresh()
    onClose()
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Log contact attempt{patientLabel ? `: ${patientLabel}` : ''}</DialogTitle></DialogHeader>
        <form noValidate className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit() }}>
          <div>
            <label htmlFor={`${uid}-ch`} className={LABEL}>Channel</label>
            <select id={`${uid}-ch`} value={channel} onChange={(e) => setChannel(e.target.value as ContactChannel)} className={FIELD}>
              {CONTACT_CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor={`${uid}-out`} className={LABEL}>Outcome</label>
            <select id={`${uid}-out`} value={outcome} onChange={(e) => setOutcome(e.target.value as ContactOutcome)} className={FIELD} required>
              <option value="">Select outcome</option>
              {CONTACT_OUTCOMES.map((o) => <option key={o} value={o}>{OUTCOME_LABEL[o]}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor={`${uid}-note`} className={LABEL}>Note (optional)</label>
            <textarea id={`${uid}-note`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={3} className={FIELD} />
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save contact attempt'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
