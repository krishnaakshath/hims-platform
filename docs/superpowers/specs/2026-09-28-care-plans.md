# Care Plans — Design Spec

**Status:** Draft for review — design spec, not yet implemented.
**Position in the larger initiative:** next item in the "complete the HIMS platform" backlog — this app has encounter notes (a single visit's SOAP record) but nothing tracking a patient's ongoing treatment goals across visits, which is standard practice for psychiatric care (a treatment plan with goals, target dates, and periodic review).

## 1. What this is, and the boundary it works within

A care plan is a small set of named, trackable treatment goals for a patient (e.g. "Reduce PHQ-9 score below 10 within 12 weeks", "Attend weekly CBT sessions"), each with a status and a target/review date, authored and periodically reviewed by the treating provider. This is **not** an automated care-pathway engine (no rules firing actions when a goal is met or missed — matching this codebase's established "software surfaces facts, a human decides" principle already applied to eligibility verdicts and lab-result flags) and **not** integrated outcome tracking (a goal referencing "PHQ-9 below 10" is free text the provider writes and later marks met/not-met by their own clinical judgment — it does not automatically read the Questionnaire Auto-Scoring module's computed score, which is a real, valuable future integration but its own separate scope decision, not assumed here).

This spec adds:
1. A **`carePlans`** table — one active plan per patient at a time (a patient can have historical/superseded plans, but only one `active` plan, matching how `medicationEpisodes` already handles "current vs. historical" for a patient's med list), with a title, start date, and next-review date.
2. A **`carePlanGoals`** table — one-to-many goals per plan, each with a description, target date, and status (active/met/not_met/discontinued).
3. A **Care Plan** section on the Medical Record page — current plan's goals with status pills, and a collapsed history of superseded plans.
4. A **"Create/update care plan"** action from the patient chart.

**Explicitly out of scope:** automated goal-outcome computation (see above). Care-team collaboration features (assigning a goal to a specific staff member, comments/discussion threads) — a real, valuable feature but its own scope. Patient-portal visibility of their own care plan (a genuinely good idea for patient engagement, but this spec is staff-facing only, matching how Lab Orders and Pharmacy also shipped staff-only first).

## 2. Data model changes (additive only)

```ts
export const carePlanStatusEnum = pgEnum('care_plan_status', ['active', 'superseded'])
export const carePlanGoalStatusEnum = pgEnum('care_plan_goal_status', ['active', 'met', 'not_met', 'discontinued'])

export const carePlans = pgTable('care_plans', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  title: text('title').notNull(),
  authorName: text('author_name').notNull(),
  status: carePlanStatusEnum('status').default('active').notNull(),
  startedAt: timestamp('started_at').defaultNow().notNull(),
  nextReviewDate: date('next_review_date'),
  supersededAt: timestamp('superseded_at'),
})

export const carePlanGoals = pgTable('care_plan_goals', {
  id: serial('id').primaryKey(),
  carePlanId: integer('care_plan_id').notNull().references(() => carePlans.id),
  description: text('description').notNull(),
  targetDate: date('target_date'),
  status: carePlanGoalStatusEnum('status').default('active').notNull(),
  statusUpdatedAt: timestamp('status_updated_at'),
  statusUpdatedByName: text('status_updated_by_name'),
})
```

**Why "one active plan per patient" is enforced by convention (superseding the old one) rather than a DB unique partial index:** this codebase has no precedent for partial/conditional unique constraints anywhere in its schema, and the write path (creating a new plan) is the single, well-defined place this invariant needs to hold — the create-plan function supersedes any existing active plan for that patient in the same call, the same "the write path is the one place this needs to be true, so enforce it there" reasoning already applied to `identityVerifications.patientId`'s application-level (not DB-level) one-per-patient handling elsewhere in this codebase. A future spec could add the DB-level constraint if a second write path for care plans is ever added; this spec has exactly one.

**Why goals are a separate table rather than a jsonb array on `carePlans`:** goals are individually status-updated over time (marked met/not-met at different points as the provider reviews progress), which needs per-row timestamps and authorship — the same reasoning `allergies` and `staffCredentials` are side tables rather than arrays-on-parent elsewhere in this codebase.

## 3. Plan lifecycle

`POST /api/patients/[anonId]/care-plans` — body `{ title: string, nextReviewDate?: string, goals: { description: string, targetDate?: string }[] }`. If the patient has an existing `active` plan, marks it `superseded` (sets `supersededAt`) in the same call before creating the new one — a patient always has at most one `active` plan, enforced here, the plan's one write path.

`PATCH /api/care-plan-goals/[id]` — body `{ status: 'met' | 'not_met' | 'discontinued' }` (a goal only ever moves forward from `active` to a terminal status; reopening a resolved goal isn't supported — start a new plan/goal instead, matching the "append-only history, never silently rewrite a clinical fact" principle already established for encounter-note signing and dispense records elsewhere in this codebase). Sets `statusUpdatedAt`/`statusUpdatedByName`. Rejects updating a goal that's already in a terminal state (409, not a silent no-op).

Every write calls `logAudit(session, <action>, patientId)`.

## 4. Medical Record display

New "Care Plan" section: the current active plan's title, next review date, and goals (each with a status pill — active/met/not_met/discontinued, never color alone). Below it, a collapsed `<details>` (matching the existing pattern this codebase already uses for a "show history" affordance — e.g. Lab Results' Pending sub-list precedent) listing superseded plans, collapsed by default so the page isn't dominated by history.

## 5. Testing

`tests/lib/queries/care-plans.test.ts` (creating a new plan supersedes the prior active one, a patient's plan history stays independent from another patient's — matching this session's established review-focus pattern), `tests/api/care-plan-goals.test.ts` (status transitions from active succeed, transitioning an already-terminal goal is rejected 409, `statusUpdatedByName` is genuinely captured from the session not client-supplied).

## 6. Role gating summary

| Action | Allowed roles |
|---|---|
| View care plan | admin, pi, crc, frontdesk (matches existing chart read-access precedent) |
| Create/update a care plan or goal (write) | admin, pi (a clinical judgment, matching the encounter-notes/MAR precedent of pi+admin for clinical writes) |
