import type { medicationDispenses } from '@/db/schema'
import type { FhirReference } from './types'

export interface DispenseWithMedicationName {
  dispense: typeof medicationDispenses.$inferSelect
  medicationName: string
}

export interface FhirMedicationDispense {
  resourceType: 'MedicationDispense'
  id: string
  status: 'completed'
  subject: FhirReference
  medicationCodeableConcept: { text: string }
  quantity: { value: number }
  whenHandedOver: string
}

export function medicationDispenseToFhir({ dispense, medicationName }: DispenseWithMedicationName): FhirMedicationDispense {
  return {
    resourceType: 'MedicationDispense',
    id: `medication-dispense-${dispense.id}`,
    status: 'completed',
    subject: { reference: `Patient/${dispense.patientId}` },
    // No `coding` -- this app has no RxNorm data for the medication catalog.
    medicationCodeableConcept: { text: medicationName },
    quantity: { value: dispense.quantity },
    whenHandedOver: dispense.dispensedAt.toISOString(),
  }
}

export function medicationDispensesToFhir(rows: DispenseWithMedicationName[]): FhirMedicationDispense[] {
  return rows.map(medicationDispenseToFhir)
}
