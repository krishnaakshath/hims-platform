import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { CASH_DESK_ROLES } from '@/lib/role-policy'
import { confirmUpiRequest } from '@/lib/payments/manual-upi'
import { normaliseUtr, UTR_PATTERN } from '@/lib/payments/provider'
import { billingError, billingServerError, invalid, parseId, readJsonBody } from '@/lib/billing/route-responses'

// Foundations T11: record a UPI QR payment with the payer's UTR. Posts exactly one receipt through
// the shared ledger write; a UTR already recorded, or a request already confirmed, is a 409.
const UTR_MESSAGE = 'Enter the 12-digit UTR (UPI reference) from the payer\'s app'
const confirmSchema = z.object({
  utr: z.string().max(40).refine((v) => UTR_PATTERN.test(normaliseUtr(v)), { message: UTR_MESSAGE }),
}).strict()

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CASH_DESK_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const requestId = parseId((await params).id)
  if (requestId === null) return billingError(404, 'Payment request not found')
  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = confirmSchema.safeParse(json.body)
  if (!parsed.success) return invalid(parsed.error, 'Invalid confirmation')

  try {
    const result = await confirmUpiRequest({ requestId, utr: parsed.data.utr }, session)
    if (!result.ok) {
      switch (result.error) {
        case 'request_not_found': return billingError(404, 'Payment request not found')
        case 'already_confirmed': return billingError(409, 'This UPI payment has already been recorded')
        case 'request_expired': return billingError(409, 'This UPI request has expired or was cancelled. Show a new QR.')
        case 'duplicate_utr': return billingError(409, 'This UTR has already been recorded')
        case 'admission_mismatch': return billingError(400, "That admission is not this patient's")
        case 'invoice_not_payable': return billingError(409, 'Payments can only be taken against a finalised invoice of this patient')
        case 'series_exhausted': return billingError(409, 'The receipt number series for this financial year is full')
        // Only a caller's under-lock check (door payments) returns this; none is passed here.
        case 'already_paid': return billingError(409, 'This payment has already been recorded')
      }
    }
    return NextResponse.json({ receiptNumber: result.receiptNumber, paymentId: result.paymentId }, { status: 201 })
  } catch (err) {
    return billingServerError('confirm UPI request', err, 'Could not record the UPI payment')
  }
}
