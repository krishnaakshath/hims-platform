# Care Plans Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Clinsync a real care-plan lifecycle — a patient's active set of named, trackable treatment goals, superseded (not deleted) whenever a new plan is created — plus a Care Plan section on the Medical Record page and a create/update action from the patient chart.

**Architecture:** `carePlans` is the lifecycle row (one `active` row per patient at a time, enforced at the single write path per spec §2/§3, the same "write-path-enforced, no partial unique index" reasoning already applied to `identityVerifications.patientId`). `carePlanGoals` is a one-to-many side table off `carePlans`, separate because each goal is individually status-updated over time with its own timestamp/authorship — the same reasoning `allergies` and `staffCredentials` are side tables rather than arrays-on-parent elsewhere in this codebase. No catalog/seed table is needed here (unlike the sibling Lab Orders and Pharmacy plans) — a care plan's goals are free text the provider writes, not drawn from a reference list.

**Tech Stack:** Next.js 16 App Router (Server Components) + Drizzle ORM over a `pg` Pool (additive-only schema changes via a hand-written one-off script, never `drizzle-kit push`) + `@base-ui/react`-backed `Dialog` primitive (`@/components/ui/dialog`) + Tailwind v4 oklch tokens.

**Spec:** `docs/superpowers/specs/2026-09-28-care-plans.md`

**Working directory note:** this plan is executed in an isolated git worktree at `/Users/k2a/Desktop/clinsync/.worktrees/care-plans` on branch `feature/care-plans`, forked from `hims-platform`. This worktree has its own `.env.local` and `node_modules` already set up. Every implementer/reviewer dispatch for this plan must work from this exact directory, not the main checkout — the main checkout and other worktrees (notably `.worktrees/lab-orders-results` and `.worktrees/pharmacy-med-inventory`, which have their own concurrent or already-merged work) must not be touched.

## Global Constraints

- Additive-only schema changes. Apply via a hand-written one-off script run with `npx dotenv -e .env.local -- npx tsx <script>` — never `drizzle-kit push`. This is a **single shared Neon Postgres database across every branch/worktree** — a schema mistake here is visible everywhere immediately, including the main checkout and every other active worktree.
- `psql` is not installed in this environment — verify a migration's live-DB effect with a Node script using `pg`'s `Pool` and an `information_schema.columns` query.
- Every write route uses `.strict()` Zod validation — this also does the work of rejecting a client-supplied `statusUpdatedByName` (Review Focus #4): an unknown key on a `.strict()` schema is a 400, not a silently-dropped field.
- Every state-changing route calls `logAudit(session, <action>, patientId)`.
- Every protected route/page starts with `requireSession()` (API routes) or `requireSessionOrRedirect()` (pages) as its first statement.
- Role gating per spec §6: view care plan (read) = admin, pi, crc, frontdesk. Create/update a care plan or goal (write) = admin, pi only (a clinical judgment).
- Status transitions are conditional UPDATEs guarded by current status in the `WHERE` clause (`WHERE id = ? AND status = 'active'`, etc.) — never a read-then-write — matching this codebase's established conditional-transition-guard pattern (MAR's `administerMedication`, encounter notes' `signNote`, the sibling Pharmacy plan's stock decrement).
- A goal only ever moves forward from `active` to a terminal status (`met`/`not_met`/`discontinued`); there is no route anywhere that reopens a resolved goal — matching the append-only "never silently rewrite a clinical fact" principle already applied to encounter-note signing and dispense records.
- Commit messages end with no attribution trailer.
- UI verification discipline: verify via a real running dev server hit with real HTTP requests (mint a session cookie the way `src/lib/auth.ts` actually does it — `SignJWT` under cookie `clinsync_demo_session`, secret from `SESSION_SECRET`), with actual commands and actual output pasted in the report. Never a narrated, unreproduced claim — this session has a standing rule against exactly that after a prior implementer fabricated UI-verification evidence.
- Vitest invocation: `npx dotenv -e .env.local -- npx vitest run <path>` (`fileParallelism: false`).

## Review Focus

