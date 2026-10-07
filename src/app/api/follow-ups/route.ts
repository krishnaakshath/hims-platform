import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { FOLLOW_UP_PLAN_ROLES } from '@/lib/role-policy'
import { createFollowUpSchema } from '@/lib/follow-ups/validation'
import { notifyFollowUpSafely } from '@/lib/follow-ups/notifier'
import { createFollowUpOrder, getFollowUpView } from '@/lib/queries/follow-ups'
import { resolveDoctorQueueProvider } from '@/lib/doctor-queue-provider'
import { DOCTOR_NOT_FOUND, NOT_LINKED_TO_DOCTOR, errorResponse, followUpServerError, readJsonBody } from '@/lib/follow-ups/route-responses'

// SP3: a doctor (pi) or admin sets a patient's follow-up plan. A pi always
// prescribes as their own linked provider profile; an admin names the doctor.
export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!FOLLOW_UP_PLAN_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = createFollowUpSchema.safeParse(json.body)
  if (!parsed.success) return errorResponse(400, 'Invalid follow-up details')
  const input = parsed.data

  try {
    let prescribedByProviderId: number
    if (session.role === 'pi') {
      const self = await resolveDoctorQueueProvider(session)
      if (!self) return errorResponse(403, NOT_LINKED_TO_DOCTOR)
      if (input.prescribedByProviderId !== undefined && input.prescribedByProviderId !== self.id) {
        return errorResponse(400, 'Doctors always prescribe follow-ups as themselves.')
      }
      prescribedByProviderId = self.id
    } else {
      if (input.prescribedByProviderId === undefined) return errorResponse(400, 'Choose the doctor who prescribes this follow-up.')
      prescribedByProviderId = input.prescribedByProviderId
    }

    const result = await createFollowUpOrder({
      patientId: input.patientId,
      source: input.originatingEncounterId ? 'encounter' : 'manual',
      prescribedByProviderId,
      departmentId: input.departmentId ?? null,
      timing: input.timing,
      windowDaysBefore: input.windowDaysBefore,
      windowDaysAfter: input.windowDaysAfter,
      reason: input.reason,
      planNotes: input.planNotes ?? null,
      originatingEncounterId: input.originatingEncounterId ?? null,
      originatingAdmissionId: null,
    }, session)
    if (!result.ok) {
      switch (result.error) {
        case 'patient_not_found': return errorResponse(404, 'Patient not found')
        case 'provider_not_found': return errorResponse(404, DOCTOR_NOT_FOUND)
        case 'encounter_not_found': return errorResponse(404, 'Visit not found')
        case 'encounter_mismatch': return errorResponse(409, 'That visit belongs to a different patient.')
        case 'due_date_invalid': return errorResponse(400, result.message ?? 'Invalid follow-up date')
      }
    }

    // Committed: the notice goes out only now (log-only, never throws).
    const { order } = result
    await notifyFollowUpSafely(session, { kind: 'planned', followUpOrderId: order.id, patientId: order.patientId, dueDate: order.dueDate, appointmentStartsAt: null })
    const view = await getFollowUpView(order.id, session.role).catch(() => null)
    return NextResponse.json({ order: view }, { status: 201 })
  } catch (err) {
    return followUpServerError('create', err, 'Could not save the follow-up')
  }
}
