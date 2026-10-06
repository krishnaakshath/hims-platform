import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { requireSession } from '@/lib/auth'
import { verifyPassword } from '@/lib/password'
import { logAudit } from '@/lib/audit'
import { getDb } from '@/db/client'
import { users, appSettings } from '@/db/schema'
import { findUserByEmail, resetUserMfa } from '@/lib/queries/users'
import { getAppSettings, resetAdminMfa } from '@/lib/queries/settings'
import { checkAccountMfaResetRateLimit } from '@/lib/rate-limit'

const methodSchema = z.object({
  method: z.enum(['totp', 'sms', 'email']),
  phone: z.string().min(1).optional(),
  email: z.string().trim().email(),
  password: z.string().min(1),
}).strict()

function getClientIp(request: NextRequest): string {
  const forwardedFor = request.headers.get('x-forwarded-for')
  if (forwardedFor) return forwardedFor.split(',')[0].trim()
  return request.headers.get('x-real-ip') ?? 'unknown'
}

// Switches the CALLING session's own account only. This mutates MFA state
// exactly like /api/account/mfa/reset (it can clear the existing secret and,
// for sms, rebind the second-factor destination to a caller-supplied phone
// number) so it gets the identical safeguards: password re-verification,
// the same rate limiting as a fresh login attempt, and identity resolved by
// email (never by display name, which has no unique constraint and could
// let one staff member silently overwrite another's MFA config).
export async function PUT(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session

  const parsed = methodSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 400 })
  const { method, phone, email, password } = parsed.data

  // Must run before verifyPassword in either branch below -- same ordering
  // rationale as /api/account/mfa/reset (this endpoint is a password oracle
  // for whoever holds the session).
  const { allowed } = await checkAccountMfaResetRateLimit(getClientIp(request), email)
  if (!allowed) return NextResponse.json({ error: 'Too many attempts. Try again in a minute.' }, { status: 429 })

  const adminEmail = process.env.ADMIN_EMAIL
  const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH
  if (adminEmail && adminPasswordHash && email.toLowerCase() === adminEmail.toLowerCase() && verifyPassword(password, adminPasswordHash)) {
    if (session.role !== 'admin') return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })
    const current = await getAppSettings()
    if (method === 'sms' && !phone && !current.adminPhone) {
      return NextResponse.json({ error: 'A phone number is required to switch to SMS sign-in.' }, { status: 400 })
    }
    await resetAdminMfa()
    await getDb().update(appSettings).set({ adminMfaMethod: method, ...(phone ? { adminPhone: phone } : {}) }).where(eq(appSettings.id, current.id))
    await logAudit(session, `switched MFA method to ${method}`, null)
    return NextResponse.json({ ok: true })
  }

  const user = await findUserByEmail(email)
  if (user?.passwordHash && verifyPassword(password, user.passwordHash)) {
    if (session.role !== user.role || session.name !== user.name) return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })
    if (method === 'sms' && !phone && !user.phone) {
      return NextResponse.json({ error: 'A phone number is required to switch to SMS sign-in.' }, { status: 400 })
    }
    await resetUserMfa(user.id)
    await getDb().update(users).set({ mfaMethod: method, ...(phone ? { phone } : {}) }).where(eq(users.id, user.id))
    await logAudit(session, `switched MFA method to ${method}`, null)
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })
}
