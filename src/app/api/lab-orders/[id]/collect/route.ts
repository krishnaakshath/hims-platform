// SP5: walk-in collection through the lifecycle query (sample ID allocated in the same
// transaction, audit on that transaction). frontdesk has no lab access.
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { LAB_COLLECT_ROLES } from '@/lib/role-policy'
import { collectLabOrder } from '@/lib/queries/lab-lifecycle'
import { errorResponse, labServerError, labTransitionError, parseId } from '@/lib/labs/route-responses'

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!LAB_COLLECT_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const orderId = parseId((await params).id)
  if (orderId === null) return errorResponse(400, 'Invalid order id')

  let result: Awaited<ReturnType<typeof collectLabOrder>>
  try {
    result = await collectLabOrder(orderId, session)
  } catch (err) {
    return labServerError('lab collect', err, 'Could not mark the sample collected')
  }
  if (!result.ok) return labTransitionError(result.error)
  return NextResponse.json({ ok: true, sampleId: result.sampleId })
}
