import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, allergies } from '@/db/schema'
import { allergyToFhir, allergiesToFhir } from '@/lib/fhir/allergy'

const createdPatientIds: string[] = []
const createdAllergyIds: number[] = []
afterEach(async () => {
  while (createdAllergyIds.length > 0) await getDb().delete(allergies).where(eq(allergies.id, createdAllergyIds.pop()!))
  while (createdPatientIds.length > 0) await getDb().delete(patients).where(eq(patients.id, createdPatientIds.pop()!))
})

describe('allergyToFhir', () => {
  it('maps an allergy with a recorded reaction', async () => {
    const [patient] = await getDb().insert(patients).values({
      id: 'RD-FHIR-A1', name: 'Allergy Patient', dob: '1980-01-01',
    }).returning()
    createdPatientIds.push(patient.id)

    const [allergyRow] = await getDb().insert(allergies).values({
      patientId: patient.id, allergen: 'Penicillin', reaction: 'Hives', severity: 'moderate',
    }).returning()
    createdAllergyIds.push(allergyRow.id)

    const fhir = allergyToFhir(allergyRow)
    expect(fhir.resourceType).toBe('AllergyIntolerance')
    expect(fhir.id).toBe(`allergy-${allergyRow.id}`)
    expect(fhir.patient).toEqual({ reference: `Patient/${patient.id}` })
    expect(fhir.code).toEqual({ text: 'Penicillin' })
    expect(fhir.code.coding).toBeUndefined()
    expect(fhir.reaction).toEqual([{ manifestation: [{ text: 'Hives' }], severity: 'moderate' }])
  })

  it('maps an allergy with no recorded reaction to "Not specified"', async () => {
    const [patient] = await getDb().insert(patients).values({
      id: 'RD-FHIR-A2', name: 'Allergy Patient 2', dob: '1980-01-01',
    }).returning()
    createdPatientIds.push(patient.id)

    const [allergyRow] = await getDb().insert(allergies).values({
      patientId: patient.id, allergen: 'Latex', severity: 'severe',
    }).returning()
    createdAllergyIds.push(allergyRow.id)

    const fhir = allergyToFhir(allergyRow)
    expect(fhir.reaction).toEqual([{ manifestation: [{ text: 'Not specified' }], severity: 'severe' }])
    expect(fhir.code).toEqual({ text: 'Latex' })
    expect(fhir.code.coding).toBeUndefined()
  })

  it('allergiesToFhir maps a list of rows', async () => {
    const [patient] = await getDb().insert(patients).values({
      id: 'RD-FHIR-A3', name: 'Allergy Patient 3', dob: '1980-01-01',
    }).returning()
    createdPatientIds.push(patient.id)

    const rows = await getDb().insert(allergies).values([
      { patientId: patient.id, allergen: 'Shellfish', reaction: 'Swelling', severity: 'mild' },
      { patientId: patient.id, allergen: 'Bee stings', severity: 'severe' },
    ]).returning()
    rows.forEach((r) => createdAllergyIds.push(r.id))

    const fhirList = allergiesToFhir(rows)
    expect(fhirList).toHaveLength(2)
    expect(fhirList[0].code).toEqual({ text: 'Shellfish' })
    expect(fhirList[1].reaction[0].manifestation).toEqual([{ text: 'Not specified' }])
  })
})
