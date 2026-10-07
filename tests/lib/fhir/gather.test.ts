import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, allergies, diagnoses } from '@/db/schema'
import { codeSystems, codes, encounterProcedures, encounters, labOrders, labResults, labTests, providers } from '@/db/schema' // SP6
import { gatherPatientFhirData } from '@/lib/fhir/gather'

const createdPatientIds: string[] = []
const createdAllergyIds: number[] = []
const createdDiagnosisIds: number[] = []
afterEach(async () => {
  while (createdAllergyIds.length > 0) await getDb().delete(allergies).where(eq(allergies.id, createdAllergyIds.pop()!))
  while (createdDiagnosisIds.length > 0) await getDb().delete(diagnoses).where(eq(diagnoses.id, createdDiagnosisIds.pop()!))
  while (createdPatientIds.length > 0) await getDb().delete(patients).where(eq(patients.id, createdPatientIds.pop()!))
})

describe('gatherPatientFhirData', () => {
  it('returns patient-scoped rows for a fixture patient, with empty arrays for data-free tables', async () => {
    const [patient] = await getDb().insert(patients).values({
      id: 'RD-FHIR-GATHER-1', name: 'Gather Patient', dob: '1980-01-01',
    }).returning()
    createdPatientIds.push(patient.id)

    const [allergyRow] = await getDb().insert(allergies).values({
      patientId: patient.id, allergen: 'Penicillin', reaction: 'Hives', severity: 'moderate',
    }).returning()
    createdAllergyIds.push(allergyRow.id)

    const [diagnosisRow] = await getDb().insert(diagnoses).values({
      patientId: patient.id, code: 'J45.909', description: 'Asthma, unspecified', date: '2024-01-01',
    }).returning()
    createdDiagnosisIds.push(diagnosisRow.id)

    const data = await gatherPatientFhirData(patient.id)
    expect(data).not.toBeNull()
    expect(data!.patient.id).toBe(patient.id)
    expect(data!.allergyRows).toHaveLength(1)
    expect(data!.allergyRows[0].id).toBe(allergyRow.id)
    expect(data!.diagnosisRows).toHaveLength(1)
    expect(data!.diagnosisRows[0].id).toBe(diagnosisRow.id)
    expect(data!.medicationEpisodeRows).toEqual([])
    expect(data!.dispenseRows).toEqual([])
    expect(data!.labOrderRows).toEqual([])
  })

  it('returns null for an unknown anonId', async () => {
    const data = await gatherPatientFhirData('RD-DOES-NOT-EXIST')
    expect(data).toBeNull()
  })
})

