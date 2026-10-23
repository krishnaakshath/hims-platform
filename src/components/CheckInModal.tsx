'use client'
import { sendJson } from '@/lib/client-fetch'
import { useEffect, useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'
import { PatientPicker, type PickedPatient } from '@/components/PatientPicker'

export interface CheckInDoctor { id: number; name: string; departmentId: number | null }
export interface CheckInDepartment { id: number; name: string }
interface RoomOption { id: number; ward: string; roomNumber: string; bedNumber: string }
interface QueueRow { providerId: number; waiting: number; estimatedWaitMinutes: number | null; availability: 'available' | 'on_leave' | 'outside_hours' }

/** "3 waiting · ~30 min", "No one waiting", "On leave" or "Outside hours". */
function queueNote(q: QueueRow): string {
  if (q.availability === 'on_leave') return 'On leave'
  if (q.availability === 'outside_hours') return 'Outside hours'
  if (q.waiting === 0) return 'No one waiting'
  return q.estimatedWaitMinutes === null ? `${q.waiting} waiting` : `${q.waiting} waiting · ~${q.estimatedWaitMinutes} min`
}

// Wave C P0-04 / P1-14: the patient is chosen in the PatientPicker (name,
// UHID, mobile or chart id) -- or preselected from the patient page -- and
// the route still receives the chart id. After check-in the ticket shows the
// token, name and UHID and links to the printable 80 mm slip
// (/print/token/[encounterId]) instead of printing the whole page.
//
// WS6 T9 (spec D6): the front desk picks the department, then one of its clinical doctors; each
// doctor option carries the queue from GET /api/front-desk/queue-summary ("3 waiting · ~30 min",
// "On leave", "Outside hours"; names alone if the summary cannot be loaded). Success also shows a
// "Token 12 issued" toast linking to the slip. Inpatient check-in is otherwise unchanged.
export function CheckInModal({ providers, departments, rooms, onClose, initialPatient = null }: { providers: CheckInDoctor[]; departments: CheckInDepartment[]; rooms: RoomOption[]; onClose: () => void; initialPatient?: PickedPatient | null }) {
  const router = useRouter()
  const toast = useToast()
  const [departmentId, setDepartmentId] = useState<number | ''>('')
  const [queue, setQueue] = useState<Map<number, QueueRow>>(new Map())
  const [patient, setPatient] = useState<PickedPatient | null>(initialPatient)
  const patientId = patient?.id ?? ''
  const [providerId, setProviderId] = useState<number | ''>('')
  const [visitType, setVisitType] = useState<'inpatient' | 'outpatient'>('outpatient')
  const [urgency, setUrgency] = useState<'routine' | 'urgent' | 'emergency'>('routine')
  const [reason, setReason] = useState('')
  const reasonHintId = useId()
  const [roomId, setRoomId] = useState<number | ''>('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    fetch('/api/front-desk/queue-summary', { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) return
        const rows = ((await res.json()) as { providers?: unknown })?.providers
        if (live && Array.isArray(rows)) setQueue(new Map((rows as QueueRow[]).map((r) => [r.providerId, r])))
      })
      .catch(() => { /* the doctors are still listed by name */ })
    return () => { live = false }
  }, [])

  const departmentDoctors = departmentId === '' ? [] : providers.filter((p) => p.departmentId === departmentId)
  const [checkinResult, setCheckinResult] = useState<{
    token: number | null
    patient: PickedPatient
    roomId: number | null
    encounterId: number | null
  } | null>(null)

  async function submit() {
    if (!patient) return
    setSubmitting(true)
    setError(null)
    const res = await sendJson<{ queueTicketNumber?: number | null; opdToken?: number | null; encounterId?: number | null; patientId?: string; roomId?: number | null }>('/api/front-desk/check-in', 'POST', {
      patientId,
      providerId,
      visitType,
      urgency,
      reason,
      ...(visitType === 'inpatient' && roomId !== '' ? { roomId } : {}),
    })
    setSubmitting(false)
    if (res.ok) {
      const body = res.data
      const token = typeof body?.opdToken === 'number' ? body.opdToken : typeof body?.queueTicketNumber === 'number' ? body.queueTicketNumber : null
      const encounterId = typeof body?.encounterId === 'number' ? body.encounterId : null
      setCheckinResult({ token, patient, roomId: body?.roomId ?? null, encounterId })
      toast.show({
        title: token !== null ? `Token ${token} issued` : 'Patient checked in',
        description: providers.find((p) => p.id === providerId)?.name,
        ...(encounterId !== null ? { action: { label: 'Print token slip', href: `/print/token/${encounterId}` } } : {}),
      })
      router.refresh()
      return
    }
    setError(res.error)
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
          <div className="space-y-3 rounded-md border p-4 text-center" role="status">
            <p className="text-sm text-muted-foreground">Token</p>
            <p className="text-5xl font-bold text-foreground">{checkinResult.token ?? '—'}</p>
            <hr className="border-border" />
            <p className="text-sm text-muted-foreground">Patient</p>
            <p className="text-lg font-semibold text-foreground">{checkinResult.patient.name}</p>
            <p className="font-mono text-xs text-muted-foreground">{checkinResult.patient.uhid ? `UHID ${checkinResult.patient.uhid}` : `Chart ID ${checkinResult.patient.id}`}</p>
            {room && (
              <>
                <p className="text-sm text-muted-foreground">Room</p>
                <p className="text-lg font-semibold text-foreground">
                  {room.ward} — Room {room.roomNumber}, Bed {room.bedNumber}
                </p>
              </>
            )}
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            {checkinResult.encounterId !== null && (
              <a
                href={`/print/token/${checkinResult.encounterId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary"
              >
                Print token slip
              </a>
            )}
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
          <PatientPicker value={patient} onChange={setPatient} autoFocus={!initialPatient} />

          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-1.5"><input type="radio" name="visitType" checked={visitType === 'outpatient'} onChange={() => setVisitType('outpatient')} aria-label="Outpatient" /> Outpatient</label>
            <label className="flex items-center gap-1.5"><input type="radio" name="visitType" checked={visitType === 'inpatient'} onChange={() => setVisitType('inpatient')} aria-label="Inpatient" /> Inpatient</label>
          </div>

          <select
            value={departmentId}
            onChange={(e) => { setDepartmentId(e.target.value === '' ? '' : Number(e.target.value)); setProviderId('') }}
            aria-label="Department"
            className="w-full rounded-md border border-border px-3 py-2 text-sm"
          >
            <option value="">Choose a department…</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>

          <select value={providerId} onChange={(e) => setProviderId(e.target.value === '' ? '' : Number(e.target.value))} disabled={departmentId === ''} aria-label="Assign to doctor" className="w-full rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50">
            <option value="">Assign to doctor…</option>
            {departmentDoctors.map((p) => {
              const q = queue.get(p.id)
              return <option key={p.id} value={p.id}>{q ? `${p.name} — ${queueNote(q)}` : p.name}</option>
            })}
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
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>Check In</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
