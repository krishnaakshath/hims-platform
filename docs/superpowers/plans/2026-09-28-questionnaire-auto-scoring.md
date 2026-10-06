# Questionnaire Auto-Scoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give validated screening-instrument templates (PHQ-9, GAD-7) real sum-and-band scoring — computed once at submission completion, off the same hook the existing form-vs-chart discrepancy check already runs at — and show the computed score inline wherever a completed submission is already displayed.

**Architecture:** `optionScores` is an additive parallel array inside the existing `formTemplates.questions` jsonb shape (no schema/column change — a TS type change only). `scoringRule` is a new nullable jsonb column on `formTemplates`. `formSubmissionScores` is a one-to-one side table (unique FK on `formSubmissionId`) rather than columns on `formSubmissions`, because a score is computed once and never edited — a different write pattern from `answers`, which is written incrementally as the patient progresses (same reasoning already applied to `medicationInventory`/`medications` in the sibling Pharmacy plan). Computation hooks into the two existing places a `formSubmissions` row transitions to `status = 'completed'`, right alongside the existing `recordFormChartDiscrepancies` call — not a new trigger mechanism.

**Tech Stack:** Next.js 16 App Router (Server Components) + Drizzle ORM over a `pg` Pool (additive-only schema changes via a hand-written one-off script, never `drizzle-kit push`) + Tailwind v4 oklch tokens.

**Spec:** `docs/superpowers/specs/2026-09-28-questionnaire-auto-scoring.md`

**Working directory note:** this plan is executed in an isolated git worktree at `/Users/k2a/Desktop/clinsync/.worktrees/questionnaire-scoring` on branch `feature/questionnaire-scoring`, forked from `hims-platform`. This worktree has its own `.env.local` and `node_modules` already set up. Every implementer/reviewer dispatch for this plan must work from this exact directory, not the main checkout — the main checkout and other worktrees (`.worktrees/lab-orders-results`, `.worktrees/pharmacy-med-inventory`, etc.) have their own concurrent work in flight; do not touch them.

## Global Constraints

- Additive-only schema changes. Apply via a hand-written one-off script run with `npx dotenv -e .env.local -- npx tsx <script>` — never `drizzle-kit push`. This is a **single shared Neon Postgres database across every branch/worktree** — a schema mistake here is visible everywhere immediately, including the main checkout and every other active worktree.
- `psql` is not installed in this environment — verify a migration's live-DB effect with a Node script using `pg`'s `Pool` and an `information_schema.columns`/row-count query.
- Score computation is **not** a user-invoked write action (spec §7) — it is a side effect of the existing submission-completion routes, which are already `.strict()`-validated and already call `requireSession()`/token-auth and `logAudit()`/`logPatientPortalAction()`. No new API route, no new role gate, no new audit-log call is needed for the computation itself.
- Every protected route/page starts with `requireSession()` (API routes) or `requireSessionOrRedirect()` (pages) as its first statement — unchanged by this plan, since no new routes/pages are added, only existing ones modified.
- Role gating per spec §7: viewing a computed score = admin, pi, crc, frontdesk (same tier as the rest of the chart — both display surfaces this plan touches are already gated at that tier).
- Retroactive rescoring is explicitly out of scope (spec §1) — a `scoringRule` change applies to new completions only; this plan never writes to `formSubmissionScores` for an already-scored submission.
- Seed data goes in `src/db/seed.ts`. Extending an existing template's `questions`/`scoringRule` must be done idempotently (guard on the value not already being set) since `seed.ts` may run more than once against the shared database.
- Commit messages end with no attribution trailer.
- UI verification discipline: verify via a real running dev server hit with real HTTP requests (mint a session cookie the way `src/lib/auth.ts` actually does it — `SignJWT` under cookie `clinsync_demo_session`, secret from `SESSION_SECRET`), with actual commands and actual output pasted in the report. Never a narrated, unreproduced claim — a prior implementer fabricated UI verification evidence earlier this session and was caught; this session enforces zero tolerance for that.
- Vitest invocation: `npx dotenv -e .env.local -- npx vitest run <path>` (`fileParallelism: false`).

## Review Focus

