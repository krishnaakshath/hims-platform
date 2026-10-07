// SP5: the home-collection day board. Gate HOME_COLLECTION_BOOKING_ROLES (admin, frontdesk, labs),
// checked before any query; the collector select is for HOME_COLLECTION_DISPATCH_ROLES only.
// The day is an IST business date: a valid ?date=YYYY-MM-DD, else today in IST.
import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { HOME_COLLECTION_BOOKING_ROLES, HOME_COLLECTION_DISPATCH_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { todayIsoIn } from '@/lib/india-time'
import { isoDateSchema } from '@/lib/follow-ups/validation'
import { listCollectors, listHomeCollectionBoard } from '@/lib/queries/home-collections'
import { HomeCollectionBoard } from '@/components/home-collection/HomeCollectionBoard'

export default async function HomeCollectionsPage({ searchParams }: { searchParams: Promise<{ date?: string | string[] }> }) {
  const session = await requireSessionOrRedirect()
  if (!HOME_COLLECTION_BOOKING_ROLES.includes(session.role)) redirect('/')

  const raw = (await searchParams).date
  const parsed = isoDateSchema.safeParse(typeof raw === 'string' ? raw : '')
  const date = parsed.success ? parsed.data : todayIsoIn()
  const canDispatch = HOME_COLLECTION_DISPATCH_ROLES.includes(session.role)

  const [board, collectors] = await Promise.all([
    listHomeCollectionBoard(date),
    canDispatch ? listCollectors() : Promise.resolve([]),
  ])
  // Date and count only: the board carries names, phones and addresses, which never go into audit details.
  await logAudit(session, 'viewed home collection board', null, `date=${date} visits=${board.visits.length}`)

  return (
    <HomeCollectionBoard
      date={date}
      windows={board.windows}
      visits={board.visits}
      totalVisits={board.totalVisits}
      collectors={collectors}
      canDispatch={canDispatch}
    />
  )
}
