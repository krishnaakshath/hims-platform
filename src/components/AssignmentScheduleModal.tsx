'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { DoctorAssignmentRow } from '@/lib/queries/doctor-assignments'

export function AssignmentScheduleModalTrigger({ assignment }: { assignment: DoctorAssignmentRow }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>Review</Button>
      {open && <AssignmentScheduleModal assignment={assignment} onClose={() => setOpen(false)} />}
    </>
  )
}

function AssignmentScheduleModal({ assignment, onClose }: { assignment: DoctorAssignmentRow; onClose: () => void }) {
  const router = useRouter()
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [startTime, setStartTime] = useState('09:00')
  const [endTime, setEndTime] = useState('09:30')
  const [declineReason, setDeclineReason] = useState('')
  const [mode, setMode] = useState<'schedule' | 'decline'>('schedule')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submitSchedule() {
    setSubmitting(true)
    setError(null)
    const res = await fetch(`/api/front-desk/assignments/${assignment.id}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startsAt: `${date}T${startTime}:00`, endsAt: `${date}T${endTime}:00` }),
    })
    setSubmitting(false)
    if (res.ok) { router.refresh(); onClose(); return }
    const body = await res.json().catch(() => null)
    setError(body?.error ?? 'Could not schedule this visit.')
  }

  async function submitDecline() {
    setSubmitting(true)
    setError(null)
    const res = await fetch(`/api/front-desk/assignments/${assignment.id}/decline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: declineReason }),
    })
    setSubmitting(false)
    if (res.ok) { router.refresh(); onClose(); return }
    const body = await res.json().catch(() => null)
    setError(body?.error ?? 'Could not decline this assignment.')
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{assignment.reason}</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">{assignment.patientId} · {assignment.visitType} · {assignment.urgency}</p>

        {mode === 'schedule' ? (
          <div className="space-y-3">
            <input value={date} onChange={(e) => setDate(e.target.value)} type="date" aria-label="Appointment date" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
            <div className="flex gap-2">
              <input value={startTime} onChange={(e) => setStartTime(e.target.value)} type="time" aria-label="Start time" className="w-1/2 rounded-md border border-border px-3 py-2 text-sm" />
              <input value={endTime} onChange={(e) => setEndTime(e.target.value)} type="time" aria-label="End time" className="w-1/2 rounded-md border border-border px-3 py-2 text-sm" />
            </div>
            <button type="button" onClick={() => setMode('decline')} className="text-xs font-medium text-destructive hover:underline">I can&apos;t take this patient</button>
          </div>
        ) : (
          <div className="space-y-3">
            <textarea value={declineReason} onChange={(e) => setDeclineReason(e.target.value)} placeholder="Reason for declining" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
            <button type="button" onClick={() => setMode('schedule')} className="text-xs font-medium text-primary hover:underline">Back to scheduling</button>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          {mode === 'schedule'
            ? <Button onClick={submitSchedule} disabled={submitting}>Schedule</Button>
            : <Button variant="destructive" onClick={submitDecline} disabled={submitting || !declineReason}>Decline</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
