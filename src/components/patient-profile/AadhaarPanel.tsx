'use client'
import { sendJson } from '@/lib/client-fetch'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Field, INPUT_CLASS } from '@/components/registration/Field'
import { AADHAAR_DECLINE_REASONS } from '@/lib/india/reference'
import type { AadhaarView } from '@/lib/patient-identity'

// Receives only the role-filtered view (never the stored summary): `masked`
// is non-null for admin/crc alone, `declineReason` likewise. The number typed
// into the modal lives in state until submit and is cleared on close.
function spaced(s: string): string {
  return s.replace(/(.{4})(?=.)/g, '$1 ')
}

function statusText(view: AadhaarView): string {
  if (view.status === 'on_file') return view.masked ?? 'On file'
  if (view.status === 'declined') {
    const label = AADHAAR_DECLINE_REASONS.find((r) => r.code === view.declineReason)?.label
    return label ? `Declined — ${label}` : 'Declined'
  }
  return 'Not recorded'
}

export function AadhaarPanel({ anonId, view, canWrite }: { anonId: string; view: AadhaarView; canWrite: boolean }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [declined, setDeclined] = useState(false)
  const [number, setNumber] = useState('')
  const [consent, setConsent] = useState(false)
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const noteMissing = declined && reason === 'other' && note.trim() === ''

  function reset() {
    setDeclined(false); setNumber(''); setConsent(false); setReason(''); setNote(''); setError(null)
  }
  function close() {
    setOpen(false)
    reset()
  }

  async function save() {
    setSaving(true)
    setError(null)
    const body = declined
      ? { status: 'declined', reason, ...(note.trim() ? { note: note.trim() } : {}) }
      : { status: 'provided', number, consent }
    try {
      const res = await sendJson(`/api/patients/${anonId}/aadhaar`, 'PUT', body)
      if (!res.ok) {
        setError(res.error)
        return
      }
      close()
      router.refresh()
    } catch {
      setError('Could not save Aadhaar. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <p className="text-sm text-foreground"><span className="mr-2 text-xs uppercase tracking-wide text-muted-foreground">Aadhaar</span><span className="font-mono">{statusText(view)}</span></p>
      {canWrite && (
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
          {view.status === 'on_file' ? 'Replace Aadhaar' : 'Record Aadhaar'}
        </Button>
      )}
      {open && (
        <Dialog open onOpenChange={(o) => { if (!o) close() }}>
          <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
            <DialogHeader><DialogTitle>{view.status === 'on_file' ? 'Replace Aadhaar' : 'Record Aadhaar'}</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={declined} onChange={(e) => setDeclined(e.target.checked)} />
                Patient does not provide Aadhaar
              </label>
              {!declined ? (
                <>
                  <Field label="Aadhaar number">
                    {(p) => (
                      <input {...p} inputMode="numeric" autoComplete="off" autoCorrect="off" spellCheck={false} placeholder="XXXX XXXX XXXX"
                        value={spaced(number)} onChange={(e) => setNumber(e.target.value.replace(/\D/g, '').slice(0, 12))} className={INPUT_CLASS} />
                    )}
                  </Field>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                    Patient consents to recording their Aadhaar number
                  </label>
                </>
              ) : (
                <>
                  <Field label="Reason for no Aadhaar" required>
                    {(p) => (
                      <select {...p} value={reason} onChange={(e) => setReason(e.target.value)} className={INPUT_CLASS}>
                        <option value="">Select a reason</option>
                        {AADHAAR_DECLINE_REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
                      </select>
                    )}
                  </Field>
                  <Field label={reason === 'other' ? 'Note (required)' : 'Note (optional)'} error={noteMissing ? 'A note is required when the reason is other' : undefined}>
                    {(p) => <input {...p} autoComplete="off" value={note} onChange={(e) => setNote(e.target.value)} className={INPUT_CLASS} />}
                  </Field>
                </>
              )}
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={close} disabled={saving}>Cancel</Button>
              <Button type="button" onClick={save} disabled={saving || (declined ? !reason || noteMissing : number.length !== 12 || !consent)}>{saving ? 'Saving…' : 'Save'}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
