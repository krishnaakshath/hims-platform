// WS2 T11: procedure orders from the doctor workspace (spec ruling 6: one line per procedure
// order, at order time). An order writes an SP6 encounter_procedures row (uncoded, the service name
// as its description) and captures its `procedure` line through the auto-charge seam in the same
// transaction. A rule block or a missing price keeps the procedure and comes back as the outcome.
//
// Lock order (the visit cancel in transitionEncounter takes the same order):
//   encounter (`for share` here, `for update` there) -> encounter_procedures rows -> patient billing lock.
// The encounter is re-read under its lock, so an order or cancel never lands on a visit that was
// closed after the route's ownership check.
import { and, asc, eq, ilike, isNull, ne, or } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '@/db/client'
import { chargeLines, departments, encounterProcedures, encounters, serviceCatalog, type EncounterRow } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { autoBillTo } from '@/lib/billing/visit-charges'
import { DEFAULT_TIMEZONE, todayIsoIn } from '@/lib/india-time'
import { resolvePrice } from '@/lib/tariff/resolve'
import { admissionFirstChargeContext, captureAutoChargeInTx, type AutoChargeOutcome } from './auto-charge'
import { lockPatientBilling } from './charge-capture'
import type { WriteExecutor } from './executor'
import { loadPricingContext } from './tariff'

export const PROCEDURE_NOTES_MAX = 300

export const orderProcedureSchema = z.object({
  serviceId: z.number().int().positive().max(2147483647),
  quantity: z.number().int().min(1).max(10).default(1),
  notes: z.string().trim().max(PROCEDURE_NOTES_MAX).optional(),
}).strict()
export type OrderProcedure = z.output<typeof orderProcedureSchema>

export interface ProcedureOption { serviceId: number; code: string; name: string; departmentName: string; pricePaise: number | null }

const OPTIONS_LIMIT = 20
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

/**
 * Active `procedure` services matching `q` (code or name, case-insensitive), at most 20, each
 * priced for this visit: the same resolver inputs as the line (its context: the active admission,
 * else the visit; payer only when the line would bill the payer; that context's department, room
 * category and ward; IST today). Null price = no rate.
 */
export async function listProcedureOptions(encounterId: number, q: string, now: Date = new Date()): Promise<ProcedureOption[]> {
  const db = getDb()
  const term = q.trim()
  const pattern = `%${escapeLike(term)}%`
  const rows = await db.select({ serviceId: serviceCatalog.id, code: serviceCatalog.code, name: serviceCatalog.name, departmentName: departments.name })
    .from(serviceCatalog).innerJoin(departments, eq(departments.id, serviceCatalog.departmentId))
    .where(and(
      eq(serviceCatalog.category, 'procedure'), eq(serviceCatalog.isActive, true),
      term === '' ? undefined : or(ilike(serviceCatalog.code, pattern), ilike(serviceCatalog.name, pattern)),
    ))
    .orderBy(asc(serviceCatalog.name), asc(serviceCatalog.id)).limit(OPTIONS_LIMIT)
  const [enc] = await db.select({ patientId: encounters.patientId }).from(encounters).where(eq(encounters.id, encounterId)).limit(1)
  const ctx = enc ? (await admissionFirstChargeContext(db, enc.patientId, encounterId))?.ctx ?? null : null
  const payerId = ctx && autoBillTo(ctx) === 'payer' ? ctx.primaryPayerId : null
  const onDate = todayIsoIn(DEFAULT_TIMEZONE, now)
  const out: ProcedureOption[] = []
  for (const r of rows) {
    const price = resolvePrice({
      serviceId: r.serviceId, payerId: payerId ?? undefined, departmentId: ctx?.departmentId ?? undefined,
      roomCategory: ctx?.roomCategoryCode ?? undefined, ward: ctx?.ward ?? undefined, onDate,
    }, await loadPricingContext(r.serviceId, db))
    out.push({ ...r, pricePaise: price.ok ? price.amountPaise : null })
  }
  return out
}

/** The encounter under a share lock (blocks a concurrent status change), and whether it is open. */
async function lockOpenEncounter(tx: WriteExecutor, encounterId: number): Promise<boolean> {
  const [e] = await tx.select({ status: encounters.status }).from(encounters).where(eq(encounters.id, encounterId)).for('share')
  return !!e && e.status !== 'completed' && e.status !== 'cancelled'
}

export type OrderProcedureResult =
  | { ok: true; procedureId: number; charge: AutoChargeOutcome }
  | { ok: false; error: 'service_not_procedure' | 'visit_closed' }

/**
 * Orders a procedure on the visit and bills it, in one transaction. The service must be an active
 * `procedure` service. Performed on IST today, by the visit's doctor. The notes are stored, never audited.
 */
