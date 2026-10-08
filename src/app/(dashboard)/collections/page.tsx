// SP5: the collector's "My route" (COLLECTOR_ROUTE_ROLES), gated before any query. A collector sees
// only the visits assigned to them (filtered server-side by user id), for today in IST or an
// upcoming day; admin sees every visit and may pick any date. A collector session without a user
// id (no DB user row) gets an empty list: null would mean "all visits".
import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { COLLECTOR_ROUTE_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { todayIsoIn } from '@/lib/india-time'
import { isoDateSchema } from '@/lib/follow-ups/validation'
import { listCollectorRoute, type RouteStop } from '@/lib/queries/home-collections'
import { CollectorRoute } from '@/components/home-collection/CollectorRoute'

export default async function CollectionsPage({ searchParams }: { searchParams: Promise<{ date?: string | string[] }> }) {
  const session = await requireSessionOrRedirect()
  if (!COLLECTOR_ROUTE_ROLES.includes(session.role)) redirect('/')

  const today = todayIsoIn()
  const isCollector = session.role === 'collector'
  const raw = (await searchParams).date
  const parsed = isoDateSchema.safeParse(typeof raw === 'string' ? raw : '')
  // ISO dates compare as strings. A collector cannot look back; admin may pick any day.
  const date = parsed.success && (!isCollector || parsed.data >= today) ? parsed.data : today

  let stops: RouteStop[] = []
  if (!isCollector) stops = await listCollectorRoute(null, date)
  else if (session.userId !== null) stops = await listCollectorRoute(session.userId, date)

  // Date and count only: stops carry names, phones and addresses, which never go into audit details.
  await logAudit(session, 'viewed collection route', null, `date=${date} stops=${stops.length}`)

  return <CollectorRoute date={date} today={today} canLookBack={!isCollector} stops={stops} />
}
