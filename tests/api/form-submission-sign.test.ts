import { describe, it, expect, vi, afterEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { POST } from '@/app/api/patients/[anonId]/form-submissions/[id]/sign/route'
import { getDb } from '@/db/client'
import { formTemplates, formSubmissions, signatures, consentDocuments, formSubmissionConsents } from '@/db/schema'

const PATIENT_ID = 'RD-0001' // seeded real patient

let sessionPatientId: string | null = PATIENT_ID
vi.mock('@/lib/patient-session', async () => {
  const actual = await vi.importActual<typeof import('@/lib/patient-session')>('@/lib/patient-session')
  return {
    ...actual,
    requirePatientSession: vi.fn(async () =>
      sessionPatientId ? { patientId: sessionPatientId } : NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    ),
  }
})

const createdTemplateIds: number[] = []
const createdSubmissionIds: number[] = []
const createdConsentDocIds: number[] = []
afterEach(async () => {
  sessionPatientId = PATIENT_ID
  while (createdSubmissionIds.length > 0) {
    const id = createdSubmissionIds.pop()!
    // Scope to (signableType, signableId), not signableId alone -- on the
    // shared Neon DB an admission_discharge signature with the same small
    // integer id (plausible from a concurrent worktree run) would otherwise
    // get deleted by this suite's cleanup.
    await getDb().delete(signatures).where(and(eq(signatures.signableType, 'form_submission'), eq(signatures.signableId, id)))
    await getDb().delete(formSubmissionConsents).where(eq(formSubmissionConsents.formSubmissionId, id))
    await getDb().delete(formSubmissions).where(eq(formSubmissions.id, id))
  }
  while (createdConsentDocIds.length > 0) await getDb().delete(consentDocuments).where(eq(consentDocuments.id, createdConsentDocIds.pop()!))
  while (createdTemplateIds.length > 0) await getDb().delete(formTemplates).where(eq(formTemplates.id, createdTemplateIds.pop()!))
})

async function makeSubmission(
  category: string,
  status: 'sent' | 'partial' | 'completed' = 'partial',
  patientId: string = PATIENT_ID,
  answers?: Record<string, string>
) {
  const db = getDb()
  const [template] = await db.insert(formTemplates).values({ name: `Test ${category} ${Date.now()}`, category, diagnosisTag: 'test', questions: [] }).returning()
  createdTemplateIds.push(template.id)
  const [submission] = await db.insert(formSubmissions).values({ templateId: template.id, patientId, status, ...(answers ? { answers } : {}) }).returning()
  createdSubmissionIds.push(submission.id)
  return submission
}

function req(body: unknown) {
  return new Request('http://localhost', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
}

describe('POST /api/patients/[anonId]/form-submissions/[id]/sign', () => {
  it('signs a consent-category submission that has real answers and marks it completed', async () => {
    const submission = await makeSubmission('Consent Forms', 'partial', PATIENT_ID, { q1: 'yes' })
    const res = await POST(req({ typedName: 'Maria Alvarez' }) as never, { params: Promise.resolve({ anonId: PATIENT_ID, id: String(submission.id) }) })
    expect(res.status).toBe(200)

    const [updated] = await getDb().select().from(formSubmissions).where(eq(formSubmissions.id, submission.id))
    expect(updated.status).toBe('completed')
    const sigRows = await getDb().select().from(signatures).where(eq(signatures.signableId, submission.id))
    expect(sigRows.some((s) => s.signableType === 'form_submission' && s.signerTypedName === 'Maria Alvarez')).toBe(true)
  })

  it('rejects signing a sent-status submission that has no answers yet (Critical fix)', async () => {
    // status 'sent' with no answers set -- the patient has never opened this
    // form. Signing it would attest to content never seen, and completing it
    // would permanently kill the access token (isSubmissionTokenValid),
    // stranding the patient before they could ever answer the real questions.
    const submission = await makeSubmission('Consent Forms', 'sent')
    const res = await POST(req({ typedName: 'Maria Alvarez' }) as never, { params: Promise.resolve({ anonId: PATIENT_ID, id: String(submission.id) }) })
    expect(res.status).toBe(400)

    const [unchanged] = await getDb().select().from(formSubmissions).where(eq(formSubmissions.id, submission.id))
    expect(unchanged.status).toBe('sent')
    const sigRows = await getDb().select().from(signatures).where(and(eq(signatures.signableType, 'form_submission'), eq(signatures.signableId, submission.id)))
    expect(sigRows).toHaveLength(0)
  })

  it('rejects a non-consent-category template', async () => {
    const submission = await makeSubmission('Screening Questionnaires')
    const res = await POST(req({ typedName: 'Maria Alvarez' }) as never, { params: Promise.resolve({ anonId: PATIENT_ID, id: String(submission.id) }) })
    expect(res.status).toBe(400)
    const [unchanged] = await getDb().select().from(formSubmissions).where(eq(formSubmissions.id, submission.id))
    expect(unchanged.status).toBe('partial')
  })

  it('rejects an already-completed submission', async () => {
    const submission = await makeSubmission('Consent Forms', 'completed')
    const res = await POST(req({ typedName: 'Maria Alvarez' }) as never, { params: Promise.resolve({ anonId: PATIENT_ID, id: String(submission.id) }) })
    expect(res.status).toBe(409)
  })

  it('rejects a 201-character typedName with 400', async () => {
    const submission = await makeSubmission('Consent Forms', 'partial', PATIENT_ID, { q1: 'yes' })
    const res = await POST(req({ typedName: 'a'.repeat(201) }) as never, { params: Promise.resolve({ anonId: PATIENT_ID, id: String(submission.id) }) })
    expect(res.status).toBe(400)
  })

  it('rejects a missing typedName', async () => {
    const submission = await makeSubmission('Consent Forms')
    const res = await POST(req({}) as never, { params: Promise.resolve({ anonId: PATIENT_ID, id: String(submission.id) }) })
    expect(res.status).toBe(400)
  })

  it('rejects signing through a mismatched anonId', async () => {
    const submission = await makeSubmission('Consent Forms')
    const res = await POST(req({ typedName: 'Someone Else' }) as never, { params: Promise.resolve({ anonId: 'RD-0002', id: String(submission.id) }) })
    expect(res.status).toBe(403)
  })

  it('rejects a valid session enumerating a different patient\'s submission id', async () => {
    // Patient A (RD-0001) has a genuinely valid session AND a matching
    // anonId in the URL -- the session/URL check passes -- but the
    // submission id itself belongs to patient B (RD-0002). This is the
    // actual named attack scenario (guessing/enumerating another patient's
    // submission id), distinct from the mismatched-anonId test above, which
    // only proves the session/URL check and never reaches the row-ownership
    // check.
    const submission = await makeSubmission('Consent Forms', 'partial', 'RD-0002')
    sessionPatientId = PATIENT_ID
    const res = await POST(req({ typedName: 'Someone Else' }) as never, { params: Promise.resolve({ anonId: PATIENT_ID, id: String(submission.id) }) })
    expect(res.status).toBe(404)

    const [unchanged] = await getDb().select().from(formSubmissions).where(eq(formSubmissions.id, submission.id))
    expect(unchanged.status).toBe('partial')
  })

  it('returns 409 for a submission that has formSubmissionConsents rows, and neither completes it nor signs it', async () => {
    const submission = await makeSubmission('Consent Forms', 'partial', PATIENT_ID, { q1: 'yes' })
    const [doc] = await getDb().insert(consentDocuments).values({ name: `Test consent ${Date.now()}`, bodyText: 'Test body' }).returning()
    createdConsentDocIds.push(doc.id)
    await getDb().insert(formSubmissionConsents).values({ formSubmissionId: submission.id, consentDocumentId: doc.id, sortOrder: 0 })

    const res = await POST(req({ typedName: 'Maria Alvarez' }) as never, { params: Promise.resolve({ anonId: PATIENT_ID, id: String(submission.id) }) })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe("This form's consents are signed within the form itself")

    const [unchanged] = await getDb().select().from(formSubmissions).where(eq(formSubmissions.id, submission.id))
    expect(unchanged.status).not.toBe('completed')
    const sigRows = await getDb().select().from(signatures).where(and(eq(signatures.signableType, 'form_submission'), eq(signatures.signableId, submission.id)))
    expect(sigRows).toHaveLength(0)
  })

  it('still signs and completes a submission with zero formSubmissionConsents rows', async () => {
    const submission = await makeSubmission('Consent Forms', 'partial', PATIENT_ID, { q1: 'yes' })
    const rows = await getDb().select().from(formSubmissionConsents).where(eq(formSubmissionConsents.formSubmissionId, submission.id))
    expect(rows).toHaveLength(0)
    const res = await POST(req({ typedName: 'Maria Alvarez' }) as never, { params: Promise.resolve({ anonId: PATIENT_ID, id: String(submission.id) }) })
    expect(res.status).toBe(200)
    const [updated] = await getDb().select().from(formSubmissions).where(eq(formSubmissions.id, submission.id))
    expect(updated.status).toBe('completed')
  })
})