1. **Creating a new plan supersedes the prior active one — it's not deleted.** The old plan's row must persist with `status = 'superseded'` and `supersededAt` set, still visible in history; a reasonable person expects "start a new plan" to never silently erase a patient's prior treatment goals. (Task 2)
2. **A patient's care-plan history stays independent from another patient's.** `listCarePlansForPatient` and the create route must key strictly off the specific patient — matching this session's established review-focus pattern for the Pharmacy plan's dispense history and the Lab Orders plan's result history. (Task 2)
3. **Transitioning an already-terminal goal is rejected with 409, not silently no-op'd.** A `met`/`not_met`/`discontinued` goal is done; a second status-change call on it must fail loudly, not quietly succeed-and-do-nothing or quietly overwrite the prior clinical determination. (Task 2)
4. **`statusUpdatedByName` is genuinely captured from the session, never client-supplied**, even when the request body includes it. A caller crafting `{ status: 'met', statusUpdatedByName: 'Dr. Someone Else' }` must not get to attribute the change to a name of their choosing — `.strict()` Zod rejects the extra key outright. (Task 2)
5. **Two concurrent status-update calls on the same active goal must not both succeed.** The transition is a single conditional UPDATE (`WHERE id = ? AND status = 'active'`), so only one of two racing `PATCH` calls can win; the loser gets the same 409 as any other terminal-state rejection, not a lost-update silently applied on top. (Task 2)

---

### Task 1: Schema — `care_plans`, `care_plan_goals`

**Files:**
- Modify: `src/db/schema.ts`
- Test: `tests/db/care-plans-schema.test.ts`

**Interfaces:**
- Produces: `carePlanStatusEnum`, `carePlanGoalStatusEnum`, `carePlans` table (`id, patientId, title, authorName, status, startedAt, nextReviewDate, supersededAt`), `carePlanGoals` table (`id, carePlanId, description, targetDate, status, statusUpdatedAt, statusUpdatedByName`). Consumed by Task 2.

- [ ] **Step 1: Write the failing test**

Create `tests/db/care-plans-schema.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, carePlans, carePlanGoals } from '@/db/schema'

const createdPlanIds: number[] = []
afterEach(async () => {
  while (createdPlanIds.length > 0) {
    const id = createdPlanIds.pop()!
    await getDb().delete(carePlanGoals).where(eq(carePlanGoals.carePlanId, id))
    await getDb().delete(carePlans).where(eq(carePlans.id, id))
  }
})

describe('care plans schema', () => {
  it('creates a plan with a goal, defaulting to active status', async () => {
    const db = getDb()
    const [patientRow] = await db.select().from(patients).limit(1)

    const [plan] = await db.insert(carePlans).values({ patientId: patientRow.id, title: 'Test Plan', authorName: 'Dr. Test' }).returning()
    createdPlanIds.push(plan.id)
    expect(plan.status).toBe('active')
    expect(plan.supersededAt).toBeNull()

    const [goal] = await db.insert(carePlanGoals).values({ carePlanId: plan.id, description: 'Attend weekly CBT' }).returning()
    expect(goal.status).toBe('active')
    expect(goal.statusUpdatedAt).toBeNull()
    expect(goal.statusUpdatedByName).toBeNull()
  })

  it('rejects a goal referencing a nonexistent care plan', async () => {
    const db = getDb()
    await expect(db.insert(carePlanGoals).values({ carePlanId: 999999999, description: 'Orphan goal' })).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/care-plans-schema.test.ts`
Expected: FAIL — tables don't exist / not exported.

- [ ] **Step 3: Add the schema definitions**

In `src/db/schema.ts`, add near the other clinical/lifecycle table definitions (values copied verbatim from spec §2):

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

