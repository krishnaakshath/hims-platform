// POST /api/coding/queries/[queryId]/responses `{ body }`: a reply on a coding query. Any pi or
// admin may answer (cross-cover, ruling 8); the coder may add to the thread. A reply on a query
// that is still `answered` after finalise stays allowed: it is conversation, not a code write.
// Gate inline first; the reply text is stored in its table only, never audited or echoed back.
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { CODING_QUERY_RESPOND_ROLES } from '@/lib/role-policy'
import { readJsonBody } from '@/lib/follow-ups/route-responses'
import { invalid, parseId } from '@/lib/tariff/route-responses'
import { queryResponseSchema } from '@/lib/coding/validation'
import { INVALID_CODING_REQUEST, codingErrorResponse, codingServerError, invalidCodingId } from '@/lib/coding/route-responses'
import { respondToCodingQuery } from '@/lib/queries/coding-queries'

export async function POST(request: NextRequest, { params }: { params: Promise<{ queryId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CODING_QUERY_RESPOND_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const queryId = parseId((await params).queryId)
  if (queryId === null) return invalidCodingId()
  const read = await readJsonBody(request)
  if (!read.ok) return read.response
  const parsed = queryResponseSchema.safeParse(read.body)
  if (!parsed.success) return invalid(parsed.error, INVALID_CODING_REQUEST)

  try {
    const r = await respondToCodingQuery(queryId, parsed.data.body, session)
    if (!r.ok) return codingErrorResponse(r.error, r.issues)
    return NextResponse.json({ id: r.value.responseId }, { status: 201 })
  } catch (err) {
    return codingServerError('respond to query', err)
  }
}
