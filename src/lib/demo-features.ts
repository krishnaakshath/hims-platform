// DEMO_FEATURES: one switch for every simulated feature that must never pass
// for a real one in production -- the virtual card payment (fake Luhn
// processor), simulated broadcasts and experience-survey delivery, the
// simulated insurance eligibility check, the fax history tab, and the
// DISABLE_STAFF_MFA login shortcut.
//
//   DEMO_FEATURES=true|1|on    -> on, in any environment (an explicit demo deployment)
//   DEMO_FEATURES=false|0|off  -> off, in any environment
//   unset                      -> off in production, on in development/test
//                                 (the local mock setup the demos were built for)
//   anything else              -> off (fail closed)
//
// When off, demo nav entries are hidden, demo pages 404 and demo routes answer
// 503 {error:'Not configured'}. When on, the UI labels them "Demo".
// Server-only: read per call (never at module load) so a test or a runtime
// env change is honoured; client components receive the boolean as a prop.

export const DEMO_FEATURES_ENV = 'DEMO_FEATURES'

export function demoFeaturesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[DEMO_FEATURES_ENV]
  if (raw === undefined || raw.trim() === '') return env.NODE_ENV !== 'production'
  const v = raw.trim().toLowerCase()
  return v === 'true' || v === '1' || v === 'on'
}

export const DEMO_NOT_CONFIGURED_BODY = { error: 'Not configured' } as const
export const DEMO_NOT_CONFIGURED_STATUS = 503

/** DISABLE_STAFF_MFA=true skips the staff TOTP step at login. It is a demo
 *  shortcut, so it only takes effect while demo features are on. */
export function staffMfaBypassEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DISABLE_STAFF_MFA === 'true' && demoFeaturesEnabled(env)
}
