// WS3 T5: discharge dues for one admission and billing's clearance (spec 3.2 item 13). The IPD
// billing-clearance gate is the only discharge dues gate in the product. Reads run on the caller's
// executor, so dischargeAdmission computes the dues inside its own transaction.
import { and, desc, eq, inArray, ne } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { admissionDuesClearances, admissions, chargeLines, invoices, patientPayments, preauths, type AdmissionDuesClearanceRow } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { sumPaise } from '@/lib/billing/amounts'
import { admissionDepositPaise } from '@/lib/billing/ledger'
import { planRoomRentDays } from '@/lib/billing/room-rent'
import { computeDischargeDues, type DischargeDues } from '@/lib/inpatient/dues'
import { lockPatientBilling } from './billing-lock'
import type { WriteExecutor } from './executor'
import { loadLedgerEntries } from './patient-ledger'

export type ClearanceRow = AdmissionDuesClearanceRow

export interface AdmissionDues {
  dues: DischargeDues
  /** The last census day with a live room-rent line, or null when none is posted. */
  roomRentPostedThrough: string | null
  /** Census days a discharge now would bill that have no room-rent line yet (a warning; never added here). */
  unpostedRoomRentDays: number
  latestClearance: ClearanceRow | null
}

/**
 * Statuses whose pre-auth carries an approved amount. An enhancement in flight keeps the amount
 * already approved (preauths_approved_fields requires it for these statuses).
 */
const APPROVED_PREAUTH_STATUSES = ['approved', 'enhancement_requested', 'enhancement_queried', 'enhanced'] as const

export async function loadAdmissionDues(admissionId: number, ex: WriteExecutor = getDb(), now: Date = new Date()): Promise<AdmissionDues | null> {
  const [adm] = await ex.select({ patientId: admissions.patientId, admittedAt: admissions.admittedAt, dischargedAt: admissions.dischargedAt })
    .from(admissions).where(eq(admissions.id, admissionId)).limit(1)
  if (!adm) return null

  const lines = await ex.select({
    taxablePaise: chargeLines.taxablePaise, gstRateBp: chargeLines.gstRateBp, payerId: chargeLines.payerId,
    source: chargeLines.source, serviceDate: chargeLines.serviceDate,
  }).from(chargeLines).where(and(eq(chargeLines.admissionId, admissionId), ne(chargeLines.status, 'void')))

  const netAdvancesPaise = admissionDepositPaise(await loadLedgerEntries(ex, adm.patientId), admissionId)

  const receipts = await ex.select({ amount: patientPayments.amountPaise }).from(patientPayments)
    .innerJoin(invoices, eq(invoices.id, patientPayments.invoiceId))
    .where(and(eq(patientPayments.kind, 'receipt'), eq(invoices.admissionId, admissionId)))

  const [preauth] = await ex.select({ approvedPaise: preauths.approvedPaise }).from(preauths)
    .where(and(eq(preauths.admissionId, admissionId), inArray(preauths.status, [...APPROVED_PREAUTH_STATUSES])))
    .orderBy(desc(preauths.updatedAt), desc(preauths.id)).limit(1)

  const dues = computeDischargeDues({
    lines: lines.map((l) => ({ taxablePaise: l.taxablePaise, gstRateBp: l.gstRateBp, payerId: l.payerId })),
    netAdvancesPaise,
    receiptsPaise: sumPaise(receipts.map((r) => r.amount)),
    approvedPreauthPaise: preauth?.approvedPaise ?? null,
  })

  const posted = new Set(lines.filter((l) => l.source === 'room_rent').map((l) => l.serviceDate))
  const roomRentPostedThrough = [...posted].sort().at(-1) ?? null
  // The census days a discharge at `now` would bill (the admission day always counts).
  const census = planRoomRentDays({ admittedAt: adm.admittedAt, dischargedAt: adm.dischargedAt ?? now, now, initialRoom: null, transfers: [] })
  const unpostedRoomRentDays = census.filter((d) => !posted.has(d.date)).length

  const [latestClearance] = await ex.select().from(admissionDuesClearances).where(eq(admissionDuesClearances.admissionId, admissionId))
    .orderBy(desc(admissionDuesClearances.clearedAt), desc(admissionDuesClearances.id)).limit(1)

  return { dues, roomRentPostedThrough, unpostedRoomRentDays, latestClearance: latestClearance ?? null }
}

export type RecordDuesClearanceResult =
  | { ok: true; clearance: ClearanceRow }
  | { ok: false; error: 'not_found' | 'not_admitted' | 'reason_required' }

/**
 * Billing records the dues as they stand now (append-only). Outstanding dues need an override
 * reason; zero dues need none. Takes the patient's billing lock first, then the admission row,
 * so the dues cannot change while they are being recorded. Audit carries ids and paise only.
 */
export async function recordDuesClearance(
  admissionId: number, overrideReason: string | null, session: Session, now: Date = new Date(),
): Promise<RecordDuesClearanceResult> {
  const reason = overrideReason?.trim() || null
  return getDb().transaction(async (tx): Promise<RecordDuesClearanceResult> => {
    const [pre] = await tx.select({ patientId: admissions.patientId }).from(admissions).where(eq(admissions.id, admissionId)).limit(1)
    if (!pre) return { ok: false, error: 'not_found' }
    await lockPatientBilling(tx, pre.patientId)
    const [adm] = await tx.select({ status: admissions.status }).from(admissions).where(eq(admissions.id, admissionId)).for('update')
    if (!adm) return { ok: false, error: 'not_found' }
    if (adm.status !== 'admitted') return { ok: false, error: 'not_admitted' }

    const loaded = await loadAdmissionDues(admissionId, tx, now)
    if (!loaded) return { ok: false, error: 'not_found' }
    const { dues } = loaded
    if (dues.outstandingPaise > 0 && reason === null) return { ok: false, error: 'reason_required' }

    const [clearance] = await tx.insert(admissionDuesClearances).values({
      admissionId,
      chargesPaise: dues.chargesPaise,
      paidPaise: dues.paidPaise,
      insurerSharePaise: dues.insurerSharePaise,
      outstandingPaise: dues.outstandingPaise,
      overrideReason: reason,
      clearedByName: session.name,
      clearedByUserId: session.userId,
      clearedAt: now,
    }).returning()
    await logAudit(session, 'cleared discharge dues', pre.patientId, `admission=${admissionId} outstanding=${dues.outstandingPaise}`, tx)
    return { ok: true, clearance }
  })
}
