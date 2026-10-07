// /coding: the clinical coding worklist (CODING_ROLES; LeftNav shows it to the same roles, and it is
// the coder's home). Completed OPD/IPD visits, oldest completion first, 50 per page. Not audited:
// it is a list (name and UHID only), not a view of any one patient's record.
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { CODING_ROLES } from '@/lib/role-policy'
import { CODING_ACTION_ROLES, nextCodingStatus } from '@/lib/coding/status'
import { BACKLOG_AGE_LABEL, parseCodingWorklistParams } from '@/lib/coding/worklist'
import { formatDateTimeIn, formatIsoDate } from '@/lib/india-time'
import { listCodingWorklist } from '@/lib/queries/coding-worklist'
import { listDepartments } from '@/lib/queries/departments'
import { CodingWorklist, type CodingWorklistRowView } from '@/components/coding/CodingWorklist'

export default async function CodingWorklistPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSessionOrRedirect()
  if (!CODING_ROLES.includes(session.role)) redirect('/')

  const filters = parseCodingWorklistParams(await searchParams)
  const [worklist, departments] = await Promise.all([
    listCodingWorklist(filters, session),
    listDepartments({ activeOnly: true }),
  ])
  const mayClaim = CODING_ACTION_ROLES.claim.includes(session.role)

  const rows: CodingWorklistRowView[] = worklist.rows.map((r) => ({
    encounterId: r.encounterId,
    patientName: r.patientName,
    uhid: r.uhid,
    encounterTypeLabel: r.encounterType.toUpperCase(),
    encounterDateLabel: formatIsoDate(r.encounterDate),
    completedLabel: formatDateTimeIn(r.completedAt),
    departmentName: r.departmentName,
    providerName: r.providerName,
    codingStatus: r.codingStatus,
    assignedToName: r.assignedToName,
    uncodedCount: r.uncodedCount,
    proposedCount: r.proposedCount,
    openQueryCount: r.openQueryCount,
    ageLabel: BACKLOG_AGE_LABEL[r.ageBucket],
    canClaim: mayClaim && r.assignedToUserId === null && nextCodingStatus(r.codingStatus, 'claim') !== null,
  }))

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Coding</h1>
          <p className="text-sm text-muted-foreground">Completed visits waiting for diagnosis and procedure codes, oldest first.</p>
        </div>
        <div className="flex flex-wrap gap-3 text-sm">
          <Link href="/coding/report" className="rounded-lg border border-border px-3 py-1.5 hover:bg-muted">Productivity report</Link>
          <Link href="/coding/service-codes" className="rounded-lg border border-border px-3 py-1.5 hover:bg-muted">Service codes</Link>
        </div>
      </div>
      <CodingWorklist
        rows={rows}
        total={worklist.total}
        counts={worklist.counts}
        filters={filters}
        // Only id and name reach the client, never whole department rows.
        departments={departments.map((d) => ({ id: d.id, name: d.name }))}
      />
    </div>
  )
}
