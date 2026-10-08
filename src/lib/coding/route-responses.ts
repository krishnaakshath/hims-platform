// Server-only response helpers shared by the /api/coding routes (SP6). The role gate itself stays
// INLINE in every handler (requireSession, then the allowlist, then the exact
// `{ error: 'Forbidden' }` 403), so a reviewer can see it precede any body parse or query.
//
// Error bodies carry catalogue messages only, never request input; a 500 logs only the pg
// error code and constraint, never the message (which can quote row values).
import { NextResponse } from 'next/server'
import { CODING_ERROR_MESSAGE, CODING_ERROR_STATUS, type CodingWriteError } from '@/lib/coding/errors'
import type { CodingIssue } from '@/lib/coding/rules'
import { RETRY_MESSAGE, isRetryableConflict, pgConstraint, pgErrorCode } from '@/lib/db-errors'
import { invalidateCache, patientDetailCacheKey } from '@/lib/cache'

export const CODING_SAVE_FAILED = 'Could not save the coding change'
export const INVALID_CODING_REQUEST = 'Invalid coding request'

export const codingJson = (status: number, error: string) => NextResponse.json({ error }, { status })
export const invalidCodingId = () => codingJson(400, 'Invalid id')

/** A refused coding write: the catalogue status and message, plus the rule issues for a 422. */
export function codingErrorResponse(error: CodingWriteError, issues?: CodingIssue[]): NextResponse {
  return NextResponse.json(
    { error: CODING_ERROR_MESSAGE[error], ...(issues ? { issues } : {}) },
    { status: CODING_ERROR_STATUS[error] },
  )
}

/**
 * A thrown error: a deadlock / serialization failure (nothing was written) is a 409 asking to try
 * again; anything else a 500 with `message`. Logs `[coding] <tag> failed (code …, constraint …)`.
 */
export function codingServerError(tag: string, err: unknown, message: string = CODING_SAVE_FAILED): NextResponse {
  if (isRetryableConflict(err)) return codingJson(409, RETRY_MESSAGE)
  console.error(`[coding] ${tag} failed (code ${pgErrorCode(err) ?? 'unknown'}, constraint ${pgConstraint(err) ?? 'none'})`)
  return codingJson(500, message)
}

/**
 * After a diagnosis write: the patient detail read model (which lists diagnoses) is cached, so
 * drop it. The write already committed, so a failure here is logged and never fails the request.
 */
export async function invalidatePatientDetail(patientId: string): Promise<void> {
  try {
    await invalidateCache(patientDetailCacheKey(patientId))
  } catch (err) {
    console.error(`[coding] patient detail cache invalidation failed (${err instanceof Error ? err.name : typeof err})`)
  }
}
