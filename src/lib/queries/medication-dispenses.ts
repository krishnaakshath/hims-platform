import { getDb } from '@/db/client'
import {
  medicationDispenses, medicationInventory, medicationEpisodes, patients, medications, charges, admissions, chargeLines, encounters, prescriptions,
} from '@/db/schema'
import { and, desc, eq, gte, isNotNull, sql } from 'drizzle-orm'
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
import type { WriteExecutor } from './executor'

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
}).strict()
export type DispenseInput = z.input<typeof dispenseSchema>

export type DispenseError =
  | 'unknown_patient' | 'unknown_medication' | 'episode_mismatch' | 'not_enough_stock'
  | 'medication_unpriced' | 'batch_required' | 'batch_expired' | 'allergy_conflict'

export interface DispenseCharge { lineId: number; quantity: number; unitMrpPaise: number; totalPaise: number }

export type DispenseResult =
  | { ok: true; dispenseId: number; charge: DispenseCharge | null }
  | { ok: false; error: DispenseError; conflicts?: AllergyConflict[] }

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
  const batch = input.batchNo !== null && input.expiryMonth !== null ? ` (Batch ${input.batchNo}, Exp ${expiryLabel(input.expiryMonth)})` : ''
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
    createdByName: input.session.name,
    createdByUserId: input.session.userId,
  }).returning({ id: chargeLines.id })
  return { lineId: line.id, totalPaise: price.totalPaise }
}

// The stock decrement is a single conditional UPDATE (quantity_on_hand >= requested in the WHERE,
// not a read-then-write), so two concurrent dispenses of the same drug can't both succeed past the
// actual stock. Patient, medication and episode are validated BEFORE the decrement so a bad id is a
// clean 400 and never destroys stock. Decrement, dispense row, charge line and audit commit or roll
// back together. Lock order: inventory row (the UPDATE) → patient billing lock → line.
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

  if (noChargeReason === null) {
    if (medication.mrpPerUnitPaise === null) return { ok: false, error: 'medication_unpriced' }
    if (batchNo === null || expiryMonth === null) return { ok: false, error: 'batch_required' }
  }
  if (expiryMonth !== null && isExpiredMonth(expiryMonth, now)) return { ok: false, error: 'batch_expired' }

  // WS1 T6 matcher against the patient's active allergies (the catalogue identity).
  const conflicts = allergyConflicts(medication, await activeAllergies(input.patientId))
  if (conflicts.length > 0 && !input.allergyAcknowledged) return { ok: false, error: 'allergy_conflict', conflicts }

  return db.transaction(async (tx) => {
    const decremented = await tx.update(medicationInventory)
      .set({ quantityOnHand: sql`${medicationInventory.quantityOnHand} - ${input.quantity}`, updatedAt: now })
      .where(and(eq(medicationInventory.medicationId, input.medicationId), gte(medicationInventory.quantityOnHand, input.quantity)))
      .returning({ id: medicationInventory.id })
    if (decremented.length === 0) return { ok: false as const, error: 'not_enough_stock' as const }

    // The price in force now, held against a concurrent price edit until this commits.
    const [priced] = await tx.select({ id: medications.id, name: medications.name, mrpPerUnitPaise: medications.mrpPerUnitPaise, gstRateBp: medications.gstRateBp, hsn: medications.hsn })
      .from(medications).where(eq(medications.id, input.medicationId)).for('share')
    if (noChargeReason === null && priced.mrpPerUnitPaise === null) throw new MedicationUnpricedRace()

    const [created] = await tx.insert(medicationDispenses).values({
      patientId: input.patientId, medicationId: input.medicationId, medicationEpisodeId: input.medicationEpisodeId ?? null,
      quantity: input.quantity, dispensedByName: session.name, dispensedAt: now, notes: input.notes?.trim() || null,
      batchNo, expiryMonth, noChargeReason, unitMrpPaise: priced.mrpPerUnitPaise,
    }).returning({ id: medicationDispenses.id })

    let charge: DispenseCharge | null = null
    if (noChargeReason === null && priced.mrpPerUnitPaise !== null) {
      const line = await insertPharmacyLine(tx, {
        dispenseId: created.id, patientId: input.patientId, quantity: input.quantity, medication: { ...priced, mrpPerUnitPaise: priced.mrpPerUnitPaise },
        batchNo, expiryMonth, prescriptionId, serviceDate: istDateOf(now), session,
      })
      if (line) charge = { lineId: line.lineId, quantity: input.quantity, unitMrpPaise: priced.mrpPerUnitPaise, totalPaise: line.totalPaise }
    }

    await logAudit(session, 'dispensed medication', input.patientId, `dispense=${created.id} line=${charge?.lineId ?? 'none'}`, tx)
    if (conflicts.length > 0) {
      await logAudit(session, 'acknowledged an allergy conflict at dispense', input.patientId, `dispense=${created.id} conflicts=${conflicts.length}`, tx)
    }
    return { ok: true as const, dispenseId: created.id, charge }
  }).catch((err: unknown) => {
    if (err instanceof MedicationUnpricedRace) return { ok: false as const, error: 'medication_unpriced' as const }
    throw err
  })
}

/** The medicine's MRP was cleared between the pre-check and the transaction: roll back, report unpriced. */
class MedicationUnpricedRace extends Error {}

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
 * reason, or a bill on the pre-SP4 charges table. Everything is checked under the patient billing
 * lock; the unique medication_dispense_id is the backstop for a race.
 */
export async function billLegacyDispense(dispenseId: number, session: Session): Promise<BillLegacyDispenseResult> {
  const db = getDb()
  const [pre] = await db.select({ patientId: medicationDispenses.patientId }).from(medicationDispenses).where(eq(medicationDispenses.id, dispenseId))
  if (!pre) return { ok: false, error: 'not_found' }
  try {
    return await db.transaction(async (tx) => {
      await lockPatientBilling(tx, pre.patientId)
      const [d] = await tx.select().from(medicationDispenses).where(eq(medicationDispenses.id, dispenseId)).for('update')
      if (!d) return { ok: false as const, error: 'not_found' as const }
      const [line] = await tx.select({ id: chargeLines.id }).from(chargeLines).where(eq(chargeLines.medicationDispenseId, d.id)).limit(1)
      if (line || d.chargeId !== null || d.noChargeReason !== null) return { ok: false as const, error: 'already_billed' as const }
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
