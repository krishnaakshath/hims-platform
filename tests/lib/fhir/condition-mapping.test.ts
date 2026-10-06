import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, diagnoses } from '@/db/schema'
import { conditionToFhir, conditionsToFhir } from '@/lib/fhir/condition'

const createdPatientIds: string[] = []
const createdDiagnosisIds: number[] = []
afterEach(async () => {
  while (createdDiagnosisIds.length > 0) await getDb().delete(diagnoses).where(eq(diagnoses.id, createdDiagnosisIds.pop()!))
  while (createdPatientIds.length > 0) await getDb().delete(patients).where(eq(patients.id, createdPatientIds.pop()!))
})

describe('conditionToFhir', () => {
  it('maps a diagnosis with a code, description, and recorded date, with no `system` on the coding', async () => {
    const [patient] = await getDb().insert(patients).values({
      id: 'RD-FHIR-C1', name: 'Condition Patient', dob: '1980-01-01',
    }).returning()
    createdPatientIds.push(patient.id)

    const [diagnosisRow] = await getDb().insert(diagnoses).values({
      patientId: patient.id, code: 'F32.9', description: 'Major depressive disorder, single episode, unspecified',
      date: '2026-01-15',
    }).returning()
    createdDiagnosisIds.push(diagnosisRow.id)

    const fhir = conditionToFhir(diagnosisRow)
    expect(fhir.resourceType).toBe('Condition')
    expect(fhir.id).toBe(`condition-${diagnosisRow.id}`)
    expect(fhir.subject).toEqual({ reference: `Patient/${patient.id}` })
    expect(fhir.code.text).toBe('Major depressive disorder, single episode, unspecified')
    expect(fhir.code.coding).toEqual([{ code: 'F32.9', display: 'Major depressive disorder, single episode, unspecified' }])
    expect(fhir.code.coding![0]).not.toHaveProperty('system')
    expect(fhir.recordedDate).toBe('2026-01-15')
  })

  it('maps a null date to a null recordedDate', async () => {
    const [patient] = await getDb().insert(patients).values({
      id: 'RD-FHIR-C2', name: 'Condition Patient 2', dob: '1980-01-01',
    }).returning()
    createdPatientIds.push(patient.id)

    const [diagnosisRow] = await getDb().insert(diagnoses).values({
      patientId: patient.id, code: 'Z00.00', description: 'Encounter for general adult medical examination',
    }).returning()
    createdDiagnosisIds.push(diagnosisRow.id)

    const fhir = conditionToFhir(diagnosisRow)
    expect(fhir.recordedDate).toBeNull()
  })

  it('conditionsToFhir maps a list of rows', async () => {
    const [patient] = await getDb().insert(patients).values({
      id: 'RD-FHIR-C3', name: 'Condition Patient 3', dob: '1980-01-01',
    }).returning()
    createdPatientIds.push(patient.id)

    const rows = await getDb().insert(diagnoses).values([
      { patientId: patient.id, code: 'F41.1', description: 'Generalized anxiety disorder', date: '2026-02-01' },
      { patientId: patient.id, code: 'F43.10', description: 'Post-traumatic stress disorder, unspecified' },
    ]).returning()
    rows.forEach((r) => createdDiagnosisIds.push(r.id))

    const fhirList = conditionsToFhir(rows)
    expect(fhirList).toHaveLength(2)
    expect(fhirList[0].code.text).toBe('Generalized anxiety disorder')
    expect(fhirList[1].recordedDate).toBeNull()
  })
})
