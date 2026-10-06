import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, patientTrialScreenings, screeningCriteriaResults } from '@/db/schema'
import type { Verdict } from '@/lib/rule-engine'

export type TrialScreeningCriterion = typeof screeningCriteriaResults.$inferSelect

export type TrialScreeningPatient = {
  id: string
  name: string
  overallStatus: Verdict
  criteria: TrialScreeningCriterion[]
}

/**
 * Every patient currently screened against a given trial, with their full
 * set of screening criteria results attached -- the trial-level counterpart
 * to `getPatientDetail`'s per-patient criteria list. One join (patients <->
 * patientTrialScreenings <-> screeningCriteriaResults) grouped in memory by
 * patient rather than N+1 queries; the seeded roster this runs against is
 * small (a couple dozen patients across two trials), so that's not a
 * meaningful cost.
 *
 * Callers group these into "Passed" / "Needs verification" / "Rejected"
 * buckets by filtering on `overallStatus` ('green' / 'yellow' / 'red').
 */
export async function listScreeningsForTrial(trialId: string): Promise<TrialScreeningPatient[]> {
  const rows = await getDb()
    .select({ patient: patients, screening: patientTrialScreenings, criterion: screeningCriteriaResults })
    .from(patientTrialScreenings)
    .innerJoin(patients, eq(patients.id, patientTrialScreenings.patientId))
    .leftJoin(screeningCriteriaResults, eq(screeningCriteriaResults.screeningId, patientTrialScreenings.id))
    .where(eq(patientTrialScreenings.trialId, trialId))
    .orderBy(patients.id)

  const byPatient = new Map<string, TrialScreeningPatient>()
  for (const row of rows) {
    let entry = byPatient.get(row.patient.id)
    if (!entry) {
      entry = {
        id: row.patient.id,
        name: row.patient.name,
        overallStatus: row.screening.overallStatus,
        criteria: [],
      }
      byPatient.set(row.patient.id, entry)
    }
    if (row.criterion) entry.criteria.push(row.criterion)
  }
  return Array.from(byPatient.values())
}
