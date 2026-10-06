import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { PUT as updateSubmissionRoute } from '@/app/api/form-submissions/[id]/route'
import { getDb } from '@/db/client'
import { patients, formTemplates, formSubmissions, formSubmissionScores } from '@/db/schema'
import { getScoreForSubmission, type ScoringRule } from '@/lib/queries/form-submission-scoring'

vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: 'admin', name: 'Test Staff' })) }))

const createdTemplateIds: number[] = []
const createdSubmissionIds: number[] = []
afterEach(async () => {
  while (createdSubmissionIds.length > 0) {
    const id = createdSubmissionIds.pop()!
    await getDb().delete(formSubmissionScores).where(eq(formSubmissionScores.formSubmissionId, id))
    await getDb().delete(formSubmissions).where(eq(formSubmissions.id, id))
  }
  while (createdTemplateIds.length > 0) await getDb().delete(formTemplates).where(eq(formTemplates.id, createdTemplateIds.pop()!))
})

function req(body: unknown) {
  return new Request('http://localhost', { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
}

async function makeTemplate(scoringRule: ScoringRule | null) {
  const db = getDb()
  const [template] = await db.insert(formTemplates).values({
    name: `Route Hook Test ${Date.now()}`, category: 'Screening Questionnaires', diagnosisTag: 'Test',
    questions: [{ id: 'q1', label: 'Q', type: 'select', options: ['A', 'B'], optionScores: [0, 5], hipaaSensitive: false, required: true }],
    scoringRule,
  }).returning()
  createdTemplateIds.push(template.id)
  return template
}

describe('PUT /api/form-submissions/[id] -- scoring hook', () => {
  it('creates a score row when completing a scoreable submission via the real route', async () => {
    const template = await makeTemplate({ questionIds: ['q1'], bands: [{ min: 0, max: 5, label: 'High' }] })
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const [submission] = await getDb().insert(formSubmissions).values({ templateId: template.id, patientId: patientRow.id, status: 'sent', answers: { q1: 'B' } }).returning()
    createdSubmissionIds.push(submission.id)

    const res = await updateSubmissionRoute(req({ status: 'completed' }) as never, { params: Promise.resolve({ id: String(submission.id) }) })
    expect(res.status).toBe(200)
    expect(await getScoreForSubmission(submission.id)).toEqual({ totalScore: 5, bandLabel: 'High' })
  })

  it('does not create a score row when completing a non-scoreable submission', async () => {
    const template = await makeTemplate(null)
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const [submission] = await getDb().insert(formSubmissions).values({ templateId: template.id, patientId: patientRow.id, status: 'sent', answers: { q1: 'B' } }).returning()
    createdSubmissionIds.push(submission.id)

    const res = await updateSubmissionRoute(req({ status: 'completed' }) as never, { params: Promise.resolve({ id: String(submission.id) }) })
    expect(res.status).toBe(200)
    expect(await getScoreForSubmission(submission.id)).toBeNull()
  })

  it('does not overwrite an already-scored submission on re-completion', async () => {
    const template = await makeTemplate({ questionIds: ['q1'], bands: [{ min: 0, max: 5, label: 'High' }] })
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const [submission] = await getDb().insert(formSubmissions).values({ templateId: template.id, patientId: patientRow.id, status: 'sent', answers: { q1: 'B' } }).returning()
    createdSubmissionIds.push(submission.id)

    await updateSubmissionRoute(req({ status: 'completed' }) as never, { params: Promise.resolve({ id: String(submission.id) }) })
    // Re-trigger completion (allowed at the route level for this test's purposes) with different answers.
    await updateSubmissionRoute(req({ status: 'completed', answers: { q1: 'A' } }) as never, { params: Promise.resolve({ id: String(submission.id) }) })
    expect(await getScoreForSubmission(submission.id)).toEqual({ totalScore: 5, bandLabel: 'High' })
  })
})
