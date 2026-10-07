'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { VISIT_REASON_MAX_LENGTH } from '@/lib/notification-templates'
import { istSlotString } from '@/lib/india-time'

interface PatientOption {
  id: string
  name: string
}

interface ProviderOption {
  id: number
  name: string
}

export function NewEventModal({ patients, providers, defaultDate, onClose }: {
  patients: PatientOption[]
  providers: ProviderOption[]
  defaultDate: string
  onClose: () => void
}) {
  const router = useRouter()
  const [patientId, setPatientId] = useState('')
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
          // IST wall-clock time with an explicit offset; the server rejects naive times.
          startsAt: istSlotString(date, startTime),
          endsAt: istSlotString(date, endTime),
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
          <select value={patientId} onChange={(e) => setPatientId(e.target.value)} aria-label="Patient" className="w-full rounded-md border border-border px-3 py-2 text-sm">
            <option value="">Select a patient…</option>
            {patients.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.id})</option>)}
          </select>
          <select value={providerId} onChange={(e) => setProviderId(e.target.value === '' ? '' : Number(e.target.value))} aria-label="Doctor" className="w-full rounded-md border border-border px-3 py-2 text-sm">
            <option value="">Select a doctor…</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input value={date} onChange={(e) => setDate(e.target.value)} type="date" aria-label="Appointment date" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          <div className="flex gap-2">
            <input value={startTime} onChange={(e) => setStartTime(e.target.value)} type="time" aria-label="Start time (IST)" className="w-1/2 rounded-md border border-border px-3 py-2 text-sm" />
            <input value={endTime} onChange={(e) => setEndTime(e.target.value)} type="time" aria-label="End time (IST)" className="w-1/2 rounded-md border border-border px-3 py-2 text-sm" />
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
