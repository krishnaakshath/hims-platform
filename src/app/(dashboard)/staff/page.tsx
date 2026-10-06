import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listStaffMembers } from '@/lib/queries/staff-members'
import { listExpiringOrExpiredCredentials } from '@/lib/queries/staff-credentials'
import { listAllUsers } from '@/lib/queries/users'
import { listActiveProviders } from '@/lib/queries/providers'
import { CLINICAL_ROLES } from '@/lib/role-policy'
import { StaffDirectoryList } from '@/components/StaffDirectoryList'

export default async function StaffPage() {
  // Must be the first statement -- see the comment in patients/page.tsx.
  const session = await requireSessionOrRedirect()
  // Matches LeftNav's roles for this route (admin/crc/pi). pi may VIEW the
  // directory (role-capabilities); only admin gets write controls.
  if (!CLINICAL_ROLES.includes(session.role)) redirect('/')

  const canWrite = session.role === 'admin'
  // users/providers only feed the Add Staff Member modal. Do not query or
  // serialize them (user emails, roles, MFA state) for a view-only role.
  const [staffMembers, expiringCredentials, users, providers] = await Promise.all([
    listStaffMembers(),
    listExpiringOrExpiredCredentials(),
    canWrite ? listAllUsers() : Promise.resolve([]),
    canWrite ? listActiveProviders() : Promise.resolve([]),
  ])
  await logAudit(session, 'viewed staff directory', null)

  return (
    <StaffDirectoryList
      staffMembers={staffMembers}
      expiringCredentials={expiringCredentials}
      users={users}
      providers={providers}
      canWrite={canWrite}
    />
  )
}
