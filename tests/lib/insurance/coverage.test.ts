import { describe, it, expect } from 'vitest'
import {
  evaluateCoverage, effectiveLimits, manualValidUntilBounds, hoursAgoLabel,
  COVERAGE_FRESH_HOURS, MANUAL_VERIFICATION_MAX_DAYS, MANUAL_VERIFICATION_DEFAULT_DAYS, ICU_ROOM_CATEGORY_CODES,
  VERIFICATION_SOURCES, VERIFICATION_RESULTS, VERIFICATION_METHODS, VERIFICATION_CONTEXTS,
  type CoverageLimits, type CoveragePolicyFacts, type CoverageVerificationFacts, type CoverageContext,
} from '@/lib/insurance/coverage'

// 2026-10-23 12:00 IST.
const NOW = new Date('2026-10-23T06:30:00Z')
const H = 60 * 60 * 1000
const NO_LIMITS: CoverageLimits = { sumInsuredPaise: null, balancePaise: null, copayBp: null, roomRentLimitPaise: null, icuLimitPaise: null }

const policy = (over: Partial<CoveragePolicyFacts> = {}): CoveragePolicyFacts => ({
  id: 7, status: 'active', validFrom: '2026-04-01', validTo: '2027-03-31', insurerName: 'Star Health', onNhcx: true, limits: NO_LIMITS, ...over,
})
const verification = (over: Partial<CoverageVerificationFacts> = {}): CoverageVerificationFacts => ({
  id: 41, source: 'nhcx', result: 'active', verifiedAt: new Date(NOW.getTime() - 3 * H), validUntil: new Date(NOW.getTime() + 21 * H),
  verifiedByName: 'Asha Front', method: null, insurerReference: null, hasDocument: false, limits: NO_LIMITS, ...over,
})
const run = (over: Partial<Parameters<typeof evaluateCoverage>[0]> & { context: CoverageContext }) =>
  evaluateCoverage({ policy: policy(), verification: null, pendingCheck: false, now: NOW, ...over })

describe('coverage constants', () => {
  it('match the spec values', () => {
    expect(COVERAGE_FRESH_HOURS).toBe(24)
    expect(MANUAL_VERIFICATION_MAX_DAYS).toBe(30)
    expect(MANUAL_VERIFICATION_DEFAULT_DAYS).toBe(7)
    expect(ICU_ROOM_CATEGORY_CODES).toEqual(['ICU', 'HDU', 'NICU', 'PICU', 'CCU'])
    expect(VERIFICATION_SOURCES).toEqual(['nhcx', 'nhcx_mock', 'manual'])
    expect(VERIFICATION_RESULTS).toEqual(['active', 'inactive', 'error'])
    expect(VERIFICATION_METHODS).toEqual(['insurer_portal', 'tpa_portal', 'phone', 'email', 'letter'])
    expect(VERIFICATION_CONTEXTS).toEqual(['registration', 'checkin', 'admission', 'preauth', 'manual'])
  })
})

