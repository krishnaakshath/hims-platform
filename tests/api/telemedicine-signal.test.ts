import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { POST as createSessionRoute } from '@/app/api/appointments/[id]/telemedicine/route'
import { POST as signalPost, GET as signalGet } from '@/app/api/telemedicine/[sessionId]/signal/route'
import { POST as endPost } from '@/app/api/telemedicine/[sessionId]/end/route'
import { getDb } from '@/db/client'
import { patients, appointments, telemedicineSessions, telemedicineSignals, auditLog } from '@/db/schema'
import { createTelemedicineSession } from '@/lib/queries/telemedicine-sessions'
import { listSignalsSince } from '@/lib/queries/telemedicine-signals'

// Mocked provider roster distinct from the real seeded providers table --
// the ownership check resolves session.name -> this mocked roster -> an id,
// which is then compared against the *real* appointment's providerId. This
// mirrors tests/api/inpatient-admissions-discharge.test.ts's pattern.
const MATCHING_PROVIDER_ID = 1 // real seeded provider id (Dr. Rajiv Kunam)
let sessionRole: 'admin' | 'pi' | 'crc' | 'frontdesk' = 'pi'
let sessionName = 'Dr. Chen'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: sessionName })) }))
vi.mock('@/lib/queries/providers', () => ({
  listActiveProviders: vi.fn(async () => [{ id: MATCHING_PROVIDER_ID, name: 'Dr. Chen', credentials: null, specialty: 'Psychiatry', colorTag: 'chart-1', isActive: true }]),
}))

