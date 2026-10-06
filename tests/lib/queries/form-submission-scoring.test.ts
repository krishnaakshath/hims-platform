import { describe, it, expect, afterEach } from 'vitest'
import { computeScore } from '@/lib/queries/form-submission-scoring'

const phq9Questions = [
  { id: 'q1', type: 'select' as const, options: ['Not at all', 'Several days', 'More than half the days', 'Nearly every day'], optionScores: [0, 1, 2, 3] },
  { id: 'q2', type: 'select' as const, options: ['Not at all', 'Several days', 'More than half the days', 'Nearly every day'], optionScores: [0, 1, 2, 3] },
]
const rule = { questionIds: ['q1', 'q2'], bands: [{ min: 0, max: 1, label: 'Minimal' }, { min: 2, max: 3, label: 'Mild' }, { min: 4, max: 6, label: 'Moderate' }] }

describe('computeScore', () => {
  it('sums scored answers and picks the matching band', () => {
    const result = computeScore(phq9Questions, rule, { q1: 'Several days', q2: 'Several days' }) // 1 + 1 = 2
    expect(result).toEqual({ totalScore: 2, bandLabel: 'Mild' })
  })

  it('lands exactly on a band boundary correctly (Review Focus #1)', () => {
    const result = computeScore(phq9Questions, rule, { q1: 'Nearly every day', q2: 'Not at all' }) // 3 + 0 = 3, boundary of Mild (max 3), not Moderate (min 4)
    expect(result?.bandLabel).toBe('Mild')
  })

  it('treats a non-matching or missing answer as 0, not a crash (Review Focus #2)', () => {
    const result = computeScore(phq9Questions, rule, { q1: 'some free-text typo', q2: 'Nearly every day' }) // 0 + 3 = 3
    expect(result).toEqual({ totalScore: 3, bandLabel: 'Mild' })
    const resultMissing = computeScore(phq9Questions, rule, { q2: 'Nearly every day' }) // q1 missing entirely -> 0 + 3 = 3
    expect(resultMissing).toEqual({ totalScore: 3, bandLabel: 'Mild' })
  })

  it('returns null for a null scoringRule (unscored template, Review Focus #4)', () => {
    expect(computeScore(phq9Questions, null, { q1: 'Not at all' })).toBeNull()
  })

  it('returns null when none of the scored questions were actually answered (final review I4)', () => {
    // No answers at all.
    expect(computeScore(phq9Questions, rule, {})).toBeNull()
    // Answers present but none match a real option or a scored question --
    // same "nothing actually scored" case as no answers at all.
    expect(computeScore(phq9Questions, rule, { q1: 'some free-text typo', other: 'irrelevant' })).toBeNull()
  })

  it('still scores normally when only some scored questions were answered (final review I4, partial != zero)', () => {
    // Only q2 answered; q1 missing entirely. This must NOT become null --
    // only the fully-unanswered case does.
    const result = computeScore(phq9Questions, rule, { q2: 'Nearly every day' })
    expect(result).toEqual({ totalScore: 3, bandLabel: 'Mild' })
  })
})

import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, formTemplates, formSubmissions, formSubmissionScores } from '@/db/schema'
import { recordFormSubmissionScore, getScoreForSubmission } from '@/lib/queries/form-submission-scoring'

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

async function makeScorableTemplateAndSubmission(answers: Record<string, string>) {
  const db = getDb()
  const [template] = await db.insert(formTemplates).values({
    name: `Scoring Hook Test ${Date.now()}`, category: 'Screening Questionnaires', diagnosisTag: 'Test',
    questions: [{ id: 'q1', label: 'Q', type: 'select', options: ['A', 'B'], optionScores: [0, 5], hipaaSensitive: false, required: true }],
    scoringRule: { questionIds: ['q1'], bands: [{ min: 0, max: 2, label: 'Low' }, { min: 3, max: 5, label: 'High' }] },
  }).returning()
  createdTemplateIds.push(template.id)
  const [patientRow] = await db.select().from(patients).limit(1)
  const [submission] = await db.insert(formSubmissions).values({ templateId: template.id, patientId: patientRow.id, status: 'completed', answers }).returning()
  createdSubmissionIds.push(submission.id)
  return submission
}

describe('recordFormSubmissionScore (DB-hooked)', () => {
  it('inserts a score row for a scoreable submission', async () => {
    const submission = await makeScorableTemplateAndSubmission({ q1: 'B' })
    await recordFormSubmissionScore(submission.id)
    const score = await getScoreForSubmission(submission.id)
    expect(score).toEqual({ totalScore: 5, bandLabel: 'High' })
  })

  it('does not overwrite an already-computed score on a second call (Review Focus #3)', async () => {
    const submission = await makeScorableTemplateAndSubmission({ q1: 'B' })
    await recordFormSubmissionScore(submission.id)
    // Answers changed after the fact shouldn't matter -- the first score stands.
    await getDb().update(formSubmissions).set({ answers: { q1: 'A' } }).where(eq(formSubmissions.id, submission.id))
    await recordFormSubmissionScore(submission.id)
    const score = await getScoreForSubmission(submission.id)
    expect(score).toEqual({ totalScore: 5, bandLabel: 'High' })
  })

  it('is a no-op for an unscored template (Review Focus #4)', async () => {
    const db = getDb()
    const [template] = await db.insert(formTemplates).values({
      name: `Unscored Test ${Date.now()}`, category: 'Consent Forms', diagnosisTag: 'Test',
      questions: [{ id: 'q1', label: 'Q', type: 'checkbox', hipaaSensitive: false, required: true }],
    }).returning()
    createdTemplateIds.push(template.id)
    const [patientRow] = await db.select().from(patients).limit(1)
    const [submission] = await db.insert(formSubmissions).values({ templateId: template.id, patientId: patientRow.id, status: 'completed', answers: { q1: 'true' } }).returning()
    createdSubmissionIds.push(submission.id)

    await recordFormSubmissionScore(submission.id)
    expect(await getScoreForSubmission(submission.id)).toBeNull()
  })
})
