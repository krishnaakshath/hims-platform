import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, formTemplates, formSubmissions, formSubmissionScores } from '@/db/schema'
import { listFormSubmissions } from '@/lib/queries/form-submissions'

const createdSubmissionIds: number[] = []
const createdTemplateIds: number[] = []
afterEach(async () => {
  while (createdSubmissionIds.length > 0) {
    const id = createdSubmissionIds.pop()!
    await getDb().delete(formSubmissionScores).where(eq(formSubmissionScores.formSubmissionId, id))
    await getDb().delete(formSubmissions).where(eq(formSubmissions.id, id))
  }
  while (createdTemplateIds.length > 0) await getDb().delete(formTemplates).where(eq(formTemplates.id, createdTemplateIds.pop()!))
})

describe('listFormSubmissions patientId filter + score join', () => {
  it('scopes strictly to the requested patient and carries that patient\'s own score', async () => {
    const db = getDb()
    const [template] = await db.insert(formTemplates).values({
      name: `Patient Scoping Test ${Date.now()}`, category: 'Screening Questionnaires', diagnosisTag: 'Test',
      questions: [{ id: 'q1', label: 'Q', type: 'select', options: ['A', 'B'], optionScores: [0, 5], hipaaSensitive: false, required: true }],
      scoringRule: { questionIds: ['q1'], bands: [{ min: 0, max: 5, label: 'High' }] },
    }).returning()
    createdTemplateIds.push(template.id)

    const patientsRows = await db.select().from(patients).limit(2)
    const [patientA, patientB] = patientsRows

    const [subA] = await db.insert(formSubmissions).values({ templateId: template.id, patientId: patientA.id, status: 'completed', answers: { q1: 'B' } }).returning()
    createdSubmissionIds.push(subA.id)
    const [scoreA] = await db.insert(formSubmissionScores).values({ formSubmissionId: subA.id, totalScore: 5, bandLabel: 'High' }).returning()

    const [subB] = await db.insert(formSubmissions).values({ templateId: template.id, patientId: patientB.id, status: 'completed', answers: { q1: 'A' } }).returning()
    createdSubmissionIds.push(subB.id)

    const resultsForA = await listFormSubmissions({ patientId: patientA.id })
    expect(resultsForA.some((s) => s.id === subB.id)).toBe(false)
    const ownRow = resultsForA.find((s) => s.id === subA.id)
    expect(ownRow?.totalScore).toBe(5)
    expect(ownRow?.bandLabel).toBe('High')
  })
})
