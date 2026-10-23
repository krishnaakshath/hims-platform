// ENABLE_TRIALS: gates the clinical-trials area of the dashboard.
//
//   ENABLE_TRIALS=true|1 (trimmed, case-insensitive) -> on
//   anything else, including unset                   -> off (fail closed)
//
// Only the TRIALS_PATHS pages are hidden when off. Form Templates, Client
// Forms and the form APIs are never gated: they carry the hospital's own
// consents and intake forms.
// Pure over an env object and read per call (never at module load), like
// demo-features.ts, so tests and runtime env changes are honoured.

export const ENABLE_TRIALS_ENV = 'ENABLE_TRIALS'

export function trialsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env[ENABLE_TRIALS_ENV]
  if (raw === undefined) return false
  const v = raw.trim().toLowerCase()
  return v === 'true' || v === '1'
}

/** Dashboard paths hidden (and 404ing) while trials are off. */
export const TRIALS_PATHS: readonly string[] = ['/workbook', '/trials', '/pipeline-dashboard']

/** True for a trials path itself or anything beneath it ('/trials/3'), not lookalikes ('/trials-x'). */
export function isTrialsPath(pathname: string): boolean {
  return TRIALS_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))
}
