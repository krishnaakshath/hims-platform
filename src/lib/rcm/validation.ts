// SP7 RCM request schemas (client-safe zod v4). Every object is strict. Refined schemas are
// built from unrefined bases so `.pick` / `.extend` / `.partial` never run on a refined object.
import { z } from 'zod'
import { isoDateSchema } from '@/lib/follow-ups/validation'
import { isValidGstin } from '@/lib/billing/gst'
import { paymentReferenceProblem } from '@/lib/billing/validation'
import { MAX_DOCUMENT_PAISE } from '@/lib/billing/amounts'
import { isIndianStateCode } from '@/lib/india/reference'
import {
  CLAIM_DOCUMENT_KINDS, CLAIM_TYPES, EMPANELMENT_STATUSES, ID_PROOF_TYPES, PAYER_KINDS, POLICY_PRIORITIES, POLICY_RELATIONSHIPS,
  POLICY_STATUSES, POLICY_TYPES, SUBMISSION_CHANNELS,
} from './constants'
import { looksLikeNationalId, NATIONAL_ID_MESSAGE } from './identifier-guard'

const positiveInt = z.number().int().positive()
const paise = z.number().int().min(0).max(MAX_DOCUMENT_PAISE)
const positivePaise = z.number().int().min(1).max(MAX_DOCUMENT_PAISE)
const trimmed = (min: number, max: number) => z.string().trim().min(min).max(max)
const isoDate = isoDateSchema
const reasonCode = z.string().regex(/^[A-Z0-9_]{2,16}$/, 'Choose a reason code')
const reference = z.string().trim().regex(/^[A-Za-z0-9/-]{1,40}$/, 'Use letters, digits, / and - only (up to 40)')
const uniqueBy = <T>(items: T[], key: (t: T) => unknown) => new Set(items.map(key)).size === items.length

// ---- payers -------------------------------------------------------------------------------

const GSTIN_MESSAGE = 'Enter a valid 15-character GSTIN'
const payerProfileBase = z.object({
  kind: z.enum(PAYER_KINDS),
  shortName: trimmed(1, 40).optional(),
  irdaiRegistrationNo: z.string().regex(/^[0-9A-Z/-]{1,30}$/, 'Use capital letters, digits, / and - only').optional(),
  nhcxParticipantCode: trimmed(1, 100).optional(),
  defaultChannel: z.enum(SUBMISSION_CHANNELS),
  portalUrl: z.string().trim().max(300).url().refine((u) => u.startsWith('https://'), 'The portal link must start with https://').optional(),
  claimsEmail: z.string().trim().email().max(200).optional(),
  empanelmentStatus: z.enum(EMPANELMENT_STATUSES),
  empanelledFrom: isoDate.optional(),
  empanelledTo: isoDate.optional(),
  agreementReference: z.string().trim().max(80).optional(),
  preauthSlaHours: z.number().int().min(1).max(720),
  claimSettlementSlaDays: z.number().int().min(1).max(365),
  queryResponseDays: z.number().int().min(1).max(90),
  submissionWindowDays: z.number().int().min(1).max(365),
  requiresAbha: z.boolean(),
  requiresPreauthForIpd: z.boolean(),
  active: z.boolean(),
  notes: z.string().trim().max(1000).optional(),
  gstin: z.string().trim().toUpperCase().refine(isValidGstin, GSTIN_MESSAGE).nullable().optional(),
  stateCode: z.string().refine(isIndianStateCode, 'Choose a state').nullable().optional(),
}).strict()

function empanelmentDates(v: { empanelledFrom?: string; empanelledTo?: string }, ctx: z.RefinementCtx) {
  if (v.empanelledFrom && v.empanelledTo && v.empanelledTo < v.empanelledFrom) {
    ctx.addIssue({ code: 'custom', path: ['empanelledTo'], message: 'The empanelment end date is before its start' })
  }
}

export const payerProfileSchema = payerProfileBase.superRefine(empanelmentDates)
export type PayerProfileInput = z.infer<typeof payerProfileSchema>

export const payerCreateSchema = payerProfileBase.extend({
  name: trimmed(2, 200),
  code: z.string().regex(/^[A-Z0-9-]{2,30}$/, 'Use 2 to 30 capital letters, digits or -'),
}).strict().superRefine(empanelmentDates)
export type PayerCreateInput = z.infer<typeof payerCreateSchema>

