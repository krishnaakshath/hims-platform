// SP7 RCM constants (pure, client-safe). Enum value lists are mirrored by the pgEnums in
// src/db/schema.ts (// SP7 block); tests/db/sp7-*-schema.test.ts pins them equal.

export const PAYER_KINDS = ['insurer', 'tpa', 'government_scheme', 'corporate'] as const
export type PayerKind = (typeof PAYER_KINDS)[number]
export const PAYER_KIND_LABEL: Record<PayerKind, string> = {
  insurer: 'Insurer',
  tpa: 'TPA',
  government_scheme: 'Government scheme',
  corporate: 'Corporate',
}
/** Payer kinds that may sit in a policy's insurer field (a TPA services, it does not insure). */
export const INSURER_SIDE_KINDS: readonly PayerKind[] = ['insurer', 'government_scheme', 'corporate']

export const SUBMISSION_CHANNELS = ['portal', 'email', 'nhcx', 'courier', 'hand_delivery'] as const
export type SubmissionChannel = (typeof SUBMISSION_CHANNELS)[number]
export const CHANNEL_LABEL: Record<SubmissionChannel, string> = {
  portal: 'Insurer/TPA portal',
  email: 'Email',
  nhcx: 'NHCX',
  courier: 'Courier',
  hand_delivery: 'Hand delivery',
}

export const EMPANELMENT_STATUSES = ['empanelled', 'pending', 'suspended', 'not_empanelled'] as const
export type EmpanelmentStatus = (typeof EMPANELMENT_STATUSES)[number]

export const POLICY_TYPES = ['individual', 'family_floater', 'group_corporate', 'government_scheme'] as const
export type PolicyType = (typeof POLICY_TYPES)[number]
export const POLICY_RELATIONSHIPS = ['self', 'spouse', 'child', 'parent', 'sibling', 'other'] as const
export type PolicyRelationship = (typeof POLICY_RELATIONSHIPS)[number]
export const POLICY_PRIORITIES = ['primary', 'secondary'] as const
export type PolicyPriority = (typeof POLICY_PRIORITIES)[number]
export const POLICY_STATUSES = ['active', 'inactive'] as const
export type PolicyStatus = (typeof POLICY_STATUSES)[number]

export const CLAIM_TYPES = ['ipd', 'daycare', 'opd'] as const
export type ClaimType = (typeof CLAIM_TYPES)[number]

export const CLAIM_DOCUMENT_KINDS = [
  'id_proof', 'policy_card', 'claim_form', 'discharge_summary', 'itemised_bill', 'investigation_reports',
  'preauth_approval', 'operation_notes', 'prescription', 'query_response', 'appeal_letter', 'settlement_advice', 'other',
] as const
export type ClaimDocumentKind = (typeof CLAIM_DOCUMENT_KINDS)[number]
export const CLAIM_DOCUMENT_KIND_LABEL: Record<ClaimDocumentKind, string> = {
  id_proof: 'Photo ID proof',
  policy_card: 'Policy or TPA card',
  claim_form: 'Claim form',
  discharge_summary: 'Discharge summary',
  itemised_bill: 'Itemised final bill',
  investigation_reports: 'Investigation reports',
  preauth_approval: 'Pre-authorisation approval letter',
  operation_notes: 'Operation notes',
  prescription: 'Prescription',
  query_response: 'Query response',
  appeal_letter: 'Appeal letter',
  settlement_advice: 'Settlement advice',
  other: 'Other document',
}

// Ruling 9: an ID-proof upload names its type from this list. There is no national-ID
// number type; a masked UID card needs an explicit "first 8 digits hidden" confirmation.
export const ID_PROOF_TYPES = ['pan', 'voter_id', 'passport', 'driving_licence', 'masked_uid', 'other_government_id'] as const
export type IdProofType = (typeof ID_PROOF_TYPES)[number]
export const ID_PROOF_TYPE_LABEL: Record<IdProofType, string> = {
  pan: 'PAN card',
  voter_id: 'Voter ID',
  passport: 'Passport',
  driving_licence: 'Driving licence',
  masked_uid: 'Masked UID card (first 8 digits hidden)',
  other_government_id: 'Other government photo ID',
}

export const DOCUMENT_SOURCES = ['upload', 'invoice', 'lab_report', 'discharge_summary', 'preauth_letter', 'policy_card', 'waiver'] as const
export type DocumentSource = (typeof DOCUMENT_SOURCES)[number]

export const REASON_CATEGORIES = ['disallowance', 'rejection', 'query', 'write_off'] as const
export type ReasonCategory = (typeof REASON_CATEGORIES)[number]
export const SUBMISSION_KINDS = ['initial', 'query_response', 'appeal', 'resubmission'] as const
export type SubmissionKind = (typeof SUBMISSION_KINDS)[number]
export const RCM_QUERY_STATUSES = ['open', 'answered', 'closed'] as const
export type RcmQueryStatus = (typeof RCM_QUERY_STATUSES)[number]
export const WRITE_OFF_STATUSES = ['requested', 'approved', 'rejected'] as const
export type WriteOffStatus = (typeof WRITE_OFF_STATUSES)[number]

// Ruling 15: under the platform request-body limit.
export const RCM_UPLOAD_MAX_BYTES = 4_000_000
export const RCM_UPLOAD_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const
export type RcmUploadType = (typeof RCM_UPLOAD_TYPES)[number]

/** `CLM-2026-000123` / `PA-2026-000123` (ruling 8: sequence numbers, gaps allowed). */
export function formatRcmNumber(prefix: 'PA' | 'CLM', istYear: string, value: number): string {
  if (!/^\d{4}$/.test(istYear)) throw new RangeError('The year must have four digits')
  if (!Number.isSafeInteger(value) || value < 1 || value > 999_999) throw new RangeError('The number must be from 1 to 999999')
  return `${prefix}-${istYear}-${String(value).padStart(6, '0')}`
}

/** How an estimate line was priced (SP2 resolver scope). */
export const PRICE_SOURCE_LABEL: Record<string, string> = { base: 'Base rate', department: 'Department rate', payer: 'Payer rate', manual: 'Manual', pharmacy: 'Pharmacy' }
