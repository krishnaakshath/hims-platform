// Wave J (P1-20): every portal record read is scoped to the session patient. Patient A's
// session never finds patient B's invoice, receipt, discharge summary, prescription or policy
// (the routes/pages turn that null into a 404), drafts and unsigned summaries stay hidden.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import {
  admissions, appointments, bookingRequests, invoices, medicationEpisodes, patientPayments, patientPolicies, patients, payers, providers, signatures,
} from '@/db/schema'
import type { InvoiceSnapshot } from '@/lib/billing/gst'
import { purgeBillingFixtures } from './billing-fixtures'
import {
  getPortalAbhaStatus, getPortalChangeableAppointment, getPortalDischargeSummary, getPortalInvoice, getPortalReceipt, listPortalAppointmentRequests,
  listPortalBookableProviders, listPortalDischarges, listPortalInvoices, listPortalPolicies, listPortalPrescriptions, listPortalReceipts,
  pendingRequestAppointmentIds,
} from '@/lib/queries/patient-portal-records'

const TAG = `WJR${process.pid}`
const A = `${TAG}-A`
const B = `${TAG}-B`
const ids = { invA: 0, invDraftA: 0, invB: 0, rcptA: 0, rcptB: 0, admA: 0, admUnsignedA: 0, admB: 0, rxA: 0, polA: 0, payer: 0, apptA: 0, apptPastA: 0, apptB: 0 }

function snapshot(pid: string): InvoiceSnapshot {
  return {
    hospital: { legalName: 'Test Hospital', gstin: null, stateCode: 'IN-KA', gstStateCode: '29', address: null },
    patient: { id: pid, name: pid, uhid: null, addressLine1: null, addressLine2: null, city: null, district: null, stateCode: null, pinCode: null },
    payer: null,
    context: { encounterId: null, admissionId: null, label: 'OPD' },
  }
}

