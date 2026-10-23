import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { CASH_DESK_ROLES } from '@/lib/role-policy'
import { MAX_DOCUMENT_PAISE } from '@/lib/billing/amounts'
import { createUpiRequest } from '@/lib/payments/manual-upi'
import { UPI_NOT_CONFIGURED_MESSAGE } from '@/lib/payments/provider'
import { billingError, billingServerError, invalid, readJsonBody } from '@/lib/billing/route-responses'

// Foundations T11: show a UPI QR for an amount (manual_upi_qr). Same roles as POST
// /api/billing/payments (CASH_DESK_ROLES: admin, billing, crc, frontdesk); the money is recorded
// only when the request is confirmed with the payer's UTR.
const positiveInt = z.number().int().positive().max(2_147_483_647)
const upiRequestSchema = z.object({
  patientId: z.string().min(1).max(40),
  amountPaise: z.number().int().min(1).max(MAX_DOCUMENT_PAISE),
  kind: z.enum(['advance', 'receipt']).optional(),
  admissionId: positiveInt.optional(),
  invoiceId: positiveInt.optional(),
  note: z.string().trim().max(50).optional(),
}).strict()

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CASH_DESK_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = upiRequestSchema.safeParse(json.body)
  if (!parsed.success) return invalid(parsed.error, 'Invalid UPI payment request')

  try {
    const result = await createUpiRequest(parsed.data, session)
    if (!result.ok) {
      switch (result.error) {
        case 'not_configured': return billingError(503, UPI_NOT_CONFIGURED_MESSAGE)
        case 'patient_not_found': return billingError(404, 'Patient not found')
        case 'admission_mismatch': return billingError(400, "That admission is not this patient's")
        case 'invoice_not_payable': return billingError(409, 'Payments can only be taken against a finalised invoice of this patient')
      }
    }
    const { requestId, uri, qrDataUrl, vpa, payeeName, amountPaise } = result
    return NextResponse.json({ requestId, uri, qrDataUrl, vpa, payeeName, amountPaise }, { status: 201 })
  } catch (err) {
    return billingServerError('create UPI request', err, 'Could not create the UPI payment request')
  }
}
