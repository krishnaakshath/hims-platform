import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { RCM_ROLES } from '@/lib/role-policy'
import { claimCreateSchema } from '@/lib/rcm/validation'
import { createClaimDraft } from '@/lib/queries/claims'
import { invalid, rcmErrorResponse, rcmServerError, readJsonBody } from '@/lib/rcm/route-responses'

// SP7: create a draft claim from finalised invoices of one visit or stay.
export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!RCM_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = claimCreateSchema.safeParse(json.body)
  if (!parsed.success) return invalid(parsed.error, 'Invalid request')

  try {
    const r = await createClaimDraft(parsed.data, session)
    if (!r.ok) return rcmErrorResponse(r)
    return NextResponse.json(r.value, { status: 201 })
  } catch (err) {
    return rcmServerError('create claim', err, 'Could not save the claim')
  }
}