describe('evaluateCoverage', () => {
  it('(a) no policy: info when viewing, warn at IPD admission', () => {
    const view = run({ policy: null, context: 'view' })
    expect(view.state).toBe('no_policy'); expect(view.severity).toBe('info'); expect(view.policyId).toBeNull()
    const ipd = run({ policy: null, context: 'ipd_admission' })
    expect(ipd.state).toBe('no_policy'); expect(ipd.severity).toBe('warn')
  })

  it('(b) expired policy blocks IPD admission, warns at OPD check-in and in an emergency', () => {
    const p = policy({ validTo: '2026-10-22' })
    const ipd = run({ policy: p, context: 'ipd_admission' })
    expect(ipd.state).toBe('policy_expired'); expect(ipd.severity).toBe('block')
    expect(run({ policy: p, context: 'opd_checkin' }).severity).toBe('warn')
    expect(run({ policy: p, context: 'registration' }).severity).toBe('warn')
    expect(run({ policy: p, context: 'view' }).severity).toBe('warn')
    const emergency = run({ policy: p, context: 'ipd_admission', emergency: true })
    expect(emergency.state).toBe('policy_expired'); expect(emergency.severity).toBe('warn')
  })

  it('(b2) a policy ending today is still in force', () => {
    expect(run({ policy: policy({ validTo: '2026-10-23' }), context: 'ipd_admission', verification: verification() }).state).toBe('verified_active')
  })

  it('(c) a policy starting tomorrow is not started', () => {
    const v = run({ policy: policy({ validFrom: '2026-10-24' }), context: 'ipd_admission' })
    expect(v.state).toBe('policy_not_started'); expect(v.severity).toBe('block')
  })

  it('policy marked inactive by staff', () => {
    const v = run({ policy: policy({ status: 'inactive' }), context: 'preauth', verification: verification() })
    expect(v.state).toBe('policy_inactive'); expect(v.severity).toBe('block')
    expect(run({ policy: policy({ status: 'inactive' }), context: 'opd_checkin' }).severity).toBe('warn')
  })

  it('(d) a fresh active verification is verified_active with the hours label', () => {
    const v = run({ context: 'ipd_admission', verification: verification() })
    expect(v).toMatchObject({ state: 'verified_active', severity: 'ok', label: 'Policy valid, verified 3 hours ago', verifiedHoursAgo: 3, isMock: false, policyId: 7, verificationId: 41 })
  })

  it('(e) an expired verification is stale, warn at admission', () => {
    const old = verification({ verifiedAt: new Date(NOW.getTime() - 30 * H), validUntil: new Date(NOW.getTime() - 6 * H) })
    const v = run({ context: 'ipd_admission', verification: old })
    expect(v.state).toBe('stale'); expect(v.severity).toBe('warn'); expect(v.verifiedHoursAgo).toBe(30)
    expect(v.label).toContain('Verification out of date')
  })

  it('(e2) validUntil exactly now is no longer current', () => {
    expect(run({ context: 'view', verification: verification({ validUntil: NOW }) }).state).toBe('stale')
  })

  it('(f) a current inactive verification blocks pre-auth and admission, warns at check-in', () => {
    const inactive = verification({ result: 'inactive' })
    const pre = run({ context: 'preauth', verification: inactive })
    expect(pre.state).toBe('verified_inactive'); expect(pre.severity).toBe('block')
    expect(run({ context: 'ipd_admission', verification: inactive }).severity).toBe('block')
    expect(run({ context: 'ipd_admission', verification: inactive, emergency: true }).severity).toBe('warn')
    expect(run({ context: 'opd_checkin', verification: inactive }).severity).toBe('warn')
  })

  it('a current error verification is verification_error and never blocks', () => {
    const v = run({ context: 'ipd_admission', verification: verification({ result: 'error' }) })
    expect(v.state).toBe('verification_error'); expect(v.severity).toBe('warn')
    expect(run({ context: 'preauth', verification: verification({ result: 'error' }) }).severity).toBe('warn')
  })

  it('(g) a mock verification is flagged isMock and says so', () => {
    const v = run({ context: 'view', verification: verification({ source: 'nhcx_mock' }) })
    expect(v.isMock).toBe(true); expect(v.state).toBe('verified_active')
    expect(v.detail).toContain('Sandbox mock - not real')
  })

  it('(h) a pending NHCX check with no current verification is pending', () => {
    const v = run({ context: 'ipd_admission', pendingCheck: true })
    // R4: nothing current confirms cover, so admission and pre-auth still warn while the check runs.
    expect(v.state).toBe('pending'); expect(v.severity).toBe('warn'); expect(v.verifiedHoursAgo).toBeNull()
    expect(run({ context: 'preauth', pendingCheck: true }).severity).toBe('warn')
    for (const context of ['view', 'registration', 'opd_checkin'] as const) expect(run({ context, pendingCheck: true }).severity).toBe('info')
    const old = verification({ verifiedAt: new Date(NOW.getTime() - 30 * H), validUntil: new Date(NOW.getTime() - 6 * H) })
    expect(run({ context: 'view', pendingCheck: true, verification: old }).state).toBe('pending')
    // An expired verification plus a pending check does not drop below stale's warning at admission.
    expect(run({ context: 'ipd_admission', pendingCheck: true, verification: old })).toMatchObject({ state: 'pending', severity: 'warn' })
    // A current verification wins over a pending re-check.
    expect(run({ context: 'view', pendingCheck: true, verification: verification() }).state).toBe('verified_active')
  })

  it('unverified when no verification exists: info on view, warn at admission and pre-auth', () => {
    expect(run({ context: 'view' })).toMatchObject({ state: 'unverified', severity: 'info', verificationId: null, verifiedHoursAgo: null })
    expect(run({ context: 'opd_checkin' }).severity).toBe('info')
    expect(run({ context: 'ipd_admission' }).severity).toBe('warn')
    expect(run({ context: 'preauth' }).severity).toBe('warn')
  })

  it('(i) pre-auth checks the planned date, not today', () => {
    const p = policy({ validTo: '2026-10-30' })
    const v = run({ policy: p, context: 'preauth', onDate: '2026-11-02', verification: verification() })
    expect(v.state).toBe('policy_expired'); expect(v.severity).toBe('block')
    expect(v.detail).toContain('2 Nov 2026')
    expect(run({ policy: p, context: 'preauth', verification: verification() }).state).toBe('verified_active')
  })

  it('today is the IST calendar date', () => {
    // 2026-10-23 20:00 UTC = 2026-10-24 01:30 IST: a policy that ended on the 23rd is expired.
    const late = new Date('2026-10-23T20:00:00Z')
    expect(evaluateCoverage({ policy: policy({ validTo: '2026-10-23' }), verification: null, pendingCheck: false, context: 'view', now: late }).state).toBe('policy_expired')
  })
})

