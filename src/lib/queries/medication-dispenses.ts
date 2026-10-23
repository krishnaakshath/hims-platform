import { getDb } from '@/db/client'
import {
  medicationDispenses, medicationEpisodes, patients, medications, charges, admissions, chargeLines, encounters, prescriptions,
} from '@/db/schema'
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm'
import { z } from 'zod'
// SP4
import { MAX_LINE_QUANTITY } from '@/lib/billing/amounts'
import { getBillingSettings } from '@/lib/queries/billing-settings'
import { lockPatientBilling } from '@/lib/queries/charge-capture'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
// WS2 T8
import { lineTax } from '@/lib/billing/gst'
import { EXPIRY_MONTH_PATTERN, expiryLabel, isExpiredMonth, pharmacyLinePrice } from '@/lib/billing/pharmacy-price'
import { allergyConflicts, type AllergyConflict } from '@/lib/prescriptions/allergy-check'
import { istDateOf } from '@/lib/india-time'
import { activeAllergies } from '@/lib/queries/prescriptions'
import { auditSelfPayFallback, untariffedAutoBillToInTx } from '@/lib/queries/auto-charge' // WS2 T14
import type { WriteExecutor } from './executor'
import { allocateDispenseBatches, OpeningBatchWrittenOffError, type DispenseAllocationError } from '@/lib/queries/medication-batches' // WS5 T5

// WS2 T8 (spec ruling 7): a dispense bills itself. A charged dispense needs a priced medicine and a
// batch/expiry snapshot; a free one needs a reason. An allergy conflict needs an acknowledgement.
export const dispenseSchema = z.object({
  patientId: z.string().min(1).max(40),
  medicationId: z.number().int().positive(),
  medicationEpisodeId: z.number().int().positive().optional(),
  quantity: z.number().int().min(1).max(1000),
  notes: z.string().trim().max(300).optional(),
  batchNo: z.string().trim().min(1).max(30).optional(),
  expiryMonth: z.string().regex(EXPIRY_MONTH_PATTERN).optional(),
  noChargeReason: z.string().trim().min(5).max(200).optional(),
  allergyAcknowledged: z.boolean().default(false),
  batchId: z.number().int().positive().optional(), // WS5 T5: a picked batch; omitted = FEFO
}).strict()
export type DispenseInput = z.input<typeof dispenseSchema>

// WS5 T5: stock refusals from the batch allocator (route: batch_mismatch 400, the rest 409).
export type DispenseRefusal = DispenseAllocationError | 'opening_batch_written_off'

export type DispenseError =
  | 'unknown_patient' | 'unknown_medication' | 'episode_mismatch'
  | 'medication_unpriced' | 'batch_required' | 'batch_expired' | 'allergy_conflict'
  | DispenseRefusal

export interface DispenseCharge { lineId: number; quantity: number; unitMrpPaise: number; totalPaise: number }

// WS5 T5: one dispense row per batch allocation (FEFO can split a dispense across batches).
export interface DispenseAllocationRow {
  dispenseId: number; batchId: number; batchNo: string; expiryMonth: string | null; quantity: number; unitMrpPaise: number | null
}

export type DispenseResult =
  | {
    ok: true
    dispenseId: number // the first of dispenseIds
    dispenseIds: number[]
    allocations: DispenseAllocationRow[]
    /** The single line when the dispense drew one batch; with several batches, the combined total (lineId = the first line). */
    charge: DispenseCharge | null
    charges: DispenseCharge[]
  }
  // stockRefusal: the refusal came from the batch allocator (a picked expired batch is 409, a typed
  // expired strip 422), so the route can tell the two batch_expired cases apart.
  | { ok: false; error: DispenseError; conflicts?: AllergyConflict[]; stockRefusal?: boolean }

/**
 * The visit or stay a pharmacy line belongs to: the patient's active admission (the SP4 rule);
 * else the OPD visit the prescription was written on, unless that visit was cancelled; else none
 * (a line with no visit or stay, which Charge Capture lists on its own). Reads only: no billing
 * path locks an encounters row.
 */
