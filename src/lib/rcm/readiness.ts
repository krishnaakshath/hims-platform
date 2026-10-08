// SP7 claim readiness engine (pure, client-safe). A claim is ready when no `block` item
// remains; `warn` items travel with the submission as warnings.
import { formatPaise } from '@/lib/format'
import { formatIsoDate } from '@/lib/india-time'
import { CLAIM_DOCUMENT_KINDS, CLAIM_DOCUMENT_KIND_LABEL, type ClaimDocumentKind, type ClaimType, type EmpanelmentStatus } from './constants'
import { isLiveApprovedPreauth, type PreauthStatus } from './preauth-status'

export const DEFAULT_REQUIRED_DOCUMENTS: Record<ClaimType, readonly ClaimDocumentKind[]> = {
  ipd: ['id_proof', 'policy_card', 'claim_form', 'discharge_summary', 'itemised_bill', 'investigation_reports', 'preauth_approval'],
  daycare: ['id_proof', 'policy_card', 'claim_form', 'discharge_summary', 'itemised_bill', 'investigation_reports', 'preauth_approval'],
  opd: ['id_proof', 'policy_card', 'itemised_bill', 'prescription'],
}

/** The defaults, plus per-payer `required: true` overrides, minus `required: false`, in CLAIM_DOCUMENT_KINDS order. */
export function requiredDocumentKinds(claimType: ClaimType, overrides: { documentKind: ClaimDocumentKind; required: boolean }[]): ClaimDocumentKind[] {
  const set = new Set<ClaimDocumentKind>(DEFAULT_REQUIRED_DOCUMENTS[claimType])
  for (const o of overrides) {
    if (o.required) set.add(o.documentKind)
    else set.delete(o.documentKind)
  }
  return CLAIM_DOCUMENT_KINDS.filter((k) => set.has(k))
}

export const READINESS_CODES = [
  'no_invoices', 'invoice_not_finalised', 'invoice_cancelled', 'claimed_exceeds_invoice', 'coding_not_finalised',
  'policy_inactive', 'policy_expired', 'tpa_not_linked', 'preauth_missing', 'preauth_not_approved', 'preauth_expired',
  'claimed_exceeds_preauth', 'sum_insured_exceeded', 'document_missing', 'patient_dob_missing', 'patient_gender_missing',
  'abha_missing', 'hospital_ids_missing', 'payer_not_empanelled',
] as const
export type ReadinessCode = (typeof READINESS_CODES)[number]

export interface ReadinessItem { code: ReadinessCode; severity: 'block' | 'warn'; message: string; documentKind?: ClaimDocumentKind }

export interface ClaimReadinessInput {
  claimType: ClaimType
  claimedPaise: number
  episodeStartDate: string
  invoices: { id: number; number: string | null; status: 'draft' | 'finalised' | 'cancelled' | 'discarded'; totalPaise: number | null; claimedPaise: number }[]
  coding: { finalised: boolean } | null
  policy: { status: 'active' | 'inactive'; validFrom: string; validTo: string; sumInsuredPaise: number | null; hasTpa: boolean }
  tpaLinkedToInsurer: boolean
  payer: { requiresPreauthForIpd: boolean; requiresAbha: boolean; empanelmentStatus: EmpanelmentStatus }
  preauth: { status: PreauthStatus; approvedPaise: number | null; validUntil: string | null } | null
  requiredDocuments: ClaimDocumentKind[]
  presentDocuments: ClaimDocumentKind[]
  patient: { dob: string | null; gender: string | null; hasAbha: boolean }
  hospital: { rohiniId: string | null }
}

const invoiceLabel = (i: { id: number; number: string | null }) => i.number ?? `draft #${i.id}`

export function checkClaimReadiness(input: ClaimReadinessInput): { ready: boolean; items: ReadinessItem[] } {
  const items: ReadinessItem[] = []
  const block = (code: ReadinessCode, message: string, documentKind?: ClaimDocumentKind) =>
    items.push(documentKind ? { code, severity: 'block', message, documentKind } : { code, severity: 'block', message })
  const warn = (code: ReadinessCode, message: string) => items.push({ code, severity: 'warn', message })

  if (input.invoices.length === 0) block('no_invoices', 'Add at least one finalised invoice')
  for (const inv of input.invoices) {
    if (inv.status === 'draft' || inv.status === 'discarded') block('invoice_not_finalised', `Invoice draft #${inv.id} is not finalised`)
  }
  for (const inv of input.invoices) {
    if (inv.status === 'cancelled') block('invoice_cancelled', `Invoice ${invoiceLabel(inv)} was cancelled by a credit note; remove it from the claim`)
  }
  for (const inv of input.invoices) {
    if (inv.totalPaise !== null && inv.claimedPaise > inv.totalPaise) block('claimed_exceeds_invoice', `The amount claimed on ${invoiceLabel(inv)} is more than its total`)
  }
  if (input.coding === null || !input.coding.finalised) block('coding_not_finalised', 'Clinical coding for this visit or stay is not finalised')

  const { policy } = input
  if (policy.status === 'inactive') block('policy_inactive', 'The policy is marked inactive')
  if (input.episodeStartDate < policy.validFrom || input.episodeStartDate > policy.validTo) {
    block('policy_expired', `The policy was not valid on ${formatIsoDate(input.episodeStartDate)}`)
  }
  if (policy.hasTpa && !input.tpaLinkedToInsurer) warn('tpa_not_linked', 'This TPA is not recorded as servicing this insurer')

  const { preauth } = input
  if (input.claimType !== 'opd' && input.payer.requiresPreauthForIpd && preauth === null) {
    block('preauth_missing', 'This insurer needs an approved pre-authorisation for inpatient claims')
  }
  if (preauth !== null) {
    if (!isLiveApprovedPreauth(preauth.status)) block('preauth_not_approved', 'The linked pre-authorisation is not approved')
    if (preauth.validUntil !== null && preauth.validUntil < input.episodeStartDate) warn('preauth_expired', 'The pre-authorisation validity ended before admission')
    if (preauth.approvedPaise !== null && input.claimedPaise > preauth.approvedPaise) {
      warn('claimed_exceeds_preauth', `The claim is ${formatPaise(input.claimedPaise - preauth.approvedPaise)} more than the pre-authorised amount; request an enhancement or expect a deduction`)
    }
  }
  if (policy.sumInsuredPaise !== null && input.claimedPaise > policy.sumInsuredPaise) {
    warn('sum_insured_exceeded', `The claim exceeds the sum insured (${formatPaise(policy.sumInsuredPaise)})`)
  }

  const present = new Set(input.presentDocuments)
  for (const kind of input.requiredDocuments) {
    if (!present.has(kind)) block('document_missing', `Missing document: ${CLAIM_DOCUMENT_KIND_LABEL[kind]}`, kind)
  }

  if (input.patient.dob === null) block('patient_dob_missing', 'The patient\'s date of birth is missing')
  if (input.patient.gender === null) block('patient_gender_missing', 'The patient\'s gender is missing')
  if (input.payer.requiresAbha && !input.patient.hasAbha) block('abha_missing', 'This payer needs the patient\'s ABHA number')
  if (input.hospital.rohiniId === null) warn('hospital_ids_missing', 'Set the hospital ROHINI ID in RCM settings')
  if (input.payer.empanelmentStatus !== 'empanelled') warn('payer_not_empanelled', 'The hospital is not recorded as empanelled with this payer')

  return { ready: !items.some((i) => i.severity === 'block'), items }
}
