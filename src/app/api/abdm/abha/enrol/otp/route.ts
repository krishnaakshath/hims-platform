import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { readJsonBody } from '@/lib/http'
import { ABHA_LINK_ROLES } from '@/lib/role-policy'
import { getAbdmGateway } from '@/lib/abdm/registry'
import { getFlow, saveFlow } from '@/lib/abdm/flow-store'
import { AADHAAR_FORMAT_MESSAGE, enrolOtpSchema } from '@/lib/validation/abha-flow'
import { abdmErrorResponse, abhaRateLimitResponse, flowExpiredResponse, flowPrefix, notConfiguredResponse, withAbdmErrors } from '@/lib/abdm/route-helpers'

// Step 1 of ABHA creation: send an enrolment OTP to the mobile linked with
// the patient's Aadhaar. The number exists only in this request: it is
// validated, encrypted for ABDM in the same expression that reads it, and
// never stored, logged, audited or echoed (S1 build-it-well; SP8 ruling 4).
export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!ABHA_LINK_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const limited = await abhaRateLimitResponse(session)
  if (limited) return limited

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = enrolOtpSchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: AADHAAR_FORMAT_MESSAGE }, { status: 400 })

  const gw = getAbdmGateway()
  if (!gw) return notConfiguredResponse()

  return withAbdmErrors('enrol_otp', async () => {
    const flow = await getFlow(parsed.data.flowId, session.name)
    if (!flow) return flowExpiredResponse()
    if (flow.consentId == null || flow.consentPurpose !== 'abha_enrolment') return abdmErrorResponse('consent_missing')

    const encrypted = await gw.encrypt(parsed.data.aadhaar)
    if (!encrypted.ok) return abdmErrorResponse(encrypted.error)
    const sent = await gw.enrolRequestAadhaarOtp({ encryptedAadhaar: encrypted.value })
    if (!sent.ok) return abdmErrorResponse(sent.error)

    await saveFlow({ ...flow, kind: 'enrolment', txnId: sent.value.txnId, userToken: null, transientToken: null, verified: null, accounts: [] })
    await logAudit(session, 'abdm: requested ABHA enrolment OTP', flow.patientId, `flow=${flowPrefix(flow.flowId)} step=enrol_otp`)
    return NextResponse.json({ flowId: flow.flowId, step: 'otp_sent' })
  })
}
