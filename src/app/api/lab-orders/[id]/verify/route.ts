// SP5: verification of a resulted order, never by the person who entered the result (the query
// enforces that and audits on its own transaction). No body.
// WS4 T11 (spec 3.4): gate LAB_VERIFY_ROLES (admin, labs, pi), then the query requires the
// session's staff link to a provider of the test's department: 403 `not_linked` / `wrong_department`.
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { LAB_VERIFY_ROLES } from '@/lib/role-policy'
import { verifyLabResult } from '@/lib/queries/lab-lifecycle'
import { errorResponse, labServerError, labTransitionError, parseId, verifyDenialError } from '@/lib/labs/route-responses'
import { invalidateLabKpis } from '@/lib/queries/hospital-kpis' // WS4 T11 (R6)

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!LAB_VERIFY_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const orderId = parseId((await params).id)
  if (orderId === null) return errorResponse(400, 'Invalid order id')

  let result: Awaited<ReturnType<typeof verifyLabResult>>
  try {
    result = await verifyLabResult(orderId, session)
  } catch (err) {
    return labServerError('lab verify', err, 'Could not verify the result')
  }
  if (!result.ok) {
    if (result.error === 'not_linked' || result.error === 'wrong_department') return verifyDenialError(result.error)
    return labTransitionError(result.error)
  }
  await invalidateLabKpis()
  return NextResponse.json({ ok: true })
}
