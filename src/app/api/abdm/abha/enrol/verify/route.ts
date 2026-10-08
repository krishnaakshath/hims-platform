import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { readJsonBody } from '@/lib/http'
import { ABHA_LINK_ROLES } from '@/lib/role-policy'
import { getAbdmGateway } from '@/lib/abdm/registry'
import { getFlow, saveFlow } from '@/lib/abdm/flow-store'
import { enrolVerifySchema } from '@/lib/validation/abha-flow'
import { abdmErrorResponse, abhaRateLimitResponse, flowExpiredResponse, flowPrefix, notConfiguredResponse, profileForBrowser, withAbdmErrors } from '@/lib/abdm/route-helpers'

// Step 2 of ABHA creation: the enrolment OTP (encrypted for ABDM, never kept)
// creates the ABHA, or returns the existing one for that Aadhaar. The user
// token stays in the sealed flow; the browser gets the profile and address
// suggestions only.
export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!ABHA_LINK_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const limited = await abhaRateLimitResponse(session)
  if (limited) return limited

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = enrolVerifySchema.safeParse(json.body)
  if (!parsed.success) return abdmErrorResponse('invalid_input')

  const gw = getAbdmGateway()
  if (!gw) return notConfiguredResponse()

  return withAbdmErrors('enrol_verify', async () => {
    const flow = await getFlow(parsed.data.flowId, session.name)
    if (!flow || flow.kind !== 'enrolment' || !flow.txnId) return flowExpiredResponse()

    const encryptedOtp = await gw.encrypt(parsed.data.otp)
    if (!encryptedOtp.ok) return abdmErrorResponse(encryptedOtp.error)
    const r = await gw.enrolByAadhaarOtp({ txnId: flow.txnId, encryptedOtp: encryptedOtp.value, mobile: parsed.data.mobile })
    if (!r.ok) return abdmErrorResponse(r.error)
    const { profile } = r.value

    const suggestions = await gw.enrolAddressSuggestions({ txnId: r.value.txnId })
    await saveFlow({
      ...flow, txnId: r.value.txnId, userToken: r.value.userToken,
      verified: { abhaNumber: profile.abhaNumber, abhaAddress: profile.preferredAbhaAddress, via: 'aadhaar_otp_enrolment', source: gw.source },
    })
    await logAudit(session, 'abdm: created ABHA', flow.patientId, `flow=${flowPrefix(flow.flowId)} step=enrol_verify new=${r.value.isNew}`)
    return NextResponse.json({
      flowId: flow.flowId,
      step: 'verified',
      profile: profileForBrowser(profile, profile.preferredAbhaAddress),
      suggestions: suggestions.ok ? suggestions.value.suggestions : [],
    })
  })
}
