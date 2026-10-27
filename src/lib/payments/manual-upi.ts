// Foundations T11: `manual_upi_qr`, the cash desk's UPI QR. A request stores the amount and the
// hospital's VPA and returns a server-rendered QR of a standard upi://pay URI. Staff confirm it with
// the payer's UTR: one transaction marks the request confirmed (the partial unique index on
// payment_requests.utr refuses a UTR used twice, including a concurrent double-click) and posts the
// ordinary receipt through insertPaymentInTx, the same ledger write every other mode uses.
// UTRs are stored on the request and as the receipt reference, never in the audit log or console.
import QRCode from 'qrcode'
import { and, eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { invoices, paymentRequests } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { isUniqueViolation } from '@/lib/db-errors'
import { lockPatientBilling } from '@/lib/queries/charge-capture'
import { UPI_REFERENCE_UNIQUE, admissionIsPatients, insertPaymentInTx, patientExists, upiReferenceTaken, withSeriesGuard } from '@/lib/queries/patient-ledger'
import { invoicePaidPaise } from '@/lib/queries/invoices'
import type { WriteExecutor } from '@/lib/queries/executor'
import { NOTE_MAX, upiConfig, upiUri } from './upi'
import { PaymentProviderError, UTR_PATTERN, normaliseUtr, type PaymentProvider, type PaymentProviderErrorCode } from './provider'

export { upiUri, upiConfig }
export { UTR_PATTERN, normaliseUtr }

export interface UpiRequestInput {
  patientId: string
  amountPaise: number
  note?: string
  kind?: 'advance' | 'receipt'
  admissionId?: number
  invoiceId?: number
}

export type CreateUpiRequestResult =
  | { ok: true; requestId: number; uri: string; qrDataUrl: string; vpa: string; payeeName: string; amountPaise: number; note: string }
  | { ok: false; error: 'not_configured' | 'patient_not_found' | 'admission_mismatch' | 'invoice_not_payable' }

/** Foundations T11: a pending request can be confirmed for this long after it was shown. */
export const UPI_REQUEST_TTL_MS = 24 * 60 * 60 * 1000

export async function createUpiRequest(input: UpiRequestInput, session: Session, now: Date = new Date()): Promise<CreateUpiRequestResult> {
  const config = upiConfig()
  if (!config) return { ok: false, error: 'not_configured' }
  if (!(await patientExists(input.patientId))) return { ok: false, error: 'patient_not_found' }
  const db = getDb()
  if (input.admissionId !== undefined && !(await admissionIsPatients(db, input.admissionId, input.patientId))) return { ok: false, error: 'admission_mismatch' }
  if (input.invoiceId !== undefined) {
    const [inv] = await db.select({ id: invoices.id }).from(invoices)
      .where(and(eq(invoices.id, input.invoiceId), eq(invoices.patientId, input.patientId), eq(invoices.status, 'finalised'))).limit(1)
    if (!inv) return { ok: false, error: 'invoice_not_payable' }
  }
  const staffNote = input.note?.trim().slice(0, NOTE_MAX)
  // One transaction: the default note needs the new id, and a QR that fails to render leaves no row.
  const created = await db.transaction(async (tx) => {
    const [row] = await tx.insert(paymentRequests).values({
      patientId: input.patientId, kind: input.kind ?? 'receipt', admissionId: input.admissionId ?? null, invoiceId: input.invoiceId ?? null,
      amountPaise: input.amountPaise, vpa: config.vpa, note: staffNote || 'Hospital payment', createdBy: session.name, createdByUserId: session.userId,
      createdAt: now,
    }).returning({ id: paymentRequests.id })
    // The note reaches the payer's UPI app and bank statement: the request id, never the patient's id.
    const note = staffNote || `Hospital payment #${row.id}`
    if (!staffNote) await tx.update(paymentRequests).set({ note }).where(eq(paymentRequests.id, row.id))
    const uri = upiUri(config.vpa, config.payeeName, input.amountPaise, note)
    const qrDataUrl = await QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', margin: 1, width: 240 })
    await logAudit(session, 'billing: created UPI payment request', input.patientId, `request=${row.id} amount=${input.amountPaise}`, tx)
    return { requestId: row.id, note, uri, qrDataUrl }
  })
  return { ok: true, ...created, vpa: config.vpa, payeeName: config.payeeName, amountPaise: input.amountPaise }
}

export type ConfirmUpiError = 'request_not_found' | 'already_confirmed' | 'duplicate_utr' | 'admission_mismatch' | 'invoice_not_payable' | 'series_exhausted'
  | 'request_expired' // cancelled, older than UPI_REQUEST_TTL_MS, or its invoice is already fully paid

class ConfirmAbort extends Error {
  constructor(readonly code: ConfirmUpiError) { super(code) }
}

/**
 * A caller's own "already paid" rule, run inside the confirm transaction AFTER the patient billing
 * lock (pg_advisory_xact_lock keyed by the patient): two confirms for the same patient serialise
 * there, so the second sees the first's committed receipt and refuses. WS6 T12 door payments use
 * it so two QRs for one visit, confirmed at the same moment with different UTRs, post one receipt.
 */
export type ConfirmUnderLockCheck = (tx: WriteExecutor) => Promise<'already_paid' | null>

/** Posts exactly one receipt for a pending request, or refuses with nothing written. */
export async function confirmUpiRequest(
  input: { requestId: number; utr: string }, session: Session, now: Date = new Date(),
  opts: { refuseUnderLock?: ConfirmUnderLockCheck } = {},
): Promise<{ ok: true; receiptNumber: string; paymentId: number } | { ok: false; error: ConfirmUpiError | 'already_paid' }> {
  const utr = normaliseUtr(input.utr)
  if (!UTR_PATTERN.test(utr)) throw new Error('Invalid UTR')
  try {
    return await withSeriesGuard(() => getDb().transaction(async (tx) => {
      // Row lock: a second confirmation of the same request waits here, then sees it confirmed.
      const [req] = await tx.select().from(paymentRequests).where(eq(paymentRequests.id, input.requestId)).for('update')
      if (!req) return { ok: false as const, error: 'request_not_found' as const }
      if (req.status === 'confirmed') return { ok: false as const, error: 'already_confirmed' as const }
      if (req.status !== 'pending' || now.getTime() - req.createdAt.getTime() > UPI_REQUEST_TTL_MS) {
        return { ok: false as const, error: 'request_expired' as const }
      }
      await lockPatientBilling(tx, req.patientId)
      if (opts.refuseUnderLock) {
        const refusal = await opts.refuseUnderLock(tx)
        if (refusal) return { ok: false as const, error: refusal }
      }
      if (req.invoiceId !== null) {
        // Under the patient lock: another receipt may have settled the invoice since the QR was shown.
        const [inv] = await tx.select({ totalPaise: invoices.totalPaise }).from(invoices).where(eq(invoices.id, req.invoiceId)).limit(1)
        if (inv && inv.totalPaise !== null && (await invoicePaidPaise(tx, req.invoiceId)) >= inv.totalPaise) {
          return { ok: false as const, error: 'request_expired' as const }
        }
      }
      // The same UTR typed by hand as a plain UPI payment, or already on another request.
      if (await upiReferenceTaken(tx, utr)) return { ok: false as const, error: 'duplicate_utr' as const }
      // Claims the UTR first: a UTR already on another request is a 23505 here (or once the
      // concurrent holder commits), and the whole transaction rolls back.
      await tx.update(paymentRequests).set({ utr }).where(eq(paymentRequests.id, req.id))
      const payment = await insertPaymentInTx(tx, {
        patientId: req.patientId, kind: req.kind, mode: 'upi', reference: utr, amountPaise: req.amountPaise,
        ...(req.admissionId !== null ? { admissionId: req.admissionId } : {}), ...(req.invoiceId !== null ? { invoiceId: req.invoiceId } : {}),
      }, session, now)
      if (!payment.ok) throw new ConfirmAbort(payment.error)
      await tx.update(paymentRequests).set({ status: 'confirmed', paymentId: payment.paymentId, confirmedAt: now }).where(eq(paymentRequests.id, req.id))
      await logAudit(session, 'billing: confirmed UPI payment request', req.patientId, `request=${req.id} receipt=${payment.receiptNumber}`, tx)
      return payment
    }))
  } catch (err) {
    if (err instanceof ConfirmAbort) return { ok: false, error: err.code }
    if (isUniqueViolation(err, 'payment_requests_utr_unique') || isUniqueViolation(err, UPI_REFERENCE_UNIQUE)) return { ok: false, error: 'duplicate_utr' }
    throw err
  }
}

/** Foundations T11: withdraw a QR that will not be paid. Pending only; never touches the ledger. */
export async function cancelUpiRequest(requestId: number, session: Session): Promise<{ ok: true } | { ok: false; error: 'request_not_found' | 'not_pending' }> {
  return getDb().transaction(async (tx) => {
    const [row] = await tx.update(paymentRequests).set({ status: 'cancelled' })
      .where(and(eq(paymentRequests.id, requestId), eq(paymentRequests.status, 'pending'))).returning({ patientId: paymentRequests.patientId })
    if (!row) {
      const [exists] = await tx.select({ id: paymentRequests.id }).from(paymentRequests).where(eq(paymentRequests.id, requestId)).limit(1)
      return { ok: false as const, error: exists ? 'not_pending' as const : 'request_not_found' as const }
    }
    await logAudit(session, 'billing: cancelled UPI payment request', row.patientId, `request=${requestId}`, tx)
    return { ok: true as const }
  })
}

/** The PaymentProvider view of the same two calls, for one staff session. */
export function manualUpiProvider(session: Session, clock: () => Date = () => new Date()): PaymentProvider {
  return {
    name: 'manual_upi_qr',
    async createRequest(i) {
      const r = await createUpiRequest(i, session, clock())
      if (!r.ok) throw new PaymentProviderError(r.error)
      return { requestId: r.requestId, qrPayload: r.uri }
    },
    async recordConfirmation(i) {
      const r = await confirmUpiRequest(i, session, clock())
      if (!r.ok) {
        // No under-lock check is passed here, so already_paid cannot come back.
        if (r.error === 'already_paid') throw new Error('confirmUpiRequest: unexpected already_paid without a check')
        throw new PaymentProviderError(r.error satisfies PaymentProviderErrorCode)
      }
      return { receiptNo: r.receiptNumber }
    },
  }
}
