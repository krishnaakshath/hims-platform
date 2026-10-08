// Wave J (P1-20): step 2 of the portal's UHID / mobile OTP sign-in -- check the code and
// start the patient session (or, for a patient with an authenticator enrolled, hand over to
// the existing TOTP step). One generic error for an unknown identifier, a wrong code or an
// expired one. Rate limited per identifier and per resolved patient; audited on success.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { readJsonBody } from '@/lib/http'
import { checkOtpVerifyRateLimit } from '@/lib/rate-limit'
import { verifyOtp } from '@/lib/otp-delivery'
import { findPortalOtpCandidate } from '@/lib/queries/patient-portal'
import { parsePortalOtpIdentifier, portalOtpIdentifierKey, portalOtpIdentity } from '@/lib/patient-portal-otp'
import { setPatientSessionCookie } from '@/lib/patient-session'
import { setPendingPatientMfaCookie } from '@/lib/mfa-pending-session'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'
import { withServiceGuard } from '@/lib/service-config'

const schema = z.object({ identifier: z.string().trim().min(1).max(64), code: z.string().regex(/^\d{6}$/) }).strict()

function getClientIp(request: NextRequest): string {
  const forwardedFor = request.headers.get('x-forwarded-for')
  if (forwardedFor) return forwardedFor.split(',')[0].trim()
  return request.headers.get('x-real-ip') ?? 'unknown'
}

const invalid = () => NextResponse.json({ error: 'Invalid or expired code' }, { status: 401 })

export const POST = withServiceGuard('patient portal otp verify', async function POST(request: NextRequest) {
  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = schema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Enter the 6-digit code' }, { status: 400 })
  const identifier = parsePortalOtpIdentifier(parsed.data.identifier)
  if (!identifier) return invalid()

  const ip = getClientIp(request)
  const tooMany = () => NextResponse.json({ error: 'Too many attempts. Try again in 15 minutes.' }, { status: 429 })
  if (!(await checkOtpVerifyRateLimit(ip, portalOtpIdentifierKey(identifier))).allowed) return tooMany()

  const candidate = await findPortalOtpCandidate(identifier)
  if (!candidate) return invalid()
  if (!(await checkOtpVerifyRateLimit(ip, portalOtpIdentity(candidate.id))).allowed) return tooMany()
  if (!(await verifyOtp(portalOtpIdentity(candidate.id), 'sms', parsed.data.code))) return invalid()

  if (candidate.mfaEnabled) {
    await setPendingPatientMfaCookie({ patientId: candidate.id })
    return NextResponse.json({ mfaRequired: true })
  }
  await setPatientSessionCookie(candidate.id)
  await logPatientPortalAction('logged in to patient portal with mobile OTP', candidate.id)
  return NextResponse.json({ ok: true })
})
