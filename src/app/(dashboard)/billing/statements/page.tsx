import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listPatientStatements } from '@/lib/queries/patient-statements'
import { PatientStatementsTable } from '@/components/PatientStatementsTable'

export default async function PatientStatementsPage() {
  const session = await requireSessionOrRedirect()
  // LeftNav.tsx:98 — the Billing group is rendered for admin/crc/frontdesk only.
  if (!['admin', 'crc', 'billing'].includes(session.role)) redirect('/')
  const statements = await listPatientStatements()
  await logAudit(session, 'viewed patient statements activity', null)

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-foreground">Patient Statements</h1>
      <p className="mb-4 text-sm text-muted-foreground">Activity log of statements sent to patients.</p>
      <PatientStatementsTable statements={statements} linkPatients={session.role !== 'billing'} />
    </div>
  )
}
