'use client'
import { formatIstDate, formatIstDateTime } from '@/lib/india-time'
import { useState } from 'react'
import Link from 'next/link'
import { Printer } from 'lucide-react'
import { TransferAdmissionModal } from '@/components/TransferAdmissionModal'
import { DischargeAdmissionModal } from '@/components/DischargeAdmissionModal'
import { MedicationAdministrationPanel } from '@/components/MedicationAdministrationPanel'
import { Button } from '@/components/ui/button'

interface TransferRecord { id: number; fromRoomId: number | null; toRoomId: number; reason: string; transferredByName: string; transferredAt: string }
interface AdmissionRecord {
  id: number
  status: 'admitted' | 'discharged'
  admissionType: string
  admittedAt: string
  dischargedAt: string | null
  dischargeDiagnosis: string | null
  dischargeDrugs: string | null
  dischargeDevices: string | null
  dischargeDiet: string | null
  dischargeSummaryNotes: string | null
  transfers: TransferRecord[]
  dischargeSignature: { signerTypedName: string; signedAt: string } | null
}
interface RoomOption { id: number; ward: string; roomNumber: string; bedNumber: string }

export function InpatientHistoryPanel({ admissions, availableRooms, canTransfer, canDischarge, canManageMedications }: { admissions: AdmissionRecord[]; availableRooms: RoomOption[]; canTransfer: boolean; canDischarge: boolean; canManageMedications: boolean }) {
  const [transferFor, setTransferFor] = useState<number | null>(null)
  const [dischargeFor, setDischargeFor] = useState<number | null>(null)
  const [medicationsFor, setMedicationsFor] = useState<number | null>(null)

  return (
    <div className="space-y-4">
      {admissions.map((a) => (
        <section key={a.id} className="rounded-xl border border-primary/10 bg-card/80 p-5 shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-semibold text-foreground">
              {a.status === 'admitted' ? 'Currently admitted' : 'Discharged'} — admitted {formatIstDate(a.admittedAt)}
              {a.dischargedAt && ` · discharged ${formatIstDate(a.dischargedAt)}`}
            </p>
            <span className="rounded-full bg-secondary px-2 py-0.5 text-xs capitalize text-muted-foreground">{a.admissionType.replace('_', ' ')}</span>
          </div>

          {a.status === 'admitted' && (canTransfer || canDischarge || canManageMedications) && (
            <div className="mb-3 flex gap-2">
              {canTransfer && <Button size="sm" variant="outline" onClick={() => setTransferFor(a.id)}>Transfer</Button>}
              {canManageMedications && <Button size="sm" variant="outline" onClick={() => setMedicationsFor(a.id)}>Medications</Button>}
              {canDischarge && <Button size="sm" onClick={() => setDischargeFor(a.id)}>Discharge</Button>}
            </div>
          )}

          {/* Wave F P1-13: the printable A4 discharge summary (same roles as this panel; the front desk gets the administrative copy). */}
          {a.status === 'discharged' && (
            <p className="mb-2">
              <Link href={`/print/discharge/${a.id}`} className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline">
                <Printer className="h-3.5 w-3.5" aria-hidden="true" />
                Print discharge summary
              </Link>
            </p>
          )}

          {a.status === 'discharged' && (
            <p className="mb-2 text-xs">
              {a.dischargeSignature
                ? <span className="text-success">Signed by {a.dischargeSignature.signerTypedName} on {formatIstDate(a.dischargeSignature.signedAt)}</span>
                : <span className="font-medium text-destructive">Not yet signed</span>}
            </p>
          )}

          {/* Only when there is discharge clinical content to show: front desk
              receives these five fields nulled (patient detail's reduced
              view), and blank labels would read as missing data. */}
          {a.status === 'discharged' && [a.dischargeDiagnosis, a.dischargeDrugs, a.dischargeDevices, a.dischargeDiet, a.dischargeSummaryNotes].some((v) => v !== null) && (
            <div className="mb-3 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
              <p><span className="font-semibold text-foreground">Diagnosis:</span> {a.dischargeDiagnosis}</p>
              <p><span className="font-semibold text-foreground">Drugs:</span> {a.dischargeDrugs}</p>
              <p><span className="font-semibold text-foreground">Devices:</span> {a.dischargeDevices}</p>
              <p><span className="font-semibold text-foreground">Diet:</span> {a.dischargeDiet}</p>
              {a.dischargeSummaryNotes && <p className="col-span-2"><span className="font-semibold text-foreground">Notes:</span> {a.dischargeSummaryNotes}</p>}
            </div>
          )}

          {a.transfers.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Room history</p>
              <ul className="space-y-1 text-xs text-muted-foreground">
                {a.transfers.map((t) => (
                  <li key={t.id}>{formatIstDateTime(t.transferredAt)} — {t.fromRoomId ? `Room #${t.fromRoomId}` : 'Boarding'} → Room #{t.toRoomId} ({t.reason}, by {t.transferredByName})</li>
                ))}
              </ul>
            </div>
          )}

          {transferFor === a.id && <TransferAdmissionModal admissionId={a.id} availableRooms={availableRooms} onClose={() => setTransferFor(null)} />}
          {dischargeFor === a.id && <DischargeAdmissionModal admissionId={a.id} onClose={() => setDischargeFor(null)} />}
          {medicationsFor === a.id && <MedicationAdministrationPanel admissionId={a.id} onClose={() => setMedicationsFor(null)} />}
        </section>
      ))}
    </div>
  )
}
