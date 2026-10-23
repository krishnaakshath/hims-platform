// WS2 T12: "Invoice all ready lines" and "Orders not billed".
//
// Why lines sit "not invoiced" (spec section 2, B5): no code path creates an invoice on its own.
// `createDraftInvoice` is reached only when a clerk ticks lines on Charge Capture (one visit or stay
// at a time), so automatic lines (registration, consultation, lab, procedure), room rent and every
// pharmacy line stay `captured` with no invoice after the visit completes or the stay ends, and the
// billing dashboard counts them as "not invoiced". This module is the fix: it finds the lines that
// are ready (spec ruling 12, src/lib/billing/ready-lines.ts), groups them by createDraftInvoice's
// rule and drafts one invoice per group. It only creates drafts: finalising (numbering) stays a
// deliberate Cash Desk / Invoice step. Each group is its own createDraftInvoice transaction (billing
// lock, line locks, readiness re-checked under the lock); a group that loses a race is reported in
// `skipped` and never fails the batch, and a repeat run finds nothing left to draft.
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { admissions, chargeLines, encounterProcedures, encounters, labOrders, labTests, medicationDispenses, medications, patients, serviceCatalog } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { groupReadyLines, type ReadyLineInput } from '@/lib/billing/ready-lines'
import { createDraftInvoice } from './invoices'
import { dispenseNotBilledSql } from './medication-dispenses' // WS2 T14
import type { WriteExecutor } from './executor'

type ReadRow = ReadyLineInput & { taxablePaise: number }

/** Captured lines on no invoice (optionally one patient's, or the given ids) with their context statuses. */
async function loadUninvoicedLines(executor: Pick<WriteExecutor, 'select'>, filter: { patientId?: string; lineIds?: number[] } = {}): Promise<ReadRow[]> {
  return executor.select({
    id: chargeLines.id, patientId: chargeLines.patientId, payerId: chargeLines.payerId,
    encounterId: chargeLines.encounterId, admissionId: chargeLines.admissionId, taxablePaise: chargeLines.taxablePaise,
    encounterType: encounters.encounterType, encounterStatus: encounters.status, admissionStatus: admissions.status,
  }).from(chargeLines)
    .leftJoin(encounters, eq(encounters.id, chargeLines.encounterId))
    .leftJoin(admissions, eq(admissions.id, chargeLines.admissionId))
    .where(and(
      eq(chargeLines.status, 'captured'), isNull(chargeLines.invoiceId),
      filter.patientId === undefined ? undefined : eq(chargeLines.patientId, filter.patientId),
      filter.lineIds === undefined ? undefined : inArray(chargeLines.id, filter.lineIds),
    ))
    .orderBy(asc(chargeLines.id))
}

export interface ReadySummary { groups: number; lines: number; taxablePaise: number; waitingLines: number }

function summarise(rows: ReadRow[]): ReadySummary {
  const { groups, waiting } = groupReadyLines(rows)
  const ready = new Set(groups.flatMap((g) => g.lineIds))
  // Integer paise; each line's taxable value is a bigint column read as a safe JS number.
  const taxablePaise = rows.filter((r) => ready.has(r.id)).reduce((s, r) => s + r.taxablePaise, 0)
  return { groups: groups.length, lines: ready.size, taxablePaise, waitingLines: waiting.length }
}

export async function previewInvoiceReady(opts: { patientId?: string } = {}): Promise<ReadySummary> {
  return summarise(await loadUninvoicedLines(getDb(), opts))
}

/** Under createDraftInvoice's billing and line locks: the group's lines are all still ready, and still one group. */
async function stillOneReadyGroup(tx: WriteExecutor, lineIds: number[]): Promise<boolean> {
  const rows = await loadUninvoicedLines(tx, { lineIds })
  if (rows.length !== lineIds.length) return false
  const { groups, waiting } = groupReadyLines(rows)
  return waiting.length === 0 && groups.length === 1 && groups[0].lineIds.length === lineIds.length
}

