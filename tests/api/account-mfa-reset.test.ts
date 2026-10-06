// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { hashPassword } from '@/lib/password'
import { buildSessionCookieValue, SESSION_COOKIE_NAME } from '@/lib/auth'
import { POST as resetMfa } from '@/app/api/account/mfa/reset/route'
import { getDb } from '@/db/client'
import { users, appSettings } from '@/db/schema'
import { setUserMfaSecret, enableUserMfa, getUserMfaState } from '@/lib/queries/users'
import { setAdminMfaSecret, enableAdminMfa, getAdminMfaState } from '@/lib/queries/settings'
import { verifyPassword } from '@/lib/password'
import { checkAccountMfaResetRateLimit } from '@/lib/rate-limit'

const TEST_PASSWORD = 'pi-reset-test-pass-123'
const TEST_EMAIL = 'test-account-mfa-reset@example.com'
let testUserId: number

// The limiter is real Upstash Redis shared with production; mocked here so
// re-running this file inside one sliding window can't turn an unrelated
// assertion into a 429. The limiter itself is unit-tested against Redis in
// tests/lib/rate-limit.test.ts.
vi.mock('@/lib/rate-limit', () => ({
  checkAccountMfaResetRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}))

// Wrapped (not replaced) so every test still checks real passwords, but the
// rate-limit test can prove the throttle fires *before* any password check.
vi.mock('@/lib/password', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/password')>()
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) }
})

// app_settings is a single, shared, LIVE row -- the admin MFA columns on it
// are the real admin's real enrollment. This file has to write to them to
// exercise the admin self-reset path, so it snapshots their exact values
// first and writes them back afterwards, leaving the row exactly as found.
let adminMfaSnapshot: { id: number; adminMfaSecretEncrypted: string | null; adminMfaEnabled: boolean } | undefined

// Route handler modules are invoked directly (no real Next.js server in
// front of them), so `next/headers`'s cookies() has no request-scoped
// async-local-storage context. vitest.setup.ts's project-wide mock papers
// over that with a silent no-op that always returns "no cookie" -- fine for
// routes that only check "is there a session" against a real HTTP request,
// but useless here, where the test needs requireSession() to actually see
// the session cookie this file puts on each NextRequest. This overrides that
// global mock, for this file only, with a cookies() read scoped to whatever
// request is "current" -- same pattern Tasks 5/6 established in
// login-mfa.test.ts / patient-portal-login-mfa.test.ts.
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

async function callReset(request: NextRequest) {
  currentRequestCookies = parseCookieHeader(request.headers.get('cookie'))
  return resetMfa(request)
}

beforeAll(async () => {
  ;[adminMfaSnapshot] = await getDb()
    .select({ id: appSettings.id, adminMfaSecretEncrypted: appSettings.adminMfaSecretEncrypted, adminMfaEnabled: appSettings.adminMfaEnabled })
    .from(appSettings)
  vi.stubEnv('ADMIN_EMAIL', 'admin@example.com')
  vi.stubEnv('ADMIN_PASSWORD_HASH', hashPassword('admin-test-pass'))
  vi.stubEnv('ADMIN_NAME', 'Test Admin')
  const [row] = await getDb().insert(users).values({ name: 'Reset Test PI', email: TEST_EMAIL, role: 'pi', passwordHash: hashPassword(TEST_PASSWORD) }).returning()
  testUserId = row.id
  await setUserMfaSecret(testUserId, 'enc-secret')
  await enableUserMfa(testUserId)
})

afterAll(async () => {
  vi.unstubAllEnvs()
  // Restore first, so a failure in the fixture cleanup below can't skip it.
  if (adminMfaSnapshot) {
    await getDb().update(appSettings)
      .set({ adminMfaSecretEncrypted: adminMfaSnapshot.adminMfaSecretEncrypted, adminMfaEnabled: adminMfaSnapshot.adminMfaEnabled })
      .where(eq(appSettings.id, adminMfaSnapshot.id))
  }
  await getDb().delete(users).where(eq(users.id, testUserId))
})

