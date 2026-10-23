import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { users } from '@/db/schema'
import type { Session } from '@/lib/auth'
import { verifyPassword } from '@/lib/password'
import { verifyMfaCode } from '@/lib/mfa'
import { decryptSensitive } from '@/lib/crypto'

// WS7 T5 (spec D12): re-authentication before a high-stakes action such as
// signing a clinical note. The account password; or, for an account with no
// password (Google sign-in), a current TOTP code; the env-configured admin
// (userId null) re-authenticates against ADMIN_PASSWORD_HASH. Exactly one
// method applies to an account, and a proof for the other method is simply
// invalid. Nothing here logs, returns or stores the password or the code.
//
// The caller must rate-limit before calling (checkReauthRateLimit, keyed on
// reauthIdentity): this function is a password/TOTP oracle.

export type ReauthMethod = 'password' | 'totp'
export interface ReauthProof { password?: string; totpCode?: string }
export type ReauthResult = { ok: true; method: ReauthMethod } | { ok: false; error: 'invalid' | 'no_method' }
interface ReauthDeps { env?: NodeJS.ProcessEnv }

type AccountCredential =
  | { method: 'password'; passwordHash: string }
  | { method: 'totp'; secretEncrypted: string; userId: number }
  | null

async function credentialFor(session: Session, env: NodeJS.ProcessEnv): Promise<AccountCredential> {
  if (session.userId === null) {
    if (session.role !== 'admin') return null
    const hash = env.ADMIN_PASSWORD_HASH
    return hash ? { method: 'password', passwordHash: hash } : null
  }
  const [row] = await getDb()
    .select({ passwordHash: users.passwordHash, mfaEnabled: users.mfaEnabled, mfaSecretEncrypted: users.mfaSecretEncrypted })
    .from(users).where(eq(users.id, session.userId))
  if (!row) return null
  if (row.passwordHash) return { method: 'password', passwordHash: row.passwordHash }
  if (row.mfaEnabled && row.mfaSecretEncrypted) return { method: 'totp', secretEncrypted: row.mfaSecretEncrypted, userId: session.userId }
  return null
}

/** The rate-limit and TOTP-replay identity, the same shape the login routes use. */
export function reauthIdentity(session: Session): string {
  return session.userId === null ? `${session.role}:${session.name.toLowerCase()}` : `user:${session.userId}`
}

/** Which proof the signing dialog must ask this account for (null: none possible). */
export async function getReauthMethod(session: Session, deps: ReauthDeps = {}): Promise<ReauthMethod | null> {
  const credential = await credentialFor(session, deps.env ?? process.env)
  return credential?.method ?? null
}

export async function reauthenticate(session: Session, proof: ReauthProof, deps: ReauthDeps = {}): Promise<ReauthResult> {
  const credential = await credentialFor(session, deps.env ?? process.env)
  if (!credential) return { ok: false, error: 'no_method' }

  if (credential.method === 'password') {
    if (typeof proof.password !== 'string' || proof.password.length === 0) return { ok: false, error: 'invalid' }
    return verifyPassword(proof.password, credential.passwordHash) ? { ok: true, method: 'password' } : { ok: false, error: 'invalid' }
  }

  if (typeof proof.totpCode !== 'string' || !/^\d{6}$/.test(proof.totpCode)) return { ok: false, error: 'invalid' }
  let secretBase32: string
  try {
    secretBase32 = decryptSensitive(credential.secretEncrypted)
  } catch {
    // A stored secret that cannot be decrypted is a server-side fault no
    // code can fix: the account has no working second method.
    return { ok: false, error: 'no_method' }
  }
  // Same replay namespace as the login MFA step (`user:<id>`), so a code
  // just used to sign in cannot be replayed here, nor the reverse.
  const valid = await verifyMfaCode(secretBase32, proof.totpCode, `user:${credential.userId}`)
  return valid ? { ok: true, method: 'totp' } : { ok: false, error: 'invalid' }
}
