'use client'
import { sendJson } from '@/lib/client-fetch'
import { formatIstDateTime } from '@/lib/india-time'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { PatientPicker, type PickedPatient } from '@/components/PatientPicker'
import { AdmitPatientModal } from '@/components/inpatient/AdmitPatientModal'
import { TransferAdmissionModal } from '@/components/TransferAdmissionModal'
import { DischargeAdmissionModal } from '@/components/DischargeAdmissionModal'
import { MedicationAdministrationPanel } from '@/components/MedicationAdministrationPanel'
import { formatPaise, formatRupeesWhole } from '@/lib/money'
import type { PatientGender, WardGender } from '@/lib/inpatient/admission-rules'

export interface BoardRoom {
  id: number
  ward: string
  roomNumber: string
  bedNumber: string
  status: 'available' | 'occupied' | 'dirty' | 'blocked'
  blockedReason: string | null
  occupantName: string | null
  occupantPatientId: string | null
  attendingProviderName: string | null
  admittedAt: Date | null
  // WS3 T4 (spec 3.2 item 12). `occupantPatientId` is only used for the patient link, never shown.
  admissionId: number | null
  occupantUhid: string | null
  occupantGender: PatientGender
  genderRestriction: WardGender
  roomCategoryName: string | null
  bedTariffPaise: number | null
  daysStayed: number | null
  wardGenderOverride: boolean
}

interface RoomOption { id: number; ward: string; roomNumber: string; bedNumber: string }
type BedAction = { kind: 'transfer' | 'discharge' | 'mar'; admissionId: number }

const perDay = (paise: number) => `${paise % 100 === 0 ? formatRupeesWhole(paise / 100) : formatPaise(paise)}/day`
const GENDER_LABELS: Record<'male' | 'female', string> = { male: 'Male ward', female: 'Female ward' }

const STATUS_STYLES: Record<BoardRoom['status'], string> = {
  available: 'border-emerald-600/30 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400',
  occupied: 'border-primary/30 bg-primary/10 text-primary',
  dirty: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  blocked: 'border-destructive/30 bg-destructive/10 text-destructive',
}

const STATUS_LABELS: Record<BoardRoom['status'], string> = {
  available: 'Available',
  occupied: 'Occupied',
  dirty: 'Needs cleaning',
  blocked: 'Blocked',
}

