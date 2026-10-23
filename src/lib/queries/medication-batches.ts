import { getDb } from '@/db/client'
import { medicationBatches, medicationInventory } from '@/db/schema'
import { and, asc, eq, gte, isNull, sql } from 'drizzle-orm'
import { expiryMonth, isExpired, pickFefo, type BatchStock } from '@/lib/pharmacy/fefo'
import type { WriteExecutor } from './executor'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'

/** Every batch of a drug (written-off included), earliest expiry first, no-expiry last, then id. */
export async function listBatches(medicationId: number, executor: WriteExecutor = getDb()): Promise<BatchStock[]> {
  const rows = await executor
    .select({
      id: medicationBatches.id,
      batchNo: medicationBatches.batchNo,
      expiryDate: medicationBatches.expiryDate,
      quantityOnHand: medicationBatches.quantityOnHand,
      mrpPerUnitPaise: medicationBatches.mrpPerUnitPaise,
      writtenOffAt: medicationBatches.writtenOffAt,
    })
    .from(medicationBatches)
    .where(eq(medicationBatches.medicationId, medicationId))
    .orderBy(sql`${medicationBatches.expiryDate} ASC NULLS LAST`, asc(medicationBatches.id))
  return rows.map(({ writtenOffAt, ...b }) => ({ ...b, writtenOff: writtenOffAt !== null }))
}

/** Sets medication_inventory.quantity_on_hand to the sum of the drug's non-written-off batches. */
export async function syncInventoryTotal(tx: WriteExecutor, medicationId: number): Promise<void> {
  const total = tx
    .select({ s: sql<number>`COALESCE(SUM(${medicationBatches.quantityOnHand}), 0)::int` })
    .from(medicationBatches)
    .where(and(eq(medicationBatches.medicationId, medicationId), isNull(medicationBatches.writtenOffAt)))
  await tx
    .update(medicationInventory)
    .set({ quantityOnHand: sql`(${total})`, updatedAt: new Date() })
    .where(eq(medicationInventory.medicationId, medicationId))
}

/** Thrown when unbatched stock would have to go into an OPENING batch that was written off. */
export class OpeningBatchWrittenOffError extends Error {
  constructor(readonly medicationId: number) {
    super('The OPENING batch of this medication is written off; its unbatched stock cannot be placed in a batch')
    this.name = 'OpeningBatchWrittenOffError'
  }
}

/**
 * WS5 T3 (ruling R7): makes the drug's live batches add up to medication_inventory.quantity_on_hand
 * before anything recomputes the total from batches. Stock written without a batch (catalog create
 * before batches, the seed, the base dispense path that decrements the total only) is otherwise
 * lost or inflated by syncInventoryTotal. Run inside the caller's transaction.
 *   surplus (on hand > live batches): added to the OPENING batch (created with no expiry, MRP 0,
 *     purchase rate 0); a written-off OPENING batch is never revived -> OpeningBatchWrittenOffError.
 *   deficit (on hand < live batches): taken from live batches FEFO (earliest expiry first, expired
 *     included, no expiry last, then lower id) with guarded decrements.
 * No inventory row: nothing to reconcile.
 */
