import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { setPatientSessionCookie } from '@/lib/patient-session'
import { decryptSensitive } from '@/lib/crypto'
import { verifyMfaCode } from '@/lib/mfa'
import { getPendingPatientMfaSession, clearPendingPatientMfaCookie } from '@/lib/mfa-pending-session'
import { getPatientMfaState } from '@/lib/queries/patient-portal'
import { checkPatientMfaRateLimit } from '@/lib/rate-limit'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'

const mfaSchema = z.object({ code: z.string().trim().length(6) }).strict()

function getClientIp(request: NextRequest): string {
  const forwardedFor = request.headers.get('x-forwarded-for')
  if (forwardedFor) return forwardedFor.split(',')[0].trim()
  return request.headers.get('x-real-ip') ?? 'unknown'
}

export async function POST(request: NextRequest) {
  const pending = await getPendingPatientMfaSession()
  if (!pending) return NextResponse.json({ error: 'Your login session expired. Please sign in again.' }, { status: 401 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsed = mfaSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid code' }, { status: 400 })

  const { allowed } = await checkPatientMfaRateLimit(getClientIp(request), pending.patientId)
  if (!allowed) return NextResponse.json({ error: 'Too many attempts. Try again in a minute.' }, { status: 429 })

  const mfaState = await getPatientMfaState(pending.patientId)
  if (!mfaState?.mfaSecretEncrypted) return NextResponse.json({ error: 'Your login session expired. Please sign in again.' }, { status: 401 })

  const secretBase32 = decryptSensitive(mfaState.mfaSecretEncrypted)
  if (!(await verifyMfaCode(secretBase32, parsed.data.code, pending.patientId))) {
    await logPatientPortalAction('failed MFA code entry', pending.patientId)
    return NextResponse.json({ error: 'Invalid code' }, { status: 401 })
  }

  await clearPendingPatientMfaCookie()
  await setPatientSessionCookie(pending.patientId)
  await logPatientPortalAction('completed MFA login', pending.patientId)

  return NextResponse.json({ ok: true })
}