export const payerContactsSchema = z.object({
  contacts: z.array(z.object({
    name: trimmed(1, 120),
    designation: z.string().trim().max(80).optional(),
    phone: z.string().trim().max(20).optional(),
    email: z.string().trim().email().max(200).optional(),
    isEscalation: z.boolean(),
  }).strict()).max(20),
}).strict()
export type PayerContactsInput = z.infer<typeof payerContactsSchema>

export const payerNetworkSchema = z.object({
  tpaPayerIds: z.array(positiveInt).max(50).refine((ids) => uniqueBy(ids, (i) => i), 'Each TPA once'),
}).strict()

export const documentRequirementsSchema = z.object({
  claimType: z.enum(CLAIM_TYPES),
  entries: z.array(z.object({ documentKind: z.enum(CLAIM_DOCUMENT_KINDS), required: z.boolean() }).strict())
    .max(CLAIM_DOCUMENT_KINDS.length)
    .refine((e) => uniqueBy(e, (x) => x.documentKind), 'Each document kind once'),
}).strict()
export type DocumentRequirementsInput = z.infer<typeof documentRequirementsSchema>

export const rcmSettingsSchema = z.object({
  rohiniId: z.string().trim().regex(/^\d{13}$/, 'The ROHINI ID has 13 digits').nullable(),
  hfrId: z.string().trim().regex(/^IN\d{10}$/, 'The HFR facility ID looks like IN followed by 10 digits').nullable(),
}).strict()
export type RcmSettingsInput = z.infer<typeof rcmSettingsSchema>

// ---- policies -----------------------------------------------------------------------------

const cardNumber = z.string().trim().regex(/^[A-Za-z0-9/-]{1,40}$/, 'Use letters, digits, / and - only (up to 40)')
const policyFields = {
  insurerPayerId: positiveInt,
  tpaPayerId: positiveInt.nullable().optional(),
  policyNumber: cardNumber,
  memberId: cardNumber,
  planName: z.string().trim().max(120).optional(),
  policyType: z.enum(POLICY_TYPES),
  corporateName: z.string().trim().max(200).optional(),
  employeeId: z.string().trim().max(40).optional(),
  holderName: trimmed(1, 200),
  relationship: z.enum(POLICY_RELATIONSHIPS),
  validFrom: isoDate,
  validTo: isoDate,
  sumInsuredPaise: paise.nullable().optional(),
  copayBp: z.number().int().min(0).max(10_000).nullable().optional(),
  roomRentLimitPaise: paise.nullable().optional(),
  priority: z.enum(POLICY_PRIORITIES),
}

function policyRefinements(
  v: { validFrom?: string; validTo?: string; policyType?: string; corporateName?: string; policyNumber?: string; memberId?: string },
  ctx: z.RefinementCtx,
) {
  if (v.validFrom && v.validTo && v.validTo < v.validFrom) ctx.addIssue({ code: 'custom', path: ['validTo'], message: 'The policy end date is before its start' })
  if (v.policyType === 'group_corporate' && !v.corporateName) ctx.addIssue({ code: 'custom', path: ['corporateName'], message: 'Enter the employer for a corporate policy' })
  if (v.policyNumber !== undefined && looksLikeNationalId(v.policyNumber)) ctx.addIssue({ code: 'custom', path: ['policyNumber'], message: NATIONAL_ID_MESSAGE })
  if (v.memberId !== undefined && looksLikeNationalId(v.memberId)) ctx.addIssue({ code: 'custom', path: ['memberId'], message: NATIONAL_ID_MESSAGE })
}

export const policySchema = z.object({
  patientId: trimmed(1, 40),
  ...policyFields,
  status: z.enum(POLICY_STATUSES).default('active'),
}).strict().superRefine(policyRefinements)
export type PolicyInput = z.infer<typeof policySchema>

export const policyPatchSchema = z.object({
  ...policyFields,
  status: z.enum(POLICY_STATUSES),
}).partial().strict()
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field')
  .superRefine(policyRefinements)
export type PolicyPatchInput = z.infer<typeof policyPatchSchema>

// ---- pre-authorisations -------------------------------------------------------------------

