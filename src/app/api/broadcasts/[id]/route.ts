import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getBroadcast } from '@/lib/queries/broadcasts'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  // LeftNav.tsx:62 — { href: '/broadcasts', roles: ['admin', 'crc'] }
  if (!['admin', 'crc'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { id } = await params
  const broadcast = await getBroadcast(Number(id))
  if (!broadcast) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await logAudit(session, `viewed broadcast ${id}`, null)
  return NextResponse.json(broadcast)
}