// SP6 Task 15: coded diagnoses carry their code-system binding, procedures and encounters are
// gathered, and LOINC bindings come from the CURRENT, non-sample LOINC version only. TEST-SP6-
// fixtures, deleted by id children-first.
describe.skipIf(!process.env.DATABASE_URL)('gatherPatientFhirData -- SP6 coding (DB)', () => {
  const RUN = `${Date.now()}`.slice(-8)
  const PATIENT = `TEST-SP6-${RUN}-FG`
  const PROBE = `TEST-SP6-T15-${Date.now()}`
  const LOINC_LOADED = `9${RUN.slice(-5)}-1`
  const LOINC_OLD = `9${RUN.slice(-5)}-2`
  const ids = { provider: 0, encounter: 0, systems: [] as number[], tests: [] as number[], orders: [] as number[] }
  let dxCodeId = 0
  let primaryId = 0
  let secondaryId = 0
  let legacyId = 0
  let voidedId = 0
  let procId = 0
  let voidedProcId = 0

  beforeAll(async () => {
    const db = getDb()
    expect(await db.select({ id: codeSystems.id }).from(codeSystems).where(and(eq(codeSystems.kind, 'loinc'), eq(codeSystems.isCurrent, true))),
      'a current LOINC version already exists in this database').toEqual([])
    await db.insert(patients).values({ id: PATIENT, name: 'TEST_SP6 FHIR Gather', dob: '1980-01-01' })
    const [p] = await db.insert(providers).values({ name: 'TEST_SP6 Dr FHIR', specialty: 'Test', colorTag: '#000000' }).returning()
    ids.provider = p.id
    const [e] = await db.insert(encounters).values({
      patientId: PATIENT, encounterType: 'ipd', status: 'completed', encounterDate: '2099-03-01', providerId: p.id,
      checkedInByName: PROBE, checkedInAt: new Date('2099-03-01T04:00:00Z'), completedAt: new Date('2099-03-04T06:30:00Z'),
    }).returning()
    ids.encounter = e.id
    const system = async (kind: 'icd10' | 'loinc', version: string, isCurrent: boolean, codeValues: string[]) => {
      const [cs] = await db.insert(codeSystems).values({
        kind, version, name: 'TEST fictional', isCurrent, licenceNote: 'Test licence', sourceFileName: 'test.csv', sourceSha256: 'x',
        codeCount: codeValues.length, importedByName: PROBE,
      }).returning()
      ids.systems.push(cs.id)
      const rows = await db.insert(codes).values(codeValues.map((c) => ({ codeSystemId: cs.id, code: c, display: `TEST fictional ${c}` }))).returning()
      return rows
    }
    const [dx] = await system('icd10', `TEST-SP6-${RUN}-dx`, false, ['U7Z.0'])
    dxCodeId = dx.id
    await system('loinc', `TEST-SP6-${RUN}-new`, true, [LOINC_LOADED])
    await system('loinc', `TEST-SP6-${RUN}-old`, false, [LOINC_OLD])

    const dxRows = await db.insert(diagnoses).values([
      { patientId: PATIENT, code: 'U7Z.0', description: 'TEST coded', encounterId: e.id, codeId: dx.id, codeSystemKind: 'icd10', codeDisplay: 'TEST fictional U7Z.0', diagnosisType: 'primary', codingStatus: 'coded' },
      { patientId: PATIENT, code: '', description: 'TEST free text', encounterId: e.id, diagnosisType: 'secondary', sequence: 2 },
      { patientId: PATIENT, code: 'F32.1', description: 'TEST legacy' },
      { patientId: PATIENT, code: '', description: 'TEST voided', encounterId: e.id, diagnosisType: 'secondary', voidedAt: new Date() },
    ]).returning()
    ;[primaryId, secondaryId, legacyId, voidedId] = dxRows.map((r) => r.id)
    const procs = await db.insert(encounterProcedures).values([
      { encounterId: e.id, patientId: PATIENT, description: 'TEST procedure', performedOn: '2099-03-02', performedByProviderId: p.id, createdByName: PROBE },
      { encounterId: e.id, patientId: PATIENT, description: 'TEST voided procedure', performedOn: '2099-03-02', createdByName: PROBE, voidedAt: new Date() },
    ]).returning()
    ;[procId, voidedProcId] = procs.map((r) => r.id)

    for (const code of [LOINC_LOADED, LOINC_OLD]) {
      const [t] = await db.insert(labTests).values({ name: `TEST_SP6 test ${code}`, code }).returning()
      ids.tests.push(t.id)
      const [o] = await db.insert(labOrders).values({ patientId: PATIENT, labTestId: t.id, orderedByProviderId: p.id, status: 'resulted' }).returning()
      ids.orders.push(o.id)
      await db.insert(labResults).values({ labOrderId: o.id, value: '1', unit: null, flag: 'normal', resultedByName: PROBE })
    }
  })

  afterAll(async () => {
    const db = getDb()
    if (ids.orders.length) {
      await db.delete(labResults).where(inArray(labResults.labOrderId, ids.orders))
      await db.delete(labOrders).where(inArray(labOrders.id, ids.orders))
    }
    if (ids.tests.length) await db.delete(labTests).where(inArray(labTests.id, ids.tests))
    await db.delete(encounterProcedures).where(eq(encounterProcedures.patientId, PATIENT))
    await db.delete(diagnoses).where(eq(diagnoses.patientId, PATIENT))
    if (ids.encounter) await db.delete(encounters).where(eq(encounters.id, ids.encounter))
    if (ids.systems.length) {
      await db.delete(codes).where(inArray(codes.codeSystemId, ids.systems))
      await db.delete(codeSystems).where(inArray(codeSystems.id, ids.systems))
    }
    if (ids.provider) await db.delete(providers).where(eq(providers.id, ids.provider))
    await db.delete(patients).where(eq(patients.id, PATIENT))
  })

  it('voided diagnosis absent; coded row has binding; loincBindings keyed by loaded current codes only', async () => {
    const data = (await gatherPatientFhirData(PATIENT))!
    expect(data.diagnosisRows.map((d) => d.id).sort((a, b) => a - b)).toEqual([primaryId, secondaryId, legacyId].sort((a, b) => a - b))
    expect(data.diagnosisRows.map((d) => d.id)).not.toContain(voidedId)
    const coded = data.diagnosisRows.find((d) => d.id === primaryId)!
    expect(coded.binding).toEqual({ kind: 'icd10', version: `TEST-SP6-${RUN}-dx`, isSample: false })
    expect(coded.codeId).toBe(dxCodeId)
    expect(data.diagnosisRows.find((d) => d.id === legacyId)!.binding).toBeNull()

    expect(data.procedureRows.map((p) => p.id)).toEqual([procId])
    expect(data.procedureRows.map((p) => p.id)).not.toContain(voidedProcId)
    expect(data.procedureRows[0]).toMatchObject({ performedByName: 'TEST_SP6 Dr FHIR', binding: null, performedOn: '2099-03-02' })

    expect(data.encounterRows).toHaveLength(1)
    expect(data.encounterRows[0]).toMatchObject({ id: ids.encounter, providerName: 'TEST_SP6 Dr FHIR', encounterType: 'ipd' })
    expect(data.encounterRows[0].diagnosisRanks).toEqual([{ diagnosisId: primaryId, rank: 1 }, { diagnosisId: secondaryId, rank: 2 }])

    expect([...data.loincBindings.entries()]).toEqual([[LOINC_LOADED, { kind: 'loinc', version: `TEST-SP6-${RUN}-new`, isSample: false }]])
  })
})