export async function reconcileUnbatchedStock(tx: WriteExecutor, medicationId: number): Promise<void> {
  const [inv] = await tx.select({ quantityOnHand: medicationInventory.quantityOnHand }).from(medicationInventory)
    .where(eq(medicationInventory.medicationId, medicationId)).for('update')
  if (!inv) return

  const live = await tx.select({ id: medicationBatches.id, quantityOnHand: medicationBatches.quantityOnHand }).from(medicationBatches)
    .where(and(eq(medicationBatches.medicationId, medicationId), isNull(medicationBatches.writtenOffAt)))
    .orderBy(sql`${medicationBatches.expiryDate} ASC NULLS LAST`, asc(medicationBatches.id))
    .for('update')
  const batched = live.reduce((s, b) => s + b.quantityOnHand, 0)

  if (inv.quantityOnHand > batched) {
    const surplus = inv.quantityOnHand - batched
    const [opening] = await tx.select({ id: medicationBatches.id, writtenOffAt: medicationBatches.writtenOffAt }).from(medicationBatches)
      .where(and(eq(medicationBatches.medicationId, medicationId), eq(medicationBatches.batchNo, 'OPENING'))).for('update')
    if (opening?.writtenOffAt) throw new OpeningBatchWrittenOffError(medicationId)
    if (opening) {
      await tx.update(medicationBatches).set({ quantityOnHand: sql`${medicationBatches.quantityOnHand} + ${surplus}` })
        .where(eq(medicationBatches.id, opening.id))
    } else {
      await tx.insert(medicationBatches).values({
        medicationId, batchNo: 'OPENING', expiryDate: null, mrpPerUnitPaise: 0, purchaseRatePaise: 0, quantityOnHand: surplus,
      })
    }
    return
  }

  let deficit = batched - inv.quantityOnHand
  for (const b of live) {
    if (deficit === 0) break
    const take = Math.min(b.quantityOnHand, deficit)
    if (take === 0) continue
    const taken = await tx.update(medicationBatches).set({ quantityOnHand: sql`${medicationBatches.quantityOnHand} - ${take}` })
      .where(and(eq(medicationBatches.id, b.id), gte(medicationBatches.quantityOnHand, take)))
      .returning({ id: medicationBatches.id })
    if (taken.length === 0) throw new Error('Batch stock changed while reconciling')
    deficit -= take
  }
}

// WS5 T4: write-off of one batch (expired, damaged, recalled stock). The free-text note a user may
// type is not stored: medication_batches has no column for it (spec section 3) and audit details
// carry enum values and counts only.
export const WRITE_OFF_REASONS = ['expired', 'damaged', 'recalled', 'other'] as const
export type WriteOffReason = (typeof WRITE_OFF_REASONS)[number]
export type WriteOffResult =
  | { ok: true; medicationId: number; quantity: number }
  | { ok: false; error: 'not_found' | 'already_written_off' | 'opening_batch_written_off' }

/**
 * Zeroes the batch, stamps written_off_at and write_off_reason, and recomputes the drug's total,
 * in one transaction: lock and reconcile the drug's stock first (ruling R7), then re-read the
 * batch under that lock so the quantity written off is the one actually removed.
 */
export async function writeOffBatch(batchId: number, reason: WriteOffReason, session: Session): Promise<WriteOffResult> {
  const db = getDb()
  // medication_id never changes, so it can be read before the lock.
  const [target] = await db.select({ medicationId: medicationBatches.medicationId }).from(medicationBatches).where(eq(medicationBatches.id, batchId))
  if (!target) return { ok: false, error: 'not_found' }
  try {
    return await db.transaction(async (tx) => {
      await reconcileUnbatchedStock(tx, target.medicationId)
      const [batch] = await tx.select({ quantityOnHand: medicationBatches.quantityOnHand, writtenOffAt: medicationBatches.writtenOffAt })
        .from(medicationBatches).where(eq(medicationBatches.id, batchId)).for('update')
      if (batch.writtenOffAt !== null) return { ok: false as const, error: 'already_written_off' as const }
      await tx.update(medicationBatches).set({ quantityOnHand: 0, writtenOffAt: new Date(), writeOffReason: reason })
        .where(eq(medicationBatches.id, batchId))
      await syncInventoryTotal(tx, target.medicationId)
      await logAudit(session, 'pharmacy: wrote off batch', null, `batch=${batchId} qty=${batch.quantityOnHand} reason=${reason}`, tx)
      return { ok: true as const, medicationId: target.medicationId, quantity: batch.quantityOnHand }
    })
  } catch (err) {
    if (err instanceof OpeningBatchWrittenOffError) return { ok: false, error: 'opening_batch_written_off' }
    throw err
  }
}

// WS5 T5: the batches a dispense draws from.
export interface DispenseAllocation {
  batchId: number
  batchNo: string
  expiryDate: string | null
  expiryMonth: string | null
  mrpPerUnitPaise: number
  quantity: number
}
export type DispenseAllocationError = 'batch_expired' | 'insufficient_stock' | 'batch_mismatch' | 'only_expired_stock'
export type AllocateDispenseResult = { ok: true; allocations: DispenseAllocation[] } | { ok: false; error: DispenseAllocationError }

