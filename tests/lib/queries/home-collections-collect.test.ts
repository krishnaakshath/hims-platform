// SP5 Task 12: the collector's route list and mark-collected by sample ID (one transaction that
// collects the matched tubes, releases the rest, and opens a completed `lab` encounter).
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import {
  auditLog, departments, encounters, homeCollectionVisits, homeCollectionWindows, labOrders, labTests, patients, providers, users,
} from '@/db/schema'
import type { Session } from '@/lib/auth'
import { istDateOf } from '@/lib/india-time'
import { displaySampleId, formatSampleId, parseSampleId } from '@/lib/labs/sample-id'
import { ensureSampleIds } from '@/lib/queries/lab-lifecycle'
import { collectHomeVisit, listCollectorRoute } from '@/lib/queries/home-collections'

const RUN = `${Date.now()}`
const TAG = RUN.slice(-6)
const PROBE_COL = `TEST_SP5_HCC_COL-${RUN}`
const PROBE_COL2 = `TEST_SP5_HCC_COL2-${RUN}`
const PROBE_ADMIN = `TEST_SP5_HCC_ADM-${RUN}`
const PROBE_NAMES = [PROBE_COL, PROBE_COL2, PROBE_ADMIN]
const P = Array.from({ length: 16 }, (_, i) => `TEST-SP5-${RUN}-C${i}`)
let nextP = 0
/** A fresh patient per visit: one patient holds at most one visit per slot. */
const fresh = () => P[nextP++]

const NOW = new Date('2099-06-02T05:00:00Z') // 10:30 IST, 2 Jun 2099
const DAY = '2099-06-02'

let providerId = 0
let departmentId = 0
let labTestId = 0
let windowId = 0
let colUser = 0
let colUser2 = 0
const orderIds: number[] = []
let COLLECTOR_S: Session
let COLLECTOR2_S: Session
const ADMIN_S: Session = { role: 'admin', name: PROBE_ADMIN, userId: null }

async function makeOrders(patientId: string, n: number) {
  const rows = await getDb().insert(labOrders).values(Array.from({ length: n }, () => ({ patientId, labTestId, orderedByProviderId: providerId }))).returning()
  orderIds.push(...rows.map((r) => r.id))
  const ids = rows.map((r) => r.id)
  const sampleIds = await ensureSampleIds(getDb(), ids, new Date('2099-06-01T06:00:00Z'))
  return ids.map((id) => ({ id, sampleId: sampleIds.get(id)! }))
}

async function makeVisit(patientId: string, over: Partial<typeof homeCollectionVisits.$inferInsert> = {}) {
  const [v] = await getDb().insert(homeCollectionVisits).values({
    patientId, visitDate: DAY, windowId, windowLabel: `TEST-SP5-${TAG}-w`, windowStart: '10:00', windowEnd: '12:00',
    addressLine1: '12 Test Road', city: 'Test City', stateCode: 'IN-KA', pinCode: '990001', landmark: 'Near the temple',
    contactPhone: '+919845013210', bookedByName: PROBE_ADMIN, collectorUserId: colUser, ...over,
  }).returning()
  return v
}

/** Orders scheduled on a fresh visit. */
async function scheduledVisit(patientId: string, n: number, over: Partial<typeof homeCollectionVisits.$inferInsert> = {}) {
  const orders = await makeOrders(patientId, n)
  const visit = await makeVisit(patientId, over)
  await getDb().update(labOrders).set({ status: 'scheduled', homeCollectionVisitId: visit.id }).where(inArray(labOrders.id, orders.map((o) => o.id)))
  return { visit, orders }
}

async function orderRow(id: number) {
  const [row] = await getDb().select().from(labOrders).where(eq(labOrders.id, id))
  return row
}
async function visitRow(id: number) {
  const [row] = await getDb().select().from(homeCollectionVisits).where(eq(homeCollectionVisits.id, id))
  return row
}

