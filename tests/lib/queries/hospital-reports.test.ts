import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import {
  admissions, chargeLines, departments, encounters, invoiceLines, invoices, labOrders, labTests, medicationDispenses,
  medicationInventory, medications, patientPayments, patients, providers, refunds, rooms, serviceCatalog, tariffRates,
} from '@/db/schema'
import {
  bedOccupancy, collectionsByMode, departmentRevenue, dischargeRegister, ipdStatistics, labTurnaround, opdStatistics,
  pharmacyStockAndDispensing, tariffPriceList,
} from '@/lib/queries/hospital-reports'
import type { ReportResult } from '@/lib/reports/table'
import { TEST_FINANCIAL_YEAR, purgeBillingFixtures } from '../../db/billing-fixtures'

// Wave I (P1-23): the hospital report queries against fixtures dated in 2099
// (no real data lives there), all named TEST_WI so cleanup is exact.
const RUN = String(Date.now()).slice(-6)
const PROBE = `TEST_WI ${RUN}`
const DEPT_NAME = `TEST_WI Dept ${RUN}`
const PATIENT = `RD-TWI${RUN}`
const WARD = `TEST_WI Ward ${RUN}`
const MARCH = { from: '2099-03-01', to: '2099-03-31' }

let deptId: number
let providerId: number
let serviceId: number
let labTestId: number
let medicationId: number
const encounterIds: number[] = []
const admissionIds: number[] = []
const roomIds: number[] = []

const section = (res: ReportResult, title: string) => {
  const s = res.sections.find((x) => x.title === title)
  if (!s) throw new Error(`no section ${title}`)
  return s
}
const rowFor = (res: ReportResult, title: string, first: string) => section(res, title).rows.find((r) => r[0] === first)

