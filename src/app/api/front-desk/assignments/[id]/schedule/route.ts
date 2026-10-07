import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { doctorAssignments } from '@/db/schema'
import { scheduleAssignmentIntoAppointment, notifyPatientOfScheduledAssignment } from '@/lib/queries/doctor-assignments'
import { resolveDoctorQueueProvider } from '@/lib/doctor-queue-provider'
import { appointmentInstantSchema, invalidAppointmentTime, isTimeFieldError } from '@/lib/appointment-time'

// Only the time slot comes from the client. The visit reason is taken from
// the stored assignment row server-side, so a crafted body cannot put
// arbitrary text into the patient's automated confirmation; .strict() makes a
// stray `visitReason` key a 400 like any other unknown key.
const scheduleSchema = z.object({
  startsAt: appointmentInstantSchema,
  endsAt: appointmentInstantSchema,
}).strict()

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'pi') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const assignmentId = Number(id)
  if (!Number.isInteger(assignmentId)) return NextResponse.json({ error: 'Invalid assignment id' }, { status: 400 })

  const parsed = scheduleSchema.safeParse(await request.json())
  if (!parsed.success && isTimeFieldError(parsed.error)) return invalidAppointmentTime()
  if (!parsed.success) return NextResponse.json({ error: 'Invalid schedule payload', details: parsed.error.flatten() }, { status: 400 })

  const startsAt = new Date(parsed.data.startsAt)
  const endsAt = new Date(parsed.data.endsAt)
  if (isNaN(startsAt.getTime()) || isNaN(endsAt.getTime()) || endsAt <= startsAt) {
    return NextResponse.json({ error: 'endsAt must be a valid time after startsAt' }, { status: 400 })
  }

  const db = getDb()
  const [assignmentRow] = await db.select().from(doctorAssignments).where(eq(doctorAssignments.id, assignmentId))
  if (!assignmentRow) return NextResponse.json({ error: 'Assignment not found' }, { status: 404 })

  // Ownership check: the same provider resolution /doctor and the nav badge
  // use (real user->provider link first, then the guarded last-name
  // fallback), so a PI can only schedule assignments the page shows them.
  const providerMatch = await resolveDoctorQueueProvider(session)
  if (!providerMatch || assignmentRow.providerId !== providerMatch.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const alreadyHandled = { error: 'This assignment has already been scheduled or declined.' }
  if (assignmentRow.status !== 'pending') {
    return NextResponse.json(alreadyHandled, { status: 409 })
  }

  // I7: the doctor's schedule lock, the conflict check, the appointment and the
  // pending -> scheduled transition are one transaction. A concurrent
  // schedule/decline rolls the appointment back with it (no orphan).
  const scheduled = await scheduleAssignmentIntoAppointment(assignmentId, {
    patientId: assignmentRow.patientId,
    providerId: assignmentRow.providerId,
    startsAt,
    endsAt,
    visitReason: assignmentRow.reason,
  })
  if (!scheduled.ok) {
    if (scheduled.error === 'conflict') return NextResponse.json({ error: 'You already have an appointment during that time.' }, { status: 409 })
    return NextResponse.json(alreadyHandled, { status: 409 })
  }
  const { assignment: updated, appointment } = scheduled
  try {
    await notifyPatientOfScheduledAssignment(updated, appointment, providerMatch.name)
  } catch (err) {
    // The appointment is already committed; only the patient message failed.
    console.error('Failed to notify patient of scheduled assignment', err)
    await logAudit(session, 'scheduled assignment into appointment; patient notification FAILED', assignmentRow.patientId)
    return NextResponse.json(
      { error: 'The appointment was scheduled, but the confirmation message to the patient could not be sent. Please message the patient manually.' },
      { status: 500 },
    )
  }
  await logAudit(session, 'scheduled assignment into appointment and notified patient', assignmentRow.patientId)
  // Re-read so the response reflects patientNotifiedAt set by the notify step.
  const [final] = await db.select().from(doctorAssignments).where(eq(doctorAssignments.id, assignmentId))
  return NextResponse.json(final ?? updated, { status: 200 })
}
