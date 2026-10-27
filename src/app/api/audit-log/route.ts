import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { encodeAuditCursor, listAuditLog, parseAuditLogQuery } from '@/lib/queries/audit-log'

// WS8 T12 (spec D19): admin-only, strict query (filters + base64url keyset cursor), 50 per page.
export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const parsed = parseAuditLogQuery(Object.fromEntries(request.nextUrl.searchParams), { allowCursor: true })
  if (!parsed.ok) return NextResponse.json({ error: 'Invalid audit log filters' }, { status: 400 })
  const { entries, nextCursor } = await listAuditLog(parsed.filters, parsed.cursor)
  return NextResponse.json(
    { entries, nextCursor: nextCursor ? encodeAuditCursor(nextCursor) : null },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
