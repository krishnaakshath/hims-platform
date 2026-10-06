import { getDb } from '@/db/client'
import { formTemplates, formSubmissions, formSubmissionScores } from '@/db/schema'
import { eq } from 'drizzle-orm'

export interface ScorableQuestion {
  id: string
  type: string
  options?: string[]
  optionScores?: (number | null)[]
}

export interface ScoringRule {
  questionIds: string[]
  bands: { min: number; max: number; label: string }[]
}

export interface SubmissionScore {
  totalScore: number
  bandLabel: string
}

/**
 * Pure sum-and-band scoring algorithm (e.g. PHQ-9, GAD-7 style
 * questionnaires). For each questionId in scoringRule.questionIds, looks up
 * the question, finds the patient's answer's index in its `options`, and
 * reads the parallel `optionScores[index]`. A missing question, missing
 * optionScores, or a non-matching/missing answer contributes 0 rather than
 * throwing -- patient-entered free text should never crash scoring. If
 * none of the scored questions were actually answered, returns `null`
 * (no score) rather than a false "0" band -- a partially-answered
 * submission (at least one scored answer) still scores normally.
 */
export function computeScore(
  questions: ScorableQuestion[],
  scoringRule: ScoringRule | null,
  answers: Record<string, string>
): SubmissionScore | null {
  if (!scoringRule) return null

  const questionsById = new Map(questions.map((q) => [q.id, q]))

  let answeredCount = 0
  const totalScore = scoringRule.questionIds.reduce((sum, questionId) => {
    const question = questionsById.get(questionId)
    if (!question || !question.options || !question.optionScores) return sum
    const answer = answers[questionId]
    if (answer === undefined) return sum
    const optionIndex = question.options.indexOf(answer)
    if (optionIndex === -1) return sum
    const optionScore = question.optionScores[optionIndex]
    if (optionScore === null || optionScore === undefined) return sum
    answeredCount += 1
    return sum + optionScore
  }, 0)

  // Zero of the scored questions were actually answered -- a completed
  // submission with nothing to score has no score to report, not a
  // confident "0" band (e.g. PHQ-9's 0-4 "Minimal"). A *partially*-answered
  // submission (>=1 scored answer) still scores normally.
  if (answeredCount === 0) return null

  const band = scoringRule.bands.find((b) => totalScore >= b.min && totalScore <= b.max)
  // A total that falls outside every declared band (a scoring-rule
  // authoring gap) has no label to report -- treated the same as "no score"
  // rather than guessing a nearest band.
  if (!band) return null

  return { totalScore, bandLabel: band.label }
}

/**
 * Runs computeScore for a just-completed submission and persists the
 * result. Called once, right when a submission is marked 'completed' -- see
 * api/form-submissions/[id]/route.ts and api/intake/[token]/route.ts.
 *
 * Insert-or-skip: the first computed score is authoritative. A single
 * atomic INSERT ... ON CONFLICT DO NOTHING, not a read-then-write, so a
 * near-simultaneous re-trigger can't race past a separate existence check.
 */
export async function recordFormSubmissionScore(formSubmissionId: number): Promise<void> {
  const db = getDb()
  const [submission] = await db.select().from(formSubmissions).where(eq(formSubmissions.id, formSubmissionId))
  if (!submission) return
  const [template] = await db.select().from(formTemplates).where(eq(formTemplates.id, submission.templateId))
  if (!template) return

  const result = computeScore(template.questions, template.scoringRule, submission.answers ?? {})
  if (!result) return

  await db.insert(formSubmissionScores)
    .values({ formSubmissionId, totalScore: result.totalScore, bandLabel: result.bandLabel })
    .onConflictDoNothing({ target: formSubmissionScores.formSubmissionId })
}

export async function getScoreForSubmission(formSubmissionId: number): Promise<SubmissionScore | null> {
  const [row] = await getDb().select({ totalScore: formSubmissionScores.totalScore, bandLabel: formSubmissionScores.bandLabel })
    .from(formSubmissionScores).where(eq(formSubmissionScores.formSubmissionId, formSubmissionId))
  return row ?? null
}
