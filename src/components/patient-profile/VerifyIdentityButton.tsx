'use client'
import { sendJson } from '@/lib/client-fetch'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ShieldCheck } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Field, INPUT_CLASS } from '@/components/registration/Field'
import { KYC_DOC_TYPES, KYC_DOC_LABELS } from '@/lib/india/reference'
import { containsAadhaarLike } from '@/lib/india/aadhaar'

type KycType = (typeof KYC_DOC_TYPES)[number]
const NO_AADHAAR = 'Do not enter an Aadhaar number here. Aadhaar is recorded only through its own consent step.'

// Wave B P1-09: record the KYC document seen at the desk (PUT
// /api/patients/[anonId]/identity). Aadhaar is never a KYC type here, and an
// Aadhaar-shaped number is refused before it leaves the browser. The number
// lives in state only until the dialog closes.
export function VerifyIdentityButton({ anonId, verified }: { anonId: string; verified: boolean }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [idType, setIdType] = useState<KycType | ''>('')
  const [idNumber, setIdNumber] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function close() {
    setOpen(false); setIdType(''); setIdNumber(''); setError(null)
  }

  async function submit() {
    setError(null)
    const number = idNumber.trim()
    if (!idType) { setError('Choose the ID document you checked.'); return }
    if (!number) { setError('Enter the document number.'); return }
    if (number.length > 40) { setError('That document number is too long.'); return }
    if (containsAadhaarLike(number)) { setError(NO_AADHAAR); setIdNumber(''); return }
    setSaving(true)
    try {
      const res = await sendJson(`/api/patients/${encodeURIComponent(anonId)}/identity`, 'PUT', { idType, idNumber: number })
      if (res.ok) { close(); router.refresh(); return }
      setError(res.error)
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <ShieldCheck className="h-4 w-4" aria-hidden="true" /> {verified ? 'Re-verify identity' : 'Verify identity'}
      </Button>
      {open && (
        <Dialog open onOpenChange={(o) => { if (!o) close() }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Verify identity</DialogTitle>
            </DialogHeader>
            <p className="-mt-2 text-xs text-muted-foreground">Record the government ID you checked against the patient. The number is stored encrypted.</p>
            <div className="space-y-3">
              <Field label="ID document" required>
                {(p) => (
                  <select {...p} value={idType} onChange={(e) => setIdType(e.target.value as KycType | '')} className={INPUT_CLASS}>
                    <option value="">Select a document</option>
                    {KYC_DOC_TYPES.map((t) => <option key={t} value={t}>{KYC_DOC_LABELS[t]}</option>)}
                  </select>
                )}
              </Field>
              <Field label="Document number" required>
                {(p) => <input {...p} value={idNumber} onChange={(e) => setIdNumber(e.target.value)} autoComplete="off" maxLength={40} className={INPUT_CLASS} />}
              </Field>
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={close}>Cancel</Button>
              <Button onClick={submit} disabled={saving}>{saving ? 'Saving…' : 'Mark verified'}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
