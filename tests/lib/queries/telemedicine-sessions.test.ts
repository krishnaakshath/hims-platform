import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, providers, appointments, telemedicineSessions, telemedicineSignals } from '@/db/schema'
import { createTelemedicineSession, getSessionById, getSessionByToken, markProviderJoined, markPatientJoined, endSession } from '@/lib/queries/telemedicine-sessions'

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

async function makeAppointment() {
  const db = getDb()
  const [patientRow] = await db.select().from(patients).limit(1)
  const [providerRow] = await db.select().from(providers).limit(1)
  const [appt] = await db.insert(appointments).values({
    patientId: patientRow.id, providerId: providerRow.id,
    startsAt: new Date(), endsAt: new Date(Date.now() + 30 * 60000), visitReason: 'Telemedicine test',
  }).returning()
  createdAppointmentIds.push(appt.id)
  return { appt, providerId: providerRow.id, patientId: patientRow.id }
}

describe('telemedicine session lifecycle', () => {
  it('creates a session with a unique token and scheduled status', async () => {
    const { appt, providerId, patientId } = await makeAppointment()
    const result = await createTelemedicineSession(appt.id)
    expect(result.ok).toBe(true)
    expect(result.session!.status).toBe('scheduled')
    expect(result.session!.appointmentProviderId).toBe(providerId)
    expect(result.session!.appointmentPatientId).toBe(patientId)
    expect(result.session!.patientJoinToken.length).toBeGreaterThan(20)
  })

  it('rejects creating a second session for the same appointment (token uniqueness / Review Focus #5)', async () => {
    const { appt } = await makeAppointment()
    const first = await createTelemedicineSession(appt.id)
    expect(first.ok).toBe(true)
    const second = await createTelemedicineSession(appt.id)
    expect(second.ok).toBe(false)
  })

  it('two genuinely concurrent creates for the same appointment: exactly one wins, the loser gets a clean ok:false (not an unhandled exception)', async () => {
    const { appt } = await makeAppointment()

    // Fired together via Promise.all against the real connection pool -- not
    // sequential calls disguised as concurrent -- so both requests' SELECT
    // pre-checks race for real, and the loser must hit the INSERT's unique
    // constraint (appointmentId.unique()) rather than the pre-check.
    const [resultA, resultB] = await Promise.all([
      createTelemedicineSession(appt.id),
      createTelemedicineSession(appt.id),
    ])

    const okCount = [resultA.ok, resultB.ok].filter(Boolean).length
    expect(okCount).toBe(1)

    const loser = resultA.ok ? resultB : resultA
    expect(loser.ok).toBe(false)
    expect(loser.error).toBe('A telemedicine session already exists for this appointment')

    // Only one row actually landed in the table.
    const rows = await getDb().select().from(telemedicineSessions).where(eq(telemedicineSessions.appointmentId, appt.id))
    expect(rows).toHaveLength(1)
  })

  it('transitions scheduled -> waiting -> in_progress as each side joins, then completed on end', async () => {
    const { appt } = await makeAppointment()
    const { session } = await createTelemedicineSession(appt.id)

    await markProviderJoined(session!.id)
    let current = await getSessionById(session!.id)
    expect(current!.status).toBe('waiting')
    expect(current!.providerJoinedAt).not.toBeNull()

    await markPatientJoined(session!.id)
    current = await getSessionById(session!.id)
    expect(current!.status).toBe('in_progress')
    expect(current!.patientJoinedAt).not.toBeNull()

    const ended = await endSession(session!.id)
    expect(ended.ok).toBe(true)
    current = await getSessionById(session!.id)
    expect(current!.status).toBe('completed')
    expect(current!.endedAt).not.toBeNull()
  })

  it('rejects ending an already-completed session', async () => {
    const { appt } = await makeAppointment()
    const { session } = await createTelemedicineSession(appt.id)
    await endSession(session!.id)
    const second = await endSession(session!.id)
    expect(second.ok).toBe(false)
  })

  it('a join call on an already-ended session does not resurrect it (Review Focus #3)', async () => {
    const { appt } = await makeAppointment()
    const { session } = await createTelemedicineSession(appt.id)
    await endSession(session!.id)
    await markPatientJoined(session!.id)
    const current = await getSessionById(session!.id)
    expect(current!.status).toBe('completed')
    expect(current!.patientJoinedAt).toBeNull()
  })

  it('getSessionByToken finds the session created above', async () => {
    const { appt } = await makeAppointment()
    const { session } = await createTelemedicineSession(appt.id)
    const found = await getSessionByToken(session!.patientJoinToken)
    expect(found!.id).toBe(session!.id)
  })
})
