// SP5: reschedule a booked home collection (HOME_COLLECTION_BOOKING_ROLES), with a reason code.
// The notice goes out only after the change has committed.
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { HOME_COLLECTION_BOOKING_ROLES } from '@/lib/role-policy'
import { rescheduleHomeCollectionSchema } from '@/lib/labs/validation'
import { rescheduleHomeCollection } from '@/lib/queries/home-collections'
import { errorResponse, invalidBody, labServerError, parseId, readJsonBody } from '@/lib/labs/route-responses'
import { INVALID_VISIT_ID, bookingError, notifyVisitChange } from '@/lib/home-collection/route-responses'

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!HOME_COLLECTION_BOOKING_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = rescheduleHomeCollectionSchema.safeParse(json.body)
  if (!parsed.success) return invalidBody(parsed.error, 'Pick a date, a window and a reason')
  const visitId = parseId((await params).id)
  if (visitId === null) return errorResponse(400, INVALID_VISIT_ID)

  let result: Awaited<ReturnType<typeof rescheduleHomeCollection>>
  try {
    result = await rescheduleHomeCollection(visitId, parsed.data, session)
  } catch (err) {
    return labServerError('home collection reschedule', err, 'Could not reschedule the home collection')
  }
  if (!result.ok) return bookingError(result)

  await notifyVisitChange(session, { kind: 'rescheduled', visit: result.visit })
  return NextResponse.json({ visit: result.visit })
}
