import { getDb } from '@/db/client'
import { medicationDispenses, medicationInventory, medicationEpisodes, patients, medications, charges } from '@/db/schema'
import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm'
import { invalidateChargesList } from '@/lib/queries/charges'

export interface DispenseInput {
  patientId: string
  medicationId: number
  medicationEpisodeId: number | null
  quantity: number
  dispensedByName: string
  notes: string | null
}

export interface DispenseResult {
  ok: boolean
  error?: string
  dispenseId?: number
}

// The stock decrement is a single conditional UPDATE (quantity_on_hand >=
// requested in the WHERE, not a separate read-then-write) so two concurrent
// dispenses of the same drug can't both succeed past the actual stock --
// same race-safety pattern as Front Desk's room assignment and the MAR's
// administerMedication elsewhere in this codebase.
//
// patientId/medicationId existence is validated BEFORE the decrement
// (matching the getPayerById/'Unknown payer' pattern in the eligibility-check
// route) for two reasons: (1) it turns a bad FK into a clean 400 instead of
// an unhandled FK-violation 500 on the medicationDispenses insert -- with no
// existence check, an unknown patientId would let the stock decrement commit
// and then fail the insert, silently destroying stock with no audit trail;
// (2) it removes the ambiguity where an unknown medicationId previously fell
// through the conditional UPDATE's WHERE clause (no matching row) and was
// misreported as "not enough stock" (409) instead of "unknown medication" (400).
//
// The decrement and the dispense insert are wrapped in a single
// db.transaction() so they commit or roll back together -- without this, a
// post-existence-check failure (or any other error) between the two
// statements could still leave stock decremented with no matching dispense
// row.
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

  return db.transaction(async (tx) => {
    const decremented = await tx.update(medicationInventory)
      .set({ quantityOnHand: sql`${medicationInventory.quantityOnHand} - ${input.quantity}`, updatedAt: new Date() })
      .where(and(eq(medicationInventory.medicationId, input.medicationId), gte(medicationInventory.quantityOnHand, input.quantity)))
      .returning({ id: medicationInventory.id })
    if (decremented.length === 0) return { ok: false, error: 'Not enough stock on hand for this quantity' }

    const [created] = await tx.insert(medicationDispenses).values({
      patientId: input.patientId, medicationId: input.medicationId, medicationEpisodeId: input.medicationEpisodeId,
      quantity: input.quantity, dispensedByName: input.dispensedByName, notes: input.notes,
    }).returning()

    return { ok: true, dispenseId: created.id }
  })
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
}

export interface DispenseChargeResult {
  ok: boolean
  error?: string
  chargeId?: number
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
export async function createChargeForDispense(input: DispenseChargeInput): Promise<DispenseChargeResult> {
  const db = getDb()

  try {
    const chargeId = await db.transaction(async (tx) => {
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

      return created.id
    })

    // Deliberately outside the transaction: a cache invalidation for a
    // rolled-back write would be wasted work, and the charges list is
    // cached for 30s (charges.ts:26, cache.ts:78) so it would otherwise not
    // show the new row.
    await invalidateChargesList()
    return { ok: true, chargeId }
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
