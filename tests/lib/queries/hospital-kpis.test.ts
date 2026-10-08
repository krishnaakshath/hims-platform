import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { inArray } from 'drizzle-orm'

// Redis off: every loader runs against the live DB, and the JSON-safety
// assertions below see exactly what a cache hit would return.
beforeAll(() => { vi.stubEnv('KV_REST_API_URL', ''); vi.stubEnv('KV_REST_API_TOKEN', '') })
afterAll(() => { vi.unstubAllEnvs() })

import { getDb } from '@/db/client'
import {
  admissions, encounterNotes, encounters, followUpOrders, labOrders, labResults, labTests, medicationDispenses,
  medicationInventory, medications, patientPayments, patients, providers, refunds, rooms, invoices, chargeLines,
} from '@/db/schema'
import { purgeBillingFixtures } from '../../db/billing-fixtures'
import {
  loadOpdToday, loadIpdCensus, loadCollectionsToday, loadBillingQueue, loadLabKpis, loadPharmacyKpis,
  loadFollowUpBuckets, loadDoctorWorkload,
} from '@/lib/queries/hospital-kpis'

// Wave E: hospital KPIs. A far-future IST day nobody else writes to isolates
// the date-scoped counts; global counts (beds, admitted, stock, queues) are
// asserted as deltas around this suite's own fixtures.
const RUN = `${Date.now()}`.slice(-9)
const DAY = '2031-04-15'
const P1 = `TEST-WE-${RUN}-1`
const P2 = `TEST-WE-${RUN}-2`
const WARD = `TEST_WE Ward ${RUN}`
let docA = 0
let docB = 0
let testId = 0
let medId = 0
const ids = { enc: [] as number[], rooms: [] as number[], adm: [] as number[], orders: [] as number[], fu: [] as number[], notes: [] as number[], disp: [] as number[] }

// Baselines for global counts, taken before any fixture exists.
let base: {
  ipd: Awaited<ReturnType<typeof loadIpdCensus>>
  billing: Awaited<ReturnType<typeof loadBillingQueue>>
  lab: Awaited<ReturnType<typeof loadLabKpis>>
  pharmacy: Awaited<ReturnType<typeof loadPharmacyKpis>>
}

const at = (hhmm: string) => new Date(`${DAY}T${hhmm}:00+05:30`)
const json = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T

