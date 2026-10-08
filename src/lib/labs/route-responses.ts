// SP5: shared plumbing for the lab and home-collection routes. The role gate is NOT here:
// every route checks its allowlist inline, right after requireSession().
import { NextResponse } from 'next/server'
import type { ZodError } from 'zod'
import { RETRY_MESSAGE, isRetryableConflict, pgConstraint, pgErrorCode } from '@/lib/db-errors'

export { parseId, readJsonBody } from '@/lib/http'

export const WINDOW_OVERLAP_MESSAGE = 'This window overlaps another active window'

export function errorResponse(status: number, error: string) {
  return NextResponse.json({ error }, { status })
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

/**
 * A thrown error: a deadlock / serialization failure (nothing was written) is a 409 asking to
 * try again; anything else a generic 500. Logs only the pg code and constraint.
 */
export function labServerError(tag: string, err: unknown, message: string) {
  if (isRetryableConflict(err)) return errorResponse(409, RETRY_MESSAGE)
  console.error(`[labs] ${tag} failed (code ${pgErrorCode(err) ?? 'unknown'}, constraint ${pgConstraint(err) ?? 'none'})`)
  return errorResponse(500, message)
}
