import type { PatientLabOrderRow } from '@/lib/queries/lab-orders'
import type { FhirCodeableConcept, FhirReference } from './types'

export interface FhirObservation {
  resourceType: 'Observation'
  id: string
  status: 'final'
  subject: FhirReference
  code: FhirCodeableConcept
  valueQuantity?: { value: number; unit?: string }
  valueString?: string
  referenceRange?: { text: string }[]
  interpretation: FhirCodeableConcept[]
  effectiveDateTime: string
}

const INTERPRETATION_CODE: Record<'normal' | 'abnormal' | 'critical', string> = { normal: 'N', abnormal: 'A', critical: 'AA' }

// `code.coding` is the one place this module includes a real `code`+`display`
// pair (every other resource here carries free text only, with no
// system/code that this app never actually assigned). `labTests.code` is
// seed/reference data shaped like a LOINC code, but this codebase has never
// verified it against a real LOINC database -- so, consistent with the
// same "never claim a coded system you didn't actually code against"
// discipline used for Condition and the med resources, this deliberately
// omits a `system` URI (e.g. http://loinc.org) even here. Only the bare
// code+display travels, not a claimed LOINC system binding.
export function observationToFhir(patientId: string, order: PatientLabOrderRow): FhirObservation | null {
  if (!order.result) return null
  const { result } = order
  const numeric = Number(result.value)
  const isNumeric = result.value.trim() !== '' && Number.isFinite(numeric)

  return {
    resourceType: 'Observation',
    id: `observation-${order.id}`,
    status: 'final',
    subject: { reference: `Patient/${patientId}` },
    code: { text: order.testName, coding: [{ code: order.testCode, display: order.testName }] },
    ...(isNumeric ? { valueQuantity: { value: numeric, ...(result.unit ? { unit: result.unit } : {}) } } : { valueString: result.value }),
    ...(result.referenceRange ? { referenceRange: [{ text: result.referenceRange }] } : {}),
    interpretation: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation', code: INTERPRETATION_CODE[result.flag] }] }],
    effectiveDateTime: result.resultedAt.toISOString(),
  }
}

// Filters to orders whose `.result` is non-null -- a `resulted`-status order
// is expected to have one, but this trusts the join's actual result field,
// not the status field, so a data anomaly (e.g. status says `resulted` but
// the result row is somehow missing) can't silently fabricate an
// Observation with made-up values.
export function observationsToFhir(patientId: string, orders: PatientLabOrderRow[]): FhirObservation[] {
  return orders.map((o) => observationToFhir(patientId, o)).filter((o): o is FhirObservation => o !== null)
}