async function pharmacyLineContext(executor: WriteExecutor, patientId: string, prescriptionId: number | null): Promise<{ encounterId: number | null; admissionId: number | null }> {
  const [active] = await executor.select({ id: admissions.id }).from(admissions)
    .where(and(eq(admissions.patientId, patientId), eq(admissions.status, 'admitted'))).orderBy(desc(admissions.admittedAt)).limit(1)
  if (active) return { encounterId: null, admissionId: active.id }
  if (prescriptionId !== null) {
    const [enc] = await executor.select({ id: encounters.id, type: encounters.encounterType, status: encounters.status })
      .from(prescriptions).innerJoin(encounters, eq(encounters.id, prescriptions.encounterId))
      .where(and(eq(prescriptions.id, prescriptionId), eq(prescriptions.patientId, patientId))).limit(1)
    if (enc && enc.type === 'opd' && enc.status !== 'cancelled') return { encounterId: enc.id, admissionId: null }
  }
  return { encounterId: null, admissionId: null }
}

type MedicationForBilling = { id: number; name: string; mrpPerUnitPaise: number | null; gstRateBp: number | null; hsn: string | null }

/**
 * Inserts the one pharmacy line of a dispense, on the caller's transaction, after taking the
 * patient billing lock. Existence is checked under the lock; the unique medication_dispense_id
 * is only a backstop. Returns null when the dispense already has a line.
 */
async function insertPharmacyLine(tx: WriteExecutor, input: {
  dispenseId: number; patientId: string; quantity: number; medication: MedicationForBilling & { mrpPerUnitPaise: number }
  batchNo: string | null; expiryMonth: string | null; prescriptionId: number | null; serviceDate: string; session: Session
}): Promise<{ lineId: number; totalPaise: number } | null> {
  await lockPatientBilling(tx, input.patientId)
  const [existing] = await tx.select({ id: chargeLines.id }).from(chargeLines).where(eq(chargeLines.medicationDispenseId, input.dispenseId)).limit(1)
  if (existing) return null
  const settings = await getBillingSettings(tx)
  const gstRateBp = input.medication.gstRateBp ?? settings.pharmacyGstRateBp
  const price = pharmacyLinePrice({ mrpPerUnitPaise: input.medication.mrpPerUnitPaise, quantity: input.quantity, gstRateBp })
  const context = await pharmacyLineContext(tx, input.patientId, input.prescriptionId)
  // WS2 T14 (ruling on T8): bill-to follows the automatic-line rule (autoBillTo, pre-auth fallback).
  // Only the payer is decided there; the price stays the MRP-backed one above, never the tariff.
  // A medicine carries no pre-authorisation flag, so it does not need pre-authorisation by itself.
  const ref = context.admissionId !== null ? { admissionId: context.admissionId } : context.encounterId !== null ? { encounterId: context.encounterId } : null
  const billTo = await untariffedAutoBillToInTx(tx, ref, { requiresPreauth: false })
  // WS5 T5: a received batch with no expiry date still names its batch.
  const batch = input.batchNo === null ? '' : input.expiryMonth !== null ? ` (Batch ${input.batchNo}, Exp ${expiryLabel(input.expiryMonth)})` : ` (Batch ${input.batchNo})`
  const [line] = await tx.insert(chargeLines).values({
    patientId: input.patientId,
    encounterId: context.encounterId,
    admissionId: context.admissionId,
    source: 'pharmacy',
    priceSource: 'pharmacy',
    serviceId: null,
    itemCode: `MED-${input.medication.id}`,
    itemName: `${input.medication.name}${batch}`,
    serviceDate: input.serviceDate,
    quantity: input.quantity,
    unitPricePaise: price.unitPricePaise,
    taxablePaise: price.taxablePaise,
    gstRateBp,
    hsnSac: input.medication.hsn ?? settings.pharmacyHsn,
    medicationDispenseId: input.dispenseId,
    payerId: billTo.payerId, // WS2 T14
    createdByName: input.session.name,
    createdByUserId: input.session.userId,
  }).returning({ id: chargeLines.id })
  if (billTo.fellBack) await auditSelfPayFallback(tx, input.session, input.patientId, line.id, billTo.fellBack) // WS2 T14
  return { lineId: line.id, totalPaise: price.totalPaise }
}

