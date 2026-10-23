import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { CASH_DESK_ROLES } from '@/lib/role-policy'
import { cancelUpiRequest } from '@/lib/payments/manual-upi'
import { billingError, billingServerError, invalid, parseId, readJsonBody } from '@/lib/billing/route-responses'

// Foundations T11: withdraw a UPI QR that will not be paid (pending only). The ledger is untouched;
// a cancelled request can no longer be confirmed. Same roles as the request and confirm routes.
const cancelSchema = z.object({}).strict()

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CASH_DESK_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const requestId = parseId((await params).id)
  if (requestId === null) return billingError(404, 'Payment request not found')
  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = cancelSchema.safeParse(json.body)
  if (!parsed.success) return invalid(parsed.error, 'Invalid cancellation')

  try {
    const result = await cancelUpiRequest(requestId, session)
    if (!result.ok) {
      return result.error === 'not_pending'
        ? billingError(409, 'This UPI request is no longer pending')
        : billingError(404, 'Payment request not found')
    }
    return NextResponse.json({ cancelled: true })
  } catch (err) {
    return billingServerError('cancel UPI request', err, 'Could not cancel the UPI request')
  }
}
