// WS3 T3: GET /api/inpatient/admissions/form-context -- what the admission dialog needs for one
// patient (free beds with the ward-gender conflict and tariff, payer choices, the open OPD visit,
// the deposit hint). Also: code search (GET /api/coding/codes) now admits frontdesk (spec 3.1 item 3).
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import {
  admissions, auditLog, billingSettings, departments, encounters, patientPolicies, patients, payers, preauths, providers, roomCategories, rooms,
  serviceCatalog, tariffRates,
} from '@/db/schema'
import { istDateOf } from '@/lib/india-time'

const state = vi.hoisted(() => ({ role: 'frontdesk' as string, name: '' }))
vi.mock('@/lib/auth', () => ({
  requireSession: vi.fn(async () => ({ role: state.role, name: state.name, userId: null })),
  requireSessionOrRedirect: vi.fn(async () => ({ role: state.role, name: state.name, userId: null })),
}))

import { GET } from '@/app/api/inpatient/admissions/form-context/route'
import { GET as getCodes } from '@/app/api/coding/codes/route'

const RUN = `${Date.now()}`.slice(-7)
const PROBE = `TEST_WS3T3-${RUN}`
const PATIENT = `TEST-WS3T3-${RUN}`
const UHID = `UHT3${RUN}`
const CODE = `TT3${RUN}`
const WARD = `${PROBE} Ward`

const get = (qs: string) => GET(new NextRequest(`http://localhost/api/inpatient/admissions/form-context${qs}`))

