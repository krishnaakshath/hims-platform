// SP5: cancel a booked home collection with a reason code (HOME_COLLECTION_CANCEL_ROLES). A
// collector may cancel only a visit assigned to them, with a doorstep reason; the query enforces
// it and `not_assigned` is the plain 403. The notice goes out only after the change has committed.
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { HOME_COLLECTION_CANCEL_ROLES } from '@/lib/role-policy'
import { cancelHomeCollectionSchema } from '@/lib/labs/validation'
import { cancelHomeCollection } from '@/lib/queries/home-collections'
import { errorResponse, invalidBody, labServerError, parseId, readJsonBody } from '@/lib/labs/route-responses'
import { INVALID_VISIT_ID, VISIT_NOT_FOUND, forbidden, notifyVisitChange } from '@/lib/home-collection/route-responses'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!HOME_COLLECTION_CANCEL_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = cancelHomeCollectionSchema.safeParse(json.body)
  if (!parsed.success) return invalidBody(parsed.error, 'Pick a reason to cancel')
  const visitId = parseId((await params).id)
  if (visitId === null) return errorResponse(400, INVALID_VISIT_ID)

  let result: Awaited<ReturnType<typeof cancelHomeCollection>>
  try {
    result = await cancelHomeCollection(visitId, parsed.data, session)
  } catch (err) {
    return labServerError('home collection cancel', err, 'Could not cancel the home collection')
  }
  if (!result.ok) {
    if (result.error === 'not_assigned') return forbidden()
    if (result.error === 'reason_not_allowed') return errorResponse(400, 'A collector can cancel only when the patient is not available, refuses, or the address is not found.')
    if (result.error === 'not_found') return errorResponse(404, VISIT_NOT_FOUND)
    return errorResponse(409, 'Only a booked visit can be cancelled.')
  }

  await notifyVisitChange(session, { kind: 'cancelled', visit: result.visit })
  return NextResponse.json({ ok: true, releasedOrderIds: result.releasedOrderIds })
}
