# Phase 5: Engagement/Marketing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Clinsync an internal engagement subsystem for the pre-screening pipeline: a Patient Broadcast tool for notifying batches of referred patients about next steps, a Pre-Screening Experience Survey for collecting brief satisfaction feedback after intake, and a Pipeline Performance Dashboard summarizing referral-to-classification throughput — adapting (not cloning) the real Tebra "Patient Broadcast / Surveys & Reviews / Online Presence / Performance Dashboard" screens to what a clinical-trial pre-screening tool actually needs.

**Architecture:** Same stack, same security patterns as the rest of Clinsync (Next.js App Router Server Components + shared query functions, Drizzle/Neon, Upstash cache, `requireSession`/`requireSessionOrRedirect`, Zod-validated writes, audit logging). Two new tables (`broadcasts`, `reviews`) extend the existing schema additively — no other phase's tables are modified. New pages live inside the existing `(dashboard)` route group. No new external integrations: broadcast delivery is clearly simulated, mirroring the project-wide mock-connector pattern (`src/connectors/*.mock.ts`) and the Phase 3/4 mock-payment/mock-fax precedent. No new npm dependencies are introduced by this phase.

**Tech Stack:** Next.js 16 (App Router, TypeScript), Drizzle ORM + Neon Postgres, Upstash Redis, Tailwind v4, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-17-full-platform-phases-design.md` (§3 constraints, §4 schema ownership, §5 navigation) and `docs/superpowers/specs/2026-09-17-tebra-intakeq-screenshot-catalog.md` ("Engagement/marketing" section under Tebra).

## Prerequisites

- **Phase 1 must already be merged** (`docs/superpowers/plans/2026-09-17-intake-chart-workflow.md`) before Task 1 of this plan can begin. This plan's `reviews` table has a genuine foreign key to Phase 1's `formSubmissions` table, and its seed data looks up real `formSubmissions` rows created by Phase 1's seed. Before starting Task 1, open `src/db/schema.ts` and confirm `formTemplates` and `formSubmissions` are already defined — if they are not, stop and wait for Phase 1 to land.
- **Phase 3's `DataGridToolbar.tsx` is explicitly NOT a dependency of this plan.** The cross-phase architecture doc (§6) describes a shared `DataGridToolbar` component intended for reuse by Phase 3/4/5 list views, but as of this writing Phase 3's plan has not yet been written or reviewed, so its component contract does not exist to depend on. This plan builds small, self-contained filter/sort controls scoped to its own two list views (Broadcast History, Review Activity), following the same interaction *pattern* described in the architecture doc (search/filter/sort, plain-text empty states) without importing unreviewed code. If Phase 3 lands `DataGridToolbar.tsx` before this phase is implemented, a later consolidation pass may refactor these two list views onto it — that refactor is explicitly out of scope for this plan.
- No new chart library dependency is introduced. The Pipeline Performance Dashboard (Task 7) reuses the KPI-card-row + date-range-filter *layout pattern* from Tebra's Performance/Billing Analytics dashboards, not a literal chart; if Phase 3 later adds `recharts` for A/R Dashboard/Billing Analytics, a future phase could extend this dashboard with a trend chart, but that is not part of this plan's scope.

## Adaptations

Four adaptation decisions, made explicit up front per the architecture spec's instruction that real Tebra features be adapted to what a clinical-trial pre-screening pipeline actually needs, not cloned literally:

1. **Patient Broadcast → internal pipeline notification tool.** Real Tebra Patient Broadcast is practice-wide marketing/reminder messaging to an outpatient panel. Clinsync has no ongoing patient panel — it pre-screens referred patients for specific trials. This plan keeps Tebra's genuinely good 3-step wizard UX (Write a Message → Specify Recipients → Review and Send) and its Send/History tab split, but reframes the feature as a CRC notifying a filtered batch of referred patients about pipeline next steps (e.g., "your intake forms are still open," "your ADHD study forms are complete — next steps enclosed"). Recipients are filtered by trial, screening status (`green`/`yellow`/`red`), and form-submission state (`sent`/`partial`/`completed`/`none`) — Clinsync's real segmentation axes — instead of Tebra's generic demographic/appointment tags.
2. **Surveys & Reviews → Pre-Screening Experience Survey (internal, not public).** Real Tebra Surveys & Reviews manages public star-ratings and public review requests for an outpatient practice's online reputation — meaningless for a clinical-trial referral pipeline with no public-facing storefront. This plan drops public ratings/review-requests entirely and instead ties a short, staff-mediated 1–5 satisfaction survey (overall experience, forms clarity, communication, free-text comments) to a specific completed `formSubmissions` row from Phase 1. The survey is sent and its response recorded by staff (mirroring how Phase 1's form submissions themselves are tracked, since Clinsync has no patient-facing authenticated surface), not filled out by a patient logging into Clinsync directly. The genuinely reusable "Review Activity" list pattern (Sort By / Filter By / date range) is kept for browsing survey history.
3. **Online Presence → dropped entirely.** This is a public-listing/directory (Google Business Profile-style) management feature for a consumer-facing outpatient practice. A clinical-trial pre-screening pilot has no public storefront, no public listings, and no online-reputation surface to manage — there is no meaningful analog to build, so this screen has no representation anywhere in this plan (beyond this note and the exclusion list in the Global Constraints section).
4. **Performance Dashboard → Pipeline Performance Dashboard.** Real Tebra's Performance Dashboard reports ROI, review counts, and online-presence monitoring — all either dropped (per #2/#3) or Tebra-ecosystem-specific (per the architecture spec's MIPS/Tebra-Community exclusions). This plan reuses the KPI-card-row + date-range-preset *layout pattern* with an entirely different, pipeline-relevant metric set: referrals received, forms completed, patients classified, and average days from referral to classification — all computed from data Clinsync already owns (`patients`, `formSubmissions`, `patientTrialScreenings`), not from marketing/reputation data that doesn't exist in this product.

Also excluded, restated from the architecture spec (§3) since this is the phase they land in: the "Patient Experience upsell/quote" page (Tebra selling itself an add-on — no analog), MIPS/Quality-Measures incentive reporting, the Surveys & Reviews AI-response promo banner, and "Tebra Community"/"Customer Care" links (vendor-ecosystem features with no Clinsync equivalent). Broadcast SMS/Email delivery is clearly simulated — no real provider is ever called (see Task 2's `simulateBroadcastDelivery`).

## Global Constraints

- Every API route calls `requireSession()` and returns its `NextResponse` result unchanged on failure (see `src/lib/auth.ts`, `src/app/api/trials/[trialId]/criteria/route.ts` for the exact pattern).
- Every Server Component page calls `requireSessionOrRedirect()` as its **first statement**, before any data fetch (see the comment in `src/app/(dashboard)/patients/page.tsx` — a prior review proved that relying on the layout's redirect alone leaks PHI into the response body on an unauthenticated request).
- Server Components call shared query functions in `src/lib/queries/*.ts` directly. **Never** `fetch()` the app's own API route from a Server Component (a prior real vulnerability: session-cookie exfiltration via a forged `Host` header).
- Every write validates its request body with a `.strict()` Zod schema (see `criteriaUpdateSchema` in `src/app/api/trials/[trialId]/criteria/route.ts`).
- Every write that changes patient-relevant state calls `logAudit(session, action, patientId)` (`src/lib/audit.ts`) — `session` must be the real, non-null session, never a fallback role. Bulk actions with no single patient (e.g., sending a broadcast to many patients) pass `null` for `patientId`, matching the existing convention for template/list-level actions.
- Zero decorative icons anywhere. Status/severity is always a colored dot (`<span className="h-2 w-2 rounded-full ...">`, `aria-hidden="true"`) plus a text label — see `src/components/StatusChip.tsx`.
- Design tokens only: `bg-primary`, `bg-accent`, `text-accent-foreground`, `bg-card`, `border-border`, `bg-muted`, `text-muted-foreground`, `bg-secondary` from `src/app/globals.css`. Never a hardcoded Tailwind color class (`bg-slate-*`, `text-green-700`, etc.) — the one established exception is the emerald-800/amber-800/red-800 status-color set already used by `StatusChip.tsx`, which this plan reuses for delivered/failed and rating displays.
- Section/column headers use the established convention: `text-xs font-semibold uppercase tracking-wide text-muted-foreground`.
- Zebra striping on every list/table: `i % 2 === 1 ? 'bg-muted/40' : ''`.
- At most one coral (`bg-accent`) primary-action button visible per screen at a time.
- No glassmorphism, gradient/shiny buttons, bento grids, or floating/breathing animations — subtle hover/transition-colors utilities only, consistent with what's already in the codebase.
- Empty states are plain, factual text in the interface's voice ("No records found.", not an illustration).
- `npm test` and `npm run build` must be clean after every task. Nothing in this plan is pushed to git or deployed until the whole plan's Final QA pass (Task 9) is green — test locally throughout.
- No real SMS/email/payment/fax provider is ever integrated. Broadcast delivery status is a deterministic, explainable simulation (Task 2's `simulateBroadcastDelivery`), matching the project-wide mock-connector convention.

---

### Task 1: Schema + seed data

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/seed.ts`
- Modify: `tests/db/seed.test.ts` (existing file — extend, don't replace)

**Interfaces:**
- Consumes: `formSubmissions`, `formTemplates` (Phase 1), `trials`, `patients`, `verdictEnum` (existing baseline schema).
- Produces: `broadcasts`, `reviews` tables (+ `broadcastChannelEnum`, `broadcastFormStatusFilterEnum`, `surveyStatusEnum`), all exported from `src/db/schema.ts`, consumed by every later task.

- [ ] **Step 1: Confirm the Phase 1 prerequisite**

Open `src/db/schema.ts` and confirm `formTemplates` and `formSubmissions` are already defined (added by Phase 1's Task 1). If they are not present, stop — this task cannot proceed until Phase 1 has landed.

- [ ] **Step 2: Add the new enums and tables to the schema**

Add to `src/db/schema.ts`, after the `formSubmissions` table (Phase 1):

```typescript
export const broadcastChannelEnum = pgEnum('broadcast_channel', ['sms', 'email', 'both'])
// Distinct from Phase 1's formSubmissionStatusEnum: a broadcast filter also
// needs to express "patients with no form submission at all", which isn't a
// real formSubmissions.status value — so this is its own enum, not a reuse
// or modification of Phase 1's.
export const broadcastFormStatusFilterEnum = pgEnum('broadcast_form_status_filter', ['sent', 'partial', 'completed', 'none'])
export const surveyStatusEnum = pgEnum('survey_status', ['sent', 'completed'])

export const broadcasts = pgTable('broadcasts', {
  id: serial('id').primaryKey(),
  subject: text('subject'),                    // required by the API when channel includes email; null for sms-only sends
  message: text('message').notNull(),
  channel: broadcastChannelEnum('channel').notNull(),
  filterTrialId: text('filter_trial_id').references(() => trials.id),
  filterOverallStatus: verdictEnum('filter_overall_status'),
  filterFormStatus: broadcastFormStatusFilterEnum('filter_form_status'),
  // Snapshot of exactly who this broadcast went to and whether each
  // recipient's simulated delivery succeeded, captured at send time so
  // history remains accurate even if a patient's contact info changes later.
  recipients: jsonb('recipients').$type<{ patientId: string; patientName: string; deliveryStatus: 'delivered' | 'failed' }[]>().notNull(),
  recipientCount: integer('recipient_count').notNull(),
  sentBy: text('sent_by').notNull(),
  sentAt: timestamp('sent_at').defaultNow().notNull(),
})

export const reviews = pgTable('reviews', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  formSubmissionId: integer('form_submission_id').notNull().references(() => formSubmissions.id),
  status: surveyStatusEnum('status').default('sent').notNull(),
  sentAt: timestamp('sent_at').defaultNow().notNull(),
  respondedAt: timestamp('responded_at'),
  ratingOverall: integer('rating_overall'),          // 1-5, set only once status = 'completed'
  ratingFormsClarity: integer('rating_forms_clarity'), // 1-5
  ratingCommunication: integer('rating_communication'), // 1-5
  comments: text('comments'),
  sentBy: text('sent_by').notNull(),
})
```

- [ ] **Step 3: Push the schema**

Run: `npm run db:push` (applies the 2 new tables + 3 new enums to the linked Neon database; confirm it reports no errors).

- [ ] **Step 4: Extend `clearExistingData()` in `src/db/seed.ts`**

Open `src/db/seed.ts` and find `clearExistingData()` (by the time this task runs, Phase 1 will already have extended it with `formSubmissions`/`allergies`/etc. deletions — read the current version first). Add `reviews` and `broadcasts` deletions as the very first two lines, before any other deletion — `reviews` depends on `patients`/`formSubmissions`, and `broadcasts` depends on `trials`, so both must go before their referenced rows are deleted:

```typescript
async function clearExistingData() {
  const db = getDb()
  // Delete in FK-safe order (children before parents) so seed() is safely re-runnable.
  await db.delete(reviews)
  await db.delete(broadcasts)
  // ...existing deletions continue unchanged below this line...
```

- [ ] **Step 5: Extend imports in `src/db/seed.ts`**

Add `broadcasts`, `reviews`, `formSubmissions` to the existing `import { ... } from './schema'` list, and add a new import line:

```typescript
import { eq, and } from 'drizzle-orm'
```

- [ ] **Step 6: Seed realistic broadcast and review data**

Add near the end of the `seed()` function, after the existing `identityMatches` insert and before the function's closing brace:

```typescript
  // Phase 5: stagger dateAdded/chartDataAsOf for a handful of patients so the
  // Pipeline Performance Dashboard's date-range filters and "average days
  // referral -> classification" KPI have real spread to show, instead of
  // every patient landing at the exact instant this script ran. This only
  // updates data values on the pre-existing `patients` table (not its
  // schema), for the same reason Phase 1's seed script freely inserts into
  // pre-existing tables like `diagnoses` — no phase "owns" `patients`
  // exclusively, and no column definition is changed here.
  const now = new Date()
  const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000)
  await db.update(patients).set({ dateAdded: daysAgo(35), chartDataAsOf: daysAgo(28) }).where(eq(patients.id, 'RD-0001'))
  await db.update(patients).set({ dateAdded: daysAgo(20), chartDataAsOf: daysAgo(15) }).where(eq(patients.id, 'RD-0002'))
  await db.update(patients).set({ dateAdded: daysAgo(12), chartDataAsOf: daysAgo(9) }).where(eq(patients.id, 'RD-0003'))
  await db.update(patients).set({ dateAdded: daysAgo(8), chartDataAsOf: daysAgo(6) }).where(eq(patients.id, 'RD-0004'))
  await db.update(patients).set({ dateAdded: daysAgo(3), chartDataAsOf: daysAgo(1) }).where(eq(patients.id, 'RD-0005'))
  await db.update(patients).set({ dateAdded: daysAgo(2) }).where(eq(patients.id, 'RD-0006')) // not yet (re)classified

  // Broadcasts: a spread of channels, filters, and simulated delivery outcomes.
  await db.insert(broadcasts).values([
    {
      message: 'Reminder: your MDD trial intake packet is still open. Please finish it before your next visit.',
      channel: 'sms',
      filterTrialId: 'nct06911112',
      filterOverallStatus: 'yellow',
      filterFormStatus: null,
      recipients: [
        { patientId: 'RD-0003', patientName: 'Linda Cho', deliveryStatus: 'delivered' },
        { patientId: 'RD-0006', patientName: 'Kathryn Voss', deliveryStatus: 'delivered' },
      ],
      recipientCount: 2,
      sentBy: 'Jamie Ruiz',
      sentAt: daysAgo(10),
    },
    {
      subject: 'Your ADHD study forms are complete — next steps',
      message: 'Thank you for completing your intake packet. The study coordinator will call you within 2 business days to schedule your screening visit.',
      channel: 'email',
      filterTrialId: 'nct-adhd-demo-01',
      filterOverallStatus: null,
      filterFormStatus: 'completed',
      recipients: [
        { patientId: 'RD-0004', patientName: 'Priya Natarajan', deliveryStatus: 'delivered' },
      ],
      recipientCount: 1,
      sentBy: 'Jamie Ruiz',
      sentAt: daysAgo(6),
    },
    {
      subject: 'Please complete your intake forms',
      message: "We noticed your intake packet hasn't been started yet. Please complete it as soon as possible so we can continue your pre-screening.",
      channel: 'both',
      filterTrialId: null,
      filterOverallStatus: null,
      filterFormStatus: 'sent',
      recipients: [
        { patientId: 'RD-0003', patientName: 'Linda Cho', deliveryStatus: 'delivered' },
        { patientId: 'RD-0005', patientName: 'Marcus Webb', deliveryStatus: 'failed' },
      ],
      recipientCount: 2,
      sentBy: 'Sam Patel',
      sentAt: daysAgo(4),
    },
    {
      message: 'This is a routine check-in from the study team — reply if you have questions about your upcoming visit.',
      channel: 'sms',
      filterTrialId: null,
      filterOverallStatus: null,
      filterFormStatus: null,
      recipients: [
        { patientId: 'RD-0001', patientName: 'Maria Alvarez', deliveryStatus: 'delivered' },
        { patientId: 'RD-0002', patientName: 'James Thornton', deliveryStatus: 'delivered' },
        { patientId: 'RD-0007', patientName: 'Robert Nguyen', deliveryStatus: 'failed' },
      ],
      recipientCount: 3,
      sentBy: 'Jamie Ruiz',
      sentAt: daysAgo(1),
    },
  ])

  // Reviews: Pre-Screening Experience Survey responses tied to Phase 1's
  // completed form submissions for RD-0001, RD-0002, and RD-0004.
  const [rd0001Submission] = await db.select().from(formSubmissions).where(and(eq(formSubmissions.patientId, 'RD-0001'), eq(formSubmissions.status, 'completed')))
  const [rd0002Submission] = await db.select().from(formSubmissions).where(and(eq(formSubmissions.patientId, 'RD-0002'), eq(formSubmissions.status, 'completed')))
  const [rd0004Submission] = await db.select().from(formSubmissions).where(and(eq(formSubmissions.patientId, 'RD-0004'), eq(formSubmissions.status, 'completed')))

  await db.insert(reviews).values([
    {
      patientId: 'RD-0001',
      formSubmissionId: rd0001Submission.id,
      status: 'completed',
      sentAt: daysAgo(27),
      respondedAt: daysAgo(25),
      ratingOverall: 5,
      ratingFormsClarity: 5,
      ratingCommunication: 4,
      comments: 'The intake process was clear and the coordinator was very responsive.',
      sentBy: 'Jamie Ruiz',
    },
    {
      patientId: 'RD-0002',
      formSubmissionId: rd0002Submission.id,
      status: 'sent',
      sentAt: daysAgo(14),
      sentBy: 'Jamie Ruiz',
    },
    {
      patientId: 'RD-0004',
      formSubmissionId: rd0004Submission.id,
      status: 'completed',
      sentAt: daysAgo(8),
      respondedAt: daysAgo(7),
      ratingOverall: 3,
      ratingFormsClarity: 3,
      ratingCommunication: 4,
      comments: 'Forms were a bit long but staff followed up quickly.',
      sentBy: 'Jamie Ruiz',
    },
  ])
```

- [ ] **Step 7: Re-seed and verify**

Run: `npm run db:seed` (destructive — confirm this is a dev/pilot database, matching existing usage in this project). Then run:

```bash
npx dotenv -e .env.local -- tsx -e "import { getDb } from './src/db/client'; import { broadcasts, reviews } from './src/db/schema'; getDb().select().from(broadcasts).then(r => console.log('broadcasts:', r.length)); getDb().select().from(reviews).then(r => console.log('reviews:', r.length))"
```

Confirm non-zero counts (4 broadcasts, 3 reviews).

- [ ] **Step 8: Extend `tests/db/seed.test.ts`**

Add to the existing `describe('seed', ...)` block (the file's `beforeAll` already calls `seed()`, so no changes are needed there):

```typescript
  it('creates the seeded broadcasts with recipient snapshots', async () => {
    const rows = await getDb().select().from(broadcasts)
    expect(rows.length).toBeGreaterThanOrEqual(4)
    expect(rows.every((r) => Array.isArray(r.recipients) && r.recipients.length === r.recipientCount)).toBe(true)
  })

  it('creates the seeded pre-screening experience surveys, including at least one still-sent response', async () => {
    const rows = await getDb().select().from(reviews)
    expect(rows.length).toBeGreaterThanOrEqual(3)
    expect(rows.some((r) => r.status === 'sent')).toBe(true)
    expect(rows.some((r) => r.status === 'completed' && r.ratingOverall !== null)).toBe(true)
  })
```

Add `broadcasts, reviews` to the file's existing `import { trials, patients, identityMatches } from '@/db/schema'` line.

- [ ] **Step 9: Run the suite and commit**

Run: `npm test` and `npm run build` — both must be clean.

```bash
git add src/db/schema.ts src/db/seed.ts tests/db/seed.test.ts
git commit -m "feat: add broadcasts and reviews tables with seed data for Phase 5 engagement"
```

---

### Task 2: Shared query functions

**Files:**
- Create: `src/lib/queries/broadcasts.ts`
- Create: `src/lib/queries/reviews.ts`
- Create: `src/lib/queries/pipeline-dashboard.ts`
- Modify: `src/lib/cache.ts` (add cache-key helpers)
- Test: `tests/lib/queries/broadcasts.test.ts`, `tests/lib/queries/reviews.test.ts`, `tests/lib/queries/pipeline-dashboard.test.ts` (new)

**Interfaces:**
- Consumes: `broadcasts`, `reviews` (Task 1); `patients`, `patientTrialScreenings`, `formSubmissions`, `formTemplates`, `trials` (existing/Phase 1).
- Produces: `listBroadcastRecipientCandidates()`, `simulateBroadcastDelivery()`, `listBroadcasts()`, `getBroadcast()`, `invalidateBroadcastsList()`, `listReviews()`, `getReview()`, `listSurveyableSubmissions()`, `getAverageExperienceRating()`, `invalidateReviewsList()`, `getPipelinePerformance()` — all consumed directly by Server Component pages in Tasks 4, 6, 7 and by the API routes in Tasks 3, 5 (never via `fetch()` from a Server Component).

- [ ] **Step 1: `src/lib/cache.ts` — add cache keys**

Add alongside the existing key helpers:

```typescript
export function broadcastsListCacheKey(): string {
  return 'broadcasts:list'
}

export function reviewsListCacheKey(filters: string): string {
  return `reviews:list:${filters}`
}

export function pipelineDashboardCacheKey(fromISO: string, toISO: string): string {
  return `pipeline-dashboard:${fromISO}:${toISO}`
}
```

- [ ] **Step 2: `src/lib/queries/broadcasts.ts`**

```typescript
import { getDb } from '@/db/client'
import { broadcasts, patients, patientTrialScreenings, formSubmissions, trials } from '@/db/schema'
import { eq, desc } from 'drizzle-orm'
import { getOrSetCache, invalidateCache, broadcastsListCacheKey } from '@/lib/cache'
import type { Verdict } from '@/lib/rule-engine'

export interface BroadcastRecipientFilters {
  trialId?: string
  overallStatus?: Verdict
  formStatus?: 'sent' | 'partial' | 'completed' | 'none'
}

export interface BroadcastRecipientCandidate {
  id: string
  name: string
  phone: string | null
  email: string | null
}

/**
 * Computes the live set of patients matching a broadcast's recipient filter.
 * Used by both the "Specify Recipients" wizard step (as a live preview,
 * before anything is sent) and by the create-broadcast route (to snapshot
 * the actual recipient list at send time).
 */
