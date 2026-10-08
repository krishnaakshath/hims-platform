import { NextRequest, NextResponse } from 'next/server'
import { parseId, readJsonBody } from '@/lib/http'
import { z } from 'zod'
import { requireSession, type Session } from '@/lib/auth'
import { resolveDoctorQueueProvider } from '@/lib/doctor-queue-provider'
import { getSessionById, markProviderJoined, type TelemedicineSessionRow } from '@/lib/queries/telemedicine-sessions'
import { createSignal, listSignalsSince } from '@/lib/queries/telemedicine-signals'

const signalSchema = z.object({
  signalType: z.enum(['offer', 'answer', 'ice_candidate']),
  payload: z.unknown(),
}).strict()

/**
 * Resolves the telemedicine session for `sessionId` and enforces the same
 * provider-ownership rule as inpatient/admissions/[id]/discharge/route.ts:
 * role-gated to admin/pi, and for pi specifically, the session must resolve
 * (resolveDoctorQueueProvider: FK link, then exact surname) to the session's
 * own provider; unresolved or ambiguous -> 403.
 * Returns a ready NextResponse on any failure so both POST and GET can
 * short-circuit with `if ('response' in result) return result.response`.
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
  // Wave I: role gate before the path id is parsed (ownership is still checked below).
  if (!['admin', 'pi'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { sessionId } = await params
  const id = parseId(sessionId)
  if (id === null) return NextResponse.json({ error: 'Invalid session id' }, { status: 400 })

  const resolved = await resolveOwnedSession(session, id)
  if ('response' in resolved) return resolved.response

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = signalSchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid signal payload', details: parsed.error.flatten() }, { status: 400 })

  const created = await createSignal(id, 'provider', parsed.data.signalType, parsed.data.payload)
  return NextResponse.json({ id: created.id }, { status: 201 })
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  // Wave I: role gate before the path id is parsed (ownership is still checked below).
  if (!['admin', 'pi'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { sessionId } = await params
  const id = parseId(sessionId)
  if (id === null) return NextResponse.json({ error: 'Invalid session id' }, { status: 400 })

  const resolved = await resolveOwnedSession(session, id)
  if ('response' in resolved) return resolved.response

  const url = new URL(request.url)
  const forParam = url.searchParams.get('for')
  if (forParam !== 'patient') return NextResponse.json({ error: "Query param 'for' must be 'patient'" }, { status: 400 })
  const since = Number(url.searchParams.get('since')) || 0

  // Idempotent, called on every poll -- spec §3: "transitions scheduled ->
  // waiting on first poll." Re-fetch status after so a first-ever poll
  // reports 'waiting', not the stale 'scheduled' read before the update.
  await markProviderJoined(id)
  const telemedicineSession = await getSessionById(id)

  const signals = await listSignalsSince(id, since, 'patient')
  return NextResponse.json({ signals, sessionStatus: telemedicineSession!.status })
}
