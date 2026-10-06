import { describe, it, expect, afterEach, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { PUT } from '@/app/api/form-submissions/[id]/route'
import { getDb } from '@/db/client'
import { formTemplates, formSubmissions, signatures } from '@/db/schema'
import { createSignature } from '@/lib/queries/signatures'

// Important #2 fix (whole-branch e-signatures review): the staff-side
// completion route (PUT /api/form-submissions/[id]) had zero signature
// requirement -- any authenticated staff member could mark a consent-category
// submission 'completed' with no attestation at all. This mirrors the
// patient-portal sign route's own gate: a consent-category submission may
// only reach 'completed' here if a form_submission signature already exists
// for it.

vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: 'crc', name: 'Jamie Ruiz' })) }))

const PATIENT_ID = 'RD-0001' // seeded real patient

const createdTemplateIds: number[] = []
const createdSubmissionIds: number[] = []
afterEach(async () => {
  while (createdSubmissionIds.length > 0) {
    const id = createdSubmissionIds.pop()!
    await getDb().delete(signatures).where(and(eq(signatures.signableType, 'form_submission'), eq(signatures.signableId, id)))
    await getDb().delete(formSubmissions).where(eq(formSubmissions.id, id))
  }
  while (createdTemplateIds.length > 0) await getDb().delete(formTemplates).where(eq(formTemplates.id, createdTemplateIds.pop()!))
})

async function makeSubmission(category: string, answers: Record<string, string> = { q1: 'yes' }) {
  const db = getDb()
  const [template] = await db.insert(formTemplates).values({ name: `Test ${category} ${Date.now()}`, category, diagnosisTag: 'test', questions: [] }).returning()
  createdTemplateIds.push(template.id)
  const [submission] = await db.insert(formSubmissions).values({ templateId: template.id, patientId: PATIENT_ID, status: 'partial', answers }).returning()
  createdSubmissionIds.push(submission.id)
  return submission
}

function req(body: unknown) {
  return new Request('http://localhost', { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
}

describe('PUT /api/form-submissions/[id] -- consent-category completion signature gate', () => {
  it('rejects completing a consent-category submission with no signature on file', async () => {
    const submission = await makeSubmission('Consent Forms')
    const res = await PUT(req({ status: 'completed' }) as never, { params: Promise.resolve({ id: String(submission.id) }) })
    expect(res.status).toBe(400)

    const [unchanged] = await getDb().select().from(formSubmissions).where(eq(formSubmissions.id, submission.id))
    expect(unchanged.status).toBe('partial')
  })

  it('allows completing a consent-category submission once a real signature exists', async () => {
    const submission = await makeSubmission('Consent Forms')
    await createSignature({
      signableType: 'form_submission',
      signableId: submission.id,
      signerTypedName: 'Maria Alvarez',
      signerRole: 'patient',
      attestationText: 'I attest that the information in this form is accurate and I consent to the terms described above.',
    })

    const res = await PUT(req({ status: 'completed' }) as never, { params: Promise.resolve({ id: String(submission.id) }) })
    expect(res.status).toBe(200)

    const [updated] = await getDb().select().from(formSubmissions).where(eq(formSubmissions.id, submission.id))
    expect(updated.status).toBe('completed')
  })

  it('does not require a signature for a non-consent-category submission (unaffected behavior)', async () => {
    const submission = await makeSubmission('Screening Questionnaires')
    const res = await PUT(req({ status: 'completed' }) as never, { params: Promise.resolve({ id: String(submission.id) }) })
    expect(res.status).toBe(200)

    const [updated] = await getDb().select().from(formSubmissions).where(eq(formSubmissions.id, submission.id))
    expect(updated.status).toBe('completed')
  })
})
