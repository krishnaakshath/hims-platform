'use client'
import { fetchJson, sendJson } from '@/lib/client-fetch'
import { useEffect, useId, useState } from 'react'
import { formatPaise, formatRupeesWhole } from '@/lib/money'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'
import { PatientPicker, type PickedPatient } from '@/components/PatientPicker'
import { AdmitPatientModal } from '@/components/inpatient/AdmitPatientModal'

export interface CheckInDoctor { id: number; name: string; departmentId: number | null }
export interface CheckInDepartment { id: number; name: string }
interface QueueRow { providerId: number; waiting: number; estimatedWaitMinutes: number | null; availability: 'available' | 'on_leave' | 'outside_hours' }

/** "3 waiting · ~30 min", "No one waiting", "On leave" or "Outside hours". */
function queueNote(q: QueueRow): string {
  if (q.availability === 'on_leave') return 'On leave'
  if (q.availability === 'outside_hours') return 'Outside hours'
  if (q.waiting === 0) return 'No one waiting'
  return q.estimatedWaitMinutes === null ? `${q.waiting} waiting` : `${q.waiting} waiting · ~${q.estimatedWaitMinutes} min`
}

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
//
// WS6 T9 (spec D6): the front desk picks the department, then one of its clinical doctors; each
// doctor option carries the queue from GET /api/front-desk/queue-summary ("3 waiting · ~30 min",
// "On leave", "Outside hours"; names alone if the summary cannot be loaded). Success also shows a
// "Token 12 issued" toast linking to the slip.
// WS3 T3: "Inpatient" no longer checks in: with a patient picked it opens the admission dialog
// (AdmitPatientModal, spec 3.1 item 1), which chooses the bed itself.
export function CheckInModal({ providers, departments, onClose, initialPatient = null }: { providers: CheckInDoctor[]; departments: CheckInDepartment[]; onClose: () => void; initialPatient?: PickedPatient | null }) {
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
    const res = await sendJson<{ queueTicketNumber?: number | null; opdToken?: number | null; encounterId?: number | null; patientId?: string; charges?: ChargeOutcome[] }>('/api/front-desk/check-in', 'POST', {
      patientId,
      providerId,
      visitType: 'outpatient',
      urgency,
      reason,
    })
    setSubmitting(false)
    if (res.ok) {
      const body = res.data
      const token = typeof body?.opdToken === 'number' ? body.opdToken : typeof body?.queueTicketNumber === 'number' ? body.queueTicketNumber : null
      const encounterId = typeof body?.encounterId === 'number' ? body.encounterId : null
      setCheckinResult({ token, patient, encounterId, charges: Array.isArray(body?.charges) ? body.charges : [] })
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

  const canSubmit = Boolean(patientId) && providerId !== '' && Boolean(reason) && visitType === 'outpatient' && !submitting

  if (visitType === 'inpatient' && patient) {
    return <AdmitPatientModal patient={patient} providers={providers} onClose={onClose} />
  }

  if (checkinResult !== null) {
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
            <p className="text-sm text-muted-foreground">Pick the patient to open the admission form.</p>
          )}

          <div className="space-y-1">
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for visit" aria-label="Reason" aria-describedby={reasonHintId} maxLength={140} className="w-full rounded-md border border-border px-3 py-2 text-sm" />
            <p id={reasonHintId} className="text-xs text-muted-foreground">Shown to the patient in their visit confirmation — keep it brief and non-clinical.</p>
          </div>
          {/* WS2 T9: the fee before submit */}
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