beforeAll(async () => {
  const db = getDb()
  await db.insert(patients).values([
    { id: A, name: 'Portal Records A', dob: '1980-01-01', abhaNumber: `9${String(process.pid).padStart(13, '0')}`.slice(0, 14), abhaAddress: `${TAG.toLowerCase()}@abdm` },
    { id: B, name: 'Portal Records B', dob: '1981-01-01' },
  ])
  const [prov] = await db.select({ id: providers.id }).from(providers).where(eq(providers.isActive, true)).limit(1)
  const inv = (pid: string, n: string, status: 'finalised' | 'draft') => ({
    patientId: pid, status, createdByName: 'test',
    ...(status === 'finalised' ? { invoiceNumber: `${TAG}-${n}`, invoiceDate: '2099-06-01', snapshot: snapshot(pid), totalPaise: 12345, taxablePaise: 12345, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, supplyType: 'intra' as const, finalisedAt: new Date(), financialYear: '2099-00' } : {}),
  })
  ids.invA = (await db.insert(invoices).values(inv(A, 'IA', 'finalised')).returning({ id: invoices.id }))[0].id
  ids.invDraftA = (await db.insert(invoices).values(inv(A, 'DA', 'draft')).returning({ id: invoices.id }))[0].id
  ids.invB = (await db.insert(invoices).values(inv(B, 'IB', 'finalised')).returning({ id: invoices.id }))[0].id
  const pay = (pid: string, n: string) => ({ receiptNumber: `${TAG}-${n}`, kind: 'receipt' as const, patientId: pid, mode: 'cash' as const, amountPaise: 5000, financialYear: '2099-00', receiptDate: '2099-06-01', receivedByName: 'Cashier' })
  ids.rcptA = (await db.insert(patientPayments).values(pay(A, 'RA')).returning({ id: patientPayments.id }))[0].id
  ids.rcptB = (await db.insert(patientPayments).values(pay(B, 'RB')).returning({ id: patientPayments.id }))[0].id
  const adm = (pid: string) => ({ patientId: pid, attendingProviderId: prov.id, status: 'discharged' as const, admittedAt: new Date('2099-05-01T04:00:00Z'), dischargedAt: new Date('2099-05-04T04:00:00Z'), dischargeDiagnosis: `Dx ${pid}`, dischargeDrugs: 'Paracetamol' })
  ids.admA = (await db.insert(admissions).values(adm(A)).returning({ id: admissions.id }))[0].id
  ids.admUnsignedA = (await db.insert(admissions).values(adm(A)).returning({ id: admissions.id }))[0].id
  ids.admB = (await db.insert(admissions).values(adm(B)).returning({ id: admissions.id }))[0].id
  for (const id of [ids.admA, ids.admB]) await db.insert(signatures).values({ signableType: 'admission_discharge', signableId: id, signerTypedName: 'Dr Test', signerRole: 'pi', attestationText: 'x' })
  ids.rxA = (await db.insert(medicationEpisodes).values({ patientId: A, name: 'Metformin', medicationClass: 'antidiabetic', dose: '500 mg', startDate: '2099-05-01', status: 'active', prescribedAt: new Date('2099-05-01T05:00:00Z'), prescribedByProviderId: prov.id, frequencyPerDay: 2, durationDays: 30 }).returning({ id: medicationEpisodes.id }))[0].id
  await db.insert(medicationEpisodes).values({ patientId: A, name: 'Imported history', medicationClass: 'x', startDate: '2001-01-01', status: 'inactive' })
  await db.insert(medicationEpisodes).values({ patientId: B, name: 'Atorvastatin', medicationClass: 'statin', startDate: '2099-05-01', status: 'active', prescribedAt: new Date(), prescribedByProviderId: prov.id })
  ids.payer = (await db.insert(payers).values({ name: `${TAG} Insurer`, payerId: `${TAG}-P` }).returning({ id: payers.id }))[0].id
  const pol = (pid: string, n: string) => ({ patientId: pid, insurerPayerId: ids.payer, policyNumber: `${TAG}-${n}`, memberId: 'M1', policyType: 'individual' as const, holderName: pid, relationship: 'self' as const, validFrom: '2099-01-01', validTo: '2099-12-31', createdByName: 'test', cardFrontBlobUrl: 'https://x/blob', cardFrontSha256: 'a'.repeat(64) })
  ids.polA = (await db.insert(patientPolicies).values(pol(A, 'PA')).returning({ id: patientPolicies.id }))[0].id
  await db.insert(patientPolicies).values(pol(B, 'PB'))
  const appt = (pid: string, startsAt: Date) => ({ patientId: pid, providerId: prov.id, startsAt, endsAt: new Date(startsAt.getTime() + 1800_000), visitReason: 'Review' })
  ids.apptA = (await db.insert(appointments).values(appt(A, new Date('2099-07-01T04:00:00Z'))).returning({ id: appointments.id }))[0].id
  ids.apptPastA = (await db.insert(appointments).values(appt(A, new Date('2001-07-01T04:00:00Z'))).returning({ id: appointments.id }))[0].id
  ids.apptB = (await db.insert(appointments).values(appt(B, new Date('2099-07-01T04:00:00Z'))).returning({ id: appointments.id }))[0].id
  await db.insert(bookingRequests).values({ requesterName: 'B', requesterDob: '1981-01-01', patientId: B, requestKind: 'cancel', appointmentId: ids.apptB, preferredDateRangeStart: '2099-07-01', preferredDateRangeEnd: '2099-07-01', reason: 'B private reason' })
  await db.insert(bookingRequests).values({ requesterName: 'A', requesterDob: '1980-01-01', patientId: A, requestKind: 'cancel', appointmentId: ids.apptA, preferredDateRangeStart: '2099-07-01', preferredDateRangeEnd: '2099-07-01', reason: 'A reason' })
})

afterAll(async () => {
  const db = getDb()
  await purgeBillingFixtures([A, B])
  await db.delete(bookingRequests).where(inArray(bookingRequests.patientId, [A, B]))
  await db.delete(appointments).where(inArray(appointments.patientId, [A, B]))
  await db.delete(patientPolicies).where(inArray(patientPolicies.patientId, [A, B]))
  await db.delete(payers).where(eq(payers.id, ids.payer))
  await db.delete(medicationEpisodes).where(inArray(medicationEpisodes.patientId, [A, B]))
  await db.delete(signatures).where(inArray(signatures.signableId, [ids.admA, ids.admB]))
  await db.delete(admissions).where(inArray(admissions.patientId, [A, B]))
  await db.delete(patients).where(inArray(patients.id, [A, B]))
})

