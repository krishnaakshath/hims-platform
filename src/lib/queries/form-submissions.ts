import { getDb } from '@/db/client'
import { formSubmissions, formTemplates, formSubmissionScores, patients } from '@/db/schema'
import { eq, and, gte, lte, desc, SQL } from 'drizzle-orm'

export interface FormSubmissionFilters {
  diagnosisTag?: string
  status?: 'sent' | 'partial' | 'completed'
  dateFrom?: string
  dateTo?: string
  patientId?: string
}

export async function listFormSubmissions(filters: FormSubmissionFilters) {
  const conditions: SQL[] = []
  if (filters.status) conditions.push(eq(formSubmissions.status, filters.status))
  if (filters.dateFrom) conditions.push(gte(formSubmissions.sentDate, new Date(filters.dateFrom)))
  if (filters.dateTo) conditions.push(lte(formSubmissions.sentDate, new Date(filters.dateTo)))
  if (filters.diagnosisTag) conditions.push(eq(formTemplates.diagnosisTag, filters.diagnosisTag))
  if (filters.patientId) conditions.push(eq(formSubmissions.patientId, filters.patientId))

  const rows = await getDb()
    .select({ submission: formSubmissions, template: formTemplates, patient: patients, score: formSubmissionScores })
    .from(formSubmissions)
    .innerJoin(formTemplates, eq(formSubmissions.templateId, formTemplates.id))
    .innerJoin(patients, eq(formSubmissions.patientId, patients.id))
    .leftJoin(formSubmissionScores, eq(formSubmissionScores.formSubmissionId, formSubmissions.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(formSubmissions.sentDate))

  // Project the submission down explicitly rather than spreading the full
  // row -- `accessToken` is a 30-day unauthenticated bearer credential for
  // the intake portal, and nothing that reads this list needs it on the wire.
  return rows.map((r) => ({
    id: r.submission.id,
    templateId: r.submission.templateId,
    patientId: r.submission.patientId,
    status: r.submission.status,
    sentDate: r.submission.sentDate,
    completedDate: r.submission.completedDate,
    answers: r.submission.answers,
    templateName: r.template.name,
    diagnosisTag: r.template.diagnosisTag,
    patientName: r.patient.name,
    totalScore: r.score?.totalScore ?? null,
    bandLabel: r.score?.bandLabel ?? null,
  }))
}

export async function getFormSubmission(id: number) {
  const [row] = await getDb()
    .select({ submission: formSubmissions, template: formTemplates, patient: patients, score: formSubmissionScores })
    .from(formSubmissions)
    .innerJoin(formTemplates, eq(formSubmissions.templateId, formTemplates.id))
    .innerJoin(patients, eq(formSubmissions.patientId, patients.id))
    .leftJoin(formSubmissionScores, eq(formSubmissionScores.formSubmissionId, formSubmissions.id))
    .where(eq(formSubmissions.id, id))
  if (!row) return null
  // Same projection as listFormSubmissions -- see the comment there.
  return {
    id: row.submission.id,
    templateId: row.submission.templateId,
    patientId: row.submission.patientId,
    status: row.submission.status,
    sentDate: row.submission.sentDate,
    completedDate: row.submission.completedDate,
    answers: row.submission.answers,
    templateName: row.template.name,
    questions: row.template.questions,
    category: row.template.category,
    patientName: row.patient.name,
    totalScore: row.score?.totalScore ?? null,
    bandLabel: row.score?.bandLabel ?? null,
  }
}