async function reqAs(role: 'admin' | 'pi' | 'crc', name: string, body: unknown) {
  const cookie = await buildSessionCookieValue(role, name, null)
  return new NextRequest('http://localhost/api/account/mfa/reset', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
  })
}

describe('self-service MFA reset', () => {
  it('resets the signed-in DB user\'s own MFA with correct credentials', async () => {
    const res = await callReset(await reqAs('pi', 'Reset Test PI', { email: TEST_EMAIL, password: TEST_PASSWORD }))
    expect(res.status).toBe(200)
    expect((await getUserMfaState(testUserId))?.mfaEnabled).toBe(false)
  })

  it('resets the admin\'s own MFA with correct env credentials', async () => {
    await setAdminMfaSecret('enc-admin-secret')
    await enableAdminMfa()
    const res = await callReset(await reqAs('admin', 'Test Admin', { email: 'admin@example.com', password: 'admin-test-pass' }))
    expect(res.status).toBe(200)
    expect((await getAdminMfaState()).mfaEnabled).toBe(false)
  })

  it('rejects a wrong password', async () => {
    const res = await callReset(await reqAs('pi', 'Reset Test PI', { email: TEST_EMAIL, password: 'wrong' }))
    expect(res.status).toBe(401)
  })

  it('rejects valid credentials for a DIFFERENT account than the caller\'s own session', async () => {
    // A signed-in `pi` session submitting the real admin credentials should
    // not be able to reset the admin's MFA -- see the Review Focus item.
    const res = await callReset(await reqAs('pi', 'Reset Test PI', { email: 'admin@example.com', password: 'admin-test-pass' }))
    expect(res.status).toBe(401)
  })

  it('rejects a signed-in admin session submitting a different staff member\'s genuinely-correct credentials', async () => {
    // Symmetric to the pi-submits-admin-credentials case above: the earlier
    // "resets the signed-in DB user's own MFA" test already disabled this
    // user's MFA, so re-enable it here to prove this rejected attempt --
    // made with the pi user's own real password, but from an `admin`
    // session -- truly has no effect on it.
    await setUserMfaSecret(testUserId, 'enc-secret-2')
    await enableUserMfa(testUserId)
    const res = await callReset(await reqAs('admin', 'Test Admin', { email: TEST_EMAIL, password: TEST_PASSWORD }))
    expect(res.status).toBe(401)
    expect((await getUserMfaState(testUserId))?.mfaEnabled).toBe(true)
  })

  it('returns 429 when rate-limited, before any password is checked, even with correct credentials', async () => {
    // The previous test left this user enrolled; submitting their genuinely
    // correct password while throttled must neither reach verifyPassword
    // (no password oracle) nor clear their MFA.
    vi.mocked(verifyPassword).mockClear()
    vi.mocked(checkAccountMfaResetRateLimit).mockResolvedValueOnce({ allowed: false })
    const res = await callReset(await reqAs('pi', 'Reset Test PI', { email: TEST_EMAIL, password: TEST_PASSWORD }))
    expect(res.status).toBe(429)
    expect(verifyPassword).not.toHaveBeenCalled()
    expect((await getUserMfaState(testUserId))?.mfaEnabled).toBe(true)
  })

  it('keys the rate limit on the submitted email, and throttles the admin branch too', async () => {
    await setAdminMfaSecret('enc-admin-secret')
    await enableAdminMfa()
    vi.mocked(checkAccountMfaResetRateLimit).mockClear()
    vi.mocked(verifyPassword).mockClear()
    vi.mocked(checkAccountMfaResetRateLimit).mockResolvedValueOnce({ allowed: false })
    const res = await callReset(await reqAs('admin', 'Test Admin', { email: 'Admin@Example.com', password: 'admin-test-pass' }))
    expect(res.status).toBe(429)
    expect(checkAccountMfaResetRateLimit).toHaveBeenCalledWith(expect.any(String), 'Admin@Example.com')
    expect(verifyPassword).not.toHaveBeenCalled()
    expect((await getAdminMfaState()).mfaEnabled).toBe(true)
  })
})
