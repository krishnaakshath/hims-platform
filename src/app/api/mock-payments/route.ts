import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { createMockPayment } from '@/lib/queries/mock-payments'

// SAFETY: `cardNumber` and `cvc` exist only to run the fake Luhn check inside
// createMockPayment() -- neither is ever written to the database, logged, or
// echoed back in the response. `cvc` isn't even read past validating its
// shape; it plays no role in the (fake) success/failure decision, exactly
// like a real payment form's CVC would never be persisted by a PCI-compliant
// integration -- except here there is no real integration at all. See the
// plan's Global Constraints "Mock-payment safety rule".
const mockPaymentSchema = z.object({
  patientId: z.string().min(1),
  chargeId: z.number().int().positive().nullable(),
  amountCents: z.number().int().positive(),
  cardNumber: z.string().min(12).max(19),
  expMonth: z.number().int().min(1).max(12),
  expYear: z.number().int().min(2024).max(2099),
  cvc: z.string().min(3).max(4),
}).strict()

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session

  // Matches /billing/pay's own page-level gate (VirtualCardPaymentForm's
  // only POST target) -- admin/crc/billing, NOT frontdesk (LeftNav.tsx's
  // BILLING_ROLES; frontdesk has no billing access at all).
  if (!['admin', 'crc', 'billing'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const parsed = mockPaymentSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payment payload', details: parsed.error.flatten() }, { status: 400 })

  const payment = await createMockPayment({
    patientId: parsed.data.patientId,
    chargeId: parsed.data.chargeId,
    amountCents: parsed.data.amountCents,
    cardNumber: parsed.data.cardNumber,
    expMonth: parsed.data.expMonth,
    expYear: parsed.data.expYear,
  })
  await logAudit(session, `recorded mock payment (${payment.result}) — DEMO ONLY, no real transaction processed`, parsed.data.patientId)
  return NextResponse.json({ id: payment.id, result: payment.result, cardLast4: payment.cardLast4 }, { status: 201 })
}
