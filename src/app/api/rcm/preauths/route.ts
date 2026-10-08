import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { RCM_ROLES } from '@/lib/role-policy'
import { preauthCreateSchema } from '@/lib/rcm/validation'
import { createPreauth } from '@/lib/queries/preauths'
import { invalid, rcmErrorResponse, rcmServerError, readJsonBody } from '@/lib/rcm/route-responses'

// SP7: create a draft pre-authorisation with a tariff-priced estimate.
export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!RCM_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = preauthCreateSchema.safeParse(json.body)
  if (!parsed.success) return invalid(parsed.error, 'Invalid pre-authorisation details')

  try {
    const r = await createPreauth(parsed.data, session)
    if (!r.ok) return rcmErrorResponse(r)
    return NextResponse.json(r.value, { status: 201 })
  } catch (err) {
    return rcmServerError('create pre-auth', err, 'Could not save the pre-authorisation')
  }
}
