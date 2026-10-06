import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { NextResponse } from 'next/server'
import { SignJWT, jwtVerify } from 'jose'
import { cookieName } from '@/lib/brand'

// A completely separate session mechanism from the staff session
// (lib/auth.ts) -- different cookie name, and every token carries a `kind:
// 'patient'` claim so a token minted here can never be reinterpreted as a
// staff session (or vice versa) even though both happen to use the same
// SESSION_SECRET and jose signing scheme. A patient session identifies
// exactly one patientId and nothing else; there is no role, no way to
// switch patients, and no staff capability reachable from it.
const COOKIE_NAME = cookieName('patient_session')
const SESSION_MAX_AGE_SECONDS = 60 * 60 // 1 hour -- shorter than staff's 8h; a patient portal session on a shared/public device is a real risk this pilot hasn't otherwise mitigated (no "remember this device", no MFA)

function getSessionSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET
  if (!secret) throw new Error('SESSION_SECRET is not configured')
  return new TextEncoder().encode(secret)
}

export interface PatientSession {
  patientId: string
}

export async function setPatientSessionCookie(patientId: string) {
  const store = await cookies()
  const value = await new SignJWT({ patientId, kind: 'patient' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(getSessionSecret())
  store.set(COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  })
}

export async function parsePatientSessionCookie(value: string): Promise<PatientSession | null> {
  try {
    const { payload } = await jwtVerify(value, getSessionSecret())
    if (payload.kind === 'patient' && typeof payload.patientId === 'string' && payload.patientId.length > 0) {
      return { patientId: payload.patientId }
    }
    return null
  } catch {
    return null
  }
}

export async function getPatientSession(): Promise<PatientSession | null> {
  const store = await cookies()
  const raw = store.get(COOKIE_NAME)?.value
  return raw ? parsePatientSessionCookie(raw) : null
}

export async function clearPatientSessionCookie() {
  const store = await cookies()
  store.delete(COOKIE_NAME)
}

export const PATIENT_SESSION_COOKIE_NAME = COOKIE_NAME

export async function requirePatientSession(): Promise<PatientSession | NextResponse> {
  const session = await getPatientSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return session
}

// Page-component equivalent -- see the matching comment on
// requireSessionOrRedirect in lib/auth.ts for why relying on a layout's
// redirect() alone isn't sufficient.
export async function requirePatientSessionOrRedirect(): Promise<PatientSession> {
  const session = await getPatientSession()
  if (!session) redirect('/patient-portal/login')
  return session
}
