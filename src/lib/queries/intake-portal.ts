import { getDb } from '@/db/client'
import { formSubmissions, formTemplates, patients } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { listConsentsForSubmission, type SubmissionConsent } from '@/lib/queries/form-submission-consents'

export type IntakePortalState = 'active' | 'expired' | 'completed' | 'not_found'

export interface IntakePortalData {
  state: IntakePortalState
  templateName?: string
  questions?: { id: string; label: string; type: 'text' | 'textarea' | 'date' | 'select' | 'checkbox'; options?: string[]; required: boolean }[]
  existingAnswers?: Record<string, string>
  autofill?: Record<string, string>
  // Present on 'active' only. Empty for a template with no attached consents,
  // so the intake flow for such a form is unchanged.
  consents?: SubmissionConsent[]
}

const AUTOFILL_SOURCE = {
  name: (p: typeof patients.$inferSelect) => p.name,
  dob: (p: typeof patients.$inferSelect) => p.dob,
  email: (p: typeof patients.$inferSelect) => p.email ?? '',
  phone: (p: typeof patients.$inferSelect) => p.phone ?? '',
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
    .select({ submission: formSubmissions, template: formTemplates, patient: patients })
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
    questions: row.template.questions.map((q) => ({ id: q.id, label: q.label, type: q.type, options: q.options, required: q.required })),
    existingAnswers: row.submission.answers ?? {},
    autofill,
    consents: await listConsentsForSubmission(row.submission.id),
  }
}

export async function getSubmissionPatientIdByToken(token: string): Promise<string | null> {
  const [row] = await getDb().select({ patientId: formSubmissions.patientId, status: formSubmissions.status, tokenExpiresAt: formSubmissions.tokenExpiresAt }).from(formSubmissions).where(eq(formSubmissions.accessToken, token))
  if (!row || !isSubmissionTokenValid(row)) return null
  return row.patientId
}
