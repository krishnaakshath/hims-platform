import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { listAuditLog } from '@/lib/queries/audit-log'

export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })

  const limitParam = request.nextUrl.searchParams.get('limit')
  const limit = limitParam ? Number(limitParam) : undefined
  const entries = await listAuditLog(limit && Number.isFinite(limit) && limit > 0 ? limit : undefined)
  return NextResponse.json({ entries })
}