// Grouped-grid-with-persistent-legend layout, following Deputy's Schedule
// grid (https://mobbin.com/screens/42d9229d-2df6-4245-a3c1-0802e8c89350):
// rows grouped by area (here, ward) with color-coded cells, and a fixed
// bottom legend mapping every color to its label -- status is never shown
// by color alone.
// WS3 T3: `canAdmit` (ADMISSION_ROLES) adds "Admit here" on a free bed: pick the patient, then the
// admission dialog opens with that bed preselected. `providers` are the attending choices.
// WS3 T4: an occupied bed's panel shows UHID, days stayed and the bed tariff, with Transfer
// (`canTransfer`, the transfer route's roles), Discharge (`canDischarge`, DISCHARGE_ROLES), MAR
// (`canManageMedications`, the medication routes' roles) and Charges (`canCaptureCharges`,
// CHARGE_CAPTURE_ROLES), each reusing the existing modal. `canSetBedGender` (MASTER_DATA_ADMIN_ROLES)
// edits a bed's ward-gender restriction.
export function BedBoard({
  rooms, availableRooms, providers = [], canManageFacilities, canBlock, canAdmit,
  canTransfer, canDischarge, canManageMedications, canCaptureCharges, canSetBedGender = false,
}: {
  rooms: BoardRoom[]; availableRooms: RoomOption[]; providers?: { id: number; name: string }[]
  canManageFacilities: boolean; canBlock: boolean; canAdmit: boolean
  canTransfer: boolean; canDischarge: boolean; canManageMedications: boolean; canCaptureCharges: boolean; canSetBedGender?: boolean
}) {
  const router = useRouter()
  const [selected, setSelected] = useState<BoardRoom | null>(null)
  const [blockReason, setBlockReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [admitPatient, setAdmitPatient] = useState<PickedPatient | null>(null)
  const [admitting, setAdmitting] = useState<{ patient: PickedPatient; roomId: number } | null>(null)
  const [action, setAction] = useState<BedAction | null>(null)
  const [bedGender, setBedGender] = useState<'male' | 'female' | 'mixed'>('mixed')

  function openAction(kind: BedAction['kind'], admissionId: number) {
    setSelected(null)
    setAction({ kind, admissionId })
  }

  const wards = Array.from(new Set(rooms.map((r) => r.ward))).sort()

  async function callAction(path: string, body?: object, method: 'POST' | 'PATCH' = 'POST') {
    setBusy(true)
    setError(null)
    const res = await sendJson(path, method, body)
    setBusy(false)
    if (!res.ok) {
      setError(res.error)
      return false
    }
    router.refresh()
    setSelected(null)
    return true
  }

  return (
    <div className="space-y-6">
      {wards.map((ward) => (
        <div key={ward}>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{ward}</h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
            {rooms.filter((r) => r.ward === ward).map((r) => (
              <button
                key={r.id}
                onClick={() => { setSelected(r); setBlockReason(''); setError(null); setAdmitPatient(null); setBedGender(r.genderRestriction ?? 'mixed') }}
                className={`rounded-lg border p-3 text-left text-xs transition-colors hover:opacity-80 ${STATUS_STYLES[r.status]}`}
              >
                <p className="font-semibold">Room {r.roomNumber} · Bed {r.bedNumber}</p>
                <p className="mt-1">{STATUS_LABELS[r.status]}</p>
                {r.occupantName && <p className="mt-1 truncate opacity-80">{r.occupantName}</p>}
                {(r.daysStayed !== null || r.bedTariffPaise !== null) && (
                  <p className="mt-1 opacity-80">{[r.daysStayed !== null ? `Day ${r.daysStayed}` : null, r.bedTariffPaise !== null ? perDay(r.bedTariffPaise) : null].filter(Boolean).join(' · ')}</p>
                )}
                {r.genderRestriction && <p className="mt-1 opacity-80">{GENDER_LABELS[r.genderRestriction]}</p>}
                {r.wardGenderOverride && <p className="mt-1 font-medium text-warning">Gender override</p>}
              </button>
            ))}
          </div>
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-4 rounded-lg border border-border bg-secondary/40 p-3 text-xs">
        {(Object.keys(STATUS_LABELS) as BoardRoom['status'][]).map((s) => (
          <span key={s} className="flex items-center gap-1.5">
            <span className={`h-2.5 w-2.5 rounded-full border ${STATUS_STYLES[s]}`} aria-hidden="true" />
            {STATUS_LABELS[s]}
          </span>
        ))}
      </div>

      <Dialog open={selected !== null} onOpenChange={(open) => { if (!open) setSelected(null) }}>
        {selected && (
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Room {selected.roomNumber} · Bed {selected.bedNumber} — {selected.ward}</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 text-sm">
              <p className="text-muted-foreground">Status: <span className="font-medium text-foreground">{STATUS_LABELS[selected.status]}</span></p>
              {selected.occupantName && (
                <div className="rounded-md border border-border bg-secondary/40 p-3">
                  <p className="text-foreground">
                    <span className="font-medium">{selected.occupantName}</span>
                    <span className="font-mono text-xs text-muted-foreground"> (UHID {selected.occupantUhid ?? 'not assigned'})</span>
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Attending: {selected.attendingProviderName ?? 'Unassigned'}
                  </p>
                  {selected.admittedAt && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Admitted {formatIstDateTime(selected.admittedAt)}{selected.daysStayed !== null && ` · Day ${selected.daysStayed}`}
                    </p>
                  )}
                  {selected.wardGenderOverride && <p className="mt-0.5 text-xs font-medium text-warning">Placed here under a ward-gender override</p>}
                  {selected.occupantPatientId && (
                    <a href={`/patients/${selected.occupantPatientId}`} className="mt-1.5 inline-block text-xs font-medium text-primary hover:underline">View patient →</a>
                  )}
                </div>
              )}
              {(selected.roomCategoryName || selected.bedTariffPaise !== null || selected.genderRestriction) && (
                <p className="text-xs text-muted-foreground">
                  {[selected.roomCategoryName, selected.bedTariffPaise !== null ? perDay(selected.bedTariffPaise) : null, selected.genderRestriction ? GENDER_LABELS[selected.genderRestriction] : 'Mixed ward']
                    .filter(Boolean).join(' · ')}
                </p>
              )}

              {selected.status === 'occupied' && selected.admissionId !== null && (canTransfer || canDischarge || canManageMedications || canCaptureCharges) && (
                <div className="flex flex-wrap gap-2">
                  {canTransfer && <Button size="sm" variant="outline" onClick={() => openAction('transfer', selected.admissionId!)}>Transfer</Button>}
                  {canManageMedications && <Button size="sm" variant="outline" onClick={() => openAction('mar', selected.admissionId!)}>MAR</Button>}
                  {canCaptureCharges && (
                    <a href={`/billing/capture?admissionId=${selected.admissionId}`} className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-secondary">Charges</a>
                  )}
                  {canDischarge && <Button size="sm" onClick={() => openAction('discharge', selected.admissionId!)}>Discharge</Button>}
                </div>
              )}

              {selected.status === 'blocked' && selected.blockedReason && <p className="text-muted-foreground">Reason: {selected.blockedReason}</p>}

              {selected.status === 'dirty' && canManageFacilities && (
                <Button onClick={() => callAction(`/api/inpatient/rooms/${selected.id}/mark-clean`)} disabled={busy}>Mark clean</Button>
              )}

              {selected.status === 'available' && canAdmit && (
                <div className="space-y-2">
                  <PatientPicker value={admitPatient} onChange={setAdmitPatient} label="Patient to admit" />
                  <Button
                    onClick={() => { if (admitPatient) { setAdmitting({ patient: admitPatient, roomId: selected.id }); setSelected(null) } }}
                    disabled={!admitPatient}
                  >
                    Admit here
                  </Button>
                </div>
              )}

              {selected.status === 'available' && canBlock && (
                <div className="space-y-2">
                  <input value={blockReason} onChange={(e) => setBlockReason(e.target.value)} placeholder="Reason for blocking, e.g. Plumbing repair" aria-label="Block reason" className="w-full rounded-md border border-border px-2 py-1.5 text-sm" />
                  <Button variant="outline" onClick={() => callAction(`/api/inpatient/rooms/${selected.id}/block`, { reason: blockReason })} disabled={busy || !blockReason}>Block room</Button>
                </div>
              )}

              {selected.status === 'blocked' && canBlock && (
                <Button variant="outline" onClick={() => callAction(`/api/inpatient/rooms/${selected.id}/unblock`)} disabled={busy}>Unblock room</Button>
              )}

              {canSetBedGender && (
                <div className="flex items-center gap-2">
                  <select value={bedGender} onChange={(e) => setBedGender(e.target.value as typeof bedGender)} aria-label="Bed gender" className="rounded-md border border-border px-2 py-1.5 text-sm">
                    <option value="mixed">Mixed (no restriction)</option>
                    <option value="male">Male only</option>
                    <option value="female">Female only</option>
                  </select>
                  <Button size="sm" variant="outline" disabled={busy || bedGender === (selected.genderRestriction ?? 'mixed')}
                    onClick={() => callAction(`/api/inpatient/rooms/${selected.id}`, { genderRestriction: bedGender === 'mixed' ? null : bedGender }, 'PATCH')}>
                    Save bed gender
                  </Button>
                </div>
              )}

              {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setSelected(null)}>Close</Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>

      {action?.kind === 'transfer' && <TransferAdmissionModal admissionId={action.admissionId} availableRooms={availableRooms} onClose={() => setAction(null)} />}
      {action?.kind === 'discharge' && <DischargeAdmissionModal admissionId={action.admissionId} onClose={() => setAction(null)} />}
      {action?.kind === 'mar' && <MedicationAdministrationPanel admissionId={action.admissionId} onClose={() => setAction(null)} />}

      {admitting && (
        <AdmitPatientModal patient={admitting.patient} initialRoomId={admitting.roomId} providers={providers} onClose={() => setAdmitting(null)} />
      )}
    </div>
  )
}
