// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { eq, and, inArray } from 'drizzle-orm'
import { decodeJwt } from 'jose'
import * as OTPAuth from 'otpauth'
import { brand, cookieName } from '@/lib/brand'
import { encryptSensitive } from '@/lib/crypto'
import { POST as loginRoute } from '@/app/api/patient-portal/login/route'
import { POST as loginMfaRoute } from '@/app/api/patient-portal/login/mfa/route'
import { getDb } from '@/db/client'
import { patients, auditLog } from '@/db/schema'
import { setPatientPortalPassword } from '@/lib/queries/patient-portal'
import { setPatientMfaSecret, enablePatientMfa } from '@/lib/queries/patient-portal'

const TEST_PATIENT_ID = 'RD-LOGIN-MFA-01'
const TEST_PASSWORD = 'patient-test-pass-123'

vi.mock('@/lib/rate-limit', () => ({
  checkPatientLoginRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  checkPatientMfaRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}))

// Route handler modules are invoked directly in tests (not through an actual
// Next.js HTTP request), so the project-wide `next/headers` mock in
// vitest.setup.ts stubs `cookies()` with a silent no-op (fine for routes that
// only ever check "is there a session"). This flow's correctness depends on a
// cookie set in one response actually being readable from a later request,
// which a no-op can't do -- same problem, same fix, as tests/api/login-mfa.test.ts
// (the staff equivalent of this file). This overrides that global mock, for
// this file only, with cookies() reads scoped to whatever request is
// "current" and writes captured into an outbox that gets flushed onto the
// real NextResponse the handler returns.
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
  await getDb().insert(patients).values({ id: TEST_PATIENT_ID, name: 'Login MFA Test Patient', dob: '1990-01-01' })
  await setPatientPortalPassword(TEST_PATIENT_ID, TEST_PASSWORD)
}, 30000)

afterAll(async () => {
  await getDb().delete(auditLog).where(and(eq(auditLog.patientId, TEST_PATIENT_ID), eq(auditLog.action, 'failed MFA code entry')))
  await getDb().delete(patients).where(eq(patients.id, TEST_PATIENT_ID))
})

function req(body: unknown) {
  return new NextRequest('http://localhost/api/patient-portal/login', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
}
function mfaReq(body: unknown, cookie?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cookie) headers['cookie'] = cookie
  return new NextRequest('http://localhost/api/patient-portal/login/mfa', { method: 'POST', body: JSON.stringify(body), headers })
}

