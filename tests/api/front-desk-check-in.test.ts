import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq, desc, and } from 'drizzle-orm'
import { POST } from '@/app/api/front-desk/check-in/route'
import { getDb } from '@/db/client'
import { doctorAssignments, rooms, admissions } from '@/db/schema'
import { listActiveProviders } from '@/lib/queries/providers'

vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: 'frontdesk', name: 'Taylor Nguyen' })) }))

const createdAssignmentIds: number[] = []
const createdRoomIds: number[] = []
const createdAdmissionIds: number[] = []
afterEach(async () => {
  while (createdAdmissionIds.length > 0) await getDb().delete(admissions).where(eq(admissions.id, createdAdmissionIds.pop()!))
  // Safety net: several of the pre-existing tests above (not part of this
  // task's brief) also do an inpatient check-in for the shared 'RD-0001'
  // fixture patient, which -- now that check-in creates an admission as a
  // side effect -- would otherwise leave a stray 'admitted' admission behind
  // for every test in this file to trip over (in particular, it would make
  // RD-0001 look already-admitted by the time the "admissions" describe
  // block below runs, since tests in a file execute in declaration order).
  await getDb().delete(admissions).where(eq(admissions.patientId, 'RD-0001'))
  while (createdAssignmentIds.length > 0) await getDb().delete(doctorAssignments).where(eq(doctorAssignments.id, createdAssignmentIds.pop()!))
  while (createdRoomIds.length > 0) await getDb().delete(rooms).where(eq(rooms.id, createdRoomIds.pop()!))
})

