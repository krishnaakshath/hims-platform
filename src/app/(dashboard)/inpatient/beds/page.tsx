import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listAllRoomsWithOccupant } from '@/lib/queries/rooms'
import { BedBoard } from '@/components/BedBoard'

export default async function InpatientBedsPage() {
  const session = await requireSessionOrRedirect()
  if (!['frontdesk', 'admin', 'crc', 'pi'].includes(session.role)) redirect('/')

  const rooms = await listAllRoomsWithOccupant()
  await logAudit(session, 'viewed bed board', null)

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-foreground">Beds</h1>
      <BedBoard
        rooms={rooms}
        canManageFacilities={['frontdesk', 'admin', 'crc'].includes(session.role)}
        canBlock={session.role === 'admin'}
        canAdmit={session.role === 'pi'}
      />
    </div>
  )
}
