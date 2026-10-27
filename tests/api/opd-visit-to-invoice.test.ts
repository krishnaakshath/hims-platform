// WS1/WS2 T14 acceptance: one OPD visit, end to end through the real routes, becomes one invoice.
// Front desk checks the patient in (registration + consultation captured), the doctor starts the
// visit, records vitals, adds a coded diagnosis, prescribes 1-0-1 x 5 days and orders a test (billed
// at order), completes; the pharmacist dispenses the prefilled quantity (billed in the dispense);
// billing drafts the ready lines (one invoice, four lines), finalises it, and the cash desk takes the
// outstanding: the patient's balance is zero.
//
// Against the worktree's isolated test DB. Every fixture (department, consultation and registration
// rates, a mapped priced lab test, a priced medicine with stock, an ICD-10 version) is created here;
// no demo seed row is used. The clock (Date only) is pinned to 2099 so every business date and the
// finalised documents fall in the test-only 2099-00 year, which purgeBillingFixtures removes.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { and, asc, eq, inArray, or } from 'drizzle-orm'
import { getDb } from '@/db/client'
import {
  auditLog, billingSettings, chargeLines, codeSystems, codes, departments, diagnoses, encounterCoding, doctorAssignments, encounterVitals, encounters,
  invoiceLines, invoices, labOrders, labRequisitions, labTests, medicationDispenses, medicationEpisodes, medicationInventory, medications,
  patients, prescriptions, providers, serviceCatalog, tariffRates,
} from '@/db/schema'
import type { Role } from '@/lib/auth'
import { gstinWithCheck } from '@/db/seed-india-data'
import { purgeBillingFixtures } from '../db/billing-fixtures'

const RUN = `${Date.now()}`.slice(-7)
const CODE = `TW14${RUN}`
const PROBE = `TEST-WS14-${RUN}`
let session: { role: Role; name: string } = { role: 'frontdesk', name: `${PROBE} desk` }
let doctorProvider: { id: number; name: string } | null = null

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ ...session, userId: null })) }
})
vi.mock('@/lib/doctor-queue-provider', () => ({ resolveDoctorQueueProvider: vi.fn(async () => doctorProvider) }))
vi.mock('@/lib/queries/notifications', () => ({ notifyPatientSafely: vi.fn(async () => 'logged') }))

import { POST as checkInRoute } from '@/app/api/front-desk/check-in/route'
import { POST as startRoute } from '@/app/api/encounters/[id]/start/route'
import { POST as vitalsRoute } from '@/app/api/encounters/[id]/vitals/route'
import { POST as diagnosisRoute } from '@/app/api/encounters/[id]/diagnoses/route'
import { POST as prescriptionRoute } from '@/app/api/encounters/[id]/prescriptions/route'
import { POST as labOrderRoute } from '@/app/api/patients/[anonId]/lab-orders/route'
import { POST as completeRoute } from '@/app/api/encounters/[id]/complete/route'
import { POST as dispenseRoute } from '@/app/api/pharmacy/dispense/route'
import { POST as invoiceReadyRoute } from '@/app/api/billing/invoice-ready/route'
import { POST as finaliseRoute } from '@/app/api/billing/invoices/[id]/finalise/route'
import { POST as paymentRoute } from '@/app/api/billing/payments/route'
import { getPatientLedger } from '@/lib/queries/patient-ledger'

const NOW = new Date('2099-06-01T05:00:00Z') // 10:30 IST, financial year 2099-00
const DAY = '2099-06-01'
const PATIENT = `TWS14-${RUN}`
const MRP_PAISE = 350

const fx = { dep: 0, prov: 0, consult: 0, reg: 0, lab: 0, test: 0, med: 0, codeSystem: 0, codeId: 0, rateIds: [] as number[] }
let savedSettings: typeof billingSettings.$inferSelect | undefined
let savedCurrentIcd: number[] = []

