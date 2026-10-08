import type { ClaimDocumentKind, ClaimType, PolicyRelationship } from '@/lib/rcm/constants'

// Profile URLs, CodeSystems and identifier systems for NHCX bundles. All from
// the NRCeS "FHIR Implementation Guide for ABDM" 6.5.0 (S5) unless marked.

export const NRCES = 'https://nrces.in/ndhm/fhir/r4'
const sd = (n: string) => `${NRCES}/StructureDefinition/${n}`
export const PROFILE = {
  Claim: sd('Claim'), ClaimBundle: sd('ClaimBundle'), ClaimResponse: sd('ClaimResponse'), ClaimResponseBundle: sd('ClaimResponseBundle'),
  Coverage: sd('Coverage'), CoverageEligibilityRequest: sd('CoverageEligibilityRequest'), CoverageEligibilityRequestBundle: sd('CoverageEligibilityRequestBundle'),
  CoverageEligibilityResponse: sd('CoverageEligibilityResponse'), CoverageEligibilityResponseBundle: sd('CoverageEligibilityResponseBundle'),
  Communication: sd('Communication'), CommunicationRequest: sd('CommunicationRequest'), PaymentNotice: sd('PaymentNotice'), Task: sd('Task'),
  TaskBundle: sd('TaskBundle'), Patient: sd('Patient'), Organization: sd('Organization'), Practitioner: sd('Practitioner'),
} as const

const cs = (n: string) => `${NRCES}/CodeSystem/${n}`
export const CS_IDENTIFIER_TYPE = cs('ndhm-identifier-type-code')
export const CS_SUPPORTINGINFO_CATEGORY = cs('ndhm-supportinginfo-category')
export const CS_SUPPORTINGINFO_CODE = cs('ndhm-supportinginfo-code')
export const CS_TASK_CODES = cs('ndhm-task-codes')
export const CS_TASK_OUTPUT_TYPE = cs('ndhm-task-output-type')
export const CS_TASK_OUTPUT_VALUE = cs('ndhm-task-output-value')
export const CS_ADJUDICATION_REASON = cs('ndhm-adjudication-reason')
export const CS_RELATED_CLAIM = cs('ndhm-related-claim-relationship-code')

export const V2_0203 = 'http://terminology.hl7.org/CodeSystem/v2-0203'
export const SNOMED = 'http://snomed.info/sct'
export const PROCESS_PRIORITY = 'http://terminology.hl7.org/CodeSystem/processpriority'
export const ACT_CODE = 'http://terminology.hl7.org/CodeSystem/v3-ActCode'
export const SUBSCRIBER_RELATIONSHIP = 'http://terminology.hl7.org/CodeSystem/subscriber-relationship'
export const ORG_TYPE = 'http://terminology.hl7.org/CodeSystem/organization-type'
export const ADJUDICATION = 'http://terminology.hl7.org/CodeSystem/adjudication'
export const FINANCIAL_TASK_INPUT = 'http://terminology.hl7.org/CodeSystem/financialtaskinputtype'
export const FINANCIAL_TASK_CODE = 'http://terminology.hl7.org/CodeSystem/financialtaskcode'
export const COMM_CATEGORY = 'http://terminology.hl7.org/CodeSystem/communication-category'

export const HFR_SYSTEM = 'https://facility.ndhm.gov.in'
export const ROHINI_SYSTEM = 'https://rohini.iib.gov.in/'
/** The HPR (doctor registry) namespace; reserved for a future HPR id field (A7). */
export const PRACTITIONER_SYSTEM = 'https://doctor.ndhm.gov.in'

export type LocalKind = 'service-code' | 'policy-number' | 'payer-code' | 'claim-number' | 'eligibility' | 'communication'

/** Hospital-local namespaces (honest, our own; payer acceptance is UNVERIFIED U15). Same pattern as uhidSystem. */
export function localSystem(kind: LocalKind): string {
  const base = process.env.NEXT_PUBLIC_APP_URL
  return base ? `${base}/fhir/sid/${kind}` : `urn:x-local:${kind}`
}

export type FhirCoding = { system: string; code: string; display?: string; version?: string }

export const CLAIM_TYPE_CODING: Record<ClaimType, FhirCoding> = {
  ipd: { system: SNOMED, code: '737481003', display: 'Inpatient care management (procedure)' },
  daycare: { system: SNOMED, code: '737850002', display: 'Day care case management (procedure)' },
  opd: { system: SNOMED, code: '737492002', display: 'Outpatient care management (procedure)' },
}

export const DIAGNOSIS_TYPE_CODING: Record<'primary' | 'secondary' | 'provisional', FhirCoding> = {
  provisional: { system: SNOMED, code: '148006', display: 'Preliminary diagnosis (contextual qualifier) (qualifier value)' },
  primary: { system: SNOMED, code: '89100005', display: 'Final diagnosis (discharge) (contextual qualifier) (qualifier value)' },
  secondary: { system: SNOMED, code: '89100005', display: 'Final diagnosis (discharge) (contextual qualifier) (qualifier value)' },
}

/** S5 ndhm-supportinginfo-category / -code (codes only; displays are not asserted here). */
export const DOCUMENT_KIND_SUPPORTING_INFO: Record<ClaimDocumentKind, { category: string; code: string }> = {
  id_proof: { category: 'POI', code: 'PIC' },
  policy_card: { category: 'BVC', code: 'AT' },
  claim_form: { category: 'FCF', code: 'AT' },
  discharge_summary: { category: 'HDS', code: 'AT' },
  itemised_bill: { category: 'MB', code: 'FB' },
  investigation_reports: { category: 'DIA', code: 'LIR' },
  preauth_approval: { category: 'CIL', code: 'AT' },
  operation_notes: { category: 'CD', code: 'OSN' },
  prescription: { category: 'CD', code: 'DRP' },
  query_response: { category: 'INF', code: 'AT' },
  appeal_letter: { category: 'OTH', code: 'AT' },
  settlement_advice: { category: 'OTH', code: 'AT' },
  other: { category: 'OTH', code: 'AT' },
}

export const RELATIONSHIP_CODING: Record<PolicyRelationship, string> = {
  self: 'self', spouse: 'spouse', child: 'child', parent: 'parent', sibling: 'other', other: 'other',
}
