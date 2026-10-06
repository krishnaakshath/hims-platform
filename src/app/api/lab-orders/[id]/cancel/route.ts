import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { cancelOrder } from '@/lib/queries/lab-orders'

const cancelOrderSchema = z.object({
  reason: z.string().min(1),
}).strict()

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['admin', 'pi'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const orderId = Number(id)
  if (!Number.isInteger(orderId)) return NextResponse.json({ error: 'Invalid order id' }, { status: 400 })

  const parsed = cancelOrderSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid cancel payload', details: parsed.error.flatten() }, { status: 400 })

  const result = await cancelOrder(orderId, parsed.data.reason)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 })

  // `reason` has no dedicated column on `labOrders` (Task 1's approved
  // schema has none) -- it's carried into the audit action text instead,
  // the same place this codebase already puts free-text context that has
  // no schema column of its own.
  await logAudit(session, `cancelled lab order: ${parsed.data.reason}`, result.patientId)
  return NextResponse.json({ ok: true })
}
