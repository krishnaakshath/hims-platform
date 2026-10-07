'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { VISIT_REASON_MAX_LENGTH } from '@/lib/notification-templates'
import { PatientPicker, type PickedPatient } from '@/components/PatientPicker'

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
  const [date, setDate] = useState(defaultDate)
  const [startTime, setStartTime] = useState('09:00')
  const [endTime, setEndTime] = useState('09:30')
  const [visitReason, setVisitReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/appointments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          patientId,
          providerId,
          startsAt: `${date}T${startTime}:00`,
          endsAt: `${date}T${endTime}:00`,
          visitReason,
        }),
      })
      if (res.ok) {
        router.refresh()
        onClose()
        return
      }
      const body = await res.json().catch(() => null)
      setError(body?.error ?? 'Could not schedule the appointment.')
    } catch {
      setError('Could not reach the server. Please check your connection and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const canSubmit = Boolean(patientId) && providerId !== '' && Boolean(date) && Boolean(startTime) && Boolean(endTime) && Boolean(visitReason) && !submitting

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New Event</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <PatientPicker value={patient} onChange={setPatient} />
          <select aria-label="Provider" value={providerId} onChange={(e) => setProviderId(e.target.value === '' ? '' : Number(e.target.value))} className="w-full rounded-md border border-border px-3 py-2 text-sm">
            <option value="">Select a provider…</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input value={date} onChange={(e) => setDate(e.target.value)} type="date" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          <div className="flex gap-2">
            <input value={startTime} onChange={(e) => setStartTime(e.target.value)} type="time" className="w-1/2 rounded-md border border-border px-3 py-2 text-sm" />
            <input value={endTime} onChange={(e) => setEndTime(e.target.value)} type="time" className="w-1/2 rounded-md border border-border px-3 py-2 text-sm" />
          </div>
          <input value={visitReason} onChange={(e) => setVisitReason(e.target.value)} placeholder="Visit reason" maxLength={VISIT_REASON_MAX_LENGTH} className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
