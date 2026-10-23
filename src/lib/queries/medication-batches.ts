import { getDb } from '@/db/client'
import { medicationBatches, medicationInventory } from '@/db/schema'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
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
