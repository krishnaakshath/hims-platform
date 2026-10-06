import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { listMedicationsWithInventory } from '@/lib/queries/medications'
import { listPharmacyPatientRoster } from '@/lib/queries/patients'
import { PharmacyPatientLookup } from '@/components/PharmacyPatientLookup'

export default async function PharmacyPatientLookupPage() {
  const session = await requireSessionOrRedirect()
  // Matches GET /api/pharmacy/patients/[patientId]'s own role gate.
  if (!['pharmacy', 'admin'].includes(session.role)) redirect('/')

  const [medications, roster] = await Promise.all([
    listMedicationsWithInventory(),
    listPharmacyPatientRoster(),
  ])

  // No `logAudit` here -- this page itself shows no patient. The per-patient
  // audit entry is emitted by GET /api/pharmacy/patients/[patientId] with a
  // real patientId attached, which is the reason patient lookup is its own
  // route rather than a tab folded into /pharmacy.
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-foreground">Patient Lookup</h1>
      <PharmacyPatientLookup medications={medications} roster={roster} />
    </div>
  )
}