1. **A total landing exactly on a band boundary** — PHQ-9 total=9 must resolve to "Mild" (band 5-9), not "Moderate" (band 10-14); an off-by-one in the `>=`/`<=` comparison silently misclassifies a real patient's severity. (Task 2)
2. **A scoring-rule-referenced question whose answer doesn't match any of its `options`** (blank, free-text typo, or answer to a question that was edited after the rule was authored) — must be treated as contributing 0 to the sum, not thrown as a crash that blocks the entire completion route. (Task 2)
3. **Re-triggered completion on an already-scored submission** — the first computed score is authoritative and must never be silently overwritten by a second completion call (matches this codebase's "never silently overwrite a clinical fact" precedent, e.g. immutable signed encounter notes). (Task 2)
4. **An unscored template completing** (`scoringRule` is null — every template except the two this plan seeds) — must produce zero rows in `formSubmissionScores` and must not change the completion route's existing behavior or response in any way. (Task 2)
5. **Two patients' scored submissions staying independent on the Medical Record page** — the per-patient query must key strictly off `patientId`, no shared/cached bleed, matching this session's established review-focus pattern for every prior patient-scoped display (Pharmacy's dispense history, Lab Orders' results section). (Task 3)

---

### Task 1: Schema — `optionScores`, `scoringRule`, `formSubmissionScores`, seed data

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/seed.ts`
- Test: `tests/db/questionnaire-scoring-schema.test.ts`

**Interfaces:**
- Produces: `formTemplates.questions[].optionScores?: (number | null)[]` (TS type addition, same jsonb column), `formTemplates.scoringRule: { questionIds: string[]; bands: { min: number; max: number; label: string }[] } | null` (new jsonb column), `formSubmissionScores` table (`id, formSubmissionId, totalScore, bandLabel, computedAt`). Consumed by Tasks 2-3.

- [ ] **Step 1: Read the current seeded "PHQ-9 (Depression Screening)" and "ASRS-v1.1 (ADHD Screening)" templates**

Already read during planning research: `src/db/seed.ts` lines ~892-907. Findings, recorded here so the implementer doesn't have to re-derive them:
- **PHQ-9 (Depression Screening)** (category `Screening Questionnaires`, diagnosisTag `Major Depressive Disorder`) already exists with 2 of the real PHQ-9's 9 items (`q1`: "Little interest or pleasure in doing things", `q2`: "Feeling down, depressed, or hopeless"), both `type: 'select'` with the real PHQ-9 4-point option set (`'Not at all'`, `'Several days'`, `'More than half the days'`, `'Nearly every day'`) already verbatim. This is a real, plausible partial PHQ-9 — extend it to the full 9 items rather than adding a new template.
- **ASRS-v1.1 (ADHD Screening)** is an ADHD instrument, not GAD-7-shaped, and has different response options (`'Never'`...`'Very Often'`) — it is **not** a plausible GAD-7 fit and must not be force-fitted. No existing template represents GAD-7. Per spec §4 ("if none do, add one new seeded template for this rather than force-fitting an unrelated existing one"), this task adds a new **GAD-7 (Anxiety Screening)** template.
- No `formSubmissions` row currently references either the PHQ-9 or ASRS-v1.1 template by id (the seeded submissions for `mddTemplate`/`adhdTemplate` are a *different*, trial-specific pair of templates defined earlier in `seed.ts` — don't confuse the two). Extending PHQ-9's `questions` array is therefore safe: no existing submission's `answers` keys collide with the new `q3`-`q9` ids.

- [ ] **Step 2: Write the failing test**

Create `tests/db/questionnaire-scoring-schema.test.ts`:

```ts
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
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/questionnaire-scoring-schema.test.ts`
Expected: FAIL — `scoringRule` not a valid column/type, `formSubmissionScores` not exported.

- [ ] **Step 4: Add the schema definitions**

In `src/db/schema.ts`, extend the `formTemplates.questions` jsonb `$type` (find the existing `options?: string[]` line, add directly after it):

```ts
    options?: string[]
    optionScores?: (number | null)[] // NEW -- same length/order as options when present; a select question with no optionScores is simply unscored
```

Add a new column to `formTemplates` (same table, after `questions`):

```ts
  scoringRule: jsonb('scoring_rule').$type<{
    questionIds: string[]
    bands: { min: number; max: number; label: string }[]
  } | null>(),
```

Add the new table near `formChartDiscrepancies` (same file, same section as the other `formSubmissions`-adjacent tables):

```ts
// One row per completed, scoreable submission. A side table, not columns on
// formSubmissions -- a score is computed once at completion and never
// edited, a different write pattern from `answers`, which is written
// incrementally as the patient progresses. See lib/queries/form-submission-scoring.ts.
export const formSubmissionScores = pgTable('form_submission_scores', {
  id: serial('id').primaryKey(),
  formSubmissionId: integer('form_submission_id').notNull().references(() => formSubmissions.id).unique(),
  totalScore: integer('total_score').notNull(),
  bandLabel: text('band_label').notNull(),
  computedAt: timestamp('computed_at').defaultNow().notNull(),
})
```

- [ ] **Step 5: Run the test again — expect a different failure**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/questionnaire-scoring-schema.test.ts`
Expected: FAIL — now a runtime DB error (`column "scoring_rule" does not exist` / relation `form_submission_scores` does not exist), not a type error.

- [ ] **Step 6: Write and run the one-off migration script**

Scratch, not part of the repo. Create `migrate-questionnaire-scoring-scratch.ts` at this worktree's root:

```ts
import { Pool } from 'pg'

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false } })

  await pool.query(`ALTER TABLE form_templates ADD COLUMN IF NOT EXISTS scoring_rule JSONB`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS form_submission_scores (
      id SERIAL PRIMARY KEY,
      form_submission_id INTEGER NOT NULL UNIQUE REFERENCES form_submissions(id),
      total_score INTEGER NOT NULL,
      band_label TEXT NOT NULL,
      computed_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `)

  console.log('Questionnaire scoring migration complete.')
  await pool.end()
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1) })
```

Run: `npx dotenv -e .env.local -- npx tsx migrate-questionnaire-scoring-scratch.ts`. If blocked by the permission classifier: stop, report it, do not retry with variations.

Verify with a Node script (no `psql` here): `SELECT column_name FROM information_schema.columns WHERE table_name = 'form_templates' AND column_name = 'scoring_rule'` and `SELECT column_name FROM information_schema.columns WHERE table_name = 'form_submission_scores'`.

Delete the scratch script once confirmed: `rm migrate-questionnaire-scoring-scratch.ts`.

- [ ] **Step 7: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/questionnaire-scoring-schema.test.ts`
Expected: PASS (both tests).

