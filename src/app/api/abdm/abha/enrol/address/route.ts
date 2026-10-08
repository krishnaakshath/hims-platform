import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { readJsonBody } from '@/lib/http'
import { ABHA_LINK_ROLES } from '@/lib/role-policy'
import { getAbdmGateway } from '@/lib/abdm/registry'
import { getFlow, saveFlow } from '@/lib/abdm/flow-store'
import { addressSchema } from '@/lib/validation/abha-flow'
import { abdmErrorResponse, abhaRateLimitResponse, flowExpiredResponse, notConfiguredResponse, withAbdmErrors } from '@/lib/abdm/route-helpers'

// Step 3 of ABHA creation (optional): GET the ABHA address suggestions, POST
// the chosen one as the preferred address.
export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!ABHA_LINK_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const limited = await abhaRateLimitResponse(session)
  if (limited) return limited

  const flowId = z.uuid().safeParse(request.nextUrl.searchParams.get('flowId'))
  if (!flowId.success) return abdmErrorResponse('invalid_input')
  const gw = getAbdmGateway()
  if (!gw) return notConfiguredResponse()

  return withAbdmErrors('enrol_suggestions', async () => {
    const flow = await getFlow(flowId.data, session.name)
    if (!flow || flow.kind !== 'enrolment' || !flow.txnId || !flow.verified) return flowExpiredResponse()
    const r = await gw.enrolAddressSuggestions({ txnId: flow.txnId })
    if (!r.ok) return abdmErrorResponse(r.error)
    return NextResponse.json({ flowId: flow.flowId, suggestions: r.value.suggestions })
  })
}

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!ABHA_LINK_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const limited = await abhaRateLimitResponse(session)
  if (limited) return limited

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = addressSchema.safeParse(json.body)
  if (!parsed.success) return abdmErrorResponse('invalid_input')
  const gw = getAbdmGateway()
  if (!gw) return notConfiguredResponse()

  return withAbdmErrors('enrol_address', async () => {
    const flow = await getFlow(parsed.data.flowId, session.name)
    if (!flow || flow.kind !== 'enrolment' || !flow.txnId || !flow.verified) return flowExpiredResponse()
    const r = await gw.enrolSetAddress({ txnId: flow.txnId, abhaAddress: parsed.data.abhaAddress })
    if (!r.ok) return abdmErrorResponse(r.error)
    await saveFlow({ ...flow, verified: { ...flow.verified, abhaAddress: r.value.preferredAbhaAddress } })
    return NextResponse.json({ flowId: flow.flowId, step: 'address_set', abhaAddress: r.value.preferredAbhaAddress })
  })
}