export async function listBroadcastRecipientCandidates(filters: BroadcastRecipientFilters): Promise<BroadcastRecipientCandidate[]> {
  const db = getDb()

  const rows = await db
    .select({ patient: patients, screening: patientTrialScreenings })
    .from(patients)
    .leftJoin(patientTrialScreenings, eq(patientTrialScreenings.patientId, patients.id))
    .where(filters.trialId ? eq(patientTrialScreenings.trialId, filters.trialId) : undefined)

  // A patient can have multiple screening rows across trials; when no
  // trialId filter narrows the join, keep exactly one row per patient.
  const byPatient = new Map<string, { patient: typeof patients.$inferSelect; overallStatus?: Verdict }>()
  for (const r of rows) {
    if (!byPatient.has(r.patient.id)) {
      byPatient.set(r.patient.id, { patient: r.patient, overallStatus: r.screening?.overallStatus as Verdict | undefined })
    }
  }

  let candidates = [...byPatient.values()]
  if (filters.overallStatus) {
    candidates = candidates.filter((c) => c.overallStatus === filters.overallStatus)
  }

  if (filters.formStatus) {
    const submissions = await db.select().from(formSubmissions).orderBy(desc(formSubmissions.sentDate))
    const latestStatusByPatient = new Map<string, string>()
    for (const s of submissions) {
      // Rows are ordered by sentDate desc, so the first one seen per patient
      // is that patient's most recent form submission.
      if (!latestStatusByPatient.has(s.patientId)) latestStatusByPatient.set(s.patientId, s.status)
    }
    if (filters.formStatus === 'none') {
      candidates = candidates.filter((c) => !latestStatusByPatient.has(c.patient.id))
    } else {
      candidates = candidates.filter((c) => latestStatusByPatient.get(c.patient.id) === filters.formStatus)
    }
  }

  return candidates.map((c) => ({
    id: c.patient.id,
    name: c.patient.nameTebra ?? c.patient.nameIntakeq,
    phone: c.patient.phoneTebra ?? c.patient.phoneIntakeq ?? null,
    email: c.patient.emailTebra ?? c.patient.emailIntakeq ?? null,
  }))
}

