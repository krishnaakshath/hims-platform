import { getDb } from '@/db/client'
import { allergies, encounters, medicationEpisodes, medications, prescriptions, providers, type EncounterRow } from '@/db/schema'
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import type { Session } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { parseDosePattern, prescribedQuantity } from '@/lib/prescriptions/dose-pattern'
import { allergyConflicts, type AllergyConflict, type AllergyInput } from '@/lib/prescriptions/allergy-check'
import type { WriteExecutor } from './executor'
import type { PrescriptionItem } from '@/lib/prescriptions/validation'
import type { SessionProvider } from '@/lib/provider-identity'
import { formatDoctorRegistration } from '@/lib/india/registration'

export interface CreatePrescriptionInput {
  patientId: string
  medicationId: number | null
  name: string
  medicationClass: string
  dose: string
  frequencyPerDay: number
  dosePattern?: string | null // WS1 T6
  quantityPrescribed?: number | null // WS1 T6
  allergyOverrideReason?: string | null // WS1 T6
  durationDays: number
  startDate: string // 'YYYY-MM-DD'
  instructions: string | null
  prescribedByProviderId: number
  enteredByName: string
}

/** Always writes `status: 'active'` and stamps `prescribedAt` now -- both
 *  are deliberately absent from the input shape so a caller can't backdate
 *  or misstate either one when writing a new, in-app prescription. */
export async function createPrescription(input: CreatePrescriptionInput) {
  const [created] = await getDb()
    .insert(medicationEpisodes)
    .values({ ...input, status: 'active', prescribedAt: new Date() })
    .returning()
  return created
}

// WS1 T6: the allergy check shared by both prescribing routes. The client's text is checked, and
// for a catalogue drug the catalogue identity (name, generic, class) is ALWAYS checked as well, so a
// client cannot dodge a match by renaming the drug, omitting its generic or sending another class.
export function drugAllergyConflicts(
  item: { name: string; genericName?: string | null; medicationClass: string },
  catalogRow: { name: string; genericName: string | null; medicationClass: string } | null,
  active: AllergyInput[],
): AllergyConflict[] {
  const found = allergyConflicts({ name: item.name, genericName: catalogRow?.genericName ?? item.genericName ?? null, medicationClass: item.medicationClass }, active)
  if (catalogRow) {
    for (const c of allergyConflicts(catalogRow, active)) {
      if (!found.some((f) => f.allergen === c.allergen)) found.push(c)
    }
  }
  return found
}

/** The patient's active allergies (inactivated_at IS NULL), as the matcher's input. */
export async function activeAllergies(patientId: string, executor: WriteExecutor = getDb()): Promise<AllergyInput[]> {
  return executor.select({ allergen: allergies.allergen, severity: allergies.severity }).from(allergies)
    .where(and(eq(allergies.patientId, patientId), isNull(allergies.inactivatedAt)))
}

// WS1 T6: a multi-drug prescription written on one visit -- one `prescriptions` header and one
// medication_episodes row per drug, in one transaction. Every drug is checked against the
// patient's active allergies (inactivated_at IS NULL); a conflict without an override reason
// refuses the whole set before anything is written.
export type CreatePrescriptionSetResult =
  | { ok: true; prescriptionId: number; episodeIds: number[] }
  | { ok: false; error: 'allergy_conflict'; conflicts: { index: number; conflicts: AllergyConflict[] }[] }
  | { ok: false; error: 'medication_not_found'; index: number }
  | { ok: false; error: 'visit_closed' }

export async function createPrescriptionSet(
  i: { encounter: EncounterRow; prescribedByProviderId: number; advice: string | null; items: PrescriptionItem[] },
  session: Session,
): Promise<CreatePrescriptionSetResult> {
  const patientId = i.encounter.patientId
  return getDb().transaction(async (tx): Promise<CreatePrescriptionSetResult> => {
    // The ownership check read the encounter outside this transaction; re-check it is still open
    // under a share lock so a concurrent completion cannot slip between the check and the insert.
    const [enc] = await tx.select({ status: encounters.status }).from(encounters).where(eq(encounters.id, i.encounter.id)).for('share')
    if (!enc || enc.status === 'completed' || enc.status === 'cancelled') return { ok: false, error: 'visit_closed' }

    const medIds = [...new Set(i.items.map((it) => it.medicationId).filter((id): id is number => id != null))]
    const catalog = new Map(
      (medIds.length === 0 ? [] : await tx.select().from(medications).where(inArray(medications.id, medIds))).map((m) => [m.id, m]),
    )
    const missing = i.items.findIndex((it) => it.medicationId != null && !catalog.has(it.medicationId))
    if (missing >= 0) return { ok: false, error: 'medication_not_found', index: missing }

    const active = await activeAllergies(patientId, tx)

    const perItem = i.items.map((it) => drugAllergyConflicts(it, it.medicationId != null ? catalog.get(it.medicationId)! : null, active))
    const blocking = perItem
      .map((conflicts, index) => ({ index, conflicts }))
      .filter((r) => r.conflicts.length > 0 && !i.items[r.index].allergyOverrideReason)
    if (blocking.length > 0) return { ok: false, error: 'allergy_conflict', conflicts: blocking }

    const [header] = await tx.insert(prescriptions).values({
      patientId,
      encounterId: i.encounter.id,
      prescribedByProviderId: i.prescribedByProviderId,
      advice: i.advice,
      enteredByName: session.name,
      enteredByUserId: session.userId,
    }).returning({ id: prescriptions.id })

    const now = new Date()
    const episodes = await tx.insert(medicationEpisodes).values(i.items.map((it, index) => {
      const pattern = it.dosePattern ? parseDosePattern(it.dosePattern) : null
      const frequencyPerDay = pattern?.perDay ?? it.frequencyPerDay ?? null
      const m = it.medicationId != null ? catalog.get(it.medicationId)! : null
      const overridden = perItem[index].length > 0
      return {
        patientId,
        medicationId: it.medicationId,
        name: it.name,
        medicationClass: it.medicationClass,
        dose: it.dose,
        startDate: i.encounter.encounterDate,
        status: 'active' as const,
        frequencyPerDay,
        durationDays: it.durationDays,
        instructions: it.instructions ?? null,
        prescribedByProviderId: i.prescribedByProviderId,
        enteredByName: session.name,
        prescribedAt: now,
        prescriptionId: header.id,
        dosePattern: pattern?.label ?? null,
        route: it.route,
        foodTiming: it.foodTiming ?? null,
        isSos: it.isSos,
        // An off-catalogue drug has no known form, so no countable quantity.
        quantityPrescribed: prescribedQuantity({ pattern, frequencyPerDay, durationDays: it.durationDays, form: m?.form ?? 'other', isSos: it.isSos }),
        // Stored only when the drug actually conflicted: the reason answers that conflict.
        allergyOverrideReason: overridden ? it.allergyOverrideReason ?? null : null,
      }
    })).returning({ id: medicationEpisodes.id })

    const overrides = perItem.filter((c) => c.length > 0).length
    await logAudit(session, 'wrote prescription', patientId, `prescription=${header.id} items=${i.items.length} overrides=${overrides}`, tx)
    return { ok: true, prescriptionId: header.id, episodeIds: episodes.map((e) => e.id) }
  })
}