describe('POST /api/front-desk/check-in', () => {
  it('rejects a payload with an unknown field (mass-assignment guard)', async () => {
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001', visitType: 'outpatient', urgency: 'routine', reason: 'Follow-up', providerId: 1, notAField: true }) })
    const res = await POST(req as never)
    expect(res.status).toBe(400)
  })

  it('checks in an outpatient without requiring a room', async () => {
    const providers = await listActiveProviders()
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001', visitType: 'outpatient', urgency: 'routine', reason: 'Follow-up', providerId: providers[0].id }) })
    const res = await POST(req as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    createdAssignmentIds.push(body.id)
    expect(body.roomId).toBeNull()
    expect(body.status).toBe('pending')
  })

  it('allows an inpatient check-in with no roomId (room assigned once one frees up)', async () => {
    const providers = await listActiveProviders()
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001', visitType: 'inpatient', urgency: 'urgent', reason: 'Admission', providerId: providers[0].id }) })
    const res = await POST(req as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    createdAssignmentIds.push(body.id)
    expect(body.roomId).toBeNull()
  })

  it('rejects a roomId on an outpatient check-in', async () => {
    const providers = await listActiveProviders()
    const [room] = await getDb().insert(rooms).values({ ward: 'Test Ward', roomNumber: '303', bedNumber: 'A', status: 'available' }).returning()
    createdRoomIds.push(room.id)

    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001', visitType: 'outpatient', urgency: 'routine', reason: 'Follow-up', providerId: providers[0].id, roomId: room.id }) })
    const res = await POST(req as never)
    expect(res.status).toBe(400)
  })

  it('returns 404 when the patient does not exist', async () => {
    const providers = await listActiveProviders()
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-NOPE', visitType: 'outpatient', urgency: 'routine', reason: 'Follow-up', providerId: providers[0].id }) })
    const res = await POST(req as never)
    expect(res.status).toBe(404)
  })

  it('returns 404 when the provider does not exist', async () => {
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001', visitType: 'outpatient', urgency: 'routine', reason: 'Follow-up', providerId: 999999 }) })
    const res = await POST(req as never)
    expect(res.status).toBe(404)
  })

  it('does not occupy a room when the providerId does not exist', async () => {
    const [room] = await getDb().insert(rooms).values({ ward: 'Test Ward', roomNumber: '304', bedNumber: 'A', status: 'available' }).returning()
    createdRoomIds.push(room.id)

    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001', visitType: 'inpatient', urgency: 'urgent', reason: 'Admission', providerId: 999999, roomId: room.id }) })
    const res = await POST(req as never)
    expect(res.status).toBe(404)

    const [reloaded] = await getDb().select().from(rooms).where(eq(rooms.id, room.id))
    expect(reloaded.status).toBe('available')
  })

  it('assigns the given room and flips it to occupied for an inpatient check-in', async () => {
    const providers = await listActiveProviders()
    const [room] = await getDb().insert(rooms).values({ ward: 'Test Ward', roomNumber: '301', bedNumber: 'A', status: 'available' }).returning()
    createdRoomIds.push(room.id)

    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001', visitType: 'inpatient', urgency: 'urgent', reason: 'Admission', providerId: providers[0].id, roomId: room.id }) })
    const res = await POST(req as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    createdAssignmentIds.push(body.id)
    expect(body.roomId).toBe(room.id)
  })

  it('returns 409 when the requested room is no longer available', async () => {
    const providers = await listActiveProviders()
    const [room] = await getDb().insert(rooms).values({ ward: 'Test Ward', roomNumber: '302', bedNumber: 'A', status: 'occupied', occupiedByPatientId: 'RD-0002' }).returning()
    createdRoomIds.push(room.id)

    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001', visitType: 'inpatient', urgency: 'urgent', reason: 'Admission', providerId: providers[0].id, roomId: room.id }) })
    const res = await POST(req as never)
    expect(res.status).toBe(409)
  })

  it('returns 403 for a pi session', async () => {
    const auth = await import('@/lib/auth')
    vi.mocked(auth.requireSession).mockResolvedValueOnce({ role: 'pi', name: 'Dr. Kunam', userId: null })
    const providers = await listActiveProviders()
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001', visitType: 'outpatient', urgency: 'routine', reason: 'Follow-up', providerId: providers[0].id }) })
    const res = await POST(req as never)
    expect(res.status).toBe(403)
  })

  it('returns a positive integer queueTicketNumber on the created assignment', async () => {
    const providers = await listActiveProviders()
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001', visitType: 'outpatient', urgency: 'routine', reason: 'Follow-up', providerId: providers[0].id }) })
    const res = await POST(req as never)
    const body = await res.json()
    createdAssignmentIds.push(body.id)
    expect(Number.isInteger(body.queueTicketNumber)).toBe(true)
    expect(body.queueTicketNumber).toBeGreaterThan(0)
  })

  it('gives two sequential real check-ins distinct sequential ticket numbers', async () => {
    const providers = await listActiveProviders()
    const req1 = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001', visitType: 'outpatient', urgency: 'routine', reason: 'Follow-up', providerId: providers[0].id }) })
    const res1 = await POST(req1 as never)
    const body1 = await res1.json()
    createdAssignmentIds.push(body1.id)

    const req2 = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001', visitType: 'outpatient', urgency: 'routine', reason: 'Follow-up', providerId: providers[0].id }) })
    const res2 = await POST(req2 as never)
    const body2 = await res2.json()
    createdAssignmentIds.push(body2.id)

    expect(body2.queueTicketNumber).toBe(body1.queueTicketNumber + 1)
  })
})

describe('POST /api/front-desk/check-in — admissions', () => {
  it('creates an admission record for an inpatient check-in', async () => {
    const providers = await listActiveProviders()
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001', visitType: 'inpatient', urgency: 'urgent', reason: 'Admission for observation', providerId: providers[0].id }) })
    const res = await POST(req as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    createdAssignmentIds.push(body.id)

    const [admission] = await getDb().select().from(admissions).where(eq(admissions.patientId, 'RD-0001')).orderBy(desc(admissions.admittedAt)).limit(1)
    createdAdmissionIds.push(admission.id)
    expect(admission.status).toBe('admitted')
    expect(admission.attendingProviderId).toBe(providers[0].id)
    expect(admission.createdFromAssignmentId).toBe(body.id)
  })

  it('does not create a second admission when the patient already has an active one', async () => {
    const providers = await listActiveProviders()
    const firstReq = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001', visitType: 'inpatient', urgency: 'urgent', reason: 'First admission', providerId: providers[0].id }) })
    const firstRes = await POST(firstReq as never)
    const firstBody = await firstRes.json()
    createdAssignmentIds.push(firstBody.id)

    const secondReq = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001', visitType: 'inpatient', urgency: 'routine', reason: 'Duplicate check-in attempt', providerId: providers[0].id }) })
    const secondRes = await POST(secondReq as never)
    const secondBody = await secondRes.json()
    createdAssignmentIds.push(secondBody.id)

    const activeAdmissions = await getDb().select().from(admissions).where(and(eq(admissions.patientId, 'RD-0001'), eq(admissions.status, 'admitted')))
    for (const a of activeAdmissions) createdAdmissionIds.push(a.id)
    expect(activeAdmissions.length).toBe(1)
  })

  it('rejects a duplicate inpatient check-in with a roomId for a patient who is already admitted, and never claims the room', async () => {
    const providers = await listActiveProviders()

    const firstReq = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001', visitType: 'inpatient', urgency: 'urgent', reason: 'First admission', providerId: providers[0].id }) })
    const firstRes = await POST(firstReq as never)
    expect(firstRes.status).toBe(201)
    const firstBody = await firstRes.json()
    createdAssignmentIds.push(firstBody.id)

    const [room] = await getDb().insert(rooms).values({ ward: 'Test Ward', roomNumber: '305', bedNumber: 'A', status: 'available' }).returning()
    createdRoomIds.push(room.id)

    const secondReq = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001', visitType: 'inpatient', urgency: 'urgent', reason: 'Duplicate check-in with a room', providerId: providers[0].id, roomId: room.id }) })
    const secondRes = await POST(secondReq as never)
    expect(secondRes.status).toBe(409)

    // The room must never have been claimed -- this is the actual bed leak
    // this test guards against. Verify real DB state, not a mock.
    const [roomAfter] = await getDb().select().from(rooms).where(eq(rooms.id, room.id))
    expect(roomAfter.status).toBe('available')
    expect(roomAfter.occupiedByPatientId).toBeNull()

    // Still only one active admission -- the duplicate must not have created
    // a second one either.
    const activeAdmissions = await getDb().select().from(admissions).where(and(eq(admissions.patientId, 'RD-0001'), eq(admissions.status, 'admitted')))
    for (const a of activeAdmissions) createdAdmissionIds.push(a.id)
    expect(activeAdmissions.length).toBe(1)
  })
})

describe('POST /api/front-desk/check-in -- reason length (patient-facing)', () => {
  async function checkIn(reason: string) {
    const providers = await listActiveProviders()
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001', visitType: 'outpatient', urgency: 'routine', reason, providerId: providers[0].id }) })
    return POST(req as never)
  }

  it('rejects a 141-char reason with the existing 400 shape and creates nothing', async () => {
    const reason = `len141-${Date.now()}-`.padEnd(141, 'x')
    expect(reason).toHaveLength(141)
    const res = await checkIn(reason)
    // Track anything created for cleanup before asserting.
    const rows = await getDb().select().from(doctorAssignments).where(eq(doctorAssignments.reason, reason))
    for (const r of rows) createdAssignmentIds.push(r.id)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Invalid check-in payload')
    expect(body.details.fieldErrors.reason).toBeDefined()
    expect(rows).toHaveLength(0)
  })

  it('accepts a 140-char reason (after trimming) and stores the trimmed value', async () => {
    const reason = `len140-${Date.now()}-`.padEnd(140, 'y')
    expect(reason).toHaveLength(140)
    const res = await checkIn(`   ${reason}  \n`)
    const body = await res.json()
    if (body?.id) createdAssignmentIds.push(body.id)
    expect(res.status).toBe(201)
    const [row] = await getDb().select().from(doctorAssignments).where(eq(doctorAssignments.id, body.id))
    expect(row.reason).toBe(reason)
  })

  it('rejects a whitespace-only reason', async () => {
    const res = await checkIn('    ')
    const body = await res.json()
    if (body?.id) createdAssignmentIds.push(body.id)
    expect(res.status).toBe(400)
  })
})
