import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { blockRoom } from '@/lib/queries/rooms'

const blockSchema = z.object({ reason: z.string().min(1) }).strict()

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const roomId = Number(id)
  if (!Number.isInteger(roomId)) return NextResponse.json({ error: 'Invalid room id' }, { status: 400 })

  const parsed = blockSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 400 })

  const ok = await blockRoom(roomId, parsed.data.reason)
  if (!ok) return NextResponse.json({ error: 'Room is not currently available, or does not exist' }, { status: 409 })

  await logAudit(session, `blocked room ${roomId}: ${parsed.data.reason}`, null)
  return NextResponse.json({ ok: true })
}
