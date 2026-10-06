// @vitest-environment node
//
// A successful login signs the session cookie with jose (HS256), which does
// a strict `instanceof Uint8Array` check internally -- under this project's
// default jsdom test environment that check runs against a different global
// realm than the one `new TextEncoder().encode()` (src/lib/auth.ts)
// constructs its value in, so a genuine Uint8Array fails jose's own type
// guard with a jsdom-only, false-positive error. See tests/lib/auth.test.ts
// for the same fix with more detail.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { hashPassword } from '@/lib/password'
import { POST as login } from '@/app/api/login/route'
import { getDb } from '@/db/client'
import { users } from '@/db/schema'

const TEST_HASH = hashPassword('s3cret-pass')
const TEST_DB_USER_EMAIL = 'test-pi-login@example.com'
const TEST_DB_USER_PASSWORD = 'pi-test-pass-123'

// Login now rate-limits via a shared, real Upstash Redis instance (same
// account/window as production, since tests share the dev cache -- see the
// shared-dev-DB note in tests/db/seed.test.ts for the same class of issue).
// Mocked here so re-running this file within the same sliding window can't
// make an unrelated later test fail with 429; rate-limit.ts is unit-tested
// separately with a throwaway key.
vi.mock('@/lib/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rate-limit')>()
  return {
    ...actual,
    checkLoginRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
    checkOtpSendRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  }
})

// A correct admin password now always starts the mandatory MFA challenge,
// which reads -- and, if the admin isn't enrolled yet, WRITES a fresh secret
// into -- the single live app_settings row's admin MFA columns. This file is
// about the password check, not MFA persistence (that's
// tests/lib/queries/mfa-state.test.ts / tests/api/account-mfa-reset.test.ts,
// which snapshot and restore the real row), so the admin-MFA queries are
// mocked out here entirely: a login test run must never overwrite the real
// admin's enrollment.
vi.mock('@/lib/queries/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/queries/settings')>()
  return {
    ...actual,
    getAdminMfaState: vi.fn().mockResolvedValue({ mfaSecretEncrypted: null, mfaEnabled: false }),
    setAdminMfaSecret: vi.fn().mockResolvedValue(undefined),
    enableAdminMfa: vi.fn().mockResolvedValue(undefined),
    resetAdminMfa: vi.fn().mockResolvedValue(undefined),
  }
})

beforeAll(() => {
  vi.stubEnv('ADMIN_EMAIL', 'admin@example.com')
  vi.stubEnv('ADMIN_PASSWORD_HASH', TEST_HASH)
  vi.stubEnv('ADMIN_NAME', 'Test Admin')
})

afterAll(() => {
  vi.unstubAllEnvs()
})

function req(body: unknown) {
  return new NextRequest('http://localhost/api/login', { method: 'POST', body: JSON.stringify(body) })
}

describe('POST /api/login', () => {
  it('accepts the correct admin email and password', async () => {
    // Staff MFA is now mandatory (see tests/api/login-mfa.test.ts for the
    // full two-step flow) -- a correct password no longer completes a login
    // by itself, it hands back an MFA challenge instead. This still proves
    // the password check itself passed: a wrong password or unknown email
    // gets 401, not this challenge shape (see tests below).
    const res = await login(req({ email: 'admin@example.com', password: 's3cret-pass' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.mfaRequired).toBe(true)
    // getAdminMfaState is mocked to "not enrolled", so this is the enroll
    // challenge -- and the secret it provisions went to the mock, not the
    // real app_settings row.
    expect(body.mode).toBe('enroll')
    const { setAdminMfaSecret } = await import('@/lib/queries/settings')
    expect(setAdminMfaSecret).toHaveBeenCalledTimes(1)
  })

  it('rejects the wrong password', async () => {
    const res = await login(req({ email: 'admin@example.com', password: 'wrong' }))
    expect(res.status).toBe(401)
  })

  it('rejects an email that is not the admin account', async () => {
    const res = await login(req({ email: 'someone-else@example.com', password: 's3cret-pass' }))
    expect(res.status).toBe(401)
  })

  it('rejects a payload with an unexpected extra field', async () => {
    const res = await login(req({ email: 'admin@example.com', password: 's3cret-pass', role: 'admin' }))
    expect(res.status).toBe(400)
  })

  it('rejects a malformed email', async () => {
    const res = await login(req({ email: 'not-an-email', password: 's3cret-pass' }))
    expect(res.status).toBe(400)
  })

  it('returns 429 when the rate limiter reports the request is not allowed', async () => {
    const { checkLoginRateLimit } = await import('@/lib/rate-limit')
    vi.mocked(checkLoginRateLimit).mockResolvedValueOnce({ allowed: false })
    const res = await login(req({ email: 'admin@example.com', password: 's3cret-pass' }))
    expect(res.status).toBe(429)
  })

  describe('DB-backed (non-admin) accounts', () => {
    afterAll(async () => {
      await getDb().delete(users).where(eq(users.email, TEST_DB_USER_EMAIL))
    })

    it('accepts a provisioned pi/crc account by checking users.passwordHash', async () => {
      await getDb().insert(users).values({ name: 'Test PI', email: TEST_DB_USER_EMAIL, role: 'pi', passwordHash: hashPassword(TEST_DB_USER_PASSWORD) })
      const res = await login(req({ email: TEST_DB_USER_EMAIL, password: TEST_DB_USER_PASSWORD }))
      expect(res.status).toBe(200)
    })

    it('rejects a DB user with no password set at all', async () => {
      // spatel.demo@example.com is the seeded admin-role user row (distinct
      // from the real admin, which authenticates via ADMIN_EMAIL/PASSWORD_HASH
      // and never gets a users.passwordHash) -- it never gets a password set.
      const res = await login(req({ email: 'spatel.demo@example.com', password: 'anything' }))
      expect(res.status).toBe(401)
    })

    it('rejects an unknown email with no matching admin or DB account', async () => {
      const res = await login(req({ email: 'nobody-at-all@example.com', password: 'anything' }))
      expect(res.status).toBe(401)
    })
  })
})

describe('POST /api/login with mfaMethod sms/email', () => {
  it('sends an SMS OTP and does not return a QR code when the account mfaMethod is sms', async () => {
    vi.doMock('@/lib/otp-delivery', () => ({ generateAndSendOtp: vi.fn(async () => undefined), verifyOtp: vi.fn(async () => false) }))
    vi.resetModules()
    const [{ POST: loginPost }, { getDb }, { users }] = await Promise.all([
      import('@/app/api/login/route'),
      import('@/db/client'),
      import('@/db/schema'),
    ])
    const { hashPassword } = await import('@/lib/password')
    const [created] = await getDb().insert(users).values({
      name: 'SMS Test User', email: 'sms-test-user@example.com', role: 'crc',
      passwordHash: hashPassword('SmsTestPass123!'), mfaMethod: 'sms', phone: '+15551234567',
    }).returning()

    const req = new Request('http://localhost/api/login', { method: 'POST', body: JSON.stringify({ email: 'sms-test-user@example.com', password: 'SmsTestPass123!' }) })
    const res = await loginPost(req as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.mfaRequired).toBe(true)
    expect(body.mode).toBe('sms')
    expect(body.qrDataUrl).toBeUndefined()

    const { eq } = await import('drizzle-orm')
    await getDb().delete(users).where(eq(users.id, created.id))
  })
})
