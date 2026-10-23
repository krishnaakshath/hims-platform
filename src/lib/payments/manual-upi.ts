// Foundations T11: `manual_upi_qr`, the cash desk's UPI QR. A request stores the amount and the
// hospital's VPA and returns a server-rendered QR of a standard upi://pay URI. Staff confirm it with
// the payer's UTR: one transaction marks the request confirmed (the partial unique index on
// payment_requests.utr refuses a UTR used twice, including a concurrent double-click) and posts the
// ordinary receipt through insertPaymentInTx, the same ledger write every other mode uses.
// UTRs are stored on the request and as the receipt reference, never in the audit log or console.
import QRCode from 'qrcode'
import { and, desc, eq, gt, isNotNull, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { invoices, paymentRequests } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { isUniqueViolation } from '@/lib/db-errors'
import { lockPatientBilling } from '@/lib/queries/charge-capture'
import { UPI_REFERENCE_UNIQUE, admissionIsPatients, insertPaymentInTx, patientExists, upiReferenceTaken, withSeriesGuard } from '@/lib/queries/patient-ledger'
import { invoicePaidPaise } from '@/lib/queries/invoices'
import { invoiceOutstandingPaise } from '@/lib/billing/invoice-balance' // WS7 T8
import { logPatientPortalAction } from '@/lib/patient-portal-audit' // WS7 T8
import { NOTE_MAX, maskUtr, upiConfig, upiUri } from './upi'
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
  // One transaction: the default note needs the new id, and a QR that fails to render leaves no row.
  const created = await db.transaction((tx) => insertRequestWithQr(tx, config, {
    patientId: input.patientId, kind: input.kind ?? 'receipt', admissionId: input.admissionId ?? null, invoiceId: input.invoiceId ?? null,
    amountPaise: input.amountPaise, createdBy: session.name, createdByUserId: session.userId, createdAt: now,
  }, input.note, (requestId) => logAudit(session, 'billing: created UPI payment request', input.patientId, `request=${requestId} amount=${input.amountPaise}`, tx)))
  return { ok: true, ...created, vpa: config.vpa, payeeName: config.payeeName, amountPaise: input.amountPaise }
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0]
type RequestValues = Omit<typeof paymentRequests.$inferInsert, 'id' | 'vpa' | 'note'>

function renderQr(uri: string): Promise<string> {
  return QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', margin: 1, width: 240 })
}

/** The one insert + QR shared by the cash desk and the portal; `audit` runs on the same transaction. */
async function insertRequestWithQr(
  tx: Tx, config: { vpa: string; payeeName: string }, values: RequestValues, rawNote: string | undefined, audit: (requestId: number) => Promise<void>,
): Promise<{ requestId: number; note: string; uri: string; qrDataUrl: string }> {
  const fixedNote = rawNote?.trim().slice(0, NOTE_MAX)
  const [row] = await tx.insert(paymentRequests).values({ ...values, vpa: config.vpa, note: fixedNote || 'Hospital payment' }).returning({ id: paymentRequests.id })
  // The note reaches the payer's UPI app and bank statement: the request id, never the patient's id.
  const note = fixedNote || `Hospital payment #${row.id}`
  if (!fixedNote) await tx.update(paymentRequests).set({ note }).where(eq(paymentRequests.id, row.id))
  const uri = upiUri(config.vpa, config.payeeName, values.amountPaise, note)
  const qrDataUrl = await renderQr(uri)
  await audit(row.id)
  return { requestId: row.id, note, uri, qrDataUrl }
}

// WS7 T8 (spec D14): the portal's "Pay now". The patient session is the only actor: the row is
// written with source 'portal', created_by 'Patient portal' and no staff user, and audited through
// logPatientPortalAction -- no staff Session is ever made up for it. The amount is the invoice's
// outstanding balance at the time; a repeat click within the TTL reuses the pending request.
export type CreatePortalUpiRequestResult =
  | { ok: true; requestId: number; uri: string; qrDataUrl: string; amountPaise: number }
  | { ok: false; error: 'not_configured' | 'invoice_not_found' | 'already_paid' }

export const PORTAL_REQUEST_CREATED_BY = 'Patient portal'

export async function createPortalUpiRequest(patientId: string, invoiceId: number, now: Date = new Date()): Promise<CreatePortalUpiRequestResult> {
  const config = upiConfig()
  if (!config) return { ok: false, error: 'not_configured' }
  return getDb().transaction(async (tx) => {
    // Serialises with receipts and with a second click: the outstanding and the reuse check hold.
    await lockPatientBilling(tx, patientId)
    const [inv] = await tx.select({ id: invoices.id, totalPaise: invoices.totalPaise }).from(invoices)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.patientId, patientId), eq(invoices.status, 'finalised'))).limit(1)
    if (!inv) return { ok: false as const, error: 'invoice_not_found' as const }
    const outstanding = invoiceOutstandingPaise('finalised', inv.totalPaise, await invoicePaidPaise(tx, inv.id)) ?? 0
    if (outstanding <= 0) return { ok: false as const, error: 'already_paid' as const }
    const [pending] = await tx.select({ id: paymentRequests.id, vpa: paymentRequests.vpa, note: paymentRequests.note }).from(paymentRequests)
      .where(and(
        eq(paymentRequests.patientId, patientId), eq(paymentRequests.invoiceId, inv.id), eq(paymentRequests.source, 'portal'),
        eq(paymentRequests.status, 'pending'), eq(paymentRequests.amountPaise, outstanding),
        gt(paymentRequests.createdAt, new Date(now.getTime() - UPI_REQUEST_TTL_MS)),
      ))
      .orderBy(desc(paymentRequests.id)).limit(1)
    if (pending) {
      const uri = upiUri(pending.vpa, config.payeeName, outstanding, pending.note)
      return { ok: true as const, requestId: pending.id, uri, qrDataUrl: await renderQr(uri), amountPaise: outstanding }
    }
    const created = await insertRequestWithQr(tx, config, {
      patientId, kind: 'receipt', invoiceId: inv.id, amountPaise: outstanding, source: 'portal',
      createdBy: PORTAL_REQUEST_CREATED_BY, createdByUserId: null, createdAt: now,
    }, undefined, (requestId) => logPatientPortalAction('patient portal: created UPI payment request', patientId, `request=${requestId} invoice=${inv.id} amount=${outstanding}`, tx))
    return { ok: true as const, requestId: created.requestId, uri: created.uri, qrDataUrl: created.qrDataUrl, amountPaise: outstanding }
  })
}

