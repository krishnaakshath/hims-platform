// SP5: assign (or clear) the collector of a booked visit (HOME_COLLECTION_DISPATCH_ROLES). The
// user must have the collector role; the query checks it.
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { HOME_COLLECTION_DISPATCH_ROLES } from '@/lib/role-policy'
import { assignCollectorSchema } from '@/lib/labs/validation'
import { assignCollector } from '@/lib/queries/home-collections'
import { errorResponse, invalidBody, labServerError, parseId, readJsonBody } from '@/lib/labs/route-responses'
import { INVALID_VISIT_ID, VISIT_NOT_FOUND } from '@/lib/home-collection/route-responses'

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!HOME_COLLECTION_DISPATCH_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = assignCollectorSchema.safeParse(json.body)
  if (!parsed.success) return invalidBody(parsed.error, 'Pick a collector')
  const visitId = parseId((await params).id)
  if (visitId === null) return errorResponse(400, INVALID_VISIT_ID)

  let result: Awaited<ReturnType<typeof assignCollector>>
  try {
    result = await assignCollector(visitId, parsed.data.collectorUserId, session)
  } catch (err) {
    return labServerError('home collection assign', err, 'Could not assign the collector')
  }
  if (!result.ok) {
    if (result.error === 'collector_not_found') return errorResponse(400, 'Pick an active collector.')
    if (result.error === 'not_found') return errorResponse(404, VISIT_NOT_FOUND)
    return errorResponse(409, 'Only a booked visit can be assigned a collector.')
  }
  return NextResponse.json({ visit: { id: result.visit.id, collectorUserId: result.visit.collectorUserId } })
}
