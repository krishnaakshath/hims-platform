'use client'
// WS7 T9 (spec D15): "Add a policy" and "Add my ABHA" on the portal insurance page, and the status
// of what the patient has sent. Nothing here changes the hospital record: the front desk checks
// each submission and approves or rejects it (with a reason shown below).
import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { fetchJson } from '@/lib/client-fetch'
import { INPUT_CLASS } from '@/components/registration/Field'

export interface SelfServiceSubmission {
  id: number; kind: 'policy' | 'abha'; status: 'pending' | 'approved' | 'rejected'; summary: string
  submittedOn: string; rejectReason: string | null
}

const STATUS_LABEL: Record<SelfServiceSubmission['status'], string> = {
  pending: 'Waiting for the front desk to check', approved: 'Approved and added to your record', rejected: 'Not accepted',
}
const MAX_CARD_BYTES = 5 * 1024 * 1024

function useSubmit(kind: 'policy' | 'abha') {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [done, setDone] = useState(false)

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const formEl = e.currentTarget
    const fd = new FormData(formEl)
    fd.set('kind', kind)
    const card = fd.get('card')
    if (card instanceof File && card.size > MAX_CARD_BYTES) { setError('Files must be 5 MB or smaller.'); return }
    if (card instanceof File && card.size === 0) fd.delete('card')
    setBusy(true); setError(null); setFieldErrors({})
    const r = await fetchJson<{ id: number }>('/api/patient-portal/self-service', { method: 'POST', body: fd }, { passThrough: [413] })
    setBusy(false)
    if (!r.ok) {
      const fields = (r.body as { fields?: Record<string, string> } | undefined)?.fields
      if (fields && typeof fields === 'object') setFieldErrors(fields)
      setError(r.error)
      return
    }
    formEl.reset()
    setDone(true)
    router.refresh()
  }
  return { busy, error, fieldErrors, done, onSubmit }
}

function FieldError({ message }: { message?: string }) {
  return message ? <span className="mt-0.5 block text-xs text-destructive">{message}</span> : null
}

function CardInput({ disabled }: { disabled: boolean }) {
  return (
    <label className="block text-xs text-muted-foreground">Photo or scan of the card (optional; PDF, JPEG or PNG up to 5 MB)
      <input name="card" type="file" accept="application/pdf,image/jpeg,image/png" className={INPUT_CLASS} disabled={disabled} />
    </label>
  )
}

function PolicyForm() {
  const { busy, error, fieldErrors, done, onSubmit } = useSubmit('policy')
  if (done) return <p role="status" className="text-sm text-foreground">Thank you. The front desk will check your policy and add it to your record.</p>
  return (
    <form onSubmit={onSubmit} className="space-y-3" aria-label="Add a policy">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block text-xs text-muted-foreground">Insurance company
          <input name="insurerName" required minLength={2} maxLength={120} className={INPUT_CLASS} disabled={busy} />
          <FieldError message={fieldErrors.insurerName} />
        </label>
        <label className="block text-xs text-muted-foreground">Policy number
          <input name="policyNumber" required minLength={3} maxLength={40} className={INPUT_CLASS} disabled={busy} />
          <FieldError message={fieldErrors.policyNumber} />
        </label>
        <label className="block text-xs text-muted-foreground">Valid from
          <input name="validFrom" type="date" required className={INPUT_CLASS} disabled={busy} />
          <FieldError message={fieldErrors.validFrom} />
        </label>
        <label className="block text-xs text-muted-foreground">Valid to
          <input name="validTo" type="date" required className={INPUT_CLASS} disabled={busy} />
          <FieldError message={fieldErrors.validTo} />
        </label>
      </div>
      <SumInsuredInput disabled={busy} error={fieldErrors.sumInsuredPaise} />
      <CardInput disabled={busy} />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button type="submit" size="sm" disabled={busy}>{busy ? 'Sending…' : 'Send to the front desk'}</Button>
    </form>
  )
}

/** Sum insured in rupees; sent as whole paise. */
function SumInsuredInput({ disabled, error }: { disabled: boolean; error?: string }) {
  const [rupees, setRupees] = useState('')
  const paise = /^\d{1,11}$/.test(rupees) ? String(Number(rupees) * 100) : ''
  return (
    <label className="block text-xs text-muted-foreground">Sum insured in ₹ (optional)
      <input inputMode="numeric" pattern="\d*" value={rupees} onChange={(e) => setRupees(e.target.value.replace(/\D/g, ''))} className={INPUT_CLASS} disabled={disabled} />
      <input type="hidden" name="sumInsuredPaise" value={paise} />
      <FieldError message={error} />
    </label>
  )
}

function AbhaForm() {
  const { busy, error, fieldErrors, done, onSubmit } = useSubmit('abha')
  if (done) return <p role="status" className="text-sm text-foreground">Thank you. The front desk will check your ABHA and add it to your record.</p>
  return (
    <form onSubmit={onSubmit} className="space-y-3" aria-label="Add my ABHA">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block text-xs text-muted-foreground">ABHA number (14 digits, XX-XXXX-XXXX-XXXX)
          <input name="abhaNumber" required inputMode="numeric" maxLength={17} placeholder="XX-XXXX-XXXX-XXXX" className={INPUT_CLASS} disabled={busy} />
          <FieldError message={fieldErrors.abhaNumber} />
        </label>
        <label className="block text-xs text-muted-foreground">ABHA address (optional, e.g. name@abdm)
          <input name="abhaAddress" maxLength={40} className={INPUT_CLASS} disabled={busy} />
          <FieldError message={fieldErrors.abhaAddress} />
        </label>
      </div>
      <CardInput disabled={busy} />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button type="submit" size="sm" disabled={busy}>{busy ? 'Sending…' : 'Send to the front desk'}</Button>
    </form>
  )
}

export function SelfServiceForms({ submissions, pendingKinds }: { submissions: SelfServiceSubmission[]; pendingKinds: ('policy' | 'abha')[] }) {
  const [open, setOpen] = useState<'policy' | 'abha' | null>(null)
  return (
    <div className="space-y-4">
      {submissions.length > 0 && (
        <ul className="space-y-2" aria-label="Your submissions">
          {submissions.map((s) => (
            <li key={s.id} className="rounded-lg border border-border bg-secondary/30 p-3 text-sm">
              <p className="font-medium text-foreground">{s.kind === 'policy' ? 'Policy' : 'ABHA'}: {s.summary}</p>
              <p className="text-xs text-muted-foreground">Sent {s.submittedOn} · {STATUS_LABEL[s.status]}</p>
              {s.status === 'rejected' && s.rejectReason && <p className="mt-1 text-xs text-foreground">Reason: {s.rejectReason}</p>}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        {!pendingKinds.includes('policy') && <Button size="sm" variant={open === 'policy' ? 'default' : 'outline'} onClick={() => setOpen(open === 'policy' ? null : 'policy')}>Add a policy</Button>}
        {!pendingKinds.includes('abha') && <Button size="sm" variant={open === 'abha' ? 'default' : 'outline'} onClick={() => setOpen(open === 'abha' ? null : 'abha')}>Add my ABHA</Button>}
      </div>
      {open === 'policy' && !pendingKinds.includes('policy') && <PolicyForm />}
      {open === 'abha' && !pendingKinds.includes('abha') && <AbhaForm />}
    </div>
  )
}
