import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listWorklist } from '@/lib/queries/lab-orders'

export async function GET() {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['admin', 'pi', 'crc', 'labs'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const worklist = await listWorklist()

  await logAudit(session, 'viewed lab worklist', null)
  return NextResponse.json(worklist)
}
