// GET /api/coding/codes?kind&q&on&limit: prefix/text search over the kind's current code-system
// version. Terminology only (no PHI), so it is not audited.
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { CODE_LOOKUP_ROLES } from '@/lib/role-policy'
import { codeSearchParamsSchema } from '@/lib/coding/validation'
import { codingJson, codingServerError } from '@/lib/coding/route-responses'
import { searchCodes } from '@/lib/queries/code-systems'

export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CODE_LOOKUP_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const parsed = codeSearchParamsSchema.safeParse(Object.fromEntries(request.nextUrl.searchParams))
  if (!parsed.success) return codingJson(400, 'Invalid code search')
  const { kind, q, on, limit } = parsed.data

  try {
    return NextResponse.json(await searchCodes({ kind, q, onDate: on ?? null, limit }))
  } catch (err) {
    return codingServerError('code search', err, 'Could not search codes')
  }
}
