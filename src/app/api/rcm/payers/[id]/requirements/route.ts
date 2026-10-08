import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { PAYER_MASTER_ROLES } from '@/lib/role-policy'
import { documentRequirementsSchema } from '@/lib/rcm/validation'
import { setDocumentRequirements } from '@/lib/queries/rcm-payers'
import { invalid, parseId, rcmError, rcmErrorResponse, rcmServerError, readJsonBody } from '@/lib/rcm/route-responses'

// SP7: replace a payer's required-document overrides for one claim type.
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!PAYER_MASTER_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = documentRequirementsSchema.safeParse(json.body)
  if (!parsed.success) return invalid(parsed.error, 'Invalid document requirements')
  const id = parseId((await params).id)
  if (id === null) return rcmError(400, 'Invalid payer id')

  try {
    const r = await setDocumentRequirements(id, parsed.data.claimType, parsed.data.entries, session)
    if (!r.ok) return rcmErrorResponse(r)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return rcmServerError('document requirements', err, 'Could not save the payer')
  }
}
