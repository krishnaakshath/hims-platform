// tests/api/reset-mfa-admin.test.ts
// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { hashPassword } from '@/lib/password'
import { buildSessionCookieValue, SESSION_COOKIE_NAME } from '@/lib/auth'
import { POST as resetUserMfaRoute } from '@/app/api/users/[id]/reset-mfa/route'
import { POST as resetPatientMfaRoute } from '@/app/api/patients/[anonId]/reset-mfa/route'
import { getDb } from '@/db/client'
import { users, patients } from '@/db/schema'
import { setUserMfaSecret, enableUserMfa, getUserMfaState } from '@/lib/queries/users'
import { setPatientMfaSecret, enablePatientMfa, getPatientMfaState } from '@/lib/queries/patient-portal'

const TEST_EMAIL = 'test-admin-reset-target@example.com'
const TEST_PATIENT_ID = 'RD-ADMIN-RESET-01'
let testUserId: number

// Route handler modules are invoked directly (no real Next.js server in
// front of them), so `next/headers`'s cookies() has no request-scoped
// async-local-storage context. vitest.setup.ts's project-wide mock papers
// over that with a silent no-op that always returns "no cookie" -- fine for
// routes that only check "is there a session" against a real HTTP request,
// but useless here, where the test needs requireSession() to actually see
// the session cookie this file puts on each NextRequest. This overrides that
// global mock, for this file only, with a cookies() read scoped to whatever
// request is "current" -- same pattern established in
// account-mfa-reset.test.ts / login-mfa.test.ts.
let currentRequestCookies = new Map<string, string>()

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
    get: (name: string) => (currentRequestCookies.has(name) ? { value: currentRequestCookies.get(name) } : undefined),
    set: () => {},
  }),
}))

beforeAll(async () => {
  const [row] = await getDb().insert(users).values({ name: 'Admin Reset Target', email: TEST_EMAIL, role: 'crc', passwordHash: hashPassword('irrelevant') }).returning()
  testUserId = row.id
  await setUserMfaSecret(testUserId, 'enc')
  await enableUserMfa(testUserId)

  await getDb().insert(patients).values({ id: TEST_PATIENT_ID, name: 'Admin Reset Target Patient', dob: '1990-01-01' })
  await setPatientMfaSecret(TEST_PATIENT_ID, 'enc')
  await enablePatientMfa(TEST_PATIENT_ID)
})

afterAll(async () => {
  await getDb().delete(users).where(eq(users.id, testUserId))
  await getDb().delete(patients).where(eq(patients.id, TEST_PATIENT_ID))
})

async function cookieFor(role: 'admin' | 'pi' | 'crc', name: string) {
  return `${SESSION_COOKIE_NAME}=${await buildSessionCookieValue(role, name, null)}`
}

async function callResetUserMfa(req: NextRequest, params: { id: string }) {
  currentRequestCookies = parseCookieHeader(req.headers.get('cookie'))
  return resetUserMfaRoute(req, { params: Promise.resolve(params) })
}

async function callResetPatientMfa(req: NextRequest, params: { anonId: string }) {
  currentRequestCookies = parseCookieHeader(req.headers.get('cookie'))
  return resetPatientMfaRoute(req, { params: Promise.resolve(params) })
}

describe('admin-triggered MFA reset', () => {
  it('rejects a non-admin caller for the staff reset route', async () => {
    const req = new NextRequest(`http://localhost/api/users/${testUserId}/reset-mfa`, { method: 'POST', headers: { cookie: await cookieFor('crc', 'Some CRC') } })
    const res = await callResetUserMfa(req, { id: String(testUserId) })
    expect(res.status).toBe(403)
  })

  it('admin resets a staff member\'s MFA', async () => {
    const req = new NextRequest(`http://localhost/api/users/${testUserId}/reset-mfa`, { method: 'POST', headers: { cookie: await cookieFor('admin', 'Test Admin') } })
    const res = await callResetUserMfa(req, { id: String(testUserId) })
    expect(res.status).toBe(200)
    expect((await getUserMfaState(testUserId))?.mfaEnabled).toBe(false)
  })

  it('rejects a non-admin caller for the patient reset route', async () => {
    const req = new NextRequest(`http://localhost/api/patients/${TEST_PATIENT_ID}/reset-mfa`, { method: 'POST', headers: { cookie: await cookieFor('pi', 'Some PI') } })
    const res = await callResetPatientMfa(req, { anonId: TEST_PATIENT_ID })
    expect(res.status).toBe(403)
  })

  it('admin resets a patient\'s MFA', async () => {
    const req = new NextRequest(`http://localhost/api/patients/${TEST_PATIENT_ID}/reset-mfa`, { method: 'POST', headers: { cookie: await cookieFor('admin', 'Test Admin') } })
    const res = await callResetPatientMfa(req, { anonId: TEST_PATIENT_ID })
    expect(res.status).toBe(200)
    expect(await getPatientMfaState(TEST_PATIENT_ID)).toEqual({ mfaSecretEncrypted: null, mfaEnabled: false })
  })
})
