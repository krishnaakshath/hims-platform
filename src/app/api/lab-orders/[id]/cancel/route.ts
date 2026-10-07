// SP5: cancel through the lifecycle query. The reason is stored on the order; the query's audit
// row carries ids only, never the reason text (the route writes no audit of its own).
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { LAB_ORDER_ROLES } from '@/lib/role-policy'
import { labOrderCancelSchema } from '@/lib/labs/validation'
import { cancelLabOrder } from '@/lib/queries/lab-lifecycle'
import { errorResponse, invalidBody, labServerError, labTransitionError, parseId, readJsonBody } from '@/lib/labs/route-responses'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!LAB_ORDER_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = labOrderCancelSchema.safeParse(json.body)
  if (!parsed.success) return invalidBody(parsed.error, 'A reason is required to cancel a test')
  const orderId = parseId((await params).id)
  if (orderId === null) return errorResponse(400, 'Invalid order id')

  let result: Awaited<ReturnType<typeof cancelLabOrder>>
  try {
    result = await cancelLabOrder(orderId, parsed.data.reason, session)
  } catch (err) {
    return labServerError('lab cancel', err, 'Could not cancel the test')
  }
  if (!result.ok) return labTransitionError(result.error)
  return NextResponse.json({ ok: true })
}
