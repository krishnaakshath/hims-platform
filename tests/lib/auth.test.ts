// @vitest-environment node
//
// This file is forced onto the plain Node environment rather than the
// project-wide jsdom default: jose's HS256 signer does a strict
// `instanceof Uint8Array` check, and under jsdom that check runs against a
// *different* global realm than the one `new TextEncoder().encode()` (used
// by src/lib/auth.ts) constructs its value in -- so a genuine Uint8Array
// fails jose's own type guard with a jsdom-only, false-positive
// "must be one of type ... Received an instance of Uint8Array" error.
// Confirmed by reproducing the exact same jose call in plain Node (works)
// vs under vitest's jsdom environment (fails) before adding this directive.
import { describe, it, expect } from 'vitest'
import { parseSessionCookie, buildSessionCookieValue } from '@/lib/auth'

describe('auth session cookie', () => {
  it('round-trips role, name and userId through the cookie value', async () => {
    const value = await buildSessionCookieValue('pi', 'Dr. R. Kunam', 42)
    expect(await parseSessionCookie(value)).toEqual({ role: 'pi', name: 'Dr. R. Kunam', userId: 42 })
  })

  it('round-trips a null userId for the env-admin account, which has no users row', async () => {
    const value = await buildSessionCookieValue('admin', 'Sam Patel', null)
    expect(await parseSessionCookie(value)).toEqual({ role: 'admin', name: 'Sam Patel', userId: null })
  })

  // DEPLOY-COMPATIBILITY REGRESSION. Staff cookies live up to 8 hours, so
  // cookies minted before the userId claim existed are still presented
  // after this ships. parseSessionCookie returning null for them would not
  // merely drop the claim -- getSession(), requireSession() and proxy.ts
  // all read null as "no session", so every signed-in staff member would
  // be logged out at deploy. An ABSENT claim is a valid old cookie.
  it('parses a pre-existing cookie that carries no userId claim as a valid session with userId: null', async () => {
    const { SignJWT } = await import('jose')
    const secret = new TextEncoder().encode(process.env.SESSION_SECRET)
    const oldCookie = await new SignJWT({ kind: 'staff', role: 'pi', name: 'Dr. R. Kunam' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('8h')
      .sign(secret)
    expect(await parseSessionCookie(oldCookie)).toEqual({ role: 'pi', name: 'Dr. R. Kunam', userId: null })
  })

  // A claim that is PRESENT but not a number is a malformed or tampered
  // token, not an old one -- that case still rejects.
  it('rejects a validly-signed token whose userId claim is present but not a number', async () => {
    const { SignJWT } = await import('jose')
    const secret = new TextEncoder().encode(process.env.SESSION_SECRET)
    const bad = await new SignJWT({ kind: 'staff', role: 'admin', name: 'x', userId: 'not-a-number' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(secret)
    expect(await parseSessionCookie(bad)).toBeNull()
  })

  it('returns null for a malformed cookie value', async () => {
    expect(await parseSessionCookie('not-json')).toBeNull()
  })

  // Regression test for a real, previously-shipped vulnerability: the cookie
  // used to be a bare JSON.stringify({role, name}) with no signature, so
  // anyone could set `Cookie: <session cookie>={"role":"admin","name":"x"}`
  // and receive a fully authenticated admin session with no password at all.
  // Signing it with a server-only secret (HS256 JWT) means a hand-crafted,
  // unsigned payload must now fail verification.
  it('rejects a hand-crafted, unsigned cookie value claiming admin -- the exact forged-session attack this signing fix closes', async () => {
    const forged = Buffer.from(JSON.stringify({ role: 'admin', name: 'attacker' })).toString('base64')
    expect(await parseSessionCookie(forged)).toBeNull()
    expect(await parseSessionCookie(JSON.stringify({ role: 'admin', name: 'attacker' }))).toBeNull()
  })

  it('rejects a token signed with the wrong secret', async () => {
    const { SignJWT } = await import('jose')
    const wrongSecretToken = await new SignJWT({ role: 'admin', name: 'attacker' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('not-the-real-session-secret'))
    expect(await parseSessionCookie(wrongSecretToken)).toBeNull()
  })

  it('rejects an expired token even with a valid signature', async () => {
    const { SignJWT } = await import('jose')
    const secret = new TextEncoder().encode(process.env.SESSION_SECRET)
    const expiredToken = await new SignJWT({ role: 'admin', name: 'Sam Patel' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1800)
      .sign(secret)
    expect(await parseSessionCookie(expiredToken)).toBeNull()
  })

  it('rejects a validly-signed token with a role outside the enum', async () => {
    const { SignJWT } = await import('jose')
    const secret = new TextEncoder().encode(process.env.SESSION_SECRET)
    const tokenWithBadRole = await new SignJWT({ role: 'superadmin', name: 'x' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(secret)
    expect(await parseSessionCookie(tokenWithBadRole)).toBeNull()
  })

  it('rejects a validly-signed token missing the staff `kind` claim -- the exact pending-MFA-cookie-replay attack this check closes', async () => {
    const { SignJWT } = await import('jose')
    const secret = new TextEncoder().encode(process.env.SESSION_SECRET)
    // Same role+name shape a pending-staff-mfa cookie carries (see
    // mfa-pending-session.ts) -- proves that token can't be replayed here.
    const tokenWithoutKind = await new SignJWT({ role: 'admin', name: 'Sam Patel' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(secret)
    expect(await parseSessionCookie(tokenWithoutKind)).toBeNull()
  })

  it('parses a validly-signed token carrying the pharmacy role', async () => {
    const value = await buildSessionCookieValue('pharmacy', 'Robin Shah', null)
    expect(await parseSessionCookie(value)).toEqual({ role: 'pharmacy', name: 'Robin Shah', userId: null })
  })
})
