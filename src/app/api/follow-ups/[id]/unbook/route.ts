import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { FOLLOW_UP_BOOKING_ROLES } from '@/lib/role-policy'
import { reasonOnlySchema } from '@/lib/follow-ups/validation'
import { notifyFollowUpSafely } from '@/lib/follow-ups/notifier'
import { unbookFollowUp } from '@/lib/queries/follow-up-recall'
import { getFollowUpView } from '@/lib/queries/follow-ups'
import {
  FOLLOW_UP_NOT_FOUND, errorResponse, followUpServerError, invalidFollowUpId, parseFollowUpId, readJsonBody,
} from '@/lib/follow-ups/route-responses'

// SP3: cancel the booked appointment; the follow-up stays open (planned).
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!FOLLOW_UP_BOOKING_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = reasonOnlySchema.safeParse(json.body)
  if (!parsed.success) return errorResponse(400, 'A reason is required (up to 500 characters).')
  const id = parseFollowUpId((await params).id)
  if (id === null) return invalidFollowUpId()

  try {
    const result = await unbookFollowUp(id, parsed.data.reason, session)
    if (!result.ok) {
      if (result.error === 'not_found') return errorResponse(404, FOLLOW_UP_NOT_FOUND)
      return errorResponse(409, 'This follow-up has no booked appointment to cancel.')
    }

    const { order } = result
    await notifyFollowUpSafely(session, { kind: 'unbooked', followUpOrderId: order.id, patientId: order.patientId, dueDate: order.dueDate, appointmentStartsAt: null })
    const view = await getFollowUpView(order.id, session.role).catch(() => null)
    return NextResponse.json({ order: view, cancelledAppointmentId: result.cancelledAppointmentId })
  } catch (err) {
    return followUpServerError('unbook', err, 'Could not cancel the booking')
  }
}
