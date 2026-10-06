import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, providers, appointments, telemedicineSessions, telemedicineSignals } from '@/db/schema'
import { createTelemedicineSession, getSessionById, markProviderJoined } from '@/lib/queries/telemedicine-sessions'
import { listSignalsSince } from '@/lib/queries/telemedicine-signals'
import { POST as joinSignalPost, GET as joinSignalGet } from '@/app/api/telemedicine/join/[token]/signal/route'

const createdAppointmentIds: number[] = []
afterEach(async () => {
  while (createdAppointmentIds.length > 0) {
    const id = createdAppointmentIds.pop()!
    const [session] = await getDb().select().from(telemedicineSessions).where(eq(telemedicineSessions.appointmentId, id))
    if (session) {
      await getDb().delete(telemedicineSignals).where(eq(telemedicineSignals.sessionId, session.id))
      await getDb().delete(telemedicineSessions).where(eq(telemedicineSessions.id, session.id))
    }
    await getDb().delete(appointments).where(eq(appointments.id, id))
  }
})

async function makeSession() {
  const db = getDb()
  const [patientRow] = await db.select().from(patients).limit(1)
  const [providerRow] = await db.select().from(providers).limit(1)
  const [appt] = await db.insert(appointments).values({
    patientId: patientRow.id, providerId: providerRow.id,
    startsAt: new Date(), endsAt: new Date(Date.now() + 30 * 60000), visitReason: 'Telemedicine test',
  }).returning()
  createdAppointmentIds.push(appt.id)
  const { session } = await createTelemedicineSession(appt.id)
  return session!
}

function req(url: string, body?: unknown) {
  return body === undefined
    ? new Request(url)
    : new Request(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
}

describe('GET /api/telemedicine/join/[token]/signal', () => {
  it('on a fresh scheduled session, returns 200 with current status and no signals', async () => {
    const session = await makeSession()
    expect(session.status).toBe('scheduled')
    const params = Promise.resolve({ token: session.patientJoinToken })

    const getRes = await joinSignalGet(req('http://localhost?since=0') as never, { params })
    expect(getRes.status).toBe(200)
    const body = await getRes.json()
    expect(body.signals).toEqual([])
    // The patient's own GET marks patientJoined, but markPatientJoined only
    // advances status out of 'waiting' (and only when the provider has also
    // already joined) -- with the provider never having joined, status stays
    // 'scheduled'.
    expect(body.sessionStatus).toBe('scheduled')
  })

  it('transitions waiting -> in_progress on the patient\'s first poll once the provider has already joined', async () => {
    const session = await makeSession()
    // Simulate Task 2's provider-side GET route having already polled once.
    await markProviderJoined(session.id)
    const afterProviderJoin = await getSessionById(session.id)
    expect(afterProviderJoin!.status).toBe('waiting')

    const params = Promise.resolve({ token: session.patientJoinToken })
    const getRes = await joinSignalGet(req('http://localhost?since=0') as never, { params })
    expect(getRes.status).toBe(200)
    const body = await getRes.json()
    expect(body.sessionStatus).toBe('in_progress')

    const afterPatientJoin = await getSessionById(session.id)
    expect(afterPatientJoin!.status).toBe('in_progress')
    expect(afterPatientJoin!.patientJoinedAt).not.toBeNull()
  })

  it('a patient answer signal posted via the route is visible to the provider side via listSignalsSince', async () => {
    const session = await makeSession()
    const params = Promise.resolve({ token: session.patientJoinToken })

    const postRes = await joinSignalPost(req('http://localhost', { signalType: 'answer', payload: { sdp: 'v=0...' } }) as never, { params })
    expect(postRes.status).toBe(201)

    // Provider side is already covered by tests/api/telemedicine-signal.test.ts;
    // here we just confirm the underlying data is visible via the same query
    // that route's GET handler uses.
    const providerVisibleSignals = await listSignalsSince(session.id, 0, 'patient')
    expect(providerVisibleSignals).toHaveLength(1)
    expect(providerVisibleSignals[0].signalType).toBe('answer')
    expect(providerVisibleSignals[0].payload).toEqual({ sdp: 'v=0...' })
  })
})
