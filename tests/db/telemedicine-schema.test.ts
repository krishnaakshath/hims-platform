import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, providers, appointments, telemedicineSessions, telemedicineSignals } from '@/db/schema'

const createdSessionIds: number[] = []
const createdAppointmentIds: number[] = []
afterEach(async () => {
  while (createdSessionIds.length > 0) {
    const id = createdSessionIds.pop()!
    await getDb().delete(telemedicineSignals).where(eq(telemedicineSignals.sessionId, id))
    await getDb().delete(telemedicineSessions).where(eq(telemedicineSessions.id, id))
  }
  while (createdAppointmentIds.length > 0) await getDb().delete(appointments).where(eq(appointments.id, createdAppointmentIds.pop()!))
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
  return appt
}

describe('telemedicine schema', () => {
  it('creates a session with defaults and attaches a signal', async () => {
    const appt = await makeAppointment()
    const [session] = await getDb().insert(telemedicineSessions).values({ appointmentId: appt.id, patientJoinToken: `tok-${Date.now()}` }).returning()
    createdSessionIds.push(session.id)
    expect(session.status).toBe('scheduled')
    expect(session.providerJoinedAt).toBeNull()

    const [signal] = await getDb().insert(telemedicineSignals).values({
      sessionId: session.id, sender: 'provider', signalType: 'offer', payload: { sdp: 'v=0...' },
    }).returning()
    expect(signal.signalType).toBe('offer')
  })

  it('enforces one session per appointment via the unique constraint', async () => {
    const appt = await makeAppointment()
    await getDb().insert(telemedicineSessions).values({ appointmentId: appt.id, patientJoinToken: `tok-a-${Date.now()}` }).then(async () => {
      const [row] = await getDb().select().from(telemedicineSessions).where(eq(telemedicineSessions.appointmentId, appt.id))
      createdSessionIds.push(row.id)
    })
    await expect(getDb().insert(telemedicineSessions).values({ appointmentId: appt.id, patientJoinToken: `tok-b-${Date.now()}` })).rejects.toThrow()
  })

  it('enforces token uniqueness across sessions', async () => {
    const apptA = await makeAppointment()
    const apptB = await makeAppointment()
    const sharedToken = `tok-shared-${Date.now()}`
    const [sessionA] = await getDb().insert(telemedicineSessions).values({ appointmentId: apptA.id, patientJoinToken: sharedToken }).returning()
    createdSessionIds.push(sessionA.id)
    await expect(getDb().insert(telemedicineSessions).values({ appointmentId: apptB.id, patientJoinToken: sharedToken })).rejects.toThrow()
  })
})
