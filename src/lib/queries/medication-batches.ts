import { getDb } from '@/db/client'
import { medicationBatches, medicationInventory } from '@/db/schema'
import { and, asc, eq, gte, isNull, sql } from 'drizzle-orm'
import type { BatchStock } from '@/lib/pharmacy/fefo'
import type { WriteExecutor } from './executor'

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
