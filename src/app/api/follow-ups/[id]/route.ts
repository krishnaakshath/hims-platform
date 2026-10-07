import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { FOLLOW_UP_PLAN_ROLES } from '@/lib/role-policy'
import { updateFollowUpPlanSchema } from '@/lib/follow-ups/validation'
import { notifyFollowUpSafely } from '@/lib/follow-ups/notifier'
import { getFollowUpView, updateFollowUpPlan } from '@/lib/queries/follow-ups'
import { resolveDoctorQueueProvider } from '@/lib/doctor-queue-provider'
import {
  DEPARTMENT_NOT_FOUND, DOCTOR_NOT_FOUND, FOLLOW_UP_CLOSED, FOLLOW_UP_NOT_FOUND, NOT_LINKED_TO_DOCTOR,
  errorResponse, followUpServerError, invalidFollowUpId, parseFollowUpId, readJsonBody,
} from '@/lib/follow-ups/route-responses'

// SP3: change the clinical plan (timing, window, reason, notes). Only an
// admin reassigns the prescriber. The booked appointment is never moved here;
// the response flags a booking that now falls outside the new window.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!FOLLOW_UP_PLAN_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = updateFollowUpPlanSchema.safeParse(json.body)
  if (!parsed.success) return errorResponse(400, 'Invalid follow-up details')
  const id = parseFollowUpId((await params).id)
  if (id === null) return invalidFollowUpId()

  const patch = parsed.data
  if (session.role === 'pi' && patch.prescribedByProviderId !== undefined) {
    return errorResponse(400, 'Only an admin can change the prescribing doctor.')
  }

  try {
    // A pi acts only as their own linked doctor profile, and only on follow-ups they prescribed.
    let actingProviderId: number | null = null
    if (session.role === 'pi') {
      const self = await resolveDoctorQueueProvider(session)
      if (!self) return errorResponse(403, NOT_LINKED_TO_DOCTOR)
      actingProviderId = self.id
    }

    const result = await updateFollowUpPlan(id, patch, session, actingProviderId)
    if (!result.ok) {
      switch (result.error) {
        case 'not_found': return errorResponse(404, FOLLOW_UP_NOT_FOUND)
        case 'not_owner': return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        case 'not_editable': return errorResponse(409, FOLLOW_UP_CLOSED)
        case 'provider_not_found': return errorResponse(404, DOCTOR_NOT_FOUND)
        case 'department_not_found': return errorResponse(400, DEPARTMENT_NOT_FOUND)
        case 'due_date_invalid': return errorResponse(400, result.message ?? 'Invalid follow-up date')
      }
    }

    const { order } = result
    const view = await getFollowUpView(order.id, session.role).catch(() => null)
    if (result.changedFields.includes('timing')) {
      const booked = view?.appointment?.status === 'scheduled' ? view.appointment.startsAt : null
      await notifyFollowUpSafely(session, { kind: 'plan_changed', followUpOrderId: order.id, patientId: order.patientId, dueDate: order.dueDate, appointmentStartsAt: booked })
    }
    return NextResponse.json({ order: view, bookingOutsideWindow: result.bookingOutsideWindow })
  } catch (err) {
    return followUpServerError('update', err, 'Could not update the follow-up')
  }
}
