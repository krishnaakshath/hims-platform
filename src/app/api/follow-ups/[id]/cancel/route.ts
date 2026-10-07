import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { FOLLOW_UP_PLAN_ROLES } from '@/lib/role-policy'
import { reasonOnlySchema } from '@/lib/follow-ups/validation'
import { notifyFollowUpSafely } from '@/lib/follow-ups/notifier'
import { cancelFollowUpOrder, getFollowUpView } from '@/lib/queries/follow-ups'
import { resolveDoctorQueueProvider } from '@/lib/doctor-queue-provider'
import {
  FOLLOW_UP_CLOSED, FOLLOW_UP_NOT_FOUND, NOT_LINKED_TO_DOCTOR,
  errorResponse, followUpServerError, invalidFollowUpId, parseFollowUpId, readJsonBody,
} from '@/lib/follow-ups/route-responses'

// SP3: cancel the follow-up itself (clinical decision). A still-booked
// appointment is cancelled in the same transaction.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!FOLLOW_UP_PLAN_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = reasonOnlySchema.safeParse(json.body)
  if (!parsed.success) return errorResponse(400, 'A reason is required (up to 500 characters).')
  const id = parseFollowUpId((await params).id)
  if (id === null) return invalidFollowUpId()

  try {
    // A pi acts only as their own linked doctor profile, and only on follow-ups they prescribed.
    let actingProviderId: number | null = null
    if (session.role === 'pi') {
      const self = await resolveDoctorQueueProvider(session)
      if (!self) return errorResponse(403, NOT_LINKED_TO_DOCTOR)
      actingProviderId = self.id
    }

    const result = await cancelFollowUpOrder(id, parsed.data.reason, session, actingProviderId)
    if (!result.ok) {
      if (result.error === 'not_found') return errorResponse(404, FOLLOW_UP_NOT_FOUND)
      if (result.error === 'not_owner') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      return errorResponse(409, FOLLOW_UP_CLOSED)
    }

    const { order } = result
    await notifyFollowUpSafely(session, { kind: 'cancelled', followUpOrderId: order.id, patientId: order.patientId, dueDate: order.dueDate, appointmentStartsAt: null })
    const view = await getFollowUpView(order.id, session.role).catch(() => null)
    return NextResponse.json({ order: view, cancelledAppointmentId: result.cancelledAppointmentId })
  } catch (err) {
    return followUpServerError('cancel', err, 'Could not cancel the follow-up')
  }
}
