import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { hasSearchScope, searchScopesFor } from '@/lib/role-policy'
import { searchAll } from '@/lib/queries/search'

export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!hasSearchScope(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const q = new URL(request.url).searchParams.get('q') ?? ''
  const results = await searchAll(q, searchScopesFor(session.role))
  if (q.trim().length > 0) await logAudit(session, `searched for "${q.slice(0, 200)}"`, null)
  return NextResponse.json(results)
}
