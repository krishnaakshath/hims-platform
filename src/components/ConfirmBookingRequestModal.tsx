'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { BookingRequestRow } from '@/lib/queries/booking-requests'
import { normalizeVisitReason, VISIT_REASON_MAX_LENGTH } from '@/lib/notification-templates'

interface ProviderOption {
  id: number
  name: string
}

export function ConfirmBookingRequestModal({ request, providers, onClose }: {
  request: BookingRequestRow
  providers: ProviderOption[]
  onClose: () => void
}) {
  const router = useRouter()
  const [patientId, setPatientId] = useState('')
  const [providerId, setProviderId] = useState<number | ''>(request.preferredProviderId ?? '')
  const [date, setDate] = useState(request.preferredDateRangeStart)
  const [startTime, setStartTime] = useState('09:00')
  const [endTime, setEndTime] = useState('09:30')
  // The public request reason allows far more than the 140 chars the confirm
  // route accepts for a (patient-visible) visit reason; prefill a normalized,
  // capped version that staff can edit.
  const [visitReason, setVisitReason] = useState(() => normalizeVisitReason(request.reason))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setSubmitting(true)
    setError(null)
    const res = await fetch(`/api/booking-requests/${request.id}/confirm`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patientId,
        providerId,
        startsAt: `${date}T${startTime}:00`,
        endsAt: `${date}T${endTime}:00`,
        visitReason,
      }),
    })
    setSubmitting(false)
    if (res.ok) { router.refresh(); onClose(); return }
    const body = await res.json().catch(() => null)
    setError(body?.error ?? 'Could not confirm this booking request.')
  }

  const canSubmit = Boolean(patientId) && providerId !== '' && Boolean(date) && Boolean(startTime) && Boolean(endTime) && Boolean(visitReason) && !submitting

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Confirm Booking Request</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">{request.requesterName} · requested {request.preferredDateRangeStart} to {request.preferredDateRangeEnd}</p>
          <input value={patientId} onChange={(e) => setPatientId(e.target.value)} placeholder="Anonymous #, e.g. RD-0001" aria-label="Patient ID" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          <p className="text-xs text-muted-foreground">If {request.requesterName} is a genuinely new patient, add them via the Add Client flow first, then confirm this request against their new patient ID.</p>
          <select value={providerId} onChange={(e) => setProviderId(e.target.value === '' ? '' : Number(e.target.value))} aria-label="Provider" className="w-full rounded-md border border-border px-3 py-2 text-sm">
            <option value="">Select a provider…</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input value={date} onChange={(e) => setDate(e.target.value)} type="date" aria-label="Appointment date" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          <div className="flex gap-2">
            <input value={startTime} onChange={(e) => setStartTime(e.target.value)} type="time" aria-label="Start time" className="w-1/2 rounded-md border border-border px-3 py-2 text-sm" />
            <input value={endTime} onChange={(e) => setEndTime(e.target.value)} type="time" aria-label="End time" className="w-1/2 rounded-md border border-border px-3 py-2 text-sm" />
          </div>
          <input value={visitReason} onChange={(e) => setVisitReason(e.target.value)} placeholder="Visit reason" aria-label="Visit reason" maxLength={VISIT_REASON_MAX_LENGTH} className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>Confirm</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