describe('portal bills and receipts', () => {
  it('lists only the patient\'s own finalised invoices', async () => {
    const rows = await listPortalInvoices(A)
    expect(rows.map((r) => r.id)).toEqual([ids.invA])
    expect(rows[0]).toMatchObject({ invoiceNumber: `${TAG}-IA`, totalPaise: 12345 })
  })

  it('opens an own finalised invoice; another patient\'s or a draft is null', async () => {
    expect((await getPortalInvoice(A, ids.invA))?.invoiceNumber).toBe(`${TAG}-IA`)
    expect(await getPortalInvoice(A, ids.invB)).toBeNull()
    expect(await getPortalInvoice(A, ids.invDraftA)).toBeNull()
    expect(await getPortalInvoice(A, 2_000_000_000)).toBeNull()
  })

  it('receipts: own only', async () => {
    expect((await listPortalReceipts(A)).map((r) => r.id)).toEqual([ids.rcptA])
    expect((await getPortalReceipt(A, ids.rcptA))?.receiptNumber).toBe(`${TAG}-RA`)
    expect(await getPortalReceipt(A, ids.rcptB)).toBeNull()
  })
})

describe('portal discharge summaries', () => {
  it('lists own discharged admissions with the signed flag', async () => {
    const rows = await listPortalDischarges(A)
    expect(rows.map((r) => [r.admissionId, r.signed]).sort()).toEqual([[ids.admA, true], [ids.admUnsignedA, false]].sort())
  })

  it('gives the patient copy of an own signed summary; unsigned or another patient\'s is null', async () => {
    const d = await getPortalDischargeSummary(A, ids.admA)
    expect(d?.clinical?.diagnosis).toBe(`Dx ${A}`)
    expect(d?.patient.mlcNumber).toBeNull()
    expect(d?.patient.abhaNumber).toMatch(/^XX-XXXX-XXXX-\d{4}$/)
    expect(await getPortalDischargeSummary(A, ids.admUnsignedA)).toBeNull()
    expect(await getPortalDischargeSummary(A, ids.admB)).toBeNull()
  })
})

describe('portal prescriptions, policies and ABHA', () => {
  it('prescriptions: own in-app ones only', async () => {
    const rows = await listPortalPrescriptions(A)
    expect(rows.map((r) => r.name)).toEqual(['Metformin'])
    expect(rows[0]).toMatchObject({ dose: '500 mg', frequencyPerDay: 2, durationDays: 30 })
    expect(typeof rows[0].prescriberName).toBe('string')
  })

  it('policies: own only, with no card image or staff fields', async () => {
    const rows = await listPortalPolicies(A)
    expect(rows.map((r) => r.policyNumber)).toEqual([`${TAG}-PA`])
    expect(rows[0].insurerName).toBe(`${TAG} Insurer`)
    const json = JSON.stringify(rows)
    for (const t of ['blob', 'createdByName', 'cardFront', `${TAG}-PB`]) expect(json).not.toContain(t)
  })

  it('ABHA status is masked', async () => {
    const s = await getPortalAbhaStatus(A)
    expect(s?.abhaNumberMasked).toMatch(/^XX-XXXX-XXXX-\d{4}$/)
    expect(s?.abhaAddress).toBe(`${TAG.toLowerCase()}@abdm`)
    expect(await getPortalAbhaStatus(B)).toEqual({ abhaNumberMasked: null, abhaAddress: null, unavailableReason: null })
  })
})

describe('portal appointment requests', () => {
  it('lists own requests only, without the free-text reason', async () => {
    const rows = await listPortalAppointmentRequests(A)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'cancel', status: 'pending', appointmentId: ids.apptA })
    expect(JSON.stringify(rows)).not.toContain('reason')
  })

  it('a changeable appointment is own, scheduled and in the future', async () => {
    expect((await getPortalChangeableAppointment(A, ids.apptA))?.id).toBe(ids.apptA)
    expect(await getPortalChangeableAppointment(A, ids.apptB)).toBeNull()
    expect(await getPortalChangeableAppointment(A, ids.apptPastA)).toBeNull()
  })

  it('pending request ids are scoped to the patient', async () => {
    expect([...(await pendingRequestAppointmentIds(A, [ids.apptA, ids.apptB]))]).toEqual([ids.apptA])
  })

  it('bookable providers expose id, name and specialty only', async () => {
    const rows = await listPortalBookableProviders()
    expect(rows.length).toBeGreaterThan(0)
    expect(Object.keys(rows[0]).sort()).toEqual(['id', 'name', 'specialty'])
  })
})
