// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { buildSessionCookieValue, SESSION_COOKIE_NAME } from '@/lib/auth'
import { PUT } from '@/app/api/account/mfa-method/route'
import { getDb } from '@/db/client'
import { users } from '@/db/schema'
import { hashPassword } from '@/lib/password'

// The limiter is real Upstash Redis shared with production; mocked here so
// re-running this file inside one sliding window can't turn an unrelated
// assertion into a 429 -- same reasoning as tests/api/account-mfa-reset.test.ts,
// which exercises the identical checkAccountMfaResetRateLimit this route now
// also calls.
vi.mock('@/lib/rate-limit', () => ({
  checkAccountMfaResetRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}))

// Route handler modules are invoked directly (no real Next.js server in
// front of them), so `next/headers`'s cookies() has no request-scoped
// async-local-storage context. vitest.setup.ts's project-wide mock papers
// over that with a silent no-op that always returns "no cookie" -- fine for
// routes that only check "is there a session", but useless here, where the
// test needs requireSession() to actually see the session cookie this file
// puts on each request. Same override as tests/api/account-mfa-reset.test.ts.
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

async function callPut(request: NextRequest) {
  currentRequestCookies = parseCookieHeader(request.headers.get('cookie'))
  return PUT(request)
}

const createdIds: number[] = []
afterEach(async () => {
  while (createdIds.length > 0) await getDb().delete(users).where(eq(users.id, createdIds.pop()!))
})

async function reqAs(role: 'crc', name: string, body: unknown) {
  const cookie = await buildSessionCookieValue(role, name, null)
  return new NextRequest('http://localhost/api/account/mfa-method', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
  })
}

describe('PUT /api/account/mfa-method', () => {
  it('rejects switching to sms when no phone is provided and none is on file', async () => {
    const [created] = await getDb().insert(users).values({ name: 'Method Test User', email: 'method-test-user@example.com', role: 'crc', passwordHash: hashPassword('MethodTest123!'), mfaMethod: 'totp' }).returning()
    createdIds.push(created.id)

    const res = await callPut(await reqAs('crc', 'Method Test User', { method: 'sms', email: 'method-test-user@example.com', password: 'MethodTest123!' }))
    expect(res.status).toBe(400)
  })

  it('switches to sms and stores the phone when one is provided, with a correct password', async () => {
    const [created] = await getDb().insert(users).values({ name: 'Method Test User 2', email: 'method-test-user-2@example.com', role: 'crc', passwordHash: hashPassword('MethodTest123!'), mfaMethod: 'totp' }).returning()
    createdIds.push(created.id)

    const res = await callPut(await reqAs('crc', 'Method Test User 2', { method: 'sms', email: 'method-test-user-2@example.com', password: 'MethodTest123!', phone: '+15559876543' }))
    expect(res.status).toBe(200)

    const [row] = await getDb().select().from(users).where(eq(users.id, created.id))
    expect(row.mfaMethod).toBe('sms')
    expect(row.phone).toBe('+15559876543')
    expect(row.mfaSecretEncrypted).toBeNull()
    expect(row.mfaEnabled).toBe(false)
  })

  it('rejects a wrong password', async () => {
    const [created] = await getDb().insert(users).values({ name: 'Method Test User 3', email: 'method-test-user-3@example.com', role: 'crc', passwordHash: hashPassword('MethodTest123!'), mfaMethod: 'totp' }).returning()
    createdIds.push(created.id)

    const res = await callPut(await reqAs('crc', 'Method Test User 3', { method: 'email', email: 'method-test-user-3@example.com', password: 'wrong-password' }))
    expect(res.status).toBe(401)

    const [row] = await getDb().select().from(users).where(eq(users.id, created.id))
    expect(row.mfaMethod).toBe('totp')
  })

  it('rejects valid credentials for a DIFFERENT account than the caller\'s own session', async () => {
    // A signed-in "Method Test User 4" session submitting some OTHER real
    // user's genuinely-correct credentials must not be able to switch that
    // other account's MFA method -- this is the exact class of bug the
    // whole-branch review found (identity resolved by session, credentials
    // re-verified, but only ever applied to the re-verified account, never
    // to the session's own display name).
    const [caller] = await getDb().insert(users).values({ name: 'Method Test User 4', email: 'method-test-user-4@example.com', role: 'crc', passwordHash: hashPassword('CallerPass123!'), mfaMethod: 'totp' }).returning()
    createdIds.push(caller.id)
    const [victim] = await getDb().insert(users).values({ name: 'Method Test Victim', email: 'method-test-victim@example.com', role: 'crc', passwordHash: hashPassword('VictimPass123!'), mfaMethod: 'totp' }).returning()
    createdIds.push(victim.id)

    const res = await callPut(await reqAs('crc', 'Method Test User 4', { method: 'email', email: 'method-test-victim@example.com', password: 'VictimPass123!' }))
    expect(res.status).toBe(401)

    const [victimRow] = await getDb().select().from(users).where(eq(users.id, victim.id))
    expect(victimRow.mfaMethod).toBe('totp')
  })

  it('returns 429 when rate-limited, before any credential is checked', async () => {
    const { checkAccountMfaResetRateLimit } = await import('@/lib/rate-limit')
    const [created] = await getDb().insert(users).values({ name: 'Method Test User 5', email: 'method-test-user-5@example.com', role: 'crc', passwordHash: hashPassword('MethodTest123!'), mfaMethod: 'totp' }).returning()
    createdIds.push(created.id)

    vi.mocked(checkAccountMfaResetRateLimit).mockResolvedValueOnce({ allowed: false })
    const res = await callPut(await reqAs('crc', 'Method Test User 5', { method: 'email', email: 'method-test-user-5@example.com', password: 'MethodTest123!' }))
    expect(res.status).toBe(429)

    const [row] = await getDb().select().from(users).where(eq(users.id, created.id))
    expect(row.mfaMethod).toBe('totp')
  })
})
