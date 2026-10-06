import { createHash } from 'node:crypto'
import * as OTPAuth from 'otpauth'
import QRCode from 'qrcode'
import { getRedis } from '@/lib/cache'
import { brand } from '@/lib/brand'

const ISSUER = brand.mfaIssuer

export interface MfaEnrollment {
  secretBase32: string
  qrDataUrl: string
}

// Generates a fresh TOTP secret and a scannable QR code for it. Returns the
// secret in plaintext base32 -- callers are responsible for encrypting it
// with lib/crypto.ts before it ever reaches a database row; this module
// never touches storage.
export async function generateMfaEnrollment(accountLabel: string): Promise<MfaEnrollment> {
  const secret = new OTPAuth.Secret({ size: 20 })
  const totp = new OTPAuth.TOTP({ issuer: ISSUER, label: accountLabel, algorithm: 'SHA1', digits: 6, period: 30, secret })
  const qrDataUrl = await QRCode.toDataURL(totp.toString())
  return { secretBase32: secret.base32, qrDataUrl }
}

const PERIOD_SECONDS = 30

// A code is accepted while the server's current time-step is within one
// step of the code's own step (window: 1 below), so a code consumed at the
// very start of its earliest acceptable step stays valid for up to 3 steps
// (90s). The used-marker must outlive that; 120s adds margin for clock
// skew between app instances without letting markers pile up.
const USED_CODE_TTL_SECONDS = 120

// window: 1 tolerates the code from the immediately preceding or following
// 30s period, absorbing normal clock drift between the server and the
// authenticator app without meaningfully widening the guessable window.
//
// Replay protection (RFC 6238 §5.2 -- a verifier MUST NOT accept a second
// use of the same OTP): on a successful match, atomically claim the matched
// time-step for this identity in Redis with SET NX. If the claim already
// exists, this exact step's code was already consumed -- someone who
// shoulder-surfed, phished, or intercepted a code can't reuse it inside its
// validity window. Scoped per identity (the same identity string each route
// already rate-limits on: 'admin' / `user:${id}` for staff, the patient id
// for patients), so two accounts that happen to share a step never block
// each other. The key also carries a short hash of the secret (never the
// secret itself): after a reset + re-enrollment the new secret's codes are
// a different namespace, so the first code from the new authenticator isn't
// wrongly rejected just because the old secret consumed the same step a
// minute earlier -- and a code from the old secret can't validate against
// the new one anyway, so this doesn't open any replay. Fails closed: if
// Redis is unreachable this throws rather than accepting an unverifiable
// code.
export async function verifyMfaCode(secretBase32: string, code: string, identity: string): Promise<boolean> {
  const totp = new OTPAuth.TOTP({ issuer: ISSUER, label: 'verify', algorithm: 'SHA1', digits: 6, period: PERIOD_SECONDS, secret: secretBase32 })
  // One timestamp for both the check and the step math, so a request that
  // straddles a 30s boundary can't validate against one step and record
  // another.
  const timestamp = Date.now()
  const delta = totp.validate({ token: code, timestamp, window: 1 })
  if (delta === null) return false

  const matchedStep = totp.counter({ timestamp }) + delta
  const secretTag = createHash('sha256').update(secretBase32).digest('hex').slice(0, 16)
  const claimed = await getRedis().set(`mfa-used:${identity}:${secretTag}:${matchedStep}`, 1, { nx: true, ex: USED_CODE_TTL_SECONDS })
  return claimed === 'OK'
}
