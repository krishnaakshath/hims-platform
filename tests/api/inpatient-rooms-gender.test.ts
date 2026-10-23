// WS3 T4: PATCH /api/inpatient/rooms/[id] -- an admin sets a bed's ward-gender restriction
// (spec 3.1 item 10); refused while the current occupant would then conflict.
import { describe, it, expect, vi, afterEach, afterAll, beforeAll } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { PATCH } from '@/app/api/inpatient/rooms/[id]/route'
import { getDb } from '@/db/client'
import { admissions, auditLog, patients, providers, rooms } from '@/db/schema'

const PROBE = 'Room Gender Probe'
let sessionRole = 'admin'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: PROBE })) }))

const FEMALE_ID = 'RD-ROOMGEN-F'
const createdRoomIds: number[] = []
const createdAdmissionIds: number[] = []
let providerId: number

beforeAll(async () => {
  await getDb().insert(patients).values({ id: FEMALE_ID, name: 'Room Gender Female', dob: '1980-05-05', gender: 'female' })
  ;[{ id: providerId }] = await getDb().select({ id: providers.id }).from(providers).limit(1)
})
afterEach(async () => {
  sessionRole = 'admin'
  if (createdAdmissionIds.length) await getDb().delete(admissions).where(inArray(admissions.id, createdAdmissionIds.splice(0)))
  if (createdRoomIds.length) await getDb().delete(rooms).where(inArray(rooms.id, createdRoomIds.splice(0)))
})
afterAll(async () => {
  await getDb().delete(auditLog).where(eq(auditLog.userName, PROBE))
  await getDb().delete(patients).where(eq(patients.id, FEMALE_ID))
})

async function room(values: Partial<typeof rooms.$inferInsert> = {}) {
  const [r] = await getDb().insert(rooms).values({ ward: 'Test Ward', roomNumber: 'G1', bedNumber: 'A', ...values }).returning()
  createdRoomIds.push(r.id)
  return r
}
function patch(id: number | string, body: unknown) {
  const req = new Request('http://localhost', { method: 'PATCH', body: typeof body === 'string' ? body : JSON.stringify(body) })
  return PATCH(req as never, { params: Promise.resolve({ id: String(id) }) })
}
const restriction = async (id: number) => (await getDb().select({ g: rooms.genderRestriction }).from(rooms).where(eq(rooms.id, id)))[0].g

describe('PATCH /api/inpatient/rooms/[id]', () => {
  it('is admin-only, refused before the body is read', async () => {
    const r = await room()
    for (const role of ['frontdesk', 'crc', 'pi', 'billing']) {
      sessionRole = role
      const res = await patch(r.id, 'not json')
      expect(res.status).toBe(403)
    }
  })

  it('refuses an invalid value or an unknown field (400) and an unknown room (404)', async () => {
    const r = await room()
    expect((await patch(r.id, { genderRestriction: 'mixed' })).status).toBe(400)
    expect((await patch(r.id, { genderRestriction: 'male', ward: 'x' })).status).toBe(400)
    expect((await patch(r.id, {})).status).toBe(400)
    expect((await patch('abc', { genderRestriction: 'male' })).status).toBe(400)
    expect((await patch(2_000_000_000, { genderRestriction: 'male' })).status).toBe(404)
  })

  it('sets and clears the restriction, audited with ids only', async () => {
    const r = await room()
    const res = await patch(r.id, { genderRestriction: 'female' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, genderRestriction: 'female' })
    expect(await restriction(r.id)).toBe('female')
    expect((await patch(r.id, { genderRestriction: null })).status).toBe(200)
    expect(await restriction(r.id)).toBeNull()
    const audits = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, PROBE), eq(auditLog.action, 'changed bed gender restriction')))
    expect(audits.map((a) => a.details)).toEqual([`room=${r.id}`, `room=${r.id}`])
  })

  it('refuses making a bed male while a female patient occupies it (409 room_occupied_conflict)', async () => {
    const r = await room({ status: 'occupied', occupiedByPatientId: FEMALE_ID })
    const [a] = await getDb().insert(admissions).values({ patientId: FEMALE_ID, currentRoomId: r.id, attendingProviderId: providerId }).returning()
    createdAdmissionIds.push(a.id)
    const res = await patch(r.id, { genderRestriction: 'male' })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'room_occupied_conflict' })
    expect(await restriction(r.id)).toBeNull()
    expect((await patch(r.id, { genderRestriction: 'female' })).status).toBe(200)
  })
})
