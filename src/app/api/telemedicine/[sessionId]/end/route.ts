import { NextRequest, NextResponse } from 'next/server'
import { requireSession, type Session } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { resolveDoctorQueueProvider } from '@/lib/doctor-queue-provider'
import { getSessionById, endSession, type TelemedicineSessionRow } from '@/lib/queries/telemedicine-sessions'

/**
 * Same ownership resolution as
 * src/app/api/telemedicine/[sessionId]/signal/route.ts (see that file's
 * comment): role-gated to admin/pi, and for pi specifically, the session
 * must resolve (resolveDoctorQueueProvider: FK link, then exact surname) to
 * the session's own provider; unresolved or ambiguous -> 403.
 */
async function resolveOwnedSession(session: Session, sessionId: number): Promise<{ telemedicineSession: TelemedicineSessionRow } | { response: NextResponse }> {
  if (!['admin', 'pi'].includes(session.role)) return { response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }

  const telemedicineSession = await getSessionById(sessionId)
  if (!telemedicineSession) return { response: NextResponse.json({ error: 'Session not found' }, { status: 404 }) }

  if (session.role === 'pi') {
    const providerMatch = await resolveDoctorQueueProvider(session)
    if (!providerMatch || telemedicineSession.appointmentProviderId !== providerMatch.id) {
      return { response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
    }
  }

  return { telemedicineSession }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session

  const { sessionId } = await params
  const id = Number(sessionId)
  if (!Number.isInteger(id)) return NextResponse.json({ error: 'Invalid session id' }, { status: 400 })

  const resolved = await resolveOwnedSession(session, id)
  if ('response' in resolved) return resolved.response

  const result = await endSession(id)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 })

  await logAudit(session, 'ended telemedicine session', resolved.telemedicineSession.appointmentPatientId)
  return NextResponse.json({ ok: true })
}
