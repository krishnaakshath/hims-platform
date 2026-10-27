// WS7 T5: re-authentication for signing a clinical note (spec D12). The
// account password, or a current TOTP code for an account without a password
// (Google sign-in); the env-configured admin re-authenticates against
// ADMIN_PASSWORD_HASH.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { inArray } from 'drizzle-orm'
import * as OTPAuth from 'otpauth'
import { getDb } from '@/db/client'
import { users } from '@/db/schema'
import { hashPassword } from '@/lib/password'
import { encryptSensitive } from '@/lib/crypto'
import { reauthenticate, getReauthMethod } from '@/lib/reauth'
import type { Session } from '@/lib/auth'

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const PASSWORD = `Reauth-Test-${RUN}`
const TOTP_SECRET = new OTPAuth.Secret({ size: 20 }).base32
const createdUserIds: number[] = []
let passwordUserId = 0
let totpUserId = 0
let noMethodUserId = 0
let adminHash = ''

function totpNow(): string {
  return new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: TOTP_SECRET }).generate()
}

beforeAll(async () => {
  const [pw] = await getDb().insert(users).values({ name: 'Dr. Reauth Password', email: `reauth-pw-${RUN}@test.local`, role: 'pi', passwordHash: hashPassword(PASSWORD) }).returning()
  const [totp] = await getDb().insert(users).values({ name: 'Dr. Reauth Google', email: `reauth-totp-${RUN}@test.local`, role: 'pi', googleSub: `sub-${RUN}`, mfaSecretEncrypted: encryptSensitive(TOTP_SECRET), mfaEnabled: true }).returning()
  const [none] = await getDb().insert(users).values({ name: 'Dr. Reauth None', email: `reauth-none-${RUN}@test.local`, role: 'pi', googleSub: `sub2-${RUN}` }).returning()
  passwordUserId = pw.id
  totpUserId = totp.id
  noMethodUserId = none.id
  createdUserIds.push(pw.id, totp.id, none.id)
  adminHash = hashPassword(PASSWORD)
})

afterAll(async () => {
  if (createdUserIds.length > 0) await getDb().delete(users).where(inArray(users.id, createdUserIds))
})

const userSession = (userId: number): Session => ({ role: 'pi', name: 'Dr. Reauth', userId })
const envWith = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv
const envAdmin: Session = { role: 'admin', name: 'Hospital Admin', userId: null }

describe('reauthenticate', () => {
  it('accepts the account password for a user with a password', async () => {
    expect(await reauthenticate(userSession(passwordUserId), { password: PASSWORD })).toEqual({ ok: true, method: 'password' })
  })

  it('rejects a wrong password', async () => {
    expect(await reauthenticate(userSession(passwordUserId), { password: 'not-the-password' })).toEqual({ ok: false, error: 'invalid' })
  })

  it('rejects a TOTP code from an account that has a password', async () => {
    expect(await reauthenticate(userSession(passwordUserId), { totpCode: '123456' })).toEqual({ ok: false, error: 'invalid' })
  })

  it('accepts a current TOTP code for an account without a password (Google sign-in)', async () => {
    expect(await reauthenticate(userSession(totpUserId), { totpCode: totpNow() })).toEqual({ ok: true, method: 'totp' })
  })

  it('rejects a wrong TOTP code and a password for a TOTP-only account', async () => {
    const wrong = totpNow() === '000000' ? '111111' : '000000'
    expect(await reauthenticate(userSession(totpUserId), { totpCode: wrong })).toEqual({ ok: false, error: 'invalid' })
    expect(await reauthenticate(userSession(totpUserId), { password: PASSWORD })).toEqual({ ok: false, error: 'invalid' })
  })

  it('reports no_method for an account with neither a password nor TOTP', async () => {
    expect(await reauthenticate(userSession(noMethodUserId), { password: PASSWORD })).toEqual({ ok: false, error: 'no_method' })
  })

  it('reports no_method for a userId with no users row', async () => {
    expect(await reauthenticate(userSession(2_000_000_000), { password: PASSWORD })).toEqual({ ok: false, error: 'no_method' })
  })

  it('re-authenticates the env admin against ADMIN_PASSWORD_HASH', async () => {
    const env = envWith({ ADMIN_PASSWORD_HASH: adminHash })
    expect(await reauthenticate(envAdmin, { password: PASSWORD }, { env })).toEqual({ ok: true, method: 'password' })
    expect(await reauthenticate(envAdmin, { password: 'wrong' }, { env })).toEqual({ ok: false, error: 'invalid' })
    expect(await reauthenticate(envAdmin, { totpCode: '123456' }, { env })).toEqual({ ok: false, error: 'invalid' })
  })

  it('reports no_method for the env admin when ADMIN_PASSWORD_HASH is unset, and for a non-admin with no userId', async () => {
    expect(await reauthenticate(envAdmin, { password: PASSWORD }, { env: envWith({}) })).toEqual({ ok: false, error: 'no_method' })
    expect(await reauthenticate({ role: 'pi', name: 'X', userId: null }, { password: PASSWORD }, { env: envWith({ ADMIN_PASSWORD_HASH: adminHash }) })).toEqual({ ok: false, error: 'no_method' })
  })
})

describe('getReauthMethod', () => {
  it('names the method the signing dialog must ask for', async () => {
    expect(await getReauthMethod(userSession(passwordUserId))).toBe('password')
    expect(await getReauthMethod(userSession(totpUserId))).toBe('totp')
    expect(await getReauthMethod(userSession(noMethodUserId))).toBeNull()
    expect(await getReauthMethod(envAdmin, { env: envWith({ ADMIN_PASSWORD_HASH: adminHash }) })).toBe('password')
    expect(await getReauthMethod(envAdmin, { env: envWith({}) })).toBeNull()
  })
})