/**
 * Simulated delivery, mirroring the project-wide mock-connector pattern
 * (`src/connectors/*.mock.ts`): no real SMS/email provider is ever called.
 * The rule is deterministic and explainable for a demo: delivery "succeeds"
 * only when the patient actually has the contact method the channel needs
 * on file, rather than a random outcome.
 */
export function simulateBroadcastDelivery(channel: 'sms' | 'email' | 'both', phone: string | null, email: string | null): 'delivered' | 'failed' {
  if (channel === 'sms') return phone ? 'delivered' : 'failed'
  if (channel === 'email') return email ? 'delivered' : 'failed'
  return phone || email ? 'delivered' : 'failed'
}

export async function listBroadcasts() {
  return getOrSetCache(broadcastsListCacheKey(), 30, async () => {
    const rows = await getDb()
      .select({ broadcast: broadcasts, trial: trials })
      .from(broadcasts)
      .leftJoin(trials, eq(broadcasts.filterTrialId, trials.id))
      .orderBy(desc(broadcasts.sentAt))

    return rows.map((r) => ({ ...r.broadcast, trialCondition: r.trial?.condition ?? null }))
  })
}

export async function getBroadcast(id: number) {
  const [row] = await getDb()
    .select({ broadcast: broadcasts, trial: trials })
    .from(broadcasts)
    .leftJoin(trials, eq(broadcasts.filterTrialId, trials.id))
    .where(eq(broadcasts.id, id))
  if (!row) return null
  return { ...row.broadcast, trialCondition: row.trial?.condition ?? null }
}

export async function invalidateBroadcastsList() {
  await invalidateCache(broadcastsListCacheKey())
}
```

- [ ] **Step 3: `src/lib/queries/reviews.ts`**

```typescript
import { getDb } from '@/db/client'
import { reviews, patients, formSubmissions, formTemplates } from '@/db/schema'
import { eq, desc, asc, and, gte, lte, SQL } from 'drizzle-orm'
import { getOrSetCache, invalidateCache, reviewsListCacheKey } from '@/lib/cache'

export interface ReviewFilters {
  status?: 'sent' | 'completed'
  dateFrom?: string
  dateTo?: string
  sortBy?: 'sentAt' | 'ratingOverall'
  sortDir?: 'asc' | 'desc'
}

export async function listReviews(filters: ReviewFilters) {
  return getOrSetCache(reviewsListCacheKey(JSON.stringify(filters)), 30, async () => {
    const conditions: SQL[] = []
    if (filters.status) conditions.push(eq(reviews.status, filters.status))
    if (filters.dateFrom) conditions.push(gte(reviews.sentAt, new Date(filters.dateFrom)))
    if (filters.dateTo) conditions.push(lte(reviews.sentAt, new Date(filters.dateTo)))

    const sortColumn = filters.sortBy === 'ratingOverall' ? reviews.ratingOverall : reviews.sentAt
    const sortFn = filters.sortDir === 'asc' ? asc : desc

    const rows = await getDb()
      .select({ review: reviews, patient: patients, submission: formSubmissions, template: formTemplates })
      .from(reviews)
      .innerJoin(patients, eq(reviews.patientId, patients.id))
      .innerJoin(formSubmissions, eq(reviews.formSubmissionId, formSubmissions.id))
      .innerJoin(formTemplates, eq(formSubmissions.templateId, formTemplates.id))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(sortFn(sortColumn))

    return rows.map((r) => ({
      ...r.review,
      patientName: r.patient.nameTebra ?? r.patient.nameIntakeq,
      templateName: r.template.name,
      diagnosisTag: r.template.diagnosisTag,
    }))
  })
}

export async function getReview(id: number) {
  const [row] = await getDb()
    .select({ review: reviews, patient: patients, submission: formSubmissions, template: formTemplates })
    .from(reviews)
    .innerJoin(patients, eq(reviews.patientId, patients.id))
    .innerJoin(formSubmissions, eq(reviews.formSubmissionId, formSubmissions.id))
    .innerJoin(formTemplates, eq(formSubmissions.templateId, formTemplates.id))
    .where(eq(reviews.id, id))
  if (!row) return null
  return {
    ...row.review,
    patientName: row.patient.nameTebra ?? row.patient.nameIntakeq,
    templateName: row.template.name,
    diagnosisTag: row.template.diagnosisTag,
  }
}

/**
 * Completed intake submissions that don't already have a survey sent — the
 * candidate list for the "Send Survey" action.
 */
export async function listSurveyableSubmissions() {
  const db = getDb()
  const completed = await db
    .select({ submission: formSubmissions, patient: patients, template: formTemplates })
    .from(formSubmissions)
    .innerJoin(patients, eq(formSubmissions.patientId, patients.id))
    .innerJoin(formTemplates, eq(formSubmissions.templateId, formTemplates.id))
    .where(eq(formSubmissions.status, 'completed'))

  const alreadySurveyed = new Set((await db.select({ formSubmissionId: reviews.formSubmissionId }).from(reviews)).map((r) => r.formSubmissionId))

  return completed
    .filter((r) => !alreadySurveyed.has(r.submission.id))
    .map((r) => ({
      formSubmissionId: r.submission.id,
      patientId: r.patient.id,
      patientName: r.patient.nameTebra ?? r.patient.nameIntakeq,
      templateName: r.template.name,
      completedDate: r.submission.completedDate,
    }))
}

export async function getAverageExperienceRating(): Promise<number | null> {
  const completed = await getDb().select({ ratingOverall: reviews.ratingOverall }).from(reviews).where(eq(reviews.status, 'completed'))
  const ratings = completed.map((r) => r.ratingOverall).filter((r): r is number => r !== null)
  if (ratings.length === 0) return null
  return ratings.reduce((a, b) => a + b, 0) / ratings.length
}

export async function invalidateReviewsList() {
  // Filtered list cache keys are parameterized per filter combination with a
  // short 30s TTL, so a full key-space scan isn't needed — just drop the
  // common no-filter view most screens load by default.
  await invalidateCache(reviewsListCacheKey(JSON.stringify({})))
}
```

- [ ] **Step 4: `src/lib/queries/pipeline-dashboard.ts`**

```typescript
import { getDb } from '@/db/client'
import { patients, patientTrialScreenings, formSubmissions } from '@/db/schema'
import { eq, and, gte, lte } from 'drizzle-orm'
import { getOrSetCache, pipelineDashboardCacheKey } from '@/lib/cache'

export interface PipelineDateRange {
  from: Date
  to: Date
}

export interface PipelinePerformance {
  referralsReceived: number
  formsCompleted: number
  patientsClassified: number
  avgDaysToClassify: number | null
}

