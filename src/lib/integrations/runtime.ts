// SP8 ruling 1: the ABDM and NHCX mocks are reachable only behind an
// explicit flag, and never in production. Pure over an env object so tests
// can pass their own.

type Env = Record<string, string | undefined>

/** Same rule as src/db/seed.ts: NODE_ENV or VERCEL_ENV is production. */
export function isProductionRuntime(env: Env = process.env): boolean {
  return env.NODE_ENV === 'production' || env.VERCEL_ENV === 'production'
}

/** ABDM_USE_MOCKS=1 outside production. */
export function mocksEnabled(env: Env = process.env): boolean {
  return env.ABDM_USE_MOCKS === '1' && !isProductionRuntime(env)
}
