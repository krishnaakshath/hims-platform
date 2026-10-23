// SP8 ruling 1: the ABDM and NHCX mocks are reachable only behind an
// explicit flag, and never in production. Pure over an env object so tests
// can pass their own.

import { DEMO_FEATURES_ENV, demoFeaturesEnabled } from '@/lib/demo-features'

type Env = Record<string, string | undefined>

/** Same rule as src/db/seed.ts: NODE_ENV or VERCEL_ENV is production. */
export function isProductionRuntime(env: Env = process.env): boolean {
  return env.NODE_ENV === 'production' || env.VERCEL_ENV === 'production'
}

/**
 * ABDM_USE_MOCKS=1|true. Outside production that is enough. In production the
 * mocks are reachable only for an explicit demo deployment: DEMO_FEATURES set
 * on (an unset variable does not count) AND ALLOW_DEMO_MOCKS=true.
 */
export function mocksEnabled(env: Env = process.env): boolean {
  if (env.ABDM_USE_MOCKS !== '1' && env.ABDM_USE_MOCKS !== 'true') return false
  if (!isProductionRuntime(env)) return true
  const explicitDemo = (env[DEMO_FEATURES_ENV] ?? '').trim() !== '' && demoFeaturesEnabled(env as NodeJS.ProcessEnv)
  return explicitDemo && env.ALLOW_DEMO_MOCKS === 'true'
}
