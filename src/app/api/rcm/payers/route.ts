import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { PAYER_MASTER_ROLES } from '@/lib/role-policy'
import { payerCreateSchema } from '@/lib/rcm/validation'
import { createPayerWithProfile } from '@/lib/queries/rcm-payers'
import { invalid, rcmErrorResponse, rcmServerError, readJsonBody } from '@/lib/rcm/route-responses'

// SP7: create an insurer, TPA, government scheme or corporate payer with its profile.
export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!PAYER_MASTER_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = payerCreateSchema.safeParse(json.body)
  if (!parsed.success) return invalid(parsed.error, 'Invalid payer details')

  try {
    const r = await createPayerWithProfile(parsed.data, session)
    if (!r.ok) return rcmErrorResponse(r)
    return NextResponse.json(r.value, { status: 201 })
  } catch (err) {
    return rcmServerError('create payer', err, 'Could not save the payer')
  }
}
