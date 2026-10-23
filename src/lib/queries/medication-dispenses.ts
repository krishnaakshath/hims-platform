import { getDb } from '@/db/client'
import { medicationDispenses, medicationEpisodes, patients, medications, charges, admissions, chargeLines } from '@/db/schema'
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { invalidateChargesList } from '@/lib/queries/charges'
// SP4
import { MAX_LINE_QUANTITY, lineTaxablePaise } from '@/lib/billing/amounts'
import { getBillingSettings } from '@/lib/queries/billing-settings'
import { lockPatientBilling } from '@/lib/queries/charge-capture'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { allocateDispenseBatches, OpeningBatchWrittenOffError, type DispenseAllocationError } from '@/lib/queries/medication-batches' // WS5 T5

export interface DispenseInput {
  patientId: string
  medicationId: number
  medicationEpisodeId: number | null
  quantity: number
  dispensedByName: string
  notes: string | null
  batchId: number | null // WS5 T5: a picked batch, or null for FEFO
  todayIso: string // WS5 T5: IST business date that decides which batches are expired
}

// WS5 T5: stock refusals carry a code the route maps to a status (batch_mismatch 400, rest 409).
export type DispenseRefusal = DispenseAllocationError | 'opening_batch_written_off'
export const DISPENSE_REFUSAL_MESSAGES: Record<DispenseRefusal, string> = {
  insufficient_stock: 'Not enough stock on hand for this quantity',
  batch_expired: 'This batch has expired and cannot be dispensed',
  only_expired_stock: 'Only expired stock is left for this quantity; write it off and receive fresh stock',
  batch_mismatch: 'That batch is not stock of this medication',
  opening_batch_written_off: 'The OPENING batch of this medication is written off; receive stock before dispensing',
}

export interface DispenseResult {
  ok: boolean
  error?: string
  code?: DispenseRefusal
  dispenseId?: number // the first of dispenseIds, for older callers
  dispenseIds?: number[]
  allocations?: { dispenseId: number; batchId: number; batchNo: string; expiryMonth: string | null; quantity: number }[]
}

class DispenseRefused extends Error {
  constructor(readonly code: DispenseRefusal) { super(code) }
}

