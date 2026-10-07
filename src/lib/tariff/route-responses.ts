// Server-only response helpers shared by the /api/tariff routes. The role gate itself stays
// INLINE in every handler (requireSession, then the allowlist, then this `forbidden()`), so a
// reviewer can see the gate precede any body parse or query without following an import.
import { NextResponse } from 'next/server'
import type { ZodError } from 'zod'
import { isExclusionViolation, pgConstraint, pgErrorCode } from '@/lib/db-errors'
import { TariffOverlapError } from '@/lib/queries/tariff'

export const forbidden = () => NextResponse.json({ error: 'Forbidden' }, { status: 403 })
export const badRequest = (error: string) => NextResponse.json({ error }, { status: 400 })
export const notFound = (error = 'Not found') => NextResponse.json({ error }, { status: 404 })
export const conflict = (error: string) => NextResponse.json({ error }, { status: 409 })

export const OVERLAP_MESSAGE = 'This rate overlaps an existing rate for the same service, scope and room/ward'

/**
 * Every message `planRevision` (src/lib/tariff/versions.ts) can return. `reviseRate` rethrows them
 * as plain Errors; only these exact texts are passed to the client (tests/api/tariff-rates.test.ts
 * derives the set from planRevision itself, so a new message there fails until it is listed here).
 */
export const REVISION_ERRORS: readonly string[] = [
  'The rate is deactivated',
  'New rate must start after the current rate starts',
  'The current rate ends before that date; add a new rate instead',
  'The new amount equals the current amount',
]

/** App-level overlap (TariffOverlapError) or the DB backstop `tariff_rates_no_overlap` (23P01). */
export function isRateOverlap(err: unknown): boolean {
  return err instanceof TariffOverlapError || isExclusionViolation(err, 'tariff_rates_no_overlap')
}

/**
 * 400 for a failed zod parse. Only messages the schemas author themselves (refinements and
 * `.regex(…, message)`) are passed on; anything zod words from the request itself, such as an
 * unrecognised key, collapses to `fallback`, so client input is never echoed back.
 */
export function invalid(error: ZodError, fallback: string) {
  const issue = error.issues[0]
  const authored = issue !== undefined && (issue.code === 'custom' || issue.code === 'invalid_format')
  return badRequest(authored ? issue.message : fallback)
}

/** Positive integer path id, or null. */
export function parseId(raw: string): number | null {
  if (!/^\d{1,10}$/.test(raw)) return null
  const id = Number(raw)
  return id > 0 && id <= 2_147_483_647 ? id : null
}

/** Generic 500: logs only the pg error code and constraint, never the message or input. */
export function serverError(tag: string, err: unknown, message: string) {
  console.error(`[tariff] ${tag} failed (code ${pgErrorCode(err) ?? 'unknown'}, constraint ${pgConstraint(err) ?? 'none'})`)
  return NextResponse.json({ error: message }, { status: 500 })
}