const estimateItems = z.array(z.object({ serviceId: positiveInt, quantity: z.number().int().min(1).max(1000) }).strict()).min(1).max(50)
const preauthCreateBase = z.object({
  policyId: positiveInt,
  claimType: z.enum(CLAIM_TYPES),
  admissionId: positiveInt.optional(),
  encounterId: positiveInt.optional(),
  plannedAdmissionDate: isoDate,
  expectedLengthOfStayDays: z.number().int().min(1).max(365),
  treatingProviderId: positiveInt,
  diagnosisCodeIds: z.array(positiveInt).max(10),
  procedureCodeIds: z.array(positiveInt).max(10),
  provisionalDiagnosisText: z.string().trim().max(500).optional(),
  estimate: estimateItems,
  requestedPaise: positivePaise.optional(),
  roomCategoryCode: trimmed(1, 20).optional(),
}).strict()

export const preauthCreateSchema = preauthCreateBase.superRefine((v, ctx) => {
  if (v.claimType === 'opd' && v.admissionId !== undefined) ctx.addIssue({ code: 'custom', path: ['admissionId'], message: 'An OPD pre-authorisation is not for an admission' })
  if (v.diagnosisCodeIds.length === 0 && !v.provisionalDiagnosisText) ctx.addIssue({ code: 'custom', path: ['diagnosisCodeIds'], message: 'Give a provisional diagnosis or a diagnosis code' })
})
export type PreauthCreateInput = z.infer<typeof preauthCreateSchema>

export const preauthEstimateSchema = preauthCreateBase.pick({ policyId: true, estimate: true, roomCategoryCode: true, plannedAdmissionDate: true }).strict()
export type PreauthEstimateInput = z.infer<typeof preauthEstimateSchema>

export const preauthActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('request') }).strict(),
  z.object({ action: z.literal('record_query'), question: trimmed(1, 2000), raisedOn: isoDate, dueOn: isoDate }).strict(),
  z.object({ action: z.literal('respond_query'), queryId: positiveInt, body: trimmed(1, 2000), respondedOn: isoDate }).strict(),
  z.object({ action: z.literal('approve'), approvedPaise: positivePaise, approvalReference: reference, validUntil: isoDate, decidedOn: isoDate }).strict(),
  z.object({ action: z.literal('reject'), reasonCode, note: z.string().trim().max(1000).optional(), decidedOn: isoDate }).strict(),
  z.object({ action: z.literal('request_enhancement'), requestedPaise: positivePaise, note: trimmed(5, 1000) }).strict(),
  z.object({ action: z.literal('approve_enhancement'), approvedPaise: positivePaise, validUntil: isoDate, approvalReference: reference.optional(), decidedOn: isoDate }).strict(),
  z.object({ action: z.literal('reject_enhancement'), reasonCode, note: z.string().trim().max(1000).optional(), decidedOn: isoDate }).strict(),
  z.object({ action: z.literal('cancel'), note: trimmed(5, 500) }).strict(),
]).superRefine((v, ctx) => {
  if (v.action === 'record_query' && v.dueOn < v.raisedOn) ctx.addIssue({ code: 'custom', path: ['dueOn'], message: 'The due date is before the query date' })
  if ((v.action === 'approve' || v.action === 'approve_enhancement') && v.validUntil < v.decidedOn) {
    ctx.addIssue({ code: 'custom', path: ['validUntil'], message: 'The approval ends before it was given' })
  }
})
export type PreauthActionRequest = z.infer<typeof preauthActionSchema>

// ---- claims -------------------------------------------------------------------------------

const claimInvoices = z.array(z.object({ invoiceId: positiveInt, claimedPaise: positivePaise.optional() }).strict())
  .min(1).max(20)
  .refine((i) => uniqueBy(i, (x) => x.invoiceId), 'Each invoice once')

export const claimCreateSchema = z.object({
  policyId: positiveInt,
  claimType: z.enum(CLAIM_TYPES),
  admissionId: positiveInt.optional(),
  encounterId: positiveInt.optional(),
  preauthId: positiveInt.optional(),
  invoices: claimInvoices,
}).strict().superRefine((v, ctx) => {
  const ok = v.claimType === 'opd' ? v.encounterId !== undefined && v.admissionId === undefined : v.admissionId !== undefined
  if (!ok) ctx.addIssue({ code: 'custom', path: ['claimType'], message: 'An OPD claim is for a visit; an inpatient or daycare claim is for an admission' })
})
export type ClaimCreateInput = z.infer<typeof claimCreateSchema>

