import type { diagnoses } from '@/db/schema'
import type { FhirCodeableConcept, FhirReference } from './types'

export interface FhirCondition {
  resourceType: 'Condition'
  id: string
  subject: FhirReference
  code: FhirCodeableConcept
  recordedDate: string | null
}

// `system` is deliberately omitted from `code.coding` -- unlike
// `labTests.code` (seed/reference data this app has never claimed is
// verified against a real LOINC code set), `diagnoses.code` has no positive
// confirmation of being verified against a real ICD-10-CM code set either.
// This mapping includes the code *value* (useful, low-risk) but never
// asserts a `system` URI (e.g. http://hl7.org/fhir/sid/icd-10-cm), since a
// FHIR resource claiming a coded system+code when the underlying data was
// never actually coded against that terminology is worse than honest free
// text.
export function conditionToFhir(diagnosis: typeof diagnoses.$inferSelect): FhirCondition {
  return {
    resourceType: 'Condition',
    id: `condition-${diagnosis.id}`,
    subject: { reference: `Patient/${diagnosis.patientId}` },
    code: { text: diagnosis.description, coding: [{ code: diagnosis.code, display: diagnosis.description }] },
    recordedDate: diagnosis.date,
  }
}

export function conditionsToFhir(rows: (typeof diagnoses.$inferSelect)[]): FhirCondition[] {
  return rows.map(conditionToFhir)
}
