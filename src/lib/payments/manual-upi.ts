// Foundations T11: `manual_upi_qr`, the cash desk's UPI QR. A request stores the amount and the
// hospital's VPA and returns a server-rendered QR of a standard upi://pay URI. Staff confirm it with
// the payer's UTR: one transaction marks the request confirmed (the partial unique index on
// payment_requests.utr refuses a UTR used twice, including a concurrent double-click) and posts the
// ordinary receipt through insertPaymentInTx, the same ledger write every other mode uses.
// UTRs are stored on the request and as the receipt reference, never in the audit log or console.
import QRCode from 'qrcode'
import { and, eq, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { invoices, patientPayments, paymentRequests } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { isUniqueViolation } from '@/lib/db-errors'
import { lockPatientBilling } from '@/lib/queries/charge-capture'
import { admissionIsPatients, insertPaymentInTx, patientExists, withSeriesGuard } from '@/lib/queries/patient-ledger'
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

export async function createUpiRequest(input: UpiRequestInput, session: Session): Promise<CreateUpiRequestResult> {
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
  const note = (input.note?.trim() || `Hospital payment ${input.patientId}`).slice(0, NOTE_MAX)
  const uri = upiUri(config.vpa, config.payeeName, input.amountPaise, note)
  const qrDataUrl = await QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', margin: 1, width: 240 })
  const requestId = await db.transaction(async (tx) => {
    const [row] = await tx.insert(paymentRequests).values({
      patientId: input.patientId, kind: input.kind ?? 'receipt', admissionId: input.admissionId ?? null, invoiceId: input.invoiceId ?? null,
      amountPaise: input.amountPaise, vpa: config.vpa, note, createdBy: session.name, createdByUserId: session.userId,
    }).returning({ id: paymentRequests.id })
    await logAudit(session, 'billing: created UPI payment request', input.patientId, `request=${row.id} amount=${input.amountPaise}`, tx)
    return row.id
  })
  return { ok: true, requestId, uri, qrDataUrl, vpa: config.vpa, payeeName: config.payeeName, amountPaise: input.amountPaise, note }
}

export type ConfirmUpiError = 'request_not_found' | 'already_confirmed' | 'duplicate_utr' | 'admission_mismatch' | 'invoice_not_payable' | 'series_exhausted'

class ConfirmAbort extends Error {
  constructor(readonly code: ConfirmUpiError) { super(code) }
}

/** Posts exactly one receipt for a pending request, or refuses with nothing written. */
export async function confirmUpiRequest(
  input: { requestId: number; utr: string }, session: Session, now: Date = new Date(),
): Promise<{ ok: true; receiptNumber: string; paymentId: number } | { ok: false; error: ConfirmUpiError }> {
  const utr = normaliseUtr(input.utr)
  if (!UTR_PATTERN.test(utr)) throw new Error('Invalid UTR')
  try {
    return await withSeriesGuard(() => getDb().transaction(async (tx) => {
      // Row lock: a second confirmation of the same request waits here, then sees it confirmed.
      const [req] = await tx.select().from(paymentRequests).where(eq(paymentRequests.id, input.requestId)).for('update')
      if (!req || req.status === 'cancelled') return { ok: false as const, error: 'request_not_found' as const }
      if (req.status !== 'pending') return { ok: false as const, error: 'already_confirmed' as const }
      await lockPatientBilling(tx, req.patientId)
      // The same UTR typed by hand on the cash desk as a plain UPI payment.
      const [typed] = await tx.select({ id: patientPayments.id }).from(patientPayments)
        .where(and(eq(patientPayments.mode, 'upi'), sql`upper(regexp_replace(${patientPayments.reference}, '[[:space:]-]', '', 'g')) = ${utr}`)).limit(1)
      if (typed) return { ok: false as const, error: 'duplicate_utr' as const }
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
    if (isUniqueViolation(err, 'payment_requests_utr_unique')) return { ok: false, error: 'duplicate_utr' }
    throw err
  }
}

/** The PaymentProvider view of the same two calls, for one staff session. */
export function manualUpiProvider(session: Session, clock: () => Date = () => new Date()): PaymentProvider {
  return {
    name: 'manual_upi_qr',
    async createRequest(i) {
      const r = await createUpiRequest(i, session)
      if (!r.ok) throw new PaymentProviderError(r.error)
      return { requestId: r.requestId, qrPayload: r.uri }
    },
    async recordConfirmation(i) {
      const r = await confirmUpiRequest(i, session, clock())
      if (!r.ok) throw new PaymentProviderError(r.error satisfies PaymentProviderErrorCode)
      return { receiptNo: r.receiptNumber }
    },
  }
}