beforeAll(async () => {
  const db = getDb()
  const [d] = await db.insert(departments).values({ code: `TWI${RUN}`, name: DEPT_NAME, kind: 'clinical' }).returning()
  deptId = d.id
  const [p] = await db.insert(providers).values({ name: `${PROBE} Dr Report`, specialty: 'Test', colorTag: '#000000', departmentId: d.id }).returning()
  providerId = p.id
  await db.insert(patients).values({
    id: PATIENT, name: `${PROBE} Patient`, dob: '1980-05-05', gender: 'female', uhid: `TWI${RUN}`,
    phone: '+919800000099', email: `test-wi-${RUN}@example.invalid`, addressLine1: 'TEST 1 Example Road', pinCode: '560001',
  })

  // OPD: 2099-03-01 new (completed), follow-up (checked in), emergency, cancelled; 2099-03-02 review (completed), dept from the provider.
  const enc = (date: string, visitType: 'new' | 'follow_up' | 'review' | 'emergency', status: 'checked_in' | 'completed' | 'cancelled', withDept = true) => ({
    patientId: PATIENT, encounterType: 'opd' as const, visitType, status, encounterDate: date,
    providerId, departmentId: withDept ? deptId : null, checkedInByName: PROBE,
  })
  const es = await db.insert(encounters).values([
    enc('2099-03-01', 'new', 'completed'), enc('2099-03-01', 'follow_up', 'checked_in'), enc('2099-03-01', 'emergency', 'completed'),
    enc('2099-03-01', 'new', 'cancelled'), enc('2099-03-02', 'review', 'completed', false),
  ]).returning({ id: encounters.id })
  encounterIds.push(...es.map((e) => e.id))

  // Beds and admissions: a 2-bed test ward; admission A 2099-03-01 10:00 IST -> 2099-03-04 10:00 IST (3 days), B admitted 2099-03-03, still in.
  const rs = await db.insert(rooms).values([
    { ward: WARD, roomNumber: '1', bedNumber: 'A', status: 'occupied' },
    { ward: WARD, roomNumber: '1', bedNumber: 'B', status: 'blocked', blockedReason: 'TEST_WI' },
  ]).returning({ id: rooms.id })
  roomIds.push(...rs.map((r) => r.id))
  const as = await db.insert(admissions).values([
    { patientId: PATIENT, attendingProviderId: providerId, admissionType: 'emergency', status: 'discharged', admittedAt: new Date('2099-03-01T04:30:00Z'), dischargedAt: new Date('2099-03-04T04:30:00Z'), currentRoomId: null },
    { patientId: PATIENT, attendingProviderId: providerId, admissionType: 'elective', status: 'admitted', admittedAt: new Date('2099-03-03T04:30:00Z'), currentRoomId: rs[0].id },
  ]).returning({ id: admissions.id })
  admissionIds.push(...as.map((a) => a.id))

  // Billing: one finalised self-pay invoice dated 2099-03-02 with one line, ₹1,000 + 18% GST.
  const [svc] = await db.insert(serviceCatalog).values({ code: `TWIS${RUN}`, name: `${PROBE} Service`, departmentId: deptId, category: 'procedure', hsnSac: '999312', gstRateBp: 1800 }).returning()
  serviceId = svc.id
  await db.insert(tariffRates).values([
    { serviceId, scope: 'base', amountPaise: 100000, validFrom: '2099-01-01', validTo: '2099-02-28', createdByName: PROBE },
    { serviceId, scope: 'base', amountPaise: 120000, validFrom: '2099-03-01', createdByName: PROBE },
  ])
  const [inv] = await db.insert(invoices).values({
    invoiceNumber: `TWI-${RUN}`, status: 'finalised', patientId: PATIENT, encounterId: es[0].id, financialYear: TEST_FINANCIAL_YEAR,
    invoiceDate: '2099-03-02', snapshot: {} as never, taxablePaise: 100000, cgstPaise: 9000, sgstPaise: 9000, igstPaise: 0, totalPaise: 118000, createdByName: PROBE,
  }).returning()
  const [cl] = await db.insert(chargeLines).values({
    patientId: PATIENT, encounterId: es[0].id, source: 'manual', status: 'invoiced', serviceId, itemCode: svc.code, itemName: svc.name,
    serviceCategory: 'procedure', departmentId: deptId, serviceDate: '2099-03-01', quantity: 1, unitPricePaise: 100000, priceSource: 'base',
    taxablePaise: 100000, gstRateBp: 1800, hsnSac: '999312', createdByName: PROBE, invoiceId: inv.id,
  }).returning()
  await db.insert(invoiceLines).values({
    invoiceId: inv.id, chargeLineId: cl.id, lineNo: 1, itemCode: svc.code, itemName: svc.name, hsnSac: '999312', serviceDate: '2099-03-01',
    quantity: 1, unitPricePaise: 100000, priceSource: 'base', taxablePaise: 100000, gstRateBp: 1800, cgstRateBp: 900, sgstRateBp: 900, igstRateBp: 0,
    cgstPaise: 9000, sgstPaise: 9000, igstPaise: 0, totalPaise: 118000,
  })
  // Payments: cash advance ₹5,000 and UPI receipt ₹1,180 on 2099-03-02; a ₹500 cash refund on 2099-03-03.
  const [adv] = await db.insert(patientPayments).values([
    { receiptNumber: `TWI-R1-${RUN}`, kind: 'advance', patientId: PATIENT, mode: 'cash', amountPaise: 500000, financialYear: TEST_FINANCIAL_YEAR, receiptDate: '2099-03-02', receivedByName: `${PROBE} Cashier` },
    { receiptNumber: `TWI-R2-${RUN}`, kind: 'receipt', patientId: PATIENT, mode: 'upi', reference: 'UPI-TEST', amountPaise: 118000, financialYear: TEST_FINANCIAL_YEAR, receiptDate: '2099-03-02', receivedByName: `${PROBE} Cashier` },
  ]).returning()
  await db.insert(refunds).values({ refundNumber: `TWI-F1-${RUN}`, patientId: PATIENT, againstPaymentId: adv.id, mode: 'cash', amountPaise: 50000, reason: 'TEST_WI', financialYear: TEST_FINANCIAL_YEAR, refundDate: '2099-03-03', issuedByName: PROBE })

  // Lab: two orders on 2099-03-05 for the test; one reported after 4 h (collected at 1 h, received 2 h, verified 3 h), one pending; one cancelled.
  const [lt] = await db.insert(labTests).values({ name: `${PROBE} Test`, code: `TWI-${RUN}` }).returning()
  labTestId = lt.id
  const t0 = Date.parse('2099-03-05T04:30:00Z')
  const h = (x: number) => new Date(t0 + x * 3600_000)
  await db.insert(labOrders).values([
    { patientId: PATIENT, labTestId, orderedByProviderId: providerId, status: 'reported', orderedAt: h(0), collectedAt: h(1), receivedAt: h(2), verifiedAt: h(3), reportedAt: h(4) },
    { patientId: PATIENT, labTestId, orderedByProviderId: providerId, status: 'ordered', orderedAt: h(0) },
    { patientId: PATIENT, labTestId, orderedByProviderId: providerId, status: 'cancelled', orderedAt: h(0), cancelledAt: h(1), cancelReason: 'TEST_WI' },
  ])

  // Pharmacy: a medication at its reorder level; two dispenses on 2099-03-06 (IST).
  const [m] = await db.insert(medications).values({ name: `${PROBE} Med`, medicationClass: 'test' }).returning()
  medicationId = m.id
  await db.insert(medicationInventory).values({ medicationId, quantityOnHand: 5, reorderThreshold: 5, unit: 'tablets' })
  await db.insert(medicationDispenses).values([
    { patientId: PATIENT, medicationId, quantity: 10, dispensedByName: PROBE, dispensedAt: new Date('2099-03-06T03:00:00Z') },
    { patientId: PATIENT, medicationId, quantity: 4, dispensedByName: PROBE, dispensedAt: new Date('2099-03-06T18:00:00Z') }, // 2099-03-06 23:30 IST
  ])
})

