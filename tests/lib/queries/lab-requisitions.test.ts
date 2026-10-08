import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import {
  auditLog, departments, encounters, labOrders, labRequisitions, labServiceAreaPins, labTests, patients, payers, providers, serviceCatalog, tariffRates,
} from '@/db/schema'
import type { Session } from '@/lib/auth'
import { createLabRequisition, getRequisitionWithOrders, type CreateLabRequisitionInput } from '@/lib/queries/lab-requisitions'

const RUN = `${Date.now()}`
const PROBE = `TEST_SP5_REQ-${RUN}`
const S: Session = { role: 'pi', name: PROBE, userId: null }
const P = `TEST-SP5-${RUN}-RA` // PIN 990011, no payer
const P_PAYER = `TEST-SP5-${RUN}-RB` // PIN 990012, primary payer
const P_OTHER = `TEST-SP5-${RUN}-RC`
const PIN = '990011'
const NOW = new Date('2099-05-01T05:00:00Z')

let deptId = 0
let providerId = 0
let serviceId = 0
let payerId = 0
let pinId = 0
let t1 = 0
let t2 = 0
let tImg = 0 // SP5 Task 8: an imaging test
let encounterId = 0
const rateIds: number[] = []
const requisitionIds: number[] = []

const input = (over: Partial<CreateLabRequisitionInput> = {}): CreateLabRequisitionInput => ({
  patientId: P, orderedByProviderId: providerId, labTestIds: [t1, t2], followUp: null, originatingEncounterId: null, ...over,
})

async function create(over: Partial<CreateLabRequisitionInput> = {}, now = NOW) {
  const r = await createLabRequisition(input(over), S, now)
  if (r.ok) requisitionIds.push(r.requisition.id)
  return r
}

