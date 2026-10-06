// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { eq, and } from 'drizzle-orm'
import * as OTPAuth from 'otpauth'
import { brand, cookieName } from '@/lib/brand'
import { hashPassword } from '@/lib/password'
import { encryptSensitive } from '@/lib/crypto'
import { POST as loginRoute } from '@/app/api/login/route'
import { POST as loginMfaRoute } from '@/app/api/login/mfa/route'
import { getDb } from '@/db/client'
import { users, auditLog } from '@/db/schema'
import { setUserMfaSecret, enableUserMfa, getUserMfaState } from '@/lib/queries/users'

const TEST_HASH = hashPassword('s3cret-pass')
const TEST_DB_USER_EMAIL = 'test-login-mfa-user@example.com'
const TEST_DB_USER_PASSWORD = 'pi-test-pass-123'
let testUserId: number

vi.mock('@/lib/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rate-limit')>()
  return {
    ...actual,
    checkLoginRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
    checkStaffMfaRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
    checkOtpSendRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
    checkOtpVerifyRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  }
})

// Every flow in this file logs in as a throwaway DB user, never the env-var
// admin -- the admin's MFA columns live on the single LIVE app_settings row,
// and the real login routes would write a fresh secret into it. Guard that
// invariant: if a future test here ever reaches the admin branch, fail
// loudly instead of silently overwriting the real admin's enrollment. (Tests
// that genuinely need the admin path mock these, or snapshot/restore the
// row -- see tests/api/login.test.ts and tests/api/account-mfa-reset.test.ts.)
vi.mock('@/lib/queries/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/queries/settings')>()
  const refuse = (name: string) => vi.fn(async () => { throw new Error(`${name} must not touch the live app_settings row from login-mfa.test.ts`) })
  return {
    ...actual,
    getAdminMfaState: refuse('getAdminMfaState'),
    setAdminMfaSecret: refuse('setAdminMfaSecret'),
    enableAdminMfa: refuse('enableAdminMfa'),
    resetAdminMfa: refuse('resetAdminMfa'),
  }
})

// The two-step flow round-trips a cookie from step 1's response to step 2's
// request. Route handlers here are invoked directly (no real Next.js server
// in front of them), so `next/headers`'s cookies() has no request it's
// scoped to -- vitest.setup.ts's project-wide mock papers over that with a
// silent no-op (fine for routes that only ever check "is there a session"),
// but this flow's correctness depends on a cookie set in one response
// actually being readable from a later request, which a no-op can't do.
// This overrides that global mock, for this file only, with cookies() reads
// scoped to whatever request is "current" and writes captured into an outbox
// that gets flushed onto the real NextResponse the handler returns --
// reproducing, for tests, the merge Next's app-route module does for real
// HTTP requests (see node_modules/next/dist/server/route-modules/app-route/module.js).
let currentRequestCookies = new Map<string, string>()
let pendingResponseCookieOps = new Map<string, { deleted: true } | { deleted: false; value: string; options?: Record<string, unknown> }>()

function parseCookieHeader(header: string | null): Map<string, string> {
  const map = new Map<string, string>()
  if (!header) return map
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (name) map.set(name, value)
  }
  return map
}

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const op = pendingResponseCookieOps.get(name)
      if (op) return op.deleted ? undefined : { value: op.value }
      return currentRequestCookies.has(name) ? { value: currentRequestCookies.get(name) } : undefined
    },
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      pendingResponseCookieOps.set(name, { deleted: false, value, options })
    },
    delete: (name: string) => {
      pendingResponseCookieOps.set(name, { deleted: true })
    },
  }),
}))

// Seeds the mocked cookies() with this call's request cookies, invokes the
// real route handler, then flushes whatever it set/deleted back onto the
// NextResponse it returned -- so `res.cookies.get(...)` in a test reflects
// reality exactly as it would over real HTTP.
async function withCookieBridge(handler: (request: NextRequest) => Promise<NextResponse>, request: NextRequest): Promise<NextResponse> {
  currentRequestCookies = parseCookieHeader(request.headers.get('cookie'))
  pendingResponseCookieOps = new Map()
  const response = await handler(request)
  for (const [name, op] of pendingResponseCookieOps) {
    if (op.deleted) response.cookies.delete(name)
    else response.cookies.set(name, op.value, op.options)
  }
  return response
}

async function login(request: NextRequest) {
  return withCookieBridge(loginRoute, request)
}
async function loginMfa(request: NextRequest) {
  return withCookieBridge(loginMfaRoute, request)
}

