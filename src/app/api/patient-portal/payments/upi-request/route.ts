// WS7 T8 (spec D14): the signed-in patient's "Pay now" on a bill. Shows a UPI QR for the
// invoice's outstanding amount; nothing is recorded as paid here. The cashier posts the receipt
// when they confirm the payment from the Cash Desk. Another patient's invoice is a 404.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requirePatientSession } from '@/lib/patient-session'
import { readJsonBody } from '@/lib/http'
import { checkPortalPaymentRequestRateLimit } from '@/lib/rate-limit'
import { createPortalUpiRequest } from '@/lib/payments/manual-upi'
import { UPI_NOT_CONFIGURED_MESSAGE } from '@/lib/payments/provider'

const schema = z.object({ invoiceId: z.number().int().positive().max(2_147_483_647) }).strict()

export async function POST(request: NextRequest) {
  const session = await requirePatientSession()
  if (session instanceof NextResponse) return session

  if (!(await checkPortalPaymentRequestRateLimit(session.patientId)).allowed) {
    return NextResponse.json({ error: 'Too many requests. Please try again later or pay at the hospital.' }, { status: 429 })
  }

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = schema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payment request' }, { status: 400 })

  try {
    const result = await createPortalUpiRequest(session.patientId, parsed.data.invoiceId)
    if (!result.ok) {
      switch (result.error) {
        case 'not_configured': return NextResponse.json({ error: UPI_NOT_CONFIGURED_MESSAGE }, { status: 503 })
        case 'invoice_not_found': return NextResponse.json({ error: 'Bill not found' }, { status: 404 })
        case 'already_paid': return NextResponse.json({ error: 'This bill is already paid' }, { status: 409 })
      }
    }
    return NextResponse.json({ requestId: result.requestId, qrDataUrl: result.qrDataUrl, upiUri: result.uri, amountPaise: result.amountPaise }, { status: 201 })
  } catch (err) {
    console.error('[patient-portal] create UPI request failed:', err instanceof Error ? err.name : 'unknown')
    return NextResponse.json({ error: 'Could not start the payment. Please try again.' }, { status: 500 })
  }
}
