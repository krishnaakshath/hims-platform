import { NextRequest, NextResponse } from 'next/server'
import { readJsonBody } from '@/lib/http'
import { z } from 'zod'
import { setPatientSessionCookie } from '@/lib/patient-session'
import { findPortalLoginCandidate, checkPortalLoginPassword } from '@/lib/queries/patient-portal'
import { checkPatientLoginRateLimit } from '@/lib/rate-limit'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'
import { setPendingPatientMfaCookie } from '@/lib/mfa-pending-session'
import { getPatientMfaState } from '@/lib/queries/patient-portal'
import { withServiceGuard } from '@/lib/service-config'

// `patientId` is the login identifier the patient typed: either their email
// address or their patient ID (the form asks for "Email address or patient
// ID"). It is only ever resolved here -- every cookie and audit row below
// uses the resolved patient id, never the raw identifier.
const loginSchema = z.object({
  patientId: z.string().trim().min(1),
  password: z.string().min(1),
}).strict()

function getClientIp(request: NextRequest): string {
  const forwardedFor = request.headers.get('x-forwarded-for')
  if (forwardedFor) return forwardedFor.split(',')[0].trim()
  return request.headers.get('x-real-ip') ?? 'unknown'
}

export const POST = withServiceGuard('patient login', async function POST(request: NextRequest) {
  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const body: unknown = json.body

  const parsed = loginSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid login payload' }, { status: 400 })
  }
  const { patientId: identifier, password } = parsed.data

  // Key on the normalized identifier so "Name@X.com" and " name@x.com " share
  // one bucket -- case/whitespace variations never buy extra attempts.
  const ip = getClientIp(request)
  const tooMany = () => NextResponse.json({ error: 'Too many login attempts. Try again in a minute.' }, { status: 429 })
  const key = identifier.toLowerCase()
  if (!(await checkPatientLoginRateLimit(ip, key)).allowed) return tooMany()

  // One query resolves the identifier to a patient and its password hash.
  const candidate = await findPortalLoginCandidate(identifier)

  // Also spend from the resolved patient's own bucket, so alternating the
  // email and the patient ID cannot double the attempts against one
  // account. Skipped when the identifier already is that bucket (a login by
  // patient ID), which would otherwise count every attempt twice.
  if (candidate && candidate.id.toLowerCase() !== key) {
    if (!(await checkPatientLoginRateLimit(ip, candidate.id.toLowerCase())).allowed) return tooMany()
  }

  // Same generic error whether the email/patient ID doesn't exist, the email
  // belongs to more than one patient, there is no portal access provisioned
  // yet, or the password is wrong -- this endpoint never confirms which part
  // was wrong or whether a given email or patient ID is real.
  const patientId = checkPortalLoginPassword(candidate, password)
  if (!patientId) {
    return NextResponse.json({ error: 'Invalid patient ID or password' }, { status: 401 })
  }

  const mfaState = await getPatientMfaState(patientId)
  if (mfaState?.mfaEnabled) {
    await setPendingPatientMfaCookie({ patientId })
    return NextResponse.json({ mfaRequired: true })
  }

  await setPatientSessionCookie(patientId)
  await logPatientPortalAction('logged in to patient portal', patientId)
  return NextResponse.json({ ok: true })
})
