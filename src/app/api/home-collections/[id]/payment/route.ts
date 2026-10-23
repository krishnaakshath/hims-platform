// WS6 T12: POST /api/home-collections/[id]/payment -- the collector takes the patient's payment at
// the door through the one ledger (spec D8): cash posts a receipt with recordPayment; UPI shows a
// QR with createUpiRequest (the money is recorded only when confirmed with the payer's UTR, see
// ./confirm). COLLECTOR_ROUTE_ROLES, and only for a visit the session may act on today (IST):
// assertCollectorVisit (Ruling R4) gives 403 not assigned, 404 not found, 409 not due / not collectable.
// Both writes carry the note `Home collection visit #<id>`. Ruling R24: under the patient billing
// lock, a visit with a door receipt already is 409 already_paid, and an amount above the visit's
// due (the quotes of its scheduled tests) is 422 amount_exceeds_due.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { COLLECTOR_ROUTE_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { todayIsoIn } from '@/lib/india-time'
import { assertCollectorVisit, checkDoorPayment, takeDoorCashPayment } from '@/lib/queries/home-collections'
import { createUpiRequest } from '@/lib/payments/manual-upi'
import { UPI_NOT_CONFIGURED_MESSAGE } from '@/lib/payments/provider'
import { doorPaymentNote } from '@/lib/home-collection/rules'
import { errorResponse, invalidBody, labServerError, parseId, readJsonBody } from '@/lib/labs/route-responses'
import { INVALID_VISIT_ID, collectorVisitError, doorPaymentRefusalResponse, forbidden } from '@/lib/home-collection/route-responses'

const doorPaymentSchema = z.object({
  mode: z.enum(['cash', 'upi']),
  amountPaise: z.number().int().min(100).max(10_000_000),
}).strict()

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!COLLECTOR_ROUTE_ROLES.includes(session.role)) return forbidden()

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = doorPaymentSchema.safeParse(json.body)
  if (!parsed.success) return invalidBody(parsed.error, 'Enter an amount between ₹1 and ₹1,00,000, paid in cash or by UPI')
  const visitId = parseId((await params).id)
  if (visitId === null) return errorResponse(400, INVALID_VISIT_ID)
  const { mode, amountPaise } = parsed.data

  try {
    const guard = await assertCollectorVisit(visitId, session, todayIsoIn())
    if (!guard.ok) return collectorVisitError(guard.error, guard.visitDate)
    const note = doorPaymentNote(visitId)

    if (mode === 'cash') {
      const r = await takeDoorCashPayment(visitId, guard.patientId, amountPaise, session)
      if (!r.ok) {
        if (r.error === 'already_paid' || r.error === 'amount_exceeds_due') return doorPaymentRefusalResponse(r.error)
        if (r.error === 'series_exhausted') return errorResponse(409, 'The receipt number series for this financial year is full')
        return errorResponse(409, 'This payment could not be recorded')
      }
      await logAudit(session, 'took home collection payment', guard.patientId, `visit=${visitId} mode=cash receipt=${r.receiptNumber} amount=${amountPaise}`)
      return NextResponse.json({ receiptNumber: r.receiptNumber }, { status: 201 })
    }

    const refusal = await checkDoorPayment(visitId, guard.patientId, amountPaise)
    if (refusal) return doorPaymentRefusalResponse(refusal)
    const r = await createUpiRequest({ patientId: guard.patientId, amountPaise, note, kind: 'receipt' }, session)
    if (!r.ok) {
      if (r.error === 'not_configured') return errorResponse(503, UPI_NOT_CONFIGURED_MESSAGE)
      return errorResponse(404, 'Patient not found')
    }
    await logAudit(session, 'showed home collection UPI QR', guard.patientId, `visit=${visitId} request=${r.requestId} amount=${amountPaise}`)
    return NextResponse.json({ requestId: r.requestId, qrDataUrl: r.qrDataUrl, amountPaise: r.amountPaise }, { status: 201 })
  } catch (err) {
    return labServerError('home collection payment', err, 'Could not record the payment')
  }
}
