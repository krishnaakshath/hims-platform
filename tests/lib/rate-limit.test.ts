// @vitest-environment node
import { describe, it, expect, afterAll } from 'vitest'
import { checkLoginRateLimit, checkPatientLoginRateLimit, checkStaffMfaRateLimit, checkPatientMfaRateLimit, checkAccountMfaResetRateLimit, checkBookingRequestRateLimit, __resetBookingRequestGlobalBucketForTests } from '@/lib/rate-limit'

describe('checkLoginRateLimit', () => {
  it('allows the first few attempts for a fresh ip+email key', async () => {
    const uniqueEmail = `rl-test-${Date.now()}-${Math.random()}@example.com`
    const first = await checkLoginRateLimit('203.0.113.1', uniqueEmail)
    expect(first.allowed).toBe(true)
  })

  it('blocks after the window is exhausted for one ip+email key', async () => {
    const uniqueEmail = `rl-test-${Date.now()}-${Math.random()}@example.com`
    const ip = '203.0.113.2'
    for (let i = 0; i < 5; i++) {
      const { allowed } = await checkLoginRateLimit(ip, uniqueEmail)
      expect(allowed).toBe(true)
    }
    const sixth = await checkLoginRateLimit(ip, uniqueEmail)
    expect(sixth.allowed).toBe(false)
  })

  it('treats a different email from the same ip as an independent bucket', async () => {
    const ip = '203.0.113.3'
    const emailA = `rl-test-a-${Date.now()}@example.com`
    const emailB = `rl-test-b-${Date.now()}@example.com`
    for (let i = 0; i < 5; i++) await checkLoginRateLimit(ip, emailA)
    const blocked = await checkLoginRateLimit(ip, emailA)
    expect(blocked.allowed).toBe(false)
    const stillAllowed = await checkLoginRateLimit(ip, emailB)
    expect(stillAllowed.allowed).toBe(true)
  })
})

describe('checkPatientLoginRateLimit', () => {
  it('uses a separate Redis key prefix from checkLoginRateLimit, so exhausting one never touches the other', async () => {
    const ip = '203.0.113.9'
    const sharedId = `rl-test-shared-${Date.now()}`
    for (let i = 0; i < 5; i++) {
      const { allowed } = await checkLoginRateLimit(ip, sharedId)
      expect(allowed).toBe(true)
    }
    // Same ip, same identifier string, but the patient bucket (a distinct
    // 'ratelimit:patient-login' prefix -- see rate-limit.ts) starts fresh.
    const patientStillAllowed = await checkPatientLoginRateLimit(ip, sharedId)
    expect(patientStillAllowed.allowed).toBe(true)
  })

  it('blocks after the window is exhausted for one ip+patientId key', async () => {
    const ip = '203.0.113.10'
    const patientId = `rl-test-patient-${Date.now()}`
    for (let i = 0; i < 5; i++) {
      const { allowed } = await checkPatientLoginRateLimit(ip, patientId)
      expect(allowed).toBe(true)
    }
    const sixth = await checkPatientLoginRateLimit(ip, patientId)
    expect(sixth.allowed).toBe(false)
  })

  it('blocks sustained guessing against one patient id even when spread across many source IPs', async () => {
    // Each individual IP below never exceeds its own 5-per-60s bucket, but
    // the IP-independent global bucket (10 per 600s, keyed on patientId
    // alone) still catches the attacker rotating addresses -- exactly the
    // gap a per-IP-only limiter leaves open.
    const patientId = `rl-test-distributed-${Date.now()}`
    for (let i = 0; i < 10; i++) {
      const { allowed } = await checkPatientLoginRateLimit(`203.0.114.${i}`, patientId)
      expect(allowed).toBe(true)
    }
    const eleventh = await checkPatientLoginRateLimit('203.0.114.99', patientId)
    expect(eleventh.allowed).toBe(false)
  })
})

