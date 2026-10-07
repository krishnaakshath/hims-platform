// SP5: book a home sample collection (HOME_COLLECTION_BOOKING_ROLES). One transaction in the query
// (capacity lock, order locks, sample IDs, audit); the patient notice only after it commits.
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { HOME_COLLECTION_BOOKING_ROLES } from '@/lib/role-policy'
import { bookHomeCollectionSchema } from '@/lib/labs/validation'
import { bookHomeCollection } from '@/lib/queries/home-collections'
import { invalidBody, labServerError, readJsonBody } from '@/lib/labs/route-responses'
import { bookingError, notifyVisitChange } from '@/lib/home-collection/route-responses'

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!HOME_COLLECTION_BOOKING_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = bookHomeCollectionSchema.safeParse(json.body)
  if (!parsed.success) return invalidBody(parsed.error, 'Invalid booking details')

  let result: Awaited<ReturnType<typeof bookHomeCollection>>
  try {
    result = await bookHomeCollection(parsed.data, session)
  } catch (err) {
    return labServerError('home collection book', err, 'Could not book the home collection')
  }
  if (!result.ok) return bookingError(result)

  const { visit } = result
  await notifyVisitChange(session, { kind: 'booked', visit })
  return NextResponse.json({ visit, sampleIds: Object.fromEntries(result.sampleIds) }, { status: 201 })
}
