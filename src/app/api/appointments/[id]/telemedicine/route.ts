import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { resolveDoctorQueueProvider } from '@/lib/doctor-queue-provider'
import { getAppointment } from '@/lib/queries/appointments'
import { createTelemedicineSession, getSessionByAppointmentId } from '@/lib/queries/telemedicine-sessions'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['admin', 'pi'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const appointmentId = Number(id)
  if (!Number.isInteger(appointmentId)) return NextResponse.json({ error: 'Invalid appointment id' }, { status: 400 })

  const appointment = await getAppointment(appointmentId)
  if (!appointment) return NextResponse.json({ error: 'Appointment not found' }, { status: 404 })

  // Ownership, BEFORE any write or token disclosure: a pi may only start (or
  // recover the join link of) a video visit on their own appointment. The
  // patient join token lets anyone join the call as the patient, so a
  // non-owner must never see it. Unresolved or ambiguous identity -> 403.
  // Admin may act on any appointment.
  if (session.role === 'pi') {
    const providerMatch = await resolveDoctorQueueProvider(session)
    if (!providerMatch || appointment.providerId !== providerMatch.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  const result = await createTelemedicineSession(appointmentId)
  if (!result.ok) {
    // Recover the already-existing session's id/token so a staff member who
    // refreshed (or double-clicked) before copying the link on the first
    // create can retry and get the same join link back, instead of a
    // dead-end error with no way to reach the call. See
    // StartTelemedicineButton.tsx, which renders the same copy-link UI on
    // this 409 body as it does on a fresh 201. Only reached by an authorized
    // caller (ownership checked above), and audited because it discloses the
    // patient join link.
    const existing = await getSessionByAppointmentId(appointmentId)
    if (existing) await logAudit(session, 'requested existing telemedicine session link', appointment.patientId)
    return NextResponse.json({ error: result.error, id: existing?.id, patientJoinToken: existing?.patientJoinToken }, { status: 409 })
  }

  await logAudit(session, 'started telemedicine session', appointment.patientId)
  return NextResponse.json({ id: result.session!.id, patientJoinToken: result.session!.patientJoinToken }, { status: 201 })
}