describe('checkStaffMfaRateLimit', () => {
  it('allows the first few attempts for a fresh ip+identity key', async () => {
    const identity = `rl-test-staff-mfa-${Date.now()}-${Math.random()}`
    const first = await checkStaffMfaRateLimit('203.0.115.1', identity)
    expect(first.allowed).toBe(true)
  })

  it('blocks after the window is exhausted for one ip+identity key', async () => {
    const ip = '203.0.115.2'
    const identity = `rl-test-staff-mfa-${Date.now()}`
    for (let i = 0; i < 5; i++) {
      const { allowed } = await checkStaffMfaRateLimit(ip, identity)
      expect(allowed).toBe(true)
    }
    const sixth = await checkStaffMfaRateLimit(ip, identity)
    expect(sixth.allowed).toBe(false)
  })

  it('blocks sustained TOTP guessing against one staff identity even when spread across many source IPs', async () => {
    // Regression test for a Critical finding: checkStaffMfaRateLimit used to
    // be keyed solely on `${ip}:${identity}` -- since getClientIp trusts the
    // client-supplied x-forwarded-for header, an attacker could get a fresh
    // 5-attempt budget on every single 6-digit code guess just by sending a
    // different (spoofed) IP each time, defeating the rate limit against the
    // whole code space with no botnet required. Each individual IP below
    // never exceeds its own 5-per-60s bucket, but the IP-independent global
    // bucket (10 per 600s, keyed on identity alone) still catches it.
    const identity = `rl-test-staff-mfa-distributed-${Date.now()}`
    for (let i = 0; i < 10; i++) {
      const { allowed } = await checkStaffMfaRateLimit(`203.0.116.${i}`, identity)
      expect(allowed).toBe(true)
    }
    const eleventh = await checkStaffMfaRateLimit('203.0.116.99', identity)
    expect(eleventh.allowed).toBe(false)
  })
})

describe('checkPatientMfaRateLimit', () => {
  it('allows the first few attempts for a fresh ip+patientId key', async () => {
    const patientId = `rl-test-patient-mfa-${Date.now()}-${Math.random()}`
    const first = await checkPatientMfaRateLimit('203.0.117.1', patientId)
    expect(first.allowed).toBe(true)
  })

  it('blocks after the window is exhausted for one ip+patientId key', async () => {
    const ip = '203.0.117.2'
    const patientId = `rl-test-patient-mfa-${Date.now()}`
    for (let i = 0; i < 5; i++) {
      const { allowed } = await checkPatientMfaRateLimit(ip, patientId)
      expect(allowed).toBe(true)
    }
    const sixth = await checkPatientMfaRateLimit(ip, patientId)
    expect(sixth.allowed).toBe(false)
  })

  it('blocks sustained TOTP guessing against one patient id even when spread across many source IPs', async () => {
    // Regression test for the same Critical finding as checkStaffMfaRateLimit
    // (Task 5): a single-bucket limiter keyed solely on `${ip}:${patientId}`
    // is trivially bypassed since getClientIp trusts the client-supplied
    // x-forwarded-for header -- an attacker gets a fresh 5-attempt budget on
    // every single 6-digit code guess just by sending a different (spoofed)
    // IP each time. Each individual IP below never exceeds its own
    // 5-per-60s bucket, but the IP-independent global bucket (10 per 600s,
    // keyed on patientId alone) still catches it.
    const patientId = `rl-test-patient-mfa-distributed-${Date.now()}`
    for (let i = 0; i < 10; i++) {
      const { allowed } = await checkPatientMfaRateLimit(`203.0.118.${i}`, patientId)
      expect(allowed).toBe(true)
    }
    const eleventh = await checkPatientMfaRateLimit('203.0.118.99', patientId)
    expect(eleventh.allowed).toBe(false)
  })
})

