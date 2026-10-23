// WS5 T3: goods received notes. One transaction per GRN: the GRN row (numbered through the
// gapless document counter), one batch insert or top-up per line, the per-drug totals and the
// audit row. Any refusal rolls everything back, including the GRN number.
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { medicationBatches, medicationInventory, medications, pharmacyGrns } from '@/db/schema'
import type { Session } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { financialYearOf } from '@/lib/billing/numbering'
import { todayIsoIn } from '@/lib/india-time'
import { allocateDocumentNumber, SeriesExhaustedError } from './document-numbers'
import { OpeningBatchWrittenOffError, reconcileUnbatchedStock, syncInventoryTotal } from './medication-batches'

export interface GrnLineInput {
  medicationId: number
  batchNo: string
  expiryDate: string
  quantity: number
  mrpPerUnitPaise: number
  purchaseRatePaise: number
}

export interface GrnInput {
  supplierName: string
  supplierInvoiceNo: string
  supplierInvoiceDate: string
  lines: GrnLineInput[]
}

export type GrnError = 'unknown_medication' | 'expired_on_receipt' | 'batch_conflict' | 'opening_batch_written_off' | 'series_exhausted'
export type ReceiveGrnResult = { ok: true; grnId: number; grnNumber: string } | { ok: false; error: GrnError }

export interface GrnListItem {
  id: number
  grnNumber: string
  supplierName: string
  supplierInvoiceNo: string
  receivedAt: Date
  totalPaise: number
  lineCount: number
}

class GrnRefusal extends Error {
  constructor(readonly code: GrnError) {
    super(code)
    this.name = 'GrnRefusal'
  }
}

export function grnTotalPaise(lines: Pick<GrnLineInput, 'quantity' | 'purchaseRatePaise'>[]): number {
  return lines.reduce((s, l) => s + l.quantity * l.purchaseRatePaise, 0)
}

export async function receiveGrn(input: GrnInput, session: Session): Promise<ReceiveGrnResult> {
  const today = todayIsoIn()
  // A batch expiring today or earlier is never received (IST business date).
  if (input.lines.some((l) => l.expiryDate <= today)) return { ok: false, error: 'expired_on_receipt' }

  try {
    return await getDb().transaction(async (tx) => {
      // Ascending ids: every GRN locks inventory rows in the same order, so two GRNs never deadlock.
      const medicationIds = [...new Set(input.lines.map((l) => l.medicationId))].sort((a, b) => a - b)
      const known = await tx.select({ id: medications.id }).from(medications).where(inArray(medications.id, medicationIds))
      if (known.length !== medicationIds.length) throw new GrnRefusal('unknown_medication')

      // Stock on hand with no batch behind it (or batches above it) is squared up first, so the
      // syncInventoryTotal below neither drops nor inflates it (ruling R7).
      for (const medicationId of medicationIds) await reconcileUnbatchedStock(tx, medicationId)

      const grnNumber = await allocateDocumentNumber(tx, 'grn', financialYearOf(today))
      const [grn] = await tx.insert(pharmacyGrns).values({
        grnNumber,
        supplierName: input.supplierName,
        supplierInvoiceNo: input.supplierInvoiceNo,
        supplierInvoiceDate: input.supplierInvoiceDate,
        receivedByName: session.name,
        totalPaise: grnTotalPaise(input.lines),
        lineCount: input.lines.length,
      }).returning({ id: pharmacyGrns.id })

      for (const line of input.lines) {
        const inserted = await tx.insert(medicationBatches).values({
          medicationId: line.medicationId,
          batchNo: line.batchNo,
          expiryDate: line.expiryDate,
          mrpPerUnitPaise: line.mrpPerUnitPaise,
          purchaseRatePaise: line.purchaseRatePaise,
          quantityOnHand: line.quantity,
          grnId: grn.id,
        }).onConflictDoNothing({ target: [medicationBatches.medicationId, medicationBatches.batchNo] })
          .returning({ id: medicationBatches.id })
        if (inserted.length > 0) continue

        // The batch is already on file: top it up only when it is the same batch (same expiry and
        // MRP) and still in stock (not written off).
        const [existing] = await tx.select().from(medicationBatches)
          .where(and(eq(medicationBatches.medicationId, line.medicationId), eq(medicationBatches.batchNo, line.batchNo)))
          .for('update')
        if (existing.expiryDate !== line.expiryDate || existing.mrpPerUnitPaise !== line.mrpPerUnitPaise || existing.writtenOffAt !== null) {
          throw new GrnRefusal('batch_conflict')
        }
        await tx.update(medicationBatches)
          .set({ quantityOnHand: sql`${medicationBatches.quantityOnHand} + ${line.quantity}` })
          .where(eq(medicationBatches.id, existing.id))
      }

      for (const medicationId of medicationIds) {
        // A drug created outside the catalog form may have no inventory row yet.
        await tx.insert(medicationInventory).values({ medicationId, quantityOnHand: 0 }).onConflictDoNothing({ target: medicationInventory.medicationId })
        await syncInventoryTotal(tx, medicationId)
      }

      await logAudit(session, 'pharmacy: received GRN', null, `grn=${grn.id} lines=${input.lines.length}`, tx)
      return { ok: true as const, grnId: grn.id, grnNumber }
    })
  } catch (err) {
    if (err instanceof GrnRefusal) return { ok: false, error: err.code }
    if (err instanceof OpeningBatchWrittenOffError) return { ok: false, error: 'opening_batch_written_off' }
    if (err instanceof SeriesExhaustedError) return { ok: false, error: 'series_exhausted' }
    throw err
  }
}

export async function listGrns(limit = 50): Promise<GrnListItem[]> {
  return getDb().select({
    id: pharmacyGrns.id,
    grnNumber: pharmacyGrns.grnNumber,
    supplierName: pharmacyGrns.supplierName,
    supplierInvoiceNo: pharmacyGrns.supplierInvoiceNo,
    receivedAt: pharmacyGrns.receivedAt,
    totalPaise: pharmacyGrns.totalPaise,
    lineCount: pharmacyGrns.lineCount,
  }).from(pharmacyGrns).orderBy(desc(pharmacyGrns.receivedAt), desc(pharmacyGrns.id)).limit(limit)
}
