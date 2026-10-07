import type { PatientLabOrderRow } from '@/lib/queries/lab-orders'
import { normalizeCode, type CodeBinding } from '@/lib/coding/code-systems' // SP6
import type { FhirCodeableConcept, FhirReference } from './types'
import { codingFor } from './condition' // SP6

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

// `code.coding` carries the lab test's code + display. `labTests.code` is reference data shaped like
// a LOINC code but never verified against a real LOINC release, so on its own it gets NO `system`
// URI. SP6 ruling 11: when the same code value is present and active in the CURRENT, loaded,
// non-sample LOINC version (`loinc`, found by gather's `loincBindings`), the coding gains
// `system: 'http://loinc.org'` and that version -- through the shared `codingFor`.
export function observationToFhir(patientId: string, order: PatientLabOrderRow, loinc: CodeBinding | null = null): FhirObservation | null {
  if (!order.result) return null
  const { result } = order
  const numeric = Number(result.value)
  const isNumeric = result.value.trim() !== '' && Number.isFinite(numeric)

  return {
    resourceType: 'Observation',
    id: `observation-${order.id}`,
    status: 'final',
    subject: { reference: `Patient/${patientId}` },
    code: { text: order.testName, coding: codingFor(order.testCode, order.testName, loinc && loinc.kind === 'loinc' ? loinc : null) },
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
export function observationsToFhir(patientId: string, orders: PatientLabOrderRow[], loincBindings: Map<string, CodeBinding> = new Map()): FhirObservation[] {
  return orders
    .map((o) => observationToFhir(patientId, o, loincBindings.get(normalizeCode(o.testCode)) ?? null))
    .filter((o): o is FhirObservation => o !== null)
}
