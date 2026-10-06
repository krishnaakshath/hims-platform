import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requirePatientSession } from '@/lib/patient-session'
import { verifyPatientPortalCredentials, resetPatientMfa } from '@/lib/queries/patient-portal'
import { checkPatientLoginRateLimit } from '@/lib/rate-limit'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'

const resetSchema = z.object({ password: z.string().min(1) }).strict()

function getClientIp(request: NextRequest): string {
  const forwardedFor = request.headers.get('x-forwarded-for')
  if (forwardedFor) return forwardedFor.split(',')[0].trim()
  return request.headers.get('x-real-ip') ?? 'unknown'
}

// Also doubles as "turn MFA back off" -- MFA is opt-in for patients, so
// disabling it is a self-service action, not an admin-only one the way a
// staff reset is.
export async function POST(request: NextRequest) {
  const session = await requirePatientSession()
  if (session instanceof NextResponse) return session

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsed = resetSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })

  const { allowed } = await checkPatientLoginRateLimit(getClientIp(request), session.patientId)
  if (!allowed) return NextResponse.json({ error: 'Too many attempts. Try again in a minute.' }, { status: 429 })

  const valid = await verifyPatientPortalCredentials(session.patientId, parsed.data.password)
  if (!valid) return NextResponse.json({ error: 'Incorrect password' }, { status: 401 })

  await resetPatientMfa(session.patientId)
  await logPatientPortalAction('reset own MFA', session.patientId)

  return NextResponse.json({ ok: true })
}
