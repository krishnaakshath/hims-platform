import type { allergies } from '@/db/schema'
import type { FhirCodeableConcept, FhirReference } from './types'

export interface FhirAllergyIntolerance {
  resourceType: 'AllergyIntolerance'
  id: string
  patient: FhirReference
  code: FhirCodeableConcept
  reaction: { manifestation: FhirCodeableConcept[]; severity: 'mild' | 'moderate' | 'severe' }[]
}

// `code.text` only -- this app has no coded (RxNorm/SNOMED) allergen data,
// so a `coding` array here would fabricate a terminology binding that was
// never actually made (spec §3).
export function allergyToFhir(allergy: typeof allergies.$inferSelect): FhirAllergyIntolerance {
  return {
    resourceType: 'AllergyIntolerance',
    id: `allergy-${allergy.id}`,
    patient: { reference: `Patient/${allergy.patientId}` },
    code: { text: allergy.allergen },
    reaction: [{ manifestation: [{ text: allergy.reaction ?? 'Not specified' }], severity: allergy.severity }],
  }
}

export function allergiesToFhir(rows: (typeof allergies.$inferSelect)[]): FhirAllergyIntolerance[] {
  return rows.map(allergyToFhir)
}
