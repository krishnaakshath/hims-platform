import { getDb } from '@/db/client'
import { medicationEpisodes, providers } from '@/db/schema'
import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import type { SessionProvider } from '@/lib/provider-identity'

export interface CreatePrescriptionInput {
  patientId: string
  medicationId: number | null
  name: string
  medicationClass: string
  dose: string | null
  frequencyPerDay: number
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
  }))
}
