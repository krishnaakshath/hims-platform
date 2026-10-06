import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients } from '@/db/schema'
import { patientToFhir } from '@/lib/fhir/patient'

const createdIds: string[] = []
afterEach(async () => {
  while (createdIds.length > 0) await getDb().delete(patients).where(eq(patients.id, createdIds.pop()!))
})

describe('patientToFhir', () => {
  it('maps identifier, name, and DOB from the single-sourced patient fields', async () => {
    const [patient] = await getDb().insert(patients).values({
      id: 'RD-FHIR-P1', name: 'Test Name', dob: '1985-03-02',
    }).returning()
    createdIds.push(patient.id)

    const fhir = patientToFhir(patient)
    expect(fhir.resourceType).toBe('Patient')
    expect(fhir.id).toBe('RD-FHIR-P1')
    expect(fhir.identifier).toEqual([{ value: 'RD-FHIR-P1' }])
    expect(fhir.name).toEqual([{ text: 'Test Name' }])
    expect(fhir.birthDate).toBe('1985-03-02')
    expect(fhir).not.toHaveProperty('gender') // this app tracks no gender/sex field on `patients` — never fabricate one
  })
})