describe('patient login without MFA enabled', () => {
  it('logs in exactly as before -- no mfaRequired in the response', async () => {
    const res = await login(req({ patientId: TEST_PATIENT_ID, password: TEST_PASSWORD }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(res.cookies.get(cookieName('patient_session'))).toBeTruthy()
  })
})

describe('patient login with MFA enabled', () => {
  const secret = new OTPAuth.Secret({ size: 20 })
  let usedCode: string

  beforeAll(async () => {
    await setPatientMfaSecret(TEST_PATIENT_ID, encryptSensitive(secret.base32))
    await enablePatientMfa(TEST_PATIENT_ID)
  })

  it('requires a second step, then a correct code logs in', async () => {
    const res = await login(req({ patientId: TEST_PATIENT_ID, password: TEST_PASSWORD }))
    expect(await res.json()).toEqual({ mfaRequired: true })
    expect(res.cookies.get(cookieName('patient_session'))).toBeFalsy()

    const pendingCookie = res.cookies.get(cookieName('pending_patient_mfa'))?.value
    const totp = new OTPAuth.TOTP({ issuer: brand.mfaIssuer, label: 'x', algorithm: 'SHA1', digits: 6, period: 30, secret })
    usedCode = totp.generate()
    const verifyRes = await loginMfa(mfaReq({ code: usedCode }, `${cookieName('pending_patient_mfa')}=${pendingCookie}`))
    expect(verifyRes.status).toBe(200)
    expect(verifyRes.cookies.get(cookieName('patient_session'))).toBeTruthy()
  })

  it('rejects replaying the code that just logged in, on a fresh password step', async () => {
    // RFC 6238 §5.2: the code from the test above is still inside its
    // validity window, but it's been consumed -- a second login presenting
    // it must fail even with a correct password and a valid pending cookie.
    const res = await login(req({ patientId: TEST_PATIENT_ID, password: TEST_PASSWORD }))
    const pendingCookie = res.cookies.get(cookieName('pending_patient_mfa'))?.value
    const replayRes = await loginMfa(mfaReq({ code: usedCode }, `${cookieName('pending_patient_mfa')}=${pendingCookie}`))
    expect(replayRes.status).toBe(401)
    expect(replayRes.cookies.get(cookieName('patient_session'))).toBeFalsy()
  })

  it('rejects a wrong code', async () => {
    const res = await login(req({ patientId: TEST_PATIENT_ID, password: TEST_PASSWORD }))
    const pendingCookie = res.cookies.get(cookieName('pending_patient_mfa'))?.value
    const wrongRes = await loginMfa(mfaReq({ code: '000000' }, `${cookieName('pending_patient_mfa')}=${pendingCookie}`))
    expect(wrongRes.status).toBe(401)

    const auditEntries = await getDb().select().from(auditLog).where(and(eq(auditLog.patientId, TEST_PATIENT_ID), eq(auditLog.action, 'failed MFA code entry')))
    expect(auditEntries.length).toBeGreaterThan(0)
  })

  it('returns 401 with no pending cookie', async () => {
    const res = await loginMfa(mfaReq({ code: '123456' }))
    expect(res.status).toBe(401)
  })

  it('returns 429 when the rate limiter disallows the attempt, without checking the code', async () => {
    const { checkPatientMfaRateLimit } = await import('@/lib/rate-limit')
    vi.mocked(checkPatientMfaRateLimit).mockResolvedValueOnce({ allowed: false })

    const res = await login(req({ patientId: TEST_PATIENT_ID, password: TEST_PASSWORD }))
    const pendingCookie = res.cookies.get(cookieName('pending_patient_mfa'))?.value
    const blockedRes = await loginMfa(mfaReq({ code: '000000' }, `${cookieName('pending_patient_mfa')}=${pendingCookie}`))
    expect(blockedRes.status).toBe(429)
  })
})

// Login by EMAIL (the portal form asks for one): the email is only ever an
// identifier to resolve -- the pending-MFA cookie and the session cookie must
// carry the resolved patientId and never the email.
describe('patient login by email', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const ID_PLAIN = `RD-PORTAL-EMAIL-G-${suffix}`
  const ID_MFA = `RD-PORTAL-EMAIL-F-${suffix}`
  const EMAIL_PLAIN = `portal-email-g-${suffix}@example.test`
  const EMAIL_MFA = `portal-email-f-${suffix}@example.test`
  const secret = new OTPAuth.Secret({ size: 20 })

  beforeAll(async () => {
    await getDb().insert(patients).values([
      { id: ID_PLAIN, name: 'Portal Email Session Test', dob: '1990-01-01', email: EMAIL_PLAIN },
      { id: ID_MFA, name: 'Portal Email MFA Test', dob: '1990-01-01', email: EMAIL_MFA },
    ])
    await setPatientPortalPassword(ID_PLAIN, TEST_PASSWORD)
    await setPatientPortalPassword(ID_MFA, TEST_PASSWORD)
    await setPatientMfaSecret(ID_MFA, encryptSensitive(secret.base32))
    await enablePatientMfa(ID_MFA)
  }, 30000)

  afterAll(async () => {
    await getDb().delete(auditLog).where(and(inArray(auditLog.patientId, [ID_PLAIN, ID_MFA]), inArray(auditLog.action, ['logged in to patient portal', 'completed MFA login'])))
    await getDb().delete(patients).where(inArray(patients.id, [ID_PLAIN, ID_MFA]))
  })

  it('(g) the session issued after an email login carries the patientId, never the email', { timeout: 30000 }, async () => {
    const res = await login(req({ patientId: EMAIL_PLAIN, password: TEST_PASSWORD }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    const sessionCookie = res.cookies.get(cookieName('patient_session'))?.value
    expect(sessionCookie).toBeTruthy()
    const claims = decodeJwt(sessionCookie!)
    expect(claims.patientId).toBe(ID_PLAIN)
    expect(JSON.stringify(claims)).not.toContain(EMAIL_PLAIN)
  })

  it('(f) MFA-required email login: the pending cookie carries the resolved patientId, and the code step completes the login', { timeout: 30000 }, async () => {
    const res = await login(req({ patientId: EMAIL_MFA.toUpperCase(), password: TEST_PASSWORD }))
    expect(await res.json()).toEqual({ mfaRequired: true })
    expect(res.cookies.get(cookieName('patient_session'))).toBeFalsy()

    const pendingCookie = res.cookies.get(cookieName('pending_patient_mfa'))?.value
    expect(pendingCookie).toBeTruthy()
    const pendingClaims = decodeJwt(pendingCookie!)
    expect(pendingClaims.patientId).toBe(ID_MFA)
    expect(JSON.stringify(pendingClaims).toLowerCase()).not.toContain(EMAIL_MFA)

    const totp = new OTPAuth.TOTP({ issuer: brand.mfaIssuer, label: 'x', algorithm: 'SHA1', digits: 6, period: 30, secret })
    const verifyRes = await loginMfa(mfaReq({ code: totp.generate() }, `${cookieName('pending_patient_mfa')}=${pendingCookie}`))
    expect(verifyRes.status).toBe(200)
    const sessionClaims = decodeJwt(verifyRes.cookies.get(cookieName('patient_session'))!.value)
    expect(sessionClaims.patientId).toBe(ID_MFA)
  })
})
