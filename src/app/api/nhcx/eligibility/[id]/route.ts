import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { NHCX_ELIGIBILITY_ROLES } from '@/lib/role-policy'
import { getEligibilityCheck } from '@/lib/queries/nhcx-eligibility'
import { parseId, rcmError } from '@/lib/rcm/route-responses'

// SP8: one eligibility check's state (polled by the panel). Status only: no payload.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!NHCX_ELIGIBILITY_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const id = parseId((await params).id)
  if (id === null) return rcmError(400, 'Invalid check id')
  const check = await getEligibilityCheck(id)
  if (!check) return rcmError(404, 'Not found')
  const { patientId: _p, ...view } = check
  void _p
  return NextResponse.json(view)
}
