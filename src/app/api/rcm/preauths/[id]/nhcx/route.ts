import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { NHCX_EXCHANGE_ROLES } from '@/lib/role-policy'
import { readNhcxConfig } from '@/lib/integrations/config'
import { createPreauthExchange } from '@/lib/queries/nhcx-exchanges'
import { parseId, rcmError, rcmErrorResponse, rcmServerError, readJsonBody } from '@/lib/rcm/route-responses'

// SP8: send the latest pre-authorisation request through NHCX. The send is an
// outbox row; it goes out after the response (and from the cron sweep).
const bodySchema = z.object({}).strict()

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!NHCX_EXCHANGE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request, { emptyAs: {} })
  if (!json.ok) return json.response
  if (!bodySchema.safeParse(json.body).success) return rcmError(400, 'Invalid request')
  const id = parseId((await params).id)
  if (id === null) return rcmError(400, 'Invalid pre-authorisation id')
  if (readNhcxConfig().state === 'not_configured') return rcmError(503, 'NHCX is not configured')

  try {
    const r = await createPreauthExchange(id, session)
    if (!r.ok) return rcmErrorResponse(r)
    return NextResponse.json({ exchangeId: r.value.exchangeId, correlationPrefix: r.value.correlationId.slice(0, 8) }, { status: 202 })
  } catch (err) {
    return rcmServerError('nhcx pre-auth send', err, 'Could not queue the pre-authorisation for NHCX')
  }
}
