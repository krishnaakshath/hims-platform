'use client'
import { sendJson } from '@/lib/client-fetch'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { BookingRequestRow } from '@/lib/queries/booking-requests'
import { normalizeVisitReason, VISIT_REASON_MAX_LENGTH } from '@/lib/notification-templates'
import { PatientPicker, type PickedPatient } from '@/components/PatientPicker'
import { todayIsoIn } from '@/lib/india-time'
import { SlotPicker, type SlotValue } from '@/components/scheduling/SlotPicker'
import { defaultBookingDate } from '@/lib/scheduling/default-booking-date'

interface ProviderOption {
  id: number
  name: string
}

// WS6 T7: `initialPatient` is the patient just registered from this request.
export function ConfirmBookingRequestModal({ request, providers, onClose, initialPatient = null }: {
  request: BookingRequestRow
  providers: ProviderOption[]
  onClose: () => void
  initialPatient?: PickedPatient | null
}) {
  const router = useRouter()
  // Wave C P0-04: found by name, UHID or mobile; the route gets the chart id.
  // Wave J: a portal request is already named to its patient; the picker is not offered.
  const portalPatient = request.patientId ? { id: request.patientId, name: request.requesterName, uhid: null } : null
  const [patient, setPatient] = useState<PickedPatient | null>(portalPatient ?? initialPatient)
  const patientId = patient?.id ?? ''
  const [providerId, setProviderId] = useState<number | ''>(request.preferredProviderId ?? '')
  // WS6 T7: never a past date; the time comes from the doctor's slots (or a typed time).
  const [today] = useState(() => todayIsoIn())
  const [date, setDate] = useState(() => defaultBookingDate(request.preferredDateRangeStart, request.preferredDateRangeEnd, today))
  const [slot, setSlot] = useState<SlotValue | null>(null)
  // The public request reason allows far more than the 140 chars the confirm
  // route accepts for a (patient-visible) visit reason; prefill a normalized,
  // capped version that staff can edit.
  const [visitReason, setVisitReason] = useState(() => normalizeVisitReason(request.reason))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!slot) return
    setSubmitting(true)
    setError(null)
    const res = await sendJson(`/api/booking-requests/${request.id}/confirm`, 'PATCH', {
      patientId,
      providerId,
      // Explicit-offset instants from the slot picker; the server rejects naive times.
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      visitReason,
      ...(slot.outsideHours ? { outsideHoursConfirmed: true } : {}),
    })
    setSubmitting(false)
    if (res.ok) { router.refresh(); onClose(); return }
    setError(res.error)
  }

  const canSubmit = Boolean(patientId) && providerId !== '' && Boolean(date) && slot !== null && Boolean(visitReason) && !submitting

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
              <p className="text-xs text-muted-foreground">If {request.requesterName} is a genuinely new patient, close this and use Register from this request, or find them here by name, UHID or mobile.</p>
            </>
          )}
          <select value={providerId} onChange={(e) => setProviderId(e.target.value === '' ? '' : Number(e.target.value))} aria-label="Provider" className="w-full rounded-md border border-border px-3 py-2 text-sm">
            <option value="">Select a provider…</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input value={date} min={today} onChange={(e) => setDate(e.target.value)} type="date" aria-label="Appointment date" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          {providerId !== '' && date && <SlotPicker providerId={providerId} date={date} value={slot} onChange={setSlot} allowCustom />}
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