describe('effectiveLimits', () => {
  it('(j) prefers the verification value per field and falls back to the policy', () => {
    const fromPolicy: CoverageLimits = { sumInsuredPaise: 5_00_000_00, balancePaise: null, copayBp: 1000, roomRentLimitPaise: 3_000_00, icuLimitPaise: 6_000_00 }
    const fromVerification: CoverageLimits = { sumInsuredPaise: 4_00_000_00, balancePaise: 2_50_000_00, copayBp: null, roomRentLimitPaise: null, icuLimitPaise: 0 }
    expect(effectiveLimits(fromPolicy, fromVerification)).toEqual({ sumInsuredPaise: 4_00_000_00, balancePaise: 2_50_000_00, copayBp: 1000, roomRentLimitPaise: 3_000_00, icuLimitPaise: 0 })
    expect(effectiveLimits(fromPolicy, null)).toEqual(fromPolicy)
  })
})

describe('manualValidUntilBounds', () => {
  it('(k) never after the policy end', () => {
    expect(manualValidUntilBounds('2026-10-24', '2026-10-27')).toEqual({ defaultIso: '2026-10-27', maxIso: '2026-10-27' })
  })
  it('defaults to +7 days and caps at +30 days', () => {
    expect(manualValidUntilBounds('2026-10-24', '2027-03-31')).toEqual({ defaultIso: '2026-10-31', maxIso: '2026-11-23' })
    expect(manualValidUntilBounds('2026-12-28', '2027-03-31')).toEqual({ defaultIso: '2027-01-04', maxIso: '2027-01-27' })
  })
})

describe('hoursAgoLabel', () => {
  it('reads naturally', () => {
    expect(hoursAgoLabel(0)).toBe('less than an hour ago')
    expect(hoursAgoLabel(1)).toBe('1 hour ago')
    expect(hoursAgoLabel(3)).toBe('3 hours ago')
    expect(hoursAgoLabel(47)).toBe('47 hours ago')
    expect(hoursAgoLabel(48)).toBe('2 days ago')
    expect(hoursAgoLabel(80)).toBe('3 days ago')
  })
})
