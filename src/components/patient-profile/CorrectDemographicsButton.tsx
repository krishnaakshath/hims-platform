'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { PenLine } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Field, INPUT_CLASS } from '@/components/registration/Field'

// Wave C P1-11: admin-only correction of a typo in the name or date of birth
// (PATCH /api/patients/[anonId]/demographics), with a reason that is
// audited. Sends only the fields that changed; the UHID never changes.
export function CorrectDemographicsButton({ anonId, name, dob }: { anonId: string; name: string; dob: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [newName, setNewName] = useState(name)
  const [newDob, setNewDob] = useState(dob)
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function close() {
    setOpen(false); setNewName(name); setNewDob(dob); setReason(''); setError(null)
  }

  async function submit() {
    setError(null)
    const body: Record<string, string> = {}
    if (newName.trim() !== name.trim()) body.name = newName.trim()
    if (newDob !== dob) body.dob = newDob
    if (Object.keys(body).length === 0) { setError('Change the name or the date of birth.'); return }
    if (reason.trim().length < 5) { setError('Give a reason of at least 5 characters.'); return }
    setSaving(true)
    try {
      const res = await fetch(`/api/patients/${encodeURIComponent(anonId)}/demographics`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, reason: reason.trim() }),
      })
      if (res.ok) { setOpen(false); setReason(''); router.refresh(); return }
      const data = await res.json().catch(() => null)
      setError(data && typeof data.error === 'string' && data.error !== 'Invalid correction' ? data.error : 'Could not save the correction. Check the name and date of birth and try again.')
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <PenLine className="h-3.5 w-3.5" aria-hidden="true" />Correct name / DOB
      </Button>
      {open && (
        <Dialog open onOpenChange={(o) => { if (!o) close() }}>
          <DialogContent className="max-w-md">
            <DialogHeader><DialogTitle>Correct name or date of birth</DialogTitle></DialogHeader>
            <form onSubmit={(e) => { e.preventDefault(); void submit() }} className="space-y-3" noValidate>
              <p className="text-xs text-muted-foreground">For fixing a registration error only. The UHID stays the same and the change is recorded in the audit log with your reason.</p>
              <Field label="Full name">
                {(p) => <input {...p} autoComplete="off" maxLength={200} value={newName} onChange={(e) => setNewName(e.target.value)} className={INPUT_CLASS} />}
              </Field>
              <Field label="Date of birth">
                {(p) => <input {...p} type="date" value={newDob} onChange={(e) => setNewDob(e.target.value)} className={INPUT_CLASS} />}
              </Field>
              <Field label="Reason for correction" required>
                {(p) => <textarea {...p} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} className={INPUT_CLASS} />}
              </Field>
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={close} disabled={saving}>Cancel</Button>
                <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save correction'}</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
