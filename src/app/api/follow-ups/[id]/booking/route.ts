import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { FOLLOW_UP_BOOKING_ROLES } from '@/lib/role-policy'
import { bookFollowUpSchema } from '@/lib/follow-ups/validation'
import { notifyFollowUpSafely } from '@/lib/follow-ups/notifier'
import { bookFollowUp } from '@/lib/queries/follow-up-recall'
import { getFollowUpView } from '@/lib/queries/follow-ups'
import {
  DOCTOR_NOT_FOUND, FOLLOW_UP_CLOSED, FOLLOW_UP_NOT_FOUND,
  errorResponse, followUpServerError, invalidFollowUpId, parseFollowUpId, readJsonBody,
} from '@/lib/follow-ups/route-responses'

// SP3: the front desk books (or reschedules) the follow-up's appointment.
// Times must carry an explicit UTC offset (the UI sends +05:30), so the
// instant never depends on the server's zone.
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!FOLLOW_UP_BOOKING_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = bookFollowUpSchema.safeParse(json.body)
  if (!parsed.success) return errorResponse(400, 'Invalid appointment time. Send a doctor and start/end times with a UTC offset, ending after the start.')
  const id = parseFollowUpId((await params).id)
  if (id === null) return invalidFollowUpId()

  const slot = { providerId: parsed.data.providerId, startsAt: new Date(parsed.data.startsAt), endsAt: new Date(parsed.data.endsAt) }
  try {
    const result = await bookFollowUp(id, slot, session)
    if (!result.ok) {
      switch (result.error) {
        case 'not_found': return errorResponse(404, FOLLOW_UP_NOT_FOUND)
        case 'not_bookable': return errorResponse(409, FOLLOW_UP_CLOSED)
        case 'provider_not_found': return errorResponse(404, DOCTOR_NOT_FOUND)
        case 'slot_in_past': return errorResponse(400, 'Pick a time later than now.')
        case 'conflict': return errorResponse(409, 'This doctor already has an appointment during that time.')
      }
    }

    const { order } = result
    await notifyFollowUpSafely(session, { kind: result.kind, followUpOrderId: order.id, patientId: order.patientId, dueDate: order.dueDate, appointmentStartsAt: slot.startsAt })
    // The role view: the front desk never receives plan notes or the cancel reason.
    const view = await getFollowUpView(order.id, session.role).catch(() => null)
    return NextResponse.json({ order: view, appointmentId: result.appointmentId, kind: result.kind })
  } catch (err) {
    return followUpServerError('book', err, 'Could not book the follow-up')
  }
}
