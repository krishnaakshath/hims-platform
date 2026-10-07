// SP3: shared plumbing for the follow-up routes. The role gate is NOT here:
// every route checks its allowlist inline, right after requireSession().
import { NextResponse } from 'next/server'
import { RETRY_MESSAGE, isRetryableConflict, pgConstraint, pgErrorCode } from '@/lib/db-errors'
import { parseId, readJsonBody } from '@/lib/http'

export const FOLLOW_UP_NOT_FOUND = 'Follow-up not found'
export const FOLLOW_UP_CLOSED = 'This follow-up is already completed or cancelled.'
export const DOCTOR_NOT_FOUND = 'Doctor not found or inactive'
export const DEPARTMENT_NOT_FOUND = 'Department not found or inactive'
export const NOT_LINKED_TO_DOCTOR = 'Your login is not linked to a doctor profile, so you cannot prescribe a follow-up.'

export function errorResponse(status: number, error: string) {
  return NextResponse.json({ error }, { status })
}

/** The request body as JSON, or a 400 `Invalid JSON` response. Never a 500. (Shared: src/lib/http.ts.) */
export { readJsonBody }

/** A positive int32 path id, or null. */
export const parseFollowUpId = (raw: string): number | null => parseId(raw)

export const invalidFollowUpId = () => errorResponse(400, 'Invalid follow-up id')

/**
 * A thrown error: a deadlock / serialization failure (nothing was written) is a
 * 409 asking to try again; a foreign-key violation a 400; anything else a generic 500. Logs only the pg code
 * and constraint -- never the message or the input.
 */
export function followUpServerError(tag: string, err: unknown, message: string) {
  if (isRetryableConflict(err)) return errorResponse(409, RETRY_MESSAGE)
  // A foreign key the request named no longer exists (e.g. deleted between check and write).
  if (pgErrorCode(err) === '23503') return errorResponse(400, 'A linked record does not exist.')
  console.error(`[follow-ups] ${tag} failed (code ${pgErrorCode(err) ?? 'unknown'}, constraint ${pgConstraint(err) ?? 'none'})`)
  return errorResponse(500, message)
}
