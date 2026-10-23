// WS7 T8 (spec D14): the patient tells the hospital the UTR (UPI reference) of a portal payment.
// It is stored on their own portal request for the cashier to check; it never posts a receipt.
// The UTR is never echoed, logged or audited. Another patient's request is a 404.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requirePatientSession } from '@/lib/patient-session'
import { parseId, readJsonBody } from '@/lib/http'
import { reportPortalUtr } from '@/lib/payments/manual-upi'
import { UTR_PATTERN, normaliseUtr } from '@/lib/payments/provider'

const UTR_MESSAGE = 'Enter the UTR (UPI reference) shown in your UPI app, usually 12 digits'
const schema = z.object({ utr: z.string().max(40).refine((v) => UTR_PATTERN.test(normaliseUtr(v))) }).strict()
const notFound = () => NextResponse.json({ error: 'Payment request not found' }, { status: 404 })

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requirePatientSession()
  if (session instanceof NextResponse) return session

  const requestId = parseId((await params).id)
  if (requestId === null) return notFound()
  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = schema.safeParse(json.body)
  // A fixed message: zod details would carry the typed value back.
  if (!parsed.success) return NextResponse.json({ error: UTR_MESSAGE }, { status: 400 })

  try {
    const result = await reportPortalUtr(session.patientId, requestId, parsed.data.utr)
    if (!result.ok) {
      if (result.error === 'request_not_found') return notFound()
      return NextResponse.json({ error: 'This payment request has expired or was already settled. Please contact the hospital.' }, { status: 409 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[patient-portal] report UTR failed:', err instanceof Error ? err.name : 'unknown')
    return NextResponse.json({ error: 'Could not save the reference. Please try again.' }, { status: 500 })
  }
}
