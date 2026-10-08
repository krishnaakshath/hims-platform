import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { RCM_ROLES } from '@/lib/role-policy'
import { preauthActionSchema } from '@/lib/rcm/validation'
import { applyPreauthAction } from '@/lib/queries/preauths'
import { invalid, parseId, rcmError, rcmErrorResponse, rcmServerError, readJsonBody } from '@/lib/rcm/route-responses'

// SP7: one pre-auth lifecycle step (request, query, response, approval, enhancement, rejection, cancel).
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!RCM_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = preauthActionSchema.safeParse(json.body)
  if (!parsed.success) return invalid(parsed.error, 'Invalid pre-authorisation step')
  const id = parseId((await params).id)
  if (id === null) return rcmError(400, 'Invalid pre-authorisation id')

  try {
    const r = await applyPreauthAction(id, parsed.data, session)
    if (!r.ok) return rcmErrorResponse(r)
    return NextResponse.json(r.value)
  } catch (err) {
    return rcmServerError('pre-auth action', err, 'Could not save the pre-authorisation')
  }
}