export async function getPipelinePerformance(range: PipelineDateRange): Promise<PipelinePerformance> {
  return getOrSetCache(pipelineDashboardCacheKey(range.from.toISOString(), range.to.toISOString()), 30, async () => {
    const db = getDb()

    const referrals = await db
      .select()
      .from(patients)
      .where(and(gte(patients.dateAdded, range.from), lte(patients.dateAdded, range.to)))

    const completedForms = await db
      .select()
      .from(formSubmissions)
      .where(and(eq(formSubmissions.status, 'completed'), gte(formSubmissions.completedDate, range.from), lte(formSubmissions.completedDate, range.to)))

    // A patient counts as "classified" once a screening row exists for them
    // (the rule engine has run at least once) and their chart's most recent
    // (re-)evaluation timestamp, `chartDataAsOf`, falls in the selected
    // window. `chartDataAsOf` is bumped by both the manual "Run
    // Classification" refresh action (`src/app/api/patients/[anonId]/refresh/route.ts`)
    // and by auto-classify-on-complete, so it is the one real, already-existing
    // signal for "classification activity" shared by both paths.
    const screenedPatientIds = new Set((await db.select({ patientId: patientTrialScreenings.patientId }).from(patientTrialScreenings)).map((r) => r.patientId))
    const candidatesInWindow = await db
      .select()
      .from(patients)
      .where(and(gte(patients.chartDataAsOf, range.from), lte(patients.chartDataAsOf, range.to)))
    const classifiedInWindow = candidatesInWindow.filter((p) => screenedPatientIds.has(p.id))

    const daysToClassify = classifiedInWindow
      .map((p) => (p.chartDataAsOf.getTime() - p.dateAdded.getTime()) / (1000 * 60 * 60 * 24))
      .filter((days) => days >= 0)

    return {
      referralsReceived: referrals.length,
      formsCompleted: completedForms.length,
      patientsClassified: classifiedInWindow.length,
      avgDaysToClassify: daysToClassify.length > 0 ? daysToClassify.reduce((a, b) => a + b, 0) / daysToClassify.length : null,
    }
  })
}
```

- [ ] **Step 5: Tests**

`tests/lib/queries/broadcasts.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { listBroadcastRecipientCandidates, simulateBroadcastDelivery, listBroadcasts } from '@/lib/queries/broadcasts'

describe('simulateBroadcastDelivery', () => {
  it('delivers SMS only when a phone number is on file', () => {
    expect(simulateBroadcastDelivery('sms', '909-555-0142', null)).toBe('delivered')
    expect(simulateBroadcastDelivery('sms', null, 'a@example.com')).toBe('failed')
  })

  it('delivers email only when an email address is on file', () => {
    expect(simulateBroadcastDelivery('email', null, 'a@example.com')).toBe('delivered')
    expect(simulateBroadcastDelivery('email', '909-555-0142', null)).toBe('failed')
  })

  it('delivers "both" when at least one contact method is on file', () => {
    expect(simulateBroadcastDelivery('both', null, 'a@example.com')).toBe('delivered')
    expect(simulateBroadcastDelivery('both', null, null)).toBe('failed')
  })
})

describe('listBroadcastRecipientCandidates', () => {
  it('filters by trial', async () => {
    const candidates = await listBroadcastRecipientCandidates({ trialId: 'nct06911112' })
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates.every((c) => typeof c.id === 'string')).toBe(true)
  })

  it('filters by overall status', async () => {
    const candidates = await listBroadcastRecipientCandidates({ overallStatus: 'red' })
    expect(candidates.length).toBeGreaterThan(0)
  })

  it('returns patients with no form submission at all when formStatus is "none"', async () => {
    const candidates = await listBroadcastRecipientCandidates({ formStatus: 'none' })
    // Seeded filler patients (RD-0007+) never get a form submission — see Phase 1's seed.
    expect(candidates.some((c) => c.id === 'RD-0007')).toBe(true)
  })
})

describe('listBroadcasts', () => {
  it('returns the seeded broadcast history, most recent first', async () => {
    const rows = await listBroadcasts()
    expect(rows.length).toBeGreaterThanOrEqual(4)
    expect(new Date(rows[0].sentAt).getTime()).toBeGreaterThanOrEqual(new Date(rows[rows.length - 1].sentAt).getTime())
  })
})
```

`tests/lib/queries/reviews.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { listReviews, getReview, listSurveyableSubmissions, getAverageExperienceRating } from '@/lib/queries/reviews'

describe('listReviews', () => {
  it('returns the seeded survey records', async () => {
    const rows = await listReviews({})
    expect(rows.length).toBeGreaterThanOrEqual(3)
  })

  it('filters by status', async () => {
    const sent = await listReviews({ status: 'sent' })
    expect(sent.every((r) => r.status === 'sent')).toBe(true)
  })
})

describe('getAverageExperienceRating', () => {
  it('averages only completed responses', async () => {
    const average = await getAverageExperienceRating()
    expect(average).not.toBeNull()
    expect(average!).toBeGreaterThan(0)
    expect(average!).toBeLessThanOrEqual(5)
  })
})

describe('listSurveyableSubmissions', () => {
  it('excludes submissions that already have a survey sent', async () => {
    const candidates = await listSurveyableSubmissions()
    const reviewed = await listReviews({})
    const reviewedSubmissionIds = new Set(reviewed.map((r) => r.formSubmissionId))
    expect(candidates.every((c) => !reviewedSubmissionIds.has(c.formSubmissionId))).toBe(true)
  })
})

describe('getReview', () => {
  it('returns null for a non-existent id', async () => {
    const review = await getReview(999999)
    expect(review).toBeNull()
  })
})
```

`tests/lib/queries/pipeline-dashboard.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { getPipelinePerformance } from '@/lib/queries/pipeline-dashboard'

describe('getPipelinePerformance', () => {
  it('returns all four KPIs for a wide date range', async () => {
    const performance = await getPipelinePerformance({ from: new Date('2000-01-01'), to: new Date() })
    expect(performance.referralsReceived).toBeGreaterThan(0)
    expect(performance.formsCompleted).toBeGreaterThan(0)
    expect(performance.patientsClassified).toBeGreaterThanOrEqual(0)
  })

  it('returns zero referrals for a date range with no data', async () => {
    const performance = await getPipelinePerformance({ from: new Date('1990-01-01'), to: new Date('1990-01-02') })
    expect(performance.referralsReceived).toBe(0)
    expect(performance.avgDaysToClassify).toBeNull()
  })
})
```

- [ ] **Step 6: Run the suite and commit**

Run: `npm test` and `npm run build` — both must be clean.

```bash
git add src/lib/queries/broadcasts.ts src/lib/queries/reviews.ts src/lib/queries/pipeline-dashboard.ts src/lib/cache.ts tests/lib/queries/broadcasts.test.ts tests/lib/queries/reviews.test.ts tests/lib/queries/pipeline-dashboard.test.ts
git commit -m "feat: add shared query functions for broadcasts, experience surveys, and pipeline dashboard"
```

---

### Task 3: Patient Broadcast API routes

**Files:**
- Create: `src/app/api/broadcasts/route.ts` (GET list, POST send)
- Create: `src/app/api/broadcasts/recipients/route.ts` (GET recipient preview)
- Create: `src/app/api/broadcasts/[id]/route.ts` (GET detail)
- Test: `tests/api/broadcasts.test.ts`

**Interfaces:**
- Consumes: `listBroadcasts`, `getBroadcast`, `listBroadcastRecipientCandidates`, `simulateBroadcastDelivery`, `invalidateBroadcastsList` (Task 2).
- Produces: `GET/POST /api/broadcasts`, `GET /api/broadcasts/recipients`, `GET /api/broadcasts/[id]`, used by the wizard and history pages in Task 4.

- [ ] **Step 1: `src/app/api/broadcasts/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDb } from '@/db/client'
import { broadcasts } from '@/db/schema'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listBroadcasts, listBroadcastRecipientCandidates, simulateBroadcastDelivery, invalidateBroadcastsList } from '@/lib/queries/broadcasts'

const createBroadcastSchema = z
  .object({
    subject: z.string().min(1).optional(),
    message: z.string().min(1).max(1000),
    channel: z.enum(['sms', 'email', 'both']),
    filterTrialId: z.string().min(1).optional(),
    filterOverallStatus: z.enum(['green', 'yellow', 'red']).optional(),
    filterFormStatus: z.enum(['sent', 'partial', 'completed', 'none']).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.channel === 'sms' && data.message.length > 140) {
      ctx.addIssue({ code: 'custom', message: 'SMS messages must be 140 characters or fewer', path: ['message'] })
    }
    if ((data.channel === 'email' || data.channel === 'both') && !data.subject) {
      ctx.addIssue({ code: 'custom', message: 'Subject is required when sending email', path: ['subject'] })
    }
  })

export async function GET() {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  return NextResponse.json(await listBroadcasts())
}

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session

  const parsed = createBroadcastSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid broadcast payload', details: parsed.error.flatten() }, { status: 400 })

  const candidates = await listBroadcastRecipientCandidates({
    trialId: parsed.data.filterTrialId,
    overallStatus: parsed.data.filterOverallStatus,
    formStatus: parsed.data.filterFormStatus,
  })
  if (candidates.length === 0) {
    return NextResponse.json({ error: 'No patients match this recipient filter' }, { status: 400 })
  }

  const recipients = candidates.map((c) => ({
    patientId: c.id,
    patientName: c.name,
    deliveryStatus: simulateBroadcastDelivery(parsed.data.channel, c.phone, c.email),
  }))

  const [created] = await getDb()
    .insert(broadcasts)
    .values({
      subject: parsed.data.subject ?? null,
      message: parsed.data.message,
      channel: parsed.data.channel,
      filterTrialId: parsed.data.filterTrialId ?? null,
      filterOverallStatus: parsed.data.filterOverallStatus ?? null,
      filterFormStatus: parsed.data.filterFormStatus ?? null,
      recipients,
      recipientCount: recipients.length,
      sentBy: session.name,
    })
    .returning()

  await invalidateBroadcastsList()
  await logAudit(session, `sent broadcast to ${recipients.length} patient(s)`, null)
  return NextResponse.json(created, { status: 201 })
}
```

- [ ] **Step 2: `src/app/api/broadcasts/recipients/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { listBroadcastRecipientCandidates } from '@/lib/queries/broadcasts'

export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session

  const url = new URL(request.url)
  const trialId = url.searchParams.get('trialId') ?? undefined
  const overallStatusParam = url.searchParams.get('overallStatus')
  const formStatusParam = url.searchParams.get('formStatus')
  const overallStatus = overallStatusParam === 'green' || overallStatusParam === 'yellow' || overallStatusParam === 'red' ? overallStatusParam : undefined
  const formStatus = formStatusParam === 'sent' || formStatusParam === 'partial' || formStatusParam === 'completed' || formStatusParam === 'none' ? formStatusParam : undefined

  const candidates = await listBroadcastRecipientCandidates({ trialId, overallStatus, formStatus })
  return NextResponse.json(candidates)
}
```

- [ ] **Step 3: `src/app/api/broadcasts/[id]/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { getBroadcast } from '@/lib/queries/broadcasts'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  const { id } = await params
  const broadcast = await getBroadcast(Number(id))
  if (!broadcast) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(broadcast)
}
```

- [ ] **Step 4: Test**

`tests/api/broadcasts.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest'
import { GET as listBroadcasts, POST as createBroadcast } from '@/app/api/broadcasts/route'
import { GET as recipientPreview } from '@/app/api/broadcasts/recipients/route'

vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: 'crc', name: 'Jamie Ruiz' })) }))

describe('GET /api/broadcasts', () => {
  it('returns the seeded broadcast history', async () => {
    const res = await listBroadcasts()
    const body = await res.json()
    expect(body.length).toBeGreaterThanOrEqual(4)
  })
})

describe('GET /api/broadcasts/recipients', () => {
  it('previews candidates for a filter without creating a broadcast', async () => {
    const req = new Request('http://localhost/api/broadcasts/recipients?trialId=nct06911112')
    const res = await recipientPreview(req as never)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
  })
})