/**
 * Takes `quantity` units of a drug from its batches inside the caller's transaction: FEFO over the
 * usable batches, or only the picked `batchId`. Self-contained so any dispense transaction can call
 * it before writing its dispense rows (one per allocation).
 *   1. reconcileUnbatchedStock (ruling R7): locks the inventory row, which serialises every batch
 *      writer of this drug, and moves unbatched stock into the OPENING batch.
 *   2. Locks all the drug's batch rows FOR UPDATE in id order and reads them under the lock.
 *   3. Picked batch: another drug's (or unknown) -> batch_mismatch; written off -> insufficient_stock
 *      (it holds nothing to dispense; "expired" would misname a damaged or recalled batch);
 *      expired -> batch_expired; short of the quantity -> insufficient_stock (a picked batch never
 *      spills into another). No pick: pickFefo (insufficient_stock / only_expired_stock).
 *   4. Guarded decrement per allocation (`WHERE quantity_on_hand >= n`), then syncInventoryTotal.
 * A refusal after step 1 may leave the reconcile (and, for a guarded decrement that finds 0 rows,
 * earlier decrements) written: the caller must roll its transaction back on any `ok: false`.
 */
export async function allocateDispenseBatches(
  tx: WriteExecutor,
  input: { medicationId: number; quantity: number; batchId: number | null; todayIso: string },
): Promise<AllocateDispenseResult> {
  const { medicationId, quantity, batchId, todayIso } = input
  if (!Number.isInteger(quantity) || quantity <= 0) throw new RangeError('quantity must be a positive integer')
  await reconcileUnbatchedStock(tx, medicationId)

  const rows = await tx.select({
    id: medicationBatches.id, batchNo: medicationBatches.batchNo, expiryDate: medicationBatches.expiryDate,
    quantityOnHand: medicationBatches.quantityOnHand, mrpPerUnitPaise: medicationBatches.mrpPerUnitPaise, writtenOffAt: medicationBatches.writtenOffAt,
  }).from(medicationBatches).where(eq(medicationBatches.medicationId, medicationId)).orderBy(asc(medicationBatches.id)).for('update')
  const batches: BatchStock[] = rows.map(({ writtenOffAt, ...b }) => ({ ...b, writtenOff: writtenOffAt !== null }))

  let picked: { batchId: number; quantity: number }[]
  if (batchId !== null) {
    const chosen = batches.find((b) => b.id === batchId)
    if (!chosen) return { ok: false, error: 'batch_mismatch' }
    if (chosen.writtenOff) return { ok: false, error: 'insufficient_stock' }
    if (isExpired(chosen, todayIso)) return { ok: false, error: 'batch_expired' }
    if (chosen.quantityOnHand < quantity) return { ok: false, error: 'insufficient_stock' }
    picked = [{ batchId, quantity }]
  } else {
    const fefo = pickFefo(batches, quantity, todayIso)
    if (!fefo.ok) return fefo
    picked = fefo.allocations
  }

  const allocations: DispenseAllocation[] = []
  for (const a of picked) {
    const taken = await tx.update(medicationBatches).set({ quantityOnHand: sql`${medicationBatches.quantityOnHand} - ${a.quantity}` })
      .where(and(eq(medicationBatches.id, a.batchId), gte(medicationBatches.quantityOnHand, a.quantity)))
      .returning({ id: medicationBatches.id })
    if (taken.length === 0) return { ok: false, error: 'insufficient_stock' }
    const b = batches.find((x) => x.id === a.batchId)!
    allocations.push({
      batchId: b.id, batchNo: b.batchNo, expiryDate: b.expiryDate, expiryMonth: expiryMonth(b.expiryDate),
      mrpPerUnitPaise: b.mrpPerUnitPaise, quantity: a.quantity,
    })
  }
  await syncInventoryTotal(tx, medicationId)
  return { ok: true, allocations }
}
