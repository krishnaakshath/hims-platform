import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listPatientsWithStatus } from '@/lib/queries/patients'
import { listAllTrials } from '@/lib/queries/trials'
import { PatientsReportTable } from '@/components/PatientsReportTable'

export default async function PatientsReportPage() {
  const session = await requireSessionOrRedirect()
  // LeftNav.tsx:60 — the Reports section is rendered for admin/crc only.
  // Same list, same redirect target as workbook/page.tsx:12.
  if (!['admin', 'crc'].includes(session.role)) redirect('/')
  const [patients, trials] = await Promise.all([listPatientsWithStatus(null), listAllTrials()])
  await logAudit(session, 'viewed report: all patients', null)

  const trialNameById = new Map(trials.map((t) => [t.id, t.name]))

  const rows = patients.map((p) => ({
    id: p.id,
    displayName: p.name,
    dob: p.dob,
    currentProvider: p.currentProvider,
    overallStatus: p.overallStatus,
    trialName: p.trialId ? (trialNameById.get(p.trialId) ?? p.trialId) : null,
    referralType: p.referralType,
    lastCommunication: p.lastCommunication,
    criteriaSummary: p.criteriaSummary,
  }))

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-foreground">All Patients</h1>
      <PatientsReportTable rows={rows} />
    </div>
  )
}
