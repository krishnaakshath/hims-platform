// Error catalogue for coding writes (SP6). Pure.
import type { CodingIssue } from '@/lib/coding/rules'

export type CodingWriteError =
  | 'not_found' | 'entry_not_found' | 'query_not_found' | 'encounter_cancelled' | 'encounter_not_completed' | 'locked'
  | 'not_claimed' | 'already_assigned' | 'invalid_transition' | 'open_queries' | 'primary_exists' | 'query_closed'
  | 'code_required' | 'code_not_found' | 'code_invalid' | 'validation_failed' | 'no_user_account' | 'assignee_not_coder'
  | 'provider_not_found' | 'service_not_found' | 'performed_in_future'

export type CodingWriteResult<T> = { ok: true; value: T } | { ok: false; error: CodingWriteError; issues?: CodingIssue[] }

export const CODING_ERROR_STATUS: Record<CodingWriteError, 400 | 404 | 409 | 422> = {
  not_found: 404, entry_not_found: 404, query_not_found: 404,
  encounter_cancelled: 409, encounter_not_completed: 409, locked: 409, not_claimed: 409, already_assigned: 409,
  invalid_transition: 409, open_queries: 409, primary_exists: 409, query_closed: 409,
  code_invalid: 422, validation_failed: 422,
  code_required: 400, code_not_found: 400, no_user_account: 400, assignee_not_coder: 400,
  provider_not_found: 400, service_not_found: 400, performed_in_future: 400,
}

export const CODING_ERROR_MESSAGE: Record<CodingWriteError, string> = {
  not_found: 'Encounter not found',
  entry_not_found: 'That diagnosis or procedure is not on this encounter',
  query_not_found: 'Coding query not found',
  encounter_cancelled: 'This visit was cancelled, so it is not coded',
  encounter_not_completed: 'Coding starts once the visit is completed or the patient is discharged',
  locked: 'Coding for this visit is closed to changes',
  not_claimed: 'Claim this encounter before changing its codes',
  already_assigned: 'Another coder has already claimed this encounter',
  invalid_transition: 'That step is not possible from the current coding status',
  open_queries: 'Close or withdraw the open doctor queries first',
  primary_exists: 'This visit already has a primary diagnosis',
  query_closed: 'This query is already closed',
  code_required: 'Choose a code from the loaded code set',
  code_not_found: 'Code not found in any loaded code set',
  code_invalid: 'That code cannot be used here',
  validation_failed: 'Coding checks failed; fix the errors listed',
  no_user_account: 'Your login has no staff account, so it cannot claim work',
  assignee_not_coder: 'Assign the encounter to a staff member with the coder role',
  provider_not_found: 'Doctor not found or inactive',
  service_not_found: 'Service not found',
  performed_in_future: 'The procedure date cannot be in the future',
}
