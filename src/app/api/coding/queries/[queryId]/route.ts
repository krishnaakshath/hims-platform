// PATCH /api/coding/queries/[queryId] `{ action: 'close' | 'withdraw' }`: a coder (with the
// encounter's claim) or admin closes or withdraws a coding query. Gate inline first.
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { CODING_ROLES } from '@/lib/role-policy'
import { readJsonBody } from '@/lib/follow-ups/route-responses'
import { invalid, parseId } from '@/lib/tariff/route-responses'
import { queryActionSchema } from '@/lib/coding/validation'
import { INVALID_CODING_REQUEST, codingErrorResponse, codingServerError, invalidCodingId } from '@/lib/coding/route-responses'
import { closeCodingQuery } from '@/lib/queries/coding-queries'

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ queryId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CODING_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const queryId = parseId((await params).queryId)
  if (queryId === null) return invalidCodingId()
  const read = await readJsonBody(request)
  if (!read.ok) return read.response
  const parsed = queryActionSchema.safeParse(read.body)
  if (!parsed.success) return invalid(parsed.error, INVALID_CODING_REQUEST)

  try {
    const r = await closeCodingQuery(queryId, parsed.data.action, session)
    if (!r.ok) return codingErrorResponse(r.error, r.issues)
    return NextResponse.json({ status: r.value.status })
  } catch (err) {
    return codingServerError('close query', err)
  }
}
