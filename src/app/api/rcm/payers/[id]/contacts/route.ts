import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { PAYER_MASTER_ROLES } from '@/lib/role-policy'
import { payerContactsSchema } from '@/lib/rcm/validation'
import { setPayerContacts } from '@/lib/queries/rcm-payers'
import { invalid, parseId, rcmError, rcmErrorResponse, rcmServerError, readJsonBody } from '@/lib/rcm/route-responses'

// SP7: replace a payer's contacts.
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!PAYER_MASTER_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = payerContactsSchema.safeParse(json.body)
  if (!parsed.success) return invalid(parsed.error, 'Invalid payer contacts')
  const id = parseId((await params).id)
  if (id === null) return rcmError(400, 'Invalid payer id')

  try {
    const r = await setPayerContacts(id, parsed.data.contacts, session)
    if (!r.ok) return rcmErrorResponse(r)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return rcmServerError('payer contacts', err, 'Could not save the payer')
  }
}
