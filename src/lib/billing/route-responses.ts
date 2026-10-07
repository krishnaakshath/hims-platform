// SP4: server-only response helpers for the /api/billing routes. The role gate is NOT here:
// every handler checks its allowlist inline, right after requireSession(), before any body read.
import { NextResponse } from 'next/server'
import { RETRY_MESSAGE, isRetryableConflict, pgConstraint, pgErrorCode } from '@/lib/db-errors'

export { readJsonBody } from '@/lib/follow-ups/route-responses'
export { parseId, invalid } from '@/lib/tariff/route-responses'

export function billingError(status: number, error: string) {
  return NextResponse.json({ error }, { status })
}

/**
 * A thrown error: a deadlock or serialization failure (nothing was written) is a 409 asking to try
 * again; anything else a generic 500. Logs only the pg code and constraint, never the message or input.
 */
export function billingServerError(tag: string, err: unknown, message: string) {
  if (isRetryableConflict(err)) return billingError(409, RETRY_MESSAGE)
  console.error(`[billing] ${tag} failed (code ${pgErrorCode(err) ?? 'unknown'}, constraint ${pgConstraint(err) ?? 'none'})`)
  return billingError(500, message)
}
