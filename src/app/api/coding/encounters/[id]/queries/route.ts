// POST /api/coding/encounters/[id]/queries `{ addressedToProviderId, question }`: a coder (with
// the claim) or admin asks a doctor about the visit; the encounter moves to `queried`. Gate inline
// first. The question text is stored in its table only, never audited or echoed back.
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { CODING_ROLES } from '@/lib/role-policy'
import { readJsonBody } from '@/lib/follow-ups/route-responses'
import { invalid, parseId } from '@/lib/tariff/route-responses'
import { raiseQuerySchema } from '@/lib/coding/validation'
import { INVALID_CODING_REQUEST, codingErrorResponse, codingServerError, invalidCodingId } from '@/lib/coding/route-responses'
import { raiseCodingQuery } from '@/lib/queries/coding-queries'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CODING_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const encounterId = parseId((await params).id)
  if (encounterId === null) return invalidCodingId()
  const read = await readJsonBody(request)
  if (!read.ok) return read.response
  const parsed = raiseQuerySchema.safeParse(read.body)
  if (!parsed.success) return invalid(parsed.error, INVALID_CODING_REQUEST)

  try {
    const r = await raiseCodingQuery(encounterId, parsed.data, session)
    if (!r.ok) return codingErrorResponse(r.error, r.issues)
    return NextResponse.json({ id: r.value.queryId }, { status: 201 })
  } catch (err) {
    return codingServerError('raise query', err)
  }
}
