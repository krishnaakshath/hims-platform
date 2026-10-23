// WS6 T12: POST /api/home-collections/[id]/payment/confirm -- record a door UPI payment with the
// payer's UTR through confirmUpiRequest (one receipt; a UTR already recorded is a 409 on the
// existing path). COLLECTOR_ROUTE_ROLES, behind the same door guard as the payment route, and the
// request must be one raised for this visit (its patient and the visit's door note; otherwise 404,
// as if it did not exist), and the visit must not already have a door receipt (409 already_paid).
// The UTR is never returned, logged or audited.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { COLLECTOR_ROUTE_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { todayIsoIn } from '@/lib/india-time'
import { assertCollectorVisit, checkDoorPayment, doorAlreadyPaidCheck, upiRequestOwner } from '@/lib/queries/home-collections'
import { doorPaymentNote } from '@/lib/home-collection/rules'
import { confirmUpiRequest } from '@/lib/payments/manual-upi'
import { UTR_PATTERN, normaliseUtr } from '@/lib/payments/provider'
import { errorResponse, invalidBody, labServerError, parseId, readJsonBody } from '@/lib/labs/route-responses'
import { INVALID_VISIT_ID, collectorVisitError, doorPaymentRefusalResponse, forbidden } from '@/lib/home-collection/route-responses'

const UTR_MESSAGE = 'Enter the 12-digit UTR (UPI reference) from the payer\'s app'
const confirmSchema = z.object({
  requestId: z.number().int().positive().max(2_147_483_647),
  utr: z.string().max(40).refine((v) => UTR_PATTERN.test(normaliseUtr(v)), { message: UTR_MESSAGE }),
}).strict()

const REQUEST_NOT_FOUND = 'Payment request not found'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!COLLECTOR_ROUTE_ROLES.includes(session.role)) return forbidden()

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = confirmSchema.safeParse(json.body)
  if (!parsed.success) return invalidBody(parsed.error, 'Invalid confirmation')
  const visitId = parseId((await params).id)
  if (visitId === null) return errorResponse(400, INVALID_VISIT_ID)

  try {
    const guard = await assertCollectorVisit(visitId, session, todayIsoIn())
    if (!guard.ok) return collectorVisitError(guard.error, guard.visitDate)
    const owner = await upiRequestOwner(parsed.data.requestId)
    if (!owner || owner.patientId !== guard.patientId || owner.note !== doorPaymentNote(visitId)) return errorResponse(404, REQUEST_NOT_FOUND)
    const refusal = await checkDoorPayment(visitId, guard.patientId, null)
    if (refusal) return doorPaymentRefusalResponse(refusal)

    // The pre-check above is the fast answer; the binding one runs again inside the confirm
    // transaction under the patient billing lock, so a concurrent confirm of another QR for this
    // visit cannot post a second receipt.
    const r = await confirmUpiRequest({ requestId: parsed.data.requestId, utr: parsed.data.utr }, session, undefined, { refuseUnderLock: doorAlreadyPaidCheck(visitId, guard.patientId) })
    if (!r.ok) {
      switch (r.error) {
        case 'already_paid': return doorPaymentRefusalResponse('already_paid')
        case 'request_not_found': return errorResponse(404, REQUEST_NOT_FOUND)
        case 'already_confirmed': return errorResponse(409, 'This UPI payment has already been recorded')
        case 'request_expired': return errorResponse(409, 'This UPI request has expired or was cancelled. Show a new QR.')
        case 'duplicate_utr': return errorResponse(409, 'This UTR has already been recorded')
        case 'series_exhausted': return errorResponse(409, 'The receipt number series for this financial year is full')
        default: return errorResponse(409, 'This UPI payment could not be recorded')
      }
    }
    await logAudit(session, 'took home collection payment', guard.patientId, `visit=${visitId} mode=upi request=${parsed.data.requestId} receipt=${r.receiptNumber}`)
    return NextResponse.json({ receiptNumber: r.receiptNumber }, { status: 201 })
  } catch (err) {
    return labServerError('home collection UPI confirm', err, 'Could not record the UPI payment')
  }
}
