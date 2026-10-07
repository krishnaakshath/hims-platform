// GET /api/coding/codes?kind&q&on&limit: prefix/text search over the kind's current code-system
// version. Terminology only (no PHI), so it is not audited.
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { CODE_LOOKUP_ROLES } from '@/lib/role-policy'
import { codeSearchParamsSchema } from '@/lib/coding/validation'
import { pgConstraint, pgErrorCode } from '@/lib/db-errors'
import { searchCodes } from '@/lib/queries/code-systems'

export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CODE_LOOKUP_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const parsed = codeSearchParamsSchema.safeParse(Object.fromEntries(request.nextUrl.searchParams))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid code search' }, { status: 400 })
  const { kind, q, on, limit } = parsed.data

  try {
    return NextResponse.json(await searchCodes({ kind, q, onDate: on ?? null, limit }))
  } catch (err) {
    console.error(`[coding] code search failed (code ${pgErrorCode(err) ?? 'unknown'}, constraint ${pgConstraint(err) ?? 'none'})`)
    return NextResponse.json({ error: 'Could not search codes' }, { status: 500 })
  }
}
