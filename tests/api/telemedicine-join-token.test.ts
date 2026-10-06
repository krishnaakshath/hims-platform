import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, providers, appointments, telemedicineSessions, telemedicineSignals } from '@/db/schema'
import { createTelemedicineSession, endSession } from '@/lib/queries/telemedicine-sessions'
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

describe('GET/POST /api/telemedicine/join/[token]/signal', () => {
  it('a wrong/guessed token returns 404, not 403', async () => {
    const params = Promise.resolve({ token: 'not-a-real-token-at-all' })
    const postRes = await joinSignalPost(req('http://localhost', { signalType: 'offer', payload: {} }) as never, { params })
    expect(postRes.status).toBe(404)
    const getRes = await joinSignalGet(req('http://localhost?since=0') as never, { params })
    expect(getRes.status).toBe(404)
  })

  it('an already-completed session\'s token no longer connects a new call (Review Focus #3)', async () => {
    const session = await makeSession()
    await endSession(session.id)
    const params = Promise.resolve({ token: session.patientJoinToken })
    const getRes = await joinSignalGet(req(`http://localhost?since=0`) as never, { params })
    expect(getRes.status).toBe(404)
  })

  it('the correct token on a live session succeeds', async () => {
    const session = await makeSession()
    const params = Promise.resolve({ token: session.patientJoinToken })
    const postRes = await joinSignalPost(req('http://localhost', { signalType: 'answer', payload: { sdp: 'v=0...' } }) as never, { params })
    expect(postRes.status).toBe(201)
  })
})
