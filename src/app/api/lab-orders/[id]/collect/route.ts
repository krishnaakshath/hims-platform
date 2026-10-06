import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { markCollected } from '@/lib/queries/lab-orders'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  // frontdesk previously had mark-collected access (a logistics step, not a
  // clinical judgment) -- removed per explicit product direction: front
  // desk's job is registration/check-in, not touching lab results at all.
  if (!['admin', 'pi', 'labs'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const orderId = Number(id)
  if (!Number.isInteger(orderId)) return NextResponse.json({ error: 'Invalid order id' }, { status: 400 })

  const result = await markCollected(orderId)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 })

  await logAudit(session, 'marked lab order collected', result.patientId)
  return NextResponse.json({ ok: true })
}
