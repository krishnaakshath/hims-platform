import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, medications, medicationDispenses } from '@/db/schema'
import { medicationDispenseToFhir, medicationDispensesToFhir } from '@/lib/fhir/medication-dispense'

const createdPatientIds: string[] = []
const createdMedIds: number[] = []
const createdDispenseIds: number[] = []
afterEach(async () => {
  while (createdDispenseIds.length > 0) await getDb().delete(medicationDispenses).where(eq(medicationDispenses.id, createdDispenseIds.pop()!))
  while (createdMedIds.length > 0) await getDb().delete(medications).where(eq(medications.id, createdMedIds.pop()!))
  while (createdPatientIds.length > 0) await getDb().delete(patients).where(eq(patients.id, createdPatientIds.pop()!))
})

describe('medicationDispenseToFhir', () => {
  it('maps a dispense row with its medication name', async () => {
    const [patient] = await getDb().insert(patients).values({
      id: 'RD-FHIR-D1', name: 'Dispense Patient', dob: '1980-01-01',
    }).returning()
    createdPatientIds.push(patient.id)

    // Collision-safe: `medications.name` has a live UNIQUE constraint and the
    // shared dev DB has real seeded rows (e.g. "Lorazepam") from the Pharmacy
    // plan -- matches the convention in tests/lib/queries/medication-dispenses.test.ts.
    const [med] = await getDb().insert(medications).values({
      name: `Test Dispense Med ${Date.now()}`, medicationClass: 'Test', form: 'tablet',
    }).returning()
    createdMedIds.push(med.id)

    const [dispenseRow] = await getDb().insert(medicationDispenses).values({
      patientId: patient.id, medicationId: med.id, quantity: 10, dispensedByName: 'Test Staff',
    }).returning()
    createdDispenseIds.push(dispenseRow.id)

    const fhir = medicationDispenseToFhir({ dispense: dispenseRow, medicationName: med.name })
    expect(fhir.resourceType).toBe('MedicationDispense')
    expect(fhir.id).toBe(`medication-dispense-${dispenseRow.id}`)
    expect(fhir.status).toBe('completed')
    expect(fhir.subject).toEqual({ reference: `Patient/${patient.id}` })
    expect(fhir.medicationCodeableConcept).toEqual({ text: med.name })
    expect(fhir.medicationCodeableConcept).not.toHaveProperty('coding')
    expect(fhir.quantity).toEqual({ value: 10 })
    expect(fhir.whenHandedOver).toBe(dispenseRow.dispensedAt.toISOString())
  })

  it('medicationDispensesToFhir maps a list of rows', async () => {
    const [patient] = await getDb().insert(patients).values({
      id: 'RD-FHIR-D2', name: 'Dispense Patient 2', dob: '1980-01-01',
    }).returning()
    createdPatientIds.push(patient.id)

    const [med] = await getDb().insert(medications).values({
      name: `Test Dispense Med 2 ${Date.now()}`, medicationClass: 'Test', form: 'tablet',
    }).returning()
    createdMedIds.push(med.id)

    const rows = await getDb().insert(medicationDispenses).values([
      { patientId: patient.id, medicationId: med.id, quantity: 5, dispensedByName: 'Staff A' },
      { patientId: patient.id, medicationId: med.id, quantity: 3, dispensedByName: 'Staff B' },
    ]).returning()
    rows.forEach((r) => createdDispenseIds.push(r.id))

    const fhirList = medicationDispensesToFhir(rows.map((dispense) => ({ dispense, medicationName: med.name })))
    expect(fhirList).toHaveLength(2)
    expect(fhirList[0].quantity).toEqual({ value: 5 })
    expect(fhirList[1].quantity).toEqual({ value: 3 })
  })
})