describe('POST /api/broadcasts', () => {
  it('rejects an SMS message over 140 characters', async () => {
    const req = new Request('http://localhost/api/broadcasts', { method: 'POST', body: JSON.stringify({ message: 'x'.repeat(141), channel: 'sms' }) })
    const res = await createBroadcast(req as never)
    expect(res.status).toBe(400)
  })

  it('rejects an email broadcast with no subject', async () => {
    const req = new Request('http://localhost/api/broadcasts', { method: 'POST', body: JSON.stringify({ message: 'Hello', channel: 'email' }) })
    const res = await createBroadcast(req as never)
    expect(res.status).toBe(400)
  })

  it('rejects a filter that matches zero patients', async () => {
    const req = new Request('http://localhost/api/broadcasts', { method: 'POST', body: JSON.stringify({ message: 'Hello', channel: 'sms', filterTrialId: 'does-not-exist' }) })
    const res = await createBroadcast(req as never)
    expect(res.status).toBe(400)
  })

  it('creates a broadcast and snapshots the matching recipients', async () => {
    const req = new Request('http://localhost/api/broadcasts', { method: 'POST', body: JSON.stringify({ message: 'Test broadcast from the automated suite', channel: 'sms', filterTrialId: 'nct06911112' }) })
    const res = await createBroadcast(req as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.recipientCount).toBeGreaterThan(0)
    expect(body.recipients.length).toBe(body.recipientCount)
  })
})
```

- [ ] **Step 5: Run the suite and commit**

Run: `npm test` and `npm run build` — both must be clean.

```bash
git add src/app/api/broadcasts tests/api/broadcasts.test.ts
git commit -m "feat: add Patient Broadcast API routes (list, recipient preview, send, detail)"
```

---

### Task 4: Patient Broadcast pages (Send wizard, History, Detail)

Modeled on Tebra's Patient Broadcast tabs (Send Broadcast 3-step wizard / Broadcast History), adapted per the Adaptations section: recipients are filtered by trial/screening-status/form-status, not demographic tags, and the framing is internal pipeline notification rather than practice marketing.

**Files:**
- Create: `src/components/BroadcastWizard.tsx` (`'use client'`)
- Create: `src/app/(dashboard)/broadcasts/page.tsx`
- Create: `src/app/(dashboard)/broadcasts/[id]/page.tsx`

**Interfaces:**
- Consumes: `listBroadcasts`, `getBroadcast` (Task 2); `listAllTrials` (existing `src/lib/queries/trials.ts`); `GET /api/broadcasts/recipients`, `POST /api/broadcasts` (Task 3).
- Produces: `/broadcasts` (tabs) and `/broadcasts/[id]` routes, linked from `LeftNav` in Task 8.

- [ ] **Step 1: `src/components/BroadcastWizard.tsx`**

```typescript
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface Trial { id: string; condition: string }
interface RecipientCandidate { id: string; name: string; phone: string | null; email: string | null }

const OVERALL_STATUS_OPTIONS = [
  { value: '', label: 'Any status' },
  { value: 'green', label: 'Meets' },
  { value: 'yellow', label: 'Needs Verification' },
  { value: 'red', label: 'Potential Exclusion' },
]

const FORM_STATUS_OPTIONS = [
  { value: '', label: 'Any form status' },
  { value: 'sent', label: 'Form sent, not started' },
  { value: 'partial', label: 'Form partially completed' },
  { value: 'completed', label: 'Form completed' },
  { value: 'none', label: 'No form sent yet' },
]

