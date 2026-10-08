import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { BILLING_AUTHORITY_ROLES } from '@/lib/role-policy'
import { refundSchema } from '@/lib/billing/validation'
import { issueRefund } from '@/lib/queries/patient-ledger'
import { formatPaise } from '@/lib/format'
import { billingError, billingServerError, invalid, readJsonBody } from '@/lib/billing/route-responses'

// SP4: refund money to a patient, at most their credit balance (billing authority only).
export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!BILLING_AUTHORITY_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = refundSchema.safeParse(json.body)
  if (!parsed.success) return invalid(parsed.error, 'Invalid refund')

  try {
    const result = await issueRefund(parsed.data, session)
    if (!result.ok) {
      switch (result.error) {
        case 'patient_not_found': return billingError(404, 'Patient not found')
        case 'payment_mismatch': return billingError(400, "That receipt is not this patient's")
        case 'admission_mismatch': return billingError(400, "That admission is not this patient's")
        case 'exceeds_credit': return billingError(409, `Refund is more than the patient's credit of ${formatPaise(result.creditPaise ?? 0)}`)
        case 'series_exhausted': return billingError(409, 'The refund number series for this financial year is full')
      }
    }
    return NextResponse.json({ refundNumber: result.refundNumber }, { status: 201 })
  } catch (err) {
    return billingServerError('issue refund', err, 'Could not issue the refund')
  }
}
