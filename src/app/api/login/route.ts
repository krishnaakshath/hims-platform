import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import type { Role } from '@/lib/auth'
import { setSessionCookie } from '@/lib/auth'
import { encryptSensitive } from '@/lib/crypto'
import { generateMfaEnrollment } from '@/lib/mfa'
import { setPendingStaffMfaCookie } from '@/lib/mfa-pending-session'
import { verifyPassword } from '@/lib/password'
import { checkLoginRateLimit } from '@/lib/rate-limit'
import { getAdminMfaState, setAdminMfaSecret } from '@/lib/queries/settings'
import { findUserByEmail, getUserMfaState, setUserMfaSecret } from '@/lib/queries/users'
import { logAudit } from '@/lib/audit'

// Demo/eval toggle: set DISABLE_STAFF_MFA=true in the environment to skip
// the TOTP enroll/verify challenge entirely and complete login on password
// alone. All the MFA code below is untouched and fully wired -- flipping
// this back to unset (or "false") re-enables mandatory MFA with no other
// changes needed.
const staffMfaDisabled = process.env.DISABLE_STAFF_MFA === 'true'

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
}).strict()

// Vercel/most proxies set the client IP as the first entry in
// x-forwarded-for; NextRequest no longer exposes `.ip` directly.
function getClientIp(request: NextRequest): string {
  const forwardedFor = request.headers.get('x-forwarded-for')
  if (forwardedFor) return forwardedFor.split(',')[0].trim()
  return request.headers.get('x-real-ip') ?? 'unknown'
}

export async function POST(request: NextRequest) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = loginSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid login payload' }, { status: 400 })
  }

  const { email, password } = parsed.data
  const ip = getClientIp(request)

  const { allowed } = await checkLoginRateLimit(ip, email)
  if (!allowed) {
    return NextResponse.json({ error: 'Too many login attempts. Try again in a minute.' }, { status: 429 })
  }

  const adminEmail = process.env.ADMIN_EMAIL
  const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH
  const adminName = process.env.ADMIN_NAME ?? 'Admin'

  // The one real admin account still authenticates via env vars, not a DB
  // row -- checked first so its behavior is byte-for-byte unchanged. Any
  // other provisioned account (pi/crc/frontdesk) authenticates against
  // users.passwordHash. Same generic error for a wrong email, a wrong
  // password, or an account with no password set at all, so this endpoint
  // never confirms which part was wrong or whether an email exists.
  if (adminEmail && adminPasswordHash && email.toLowerCase() === adminEmail.toLowerCase() && verifyPassword(password, adminPasswordHash)) {
    if (staffMfaDisabled) return completeLoginWithoutMfa('admin', adminName, null)
    const adminMfaState = await getAdminMfaState()
    return startStaffMfaChallenge({ role: 'admin', name: adminName, userId: null, ip, mfaMethod: adminMfaState.mfaMethod, phone: adminMfaState.phone, email: adminEmail })
  }

  const user = await findUserByEmail(email)
  if (user?.passwordHash && verifyPassword(password, user.passwordHash)) {
    if (staffMfaDisabled) return completeLoginWithoutMfa(user.role, user.name, user.id)
    return startStaffMfaChallenge({ role: user.role, name: user.name, userId: user.id, ip, mfaMethod: user.mfaMethod, phone: user.phone, email: user.email })
  }

  return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })
}

// Mirrors /api/login/mfa's own success path (setSessionCookie + logAudit +
// {ok:true}) so a DISABLE_STAFF_MFA login is indistinguishable downstream
// from a real completed-MFA login -- same cookie shape, same audit trail.
async function completeLoginWithoutMfa(role: Role, name: string, userId: number | null) {
  await setSessionCookie(role, name, userId)
  await logAudit({ role, name, userId }, 'completed login (MFA disabled)', null)
  return NextResponse.json({ ok: true })
}

// MFA is mandatory for every staff account, so a correct password never
// completes a login by itself anymore -- it always hands back a challenge:
// enroll or verify for totp (unchanged), or an OTP send for sms/email.
async function startStaffMfaChallenge({ role, name, userId, ip, mfaMethod, phone, email }: { role: Role; name: string; userId: number | null; ip: string; mfaMethod: 'totp' | 'sms' | 'email'; phone: string | null; email: string }) {
  const identity = userId === null ? 'admin' : `user:${userId}`

  if (mfaMethod === 'sms' || mfaMethod === 'email') {
    const { checkOtpSendRateLimit } = await import('@/lib/rate-limit')
    const { generateAndSendOtp } = await import('@/lib/otp-delivery')
    const { allowed } = await checkOtpSendRateLimit(ip, identity)
    if (!allowed) return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })

    const destination = mfaMethod === 'sms' ? phone : email
    if (!destination) return NextResponse.json({ error: `No ${mfaMethod === 'sms' ? 'phone number' : 'email'} is on file for this account. Contact your admin.` }, { status: 400 })

    try {
      await generateAndSendOtp(identity, mfaMethod, destination)
    } catch (err) {
      console.error(`Failed to send ${mfaMethod} OTP:`, err)
      return NextResponse.json({ error: `Could not send your ${mfaMethod === 'sms' ? 'text' : 'email'} code. Contact your admin.` }, { status: 500 })
    }

    await setPendingStaffMfaCookie({ role, name, mode: 'verify', userId, method: mfaMethod })
    return NextResponse.json({ mfaRequired: true, mode: mfaMethod })
  }

  const mfaState = userId === null ? await getAdminMfaState() : await getUserMfaState(userId)
  if (!mfaState || !mfaState.mfaEnabled) {
    const enrollment = await generateMfaEnrollment(`${name} <${role}>`)
    if (userId === null) await setAdminMfaSecret(encryptSensitive(enrollment.secretBase32))
    else await setUserMfaSecret(userId, encryptSensitive(enrollment.secretBase32))
    await setPendingStaffMfaCookie({ role, name, mode: 'enroll', userId, method: 'totp' })
    return NextResponse.json({ mfaRequired: true, mode: 'enroll', qrDataUrl: enrollment.qrDataUrl, manualKey: enrollment.secretBase32 })
  }
  await setPendingStaffMfaCookie({ role, name, mode: 'verify', userId, method: 'totp' })
  return NextResponse.json({ mfaRequired: true, mode: 'verify' })
}
