// SP5: shared plumbing for the lab and home-collection routes. The role gate is NOT here:
// every route checks its allowlist inline, right after requireSession().
import { NextResponse } from 'next/server'
import type { ZodError } from 'zod'
import { RETRY_MESSAGE, isRetryableConflict, pgConstraint, pgErrorCode } from '@/lib/db-errors'
import { serviceErrorResponse } from '@/lib/service-config'
import { VERIFY_DENIAL_MESSAGE } from '@/lib/labs/verification' // WS4 T11

export { parseId, readJsonBody } from '@/lib/http'

export const WINDOW_OVERLAP_MESSAGE = 'This window overlaps another active window'

export function errorResponse(status: number, error: string, code?: string) {
  return NextResponse.json(code === undefined ? { error } : { error, code }, { status })
}

/**
 * 400 for a failed zod parse. Only messages the schemas author themselves are passed on;
 * anything zod words from the request (an unknown key, a wrong type) collapses to `fallback`,
 * so client input is never echoed back.
 */
export function invalidBody(error: ZodError, fallback: string) {
  const issue = error.issues[0]
  const authored = issue !== undefined && (issue.code === 'custom' || issue.code === 'invalid_format')
  return errorResponse(400, authored ? issue.message : fallback)
}

/** The fixed message for every lab-order transition refusal (Task 8). Never echoes input. */
export const LAB_ORDER_NOT_FOUND = 'Lab order not found'
const LAB_TRANSITION_CONFLICT = {
  invalid_status: 'This order is not at a stage where that can be done.',
  booked_for_home: 'This test is booked for home collection. Cancel the home visit first.',
  self_verification: 'Results must be verified by someone other than the person who entered them.',
  not_cancellable: 'Only tests without a result can be cancelled.',
} as const
export type LabTransitionError = 'not_found' | keyof typeof LAB_TRANSITION_CONFLICT

export function labTransitionError(error: LabTransitionError) {
  if (error === 'not_found') return errorResponse(404, LAB_ORDER_NOT_FOUND)
  return errorResponse(409, LAB_TRANSITION_CONFLICT[error])
}

// WS4 T9: per-analyte result entry refusals (422 with a stable code; never echoes input).
export const ANALYTE_ENTRY_MESSAGES = {
  analytes_required: 'This test is entered one value per analyte.',
  analyte_unknown: 'A value was sent for an analyte this test does not have.',
  analyte_missing: 'Enter a value for every analyte of this test.',
  flag_required: 'Choose a flag, with a reason, for each value the system cannot flag automatically.',
  flag_below_computed: 'A flag can be raised but never lowered below the automatic flag. Correct the value by amendment instead.',
  invalid_numeric: 'Enter a number for each numeric analyte.',
} as const
export type AnalyteEntryErrorCode = keyof typeof ANALYTE_ENTRY_MESSAGES

export function analyteEntryError(code: AnalyteEntryErrorCode, analyteId?: number) {
  return NextResponse.json({ error: ANALYTE_ENTRY_MESSAGES[code], code, ...(analyteId !== undefined ? { analyteId } : {}) }, { status: 422 })
}
// end WS4 T9

// WS4 T11: verification by department (403 with a stable code; fixed messages from the pure rule).
export function verifyDenialError(code: 'not_linked' | 'wrong_department') {
  return errorResponse(403, VERIFY_DENIAL_MESSAGE[code], code)
}

// WS4 T11: a doctor's acknowledgement / co-sign. Fixed messages; never echo the typed name or note.
export const SIGNOFF_MESSAGES = {
  not_verified_acknowledge: 'There is no result to acknowledge yet.',
  not_verified_cosign: 'A result can be co-signed only after it is verified.',
  not_owner: 'Only the ordering doctor or the attending doctor of the current admission can sign off this result.',
  name_mismatch: 'The typed name must match the name you are signed in with.',
  already_signed_acknowledge: 'You have already acknowledged this result.',
  already_signed_cosign: 'You have already co-signed this result.',
} as const

export function signOffError(kind: 'acknowledge' | 'cosign', error: 'not_found' | 'not_verified' | 'not_owner' | 'name_mismatch' | 'already_signed') {
  switch (error) {
    case 'not_found': return errorResponse(404, LAB_ORDER_NOT_FOUND)
    case 'not_verified': return errorResponse(409, SIGNOFF_MESSAGES[`not_verified_${kind}`], 'not_verified')
    case 'not_owner': return errorResponse(403, SIGNOFF_MESSAGES.not_owner, 'not_owner')
    case 'name_mismatch': return errorResponse(403, SIGNOFF_MESSAGES.name_mismatch, 'name_mismatch')
    case 'already_signed': return errorResponse(409, SIGNOFF_MESSAGES[`already_signed_${kind}`], 'already_signed')
  }
}
// end WS4 T11

/**
 * A thrown error: a missing blob store or unreachable database is a 503 (one [config] log
 * line); a deadlock / serialization failure (nothing was written) is a 409 asking to
 * try again; anything else a generic 500. Logs only the pg code and constraint.
 */
export function labServerError(tag: string, err: unknown, message: string) {
  const unavailable = serviceErrorResponse(err, tag)
  if (unavailable) return unavailable
  if (isRetryableConflict(err)) return errorResponse(409, RETRY_MESSAGE)
  console.error(`[labs] ${tag} failed (code ${pgErrorCode(err) ?? 'unknown'}, constraint ${pgConstraint(err) ?? 'none'})`)
  return errorResponse(500, message)
}
