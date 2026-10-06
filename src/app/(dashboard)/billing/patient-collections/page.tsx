import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listPatientCollections } from '@/lib/queries/patient-collections'
import { PatientCollectionsTable } from '@/components/PatientCollectionsTable'

export default async function PatientCollectionsPage() {
  const session = await requireSessionOrRedirect()
  // LeftNav.tsx:98 — the Billing group is rendered for admin/crc/frontdesk only.
  if (!['admin', 'crc', 'billing'].includes(session.role)) redirect('/')
  const rows = await listPatientCollections()
  await logAudit(session, 'viewed patient collections', null)

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-foreground">Patient Collections</h1>
      <PatientCollectionsTable rows={rows} linkPatients={session.role !== 'billing'} />
    </div>
  )
}
