import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { readJsonBody } from '@/lib/http'
import { ABHA_LINK_ROLES } from '@/lib/role-policy'
import { invalidateCache, patientDetailCacheKey } from '@/lib/cache'
import { getAbdmGateway } from '@/lib/abdm/registry'
import { deleteFlow, getFlow } from '@/lib/abdm/flow-store'
import { linkSchema } from '@/lib/validation/abha-flow'
import { abdmErrorResponse, abhaRateLimitResponse, flowExpiredResponse, identityMismatchResponse, notConfiguredResponse, withAbdmErrors } from '@/lib/abdm/route-helpers'
import { compareAbhaIdentity } from '@/lib/abdm/identity-match'
import { applyVerifiedAbha, readChartIdentity } from '@/lib/queries/abha-link'

// Link an ABHA verified in this staff member's flow to an existing patient
// (ruling 12): number, address and the verification columns with their audit
// rows in one transaction. Another patient's ABHA is a 409, never merged.
// WS12 T5 (spec R9): the ABDM profile is compared with the chart first; a
// mismatch is a 409 with the field names unless `mismatchReason` is given, and
// the transaction compares again under the patient lock.
export async function POST(request: NextRequest, { params }: { params: Promise<{ anonId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!ABHA_LINK_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const limited = await abhaRateLimitResponse(session)
  if (limited) return limited
  const { anonId } = await params

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = linkSchema.safeParse(json.body)
  if (!parsed.success) return abdmErrorResponse('invalid_input')
  if (!getAbdmGateway()) return notConfiguredResponse()

  return withAbdmErrors('link', async () => {
    const flow = await getFlow(parsed.data.flowId, session.name)
    if (!flow || !flow.verified) return flowExpiredResponse()
    if (flow.patientId && flow.patientId !== anonId) return abdmErrorResponse('invalid_input')
    const chart = await readChartIdentity(anonId)
    if (!chart) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const cmp = compareAbhaIdentity(chart, flow.verified.profile ?? null)
    const reason = parsed.data.mismatchReason
    if (cmp.mismatch && !reason) return identityMismatchResponse(cmp.mismatchedFields)
    const r = await applyVerifiedAbha(anonId, flow, session, cmp.mismatch && reason ? { override: { fields: cmp.mismatchedFields, reason } } : {})
    if (!r.ok) {
      if (r.error === 'identity_mismatch') return identityMismatchResponse(r.fields)
      if (r.error === 'not_found') return NextResponse.json({ error: 'Not found' }, { status: 404 })
      if (r.error === 'abha_conflict') return abdmErrorResponse('abha_conflict')
      return flowExpiredResponse()
    }
    await deleteFlow(flow.flowId)
    try {
      await invalidateCache(patientDetailCacheKey(anonId))
    } catch {
      // The detail cache expires on its own; the link is committed.
    }
    return NextResponse.json({ ok: true })
  })
}
