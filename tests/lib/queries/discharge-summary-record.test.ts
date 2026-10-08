import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import {
  admissions, auditLog, codes, codeSystems, departments, diagnoses, encounters, followUpOrders, labOrders, labResults, labTests,
  medicationAdministrations, patients, providers,
} from '@/db/schema'
import type { Session } from '@/lib/auth'
import { createAdmission, dischargeAdmission } from '@/lib/queries/admissions'
import { getDischargeSummaryData } from '@/lib/queries/discharge-summary'

// Wave F P1-13: the clinical record on the printed discharge summary -- the
// admission's coded diagnoses (SP6), the medicines given on the MAR and the
// verified lab results of tests ordered during the stay.
const RUN = `${Date.now()}`
const PROBE_USER = `TEST_WF_DREC-${RUN}`
const SESSION: Session = { role: 'admin', name: PROBE_USER, userId: null }
const PATIENT = `TEST-WF-${RUN}-DREC`
const DEPT_CODE = `TWFD${RUN.slice(-8)}`
const HOUR = 60 * 60 * 1000

let deptId = 0
let providerId = 0
let admissionId = 0
let encounterId = 0
let systemId = 0
let codeId = 0
let labTestId = 0
const labOrderIds: number[] = []

describe.skipIf(!process.env.DATABASE_URL)('getDischargeSummaryData record (DB)', () => {
  beforeAll(async () => {
    const db = getDb()
    const [d] = await db.insert(departments).values({ code: DEPT_CODE, name: 'TEST_WF Medicine', kind: 'clinical' }).returning()
    deptId = d.id
    const [p] = await db.insert(providers).values({ name: `TEST_WF Dr Record ${RUN}`, specialty: 'Test', colorTag: '#000000', departmentId: d.id }).returning()
    providerId = p.id
    await db.insert(patients).values({ id: PATIENT, name: 'TEST_WF Record Patient', dob: '1975-05-05', gender: 'female', uhid: `TWF-UH-${RUN}` })

    const adm = await createAdmission({ patientId: PATIENT, roomId: null, attendingProviderId: providerId, admissionType: 'emergency', createdFromAssignmentId: null })
    admissionId = adm.id
    const admittedAt = new Date(Date.now() - 48 * HOUR)
    await db.update(admissions).set({ admittedAt }).where(eq(admissions.id, admissionId))
    const [enc] = await db.insert(encounters).values({
      patientId: PATIENT, encounterType: 'ipd', encounterDate: '2026-10-01', providerId, admissionId, checkedInByName: PROBE_USER,
    }).returning()
    encounterId = enc.id

    const [sys] = await db.insert(codeSystems).values({
      kind: 'icd10', version: `SAMPLE-TEST-WF-${RUN}`, name: 'TEST_WF sample', isSample: true, sourceFileName: 'test.csv', sourceSha256: 'x', codeCount: 1, importedByName: PROBE_USER,
    }).returning()
    systemId = sys.id
    const [c] = await db.insert(codes).values({ codeSystemId: systemId, code: 'ZZ9.9', display: 'SAMPLE fictional pneumonia' }).returning()
    codeId = c.id
    await db.insert(diagnoses).values([
      { patientId: PATIENT, encounterId, code: '', description: 'TEST_WF free-text comorbidity', diagnosisType: 'secondary', codingStatus: 'uncoded', sequence: 2, createdAt: new Date() },
      { patientId: PATIENT, encounterId, code: 'ZZ9.9', description: 'SAMPLE fictional pneumonia', codeId, codeSystemKind: 'icd10', codeDisplay: 'SAMPLE fictional pneumonia', diagnosisType: 'primary', codingStatus: 'coded', sequence: 1, createdAt: new Date() },
      { patientId: PATIENT, encounterId, code: '', description: 'TEST_WF voided', diagnosisType: 'secondary', codingStatus: 'uncoded', voidedAt: new Date(), createdAt: new Date() },
    ])

    const t1 = new Date(Date.now() - 40 * HOUR)
    const t2 = new Date(Date.now() - 20 * HOUR)
    await db.insert(medicationAdministrations).values([
      { admissionId, medicationName: 'TEST_WF Ceftriaxone', dose: '1 g IV', scheduledFor: t1, status: 'given', administeredAt: t1, administeredByName: PROBE_USER },
      { admissionId, medicationName: 'TEST_WF Ceftriaxone', dose: '1 g IV', scheduledFor: t2, status: 'given', administeredAt: t2, administeredByName: PROBE_USER },
      { admissionId, medicationName: 'TEST_WF Ceftriaxone', dose: '1 g IV', scheduledFor: new Date(), status: 'held' },
    ])

    const [test] = await db.select({ id: labTests.id }).from(labTests).limit(1)
    if (!test) throw new Error('Need at least one seeded lab test')
    labTestId = test.id
    const mk = async (orderedAt: Date, status: 'verified' | 'ordered' | 'cancelled') => {
      const [o] = await db.insert(labOrders).values({ patientId: PATIENT, labTestId, orderedByProviderId: providerId, status, orderedAt }).returning()
      labOrderIds.push(o.id)
      return o.id
    }
    const verified = await mk(new Date(Date.now() - 30 * HOUR), 'verified')
    await db.insert(labResults).values({ labOrderId: verified, value: '10.2', unit: 'g/dL', referenceRange: '12-15', flag: 'abnormal', resultedByName: PROBE_USER })
    await mk(new Date(Date.now() - 10 * HOUR), 'ordered')
    await mk(new Date(Date.now() - 9 * HOUR), 'cancelled')
    // Before the stay: never on this summary.
    const before = await mk(new Date(Date.now() - 96 * HOUR), 'verified')
    await db.insert(labResults).values({ labOrderId: before, value: '99.9', unit: 'g/dL', flag: 'normal', resultedByName: PROBE_USER })

    const r = await dischargeAdmission(admissionId, { dischargeDiagnosis: 'TEST_WF pneumonia', dischargeDrugs: 'TEST_WF amoxicillin', dischargeDevices: 'None', dischargeDiet: 'Soft', dischargeSummaryNotes: 'TEST_WF ok', followUp: null, followUpPlan: null }, SESSION)
    if (!r.ok) throw new Error('discharge failed')
  })

  afterAll(async () => {
    const db = getDb()
    if (labOrderIds.length) {
      await db.delete(labResults).where(inArray(labResults.labOrderId, labOrderIds))
      await db.delete(labOrders).where(inArray(labOrders.id, labOrderIds))
    }
    await db.delete(medicationAdministrations).where(eq(medicationAdministrations.admissionId, admissionId))
    await db.delete(diagnoses).where(eq(diagnoses.patientId, PATIENT))
    if (codeId) await db.delete(codes).where(eq(codes.id, codeId))
    if (systemId) await db.delete(codeSystems).where(eq(codeSystems.id, systemId))
    await db.delete(followUpOrders).where(eq(followUpOrders.patientId, PATIENT))
    await db.delete(encounters).where(eq(encounters.patientId, PATIENT))
    await db.delete(admissions).where(eq(admissions.patientId, PATIENT))
    await db.delete(auditLog).where(eq(auditLog.userName, PROBE_USER))
    await db.delete(patients).where(eq(patients.id, PATIENT))
    await db.delete(providers).where(eq(providers.id, providerId))
    await db.delete(departments).where(eq(departments.id, deptId))
  })

  it('loads the live diagnoses (primary first, ICD code value), the MAR summary and the in-stay verified labs for a clinical viewer', async () => {
    const d = await getDischargeSummaryData(admissionId, { now: new Date(), viewerRole: 'pi' })
    expect(d?.record).not.toBeNull()
    const rec = d!.record!
    expect(rec.diagnoses).toEqual([
      { code: 'ZZ9.9', system: 'icd10', description: 'SAMPLE fictional pneumonia', type: 'primary', codingStatus: 'coded' },
      { code: null, system: null, description: 'TEST_WF free-text comorbidity', type: 'secondary', codingStatus: 'uncoded' },
    ])
    expect(rec.medications).toEqual([
      { name: 'TEST_WF Ceftriaxone', dose: '1 g IV', given: 2, firstGivenAt: expect.any(String), lastGivenAt: expect.any(String) },
    ])
    expect(rec.labs).toHaveLength(1)
    expect(rec.labs[0]).toMatchObject({ value: '10.2', unit: 'g/dL', referenceRange: '12-15', flag: 'abnormal' })
    expect(rec.labsNotFinal).toBe(1)
    expect(JSON.stringify(rec)).not.toContain('99.9')
    expect(JSON.stringify(rec)).not.toContain('TEST_WF voided')
  })

  it('the front desk gets no record at all', async () => {
    const d = await getDischargeSummaryData(admissionId, { now: new Date(), viewerRole: 'frontdesk' })
    expect(d?.record).toBeNull()
    expect(JSON.stringify(d)).not.toMatch(/ZZ9\.9|Ceftriaxone|10\.2/)
  })
})