describe.skipIf(!process.env.DATABASE_URL)('home collection: route list and collect (DB)', () => {
  beforeAll(async () => {
    const db = getDb()
    await db.insert(patients).values(P.map((id, i) => ({
      id, name: `Asha Devi Rao${TAG}x${i}`, dob: '1980-06-03', gender: 'female' as const, phone: '+919845013210',
      addressLine1: 'Reg line', city: 'Reg City', stateCode: 'IN-KA', pinCode: '990001', uhid: `TSP5C${TAG}${i}`,
    })))
    const [dept] = await db.insert(departments).values({ code: `TSP5${TAG}`, name: `TEST_SP5 Path ${RUN}` }).returning()
    departmentId = dept.id
    const [pr] = await db.insert(providers).values({ name: `TEST_SP5 Dr Collect ${RUN}`, specialty: 'Pathology', colorTag: '#000000', departmentId }).returning()
    providerId = pr.id
    const [t] = await db.insert(labTests).values({ name: `TEST_SP5 collect lab ${RUN}`, code: `TEST-SP5-HCC-${RUN}`, container: 'edta_lavender', sampleType: 'blood' }).returning()
    labTestId = t.id
    const [w] = await db.insert(homeCollectionWindows).values({ label: `TEST-SP5-${TAG}-w`, startTime: '10:00', endTime: '12:00', capacity: 50 }).returning()
    windowId = w.id
    const us = await db.insert(users).values([
      { name: PROBE_COL, email: `test-sp5-hcc-col-${RUN}@example.invalid`, role: 'collector' },
      { name: PROBE_COL2, email: `test-sp5-hcc-col2-${RUN}@example.invalid`, role: 'collector' },
    ]).returning()
    ;[colUser, colUser2] = us.map((u) => u.id)
    COLLECTOR_S = { role: 'collector', name: PROBE_COL, userId: colUser }
    COLLECTOR2_S = { role: 'collector', name: PROBE_COL2, userId: colUser2 }
  })

  afterAll(async () => {
    const db = getDb()
    if (orderIds.length > 0) await db.delete(labOrders).where(inArray(labOrders.id, orderIds))
    await db.delete(homeCollectionVisits).where(inArray(homeCollectionVisits.patientId, P))
    await db.delete(encounters).where(inArray(encounters.patientId, P))
    await db.delete(homeCollectionWindows).where(eq(homeCollectionWindows.id, windowId))
    await db.delete(auditLog).where(inArray(auditLog.userName, PROBE_NAMES))
    await db.delete(users).where(inArray(users.id, [colUser, colUser2]))
    await db.delete(labTests).where(eq(labTests.id, labTestId))
    await db.delete(providers).where(eq(providers.id, providerId))
    await db.delete(departments).where(eq(departments.id, departmentId))
    await db.delete(patients).where(inArray(patients.id, P))
  })

  it('collects matching tubes, releases the rest, and opens a completed lab encounter', async () => {
    const { visit, orders: [oA, oB] } = await scheduledVisit(fresh(), 2)
    // Typed with the display dashes and lower case: still the same tube.
    const r = await collectHomeVisit(visit.id, [displaySampleId(oA.sampleId).toLowerCase()], COLLECTOR_S, NOW)
    expect(r).toMatchObject({ ok: true, collectedOrderIds: [oA.id], notCollectedOrderIds: [oB.id] })
    if (!r.ok) return

    expect(await orderRow(oA.id)).toMatchObject({ status: 'collected', collectedByName: PROBE_COL, homeCollectionVisitId: visit.id })
    expect((await orderRow(oA.id)).collectedAt?.getTime()).toBe(NOW.getTime())
    expect(await orderRow(oB.id)).toMatchObject({ status: 'ordered', homeCollectionVisitId: null, sampleId: oB.sampleId })

    const [enc] = await getDb().select().from(encounters).where(eq(encounters.id, r.encounterId))
    expect(enc).toMatchObject({
      patientId: visit.patientId, encounterType: 'lab', visitType: 'new', status: 'completed', encounterDate: DAY, opdToken: null,
      providerId, departmentId, checkedInByName: PROBE_COL, statusChangedByName: PROBE_COL,
    })
    expect(enc.completedAt?.getTime()).toBe(NOW.getTime())
    expect(enc.checkedInAt.getTime()).toBe(NOW.getTime())

    const v = await visitRow(visit.id)
    expect(v).toMatchObject({ status: 'collected', collectedByName: PROBE_COL, encounterId: r.encounterId })
    expect(v.collectedAt?.getTime()).toBe(NOW.getTime())

    const audits = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, PROBE_COL), eq(auditLog.action, 'collected home samples')))
    expect(audits.map((a) => a.details)).toContain(`visit=${visit.id} orders=${oA.id} missed=${oB.id} encounter=${r.encounterId}`)
    expect(audits.find((a) => a.details?.includes(`visit=${visit.id}`))?.patientId).toBe(visit.patientId)

    // A second collect of a collected visit changes nothing.
    expect(await collectHomeVisit(visit.id, [oA.sampleId], COLLECTOR_S, NOW)).toEqual({ ok: false, error: 'not_collectable' })
  })

  it('refuses a sample ID from another visit and changes nothing', async () => {
    const mine = await scheduledVisit(fresh(), 2)
    const other = await scheduledVisit(fresh(), 1)
    const r = await collectHomeVisit(mine.visit.id, [mine.orders[0].sampleId, other.orders[0].sampleId], COLLECTOR_S, NOW)
    expect(r).toEqual({ ok: false, error: 'sample_not_on_visit', sampleId: other.orders[0].sampleId })
    for (const o of [...mine.orders, ...other.orders]) expect((await orderRow(o.id)).status).toBe('scheduled')
    expect((await visitRow(mine.visit.id)).status).toBe('booked')
    expect((await visitRow(other.visit.id)).status).toBe('booked')
    expect(await getDb().select().from(encounters).where(inArray(encounters.patientId, [mine.visit.patientId, other.visit.patientId]))).toHaveLength(0)
  })

  it('rejects a typo or a duplicate tube before anything is written', async () => {
    const { visit, orders: [o] } = await scheduledVisit(fresh(), 1)
    const digits = o.sampleId.slice(1)
    const last = Number(digits.at(-1))
    const typo = `L${digits.slice(0, -1)}${(last + 1) % 10}`
    expect(parseSampleId(typo)).toBeNull()
    expect(await collectHomeVisit(visit.id, [typo], COLLECTOR_S, NOW)).toEqual({ ok: false, error: 'invalid_sample_id', sampleId: typo })
    expect(await collectHomeVisit(visit.id, [o.sampleId, displaySampleId(o.sampleId)], COLLECTOR_S, NOW))
      .toEqual({ ok: false, error: 'invalid_sample_id', sampleId: displaySampleId(o.sampleId) })
    // A well-formed ID that is on no order at all.
    const stray = formatSampleId('2099-06-01', 999_999)
    expect(await collectHomeVisit(visit.id, [stray], COLLECTOR_S, NOW)).toEqual({ ok: false, error: 'sample_not_on_visit', sampleId: stray })
    expect((await orderRow(o.id)).status).toBe('scheduled')
    expect((await visitRow(visit.id)).status).toBe('booked')
  })

  it('refuses a collector who is not assigned, and an unknown visit', async () => {
    const { visit, orders: [o] } = await scheduledVisit(fresh(), 1)
    expect(await collectHomeVisit(visit.id, [o.sampleId], COLLECTOR2_S, NOW)).toEqual({ ok: false, error: 'not_assigned' })
    expect(await collectHomeVisit(visit.id, [o.sampleId], { ...COLLECTOR_S, userId: null }, NOW)).toEqual({ ok: false, error: 'not_assigned' })
    const unassigned = await scheduledVisit(fresh(), 1, { collectorUserId: null })
    expect(await collectHomeVisit(unassigned.visit.id, [unassigned.orders[0].sampleId], COLLECTOR_S, NOW)).toEqual({ ok: false, error: 'not_assigned' })
    expect(await collectHomeVisit(2147483000, [o.sampleId], COLLECTOR_S, NOW)).toEqual({ ok: false, error: 'not_found' })
    expect((await orderRow(o.id)).status).toBe('scheduled')
    // Admin covers for any collector.
    const r = await collectHomeVisit(unassigned.visit.id, [unassigned.orders[0].sampleId], ADMIN_S, NOW)
    expect(r.ok).toBe(true)
  })

  it('a cancelled visit is not collectable', async () => {
    const { visit, orders: [o] } = await scheduledVisit(fresh(), 1, { status: 'cancelled', cancelledAt: NOW, cancelledByName: PROBE_ADMIN, cancelReason: 'other' })
    expect(await collectHomeVisit(visit.id, [o.sampleId], COLLECTOR_S, NOW)).toEqual({ ok: false, error: 'not_collectable' })
  })

  it('two concurrent collects of the same visit: exactly one wins and one encounter is written', async () => {
    const { visit, orders: [o1, o2] } = await scheduledVisit(fresh(), 2)
    const rs = await Promise.all([
      collectHomeVisit(visit.id, [o1.sampleId, o2.sampleId], COLLECTOR_S, NOW),
      collectHomeVisit(visit.id, [o1.sampleId], COLLECTOR_S, NOW),
      collectHomeVisit(visit.id, [o2.sampleId], ADMIN_S, NOW),
    ])
    expect(rs.filter((r) => r.ok)).toHaveLength(1)
    expect(rs.filter((r) => !r.ok).every((r) => !r.ok && r.error === 'not_collectable')).toBe(true)
    const v = await visitRow(visit.id)
    expect(v.status).toBe('collected')
    const encs = await getDb().select().from(encounters).where(and(eq(encounters.patientId, visit.patientId), eq(encounters.encounterType, 'lab')))
    expect(encs.map((e) => e.id)).toEqual([v.encounterId])
  })

  it('route list: own visits only, minimal projection, sorted by window then id', async () => {
    const date = '2099-06-05'
    const late = await scheduledVisit(fresh(), 1, { visitDate: date, windowStart: '15:00', windowEnd: '16:00', windowLabel: 'Afternoon' })
    const early = await scheduledVisit(fresh(), 2, { visitDate: date, notes: 'Ring twice' })
    const others = await scheduledVisit(fresh(), 1, { visitDate: date, collectorUserId: colUser2 })

    const mine = await listCollectorRoute(colUser, date)
    expect(mine.map((s) => s.visitId)).toEqual([early.visit.id, late.visit.id])
    const stop = mine[0]
    expect(stop).toEqual({
      visitId: early.visit.id, status: 'booked', windowLabel: `TEST-SP5-${TAG}-w`, windowStart: '10:00', windowEnd: '12:00',
      patient: { id: early.visit.patientId, name: 'Asha R.', uhid: `TSP5C${TAG}${P.indexOf(early.visit.patientId)}`, ageYears: 119, gender: 'female' },
      contactPhone: '+919845013210',
      address: { line1: '12 Test Road', line2: null, city: 'Test City', district: null, stateCode: 'IN-KA', pinCode: '990001', landmark: 'Near the temple' },
      notes: 'Ring twice',
      tests: early.orders.map((o) => ({ orderId: o.id, testName: `TEST_SP5 collect lab ${RUN}`, sampleType: 'blood', container: 'edta_lavender', sampleId: o.sampleId, status: 'scheduled' })),
    })
    const json = JSON.stringify(mine)
    expect(json).not.toMatch(/dob|aadhaar|abha|1980-06-03|Reg line/i)

    const all = await listCollectorRoute(null, date)
    expect(all.map((s) => s.visitId)).toEqual(expect.arrayContaining([early.visit.id, late.visit.id, others.visit.id]))
    expect((await listCollectorRoute(colUser2, date)).map((s) => s.visitId)).toEqual([others.visit.id])
  })

  it("route list at 00:15 IST shows that IST day's visits", async () => {
    const today = await scheduledVisit(fresh(), 1, { visitDate: '2099-06-03' })
    const yesterday = await scheduledVisit(fresh(), 1, { visitDate: '2099-06-02' })
    const at0015 = new Date('2099-06-02T18:45:00Z') // 00:15 IST, 3 Jun 2099
    const ids = (await listCollectorRoute(colUser, istDateOf(at0015))).map((s) => s.visitId)
    expect(ids).toContain(today.visit.id)
    expect(ids).not.toContain(yesterday.visit.id)
  })
})
