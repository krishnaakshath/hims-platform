import { NextRequest, NextResponse } from 'next/server'
import { readJsonBody } from '@/lib/http'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { requireSession } from '@/lib/auth'
import { getDb } from '@/db/client'
import { patients, providers } from '@/db/schema'
import { assignRoomToPatient } from '@/lib/queries/rooms'
import { getActiveAdmissionForPatient } from '@/lib/queries/admissions'
import { checkInVisit, type CheckInVisitError } from '@/lib/queries/encounters'
import { CHECK_IN_ROLES } from '@/lib/role-policy'
import { RETRY_MESSAGE, isRetryableConflict, pgConstraint, pgErrorCode } from '@/lib/db-errors'
import { visitReasonSchema } from '@/lib/visit-reason-schema'

const checkInSchema = z.object({
  patientId: z.string().min(1),
  providerId: z.number().int().positive(),
  visitType: z.enum(['inpatient', 'outpatient']),
  urgency: z.enum(['routine', 'urgent', 'emergency']),
  // Shown to the patient in their visit confirmation -- see visitReasonSchema.
  reason: visitReasonSchema,
  roomId: z.number().int().positive().optional(),
  // SP3: check in against a booked appointment (e.g. a follow-up) -- outpatient only.
  appointmentId: z.number().int().positive().optional(),
}).strict()

const CHECK_IN_ERRORS: Record<CheckInVisitError, { status: number; error: string }> = {
  appointment_not_found: { status: 404, error: 'Appointment not found' },
  appointment_mismatch: { status: 409, error: 'That appointment is for a different patient or doctor.' },
  appointment_not_scheduled: { status: 409, error: 'That appointment is not in a bookable state.' },
  appointment_not_today: { status: 409, error: 'That appointment is not today.' },
  appointment_already_checked_in: { status: 409, error: 'This appointment has already been checked in.' },
}

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CHECK_IN_ROLES.includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const body: unknown = json.body
  const parsed = checkInSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid check-in payload', details: parsed.error.flatten() }, { status: 400 })

  const { patientId, providerId, visitType, urgency, reason, roomId, appointmentId } = parsed.data

  if (visitType === 'outpatient' && roomId) {
    return NextResponse.json({ error: 'roomId is only valid for an inpatient check-in' }, { status: 400 })
  }
  if (visitType !== 'outpatient' && appointmentId !== undefined) {
    return NextResponse.json({ error: 'appointmentId is only valid for an outpatient check-in' }, { status: 400 })
  }

  // Verify the patient and provider actually exist BEFORE touching a room --
  // a bad providerId must never be able to strand a room as occupied with no
  // valid assignment behind it.
  const [patientRow] = await getDb().select({ id: patients.id }).from(patients).where(eq(patients.id, patientId))
  if (!patientRow) return NextResponse.json({ error: 'Patient not found' }, { status: 404 })

  const [providerRow] = await getDb().select({ id: providers.id }).from(providers).where(eq(providers.id, providerId))
  if (!providerRow) return NextResponse.json({ error: 'Provider not found' }, { status: 404 })

  // Checking in an inpatient IS starting their admission -- there's no
  // separate "start an admission" screen. Guard against double-admitting a
  // patient who's already an active inpatient (e.g. reception accidentally
  // re-checks someone in): the existing admission remains the current one.
  //
  // This lookup MUST happen before any room is claimed. If a room were
  // claimed first and this guard then fired, the just-claimed room would be
  // left permanently `occupied` with no admission ever pointing at it --
  // nothing else in the app knows to free it. When the patient is already
  // admitted AND a room was requested, reject the whole check-in instead:
  // moving an already-admitted patient into a different room is what
  // Transfer is for, not a second check-in.
  const existingActive = visitType === 'inpatient' ? await getActiveAdmissionForPatient(patientId) : null
  if (existingActive && roomId) {
    return NextResponse.json(
      { error: 'This patient is already admitted. Use Transfer to move them to a different room.' },
      { status: 409 },
    )
  }

  if (roomId) {
    const assigned = await assignRoomToPatient(roomId, patientId)
    if (!assigned) {
      return NextResponse.json({ error: 'That room is no longer available. Please choose another.' }, { status: 409 })
    }
  }

  // SP3: the assignment, its OPD token/lobby ticket, the admission, the
  // encounter, a booked follow-up's completion and the audit rows are one
  // transaction. (A room claimed above is not released if it throws -- a
  // pre-existing hazard flagged in the SP3 plan.)
  try {
    const result = await checkInVisit({
      patientId,
      providerId,
      visitType,
      urgency,
      reason,
      roomId: roomId ?? null,
      appointmentId: appointmentId ?? null,
      createAdmission: visitType === 'inpatient' && !existingActive,
    }, session)
    if (!result.ok) {
      const mapped = CHECK_IN_ERRORS[result.error]
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }
    return NextResponse.json({ ...result.assignment, encounterId: result.encounter.id, opdToken: result.encounter.opdToken }, { status: 201 })
  } catch (err) {
    if (isRetryableConflict(err)) return NextResponse.json({ error: RETRY_MESSAGE }, { status: 409 })
    console.error(`[check-in] failed (code ${pgErrorCode(err) ?? 'unknown'}, constraint ${pgConstraint(err) ?? 'none'})`)
    return NextResponse.json({ error: 'Could not check in the patient' }, { status: 500 })
  }
}