export function BroadcastWizard({ trials }: { trials: Trial[] }) {
  const router = useRouter()
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [channel, setChannel] = useState<'sms' | 'email' | 'both'>('sms')
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [trialId, setTrialId] = useState('')
  const [overallStatus, setOverallStatus] = useState('')
  const [formStatus, setFormStatus] = useState('')
  const [candidates, setCandidates] = useState<RecipientCandidate[] | null>(null)
  const [loadingCandidates, setLoadingCandidates] = useState(false)
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState<{ recipientCount: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const messageTooLong = channel === 'sms' && message.length > 140
  const missingSubject = (channel === 'email' || channel === 'both') && subject.trim().length === 0

  async function loadCandidates() {
    setLoadingCandidates(true)
    setError(null)
    const params = new URLSearchParams()
    if (trialId) params.set('trialId', trialId)
    if (overallStatus) params.set('overallStatus', overallStatus)
    if (formStatus) params.set('formStatus', formStatus)
    const res = await fetch(`/api/broadcasts/recipients?${params.toString()}`)
    setLoadingCandidates(false)
    if (res.ok) {
      setCandidates(await res.json())
    } else {
      setError('Could not load recipients for this filter.')
    }
  }

  async function send() {
    setSending(true)
    setError(null)
    const res = await fetch('/api/broadcasts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject: subject || undefined,
        message,
        channel,
        filterTrialId: trialId || undefined,
        filterOverallStatus: overallStatus || undefined,
        filterFormStatus: formStatus || undefined,
      }),
    })
    setSending(false)
    if (res.ok) {
      const created = await res.json()
      setSent({ recipientCount: created.recipientCount })
      router.refresh()
    } else {
      const body = await res.json()
      setError(body.error ?? 'Could not send broadcast.')
    }
  }

  if (sent) {
    return (
      <div className="max-w-xl rounded-lg border border-border bg-card p-6">
        <p className="text-sm font-medium text-foreground">Broadcast sent to {sent.recipientCount} recipient{sent.recipientCount === 1 ? '' : 's'}.</p>
        <button
          onClick={() => { setSent(null); setStep(1); setMessage(''); setSubject(''); setCandidates(null) }}
          className="mt-4 rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary"
        >
          Send Another Broadcast
        </button>
      </div>
    )
  }

  return (
    <div className="max-w-xl">
      <div className="mb-6 flex gap-1 rounded-lg bg-secondary p-1 text-sm">
        {(['Write a Message', 'Specify Recipients', 'Review and Send'] as const).map((label, i) => (
          <span key={label} className={`flex-1 rounded-md px-3 py-1.5 text-center font-medium ${step === i + 1 ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground'}`}>
            {i + 1}. {label}
          </span>
        ))}
      </div>

      {error && <p className="mb-4 text-sm text-red-700">{error}</p>}

      {step === 1 && (
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Channel</label>
            <select value={channel} onChange={(e) => setChannel(e.target.value as 'sms' | 'email' | 'both')} className="w-full rounded-md border border-border px-3 py-2 text-sm">
              <option value="sms">SMS</option>
              <option value="email">Email</option>
              <option value="both">SMS and Email</option>
            </select>
          </div>
          {(channel === 'email' || channel === 'both') && (
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Subject</label>
              <input value={subject} onChange={(e) => setSubject(e.target.value)} className="w-full rounded-md border border-border px-3 py-2 text-sm" />
            </div>
          )}
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Message</label>
            <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={4} className="w-full rounded-md border border-border px-3 py-2 text-sm" />
            {channel === 'sms' && <p className={`mt-1 text-xs ${messageTooLong ? 'text-red-700' : 'text-muted-foreground'}`}>{message.length}/140 characters</p>}
          </div>
          <div className="flex justify-end">
            <button
              onClick={() => setStep(2)}
              disabled={message.trim().length === 0 || messageTooLong || missingSubject}
              className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              Next: Specify Recipients
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Trial</label>
            <select value={trialId} onChange={(e) => setTrialId(e.target.value)} className="w-full rounded-md border border-border px-3 py-2 text-sm">
              <option value="">All trials</option>
              {trials.map((t) => <option key={t.id} value={t.id}>{t.condition}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Screening Status</label>
            <select value={overallStatus} onChange={(e) => setOverallStatus(e.target.value)} className="w-full rounded-md border border-border px-3 py-2 text-sm">
              {OVERALL_STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Form Status</label>
            <select value={formStatus} onChange={(e) => setFormStatus(e.target.value)} className="w-full rounded-md border border-border px-3 py-2 text-sm">
              {FORM_STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <button onClick={loadCandidates} disabled={loadingCandidates} className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary disabled:opacity-50">
            {loadingCandidates ? 'Loading…' : 'Preview Recipients'}
          </button>
          {candidates && (
            <p className="text-sm text-foreground">{candidates.length} patient{candidates.length === 1 ? '' : 's'} match this filter.</p>
          )}
          <div className="flex justify-between">
            <button onClick={() => setStep(1)} className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary">Back</button>
            <button
              onClick={() => setStep(3)}
              disabled={!candidates || candidates.length === 0}
              className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              Next: Review and Send
            </button>
          </div>
        </div>
      )}

      {step === 3 && candidates && (
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Message</p>
            <p className="mt-1 text-sm text-foreground">{message}</p>
            <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Channel</p>
            <p className="mt-1 text-sm capitalize text-foreground">{channel === 'both' ? 'SMS and Email' : channel}</p>
            <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recipients</p>
            <p className="mt-1 text-sm text-foreground">{candidates.length} patient{candidates.length === 1 ? '' : 's'}</p>
            <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-sm text-muted-foreground">
              {candidates.map((c) => <li key={c.id}>{c.name}</li>)}
            </ul>
          </div>
          <div className="flex justify-between">
            <button onClick={() => setStep(2)} className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary">Back</button>
            <button onClick={send} disabled={sending} className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
              {sending ? 'Sending…' : 'Send Broadcast'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: `src/app/(dashboard)/broadcasts/page.tsx`**

```typescript
import Link from 'next/link'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listBroadcasts } from '@/lib/queries/broadcasts'
import { listAllTrials } from '@/lib/queries/trials'
import { BroadcastWizard } from '@/components/BroadcastWizard'

export default async function BroadcastsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const session = await requireSessionOrRedirect()
  const { tab } = await searchParams
  const activeTab = tab === 'history' ? 'history' : 'send'
  await logAudit(session, `viewed broadcasts (${activeTab})`, null)

  const trials = await listAllTrials()
  const broadcasts = activeTab === 'history' ? await listBroadcasts() : []

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-foreground">Patient Broadcast</h1>
      <div className="mb-6 flex w-fit gap-1 rounded-lg bg-secondary p-1 text-sm">
        <Link href="/broadcasts?tab=send" className={`rounded-md px-4 py-1.5 font-medium transition-colors ${activeTab === 'send' ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>Send Broadcast</Link>
        <Link href="/broadcasts?tab=history" className={`rounded-md px-4 py-1.5 font-medium transition-colors ${activeTab === 'history' ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>Broadcast History</Link>
      </div>

      {activeTab === 'send' ? (
        <BroadcastWizard trials={trials.map((t) => ({ id: t.id, condition: t.condition }))} />
      ) : broadcasts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No records found.</p>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sent</th>
              <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Channel</th>
              <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Message</th>
              <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Trial</th>
              <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recipients</th>
              <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Delivered</th>
              <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Failed</th>
              <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sent By</th>
            </tr>
          </thead>
          <tbody>
            {broadcasts.map((b, i) => {
              const delivered = b.recipients.filter((r) => r.deliveryStatus === 'delivered').length
              const failed = b.recipients.length - delivered
              return (
                <tr key={b.id} className={`border-b border-border ${i % 2 === 1 ? 'bg-muted/40' : ''} hover:bg-secondary`}>
                  <td className="p-3 text-muted-foreground">{new Date(b.sentAt).toLocaleDateString()}</td>
                  <td className="p-3 capitalize text-foreground">{b.channel === 'both' ? 'SMS + Email' : b.channel}</td>
                  <td className="p-3"><Link href={`/broadcasts/${b.id}`} className="font-medium text-primary hover:underline">{b.message.length > 60 ? `${b.message.slice(0, 60)}…` : b.message}</Link></td>
                  <td className="p-3 text-foreground">{b.trialCondition ?? 'All trials'}</td>
                  <td className="p-3 text-foreground">{b.recipientCount}</td>
                  <td className="p-3 text-emerald-800">{delivered}</td>
                  <td className="p-3 text-red-800">{failed}</td>
                  <td className="p-3 text-muted-foreground">{b.sentBy}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
```

- [ ] **Step 3: `src/app/(dashboard)/broadcasts/[id]/page.tsx`**

```typescript
import { notFound } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getBroadcast } from '@/lib/queries/broadcasts'

export default async function BroadcastDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSessionOrRedirect()
  const { id } = await params
  const broadcast = await getBroadcast(Number(id))
  if (!broadcast) notFound()
  await logAudit(session, `viewed broadcast ${id}`, null)

  return (
    <div className="max-w-2xl">
      <h1 className="mb-1 text-2xl font-bold text-foreground">{broadcast.subject || 'Broadcast'}</h1>
      <p className="mb-6 text-sm text-muted-foreground">{new Date(broadcast.sentAt).toLocaleString()} · {broadcast.trialCondition ?? 'All trials'} · Sent by {broadcast.sentBy}</p>
      <div className="mb-6 rounded-lg border border-border bg-card p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Message</p>
        <p className="mt-1 text-sm text-foreground">{broadcast.message}</p>
      </div>
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recipients ({broadcast.recipientCount})</h2>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Patient</th>
            <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Delivery Status</th>
          </tr>
        </thead>
        <tbody>
          {broadcast.recipients.map((r, i) => (
            <tr key={r.patientId} className={`border-b border-border ${i % 2 === 1 ? 'bg-muted/40' : ''}`}>
              <td className="p-3 text-foreground">{r.patientName}</td>
              <td className="p-3">
                <span className={`inline-flex items-center gap-1.5 text-sm font-medium ${r.deliveryStatus === 'delivered' ? 'text-emerald-800' : 'text-red-800'}`}>
                  <span className={`h-2 w-2 rounded-full ${r.deliveryStatus === 'delivered' ? 'bg-emerald-600' : 'bg-red-600'}`} aria-hidden="true" />
                  {r.deliveryStatus === 'delivered' ? 'Delivered' : 'Failed'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 4: Run the suite, manually verify, and commit**

Run: `npm test` and `npm run build`. Then `npm run dev` and manually confirm: `/broadcasts` shows the wizard by default; switching channel to Email requires a Subject before advancing; SMS messages over 140 characters block advancing; Specify Recipients previews a real, non-zero patient count for at least one filter combination; Review and Send lists the exact recipients and sending navigates to a confirmation state; `/broadcasts?tab=history` lists the 4 seeded broadcasts plus the new one, zebra-striped; clicking a row opens `/broadcasts/[id]` showing per-recipient delivered/failed dots.

```bash
git add src/components/BroadcastWizard.tsx src/app/\(dashboard\)/broadcasts
git commit -m "feat: add Patient Broadcast pages (send wizard, history, detail)"
```

---

### Task 5: Pre-Screening Experience Survey API routes

**Files:**
- Create: `src/app/api/reviews/route.ts` (GET list, POST send survey)
- Create: `src/app/api/reviews/[id]/route.ts` (GET detail, PUT record response)
- Test: `tests/api/reviews.test.ts`

**Interfaces:**
- Consumes: `listReviews`, `getReview`, `invalidateReviewsList` (Task 2); `formSubmissions` (Phase 1).
- Produces: `GET/POST /api/reviews`, `GET/PUT /api/reviews/[id]`, used by the survey pages in Task 6.

- [ ] **Step 1: `src/app/api/reviews/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDb } from '@/db/client'
import { reviews, formSubmissions } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listReviews, invalidateReviewsList } from '@/lib/queries/reviews'

const sendSurveySchema = z.object({ formSubmissionId: z.number().int().positive() }).strict()

export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session

  const url = new URL(request.url)
  const statusParam = url.searchParams.get('status')
  const filters = {
    status: statusParam === 'sent' || statusParam === 'completed' ? statusParam : undefined,
    dateFrom: url.searchParams.get('dateFrom') ?? undefined,
    dateTo: url.searchParams.get('dateTo') ?? undefined,
    sortBy: url.searchParams.get('sortBy') === 'ratingOverall' ? ('ratingOverall' as const) : ('sentAt' as const),
    sortDir: url.searchParams.get('sortDir') === 'asc' ? ('asc' as const) : ('desc' as const),
  }
  return NextResponse.json(await listReviews(filters))
}

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session

  const parsed = sendSurveySchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid send-survey payload', details: parsed.error.flatten() }, { status: 400 })

  const [submission] = await getDb().select().from(formSubmissions).where(eq(formSubmissions.id, parsed.data.formSubmissionId))
  if (!submission) return NextResponse.json({ error: 'Form submission not found' }, { status: 404 })
  if (submission.status !== 'completed') return NextResponse.json({ error: 'Can only survey a completed intake submission' }, { status: 400 })

  const [existing] = await getDb().select().from(reviews).where(eq(reviews.formSubmissionId, parsed.data.formSubmissionId))
  if (existing) return NextResponse.json({ error: 'A survey has already been sent for this submission' }, { status: 409 })

  const [created] = await getDb()
    .insert(reviews)
    .values({ patientId: submission.patientId, formSubmissionId: submission.id, sentBy: session.name })
    .returning()

  await invalidateReviewsList()
  await logAudit(session, 'sent pre-screening experience survey', submission.patientId)
  return NextResponse.json(created, { status: 201 })
}
```

- [ ] **Step 2: `src/app/api/reviews/[id]/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDb } from '@/db/client'
import { reviews } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getReview, invalidateReviewsList } from '@/lib/queries/reviews'

const recordResponseSchema = z
  .object({
    ratingOverall: z.number().int().min(1).max(5),
    ratingFormsClarity: z.number().int().min(1).max(5),
    ratingCommunication: z.number().int().min(1).max(5),
    comments: z.string().max(2000).optional(),
  })
  .strict()

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  const { id } = await params
  const review = await getReview(Number(id))
  if (!review) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(review)
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  const { id } = await params

  const parsed = recordResponseSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid survey response payload', details: parsed.error.flatten() }, { status: 400 })

  const existing = await getReview(Number(id))
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (existing.status === 'completed') return NextResponse.json({ error: 'This survey response has already been recorded' }, { status: 409 })

  await getDb()
    .update(reviews)
    .set({ ratingOverall: parsed.data.ratingOverall, ratingFormsClarity: parsed.data.ratingFormsClarity, ratingCommunication: parsed.data.ratingCommunication, comments: parsed.data.comments ?? null, status: 'completed', respondedAt: new Date() })
    .where(eq(reviews.id, Number(id)))

  await invalidateReviewsList()
  await logAudit(session, 'recorded pre-screening experience survey response', existing.patientId)
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 3: Test**

`tests/api/reviews.test.ts`:
```typescript
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { getDb } from '@/db/client'
import { formSubmissions, reviews } from '@/db/schema'
import { eq, and } from 'drizzle-orm'
import { GET as listReviews, POST as sendSurvey } from '@/app/api/reviews/route'
import { PUT as recordResponse } from '@/app/api/reviews/[id]/route'

vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: 'crc', name: 'Jamie Ruiz' })) }))

describe('GET /api/reviews', () => {
  it('returns the seeded survey records', async () => {
    const req = new Request('http://localhost/api/reviews')
    const res = await listReviews(req as never)
    const body = await res.json()
    expect(body.length).toBeGreaterThanOrEqual(3)
  })
})

describe('POST /api/reviews', () => {
  it('rejects sending a survey for a submission that is not completed', async () => {
    const [pending] = await getDb().select().from(formSubmissions).where(eq(formSubmissions.status, 'sent'))
    const req = new Request('http://localhost/api/reviews', { method: 'POST', body: JSON.stringify({ formSubmissionId: pending.id }) })
    const res = await sendSurvey(req as never)
    expect(res.status).toBe(400)
  })

  it('rejects sending a second survey for the same submission', async () => {
    const [alreadySurveyed] = await getDb().select().from(formSubmissions).where(and(eq(formSubmissions.patientId, 'RD-0001'), eq(formSubmissions.status, 'completed')))
    const req = new Request('http://localhost/api/reviews', { method: 'POST', body: JSON.stringify({ formSubmissionId: alreadySurveyed.id }) })
    const res = await sendSurvey(req as never)
    expect(res.status).toBe(409)
  })
})

describe('PUT /api/reviews/[id]', () => {
  // RD-0002's seeded survey is the one 'sent'-but-not-completed review; this
  // suite mutates it, then restores the original row so re-running the
  // suite (without a full reseed in between) stays idempotent, matching the
  // snapshot-restore pattern in tests/api/trials.test.ts.
  let reviewId: number
  let originalRow: typeof reviews.$inferSelect

  beforeAll(async () => {
    const [row] = await getDb().select().from(reviews).where(eq(reviews.status, 'sent'))
    reviewId = row.id
    originalRow = row
  })

  afterAll(async () => {
    await getDb().update(reviews).set(originalRow).where(eq(reviews.id, reviewId))
  })

  it('rejects an out-of-range rating', async () => {
    const req = new Request(`http://localhost/api/reviews/${reviewId}`, { method: 'PUT', body: JSON.stringify({ ratingOverall: 6, ratingFormsClarity: 5, ratingCommunication: 5 }) })
    const res = await recordResponse(req as never, { params: Promise.resolve({ id: String(reviewId) }) })
    expect(res.status).toBe(400)
  })

  it('records a valid response', async () => {
    const req = new Request(`http://localhost/api/reviews/${reviewId}`, { method: 'PUT', body: JSON.stringify({ ratingOverall: 4, ratingFormsClarity: 4, ratingCommunication: 5, comments: 'Great experience.' }) })
    const res = await recordResponse(req as never, { params: Promise.resolve({ id: String(reviewId) }) })
    expect(res.status).toBe(200)
  })

  it('rejects recording a response twice', async () => {
    const req = new Request(`http://localhost/api/reviews/${reviewId}`, { method: 'PUT', body: JSON.stringify({ ratingOverall: 5, ratingFormsClarity: 5, ratingCommunication: 5 }) })
    const res = await recordResponse(req as never, { params: Promise.resolve({ id: String(reviewId) }) })
    expect(res.status).toBe(409)
  })
})
```

- [ ] **Step 4: Run the suite and commit**

Run: `npm test` and `npm run build` — both must be clean.

```bash
git add src/app/api/reviews tests/api/reviews.test.ts
git commit -m "feat: add Pre-Screening Experience Survey API routes"
```

---

### Task 6: Pre-Screening Experience Survey pages

Modeled on Tebra's "Review Activity" list pattern (Sort By, Filter By, date range), adapted per the Adaptations section into a short, staff-recorded satisfaction survey tied to a completed Phase 1 form submission — no public ratings, no public review requests.

**Files:**
- Create: `src/components/SendSurveyButton.tsx` (`'use client'`)
- Create: `src/components/RecordSurveyResponseForm.tsx` (`'use client'`)
- Create: `src/app/(dashboard)/experience-surveys/page.tsx`
- Create: `src/app/(dashboard)/experience-surveys/[id]/page.tsx`

**Interfaces:**
- Consumes: `listReviews`, `listSurveyableSubmissions`, `getAverageExperienceRating`, `getReview` (Task 2); `POST /api/reviews`, `PUT /api/reviews/[id]` (Task 5).
- Produces: `/experience-surveys` and `/experience-surveys/[id]` routes, linked from `LeftNav` in Task 8.

- [ ] **Step 1: `src/components/SendSurveyButton.tsx`**

```typescript
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface Candidate { formSubmissionId: number; patientId: string; patientName: string; templateName: string; completedDate: string | null }