const createdAppointmentIds: number[] = []
afterEach(async () => {
  sessionRole = 'pi'
  sessionName = 'Dr. Chen'
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

async function makeAppointment(providerId: number) {
  const db = getDb()
  const [patientRow] = await db.select().from(patients).limit(1)
  const [appt] = await db.insert(appointments).values({
    patientId: patientRow.id, providerId,
    startsAt: new Date(), endsAt: new Date(Date.now() + 30 * 60000), visitReason: 'Telemedicine test',
  }).returning()
  createdAppointmentIds.push(appt.id)
  return appt
}

async function makeSession(providerId: number) {
  const appt = await makeAppointment(providerId)
  const { session } = await createTelemedicineSession(appt.id)
  return session!
}

function jsonReq(body: unknown) {
  return new Request('http://localhost', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
}

function getReq(url: string) {
  return new Request(url, { method: 'GET' })
}

describe('POST /api/telemedicine/[sessionId]/signal ownership', () => {
  it('a pi session whose name matches the appointment provider succeeds on POST and GET', async () => {
    const session = await makeSession(MATCHING_PROVIDER_ID)
    sessionRole = 'pi'
    sessionName = 'Dr. Chen'

    const postRes = await signalPost(jsonReq({ signalType: 'offer', payload: { sdp: 'x' } }) as never, { params: Promise.resolve({ sessionId: String(session.id) }) })
    expect(postRes.status).toBe(201)

    const getRes = await signalGet(getReq(`http://localhost/api/telemedicine/${session.id}/signal?for=patient`) as never, { params: Promise.resolve({ sessionId: String(session.id) }) })
    expect(getRes.status).toBe(200)
  })

  it('a pi session whose name does not match the appointment provider gets 403 on POST and GET (Review Focus #1)', async () => {
    const otherProviderId = 2 // real seeded provider, distinct from MATCHING_PROVIDER_ID
    const session = await makeSession(otherProviderId)
    sessionRole = 'pi'
    sessionName = 'Dr. Chen' // resolves via mocked roster to MATCHING_PROVIDER_ID, which owns a different session

    const postRes = await signalPost(jsonReq({ signalType: 'offer', payload: { sdp: 'x' } }) as never, { params: Promise.resolve({ sessionId: String(session.id) }) })
    expect(postRes.status).toBe(403)

    const getRes = await signalGet(getReq(`http://localhost/api/telemedicine/${session.id}/signal?for=patient`) as never, { params: Promise.resolve({ sessionId: String(session.id) }) })
    expect(getRes.status).toBe(403)
  })

  it('an admin session succeeds regardless of name match, on the same non-matching-provider session', async () => {
    const otherProviderId = 2
    const session = await makeSession(otherProviderId)
    sessionRole = 'admin'
    sessionName = 'Someone Else Entirely'

    const postRes = await signalPost(jsonReq({ signalType: 'offer', payload: { sdp: 'x' } }) as never, { params: Promise.resolve({ sessionId: String(session.id) }) })
    expect(postRes.status).toBe(201)

    const getRes = await signalGet(getReq(`http://localhost/api/telemedicine/${session.id}/signal?for=patient`) as never, { params: Promise.resolve({ sessionId: String(session.id) }) })
    expect(getRes.status).toBe(200)
  })
})

describe('POST /api/telemedicine/[sessionId]/end ownership', () => {
  it('a matching pi succeeds', async () => {
    const session = await makeSession(MATCHING_PROVIDER_ID)
    sessionRole = 'pi'
    sessionName = 'Dr. Chen'

    const res = await endPost(jsonReq({}) as never, { params: Promise.resolve({ sessionId: String(session.id) }) })
    expect(res.status).toBe(200)
  })

  it('a non-matching pi gets 403', async () => {
    const session = await makeSession(2)
    sessionRole = 'pi'
    sessionName = 'Dr. Chen'

    const res = await endPost(jsonReq({}) as never, { params: Promise.resolve({ sessionId: String(session.id) }) })
    expect(res.status).toBe(403)
  })

  it('an admin always succeeds', async () => {
    const session = await makeSession(2)
    sessionRole = 'admin'
    sessionName = 'Someone Else Entirely'

    const res = await endPost(jsonReq({}) as never, { params: Promise.resolve({ sessionId: String(session.id) }) })
    expect(res.status).toBe(200)
  })
})

describe('cross-session signal isolation (Review Focus #4)', () => {
  it('signals posted to session A never appear in session B\'s results, and vice versa', async () => {
    sessionRole = 'admin'
    sessionName = 'Admin User'
    const sessionA = await makeSession(MATCHING_PROVIDER_ID)
    const sessionB = await makeSession(2)

    const postA = await signalPost(jsonReq({ signalType: 'offer', payload: { marker: 'A' } }) as never, { params: Promise.resolve({ sessionId: String(sessionA.id) }) })
    expect(postA.status).toBe(201)
    const postB = await signalPost(jsonReq({ signalType: 'offer', payload: { marker: 'B' } }) as never, { params: Promise.resolve({ sessionId: String(sessionB.id) }) })
    expect(postB.status).toBe(201)

    const signalsA = await listSignalsSince(sessionA.id, 0, 'provider')
    const signalsB = await listSignalsSince(sessionB.id, 0, 'provider')

    expect(signalsA).toHaveLength(1)
    expect(signalsA[0].payload).toEqual({ marker: 'A' })
    expect(signalsB).toHaveLength(1)
    expect(signalsB[0].payload).toEqual({ marker: 'B' })

    // Neither session's signal ids ever cross into the other's result set.
    const idsA = signalsA.map((s) => s.id)
    const idsB = signalsB.map((s) => s.id)
    expect(idsA.some((id) => idsB.includes(id))).toBe(false)
  })
})

describe('POST /api/appointments/[id]/telemedicine', () => {
  it('rejects a second call for the same appointment with 409 (Review Focus #5)', async () => {
    sessionRole = 'admin'
    sessionName = 'Admin User'
    const appt = await makeAppointment(MATCHING_PROVIDER_ID)

    const first = await createSessionRoute(jsonReq({}) as never, { params: Promise.resolve({ id: String(appt.id) }) })
    expect(first.status).toBe(201)

    const second = await createSessionRoute(jsonReq({}) as never, { params: Promise.resolve({ id: String(appt.id) }) })
    expect(second.status).toBe(409)
  })

  it('a 409 (session already exists) recovers the SAME session\'s real id/patientJoinToken, not a new one (final review fix, Important #1)', async () => {
    sessionRole = 'admin'
    sessionName = 'Admin User'
    const appt = await makeAppointment(MATCHING_PROVIDER_ID)

    const first = await createSessionRoute(jsonReq({}) as never, { params: Promise.resolve({ id: String(appt.id) }) })
    expect(first.status).toBe(201)
    const firstBody = await first.json()

    // Simulate a "second click" -- staff refreshed or double-clicked after
    // already creating a session for this appointment, before copying the
    // join link. The 409 body must now carry that same first session's
    // id/token, not just a bare error string, so the UI can recover it.
    const second = await createSessionRoute(jsonReq({}) as never, { params: Promise.resolve({ id: String(appt.id) }) })
    expect(second.status).toBe(409)
    const secondBody = await second.json()

    expect(secondBody.id).toBe(firstBody.id)
    expect(secondBody.patientJoinToken).toBe(firstBody.patientJoinToken)
    expect(typeof secondBody.error).toBe('string')
  })
})

// RBAC Task 18: a pi may only start (or recover the join link of) a video
// visit for an appointment they own; admin may act on any appointment.
describe('POST /api/appointments/[id]/telemedicine ownership', () => {
  function createReq(apptId: number) {
    return createSessionRoute(jsonReq({}) as never, { params: Promise.resolve({ id: String(apptId) }) })
  }
  async function sessionRowFor(apptId: number) {
    const [row] = await getDb().select({ id: telemedicineSessions.id }).from(telemedicineSessions).where(eq(telemedicineSessions.appointmentId, apptId))
    return row ?? null
  }

  it('the owning pi gets 201 with a token, then 409 with the same token', async () => {
    const appt = await makeAppointment(MATCHING_PROVIDER_ID)
    sessionRole = 'pi'
    sessionName = 'Dr. Chen'

    const first = await createReq(appt.id)
    expect(first.status).toBe(201)
    const firstBody = await first.json()
    expect(typeof firstBody.patientJoinToken).toBe('string')

    const second = await createReq(appt.id)
    expect(second.status).toBe(409)
    const secondBody = await second.json()
    expect(secondBody.patientJoinToken).toBe(firstBody.patientJoinToken)
  })

  it('a non-owner pi gets 403 on create and no session row is written', async () => {
    const appt = await makeAppointment(2)
    sessionRole = 'pi'
    sessionName = 'Dr. Chen' // resolves to MATCHING_PROVIDER_ID, not 2

    const res = await createReq(appt.id)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
    expect(await sessionRowFor(appt.id)).toBeNull()
  })

  it('a non-owner pi gets 403 with no token on the existing-session (409) path', async () => {
    const appt = await makeAppointment(2)
    sessionRole = 'admin'
    sessionName = 'Admin User'
    const first = await createReq(appt.id)
    expect(first.status).toBe(201)
    const { patientJoinToken } = await first.json()

    sessionRole = 'pi'
    sessionName = 'Dr. Chen'
    const res = await createReq(appt.id)
    expect(res.status).toBe(403)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ error: 'Forbidden' })
    expect(text).not.toContain(patientJoinToken)
  })

  it('a non-owner 403 on the existing-session path writes no link-request audit row', async () => {
    const appt = await makeAppointment(2)
    sessionRole = 'admin'
    sessionName = 'Admin User'
    expect((await createReq(appt.id)).status).toBe(201)

    // Unique probe (surname last, so it resolves to MATCHING_PROVIDER_ID,
    // which does not own this appointment). Audit rows are never deleted.
    const probe = `Dr. Probe${Date.now()}${Math.random().toString(36).slice(2, 8)} Chen`
    sessionRole = 'pi'
    sessionName = probe
    const res = await createReq(appt.id)
    expect(res.status).toBe(403)

    const rows = await getDb().select().from(auditLog).where(eq(auditLog.userName, probe))
    expect(rows.filter((r) => r.action === 'requested existing telemedicine session link')).toHaveLength(0)
    expect(rows).toHaveLength(0)
  })

  it('a pi whose name resolves to no provider gets 403 (fail closed)', async () => {
    const appt = await makeAppointment(MATCHING_PROVIDER_ID)
    sessionRole = 'pi'
    sessionName = 'Dr. Nobody Matchington'

    const res = await createReq(appt.id)
    expect(res.status).toBe(403)
    expect(await sessionRowFor(appt.id)).toBeNull()
  })

  it('admin may start a visit on any provider\'s appointment', async () => {
    const appt = await makeAppointment(2)
    sessionRole = 'admin'
    sessionName = 'Someone Else Entirely'

    const res = await createReq(appt.id)
    expect(res.status).toBe(201)
  })

  it('the 409 existing-session path writes an audit row for the authorized caller', async () => {
    const appt = await makeAppointment(MATCHING_PROVIDER_ID)
    sessionRole = 'pi'
    sessionName = 'Dr. Chen'
    expect((await createReq(appt.id)).status).toBe(201)

    // Unique probe name so the assertion only ever sees this test's row.
    // Audit rows are append-only compliance records: never deleted here.
    // The surname stays last so it still resolves to the owning provider.
    const probe = `Dr. Probe${Date.now()}${Math.random().toString(36).slice(2, 8)} Chen`
    sessionName = probe
    const res = await createReq(appt.id)
    expect(res.status).toBe(409)

    const rows = await getDb().select().from(auditLog).where(eq(auditLog.userName, probe))
    expect(rows).toHaveLength(1)
    expect(rows[0].action).toBe('requested existing telemedicine session link')
    expect(rows[0].role).toBe('pi')
    expect(rows[0].patientId).toBe(appt.patientId)
  })
})
