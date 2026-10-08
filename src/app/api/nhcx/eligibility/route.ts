import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { NHCX_ELIGIBILITY_ROLES } from '@/lib/role-policy'
import { readNhcxConfig } from '@/lib/integrations/config'
import { ELIGIBILITY_CONTEXTS, ELIGIBILITY_PURPOSES } from '@/lib/nhcx/constants'
import { requestEligibility } from '@/lib/queries/nhcx-eligibility'
import { rcmError, rcmErrorResponse, rcmServerError, readJsonBody } from '@/lib/rcm/route-responses'

// SP8: run an NHCX coverage eligibility check on a patient's policy. The send
// happens after the response; the answer arrives on the NHCX callback.
const schema = z.object({
  policyId: z.number().int().positive().max(2_147_483_647),
  purpose: z.enum(ELIGIBILITY_PURPOSES).default('validation'),
  context: z.enum(ELIGIBILITY_CONTEXTS),
  providerId: z.number().int().positive().max(2_147_483_647),
}).strict()

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!NHCX_ELIGIBILITY_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = schema.safeParse(json.body)
  if (!parsed.success) return rcmError(400, 'Invalid eligibility check')
  if (readNhcxConfig().state === 'not_configured') return rcmError(503, 'NHCX is not configured')

  try {
    const r = await requestEligibility(parsed.data, session)
    if (!r.ok) return rcmErrorResponse(r)
    return NextResponse.json({ checkId: r.value.checkId }, { status: 202 })
  } catch (err) {
    return rcmServerError('nhcx eligibility', err, 'Could not start the eligibility check')
  }
}
