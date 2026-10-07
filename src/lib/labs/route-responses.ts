// SP5: shared plumbing for the lab and home-collection routes. The role gate is NOT here:
// every route checks its allowlist inline, right after requireSession().
import { NextResponse } from 'next/server'
import type { ZodError } from 'zod'
import { RETRY_MESSAGE, isRetryableConflict, pgConstraint, pgErrorCode } from '@/lib/db-errors'

export { readJsonBody } from '@/lib/follow-ups/route-responses'
export { parseId } from '@/lib/tariff/route-responses'

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

/**
 * A thrown error: a deadlock / serialization failure (nothing was written) is a 409 asking to
 * try again; anything else a generic 500. Logs only the pg code and constraint.
 */
export function labServerError(tag: string, err: unknown, message: string) {
  if (isRetryableConflict(err)) return errorResponse(409, RETRY_MESSAGE)
  console.error(`[labs] ${tag} failed (code ${pgErrorCode(err) ?? 'unknown'}, constraint ${pgConstraint(err) ?? 'none'})`)
  return errorResponse(500, message)
}
