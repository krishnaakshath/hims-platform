import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getDb } from '@/db/client'
import { patients, providers } from '@/db/schema'
import { assignRoomToPatient } from '@/lib/queries/rooms'
import { createDoctorAssignment } from '@/lib/queries/doctor-assignments'
import { createAdmission, getActiveAdmissionForPatient } from '@/lib/queries/admissions'
import { visitReasonSchema } from '@/lib/visit-reason-schema'

const checkInSchema = z.object({
  patientId: z.string().min(1),
  providerId: z.number().int().positive(),
  visitType: z.enum(['inpatient', 'outpatient']),
  urgency: z.enum(['routine', 'urgent', 'emergency']),
  // Shown to the patient in their visit confirmation -- see visitReasonSchema.
  reason: visitReasonSchema,
  roomId: z.number().int().positive().optional(),
}).strict()

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['frontdesk', 'admin', 'crc'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const parsed = checkInSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid check-in payload', details: parsed.error.flatten() }, { status: 400 })

  const { patientId, providerId, visitType, urgency, reason, roomId } = parsed.data

  if (visitType === 'outpatient' && roomId) {
    return NextResponse.json({ error: 'roomId is only valid for an inpatient check-in' }, { status: 400 })
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

  const created = await createDoctorAssignment({
    patientId,
    providerId,
    visitType,
    urgency,
    reason,
    roomId: roomId ?? null,
    assignedByName: session.name,
  })

  if (visitType === 'inpatient' && !existingActive) {
    await createAdmission({
      patientId,
      roomId: roomId ?? null,
      attendingProviderId: providerId,
      admissionType: 'elective',
      createdFromAssignmentId: created.id,
    })
  }

  await logAudit(session, `checked in patient (${visitType})`, patientId)
  return NextResponse.json(created, { status: 201 })
}
