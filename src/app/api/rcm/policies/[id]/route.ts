import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { POLICY_WRITE_ROLES } from '@/lib/role-policy'
import { policyPatchSchema } from '@/lib/rcm/validation'
import { updatePolicy } from '@/lib/queries/rcm-policies'
import { invalid, parseId, rcmError, rcmErrorResponse, rcmServerError, readJsonBody } from '@/lib/rcm/route-responses'

// SP7: change a policy (validity, priority, status, payers, numbers).
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!POLICY_WRITE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = policyPatchSchema.safeParse(json.body)
  if (!parsed.success) return invalid(parsed.error, 'Invalid policy details')
  const id = parseId((await params).id)
  if (id === null) return rcmError(400, 'Invalid policy id')

  try {
    const r = await updatePolicy(id, parsed.data, session)
    if (!r.ok) return rcmErrorResponse(r)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return rcmServerError('update policy', err, 'Could not save the policy')
  }
}
