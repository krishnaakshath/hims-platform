import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { unblockRoom } from '@/lib/queries/rooms'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const roomId = Number(id)
  if (!Number.isInteger(roomId)) return NextResponse.json({ error: 'Invalid room id' }, { status: 400 })

  const ok = await unblockRoom(roomId)
  if (!ok) return NextResponse.json({ error: 'Room is not currently blocked, or does not exist' }, { status: 409 })

  await logAudit(session, `unblocked room ${roomId}`, null)
  return NextResponse.json({ ok: true })
}
