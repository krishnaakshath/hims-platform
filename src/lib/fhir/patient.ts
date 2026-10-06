import type { patients } from '@/db/schema'

export interface FhirPatient {
  resourceType: 'Patient'
  id: string
  identifier: { value: string }[]
  name: { text: string }[]
  birthDate: string
}

// No `gender` field: `patients` has no gender/sex column in this app's schema
// today, and FHIR's `gender` is optional -- omitting it is honest, a
// fabricated value would not be.
export function patientToFhir(patient: typeof patients.$inferSelect): FhirPatient {
  return {
    resourceType: 'Patient',
    id: patient.id,
    identifier: [{ value: patient.id }],
    name: [{ text: patient.name }],
    birthDate: patient.dob,
  }
}
