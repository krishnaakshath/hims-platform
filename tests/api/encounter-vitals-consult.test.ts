// WS1 T2: POST /api/encounters/[id]/vitals and PUT /api/encounters/[id]/consult against the
// worktree test DB. Session and the doctor's provider resolver are mocked; everything else is real.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, encounterConsults, encounterVitals, encounters, patients, providers } from '@/db/schema'

let role = 'admin'
let actingProvider: { id: number; name: string } | null = null
const PROBE = `TEST_WS1T2-${Date.now()}`
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role, name: PROBE, userId: null })) }))
vi.mock('@/lib/doctor-queue-provider', () => ({ resolveDoctorQueueProvider: vi.fn(async () => actingProvider) }))

import { POST as postVitals } from '@/app/api/encounters/[id]/vitals/route'
import { PUT as putConsult } from '@/app/api/encounters/[id]/consult/route'
import { deletePatient } from '@/lib/queries/patients'

const PATIENT = `TWS1T2-${Date.now()}`
const call = (handler: typeof postVitals, method: 'POST' | 'PUT', id: number | string, body: unknown) =>
  handler(new NextRequest(`http://localhost/api/encounters/${id}/x`, { method, body: JSON.stringify(body) }), { params: Promise.resolve({ id: String(id) }) })

describe.skipIf(!process.env.DATABASE_URL)('encounter vitals and consult routes (DB)', () => {
  let providerA = 0
  let providerB = 0
  let openA = 0 // open visit, provider A
  let openB = 0 // open visit, provider B
  let doneA = 0 // completed visit, provider A
  const encounterIds: number[] = []

  beforeAll(async () => {
    const db = getDb()
    const [a] = await db.insert(providers).values({ name: `${PROBE} Dr A`, specialty: 'Test', colorTag: '#000000' }).returning()
    const [b] = await db.insert(providers).values({ name: `${PROBE} Dr B`, specialty: 'Test', colorTag: '#000000' }).returning()
    providerA = a.id
    providerB = b.id
    await db.insert(patients).values({ id: PATIENT, name: 'TEST_WS1T2 Patient', dob: '1980-01-01', gender: 'female', uhid: `${PATIENT}-UH` })
    const mk = async (providerId: number, status: 'in_consultation' | 'completed') => {
      const [e] = await db.insert(encounters).values({ patientId: PATIENT, encounterType: 'opd', encounterDate: '2026-10-01', providerId, status, checkedInByName: PROBE }).returning()
      encounterIds.push(e.id)
      return e.id
    }
    openA = await mk(providerA, 'in_consultation')
    openB = await mk(providerB, 'in_consultation')
    doneA = await mk(providerA, 'completed')
  })

  afterAll(async () => {
    const db = getDb()
    await db.delete(encounterVitals).where(inArray(encounterVitals.encounterId, encounterIds))
    await db.delete(encounterConsults).where(inArray(encounterConsults.encounterId, encounterIds))
    await db.delete(encounters).where(inArray(encounters.id, encounterIds))
    await db.delete(patients).where(eq(patients.id, PATIENT))
    await db.delete(providers).where(inArray(providers.id, [providerA, providerB]))
    await db.delete(auditLog).where(eq(auditLog.userName, PROBE))
  })

  beforeEach(() => {
    role = 'admin'
    actingProvider = null
  })

  describe('vitals', () => {
    it('crc records vitals on any open visit; the row names the recorder; derived BMI and flags come back', async () => {
      role = 'crc'
      const res = await call(postVitals, 'POST', openB, { systolicMmhg: 150, diastolicMmhg: 95, weightKg: 70, heightCm: 175, tempC: 37.4, painScore: 3, notes: 'seated' })
      expect(res.status).toBe(201)
      const { vitals } = await res.json()
      expect(vitals).toMatchObject({ encounterId: openB, patientId: PATIENT, recordedByName: PROBE, systolicMmhg: 150, tempDeciC: 374, weightG: 70000, heightMm: 1750, painScore: 3, notes: 'seated', bmiTenths: 229, flags: ['bp_high'] })
    })

    it('pi records on their own encounter and is refused on another doctor\'s', async () => {
      role = 'pi'
      actingProvider = { id: providerA, name: 'Dr A' }
      expect((await call(postVitals, 'POST', openA, { pulseBpm: 72 })).status).toBe(201)
      const other = await call(postVitals, 'POST', openB, { pulseBpm: 72 })
      expect(other.status).toBe(403)
      expect(await other.json()).toEqual({ error: 'Forbidden', code: 'not_owner' })
    })

    it('frontdesk is 403', async () => {
      role = 'frontdesk'
      expect((await call(postVitals, 'POST', openA, { pulseBpm: 72 })).status).toBe(403)
    })

    it('a completed visit is 409 visit_closed; an unknown visit is 404; a bad id or body is 400', async () => {
      const closed = await call(postVitals, 'POST', doneA, { pulseBpm: 72 })
      expect(closed.status).toBe(409)
      expect(await closed.json()).toEqual({ error: 'Visit is closed', code: 'visit_closed' })
      expect((await call(postVitals, 'POST', 2147483000, { pulseBpm: 72 })).status).toBe(404)
      expect((await call(postVitals, 'POST', 'abc', { pulseBpm: 72 })).status).toBe(400)
      expect((await call(postVitals, 'POST', openA, {})).status).toBe(400)
      expect((await call(postVitals, 'POST', openA, { notes: 'note only' })).status).toBe(400)
    })

    it('audits the encounter id only: no measurement value and no notes text', async () => {
      await call(postVitals, 'POST', openA, { systolicMmhg: 133, diastolicMmhg: 77, notes: 'SECRET-NOTE-TEXT' })
      const rows = await getDb().select().from(auditLog).where(eq(auditLog.userName, PROBE))
      const mine = rows.filter((r) => r.action === 'recorded vitals')
      expect(mine.length).toBeGreaterThan(0)
      for (const r of mine) {
        expect(r.details).toMatch(/^encounter=\d+$/)
        expect(r.details).not.toContain('133')
        expect(r.details).not.toContain('SECRET')
        expect(r.patientId).toBe(PATIENT)
      }
    })
  })

  describe('consult', () => {
    it('upserts: a second PUT updates the same row and keeps unsent fields', async () => {
      const first = await call(putConsult, 'PUT', openA, { chiefComplaint: ' fever 3 days ', examination: 'chest clear' })
      expect(first.status).toBe(200)
      const a = (await first.json()).consult
      expect(a).toMatchObject({ encounterId: openA, chiefComplaint: 'fever 3 days', examination: 'chest clear', updatedByName: PROBE })
      const second = await call(putConsult, 'PUT', openA, { advice: 'rest', examination: null })
      const b = (await second.json()).consult
      expect(b.id).toBe(a.id)
      expect(b).toMatchObject({ chiefComplaint: 'fever 3 days', advice: 'rest', examination: null })
      const rows = await getDb().select().from(encounterConsults).where(eq(encounterConsults.encounterId, openA))
      expect(rows).toHaveLength(1)
    })

    it('is gated: crc and frontdesk 403; pi only on their own visit; closed visit 409; bad body 400', async () => {
      role = 'crc'
      expect((await call(putConsult, 'PUT', openA, { advice: 'x' })).status).toBe(403)
      role = 'frontdesk'
      expect((await call(putConsult, 'PUT', openA, { advice: 'x' })).status).toBe(403)
      role = 'pi'
      actingProvider = { id: providerA, name: 'Dr A' }
      expect((await call(putConsult, 'PUT', openA, { advice: 'x' })).status).toBe(200)
      expect((await call(putConsult, 'PUT', openB, { advice: 'x' })).status).toBe(403)
      expect((await call(putConsult, 'PUT', doneA, { advice: 'x' })).status).toBe(409)
      expect((await call(putConsult, 'PUT', openA, {})).status).toBe(400)
      expect((await call(putConsult, 'PUT', openA, { advice: 'x'.repeat(4001) })).status).toBe(400)
    })

    it('audits the encounter id only', async () => {
      await call(putConsult, 'PUT', openA, { chiefComplaint: 'SECRET-COMPLAINT' })
      const rows = (await getDb().select().from(auditLog).where(eq(auditLog.userName, PROBE))).filter((r) => r.action === 'updated consultation record')
      expect(rows.length).toBeGreaterThan(0)
      for (const r of rows) expect(r.details).toMatch(/^encounter=\d+$/)
    })
  })

  it('deletePatient removes both tables\' rows', async () => {
    const db = getDb()
    expect((await db.select().from(encounterVitals).where(eq(encounterVitals.patientId, PATIENT))).length).toBeGreaterThan(0)
    expect((await db.select().from(encounterConsults).where(eq(encounterConsults.patientId, PATIENT))).length).toBeGreaterThan(0)
    expect(await deletePatient(PATIENT)).toBe(true)
    expect(await db.select().from(encounterVitals).where(eq(encounterVitals.patientId, PATIENT))).toHaveLength(0)
    expect(await db.select().from(encounterConsults).where(eq(encounterConsults.patientId, PATIENT))).toHaveLength(0)
  })
})