export type StopPrescriptionResult =
  | { ok: true; episode: typeof medicationEpisodes.$inferSelect }
  | { ok: false; reason: 'not_found' | 'already_inactive' }

/** A single conditional UPDATE, guarded on id + patientId + status: 'active'
 *  in the WHERE clause (never read-then-write, matching lab-orders.ts's
 *  lifecycle functions). When it affects no row, one follow-up existence
 *  query -- keyed on the same id + patientId -- distinguishes "this patient's
 *  episode exists but is already inactive" from "no such episode for this
 *  patient" (wrong id, or an id that belongs to a different patient). */
export async function stopPrescription(patientId: string, episodeId: number, stopDate: string): Promise<StopPrescriptionResult> {
  const db = getDb()

  const updated = await db
    .update(medicationEpisodes)
    .set({ status: 'inactive', stopDate })
    .where(and(
      eq(medicationEpisodes.id, episodeId),
      eq(medicationEpisodes.patientId, patientId),
      eq(medicationEpisodes.status, 'active'),
    ))
    .returning()

  if (updated.length > 0) return { ok: true, episode: updated[0] }

  const [existing] = await db
    .select({ id: medicationEpisodes.id })
    .from(medicationEpisodes)
    .where(and(eq(medicationEpisodes.id, episodeId), eq(medicationEpisodes.patientId, patientId)))

  return existing ? { ok: false, reason: 'already_inactive' } : { ok: false, reason: 'not_found' }
}

export interface PrintablePrescription {
  id: number
  patientId: string
  name: string
  medicationClass: string
  dose: string | null
  frequencyPerDay: number | null
  durationDays: number | null
  instructions: string | null
  prescribedAt: Date
  enteredByName: string | null
  prescriber: SessionProvider
  /** Wave F P1-16: "NMC 12345" / "SMC IN-MH 12345", or null when not on file. */
  prescriberRegistration: string | null
}

/** Null unless EVERY id exists, they all belong to ONE patient, and each has
 *  both `prescribedAt` and a resolvable `prescribedByProviderId` -- the
 *  inner join to `providers` plus the `isNotNull(prescribedAt)` filter make
 *  "missing id", "not prescribed" and "no prescriber" all collapse into a
 *  short result set, and the length-vs-distinct-ids check below is what
 *  turns that into a `null`. */
export async function getPrintablePrescriptions(ids: number[]): Promise<PrintablePrescription[] | null> {
  if (ids.length === 0) return null

  const rows = await getDb()
    .select({ episode: medicationEpisodes, provider: providers })
    .from(medicationEpisodes)
    .innerJoin(providers, eq(medicationEpisodes.prescribedByProviderId, providers.id))
    .where(and(
      inArray(medicationEpisodes.id, ids),
      isNotNull(medicationEpisodes.prescribedAt),
    ))

  const distinctIdCount = new Set(ids).size
  if (rows.length !== distinctIdCount) return null

  const patientIds = new Set(rows.map((r) => r.episode.patientId))
  if (patientIds.size !== 1) return null

  return rows.map((r) => ({
    id: r.episode.id,
    patientId: r.episode.patientId,
    name: r.episode.name,
    medicationClass: r.episode.medicationClass,
    dose: r.episode.dose,
    frequencyPerDay: r.episode.frequencyPerDay,
    durationDays: r.episode.durationDays,
    instructions: r.episode.instructions,
    prescribedAt: r.episode.prescribedAt as Date,
    enteredByName: r.episode.enteredByName,
    prescriber: {
      id: r.provider.id,
      name: r.provider.name,
      credentials: r.provider.credentials,
      specialty: r.provider.specialty,
    },
    prescriberRegistration: formatDoctorRegistration(r.provider),
  }))
}
