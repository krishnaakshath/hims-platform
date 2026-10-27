import type { PatientLabOrderRow } from '@/lib/queries/lab-orders'
import { normalizeCode, type CodeBinding } from '@/lib/coding/code-systems' // SP6
import type { FhirCodeableConcept, FhirReference } from './types'
import { fhirObservationStatusFor } from '@/lib/labs/status' // SP5
import { codingFor } from './condition' // SP6
import type { Interpretation } from '@/lib/labs/analytes' // WS4 T10
import type { AnalyteResultRow } from '@/lib/queries/lab-result-values' // WS4 T10

export interface FhirObservation {
  resourceType: 'Observation'
  id: string
  status: 'preliminary' | 'final' // SP5: resulted = preliminary; verified/reported = final
  subject: FhirReference
  code: FhirCodeableConcept
  valueQuantity?: { value: number; unit?: string }
  valueString?: string
  referenceRange?: { text: string }[]
  interpretation: FhirCodeableConcept[]
  effectiveDateTime: string
  hasMember?: FhirReference[] // WS4 T10: a panel's analyte Observations
}

// WS4 T10: v3 ObservationInterpretation codes. A summary flag maps to N / A / AA; an analyte
// carries its own directional interpretation (L/H, LL/HH) from the flagging rules.
export const INTERPRETATION_CODE: Record<Interpretation, string> = { N: 'N', L: 'L', H: 'H', LL: 'LL', HH: 'HH', A: 'A', AA: 'AA' }
const FLAG_INTERPRETATION: Record<'normal' | 'abnormal' | 'critical', Interpretation> = { normal: 'N', abnormal: 'A', critical: 'AA' }
const INTERPRETATION_SYSTEM = 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation'
const interpretationOf = (i: Interpretation): FhirCodeableConcept[] => [{ coding: [{ system: INTERPRETATION_SYSTEM, code: INTERPRETATION_CODE[i] }] }]

function valueOf(value: string, unit: string | null): Pick<FhirObservation, 'valueQuantity' | 'valueString'> {
  const numeric = Number(value)
  const isNumeric = value.trim() !== '' && Number.isFinite(numeric)
  return isNumeric ? { valueQuantity: { value: numeric, ...(unit ? { unit } : {}) } } : { valueString: value }
}

// `code.coding` carries the lab test's code + display. `labTests.code` is reference data shaped like
// a LOINC code but never verified against a real LOINC release, so on its own it gets NO `system`
// URI. SP6 ruling 11: when the same code value is present and active in the CURRENT, loaded,
// non-sample LOINC version (`loinc`, found by gather's `loincBindings`), the coding gains
// `system: 'http://loinc.org'` and that version -- through the shared `codingFor`.
export function observationToFhir(patientId: string, order: PatientLabOrderRow, loinc: CodeBinding | null = null): FhirObservation | null {
  if (!order.result) return null
  // SP5: only resulted (preliminary) and verified/reported (final) orders carry an Observation.
  const status = fhirObservationStatusFor(order.status)
  if (status === null) return null
  const { result } = order

  return {
    resourceType: 'Observation',
    id: `observation-${order.id}`,
    status,
    subject: { reference: `Patient/${patientId}` },
    code: { text: order.testName, coding: codingFor(order.testCode, order.testName, loinc && loinc.kind === 'loinc' ? loinc : null) },
    ...valueOf(result.value, result.unit),
    ...(result.referenceRange ? { referenceRange: [{ text: result.referenceRange }] } : {}),
    interpretation: interpretationOf(FLAG_INTERPRETATION[result.flag]),
    effectiveDateTime: result.resultedAt.toISOString(),
  }
}

const loincOnly = (b: CodeBinding | undefined): CodeBinding | null => (b && b.kind === 'loinc' ? b : null)

/**
 * The FHIR id of an analyte's Observation, used for both its `id` and the panel's `hasMember`
 * reference. Analyte codes allow "_" (^[A-Z][A-Z0-9_]{0,15}$), which a FHIR id ([A-Za-z0-9\-.])
 * does not, so "_" becomes "-".
 */
export function analyteObservationId(orderId: number, analyteCode: string): string {
  return `observation-${orderId}-${analyteCode.replace(/_/g, '-')}`
}

/**
 * WS4 T10 (spec 3.7 item 31): the Observations of one order. A single-value test is the one
 * Observation of observationToFhir. An analyte test is a panel `observation-<orderId>` with no
 * value and a `hasMember` per analyte, then one `observation-<orderId>-<analyteCode>` per analyte
 * in definition order. An analyte is coded by its LOINC code when it has one (with the LOINC
 * system only when that code is in a loaded, non-sample LOINC version: the same codingFor rule as
 * the test code), else by its own code without a system.
 */
export function observationsForOrder(patientId: string, order: PatientLabOrderRow, bindings: Map<string, CodeBinding>): FhirObservation[] {
  const panel = observationToFhir(patientId, order, bindings.get(normalizeCode(order.testCode)) ?? null)
  if (panel === null) return []
  const analytes: AnalyteResultRow[] = order.result?.analytes ?? []
  if (analytes.length === 0) return [panel]
  const memberId = (a: AnalyteResultRow) => analyteObservationId(order.id, a.code)
  const members: FhirObservation[] = analytes.map((a) => ({
    resourceType: 'Observation',
    id: memberId(a),
    status: panel.status,
    subject: panel.subject,
    code: {
      text: a.name,
      coding: a.loincCode
        ? codingFor(a.loincCode, a.name, loincOnly(bindings.get(normalizeCode(a.loincCode))))
        : codingFor(a.code, a.name, null),
    },
    ...valueOf(a.value, a.unit),
    ...(a.referenceRange ? { referenceRange: [{ text: a.referenceRange }] } : {}),
    interpretation: interpretationOf(a.interpretation ?? FLAG_INTERPRETATION[a.flag]),
    effectiveDateTime: panel.effectiveDateTime,
  }))
  // The panel keeps its code, status and summary interpretation but carries no value of its own.
  const head: FhirObservation = { ...panel, hasMember: members.map((m) => ({ reference: `Observation/${m.id}` })) }
  delete head.valueQuantity
  delete head.valueString
  delete head.referenceRange
  return [head, ...members]
}

// Filters to orders whose `.result` is non-null -- a `resulted`-status order
// is expected to have one, but this trusts the join's actual result field,
// not the status field, so a data anomaly (e.g. status says `resulted` but
// the result row is somehow missing) can't silently fabricate an
// Observation with made-up values. WS4 T10: an analyte test contributes its panel and members.
export function observationsToFhir(patientId: string, orders: PatientLabOrderRow[], loincBindings: Map<string, CodeBinding> = new Map()): FhirObservation[] {
  return orders.flatMap((o) => observationsForOrder(patientId, o, loincBindings))
}
