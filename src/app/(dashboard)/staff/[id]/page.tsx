import { notFound, redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getStaffMemberDetail } from '@/lib/queries/staff-members'
import { getUserNameById } from '@/lib/queries/users'
import { listAllProviders } from '@/lib/queries/providers'
import { CLINICAL_ROLES } from '@/lib/role-policy'
import { StaffMemberDetail } from '@/components/StaffMemberDetail'

export default async function StaffMemberDetailPage({ params }: { params: Promise<{ id: string }> }) {
  // Must be the first statement -- see the comment in patients/page.tsx.
  const session = await requireSessionOrRedirect()
  // admin/crc/pi (pi view-only; canWrite below stays admin-only). Before
  // `await params` and any query.
  if (!CLINICAL_ROLES.includes(session.role)) redirect('/')

  const { id } = await params
  const staffId = Number(id)
  if (!Number.isInteger(staffId)) notFound()

  const staffMember = await getStaffMemberDetail(staffId)
  if (!staffMember) notFound()
  await logAudit(session, 'viewed staff member detail', null)

  // Resolve the linked user/provider to a display name here (in the page,
  // not the query layer -- this task is UI-only, no changes to Task 2's
  // already-reviewed query/API layer) so the detail view shows a name
  // instead of a bare numeric id.
  const [linkedUserName, providers] = await Promise.all([
    staffMember.userId !== null ? getUserNameById(staffMember.userId) : Promise.resolve(null),
    staffMember.providerId !== null ? listAllProviders() : Promise.resolve([]),
  ])
  const linkedProviderName = staffMember.providerId !== null
    ? (providers.find((p) => p.id === staffMember.providerId)?.name ?? null)
    : null

  return (
    <StaffMemberDetail
      staffMember={staffMember}
      linkedUserName={linkedUserName}
      linkedProviderName={linkedProviderName}
      canWrite={session.role === 'admin'}
    />
  )
}
