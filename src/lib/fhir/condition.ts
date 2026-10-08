import { fhirSystemFor, type CodeBinding } from '@/lib/coding/code-systems'
import type { DiagnosisFhirRow } from './gather'
import type { FhirCodeableConcept, FhirCoding, FhirReference } from './types'

export interface FhirCondition {
  resourceType: 'Condition'
  id: string
  subject: FhirReference
  category: FhirCodeableConcept[]
  verificationStatus?: FhirCodeableConcept
  encounter?: FhirReference
  code: FhirCodeableConcept
  recordedDate: string | null
}

const CONDITION_CATEGORY = 'http://terminology.hl7.org/CodeSystem/condition-category'
const CONDITION_VER_STATUS = 'http://terminology.hl7.org/CodeSystem/condition-ver-status'

// SP6 ruling 11 (replaces the SP1 "system deliberately omitted" rule): a coding carries a `system`
// URI and `version` ONLY when the code came from a loaded, NON-SAMPLE code system -- for diagnoses
// and procedures that is the code system joined through `code_id` (the `binding`), for lab tests a
// matching code in the current loaded LOINC version. Everything else keeps the honest SP1
// behaviour: legacy free-text diagnoses (no encounter, never coded against any terminology) and
// codes from the fictional SAMPLE- fixtures emit the bare code + display with no system, HBP
// package codes get no system until SP8 confirms the NHCX URI, and an empty code value (an SP6
// free-text entry stores code = '') emits no coding at all, only the text.
export function codingFor(code: string, display: string | null, binding: CodeBinding | null): FhirCoding[] | undefined {
  if (code === '') return undefined
  const system = binding ? fhirSystemFor(binding) : null
  return [{
    ...(system && binding ? { system, version: binding.version } : {}),
    code,
    ...(display ? { display } : {}),
  }]
}

/** A CodeableConcept with the text and, when there is a code, its coding. */
export function codedConcept(text: string, coding: FhirCoding[] | undefined): FhirCodeableConcept {
  return coding ? { text, coding } : { text }
}

export function conditionToFhir(row: DiagnosisFhirRow): FhirCondition {
  const linked = row.encounterId !== null
  const verification = row.diagnosisType === 'provisional' ? 'provisional' : row.diagnosisType ? 'confirmed' : null
  return {
    resourceType: 'Condition',
    id: `condition-${row.id}`,
    subject: { reference: `Patient/${row.patientId}` },
    category: [{ coding: [{ system: CONDITION_CATEGORY, code: linked ? 'encounter-diagnosis' : 'problem-list-item' }] }],
    ...(verification ? { verificationStatus: { coding: [{ system: CONDITION_VER_STATUS, code: verification }] } } : {}),
    ...(linked ? { encounter: { reference: `Encounter/encounter-${row.encounterId}` } } : {}),
    code: codedConcept(row.description, codingFor(row.code, row.codeDisplay ?? row.description, row.binding)),
    recordedDate: row.date,
  }
}

export function conditionsToFhir(rows: DiagnosisFhirRow[]): FhirCondition[] {
  return rows.map(conditionToFhir)
}
