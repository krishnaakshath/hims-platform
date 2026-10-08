import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { and, eq, inArray, like, or } from 'drizzle-orm'
import { getDb } from '@/db/client'
import {
  auditLog, homeCollectionVisits, homeCollectionWindows, labOrders, labServiceAreaPins, labTests, patients, providers, users,
} from '@/db/schema'
import type { Session } from '@/lib/auth'
import type { BookHomeCollectionRequest } from '@/lib/labs/validation'
import { parseSampleId } from '@/lib/labs/sample-id'
import {
  assignCollector, bookHomeCollection, cancelHomeCollection, getHomeCollectionContext, listCollectors,
  listHomeCollectionBoard, listWindowAvailability, rescheduleHomeCollection,
} from '@/lib/queries/home-collections'

const RUN = `${Date.now()}`
const TAG = RUN.slice(-6)
const PROBE = `TEST_SP5_HC-${RUN}`
const PROBE_COL = `TEST_SP5_HC_COL-${RUN}`
const PROBE_COL2 = `TEST_SP5_HC_COL2-${RUN}`
const PROBE_LABS = `TEST_SP5_HC_LABS-${RUN}`
const PROBE_NAMES = [PROBE, PROBE_COL, PROBE_COL2, PROBE_LABS]
const S: Session = { role: 'frontdesk', name: PROBE, userId: null }

// Per-run service-area PINs (99xxxx): one active (local), one inactive.
const PIN_BASE = 990000 + (Number(RUN.slice(-5)) % 4000) * 2
const PIN_LOCAL = String(PIN_BASE)
const PIN_INACTIVE = String(PIN_BASE + 1)
const P = Array.from({ length: 8 }, (_, i) => `TEST-SP5-${RUN}-H${i}`)
const UHID0 = `TESTSP5U${RUN}`

const NOW = new Date('2099-07-01T03:00:00Z') // 08:30 IST, 1 Jul 2099
const D2 = '2099-07-02'

let providerId = 0
let labTestId = 0
let imagingTestId = 0
let wMain = 0 // 10:00-12:00, capacity 3
let wOne = 0 // 09:00-10:00, capacity 1
let wTwo = 0 // 13:00-14:00, capacity 2
let wOff = 0 // inactive
let colUser = 0
let colUser2 = 0
let labsUser = 0
const pinIds: number[] = []
const orderIds: number[] = []

async function makeOrder(patientId: string, over: Partial<typeof labOrders.$inferInsert> = {}) {
  const [o] = await getDb().insert(labOrders).values({ patientId, labTestId, orderedByProviderId: providerId, ...over }).returning()
  orderIds.push(o.id)
  return o
}

const ADDRESS = { line1: 'SECRETLINE 12 Test Road', city: 'Test City', stateCode: 'IN-KA', pinCode: PIN_LOCAL }

function req(over: Partial<BookHomeCollectionRequest> & { labOrderIds: number[] }): BookHomeCollectionRequest {
  return {
    patientId: P[0],
    visitDate: D2,
    windowId: wMain,
    address: ADDRESS,
    contactPhone: '+919845013210',
    ...over,
  }
}

async function orderRow(id: number) {
  const [row] = await getDb().select().from(labOrders).where(eq(labOrders.id, id))
  return row
}

