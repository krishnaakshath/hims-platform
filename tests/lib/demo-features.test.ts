import { describe, it, expect } from 'vitest'
import { demoFeaturesEnabled } from '@/lib/demo-features'

const env = (vars: Record<string, string | undefined>) => vars as NodeJS.ProcessEnv

describe('demoFeaturesEnabled (DEMO_FEATURES)', () => {
  it('is OFF in production when unset', () => {
    expect(demoFeaturesEnabled(env({ NODE_ENV: 'production' }))).toBe(false)
  })
  it('is ON in development and test when unset (the local mock/EHR-style setup)', () => {
    expect(demoFeaturesEnabled(env({ NODE_ENV: 'development' }))).toBe(true)
    expect(demoFeaturesEnabled(env({ NODE_ENV: 'test' }))).toBe(true)
  })
  it.each(['true', '1', 'on', 'TRUE'])('an explicit %s turns it on, even in production', (v) => {
    expect(demoFeaturesEnabled(env({ NODE_ENV: 'production', DEMO_FEATURES: v }))).toBe(true)
  })
  it.each(['false', '0', 'off'])('an explicit %s turns it off, even in development', (v) => {
    expect(demoFeaturesEnabled(env({ NODE_ENV: 'development', DEMO_FEATURES: v }))).toBe(false)
  })
  it('treats an unrecognised value as off (fail closed)', () => {
    expect(demoFeaturesEnabled(env({ NODE_ENV: 'development', DEMO_FEATURES: 'maybe' }))).toBe(false)
  })
})

import { staffMfaBypassEnabled } from '@/lib/demo-features'

// Wave B P1-21: DISABLE_STAFF_MFA is a demo shortcut; it never applies with demo features off.
describe('staffMfaBypassEnabled (DISABLE_STAFF_MFA)', () => {
  it('is ignored in production unless DEMO_FEATURES is on', () => {
    expect(staffMfaBypassEnabled(env({ NODE_ENV: 'production', DISABLE_STAFF_MFA: 'true' }))).toBe(false)
    expect(staffMfaBypassEnabled(env({ NODE_ENV: 'production', DISABLE_STAFF_MFA: 'true', DEMO_FEATURES: 'true' }))).toBe(true)
  })
  it('needs DISABLE_STAFF_MFA=true exactly', () => {
    expect(staffMfaBypassEnabled(env({ NODE_ENV: 'development' }))).toBe(false)
    expect(staffMfaBypassEnabled(env({ NODE_ENV: 'development', DISABLE_STAFF_MFA: 'true' }))).toBe(true)
    expect(staffMfaBypassEnabled(env({ NODE_ENV: 'development', DISABLE_STAFF_MFA: 'true', DEMO_FEATURES: 'false' }))).toBe(false)
  })
})