export async function orderProcedure(encounter: EncounterRow, input: OrderProcedure, session: Session, now: Date = new Date()): Promise<OrderProcedureResult> {
  return getDb().transaction(async (tx): Promise<OrderProcedureResult> => {
    if (!(await lockOpenEncounter(tx, encounter.id))) return { ok: false, error: 'visit_closed' }
    const [svc] = await tx.select({ id: serviceCatalog.id, code: serviceCatalog.code, name: serviceCatalog.name, category: serviceCatalog.category, isActive: serviceCatalog.isActive })
      .from(serviceCatalog).where(eq(serviceCatalog.id, input.serviceId)).limit(1)
    if (!svc || svc.category !== 'procedure' || !svc.isActive) return { ok: false, error: 'service_not_procedure' }
    const performedOn = todayIsoIn(DEFAULT_TIMEZONE, now)
    const [row] = await tx.insert(encounterProcedures).values({
      encounterId: encounter.id,
      patientId: encounter.patientId,
      description: svc.name,
      serviceId: svc.id,
      performedOn,
      performedByProviderId: encounter.providerId,
      codingStatus: 'uncoded',
      createdByName: session.name,
      createdAt: now,
      orderNotes: input.notes ? input.notes : null,
    }).returning({ id: encounterProcedures.id })
    await logAudit(session, 'ordered procedure', encounter.patientId, `encounter=${encounter.id} procedure=${row.id} service=${svc.code} qty=${input.quantity}`, tx)
    // Final fix wave (item 4): admission-first, like lab orders and pharmacy (the patient's active
    // stay, else this visit). The visit cancel finds the line by encounter_procedure_id.
    const context = (await admissionFirstChargeContext(tx, encounter.patientId, encounter.id))?.ref ?? { encounterId: encounter.id }
    const charge = await captureAutoChargeInTx(tx, {
      context, serviceId: svc.id, quantity: input.quantity, serviceDate: performedOn,
      source: 'procedure', links: { encounterProcedureId: row.id },
    }, session, now)
    return { ok: true, procedureId: row.id, charge }
  })
}

/** What cancelling did to the procedure's charge line (the lab order cancel semantics, WS2 T10). */
export type ProcedureCancelBilling = 'voided' | 'none' | 'credit_note_needed'

export type CancelProcedureResult =
  | { ok: true; billing: ProcedureCancelBilling }
  | { ok: false; error: 'not_found' | 'already_void' | 'coded' | 'visit_closed' }

const PROCEDURE_CANCELLED_REASON = 'Procedure cancelled'

/**
 * Cancels a procedure of this visit: the SP6 soft void (voided_at/by), then its line. A coded
 * procedure is refused (the coder owns it; the doctor raises a coding query). The line is voided
 * (a draft invoice loses it); a line on a finalised invoice is never touched and the caller is
 * told a credit note is needed; no line or a void one is 'none'.
 */
export async function cancelProcedure(encounter: EncounterRow, procedureId: number, session: Session, now: Date = new Date()): Promise<CancelProcedureResult> {
  return getDb().transaction(async (tx): Promise<CancelProcedureResult> => {
    if (!(await lockOpenEncounter(tx, encounter.id))) return { ok: false, error: 'visit_closed' }
    const [p] = await tx.select({ id: encounterProcedures.id, encounterId: encounterProcedures.encounterId, voidedAt: encounterProcedures.voidedAt, codingStatus: encounterProcedures.codingStatus })
      .from(encounterProcedures).where(eq(encounterProcedures.id, procedureId)).for('update')
    if (!p || p.encounterId !== encounter.id) return { ok: false, error: 'not_found' }
    if (p.voidedAt !== null) return { ok: false, error: 'already_void' }
    if (p.codingStatus === 'coded') return { ok: false, error: 'coded' }
    await tx.update(encounterProcedures).set({ voidedAt: now, voidedByName: session.name }).where(eq(encounterProcedures.id, procedureId))
    await logAudit(session, 'cancelled procedure', encounter.patientId, `encounter=${encounter.id} procedure=${procedureId}`, tx)

    return { ok: true, billing: await voidProcedureLineInTx(tx, procedureId, encounter.patientId, session, now) }
  })
}

/**
 * The line of a procedure that was just voided (doctor cancel, or a coder removing it in SP6
 * coding), on the caller's transaction after the procedure row lock: takes the patient billing lock
 * (last), then voids the line (a draft invoice loses it). A line on a finalised invoice is never
 * touched: the result is credit_note_needed and that is audited (ids only). No line or a void one: 'none'.
 */
