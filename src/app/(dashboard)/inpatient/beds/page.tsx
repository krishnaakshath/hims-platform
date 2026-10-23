import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listAllRoomsWithOccupant } from '@/lib/queries/rooms'
import { listActiveProviders } from '@/lib/queries/providers'
import { resolveDoctorQueueProvider } from '@/lib/doctor-queue-provider'
import { ADMISSION_ROLES } from '@/lib/role-policy'
import { BedBoard } from '@/components/BedBoard'

export default async function InpatientBedsPage() {
  const session = await requireSessionOrRedirect()
  if (!['frontdesk', 'admin', 'crc', 'pi'].includes(session.role)) redirect('/')

  const canAdmit = ADMISSION_ROLES.includes(session.role)
  // WS3 T3: the attending choices for "Admit here"; a doctor (pi) may admit only as the attending.
  const [rooms, providers] = await Promise.all([
    listAllRoomsWithOccupant(),
    !canAdmit ? Promise.resolve([]) : session.role === 'pi'
      ? resolveDoctorQueueProvider(session).then((own) => (own ? [own] : []))
      : listActiveProviders().then((list) => list.map((p) => ({ id: p.id, name: p.name }))),
  ])
  await logAudit(session, 'viewed bed board', null)

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-foreground">Beds</h1>
      <BedBoard
        rooms={rooms}
        providers={providers}
        canManageFacilities={['frontdesk', 'admin', 'crc'].includes(session.role)}
        canBlock={session.role === 'admin'}
        canAdmit={canAdmit}
      />
    </div>
  )
}