// WS5 T5 + WS2 T8: stock comes out of batches. Patient, medication and episode are validated BEFORE
// the transaction so a bad id is a clean 400 and never touches stock. Inside one transaction,
// allocateDispenseBatches locks the drug's inventory row and batches, moves unbatched stock into the
// OPENING batch (ruling R7), allocates FEFO or the picked batch with guarded decrements and
// recomputes medication_inventory; then one dispense row per allocation is written with its batch
// snapshot (batch_id, batch_no, expiry_month, unit_mrp_paise) and, unless free, its own MRP-backed
// pharmacy line. Every refusal after the allocator throws so the reconcile and decrements roll back.
// Snapshot: a received batch supplies its own number, expiry and MRP; the OPENING batch (stock that
// predates GRNs: no number, no expiry, MRP 0) takes the batch and expiry typed from the strip and
// the catalogue MRP. Lock order: inventory row → batch rows → medication FOR SHARE → patient
// billing lock → line.
export async function dispenseMedication(input: DispenseInput, session: Session, now: Date = new Date()): Promise<DispenseResult> {
  const db = getDb()
  const noChargeReason = input.noChargeReason?.trim() || null
  const batchNo = input.batchNo?.trim() || null
  const expiryMonth = input.expiryMonth ?? null

  const [patient] = await db.select({ id: patients.id }).from(patients).where(eq(patients.id, input.patientId))
  if (!patient) return { ok: false, error: 'unknown_patient' }

  const [medication] = await db.select({
    id: medications.id, name: medications.name, genericName: medications.genericName, medicationClass: medications.medicationClass, mrpPerUnitPaise: medications.mrpPerUnitPaise,
  }).from(medications).where(eq(medications.id, input.medicationId))
  if (!medication) return { ok: false, error: 'unknown_medication' }

  let prescriptionId: number | null = null
  if (input.medicationEpisodeId !== undefined) {
    const [episode] = await db.select({ patientId: medicationEpisodes.patientId, prescriptionId: medicationEpisodes.prescriptionId })
      .from(medicationEpisodes).where(eq(medicationEpisodes.id, input.medicationEpisodeId))
    if (!episode || episode.patientId !== input.patientId) return { ok: false, error: 'episode_mismatch' }
    prescriptionId = episode.prescriptionId
  }

  if (expiryMonth !== null && isExpiredMonth(expiryMonth, now)) return { ok: false, error: 'batch_expired' }

  // WS1 T6 matcher against the patient's active allergies (the catalogue identity).
  const conflicts = allergyConflicts(medication, await activeAllergies(input.patientId))
  if (conflicts.length > 0 && !input.allergyAcknowledged) return { ok: false, error: 'allergy_conflict', conflicts }

  try {
    return await db.transaction(async (tx) => {
      const allocated = await allocateDispenseBatches(tx, {
        medicationId: input.medicationId, quantity: input.quantity, batchId: input.batchId ?? null, todayIso: istDateOf(now),
      })
      if (!allocated.ok) throw new DispenseRefused(allocated.error, true)

      // The price in force now, held against a concurrent price edit until this commits.
      const [priced] = await tx.select({ id: medications.id, name: medications.name, mrpPerUnitPaise: medications.mrpPerUnitPaise, gstRateBp: medications.gstRateBp, hsn: medications.hsn })
        .from(medications).where(eq(medications.id, input.medicationId)).for('share')

      const allocations: DispenseAllocationRow[] = []
      const charges: DispenseCharge[] = []
      for (const a of allocated.allocations) {
        const opening = a.batchNo === OPENING_BATCH_NO
        const rowBatchNo = opening ? batchNo : a.batchNo
        const rowExpiryMonth = opening ? expiryMonth : a.expiryMonth
        // An OPENING batch has MRP 0: fall back to the catalogue MRP.
        const unitMrpPaise = a.mrpPerUnitPaise > 0 ? a.mrpPerUnitPaise : priced.mrpPerUnitPaise
        if (noChargeReason === null) {
          if (unitMrpPaise === null) throw new DispenseRefused('medication_unpriced')
          if (rowBatchNo === null || (opening && rowExpiryMonth === null)) throw new DispenseRefused('batch_required')
        }

        const [created] = await tx.insert(medicationDispenses).values({
          patientId: input.patientId, medicationId: input.medicationId, medicationEpisodeId: input.medicationEpisodeId ?? null,
          quantity: a.quantity, dispensedByName: session.name, dispensedAt: now, notes: input.notes?.trim() || null,
          batchId: a.batchId, batchNo: rowBatchNo, expiryMonth: rowExpiryMonth, noChargeReason, unitMrpPaise,
        }).returning({ id: medicationDispenses.id })
        allocations.push({ dispenseId: created.id, batchId: a.batchId, batchNo: a.batchNo, expiryMonth: a.expiryMonth, quantity: a.quantity, unitMrpPaise })

        if (noChargeReason === null && unitMrpPaise !== null) {
          const line = await insertPharmacyLine(tx, {
            dispenseId: created.id, patientId: input.patientId, quantity: a.quantity, medication: { ...priced, mrpPerUnitPaise: unitMrpPaise },
            batchNo: rowBatchNo, expiryMonth: rowExpiryMonth, prescriptionId, serviceDate: istDateOf(now), session,
          })
          if (line) charges.push({ lineId: line.lineId, quantity: a.quantity, unitMrpPaise, totalPaise: line.totalPaise })
        }
      }

      const dispenseIds = allocations.map((a) => a.dispenseId)
      const lineIds = charges.map((c) => c.lineId)
      await logAudit(session, 'dispensed medication', input.patientId, `dispense=${dispenseIds.join(',')} line=${lineIds.length > 0 ? lineIds.join(',') : 'none'}`, tx)
      if (conflicts.length > 0) {
        await logAudit(session, 'acknowledged an allergy conflict at dispense', input.patientId, `dispense=${dispenseIds.join(',')} conflicts=${conflicts.length}`, tx)
      }
      const charge: DispenseCharge | null = charges.length === 0 ? null : charges.length === 1 ? charges[0] : {
        lineId: charges[0].lineId,
        quantity: charges.reduce((n, c) => n + c.quantity, 0),
        unitMrpPaise: charges[0].unitMrpPaise,
        totalPaise: charges.reduce((n, c) => n + c.totalPaise, 0),
      }
      return { ok: true as const, dispenseId: dispenseIds[0], dispenseIds, allocations, charge, charges }
    })
  } catch (err) {
    if (err instanceof DispenseRefused) return { ok: false, error: err.code, ...(err.stockRefusal ? { stockRefusal: true } : {}) }
    if (err instanceof OpeningBatchWrittenOffError) return { ok: false, error: 'opening_batch_written_off', stockRefusal: true }
    throw err
  }
}

