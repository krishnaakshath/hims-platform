'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { sendJson } from '@/lib/client-fetch'

// Wave J (P1-20): ask to move or cancel one of the patient's own upcoming appointments.
// Both are requests to the front desk; the appointment stays as it is until they confirm.
const INPUT = 'h-10 rounded-md border border-input bg-white px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary'
const BTN = 'inline-flex min-h-10 items-center rounded-md px-3 text-sm font-medium'

export function PortalAppointmentActions({ appointmentId, minDate, label }: { appointmentId: number; minDate: string; label: string }) {
  const router = useRouter()
  const [mode, setMode] = useState<'idle' | 'reschedule' | 'cancel' | 'sent'>('idle')
  const [start, setStart] = useState(minDate)
  const [end, setEnd] = useState(minDate)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function send(body: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    const res = await sendJson('/api/patient-portal/appointment-requests', 'POST', { appointmentId, ...body })
    setBusy(false)
    if (!res.ok) { setError(res.error); return }
    setMode('sent')
    router.refresh()
  }

  if (mode === 'sent') return <p role="status" className="text-xs text-foreground">Request sent to the hospital.</p>
  if (mode === 'idle') {
    return (
      <div className="flex gap-2">
        <button type="button" onClick={() => setMode('reschedule')} className={`${BTN} text-primary hover:underline`}>Reschedule<span className="sr-only"> {label}</span></button>
        <button type="button" onClick={() => setMode('cancel')} className={`${BTN} text-destructive hover:underline`}>Cancel<span className="sr-only"> {label}</span></button>
      </div>
    )
  }
  return (
    <div className="mt-2 w-full space-y-2 rounded-lg border border-border bg-white p-3">
      {mode === 'reschedule' ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="space-y-1 text-xs text-muted-foreground">New earliest date
            <input type="date" aria-label="New earliest date" min={minDate} value={start} onChange={(e) => { setStart(e.target.value); if (end < e.target.value) setEnd(e.target.value) }} className={`${INPUT} block`} />
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">New latest date
            <input type="date" aria-label="New latest date" min={start} value={end} onChange={(e) => setEnd(e.target.value)} className={`${INPUT} block`} />
          </label>
          <button type="button" disabled={busy} onClick={() => send({ kind: 'reschedule', preferredDateRangeStart: start, preferredDateRangeEnd: end })} className={`${BTN} bg-primary text-primary-foreground disabled:opacity-50`}>Send reschedule request</button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-foreground">Ask the hospital to cancel this appointment?</p>
          <button type="button" disabled={busy} onClick={() => send({ kind: 'cancel' })} className={`${BTN} bg-destructive/10 text-destructive disabled:opacity-50`}>Send cancellation request</button>
        </div>
      )}
      <button type="button" onClick={() => { setMode('idle'); setError(null) }} className={`${BTN} text-muted-foreground hover:underline`}>Back</button>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
