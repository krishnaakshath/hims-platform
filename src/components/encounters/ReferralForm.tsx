'use client'
// WS1 T4: refer the patient from the open visit (POST /api/encounters/[id]/referrals), to a
// department and/or doctor in the hospital, or to an outside facility.
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { sendJson } from '@/lib/client-fetch'

type Urgency = 'routine' | 'urgent' | 'emergency'
const FIELD = 'mt-1 w-full rounded-md border border-border px-2 py-1.5 text-sm text-foreground'

export function ReferralForm({ encounterId, departments, doctors }: {
  encounterId: number
  departments: { id: number; name: string }[]
  doctors: { id: number; name: string; specialty: string }[]
}) {
  const router = useRouter()
  const [kind, setKind] = useState<'internal' | 'external'>('internal')
  const [departmentId, setDepartmentId] = useState('')
  const [providerId, setProviderId] = useState('')
  const [facility, setFacility] = useState('')
  const [externalDoctor, setExternalDoctor] = useState('')
  const [reason, setReason] = useState('')
  const [urgency, setUrgency] = useState<Urgency>('routine')
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const body = kind === 'internal'
      ? {
          kind, reason: reason.trim(), urgency,
          ...(departmentId ? { toDepartmentId: Number(departmentId) } : {}),
          ...(providerId ? { toProviderId: Number(providerId) } : {}),
        }
      : { kind, reason: reason.trim(), urgency, externalFacility: facility.trim(), ...(externalDoctor.trim() ? { externalDoctor: externalDoctor.trim() } : {}) }
    if (kind === 'internal' && !departmentId && !providerId) { setError('Choose a department or a doctor to refer to.'); return }
    setState('saving')
    const res = await sendJson(`/api/encounters/${encounterId}/referrals`, 'POST', body)
    if (!res.ok) { setState('idle'); setError(res.error); return }
    setState('saved')
    setReason(''); setFacility(''); setExternalDoctor(''); setDepartmentId(''); setProviderId('')
    router.refresh()
  }

  return (
    <form onSubmit={submit} className="space-y-3" aria-label="Referral">
      <fieldset className="flex gap-4 text-sm">
        <legend className="sr-only">Refer to</legend>
        <label className="flex items-center gap-1"><input type="radio" name="referral-kind" checked={kind === 'internal'} onChange={() => setKind('internal')} /> Within the hospital</label>
        <label className="flex items-center gap-1"><input type="radio" name="referral-kind" checked={kind === 'external'} onChange={() => setKind('external')} /> Outside facility</label>
      </fieldset>
      {kind === 'internal' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs font-medium text-muted-foreground">Department
            <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} className={FIELD}>
              <option value="">Any</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
          <label className="block text-xs font-medium text-muted-foreground">Doctor
            <select value={providerId} onChange={(e) => setProviderId(e.target.value)} className={FIELD}>
              <option value="">Any doctor in the department</option>
              {doctors.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.specialty}</option>)}
            </select>
          </label>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs font-medium text-muted-foreground">Facility
            <input type="text" required minLength={2} maxLength={200} value={facility} onChange={(e) => setFacility(e.target.value)} className={FIELD} />
          </label>
          <label className="block text-xs font-medium text-muted-foreground">Doctor (optional)
            <input type="text" maxLength={120} value={externalDoctor} onChange={(e) => setExternalDoctor(e.target.value)} className={FIELD} />
          </label>
        </div>
      )}
      <label className="block text-xs font-medium text-muted-foreground">Reason for referral
        <textarea required minLength={5} maxLength={1000} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} className={FIELD} />
      </label>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs font-medium text-muted-foreground">Urgency
          <select value={urgency} onChange={(e) => setUrgency(e.target.value as Urgency)} className={FIELD}>
            <option value="routine">Routine</option>
            <option value="urgent">Urgent</option>
            <option value="emergency">Emergency</option>
          </select>
        </label>
        <button type="submit" disabled={state === 'saving'} className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground disabled:opacity-50">
          {state === 'saving' ? 'Saving...' : 'Refer'}
        </button>
        {state === 'saved' && <span role="status" className="text-xs text-success">Referral saved</span>}
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </form>
  )
}
