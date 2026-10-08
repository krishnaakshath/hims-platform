'use client'
import { sendJson } from '@/lib/client-fetch'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { BookingRequestRow } from '@/lib/queries/booking-requests'
import { normalizeVisitReason, VISIT_REASON_MAX_LENGTH } from '@/lib/notification-templates'
import { PatientPicker, type PickedPatient } from '@/components/PatientPicker'
import { istSlotString } from '@/lib/india-time'

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
  // Wave C P0-04: found by name, UHID or mobile; the route gets the chart id.
  // Wave J: a portal request is already named to its patient; the picker is not offered.
  const portalPatient = request.patientId ? { id: request.patientId, name: request.requesterName, uhid: null } : null
  const [patient, setPatient] = useState<PickedPatient | null>(portalPatient)
  const patientId = patient?.id ?? ''
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
    const res = await sendJson(`/api/booking-requests/${request.id}/confirm`, 'PATCH', {
      patientId,
      providerId,
      // IST wall-clock time with an explicit offset; the server rejects naive times.
      startsAt: istSlotString(date, startTime),
      endsAt: istSlotString(date, endTime),
      visitReason,
    })
    setSubmitting(false)
    if (res.ok) { router.refresh(); onClose(); return }
    setError(res.error)
  }

  const canSubmit = Boolean(patientId) && providerId !== '' && Boolean(date) && Boolean(startTime) && Boolean(endTime) && Boolean(visitReason) && !submitting

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{request.requestKind === 'reschedule' ? 'Confirm Reschedule Request' : 'Confirm Booking Request'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">{request.requesterName} · requested {request.preferredDateRangeStart} to {request.preferredDateRangeEnd}</p>
          {portalPatient ? (
            <p className="text-sm text-foreground">
              Patient: <span className="font-medium">{portalPatient.name}</span> (requested from the patient portal)
              {request.requestKind === 'reschedule' && <span className="block text-xs text-muted-foreground">Confirming books the new time and cancels appointment #{request.appointmentId}.</span>}
            </p>
          ) : (
            <>
              <PatientPicker value={patient} onChange={setPatient} />
              <p className="text-xs text-muted-foreground">If {request.requesterName} is a genuinely new patient, register them with Add Patient first, then find them here by name, UHID or mobile.</p>
            </>
          )}
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
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>Confirm</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
