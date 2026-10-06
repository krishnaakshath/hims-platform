import { describe, it, expect, afterEach } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, formTemplates, formSubmissions, consentDocuments, formSubmissionConsents } from '@/db/schema'
import { deletePatient } from '@/lib/queries/patients'

// Final whole-branch review of feature/forms-redesign, I1:
// form_submission_consents.form_submission_id references form_submissions
// with no ON DELETE action, so deletePatient() FK-failed for any patient who
// had been sent a form carrying an attached consent document.
describe('deletePatient — form submission consents cleanup', () => {
  const ids: { patient?: string; template?: number; doc?: number; submission?: number; fsc?: number } = {}

  afterEach(async () => {
    const db = getDb()
    // Only reached with rows still present if deletePatient failed part-way.
    if (ids.fsc != null) await db.delete(formSubmissionConsents).where(eq(formSubmissionConsents.id, ids.fsc))
    if (ids.submission != null) await db.delete(formSubmissions).where(eq(formSubmissions.id, ids.submission))
    if (ids.patient != null) await db.delete(patients).where(eq(patients.id, ids.patient))
    if (ids.template != null) await db.delete(formTemplates).where(eq(formTemplates.id, ids.template))
    if (ids.doc != null) await db.delete(consentDocuments).where(eq(consentDocuments.id, ids.doc))
  })

  it('deletes the consent rows with the submissions and does not FK-fail', { timeout: 30000 }, async () => {
    const db = getDb()
    const testPatientId = `TEST-DEL-FSC-${Date.now()}`
    await db.insert(patients).values({ id: testPatientId, name: 'Delete Form Consent Test Patient', dob: '2000-01-01' })
    ids.patient = testPatientId
    const [template] = await db.insert(formTemplates).values({ name: `Del FSC Test ${Date.now()}`, category: 'Uncategorized', diagnosisTag: 'test', questions: [] }).returning()
    ids.template = template.id
    const [doc] = await db.insert(consentDocuments).values({ name: `Del FSC Test ${Date.now()}`, bodyText: 'x' }).returning()
    ids.doc = doc.id
    const [submission] = await db.insert(formSubmissions).values({ templateId: template.id, patientId: testPatientId, status: 'sent' }).returning()
    ids.submission = submission.id
    const [fsc] = await db.insert(formSubmissionConsents).values({ formSubmissionId: submission.id, consentDocumentId: doc.id }).returning()
    ids.fsc = fsc.id

    expect(await deletePatient(testPatientId)).toBe(true)

    expect(await db.select().from(formSubmissionConsents).where(inArray(formSubmissionConsents.id, [fsc.id]))).toHaveLength(0)
    expect(await db.select().from(formSubmissions).where(eq(formSubmissions.id, submission.id))).toHaveLength(0)
    expect(await db.select().from(patients).where(eq(patients.id, testPatientId))).toHaveLength(0)
    ids.fsc = undefined; ids.submission = undefined; ids.patient = undefined
  })
})
