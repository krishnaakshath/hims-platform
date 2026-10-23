// WS6 T11: POST /api/home-collections/[id]/otp -- send the patient a fresh 6-digit handover code
// (COLLECTOR_ROUTE_ROLES). Body `{}` (strict). The door guard (assertCollectorVisit, Ruling R4)
// runs before the per-visit send limit, so another collector cannot burn this visit's sends.
// The response carries only the channel status: never the code, the phone or the hash.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { COLLECTOR_ROUTE_ROLES } from '@/lib/role-policy'
import { todayIsoIn } from '@/lib/india-time'
import { checkHandoverOtpSendRateLimit } from '@/lib/rate-limit'
import { assertCollectorVisit } from '@/lib/queries/home-collections'
import { issueHandoverOtp } from '@/lib/home-collection/handover-otp'
import { errorResponse, invalidBody, labServerError, parseId, readJsonBody } from '@/lib/labs/route-responses'
import {
  INVALID_VISIT_ID, NOT_COLLECTABLE_MESSAGE, VISIT_NOT_FOUND, forbidden, notDueResponse,
} from '@/lib/home-collection/route-responses'

const sendOtpSchema = z.object({}).strict()

function refusal(error: 'not_found' | 'not_assigned' | 'not_due' | 'not_collectable' | 'no_phone', visitDate?: string) {
  if (error === 'not_assigned') return forbidden()
  if (error === 'not_found') return errorResponse(404, VISIT_NOT_FOUND)
  if (error === 'not_due') return notDueResponse(visitDate)
  if (error === 'no_phone') return errorResponse(409, 'This visit has no mobile number to send a code to. Choose why the code could not be used.', 'no_phone')
  return errorResponse(409, NOT_COLLECTABLE_MESSAGE)
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!COLLECTOR_ROUTE_ROLES.includes(session.role)) return forbidden()

  const json = await readJsonBody(request, { emptyAs: {} })
  if (!json.ok) return json.response
  const parsed = sendOtpSchema.safeParse(json.body)
  if (!parsed.success) return invalidBody(parsed.error, 'Invalid request')
  const visitId = parseId((await params).id)
  if (visitId === null) return errorResponse(400, INVALID_VISIT_ID)

  try {
    const guard = await assertCollectorVisit(visitId, session, todayIsoIn())
    if (!guard.ok) return refusal(guard.error, guard.visitDate)
  } catch (err) {
    return labServerError('home collection handover code', err, 'Could not send the handover code')
  }

  let limited: boolean
  try {
    limited = !(await checkHandoverOtpSendRateLimit(visitId)).allowed
  } catch {
    return NextResponse.json({ error: 'Service temporarily unavailable' }, { status: 503 })
  }
  if (limited) return errorResponse(429, 'A code was sent several times already. Wait a few minutes before sending another.')

  try {
    const result = await issueHandoverOtp(visitId, session)
    if (!result.ok) return refusal(result.error, result.visitDate)
    return NextResponse.json({ channelStatus: result.channelStatus })
  } catch (err) {
    return labServerError('home collection handover code', err, 'Could not send the handover code')
  }
}