afterAll(async () => {
  const db = getDb()
  await purgeBillingFixtures([PATIENT])
  await db.delete(medicationDispenses).where(eq(medicationDispenses.patientId, PATIENT))
  if (medicationId) {
    await db.delete(medicationInventory).where(eq(medicationInventory.medicationId, medicationId))
    await db.delete(medications).where(eq(medications.id, medicationId))
  }
  await db.delete(labOrders).where(eq(labOrders.patientId, PATIENT))
  if (labTestId) await db.delete(labTests).where(eq(labTests.id, labTestId))
  if (serviceId) {
    await db.delete(tariffRates).where(eq(tariffRates.serviceId, serviceId))
    await db.delete(serviceCatalog).where(eq(serviceCatalog.id, serviceId))
  }
  if (admissionIds.length) await db.delete(admissions).where(inArray(admissions.id, admissionIds))
  if (roomIds.length) await db.delete(rooms).where(inArray(rooms.id, roomIds))
  if (encounterIds.length) await db.delete(encounters).where(inArray(encounters.id, encounterIds))
  await db.delete(patients).where(eq(patients.id, PATIENT))
  if (providerId) await db.delete(providers).where(eq(providers.id, providerId))
  if (deptId) await db.delete(departments).where(eq(departments.id, deptId))
})

describe('opdStatistics', () => {
  it('counts OPD visits by department (encounter dept, else the doctor\'s), with cancellations apart', async () => {
    const res = await opdStatistics(MARCH)
    expect(rowFor(res, 'By department', DEPT_NAME)).toEqual([DEPT_NAME, 4, 1, 2, 1, 3, 1])
    expect(rowFor(res, 'By doctor', `${PROBE} Dr Report`)).toEqual([`${PROBE} Dr Report`, DEPT_NAME, 4, 1, 2, 1, 3, 1])
    expect(section(res, 'By day').rows.filter((r) => String(r[0]).startsWith('2099-03'))).toEqual([['2099-03-01', 3, 1, 1, 1, 2, 1], ['2099-03-02', 1, 0, 1, 0, 1, 0]])
  })

  it('leaves out visits outside the range', async () => {
    const res = await opdStatistics({ from: '2099-03-02', to: '2099-03-02' })
    expect(rowFor(res, 'By department', DEPT_NAME)).toEqual([DEPT_NAME, 1, 0, 1, 0, 1, 0])
  })
})

describe('ipdStatistics', () => {
  it('counts admissions, discharges and the average length of stay by the doctor\'s department', async () => {
    const res = await ipdStatistics(MARCH)
    expect(rowFor(res, 'By department', DEPT_NAME)).toEqual([DEPT_NAME, 2, 1, 3])
  })

  it('reports the daily census at IST midnight', async () => {
    const res = await ipdStatistics({ from: '2099-03-01', to: '2099-03-05' })
    const census = section(res, 'Daily census').rows
    // Other (real) open admissions add the same constant to every 2099 day; compare differences.
    const base = Number(census[0][3]) - 1
    expect(census.map((r) => [r[0], r[1], r[2], Number(r[3]) - base])).toEqual([
      ['2099-03-01', 1, 0, 1], ['2099-03-02', 0, 0, 1], ['2099-03-03', 1, 0, 2], ['2099-03-04', 0, 1, 1], ['2099-03-05', 0, 0, 1],
    ])
  })
})

describe('bedOccupancy', () => {
  it('lists beds by ward now, occupancy against beds in service', async () => {
    const res = await bedOccupancy(MARCH)
    expect(rowFor(res, 'Beds by ward (now)', WARD)).toEqual([WARD, 2, 1, 0, 0, 1, 100])
  })

  it('counts each admission\'s days inside the period, up to now', async () => {
    const res = await bedOccupancy({ from: '2099-03-02', to: '2099-03-03' })
    // Admission A is in all of both days (2.0). B (admitted 2099-03-03) has not happened yet, so
    // nothing of it is counted; no real admission reaches 2099 either.
    expect(section(res, 'Occupancy over the period').rows[0].slice(0, 1)).toEqual([2])
    expect(section(res, 'Occupancy over the period').rows[0][3]).toBe(2)
  })
})

