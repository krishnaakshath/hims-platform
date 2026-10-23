// WS3 T7: nursing vitals on the admission's IPD encounter (lane ruling R4: encounter_vitals) and the
// medication-round read, against the lane test DB. Only the session is mocked.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { admissions, auditLog, encounterVitals, encounters, patients, providers, rooms } from '@/db/schema'

let role = 'crc'
const RUN = `${Date.now()}`.slice(-7)
const PROBE = `TEST_WS3T7V-${RUN}`
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role, name: PROBE, userId: null })) }))

import { GET as getVitals, POST as postVitals } from '@/app/api/inpatient/admissions/[id]/vitals/route'
import { GET as getRound } from '@/app/api/inpatient/medication-round/route'
import { deletePatient } from '@/lib/queries/patients'
import { listVitals } from '@/lib/queries/vitals'

const post = (id: number | string, body: unknown) =>
  postVitals(new NextRequest(`http://localhost/api/inpatient/admissions/${id}/vitals`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }), { params: Promise.resolve({ id: String(id) }) })
const get = (id: number | string, qs = '') =>
  getVitals(new NextRequest(`http://localhost/api/inpatient/admissions/${id}/vitals${qs}`), { params: Promise.resolve({ id: String(id) }) })

describe.skipIf(!process.env.DATABASE_URL)('nursing vitals routes (DB)', () => {
  const P = `TWS3T7V-${RUN}-A`
  const PD = `TWS3T7V-${RUN}-D`
  const PL = `TWS3T7V-${RUN}-L`
  let providerId = 0
  let roomId = 0
  let admitted = 0
  let discharged = 0
  let legacy = 0
  let ipdEncounter = 0
  const encounterIds: number[] = []
  const admissionIds: number[] = []

  beforeAll(async () => {
    const db = getDb()
    const [p] = await db.insert(providers).values({ name: `${PROBE} Dr`, specialty: 'Test', colorTag: '#000000' }).returning()
    providerId = p.id
    await db.insert(patients).values([
      { id: P, name: 'TEST_WS3T7V Admitted', dob: '1980-01-01', gender: 'female', uhid: `${P}-UH` },
      { id: PD, name: 'TEST_WS3T7V Discharged', dob: '1980-01-01', gender: 'male' },
      { id: PL, name: 'TEST_WS3T7V Legacy', dob: '1980-01-01', gender: 'male' },
    ])
    const [r] = await db.insert(rooms).values({ ward: `${PROBE} Ward`, roomNumber: '1', bedNumber: 'A', status: 'occupied', occupiedByPatientId: P }).returning()
    roomId = r.id
    const mkAdmission = async (patientId: string, status: 'admitted' | 'discharged', withEncounter: boolean) => {
      const [a] = await db.insert(admissions).values({ patientId, currentRoomId: status === 'admitted' && patientId === P ? r.id : null, attendingProviderId: providerId, status }).returning()
      admissionIds.push(a.id)
      if (withEncounter) {
        const [e] = await db.insert(encounters).values({ patientId, encounterType: 'ipd', encounterDate: '2026-10-20', providerId, status: 'checked_in', admissionId: a.id, checkedInByName: PROBE }).returning()
        encounterIds.push(e.id)
        return { a: a.id, e: e.id }
      }
      return { a: a.id, e: 0 }
    }
    const x = await mkAdmission(P, 'admitted', true)
    admitted = x.a
    ipdEncounter = x.e
    discharged = (await mkAdmission(PD, 'discharged', true)).a
    legacy = (await mkAdmission(PL, 'admitted', false)).a
  })

  afterAll(async () => {
    const db = getDb()
    await db.delete(encounterVitals).where(inArray(encounterVitals.patientId, [P, PD, PL]))
    await db.delete(encounters).where(inArray(encounters.id, encounterIds))
    await db.delete(admissions).where(inArray(admissions.id, admissionIds))
    await db.update(rooms).set({ occupiedByPatientId: null }).where(eq(rooms.id, roomId))
    await db.delete(rooms).where(eq(rooms.id, roomId))
    await db.delete(patients).where(inArray(patients.id, [P, PD, PL]))
    await db.delete(providers).where(eq(providers.id, providerId))
    await db.delete(auditLog).where(eq(auditLog.userName, PROBE))
  })

  beforeEach(() => { role = 'crc' })

  it('crc records a reading on the admission\'s IPD encounter with the charted time; warnings come back', async () => {
    // One hour ago, sent as IST wall-clock time with its offset.
    const taken = new Date(Math.floor((Date.now() - 3600_000) / 60_000) * 60_000)
    const ist = new Date(taken.getTime() + 330 * 60_000).toISOString().slice(0, 19)
    const res = await post(admitted, { tempC: 38.4, spo2Pct: 91, pulseBpm: 96, recordedAt: `${ist}+05:30` })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.vitals).toMatchObject({ encounterId: ipdEncounter, patientId: P, tempDeciC: 384, spo2Pct: 91, recordedByName: PROBE, warnings: ['fever', 'hypoxia'] })
    const [row] = await getDb().select().from(encounterVitals).where(eq(encounterVitals.id, body.vitals.id))
    expect(row.recordedAt.toISOString()).toBe(taken.toISOString())
  })

  it('pi and admin may record too; a reading without a time is charted now', async () => {
    for (const r of ['pi', 'admin']) {
      role = r
      const before = Date.now()
      const res = await post(admitted, { pulseBpm: 80 })
      expect(res.status).toBe(201)
      const { vitals } = await res.json()
      expect(new Date(vitals.recordedAt).getTime()).toBeGreaterThanOrEqual(before - 1000)
    }
  })

  it('a discharged admission is 409 not_admitted; a legacy admission without an IPD visit is 409; unknown is 404', async () => {
    const d = await post(discharged, { pulseBpm: 80 })
    expect(d.status).toBe(409)
    expect(await d.json()).toEqual({ error: 'Patient is not admitted', code: 'not_admitted' })
    const l = await post(legacy, { pulseBpm: 80 })
    expect(l.status).toBe(409)
    expect((await l.json()).code).toBe('no_ipd_encounter')
    expect((await post(2147483000, { pulseBpm: 80 })).status).toBe(404)
  })

  it('refuses a bad id, a non-JSON body, an empty reading, 50 °C and a future time with 400', async () => {
    expect((await post('abc', { pulseBpm: 80 })).status).toBe(400)
    expect((await post(admitted, 'not json')).status).toBe(400)
    expect((await post(admitted, {})).status).toBe(400)
    expect((await post(admitted, { tempC: 50 })).status).toBe(400)
    expect((await post(admitted, { pulseBpm: 80, recordedAt: '2099-01-01T08:00:00+05:30' })).status).toBe(400)
  })

  it('is gated: frontdesk and billing get 403 on both methods and on the round', async () => {
    for (const r of ['frontdesk', 'billing']) {
      role = r
      expect((await post(admitted, { pulseBpm: 80 })).status).toBe(403)
      expect((await get(admitted)).status).toBe(403)
      expect((await getRound(new NextRequest('http://localhost/api/inpatient/medication-round'))).status).toBe(403)
    }
  })

  it('GET lists the last 72 h in time order with warnings; older readings drop off', async () => {
    const db = getDb()
    await db.insert(encounterVitals).values({ encounterId: ipdEncounter, patientId: P, recordedByName: PROBE, pulseBpm: 70, recordedAt: new Date(Date.now() - 80 * 3600_000) })
    const res = await get(admitted)
    expect(res.status).toBe(200)
    const { readings } = await res.json()
    expect(readings.length).toBeGreaterThanOrEqual(3)
    expect(readings.some((r: { pulseBpm: number | null }) => r.pulseBpm === 70)).toBe(false)
    const times = readings.map((r: { recordedAt: string }) => new Date(r.recordedAt).getTime())
    expect([...times].sort((a, b) => a - b)).toEqual(times)
    expect((await listVitals(admitted, 100)).some((r) => r.pulseBpm === 70)).toBe(true)
    expect((await get(legacy)).status).toBe(200)
    expect((await get(2147483000)).status).toBe(404)
  })

  it('audits ids only: no measurement value, no notes', async () => {
    await post(admitted, { systolicMmhg: 133, diastolicMmhg: 77, notes: 'SECRET-NOTE' })
    await get(admitted)
    // Only this admission's rows (the legacy admission's GET above audits its own patient).
    const rows = (await getDb().select().from(auditLog).where(eq(auditLog.userName, PROBE))).filter((r) => r.details?.startsWith(`admission=${admitted}`))
    const recorded = rows.filter((r) => r.action === 'recorded vitals')
    const viewed = rows.filter((r) => r.action === 'viewed vitals')
    expect(recorded.length).toBeGreaterThan(0)
    expect(viewed.length).toBeGreaterThan(0)
    for (const r of [...recorded, ...viewed]) {
      expect(r.patientId).toBe(P)
      expect(r.details).toMatch(new RegExp(`^admission=${admitted}( encounter=${ipdEncounter})?$`))
      expect(r.details).not.toContain('SECRET')
    }
  })

  it('medication round: 400 for a bad date; 200 for crc with today by default', async () => {
    expect((await getRound(new NextRequest('http://localhost/api/inpatient/medication-round?date=2026-13-01'))).status).toBe(400)
    const res = await getRound(new NextRequest('http://localhost/api/inpatient/medication-round'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(Array.isArray(body.rows)).toBe(true)
  })

  it('cascade: deleting the patient removes the readings', async () => {
    const db = getDb()
    expect((await db.select().from(encounterVitals).where(eq(encounterVitals.patientId, P))).length).toBeGreaterThan(0)
    await db.update(rooms).set({ occupiedByPatientId: null, status: 'available' }).where(eq(rooms.id, roomId))
    expect(await deletePatient(P)).toBe(true)
    expect(await db.select().from(encounterVitals).where(eq(encounterVitals.patientId, P))).toHaveLength(0)
  })
})