export const claimInvoicesSchema = z.object({ invoices: claimInvoices }).strict()

export const claimDocumentMetaSchema = z.object({
  kind: z.enum(CLAIM_DOCUMENT_KINDS),
  title: trimmed(1, 120),
  idProofType: z.enum(ID_PROOF_TYPES).optional(),
  maskedConfirmed: z.literal('true').optional(),
}).strict().superRefine((v, ctx) => {
  if (v.kind === 'id_proof' && v.idProofType === undefined) ctx.addIssue({ code: 'custom', path: ['idProofType'], message: 'Choose the type of ID proof' })
  if (v.idProofType === 'masked_uid' && v.maskedConfirmed !== 'true') ctx.addIssue({ code: 'custom', path: ['maskedConfirmed'], message: 'Confirm the first 8 digits are hidden' })
})
export type ClaimDocumentMeta = z.infer<typeof claimDocumentMetaSchema>

export const attachLabReportSchema = z.object({ labReportId: positiveInt }).strict()
export const waiveDocumentSchema = z.object({ kind: z.enum(CLAIM_DOCUMENT_KINDS), reason: trimmed(5, 300) }).strict()

const channel = z.enum(SUBMISSION_CHANNELS)
const trackingReference = trimmed(1, 80).optional()
export const claimSubmitSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('submit'), channel, trackingReference, coverNote: z.string().trim().max(2000).optional() }).strict(),
  z.object({ action: z.literal('respond_query'), queryId: positiveInt, body: trimmed(1, 2000), channel, trackingReference, respondedOn: isoDate }).strict(),
  z.object({ action: z.literal('appeal'), appealKind: z.enum(['appeal', 'resubmission']), grounds: trimmed(10, 2000), channel, trackingReference }).strict(),
])
export type ClaimSubmitRequest = z.infer<typeof claimSubmitSchema>

const insurerClaimReference = trimmed(1, 80).optional()
export const claimUpdateSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('record_query'), question: trimmed(1, 2000), raisedOn: isoDate, dueOn: isoDate, insurerClaimReference }).strict(),
  z.object({
    action: z.literal('record_decision'),
    approvedPaise: positivePaise,
    decidedOn: isoDate,
    disallowances: z.array(z.object({ reasonCode, amountPaise: positivePaise, patientRecoverable: z.boolean(), note: z.string().trim().max(500).optional() }).strict()).max(30),
    insurerClaimReference,
  }).strict(),
  z.object({ action: z.literal('record_rejection'), decidedOn: isoDate, reasonCode, patientRecoverable: z.boolean(), note: z.string().trim().max(1000).optional() }).strict(),
  z.object({ action: z.literal('close') }).strict(),
  z.object({ action: z.literal('reopen'), reason: trimmed(5, 500) }).strict(),
  z.object({ action: z.literal('withdraw'), reason: trimmed(5, 500) }).strict(),
  z.object({ action: z.literal('note'), note: trimmed(1, 1000), portalCheckedOn: isoDate }).strict(),
]).superRefine((v, ctx) => {
  if (v.action === 'record_query' && v.dueOn < v.raisedOn) ctx.addIssue({ code: 'custom', path: ['dueOn'], message: 'The due date is before the query date' })
})
export type ClaimUpdateRequest = z.infer<typeof claimUpdateSchema>

export const settlementSchema = z.object({
  utr: trimmed(6, 40),
  paymentDate: isoDate,
  receivedPaise: positivePaise,
  tdsPaise: paise,
  bankChargesPaise: paise,
}).strict().superRefine((v, ctx) => {
  const problem = paymentReferenceProblem('neft', v.utr)
  if (problem) ctx.addIssue({ code: 'custom', path: ['utr'], message: problem })
})
export type SettlementInput = z.infer<typeof settlementSchema>

export const reconcileSchema = z.object({ bankCreditDate: isoDate }).strict()
export const acknowledgeSchema = z.object({ insurerReference: trimmed(1, 80), acknowledgedOn: isoDate }).strict()
export const writeOffRequestSchema = z.object({ amountPaise: positivePaise, reasonCode, note: trimmed(5, 500) }).strict()
export const writeOffDecisionSchema = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().max(500).optional() }).strict()