describe('dischargeRegister', () => {
  it('lists discharges with IST times, length of stay and no phone number', async () => {
    const res = await dischargeRegister(MARCH)
    const row = section(res, 'Discharges').rows.find((r) => r[2] === `${PROBE} Patient`)
    expect(row).toEqual(['2099-03-04 10:00', `TWI${RUN}`, `${PROBE} Patient`, 'female', '2099-03-01 10:00', 3, 'emergency', `${PROBE} Dr Report`, DEPT_NAME, null])
    expect(JSON.stringify(res)).not.toContain('9800000099')
  })
})

describe('departmentRevenue', () => {
  it('sums finalised invoice lines by department and category', async () => {
    const res = await departmentRevenue(MARCH)
    expect(rowFor(res, 'By department', DEPT_NAME)).toEqual([DEPT_NAME, 1, 100000, 18000, 118000, 118000, 0])
    expect(rowFor(res, 'By service category', 'procedure')?.slice(1)).toEqual([1, 100000, 18000, 118000, 118000, 0])
  })

  it('leaves out invoices dated outside the range', async () => {
    const res = await departmentRevenue({ from: '2099-03-03', to: '2099-03-31' })
    expect(rowFor(res, 'By department', DEPT_NAME)).toBeUndefined()
  })
})

describe('collectionsByMode', () => {
  it('splits advances, receipts and refunds by mode, day and cashier', async () => {
    const res = await collectionsByMode(MARCH)
    expect(section(res, 'By payment mode').rows).toEqual([
      ['Cash', 1, 500000, 0, 500000, 1, 50000, 450000],
      ['UPI', 1, 0, 118000, 118000, 0, 0, 118000],
    ])
    expect(section(res, 'By payment mode').totals).toEqual(['Total', 2, 500000, 118000, 618000, 1, 50000, 568000])
    expect(section(res, 'By day').rows).toEqual([['2099-03-02', 618000, 0, 618000], ['2099-03-03', 0, 50000, -50000]])
    expect(section(res, 'By cashier').rows).toEqual([[`${PROBE} Cashier`, 'Cash', 1, 500000], [`${PROBE} Cashier`, 'UPI', 1, 118000]])
    expect(JSON.stringify(res)).not.toContain('UPI-TEST')
  })
})

describe('tariffPriceList', () => {
  it('shows the rate in force on the date', async () => {
    const feb = await tariffPriceList({ from: '2099-02-15', to: '2099-02-15' })
    const mar = await tariffPriceList({ from: '2099-03-15', to: '2099-03-15' })
    const find = (r: ReportResult) => section(r, 'Price list').rows.filter((x) => x[0] === `TWIS${RUN}`)
    expect(find(feb)).toEqual([[`TWIS${RUN}`, `${PROBE} Service`, DEPT_NAME, 'procedure', '999312', 18, 'Base', null, null, null, 100000]])
    expect(find(mar).map((x) => x[10])).toEqual([120000])
  })

  it('shows a service with no rate in force as one "No rate" row', async () => {
    const res = await tariffPriceList({ from: '2098-12-31', to: '2098-12-31' })
    expect(section(res, 'Price list').rows.filter((x) => x[0] === `TWIS${RUN}`).map((x) => [x[6], x[10]])).toEqual([['No rate', null]])
  })
})

describe('labTurnaround', () => {
  it('reports per-test turnaround in hours, without cancelled orders', async () => {
    const res = await labTurnaround(MARCH)
    expect(rowFor(res, 'By test', `${PROBE} Test`)).toEqual([`${PROBE} Test`, 'lab', 2, 1, 1, 1, 1, 4, 4, 4])
  })
})

describe('pharmacyStockAndDispensing', () => {
  it('flags stock at its reorder level and totals dispensing by IST day', async () => {
    const res = await pharmacyStockAndDispensing(MARCH)
    expect(rowFor(res, 'Stock', `${PROBE} Med`)).toEqual([`${PROBE} Med`, null, 'tablet', 5, 'tablets', 5, 'Reorder', 14])
    expect(rowFor(res, 'Dispensing by medication', `${PROBE} Med`)).toEqual([`${PROBE} Med`, 2, 14, 1, 0])
    expect(section(res, 'Dispensing by day').rows.filter((r) => String(r[0]).startsWith('2099'))).toEqual([['2099-03-06', 2, 14]])
  })
})
