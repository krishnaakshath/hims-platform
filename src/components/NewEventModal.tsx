'use client'
import { sendJson } from '@/lib/client-fetch'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { VISIT_REASON_MAX_LENGTH } from '@/lib/notification-templates'
import { PatientPicker, type PickedPatient } from '@/components/PatientPicker'
import { todayIsoIn } from '@/lib/india-time'
import { SlotPicker, type SlotValue } from '@/components/scheduling/SlotPicker'
import { defaultBookingDate } from '@/lib/scheduling/default-booking-date'

interface ProviderOption {
  id: number
  name: string
}

// Wave C P0-04: the patient comes from the PatientPicker (name, UHID,
// mobile) or is preselected (calendar ?book=<chart id>) -- the page no longer
// ships the whole patient list to the client.
export function NewEventModal({ providers, defaultDate, onClose, initialPatient = null }: {
  providers: ProviderOption[]
  defaultDate: string
  onClose: () => void
  initialPatient?: PickedPatient | null
}) {
  const router = useRouter()
  const [patient, setPatient] = useState<PickedPatient | null>(initialPatient)
  const patientId = patient?.id ?? ''
  const [providerId, setProviderId] = useState<number | ''>('')
  // WS6 T7: never a past date; the time comes from the doctor's slots (or a typed time).
  const [today] = useState(() => todayIsoIn())
  const [date, setDate] = useState(() => defaultBookingDate(defaultDate, defaultDate, today))
  const [slot, setSlot] = useState<SlotValue | null>(null)
  const [visitReason, setVisitReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!slot) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await sendJson('/api/appointments', 'POST', {
        patientId,
        providerId,
        // Explicit-offset instants from the slot picker; the server rejects naive times.
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        visitReason,
        ...(slot.outsideHours ? { outsideHoursConfirmed: true } : {}),
      })
      if (res.ok) {
        router.refresh()
        onClose()
        return
      }
      setError(res.error)
    } catch {
      setError('Could not reach the server. Please check your connection and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const canSubmit = Boolean(patientId) && providerId !== '' && Boolean(date) && slot !== null && Boolean(visitReason) && !submitting

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New Event</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <PatientPicker value={patient} onChange={setPatient} />
          <select value={providerId} onChange={(e) => setProviderId(e.target.value === '' ? '' : Number(e.target.value))} aria-label="Doctor" className="w-full rounded-md border border-border px-3 py-2 text-sm">
            <option value="">Select a doctor…</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input value={date} min={today} onChange={(e) => setDate(e.target.value)} type="date" aria-label="Appointment date" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          {providerId !== '' && date && <SlotPicker providerId={providerId} date={date} value={slot} onChange={setSlot} allowCustom />}
          <input value={visitReason} onChange={(e) => setVisitReason(e.target.value)} placeholder="Visit reason" maxLength={VISIT_REASON_MAX_LENGTH} className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