beforeAll(async () => {
  vi.stubEnv('ADMIN_EMAIL', 'admin@example.com')
  vi.stubEnv('ADMIN_PASSWORD_HASH', TEST_HASH)
  vi.stubEnv('ADMIN_NAME', 'Test Admin')
  // `users.email` has no unique constraint, and this email is a fixed literal
  // (not per-run-unique) -- a run that crashes before afterAll's cleanup
  // leaves a stale row behind that a later run's plain WHERE-email lookup can
  // match instead of the fresh row inserted below, silently reusing whatever
  // MFA-enrollment state that stale row happened to be in. Delete-then-insert
  // makes this self-healing instead of a one-time manual cleanup.
  await getDb().delete(users).where(eq(users.email, TEST_DB_USER_EMAIL))
  const [row] = await getDb().insert(users).values({ name: 'Test PI', email: TEST_DB_USER_EMAIL, role: 'pi', passwordHash: hashPassword(TEST_DB_USER_PASSWORD) }).returning()
  testUserId = row.id
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await getDb().delete(auditLog).where(and(eq(auditLog.userName, 'Test PI'), eq(auditLog.action, 'failed MFA code entry')))
  await getDb().delete(users).where(eq(users.id, testUserId))
})

function req(body: unknown) {
  return new NextRequest('http://localhost/api/login', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
}
function mfaReq(body: unknown, cookie?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cookie) headers['cookie'] = cookie
  return new NextRequest('http://localhost/api/login/mfa', { method: 'POST', body: JSON.stringify(body), headers })
}

describe('two-step staff login', () => {
  let enrollCode: string

  it('unenrolled user gets an enroll challenge, then a correct code logs them in', async () => {
    const enrollRes = await login(req({ email: TEST_DB_USER_EMAIL, password: TEST_DB_USER_PASSWORD }))
    expect(enrollRes.status).toBe(200)
    const enrollBody = await enrollRes.json()
    expect(enrollBody).toMatchObject({ mfaRequired: true, mode: 'enroll' })
    expect(enrollBody.qrDataUrl).toMatch(/^data:image\/png/)

    const state = await getUserMfaState(testUserId)
    expect(state?.mfaEnabled).toBe(false)
    expect(state?.mfaSecretEncrypted).toBeTruthy()

    const pendingCookie = enrollRes.cookies.get(cookieName('pending_staff_mfa'))?.value
    const totp = new OTPAuth.TOTP({ issuer: brand.mfaIssuer, label: 'x', algorithm: 'SHA1', digits: 6, period: 30, secret: enrollBody.manualKey })
    enrollCode = totp.generate()
    const verifyRes = await loginMfa(mfaReq({ code: enrollCode }, `${cookieName('pending_staff_mfa')}=${pendingCookie}`))
    expect(verifyRes.status).toBe(200)
    expect(await verifyRes.json()).toEqual({ ok: true })
    expect(verifyRes.cookies.get(cookieName('session'))).toBeTruthy()
    expect((await getUserMfaState(testUserId))?.mfaEnabled).toBe(true)
  })

  it('rejects replaying the enrollment code on the next login (RFC 6238 §5.2)', async () => {
    // Still inside its validity window and the secret is unchanged, but the
    // code was consumed by the enrollment above -- a fresh password step
    // presenting it again must not complete a login.
    const res = await login(req({ email: TEST_DB_USER_EMAIL, password: TEST_DB_USER_PASSWORD }))
    expect(await res.json()).toEqual({ mfaRequired: true, mode: 'verify' })
    const pendingCookie = res.cookies.get(cookieName('pending_staff_mfa'))?.value
    const replayRes = await loginMfa(mfaReq({ code: enrollCode }, `${cookieName('pending_staff_mfa')}=${pendingCookie}`))
    expect(replayRes.status).toBe(401)
    expect(replayRes.cookies.get(cookieName('session'))).toBeFalsy()
  })

  it('already-enrolled user gets a verify challenge, and a wrong code is rejected', async () => {
    const secret = new OTPAuth.Secret({ size: 20 })
    await setUserMfaSecret(testUserId, encryptSensitive(secret.base32))
    await enableUserMfa(testUserId)

    const res = await login(req({ email: TEST_DB_USER_EMAIL, password: TEST_DB_USER_PASSWORD }))
    const body = await res.json()
    expect(body).toEqual({ mfaRequired: true, mode: 'verify' })
    const pendingCookie = res.cookies.get(cookieName('pending_staff_mfa'))?.value

    const wrongRes = await loginMfa(mfaReq({ code: '000000' }, `${cookieName('pending_staff_mfa')}=${pendingCookie}`))
    expect(wrongRes.status).toBe(401)

    const auditEntries = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, 'Test PI'), eq(auditLog.action, 'failed MFA code entry')))
    expect(auditEntries.length).toBeGreaterThan(0)
    expect(auditEntries[0].role).toBe('pi')
    expect(auditEntries[0].patientId).toBeNull()
  })

  it('returns 401 with no pending cookie', async () => {
    const res = await loginMfa(mfaReq({ code: '123456' }))
    expect(res.status).toBe(401)
  })

  it('returns 429 when the rate limiter disallows the attempt, without checking the code', async () => {
    const { checkStaffMfaRateLimit } = await import('@/lib/rate-limit')
    vi.mocked(checkStaffMfaRateLimit).mockResolvedValueOnce({ allowed: false })

    const enrollRes = await login(req({ email: TEST_DB_USER_EMAIL, password: TEST_DB_USER_PASSWORD }))
    const pendingCookie = enrollRes.cookies.get(cookieName('pending_staff_mfa'))?.value
    const res = await loginMfa(mfaReq({ code: '000000' }, `${cookieName('pending_staff_mfa')}=${pendingCookie}`))
    expect(res.status).toBe(429)
  })
})