- [ ] **Step 8: Extend the seeded PHQ-9 template to the full 9 items with `optionScores` and `scoringRule`**

In `src/db/seed.ts`, replace the `'PHQ-9 (Depression Screening)'` template object's `questions` array (currently `q1`, `q2` only) with the real PHQ-9's 9 items, all `type: 'select'`, all sharing the existing option set (`'Not at all'`, `'Several days'`, `'More than half the days'`, `'Nearly every day'`) with `optionScores: [0, 1, 2, 3]`:

1. `q1` Little interest or pleasure in doing things (already present — add `optionScores`)
2. `q2` Feeling down, depressed, or hopeless (already present — add `optionScores`)
3. `q3` Trouble falling or staying asleep, or sleeping too much
4. `q4` Feeling tired or having little energy
5. `q5` Poor appetite or overeating
6. `q6` Feeling bad about yourself — or that you are a failure or have let yourself or your family down
7. `q7` Trouble concentrating on things, such as reading or watching television
8. `q8` Moving or speaking so slowly that other people could have noticed, or the opposite — being so fidgety or restless that you have been moving around a lot more than usual
9. `q9` Thoughts that you would be better off dead, or of hurting yourself in some way

Add `scoringRule: { questionIds: ['q1','q2','q3','q4','q5','q6','q7','q8','q9'], bands: [{ min: 0, max: 4, label: 'Minimal' }, { min: 5, max: 9, label: 'Mild' }, { min: 10, max: 14, label: 'Moderate' }, { min: 15, max: 19, label: 'Moderately Severe' }, { min: 20, max: 27, label: 'Severe' }] }` (spec §4's exact published cutoffs) to the same template object.

- [ ] **Step 9: Add a new seeded GAD-7 template**

In the same `db.insert(formTemplates).values([...])` array, add a new entry after ASRS-v1.1:

```ts
{
  name: 'GAD-7 (Anxiety Screening)',
  category: 'Screening Questionnaires',
  diagnosisTag: 'Generalized Anxiety Disorder',
  questions: [
    { id: 'q1', label: 'Feeling nervous, anxious, or on edge', type: 'select', options: ['Not at all', 'Several days', 'More than half the days', 'Nearly every day'], optionScores: [0, 1, 2, 3], hipaaSensitive: true, required: true },
    { id: 'q2', label: 'Not being able to stop or control worrying', type: 'select', options: ['Not at all', 'Several days', 'More than half the days', 'Nearly every day'], optionScores: [0, 1, 2, 3], hipaaSensitive: true, required: true },
    { id: 'q3', label: 'Worrying too much about different things', type: 'select', options: ['Not at all', 'Several days', 'More than half the days', 'Nearly every day'], optionScores: [0, 1, 2, 3], hipaaSensitive: true, required: true },
    { id: 'q4', label: 'Trouble relaxing', type: 'select', options: ['Not at all', 'Several days', 'More than half the days', 'Nearly every day'], optionScores: [0, 1, 2, 3], hipaaSensitive: true, required: true },
    { id: 'q5', label: "Being so restless that it's hard to sit still", type: 'select', options: ['Not at all', 'Several days', 'More than half the days', 'Nearly every day'], optionScores: [0, 1, 2, 3], hipaaSensitive: true, required: true },
    { id: 'q6', label: 'Becoming easily annoyed or irritable', type: 'select', options: ['Not at all', 'Several days', 'More than half the days', 'Nearly every day'], optionScores: [0, 1, 2, 3], hipaaSensitive: true, required: true },
    { id: 'q7', label: 'Feeling afraid as if something awful might happen', type: 'select', options: ['Not at all', 'Several days', 'More than half the days', 'Nearly every day'], optionScores: [0, 1, 2, 3], hipaaSensitive: true, required: true },
  ],
  scoringRule: { questionIds: ['q1','q2','q3','q4','q5','q6','q7'], bands: [{ min: 0, max: 4, label: 'Minimal' }, { min: 5, max: 9, label: 'Mild' }, { min: 10, max: 14, label: 'Moderate' }, { min: 15, max: 21, label: 'Severe' }] },
},
```

(GAD-7's published bands, spec §4: 0-4 Minimal, 5-9 Mild, 10-14 Moderate, 15-21 Severe.)

- [ ] **Step 10: Confirm the seed changes are idempotent by inspection**

`seed.ts`'s existing `db.insert(formTemplates).values([...])` block is a one-time insert executed by a script this plan does not run against the shared database (same discipline as the sibling Lab Orders and Pharmacy plans — do NOT run `npm run db:seed` against the live shared dev database as part of this task). Read the block to confirm the new/edited template objects are syntactically valid TypeScript and match the schema's `$type` shape; do not execute it.

- [ ] **Step 11: Extend the form-template authoring routes' Zod schemas to accept the new fields**

`src/app/api/form-templates/route.ts` (`questionSchema`/`createTemplateSchema`) and `src/app/api/form-templates/[id]/route.ts` (`updateTemplateSchema`'s inline question object) are the existing `.strict()`-validated routes an admin uses to author/edit a template (spec §7: "Author a scoring rule on a template | admin — matches existing form-template-authoring access, not a new role"). Neither route currently has any role check beyond `requireSession()` (any authenticated session can POST/PUT a template today) — that's this route's existing, pre-this-plan behavior; do not add a new role gate that doesn't already exist here, just extend the schema so the field is authorable at all:

- Add `optionScores: z.array(z.number().nullable()).optional()` to both `questionSchema` (in `route.ts`) and the inline question object (in `[id]/route.ts`).
- Add `scoringRule: z.object({ questionIds: z.array(z.string()), bands: z.array(z.object({ min: z.number(), max: z.number(), label: z.string() })) }).nullable().optional()` to both `createTemplateSchema` and `updateTemplateSchema`.

Without this, `.strict()` rejects any POST/PUT payload that includes these fields, and a template's scoring rule could only ever be set by direct seed/DB edit — not through the app the way every other template field already is.

- [ ] **Step 12: Commit**

```bash
git add src/db/schema.ts src/db/seed.ts src/app/api/form-templates/route.ts "src/app/api/form-templates/[id]/route.ts" tests/db/questionnaire-scoring-schema.test.ts
git commit -m "feat: add optionScores/scoringRule fields and form_submission_scores table with PHQ-9/GAD-7 seed data

"```

---

### Task 2: Score computation + completion-hook wiring

**Files:**
- Create: `src/lib/queries/form-submission-scoring.ts`
- Modify: `src/app/api/intake/[token]/route.ts`
- Modify: `src/app/api/form-submissions/[id]/route.ts`
- Test: `tests/lib/queries/form-submission-scoring.test.ts`, `tests/api/form-submission-complete-scoring.test.ts`

**Interfaces:**
- Consumes: `formTemplates`, `formSubmissions`, `formSubmissionScores` from `@/db/schema` (Task 1).
- Produces: `computeScore(questions, scoringRule, answers)` (pure), `recordFormSubmissionScore(formSubmissionId: number): Promise<void>`, `getScoreForSubmission(formSubmissionId: number): Promise<{ totalScore: number; bandLabel: string } | null>` from `@/lib/queries/form-submission-scoring` — consumed by Task 3 and by both completion routes.

- [ ] **Step 1: Write the failing tests — pure scoring algorithm**

Create `tests/lib/queries/form-submission-scoring.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
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
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/form-submission-scoring.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `computeScore` in `src/lib/queries/form-submission-scoring.ts`**

```ts
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

export function computeScore(
  questions: ScorableQuestion[],
  scoringRule: ScoringRule | null,
  answers: Record<string, string>
): SubmissionScore | null {
  if (!scoringRule) return null
  // implement per spec §3: for each questionId in scoringRule.questionIds,
  // look up the question, find the patient's answer's index in its
  // `options`, read the parallel `optionScores[index]`; treat a missing
  // question, missing optionScores, or a non-matching/missing answer as 0
  // (never throw). Sum, then return the first band where
  // total >= min && total <= max, using scoringRule.bands' declared order.
}
```

One line on the approach: build a `Map<string, ScorableQuestion>` from `questions` by `id` once, then reduce over `scoringRule.questionIds`.

- [ ] **Step 4: Run the pure-algorithm tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/form-submission-scoring.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing tests — DB-hooked `recordFormSubmissionScore` and `getScoreForSubmission`**

Append to `tests/lib/queries/form-submission-scoring.test.ts`:

```ts
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
```

- [ ] **Step 6: Run to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/form-submission-scoring.test.ts`
Expected: FAIL — `recordFormSubmissionScore`/`getScoreForSubmission` not exported.

- [ ] **Step 7: Implement `recordFormSubmissionScore` and `getScoreForSubmission`**

```ts
import { getDb } from '@/db/client'
import { formTemplates, formSubmissions, formSubmissionScores } from '@/db/schema'
import { eq } from 'drizzle-orm'

export async function recordFormSubmissionScore(formSubmissionId: number): Promise<void> {
  const db = getDb()
  const [submission] = await db.select().from(formSubmissions).where(eq(formSubmissions.id, formSubmissionId))
  if (!submission) return
  const [template] = await db.select().from(formTemplates).where(eq(formTemplates.id, submission.templateId))
  if (!template) return

  const result = computeScore(template.questions, template.scoringRule, submission.answers ?? {})
  if (!result) return

  // Insert-or-skip: the first computed score is authoritative (Review Focus
  // #3). A single atomic INSERT ... ON CONFLICT DO NOTHING, not a
  // read-then-write, so a near-simultaneous re-trigger can't race past this
  // check the way a separate existence check + insert could.
  await db.insert(formSubmissionScores)
    .values({ formSubmissionId, totalScore: result.totalScore, bandLabel: result.bandLabel })
    .onConflictDoNothing({ target: formSubmissionScores.formSubmissionId })
}

export async function getScoreForSubmission(formSubmissionId: number): Promise<SubmissionScore | null> {
  const [row] = await getDb().select({ totalScore: formSubmissionScores.totalScore, bandLabel: formSubmissionScores.bandLabel })
    .from(formSubmissionScores).where(eq(formSubmissionScores.formSubmissionId, formSubmissionId))
  return row ?? null
}
```

- [ ] **Step 8: Run the query-layer tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/form-submission-scoring.test.ts`
Expected: PASS (7 tests total).

- [ ] **Step 9: Write the failing test — completion-route hook wiring**

Create `tests/api/form-submission-complete-scoring.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { PUT as updateSubmissionRoute } from '@/app/api/form-submissions/[id]/route'
import { getDb } from '@/db/client'
import { patients, formTemplates, formSubmissions, formSubmissionScores } from '@/db/schema'
import { getScoreForSubmission } from '@/lib/queries/form-submission-scoring'

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

async function makeTemplate(scoringRule: unknown) {
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
```

- [ ] **Step 10: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/form-submission-complete-scoring.test.ts`
Expected: FAIL — no score row is created (the hook isn't wired yet).

- [ ] **Step 11: Wire `recordFormSubmissionScore` into both completion routes**

In `src/app/api/form-submissions/[id]/route.ts`, in the `if (parsed.data.status === 'completed')` branch, add a call to `recordFormSubmissionScore(Number(id))` alongside the existing `recordFormChartDiscrepancies(Number(id))` call (either order is fine — they're independent). Import it from `@/lib/queries/form-submission-scoring`.

In `src/app/api/intake/[token]/route.ts`, in the `if (parsed.data.complete)` branch, add the same call: `await recordFormSubmissionScore(updated[0].id)` alongside the existing `recordFormChartDiscrepancies(updated[0].id)` call. Import it from `@/lib/queries/form-submission-scoring`.

- [ ] **Step 12: Run all this task's tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/form-submission-scoring.test.ts tests/api/form-submission-complete-scoring.test.ts`
Expected: PASS (10 tests total).

- [ ] **Step 13: Commit**

```bash
git add src/lib/queries/form-submission-scoring.ts src/app/api/intake/\[token\]/route.ts src/app/api/form-submissions/\[id\]/route.ts tests/lib/queries/form-submission-scoring.test.ts tests/api/form-submission-complete-scoring.test.ts
git commit -m "feat: compute PHQ-9/GAD-7 style scores at submission completion

"```

---

### Task 3: Display — Client Forms (CRC/staff review) and Medical Record page

**Files:**
- Modify: `src/lib/queries/form-submissions.ts`
- Modify: `src/components/ClientFormsTable.tsx`
- Modify: `src/app/(dashboard)/client-forms/[id]/page.tsx`
- Modify: `src/app/(dashboard)/patients/[anonId]/medical-record/page.tsx`
- Test: `tests/lib/queries/form-submissions-patient-scoping.test.ts` — the rest of this task is UI wiring over already-tested query/scoring logic, verified per this plan's UI verification discipline.

**Interfaces:**
- Consumes: `getScoreForSubmission(formSubmissionId)` (Task 2, used indirectly via the join below).

**A note on the Medical Record page, read this before starting:** the spec (§5) describes the Medical Record page as already having "an existing form-submission section." As of this worktree's current state it does not — the page (`src/app/(dashboard)/patients/[anonId]/medical-record/page.tsx`) has Dual-Sourced Fields, Diagnoses, Medication History, Medications Dispensed, Allergies, Insurance, and Notes sections, but no section listing a patient's `formSubmissions` at all. The actual "wherever staff currently look at a patient's completed submissions" surface in this codebase is **Client Forms** (`/client-forms` list + `/client-forms/[id]` detail), which already exists and is CRC/PI-visible. This task therefore: (a) adds the score display to Client Forms, the surface that actually exists and matches the spec's intent, and (b) adds a small new, additive "Screening Questionnaires" section to the Medical Record page — scoped to just this patient's scoreable submissions — so the spec's explicit naming of the Medical Record page as a display surface (§5) is still honored, without inventing an unrelated general form-submission-history feature that isn't otherwise in scope.

- [ ] **Step 1: Write the failing test — patient-scoped filtering stays independent (Review Focus #5)**

Create `tests/lib/queries/form-submissions-patient-scoping.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/form-submissions-patient-scoping.test.ts`
Expected: FAIL — `FormSubmissionFilters` has no `patientId`, and the returned rows have no `totalScore`/`bandLabel`.

- [ ] **Step 3: Add score fields and the `patientId` filter to the shared submission query layer**

In `src/lib/queries/form-submissions.ts`:
- Add `patientId?: string` to `FormSubmissionFilters` and push `eq(formSubmissions.patientId, filters.patientId)` into `conditions` when set (additive — every existing caller that doesn't pass it is unaffected).
- In both `listFormSubmissions` and `getFormSubmission`, left-join `formSubmissionScores` (`leftJoin(formSubmissionScores, eq(formSubmissionScores.formSubmissionId, formSubmissions.id))`) and add `totalScore: r.score?.totalScore ?? null` / `bandLabel: r.score?.bandLabel ?? null` to the returned projection (name the joined table alias `score` in the `.select({...})` call). Import `formSubmissionScores` from `@/db/schema`.

- [ ] **Step 4: Run it to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/form-submissions-patient-scoping.test.ts`
Expected: PASS.

- [ ] **Step 5: Add score display to the Client Forms list**

In `src/components/ClientFormsTable.tsx`, add `totalScore: number | null` and `bandLabel: string | null` to `ClientFormRow`. In the table body, in the existing Status `<td>`, append inline (per spec §5's "additive inline text, not a new section/column"): when `bandLabel` is not null, render `· Score: {totalScore} ({bandLabel})` after the status text, in the same cell.

In `src/app/(dashboard)/client-forms/page.tsx`, no change needed beyond what `listFormSubmissions` now returns (the object passed to `<ClientFormsTable submissions={submissions} />` already carries the new fields once Step 3 lands) — confirm the `ClientFormRow` type and the `listFormSubmissions` return type still line up; adjust field names only if they don't match.

- [ ] **Step 6: Add score display to the Client Forms detail page**

In `src/app/(dashboard)/client-forms/[id]/page.tsx`, in the header line that currently reads `{submission.patientName} · <span className="capitalize">{submission.status}</span>`, add (when `submission.bandLabel` is not null): `· Score: {submission.totalScore} ({submission.bandLabel})` — same inline pattern, no new section.

- [ ] **Step 7: Add the "Screening Questionnaires" section to the Medical Record page**

In `src/app/(dashboard)/patients/[anonId]/medical-record/page.tsx`, fetch `const screeningSubmissions = await listFormSubmissions({ patientId: anonId, status: 'completed' })` alongside the page's existing data fetches (using the `patientId` filter added in Step 3), then filter client-side (or add a second filter param, implementer's call) to submissions whose `diagnosisTag`/template `category` is `'Screening Questionnaires'` — or, simpler and sufficient: just filter to rows where `bandLabel !== null` (i.e., only show ones that actually got scored, which is exactly the scoreable-and-completed subset this section is for). Add a new `<section className={SECTION}>` titled "Screening Questionnaires" listing each: template name, completed date, and `Score: {totalScore} ({bandLabel})` inline — matching this file's existing list-item style (see the "Medications Dispensed" section immediately above it for the pattern to copy). If there are none, render the file's existing empty-state text pattern (e.g. "No screening questionnaires completed.").

- [ ] **Step 8: Verify via a real running dev server, not narration**

Start the dev server, mint a staff session cookie per Global Constraints, and:
1. `GET` the intake portal data for a seeded, not-yet-completed PHQ-9 or GAD-7 submission's token (or create one via the DB if none is seeded as `sent`/`partial` for either template — check `formSubmissions` for a row with `templateId` matching PHQ-9/GAD-7; Task 1 didn't add one, so insert one directly for this verification).
2. `PUT` a full set of real answers with `complete: true` to `/api/intake/[token]` (or use the staff-side `PUT /api/form-submissions/[id]` with a known total that lands in a specific band).
3. `GET /client-forms` and confirm the row shows the inline score text.
4. `GET /client-forms/[id]` for that submission and confirm the score line renders.
5. `GET /patients/[anonId]/medical-record` for that patient and confirm the new "Screening Questionnaires" section shows the same score.

Paste actual commands and actual output (curl/fetch responses, or the rendered HTML snippet containing the score text) in the report — no narrated, unreproduced claims.

- [ ] **Step 9: Run the full suite once**

Run: `npx dotenv -e .env.local -- npx vitest run`
Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add src/lib/queries/form-submissions.ts src/components/ClientFormsTable.tsx "src/app/(dashboard)/client-forms/[id]/page.tsx" "src/app/(dashboard)/patients/[anonId]/medical-record/page.tsx" tests/lib/queries/form-submissions-patient-scoping.test.ts
git commit -m "feat: display computed screening scores on Client Forms and Medical Record

"```