describe('checkAccountMfaResetRateLimit', () => {
  it('blocks after 5 attempts in the window for one ip+email key', async () => {
    const ip = '203.0.119.1'
    const email = `rl-test-acct-reset-${Date.now()}-${Math.random()}@example.com`
    for (let i = 0; i < 5; i++) {
      const { allowed } = await checkAccountMfaResetRateLimit(ip, email)
      expect(allowed).toBe(true)
    }
    const sixth = await checkAccountMfaResetRateLimit(ip, email)
    expect(sixth.allowed).toBe(false)
  })

  it('treats the email case-insensitively, so varying its case does not buy fresh attempts', async () => {
    const ip = '203.0.119.2'
    const email = `rl-test-acct-reset-case-${Date.now()}@example.com`
    for (let i = 0; i < 5; i++) {
      const { allowed } = await checkAccountMfaResetRateLimit(ip, email)
      expect(allowed).toBe(true)
    }
    const upper = await checkAccountMfaResetRateLimit(ip, email.toUpperCase())
    expect(upper.allowed).toBe(false)
  })

  it('blocks sustained password guessing against one email even when spread across many source IPs', async () => {
    // Same spoofed-x-forwarded-for bypass the other dual-bucket limiters
    // defend against: no single IP exceeds its 5-per-60s bucket, but the
    // identity-only global bucket (10 per 600s) still catches it.
    const email = `rl-test-acct-reset-distributed-${Date.now()}@example.com`
    for (let i = 0; i < 10; i++) {
      const { allowed } = await checkAccountMfaResetRateLimit(`203.0.120.${i}`, email)
      expect(allowed).toBe(true)
    }
    const eleventh = await checkAccountMfaResetRateLimit('203.0.120.99', email)
    expect(eleventh.allowed).toBe(false)
  })

  it('uses its own bucket, independent of the login limiter', async () => {
    const ip = '203.0.119.3'
    const email = `rl-test-acct-reset-vs-login-${Date.now()}@example.com`
    for (let i = 0; i < 5; i++) await checkLoginRateLimit(ip, email)
    expect((await checkLoginRateLimit(ip, email)).allowed).toBe(false)
    expect((await checkAccountMfaResetRateLimit(ip, email)).allowed).toBe(true)
  })
})

describe('checkBookingRequestRateLimit', () => {
  // The saturation test below deliberately exhausts the flat, invariant
  // 'global' bucket key (see checkBookingRequestRateLimit in rate-limit.ts --
  // unlike every other limiter in this file, there's no per-test-random
  // identity to peg it to). That key is shared with every other caller,
  // including tests/api/public-booking-requests.test.ts and real production
  // traffic, so without resetting it here, running this file directly before
  // that one (or a CI retry within the ~600s window) would spuriously 429
  // that file's success-path assertions -- purely because of file execution
  // order, not a real bug. Reset unconditionally so this file can never leak
  // that state elsewhere, regardless of run order.
  afterAll(async () => {
    await __resetBookingRequestGlobalBucketForTests()
  })

  it('allows the first few attempts for a fresh ip', async () => {
    const ip = `198.51.100.${Date.now() % 250}`
    const first = await checkBookingRequestRateLimit(ip)
    expect(first.allowed).toBe(true)
  })

  it('blocks after the per-IP window is exhausted for one ip', async () => {
    const ip = `198.51.101.${Date.now() % 250}`
    for (let i = 0; i < 3; i++) {
      const { allowed } = await checkBookingRequestRateLimit(ip)
      expect(allowed).toBe(true)
    }
    const fourth = await checkBookingRequestRateLimit(ip)
    expect(fourth.allowed).toBe(false)
  })

  it('eventually blocks under sustained submissions spread across many source IPs, via the identity-independent global bucket', async () => {
    // Unlike every other limiter in this file, there is no persistent
    // identity to peg a global bucket to for an anonymous submitter -- so
    // this global bucket is a genuinely flat, shared cap on total booking
    // submissions regardless of source IP, defending against a botnet
    // rotating (or spoofing) addresses to dodge the per-IP bucket above.
    // Because that flat key is real shared state that can carry a small
    // remainder across repeated test runs within the same window, this
    // asserts the deterministic property -- saturating it with more calls
    // than its cap can ever hold -- rather than a specific call index.
    // The cap is 200-per-600s (raised from an original 20 -- see the
    // comment on getBookingRequestGlobalLimiter in rate-limit.ts for why a
    // flat, identity-independent cap that low was itself a denial-of-service
    // risk against the whole practice), so this needs well past 200 calls
    // to reliably saturate it -- issued concurrently (not a 210-call
    // sequential loop) so the real Upstash round trips don't blow the
    // suite's default per-test timeout.
    const calls = Array.from({ length: 210 }, (_, i) =>
      checkBookingRequestRateLimit(`203.0.${113 + (i % 5)}.${i}`))
    const results = await Promise.all(calls)
    expect(results.some(({ allowed }) => allowed === false)).toBe(true)
  }, 30000)
})