// patientId/medicationId existence is validated BEFORE the transaction
// (matching the getPayerById/'Unknown payer' pattern in the eligibility-check
// route) so a bad FK is a clean 400 instead of an FK-violation 500 on the
// medicationDispenses insert, and an unknown medicationId is reported as
// "unknown medication" (400), not "not enough stock" (409).
//
// WS5 T5: stock comes out of batches. allocateDispenseBatches (inside the same
// transaction as the dispense rows) locks the drug's inventory row and batches,
// moves any unbatched stock into the OPENING batch, allocates FEFO or the picked
// batch with guarded decrements, and recomputes medication_inventory from the
// batches -- so this path no longer decrements medication_inventory itself.
// One dispense row per allocation, each with its batch_id; a drug with no stock
// at all is refused exactly as before. Any refusal throws inside the transaction
// so the reconcile and partial decrements roll back with it.
export async function dispenseMedication(input: DispenseInput): Promise<DispenseResult> {
  const db = getDb()

  const [patient] = await db.select({ id: patients.id }).from(patients).where(eq(patients.id, input.patientId))
  if (!patient) return { ok: false, error: 'Unknown patient' }

  const [medication] = await db.select({ id: medications.id }).from(medications).where(eq(medications.id, input.medicationId))
  if (!medication) return { ok: false, error: 'Unknown medication' }

  if (input.medicationEpisodeId !== null) {
    const [episode] = await db.select().from(medicationEpisodes).where(eq(medicationEpisodes.id, input.medicationEpisodeId))
    if (!episode || episode.patientId !== input.patientId) {
      return { ok: false, error: 'medicationEpisodeId does not belong to this patient' }
    }
  }

  try {
    return await db.transaction(async (tx) => {
      const allocated = await allocateDispenseBatches(tx, {
        medicationId: input.medicationId, quantity: input.quantity, batchId: input.batchId, todayIso: input.todayIso,
      })
      if (!allocated.ok) throw new DispenseRefused(allocated.error)

      const allocations: NonNullable<DispenseResult['allocations']> = []
      for (const a of allocated.allocations) {
        const [created] = await tx.insert(medicationDispenses).values({
          patientId: input.patientId, medicationId: input.medicationId, medicationEpisodeId: input.medicationEpisodeId,
          quantity: a.quantity, dispensedByName: input.dispensedByName, notes: input.notes, batchId: a.batchId,
        }).returning({ id: medicationDispenses.id })
        allocations.push({ dispenseId: created.id, batchId: a.batchId, batchNo: a.batchNo, expiryMonth: a.expiryMonth, quantity: a.quantity })
      }
      const dispenseIds = allocations.map((a) => a.dispenseId)
      return { ok: true, dispenseId: dispenseIds[0], dispenseIds, allocations }
    })
  } catch (err) {
    const code = err instanceof DispenseRefused ? err.code : err instanceof OpeningBatchWrittenOffError ? 'opening_batch_written_off' : null
    if (code === null) throw err
    return { ok: false, code, error: DISPENSE_REFUSAL_MESSAGES[code] }
  }
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

export interface DispenseChargeInput {
  dispenseId: number
  patientId: string
  providerName: string
  dateOfService: string
  diagnosisCode: { code: string; description: string }
  procedureCode: { code: string; description: string; units: number; chargeCents: number }
  amountCents: number
  // SP4: the IST date of the dispense (istDateOf(dispensedAt)) and who dispensed it, for the charge line.
  serviceDate: string
  createdByName: string
}

export interface DispenseChargeResult {
  ok: boolean
  error?: string
  chargeId?: number
  lineId?: number
}

// Same transactional posture as dispenseMedication above: the charge insert
// and the dispense's chargeId link commit or roll back together, so a
// dispense is never left pointing at a charge that rolled back and a charge
// is never orphaned from its dispense.
//
// The link step is a conditional UPDATE (chargeId IS NULL in the WHERE, not
// a separate read-then-write) so two concurrent bill calls for the same
// dispense can't both succeed -- if this returns zero rows, the dispense was
// billed by another request between the route's own check and here, and we
// throw to roll back the whole transaction (including the just-inserted
// charge) rather than leave an orphan charge row. The .unique() index on
// medicationDispenses.chargeId is the real backstop; this conditional WHERE
// is what turns a race into a clean rollback instead of a
// constraint-violation 500.
// `session` (the route always passes it): the audit row is written on the same transaction.
export async function createChargeForDispense(input: DispenseChargeInput, session?: Session): Promise<DispenseChargeResult> {
  const db = getDb()
  // SP4: the bill also becomes one charge line, which caps a line at MAX_LINE_QUANTITY units.
  if (input.procedureCode.units > MAX_LINE_QUANTITY) {
    return { ok: false, error: `This dispense is too large to bill as one line (more than ${MAX_LINE_QUANTITY} units)` }
  }

  try {
    const { chargeId, lineId } = await db.transaction(async (tx) => {
      // SP4: the per-patient billing lock first (same key as charge capture).
      await lockPatientBilling(tx, input.patientId)
      const [created] = await tx.insert(charges).values({
        patientId: input.patientId,
        providerName: input.providerName,
        dateOfService: input.dateOfService,
        diagnosisCodes: [input.diagnosisCode],
        procedureCodes: [input.procedureCode],
        amountCents: input.amountCents,
        status: 'draft',
      }).returning()

      const linked = await tx.update(medicationDispenses)
        .set({ chargeId: created.id })
        .where(and(eq(medicationDispenses.id, input.dispenseId), isNull(medicationDispenses.chargeId)))
        .returning({ id: medicationDispenses.id })
      if (linked.length === 0) throw new Error('ALREADY_BILLED')

      // SP4: the same bill as one pharmacy charge line (amount_cents is read as paise), on the
      // patient's active admission when there is one. legacy_charge_id keeps it from being listed twice.
      const settings = await getBillingSettings(tx)
      const [active] = await tx.select({ id: admissions.id }).from(admissions)
        .where(and(eq(admissions.patientId, input.patientId), eq(admissions.status, 'admitted'))).orderBy(desc(admissions.admittedAt)).limit(1)
      const quantity = input.procedureCode.units
      const unitPricePaise = input.procedureCode.chargeCents
      const [line] = await tx.insert(chargeLines).values({
        patientId: input.patientId,
        admissionId: active?.id ?? null,
        source: 'pharmacy',
        priceSource: 'pharmacy',
        serviceId: null,
        itemCode: input.procedureCode.code,
        itemName: input.procedureCode.description,
        serviceDate: input.serviceDate,
        quantity,
        unitPricePaise,
        taxablePaise: lineTaxablePaise(unitPricePaise, quantity),
        gstRateBp: settings.pharmacyGstRateBp,
        hsnSac: settings.pharmacyHsn,
        legacyChargeId: created.id,
        medicationDispenseId: input.dispenseId,
        createdByName: input.createdByName,
      }).returning({ id: chargeLines.id })

      if (session) await logAudit(session, 'logged a bill for a dispensed medication', input.patientId, `charge=${created.id} line=${line.id}`, tx)
      return { chargeId: created.id, lineId: line.id }
    })

    // Deliberately outside the transaction: a cache invalidation for a
    // rolled-back write would be wasted work, and the charges list is
    // cached for 30s (charges.ts:26, cache.ts:78) so it would otherwise not
    // show the new row.
    await invalidateChargesList()
    return { ok: true, chargeId, lineId }
  } catch (err) {
    if (err instanceof Error && err.message === 'ALREADY_BILLED') {
      return { ok: false, error: 'This dispense has already been billed' }
    }
    throw err
  }
}

export interface PharmacyBillingRow {
  dispenseId: number
  patientId: string
  patientName: string
  medicationName: string
  quantity: number
  dispensedByName: string
  dispensedAt: Date
  charge: { id: number; status: typeof charges.$inferSelect['status']; amountCents: number } | null
}

/**
 * Every dispense across every patient, newest first, with its billed charge
 * if any -- pharmacy's own billing view. Deliberately NOT a slice of the
 * general `charges` table: that table is every service line across the
 * whole practice (visits, procedures, everything), and pharmacy should see
 * only the charges that came from a medication dispense, not the practice's
 * full revenue cycle (that's the Billing role's job, a completely separate
 * dashboard).
 */
export async function listAllDispensesWithBilling(): Promise<PharmacyBillingRow[]> {
  const rows = await getDb()
    .select({
      dispenseId: medicationDispenses.id,
      patientId: medicationDispenses.patientId,
      patientName: sql<string>`patients.name`,
      medicationName: medications.name,
      quantity: medicationDispenses.quantity,
      dispensedByName: medicationDispenses.dispensedByName,
      dispensedAt: medicationDispenses.dispensedAt,
      chargeId: charges.id,
      chargeStatus: charges.status,
      chargeAmountCents: charges.amountCents,
    })
    .from(medicationDispenses)
    .innerJoin(patients, eq(patients.id, medicationDispenses.patientId))
    .innerJoin(medications, eq(medications.id, medicationDispenses.medicationId))
    .leftJoin(charges, eq(charges.id, medicationDispenses.chargeId))
    .orderBy(desc(medicationDispenses.dispensedAt), desc(medicationDispenses.id))

  return rows.map((r) => ({
    dispenseId: r.dispenseId,
    patientId: r.patientId,
    patientName: r.patientName,
    medicationName: r.medicationName,
    quantity: r.quantity,
    dispensedByName: r.dispensedByName,
    dispensedAt: r.dispensedAt,
    charge: r.chargeId != null ? { id: r.chargeId, status: r.chargeStatus!, amountCents: r.chargeAmountCents! } : null,
  }))
}

// Wave E P1-19: ids of the legacy charges raised from a dispense (pharmacy bills), so
// /billing/charges?source=pharmacy can list only those for review.
export async function listPharmacyChargeIds(): Promise<number[]> {
  const rows = await getDb().select({ id: medicationDispenses.chargeId }).from(medicationDispenses).where(isNotNull(medicationDispenses.chargeId))
  return rows.map((r) => r.id).filter((id): id is number => id !== null)
}
// end Wave E