describe.skipIf(!process.env.DATABASE_URL)('GET /api/inpatient/admissions/form-context', () => {
  const fx = {
    providerId: 0, departmentId: 0, serviceId: 0, categoryId: 0, rateId: 0, payerId: 0,
    rooms: [] as number[], policies: [] as number[], preauths: [] as number[],
    maleBed: 0, femaleBed: 0, mixedBed: 0, activePolicy: 0, inactivePolicy: 0, openPreauth: 0,
  }
  let savedSettings: Record<string, unknown> | null = null
  const today = istDateOf(new Date())

  beforeAll(async () => {
    state.name = PROBE
    const db = getDb()
    const [s] = await db.select().from(billingSettings).where(eq(billingSettings.id, 1))
    savedSettings = s ?? null
    const [dep] = await db.insert(departments).values({ code: CODE, name: `${PROBE} Dept` }).returning()
    fx.departmentId = dep.id
    const [svc] = await db.insert(serviceCatalog).values({ code: `${CODE}RR`, name: 'Test room rent', departmentId: dep.id, category: 'room_rent', hsnSac: '999311' }).returning()
    fx.serviceId = svc.id
    await db.update(billingSettings).set({ roomRentServiceId: svc.id, ipdDepositThresholdPaise: 500_000 }).where(eq(billingSettings.id, 1))
    const [cat] = await db.insert(roomCategories).values({ code: `${CODE}G`, name: `${PROBE} General` }).returning()
    fx.categoryId = cat.id
    const [rate] = await db.insert(tariffRates).values({ serviceId: svc.id, scope: 'base', roomCategoryId: cat.id, amountPaise: 150_000, validFrom: '2020-01-01', createdByName: PROBE }).returning()
    fx.rateId = rate.id

    const [prov] = await db.insert(providers).values({ name: `${PROBE} Dr A`, specialty: 'Test', colorTag: '#000000' }).returning()
    fx.providerId = prov.id
    await db.insert(patients).values({ id: PATIENT, name: 'TEST_WS3T3 Form', dob: '1990-01-01', gender: 'female', uhid: UHID })

    const room = async (n: string, over: Partial<typeof rooms.$inferInsert> = {}) => {
      const [r] = await db.insert(rooms).values({ ward: WARD, roomNumber: n, bedNumber: 'A', ...over }).returning()
      fx.rooms.push(r.id)
      return r.id
    }
    fx.maleBed = await room('M1', { genderRestriction: 'male' })
    fx.femaleBed = await room('F1', { genderRestriction: 'female', roomCategoryId: cat.id })
    fx.mixedBed = await room('X1')
    await room('O1', { status: 'occupied' })
    await room('B1', { status: 'blocked', blockedReason: 'Repair' })
    await room('D1', { status: 'dirty' })

    const [payer] = await db.insert(payers).values({ name: `${PROBE} Insurer`, payerId: CODE }).returning()
    fx.payerId = payer.id
    const policy = async (over: Partial<typeof patientPolicies.$inferInsert>) => {
      const [p] = await db.insert(patientPolicies).values({
        patientId: PATIENT, insurerPayerId: payer.id, policyNumber: `${CODE}-P${fx.policies.length}`, memberId: 'M1', policyType: 'individual',
        holderName: 'Holder', relationship: 'self', validFrom: '2020-01-01', validTo: '2099-12-31', createdByName: PROBE, ...over,
      }).returning()
      fx.policies.push(p.id)
      return p.id
    }
    fx.activePolicy = await policy({})
    fx.inactivePolicy = await policy({ status: 'inactive', priority: 'secondary' })
    await policy({ validTo: '2021-01-01', priority: 'secondary' }) // expired
    const preauth = async (n: string, over: Partial<typeof preauths.$inferInsert> = {}) => {
      const [pa] = await db.insert(preauths).values({
        preauthNumber: `${CODE}-${n}`, patientId: PATIENT, policyId: fx.activePolicy, insurerPayerId: payer.id, claimType: 'ipd',
        plannedAdmissionDate: today, expectedLengthOfStayDays: 3, treatingProviderId: prov.id, estimateLines: [], estimatedPaise: 0,
        requestedPaise: 0, createdByName: PROBE, ...over,
      }).returning()
      fx.preauths.push(pa.id)
      return pa.id
    }
    fx.openPreauth = await preauth('OPEN', { status: 'requested' })
    await preauth('REJ', { status: 'rejected' })
    await preauth('CAN', { status: 'cancelled' })
  })

  afterEach(async () => {
    state.role = 'frontdesk'
    const db = getDb()
    await db.delete(encounters).where(eq(encounters.patientId, PATIENT))
    await db.delete(admissions).where(eq(admissions.patientId, PATIENT))
    await db.delete(auditLog).where(eq(auditLog.userName, PROBE))
  })

  afterAll(async () => {
    const db = getDb()
    if (savedSettings) await db.update(billingSettings).set(savedSettings).where(eq(billingSettings.id, 1))
    await db.delete(preauths).where(inArray(preauths.id, fx.preauths))
    await db.delete(patientPolicies).where(inArray(patientPolicies.id, fx.policies))
    await db.delete(payers).where(eq(payers.id, fx.payerId))
    await db.delete(rooms).where(inArray(rooms.id, fx.rooms))
    await db.delete(patients).where(eq(patients.id, PATIENT))
    await db.delete(providers).where(eq(providers.id, fx.providerId))
    await db.delete(tariffRates).where(eq(tariffRates.id, fx.rateId))
    await db.delete(roomCategories).where(eq(roomCategories.id, fx.categoryId))
    await db.delete(serviceCatalog).where(eq(serviceCatalog.id, fx.serviceId))
    await db.delete(departments).where(eq(departments.id, fx.departmentId))
  })

  it.each(['labs', 'billing', 'pharmacy'])('403s %s', async (role) => {
    state.role = role
    const res = await get(`?patientId=${PATIENT}`)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
  })

  it('400s without a patientId and 404s an unknown patient', async () => {
    expect((await get('')).status).toBe(400)
    const res = await get('?patientId=NOPE-XYZ')
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ code: 'patient_not_found' })
  })

  it('returns only free beds, each with its ward-gender conflict for a female patient and the tariff', async () => {
    const res = await get(`?patientId=${PATIENT}`)
    expect(res.status).toBe(200)
    const ctx = await res.json()
    expect(ctx.patient).toEqual({ id: PATIENT, name: 'TEST_WS3T3 Form', uhid: UHID, gender: 'female', ageYears: expect.any(Number) })
    const mine = ctx.beds.filter((b: { ward: string }) => b.ward === WARD)
    expect(mine.map((b: { id: number }) => b.id).sort()).toEqual([fx.maleBed, fx.femaleBed, fx.mixedBed].sort())
    const byId = new Map(mine.map((b: { id: number }) => [b.id, b]))
    expect(byId.get(fx.maleBed)).toMatchObject({ label: `${WARD} M1-A`, genderRestriction: 'male', conflict: 'opposite_sex', tariffPaise: null, roomCategoryName: null })
    expect(byId.get(fx.femaleBed)).toMatchObject({ genderRestriction: 'female', conflict: null, tariffPaise: 150_000, roomCategoryName: `${PROBE} General` })
    expect(byId.get(fx.mixedBed)).toMatchObject({ genderRestriction: null, conflict: null })
  })

  it('lists active, in-date policies and the open pre-auths with their policy, plus the deposit threshold', async () => {
    const ctx = await (await get(`?patientId=${UHID.toLowerCase()}`)).json()
    expect(ctx.patient.id).toBe(PATIENT)
    expect(ctx.policies).toEqual([{ id: fx.activePolicy, label: expect.stringContaining(`${CODE}-P0`), insurerName: `${PROBE} Insurer`, validTo: '2099-12-31' }])
    expect(ctx.preauths).toEqual([{ id: fx.openPreauth, preauthNumber: `${CODE}-OPEN`, status: 'requested', approvedPaise: null, policyId: fx.activePolicy }])
    expect(ctx.depositThresholdPaise).toBe(500_000)
    expect(ctx.openOpdEncounter).toBeNull()
    expect(ctx.activeAdmissionId).toBeNull()
  })

  it('reports an open OPD visit of today with its token and doctor, and an active admission', async () => {
    const db = getDb()
    await db.insert(encounters).values({
      patientId: PATIENT, encounterType: 'opd', visitType: 'new', status: 'checked_in', encounterDate: today, opdToken: 12,
      providerId: fx.providerId, checkedInByName: PROBE, checkedInAt: new Date(),
    })
    const [adm] = await db.insert(admissions).values({ patientId: PATIENT, attendingProviderId: fx.providerId, admittedAt: new Date() }).returning()
    const ctx = await (await get(`?patientId=${PATIENT}`)).json()
    expect(ctx.openOpdEncounter).toEqual({ id: expect.any(Number), opdToken: 12, providerName: `${PROBE} Dr A` })
    expect(ctx.activeAdmissionId).toBe(adm.id)
  })

  it('audits "viewed admission form" with the patient id only', async () => {
    await get(`?patientId=${PATIENT}`)
    const rows = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, PROBE), eq(auditLog.action, 'viewed admission form')))
    expect(rows).toHaveLength(1)
    expect(rows[0].patientId).toBe(PATIENT)
  })
})

describe('GET /api/coding/codes (code search)', () => {
  it('admits frontdesk (admission diagnosis picker, spec 3.1 item 3)', async () => {
    state.role = 'frontdesk'
    const res = await getCodes(new NextRequest('http://localhost/api/coding/codes'))
    expect(res.status).not.toBe(403)
  })
})
