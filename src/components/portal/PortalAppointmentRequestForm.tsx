'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { sendJson } from '@/lib/client-fetch'
import type { VisitMode } from '@/lib/queries/appointments' // WS7 T7

// Wave J (P1-20): the patient asks for a new visit. Nothing is booked here: the request goes
// to the hospital's booking queue and the front desk confirms a time.
const INPUT = 'h-11 w-full rounded-md border border-input bg-white px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary'
const LABEL = 'text-xs font-medium text-muted-foreground'

export function PortalAppointmentRequestForm({ providers, minDate, defaultStart, defaultEnd, defaultReason = '' }: {
  providers: { id: number; name: string; specialty: string }[]
  minDate: string
  defaultStart?: string
  defaultEnd?: string
  defaultReason?: string
}) {
  const router = useRouter()
  const [providerId, setProviderId] = useState('')
  const [visitMode, setVisitMode] = useState<VisitMode>('in_person') // WS7 T7
  const [start, setStart] = useState(defaultStart ?? minDate)
  const [end, setEnd] = useState(defaultEnd ?? defaultStart ?? minDate)
  const [reason, setReason] = useState(defaultReason)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const res = await sendJson('/api/patient-portal/appointment-requests', 'POST', {
      kind: 'new',
      preferredProviderId: providerId ? Number(providerId) : null,
      preferredDateRangeStart: start,
      preferredDateRangeEnd: end,
      reason: reason.trim(),
      visitMode, // WS7 T7
    })
    setBusy(false)
    if (!res.ok) { setError(res.error); return }
    setDone(true)
    router.refresh()
  }

  if (done) {
    return <p role="status" className="text-sm text-foreground">Request sent. The hospital will confirm a time with you.</p>
  }

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2" aria-label="Request an appointment">
      <label className="space-y-1 sm:col-span-2">
        <span className={LABEL}>Doctor (optional)</span>
        <select value={providerId} onChange={(e) => setProviderId(e.target.value)} className={INPUT}>
          <option value="">Any available doctor</option>
          {providers.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.specialty}</option>)}
        </select>
      </label>
      {/* WS7 T7 (spec D20): the patient says how they would like to be seen; staff confirm it. */}
      <fieldset className="space-y-1 sm:col-span-2">
        <legend className={LABEL}>How would you like to be seen?</legend>
        <div className="flex flex-wrap gap-4">
          {([['in_person', 'In person'], ['video', 'Video consultation']] as const).map(([value, label]) => (
            <label key={value} className="inline-flex min-h-11 items-center gap-2 text-sm text-foreground">
              <input type="radio" name="visitMode" value={value} checked={visitMode === value} onChange={() => setVisitMode(value)} className="h-4 w-4 accent-primary" />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="space-y-1">
        <span className={LABEL}>Earliest date</span>
        <input type="date" required min={minDate} value={start} onChange={(e) => { setStart(e.target.value); if (end < e.target.value) setEnd(e.target.value) }} className={INPUT} />
      </label>
      <label className="space-y-1">
        <span className={LABEL}>Latest date</span>
        <input type="date" required min={start || minDate} value={end} onChange={(e) => setEnd(e.target.value)} className={INPUT} />
      </label>
      <label className="space-y-1 sm:col-span-2">
        <span className={LABEL}>Reason for the visit</span>
        <input required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Follow-up for blood sugar" className={INPUT} />
      </label>
      {error && <p role="alert" className="text-sm text-destructive sm:col-span-2">{error}</p>}
      <div className="sm:col-span-2">
        <button type="submit" disabled={busy || !reason.trim() || !start || !end} className="inline-flex h-11 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90 disabled:opacity-50">
          {busy ? 'Sending…' : 'Send request'}
        </button>
      </div>
    </form>
  )
}