- [ ] **Step 4: Run the test again — expect a different failure**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/care-plans-schema.test.ts`
Expected: FAIL — now a runtime DB error (relation does not exist), not an import error.

- [ ] **Step 5: Write and run the one-off migration script**

Scratch, not part of the repo. Create `migrate-care-plans-scratch.ts` at this worktree's root (`/Users/k2a/Desktop/clinsync/.worktrees/care-plans`):

```ts
import { Pool } from 'pg'

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false } })

  await pool.query(`DO $$ BEGIN CREATE TYPE care_plan_status AS ENUM ('active', 'superseded'); EXCEPTION WHEN duplicate_object THEN null; END $$;`)
  await pool.query(`DO $$ BEGIN CREATE TYPE care_plan_goal_status AS ENUM ('active', 'met', 'not_met', 'discontinued'); EXCEPTION WHEN duplicate_object THEN null; END $$;`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS care_plans (
      id SERIAL PRIMARY KEY,
      patient_id TEXT NOT NULL REFERENCES patients(id),
      title TEXT NOT NULL,
      author_name TEXT NOT NULL,
      status care_plan_status NOT NULL DEFAULT 'active',
      started_at TIMESTAMP NOT NULL DEFAULT now(),
      next_review_date DATE,
      superseded_at TIMESTAMP
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS care_plan_goals (
      id SERIAL PRIMARY KEY,
      care_plan_id INTEGER NOT NULL REFERENCES care_plans(id),
      description TEXT NOT NULL,
      target_date DATE,
      status care_plan_goal_status NOT NULL DEFAULT 'active',
      status_updated_at TIMESTAMP,
      status_updated_by_name TEXT
    )
  `)

  console.log('Care plans schema migration complete.')
  await pool.end()
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1) })
```

Run: `npx dotenv -e .env.local -- npx tsx migrate-care-plans-scratch.ts`. If blocked by the permission classifier: stop, report it, do not retry with variations.

Verify with a Node script (no `psql` here): `SELECT column_name FROM information_schema.columns WHERE table_name IN ('care_plans','care_plan_goals')`.

Delete the scratch script once confirmed: `rm migrate-care-plans-scratch.ts`.

- [ ] **Step 6: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/care-plans-schema.test.ts`
Expected: PASS (both tests).

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts tests/db/care-plans-schema.test.ts
git commit -m "$(cat <<'EOF'
feat: add care plans and care plan goals tables

EOF
)"
```

---

### Task 2: Query layer + care plan and goal routes

**Files:**
- Create: `src/lib/queries/care-plans.ts`
- Create: `src/app/api/patients/[anonId]/care-plans/route.ts` (POST — create plan, supersedes prior active)
- Create: `src/app/api/care-plan-goals/[id]/route.ts` (PATCH — goal status transition)
- Test: `tests/lib/queries/care-plans.test.ts`, `tests/api/care-plans.test.ts`, `tests/api/care-plan-goals.test.ts`

**Interfaces:**
- Consumes: `carePlans`, `carePlanGoals` from `@/db/schema` (Task 1); `patients` from `@/db/schema` (existing).
- Produces (from `src/lib/queries/care-plans.ts`, consumed by Task 3):
  - `interface CarePlanGoal { id: number; description: string; targetDate: string | null; status: 'active' | 'met' | 'not_met' | 'discontinued'; statusUpdatedAt: string | null; statusUpdatedByName: string | null }`
  - `interface CarePlanWithGoals { id: number; title: string; authorName: string; status: 'active' | 'superseded'; startedAt: string; nextReviewDate: string | null; supersededAt: string | null; goals: CarePlanGoal[] }`
  - `createCarePlan(input: { patientId: string; title: string; authorName: string; nextReviewDate: string | null; goals: { description: string; targetDate: string | null }[] }): Promise<{ id: number; supersededPlanId: number | null }>`
  - `listCarePlansForPatient(patientId: string): Promise<CarePlanWithGoals[]>` — newest plan first, goals within a plan ordered by `id` ascending.
  - `updateGoalStatus(goalId: number, status: 'met' | 'not_met' | 'discontinued', statusUpdatedByName: string): Promise<{ ok: boolean; error?: string; patientId?: string }>`

- [ ] **Step 1: Read the `signNote` status-transition precedent**

Read `src/lib/queries/encounter-notes.ts`'s `signNote` function and `src/app/api/patients/[anonId]/notes/[id]/sign/route.ts`'s status-to-HTTP-code mapping (`'Note not found' → 404`, `'Note is already signed' → 409`) before writing `updateGoalStatus` and the goal PATCH route — this plan's terminal-state guard (Review Focus #3, #5) follows the same existence-check-then-conditional-UPDATE shape, and the same not-found/already-terminal → 404/409 mapping.

- [ ] **Step 2: Write the failing tests — query layer**

Create `tests/lib/queries/care-plans.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, carePlans, carePlanGoals } from '@/db/schema'
import { createCarePlan, listCarePlansForPatient, updateGoalStatus } from '@/lib/queries/care-plans'

const createdPlanIds: number[] = []
afterEach(async () => {
  while (createdPlanIds.length > 0) {
    const id = createdPlanIds.pop()!
    await getDb().delete(carePlanGoals).where(eq(carePlanGoals.carePlanId, id))
    await getDb().delete(carePlans).where(eq(carePlans.id, id))
  }
})

describe('createCarePlan', () => {
  it('creates a plan with goals, all defaulting to active', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const result = await createCarePlan({
      patientId: patientRow.id, title: 'Initial Plan', authorName: 'Dr. Test', nextReviewDate: null,
      goals: [{ description: 'Reduce PHQ-9 below 10', targetDate: null }, { description: 'Attend weekly CBT', targetDate: null }],
    })
    createdPlanIds.push(result.id)
    expect(result.supersededPlanId).toBeNull()

    const [plans] = [await listCarePlansForPatient(patientRow.id)]
    const created = plans.find((p) => p.id === result.id)!
    expect(created.status).toBe('active')
    expect(created.goals).toHaveLength(2)
    expect(created.goals.every((g) => g.status === 'active')).toBe(true)
  })

  it('supersedes the prior active plan instead of deleting it (Review Focus #1)', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const first = await createCarePlan({ patientId: patientRow.id, title: 'First Plan', authorName: 'Dr. Test', nextReviewDate: null, goals: [] })
    createdPlanIds.push(first.id)

    const second = await createCarePlan({ patientId: patientRow.id, title: 'Second Plan', authorName: 'Dr. Test', nextReviewDate: null, goals: [] })
    createdPlanIds.push(second.id)
    expect(second.supersededPlanId).toBe(first.id)

    const plans = await listCarePlansForPatient(patientRow.id)
    const firstAfter = plans.find((p) => p.id === first.id)!
    const secondAfter = plans.find((p) => p.id === second.id)!
    expect(firstAfter.status).toBe('superseded')
    expect(firstAfter.supersededAt).not.toBeNull()
    expect(secondAfter.status).toBe('active')
  })
})

describe('listCarePlansForPatient patient scoping (Review Focus #2)', () => {
  it('two patients care plan histories stay independent', async () => {
    const patientsRows = await getDb().select().from(patients).limit(2)
    const [patientA, patientB] = patientsRows
    const planA = await createCarePlan({ patientId: patientA.id, title: 'Plan A', authorName: 'Dr. Test', nextReviewDate: null, goals: [] })
    createdPlanIds.push(planA.id)
    const planB = await createCarePlan({ patientId: patientB.id, title: 'Plan B', authorName: 'Dr. Test', nextReviewDate: null, goals: [] })
    createdPlanIds.push(planB.id)

    const historyA = await listCarePlansForPatient(patientA.id)
    const historyB = await listCarePlansForPatient(patientB.id)
    expect(historyA.some((p) => p.id === planB.id)).toBe(false)
    expect(historyB.some((p) => p.id === planA.id)).toBe(false)
  })
})

describe('updateGoalStatus', () => {
  it('transitions an active goal to a terminal status', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const plan = await createCarePlan({ patientId: patientRow.id, title: 'Plan', authorName: 'Dr. Test', nextReviewDate: null, goals: [{ description: 'Goal 1', targetDate: null }] })
    createdPlanIds.push(plan.id)
    const [goal] = await getDb().select().from(carePlanGoals).where(eq(carePlanGoals.carePlanId, plan.id))

    const result = await updateGoalStatus(goal.id, 'met', 'Dr. Test')
    expect(result.ok).toBe(true)

    const [updated] = await getDb().select().from(carePlanGoals).where(eq(carePlanGoals.id, goal.id))
    expect(updated.status).toBe('met')
    expect(updated.statusUpdatedByName).toBe('Dr. Test')
    expect(updated.statusUpdatedAt).not.toBeNull()
  })

  it('rejects transitioning an already-terminal goal (Review Focus #3)', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const plan = await createCarePlan({ patientId: patientRow.id, title: 'Plan', authorName: 'Dr. Test', nextReviewDate: null, goals: [{ description: 'Goal 1', targetDate: null }] })
    createdPlanIds.push(plan.id)
    const [goal] = await getDb().select().from(carePlanGoals).where(eq(carePlanGoals.carePlanId, plan.id))

    const first = await updateGoalStatus(goal.id, 'met', 'Dr. Test')
    expect(first.ok).toBe(true)
    const second = await updateGoalStatus(goal.id, 'not_met', 'Dr. Someone Else')
    expect(second.ok).toBe(false)

    const [unchanged] = await getDb().select().from(carePlanGoals).where(eq(carePlanGoals.id, goal.id))
    expect(unchanged.status).toBe('met') // unchanged by the rejected second call
    expect(unchanged.statusUpdatedByName).toBe('Dr. Test') // not overwritten
  })

  it('only one of two concurrent status updates on the same goal succeeds (Review Focus #5)', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const plan = await createCarePlan({ patientId: patientRow.id, title: 'Plan', authorName: 'Dr. Test', nextReviewDate: null, goals: [{ description: 'Goal 1', targetDate: null }] })
    createdPlanIds.push(plan.id)
    const [goal] = await getDb().select().from(carePlanGoals).where(eq(carePlanGoals.carePlanId, plan.id))

    const [resultA, resultB] = await Promise.all([
      updateGoalStatus(goal.id, 'met', 'Dr. A'),
      updateGoalStatus(goal.id, 'discontinued', 'Dr. B'),
    ])
    const okCount = [resultA.ok, resultB.ok].filter(Boolean).length
    expect(okCount).toBe(1)
  })
})
```

- [ ] **Step 3: Run them to confirm they fail**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/care-plans.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 4: Implement `src/lib/queries/care-plans.ts`**

Implement the types and three functions from the Interfaces block above.

`createCarePlan` runs inside a single `db.transaction()`: select the patient's current `active` plan (if any), `UPDATE ... SET status = 'superseded', supersededAt = now() WHERE id = <that plan's id>` when one exists, then `INSERT` the new `carePlans` row and its `carePlanGoals` rows (bulk `insert(...).values([...])` when `goals.length > 0`, skipped otherwise), returning `{ id: created.id, supersededPlanId: existingActive?.id ?? null }`.

`listCarePlansForPatient` selects `carePlans` for the patient ordered by `startedAt desc, id desc`, then selects all `carePlanGoals` for those plan ids ordered by `id asc`, and assembles each plan's `goals` array in application code (two queries, not a join — a join would need per-plan grouping logic which a join result rows list doesn't give you for free; two queries plus a `Map` keyed by `carePlanId` is simpler here and matches this codebase's general preference for the simplest correct approach).

`updateGoalStatus`, following the `signNote` shape read in Step 1: select the goal by id first — `{ ok: false, error: 'Goal not found' }` if missing; if `goal.status !== 'active'`, return `{ ok: false, error: 'Goal is already in a terminal state' }` without writing. Otherwise run the actual transition as a conditional `UPDATE ... WHERE id = ? AND status = 'active'` (Review Focus #5 — the existence/status pre-check above is a fast-path for a clear error message, but the real safety guarantee against a concurrent second writer is this WHERE clause, since two racing calls can both pass the pre-check before either writes). If the conditional UPDATE affects 0 rows despite the pre-check passing (the race actually happened), return `{ ok: false, error: 'Goal is already in a terminal state' }` — same message, since from the caller's perspective it's the same fact. On success, join back to `carePlans` to get `patientId` for the caller to audit-log against, returning `{ ok: true, patientId: carePlan.patientId }`.

- [ ] **Step 5: Run the query-layer tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/care-plans.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Write the failing test — POST create-plan route**

Create `tests/api/care-plans.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { POST as createRoute } from '@/app/api/patients/[anonId]/care-plans/route'
import { getDb } from '@/db/client'
import { patients, carePlans, carePlanGoals } from '@/db/schema'

let sessionRole: 'admin' | 'pi' | 'crc' | 'frontdesk' = 'pi'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Dr. R. Kunam' })) }))

const createdPlanIds: number[] = []
afterEach(async () => {
  sessionRole = 'pi'
  while (createdPlanIds.length > 0) {
    const id = createdPlanIds.pop()!
    await getDb().delete(carePlanGoals).where(eq(carePlanGoals.carePlanId, id))
    await getDb().delete(carePlans).where(eq(carePlans.id, id))
  }
})

function req(body: unknown) {
  return new Request('http://localhost', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
}

describe('POST /api/patients/[anonId]/care-plans', () => {
  it('creates a plan as pi, authored from the session name', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const res = await createRoute(req({ title: 'Q4 Plan', goals: [{ description: 'Attend weekly CBT' }] }) as never, { params: Promise.resolve({ anonId: patientRow.id }) })
    expect(res.status).toBe(201)
    const body = await res.json()
    createdPlanIds.push(body.id)

    const [planRow] = await getDb().select().from(carePlans).where(eq(carePlans.id, body.id))
    expect(planRow.authorName).toBe('Dr. R. Kunam')
  })

  it('rejects a frontdesk session', async () => {
    sessionRole = 'frontdesk'
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const res = await createRoute(req({ title: 'Q4 Plan', goals: [] }) as never, { params: Promise.resolve({ anonId: patientRow.id }) })
    expect(res.status).toBe(403)
  })

  it('rejects an unknown field in the body (.strict())', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const res = await createRoute(req({ title: 'Q4 Plan', goals: [], authorName: 'Someone Else' }) as never, { params: Promise.resolve({ anonId: patientRow.id }) })
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 7: Write the failing test — PATCH goal-status route**

Create `tests/api/care-plan-goals.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { PATCH as updateGoalRoute } from '@/app/api/care-plan-goals/[id]/route'
import { getDb } from '@/db/client'
import { patients, carePlans, carePlanGoals } from '@/db/schema'
import { createCarePlan } from '@/lib/queries/care-plans'

let sessionRole: 'admin' | 'pi' | 'crc' | 'frontdesk' = 'pi'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Dr. R. Kunam' })) }))

const createdPlanIds: number[] = []
afterEach(async () => {
  sessionRole = 'pi'
  while (createdPlanIds.length > 0) {
    const id = createdPlanIds.pop()!
    await getDb().delete(carePlanGoals).where(eq(carePlanGoals.carePlanId, id))
    await getDb().delete(carePlans).where(eq(carePlans.id, id))
  }
})

function req(body: unknown) {
  return new Request('http://localhost', { method: 'PATCH', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
}

async function makeGoal() {
  const [patientRow] = await getDb().select().from(patients).limit(1)
  const plan = await createCarePlan({ patientId: patientRow.id, title: 'Plan', authorName: 'Dr. Test', nextReviewDate: null, goals: [{ description: 'Goal 1', targetDate: null }] })
  createdPlanIds.push(plan.id)
  const [goal] = await getDb().select().from(carePlanGoals).where(eq(carePlanGoals.carePlanId, plan.id))
  return goal
}

describe('PATCH /api/care-plan-goals/[id]', () => {
  it('transitions an active goal to met as pi, capturing the session name', async () => {
    const goal = await makeGoal()
    const res = await updateGoalRoute(req({ status: 'met' }) as never, { params: Promise.resolve({ id: String(goal.id) }) })
    expect(res.status).toBe(200)

    const [updated] = await getDb().select().from(carePlanGoals).where(eq(carePlanGoals.id, goal.id))
    expect(updated.status).toBe('met')
    expect(updated.statusUpdatedByName).toBe('Dr. R. Kunam')
  })

  it('rejects transitioning an already-terminal goal with 409 (Review Focus #3)', async () => {
    const goal = await makeGoal()
    await updateGoalRoute(req({ status: 'met' }) as never, { params: Promise.resolve({ id: String(goal.id) }) })
    const second = await updateGoalRoute(req({ status: 'not_met' }) as never, { params: Promise.resolve({ id: String(goal.id) }) })
    expect(second.status).toBe(409)
  })

  it('never trusts a client-supplied statusUpdatedByName (Review Focus #4)', async () => {
    const goal = await makeGoal()
    const res = await updateGoalRoute(req({ status: 'met', statusUpdatedByName: 'Dr. Someone Else' }) as never, { params: Promise.resolve({ id: String(goal.id) }) })
    expect(res.status).toBe(400) // .strict() rejects the unknown key outright

    const [unchanged] = await getDb().select().from(carePlanGoals).where(eq(carePlanGoals.id, goal.id))
    expect(unchanged.status).toBe('active') // the rejected request never wrote anything
  })

  it('rejects a frontdesk session', async () => {
    sessionRole = 'frontdesk'
    const goal = await makeGoal()
    const res = await updateGoalRoute(req({ status: 'met' }) as never, { params: Promise.resolve({ id: String(goal.id) }) })
    expect(res.status).toBe(403)
  })

  it('404s for a nonexistent goal id', async () => {
    const res = await updateGoalRoute(req({ status: 'met' }) as never, { params: Promise.resolve({ id: '999999999' }) })
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 8: Run these route tests to confirm they fail**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/care-plans.test.ts tests/api/care-plan-goals.test.ts`
Expected: FAIL — routes don't exist.

- [ ] **Step 9: Implement `POST /api/patients/[anonId]/care-plans`**

Create `src/app/api/patients/[anonId]/care-plans/route.ts`. Zod schema (`.strict()` on both the outer body and each goal object, so a client-supplied `authorName` or a goal-level extra key is rejected the same way):

```ts
const carePlanSchema = z.object({
  title: z.string().min(1),
  nextReviewDate: z.string().optional(),
  goals: z.array(z.object({
    description: z.string().min(1),
    targetDate: z.string().optional(),
  }).strict()).default([]),
}).strict()
```

`requireSession()` first; role gate `['admin', 'pi']`; parse and validate the body; call `createCarePlan({ patientId: anonId, title, authorName: session.name, nextReviewDate: nextReviewDate ?? null, goals: goals.map(g => ({ description: g.description, targetDate: g.targetDate ?? null })) })`; `logAudit(session, 'created care plan', anonId)`; return `NextResponse.json({ id, supersededPlanId }, { status: 201 })`.

- [ ] **Step 10: Implement `PATCH /api/care-plan-goals/[id]`**

Create `src/app/api/care-plan-goals/[id]/route.ts`. Zod schema:

```ts
const goalStatusSchema = z.object({
  status: z.enum(['met', 'not_met', 'discontinued']),
}).strict()
```

`requireSession()` first; role gate `['admin', 'pi']`; parse `id` as an integer (400 if not); parse and validate the body; call `updateGoalStatus(id, status, session.name)`; on failure, map `result.error === 'Goal not found' ? 404 : 409` (following the `signNote` route's mapping read in Step 1); on success, `logAudit(session, 'updated care plan goal status', result.patientId ?? null)` and return `NextResponse.json({ ok: true }, { status: 200 })`.

- [ ] **Step 11: Run all this task's tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/care-plans.test.ts tests/api/care-plans.test.ts tests/api/care-plan-goals.test.ts`
Expected: PASS (14 tests total: 6 in `tests/lib/queries/care-plans.test.ts`, 3 in `tests/api/care-plans.test.ts`, 5 in `tests/api/care-plan-goals.test.ts`).

- [ ] **Step 12: Commit**

```bash
git add src/lib/queries/care-plans.ts "src/app/api/patients/[anonId]/care-plans" src/app/api/care-plan-goals tests/lib/queries/care-plans.test.ts tests/api/care-plans.test.ts tests/api/care-plan-goals.test.ts
git commit -m "$(cat <<'EOF'
feat: add care plan lifecycle routes with supersede-on-create and terminal goal-status guard

EOF
)"
```

---

### Task 3: Medical Record — Care Plan section + create/update action

**Files:**
- Create: `src/components/CarePlanSection.tsx`
- Modify: `src/app/(dashboard)/patients/[anonId]/medical-record/page.tsx`
- Test: none new (UI wiring over already-tested routes) — verify per this plan's UI verification discipline.

**Interfaces:**
- Consumes: `listCarePlansForPatient(patientId)`, `CarePlanWithGoals` (Task 2, fetched server-side and passed as a prop — this codebase's own established rule that Server Components call the query layer directly, never their own API routes), `POST /api/patients/[anonId]/care-plans` and `PATCH /api/care-plan-goals/[id]` (Task 2, called by URL from this client component).

- [ ] **Step 1: Read the current state of the Medical Record page and the `NoteForm`/`NoteCard` precedent**

Read `src/app/(dashboard)/patients/[anonId]/medical-record/page.tsx` in full as it exists in this worktree right now (at the time this plan was written it has Dual-Sourced Fields, Diagnoses, Medication History, Medications Dispensed, Allergies, Insurance, and Notes sections, in that order — it does **not** yet have a Lab Results section; do not assume that section exists, re-read the file before editing). Read `src/components/NoteForm.tsx`'s `NoteForm` (a `Dialog`-based create form opened by a button in the section header) and `NoteCard` (a per-row status pill plus a same-file inline action button that `PATCH`/`PUT`s and calls `router.refresh()`) — this task's `CarePlanSection` combines both patterns into one component. Read `src/components/DiscrepancyList.tsx`'s `<details>`/`<summary>` usage (lines ~55-68) for the exact collapsed-history markup to match for the superseded-plans list (spec §4).

- [ ] **Step 2: Build `CarePlanSection`**

Create `src/components/CarePlanSection.tsx` (`'use client'`), accepting `{ patientId: string; plans: CarePlanWithGoals[]; canWrite: boolean }` (the `CarePlanWithGoals` type imported from `@/lib/queries/care-plans`, Task 2). Structure:

- The current plan is `plans.find(p => p.status === 'active')`; everything else is history.
- A header row: section title plus (when `canWrite`) a "New Care Plan" button opening a `Dialog` (matching `NoteForm`'s open/submit/reset/error-display shape) with a title input, an optional next-review-date input, and a dynamic list of goal rows (description + optional target date, with add/remove-row buttons, starting with one empty row) — `POST`s to `/api/patients/${patientId}/care-plans`, `router.refresh()` and closes on success, inline error display on failure. Label this action clearly as creating a new plan that supersedes the current one when one exists (e.g. helper text under the dialog title: "Starting a new plan supersedes the current one — it stays visible in history below.") so the supersede behavior isn't a surprise to the user.
- If there's no current plan: "No care plan on file."
- If there is one: its title, next review date, and its goals, each as a row showing the description, target date, and a status pill (active/met/not_met/discontinued — text label alongside color per this codebase's "never color alone" convention, matching `NoteStatusPill`'s dot-plus-text shape). When `canWrite` and a goal's `status === 'active'`, render three small action buttons ("Mark met" / "Mark not met" / "Discontinue") that `PATCH` `/api/care-plan-goals/${goal.id}` with `{ status: 'met' | 'not_met' | 'discontinued' }` and `router.refresh()` on success, inline error display on failure (mirroring `NoteCard`'s `sign()` function).
- Below the current plan, if any superseded plans exist: a `<details>` element (matching `DiscrepancyList`'s markup) with a `<summary>` of `"${count} prior plan(s)"`, containing each superseded plan's title, started/superseded dates, and its goals (read-only — no action buttons in history, matching how `DiscrepancyList`'s resolved items are read-only).

- [ ] **Step 3: Wire it into the Medical Record page**

In `src/app/(dashboard)/patients/[anonId]/medical-record/page.tsx`: import `listCarePlansForPatient` from `@/lib/queries/care-plans` and `CarePlanSection`; fetch `const carePlans = await listCarePlansForPatient(anonId)` alongside the page's existing data fetches; add a new `<section className={SECTION}>` titled "Care Plan" (this file's existing `SECTION`/`SECTION_HEADING` convention) rendering `<CarePlanSection patientId={anonId} plans={carePlans} canWrite={['admin', 'pi'].includes(session.role)} />`. Place it near the other clinical sections (after Medication History reads naturally, but exact placement among the existing sections is the implementer's call — match this file's existing visual grouping of clinical vs. administrative sections).

- [ ] **Step 4: Verify via a real running dev server, not narration**

Start the dev server, mint a `pi`-role session cookie the way `src/lib/auth.ts` actually builds it (`SignJWT` under `clinsync_demo_session`, secret from `SESSION_SECRET`). Then, with real `curl`/`fetch` commands against the running server (not narrated):
1. Load a specific patient's `/patients/[anonId]/medical-record` page — confirm "No care plan on file."
2. Create a plan with at least one goal via the real "New Care Plan" flow (either through the rendered form or a direct `POST` to the route — note which in your report) — reload the page, confirm the plan and its goal render with an "active" status pill.
3. Mark the goal "met" — reload, confirm the rendered HTML shows the "met" status pill and the "Mark met/not met/Discontinue" buttons are gone for that goal.
4. Create a **second** plan for the same patient — reload, confirm the first plan now appears only inside the collapsed `<details>` history section (not as the current plan), and the second plan is now the one shown as current.

Paste the actual commands and actual output for all four steps in your report.

- [ ] **Step 5: Run the full suite once**

Run: `npx dotenv -e .env.local -- npx vitest run`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/components/CarePlanSection.tsx "src/app/(dashboard)/patients/[anonId]/medical-record/page.tsx"
git commit -m "$(cat <<'EOF'
feat: add Care Plan section and create/update action to Medical Record page

EOF
)"
```
