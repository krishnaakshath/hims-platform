import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { departments, encounters, patients, providers } from '@/db/schema'
import { listEncounterRegister } from '@/lib/queries/encounter-register'
import type { RegisterFilters } from '@/lib/encounters/register'

// Wave F P1-04: the OPD register query over SP3 `encounters`.
const RUN = `${Date.now()}`
const DEPT_A = `TWFA${RUN.slice(-8)}`
const DEPT_B = `TWFB${RUN.slice(-8)}`
const P1 = `TEST-WF-${RUN}-R1`
const P2 = `TEST-WF-${RUN}-R2`
// Far-future dates nobody else uses, so the date filter isolates this suite's rows.
const D1 = '2031-03-10'
const D2 = '2031-03-11'
let deptA = 0
let deptB = 0
let docA = 0
let docB = 0
const encIds: number[] = []

const base = (over: Partial<RegisterFilters> = {}): RegisterFilters => ({ from: D1, to: D2, type: null, status: null, departmentId: null, providerId: null, ...over })

describe.skipIf(!process.env.DATABASE_URL)('listEncounterRegister (DB)', () => {
  beforeAll(async () => {
    const db = getDb()
    const [a] = await db.insert(departments).values({ code: DEPT_A, name: 'TEST_WF Cardiology', kind: 'clinical' }).returning()
    const [b] = await db.insert(departments).values({ code: DEPT_B, name: 'TEST_WF Ortho', kind: 'clinical' }).returning()
    deptA = a.id; deptB = b.id
    const [pa] = await db.insert(providers).values({ name: `TEST_WF Dr A ${RUN}`, specialty: 'Test', colorTag: '#000000', departmentId: deptA }).returning()
    const [pb] = await db.insert(providers).values({ name: `TEST_WF Dr B ${RUN}`, specialty: 'Test', colorTag: '#000000', departmentId: deptB }).returning()
    docA = pa.id; docB = pb.id
    await db.insert(patients).values([
      { id: P1, name: 'TEST_WF Register One ', dob: '1990-03-11', gender: 'male', uhid: `TWF-R1-${RUN}`, phone: '9876543210' },
      { id: P2, name: 'TEST_WF Register Two', dob: '2000-01-01', gender: 'female', phone: '9123456780' },
    ])
    const rows = await db.insert(encounters).values([
      { patientId: P1, encounterType: 'opd', status: 'completed', encounterDate: D1, opdToken: 2, departmentId: deptA, providerId: docA, checkedInByName: 'TEST_WF', checkedInAt: new Date('2031-03-10T04:00:00Z'), completedAt: new Date('2031-03-10T05:00:00Z') },
      { patientId: P2, encounterType: 'opd', status: 'checked_in', encounterDate: D1, opdToken: 1, departmentId: deptB, providerId: docB, checkedInByName: 'TEST_WF', checkedInAt: new Date('2031-03-10T03:30:00Z') },
      { patientId: P1, encounterType: 'opd', status: 'cancelled', encounterDate: D2, opdToken: 1, departmentId: deptA, providerId: docA, checkedInByName: 'TEST_WF', checkedInAt: new Date('2031-03-11T04:00:00Z') },
      { patientId: P2, encounterType: 'ipd', status: 'checked_in', encounterDate: D2, departmentId: deptB, providerId: docB, checkedInByName: 'TEST_WF', checkedInAt: new Date('2031-03-11T06:00:00Z') },
    ]).returning({ id: encounters.id })
    encIds.push(...rows.map((r) => r.id))
  })

  afterAll(async () => {
    const db = getDb()
    if (encIds.length) await db.delete(encounters).where(inArray(encounters.id, encIds))
    await db.delete(patients).where(inArray(patients.id, [P1, P2]))
    await db.delete(providers).where(inArray(providers.id, [docA, docB]))
    await db.delete(departments).where(inArray(departments.id, [deptA, deptB]))
  })

  it('lists the range newest date first, token ascending, with a minimal projection and age on the visit date', async () => {
    const r = await listEncounterRegister(base())
    expect(r.truncated).toBe(false)
    expect(r.total).toBe(4)
    expect(r.rows.map((x) => [x.encounterDate, x.opdToken, x.patientId])).toEqual([
      [D2, 1, P1], [D2, null, P2], [D1, 1, P2], [D1, 2, P1],
    ])
    const one = r.rows.find((x) => x.patientId === P1 && x.encounterDate === D1)!
    expect(one).toMatchObject({
      patientName: 'TEST_WF Register One', uhid: `TWF-R1-${RUN}`, gender: 'male', departmentName: 'TEST_WF Cardiology',
      doctorName: `TEST_WF Dr A ${RUN}`, status: 'completed', visitType: 'new', encounterType: 'opd',
    })
    // Born 11 Mar 1990: still 40 on 10 Mar 2031.
    expect(one.ageYears).toBe(40)
    expect(one.completedAt).toBeInstanceOf(Date)
    const json = JSON.stringify(r)
    expect(json).not.toContain('9876543210')
    expect(json).not.toMatch(/phone|address|aadhaar|abha/i)
  })

  it('filters by type, status, department and doctor, and counts by status', async () => {
    expect((await listEncounterRegister(base({ type: 'opd' }))).rows).toHaveLength(3)
    expect((await listEncounterRegister(base({ status: 'checked_in' }))).rows.map((x) => x.encounterType).sort()).toEqual(['ipd', 'opd'])
    expect((await listEncounterRegister(base({ departmentId: deptA }))).rows.every((x) => x.departmentName === 'TEST_WF Cardiology')).toBe(true)
    expect((await listEncounterRegister(base({ providerId: docB }))).rows).toHaveLength(2)
    expect((await listEncounterRegister(base({ from: D2, to: D2 }))).rows).toHaveLength(2)
    const r = await listEncounterRegister(base({ status: 'completed' }))
    // Status counts ignore the status filter (they drive the status chips).
    expect(r.statusCounts).toEqual({ checked_in: 2, in_consultation: 0, completed: 1, cancelled: 1 })
  })

  it('reports truncation past the limit', async () => {
    const r = await listEncounterRegister(base(), { limit: 2 })
    expect(r.rows).toHaveLength(2)
    expect(r.truncated).toBe(true)
    expect(r.total).toBe(4)
  })

  it('an unknown department returns nothing (not an error)', async () => {
    const r = await listEncounterRegister(base({ departmentId: 2147483000 }))
    expect(r.rows).toEqual([])
    expect(r.total).toBe(0)
  })
})
