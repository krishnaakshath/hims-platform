import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { readJsonBody } from '@/lib/http'
import { ABHA_LINK_ROLES } from '@/lib/role-policy'
import { getAbdmGateway } from '@/lib/abdm/registry'
import { getFlow, saveFlow } from '@/lib/abdm/flow-store'
import type { LoginRoute } from '@/lib/abdm/gateway'
import { loginVerifySchema } from '@/lib/validation/abha-flow'
import {
  abdmErrorResponse, abhaRateLimitResponse, flowExpiredResponse, flowPrefix, maskAbhaNumber, notConfiguredResponse, profileForBrowser, withAbdmErrors,
} from '@/lib/abdm/route-helpers'

// Verify the login OTP. A mobile login answers with the ABHAs on that mobile
// (masked) to choose from; every other route returns the verified profile.
export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!ABHA_LINK_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const limited = await abhaRateLimitResponse(session)
  if (limited) return limited

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = loginVerifySchema.safeParse(json.body)
  if (!parsed.success) return abdmErrorResponse('invalid_input')
  const gw = getAbdmGateway()
  if (!gw) return notConfiguredResponse()

  return withAbdmErrors('login_verify', async () => {
    const flow = await getFlow(parsed.data.flowId, session.name)
    if (!flow || !flow.txnId || flow.kind === null || flow.kind === 'enrolment') return flowExpiredResponse()
    const route: LoginRoute = flow.kind

    const encryptedOtp = await gw.encrypt(parsed.data.otp)
    if (!encryptedOtp.ok) return abdmErrorResponse(encryptedOtp.error)
    const r = await gw.loginVerifyOtp({ route, txnId: flow.txnId, encryptedOtp: encryptedOtp.value })
    if (!r.ok) return abdmErrorResponse(r.error)

    if (r.value.transientToken) {
      const accounts = r.value.accounts.map((a) => a.abhaNumber)
      if (accounts.length === 0) return abdmErrorResponse('abdm_unavailable')
      await saveFlow({ ...flow, transientToken: r.value.transientToken, accounts })
      return NextResponse.json({ flowId: flow.flowId, step: 'choose_account', accounts: r.value.accounts.map((a) => ({ abhaNumber: maskAbhaNumber(a.abhaNumber), name: a.name })) })
    }
    if (!r.value.userToken) return abdmErrorResponse('abdm_unavailable')
    const profile = await gw.fetchProfile({ userToken: r.value.userToken, route })
    if (!profile.ok) return abdmErrorResponse(profile.error)
    const p = profile.value
    await saveFlow({
      ...flow, userToken: r.value.userToken,
      verified: { abhaNumber: p.abhaNumber, abhaAddress: p.preferredAbhaAddress, via: route, source: gw.source },
    })
    await logAudit(session, 'abdm: verified ABHA login', flow.patientId, `flow=${flowPrefix(flow.flowId)} route=${route}`)
    return NextResponse.json({ flowId: flow.flowId, step: 'verified', profile: profileForBrowser(p, p.preferredAbhaAddress) })
  })
}
