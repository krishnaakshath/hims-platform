// SP5 lab order lifecycle: sample-ID allocation and every order transition after the doctor's
// order (walk-in collect, receive by sample ID, result entry/amendment by staff or the LIS,
// verification by someone other than the enterer, cancel).
//
// Every write is ONE transaction with its audit row on the same `tx`. Transitions are decided
// by the pure machine in src/lib/labs/status.ts; an illegal move is an `invalid_status` result
// (the routes map it to a fixed 409 message).
//
// Lock order (never reverse it; deadlocks/serialization failures surface as 40P01/40001, which
// the routes map to 409 via isRetryableConflict):
//   1. lab_requisitions row (not taken here)
//   2. lab_orders rows, `for update`, by ascending id
//   3. the per-IST-date sample-sequence advisory lock (allocateSampleId)
//   4. home_collection_visits row, `for update` (cancelLabOrder only)
//   5. the patient billing lock, then the order's charge line `for update` (cancelLabOrder only, WS2 T10)
// WS2 T10: a visit cancel (transitionEncounter) cancels the visit's pending orders through
// cancelLabOrderInTx, locking in the order follow-up -> encounter -> lab orders -> home visits ->
// billing. The encounter comes first, and the order and home-visit rows are taken before the
// billing lock, so it never waits on a row while holding the billing lock. No path in this file
// locks an encounter.
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { chargeLines, homeCollectionVisits, labOrders, labResults, patients, type LabOrderRow } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { istDateOf } from '@/lib/india-time'
import { formatSampleId, parseSampleId } from '@/lib/labs/sample-id'
import { canTransitionLabOrder, type LabOrderStatus } from '@/lib/labs/status'
import { isAnalyteResultRequest, type LabResultRequest } from '@/lib/labs/validation'
import { logIntegrationEvent } from '@/lib/patient-portal-audit'
import type { WriteExecutor } from '@/lib/queries/executor'
import { lockPatientBilling } from '@/lib/queries/charge-capture' // WS2 T10
// WS4 T9
import type { LabResultFlag } from '@/lib/labs/analytes'
import { loadActiveAnalytesForTest } from '@/lib/queries/lab-analytes'
import { evaluateAnalyteEntries, writeAnalyteResults, type AnalyteEntryError } from '@/lib/queries/lab-result-values'
// end WS4 T9

export type LabActor = { kind: 'staff'; session: Session } | { kind: 'lis' }

/** Name stamped on receipt and result rows written by the LIS webhook. */
export const LIS_ACTOR_NAME = 'System (LIS API)'

function rowsOf<T>(res: unknown): T[] {
  return (Array.isArray(res) ? res : (res as { rows: unknown[] }).rows) as T[]
}

/**
 * Next sample ID for an IST date. Must run inside a transaction: the advisory lock is held
 * until that transaction ends, so a concurrent allocation for the same date waits and then
 * sees this one's row. The caller writes the returned triple onto its lab_orders row.
 */