describe.skipIf(!process.env.DATABASE_URL)('home collections (DB)', () => {
  beforeAll(async () => {
    const db = getDb()
    await db.insert(patients).values(P.map((id, i) => ({
      id, name: `TEST_SP5 Home ${i}`, dob: '1980-01-01', phone: '+919845013210',
      addressLine1: 'Reg line 1', city: 'Reg City', stateCode: 'IN-KA', pinCode: i === 7 ? PIN_INACTIVE : PIN_LOCAL,
      ...(i === 0 ? { uhid: UHID0 } : {}),
    })))
    const pins = await db.insert(labServiceAreaPins).values([
      { pinCode: PIN_LOCAL, createdByName: PROBE },
      { pinCode: PIN_INACTIVE, createdByName: PROBE, isActive: false },
    ]).returning()
    pinIds.push(...pins.map((p) => p.id))
    const [pr] = await db.insert(providers).values({ name: `TEST_SP5 Dr HC ${RUN}`, specialty: 'Pathology', colorTag: '#000000' }).returning()
    providerId = pr.id
    const [t, ti] = await db.insert(labTests).values([
      { name: `TEST_SP5 hc lab ${RUN}`, code: `TEST-SP5-HC-${RUN}`, container: 'edta_lavender' },
      { name: `TEST_SP5 hc xray ${RUN}`, code: `TEST-SP5-HCX-${RUN}`, category: 'imaging' },
    ]).returning()
    labTestId = t.id
    imagingTestId = ti.id
    const ws = await db.insert(homeCollectionWindows).values([
      { label: `TEST-SP5-${TAG}-main`, startTime: '10:00', endTime: '12:00', capacity: 3 },
      { label: `TEST-SP5-${TAG}-one`, startTime: '09:00', endTime: '10:00', capacity: 1 },
      { label: `TEST-SP5-${TAG}-two`, startTime: '13:00', endTime: '14:00', capacity: 2 },
      { label: `TEST-SP5-${TAG}-off`, startTime: '15:00', endTime: '16:00', capacity: 5, isActive: false },
    ]).returning()
    ;[wMain, wOne, wTwo, wOff] = ws.map((w) => w.id)
    const us = await db.insert(users).values([
      { name: PROBE_COL, email: `test-sp5-hc-col-${RUN}@example.invalid`, role: 'collector' },
      { name: PROBE_COL2, email: `test-sp5-hc-col2-${RUN}@example.invalid`, role: 'collector' },
      { name: PROBE_LABS, email: `test-sp5-hc-labs-${RUN}@example.invalid`, role: 'labs' },
    ]).returning()
    ;[colUser, colUser2, labsUser] = us.map((u) => u.id)
  })

  afterAll(async () => {
    const db = getDb()
    if (orderIds.length > 0) await db.delete(labOrders).where(inArray(labOrders.id, orderIds))
    await db.delete(homeCollectionVisits).where(inArray(homeCollectionVisits.patientId, P))
    await db.delete(homeCollectionWindows).where(inArray(homeCollectionWindows.id, [wMain, wOne, wTwo, wOff]))
    await db.delete(auditLog).where(inArray(auditLog.userName, PROBE_NAMES))
    await db.delete(users).where(inArray(users.id, [colUser, colUser2, labsUser]))
    await db.delete(labTests).where(inArray(labTests.id, [labTestId, imagingTestId]))
    await db.delete(providers).where(eq(providers.id, providerId))
    if (pinIds.length > 0) await db.delete(labServiceAreaPins).where(inArray(labServiceAreaPins.id, pinIds))
    await db.delete(patients).where(inArray(patients.id, P))
  })

  it('books a local patient, snapshots the address and schedules the orders with sample IDs', async () => {
    const o1 = await makeOrder(P[0])
    const o2 = await makeOrder(P[0])
    const r = await bookHomeCollection(req({ labOrderIds: [o2.id, o1.id], notes: 'SECRETNOTE ring twice' }), S, NOW)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.visit).toMatchObject({
      status: 'booked', patientId: P[0], visitDate: D2, windowId: wMain, windowLabel: `TEST-SP5-${TAG}-main`, windowStart: '10:00', windowEnd: '12:00',
      addressLine1: ADDRESS.line1, city: 'Test City', stateCode: 'IN-KA', pinCode: PIN_LOCAL, contactPhone: '+919845013210', bookedByName: PROBE,
    })
    for (const o of [o1, o2]) {
      const row = await orderRow(o.id)
      expect(row).toMatchObject({ status: 'scheduled', homeCollectionVisitId: r.visit.id })
      expect(row.statusChangedAt?.getTime()).toBe(NOW.getTime())
      expect(r.sampleIds.get(o.id)).toBe(row.sampleId)
      expect(parseSampleId(row.sampleId!)?.dateIso).toBe('2099-07-01')
    }
    const audits = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, PROBE), eq(auditLog.action, 'booked home sample collection')))
    expect(audits.map((a) => a.details)).toContain(`visit=${r.visit.id} orders=${[o1.id, o2.id].sort((a, b) => a - b).join(',')} date=${D2} window=${wMain}`)
  })

  it('accepts a UHID as the patient and refuses an unknown patient', async () => {
    const o = await makeOrder(P[0])
    const r = await bookHomeCollection(req({ patientId: UHID0, labOrderIds: [o.id], windowId: wTwo }), S, NOW)
    expect(r.ok && r.visit.patientId).toBe(P[0])
    expect(await bookHomeCollection(req({ patientId: `NOPE-${RUN}`, labOrderIds: [o.id] }), S, NOW)).toEqual({ ok: false, error: 'patient_not_found' })
  })

  it('refuses an address outside the service area', async () => {
    const o = await makeOrder(P[1])
    const r = await bookHomeCollection(req({ patientId: P[1], labOrderIds: [o.id], address: { ...ADDRESS, pinCode: PIN_INACTIVE } }), S, NOW)
    expect(r).toEqual({ ok: false, error: 'not_in_service_area' })
    expect((await orderRow(o.id)).status).toBe('ordered')
  })

  it('a window starting within 60 minutes is closed; past and far dates are invalid; inactive windows are not found', async () => {
    const o = await makeOrder(P[1])
    expect(await bookHomeCollection(req({ patientId: P[1], labOrderIds: [o.id], visitDate: '2099-07-01', windowId: wOne }), S, NOW)).toEqual({ ok: false, error: 'window_closed' })
    const past = await bookHomeCollection(req({ patientId: P[1], labOrderIds: [o.id], visitDate: '2099-06-30' }), S, NOW)
    expect(past).toMatchObject({ ok: false, error: 'invalid_date', message: 'Pick today or a later date.' })
    expect(await bookHomeCollection(req({ patientId: P[1], labOrderIds: [o.id], visitDate: '2099-08-15' }), S, NOW)).toMatchObject({ ok: false, error: 'invalid_date' })
    expect(await bookHomeCollection(req({ patientId: P[1], labOrderIds: [o.id], windowId: wOff }), S, NOW)).toEqual({ ok: false, error: 'window_not_found' })
    expect((await orderRow(o.id)).status).toBe('ordered')
  })

  it('concurrent bookings for the last place in a window: exactly one wins', async () => {
    const oa = await makeOrder(P[2])
    const ob = await makeOrder(P[3])
    const [a, b] = await Promise.all([
      bookHomeCollection(req({ patientId: P[2], labOrderIds: [oa.id], windowId: wOne }), S, NOW),
      bookHomeCollection(req({ patientId: P[3], labOrderIds: [ob.id], windowId: wOne }), S, NOW),
    ])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    expect([a, b].find((r) => !r.ok)).toEqual({ ok: false, error: 'slot_full' })
    const visits = await getDb().select().from(homeCollectionVisits).where(and(eq(homeCollectionVisits.windowId, wOne), eq(homeCollectionVisits.visitDate, D2)))
    expect(visits).toHaveLength(1)
    const loser = a.ok ? ob : oa
    expect(await orderRow(loser.id)).toMatchObject({ status: 'ordered', homeCollectionVisitId: null, sampleId: null })
  })

  it('N parallel bookings against capacity K: exactly K succeed', async () => {
    const date = '2099-07-03'
    const patientsN = [P[2], P[3], P[4], P[5], P[6]]
    const orders = await Promise.all(patientsN.map((p) => makeOrder(p)))
    const rs = await Promise.all(orders.map((o, i) => bookHomeCollection(req({ patientId: patientsN[i], labOrderIds: [o.id], windowId: wTwo, visitDate: date }), S, NOW)))
    expect(rs.filter((r) => r.ok)).toHaveLength(2)
    expect(rs.filter((r) => !r.ok).every((r) => !r.ok && r.error === 'slot_full')).toBe(true)
    const visits = await getDb().select().from(homeCollectionVisits).where(and(eq(homeCollectionVisits.windowId, wTwo), eq(homeCollectionVisits.visitDate, date)))
    expect(visits).toHaveLength(2)
    const avail = await listWindowAvailability(date, NOW)
    expect(avail.find((w) => w.windowId === wTwo)).toMatchObject({ capacity: 2, booked: 2, remaining: 0, closed: false })
  })

  it('the same patient cannot double-book one slot, and two staff booking the same orders: one wins', async () => {
    const o1 = await makeOrder(P[4])
    const o2 = await makeOrder(P[4])
    const first = await bookHomeCollection(req({ patientId: P[4], labOrderIds: [o1.id], visitDate: '2099-07-04' }), S, NOW)
    expect(first.ok).toBe(true)
    expect(await bookHomeCollection(req({ patientId: P[4], labOrderIds: [o2.id], visitDate: '2099-07-04' }), S, NOW)).toEqual({ ok: false, error: 'already_booked' })

    const o3 = await makeOrder(P[5])
    const rs = await Promise.all([
      bookHomeCollection(req({ patientId: P[5], labOrderIds: [o3.id], visitDate: '2099-07-05' }), S, NOW),
      bookHomeCollection(req({ patientId: P[5], labOrderIds: [o3.id], visitDate: '2099-07-06' }), S, NOW),
    ])
    expect(rs.filter((r) => r.ok)).toHaveLength(1)
    expect(rs.find((r) => !r.ok)).toEqual({ ok: false, error: 'order_not_bookable' })
  })

  it('refuses imaging, already-scheduled, other-patient and missing orders', async () => {
    const img = await makeOrder(P[6], { labTestId: imagingTestId })
    const base = { patientId: P[6], visitDate: '2099-07-07' }
    expect(await bookHomeCollection(req({ ...base, labOrderIds: [img.id] }), S, NOW)).toEqual({ ok: false, error: 'order_not_bookable' })
    const other = await makeOrder(P[5])
    expect(await bookHomeCollection(req({ ...base, labOrderIds: [other.id] }), S, NOW)).toEqual({ ok: false, error: 'order_not_bookable' })
    expect(await bookHomeCollection(req({ ...base, labOrderIds: [2_000_000_000] }), S, NOW)).toEqual({ ok: false, error: 'order_not_bookable' })
    const o = await makeOrder(P[6])
    expect((await bookHomeCollection(req({ ...base, labOrderIds: [o.id] }), S, NOW)).ok).toBe(true)
    expect(await bookHomeCollection(req({ ...base, labOrderIds: [o.id], windowId: wTwo }), S, NOW)).toEqual({ ok: false, error: 'order_not_bookable' })
    expect((await orderRow(img.id)).status).toBe('ordered')
  })

  it('reschedule moves the slot, clears the collector on a date change, and bumps the count', async () => {
    const o = await makeOrder(P[1])
    const b = await bookHomeCollection(req({ patientId: P[1], labOrderIds: [o.id], visitDate: '2099-07-08' }), S, NOW)
    if (!b.ok) throw new Error(b.error)
    const v = b.visit.id
    expect(await assignCollector(v, colUser, S)).toMatchObject({ ok: true, visit: { collectorUserId: colUser, collectorAssignedByName: PROBE } })

    expect(await rescheduleHomeCollection(v, { visitDate: '2099-07-08', windowId: wMain, reason: 'patient_request' }, S, NOW)).toEqual({ ok: false, error: 'same_slot' })
    // Same date, new window: collector kept.
    const r1 = await rescheduleHomeCollection(v, { visitDate: '2099-07-08', windowId: wTwo, reason: 'address_issue', note: 'SECRETNOTE gate code' }, S, NOW)
    expect(r1).toMatchObject({ ok: true, visit: { windowId: wTwo, windowLabel: `TEST-SP5-${TAG}-two`, windowStart: '13:00', rescheduleCount: 1, collectorUserId: colUser, lastRescheduleReason: 'address_issue', lastRescheduleNote: 'SECRETNOTE gate code' } })
    // New date: collector cleared.
    const r2 = await rescheduleHomeCollection(v, { visitDate: '2099-07-09', windowId: wTwo, reason: 'patient_request' }, S, NOW)
    expect(r2).toMatchObject({ ok: true, visit: { visitDate: '2099-07-09', rescheduleCount: 2, collectorUserId: null, collectorAssignedAt: null, lastRescheduleNote: null } })
    expect((await orderRow(o.id))).toMatchObject({ status: 'scheduled', homeCollectionVisitId: v })

    expect(await rescheduleHomeCollection(v, { visitDate: '2099-06-01', windowId: wTwo, reason: 'other' }, S, NOW)).toMatchObject({ ok: false, error: 'invalid_date' })
    expect(await rescheduleHomeCollection(v, { visitDate: '2099-07-10', windowId: wOff, reason: 'other' }, S, NOW)).toEqual({ ok: false, error: 'window_not_found' })
    expect(await rescheduleHomeCollection(v, { visitDate: '2099-07-01', windowId: wOne, reason: 'other' }, S, NOW)).toEqual({ ok: false, error: 'window_closed' })
    // wOne on 2 Jul is full (concurrency test).
    expect(await rescheduleHomeCollection(v, { visitDate: D2, windowId: wOne, reason: 'other' }, S, NOW)).toEqual({ ok: false, error: 'slot_full' })
    expect(await rescheduleHomeCollection(2_000_000_000, { visitDate: D2, windowId: wMain, reason: 'other' }, S, NOW)).toEqual({ ok: false, error: 'not_found' })
    const audits = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, PROBE), eq(auditLog.action, 'rescheduled home sample collection')))
    expect(audits.map((a) => a.details)).toContain(`visit=${v} date=2099-07-09 window=${wTwo} reason=patient_request`)
  })

  it('reschedule onto a slot where the patient already has a visit is already_booked', async () => {
    const o1 = await makeOrder(P[6])
    const o2 = await makeOrder(P[6])
    const a = await bookHomeCollection(req({ patientId: P[6], labOrderIds: [o1.id], visitDate: '2099-07-11' }), S, NOW)
    const b = await bookHomeCollection(req({ patientId: P[6], labOrderIds: [o2.id], visitDate: '2099-07-11', windowId: wTwo }), S, NOW)
    if (!a.ok || !b.ok) throw new Error('fixture booking failed')
    expect(await rescheduleHomeCollection(b.visit.id, { visitDate: '2099-07-11', windowId: wMain, reason: 'other' }, S, NOW)).toEqual({ ok: false, error: 'already_booked' })
  })

  it('cancel returns the orders to ordered and keeps their sample IDs', async () => {
    const o = await makeOrder(P[1])
    const b = await bookHomeCollection(req({ patientId: P[1], labOrderIds: [o.id], visitDate: '2099-07-12' }), S, NOW)
    if (!b.ok) throw new Error(b.error)
    const sampleId = b.sampleIds.get(o.id)
    const r = await cancelHomeCollection(b.visit.id, { reason: 'patient_request', note: 'SECRETNOTE moved away' }, S, NOW)
    expect(r).toMatchObject({ ok: true, releasedOrderIds: [o.id], visit: { status: 'cancelled', cancelReason: 'patient_request', cancelNote: 'SECRETNOTE moved away', cancelledByName: PROBE } })
    expect(await orderRow(o.id)).toMatchObject({ status: 'ordered', homeCollectionVisitId: null, sampleId })
    expect(await cancelHomeCollection(b.visit.id, { reason: 'other' }, S, NOW)).toEqual({ ok: false, error: 'not_cancellable' })
    expect(await rescheduleHomeCollection(b.visit.id, { visitDate: '2099-07-13', windowId: wMain, reason: 'other' }, S, NOW)).toEqual({ ok: false, error: 'not_reschedulable' })
    expect(await cancelHomeCollection(2_000_000_000, { reason: 'other' }, S, NOW)).toEqual({ ok: false, error: 'not_found' })
    // The released order can be booked again and keeps its sample ID.
    const again = await bookHomeCollection(req({ patientId: P[1], labOrderIds: [o.id], visitDate: '2099-07-12' }), S, NOW)
    expect(again.ok && again.sampleIds.get(o.id)).toBe(sampleId)
    const audits = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, PROBE), eq(auditLog.action, 'cancelled home sample collection')))
    expect(audits.map((a) => a.details)).toContain(`visit=${b.visit.id} reason=patient_request orders=${o.id}`)
  })

  it('a collector may cancel only their own visit with a collector reason', async () => {
    const o = await makeOrder(P[2])
    const b = await bookHomeCollection(req({ patientId: P[2], labOrderIds: [o.id], visitDate: '2099-07-14' }), S, NOW)
    if (!b.ok) throw new Error(b.error)
    const v = b.visit.id
    const col: Session = { role: 'collector', name: PROBE_COL, userId: colUser }
    const col2: Session = { role: 'collector', name: PROBE_COL2, userId: colUser2 }
    expect(await cancelHomeCollection(v, { reason: 'patient_unavailable' }, col, NOW)).toEqual({ ok: false, error: 'not_assigned' })
    expect(await assignCollector(v, colUser, S)).toMatchObject({ ok: true })
    expect(await cancelHomeCollection(v, { reason: 'patient_unavailable' }, col2, NOW)).toEqual({ ok: false, error: 'not_assigned' })
    expect(await cancelHomeCollection(v, { reason: 'patient_request' }, col, NOW)).toEqual({ ok: false, error: 'reason_not_allowed' })
    expect(await cancelHomeCollection(v, { reason: 'patient_unavailable' }, col, NOW)).toMatchObject({ ok: true, visit: { status: 'cancelled', cancelReason: 'patient_unavailable' } })
  })

  it('assignCollector accepts only collector-role users and booked visits', async () => {
    const o = await makeOrder(P[3])
    const b = await bookHomeCollection(req({ patientId: P[3], labOrderIds: [o.id], visitDate: '2099-07-15' }), S, NOW)
    if (!b.ok) throw new Error(b.error)
    expect(await assignCollector(b.visit.id, labsUser, S)).toEqual({ ok: false, error: 'collector_not_found' })
    expect(await assignCollector(b.visit.id, 2_000_000_000, S)).toEqual({ ok: false, error: 'collector_not_found' })
    expect(await assignCollector(2_000_000_000, colUser, S)).toEqual({ ok: false, error: 'not_found' })
    expect(await assignCollector(b.visit.id, colUser2, S)).toMatchObject({ ok: true, visit: { collectorUserId: colUser2 } })
    expect(await assignCollector(b.visit.id, null, S)).toMatchObject({ ok: true, visit: { collectorUserId: null, collectorAssignedAt: null } })
    await cancelHomeCollection(b.visit.id, { reason: 'other' }, S, NOW)
    expect(await assignCollector(b.visit.id, colUser, S)).toEqual({ ok: false, error: 'not_assignable' })
    const audits = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, PROBE), eq(auditLog.action, 'assigned home collection collector')))
    expect(audits.map((a) => a.details)).toEqual(expect.arrayContaining([`visit=${b.visit.id} collector=${colUser2}`, `visit=${b.visit.id} collector=none`]))
    const collectors = await listCollectors()
    expect(collectors).toEqual(expect.arrayContaining([{ id: colUser, name: PROBE_COL }, { id: colUser2, name: PROBE_COL2 }]))
    expect(collectors.some((c) => c.id === labsUser)).toBe(false)
  })

  it('context matches id or UHID, lists only ordered lab tests, and decides locality from the registered PIN', async () => {
    const lab = await makeOrder(P[7])
    await makeOrder(P[7], { labTestId: imagingTestId })
    const byId = await getHomeCollectionContext(P[7])
    expect(byId).toMatchObject({ isLocal: false, patient: { id: P[7], pinCode: PIN_INACTIVE, stateCode: 'IN-KA', phone: '+919845013210', notificationOptOut: false } })
    expect(byId?.bookableOrders).toEqual([{ id: lab.id, testName: `TEST_SP5 hc lab ${RUN}`, sampleType: null, container: 'edta_lavender' }])
    expect(byId?.bookableOrderCount).toBe(1)
    const byUhid = await getHomeCollectionContext(UHID0)
    expect(byUhid).toMatchObject({ isLocal: true, patient: { id: P[0], uhid: UHID0 } })
    expect(byUhid?.activeVisits.length).toBeGreaterThan(0)
    expect(Object.keys(byUhid!.patient).some((k) => /aadhaar|abha|password|mfa/i.test(k))).toBe(false)
    expect(await getHomeCollectionContext(`NOPE-${RUN}`)).toBeNull()
  })

  it('board: one row per visit with its tests, sorted by window start then id', async () => {
    const board = await listHomeCollectionBoard(D2, NOW)
    const mine = board.visits.filter((v) => P.includes(v.patientId))
    expect(mine.length).toBeGreaterThanOrEqual(3)
    const starts = mine.map((v) => (v.windowId === wOne ? '09:00' : v.windowId === wMain ? '10:00' : '13:00'))
    expect([...starts].sort()).toEqual(starts)
    const first = mine.find((v) => v.patientId === P[0] && v.windowId === wMain)!
    expect(first).toMatchObject({ status: 'booked', uhid: UHID0, pinCode: PIN_LOCAL, contactPhone: '+919845013210', collector: null, rescheduleCount: 0 })
    expect(first.tests).toHaveLength(2)
    expect(first.tests[0]).toMatchObject({ testName: `TEST_SP5 hc lab ${RUN}`, container: 'edta_lavender', status: 'scheduled' })
    expect(board.windows.find((w) => w.windowId === wOne)).toMatchObject({ booked: 1, remaining: 0 })
    expect(board.windows.some((w) => w.windowId === wOff)).toBe(false)
    expect(board.totalVisits).toBeGreaterThanOrEqual(mine.length)
  })

  it('availability marks a window closed inside the 60-minute lead time', async () => {
    const today = await listWindowAvailability('2099-07-01', NOW)
    expect(today.find((w) => w.windowId === wOne)?.closed).toBe(true) // 09:00, 30 min away
    expect(today.find((w) => w.windowId === wMain)?.closed).toBe(false) // 10:00, 90 min away
  })

  it('audit details carry no address, phone or note', async () => {
    const rows = await getDb()
      .select({ details: auditLog.details })
      .from(auditLog)
      .where(and(inArray(auditLog.userName, PROBE_NAMES), or(like(auditLog.details, '%SECRET%'), like(auditLog.details, '%9845013210%'), like(auditLog.details, `%${PIN_LOCAL}%`))))
    expect(rows).toEqual([])
    const all = await getDb().select({ details: auditLog.details }).from(auditLog).where(inArray(auditLog.userName, PROBE_NAMES))
    expect(all.length).toBeGreaterThan(5)
  })
})