export async function invoiceReadyLines(session: Session, opts: { patientId?: string } = {}): Promise<{
  created: { invoiceId: number; patientId: string; lineCount: number }[]
  skipped: { patientId: string; error: 'lines_not_found' | 'lines_not_available' | 'mixed_lines' }[]
}> {
  const { groups } = groupReadyLines(await loadUninvoicedLines(getDb(), opts))
  const created: { invoiceId: number; patientId: string; lineCount: number }[] = []
  const skipped: { patientId: string; error: 'lines_not_found' | 'lines_not_available' | 'mixed_lines' }[] = []
  for (const g of groups) {
    const r = await createDraftInvoice(g.lineIds, session, { stillEligible: stillOneReadyGroup })
    if (r.ok) created.push({ invoiceId: r.invoiceId, patientId: g.patientId, lineCount: g.lineIds.length })
    else skipped.push({ patientId: g.patientId, error: r.error })
  }
  const lines = created.reduce((s, c) => s + c.lineCount, 0)
  await logAudit(session, 'billing: invoiced ready lines', opts.patientId ?? null, `invoices=${created.length} lines=${lines} skipped=${skipped.length}`)
  return { created, skipped }
}

export interface UnbilledOrder {
  kind: 'lab_order' | 'procedure' | 'dispense'
  id: number
  patientId: string
  patientName: string
  uhid: string | null
  itemName: string
  createdAt: Date
}

const UNBILLED_LIMIT = 200

/**
 * Orders with no live charge line (spec section 3, automatic charges, "never block the clinical
 * act": a blocked or unpriced automatic charge leaves the order without a line). Dispenses not
 * billed (WS2 T14, dispenseNotBilledSql). Non-cancelled lab orders, and
 * non-void procedures that name a service (a description-only coding entry is not an order). A
 * cancelled visit cancels its pending orders and soft-voids its uncoded procedures, and refuses the
 * cancel when a test was performed or a procedure is coded, so none of them appear here.
 * Newest first, at most 200.
 */
export async function listUnbilledOrders(): Promise<UnbilledOrder[]> {
  const db = getDb()
  const liveLine = (column: typeof chargeLines.labOrderId | typeof chargeLines.encounterProcedureId, id: typeof labOrders.id | typeof encounterProcedures.id) =>
    sql`not exists (select 1 from ${chargeLines} where ${column} = ${id} and ${chargeLines.status} <> 'void')`
  const [labs, procs, dispenses] = await Promise.all([
    db.select({ id: labOrders.id, patientId: labOrders.patientId, patientName: patients.name, uhid: patients.uhid, itemName: labTests.name, createdAt: labOrders.orderedAt })
      .from(labOrders).innerJoin(patients, eq(patients.id, labOrders.patientId)).innerJoin(labTests, eq(labTests.id, labOrders.labTestId))
      .where(and(ne(labOrders.status, 'cancelled'), liveLine(chargeLines.labOrderId, labOrders.id)))
      .orderBy(sql`${labOrders.orderedAt} desc`, sql`${labOrders.id} desc`).limit(UNBILLED_LIMIT),
    db.select({ id: encounterProcedures.id, patientId: encounterProcedures.patientId, patientName: patients.name, uhid: patients.uhid, itemName: serviceCatalog.name, createdAt: encounterProcedures.createdAt })
      .from(encounterProcedures).innerJoin(patients, eq(patients.id, encounterProcedures.patientId)).innerJoin(serviceCatalog, eq(serviceCatalog.id, encounterProcedures.serviceId))
      .where(and(isNull(encounterProcedures.voidedAt), liveLine(chargeLines.encounterProcedureId, encounterProcedures.id)))
      .orderBy(sql`${encounterProcedures.createdAt} desc`, sql`${encounterProcedures.id} desc`).limit(UNBILLED_LIMIT),
    // WS2 T14: dispenses not billed (WS2 T8's rule: no live line, no free-dispense reason, and no
    // pre-SP4 bill on the legacy charges table, which counts as billed).
    db.select({ id: medicationDispenses.id, patientId: medicationDispenses.patientId, patientName: patients.name, uhid: patients.uhid, itemName: medications.name, createdAt: medicationDispenses.dispensedAt })
      .from(medicationDispenses).innerJoin(patients, eq(patients.id, medicationDispenses.patientId)).innerJoin(medications, eq(medications.id, medicationDispenses.medicationId))
      .where(dispenseNotBilledSql)
      .orderBy(sql`${medicationDispenses.dispensedAt} desc`, sql`${medicationDispenses.id} desc`).limit(UNBILLED_LIMIT),
  ])
  const rows: UnbilledOrder[] = [
    ...labs.map((r) => ({ kind: 'lab_order' as const, ...r })),
    ...procs.map((r) => ({ kind: 'procedure' as const, ...r })),
    ...dispenses.map((r) => ({ kind: 'dispense' as const, ...r })),
  ]
  return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id).slice(0, UNBILLED_LIMIT)
}
