'use client'
import { fetchJson, sendJson } from '@/lib/client-fetch'
import { useEffect, useId, useState } from 'react'
import { formatPaise, formatRupeesWhole } from '@/lib/money'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { PatientPicker, type PickedPatient } from '@/components/PatientPicker'

interface ProviderOption { id: number; name: string }
interface RoomOption { id: number; ward: string; roomNumber: string; bedNumber: string }

// WS2 T9: the fee preview (GET /api/front-desk/check-in/fee-preview) and the automatic charge
// outcomes the check-in returns.
interface FeePreview {
  registration: { itemName: string; amountPaise: number } | null
  consultation: { itemName: string; amountPaise: number } | null
  note: 'no_rate' | 'no_department' | 'free_review' | 'inpatient' | null
}
type ChargeOutcome =
  | { ok: true; source: string; lineId: number; itemName: string; taxablePaise: number; billTo: 'self' | 'payer'; existing: boolean }
  | { ok: false; source: string; reason: string; rules?: string[] }

const fee = (paise: number) => (paise % 100 === 0 ? formatRupeesWhole(paise / 100) : formatPaise(paise))
const SOURCE_LABEL: Record<string, string> = { consultation: 'Consultation', registration: 'Registration', lab_order: 'Lab test', procedure: 'Procedure' }
const REASON_LABEL: Record<string, string> = {
  price_unresolved: 'no rate', no_service: 'no service set up', blocked: 'a billing rule blocked it', no_context: 'visit not found', context_cancelled: 'visit cancelled',
}
const NOTE_LABEL: Record<NonNullable<FeePreview['note']>, string> = {
  no_rate: 'No consultation rate is set for this department; billing will add the charge.',
  no_department: 'This doctor has no department, so no consultation fee is charged automatically.',
  free_review: 'Free review visit: no consultation fee.',
  inpatient: 'Inpatient charges are added by billing.',
}

function previewText(p: FeePreview): string | null {
  const parts = [
    p.consultation ? `Consultation ${fee(p.consultation.amountPaise)}` : null,
    p.registration ? `Registration ${fee(p.registration.amountPaise)} (first visit)` : null,
  ].filter((x): x is string => x !== null)
  return parts.length > 0 ? parts.join(' · ') : null
}

// Wave C P0-04 / P1-14: the patient is chosen in the PatientPicker (name,
// UHID, mobile or chart id) -- or preselected from the patient page -- and
// the route still receives the chart id. After check-in the ticket shows the
// token, name and UHID and links to the printable 80 mm slip
// (/print/token/[encounterId]) instead of printing the whole page.
export function CheckInModal({ providers, rooms, onClose, initialPatient = null }: { providers: ProviderOption[]; rooms: RoomOption[]; onClose: () => void; initialPatient?: PickedPatient | null }) {
  const router = useRouter()
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
  const [checkinResult, setCheckinResult] = useState<{
    token: number | null
    patient: PickedPatient
    roomId: number | null
    encounterId: number | null
    charges: ChargeOutcome[]
  } | null>(null)

  // WS2 T9: what this check-in will charge, refreshed as the form changes (outpatient only).
  const [preview, setPreview] = useState<FeePreview | null>(null)
  useEffect(() => {
    if (!patientId || providerId === '' || visitType !== 'outpatient') return
    let live = true
    const q = new URLSearchParams({ patientId, providerId: String(providerId), visitType, urgency })
    void fetchJson<FeePreview>(`/api/front-desk/check-in/fee-preview?${q.toString()}`).then((r) => {
      if (live) setPreview(r.ok ? r.data : null)
    })
    return () => { live = false; setPreview(null) }
  }, [patientId, providerId, visitType, urgency])

  async function submit() {
    if (!patient) return
    setSubmitting(true)
    setError(null)
    const res = await sendJson<{ queueTicketNumber?: number | null; opdToken?: number | null; encounterId?: number | null; patientId?: string; roomId?: number | null; charges?: ChargeOutcome[] }>('/api/front-desk/check-in', 'POST', {
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
      setCheckinResult({
        token: typeof body?.opdToken === 'number' ? body.opdToken : typeof body?.queueTicketNumber === 'number' ? body.queueTicketNumber : null,
        patient,
        roomId: body?.roomId ?? null,
        encounterId: typeof body?.encounterId === 'number' ? body.encounterId : null,
        charges: Array.isArray(body?.charges) ? body.charges : [],
      })
      router.refresh()
      return
    }
    setError(res.error)
  }

  const canSubmit = Boolean(patientId) && providerId !== '' && Boolean(reason) && (visitType === 'outpatient' || roomId !== '' || rooms.length === 0) && !submitting

  if (checkinResult !== null) {
    const room = rooms.find((r) => r.id === checkinResult.roomId)
    // WS2 T9: what to collect now: the new self-pay lines this check-in captured.
    const collectPaise = checkinResult.charges.reduce((sum, c) => (c.ok && !c.existing && c.billTo === 'self' ? sum + c.taxablePaise : sum), 0)
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
          {checkinResult.charges.length > 0 && (
            <div className="space-y-1 rounded-md border p-3 text-sm" aria-label="Charges">
              <p className="font-medium text-foreground">Charges</p>
              <ul className="space-y-1">
                {checkinResult.charges.map((c, i) => c.ok ? (
                  <li key={i} className="flex justify-between gap-3">
                    <span>{c.itemName}</span>
                    <span className="tabular-nums">{fee(c.taxablePaise)}{c.billTo === 'payer' ? ' (payer)' : ''}</span>
                  </li>
                ) : (
                  <li key={i} className="text-warning">{SOURCE_LABEL[c.source] ?? c.source} not billed: {REASON_LABEL[c.reason] ?? c.reason}</li>
                ))}
              </ul>
            </div>
          )}
          <DialogFooter className="gap-2 sm:gap-0">
            {collectPaise > 0 && (
              <a
                href={`/cash-desk?patientId=${encodeURIComponent(checkinResult.patient.id)}&amountPaise=${collectPaise}`}
                className="inline-flex items-center justify-center rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary"
              >
                Collect now
              </a>
            )}
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
          {/* WS2 T9: the fee before submit */}
          {visitType === 'inpatient' && patientId && providerId !== '' && (
            <p className="text-sm text-muted-foreground">{NOTE_LABEL.inpatient}</p>
          )}
          {visitType === 'outpatient' && preview && (previewText(preview) || preview.note) && (
            <div className="space-y-0.5 text-sm" aria-live="polite">
              {previewText(preview) && <p className="font-medium text-foreground">{previewText(preview)}</p>}
              {preview.note && <p className="text-muted-foreground">{NOTE_LABEL[preview.note]}</p>}
            </div>
          )}
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
