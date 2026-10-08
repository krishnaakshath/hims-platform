import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, homeCollectionVisits, homeCollectionWindows, labOrders, labResults, labTests, patients, providers, users } from '@/db/schema'
import type { Session } from '@/lib/auth'
import { parseSampleId, formatSampleId } from '@/lib/labs/sample-id'
import {
  allocateSampleId, cancelLabOrder, collectLabOrder, ensureSampleIds, getLabOrder, receiveLabSample, recordLabResult, verifyLabResult,
} from '@/lib/queries/lab-lifecycle'

const RUN = `${Date.now()}`
const PROBE = `TEST_SP5_LIFE-${RUN}`
const PROBE_U1 = `TEST_SP5_LIFE_U1-${RUN}`
const PROBE_U2 = `TEST_SP5_LIFE_U2-${RUN}`
const PROBE_ADMIN = `TEST_SP5_LIFE_ADMIN-${RUN}`
const PROBE_NAMES = [PROBE, PROBE_U1, PROBE_U2, PROBE_ADMIN]
const P = `TEST-SP5-${RUN}-LA`
const P_OTHER = `TEST-SP5-${RUN}-LB`
const S: Session = { role: 'labs', name: PROBE, userId: null }
const ADMIN: Session = { role: 'admin', name: PROBE_ADMIN, userId: null }
const NOW = new Date('2099-05-01T05:00:00Z') // 10:30 IST, 1 May 2099
const NOW3 = new Date('2099-05-03T05:00:00Z')
const RESULT = { value: '5.4', unit: 'mmol/L', flag: 'normal' as const }

let providerId = 0
let labTestId = 0
let windowId = 0
let u1 = 0
let u2 = 0
const orderIds: number[] = []
const visitIds: number[] = []

async function makeOrder(over: Partial<typeof labOrders.$inferInsert> = {}) {
  const [o] = await getDb().insert(labOrders).values({ patientId: P, labTestId, orderedByProviderId: providerId, ...over }).returning()
  orderIds.push(o.id)
  return o
}

async function makeVisit(visitDate = '2099-05-10') {
  const [v] = await getDb().insert(homeCollectionVisits).values({
    patientId: P, visitDate, windowId, windowLabel: 'Morning', windowStart: '07:00', windowEnd: '09:00',
    addressLine1: 'TEST_SP5 line', city: 'Test City', stateCode: 'IN-KA', pinCode: '990011', contactPhone: '+919845013210', bookedByName: PROBE,
  }).returning()
  visitIds.push(v.id)
  return v
}

/** Collected (walk-in) order with an allocated sample ID. */
async function collected(patientId = P) {
  const o = await makeOrder({ patientId })
  const r = await collectLabOrder(o.id, S, NOW)
  if (!r.ok) throw new Error(`fixture collect failed: ${r.error}`)
  return { id: o.id, sampleId: r.sampleId }
}

async function received() {
  const c = await collected()
  const r = await receiveLabSample(c.sampleId, S, NOW)
  if (!r.ok) throw new Error(`fixture receive failed: ${r.error}`)
  return c
}

/** A valid-check-digit sample ID that no row carries (seq 9999 on a far date). */
const UNUSED_SAMPLE_ID = formatSampleId('2099-12-31', 9999)

