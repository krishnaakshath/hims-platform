import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getBookingRequestById, declineBookingRequest } from '@/lib/queries/booking-requests'

const declineBookingRequestSchema = z.object({
  reason: z.string().min(1),
}).strict()

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['admin', 'crc', 'frontdesk'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const requestId = Number(id)
  if (!Number.isInteger(requestId)) return NextResponse.json({ error: 'Invalid booking request id' }, { status: 400 })

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const parsed = declineBookingRequestSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid decline payload', details: parsed.error.flatten() }, { status: 400 })

  const existing = await getBookingRequestById(requestId)
  if (!existing) return NextResponse.json({ error: 'Booking request not found' }, { status: 404 })

  const result = await declineBookingRequest(requestId, { reason: parsed.data.reason, reviewedByName: session.name })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 })

  await logAudit(session, 'declined booking request', null)
  return NextResponse.json(result)
}
