import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { admissions, admissionTransfers, appointments, auditLog, departments, followUpOrders, patients, providers, rooms, signatures } from '@/db/schema'
import type { Session } from '@/lib/auth'
import { addDaysIso } from '@/lib/follow-ups/rules'
import { istDateOf } from '@/lib/india-time'
import { createAdmission, dischargeAdmission } from '@/lib/queries/admissions'
import { getDischargeSummaryData } from '@/lib/queries/discharge-summary'
import { createSignature } from '@/lib/queries/signatures'

const RUN = `${Date.now()}`
const PROBE_USER = `TEST_SP3_DSUM-${RUN}`
const SESSION: Session = { role: 'admin', name: PROBE_USER, userId: null }
const PATIENT = `TEST-SP3-${RUN}-DSUM`
const DEPT_CODE = `TSP3D${RUN.slice(-8)}`
const DAY = 24 * 60 * 60 * 1000

let deptId = 0
let providerId = 0
let roomId = 0
let admissionId = 0
let otherAdmissionId = 0

describe.skipIf(!process.env.DATABASE_URL)('getDischargeSummaryData (DB)', () => {
  beforeAll(async () => {
    const db = getDb()
    const [d] = await db.insert(departments).values({ code: DEPT_CODE, name: 'TEST_SP3 Surgery', kind: 'clinical' }).returning()
    deptId = d.id
    const [p] = await db.insert(providers).values({ name: `TEST_SP3 Dr Summary ${RUN}`, specialty: 'Test', colorTag: '#000000', departmentId: d.id, registrationCouncil: 'nmc', registrationNumber: 'TSP3-777' }).returning()
    providerId = p.id
    await db.insert(patients).values({
      id: PATIENT, name: 'TEST_SP3 Summary Patient', dob: '1990-01-15', gender: 'male', uhid: `TSP3-UH-${RUN}`,
      phone: '9999999999', abhaNumber: `9${RUN.slice(-13).padStart(13, '0')}`, city: 'Mumbai', stateCode: 'IN-MH', pinCode: '400001',
    })
    const [r] = await db.insert(rooms).values({ ward: 'TEST_SP3 Ward S', roomNumber: 'S1', bedNumber: 'A' }).returning()
    roomId = r.id
  })

  afterAll(async () => {
    const db = getDb()
    const ids = [admissionId, otherAdmissionId].filter(Boolean)
    const appts = ids.length ? await db.select({ id: admissions.followUpAppointmentId }).from(admissions).where(inArray(admissions.id, ids)) : []
    if (ids.length) {
      await db.delete(followUpOrders).where(inArray(followUpOrders.originatingAdmissionId, ids))
      await db.delete(admissionTransfers).where(inArray(admissionTransfers.admissionId, ids))
      for (const id of ids) await db.delete(signatures).where(and(eq(signatures.signableType, 'admission_discharge'), eq(signatures.signableId, id)))
      await db.delete(admissions).where(inArray(admissions.id, ids))
    }
    const apptIds = appts.map((a) => a.id).filter((x): x is number => x !== null)
    if (apptIds.length) await db.delete(appointments).where(inArray(appointments.id, apptIds))
    await db.delete(rooms).where(eq(rooms.id, roomId))
    await db.delete(auditLog).where(eq(auditLog.userName, PROBE_USER))
    await db.delete(patients).where(eq(patients.id, PATIENT))
    await db.delete(providers).where(eq(providers.id, providerId))
    await db.delete(departments).where(eq(departments.id, deptId))
  })

  it('returns null for an unknown admission', async () => {
    expect(await getDischargeSummaryData(2147483000, new Date(), 'admin')).toBeNull()
  })

  it('returns null for an admission still admitted and the shape after discharge', async () => {
    const db = getDb()
    const adm = await createAdmission({ patientId: PATIENT, roomId: null, attendingProviderId: providerId, admissionType: 'elective', createdFromAssignmentId: null })
    admissionId = adm.id
    await db.insert(admissionTransfers).values({ admissionId: adm.id, fromRoomId: null, toRoomId: roomId, reason: 'TEST_SP3 bed', transferredByName: PROBE_USER })
    expect(await getDischargeSummaryData(adm.id, new Date(), 'admin')).toBeNull()

    const start = new Date(Math.floor((Date.now() + 15 * DAY) / 60000) * 60000)
    const r = await dischargeAdmission(adm.id, {
      dischargeDiagnosis: 'TEST_SP3 appendicitis', dischargeDrugs: 'TEST_SP3 paracetamol', dischargeDevices: 'None', dischargeDiet: 'Soft', dischargeSummaryNotes: 'TEST_SP3 uneventful',
      followUp: { startsAt: start, endsAt: new Date(start.getTime() + 30 * 60000) },
      followUpPlan: { timing: { kind: 'interval', interval: { value: 2, unit: 'weeks' } }, reason: 'Suture removal', planNotes: 'TEST_SP3 private plan' },
    }, SESSION)
    expect(r.ok).toBe(true)
    await createSignature({ signableType: 'admission_discharge', signableId: adm.id, signerTypedName: PROBE_USER, signerRole: 'admin', attestationText: 'TEST_SP3' })

    const now = new Date()
    const d = await getDischargeSummaryData(adm.id, now, 'pi')
    expect(d).not.toBeNull()
    const today = istDateOf(now)
    expect(d!.patient).toEqual({
      id: PATIENT, uhid: `TSP3-UH-${RUN}`, name: 'TEST_SP3 Summary Patient', ageYears: expect.any(Number), gender: 'Male',
      abhaNumber: expect.stringMatching(/^\d{2}-\d{4}-\d{4}-\d{4}$/), abhaAddress: null,
      address: 'Mumbai, Maharashtra 400001', isMlc: false, mlcNumber: null,
    })
    expect(d!.admission).toEqual({ id: adm.id, admissionType: 'elective', admittedOn: today, dischargedOn: today, lengthOfStayDays: 1, lastWard: 'TEST_SP3 Ward S' })
    expect(d!.attending).toEqual({ providerId, name: `TEST_SP3 Dr Summary ${RUN}`, registration: 'NMC TSP3-777', departmentName: 'TEST_SP3 Surgery' })
    expect(d!.clinical).toEqual({ diagnosis: 'TEST_SP3 appendicitis', drugs: 'TEST_SP3 paracetamol', devices: 'None', diet: 'Soft', notes: 'TEST_SP3 uneventful' })
    expect(d!.followUp).toEqual({
      dueDate: addDaysIso(today, 14), windowStart: addDaysIso(today, 11), windowEnd: addDaysIso(today, 21),
      reason: 'Suture removal', status: 'scheduled', appointmentStartsAt: start.toISOString(),
    })
    expect(d!.signature).toEqual({ signerTypedName: PROBE_USER, signedAt: expect.any(String) })

    // Minimal projection only: no phone, Aadhaar, plan notes or credential keys at any depth.
    const json = JSON.stringify(d)
    for (const banned of ['9999999999', 'TEST_SP3 private plan', 'aadhaar', 'Aadhaar', 'password', 'mfa', 'phone', 'planNotes']) expect(json).not.toContain(banned)
  })

  it('front desk gets the document without clinical sections or ABHA', async () => {
    const d = await getDischargeSummaryData(admissionId, new Date(), 'frontdesk')
    expect(d).not.toBeNull()
    expect(d!.clinical).toBeNull()
    expect(d!.patient.abhaNumber).toBeNull()
    expect(JSON.stringify(d)).not.toContain('appendicitis')
    expect(d!.followUp?.reason).toBe('Suture removal')
  })

  it('a discharge without a follow-up has followUp and signature null', async () => {
    const adm = await createAdmission({ patientId: PATIENT, roomId: null, attendingProviderId: providerId, admissionType: 'transfer_in', createdFromAssignmentId: null })
    otherAdmissionId = adm.id
    await dischargeAdmission(adm.id, { dischargeDiagnosis: 'A', dischargeDrugs: 'B', dischargeDevices: 'C', dischargeDiet: 'D', dischargeSummaryNotes: 'E', followUp: null, followUpPlan: null }, SESSION)
    const d = await getDischargeSummaryData(adm.id, new Date(), 'admin')
    expect(d!.followUp).toBeNull()
    expect(d!.signature).toBeNull()
    expect(d!.admission.lastWard).toBeNull()
  })
})
