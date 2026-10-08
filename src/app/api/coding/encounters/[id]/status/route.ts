// POST /api/coding/encounters/[id]/status `{ action, … }`: claim, assign, release, resume,
// mark_coded, finalise or reopen. Two gates: CODING_ROLES inline before the body is read, then
// CODING_ACTION_ROLES for the parsed action (assign is admin-only), both the exact Forbidden 403.
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { CODING_ROLES } from '@/lib/role-policy'
import { CODING_ACTION_ROLES } from '@/lib/coding/status'
import { readJsonBody } from '@/lib/follow-ups/route-responses'
import { invalid, parseId } from '@/lib/tariff/route-responses'
import { codingStatusRequestSchema } from '@/lib/coding/validation'
import { INVALID_CODING_REQUEST, codingErrorResponse, codingServerError, invalidCodingId } from '@/lib/coding/route-responses'
import { applyCodingAction } from '@/lib/queries/coding'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CODING_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const encounterId = parseId((await params).id)
  if (encounterId === null) return invalidCodingId()
  const read = await readJsonBody(request)
  if (!read.ok) return read.response
  const parsed = codingStatusRequestSchema.safeParse(read.body)
  if (!parsed.success) return invalid(parsed.error, INVALID_CODING_REQUEST)
  if (!CODING_ACTION_ROLES[parsed.data.action].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  try {
    const r = await applyCodingAction(encounterId, parsed.data, session)
    if (!r.ok) return codingErrorResponse(r.error, r.issues)
    return NextResponse.json({ status: r.value.status, issues: r.value.issues })
  } catch (err) {
    return codingServerError(`coding action ${parsed.data.action}`, err)
  }
}
