import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { FOLLOW_UP_BOOKING_ROLES, FOLLOW_UP_WORKLIST_ROLES } from '@/lib/role-policy'
import { todayIsoIn } from '@/lib/india-time'
import { listFollowUpWorklist } from '@/lib/queries/follow-up-recall'
import { listActiveProviders } from '@/lib/queries/providers'
import { listDepartments } from '@/lib/queries/departments'
import { countWorklistBuckets, filterAndSortWorklist, parseWorklistParams, WORKLIST_ROW_CAP } from '@/lib/follow-ups/worklist'
import { FollowUpWorklist } from '@/components/follow-ups/FollowUpWorklist'

export default async function FollowUpWorklistPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSessionOrRedirect()
  if (!FOLLOW_UP_WORKLIST_ROLES.includes(session.role)) redirect('/')

  const filters = parseWorklistParams(await searchParams)
  const todayIso = todayIsoIn()
  const [all, providers, departments] = await Promise.all([
    listFollowUpWorklist(todayIso, { departmentId: filters.departmentId, providerId: filters.providerId }),
    listActiveProviders(),
    listDepartments({ activeOnly: true }),
  ])
  await logAudit(session, 'viewed follow-up worklist', null)

  // Counts are for the department/doctor-filtered rows; the bucket filter only picks the visible tab.
  const scoped = filterAndSortWorklist(all, { ...filters, bucket: 'all_open' })
  const counts = countWorklistBuckets(scoped)
  const rows = filterAndSortWorklist(all, filters)

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold text-foreground">Follow-ups</h1>
      <p className="mb-6 text-sm text-muted-foreground">Patients due back for a follow-up visit, by how urgent each recall is.</p>
      <FollowUpWorklist
        rows={rows}
        counts={counts}
        filters={filters}
        // Only id and name reach the client, never whole provider/department rows.
        providers={providers.map((p) => ({ id: p.id, name: p.name }))}
        departments={departments.map((d) => ({ id: d.id, name: d.name }))}
        todayIso={todayIso}
        canAct={FOLLOW_UP_BOOKING_ROLES.includes(session.role)}
        capped={all.length >= WORKLIST_ROW_CAP}
      />
    </div>
  )
}
