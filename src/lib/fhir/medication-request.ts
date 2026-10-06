import type { medicationEpisodes } from '@/db/schema'
import type { FhirReference } from './types'

export interface FhirMedicationRequest {
  resourceType: 'MedicationRequest'
  id: string
  status: 'active'
  subject: FhirReference
  medicationCodeableConcept: { text: string }
  dosageInstruction?: { text: string }[]
  authoredOn: string
}

// Composes the sig from whichever parts are present, dose -> frequency ->
// duration -> instructions, so an imported row with only `dose` set still
// produces the same single-part text it always has, and a prescribed row
// gets the fuller sig without a separate code path.
function buildDosageText(episode: typeof medicationEpisodes.$inferSelect): string | null {
  const parts: string[] = []
  if (episode.dose) parts.push(episode.dose)
  if (episode.frequencyPerDay != null) parts.push(`${episode.frequencyPerDay} times daily`)
  if (episode.durationDays != null) parts.push(`${episode.durationDays} days`)
  if (episode.instructions) parts.push(episode.instructions)
  return parts.length > 0 ? parts.join(' · ') : null
}

// Only `status === 'active'` episodes produce a resource -- spec §3 says
// "one resource per active episode." A stopped episode returns `null`.
export function medicationEpisodeToFhir(episode: typeof medicationEpisodes.$inferSelect): FhirMedicationRequest | null {
  if (episode.status !== 'active') return null
  const dosageText = buildDosageText(episode)
  return {
    resourceType: 'MedicationRequest',
    id: `medication-request-${episode.id}`,
    status: 'active',
    subject: { reference: `Patient/${episode.patientId}` },
    // No `coding` -- this app has no RxNorm data for medication episodes.
    medicationCodeableConcept: { text: `${episode.name} (${episode.medicationClass})` },
    ...(dosageText ? { dosageInstruction: [{ text: dosageText }] } : {}),
    // Prescribed rows are dated to when the prescription was written, not
    // to the medication's clinical start date -- `prescribedAt` and
    // `startDate` can differ (spec §9). Imported rows have no
    // `prescribedAt` and fall back to `startDate`, unchanged from before.
    // No `requester` reference: this export has no FHIR `Practitioner`
    // resource for a prescriber to point at.
    authoredOn: episode.prescribedAt ? episode.prescribedAt.toISOString().slice(0, 10) : episode.startDate,
  }
}

export function medicationEpisodesToFhir(rows: (typeof medicationEpisodes.$inferSelect)[]): FhirMedicationRequest[] {
  return rows.map(medicationEpisodeToFhir).filter((r): r is FhirMedicationRequest => r !== null)
}
