# Questionnaire Auto-Scoring — Design Spec

**Status:** Draft for review — design spec, not yet implemented.
**Position in the larger initiative:** next item in the "complete the HIMS platform" backlog — this app already has a form-template/intake system (`formTemplates`, `formSubmissions`) used for real validated psychiatric screening instruments (the category "Screening Questionnaires" already exists in this codebase's seed data), but answers are stored as free-form text with no scoring. This spec adds the scoring a screening instrument actually needs to be clinically useful (a PHQ-9 with no computed severity band is just an unscored form).

## 1. What this is, and the boundary it works within

Real validated instruments (PHQ-9 for depression, GAD-7 for anxiety — both already plausible fits for this practice's "Screening Questionnaires" category) score by summing numeric values assigned to each answer choice, then mapping the total to a named severity band via fixed, published cutoffs. This spec adds that mechanism generically: any `select`-type question in a template can optionally carry a numeric `scoreValue` per option, and a template can optionally declare a scoring rule (which questions count, and the band cutoffs). This is **not** a general rules engine — it supports exactly the sum-and-band pattern real validated screening instruments use, because that's the actual, well-established clinical need, not a speculative general case.

**Explicitly out of scope:** clinical-decision-support actions triggered by a score (e.g. auto-flagging a provider) — this spec computes and displays a score, it doesn't act on it, matching this codebase's established "software surfaces facts, a human decides" principle (already applied to eligibility verdicts, identity-match confidence, and lab-result abnormal flags elsewhere in this app). Weighted/non-linear scoring formulas beyond simple summation (no validated instrument this practice would plausibly use needs one). Retroactive rescoring of historical submissions if a template's scoring rule changes later (out of scope — a rule change applies to new submissions only, and existing scores stay as computed at the time, which is the honest historical record).

This spec adds:
1. A `scoreValue: number | null` field per option on `select`-type questions in `formTemplates.questions` (additive to the existing JSON shape — a question with no `scoreValue`s is simply not scoreable, no migration needed for existing templates).
2. A `scoringRule: { questionIds: string[]; bands: { min: number; max: number; label: string }[] } | null` field on `formTemplates` (additive column).
3. Score computation at the moment a `formSubmissions` row transitions to `status = 'completed'` (same trigger point the existing `form-chart-discrepancy` comparison already runs at, in `lib/form-chart-discrepancy.ts` or wherever that completion hook currently lives — this spec adds a second thing that happens at that same hook point, not a new trigger mechanism).
4. Display of the computed score + band on the Medical Record page's existing form-submission history section, and on the CRC/staff intake review screen.

## 2. Data model changes (additive only)

```ts
// formTemplates.questions[].options entries, when type === 'select', gain an
// optional parallel scoreValue -- represented as a second JSON shape, not a
// schema/column change (the field already lives inside the existing jsonb
// `questions` column):
//   options?: string[]              // existing
//   optionScores?: (number | null)[] // NEW, same length/order as options when present; a select question with no optionScores is simply unscored

// New column on formTemplates:
scoringRule: jsonb('scoring_rule').$type<{
  questionIds: string[]
  bands: { min: number; max: number; label: string }[]
} | null>(),
```

```ts
// New table -- one row per completed, scoreable submission. A side table
// (not columns on formSubmissions) for the same reason medicationInventory
// is separate from medications: a score is computed once at completion and
// never edited, a different write pattern from the submission's own answers
// column, which is written incrementally as the patient progresses.
export const formSubmissionScores = pgTable('form_submission_scores', {
  id: serial('id').primaryKey(),
  formSubmissionId: integer('form_submission_id').notNull().references(() => formSubmissions.id).unique(),
  totalScore: integer('total_score').notNull(),
  bandLabel: text('band_label').notNull(),
  computedAt: timestamp('computed_at').defaultNow().notNull(),
})
```

**Why `optionScores` is a parallel array by index rather than restructuring `options: string[]` into `{ label: string; score: number }[]`:** changing `options`'s shape would touch every existing question-rendering call site in this codebase (the intake form UI, the CRC review screen, any place that maps over `options` as strings today) for a feature only some questions use. A parallel, optional array is additive and leaves every non-scoring question and every existing call site untouched.

## 3. Score computation

Triggered when a `formSubmissions` row's `status` is set to `'completed'` (the existing completion path, wherever that transition currently happens — extend it, don't add a second one). If `formTemplates.scoringRule` is null, nothing happens (unscored templates are unaffected, zero behavior change for every existing template). If it's set: for each `questionId` in `scoringRule.questionIds`, look up the patient's answer in `formSubmissions.answers`, find that answer's index in the question's `options`, read the parallel `optionScores[index]` (skip/treat as 0 if the answer doesn't match any option or the question has no `optionScores` — a free-text answer to a question the scoring rule references is a template-authoring error, not a crash), sum, then find the first band where `total >= min && total <= max` and use its `label`. Insert one `formSubmissionScores` row. If a `formSubmissionScores` row already exists for this submission (re-triggered completion, which shouldn't normally happen but the code should not crash if it does), this is an upsert-or-skip — the first computed score is treated as authoritative, matching the "never silently overwrite a clinical fact" principle already applied elsewhere (e.g. encounter note signing being immutable once signed).

## 4. Seed data

Extend the existing seeded "Screening Questionnaires"-category templates (or add one if none currently has real PHQ-9/GAD-7-shaped questions — read the current seed data first, don't assume) with real, standard, published cutoffs: PHQ-9 (0-4 Minimal, 5-9 Mild, 10-14 Moderate, 15-19 Moderately Severe, 20-27 Severe) and/or GAD-7 (0-4 Minimal, 5-9 Mild, 10-14 Moderate, 15-21 Severe) — whichever instrument(s) the existing seed data's "Screening Questionnaires" templates most plausibly already represent; if none do, add one new seeded template for this rather than force-fitting an unrelated existing one.

## 5. Display

Medical Record page's existing form-submission section gains, per completed scoreable submission: "Score: 14 (Moderate)" inline with the existing entry — additive, not a new section. Same display reused on the CRC intake-review screen (wherever staff currently look at a patient's completed submissions).

## 6. Testing

`tests/lib/queries/form-submission-scoring.test.ts` (sum computation correct for a known answer set, correct band selection at exact boundary values — e.g. total=9 is Mild not Moderate for PHQ-9's cutoffs, an unscored template produces no score row, a free-text answer to a scoring-referenced question doesn't crash), `tests/api/form-submission-complete-scoring.test.ts` (completing a scoreable submission creates the score row via the real completion route, completing a non-scoreable submission does not, re-completing an already-scored submission doesn't overwrite the first score).

## 7. Role gating summary

| Action | Allowed |
|---|---|
| View a computed score | admin, pi, crc, frontdesk (matches existing chart/intake read-access precedent — a score is clinical data, same access tier as the rest of the chart) |
| Author a scoring rule on a template | admin (matches existing form-template-authoring access, not a new role) |
| Trigger score computation | Not directly user-invoked — happens automatically at submission completion, same access as completing a submission today (patient-portal for the patient's own submission) |