describe.skipIf(!process.env.DATABASE_URL)('hospital KPIs (DB)', () => {
  beforeAll(async () => {
    base = { ipd: await loadIpdCensus(), billing: await loadBillingQueue(), lab: await loadLabKpis(DAY), pharmacy: await loadPharmacyKpis(DAY) }
    const db = getDb()
    const [a] = await db.insert(providers).values({ name: `TEST_WE Dr A ${RUN}`, specialty: 'Test', colorTag: '#000000' }).returning()
    const [b] = await db.insert(providers).values({ name: `TEST_WE Dr B ${RUN}`, specialty: 'Test', colorTag: '#000000' }).returning()
    docA = a.id; docB = b.id
    await db.insert(patients).values([
      { id: P1, name: 'TEST_WE Kpi One', dob: '1980-01-01', gender: 'male', uhid: `TWE-1-${RUN}`, phone: '9876500001' },
      { id: P2, name: 'TEST_WE Kpi Two', dob: '1990-01-01', gender: 'female', uhid: `TWE-2-${RUN}`, phone: '9876500002' },
    ])

    // OPD: 4 tokens for DAY (one per status) plus an IPD encounter (not a token).
    const enc = await db.insert(encounters).values([
      { patientId: P1, encounterType: 'opd', status: 'checked_in', encounterDate: DAY, opdToken: 1, providerId: docA, checkedInByName: 'TEST_WE' },
      { patientId: P2, encounterType: 'opd', status: 'in_consultation', encounterDate: DAY, opdToken: 2, providerId: docA, checkedInByName: 'TEST_WE' },
      { patientId: P1, encounterType: 'opd', status: 'completed', encounterDate: DAY, opdToken: 3, providerId: docB, checkedInByName: 'TEST_WE' },
      { patientId: P2, encounterType: 'opd', status: 'cancelled', encounterDate: DAY, opdToken: 4, providerId: docB, checkedInByName: 'TEST_WE', cancelReason: 'test' },
      { patientId: P2, encounterType: 'ipd', status: 'checked_in', encounterDate: DAY, providerId: docA, checkedInByName: 'TEST_WE' },
    ]).returning({ id: encounters.id })
    ids.enc.push(...enc.map((r) => r.id))

    // Beds: one ward of 4 beds -- occupied, available, dirty, blocked.
    const rs = await db.insert(rooms).values([
      { ward: WARD, roomNumber: '1', bedNumber: 'A', status: 'occupied', occupiedByPatientId: P1 },
      { ward: WARD, roomNumber: '1', bedNumber: 'B', status: 'available' },
      { ward: WARD, roomNumber: '2', bedNumber: 'A', status: 'dirty' },
      { ward: WARD, roomNumber: '2', bedNumber: 'B', status: 'blocked', blockedReason: 'test' },
    ]).returning({ id: rooms.id })
    ids.rooms.push(...rs.map((r) => r.id))
    const [adm] = await db.insert(admissions).values({ patientId: P1, currentRoomId: rs[0].id, attendingProviderId: docA, admittedAt: at('08:00') }).returning({ id: admissions.id })
    ids.adm.push(adm.id)

    // Money on DAY: two receipts and one refund.
    await db.insert(patientPayments).values([
      { receiptNumber: `TWE-R1-${RUN}`, kind: 'receipt', patientId: P1, mode: 'cash', amountPaise: 150000, financialYear: '2099-00', receiptDate: DAY, receivedByName: 'TEST_WE' },
      { receiptNumber: `TWE-R2-${RUN}`, kind: 'advance', patientId: P2, mode: 'upi', reference: 'UPI-TEST', amountPaise: 500000, financialYear: '2099-00', receiptDate: DAY, receivedByName: 'TEST_WE' },
    ])
    await db.insert(refunds).values({ refundNumber: `TWE-F1-${RUN}`, patientId: P2, mode: 'cash', amountPaise: 20000, reason: 'test', financialYear: '2099-00', refundDate: DAY, issuedByName: 'TEST_WE' })
    // Billing queue: one draft invoice and one captured, uninvoiced line.
    await db.insert(invoices).values({ patientId: P1, status: 'draft', createdByName: 'TEST_WE' })
    await db.insert(chargeLines).values({
      patientId: P1, encounterId: enc[0].id, source: 'pharmacy', priceSource: 'pharmacy', itemCode: 'TWE', itemName: 'TEST_WE line',
      serviceDate: DAY, quantity: 2, unitPricePaise: 10000, taxablePaise: 20000, gstRateBp: 0, hsnSac: '3004', createdByName: 'TEST_WE',
    })

    // Labs: one per bench stage, two resulted on DAY (one critical, still unverified).
    const [t] = await db.insert(labTests).values({ name: `TEST_WE CBC ${RUN}`, code: `TWE${RUN}` }).returning({ id: labTests.id })
    testId = t.id
    const orders = await db.insert(labOrders).values([
      { patientId: P1, labTestId: testId, orderedByProviderId: docA, status: 'ordered' },
      { patientId: P1, labTestId: testId, orderedByProviderId: docA, status: 'collected', collectedAt: at('09:00') },
      { patientId: P1, labTestId: testId, orderedByProviderId: docA, status: 'received', collectedAt: at('09:00'), receivedAt: at('09:30') },
      { patientId: P1, labTestId: testId, orderedByProviderId: docA, status: 'resulted', collectedAt: at('09:00') },
      { patientId: P2, labTestId: testId, orderedByProviderId: docB, status: 'verified', collectedAt: at('10:00') },
    ]).returning({ id: labOrders.id })
    ids.orders.push(...orders.map((o) => o.id))
    await db.insert(labResults).values([
      { labOrderId: orders[3].id, value: '2.1', flag: 'critical', resultedByName: 'TEST_WE', resultedAt: at('10:00') }, // 60 min TAT
      { labOrderId: orders[4].id, value: '5.0', flag: 'normal', resultedByName: 'TEST_WE', resultedAt: at('13:00') }, // 180 min TAT
    ])

    // Pharmacy: one out-of-stock medication, one dispense on DAY (unbilled).
    const [m] = await db.insert(medications).values({ name: `TEST_WE Drug ${RUN}`, medicationClass: 'Test' }).returning({ id: medications.id })
    medId = m.id
    await db.insert(medicationInventory).values({ medicationId: medId, quantityOnHand: 0, reorderThreshold: 5 })
    const [d] = await db.insert(medicationDispenses).values({ patientId: P1, medicationId: medId, quantity: 1, dispensedByName: 'TEST_WE', dispensedAt: at('11:00') }).returning({ id: medicationDispenses.id })
    ids.disp.push(d.id)

    // Follow-ups prescribed by docA: one due on DAY, one long overdue.
    const fu = await db.insert(followUpOrders).values([
      { patientId: P1, source: 'manual', prescribedByProviderId: docA, baseDate: '2031-04-01', dueDate: DAY, windowStart: '2031-04-13', windowEnd: '2031-04-17', reason: 'TEST_WE due', createdByName: 'TEST_WE' },
      { patientId: P2, source: 'manual', prescribedByProviderId: docA, baseDate: '2031-03-01', dueDate: '2031-04-08', windowStart: '2031-04-07', windowEnd: '2031-04-10', reason: 'TEST_WE overdue', createdByName: 'TEST_WE' },
    ]).returning({ id: followUpOrders.id })
    ids.fu.push(...fu.map((r) => r.id))

    // Notes: docA's author name has one draft and one signed note.
    const notes = await db.insert(encounterNotes).values([
      { patientId: P1, authorName: `TEST_WE Dr A ${RUN}`, authorRole: 'pi', status: 'draft' },
      { patientId: P1, authorName: `TEST_WE Dr A ${RUN}`, authorRole: 'pi', status: 'signed', signedAt: at('12:00') },
    ]).returning({ id: encounterNotes.id })
    ids.notes.push(...notes.map((n) => n.id))
  })

  afterAll(async () => {
    const db = getDb()
    await purgeBillingFixtures([P1, P2])
    if (ids.notes.length) await db.delete(encounterNotes).where(inArray(encounterNotes.id, ids.notes))
    if (ids.fu.length) await db.delete(followUpOrders).where(inArray(followUpOrders.id, ids.fu))
    if (ids.disp.length) await db.delete(medicationDispenses).where(inArray(medicationDispenses.id, ids.disp))
    if (medId) { await db.delete(medicationInventory).where(inArray(medicationInventory.medicationId, [medId])); await db.delete(medications).where(inArray(medications.id, [medId])) }
    if (ids.orders.length) { await db.delete(labResults).where(inArray(labResults.labOrderId, ids.orders)); await db.delete(labOrders).where(inArray(labOrders.id, ids.orders)) }
    if (testId) await db.delete(labTests).where(inArray(labTests.id, [testId]))
    if (ids.adm.length) await db.delete(admissions).where(inArray(admissions.id, ids.adm))
    if (ids.enc.length) await db.delete(encounters).where(inArray(encounters.id, ids.enc))
    if (ids.rooms.length) await db.delete(rooms).where(inArray(rooms.id, ids.rooms))
    await db.delete(patients).where(inArray(patients.id, [P1, P2]))
    await db.delete(providers).where(inArray(providers.id, [docA, docB]))
  })

  it('OPD today counts the day\'s tokens by status (IPD stays are not tokens)', async () => {
    const opd = await loadOpdToday(DAY)
    expect(opd).toEqual({ date: DAY, tokens: 4, waiting: 1, inConsultation: 1, completed: 1, cancelled: 1 })
    expect(await loadOpdToday(DAY, docA)).toMatchObject({ tokens: 2, waiting: 1, inConsultation: 1, completed: 0 })
  })

  it('IPD census: admitted patients and bed occupancy by ward (blocked beds excluded from capacity)', async () => {
    const ipd = await loadIpdCensus()
    expect(ipd.admitted - base.ipd.admitted).toBe(1)
    expect(ipd.wards.find((w) => w.ward === WARD)).toEqual({ ward: WARD, beds: 4, occupied: 1, available: 1, dirty: 1, blocked: 1, occupancyPct: 33 })
    expect(ipd.beds - base.ipd.beds).toBe(4)
    expect(ipd.occupied - base.ipd.occupied).toBe(1)
  })

  it('collections today in paise: receipts and advances, less refunds', async () => {
    expect(await loadCollectionsToday(DAY)).toEqual({ date: DAY, receiptCount: 2, collectedPaise: 650000, refundedPaise: 20000, netPaise: 630000 })
  })

  it('billing queue: draft invoices and captured lines not yet on an invoice', async () => {
    const q = await loadBillingQueue()
    expect(q.draftInvoices - base.billing.draftInvoices).toBe(1)
    expect(q.uninvoicedLines - base.billing.uninvoicedLines).toBe(1)
    expect(q.uninvoicedPaise - base.billing.uninvoicedPaise).toBe(20000)
  })

  it('labs: one count per bench stage, results and criticals on the day, median collection-to-result TAT', async () => {
    const lab = await loadLabKpis(DAY)
    expect(lab.awaitingCollection - base.lab.awaitingCollection).toBe(1)
    expect(lab.inTransit - base.lab.inTransit).toBe(1)
    expect(lab.atBench - base.lab.atBench).toBe(1)
    expect(lab.toVerify - base.lab.toVerify).toBe(1)
    expect(lab.criticalUnverified - base.lab.criticalUnverified).toBe(1)
    expect(lab.resultedToday).toBe(2)
    expect(lab.criticalToday).toBe(1)
    expect(lab.medianTatMinutes).toBe(120)
  })

  it('pharmacy: out of stock, low stock, dispenses on the day and unbilled dispenses', async () => {
    const ph = await loadPharmacyKpis(DAY)
    expect(ph.outOfStock - base.pharmacy.outOfStock).toBe(1)
    expect(ph.lowStock - base.pharmacy.lowStock).toBe(0)
    expect(ph.dispensedToday).toBe(1)
    expect(ph.unbilledDispenses - base.pharmacy.unbilledDispenses).toBe(1)
  })

  it('follow-up buckets match the recall worklist, optionally for one prescriber', async () => {
    const mine = await loadFollowUpBuckets(DAY, docA)
    expect(mine).toMatchObject({ due: 1, overdue: 1 })
    expect(await loadFollowUpBuckets(DAY, docB)).toMatchObject({ due: 0, overdue: 0 })
  })

  it('doctor workload: own OPD today, inpatients, results to verify (critical first), follow-ups and unsigned notes -- no phone numbers', async () => {
    const w = await loadDoctorWorkload({ providerId: docA, authorName: `TEST_WE Dr A ${RUN}`, today: DAY })
    expect(w.encountersToday.map((e) => [e.opdToken, e.status])).toEqual([[1, 'checked_in'], [2, 'in_consultation']])
    expect(w.inpatients).toHaveLength(1)
    expect(w.inpatients[0]).toMatchObject({ patientId: P1, ward: WARD, bed: '1-A' })
    expect(w.resultsToVerify.map((r) => [r.patientId, r.flag])).toEqual([[P1, 'critical']])
    expect(w.labsAwaitingResult).toBe(3)
    expect(w.followUps.map((f) => [f.patientId, f.bucket])).toEqual([[P2, 'overdue'], [P1, 'due']])
    expect(w.unsignedNotes).toBe(1)
    expect(w.draftNotes.map((d) => [d.patientId, d.patientName])).toEqual([[P1, 'TEST_WE Kpi One']])
    expect(JSON.stringify(w)).not.toMatch(/98765000/)
    expect(await loadDoctorWorkload({ providerId: docB, authorName: 'nobody', today: DAY })).toMatchObject({ inpatients: [], resultsToVerify: [], unsignedNotes: 0, draftNotes: [] })
  })

  it('every loader returns a JSON-safe value (a cache hit equals a miss)', async () => {
    for (const v of [
      await loadOpdToday(DAY), await loadIpdCensus(), await loadCollectionsToday(DAY), await loadBillingQueue(),
      await loadLabKpis(DAY), await loadPharmacyKpis(DAY), await loadFollowUpBuckets(DAY),
      await loadDoctorWorkload({ providerId: docA, authorName: 'x', today: DAY }),
    ]) expect(v).toEqual(json(v))
  })
})
