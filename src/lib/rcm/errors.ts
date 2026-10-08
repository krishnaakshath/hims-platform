// SP7 RCM write errors (pure). Query modules return RcmWriteResult; routes map it with
// rcmErrorResponse (src/lib/rcm/route-responses.ts).
import type { ReadinessItem } from './readiness'

export const RCM_ERRORS = [
  'claim_not_found', 'preauth_not_found', 'policy_not_found', 'payer_not_found', 'patient_not_found', 'query_not_found',
  'document_not_found', 'settlement_not_found', 'write_off_not_found', 'dispatch_not_found', 'submission_not_found',
  'invalid_transition', 'stale', 'not_draft', 'invoice_unavailable', 'invoice_over_claimed', 'not_ready', 'preauth_unavailable',
  'preauth_in_use', 'primary_exists', 'payer_kind_invalid', 'payer_inactive', 'context_mismatch', 'code_not_found',
  'service_not_found', 'price_unresolved', 'duplicate_reference', 'duplicate_utr', 'amounts_invalid', 'write_off_exceeds',
  'same_approver', 'no_user_account', 'close_blocked', 'gateway_not_configured', 'already_acknowledged', 'already_reconciled',
  'already_decided', 'query_closed', 'upload_invalid', 'lab_report_unavailable',
] as const
export type RcmWriteError = (typeof RCM_ERRORS)[number]

export type RcmWriteResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: RcmWriteError; message?: string; items?: ReadinessItem[] }

export function rcmOk<T>(value: T): RcmWriteResult<T> {
  return { ok: true, value }
}
export function rcmFail(error: RcmWriteError, message?: string): { ok: false; error: RcmWriteError; message?: string } {
  return message === undefined ? { ok: false, error } : { ok: false, error, message }
}

const STATUS_400: readonly RcmWriteError[] = ['payer_kind_invalid', 'context_mismatch', 'code_not_found', 'service_not_found', 'upload_invalid']
const STATUS_403: readonly RcmWriteError[] = ['same_approver', 'no_user_account']
const STATUS_422: readonly RcmWriteError[] = ['not_ready', 'amounts_invalid', 'write_off_exceeds', 'price_unresolved']

export const RCM_ERROR_STATUS = Object.fromEntries(
  RCM_ERRORS.map((e) => [
    e,
    e.endsWith('_not_found') && e !== 'code_not_found' && e !== 'service_not_found' ? 404
      : STATUS_400.includes(e) ? 400
      : STATUS_403.includes(e) ? 403
      : STATUS_422.includes(e) ? 422
      : 409,
  ]),
) as Record<RcmWriteError, 400 | 403 | 404 | 409 | 422>

export const RCM_ERROR_MESSAGE: Record<RcmWriteError, string> = {
  claim_not_found: 'Claim not found',
  preauth_not_found: 'Pre-authorisation not found',
  policy_not_found: 'Policy not found',
  payer_not_found: 'Insurer or TPA not found',
  patient_not_found: 'Patient not found',
  query_not_found: 'Query not found',
  document_not_found: 'Document not found',
  settlement_not_found: 'Settlement not found',
  write_off_not_found: 'Write-off not found',
  dispatch_not_found: 'Dispatch record not found',
  submission_not_found: 'Submission not found',
  invalid_transition: 'That step is not possible from the current status',
  stale: 'The claim changed while its copy was being prepared; please try again',
  not_draft: 'Only a draft claim can be changed',
  invoice_unavailable: 'That invoice is not a finalised bill of this visit or stay for this payer',
  invoice_over_claimed: 'This invoice is already claimed up to its total',
  not_ready: 'This claim is not ready to submit',
  preauth_unavailable: 'That pre-authorisation is not an approved one for this patient and policy',
  preauth_in_use: 'This pre-authorisation is on a submitted claim',
  primary_exists: 'This patient already has an active primary policy',
  payer_kind_invalid: 'Choose an insurer for the insurer field and a TPA for the TPA field',
  payer_inactive: 'This insurer or TPA is marked inactive',
  context_mismatch: 'That admission or visit is not this patient\'s',
  code_not_found: 'Code not found in any loaded code set',
  service_not_found: 'Service not found',
  price_unresolved: 'No tariff rate covers one of the services',
  duplicate_reference: 'This approval reference is already recorded for another pre-authorisation of this insurer',
  duplicate_utr: 'This UTR is already recorded on this claim',
  amounts_invalid: 'The amounts do not add up',
  write_off_exceeds: 'The write-off is more than what is still open on this claim',
  same_approver: 'A write-off must be approved by someone other than the person who requested it',
  no_user_account: 'Your login has no staff account, so it cannot approve write-offs',
  close_blocked: 'This claim cannot be closed yet',
  gateway_not_configured: 'NHCX is not connected yet; submit through the insurer portal or email and record it',
  already_acknowledged: 'The insurer reference is already recorded',
  already_reconciled: 'This settlement is already reconciled',
  already_decided: 'This write-off is already decided',
  query_closed: 'This query is already answered or closed',
  upload_invalid: 'Upload a PDF, JPEG or PNG file of at most 4 MB',
  lab_report_unavailable: 'That lab report is not this patient\'s current report',
}
