import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, formTemplates, formSubmissions, formSubmissionScores } from '@/db/schema'

const createdScoreIds: number[] = []
const createdSubmissionIds: number[] = []
const createdTemplateIds: number[] = []
afterEach(async () => {
  while (createdScoreIds.length > 0) await getDb().delete(formSubmissionScores).where(eq(formSubmissionScores.id, createdScoreIds.pop()!))
  while (createdSubmissionIds.length > 0) await getDb().delete(formSubmissions).where(eq(formSubmissions.id, createdSubmissionIds.pop()!))
  while (createdTemplateIds.length > 0) await getDb().delete(formTemplates).where(eq(formTemplates.id, createdTemplateIds.pop()!))
})

describe('questionnaire scoring schema', () => {
  it('stores optionScores and scoringRule on a template, and a score row on a submission', async () => {
    const db = getDb()
    const [template] = await db.insert(formTemplates).values({
      name: 'Scoring Schema Test Template',
      category: 'Screening Questionnaires',
      diagnosisTag: 'Test',
      questions: [{ id: 'q1', label: 'Test question', type: 'select', options: ['A', 'B'], optionScores: [0, 3], hipaaSensitive: false, required: true }],
      scoringRule: { questionIds: ['q1'], bands: [{ min: 0, max: 1, label: 'Low' }, { min: 2, max: 3, label: 'High' }] },
    }).returning()
    createdTemplateIds.push(template.id)
    expect(template.scoringRule?.bands[1].label).toBe('High')

    const [patientRow] = await db.select().from(patients).limit(1)
    const [submission] = await db.insert(formSubmissions).values({ templateId: template.id, patientId: patientRow.id, status: 'completed', answers: { q1: 'B' } }).returning()
    createdSubmissionIds.push(submission.id)

    const [score] = await db.insert(formSubmissionScores).values({ formSubmissionId: submission.id, totalScore: 3, bandLabel: 'High' }).returning()
    createdScoreIds.push(score.id)
    expect(score.totalScore).toBe(3)
  })

  it('enforces one score row per submission via the unique constraint', async () => {
    const db = getDb()
    const [template] = await db.insert(formTemplates).values({
      name: 'Scoring Schema Test Template 2', category: 'Screening Questionnaires', diagnosisTag: 'Test',
      questions: [{ id: 'q1', label: 'Q', type: 'select', options: ['A'], hipaaSensitive: false, required: true }],
    }).returning()
    createdTemplateIds.push(template.id)
    const [patientRow] = await db.select().from(patients).limit(1)
    const [submission] = await db.insert(formSubmissions).values({ templateId: template.id, patientId: patientRow.id, status: 'completed' }).returning()
    createdSubmissionIds.push(submission.id)

    const [first] = await db.insert(formSubmissionScores).values({ formSubmissionId: submission.id, totalScore: 1, bandLabel: 'Low' }).returning()
    createdScoreIds.push(first.id)
    await expect(db.insert(formSubmissionScores).values({ formSubmissionId: submission.id, totalScore: 2, bandLabel: 'High' })).rejects.toThrow()
  })
})
