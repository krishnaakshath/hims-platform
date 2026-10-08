import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { readJsonBody } from '@/lib/http'
import { ABHA_LINK_ROLES } from '@/lib/role-policy'
import { getAbdmGateway } from '@/lib/abdm/registry'
import { getFlow, saveFlow } from '@/lib/abdm/flow-store'
import { accountSchema } from '@/lib/validation/abha-flow'
import { abdmErrorResponse, abhaRateLimitResponse, flowExpiredResponse, flowPrefix, notConfiguredResponse, profileForBrowser, withAbdmErrors } from '@/lib/abdm/route-helpers'

// After a mobile login: the staff member picks one of the masked ABHAs (by
// position); the transient token is exchanged for that account's token and
// its profile is fetched.
export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!ABHA_LINK_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const limited = await abhaRateLimitResponse(session)
  if (limited) return limited

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = accountSchema.safeParse(json.body)
  if (!parsed.success) return abdmErrorResponse('account_choice_required')
  const gw = getAbdmGateway()
  if (!gw) return notConfiguredResponse()

  return withAbdmErrors('login_account', async () => {
    const flow = await getFlow(parsed.data.flowId, session.name)
    if (!flow || flow.kind !== 'mobile_otp' || !flow.txnId || !flow.transientToken) return flowExpiredResponse()
    const abhaNumber = flow.accounts[parsed.data.accountIndex]
    if (!abhaNumber) return abdmErrorResponse('account_choice_required')

    const chosen = await gw.loginSelectAccount({ transientToken: flow.transientToken, txnId: flow.txnId, abhaNumber })
    if (!chosen.ok) return abdmErrorResponse(chosen.error)
    const profile = await gw.fetchProfile({ userToken: chosen.value.userToken, route: 'mobile_otp' })
    if (!profile.ok) return abdmErrorResponse(profile.error)
    const p = profile.value
    await saveFlow({
      ...flow, transientToken: null, userToken: chosen.value.userToken,
      verified: { abhaNumber: p.abhaNumber, abhaAddress: p.preferredAbhaAddress, via: 'mobile_otp', source: gw.source },
    })
    await logAudit(session, 'abdm: verified ABHA login', flow.patientId, `flow=${flowPrefix(flow.flowId)} route=mobile_otp`)
    return NextResponse.json({ flowId: flow.flowId, step: 'verified', profile: profileForBrowser(p, p.preferredAbhaAddress) })
  })
}
