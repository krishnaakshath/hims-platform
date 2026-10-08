// SP4: advances, receipts, refunds and the running patient ledger (record-keeping only, no gateway).
// Every write takes the per-patient billing lock and writes its audit row on the same transaction.
// Audit details never carry payment references or reasons.
import { and, asc, desc, eq, ilike, inArray, notExists, or, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import {
  admissions, chargeLines, charges, creditNotes, invoices, patientPayments, patients, refunds, type PatientPaymentRow,
  claims, claimSettlements, claimWriteOffs, // SP7
} from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import type { ChargeStatus } from '@/lib/charge-status'
import { paiseFromDb, sumPaise } from '@/lib/billing/amounts'
import { claimCoveredPendingPaise, splitPatientOutstanding } from '@/lib/rcm/amounts' // SP7
import { computeLedger, type LedgerEntry } from '@/lib/billing/ledger'
import { financialYearOf } from '@/lib/billing/numbering'
import type { PaymentInput, RefundInput } from '@/lib/billing/validation'
import { istDateOf } from '@/lib/india-time'
import { lockPatientBilling } from './charge-capture'
import { SeriesExhaustedError, allocateDocumentNumber } from './document-numbers'
import type { WriteExecutor } from './executor'

/** Issued documents only: finalised/cancelled invoices, credit notes, advances, receipts, refunds. */
export async function loadLedgerEntries(executor: WriteExecutor, patientId: string): Promise<LedgerEntry[]> {
  const inv = await executor.select({
    id: invoices.id, number: invoices.invoiceNumber, at: invoices.finalisedAt, amount: invoices.totalPaise, admissionId: invoices.admissionId,
  }).from(invoices).where(and(eq(invoices.patientId, patientId), inArray(invoices.status, ['finalised', 'cancelled'])))
  const cn = await executor.select({
    id: creditNotes.id, number: creditNotes.creditNoteNumber, at: creditNotes.issuedAt, amount: creditNotes.totalPaise, admissionId: invoices.admissionId,
  }).from(creditNotes).innerJoin(invoices, eq(invoices.id, creditNotes.invoiceId)).where(eq(invoices.patientId, patientId))
  const pay = await executor.select({
    id: patientPayments.id, kind: patientPayments.kind, number: patientPayments.receiptNumber, at: patientPayments.receivedAt,
    amount: patientPayments.amountPaise, admissionId: patientPayments.admissionId,
  }).from(patientPayments).where(eq(patientPayments.patientId, patientId))
  const ref = await executor.select({
    id: refunds.id, number: refunds.refundNumber, at: refunds.issuedAt, amount: refunds.amountPaise, admissionId: refunds.admissionId,
  }).from(refunds).where(eq(refunds.patientId, patientId))
  return [
    ...inv.map((r) => ({ kind: 'invoice' as const, id: r.id, number: r.number ?? '', at: r.at ?? new Date(0), amountPaise: r.amount ?? 0, admissionId: r.admissionId })),
    ...cn.map((r) => ({ kind: 'credit_note' as const, id: r.id, number: r.number, at: r.at, amountPaise: r.amount, admissionId: r.admissionId })),
    ...pay.map((r) => ({ kind: r.kind, id: r.id, number: r.number, at: r.at, amountPaise: r.amount, admissionId: r.admissionId })),
    ...ref.map((r) => ({ kind: 'refund' as const, id: r.id, number: r.number, at: r.at, amountPaise: r.amount, admissionId: r.admissionId })),
    ...(await loadClaimCredits(executor, patientId)), // SP7
  ]
}

// SP7 (ruling 5): one credit per insurer settlement row and per approved write-off of the
// patient's claims. Insurer money never enters patient_payments, so it is counted exactly once.
async function loadClaimCredits(executor: WriteExecutor, patientId: string): Promise<LedgerEntry[]> {
  const st = await executor.select({ id: claimSettlements.id, claimNumber: claims.claimNumber, at: claimSettlements.recordedAt, amount: claimSettlements.settledPaise, admissionId: claims.admissionId })
    .from(claimSettlements).innerJoin(claims, eq(claims.id, claimSettlements.claimId)).where(eq(claims.patientId, patientId))
  const wo = await executor.select({ id: claimWriteOffs.id, claimNumber: claims.claimNumber, at: claimWriteOffs.decidedAt, amount: claimWriteOffs.amountPaise, admissionId: claims.admissionId })
    .from(claimWriteOffs).innerJoin(claims, eq(claims.id, claimWriteOffs.claimId)).where(and(eq(claims.patientId, patientId), eq(claimWriteOffs.status, 'approved')))
  return [
    ...st.map((r) => ({ kind: 'insurer_settlement' as const, id: r.id, number: `${r.claimNumber}/S${r.id}`, at: r.at, amountPaise: r.amount, admissionId: r.admissionId })),
    ...wo.map((r) => ({ kind: 'write_off' as const, id: r.id, number: `${r.claimNumber}/W${r.id}`, at: r.at ?? new Date(0), amountPaise: r.amount, admissionId: r.admissionId })),
  ]
}

/** SP7: what the patient's open claims still cover (ruling 5), summed over the patient's claims. */
export async function patientCoveredPendingPaise(executor: WriteExecutor, patientId: string): Promise<number> {
  const rows = await executor.select({
    status: claims.status, claimedPaise: claims.claimedPaise, approvedPaise: claims.approvedPaise, nonRecoverableDisallowedPaise: claims.nonRecoverableDisallowedPaise,
    settledPaise: claims.settledPaise, writtenOffPaise: claims.writtenOffPaise,
  }).from(claims).where(eq(claims.patientId, patientId))
  return sumPaise(rows.map((r) => claimCoveredPendingPaise({ ...r, pendingWriteOffPaise: 0 })))
}
// end SP7

export interface LegacyChargeRow { id: number; dateOfService: string; amountPaise: number; status: ChargeStatus; legacy: true }

export async function getPatientLedger(patientId: string): Promise<{
  patient: { id: string; name: string; uhid: string | null }
  activeAdmissionId: number | null
  ledger: ReturnType<typeof computeLedger>
  unbilledPaise: number
  legacyCharges: LegacyChargeRow[]
  coveredPendingPaise: number // SP7: awaiting the insurer
  patientPayablePaise: number // SP7: outstanding less what the insurer still covers
} | null> {
  const db = getDb()
  const [patient] = await db.select({ id: patients.id, name: patients.name, uhid: patients.uhid }).from(patients).where(eq(patients.id, patientId)).limit(1)
  if (!patient) return null
  const [active] = await db.select({ id: admissions.id }).from(admissions)
    .where(and(eq(admissions.patientId, patientId), eq(admissions.status, 'admitted'))).orderBy(desc(admissions.admittedAt)).limit(1)
  const ledger = computeLedger(await loadLedgerEntries(db, patientId))
  const [unbilled] = await db.select({ total: sql<string | null>`sum(${chargeLines.taxablePaise})` }).from(chargeLines)
    .where(and(eq(chargeLines.patientId, patientId), eq(chargeLines.status, 'captured')))
  // Legacy charges (amount_cents read as paise) not already represented by a pharmacy-linked charge line.
  // Listed flagged, outside the ledger and the outstanding (ruling 3).
  const legacy = await db.select({ id: charges.id, dateOfService: charges.dateOfService, amountPaise: charges.amountCents, status: charges.status })
    .from(charges).where(and(eq(charges.patientId, patientId), notExists(
      db.select({ one: sql`1` }).from(chargeLines).where(eq(chargeLines.legacyChargeId, charges.id)),
    ))).orderBy(desc(charges.dateOfService), desc(charges.id))
  return {
    patient,
    activeAdmissionId: active?.id ?? null,
    ledger,
    unbilledPaise: paiseFromDb(unbilled?.total ?? null),
    legacyCharges: legacy.map((c) => ({ ...c, legacy: true as const })),
    ...(await (async () => { // SP7
      const covered = await patientCoveredPendingPaise(db, patientId)
      const split = splitPatientOutstanding(ledger.summary.outstandingPaise, covered)
      return { coveredPendingPaise: split.coveredPendingPaise, patientPayablePaise: split.patientPayablePaise }
    })()),
  }
}

/** Exact UHID or patient id first, then a name prefix; at most 10, named columns only. */
export async function findPatientForCashDesk(query: string): Promise<{ id: string; name: string; uhid: string | null }[]> {
  const q = query.trim()
  if (q === '') return []
  const db = getDb()
  const cols = { id: patients.id, name: patients.name, uhid: patients.uhid }
  const exact = await db.select(cols).from(patients).where(or(eq(patients.uhid, q), eq(patients.id, q))).limit(10)
  const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`)
  const byName = await db.select(cols).from(patients).where(ilike(patients.name, `${escaped}%`)).orderBy(asc(patients.name), asc(patients.id)).limit(10)
  const seen = new Set<string>()
  return [...exact, ...byName].filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true))).slice(0, 10)
}

/** A full number series rolls the whole transaction back and becomes a plain refusal. */
async function withSeriesGuard<T>(run: () => Promise<T>): Promise<T | { ok: false; error: 'series_exhausted' }> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof SeriesExhaustedError) return { ok: false, error: 'series_exhausted' }
    throw err
  }
}

/** The patient's finalised invoices, newest first, for taking a payment against one. */
export async function listPayableInvoices(patientId: string): Promise<{ id: number; invoiceNumber: string; totalPaise: number }[]> {
  const rows = await getDb().select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber, totalPaise: invoices.totalPaise }).from(invoices)
    .where(and(eq(invoices.patientId, patientId), eq(invoices.status, 'finalised'))).orderBy(desc(invoices.finalisedAt), desc(invoices.id))
  return rows.map((r) => ({ id: r.id, invoiceNumber: r.invoiceNumber ?? '', totalPaise: r.totalPaise ?? 0 }))
}

async function patientExists(patientId: string): Promise<boolean> {
  const [p] = await getDb().select({ id: patients.id }).from(patients).where(eq(patients.id, patientId)).limit(1)
  return Boolean(p)
}

async function admissionIsPatients(executor: WriteExecutor, admissionId: number, patientId: string): Promise<boolean> {
  const [a] = await executor.select({ id: admissions.id }).from(admissions).where(and(eq(admissions.id, admissionId), eq(admissions.patientId, patientId))).limit(1)
  return Boolean(a)
}

export async function recordPayment(
  input: PaymentInput, session: Session, now: Date = new Date(),
): Promise<{ ok: true; receiptNumber: string; paymentId: number } | { ok: false; error: 'patient_not_found' | 'admission_mismatch' | 'invoice_not_payable' | 'series_exhausted' }> {
  if (!(await patientExists(input.patientId))) return { ok: false, error: 'patient_not_found' }
  return withSeriesGuard(() => getDb().transaction(async (tx) => {
    await lockPatientBilling(tx, input.patientId)
    if (input.admissionId !== undefined && !(await admissionIsPatients(tx, input.admissionId, input.patientId))) {
      return { ok: false as const, error: 'admission_mismatch' as const }
    }
    if (input.invoiceId !== undefined) {
      const [inv] = await tx.select({ id: invoices.id }).from(invoices)
        .where(and(eq(invoices.id, input.invoiceId), eq(invoices.patientId, input.patientId), eq(invoices.status, 'finalised'))).limit(1)
      if (!inv) return { ok: false as const, error: 'invoice_not_payable' as const }
    }
    const receiptDate = istDateOf(now)
    const financialYear = financialYearOf(receiptDate)
    // Advances and receipts share the RCT series.
    const receiptNumber = await allocateDocumentNumber(tx, 'receipt', financialYear)
    const [row] = await tx.insert(patientPayments).values({
      receiptNumber, kind: input.kind, patientId: input.patientId, admissionId: input.admissionId ?? null, invoiceId: input.invoiceId ?? null,
      mode: input.mode, reference: input.reference?.trim() || null, amountPaise: input.amountPaise, financialYear, receiptDate,
      receivedByName: session.name, receivedByUserId: session.userId, receivedAt: now,
    }).returning({ id: patientPayments.id })
    await logAudit(session, `billing: recorded ${input.kind}`, input.patientId,
      `receipt=${receiptNumber} mode=${input.mode} amount=${input.amountPaise}`, tx)
    return { ok: true as const, receiptNumber, paymentId: row.id }
  }))
}

export async function issueRefund(
  input: RefundInput, session: Session, now: Date = new Date(),
): Promise<{ ok: true; refundNumber: string } | { ok: false; error: 'patient_not_found' | 'payment_mismatch' | 'admission_mismatch' | 'exceeds_credit' | 'series_exhausted'; creditPaise?: number }> {
  if (!(await patientExists(input.patientId))) return { ok: false, error: 'patient_not_found' }
  return withSeriesGuard(() => getDb().transaction(async (tx) => {
    await lockPatientBilling(tx, input.patientId)
    if (input.againstPaymentId !== undefined) {
      const [p] = await tx.select({ id: patientPayments.id }).from(patientPayments)
        .where(and(eq(patientPayments.id, input.againstPaymentId), eq(patientPayments.patientId, input.patientId))).limit(1)
      if (!p) return { ok: false as const, error: 'payment_mismatch' as const }
    }
    if (input.admissionId !== undefined && !(await admissionIsPatients(tx, input.admissionId, input.patientId))) {
      return { ok: false as const, error: 'admission_mismatch' as const }
    }
    // Checked under the lock, so two refunds cannot both spend the same credit.
    const creditPaise = computeLedger(await loadLedgerEntries(tx, input.patientId)).summary.creditBalancePaise
    if (input.amountPaise > creditPaise) return { ok: false as const, error: 'exceeds_credit' as const, creditPaise }
    const refundDate = istDateOf(now)
    const financialYear = financialYearOf(refundDate)
    const refundNumber = await allocateDocumentNumber(tx, 'refund', financialYear)
    await tx.insert(refunds).values({
      refundNumber, patientId: input.patientId, admissionId: input.admissionId ?? null, againstPaymentId: input.againstPaymentId ?? null,
      mode: input.mode, reference: input.reference?.trim() || null, amountPaise: input.amountPaise, reason: input.reason.trim(),
      financialYear, refundDate, issuedByName: session.name, issuedAt: now,
    })
    await logAudit(session, 'billing: issued refund', input.patientId, `refund=${refundNumber} mode=${input.mode} amount=${input.amountPaise}`, tx)
    return { ok: true as const, refundNumber }
  }))
}

export async function getReceipt(id: number): Promise<(PatientPaymentRow & { patientName: string; uhid: string | null }) | null> {
  const [row] = await getDb().select({ payment: patientPayments, patientName: patients.name, uhid: patients.uhid })
    .from(patientPayments).innerJoin(patients, eq(patients.id, patientPayments.patientId)).where(eq(patientPayments.id, id)).limit(1)
  return row ? { ...row.payment, patientName: row.patientName, uhid: row.uhid } : null
}