export function SendSurveyButton({ candidates }: { candidates: Candidate[] }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<number | null>(candidates[0]?.formSubmissionId ?? null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function send() {
    if (selected === null) return
    setSending(true)
    setError(null)
    const res = await fetch('/api/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ formSubmissionId: selected }),
    })
    setSending(false)
    if (res.ok) {
      setOpen(false)
      router.refresh()
    } else {
      const body = await res.json()
      setError(body.error ?? 'Could not send survey.')
    }
  }

  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90">
        Send Survey
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-80 rounded-lg border border-border bg-card p-4 shadow-lg">
          {candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">No completed intakes are eligible for a survey right now.</p>
          ) : (
            <>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Patient</label>
              <select value={selected ?? ''} onChange={(e) => setSelected(Number(e.target.value))} className="mb-3 w-full rounded-md border border-border px-3 py-2 text-sm">
                {candidates.map((c) => <option key={c.formSubmissionId} value={c.formSubmissionId}>{c.patientName} — {c.templateName}</option>)}
              </select>
              {error && <p className="mb-2 text-sm text-red-700">{error}</p>}
              <button onClick={send} disabled={sending} className="w-full rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
                {sending ? 'Sending…' : 'Send'}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: `src/components/RecordSurveyResponseForm.tsx`**

```typescript
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

export function RecordSurveyResponseForm({ reviewId }: { reviewId: number }) {
  const router = useRouter()
  const [ratingOverall, setRatingOverall] = useState(5)
  const [ratingFormsClarity, setRatingFormsClarity] = useState(5)
  const [ratingCommunication, setRatingCommunication] = useState(5)
  const [comments, setComments] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setSaving(true)
    setError(null)
    const res = await fetch(`/api/reviews/${reviewId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ratingOverall, ratingFormsClarity, ratingCommunication, comments: comments || undefined }),
    })
    setSaving(false)
    if (res.ok) {
      router.refresh()
    } else {
      const body = await res.json()
      setError(body.error ?? 'Could not record this response.')
    }
  }

  function ratingField(label: string, value: number, onChange: (v: number) => void) {
    return (
      <div>
        <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</label>
        <select value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full rounded-md border border-border px-3 py-2 text-sm">
          {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-red-700">{error}</p>}
      {ratingField('Overall Experience (1-5)', ratingOverall, setRatingOverall)}
      {ratingField('Forms Were Clear (1-5)', ratingFormsClarity, setRatingFormsClarity)}
      {ratingField('Communication Was Easy (1-5)', ratingCommunication, setRatingCommunication)}
      <div>
        <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Comments</label>
        <textarea value={comments} onChange={(e) => setComments(e.target.value)} rows={3} className="w-full rounded-md border border-border px-3 py-2 text-sm" />
      </div>
      <button onClick={save} disabled={saving} className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
        {saving ? 'Saving…' : 'Record Response'}
      </button>
    </div>
  )
}
```

- [ ] **Step 3: `src/app/(dashboard)/experience-surveys/page.tsx`**

```typescript
import Link from 'next/link'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listReviews, listSurveyableSubmissions, getAverageExperienceRating } from '@/lib/queries/reviews'
import { SendSurveyButton } from '@/components/SendSurveyButton'