const json = (url: string, body: unknown) => new NextRequest(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
const idParams = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) })
const as = (role: Role, name: string) => { session = { role, name: `${PROBE} ${name}` } }

describe.skipIf(!process.env.DATABASE_URL)('OPD visit to one invoice (acceptance, DB)', () => {
  beforeAll(async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    const db = getDb()
    ;[savedSettings] = await db.select().from(billingSettings).where(eq(billingSettings.id, 1))

    // A department with a consultation rate, its doctor, and a registration fee.
    const [dep] = await db.insert(departments).values({ code: `${CODE}D`, name: `Test WS14 Medicine ${RUN}` }).returning()
    fx.dep = dep.id
    const [prov] = await db.insert(providers).values({ name: `${PROBE} Dr Rao`, specialty: 'General Medicine', colorTag: '#000000', departmentId: dep.id }).returning()
    fx.prov = prov.id
    doctorProvider = { id: prov.id, name: prov.name }
    const svc = async (suffix: string, category: 'consultation' | 'other' | 'investigation_lab', name: string) =>
      (await db.insert(serviceCatalog).values({ code: `${CODE}${suffix}`, name, departmentId: dep.id, category, hsnSac: '999312', gstRateBp: 0 }).returning())[0].id
    fx.consult = await svc('C', 'consultation', 'Consultation - General Medicine')
    fx.reg = await svc('R', 'other', 'Registration fee')
    fx.lab = await svc('L', 'investigation_lab', 'Complete blood count')
    const rates = await db.insert(tariffRates).values([
      { serviceId: fx.consult, scope: 'base', amountPaise: 60000, validFrom: '2020-01-01', createdByName: PROBE },
      { serviceId: fx.reg, scope: 'base', amountPaise: 10000, validFrom: '2020-01-01', createdByName: PROBE },
      { serviceId: fx.lab, scope: 'base', amountPaise: 45000, validFrom: '2020-01-01', createdByName: PROBE },
    ]).returning()
    fx.rateIds = rates.map((r) => r.id)
    await db.update(billingSettings).set({
      // The medicine line is taxable, so finalising needs the hospital's GSTIN (a synthetic Karnataka one).
      registrationServiceId: fx.reg, freeReviewDays: 0, legalName: 'Test WS14 Hospital', stateCode: 'IN-KA', gstin: gstinWithCheck('29ZZZTW1414Z1Z'), placeOfSupplyMode: 'location_of_service',
    }).where(eq(billingSettings.id, 1))

    // A lab test mapped to the priced service; a priced medicine with stock.
    fx.test = (await db.insert(labTests).values({ name: `Test WS14 CBC ${RUN}`, code: `${CODE}-CBC`, serviceId: fx.lab }).returning())[0].id
    const [med] = await db.insert(medications).values({
      name: `Test WS14 Paracetamol 650 ${RUN}`, genericName: 'Paracetamol', medicationClass: 'Analgesic', form: 'tablet', mrpPerUnitPaise: MRP_PAISE, gstRateBp: 1200, hsn: '30049099',
    }).returning()
    fx.med = med.id
    await db.insert(medicationInventory).values({ medicationId: med.id, quantityOnHand: 100, unit: 'tablets' })

    // The current WHO ICD-10 version (the real one, if any, is set aside and restored).
    savedCurrentIcd = (await db.select({ id: codeSystems.id }).from(codeSystems).where(and(eq(codeSystems.kind, 'icd10'), eq(codeSystems.isCurrent, true)))).map((c) => c.id)
    if (savedCurrentIcd.length) await db.update(codeSystems).set({ isCurrent: false }).where(inArray(codeSystems.id, savedCurrentIcd))
    const [cs] = await db.insert(codeSystems).values({
      kind: 'icd10', version: `TEST-WS14-${RUN}`, name: 'T', isSample: false, isCurrent: true, licenceNote: 'test',
      sourceFileName: 't.csv', sourceSha256: 'x', codeCount: 1, importedByName: PROBE,
    }).returning()
    fx.codeSystem = cs.id
    fx.codeId = (await db.insert(codes).values({ codeSystemId: cs.id, code: 'R50.9', display: 'Fever, unspecified', selectable: true, active: true, excludes: [] }).returning())[0].id

    await db.insert(patients).values({
      id: PATIENT, name: 'Test WS14 Meena', dob: '1980-01-01', gender: 'female', uhid: `${CODE}U`, stateCode: 'IN-KA', addressLine1: '1 Test Street', phone: '9999999999',
    })
  })

  afterAll(async () => {
    vi.useRealTimers()
    const db = getDb()
    // Shared settings first, so a failed delete below never leaves them changed.
    if (savedSettings) await db.update(billingSettings).set(savedSettings).where(eq(billingSettings.id, 1))
    if (fx.codeSystem) await db.update(codeSystems).set({ isCurrent: false }).where(eq(codeSystems.id, fx.codeSystem))
    if (savedCurrentIcd.length) await db.update(codeSystems).set({ isCurrent: true }).where(inArray(codeSystems.id, savedCurrentIcd))
    await purgeBillingFixtures([PATIENT])
    await db.delete(medicationDispenses).where(eq(medicationDispenses.patientId, PATIENT))
    await db.delete(medicationEpisodes).where(eq(medicationEpisodes.patientId, PATIENT))
    await db.delete(prescriptions).where(eq(prescriptions.patientId, PATIENT))
    await db.delete(labOrders).where(eq(labOrders.patientId, PATIENT))
    await db.delete(labRequisitions).where(eq(labRequisitions.patientId, PATIENT))
    await db.delete(diagnoses).where(eq(diagnoses.patientId, PATIENT))
    await db.delete(encounterVitals).where(eq(encounterVitals.patientId, PATIENT))
    await db.delete(encounterCoding).where(eq(encounterCoding.patientId, PATIENT))
    await db.delete(encounters).where(eq(encounters.patientId, PATIENT))
    await db.delete(doctorAssignments).where(eq(doctorAssignments.patientId, PATIENT))
    await db.delete(auditLog).where(or(eq(auditLog.patientId, PATIENT), inArray(auditLog.userName, ['desk', 'doctor', 'pharmacist', 'billing', 'cashier'].map((n) => `${PROBE} ${n}`))))
    await db.delete(patients).where(eq(patients.id, PATIENT))
    await db.delete(codes).where(eq(codes.codeSystemId, fx.codeSystem))
    await db.delete(codeSystems).where(eq(codeSystems.id, fx.codeSystem))
    await db.delete(medicationInventory).where(eq(medicationInventory.medicationId, fx.med))
    await db.delete(medications).where(eq(medications.id, fx.med))
    await db.delete(labTests).where(eq(labTests.id, fx.test))
    await db.delete(tariffRates).where(inArray(tariffRates.id, fx.rateIds))
    await db.delete(serviceCatalog).where(eq(serviceCatalog.departmentId, fx.dep))
    await db.delete(providers).where(eq(providers.id, fx.prov))
    await db.delete(departments).where(eq(departments.id, fx.dep))
  })

  it('walk-in check-in -> consultation -> dispense -> one invoice of four lines, paid in cash, balance zero', async () => {
    const db = getDb()

    // 1. Front desk: walk-in check-in captures the consultation and the first-visit registration.
    as('frontdesk', 'desk')
    const checkIn = await checkInRoute(json('http://localhost/api/front-desk/check-in', {
      patientId: PATIENT, providerId: fx.prov, visitType: 'outpatient', urgency: 'routine', reason: 'Fever for three days',
    }))
    expect(checkIn.status).toBe(201)
    const checkedIn = await checkIn.json()
    const encounterId: number = checkedIn.encounterId
    expect(checkedIn.charges).toEqual([
      { ok: true, source: 'consultation', lineId: expect.any(Number), itemName: 'Consultation - General Medicine', taxablePaise: 60000, billTo: 'self', existing: false },
      { ok: true, source: 'registration', lineId: expect.any(Number), itemName: 'Registration fee', taxablePaise: 10000, billTo: 'self', existing: false },
    ])

    // 2. Doctor: start, vitals, coded diagnosis, 1-0-1 x 5 days, a lab order on the visit.
    as('pi', 'doctor')
    const start = await startRoute(json(`http://localhost/api/encounters/${encounterId}/start`, {}), idParams(encounterId))
    expect(start.status).toBe(200)
    expect(await start.json()).toEqual({ status: 'in_consultation', changed: true })

    const vitals = await vitalsRoute(json(`http://localhost/api/encounters/${encounterId}/vitals`, { systolicMmhg: 124, diastolicMmhg: 82, pulseBpm: 88, tempC: 38.4, spo2Pct: 98 }), idParams(encounterId))
    expect(vitals.status).toBe(201)

    const dx = await diagnosisRoute(json(`http://localhost/api/encounters/${encounterId}/diagnoses`, { codeId: fx.codeId, diagnosisType: 'primary' }), idParams(encounterId))
    expect(dx.status).toBe(201)
    expect((await dx.json()).diagnosis).toMatchObject({ code: 'R50.9', encounterId })

    const rx = await prescriptionRoute(json(`http://localhost/api/encounters/${encounterId}/prescriptions`, {
      items: [{ medicationId: fx.med, name: `Test WS14 Paracetamol 650 ${RUN}`, genericName: 'Paracetamol', medicationClass: 'Analgesic', dose: '1 tablet', dosePattern: '1-0-1', durationDays: 5, route: 'oral', foodTiming: 'after_food' }],
    }), idParams(encounterId))
    expect(rx.status).toBe(201)
    const { episodeIds } = await rx.json()
    expect(episodeIds).toHaveLength(1)

    const lab = await labOrderRoute(json(`http://localhost/api/patients/${PATIENT}/lab-orders`, { labTestIds: [fx.test], originatingEncounterId: encounterId }), { params: Promise.resolve({ anonId: PATIENT }) })
    expect(lab.status).toBe(201)
    const labBody = await lab.json()
    expect(labBody.charges).toEqual([expect.objectContaining({ ok: true, source: 'lab_order', taxablePaise: 45000, billTo: 'self', existing: false })])

    // 3. Doctor completes: the consultation is already on the bill (captured at check-in).
    const complete = await completeRoute(json(`http://localhost/api/encounters/${encounterId}/complete`, {}), idParams(encounterId))
    expect(complete.status).toBe(200)
    const completed = await complete.json()
    expect(completed.encounter).toMatchObject({ id: encounterId, status: 'completed' })
    expect(completed.warnings).toEqual([])
    expect(completed.charges).toEqual([
      { ok: true, source: 'consultation', lineId: checkedIn.charges[0].lineId, itemName: 'Consultation - General Medicine', taxablePaise: 60000, billTo: 'self', existing: true },
    ])

    // 4. Pharmacist: dispenses the prefilled quantity (1-0-1 x 5 days of tablets = 10) with batch and expiry.
    as('pharmacy', 'pharmacist')
    const [episode] = await db.select().from(medicationEpisodes).where(eq(medicationEpisodes.id, episodeIds[0]))
    expect(episode.quantityPrescribed).toBe(10)
    const dispense = await dispenseRoute(json('http://localhost/api/pharmacy/dispense', {
      patientId: PATIENT, medicationId: fx.med, medicationEpisodeId: episode.id, quantity: episode.quantityPrescribed, batchNo: 'B2099', expiryMonth: '2099-12',
    }))
    expect(dispense.status).toBe(201)
    const dispensed = await dispense.json()
    expect(dispensed.charge).toMatchObject({ quantity: 10, unitMrpPaise: MRP_PAISE })
    const [pharmacyLine] = await db.select().from(chargeLines).where(eq(chargeLines.medicationDispenseId, dispensed.id))
    expect(pharmacyLine).toMatchObject({ encounterId, admissionId: null, payerId: null, source: 'pharmacy', status: 'captured' })

    // 5. Billing: "Invoice all ready lines" drafts exactly one invoice with the visit's four lines.
    as('billing', 'billing')
    const ready = await invoiceReadyRoute(json('http://localhost/api/billing/invoice-ready', { patientId: PATIENT }))
    expect(ready.status).toBe(200)
    const drafted = await ready.json()
    expect(drafted.skipped).toEqual([])
    expect(drafted.created).toEqual([{ invoiceId: expect.any(Number), patientId: PATIENT, lineCount: 4 }])
    const invoiceId: number = drafted.created[0].invoiceId
    const lines = await db.select().from(chargeLines).where(eq(chargeLines.patientId, PATIENT)).orderBy(asc(chargeLines.id))
    expect(lines.map((l) => [l.source, l.encounterId, l.invoiceId, l.status])).toEqual([
      ['consultation', encounterId, invoiceId, 'captured'],
      ['registration', encounterId, invoiceId, 'captured'],
      ['lab_order', encounterId, invoiceId, 'captured'],
      ['pharmacy', encounterId, invoiceId, 'captured'],
    ])
    expect(await db.select({ id: invoices.id }).from(invoices).where(eq(invoices.patientId, PATIENT))).toHaveLength(1)

    // 6. Finalise: the total is the sum of the line totals; the medicine never exceeds MRP x 10.
    const fin = await finaliseRoute(json(`http://localhost/api/billing/invoices/${invoiceId}/finalise`, {}), idParams(invoiceId))
    const finBody = await fin.json()
    expect([fin.status, finBody]).toEqual([200, { invoiceNumber: expect.any(String) }])
    const { invoiceNumber } = finBody
    expect(invoiceNumber).toEqual(expect.any(String))
    const [invoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId))
    expect(invoice).toMatchObject({ status: 'finalised', invoiceNumber, invoiceDate: DAY, payerId: null })
    const invLines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(asc(invoiceLines.lineNo))
    expect(invLines).toHaveLength(4)
    expect(invoice.totalPaise).toBe(invLines.reduce((s, l) => s + l.totalPaise, 0))
    const medLine = invLines.find((l) => l.chargeLineId === pharmacyLine.id)!
    expect(medLine.quantity).toBe(10)
    expect(medLine.totalPaise).toBeLessThanOrEqual(MRP_PAISE * 10)
    // 10 x 312 = 3120 taxable + 12% GST (187 CGST + 187 SGST) = 3494 <= 3500.
    expect(medLine).toMatchObject({ taxablePaise: 3120, cgstPaise: 187, sgstPaise: 187, totalPaise: 3494 })
    expect(invoice.totalPaise).toBe(60000 + 10000 + 45000 + 3494)

    // 7. Cash desk: a cash receipt for the outstanding; the ledger balance is zero.
    as('billing', 'cashier')
    const before = (await getPatientLedger(PATIENT))!
    expect(before.ledger.summary.outstandingPaise).toBe(invoice.totalPaise)
    const pay = await paymentRoute(json('http://localhost/api/billing/payments', {
      patientId: PATIENT, kind: 'receipt', invoiceId, mode: 'cash', amountPaise: before.ledger.summary.outstandingPaise,
    }))
    expect(pay.status).toBe(201)
    expect((await pay.json()).receiptNumber).toEqual(expect.any(String))
    const after = (await getPatientLedger(PATIENT))!
    expect(after.ledger.summary.balancePaise).toBe(0)
    expect(after.unbilledPaise).toBe(0)
  })
})
