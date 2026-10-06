import { cookies } from 'next/headers'
import { SignJWT, jwtVerify } from 'jose'
import type { Role } from './auth'
import { cookieName } from '@/lib/brand'

// Bridges the two-step MFA login flow: step 1 (password check) mints one of
// these; step 2 (code check) reads it to know whose login is mid-flight and
// whether this is a first-time enrollment or a returning verify. Separate
// cookie names and a `kind` claim keep these from ever being confused with
// the real, fully-authenticated session cookies in auth.ts/patient-session.ts,
// even though all three share the same SESSION_SECRET and jose signing setup.
const STAFF_COOKIE_NAME = cookieName('pending_staff_mfa')
const PATIENT_COOKIE_NAME = cookieName('pending_patient_mfa')
const PENDING_MAX_AGE_SECONDS = 5 * 60 // long enough to scan a QR code and type a 6-digit code, short enough that an abandoned mid-login state can't be resumed much later

function getSessionSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET
  if (!secret) throw new Error('SESSION_SECRET is not configured')
  return new TextEncoder().encode(secret)
}

export interface PendingStaffMfaSession {
  role: Role
  name: string
  mode: 'enroll' | 'verify'
  userId: number | null // null = the env-based admin account
  method: 'totp' | 'sms' | 'email'
}

export async function setPendingStaffMfaCookie(session: PendingStaffMfaSession): Promise<void> {
  const store = await cookies()
  const value = await new SignJWT({ kind: 'pending-staff-mfa', role: session.role, name: session.name, mode: session.mode, userId: session.userId, method: session.method })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${PENDING_MAX_AGE_SECONDS}s`)
    .sign(getSessionSecret())
  store.set(STAFF_COOKIE_NAME, value, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: PENDING_MAX_AGE_SECONDS })
}

export async function getPendingStaffMfaSession(): Promise<PendingStaffMfaSession | null> {
  const store = await cookies()
  const raw = store.get(STAFF_COOKIE_NAME)?.value
  if (!raw) return null
  try {
    const { payload } = await jwtVerify(raw, getSessionSecret())
    if (
      payload.kind === 'pending-staff-mfa' &&
      typeof payload.name === 'string' &&
      (payload.mode === 'enroll' || payload.mode === 'verify') &&
      (payload.userId === null || typeof payload.userId === 'number') &&
      (payload.method === 'totp' || payload.method === 'sms' || payload.method === 'email')
    ) {
      return { role: payload.role as Role, name: payload.name, mode: payload.mode, userId: payload.userId as number | null, method: payload.method }
    }
    return null
  } catch {
    return null
  }
}

export async function clearPendingStaffMfaCookie(): Promise<void> {
  const store = await cookies()
  store.delete(STAFF_COOKIE_NAME)
}

export interface PendingPatientMfaSession {
  patientId: string
}

export async function setPendingPatientMfaCookie(session: PendingPatientMfaSession): Promise<void> {
  const store = await cookies()
  const value = await new SignJWT({ kind: 'pending-patient-mfa', patientId: session.patientId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${PENDING_MAX_AGE_SECONDS}s`)
    .sign(getSessionSecret())
  store.set(PATIENT_COOKIE_NAME, value, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: PENDING_MAX_AGE_SECONDS })
}

export async function getPendingPatientMfaSession(): Promise<PendingPatientMfaSession | null> {
  const store = await cookies()
  const raw = store.get(PATIENT_COOKIE_NAME)?.value
  if (!raw) return null
  try {
    const { payload } = await jwtVerify(raw, getSessionSecret())
    if (payload.kind === 'pending-patient-mfa' && typeof payload.patientId === 'string' && payload.patientId.length > 0) {
      return { patientId: payload.patientId }
    }
    return null
  } catch {
    return null
  }
}

export async function clearPendingPatientMfaCookie(): Promise<void> {
  const store = await cookies()
  store.delete(PATIENT_COOKIE_NAME)
}

// Bridges the Google OAuth authorization-code flow: /api/auth/google/start
// mints one of these (holding the CSRF `state` and the PKCE `codeVerifier`)
// right before redirecting to Google; /api/auth/google/callback reads it
// back to verify `state` and complete the PKCE token exchange. Entirely
// separate from the staff-MFA pending session above -- different cookie
// name, different `kind` claim -- even though both share the same
// SESSION_SECRET and jose signing setup.
const GOOGLE_OAUTH_COOKIE_NAME = cookieName('pending_google_oauth')
const GOOGLE_OAUTH_MAX_AGE_SECONDS = 300

export interface PendingGoogleOAuth {
  state: string
  codeVerifier: string
  nonce: string
}

export async function setPendingGoogleOAuthCookie(pending: PendingGoogleOAuth): Promise<void> {
  const store = await cookies()
  const value = await new SignJWT({ kind: 'pending-google-oauth', state: pending.state, codeVerifier: pending.codeVerifier, nonce: pending.nonce })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${GOOGLE_OAUTH_MAX_AGE_SECONDS}s`)
    .sign(getSessionSecret())
  store.set(GOOGLE_OAUTH_COOKIE_NAME, value, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: GOOGLE_OAUTH_MAX_AGE_SECONDS })
}

export async function getPendingGoogleOAuth(): Promise<PendingGoogleOAuth | null> {
  const store = await cookies()
  const raw = store.get(GOOGLE_OAUTH_COOKIE_NAME)?.value
  if (!raw) return null
  try {
    const { payload } = await jwtVerify(raw, getSessionSecret())
    if (payload.kind === 'pending-google-oauth' && typeof payload.state === 'string' && typeof payload.codeVerifier === 'string' && typeof payload.nonce === 'string') {
      return { state: payload.state, codeVerifier: payload.codeVerifier, nonce: payload.nonce }
    }
    return null
  } catch {
    return null
  }
}

export async function clearPendingGoogleOAuthCookie(): Promise<void> {
  const store = await cookies()
  store.delete(GOOGLE_OAUTH_COOKIE_NAME)
}
