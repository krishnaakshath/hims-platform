import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { REGISTRATION_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { listActiveProviders } from '@/lib/queries/providers'
import { listAvailableRooms } from '@/lib/queries/rooms'
import { CheckInButton } from '@/components/CheckInButton'
import { AddPatientButton } from '@/components/AddPatientButton'
import { getPickedPatient } from '@/lib/queries/search' // Wave C

// Gives admin and crc (who have no dashboard button for this -- their home
// dashboards are AdminDashboard/CoordinatorDashboard, neither of which
// renders CheckInButton) a real entry point at the URL LeftNav already
// promises them, instead of a 404. frontdesk lands here too, matching the
// nav link's role list.
//
// Wave C quick path: ?patient=<chart id> (from the patient page or list)
// opens the check-in modal with that patient preselected.
export default async function FrontDeskCheckInPage({ searchParams }: { searchParams?: Promise<{ patient?: string | string[] }> } = {}) {
  const session = await requireSessionOrRedirect()
  if (!['frontdesk', 'admin', 'crc'].includes(session.role)) redirect('/')

  const requested = (await searchParams)?.patient
  const preselectId = typeof requested === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(requested) ? requested : null
  const [providers, rooms, initialPatient] = await Promise.all([
    listActiveProviders(),
    listAvailableRooms(),
    preselectId ? getPickedPatient(preselectId) : Promise.resolve(null),
  ])
  await logAudit(session, 'viewed front desk check-in', null)

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-foreground">Check-In</h1>
      <div className="flex gap-3">
        <CheckInButton providers={providers} rooms={rooms} initialPatient={initialPatient} />
        {/* Check-In only accepts an existing patient ID -- a genuine
            walk-in with no chart yet needs to be registered first. Same
            POST /api/patients gate (admin/frontdesk), surfaced right here
            instead of only on /patients, so front desk doesn't have to
            leave their main workflow screen to do it. */}
        {REGISTRATION_ROLES.includes(session.role) && <AddPatientButton />}
      </div>
    </div>
  )
}
