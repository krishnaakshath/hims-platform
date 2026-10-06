import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listBookingRequests } from '@/lib/queries/booking-requests'
import { listActiveProviders } from '@/lib/queries/providers'
import { BookingRequestsQueue } from '@/components/BookingRequestsQueue'

export default async function BookingRequestsPage() {
  const session = await requireSessionOrRedirect()
  if (!['admin', 'pi', 'crc', 'frontdesk'].includes(session.role)) redirect('/')

  const [requests, providers] = await Promise.all([listBookingRequests(), listActiveProviders()])
  await logAudit(session, 'viewed booking requests', null)

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-foreground">Booking Requests</h1>
      <BookingRequestsQueue
        requests={requests}
        providers={providers}
        canResolve={['admin', 'crc', 'frontdesk'].includes(session.role)}
      />
    </div>
  )
}
