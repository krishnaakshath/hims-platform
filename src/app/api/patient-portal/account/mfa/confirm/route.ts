import { NextRequest, NextResponse } from 'next/server'
import { readJsonBody } from '@/lib/http'
import { z } from 'zod'
import { requirePatientSession } from '@/lib/patient-session'
import { decryptSensitive } from '@/lib/crypto'
import { verifyMfaCode } from '@/lib/mfa'
import { getPatientMfaState, enablePatientMfa } from '@/lib/queries/patient-portal'
import { checkPatientMfaRateLimit } from '@/lib/rate-limit'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'
import { withServiceGuard } from '@/lib/service-config'

const confirmSchema = z.object({ code: z.string().trim().length(6) }).strict()

function getClientIp(request: NextRequest): string {
  const forwardedFor = request.headers.get('x-forwarded-for')
  if (forwardedFor) return forwardedFor.split(',')[0].trim()
  return request.headers.get('x-real-ip') ?? 'unknown'
}

export const POST = withServiceGuard('patient MFA confirmation', async function POST(request: NextRequest) {
  const session = await requirePatientSession()
  if (session instanceof NextResponse) return session

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const body: unknown = json.body
  const parsed = confirmSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid code' }, { status: 400 })

  const { allowed } = await checkPatientMfaRateLimit(getClientIp(request), session.patientId)
  if (!allowed) return NextResponse.json({ error: 'Too many attempts. Try again in a minute.' }, { status: 429 })

  const mfaState = await getPatientMfaState(session.patientId)
  if (!mfaState?.mfaSecretEncrypted || mfaState.mfaEnabled) return NextResponse.json({ error: 'No enrollment in progress' }, { status: 400 })

  const secretBase32 = decryptSensitive(mfaState.mfaSecretEncrypted)
  if (!(await verifyMfaCode(secretBase32, parsed.data.code, session.patientId))) {
    await logPatientPortalAction('failed MFA code entry during enrollment', session.patientId)
    return NextResponse.json({ error: 'Invalid code' }, { status: 401 })
  }

  await enablePatientMfa(session.patientId)
  await logPatientPortalAction('enabled MFA', session.patientId)

  return NextResponse.json({ ok: true })
})
