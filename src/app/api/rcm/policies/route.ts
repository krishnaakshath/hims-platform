import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { POLICY_WRITE_ROLES } from '@/lib/role-policy'
import { policySchema } from '@/lib/rcm/validation'
import { createPolicy } from '@/lib/queries/rcm-policies'
import { invalid, rcmErrorResponse, rcmServerError, readJsonBody } from '@/lib/rcm/route-responses'

// SP7: record a patient's insurance policy (front desk at registration/admission, or RCM).
export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!POLICY_WRITE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = policySchema.safeParse(json.body)
  if (!parsed.success) return invalid(parsed.error, 'Invalid policy details')

  try {
    const r = await createPolicy(parsed.data, session)
    if (!r.ok) return rcmErrorResponse(r)
    return NextResponse.json(r.value, { status: 201 })
  } catch (err) {
    return rcmServerError('create policy', err, 'Could not save the policy')
  }
}
