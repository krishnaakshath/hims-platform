// @vitest-environment node
//
// verifyMfaCode records each consumed time-step in the real (shared) Upstash
// Redis instance for replay protection -- node environment for the same
// reason as tests/lib/rate-limit.test.ts. Every test uses its own random
// secret and a unique identity, so reruns never collide with each other or
// with a real account's used-code markers.
import { describe, it, expect, afterEach, vi } from 'vitest'
import * as OTPAuth from 'otpauth'
import { brand } from '@/lib/brand'
import { generateMfaEnrollment, verifyMfaCode } from '@/lib/mfa'

function uniqueIdentity(label: string) {
  return `mfa-test-${label}-${Date.now()}-${Math.random()}`
}

function newTotp() {
  const secret = new OTPAuth.Secret({ size: 20 })
  const totp = new OTPAuth.TOTP({ issuer: brand.mfaIssuer, label: 'test', algorithm: 'SHA1', digits: 6, period: 30, secret })
  return { secretBase32: secret.base32, totp }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('generateMfaEnrollment', () => {
  it('returns a base32 secret and a scannable QR data URL', async () => {
    const enrollment = await generateMfaEnrollment('test@example.com')
    expect(enrollment.secretBase32).toMatch(/^[A-Z2-7]+=*$/)
    expect(enrollment.qrDataUrl).toMatch(/^data:image\/png;base64,/)
  })
})

describe('verifyMfaCode', () => {
  it('accepts the current valid code', async () => {
    const { secretBase32, totp } = newTotp()
    expect(await verifyMfaCode(secretBase32, totp.generate(), uniqueIdentity('current'))).toBe(true)
  })

  it('rejects a wrong code', async () => {
    const { secretBase32 } = newTotp()
    expect(await verifyMfaCode(secretBase32, '000000', uniqueIdentity('wrong'))).toBe(false)
  })

  it('accepts a code from one period ago (clock-drift tolerance)', async () => {
    const { secretBase32, totp } = newTotp()
    const oneStepAgo = totp.generate({ timestamp: Date.now() - 30_000 })
    expect(await verifyMfaCode(secretBase32, oneStepAgo, uniqueIdentity('drift'))).toBe(true)
  })

  it('rejects a code from two periods ago (outside the drift window)', async () => {
    const { secretBase32, totp } = newTotp()
    const twoStepsAgo = totp.generate({ timestamp: Date.now() - 60_000 })
    expect(await verifyMfaCode(secretBase32, twoStepsAgo, uniqueIdentity('stale'))).toBe(false)
  })
})

describe('verifyMfaCode replay protection (RFC 6238 §5.2)', () => {
  it('rejects a second use of the same code by the same identity within the validation window', async () => {
    const { secretBase32, totp } = newTotp()
    const identity = uniqueIdentity('replay')
    const code = totp.generate()
    expect(await verifyMfaCode(secretBase32, code, identity)).toBe(true)
    expect(await verifyMfaCode(secretBase32, code, identity)).toBe(false)
  })

  it('scopes replay tracking per identity -- another account using the same code is unaffected', async () => {
    const { secretBase32, totp } = newTotp()
    const code = totp.generate()
    expect(await verifyMfaCode(secretBase32, code, uniqueIdentity('scope-a'))).toBe(true)
    expect(await verifyMfaCode(secretBase32, code, uniqueIdentity('scope-b'))).toBe(true)
  })

  it('still rejects the replay after the clock moves into the next step, while the code is still inside the drift window', async () => {
    // The used-marker is keyed on the code's own time-step (current step +
    // validate()'s delta), not on "now" -- otherwise replaying the same
    // code 30s later, when it validates as delta -1 instead of 0, would
    // look like a fresh step and be accepted.
    const { secretBase32, totp } = newTotp()
    const identity = uniqueIdentity('replay-next-step')
    const start = Date.now()
    const code = totp.generate({ timestamp: start })
    vi.spyOn(Date, 'now').mockReturnValue(start)
    expect(await verifyMfaCode(secretBase32, code, identity)).toBe(true)
    vi.spyOn(Date, 'now').mockReturnValue(start + 30_000)
    expect(await verifyMfaCode(secretBase32, code, identity)).toBe(false)
  })

  it('does not treat a new secret for the same identity as a replay (reset + re-enroll)', async () => {
    const identity = uniqueIdentity('reenroll')
    const first = newTotp()
    const second = newTotp()
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    expect(await verifyMfaCode(first.secretBase32, first.totp.generate({ timestamp: now }), identity)).toBe(true)
    expect(await verifyMfaCode(second.secretBase32, second.totp.generate({ timestamp: now }), identity)).toBe(true)
  })

  it('does not consume anything on a failed code, so the real code still works afterwards', async () => {
    const { secretBase32, totp } = newTotp()
    const identity = uniqueIdentity('fail-then-ok')
    expect(await verifyMfaCode(secretBase32, '000000', identity)).toBe(false)
    expect(await verifyMfaCode(secretBase32, totp.generate(), identity)).toBe(true)
  })
})