/** The batch reconcileUnbatchedStock creates for stock that predates GRNs (ruling R7). */
const OPENING_BATCH_NO = 'OPENING'

/** A refusal found inside the dispense transaction: thrown so the reconcile and decrements roll back. */
class DispenseRefused extends Error {
  constructor(readonly code: DispenseError, readonly stockRefusal = false) { super(code) }
}

export async function listDispensesForPatient(patientId: string) {
  // Secondary sort on id breaks ties between dispenses sharing the same
  // dispensedAt timestamp (defaultNow() has millisecond resolution, so this
  // is possible for near-simultaneous dispenses), giving a stable order.
  return getDb().select().from(medicationDispenses).where(eq(medicationDispenses.patientId, patientId)).orderBy(desc(medicationDispenses.dispensedAt), desc(medicationDispenses.id))
}

export async function getDispenseById(id: number): Promise<typeof medicationDispenses.$inferSelect | null> {
  const [row] = await getDb().select().from(medicationDispenses).where(eq(medicationDispenses.id, id))
  return row ?? null
}

export type BillLegacyDispenseResult =
  | { ok: true; lineId: number }
  | { ok: false; error: 'not_found' | 'already_billed' | 'medication_unpriced' | 'quantity_too_large' }

/**
 * WS2 T8: bills a dispense made before dispensing billed itself, once, at the medicine's CURRENT
 * MRP. Already billed = it has a charge line (live or void: one line per dispense), a free-dispense
 * reason, or a bill on the pre-SP4 charges table. The dispense row lock serialises two bills of the
 * same dispense; the line check runs again under the patient billing lock; the unique
 * medication_dispense_id is the backstop.
 */
