import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { RCM_ROLES } from '@/lib/role-policy'
import { preauthEstimateSchema } from '@/lib/rcm/validation'
import { estimateForPolicy } from '@/lib/queries/preauths'
import { invalid, rcmErrorResponse, rcmServerError, readJsonBody } from '@/lib/rcm/route-responses'

// SP7: price a pre-auth estimate with the policy's billing payer tariff (no write, not audited).
export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!RCM_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = preauthEstimateSchema.safeParse(json.body)
  if (!parsed.success) return invalid(parsed.error, 'Invalid estimate request')

  try {
    const r = await estimateForPolicy(parsed.data)
    if (!r.ok) return rcmErrorResponse(r)
    return NextResponse.json(r.value)
  } catch (err) {
    return rcmServerError('pre-auth estimate', err, 'Could not price the estimate')
  }
}
