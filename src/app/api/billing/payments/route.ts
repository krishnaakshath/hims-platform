import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { CASH_DESK_ROLES } from '@/lib/role-policy'
import { paymentSchema } from '@/lib/billing/validation'
import { recordPayment } from '@/lib/queries/patient-ledger'
import { billingError, billingServerError, invalid, readJsonBody } from '@/lib/billing/route-responses'

// SP4 cash desk: record an advance or a receipt (front desk included). Record-keeping only.
export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CASH_DESK_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = paymentSchema.safeParse(json.body)
  if (!parsed.success) return invalid(parsed.error, 'Invalid payment')

  try {
    const result = await recordPayment(parsed.data, session)
    if (!result.ok) {
      switch (result.error) {
        case 'patient_not_found': return billingError(404, 'Patient not found')
        case 'admission_mismatch': return billingError(400, "That admission is not this patient's")
        case 'invoice_not_payable': return billingError(409, 'Payments can only be taken against a finalised invoice of this patient')
        case 'series_exhausted': return billingError(409, 'The receipt number series for this financial year is full')
      }
    }
    return NextResponse.json({ receiptNumber: result.receiptNumber, paymentId: result.paymentId }, { status: 201 })
  } catch (err) {
    return billingServerError('record payment', err, 'Could not record the payment')
  }
}
