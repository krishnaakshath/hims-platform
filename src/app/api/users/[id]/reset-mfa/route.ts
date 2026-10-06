import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { getUserNameById, resetUserMfa } from '@/lib/queries/users'
import { logAudit } from '@/lib/audit'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })

  const { id } = await params
  const userId = Number(id)
  if (!Number.isInteger(userId)) return NextResponse.json({ error: 'Invalid staff account id' }, { status: 400 })

  const name = await getUserNameById(userId)
  if (!name) return NextResponse.json({ error: 'Staff account not found' }, { status: 404 })

  await resetUserMfa(userId)
  await logAudit(session, `reset MFA for staff member ${name}`, null)

  return NextResponse.json({ ok: true })
}
