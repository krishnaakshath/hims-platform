import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { verifyPassword } from '@/lib/password'
import { findUserByEmail, resetUserMfa } from '@/lib/queries/users'
import { resetAdminMfa } from '@/lib/queries/settings'
import { logAudit } from '@/lib/audit'
import { checkAccountMfaResetRateLimit } from '@/lib/rate-limit'

const resetSchema = z.object({ email: z.string().trim().email(), password: z.string().min(1) }).strict()

function getClientIp(request: NextRequest): string {
  const forwardedFor = request.headers.get('x-forwarded-for')
  if (forwardedFor) return forwardedFor.split(',')[0].trim()
  return request.headers.get('x-real-ip') ?? 'unknown'
}

// Lost-device recovery for a staff member who's still holding a trusted,
// signed-in session but can no longer produce a TOTP code -- re-verifies a
// password (the same credential a fresh login would check), then checks the
// re-authenticated identity against the CALLER's own session before
// clearing anything, so this can only ever reset your own MFA, never
// someone else's.
export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsed = resetSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
  const { email, password } = parsed.data

  // Must run before verifyPassword in either branch below -- this endpoint
  // is a password oracle for whoever holds the session, so it gets the same
  // throttling as login (see checkAccountMfaResetRateLimit).
  const { allowed } = await checkAccountMfaResetRateLimit(getClientIp(request), email)
  if (!allowed) return NextResponse.json({ error: 'Too many attempts. Try again in a minute.' }, { status: 429 })

  const adminEmail = process.env.ADMIN_EMAIL
  const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH
  if (adminEmail && adminPasswordHash && email.toLowerCase() === adminEmail.toLowerCase() && verifyPassword(password, adminPasswordHash)) {
    if (session.role !== 'admin') return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })
    await resetAdminMfa()
    await logAudit(session, 'reset own MFA', null)
    return NextResponse.json({ ok: true })
  }

  const user = await findUserByEmail(email)
  if (user?.passwordHash && verifyPassword(password, user.passwordHash)) {
    if (session.role !== user.role || session.name !== user.name) return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })
    await resetUserMfa(user.id)
    await logAudit(session, 'reset own MFA', null)
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })
}
