// drizzle wraps pg errors: the driver error is on `.cause`.
function field(err: unknown, key: 'code' | 'constraint'): string | null {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 3; e = (e as { cause?: unknown }).cause, depth++) {
    const v = (e as Record<string, unknown>)[key]
    if (typeof v === 'string') return v
  }
  return null
}

export function pgErrorCode(err: unknown): string | null { return field(err, 'code') }
export function pgConstraint(err: unknown): string | null { return field(err, 'constraint') }

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  return pgErrorCode(err) === '23505' && (constraint === undefined || pgConstraint(err) === constraint)
}
export function isExclusionViolation(err: unknown, constraint?: string): boolean {
  return pgErrorCode(err) === '23P01' && (constraint === undefined || pgConstraint(err) === constraint)
}

export const RETRY_MESSAGE = 'Another change was being saved at the same time; please try again'

/** Postgres deadlock (40P01) or serialization failure (40001): nothing was written; a retry can succeed. */
export function isRetryableConflict(err: unknown): boolean {
  const code = pgErrorCode(err)
  return code === '40P01' || code === '40001'
}