describe.skipIf(!process.env.DATABASE_URL)('lab lifecycle (DB)', () => {
  beforeAll(async () => {
    const db = getDb()
    await db.insert(patients).values([
      { id: P, name: 'TEST_SP5 Lifecycle', dob: '1980-01-01' },
      { id: P_OTHER, name: 'TEST_SP5 Lifecycle other', dob: '1981-01-01' },
    ])
    const [pr] = await db.insert(providers).values({ name: `TEST_SP5 Dr ${RUN}`, specialty: 'Pathology', colorTag: '#000000' }).returning()
    providerId = pr.id
    const [t] = await db.insert(labTests).values({ name: `TEST_SP5 life ${RUN}`, code: `TEST-SP5-L-${RUN}` }).returning()
    labTestId = t.id
    const [w] = await db.insert(homeCollectionWindows).values({ label: `TEST-SP5-${RUN.slice(-6)}-life`, startTime: '07:00', endTime: '09:00', capacity: 5, isActive: false }).returning()
    windowId = w.id
    const [a, b] = await db.insert(users).values([
      { name: PROBE_U1, email: `test-sp5-u1-${RUN}@example.invalid`, role: 'labs' },
      { name: PROBE_U2, email: `test-sp5-u2-${RUN}@example.invalid`, role: 'pi' },
    ]).returning()
    u1 = a.id
    u2 = b.id
  })

  afterAll(async () => {
    const db = getDb()
    if (orderIds.length > 0) {
      await db.delete(labResults).where(inArray(labResults.labOrderId, orderIds))
      await db.delete(labOrders).where(inArray(labOrders.id, orderIds))
    }
    if (visitIds.length > 0) await db.delete(homeCollectionVisits).where(inArray(homeCollectionVisits.id, visitIds))
    await db.delete(homeCollectionWindows).where(eq(homeCollectionWindows.id, windowId))
    await db.delete(auditLog).where(inArray(auditLog.userName, PROBE_NAMES))
    await db.delete(auditLog).where(and(eq(auditLog.userName, 'LIS integration'), inArray(auditLog.patientId, [P, P_OTHER])))
    await db.delete(users).where(inArray(users.id, [u1, u2]))
    await db.delete(labTests).where(eq(labTests.id, labTestId))
    await db.delete(providers).where(eq(providers.id, providerId))
    await db.delete(patients).where(inArray(patients.id, [P, P_OTHER]))
  })

  it('walk-in collect allocates a valid sample ID and is not repeatable', async () => {
    const o1 = await makeOrder()
    const r = await collectLabOrder(o1.id, S, NOW)
    expect(r.ok && parseSampleId(r.sampleId)?.dateIso).toBe('2099-05-01')
    if (!r.ok) return
    expect(r.order).toMatchObject({ status: 'collected', sampleId: r.sampleId, sampleDate: '2099-05-01', collectedByName: PROBE })
    expect(r.order.collectedAt?.getTime()).toBe(NOW.getTime())
    expect(r.order.statusChangedAt?.getTime()).toBe(NOW.getTime())
    expect(await collectLabOrder(o1.id, S, NOW)).toEqual({ ok: false, error: 'invalid_status' })
    expect((await getLabOrder(o1.id))?.sampleId).toBe(r.sampleId)
    const audits = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, PROBE), eq(auditLog.action, 'marked lab order collected'), eq(auditLog.details, `order=${o1.id} sample=${r.sampleId}`)))
    expect(audits).toHaveLength(1)
    expect(audits[0].patientId).toBe(P)
  })

  it('collect of a missing order is not_found', async () => {
    expect(await collectLabOrder(2_000_000_000, S, NOW)).toEqual({ ok: false, error: 'not_found' })
  })

  it('sample date is the IST date', async () => {
    const o2 = await makeOrder()
    const r = await collectLabOrder(o2.id, S, new Date('2099-05-01T18:40:00Z')) // 00:10 IST 2 May
    expect(r.ok && parseSampleId(r.sampleId)?.dateIso).toBe('2099-05-02')
  })

  it('concurrent collections on one date get distinct sequence numbers', async () => {
    const orders5 = await Promise.all([1, 2, 3, 4, 5].map(() => makeOrder()))
    const rs = await Promise.all(orders5.map((o) => collectLabOrder(o.id, S, NOW3)))
    expect(rs.every((r) => r.ok)).toBe(true)
    expect(new Set(rs.map((r) => (r.ok ? r.sampleId : null))).size).toBe(5)
    const seqs = rs.map((r) => (r.ok ? parseSampleId(r.sampleId)!.seq : 0)).sort((a, b) => a - b)
    expect(seqs[4] - seqs[0]).toBe(4)
  })

  it('two clerks collecting the same order at once: exactly one wins', async () => {
    const o = await makeOrder()
    const rs = await Promise.all([collectLabOrder(o.id, S, NOW), collectLabOrder(o.id, ADMIN, NOW)])
    expect(rs.filter((r) => r.ok)).toHaveLength(1)
    expect(rs.filter((r) => !r.ok)).toEqual([{ ok: false, error: 'invalid_status' }])
  })

  it('ensureSampleIds allocates once and never re-allocates', async () => {
    const o = await makeOrder()
    const first = await getDb().transaction((tx) => ensureSampleIds(tx, [o.id], NOW))
    const again = await getDb().transaction((tx) => ensureSampleIds(tx, [o.id], NOW3))
    expect(again.get(o.id)).toBe(first.get(o.id))
    expect(parseSampleId(first.get(o.id)!)?.dateIso).toBe('2099-05-01')
    const alloc = await getDb().transaction((tx) => allocateSampleId(tx, '2099-05-01'))
    expect(alloc.sampleDate).toBe('2099-05-01')
    expect(alloc.sampleId).toBe(formatSampleId('2099-05-01', alloc.sampleSeq))
    expect(alloc.sampleSeq).toBeGreaterThan(parseSampleId(first.get(o.id)!)!.seq)
  })

  it('refuses walk-in collection of a home-booked order', async () => {
    const v = await makeVisit()
    const o = await makeOrder({ status: 'scheduled', homeCollectionVisitId: v.id })
    expect(await collectLabOrder(o.id, S, NOW)).toEqual({ ok: false, error: 'booked_for_home' })
    expect((await getLabOrder(o.id))?.status).toBe('scheduled')
  })

  it('receive needs the exact sample ID; a typo is invalid_sample_id', async () => {
    const c = await collected()
    const typo = c.sampleId.slice(0, -2) + String((Number(c.sampleId.at(-2)) + 1) % 10) + c.sampleId.at(-1)
    expect(await receiveLabSample(typo, S, NOW)).toEqual({ ok: false, error: 'invalid_sample_id' })
    expect(await receiveLabSample(UNUSED_SAMPLE_ID, S, NOW)).toEqual({ ok: false, error: 'not_found' })
    // The displayed (grouped, lower-case) form is accepted.
    const grouped = `${c.sampleId.slice(0, 7)}-${c.sampleId.slice(7, -1)}-${c.sampleId.at(-1)}`.toLowerCase()
    const r = await receiveLabSample(grouped, S, NOW)
    expect(r.ok && r.order).toMatchObject({ id: c.id, status: 'received', receivedByName: PROBE })
    expect(await receiveLabSample(c.sampleId, S, NOW)).toEqual({ ok: false, error: 'already_received' })
    const audits = await getDb().select().from(auditLog).where(and(eq(auditLog.action, 'received lab sample'), eq(auditLog.details, `order=${c.id} sample=${c.sampleId}`)))
    expect(audits).toHaveLength(1)
  })

  it('double receive at the same moment: exactly one wins', async () => {
    const c = await collected()
    const rs = await Promise.all([receiveLabSample(c.sampleId, S, NOW), receiveLabSample(c.sampleId, ADMIN, NOW)])
    expect(rs.filter((r) => r.ok)).toHaveLength(1)
    expect(rs.filter((r) => !r.ok)).toEqual([{ ok: false, error: 'already_received' }])
  })

  it('a pre-allocated sample ID on a home-booked order cannot be received yet', async () => {
    const v = await makeVisit('2099-05-11')
    const o = await makeOrder({ status: 'scheduled', homeCollectionVisitId: v.id })
    const ids = await getDb().transaction((tx) => ensureSampleIds(tx, [o.id], NOW))
    expect(await receiveLabSample(ids.get(o.id)!, S, NOW)).toEqual({ ok: false, error: 'invalid_status' })
  })

  it('staff result needs received; amending a resulted order sets amendedAt', async () => {
    const c = await collected()
    const staff = { kind: 'staff' as const, session: S }
    expect(await recordLabResult(c.id, RESULT, staff, { now: NOW })).toEqual({ ok: false, error: 'invalid_status' })
    await receiveLabSample(c.sampleId, S, NOW)
    expect(await recordLabResult(c.id, RESULT, staff, { now: NOW })).toEqual({ ok: true, patientId: P, amended: false })
    const [r1] = await getDb().select().from(labResults).where(eq(labResults.labOrderId, c.id))
    expect(r1).toMatchObject({ value: '5.4', resultedByName: PROBE, resultedByUserId: null, amendedAt: null })
    expect((await getLabOrder(c.id))?.status).toBe('resulted')
    expect(await recordLabResult(c.id, { ...RESULT, value: '5.6' }, staff, { now: NOW3 })).toEqual({ ok: true, patientId: P, amended: true })
    const [r2] = await getDb().select().from(labResults).where(eq(labResults.labOrderId, c.id))
    expect(r2.value).toBe('5.6')
    expect(r2.amendedAt?.getTime()).toBe(NOW3.getTime())
    const actions = (await getDb().select().from(auditLog).where(and(eq(auditLog.userName, PROBE), eq(auditLog.details, `order=${c.id}`)))).map((a) => a.action)
    expect(actions).toEqual(expect.arrayContaining(['entered lab result', 'amended lab result']))
    expect(await recordLabResult(2_000_000_000, RESULT, staff)).toEqual({ ok: false, error: 'not_found' })
  })

  it('LIS result on a collected order stamps receipt and results it', async () => {
    const c = await collected()
    expect(await recordLabResult(c.id, RESULT, { kind: 'lis' }, { expectedPatientId: P, now: NOW })).toEqual({ ok: true, patientId: P, amended: false })
    const o = await getLabOrder(c.id)
    expect(o).toMatchObject({ status: 'resulted', receivedByName: 'System (LIS API)' })
    expect(o?.receivedAt?.getTime()).toBe(NOW.getTime())
    const [r] = await getDb().select().from(labResults).where(eq(labResults.labOrderId, c.id))
    expect(r).toMatchObject({ resultedByName: 'System (LIS API)', resultedByUserId: null })
    const lis = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, 'LIS integration'), eq(auditLog.action, `accepted LIS lab result for order ${c.id}`)))
    expect(lis).toHaveLength(1)
    // A later LIS message amends; an order not yet collected is refused.
    expect(await recordLabResult(c.id, { ...RESULT, value: '5.5' }, { kind: 'lis' }, { now: NOW3 })).toEqual({ ok: true, patientId: P, amended: true })
    const o2 = await makeOrder()
    expect(await recordLabResult(o2.id, RESULT, { kind: 'lis' }, { now: NOW })).toEqual({ ok: false, error: 'invalid_status' })
  })

  it('LIS result for another patient changes nothing', async () => {
    const c = await collected()
    expect(await recordLabResult(c.id, RESULT, { kind: 'lis' }, { expectedPatientId: P_OTHER, now: NOW })).toEqual({ ok: false, error: 'patient_mismatch' })
    const o = await getLabOrder(c.id)
    expect(o).toMatchObject({ status: 'collected', receivedAt: null })
    expect(await getDb().select().from(labResults).where(eq(labResults.labOrderId, c.id))).toHaveLength(0)
  })

  it('the person who entered a result cannot verify it', async () => {
    const enter = (id: number, userId: number | null, name: string) =>
      recordLabResult(id, RESULT, { kind: 'staff', session: { role: 'labs', name, userId } }, { now: NOW })
    const a = await received()
    expect((await enter(a.id, u1, PROBE_U1)).ok).toBe(true)
    expect(await verifyLabResult(a.id, { role: 'admin', name: PROBE_U1, userId: u1 }, NOW)).toEqual({ ok: false, error: 'self_verification' })
    expect((await getLabOrder(a.id))?.status).toBe('resulted')
    const ok = await verifyLabResult(a.id, { role: 'pi', name: PROBE_U2, userId: u2 }, NOW3)
    expect(ok.ok && ok.order).toMatchObject({ status: 'verified', verifiedByName: PROBE_U2, verifiedByUserId: u2 })
    expect(ok.ok && ok.order.verifiedAt?.getTime()).toBe(NOW3.getTime())
    expect(await verifyLabResult(a.id, { role: 'pi', name: PROBE_U2, userId: u2 }, NOW3)).toEqual({ ok: false, error: 'invalid_status' })
    // Results cannot be changed after verification.
    expect(await enter(a.id, u1, PROBE_U1)).toEqual({ ok: false, error: 'invalid_status' })
    // The env admin (no user id) may verify another person's result.
    const b = await received()
    await enter(b.id, u1, PROBE_U1)
    expect((await verifyLabResult(b.id, ADMIN, NOW)).ok).toBe(true)
    // An amendment by U2 makes U2 the last enterer: now U2 is the one who cannot verify.
    const c = await received()
    await enter(c.id, u1, PROBE_U1)
    await enter(c.id, u2, PROBE_U2)
    expect(await verifyLabResult(c.id, { role: 'pi', name: PROBE_U2, userId: u2 }, NOW)).toEqual({ ok: false, error: 'self_verification' })
    // Not yet resulted.
    const d = await received()
    expect(await verifyLabResult(d.id, ADMIN, NOW)).toEqual({ ok: false, error: 'invalid_status' })
    expect(await verifyLabResult(2_000_000_000, ADMIN, NOW)).toEqual({ ok: false, error: 'not_found' })
    const audits = await getDb().select().from(auditLog).where(and(eq(auditLog.action, 'verified lab result'), eq(auditLog.details, `order=${a.id}`)))
    expect(audits.map((x) => x.userName)).toEqual([PROBE_U2])
  })

  it('cancelling the last scheduled order of a visit cancels the visit', async () => {
    const v = await makeVisit('2099-05-12')
    const o1 = await makeOrder({ status: 'scheduled', homeCollectionVisitId: v.id })
    const o2 = await makeOrder({ status: 'scheduled', homeCollectionVisitId: v.id })
    expect(await cancelLabOrder(o1.id, 'doctor changed plan', S, NOW)).toEqual({ ok: true, patientId: P, cancelledVisitId: null })
    const [still] = await getDb().select().from(homeCollectionVisits).where(eq(homeCollectionVisits.id, v.id))
    expect(still.status).toBe('booked')
    expect(await getLabOrder(o1.id)).toMatchObject({ status: 'cancelled', homeCollectionVisitId: null, cancelReason: 'doctor changed plan', cancelledByName: PROBE })
    expect(await cancelLabOrder(o2.id, 'doctor changed plan', S, NOW)).toEqual({ ok: true, patientId: P, cancelledVisitId: v.id })
    const [gone] = await getDb().select().from(homeCollectionVisits).where(eq(homeCollectionVisits.id, v.id))
    expect(gone).toMatchObject({ status: 'cancelled', cancelReason: 'tests_cancelled', cancelledByName: PROBE })
    const audits = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, PROBE), eq(auditLog.action, 'cancelled lab order'), inArray(auditLog.details, [`order=${o1.id}`, `order=${o2.id} visit=${v.id}`])))
    expect(audits).toHaveLength(2)
  })

  it('cancelling the last two scheduled orders at once still cancels the visit', async () => {
    const v = await makeVisit('2099-05-13')
    const o1 = await makeOrder({ status: 'scheduled', homeCollectionVisitId: v.id })
    const o2 = await makeOrder({ status: 'scheduled', homeCollectionVisitId: v.id })
    const rs = await Promise.all([cancelLabOrder(o1.id, 'x', S, NOW), cancelLabOrder(o2.id, 'x', ADMIN, NOW)])
    expect(rs.every((r) => r.ok)).toBe(true)
    expect(rs.filter((r) => r.ok && r.cancelledVisitId === v.id)).toHaveLength(1)
    const [gone] = await getDb().select().from(homeCollectionVisits).where(eq(homeCollectionVisits.id, v.id))
    expect(gone.status).toBe('cancelled')
  })

  it('only orders without a result can be cancelled', async () => {
    const c = await received()
    await recordLabResult(c.id, RESULT, { kind: 'staff', session: S }, { now: NOW })
    expect(await cancelLabOrder(c.id, 'x', S, NOW)).toEqual({ ok: false, error: 'not_cancellable' })
    const o = await makeOrder()
    expect((await cancelLabOrder(o.id, 'x', S, NOW)).ok).toBe(true)
    expect(await cancelLabOrder(o.id, 'x', S, NOW)).toEqual({ ok: false, error: 'not_cancellable' })
    expect(await cancelLabOrder(2_000_000_000, 'x', S, NOW)).toEqual({ ok: false, error: 'not_found' })
  })

  it('audit details never carry the cancel reason or result value', async () => {
    const c = await received()
    await recordLabResult(c.id, { ...RESULT, value: 'SECRETVAL', notes: 'SECRETNOTE' }, { kind: 'staff', session: S }, { now: NOW })
    const o = await makeOrder()
    await cancelLabOrder(o.id, 'SECRETWORD', S, NOW)
    const rows = await getDb().select().from(auditLog).where(inArray(auditLog.userName, PROBE_NAMES))
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(`${r.action} ${r.details}`).not.toMatch(/SECRETWORD|SECRETVAL|SECRETNOTE/)
  })
})
