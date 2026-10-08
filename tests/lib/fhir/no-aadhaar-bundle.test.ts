import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, patientAadhaar } from '@/db/schema'
import { codeSystems, codes, diagnoses, encounterProcedures, encounters, providers } from '@/db/schema' // SP6
import { gatherPatientFhirData } from '@/lib/fhir/gather'
import { buildFullBundle } from '@/lib/fhir/bundle'
import { toCcdaXml } from '@/lib/fhir/ccda'

const PATIENT_ID = 'RD-FHIR-NOAADH-1'
const FULL_NUMBER = '234567890124'
const LAST4 = '0124'
const CIPHERTEXT = 'ciphertext-fixture-value'

beforeAll(async () => {
  const db = getDb()
  await db.insert(patients).values({ id: PATIENT_ID, name: 'No Leak Patient', dob: '1980-01-01', uhid: 'UH000000999', gender: 'female', addressLine1: '1 Test Street', stateCode: 'IN-KA', pinCode: '560001' })
  await db.insert(patientAadhaar).values({ patientId: PATIENT_ID, aadhaarEncrypted: CIPHERTEXT, aadhaarLast4: LAST4, consentGiven: true, consentRecordedAt: new Date(), recordedByName: 'Fixture' })
})
afterAll(async () => {
  const db = getDb()
  await db.delete(patientAadhaar).where(eq(patientAadhaar.patientId, PATIENT_ID))
  await db.delete(patients).where(eq(patients.id, PATIENT_ID))
})

describe('FHIR and C-CDA output for a patient with an Aadhaar row', () => {
  it('contains no Aadhaar digits, last4, ciphertext or label anywhere', async () => {
    const data = (await gatherPatientFhirData(PATIENT_ID))!
    const out = JSON.stringify(buildFullBundle(data)) + toCcdaXml(data)
    expect(out).toContain('UH000000999')
    for (const needle of [FULL_NUMBER, '2345 6789 0124', '2345-6789-0124', LAST4, CIPHERTEXT]) expect(out).not.toContain(needle)
    expect(out).not.toMatch(/aadhaar/i)
  })
})

// SP6 Task 15: the coded paths (Encounter, coded Condition, Procedure, Observation) add no Aadhaar
// and no ABHA. The patient carries an ABHA number, which only the Patient resource may show.
describe.skipIf(!process.env.DATABASE_URL)('coded FHIR resources for a patient with Aadhaar and ABHA (SP6)', () => {
  const RUN = `${Date.now()}`.slice(-8)
  const PID = `TEST-SP6-${RUN}-NA`
  const ABHA = `91${RUN}5555`.slice(0, 14)
  const ids = { provider: 0, encounter: 0, system: 0 }

  beforeAll(async () => {
    const db = getDb()
    await db.insert(patients).values({ id: PID, name: 'TEST_SP6 No Leak Coded', dob: '1980-01-01', abhaNumber: ABHA })
    await db.insert(patientAadhaar).values({ patientId: PID, aadhaarEncrypted: CIPHERTEXT, aadhaarLast4: LAST4, consentGiven: true, consentRecordedAt: new Date(), recordedByName: 'Fixture' })
    const [p] = await db.insert(providers).values({ name: 'TEST_SP6 Dr NoLeak', specialty: 'Test', colorTag: '#000000' }).returning()
    ids.provider = p.id
    const [e] = await db.insert(encounters).values({
      patientId: PID, encounterType: 'opd', status: 'completed', encounterDate: '2099-03-01', providerId: p.id, checkedInByName: 'TEST_SP6',
      completedAt: new Date('2099-03-01T08:00:00Z'),
    }).returning()
    ids.encounter = e.id
    const [cs] = await db.insert(codeSystems).values({
      kind: 'icd10', version: `TEST-SP6-${RUN}-na`, name: 'TEST fictional', licenceNote: 'Test licence', sourceFileName: 'test.csv',
      sourceSha256: 'x', codeCount: 1, importedByName: 'TEST_SP6',
    }).returning()
    ids.system = cs.id
    const [c] = await db.insert(codes).values({ codeSystemId: cs.id, code: 'U7Z.0', display: 'TEST fictional U7Z.0' }).returning()
    await db.insert(diagnoses).values({
      patientId: PID, code: 'U7Z.0', description: 'TEST coded', encounterId: e.id, codeId: c.id, codeSystemKind: 'icd10', codeDisplay: 'TEST fictional U7Z.0',
      diagnosisType: 'primary', codingStatus: 'coded',
    })
    await db.insert(encounterProcedures).values({ encounterId: e.id, patientId: PID, description: 'TEST procedure', performedOn: '2099-03-01', createdByName: 'TEST_SP6' })
  })
  afterAll(async () => {
    const db = getDb()
    await db.delete(encounterProcedures).where(eq(encounterProcedures.patientId, PID))
    await db.delete(diagnoses).where(eq(diagnoses.patientId, PID))
    if (ids.encounter) await db.delete(encounters).where(eq(encounters.id, ids.encounter))
    if (ids.system) {
      await db.delete(codes).where(eq(codes.codeSystemId, ids.system))
      await db.delete(codeSystems).where(eq(codeSystems.id, ids.system))
    }
    if (ids.provider) await db.delete(providers).where(eq(providers.id, ids.provider))
    await db.delete(patientAadhaar).where(eq(patientAadhaar.patientId, PID))
    await db.delete(patients).where(eq(patients.id, PID))
  })

  it('carries no Aadhaar anywhere and no ABHA outside the Patient resource', async () => {
    const data = (await gatherPatientFhirData(PID))!
    const bundle = buildFullBundle(data)
    const types = bundle.entry.map((e) => (e.resource as { resourceType: string }).resourceType)
    expect(types).toEqual(expect.arrayContaining(['Patient', 'Encounter', 'Condition', 'Procedure']))
    const out = JSON.stringify(bundle) + toCcdaXml(data)
    for (const needle of [FULL_NUMBER, LAST4, CIPHERTEXT]) expect(out).not.toContain(needle)
    expect(out).not.toMatch(/aadhaar/i)
    const coded = JSON.stringify(bundle.entry.filter((e) => (e.resource as { resourceType: string }).resourceType !== 'Patient'))
    expect(coded).not.toContain(ABHA.slice(-6))
    expect(coded).not.toMatch(/abha|healthid/i)
  })
})
