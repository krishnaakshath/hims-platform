// Wave J (P1-20): step 1 of the portal's UHID / mobile OTP sign-in -- send a one-time code
// by SMS to the mobile number on the patient's record. The answer is the same whether or
// not the UHID / number belongs to a portal patient, so this never confirms who is
// registered; the code only ever goes to the number the hospital already has.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { readJsonBody } from '@/lib/http'
import { checkOtpSendRateLimit } from '@/lib/rate-limit'
import { generateAndSendOtp } from '@/lib/otp-delivery'
import { findPortalOtpCandidate } from '@/lib/queries/patient-portal'
import { PORTAL_OTP_SENT_MESSAGE, isSmsSignInConfigured, parsePortalOtpIdentifier, portalOtpIdentifierKey, portalOtpIdentity, toIndianE164 } from '@/lib/patient-portal-otp'
import { withServiceGuard } from '@/lib/service-config'

const schema = z.object({ identifier: z.string().trim().min(1).max(64) }).strict()

function getClientIp(request: NextRequest): string {
  const forwardedFor = request.headers.get('x-forwarded-for')
  if (forwardedFor) return forwardedFor.split(',')[0].trim()
  return request.headers.get('x-real-ip') ?? 'unknown'
}

export const POST = withServiceGuard('patient portal otp', async function POST(request: NextRequest) {
  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = schema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Enter your UHID or mobile number' }, { status: 400 })
  const identifier = parsePortalOtpIdentifier(parsed.data.identifier)
  if (!identifier) return NextResponse.json({ error: 'Enter your UHID or 10-digit mobile number' }, { status: 400 })

  if (!isSmsSignInConfigured()) {
    return NextResponse.json({ error: 'Sign-in with a mobile code is not available right now. Please use your password.' }, { status: 503 })
  }

  const ip = getClientIp(request)
  const tooMany = () => NextResponse.json({ error: 'Too many code requests. Try again in 15 minutes.' }, { status: 429 })
  if (!(await checkOtpSendRateLimit(ip, portalOtpIdentifierKey(identifier))).allowed) return tooMany()

  const candidate = await findPortalOtpCandidate(identifier)
  if (candidate) {
    // The patient's own bucket too, so alternating UHID and mobile cannot double the sends.
    if (!(await checkOtpSendRateLimit(ip, portalOtpIdentity(candidate.id))).allowed) return tooMany()
    const destination = toIndianE164(candidate.phone)
    if (destination) {
      try {
        await generateAndSendOtp(portalOtpIdentity(candidate.id), 'sms', destination)
      } catch {
        // Never surfaced (the response must not differ for a registered patient) and never
        // logged with the number. The patient can retry or use their password.
      }
    }
  }
  return NextResponse.json({ sent: true, message: PORTAL_OTP_SENT_MESSAGE })
})
