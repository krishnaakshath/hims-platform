import { getDb } from '@/db/client'
import { formTemplates, formSubmissions, medicationEpisodes, formChartDiscrepancies } from '@/db/schema'
import { eq, and } from 'drizzle-orm'
import { checkFormChartDiscrepancies } from '@/lib/form-chart-discrepancy'

/**
 * Runs the form-vs-chart discrepancy check for a just-completed submission
 * and persists any findings. Called once, right when a submission is
 * marked 'completed' -- see api/form-submissions/[id]/route.ts.
 */
export async function recordFormChartDiscrepancies(formSubmissionId: number): Promise<number> {
  const db = getDb()
  const [submission] = await db.select().from(formSubmissions).where(eq(formSubmissions.id, formSubmissionId))
  if (!submission) return 0

  const [template] = await db.select().from(formTemplates).where(eq(formTemplates.id, submission.templateId))
  if (!template) return 0

  const activeMeds = await db
    .select({ medicationClass: medicationEpisodes.medicationClass })
    .from(medicationEpisodes)
    .where(and(eq(medicationEpisodes.patientId, submission.patientId), eq(medicationEpisodes.status, 'active')))
  const activeMedicationClasses = new Set(activeMeds.map((m) => m.medicationClass))

  const findings = checkFormChartDiscrepancies(template.questions, submission.answers ?? {}, activeMedicationClasses)
  if (findings.length === 0) return 0

  await db.insert(formChartDiscrepancies).values(findings.map((f) => ({
    patientId: submission.patientId,
    formSubmissionId,
    questionId: f.questionId,
    questionLabel: f.questionLabel,
    patientAnswer: f.patientAnswer,
    chartFinding: f.chartFinding,
  })))

  return findings.length
}

export async function listDiscrepanciesForPatient(patientId: string) {
  return getDb().select().from(formChartDiscrepancies).where(eq(formChartDiscrepancies.patientId, patientId)).orderBy(formChartDiscrepancies.createdAt)
}

export async function resolveDiscrepancy(id: number, resolvedBy: string): Promise<void> {
  await getDb().update(formChartDiscrepancies).set({ resolved: true, resolvedBy, resolvedAt: new Date() }).where(eq(formChartDiscrepancies.id, id))
}
