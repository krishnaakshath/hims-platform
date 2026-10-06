import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, allergies, diagnoses } from '@/db/schema'
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
