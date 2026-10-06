import { getDb } from '@/db/client'
import { medicationAdministrations, medicationEpisodes } from '@/db/schema'
import { and, asc, eq } from 'drizzle-orm'

export type MedicationAdministration = typeof medicationAdministrations.$inferSelect
export type MedicationEpisode = typeof medicationEpisodes.$inferSelect

export async function getMedicationEpisodeById(id: number): Promise<MedicationEpisode | null> {
  const [row] = await getDb().select().from(medicationEpisodes).where(eq(medicationEpisodes.id, id))
  return row ?? null
}

export interface OrderMedicationInput {
  admissionId: number
  medicationEpisodeId: number | null
  medicationName: string
  dose: string
  scheduledFor: Date
}

export async function orderMedication(input: OrderMedicationInput): Promise<MedicationAdministration> {
  const [created] = await getDb().insert(medicationAdministrations).values(input).returning()
  return created
}

export async function listMedicationsForAdmission(admissionId: number): Promise<MedicationAdministration[]> {
  return getDb().select().from(medicationAdministrations).where(eq(medicationAdministrations.admissionId, admissionId)).orderBy(asc(medicationAdministrations.scheduledFor))
}

export interface AdministerInput {
  status: 'given' | 'held' | 'refused'
  administeredByName: string
  notes: string | null
}

export interface AdministerResult {
  ok: boolean
  error?: string
}

// A row can only transition out of 'scheduled' once -- re-administering an
// already-given/held/refused row is rejected, not silently overwritten
// (real MAR safety property: you cannot double-chart a dose), enforced by
// re-checking status = 'scheduled' in the same WHERE as the id lookup
// rather than as a separate read-then-write (closes the same race class
// Front Desk's room-assignment conditional-UPDATE pattern closes elsewhere
// in this codebase). The admissionId is also part of the WHERE: the route
// layer (Step 8 below) receives both an admissionId (from the URL) and a
// medId, and without this check, a medId that actually belongs to a
// DIFFERENT admission would still succeed -- the id alone is not proof the
// caller's admissionId owns this row. A held or refused dose with no notes
// is rejected the same way an incomplete discharge's "5 D's" are --
// incomplete documentation is not a smaller version of the real thing,
// it's a different, unacceptable thing.
export async function administerMedication(id: number, admissionId: number, input: AdministerInput): Promise<AdministerResult> {
  if ((input.status === 'held' || input.status === 'refused') && !input.notes) {
    return { ok: false, error: 'A reason is required when holding or refusing a dose' }
  }

  const result = await getDb().update(medicationAdministrations).set({
    status: input.status,
    administeredAt: new Date(),
    administeredByName: input.administeredByName,
    notes: input.notes,
  }).where(and(eq(medicationAdministrations.id, id), eq(medicationAdministrations.admissionId, admissionId), eq(medicationAdministrations.status, 'scheduled')))
    .returning({ id: medicationAdministrations.id })
  return { ok: result.length > 0 }
}
