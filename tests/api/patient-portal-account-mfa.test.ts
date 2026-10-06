// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { eq, and } from 'drizzle-orm'
import * as OTPAuth from 'otpauth'
import { brand } from '@/lib/brand'
import { setPatientSessionCookie, PATIENT_SESSION_COOKIE_NAME } from '@/lib/patient-session'
import { POST as enroll } from '@/app/api/patient-portal/account/mfa/enroll/route'
import { POST as confirm } from '@/app/api/patient-portal/account/mfa/confirm/route'
import { POST as reset } from '@/app/api/patient-portal/account/mfa/reset/route'
import { getDb } from '@/db/client'
import { patients, auditLog } from '@/db/schema'
import { setPatientPortalPassword, getPatientMfaState } from '@/lib/queries/patient-portal'

const TEST_PATIENT_ID = 'RD-ACCT-MFA-01'
const TEST_PASSWORD = 'acct-mfa-test-pass-123'

vi.mock('@/lib/rate-limit', () => ({
  checkPatientMfaRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  checkPatientLoginRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}))

// Route handlers are invoked directly in tests (no real Next.js server in
// front of them), so the project-wide `next/headers` mock in vitest.setup.ts
// stubs cookies() with a silent no-op. These routes all gate on
// requirePatientSession, which needs a *real* cookie read scoped to the
// request under test, not a global no-op -- same problem, same fix, as
// tests/api/login-mfa.test.ts and tests/api/patient-portal-login-mfa.test.ts:
// override the mock for this file only, with reads scoped to whatever
// request is "current" and writes captured into an outbox flushed onto the
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

// Mints a real, signed patient session cookie value (via the same
// SignJWT-backed helper the login flow uses) so requirePatientSession()
// accepts it, using the cookie-bridge mock above to capture what
// setPatientSessionCookie() writes.
async function mintSessionCookieValue(patientId: string): Promise<string> {
  currentRequestCookies = new Map()
  pendingResponseCookieOps = new Map()
  await setPatientSessionCookie(patientId)
  const op = pendingResponseCookieOps.get(PATIENT_SESSION_COOKIE_NAME)
  if (!op || op.deleted) throw new Error('failed to mint a patient session cookie for the test')
  return op.value
}

function reqWithSession(path: string, body: unknown, sessionCookieValue: string) {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', cookie: `${PATIENT_SESSION_COOKIE_NAME}=${sessionCookieValue}` },
  })
}

function enrollReq(sessionCookieValue: string) {
  return new NextRequest('http://localhost/api/patient-portal/account/mfa/enroll', {
    method: 'POST',
    headers: { cookie: `${PATIENT_SESSION_COOKIE_NAME}=${sessionCookieValue}` },
  })
}

beforeAll(async () => {
  await getDb().insert(patients).values({ id: TEST_PATIENT_ID, name: 'Account MFA Test Patient', dob: '1990-01-01' })
  await setPatientPortalPassword(TEST_PATIENT_ID, TEST_PASSWORD)
})

afterAll(async () => {
  await getDb().delete(auditLog).where(and(eq(auditLog.patientId, TEST_PATIENT_ID), eq(auditLog.action, 'failed MFA code entry during enrollment')))
  await getDb().delete(auditLog).where(and(eq(auditLog.patientId, TEST_PATIENT_ID), eq(auditLog.action, 'enrolled in patient portal MFA')))
  await getDb().delete(patients).where(eq(patients.id, TEST_PATIENT_ID))
})

