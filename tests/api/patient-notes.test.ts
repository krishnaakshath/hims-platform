import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { POST as createRoute } from '@/app/api/patients/[anonId]/notes/route'
import { PUT as signRoute } from '@/app/api/patients/[anonId]/notes/[id]/sign/route'
import { getDb } from '@/db/client'
import { patients, providers, rooms, admissions, appointments, encounterNotes } from '@/db/schema'

let sessionRole: 'admin' | 'pi' | 'crc' | 'frontdesk' = 'pi'
let sessionName = 'Dr. R. Kunam'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: sessionName })) }))

const createdNoteIds: number[] = []
const createdAdmissionIds: number[] = []
const createdRoomIds: number[] = []
const createdAppointmentIds: number[] = []
afterEach(async () => {
  sessionRole = 'pi'
  sessionName = 'Dr. R. Kunam'
  while (createdNoteIds.length > 0) await getDb().delete(encounterNotes).where(eq(encounterNotes.id, createdNoteIds.pop()!))
  while (createdAdmissionIds.length > 0) await getDb().delete(admissions).where(eq(admissions.id, createdAdmissionIds.pop()!))
  while (createdRoomIds.length > 0) await getDb().delete(rooms).where(eq(rooms.id, createdRoomIds.pop()!))
  while (createdAppointmentIds.length > 0) await getDb().delete(appointments).where(eq(appointments.id, createdAppointmentIds.pop()!))
})

function req(body: unknown) {
  return new Request('http://localhost', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
}

describe('POST /api/patients/[anonId]/notes', () => {
  it('creates a draft note', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const res = await createRoute(req({ noteType: 'progress', subjective: 'Test' }) as never, { params: Promise.resolve({ anonId: patientRow.id }) })
    expect(res.status).toBe(201)
    const body = await res.json()
    createdNoteIds.push(body.id)
    expect(body.status).toBe('draft')
    expect(body.authorName).toBe('Dr. R. Kunam')
  })

  it('rejects both appointmentId and admissionId set at once', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const [admissionRow] = await getDb().select().from(admissions).limit(1)
    const res = await createRoute(req({ noteType: 'progress', appointmentId: 1, admissionId: admissionRow?.id ?? 1 }) as never, { params: Promise.resolve({ anonId: patientRow.id }) })
    expect(res.status).toBe(400)
  })

  it('rejects a frontdesk session', async () => {
    sessionRole = 'frontdesk'
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const res = await createRoute(req({ noteType: 'progress' }) as never, { params: Promise.resolve({ anonId: patientRow.id }) })
    expect(res.status).toBe(403)
  })

  it('rejects an admissionId belonging to a different patient', async () => {
    const patientRows = await getDb().select().from(patients).limit(2)
    if (patientRows.length < 2) throw new Error('This test needs at least 2 seeded patients -- run npm run db:seed')
    const [patientA, patientB] = patientRows

    // A real admission that genuinely belongs to patientB, not patientA.
    const [room] = await getDb().insert(rooms).values({ ward: 'Test Ward', roomNumber: 'CP1', bedNumber: 'A' }).returning()
    createdRoomIds.push(room.id)
    const [providerRow] = await getDb().select().from(providers).limit(1)
    const [admissionForB] = await getDb().insert(admissions).values({ patientId: patientB.id, currentRoomId: room.id, attendingProviderId: providerRow.id }).returning()
    createdAdmissionIds.push(admissionForB.id)

    // Attempt to create a note for patientA that references patientB's admission.
    const res = await createRoute(req({ noteType: 'progress', admissionId: admissionForB.id }) as never, { params: Promise.resolve({ anonId: patientA.id }) })
    expect(res.status).toBe(400)
  })

  it('rejects an appointmentId belonging to a different patient', async () => {
    const patientRows = await getDb().select().from(patients).limit(2)
    if (patientRows.length < 2) throw new Error('This test needs at least 2 seeded patients -- run npm run db:seed')
    const [patientA, patientB] = patientRows

    // A real appointment that genuinely belongs to patientB, not patientA.
    const [providerRow] = await getDb().select().from(providers).limit(1)
    const [appointmentForB] = await getDb().insert(appointments).values({
      patientId: patientB.id,
      providerId: providerRow.id,
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 30 * 60 * 1000),
      visitReason: 'Test visit',
    }).returning()
    createdAppointmentIds.push(appointmentForB.id)

    // Attempt to create a note for patientA that references patientB's appointment.
    const res = await createRoute(req({ noteType: 'progress', appointmentId: appointmentForB.id }) as never, { params: Promise.resolve({ anonId: patientA.id }) })
    expect(res.status).toBe(400)
  })
})

describe('PUT /api/patients/[anonId]/notes/[id]/sign', () => {
  it('signs a draft note as its author', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const createRes = await createRoute(req({ noteType: 'progress' }) as never, { params: Promise.resolve({ anonId: patientRow.id }) })
    const created = await createRes.json()
    createdNoteIds.push(created.id)

    const signRes = await signRoute(new Request('http://localhost', { method: 'PUT' }) as never, { params: Promise.resolve({ anonId: patientRow.id, id: String(created.id) }) })
    expect(signRes.status).toBe(200)
  })

  it('rejects signing by a different pi than the author', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const createRes = await createRoute(req({ noteType: 'progress' }) as never, { params: Promise.resolve({ anonId: patientRow.id }) })
    const created = await createRes.json()
    createdNoteIds.push(created.id)

    sessionName = 'A Different Doctor'
    const signRes = await signRoute(new Request('http://localhost', { method: 'PUT' }) as never, { params: Promise.resolve({ anonId: patientRow.id, id: String(created.id) }) })
    expect(signRes.status).toBe(403)
  })

  it('rejects signing an already-signed note a second time', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const createRes = await createRoute(req({ noteType: 'progress' }) as never, { params: Promise.resolve({ anonId: patientRow.id }) })
    const created = await createRes.json()
    createdNoteIds.push(created.id)

    const firstSign = await signRoute(new Request('http://localhost', { method: 'PUT' }) as never, { params: Promise.resolve({ anonId: patientRow.id, id: String(created.id) }) })
    expect(firstSign.status).toBe(200)

    const secondSign = await signRoute(new Request('http://localhost', { method: 'PUT' }) as never, { params: Promise.resolve({ anonId: patientRow.id, id: String(created.id) }) })
    expect(secondSign.status).toBe(409)
  })

  it('rejects signing a note through a different patient\'s URL than the one it belongs to', async () => {
    const patientRows = await getDb().select().from(patients).limit(2)
    if (patientRows.length < 2) throw new Error('This test needs at least 2 seeded patients -- run npm run db:seed')
    const [patientA, patientB] = patientRows

    // A real note that genuinely belongs to patientA, not patientB.
    const createRes = await createRoute(req({ noteType: 'progress' }) as never, { params: Promise.resolve({ anonId: patientA.id }) })
    const created = await createRes.json()
    createdNoteIds.push(created.id)

    // Attempt to sign patientA's note via patientB's URL.
    const signRes = await signRoute(new Request('http://localhost', { method: 'PUT' }) as never, { params: Promise.resolve({ anonId: patientB.id, id: String(created.id) }) })
    expect(signRes.status).toBe(404)

    const [noteRow] = await getDb().select().from(encounterNotes).where(eq(encounterNotes.id, created.id))
    expect(noteRow.status).toBe('draft')
  })
})
