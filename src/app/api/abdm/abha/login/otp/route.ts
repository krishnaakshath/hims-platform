import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients } from '@/db/schema'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { readJsonBody } from '@/lib/http'
import { ABHA_LINK_ROLES } from '@/lib/role-policy'
import { LOGIN_ROUTES } from '@/lib/abdm/constants'
import { getAbdmGateway } from '@/lib/abdm/registry'
import { createFlow, getFlow, saveFlow } from '@/lib/abdm/flow-store'
import { loginIdForWire, loginOtpSchema } from '@/lib/validation/abha-flow'
import { abdmErrorResponse, abhaRateLimitResponse, flowExpiredResponse, flowPrefix, notConfiguredResponse, withAbdmErrors } from '@/lib/abdm/route-helpers'

// Verify an existing ABHA: send a login OTP by ABHA number, mobile, ABHA
// address or Aadhaar (S1 M1 login). An Aadhaar-OTP route needs a recorded
// verification consent first. The login id is validated, put in ABDM's wire
// form and encrypted in one expression; it is never stored, logged or echoed.
export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!ABHA_LINK_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const limited = await abhaRateLimitResponse(session)
  if (limited) return limited

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = loginOtpSchema.safeParse(json.body)
  if (!parsed.success) return abdmErrorResponse('invalid_input')
  const { route } = parsed.data

  const gw = getAbdmGateway()
  if (!gw) return notConfiguredResponse()

  return withAbdmErrors('login_otp', async () => {
    let flow
    if (parsed.data.flowId) {
      flow = await getFlow(parsed.data.flowId, session.name)
      if (!flow) return flowExpiredResponse()
    } else {
      if (parsed.data.patientId) {
        const [p] = await getDb().select({ id: patients.id }).from(patients).where(eq(patients.id, parsed.data.patientId))
        if (!p) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      }
      flow = await createFlow({ staffName: session.name, staffUserId: session.userId, patientId: parsed.data.patientId ?? null, kind: route })
    }
    if (LOGIN_ROUTES[route].otpSystem === 'aadhaar' && (flow.consentId == null || flow.consentPurpose !== 'abha_verification')) return abdmErrorResponse('consent_missing')

    const encrypted = await gw.encrypt(loginIdForWire(route, parsed.data.loginId))
    if (!encrypted.ok) return abdmErrorResponse(encrypted.error)
    const sent = await gw.loginRequestOtp({ route, encryptedLoginId: encrypted.value })
    if (!sent.ok) return abdmErrorResponse(sent.error)

    await saveFlow({ ...flow, kind: route, txnId: sent.value.txnId, userToken: null, transientToken: null, verified: null, accounts: [] })
    await logAudit(session, 'abdm: requested ABHA login OTP', flow.patientId, `flow=${flowPrefix(flow.flowId)} route=${route}`)
    return NextResponse.json({ flowId: flow.flowId, step: 'otp_sent' })
  })
}
