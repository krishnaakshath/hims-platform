import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { NHCX_EXCHANGE_ROLES } from '@/lib/role-policy'
import { getExchangePayloadView } from '@/lib/queries/nhcx-review'
import { parseId, rcmError, rcmServerError } from '@/lib/rcm/route-responses'

// SP8: the review view of one inbound NHCX response, decrypted server-side.
// No raw bundle and no JWE leave the server; the view is audited.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!NHCX_EXCHANGE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const id = parseId((await params).id)
  if (id === null) return rcmError(400, 'Invalid exchange id')
  try {
    const view = await getExchangePayloadView(id, session)
    if (!view) return rcmError(404, 'Not found')
    return NextResponse.json(view, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (err) {
    return rcmServerError('nhcx payload view', err, 'Could not open the response')
  }
}
