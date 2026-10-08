import { NextRequest, NextResponse } from 'next/server'
import { parseId, readJsonBody } from '@/lib/http'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients } from '@/db/schema'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getBookingRequestById, confirmBookingRequest, confirmCancelRequest } from '@/lib/queries/booking-requests'
import { visitReasonSchema } from '@/lib/visit-reason-schema'
import { appointmentInstantSchema, invalidAppointmentTime, isTimeFieldError } from '@/lib/appointment-time'

const confirmBookingRequestSchema = z.object({
  patientId: z.string().min(1),
  providerId: z.number().int().positive(),
  startsAt: appointmentInstantSchema,
  endsAt: appointmentInstantSchema,
  visitReason: visitReasonSchema,
}).strict()

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['admin', 'crc', 'frontdesk'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const requestId = parseId(id)
  if (requestId === null) return NextResponse.json({ error: 'Invalid booking request id' }, { status: 400 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const body: unknown = json.body

  // Wave J (P1-20): a portal cancellation request is confirmed with an empty body -- there is
  // no time to choose; confirming cancels the patient's appointment.
  if (body !== null && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0) {
    const pending = await getBookingRequestById(requestId)
    if (!pending) return NextResponse.json({ error: 'Booking request not found' }, { status: 404 })
    if (pending.requestKind !== 'cancel') return NextResponse.json({ error: 'Invalid confirm payload' }, { status: 400 })
    const cancelled = await confirmCancelRequest(requestId, session)
    if (!cancelled.ok) return NextResponse.json({ error: cancelled.error }, { status: 409 })
    return NextResponse.json({ ok: true, appointmentId: cancelled.appointmentId })
  }
  // end Wave J

  const parsed = confirmBookingRequestSchema.safeParse(body)
  if (!parsed.success && isTimeFieldError(parsed.error)) return invalidAppointmentTime()
  if (!parsed.success) return NextResponse.json({ error: 'Invalid confirm payload', details: parsed.error.flatten() }, { status: 400 })

  const startsAt = new Date(parsed.data.startsAt)
  const endsAt = new Date(parsed.data.endsAt)
  if (isNaN(startsAt.getTime()) || isNaN(endsAt.getTime()) || endsAt <= startsAt) {
    return NextResponse.json({ error: 'endsAt must be a valid time after startsAt' }, { status: 400 })
  }

  const existing = await getBookingRequestById(requestId)
  if (!existing) return NextResponse.json({ error: 'Booking request not found' }, { status: 404 })
  // Wave J: a portal request is for its own patient only, and a cancellation has no new time.
  if (existing.requestKind === 'cancel') return NextResponse.json({ error: 'A cancellation request is confirmed without appointment details' }, { status: 400 })
  if (existing.patientId !== null && existing.patientId !== parsed.data.patientId) {
    return NextResponse.json({ error: 'This request was made by a different patient' }, { status: 400 })
  }
  // end Wave J

  // Validate patientId refers to a real patient BEFORE calling
  // confirmBookingRequest -- that function flips the request's status to
  // 'confirmed' and only then inserts the appointments row, so a bad
  // patientId (e.g. a staff typo in this free-text field) discovered by a
  // FK violation at insert time would leave the request permanently stuck
  // 'confirmed' with no appointment and no retry path (a retry just 409s
  // "already resolved"). Same "does not reference a real X" pattern already
  // used for preferredProviderId on the public submission route.
  const [patientRow] = await getDb().select({ id: patients.id }).from(patients).where(eq(patients.id, parsed.data.patientId))
  if (!patientRow) return NextResponse.json({ error: 'patientId does not reference a real patient' }, { status: 400 })

  const result = await confirmBookingRequest(requestId, {
    patientId: parsed.data.patientId,
    providerId: parsed.data.providerId,
    startsAt,
    endsAt,
    visitReason: parsed.data.visitReason,
    reviewedByName: session.name,
    rescheduleFromAppointmentId: existing.requestKind === 'reschedule' ? existing.appointmentId : null, // Wave J
  })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 })

  await logAudit(session, existing.requestKind === 'reschedule' ? 'confirmed appointment reschedule request' : 'confirmed booking request', parsed.data.patientId) // Wave J
  return NextResponse.json(result)
}
