import { getDb } from '@/db/client'
import { documents, formSubmissions, formTemplates, patients } from '@/db/schema'
import { and, eq, inArray } from 'drizzle-orm'
import { listConsentsForSubmission, type SubmissionConsent } from '@/lib/queries/form-submission-consents'
import { publicPatientColumns, type PublicPatientRow } from '@/lib/queries/patient-columns'
import { formLanguages, type FormLang, type FormQuestion } from '@/lib/forms/question-model' // WS7 T1/T3
import type { IntakeQuestion } from '@/components/intake/QuestionField' // WS7 T3

export type IntakePortalState = 'active' | 'expired' | 'completed' | 'not_found'

export interface IntakePortalData {
  state: IntakePortalState
  templateName?: string
  questions?: IntakeQuestion[] // WS7 T3: with conditions, limits and translations; never scores or chart tags
  existingAnswers?: Record<string, string>
  autofill?: Record<string, string>
  // Present on 'active' only. Empty for a template with no attached consents,
  // so the intake flow for such a form is unchanged.
  consents?: SubmissionConsent[]
  languages?: FormLang[] // WS7 T3: the template's offered languages, 'en' first
}

const AUTOFILL_SOURCE = {
  name: (p: PublicPatientRow) => p.name,
  dob: (p: PublicPatientRow) => p.dob,
  email: (p: PublicPatientRow) => p.email ?? '',
  phone: (p: PublicPatientRow) => p.phone ?? '',
} as const

// The one place "is this token still usable" is decided -- both
// getIntakePortalData and getSubmissionPatientIdByToken call this instead
// of each re-implementing the completed/expiry check, so a future change
// (a new terminal status, an off-by-one on expiry) can't update one path
// and silently leave the other path's check stale.
function isSubmissionTokenValid(row: { status: string; tokenExpiresAt: Date | null }): boolean {
  return row.status !== 'completed' && !(row.tokenExpiresAt && row.tokenExpiresAt < new Date())
}

// Deliberately returns only what a specific form's own questions need --
// never diagnoses, medications, allergies, screening verdicts, or any other
// patient field. The token scopes access to exactly this one submission.
export async function getIntakePortalData(token: string): Promise<IntakePortalData> {
  const [row] = await getDb()
    .select({ submission: formSubmissions, template: formTemplates, patient: publicPatientColumns })
    .from(formSubmissions)
    .innerJoin(formTemplates, eq(formSubmissions.templateId, formTemplates.id))
    .innerJoin(patients, eq(formSubmissions.patientId, patients.id))
    .where(eq(formSubmissions.accessToken, token))

  if (!row) return { state: 'not_found' }
  if (row.submission.status === 'completed') return { state: 'completed' }
  if (!isSubmissionTokenValid(row.submission)) return { state: 'expired' }

  const autofill: Record<string, string> = {}
  for (const q of row.template.questions) {
    if (q.autofillField) autofill[q.id] = AUTOFILL_SOURCE[q.autofillField](row.patient)
  }

  return {
    state: 'active',
    templateName: row.template.name,
    questions: row.template.questions.map(toIntakeQuestion),
    existingAnswers: row.submission.answers ?? {},
    autofill,
    consents: await listConsentsForSubmission(row.submission.id),
    languages: formLanguages(row.template.languages),
  }
}

// WS7 T3: what the patient's renderer needs of a question -- never the scoring
// (optionScores), the chart comparison tag or the autofill source.
function toIntakeQuestion(q: FormQuestion): IntakeQuestion {
  return { id: q.id, label: q.label, type: q.type, options: q.options, required: q.required, hipaaSensitive: q.hipaaSensitive, min: q.min, max: q.max, visibleIf: q.visibleIf, i18n: q.i18n }
}

export async function getSubmissionPatientIdByToken(token: string): Promise<string | null> {
  const [row] = await getDb().select({ patientId: formSubmissions.patientId, status: formSubmissions.status, tokenExpiresAt: formSubmissions.tokenExpiresAt }).from(formSubmissions).where(eq(formSubmissions.accessToken, token))
  if (!row || !isSubmissionTokenValid(row)) return null
  return row.patientId
}

// WS7 T3 ------------------------------------------------------------------

/** The submission behind a usable token (not expired, not completed) with its template's questions, else null. */
export async function getActiveIntakeSubmission(token: string): Promise<{ id: number; patientId: string; questions: FormQuestion[] } | null> {
  const [row] = await getDb()
    .select({ id: formSubmissions.id, patientId: formSubmissions.patientId, status: formSubmissions.status, tokenExpiresAt: formSubmissions.tokenExpiresAt, questions: formTemplates.questions })
    .from(formSubmissions)
    .innerJoin(formTemplates, eq(formSubmissions.templateId, formTemplates.id))
    .where(eq(formSubmissions.accessToken, token))
  if (!row || !isSubmissionTokenValid(row)) return null
  return { id: row.id, patientId: row.patientId, questions: row.questions }
}

/**
 * Which submission and patient a token names, whatever its state. Server-only:
 * the intake page uses it to decide "portal-linked" (a patient session for this
 * same patient) and never returns either id to the client.
 */
export async function getIntakeSubmissionRef(token: string): Promise<{ submissionId: number; patientId: string } | null> {
  const [row] = await getDb().select({ submissionId: formSubmissions.id, patientId: formSubmissions.patientId }).from(formSubmissions).where(eq(formSubmissions.accessToken, token))
  return row ?? null
}

/** The subset of `ids` that are documents of `patientId` (a file answer may only name the patient's own upload). */
export async function documentIdsOfPatient(patientId: string, ids: number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set()
  const rows = await getDb().select({ id: documents.id }).from(documents).where(and(eq(documents.patientId, patientId), inArray(documents.id, ids)))
  return new Set(rows.map((r) => r.id))
}