export async function voidProcedureLineInTx(tx: WriteExecutor, procedureId: number, patientId: string, session: Session, now: Date): Promise<ProcedureCancelBilling> {
  await lockPatientBilling(tx, patientId)
  const [line] = await tx.select({ id: chargeLines.id, status: chargeLines.status }).from(chargeLines)
    .where(eq(chargeLines.encounterProcedureId, procedureId)).for('update')
  if (!line || line.status === 'void') return 'none'
  if (line.status === 'invoiced') {
    await logAudit(session, 'billing: credit note needed', patientId, `line=${line.id} procedure=${procedureId} cause=procedure_cancelled`, tx)
    return 'credit_note_needed'
  }
  await tx.update(chargeLines).set({ status: 'void', voidReason: PROCEDURE_CANCELLED_REASON, voidedAt: now, voidedByName: session.name, invoiceId: null })
    .where(eq(chargeLines.id, line.id))
  await logAudit(session, 'billing: voided charge line', patientId, `line=${line.id} procedure=${procedureId} cause=procedure_cancelled`, tx)
  return 'voided'
}

/**
 * Under the patient billing lock (taken here, last): whether the procedure has a live line
 * (captured or invoiced). Used by SP6 coding to refuse a service change on a billed procedure.
 */
export async function procedureHasLiveLineInTx(tx: WriteExecutor, procedureId: number, patientId: string): Promise<boolean> {
  await lockPatientBilling(tx, patientId)
  const [line] = await tx.select({ id: chargeLines.id }).from(chargeLines)
    .where(and(eq(chargeLines.encounterProcedureId, procedureId), ne(chargeLines.status, 'void'))).limit(1)
  return !!line
}

/**
 * Visit cancel (transitionEncounter): soft-voids the visit's live procedures that are not coded,
 * on the caller's transaction, after the rows were locked and the lines handled. Coded procedures
 * stay (the coder owns them).
 */
export async function voidVisitProceduresInTx(tx: WriteExecutor, encounterId: number, patientId: string, procedureIds: readonly number[], session: Session, now: Date): Promise<void> {
  for (const id of procedureIds) {
    await tx.update(encounterProcedures).set({ voidedAt: now, voidedByName: session.name }).where(eq(encounterProcedures.id, id))
    await logAudit(session, 'cancelled procedure', patientId, `encounter=${encounterId} procedure=${id} cause=visit_cancelled`, tx)
  }
}

export interface EncounterProcedureRow {
  id: number
  name: string
  serviceCode: string | null
  performedOn: string
  codingStatus: 'uncoded' | 'proposed' | 'coded'
  status: 'active' | 'cancelled'
  notes: string | null
  quantity: number | null
  taxablePaise: number | null
  billing: 'billed' | 'void' | 'not_billed'
}

/** The visit's procedures (oldest first) with their line: billed (captured or invoiced), void, or not billed. */
export async function listEncounterProcedures(encounterId: number): Promise<EncounterProcedureRow[]> {
  const rows = await getDb().select({
    id: encounterProcedures.id, name: encounterProcedures.description, serviceCode: serviceCatalog.code, performedOn: encounterProcedures.performedOn,
    codingStatus: encounterProcedures.codingStatus, voidedAt: encounterProcedures.voidedAt, notes: encounterProcedures.orderNotes,
    lineStatus: chargeLines.status, quantity: chargeLines.quantity, taxablePaise: chargeLines.taxablePaise,
  }).from(encounterProcedures)
    .leftJoin(serviceCatalog, eq(serviceCatalog.id, encounterProcedures.serviceId))
    .leftJoin(chargeLines, eq(chargeLines.encounterProcedureId, encounterProcedures.id))
    .where(eq(encounterProcedures.encounterId, encounterId))
    .orderBy(asc(encounterProcedures.id))
  return rows.map((r) => ({
    id: r.id, name: r.name, serviceCode: r.serviceCode, performedOn: r.performedOn, codingStatus: r.codingStatus,
    status: r.voidedAt === null ? 'active' : 'cancelled', notes: r.notes,
    quantity: r.quantity, taxablePaise: r.taxablePaise,
    billing: r.lineStatus === null ? 'not_billed' : r.lineStatus === 'void' ? 'void' : 'billed',
  }))
}

// Exported for the visit cancel: the visit's live procedures, locked by ascending id.
export async function lockVisitProceduresInTx(tx: WriteExecutor, encounterId: number): Promise<{ id: number; codingStatus: 'uncoded' | 'proposed' | 'coded' }[]> {
  return tx.select({ id: encounterProcedures.id, codingStatus: encounterProcedures.codingStatus }).from(encounterProcedures)
    .where(and(eq(encounterProcedures.encounterId, encounterId), isNull(encounterProcedures.voidedAt)))
    .orderBy(asc(encounterProcedures.id)).for('update')
}