/**
 * WS7 T8: the patient says they paid a portal request with this UTR. Stored on the request for the
 * cashier to check against the bank statement; it never posts a receipt (only confirmUpiRequest,
 * by staff, does). Another patient's request, or a cash-desk one, is not found. The audit row
 * carries the request id only, never the UTR.
 */
export async function reportPortalUtr(
  patientId: string, requestId: number, rawUtr: string, now: Date = new Date(),
): Promise<{ ok: true } | { ok: false; error: 'request_not_found' | 'not_pending' }> {
  const utr = normaliseUtr(rawUtr)
  if (!UTR_PATTERN.test(utr)) throw new Error('Invalid UTR')
  return getDb().transaction(async (tx) => {
    const [req] = await tx.select({ id: paymentRequests.id, status: paymentRequests.status, createdAt: paymentRequests.createdAt }).from(paymentRequests)
      .where(and(eq(paymentRequests.id, requestId), eq(paymentRequests.patientId, patientId), eq(paymentRequests.source, 'portal'))).for('update')
    if (!req) return { ok: false as const, error: 'request_not_found' as const }
    if (req.status !== 'pending' || now.getTime() - req.createdAt.getTime() > UPI_REQUEST_TTL_MS) return { ok: false as const, error: 'not_pending' as const }
    await tx.update(paymentRequests).set({ reportedUtr: utr, reportedAt: now }).where(eq(paymentRequests.id, req.id))
    await logPatientPortalAction('patient portal: reported UPI payment', patientId, `request=${req.id}`, tx)
    return { ok: true as const }
  })
}

/** WS7 T8: one row of the Cash Desk's pending UPI list. A reported UTR is masked; the full one never leaves the server. */
export interface PendingUpiRequestRow {
  id: number
  source: 'staff' | 'portal'
  amountPaise: number
  invoiceNumber: string | null
  createdAt: Date
  reportedUtrMasked: string | null
  reportedAt: Date | null
}

/** The patient's pending UPI requests still inside their TTL, newest first. */
export async function listPendingUpiRequests(patientId: string, now: Date = new Date()): Promise<PendingUpiRequestRow[]> {
  const rows = await getDb()
    .select({
      id: paymentRequests.id, source: paymentRequests.source, amountPaise: paymentRequests.amountPaise, invoiceNumber: invoices.invoiceNumber,
      createdAt: paymentRequests.createdAt, reportedUtr: paymentRequests.reportedUtr, reportedAt: paymentRequests.reportedAt,
    })
    .from(paymentRequests).leftJoin(invoices, eq(invoices.id, paymentRequests.invoiceId))
    .where(and(eq(paymentRequests.patientId, patientId), eq(paymentRequests.status, 'pending'), gt(paymentRequests.createdAt, new Date(now.getTime() - UPI_REQUEST_TTL_MS))))
    .orderBy(desc(paymentRequests.createdAt), desc(paymentRequests.id))
  return rows.map(({ reportedUtr, source, ...r }) => ({
    ...r, source: source === 'portal' ? 'portal' as const : 'staff' as const, amountPaise: Number(r.amountPaise),
    reportedUtrMasked: reportedUtr ? maskUtr(reportedUtr) : null,
  }))
}
// end WS7 T8

export type ConfirmUpiError = 'request_not_found' | 'already_confirmed' | 'duplicate_utr' | 'admission_mismatch' | 'invoice_not_payable' | 'series_exhausted'
  | 'request_expired' // cancelled, older than UPI_REQUEST_TTL_MS, or its invoice is already fully paid

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
      if (!req) return { ok: false as const, error: 'request_not_found' as const }
      if (req.status === 'confirmed') return { ok: false as const, error: 'already_confirmed' as const }
      if (req.status !== 'pending' || now.getTime() - req.createdAt.getTime() > UPI_REQUEST_TTL_MS) {
        return { ok: false as const, error: 'request_expired' as const }
      }
      await lockPatientBilling(tx, req.patientId)
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
      if (!r.ok) throw new PaymentProviderError(r.error satisfies PaymentProviderErrorCode)
      return { receiptNo: r.receiptNumber }
    },
  }
}

// WS8 T15: the dashboard needs-attention strip. Patient-portal UPI requests the patient has reported
// a UTR against and the cash desk has not yet confirmed, inside the same TTL the cash desk lists.
// A count only: the UTR itself never leaves this query.
export async function countReportedPortalUpiRequests(now: Date = new Date()): Promise<number> {
  const [r] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(paymentRequests)
    .where(and(
      eq(paymentRequests.source, 'portal'), eq(paymentRequests.status, 'pending'), isNotNull(paymentRequests.reportedUtr),
      gt(paymentRequests.createdAt, new Date(now.getTime() - UPI_REQUEST_TTL_MS)),
    ))
  return r?.n ?? 0
}
// end WS8 T15
