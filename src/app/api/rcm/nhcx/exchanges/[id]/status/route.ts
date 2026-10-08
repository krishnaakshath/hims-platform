import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { NHCX_EXCHANGE_ROLES } from '@/lib/role-policy'
import { readNhcxConfig } from '@/lib/integrations/config'
import { pollExchangeStatus } from '@/lib/queries/nhcx-exchanges'
import { parseId, rcmError, rcmServerError, readJsonBody } from '@/lib/rcm/route-responses'

// SP8: ask NHCX for the status of one exchange (at most every 15 minutes).
const bodySchema = z.object({}).strict()

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!NHCX_EXCHANGE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request, { emptyAs: {} })
  if (!json.ok) return json.response
  if (!bodySchema.safeParse(json.body).success) return rcmError(400, 'Invalid request')
  const id = parseId((await params).id)
  if (id === null) return rcmError(400, 'Invalid exchange id')
  if (readNhcxConfig().state !== 'configured') return rcmError(503, 'NHCX is not configured')

  try {
    const result = await pollExchangeStatus(id)
    if (result === 'too_soon') return rcmError(429, 'Status was checked less than 15 minutes ago')
    if (result === 'disabled') return rcmError(409, 'Status checks through NHCX are turned off for this hospital')
    if (result === 'not_pollable') return rcmError(409, 'This exchange is not waiting for an insurer answer')
    await logAudit(session, 'nhcx: requested status', null, `exchange=${id}`)
    return NextResponse.json({ result })
  } catch (err) {
    return rcmServerError('nhcx status', err, 'Could not check the status')
  }
}
