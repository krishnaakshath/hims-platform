'use client'
import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface ProviderOption { id: number; name: string }
interface RoomOption { id: number; ward: string; roomNumber: string; bedNumber: string }

export function CheckInModal({ providers, rooms, onClose }: { providers: ProviderOption[]; rooms: RoomOption[]; onClose: () => void }) {
  const router = useRouter()
  const [patientId, setPatientId] = useState('')
  const [providerId, setProviderId] = useState<number | ''>('')
  const [visitType, setVisitType] = useState<'inpatient' | 'outpatient'>('outpatient')
  const [urgency, setUrgency] = useState<'routine' | 'urgent' | 'emergency'>('routine')
  const [reason, setReason] = useState('')
  const reasonHintId = useId()
  const [roomId, setRoomId] = useState<number | ''>('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [checkinResult, setCheckinResult] = useState<{
    queueTicketNumber: number
    patientId: string
    roomId: number | null
    checkedInAt: string
  } | null>(null)

  async function submit() {
    setSubmitting(true)
    setError(null)
    const res = await fetch('/api/front-desk/check-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patientId,
        providerId,
        visitType,
        urgency,
        reason,
        ...(visitType === 'inpatient' && roomId !== '' ? { roomId } : {}),
      }),
    })
    setSubmitting(false)
    if (res.ok) {
      const body = await res.json()
      setCheckinResult({
        queueTicketNumber: body.queueTicketNumber,
        patientId: body.patientId ?? patientId,
        roomId: body.roomId ?? null,
        checkedInAt: new Date().toLocaleString(),
      })
      router.refresh()
      return
    }
    const body = await res.json().catch(() => null)
    setError(body?.error ?? 'Could not check in this patient.')
  }

  const canSubmit = Boolean(patientId) && providerId !== '' && Boolean(reason) && (visitType === 'outpatient' || roomId !== '' || rooms.length === 0) && !submitting

  if (checkinResult !== null) {
    const room = rooms.find((r) => r.id === checkinResult.roomId)
    return (
      <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Check-in Ticket</DialogTitle>
          </DialogHeader>
          <div id="print-ticket" className="space-y-3 rounded-md border p-4 text-center">
            <p className="text-sm text-muted-foreground">Queue Number</p>
            <p className="text-5xl font-bold text-foreground">{checkinResult.queueTicketNumber}</p>
            <hr className="border-border" />
            <p className="text-sm text-muted-foreground">Patient</p>
            <p className="text-lg font-semibold text-foreground">{checkinResult.patientId}</p>
            {room && (
              <>
                <p className="text-sm text-muted-foreground">Room</p>
                <p className="text-lg font-semibold text-foreground">
                  {room.ward} — Room {room.roomNumber}, Bed {room.bedNumber}
                </p>
              </>
            )}
            <p className="text-sm text-muted-foreground">Date / Time</p>
            <p className="text-sm text-foreground">{checkinResult.checkedInAt}</p>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => window.print()}>Print</Button>
            <Button onClick={onClose}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Check In Patient</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <input value={patientId} onChange={(e) => setPatientId(e.target.value)} placeholder="Anonymous #, e.g. RD-0001" aria-label="Patient ID" className="w-full rounded-md border border-border px-3 py-2 text-sm" />

          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-1.5"><input type="radio" name="visitType" checked={visitType === 'outpatient'} onChange={() => setVisitType('outpatient')} aria-label="Outpatient" /> Outpatient</label>
            <label className="flex items-center gap-1.5"><input type="radio" name="visitType" checked={visitType === 'inpatient'} onChange={() => setVisitType('inpatient')} aria-label="Inpatient" /> Inpatient</label>
          </div>

          <select value={providerId} onChange={(e) => setProviderId(e.target.value === '' ? '' : Number(e.target.value))} aria-label="Assign to doctor" className="w-full rounded-md border border-border px-3 py-2 text-sm">
            <option value="">Assign to doctor…</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>

          <select value={urgency} onChange={(e) => setUrgency(e.target.value as typeof urgency)} aria-label="Urgency" className="w-full rounded-md border border-border px-3 py-2 text-sm">
            <option value="routine">Routine</option>
            <option value="urgent">Urgent</option>
            <option value="emergency">Emergency</option>
          </select>

          {visitType === 'inpatient' && (
            <select value={roomId} onChange={(e) => setRoomId(e.target.value === '' ? '' : Number(e.target.value))} aria-label="Room" className="w-full rounded-md border border-border px-3 py-2 text-sm">
              <option value="">Select a room…</option>
              {rooms.map((r) => <option key={r.id} value={r.id}>{r.ward} — Room {r.roomNumber}, Bed {r.bedNumber}</option>)}
            </select>
          )}
          {visitType === 'inpatient' && rooms.length === 0 && (
            <p className="text-sm text-warning">No rooms are currently available. You can still complete this check-in and assign a room once one frees up.</p>
          )}

          <div className="space-y-1">
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for visit" aria-label="Reason" aria-describedby={reasonHintId} maxLength={140} className="w-full rounded-md border border-border px-3 py-2 text-sm" />
            <p id={reasonHintId} className="text-xs text-muted-foreground">Shown to the patient in their visit confirmation — keep it brief and non-clinical.</p>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>Check In</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
