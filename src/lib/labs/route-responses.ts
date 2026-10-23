// SP5: shared plumbing for the lab and home-collection routes. The role gate is NOT here:
// every route checks its allowlist inline, right after requireSession().
import { NextResponse } from 'next/server'
import type { ZodError } from 'zod'
import { RETRY_MESSAGE, isRetryableConflict, pgConstraint, pgErrorCode } from '@/lib/db-errors'
import { serviceErrorResponse } from '@/lib/service-config'

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