// Neither login route nor login/mfa route had ever been exercised end to end
// for mfaMethod sms/email -- tests/api/login.test.ts only checks that an OTP
// send is triggered (mocking generateAndSendOtp entirely), and
// tests/lib/otp-delivery.test.ts covers verifyOtp's single-use behavior in
// isolation, but nothing drove a real code through both real routes. This
// mocks only the outbound transport (@/lib/sms) so the real
// generateAndSendOtp/verifyOtp logic (real Redis) runs, then round-trips the
// captured code through the same cookie-bridge harness as the totp tests
// above. Uses vi.doMock + vi.resetModules() + a dynamic re-import so the
// mock is only visible to the route instances imported inside this test --
// the top-level `login`/`loginMfa` helpers other tests use stay bound to the
// original, un-mocked modules (same pattern already used for the sms send
// test in tests/api/login.test.ts).
describe('two-step staff login (sms/email verify branch)', () => {
  it('accepts a real sms OTP once through the actual routes, then rejects it on replay', async () => {
    let capturedCode = ''
    vi.doMock('@/lib/sms', () => ({ sendSms: vi.fn(async (_to: string, code: string) => { capturedCode = code }) }))
    vi.resetModules()
    const [{ POST: freshLoginRoute }, { POST: freshLoginMfaRoute }] = await Promise.all([
      import('@/app/api/login/route'),
      import('@/app/api/login/mfa/route'),
    ])

    const [smsUser] = await getDb().insert(users).values({
      name: 'SMS Verify Test User',
      email: 'sms-verify-test-user@example.com',
      role: 'crc',
      passwordHash: hashPassword('SmsVerifyPass123!'),
      mfaMethod: 'sms',
      phone: '+15557654321',
    }).returning()

    try {
      const loginRes = await withCookieBridge(freshLoginRoute, req({ email: 'sms-verify-test-user@example.com', password: 'SmsVerifyPass123!' }))
      expect(loginRes.status).toBe(200)
      expect(await loginRes.json()).toEqual({ mfaRequired: true, mode: 'sms' })
      expect(capturedCode).toMatch(/^\d{6}$/)

      const pendingCookie = loginRes.cookies.get(cookieName('pending_staff_mfa'))?.value
      // Saved into its own variable before the second login below overwrites
      // the shared `capturedCode` closure with a brand-new code -- without
      // this, the "replay" attempt would accidentally submit the SECOND
      // login's fresh (still-valid) code instead of replaying the first
      // (already-used) one, making the test pass for the wrong reason.
      const firstCode = capturedCode
      const verifyRes = await withCookieBridge(freshLoginMfaRoute, mfaReq({ code: firstCode }, `${cookieName('pending_staff_mfa')}=${pendingCookie}`))
      expect(verifyRes.status).toBe(200)
      expect(await verifyRes.json()).toEqual({ ok: true })
      expect(verifyRes.cookies.get(cookieName('session'))).toBeTruthy()

      // Resubmitting the same code against a fresh pending cookie from a
      // second login attempt must be rejected -- proves single-use through
      // the real routes, not just verifyOtp in isolation.
      const loginRes2 = await withCookieBridge(freshLoginRoute, req({ email: 'sms-verify-test-user@example.com', password: 'SmsVerifyPass123!' }))
      expect(loginRes2.status).toBe(200)
      const pendingCookie2 = loginRes2.cookies.get(cookieName('pending_staff_mfa'))?.value
      const replayRes = await withCookieBridge(freshLoginMfaRoute, mfaReq({ code: firstCode }, `${cookieName('pending_staff_mfa')}=${pendingCookie2}`))
      expect(replayRes.status).toBe(401)
      expect(replayRes.cookies.get(cookieName('session'))).toBeFalsy()
    } finally {
      await getDb().delete(users).where(eq(users.id, smsUser.id))
      vi.doUnmock('@/lib/sms')
    }
  })
})
