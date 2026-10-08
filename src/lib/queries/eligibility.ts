import { getDb } from '@/db/client'
import { trials, patients, diagnoses, medicationEpisodes, screeningCriteriaResults, patientTrialScreenings } from '@/db/schema'
import { eq, and, isNull, or, lt } from 'drizzle-orm'
import { liveDiagnosis } from './diagnoses' // SP6
import { evaluateEligibility } from '@/lib/eligibility'
import { evaluateCriteria, type Verdict } from '@/lib/rule-engine'
import { sendMessage } from '@/lib/queries/messages'
import { brand } from '@/lib/brand'
import { publicPatientColumns } from '@/lib/queries/patient-columns'

/**
 * The single place a screening's criteria rows get (re)computed from live
 * chart data, shared by the manual "Run Classification" action and
 * auto-classify-on-complete so there's exactly one evaluation path, not two
 * that could silently diverge. Replaces whatever criteria rows already
 * existed for this screening with a fresh set -- including for the six
 * hand-seeded demo patients, whose illustrative seed criteria get replaced
 * by real evaluated ones the first time anyone clicks Refresh/Run
 * Classification on them.
 */
export async function regenerateScreeningCriteria(patientId: string, screeningId: number, trialId: string): Promise<Verdict | null> {
  const db = getDb()
  const [trial] = await db.select().from(trials).where(eq(trials.id, trialId))
  const [patient] = await db.select(publicPatientColumns).from(patients).where(eq(patients.id, patientId))
  if (!trial || !patient) return null

  const dx = await db.select({ code: diagnoses.code, description: diagnoses.description }).from(diagnoses).where(and(eq(diagnoses.patientId, patientId), liveDiagnosis)) // SP6: voided rows hidden
  const meds = await db
    .select({ name: medicationEpisodes.name, medicationClass: medicationEpisodes.medicationClass, startDate: medicationEpisodes.startDate, status: medicationEpisodes.status })
    .from(medicationEpisodes)
    .where(eq(medicationEpisodes.patientId, patientId))

  const dob = patient.dob
  const results = evaluateEligibility(
    {
      ageMin: trial.ageMin,
      ageMax: trial.ageMax,
      diagnosisCodes: trial.diagnosisCodes,
      ratingScales: trial.ratingScales,
      medicationClasses: trial.medicationClasses,
      exclusionDiagnoses: trial.exclusionDiagnoses,
      minRatingScaleScore: trial.minRatingScaleScore,
    },
    { dob, diagnoses: dx, medications: meds, ratingScales: patient.ratingScales ?? [] }
  )

  await db.delete(screeningCriteriaResults).where(eq(screeningCriteriaResults.screeningId, screeningId))
  if (results.length > 0) {
    await db.insert(screeningCriteriaResults).values(results.map((r) => ({ screeningId, ...r })))
  }

  const overallStatus = evaluateCriteria(results)
  // A confirmation was a human's judgment about the evidence at that moment
  // (spec §3). Once the chart data changes enough to flip the computed
  // verdict away from green, that judgment has no factual basis and must be
  // re-made. selectionNotifiedAt is deliberately NOT cleared -- the patient
  // really was notified once, and that historical fact doesn't un-happen.
  await db.update(patientTrialScreenings)
    .set(overallStatus === 'green'
      ? { overallStatus }
      : { overallStatus, selectionConfirmedAt: null, selectionConfirmedByName: null })
    .where(eq(patientTrialScreenings.id, screeningId))
  return overallStatus
}

export type ConfirmSelectionResult =
  | { ok: true; screeningId: number; confirmedAt: Date; notifiedAt: Date; messageId: number }
  | { ok: false; reason: 'not_found' | 'not_green' | 'already_confirmed' | 'trial_missing' }

// Configured per deployment (brand.ts). Already-stored messages keep the sender
// name they were written with; nothing matches on this string.
export const SYSTEM_SENDER_NAME = brand.systemSenderName

export function selectionNotificationBody(trialName: string, trialSite: string): string {
  return `Great news — based on your recent screening, you've been selected to move forward with ${trialName} at ${trialSite}. A member of our care team will reach out soon to schedule your next steps.`
}

export async function confirmScreeningSelection(patientId: string, confirmedByName: string): Promise<ConfirmSelectionResult> {
  const db = getDb()
  const [screening] = await db.select().from(patientTrialScreenings).where(eq(patientTrialScreenings.patientId, patientId))
  if (!screening) return { ok: false, reason: 'not_found' }
  if (screening.overallStatus !== 'green') return { ok: false, reason: 'not_green' }

  // Resolve the trial BEFORE claiming the confirmation. The message
  // interpolates the real trial's name/site (spec §5); an unresolvable
  // trial must abort with nothing written rather than send the patient
  // "selected to move forward with undefined at undefined".
  const [trial] = await db.select().from(trials).where(eq(trials.id, screening.trialId))
  if (!trial) return { ok: false, reason: 'trial_missing' }

  // Single conditional UPDATE, same conditional-transition-guard posture as
  // administerMedication / confirmBookingRequest: only one of two racing
  // callers can win this, and only the winner goes on to notify.
  const confirmedAt = new Date()
  const claimed = await db.update(patientTrialScreenings)
    .set({ selectionConfirmedAt: confirmedAt, selectionConfirmedByName: confirmedByName })
    .where(and(
      eq(patientTrialScreenings.id, screening.id),
      eq(patientTrialScreenings.overallStatus, 'green'),
      isNull(patientTrialScreenings.selectionConfirmedAt),
    ))
    .returning({ id: patientTrialScreenings.id })
  if (claimed.length === 0) return { ok: false, reason: 'already_confirmed' }

  // The send-guard (spec §4), claimed the same conditional way. It is NOT a
  // bare `selection_notified_at IS NULL` check: selectionNotifiedAt is the
  // one field never cleared by a verdict regression (spec §3), so a bare
  // NULL check would permanently swallow the legitimate second notification
  // after a reconfirmation. "Not yet notified FOR THIS confirmation" is the
  // real invariant, and on a first confirmation it reduces to the NULL check.
  const notifiedAt = new Date()
  const claimedNotify = await db.update(patientTrialScreenings)
    .set({ selectionNotifiedAt: notifiedAt })
    .where(and(
      eq(patientTrialScreenings.id, screening.id),
      or(
        isNull(patientTrialScreenings.selectionNotifiedAt),
        lt(patientTrialScreenings.selectionNotifiedAt, patientTrialScreenings.selectionConfirmedAt),
      ),
    ))
    .returning({ id: patientTrialScreenings.id })
  if (claimedNotify.length === 0) return { ok: false, reason: 'already_confirmed' }

  const created = await sendMessage(patientId, 'system', SYSTEM_SENDER_NAME, selectionNotificationBody(trial.name, trial.site))
  return { ok: true, screeningId: screening.id, confirmedAt, notifiedAt, messageId: created.id }
}
