// WS1 T3: the patient's allergy list and allergy status ("unknown" / "no known allergies" /
// "recorded"). Active allergy = inactivated_at IS NULL (rows are never deleted, only inactivated).
// Every write locks the patient row first, so adding an allergy and marking "no known allergies"
// can never interleave into a contradictory state.
import { and, asc, count, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '@/db/client'
import { allergies, patients } from '@/db/schema'
import type { Session } from '@/lib/auth'
import { invalidateCache, patientDetailCacheKey } from '@/lib/cache'

export const addAllergySchema = z.object({
  allergen: z.string().trim().min(2).max(120),
  reaction: z.string().trim().max(200).optional(),
  severity: z.enum(['mild', 'moderate', 'severe']),
}).strict()
export type AddAllergy = z.infer<typeof addAllergySchema>

export const allergyStatusSchema = z.object({ status: z.enum(['none_known', 'unknown']) }).strict()
export const inactivateAllergySchema = z.object({ active: z.literal(false) }).strict()

export type AllergyRow = typeof allergies.$inferSelect
export type AllergyStatus = 'unknown' | 'none_known' | 'recorded'

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0]

async function lockPatient(tx: Tx, patientId: string): Promise<boolean> {
  const [row] = await tx.select({ id: patients.id }).from(patients).where(eq(patients.id, patientId)).for('update')
  return !!row
}

const active = (patientId: string) => and(eq(allergies.patientId, patientId), isNull(allergies.inactivatedAt))

async function activeCount(tx: Tx, patientId: string): Promise<number> {
  const [row] = await tx.select({ n: count() }).from(allergies).where(active(patientId))
  return Number(row?.n ?? 0)
}

export async function listActiveAllergies(patientId: string): Promise<AllergyRow[]> {
  return getDb().select().from(allergies).where(active(patientId)).orderBy(asc(allergies.id))
}

/** Adds one allergy and marks the patient's allergy status "recorded". The caller checked the patient exists. */
export async function addAllergy(patientId: string, input: AddAllergy, session: Session): Promise<AllergyRow> {
  const row = await getDb().transaction(async (tx) => {
    if (!(await lockPatient(tx, patientId))) throw new Error('Patient not found')
    const [inserted] = await tx.insert(allergies).values({
      patientId,
      allergen: input.allergen,
      reaction: input.reaction ? input.reaction : null,
      severity: input.severity,
      recordedByName: session.name,
      recordedAt: new Date(),
    }).returning()
    await tx.update(patients).set({ allergyStatus: 'recorded' }).where(eq(patients.id, patientId))
    return inserted
  })
  await invalidateCache(patientDetailCacheKey(patientId))
  return row
}

/**
 * Inactivates one of this patient's active allergies; false when there is no such active row.
 * When the last active allergy goes, the status falls back to "unknown" (nobody has confirmed
 * "no known allergies"), so the workspace asks again instead of showing an empty "recorded" list.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- session kept in the shared signature (plan interface)
export async function inactivateAllergy(patientId: string, allergyId: number, _session: Session): Promise<boolean> {
  const done = await getDb().transaction(async (tx) => {
    if (!(await lockPatient(tx, patientId))) return false
    const updated = await tx.update(allergies).set({ inactivatedAt: new Date() })
      .where(and(eq(allergies.id, allergyId), active(patientId))).returning({ id: allergies.id })
    if (updated.length === 0) return false
    if ((await activeCount(tx, patientId)) === 0) {
      await tx.update(patients).set({ allergyStatus: 'unknown' }).where(eq(patients.id, patientId))
    }
    return true
  })
  if (done) await invalidateCache(patientDetailCacheKey(patientId))
  return done
}

/** Sets "no known allergies" or back to "unknown"; refused while any allergy is active. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- session kept in the shared signature (plan interface)
export async function setAllergyStatus(patientId: string, status: 'none_known' | 'unknown', _session: Session): Promise<'ok' | 'has_active_allergies'> {
  const result = await getDb().transaction(async (tx) => {
    if (!(await lockPatient(tx, patientId))) throw new Error('Patient not found')
    if ((await activeCount(tx, patientId)) > 0) return 'has_active_allergies' as const
    await tx.update(patients).set({ allergyStatus: status }).where(eq(patients.id, patientId))
    return 'ok' as const
  })
  if (result === 'ok') await invalidateCache(patientDetailCacheKey(patientId))
  return result
}