export default async function ExperienceSurveysPage({ searchParams }: { searchParams: Promise<{ status?: string; dateFrom?: string; dateTo?: string; sortBy?: string; sortDir?: string }> }) {
  const session = await requireSessionOrRedirect()
  const sp = await searchParams
  const filters = {
    status: sp.status === 'sent' || sp.status === 'completed' ? (sp.status as 'sent' | 'completed') : undefined,
    dateFrom: sp.dateFrom,
    dateTo: sp.dateTo,
    sortBy: sp.sortBy === 'ratingOverall' ? ('ratingOverall' as const) : ('sentAt' as const),
    sortDir: sp.sortDir === 'asc' ? ('asc' as const) : ('desc' as const),
  }
  const [reviewsList, surveyable, averageRating] = await Promise.all([
    listReviews(filters),
    listSurveyableSubmissions(),
    getAverageExperienceRating(),
  ])
  await logAudit(session, 'viewed pre-screening experience surveys', null)

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Pre-Screening Experience Surveys</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {averageRating !== null ? `Average rating: ${averageRating.toFixed(1)} / 5 across ${reviewsList.filter((r) => r.status === 'completed').length} responses` : 'No responses recorded yet.'}
          </p>
        </div>
        <SendSurveyButton candidates={surveyable} />
      </div>

      <form className="mb-4 flex flex-wrap items-end gap-3 text-sm" action="/experience-surveys">
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Filter By</label>
          <select name="status" defaultValue={filters.status ?? ''} className="rounded-md border border-border px-3 py-2">
            <option value="">All statuses</option>
            <option value="sent">Sent</option>
            <option value="completed">Completed</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">From</label>
          <input type="date" name="dateFrom" defaultValue={filters.dateFrom ?? ''} className="rounded-md border border-border px-3 py-2" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">To</label>
          <input type="date" name="dateTo" defaultValue={filters.dateTo ?? ''} className="rounded-md border border-border px-3 py-2" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sort By</label>
          <select name="sortBy" defaultValue={filters.sortBy} className="rounded-md border border-border px-3 py-2">
            <option value="sentAt">Date Sent</option>
            <option value="ratingOverall">Rating</option>
          </select>
        </div>
        <button type="submit" className="rounded-md border border-border px-4 py-2 font-medium text-foreground hover:bg-secondary">Apply</button>
      </form>

      {reviewsList.length === 0 ? (
        <p className="text-sm text-muted-foreground">No records found.</p>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Patient</th>
              <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Form</th>
              <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</th>
              <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Rating</th>
              <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sent</th>
              <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Responded</th>
            </tr>
          </thead>
          <tbody>
            {reviewsList.map((r, i) => (
              <tr key={r.id} className={`border-b border-border ${i % 2 === 1 ? 'bg-muted/40' : ''} hover:bg-secondary`}>
                <td className="p-3"><Link href={`/experience-surveys/${r.id}`} className="font-medium text-primary hover:underline">{r.patientName}</Link></td>
                <td className="p-3 text-foreground">{r.templateName}</td>
                <td className="p-3 capitalize text-foreground">{r.status}</td>
                <td className="p-3 text-foreground">{r.ratingOverall ?? '—'}</td>
                <td className="p-3 text-muted-foreground">{new Date(r.sentAt).toLocaleDateString()}</td>
                <td className="p-3 text-muted-foreground">{r.respondedAt ? new Date(r.respondedAt).toLocaleDateString() : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
```

- [ ] **Step 4: `src/app/(dashboard)/experience-surveys/[id]/page.tsx`**

```typescript
import { notFound } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getReview } from '@/lib/queries/reviews'
import { RecordSurveyResponseForm } from '@/components/RecordSurveyResponseForm'

export default async function ExperienceSurveyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSessionOrRedirect()
  const { id } = await params
  const review = await getReview(Number(id))
  if (!review) notFound()
  await logAudit(session, `viewed pre-screening experience survey ${id}`, review.patientId)

  return (
    <div className="max-w-xl">
      <h1 className="mb-1 text-2xl font-bold text-foreground">{review.patientName}</h1>
      <p className="mb-6 text-sm text-muted-foreground">{review.templateName} · Sent {new Date(review.sentAt).toLocaleDateString()}</p>

      {review.status === 'completed' ? (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-lg border border-border bg-card p-4 text-center">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Overall</p>
              <p className="mt-1 text-2xl font-bold text-foreground">{review.ratingOverall}/5</p>
            </div>
            <div className="rounded-lg border border-border bg-card p-4 text-center">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Forms Clarity</p>
              <p className="mt-1 text-2xl font-bold text-foreground">{review.ratingFormsClarity}/5</p>
            </div>
            <div className="rounded-lg border border-border bg-card p-4 text-center">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Communication</p>
              <p className="mt-1 text-2xl font-bold text-foreground">{review.ratingCommunication}/5</p>
            </div>
          </div>
          {review.comments && (
            <div className="rounded-lg border border-border bg-card p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Comments</p>
              <p className="mt-1 text-sm text-foreground">{review.comments}</p>
            </div>
          )}
          <p className="text-xs text-muted-foreground">Responded {new Date(review.respondedAt!).toLocaleDateString()}</p>
        </div>
      ) : (
        <RecordSurveyResponseForm reviewId={review.id} />
      )}
    </div>
  )
}
```

- [ ] **Step 5: Run the suite, manually verify, and commit**

Run: `npm test` and `npm run build`. Then `npm run dev` and manually confirm: `/experience-surveys` shows the average rating summary and the 3 seeded rows; the Filter By/date-range/Sort By form updates the list via the URL query string; "Send Survey" only lists completed submissions that don't already have a survey; opening a `sent` row shows the Record Response form, and submitting it flips the row to `completed` with the entered ratings/comments visible; opening a `completed` row shows read-only ratings.

```bash
git add src/components/SendSurveyButton.tsx src/components/RecordSurveyResponseForm.tsx src/app/\(dashboard\)/experience-surveys
git commit -m "feat: add Pre-Screening Experience Survey pages"
```

---

### Task 7: Pipeline Performance Dashboard

Reuses Tebra's KPI-card-row + date-range-preset layout pattern with a pipeline-relevant metric set (see Adaptations #4) instead of ROI/reviews/online-presence metrics.

**Files:**
- Create: `src/app/(dashboard)/pipeline-dashboard/page.tsx`

**Interfaces:**
- Consumes: `getPipelinePerformance` (Task 2).
- Produces: `/pipeline-dashboard` route, linked from `LeftNav` in Task 8.

- [ ] **Step 1: `src/app/(dashboard)/pipeline-dashboard/page.tsx`**

```typescript
import Link from 'next/link'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getPipelinePerformance } from '@/lib/queries/pipeline-dashboard'

const PRESETS = [
  { key: 'week', label: 'This Week' },
  { key: 'month', label: 'This Month' },
  { key: 'last30', label: 'Last 30 Days' },
] as const

function resolveRange(preset: string | undefined, from: string | undefined, to: string | undefined) {
  const now = new Date()
  if (preset === 'custom' && from && to) {
    return { from: new Date(from), to: new Date(to), preset: 'custom' as const }
  }
  if (preset === 'week') {
    const start = new Date(now)
    start.setDate(now.getDate() - now.getDay())
    start.setHours(0, 0, 0, 0)
    return { from: start, to: now, preset: 'week' as const }
  }
  if (preset === 'last30') {
    const start = new Date(now)
    start.setDate(now.getDate() - 30)
    return { from: start, to: now, preset: 'last30' as const }
  }
  const start = new Date(now.getFullYear(), now.getMonth(), 1)
  return { from: start, to: now, preset: 'month' as const }
}

export default async function PipelineDashboardPage({ searchParams }: { searchParams: Promise<{ preset?: string; from?: string; to?: string }> }) {
  const session = await requireSessionOrRedirect()
  const sp = await searchParams
  const range = resolveRange(sp.preset, sp.from, sp.to)
  const performance = await getPipelinePerformance({ from: range.from, to: range.to })
  await logAudit(session, 'viewed pipeline performance dashboard', null)

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">Pipeline Performance</h1>
        <div className="flex gap-1 rounded-lg bg-secondary p-1 text-sm">
          {PRESETS.map((p) => (
            <Link key={p.key} href={`/pipeline-dashboard?preset=${p.key}`} className={`rounded-md px-3 py-1.5 font-medium transition-colors ${range.preset === p.key ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>{p.label}</Link>
          ))}
        </div>
      </div>

      <form className="mb-6 flex items-end gap-3 text-sm" action="/pipeline-dashboard">
        <input type="hidden" name="preset" value="custom" />
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">From</label>
          <input type="date" name="from" defaultValue={range.from.toISOString().slice(0, 10)} className="rounded-md border border-border px-3 py-2" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">To</label>
          <input type="date" name="to" defaultValue={range.to.toISOString().slice(0, 10)} className="rounded-md border border-border px-3 py-2" />
        </div>
        <button type="submit" className="rounded-md border border-border px-4 py-2 font-medium text-foreground hover:bg-secondary">Update</button>
      </form>

      <div className="grid grid-cols-4 gap-4">
        <div className="rounded-lg border border-border bg-card p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Referrals Received</p>
          <p className="mt-2 text-3xl font-bold text-foreground">{performance.referralsReceived}</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Forms Completed</p>
          <p className="mt-2 text-3xl font-bold text-foreground">{performance.formsCompleted}</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Patients Classified</p>
          <p className="mt-2 text-3xl font-bold text-foreground">{performance.patientsClassified}</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Avg. Days Referral → Classification</p>
          <p className="mt-2 text-3xl font-bold text-foreground">{performance.avgDaysToClassify !== null ? performance.avgDaysToClassify.toFixed(1) : '—'}</p>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Run the suite, manually verify, and commit**

Run: `npm test` and `npm run build`. Then `npm run dev` and manually confirm: `/pipeline-dashboard` defaults to "This Month" and shows non-zero KPI values (Task 1's staggered `dateAdded`/`chartDataAsOf` seed values make this demonstrable); switching to "This Week"/"Last 30 Days" changes the figures; the custom From/To form updates the URL and figures; a date range with no data (e.g., a range entirely in the past before any seeded patient existed) shows `0`/`—` rather than an error.

```bash
git add src/app/\(dashboard\)/pipeline-dashboard
git commit -m "feat: add Pipeline Performance Dashboard"
```

---

### Task 8: Left navigation entries

**Files:**
- Modify: `src/components/LeftNav.tsx`

**Interfaces:**
- Consumes: routes from Tasks 4, 6, 7.

- [ ] **Step 1: Add the three Engagement entries**

Per the cross-phase navigation order (`docs/superpowers/specs/2026-09-17-full-platform-phases-design.md` §5: "... Engagement (Phase 5), Audit Log ..."), insert three flat entries into the existing `ITEMS` array in `src/components/LeftNav.tsx`, immediately before the `Audit Log` entry (Online Presence has no entry anywhere, per Adaptation #3):

```typescript
const ITEMS = [
  { href: '/patients', label: 'Patients' },
  { href: '/identity-matching', label: 'Identity Matching' },
  { href: '/trials', label: 'Trials & Protocols' },
  { href: '/broadcasts', label: 'Broadcasts' },
  { href: '/experience-surveys', label: 'Experience Surveys' },
  { href: '/pipeline-dashboard', label: 'Pipeline Dashboard' },
  { href: '/audit-log', label: 'Audit Log' },
  { href: '/settings', label: 'Settings' },
]
```

(No other changes to the component. If Phase 2, 3, or 4 have already added their own entries by the time this task runs, insert these three immediately before whatever entry currently occupies the "Audit Log" position, not necessarily the literal array shown above — the ordering rule, not the exact array contents, is what must hold.)

- [ ] **Step 2: Run the suite and commit**

Run: `npm test` and `npm run build` — both must be clean.

```bash
git add src/components/LeftNav.tsx
git commit -m "feat: add Engagement nav entries"
```

---

### Task 9: Final QA pass (local only — no push)

**Files:** none created; verification only.

- [ ] **Step 1: Full-tree greps, scoped to this phase's new files**

```bash
grep -rn "TODO\|TBD\|FIXME\|placeholder" src/app/api/broadcasts src/app/api/reviews src/app/\(dashboard\)/broadcasts src/app/\(dashboard\)/experience-surveys src/app/\(dashboard\)/pipeline-dashboard src/lib/queries/broadcasts.ts src/lib/queries/reviews.ts src/lib/queries/pipeline-dashboard.ts src/components/BroadcastWizard.tsx src/components/SendSurveyButton.tsx src/components/RecordSurveyResponseForm.tsx
grep -rn "lucide-react" src/app/api/broadcasts src/app/api/reviews src/app/\(dashboard\)/broadcasts src/app/\(dashboard\)/experience-surveys src/app/\(dashboard\)/pipeline-dashboard src/components/BroadcastWizard.tsx src/components/SendSurveyButton.tsx src/components/RecordSurveyResponseForm.tsx
grep -rn "bg-slate-\|text-green-700\|text-blue-700\|text-purple-700\|bg-green-700\|text-amber-700" src/app/api/broadcasts src/app/api/reviews src/app/\(dashboard\)/broadcasts src/app/\(dashboard\)/experience-surveys src/app/\(dashboard\)/pipeline-dashboard src/components/BroadcastWizard.tsx src/components/SendSurveyButton.tsx src/components/RecordSurveyResponseForm.tsx
grep -rln "Online Presence\|public review\|star rating\|ROI Calculator\|Tebra Community" src/app src/components
```

All four must return zero matches (the third grep intentionally does not flag `emerald-800`/`red-800`, the accepted status-color convention this plan reuses from `StatusChip.tsx`; the fourth confirms no trace of the dropped Online Presence / public-review / ROI / vendor-ecosystem features leaked into implementation).

- [ ] **Step 2: `npm test` and `npm run build`**

Both must be 100% clean.

- [ ] **Step 3: Manual browser walkthrough**

Log in as each of the 3 demo roles and visit every screen this plan added: `/broadcasts` (both tabs), `/broadcasts/[id]`, `/experience-surveys`, `/experience-surveys/[id]` (one `sent`, one `completed`), `/pipeline-dashboard` (all 3 presets + custom range). Confirm:
- Every list/table is zebra-striped and has a plain-text empty state, never an illustration.
- Every status/delivery indicator is a colored dot plus a text label, never color or an icon alone.
- At most one `bg-accent` button is visible at a time on every screen (wizard steps, Send Survey, Record Response).
- The Patient Broadcast wizard genuinely blocks sending on a too-long SMS or a missing email subject, and the recipient count shown at Review and Send matches what was actually sent (cross-check against the Broadcast History row afterward).
- The Experience Survey list's Filter By / Sort By / date-range controls actually change the results (not just cosmetic).
- The Pipeline Dashboard's 4 KPI numbers are non-zero for "This Month" (from Task 1's seeded date staggering) and change when switching presets.
- `LeftNav` shows exactly 3 new entries (Broadcasts, Experience Surveys, Pipeline Dashboard) in the position specified by the cross-phase nav order, with no Online Presence entry anywhere.

- [ ] **Step 4: Confirm nothing pushed yet**

```bash
git status --porcelain
git log --oneline origin/master..HEAD
```

Everything from this plan should be committed locally but **not yet pushed** — pushing and deployment happen only after this Final QA pass is confirmed clean and the user has reviewed the work, per the project's standing "test locally... before pushing into git" instruction.

## Self-Review

**Placeholder scan.** This plan document itself contains no `TODO`/`TBD`/`FIXME`/placeholder markers, no stubbed function bodies, and no "left as an exercise" steps — every schema field, query function, Zod schema, API route, and page/component above is complete, runnable code. The one intentionally deferred item (a recharts trend chart) is explicitly named as **out of scope**, not silently dropped or half-built — see "Prerequisites."

**Type/interface consistency.** Field names are spelled identically end-to-end for both new entities: `broadcasts` — `subject`/`message`/`channel`/`filterTrialId`/`filterOverallStatus`/`filterFormStatus`/`recipients`/`recipientCount`/`sentBy`/`sentAt` appear with the same names and shapes in the Drizzle table (Task 1), the query layer (Task 2), the Zod schema and route handlers (Task 3), and the wizard/history/detail UI (Task 4). `reviews` — `patientId`/`formSubmissionId`/`status`/`sentAt`/`respondedAt`/`ratingOverall`/`ratingFormsClarity`/`ratingCommunication`/`comments`/`sentBy` likewise thread consistently through Tasks 1, 2, 5, and 6. The `deliveryStatus: 'delivered' | 'failed'` union and the `BroadcastRecipientFilters`/`ReviewFilters`/`PipelinePerformance` interfaces are each defined once (in `src/lib/queries/*.ts`) and imported everywhere else they're used, rather than redeclared with drift.

**Spec coverage against the adapted scope** (not the raw, unadapted catalog):
- Patient Broadcast Send/History tabs → Tasks 3–4 (wizard steps match the catalog's 3-step pattern; recipient filters match Clinsync's real segmentation axes per Adaptation #1).
- Surveys & Reviews (Review Activity list; Sort By/Filter By/date range) → Tasks 5–6, re-scoped to a private 1–5 satisfaction survey per Adaptation #2. The catalog's public review-request toggle, review-allocation, and AI-response promo banner are not built — they have no meaning under the adapted scope.
- Online Presence → not built anywhere in this plan; Adaptation #3 documents why, and Task 9 Step 1's fourth grep verifies no trace of it leaked in.
- Performance Dashboard → Task 7, re-scoped to referral/form/classification KPIs per Adaptation #4. ROI, review-count, and online-presence-monitoring tiles are not built.
- Cross-cutting exclusions already ledgered in the architecture spec (Patient Experience upsell page, MIPS/Quality Measures, Tebra Community/Customer Care links) have no representation anywhere in this plan, confirmed by the same grep.
- Every new write path (`POST /api/broadcasts`, `POST /api/reviews`, `PUT /api/reviews/[id]`) validates with a `.strict()` Zod schema and calls `logAudit`; every new page calls `requireSessionOrRedirect()` first; every new list is zebra-striped with a plain-text empty state — the plan's Global Constraints are satisfied by construction in each task, not bolted on at the end.
