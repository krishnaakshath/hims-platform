// SP5: verification of a resulted order by pi/admin, never by the person who entered the result
// (the query enforces that and audits on its own transaction). No body.
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { LAB_VERIFY_ROLES } from '@/lib/role-policy'
import { verifyLabResult } from '@/lib/queries/lab-lifecycle'
import { errorResponse, labServerError, labTransitionError, parseId } from '@/lib/labs/route-responses'

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
  if (!result.ok) return labTransitionError(result.error)
  return NextResponse.json({ ok: true })
}