describe.skipIf(!process.env.DATABASE_URL)('lab requisitions (DB)', () => {
  beforeAll(async () => {
    const db = getDb()
    await db.delete(labServiceAreaPins).where(eq(labServiceAreaPins.pinCode, PIN))
    const [d] = await db.insert(departments).values({ code: `TSP5R${RUN.slice(-8)}`, name: 'TEST_SP5 req dept', kind: 'diagnostic' }).returning()
    deptId = d.id
    const [pay] = await db.insert(payers).values({ name: `TEST_SP5 payer ${RUN}`, payerId: `TSP5-${RUN}` }).returning()
    payerId = pay.id
    await db.insert(patients).values([
      { id: P, name: 'TEST_SP5 Requisition', dob: '1980-01-01', pinCode: PIN },
      { id: P_PAYER, name: 'TEST_SP5 Requisition payer', dob: '1980-01-01', pinCode: '990012', primaryPayerId: payerId },
      { id: P_OTHER, name: 'TEST_SP5 Requisition other', dob: '1980-01-01' },
    ])
    const [pr] = await db.insert(providers).values({ name: `TEST_SP5 Dr R ${RUN}`, specialty: 'Medicine', colorTag: '#000000', departmentId: d.id }).returning()
    providerId = pr.id
    const [svc] = await db.insert(serviceCatalog).values({ code: `TR${RUN.slice(-8)}`, name: 'TEST_SP5 CBC', departmentId: d.id, category: 'investigation_lab', hsnSac: '999316' }).returning()
    serviceId = svc.id
    const rates = await db.insert(tariffRates).values([
      { serviceId, scope: 'base', amountPaise: 45000, validFrom: '2099-01-01', createdByName: PROBE },
      { serviceId, scope: 'payer', payerId, amountPaise: 38000, validFrom: '2099-01-01', createdByName: PROBE },
    ]).returning()
    rateIds.push(...rates.map((r) => r.id))
    const [a, b] = await db.insert(labTests).values([
      { name: `TEST_SP5 mapped ${RUN}`, code: `TEST-SP5-RM-${RUN}`, serviceId },
      { name: `TEST_SP5 unmapped ${RUN}`, code: `TEST-SP5-RU-${RUN}` },
    ]).returning()
    t1 = a.id
    t2 = b.id
    const [img] = await db.insert(labTests).values({ name: `TEST_SP5 imaging ${RUN}`, code: `TEST-SP5-RI-${RUN}`, category: 'imaging' }).returning()
    tImg = img.id
    const [pin] = await db.insert(labServiceAreaPins).values({ pinCode: PIN, createdByName: PROBE }).returning()
    pinId = pin.id
    const [enc] = await db.insert(encounters).values({
      patientId: P_OTHER, encounterType: 'opd', encounterDate: '2099-05-01', providerId, checkedInByName: PROBE, status: 'completed',
    }).returning()
    encounterId = enc.id
  })

  afterAll(async () => {
    const db = getDb()
    await db.delete(labOrders).where(inArray(labOrders.patientId, [P, P_PAYER, P_OTHER]))
    await db.delete(labRequisitions).where(inArray(labRequisitions.patientId, [P, P_PAYER, P_OTHER]))
    await db.delete(encounters).where(eq(encounters.id, encounterId))
    await db.delete(labServiceAreaPins).where(eq(labServiceAreaPins.id, pinId))
    await db.delete(labTests).where(inArray(labTests.id, [t1, t2, tImg]))
    await db.delete(tariffRates).where(inArray(tariffRates.id, rateIds))
    await db.delete(serviceCatalog).where(eq(serviceCatalog.id, serviceId))
    await db.delete(providers).where(eq(providers.id, providerId))
    await db.delete(patients).where(inArray(patients.id, [P, P_PAYER, P_OTHER]))
    await db.delete(payers).where(eq(payers.id, payerId))
    await db.delete(departments).where(eq(departments.id, deptId))
    await db.delete(auditLog).where(eq(auditLog.userName, PROBE))
  })

  it('creates one requisition with one priced order per test', async () => {
    const r = await create()
    expect(r.ok && r.lines.map((l) => [l.quotedPricePaise, l.quoteStatus])).toEqual([[45000, 'quoted'], [null, 'unmapped']])
    if (!r.ok) return
    expect(r.requisition).toMatchObject({ patientId: P, orderedByProviderId: providerId, followUpRequested: false, followUpIntervalValue: null, createdByName: PROBE })
    expect(r.lines.map((l) => l.labTestId)).toEqual([t1, t2])
    const full = await getRequisitionWithOrders(r.requisition.id)
    expect(full?.orders.map((o) => [o.id, o.status, o.requisitionId, o.quotedPricePaise, o.quotedTariffRateId, o.quotedOn, o.quoteStatus])).toEqual([
      [r.lines[0].orderId, 'ordered', r.requisition.id, 45000, rateIds[0], '2099-05-01', 'quoted'],
      [r.lines[1].orderId, 'ordered', r.requisition.id, null, null, '2099-05-01', 'unmapped'],
    ])
    const audits = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, PROBE), eq(auditLog.action, 'created lab order'), eq(auditLog.patientId, P)))
    expect(audits.map((a) => a.details)).toEqual(expect.arrayContaining([
      `order=${r.lines[0].orderId} requisition=${r.requisition.id} quote=quoted`,
      `order=${r.lines[1].orderId} requisition=${r.requisition.id} quote=unmapped`,
    ]))
    expect(await getRequisitionWithOrders(2_000_000_000)).toBeNull()
  })

  it('quotes on the IST order date', async () => {
    // 2098-12-31 23:00 IST is before the rate starts: no rate.
    const r = await create({ labTestIds: [t1] }, new Date('2098-12-31T17:30:00Z'))
    expect(r.ok && r.lines.map((l) => [l.quotedPricePaise, l.quoteStatus])).toEqual([[null, 'no_rate']])
    // 00:10 IST on 1 Jan 2099 (still 31 Dec in UTC) is on the rate's first day.
    const r2 = await create({ labTestIds: [t1] }, new Date('2098-12-31T18:40:00Z'))
    expect(r2.ok && r2.lines[0].quotedPricePaise).toBe(45000)
  })

  it('stores the follow-up request on the requisition', async () => {
    const r = await create({ labTestIds: [t2], followUp: { interval: { value: 2, unit: 'weeks' }, reason: 'Review the reports' } })
    expect(r.ok && r.requisition).toMatchObject({ followUpRequested: true, followUpIntervalValue: 2, followUpIntervalUnit: 'weeks', followUpReason: 'Review the reports' })
  })

  it('a payer-scoped rate wins for a patient with that primary payer', async () => {
    const r = await create({ patientId: P_PAYER, labTestIds: [t1] })
    expect(r.ok && r.lines.map((l) => [l.quotedPricePaise, l.quoteStatus])).toEqual([[38000, 'quoted']])
    expect(r.ok && (await getRequisitionWithOrders(r.requisition.id))?.orders[0].quotedTariffRateId).toBe(rateIds[1])
  })

  it('an inactive tariff service is ordered unpriced', async () => {
    await getDb().update(serviceCatalog).set({ isActive: false }).where(eq(serviceCatalog.id, serviceId))
    try {
      const r = await create({ labTestIds: [t1] })
      expect(r.ok && r.lines.map((l) => [l.quotedPricePaise, l.quoteStatus])).toEqual([[null, 'service_inactive']])
    } finally {
      await getDb().update(serviceCatalog).set({ isActive: true }).where(eq(serviceCatalog.id, serviceId))
    }
  })

  it('patientIsLocal follows the active service-area PINs', async () => {
    const r = await create({ labTestIds: [t2] })
    expect(r.ok && r.patientIsLocal).toBe(true)
    await getDb().update(labServiceAreaPins).set({ isActive: false }).where(eq(labServiceAreaPins.id, pinId))
    try {
      const r2 = await create({ labTestIds: [t2] })
      expect(r2.ok && r2.patientIsLocal).toBe(false)
    } finally {
      await getDb().update(labServiceAreaPins).set({ isActive: true }).where(eq(labServiceAreaPins.id, pinId))
    }
    const r3 = await create({ patientId: P_OTHER, labTestIds: [t2] }) // no PIN on file
    expect(r3.ok && r3.patientIsLocal).toBe(false)
  })

  // SP5 Task 8 ruling: the home-collection notice needs at least one lab (not imaging) test.
  it('includesLabTest is false only for an imaging-only requisition', async () => {
    const img = await create({ labTestIds: [tImg] })
    expect(img.ok && [img.patientIsLocal, img.includesLabTest]).toEqual([true, false])
    const mixed = await create({ labTestIds: [tImg, t2] })
    expect(mixed.ok && mixed.includesLabTest).toBe(true)
  })

  it('rejects an encounter of another patient and writes nothing', async () => {
    const before = await getDb().select({ id: labOrders.id }).from(labOrders).where(eq(labOrders.patientId, P))
    expect(await create({ originatingEncounterId: encounterId })).toEqual({ ok: false, error: 'encounter_mismatch' })
    expect(await create({ originatingEncounterId: 2_000_000_000 })).toEqual({ ok: false, error: 'encounter_not_found' })
    const after = await getDb().select({ id: labOrders.id }).from(labOrders).where(eq(labOrders.patientId, P))
    expect(after).toHaveLength(before.length)
    const ok = await create({ patientId: P_OTHER, labTestIds: [t2], originatingEncounterId: encounterId })
    expect(ok.ok && ok.requisition.originatingEncounterId).toBe(encounterId)
  })

  it('rejects an unknown patient or test and writes nothing', async () => {
    expect(await create({ patientId: 'TEST-SP5-NOPE' })).toEqual({ ok: false, error: 'patient_not_found' })
    const before = await getDb().select({ id: labRequisitions.id }).from(labRequisitions).where(eq(labRequisitions.patientId, P))
    expect(await create({ labTestIds: [t1, 2_000_000_000] })).toEqual({ ok: false, error: 'test_not_found' })
    const after = await getDb().select({ id: labRequisitions.id }).from(labRequisitions).where(eq(labRequisitions.patientId, P))
    expect(after).toHaveLength(before.length)
  })
})
