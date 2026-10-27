import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq, and, inArray, or } from 'drizzle-orm'
import { POST } from '@/app/api/front-desk/check-in/route'
import { getDb } from '@/db/client'
import { doctorAssignments, rooms, admissions, encounters, chargeLines, patients } from '@/db/schema'
import { listActiveProviders } from '@/lib/queries/providers'

vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: 'frontdesk', name: 'Taylor Nguyen' })) }))

const createdAssignmentIds: number[] = []
const createdRoomIds: number[] = []
const createdAdmissionIds: number[] = []
afterEach(async () => {
  // SP3: check-in now opens an encounter in the same transaction -- remove
  // those first (they reference the assignment and admission). This file
  // creates no follow_up_orders and never checks in against an appointment.
  const sp3Encounters = getDb().select({ id: encounters.id }).from(encounters).where(or(
    createdAssignmentIds.length > 0 ? inArray(encounters.doctorAssignmentId, createdAssignmentIds) : undefined,
    and(eq(encounters.patientId, 'RD-0001'), eq(encounters.checkedInByName, 'Taylor Nguyen')),
  ))
  // WS2 T9: check-in captures the visit charges; they go before their encounter.
  await getDb().delete(chargeLines).where(inArray(chargeLines.encounterId, sp3Encounters))
  await getDb().delete(encounters).where(inArray(encounters.id, sp3Encounters))
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

  // WS3 T2: admission moved to POST /api/inpatient/admissions.
  it('refuses an inpatient check-in with use_admission_form and admits nobody', async () => {
    const providers = await listActiveProviders()
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001', visitType: 'inpatient', urgency: 'urgent', reason: 'Admission', providerId: providers[0].id }) })
    const res = await POST(req as never)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'use_admission_form' })
    expect(await getDb().select().from(admissions).where(and(eq(admissions.patientId, 'RD-0001'), eq(admissions.status, 'admitted'), eq(admissions.attendingProviderId, providers[0].id)))).toHaveLength(0)
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

  // WS8 T13: an archived chart is hidden from the queue, so it cannot be checked in or admitted --
  // by chart id or by typed UHID. Nothing is written.
  it('returns 404 for an archived chart (OPD and inpatient, by chart id and by UHID)', async () => {
    const providers = await listActiveProviders()
    const id = `WS8T13-CI-${process.pid}`
    const uhid = `ARCH${process.pid}`.slice(0, 20)
    await getDb().insert(patients).values({ id, uhid, name: 'Archived Check In', dob: '1980-01-01', archivedAt: new Date(), archivedByName: 'Test Admin', archiveReason: 'Duplicate chart for testing' })
    try {
      for (const visitType of ['outpatient', 'inpatient'] as const) {
        for (const ref of [id, uhid.toLowerCase()]) {
          const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: ref, visitType, urgency: 'routine', reason: 'Follow-up', providerId: providers[0].id }) })
          const res = await POST(req as never)
          expect(res.status, `${visitType} ${ref}`).toBe(404)
          expect(await res.json()).toEqual({ error: 'Patient not found' })
        }
      }
      expect(await getDb().select().from(doctorAssignments).where(eq(doctorAssignments.patientId, id))).toEqual([])
      expect(await getDb().select().from(admissions).where(eq(admissions.patientId, id))).toEqual([])
      expect(await getDb().select().from(encounters).where(eq(encounters.patientId, id))).toEqual([])
    } finally {
      await getDb().delete(patients).where(eq(patients.id, id))
    }
  })

  it('returns 404 when the provider does not exist', async () => {
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001', visitType: 'outpatient', urgency: 'routine', reason: 'Follow-up', providerId: 999999 }) })
    const res = await POST(req as never)
    expect(res.status).toBe(404)
  })

  it('never occupies a room: a roomId is not part of check-in any more (WS3 T2)', async () => {
    const [room] = await getDb().insert(rooms).values({ ward: 'Test Ward', roomNumber: '304', bedNumber: 'A', status: 'available' }).returning()
    createdRoomIds.push(room.id)

    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001', visitType: 'inpatient', urgency: 'urgent', reason: 'Admission', providerId: 999999, roomId: room.id }) })
    const res = await POST(req as never)
    expect(res.status).toBe(400)

    const [reloaded] = await getDb().select().from(rooms).where(eq(rooms.id, room.id))
    expect(reloaded.status).toBe('available')
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