export async function allocateSampleId(ex: WriteExecutor, dateIso: string): Promise<{ sampleId: string; sampleDate: string; sampleSeq: number }> {
  const key = `lab_orders.sample_seq:${dateIso}`
  await ex.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`)
  const res = await ex.execute(sql`select coalesce(max(${labOrders.sampleSeq}), 0) + 1 as seq from ${labOrders} where ${labOrders.sampleDate} = ${dateIso}`)
  const sampleSeq = Number(rowsOf<{ seq: string | number }>(res)[0].seq)
  return { sampleId: formatSampleId(dateIso, sampleSeq), sampleDate: dateIso, sampleSeq }
}

/**
 * Sample IDs for the given orders: rows that already have one keep it (never re-allocated);
 * the rest get one for the IST date of `now`. Locks the rows (ascending id) first.
 */
export async function ensureSampleIds(ex: WriteExecutor, orderIds: number[], now: Date): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  if (orderIds.length === 0) return out
  const rows = await ex
    .select({ id: labOrders.id, sampleId: labOrders.sampleId })
    .from(labOrders)
    .where(inArray(labOrders.id, orderIds))
    .orderBy(asc(labOrders.id))
    .for('update')
  const dateIso = istDateOf(now)
  for (const r of rows) {
    if (r.sampleId !== null) {
      out.set(r.id, r.sampleId)
      continue
    }
    const alloc = await allocateSampleId(ex, dateIso)
    await ex.update(labOrders).set(alloc).where(eq(labOrders.id, r.id))
    out.set(r.id, alloc.sampleId)
  }
  return out
}

export async function getLabOrder(id: number, ex: Pick<WriteExecutor, 'select'> = getDb()): Promise<LabOrderRow | null> {
  const [row] = await ex.select().from(labOrders).where(eq(labOrders.id, id))
  return row ?? null
}

async function lockOrder(ex: WriteExecutor, id: number): Promise<LabOrderRow | null> {
  const [row] = await ex.select().from(labOrders).where(eq(labOrders.id, id)).for('update')
  return row ?? null
}

const RECEIVED_OR_LATER: readonly LabOrderStatus[] = ['received', 'resulted', 'verified', 'reported']

// ── Walk-in collection ──────────────────────────────────────────────────────

export type CollectLabOrderResult =
  | { ok: true; order: LabOrderRow; sampleId: string }
  | { ok: false; error: 'not_found' | 'booked_for_home' | 'invalid_status' }

export async function collectLabOrder(orderId: number, session: Session, now = new Date()): Promise<CollectLabOrderResult> {
  return getDb().transaction(async (tx) => {
    const order = await lockOrder(tx, orderId)
    if (!order) return { ok: false, error: 'not_found' } as const
    if (order.status === 'scheduled') return { ok: false, error: 'booked_for_home' } as const
    if (order.status !== 'ordered' || !canTransitionLabOrder(order.status, 'collected')) return { ok: false, error: 'invalid_status' } as const

    const sampleId = (await ensureSampleIds(tx, [orderId], now)).get(orderId)!
    const [updated] = await tx
      .update(labOrders)
      .set({ status: 'collected', collectedAt: now, collectedByName: session.name, statusChangedAt: now })
      .where(eq(labOrders.id, orderId))
      .returning()
    await logAudit(session, 'marked lab order collected', order.patientId, `order=${orderId} sample=${sampleId}`, tx)
    return { ok: true, order: updated, sampleId } as const
  })
}

// ── Receive at the lab bench, by scanned/typed sample ID ───────────────────

export type ReceiveLabSampleResult =
  | { ok: true; order: LabOrderRow }
  | { ok: false; error: 'invalid_sample_id' | 'not_found' | 'already_received' | 'invalid_status' }

export async function receiveLabSample(sampleIdInput: string, session: Session, now = new Date()): Promise<ReceiveLabSampleResult> {
  const parsed = parseSampleId(sampleIdInput)
  if (!parsed) return { ok: false, error: 'invalid_sample_id' }
  return getDb().transaction(async (tx) => {
    const [order] = await tx.select().from(labOrders).where(eq(labOrders.sampleId, parsed.canonical)).for('update')
    if (!order) return { ok: false, error: 'not_found' } as const
    if (RECEIVED_OR_LATER.includes(order.status)) return { ok: false, error: 'already_received' } as const
    if (!canTransitionLabOrder(order.status, 'received')) return { ok: false, error: 'invalid_status' } as const

    const [updated] = await tx
      .update(labOrders)
      .set({ status: 'received', receivedAt: now, receivedByName: session.name, statusChangedAt: now })
      .where(eq(labOrders.id, order.id))
      .returning()
    await logAudit(session, 'received lab sample', order.patientId, `order=${order.id} sample=${parsed.canonical}`, tx)
    return { ok: true, order: updated } as const
  })
}

// ── Result entry / amendment (staff or LIS) ────────────────────────────────

export type RecordLabResultResult =
  | { ok: true; patientId: string; amended: boolean; flag: LabResultFlag }
  | { ok: false; error: 'not_found' | 'patient_mismatch' | 'invalid_status' }
  | { ok: false; error: AnalyteEntryError; analyteId?: number } // WS4 T9

/**
 * Staff: `received` → insert, `resulted` → amend. LIS: additionally `collected`, which first
 * stamps receipt as the LIS (Ruling 4). Anything else (incl. verified/reported: corrections after
 * verification are out of scope) is `invalid_status`. `expectedPatientId` (the webhook's patient
 * binding) is checked before any write.
 *
 * WS4 T9: a test with active analytes takes a per-analyte body only (a single value is
 * `analytes_required`, so the LIS webhook is refused too); the summary row is derived from the
 * values (spec 3.3 item 18). A per-analyte body to a test without analytes is `analyte_unknown`.
 * Every refusal is decided before the first write.
 */
export async function recordLabResult(
  orderId: number,
  input: LabResultRequest,
  actor: LabActor,
  opts: { expectedPatientId?: string; now?: Date } = {},
): Promise<RecordLabResultResult> {
  const now = opts.now ?? new Date()
  return getDb().transaction(async (tx): Promise<RecordLabResultResult> => {
    const order = await lockOrder(tx, orderId)
    if (!order) return { ok: false, error: 'not_found' } as const
    if (opts.expectedPatientId !== undefined && order.patientId !== opts.expectedPatientId) return { ok: false, error: 'patient_mismatch' } as const

    const lis = actor.kind === 'lis'
    const amended = order.status === 'resulted'
    const lisReceipt = lis && order.status === 'collected'
    const fromStatus: LabOrderStatus = lisReceipt ? 'received' : order.status
    if (lisReceipt && !canTransitionLabOrder('collected', 'received')) return { ok: false, error: 'invalid_status' } as const
    if (!amended && !canTransitionLabOrder(fromStatus, 'resulted')) return { ok: false, error: 'invalid_status' } as const

    // WS4 T9: per-analyte tests. Age on the collection date, else the result date (IST).
    const defs = await loadActiveAnalytesForTest(tx, order.labTestId)
    const perAnalyte = isAnalyteResultRequest(input)
    if (defs.length > 0 && !perAnalyte) return { ok: false, error: 'analytes_required' } as const
    if (defs.length === 0 && perAnalyte) return { ok: false, error: 'analyte_unknown' } as const
    let analyteInput: { patient: { dob: string; gender: string | null }; onDate: string } | null = null
    let summary: { value: string; unit: string | null; referenceRange: string | null; flag: LabResultFlag }
    if (perAnalyte) {
      const [patient] = await tx.select({ dob: patients.dob, gender: patients.gender }).from(patients).where(eq(patients.id, order.patientId))
      analyteInput = { patient: { dob: patient.dob, gender: patient.gender }, onDate: istDateOf(order.collectedAt ?? now) }
      const ev = evaluateAnalyteEntries({ ...analyteInput, defs, entries: input.analytes })
      if (!ev.ok) return ev
      summary = ev.summary
    } else {
      summary = { value: input.value, unit: input.unit ?? null, referenceRange: input.referenceRange ?? null, flag: input.flag }
    }
    // end WS4 T9

    const resultedByName = lis ? LIS_ACTOR_NAME : actor.session.name
    const resultedByUserId = lis ? null : actor.session.userId
    const fields = {
      value: summary.value,
      unit: summary.unit,
      referenceRange: summary.referenceRange,
      flag: summary.flag,
      notes: input.notes ?? null,
      resultedByName,
      resultedByUserId,
    }

    let labResultId: number
    if (amended) {
      // A legacy `resulted` order should always have its row; upsert covers one that does not.
      const [row] = await tx
        .insert(labResults)
        .values({ labOrderId: orderId, ...fields, resultedAt: now, amendedAt: now })
        .onConflictDoUpdate({ target: labResults.labOrderId, set: { ...fields, amendedAt: now } })
        .returning({ id: labResults.id })
      labResultId = row.id
    } else {
      const [row] = await tx
        .insert(labResults)
        .values({ labOrderId: orderId, ...fields, resultedAt: now })
        .onConflictDoUpdate({ target: labResults.labOrderId, set: { ...fields, resultedAt: now, amendedAt: null } })
        .returning({ id: labResults.id })
      labResultId = row.id
      await tx
        .update(labOrders)
        .set({
          status: 'resulted',
          statusChangedAt: now,
          ...(lisReceipt ? { receivedAt: now, receivedByName: LIS_ACTOR_NAME } : {}),
        })
        .where(eq(labOrders.id, orderId))
    }

    // WS4 T9: the values (already validated above, so this cannot refuse).
    if (perAnalyte && analyteInput) {
      const written = await writeAnalyteResults(tx, { orderId, labResultId, ...analyteInput, defs, entries: input.analytes })
      if (!written.ok) throw new Error('analyte entries changed between validation and write')
    }

    if (lis) await logIntegrationEvent(`accepted LIS lab result for order ${orderId}`, order.patientId, undefined, tx)
    else await logAudit(actor.session, amended ? 'amended lab result' : 'entered lab result', order.patientId, `order=${orderId}`, tx)
    return { ok: true, patientId: order.patientId, amended, flag: summary.flag } as const
  })
}

// ── Verification (never by the person who entered the result) ─────────────

export type VerifyLabResultResult =
  | { ok: true; order: LabOrderRow }
  | { ok: false; error: 'not_found' | 'invalid_status' | 'self_verification' }

export async function verifyLabResult(orderId: number, session: Session, now = new Date()): Promise<VerifyLabResultResult> {
  return getDb().transaction(async (tx) => {
    const order = await lockOrder(tx, orderId)
    if (!order) return { ok: false, error: 'not_found' } as const
    if (!canTransitionLabOrder(order.status, 'verified')) return { ok: false, error: 'invalid_status' } as const
    // The result row only changes under the order lock taken above.
    const [result] = await tx.select({ resultedByUserId: labResults.resultedByUserId }).from(labResults).where(eq(labResults.labOrderId, orderId))
    if (!result) return { ok: false, error: 'invalid_status' } as const
    if (session.userId !== null && result.resultedByUserId === session.userId) return { ok: false, error: 'self_verification' } as const

    const [updated] = await tx
      .update(labOrders)
      .set({ status: 'verified', verifiedAt: now, verifiedByName: session.name, verifiedByUserId: session.userId, statusChangedAt: now })
      .where(eq(labOrders.id, orderId))
      .returning()
    await logAudit(session, 'verified lab result', order.patientId, `order=${orderId}`, tx)
    return { ok: true, order: updated } as const
  })
}

// ── Cancel ──────────────────────────────────────────────────────────────────

/** WS2 T10: what cancelling did to the order's charge line. */
export type LabOrderCancelBilling = 'voided' | 'none' | 'credit_note_needed'

export type CancelLabOrderResult =
  | { ok: true; patientId: string; cancelledVisitId: number | null; billing: LabOrderCancelBilling }
  | { ok: false; error: 'not_found' | 'not_cancellable' }

/**
 * Cancels an order that has no result yet. A `scheduled` order leaves its home visit; if that
 * visit then has no `scheduled` order left it is cancelled too ('tests_cancelled'), in the same
 * transaction. The order row is updated BEFORE the visit lock is taken, so of two concurrent
 * cancels of a visit's last two orders the second to get the visit lock sees the first's
 * committed change and cancels the visit. The free-text reason is stored, never audited.
 */
export async function cancelLabOrder(orderId: number, reason: string, session: Session, now = new Date()): Promise<CancelLabOrderResult> {
  return getDb().transaction((tx) => cancelLabOrderInTx(tx, orderId, reason, session, now))
}

/**
 * The body of cancelLabOrder on the caller's transaction (WS2 T10: a visit cancel cancels its
 * pending orders this way). Same lock order: the order row, its home visit, the billing lock.
 */
export async function cancelLabOrderInTx(tx: WriteExecutor, orderId: number, reason: string, session: Session, now: Date): Promise<CancelLabOrderResult> {
  const order = await lockOrder(tx, orderId)
  if (!order) return { ok: false, error: 'not_found' } as const
  if (!canTransitionLabOrder(order.status, 'cancelled')) return { ok: false, error: 'not_cancellable' } as const

  await tx
    .update(labOrders)
    .set({ status: 'cancelled', cancelledAt: now, cancelledByName: session.name, cancelReason: reason.trim(), homeCollectionVisitId: null, statusChangedAt: now })
    .where(eq(labOrders.id, orderId))

  let cancelledVisitId: number | null = null
  const visitId = order.homeCollectionVisitId
  if (order.status === 'scheduled' && visitId !== null) {
    const [visit] = await tx.select({ id: homeCollectionVisits.id, status: homeCollectionVisits.status }).from(homeCollectionVisits).where(eq(homeCollectionVisits.id, visitId)).for('update')
    if (visit && visit.status === 'booked') {
      const [left] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(labOrders)
        .where(and(eq(labOrders.homeCollectionVisitId, visitId), eq(labOrders.status, 'scheduled')))
      if (Number(left.n) === 0) {
        await tx
          .update(homeCollectionVisits)
          .set({ status: 'cancelled', cancelledAt: now, cancelledByName: session.name, cancelReason: 'tests_cancelled', updatedAt: now })
          .where(eq(homeCollectionVisits.id, visitId))
        cancelledVisitId = visitId
      }
    }
  }

  await logAudit(session, 'cancelled lab order', order.patientId, `order=${orderId}${cancelledVisitId !== null ? ` visit=${cancelledVisitId}` : ''}`, tx)
  const billing = await voidOrderLineInTx(tx, orderId, order.patientId, session, now)
  return { ok: true, patientId: order.patientId, cancelledVisitId, billing } as const
}

const ORDER_CANCELLED_REASON = 'Lab order cancelled'

/**
 * WS2 T10 (spec ruling 6): a cancelled order's line is voided (a draft invoice loses it, the SP4
 * void rule). A line on a finalised invoice is never touched: the cancel still succeeds and the
 * caller is told a credit note is needed. No line, or an already void one: 'none'.
 */
async function voidOrderLineInTx(tx: WriteExecutor, orderId: number, patientId: string, session: Session, now: Date): Promise<LabOrderCancelBilling> {
  await lockPatientBilling(tx, patientId)
  const [line] = await tx.select({ id: chargeLines.id, status: chargeLines.status }).from(chargeLines)
    .where(eq(chargeLines.labOrderId, orderId)).for('update')
  if (!line || line.status === 'void') return 'none'
  if (line.status === 'invoiced') return 'credit_note_needed'
  await tx.update(chargeLines).set({ status: 'void', voidReason: ORDER_CANCELLED_REASON, voidedAt: now, voidedByName: session.name, invoiceId: null })
    .where(eq(chargeLines.id, line.id))
  await logAudit(session, 'billing: voided charge line', patientId, `line=${line.id} order=${orderId} cause=order_cancelled`, tx)
  return 'voided'
}