export async function billLegacyDispense(dispenseId: number, session: Session): Promise<BillLegacyDispenseResult> {
  const db = getDb()
  const [pre] = await db.select({ patientId: medicationDispenses.patientId }).from(medicationDispenses).where(eq(medicationDispenses.id, dispenseId))
  if (!pre) return { ok: false, error: 'not_found' }
  try {
    // Lock order (deadlock safety, spec section 6): dispense row FOR UPDATE → medication FOR SHARE →
    // patient billing lock LAST (taken inside insertPharmacyLine, which re-checks for an existing
    // line under it). dispenseMedication takes inventory → medication FOR SHARE → billing lock and
    // the price PATCH takes only medication FOR UPDATE, so no path waits on the billing lock while
    // another holds it and waits on the medication row.
    return await db.transaction(async (tx) => {
      const [d] = await tx.select().from(medicationDispenses).where(eq(medicationDispenses.id, dispenseId)).for('update')
      if (!d) return { ok: false as const, error: 'not_found' as const }
      if (d.chargeId !== null || d.noChargeReason !== null) return { ok: false as const, error: 'already_billed' as const }
      const [m] = await tx.select({ id: medications.id, name: medications.name, mrpPerUnitPaise: medications.mrpPerUnitPaise, gstRateBp: medications.gstRateBp, hsn: medications.hsn })
        .from(medications).where(eq(medications.id, d.medicationId)).for('share')
      if (m.mrpPerUnitPaise === null) return { ok: false as const, error: 'medication_unpriced' as const }
      if (d.quantity > MAX_LINE_QUANTITY) return { ok: false as const, error: 'quantity_too_large' as const }
      let prescriptionId: number | null = null
      if (d.medicationEpisodeId !== null) {
        const [ep] = await tx.select({ prescriptionId: medicationEpisodes.prescriptionId }).from(medicationEpisodes).where(eq(medicationEpisodes.id, d.medicationEpisodeId))
        prescriptionId = ep?.prescriptionId ?? null
      }
      const created = await insertPharmacyLine(tx, {
        dispenseId: d.id, patientId: d.patientId, quantity: d.quantity, medication: { ...m, mrpPerUnitPaise: m.mrpPerUnitPaise },
        batchNo: d.batchNo, expiryMonth: d.expiryMonth, prescriptionId, serviceDate: istDateOf(d.dispensedAt), session,
      })
      if (!created) return { ok: false as const, error: 'already_billed' as const }
      await tx.update(medicationDispenses).set({ unitMrpPaise: m.mrpPerUnitPaise }).where(eq(medicationDispenses.id, d.id))
      await logAudit(session, 'billed a legacy dispense', d.patientId, `dispense=${d.id} line=${created.lineId}`, tx)
      return { ok: true as const, lineId: created.lineId }
    })
  } catch (err) {
    if ((err as { code?: unknown })?.code === '23505') return { ok: false, error: 'already_billed' }
    throw err
  }
}

// ---------- billing status of a dispense (read from charge_lines) ----------

export type DispenseBilling =
  | { status: 'billed'; lineId: number; lineStatus: 'captured' | 'invoiced'; totalPaise: number }
  | { status: 'voided'; lineId: number }
  | { status: 'legacy_charge'; chargeId: number; amountPaise: number }
  | { status: 'no_charge' }
  | { status: 'unbilled' }

export interface DispenseBillingInput {
  noChargeReason: string | null
  lineId: number | null
  lineStatus: 'captured' | 'invoiced' | 'void' | null
  lineTaxablePaise: number | null
  lineGstRateBp: number | null
  chargeId: number | null
  chargeAmountCents: number | null
}

