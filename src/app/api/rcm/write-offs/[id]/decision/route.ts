import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { WRITE_OFF_APPROVE_ROLES } from '@/lib/role-policy'
import { writeOffDecisionSchema } from '@/lib/rcm/validation'
import { decideWriteOff } from '@/lib/queries/claim-updates'
import { invalid, parseId, rcmError, rcmErrorResponse, rcmServerError, readJsonBody } from '@/lib/rcm/route-responses'

// SP7: approve or reject a write-off (admin with a staff account, not the requester).
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!WRITE_OFF_APPROVE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = writeOffDecisionSchema.safeParse(json.body)
  if (!parsed.success) return invalid(parsed.error, 'Invalid request')
  const id = parseId((await params).id)
  if (id === null) return rcmError(400, 'Invalid write-off id')

  try {
    const r = await decideWriteOff(id, parsed.data, session)
    if (!r.ok) return rcmErrorResponse(r)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return rcmServerError('decide write-off', err, 'Could not save the claim')
  }
}
