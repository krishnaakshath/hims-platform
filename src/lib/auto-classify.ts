import { getDb } from '@/db/client'
import { patients, patientTrialScreenings, diagnoses, medicationEpisodes } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { regenerateScreeningCriteria } from '@/lib/queries/eligibility'
import { getAppSettings } from '@/lib/queries/settings'
import { invalidateCache, patientDetailCacheKey, patientListCacheKey } from '@/lib/cache'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'

// Called after a form submission is marked 'completed'. If the
// autoClassifyOnComplete setting is on, and this patient now has both
// completed intake data and at least some chart data (a diagnosis or a
// medication on file), re-runs the same rule-engine evaluation the manual
// "Run Classification" action uses — never a separate, divergent scoring
// path. If the setting is off, or the patient has no screening row yet
// (nothing to re-evaluate against), this is a no-op.
//
// Takes the caller's session so a real, attributable audit-log entry can be
// written when a classification actually runs -- a safety-critical,
// unattended verdict change is exactly the kind of event this product's
// audit trail exists to record, matching the manual "Run Classification"
// endpoint's own logAudit call rather than leaving auto-classification as
// the one write path with no audit record.
export async function maybeAutoClassify(patientId: string, session: Session): Promise<void> {
  const settings = await getAppSettings()
  if (!settings.autoClassifyOnComplete) return

  const dx = await getDb().select().from(diagnoses).where(eq(diagnoses.patientId, patientId))
  const meds = await getDb().select().from(medicationEpisodes).where(eq(medicationEpisodes.patientId, patientId))
  if (dx.length === 0 && meds.length === 0) return  // no chart data yet — nothing to classify against

  const [screening] = await getDb().select().from(patientTrialScreenings).where(eq(patientTrialScreenings.patientId, patientId))
  if (!screening) return  // no trial screening exists yet for this patient — manual assignment to a trial happens first

  const overallStatus = await regenerateScreeningCriteria(patientId, screening.id, screening.trialId)
  await getDb().update(patients).set({ chartDataAsOf: new Date() }).where(eq(patients.id, patientId))

  await invalidateCache(patientDetailCacheKey(patientId))
  await invalidateCache(patientListCacheKey(screening.trialId))
  await invalidateCache(patientListCacheKey(null))

  await logAudit(session, `auto-classified patient (status: ${overallStatus})`, patientId)
}