describe('patient opt-in MFA', () => {
  let manualKey: string

  it('enroll returns a QR and manual key, and provisions an unconfirmed secret', async () => {
    const sessionCookieValue = await mintSessionCookieValue(TEST_PATIENT_ID)
    const res = await withCookieBridge(() => enroll(), enrollReq(sessionCookieValue))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.qrDataUrl).toMatch(/^data:image\/png/)
    manualKey = body.manualKey

    const state = await getPatientMfaState(TEST_PATIENT_ID)
    expect(state?.mfaEnabled).toBe(false)
    expect(state?.mfaSecretEncrypted).toBeTruthy()

    const auditEntries = await getDb().select().from(auditLog).where(and(eq(auditLog.patientId, TEST_PATIENT_ID), eq(auditLog.action, 'enrolled in patient portal MFA')))
    expect(auditEntries.length).toBe(1)
  })

  it('confirm rejects an incorrect code without enabling MFA', async () => {
    const sessionCookieValue = await mintSessionCookieValue(TEST_PATIENT_ID)
    const res = await withCookieBridge((request) => confirm(request), reqWithSession('/api/patient-portal/account/mfa/confirm', { code: '000000' }, sessionCookieValue))
    expect(res.status).toBe(401)
    expect((await getPatientMfaState(TEST_PATIENT_ID))?.mfaEnabled).toBe(false)

    const auditEntries = await getDb().select().from(auditLog).where(and(eq(auditLog.patientId, TEST_PATIENT_ID), eq(auditLog.action, 'failed MFA code entry during enrollment')))
    expect(auditEntries.length).toBeGreaterThan(0)
  })

  it('confirm with the correct code enables MFA', async () => {
    const totp = new OTPAuth.TOTP({ issuer: brand.mfaIssuer, label: 'x', algorithm: 'SHA1', digits: 6, period: 30, secret: manualKey })
    const sessionCookieValue = await mintSessionCookieValue(TEST_PATIENT_ID)
    const res = await withCookieBridge((request) => confirm(request), reqWithSession('/api/patient-portal/account/mfa/confirm', { code: totp.generate() }, sessionCookieValue))
    expect(res.status).toBe(200)
    expect((await getPatientMfaState(TEST_PATIENT_ID))?.mfaEnabled).toBe(true)
  })

  it('enroll rejects when MFA is already enabled', async () => {
    const sessionCookieValue = await mintSessionCookieValue(TEST_PATIENT_ID)
    const res = await withCookieBridge(() => enroll(), enrollReq(sessionCookieValue))
    expect(res.status).toBe(400)
  })

  it('reset rejects an incorrect password without disabling MFA', async () => {
    const sessionCookieValue = await mintSessionCookieValue(TEST_PATIENT_ID)
    const res = await withCookieBridge((request) => reset(request), reqWithSession('/api/patient-portal/account/mfa/reset', { password: 'totally-wrong-password' }, sessionCookieValue))
    expect(res.status).toBe(401)
    expect((await getPatientMfaState(TEST_PATIENT_ID))?.mfaEnabled).toBe(true)
  })

  it('reset with the correct password disables MFA', async () => {
    const sessionCookieValue = await mintSessionCookieValue(TEST_PATIENT_ID)
    const res = await withCookieBridge((request) => reset(request), reqWithSession('/api/patient-portal/account/mfa/reset', { password: TEST_PASSWORD }, sessionCookieValue))
    expect(res.status).toBe(200)
    expect(await getPatientMfaState(TEST_PATIENT_ID)).toEqual({ mfaSecretEncrypted: null, mfaEnabled: false })
  })

  it('confirm rejects when there is no enrollment in progress', async () => {
    const sessionCookieValue = await mintSessionCookieValue(TEST_PATIENT_ID)
    const res = await withCookieBridge((request) => confirm(request), reqWithSession('/api/patient-portal/account/mfa/confirm', { code: '123456' }, sessionCookieValue))
    expect(res.status).toBe(400)
  })

  it('rejects every route without a patient session', async () => {
    const noSessionEnroll = new NextRequest('http://localhost/api/patient-portal/account/mfa/enroll', { method: 'POST' })
    expect((await withCookieBridge(() => enroll(), noSessionEnroll)).status).toBe(401)

    const noSessionConfirm = new NextRequest('http://localhost/api/patient-portal/account/mfa/confirm', { method: 'POST', body: JSON.stringify({ code: '123456' }), headers: { 'Content-Type': 'application/json' } })
    expect((await withCookieBridge((request) => confirm(request), noSessionConfirm)).status).toBe(401)

    const noSessionReset = new NextRequest('http://localhost/api/patient-portal/account/mfa/reset', { method: 'POST', body: JSON.stringify({ password: TEST_PASSWORD }), headers: { 'Content-Type': 'application/json' } })
    expect((await withCookieBridge((request) => reset(request), noSessionReset)).status).toBe(401)
  })
})
