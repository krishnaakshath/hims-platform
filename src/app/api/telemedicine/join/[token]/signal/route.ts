import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionById, getSessionByToken, markPatientJoined } from '@/lib/queries/telemedicine-sessions'
import { createSignal, listSignalsSince } from '@/lib/queries/telemedicine-signals'

// Deliberately NOT requireSession()-gated -- a joining patient has no staff
// account. Authorization here is possession of the unguessable
// patientJoinToken itself, checked below (a token that never existed and a
// token whose session has already ended are indistinguishable to the caller,
// by design -- see src/app/api/intake/[token]/route.ts for the same pattern).
async function resolveLiveSession(token: string) {
  const session = await getSessionByToken(token)
  if (!session || session.status === 'completed' || session.status === 'failed') return null
  return session
}

const signalSchema = z.object({
  signalType: z.enum(['offer', 'answer', 'ice_candidate']),
  payload: z.unknown(),
}).strict()

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const session = await resolveLiveSession(token)
  if (!session) return NextResponse.json({ error: 'This link is no longer valid.' }, { status: 404 })

  const parsed = signalSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid signal payload', details: parsed.error.flatten() }, { status: 400 })

  const created = await createSignal(session.id, 'patient', parsed.data.signalType, parsed.data.payload)
  return NextResponse.json({ id: created.id }, { status: 201 })
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const session = await resolveLiveSession(token)
  if (!session) return NextResponse.json({ error: 'This link is no longer valid.' }, { status: 404 })

  const url = new URL(request.url)
  const since = Number(url.searchParams.get('since')) || 0

  // Idempotent, called on every poll -- spec §3: "Sets patientJoinedAt,
  // transitions waiting -> in_progress once both sides have joined." Re-fetch
  // the session after so this response reports current status, not the stale
  // read from before the update (mirrors the provider route's own comment).
  await markPatientJoined(session.id)
  const refreshed = await getSessionById(session.id)

  // The patient always polls for the provider's signals -- no `for` query
  // param needed, unlike the provider-side route which can poll for either side.
  const signals = await listSignalsSince(session.id, since, 'provider')
  return NextResponse.json({ signals, sessionStatus: refreshed!.status })
}