/** A dispense's billing state. A pre-SP4 bill (a legacy charge with no line) counts as billed. */
export function dispenseBilling(r: DispenseBillingInput): DispenseBilling {
  if (r.lineId !== null && r.lineStatus !== null && r.lineStatus !== 'void') {
    // The line's GST-inclusive total (intra-state estimate; the invoice applies the place of supply).
    const totalPaise = lineTax(r.lineTaxablePaise ?? 0, r.lineGstRateBp ?? 0, 'intra').totalPaise
    return { status: 'billed', lineId: r.lineId, lineStatus: r.lineStatus, totalPaise }
  }
  if (r.noChargeReason !== null) return { status: 'no_charge' }
  if (r.lineId !== null) return { status: 'voided', lineId: r.lineId }
  if (r.chargeId !== null) return { status: 'legacy_charge', chargeId: r.chargeId, amountPaise: r.chargeAmountCents ?? 0 }
  return { status: 'unbilled' }
}

/** SQL twin of dispenseBilling's "not billed" (unbilled or voided): no live line, no free-dispense reason, no pre-SP4 bill. */
export const dispenseNotBilledSql = sql`(${medicationDispenses.noChargeReason} IS NULL
  AND NOT EXISTS (SELECT 1 FROM charge_lines cl WHERE cl.medication_dispense_id = ${medicationDispenses.id} AND cl.status <> 'void')
  AND (${medicationDispenses.chargeId} IS NULL OR EXISTS (SELECT 1 FROM charge_lines cl2 WHERE cl2.medication_dispense_id = ${medicationDispenses.id})))`

/** The columns dispenseBilling needs; join chargeLines on medication_dispense_id and charges on charge_id. */
export const dispenseBillingColumns = {
  noChargeReason: medicationDispenses.noChargeReason,
  lineId: chargeLines.id,
  lineStatus: chargeLines.status,
  lineTaxablePaise: chargeLines.taxablePaise,
  lineGstRateBp: chargeLines.gstRateBp,
  chargeId: charges.id,
  chargeAmountCents: charges.amountCents,
}

export interface PharmacyBillingRow {
  dispenseId: number
  patientId: string
  patientName: string
  uhid: string | null
  medicationName: string
  quantity: number
  dispensedByName: string
  dispensedAt: Date
  billing: DispenseBilling
}

/**
 * Every dispense across every patient, newest first, with its billing state from charge_lines --
 * pharmacy's own billing view, not the practice's full revenue cycle.
 */
export async function listAllDispensesWithBilling(): Promise<PharmacyBillingRow[]> {
  const rows = await getDb()
    .select({
      dispenseId: medicationDispenses.id,
      patientId: medicationDispenses.patientId,
      patientName: sql<string>`patients.name`,
      uhid: patients.uhid,
      medicationName: medications.name,
      quantity: medicationDispenses.quantity,
      dispensedByName: medicationDispenses.dispensedByName,
      dispensedAt: medicationDispenses.dispensedAt,
      ...dispenseBillingColumns,
    })
    .from(medicationDispenses)
    .innerJoin(patients, eq(patients.id, medicationDispenses.patientId))
    .innerJoin(medications, eq(medications.id, medicationDispenses.medicationId))
    .leftJoin(chargeLines, eq(chargeLines.medicationDispenseId, medicationDispenses.id))
    .leftJoin(charges, eq(charges.id, medicationDispenses.chargeId))
    .orderBy(desc(medicationDispenses.dispensedAt), desc(medicationDispenses.id))

  return rows.map((r) => ({
    dispenseId: r.dispenseId,
    patientId: r.patientId,
    patientName: r.patientName,
    uhid: r.uhid,
    medicationName: r.medicationName,
    quantity: r.quantity,
    dispensedByName: r.dispensedByName,
    dispensedAt: r.dispensedAt,
    billing: dispenseBilling(r),
  }))
}
// end WS2 T8

// Wave E P1-19: ids of the legacy charges raised from a dispense (pharmacy bills), so
// /billing/charges?source=pharmacy can list only those for review.
export async function listPharmacyChargeIds(): Promise<number[]> {
  const rows = await getDb().select({ id: medicationDispenses.chargeId }).from(medicationDispenses).where(isNotNull(medicationDispenses.chargeId))
  return rows.map((r) => r.id).filter((id): id is number => id !== null)
}
// end Wave E
