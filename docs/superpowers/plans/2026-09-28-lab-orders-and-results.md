# Lab Orders & Results Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Clinsync a real lab-order lifecycle (ordered → collected → resulted/cancelled) with a seeded test catalog, a worklist screen, and a results section on the Medical Record page — the record-keeping half of lab ordering, not a real lab-network integration.

**Architecture:** `labTests` is a small, seeded, read-only reference catalog (same posture as `payers`, `medications`). `labOrders` is the lifecycle row (status machine). `labResults` is a one-to-one side table off `labOrders` (unique FK), holding only what a resulted order has — separate because an order and its result have different authors and different lifecycles, the same reasoning already applied to `medicationInventory`/`medications` in the sibling Pharmacy plan.

**Tech Stack:** Next.js 16 App Router (Server Components) + Drizzle ORM over a `pg` Pool (additive-only schema changes via a hand-written one-off script, never `drizzle-kit push`) + `@base-ui/react` Dialog primitive + Tailwind v4 oklch tokens.

**Spec:** `docs/superpowers/specs/2026-09-28-lab-orders-and-results.md`

**Working directory note:** this plan is executed in an isolated git worktree at `/Users/k2a/Desktop/clinsync/.worktrees/lab-orders-results` on branch `feature/lab-orders-results`, forked from `hims-platform`. This worktree has its own `.env.local` and `node_modules` already set up. Every implementer/reviewer dispatch for this plan must work from this exact directory, not the main checkout — the main checkout and other worktrees (notably `.worktrees/pharmacy-med-inventory`) have their own concurrent work in flight; do not touch them.

## Global Constraints

- Additive-only schema changes. Apply via a hand-written one-off script run with `npx dotenv -e .env.local -- npx tsx <script>` — never `drizzle-kit push`. This is a **single shared Neon Postgres database across every branch/worktree** — a schema mistake here is visible everywhere immediately, including the main checkout and every other active worktree.
- `psql` is not installed in this environment — verify a migration's live-DB effect with a Node script using `pg`'s `Pool` and an `information_schema.columns`/row-count query.
- Every write route uses `.strict()` Zod validation.
- Every state-changing route calls `logAudit(session, <action>, <patientId>)`.
- Every protected route/page starts with `requireSession()` (API routes) or `requireSessionOrRedirect()` (pages) as its first statement.
- Role gating per spec §8: read (worklist/results) = admin, pi, crc, frontdesk. Order a test (write) = admin, pi. Mark collected (write) = admin, pi, frontdesk. Enter a result (write) = admin, pi. Cancel an order (write) = admin, pi.
- Status transitions are conditional UPDATEs guarded by current status in the `WHERE` clause (`WHERE id = ? AND status = 'ordered'`, etc.) — never a read-then-write — matching this codebase's established conditional-transition-guard pattern (MAR's `administerMedication`, ADT admission/discharge routes).
- Seed data goes in `src/db/seed.ts`, idempotent (check-before-insert by name/code), matching the `payers`-seeding pattern already established in this same repo's `hims-platform` branch — read that function for the exact convention before writing this one.
- Commit messages end with no attribution trailer.
- UI verification discipline: verify via a real running dev server hit with real HTTP requests (mint a session cookie the way `src/lib/auth.ts` actually does it — `SignJWT` under cookie `clinsync_demo_session`, secret from `SESSION_SECRET`), with actual commands and actual output pasted in the report. Never a narrated, unreproduced claim.
- Vitest invocation: `npx dotenv -e .env.local -- npx vitest run <path>` (`fileParallelism: false`).

## Review Focus

1. **Entering a result before the order was collected** — the result route must reject a `labOrders` row whose status isn't `collected`, not silently accept it out of order. (Task 2)
2. **Two concurrent "mark collected" calls on the same order** — the transition must be a single conditional UPDATE (`WHERE status = 'ordered'`), so only one of two racing calls succeeds. (Task 2)
3. **Cancelling an already-resulted order** — the spec's role table treats cancel as a write action but doesn't explicitly forbid cancelling a terminal/resulted order; the route must reject cancelling a `resulted` or already-`cancelled` order (both are terminal), matching the general "transitions only move forward from their real predecessor state" rule already applied elsewhere. (Task 2)
4. **Two patients' lab histories staying independent** — the Medical Record section and the underlying query must key strictly off the specific patient, no shared/cached bleed, matching this session's established review-focus pattern for the Pharmacy plan's dispense history and the encounter-notes plan's note history. (Task 2, 4)
5. **A `frontdesk` session calling the "mark collected" route directly with a `labTestId` it doesn't have order access to** (i.e., role-gate coverage of the intermediate, non-clinical transition, which spec §8 gives to `frontdesk` unlike order/result/cancel) — the collect route must accept `frontdesk` while the order/result/cancel routes reject it, and a test must confirm the asymmetry explicitly rather than reusing one role list across all four routes. (Task 2)

---

### Task 1: Schema — `lab_tests`, `lab_orders`, `lab_results`, seed data

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/seed.ts`
- Test: `tests/db/lab-schema.test.ts`

**Interfaces:**
- Produces: `labOrderStatusEnum`, `labResultFlagEnum`, `labTests` table (`id, name, code, defaultUnit, referenceRange`), `labOrders` table (`id, patientId, labTestId, orderedByProviderId, status, orderedAt, collectedAt`), `labResults` table (`id, labOrderId, value, unit, referenceRange, flag, resultedByName, resultedAt, notes`). Consumed by Tasks 2-4.

- [ ] **Step 1: Read the existing `providers` table definition**

Read `src/db/schema.ts` for the current `providers` table shape (columns, primary key type) before writing `labOrders.orderedByProviderId` — confirm it's an `integer` PK (matching this plan's assumption) and adjust the FK type if it's not.

- [ ] **Step 2: Write the failing test**

Create `tests/db/lab-schema.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, providers, labTests, labOrders, labResults } from '@/db/schema'

const createdOrderIds: number[] = []
const createdTestIds: number[] = []
afterEach(async () => {
  while (createdOrderIds.length > 0) {
    const id = createdOrderIds.pop()!
    await getDb().delete(labResults).where(eq(labResults.labOrderId, id))
    await getDb().delete(labOrders).where(eq(labOrders.id, id))
  }
  while (createdTestIds.length > 0) await getDb().delete(labTests).where(eq(labTests.id, createdTestIds.pop()!))
})

describe('lab schema', () => {
  it('creates an order and attaches a one-to-one result', async () => {
    const db = getDb()
    const [test] = await db.insert(labTests).values({ name: 'Test Panel', code: 'TP-1', defaultUnit: 'mg/dL', referenceRange: '0-10' }).returning()
    createdTestIds.push(test.id)
    const [patientRow] = await db.select().from(patients).limit(1)
    const [providerRow] = await db.select().from(providers).limit(1)

    const [order] = await db.insert(labOrders).values({ patientId: patientRow.id, labTestId: test.id, orderedByProviderId: providerRow.id }).returning()
    createdOrderIds.push(order.id)
    expect(order.status).toBe('ordered')
    expect(order.collectedAt).toBeNull()

    const [result] = await db.insert(labResults).values({ labOrderId: order.id, value: '5.2', unit: 'mg/dL', flag: 'normal', resultedByName: 'Test Staff' }).returning()
    expect(result.flag).toBe('normal')
  })

  it('enforces one result per order via the unique constraint', async () => {
    const db = getDb()
    const [test] = await db.insert(labTests).values({ name: 'Test Panel 2', code: 'TP-2' }).returning()
    createdTestIds.push(test.id)
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const [providerRow] = await getDb().select().from(providers).limit(1)
    const [order] = await getDb().insert(labOrders).values({ patientId: patientRow.id, labTestId: test.id, orderedByProviderId: providerRow.id }).returning()
    createdOrderIds.push(order.id)

    await getDb().insert(labResults).values({ labOrderId: order.id, value: '1', flag: 'normal', resultedByName: 'A' })
    await expect(getDb().insert(labResults).values({ labOrderId: order.id, value: '2', flag: 'normal', resultedByName: 'B' })).rejects.toThrow()
  })
})
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/lab-schema.test.ts`
Expected: FAIL — tables don't exist / not exported.

- [ ] **Step 4: Add the schema definitions**

In `src/db/schema.ts`, add near the other reference/lifecycle table definitions:

```ts
export const labOrderStatusEnum = pgEnum('lab_order_status', ['ordered', 'collected', 'resulted', 'cancelled'])
export const labResultFlagEnum = pgEnum('lab_result_flag', ['normal', 'abnormal', 'critical'])

export const labTests = pgTable('lab_tests', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  code: text('code').notNull(),
  defaultUnit: text('default_unit'),
  referenceRange: text('reference_range'),
})

export const labOrders = pgTable('lab_orders', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  labTestId: integer('lab_test_id').notNull().references(() => labTests.id),
  orderedByProviderId: integer('ordered_by_provider_id').notNull().references(() => providers.id),
  status: labOrderStatusEnum('status').default('ordered').notNull(),
  orderedAt: timestamp('ordered_at').defaultNow().notNull(),
  collectedAt: timestamp('collected_at'),
})

export const labResults = pgTable('lab_results', {
  id: serial('id').primaryKey(),
  labOrderId: integer('lab_order_id').notNull().references(() => labOrders.id).unique(),
  value: text('value').notNull(),
  unit: text('unit'),
  referenceRange: text('reference_range'),
  flag: labResultFlagEnum('flag').default('normal').notNull(),
  resultedByName: text('resulted_by_name').notNull(),
  resultedAt: timestamp('resulted_at').defaultNow().notNull(),
  notes: text('notes'),
})
```

- [ ] **Step 5: Run the test again — expect a different failure**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/lab-schema.test.ts`
Expected: FAIL — now a runtime DB error (relation does not exist), not an import error.

- [ ] **Step 6: Write and run the one-off migration script**

Scratch, not part of the repo. Create `migrate-labs-scratch.ts` at the repo root (this worktree's root: `/Users/k2a/Desktop/clinsync/.worktrees/lab-orders-results`):

```ts
import { Pool } from 'pg'

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false } })

  await pool.query(`DO $$ BEGIN CREATE TYPE lab_order_status AS ENUM ('ordered', 'collected', 'resulted', 'cancelled'); EXCEPTION WHEN duplicate_object THEN null; END $$;`)
  await pool.query(`DO $$ BEGIN CREATE TYPE lab_result_flag AS ENUM ('normal', 'abnormal', 'critical'); EXCEPTION WHEN duplicate_object THEN null; END $$;`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS lab_tests (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT NOT NULL,
      default_unit TEXT,
      reference_range TEXT
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS lab_orders (
      id SERIAL PRIMARY KEY,
      patient_id TEXT NOT NULL REFERENCES patients(id),
      lab_test_id INTEGER NOT NULL REFERENCES lab_tests(id),
      ordered_by_provider_id INTEGER NOT NULL REFERENCES providers(id),
      status lab_order_status NOT NULL DEFAULT 'ordered',
      ordered_at TIMESTAMP NOT NULL DEFAULT now(),
      collected_at TIMESTAMP
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS lab_results (
      id SERIAL PRIMARY KEY,
      lab_order_id INTEGER NOT NULL UNIQUE REFERENCES lab_orders(id),
      value TEXT NOT NULL,
      unit TEXT,
      reference_range TEXT,
      flag lab_result_flag NOT NULL DEFAULT 'normal',
      resulted_by_name TEXT NOT NULL,
      resulted_at TIMESTAMP NOT NULL DEFAULT now(),
      notes TEXT
    )
  `)

  console.log('Lab schema migration complete.')
  await pool.end()
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1) })
```

Run: `npx dotenv -e .env.local -- npx tsx migrate-labs-scratch.ts`. If blocked by the permission classifier: stop, report it, do not retry with variations.

Verify with a Node script (no `psql` here): `SELECT column_name FROM information_schema.columns WHERE table_name IN ('lab_tests','lab_orders','lab_results')`.

Delete the scratch script once confirmed: `rm migrate-labs-scratch.ts`.

- [ ] **Step 7: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/lab-schema.test.ts`
Expected: PASS (both tests).

- [ ] **Step 8: Add idempotent seed data to `src/db/seed.ts`**

Read `src/db/seed.ts`'s existing idempotent reference-data seeding pattern (`payers`, or `medications` if the sibling Pharmacy plan's seed function has landed in this worktree's history by the time you do this — check by name before inserting, called unconditionally near the top of `seed()`).

Add a `LAB_TESTS_SEED` array of 10 tests (name, code, defaultUnit, referenceRange) covering: CBC with differential (`CBC-DIFF`, cells/mcL, "4.5-11.0 x10^3/mcL"), Comprehensive Metabolic Panel (`CMP`, varies — leave defaultUnit null, referenceRange "See individual analytes"), TSH (`TSH`, mIU/L, "0.4-4.0"), Lipid Panel (`LIPID`, mg/dL, "Total chol <200"), HbA1c (`HBA1C`, "%", "4.0-5.6"), Lithium level (`LITH`, mEq/L, "0.6-1.2"), Valproic acid level (`VPA`, mcg/mL, "50-100"), Urine drug screen (`UDS`, null unit, "Negative"), Prolactin (`PRL`, ng/mL, "4-15.2"), Vitamin D 25-OH (`VITD`, ng/mL, "30-100"). A `seedLabTests()` function inserting any missing-by-code test.

- [ ] **Step 9: Confirm seeding logic is idempotent by inspection**

Same discipline as the sibling Pharmacy plan: do NOT run `npm run db:seed` against the live shared dev database as part of this task. Read your `seedLabTests()` check-before-insert logic carefully to confirm idempotency instead.

- [ ] **Step 10: Commit**

```bash
git add src/db/schema.ts src/db/seed.ts tests/db/lab-schema.test.ts
git commit -m "feat: add lab tests catalog, orders, and results tables with seed data"
```

---

### Task 2: Query layer + order lifecycle routes

**Files:**
- Create: `src/lib/queries/lab-tests.ts`
- Create: `src/lib/queries/lab-orders.ts`
- Create: `src/app/api/patients/[anonId]/lab-orders/route.ts` (POST — create order)
- Create: `src/app/api/lab-orders/[id]/collect/route.ts` (POST)
- Create: `src/app/api/lab-orders/[id]/result/route.ts` (POST)
- Create: `src/app/api/lab-orders/[id]/cancel/route.ts` (POST)
- Create: `src/app/api/lab-orders/route.ts` (GET — worklist, all orders with test/patient joined)
- Test: `tests/lib/queries/lab-tests.test.ts`, `tests/api/lab-orders.test.ts`, `tests/lib/queries/lab-results-patient-scoping.test.ts`

**Interfaces:**
- Consumes: `labTests`, `labOrders`, `labResults` from `@/db/schema` (Task 1); `providers`, `patients` from `@/db/schema` (existing).
- Produces: `listLabTests()` from `@/lib/queries/lab-tests`; `createLabOrder(input)`, `markCollected(orderId)`, `enterResult(orderId, input)`, `cancelOrder(orderId, reason)`, `listOrdersForPatient(patientId)`, `listWorklist()` from `@/lib/queries/lab-orders` — consumed by Tasks 3, 4.

- [ ] **Step 1: Read how an existing clinical-write route resolves "the calling provider" from the session**

Read `src/app/api/inpatient/admissions/[id]/discharge/route.ts` (or the nearest equivalent own-attending-provider check already in this codebase) to see the exact established pattern for turning `session` into a `providers.id`. If no such lookup-by-session-identity pattern exists anywhere in this codebase, fall back to the simpler, already-established pattern from encounter notes: record `session.name` as free text rather than inventing a new session→provider-id resolution mechanism. Note which approach you used in your report — this is a real ambiguity in the spec (spec §4 names this as an open question) and either resolution is acceptable; do not block on it.

- [ ] **Step 2: Write the failing tests — query layer**

Create `tests/lib/queries/lab-tests.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { listLabTests } from '@/lib/queries/lab-tests'

describe('lab tests catalog', () => {
  it('lists at least the 10 seeded tests', async () => {
    const all = await listLabTests()
    expect(all.length).toBeGreaterThanOrEqual(10)
    expect(all.some((t) => t.code === 'TSH')).toBe(true)
  })
})
```

Create `tests/api/lab-orders.test.ts` covering, using the real query functions (not the route — route-level role gating is covered separately in Step 6):
- `createLabOrder` sets initial status `ordered`.
- `markCollected` on an `ordered` order transitions to `collected` and sets `collectedAt`; calling it again on the same (now `collected`) order fails/no-ops (Review Focus #2 — verify via two sequential calls, second must not double-apply).
- `enterResult` on a `collected` order transitions to `resulted` and inserts the result row; calling `enterResult` on an order still `ordered` (never collected) fails (Review Focus #1).
- `cancelOrder` on an `ordered` or `collected` order transitions to `cancelled`; calling `cancelOrder` on a `resulted` order fails, and calling it on an already-`cancelled` order fails (Review Focus #3 — both terminal states rejected).

Write these as real assertions against the actual return values/thrown results (follow this codebase's established `{ ok: boolean, error?: string }`-style result convention, matching `dispenseMedication` in the sibling Pharmacy plan and `administerMedication` elsewhere in this codebase, rather than throwing).

Create `tests/lib/queries/lab-results-patient-scoping.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, providers, labTests, labOrders, labResults } from '@/db/schema'
import { listOrdersForPatient } from '@/lib/queries/lab-orders'

const createdOrderIds: number[] = []
afterEach(async () => {
  while (createdOrderIds.length > 0) {
    const id = createdOrderIds.pop()!
    await getDb().delete(labResults).where(eq(labResults.labOrderId, id))
    await getDb().delete(labOrders).where(eq(labOrders.id, id))
  }
})

describe('lab order patient scoping', () => {
  it('two patients lab histories stay independent', async () => {
    const db = getDb()
    const [test] = await db.select().from(labTests).limit(1)
    const [providerRow] = await db.select().from(providers).limit(1)
    const patientsRows = await db.select().from(patients).limit(2)
    const [patientA, patientB] = patientsRows

    const [orderA] = await db.insert(labOrders).values({ patientId: patientA.id, labTestId: test.id, orderedByProviderId: providerRow.id }).returning()
    createdOrderIds.push(orderA.id)
    const [orderB] = await db.insert(labOrders).values({ patientId: patientB.id, labTestId: test.id, orderedByProviderId: providerRow.id }).returning()
    createdOrderIds.push(orderB.id)

    const historyA = await listOrdersForPatient(patientA.id)
    const historyB = await listOrdersForPatient(patientB.id)
    expect(historyA.some((o) => o.id === orderB.id)).toBe(false)
    expect(historyB.some((o) => o.id === orderA.id)).toBe(false)
  })
})
```

- [ ] **Step 3: Run them to confirm they fail**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/lab-tests.test.ts tests/api/lab-orders.test.ts tests/lib/queries/lab-results-patient-scoping.test.ts`
Expected: FAIL — modules don't exist.

- [ ] **Step 4: Implement `src/lib/queries/lab-tests.ts`**

```ts
import { getDb } from '@/db/client'
import { labTests } from '@/db/schema'
import { asc } from 'drizzle-orm'

export async function listLabTests() {
  return getDb().select().from(labTests).orderBy(asc(labTests.name))
}
```

- [ ] **Step 5: Implement `src/lib/queries/lab-orders.ts`**

Implement `createLabOrder(input: { patientId: string, labTestId: number, orderedByProviderId: number })`, `markCollected(orderId: number)`, `enterResult(orderId: number, input: { value: string, unit?: string, referenceRange?: string, flag: 'normal'|'abnormal'|'critical', notes?: string, resultedByName: string })`, `cancelOrder(orderId: number, reason: string)`, `listOrdersForPatient(patientId: string)`, `listWorklist()`.

Each transition function is a single conditional UPDATE keyed on current status (Global Constraints) returning `{ ok: boolean, error?: string }`, e.g.:

```ts
export async function markCollected(orderId: number) {
  const updated = await getDb().update(labOrders)
    .set({ status: 'collected', collectedAt: new Date() })
    .where(and(eq(labOrders.id, orderId), eq(labOrders.status, 'ordered')))
    .returning({ id: labOrders.id })
  if (updated.length === 0) return { ok: false, error: 'Order is not in ordered status' }
  return { ok: true }
}
```

`cancelOrder` guards `status IN ('ordered', 'collected')` in its WHERE (both non-terminal), rejecting `resulted` and `cancelled` alike. `enterResult` guards `status = 'collected'` in its UPDATE-to-`resulted`, and only inserts the `labResults` row after the UPDATE succeeds (if the UPDATE affects 0 rows, return `{ ok: false }` without inserting). `listWorklist()` joins `labOrders` to `labTests`, `patients`, and `providers` for display (test name, patient anonId/name, ordering provider name, status, orderedAt).

- [ ] **Step 6: Run the query-layer tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/lab-tests.test.ts tests/api/lab-orders.test.ts tests/lib/queries/lab-results-patient-scoping.test.ts`
Expected: PASS.

- [ ] **Step 7: Write the failing test — route-level role gating**

Create `tests/api/lab-orders-routes.test.ts` covering the asymmetric role gate (Review Focus #5): a `frontdesk` session calling the collect route succeeds (200/204), but a `frontdesk` session calling the order-creation, result-entry, or cancel routes each gets 403. An `admin` or `pi` session succeeds on all four. Follow the `vi.mock('@/lib/auth', ...)` pattern already established in `tests/api/pharmacy-dispense.test.ts` (sibling Pharmacy plan) or this codebase's other route tests for mocking `requireSession()`.

- [ ] **Step 8: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/lab-orders-routes.test.ts`
Expected: FAIL — routes don't exist.

- [ ] **Step 9: Implement the four lifecycle routes + worklist GET**

`POST /api/patients/[anonId]/lab-orders` — role gate `['admin','pi']`, body `{ labTestId: number }` (`.strict()` Zod), resolves the ordering provider per Step 1's chosen approach, calls `createLabOrder`, `logAudit`, returns 201.

`POST /api/lab-orders/[id]/collect` — role gate `['admin','pi','frontdesk']`, no body, calls `markCollected`, `logAudit`, returns 200 or 409 on the guard rejection.

`POST /api/lab-orders/[id]/result` — role gate `['admin','pi']`, body `{ value, unit?, referenceRange?, flag, notes? }` (`.strict()` Zod, `flag` a `z.enum(['normal','abnormal','critical'])`), `resultedByName: session.name`, calls `enterResult`, `logAudit`, returns 200 or 409.

`POST /api/lab-orders/[id]/cancel` — role gate `['admin','pi']`, body `{ reason: string }` (`.strict()` Zod, reason required per spec §4), calls `cancelOrder`, `logAudit`, returns 200 or 409.

`GET /api/lab-orders` — role gate `['admin','pi','crc','frontdesk']` (read), calls `listWorklist()`.

- [ ] **Step 10: Run all this task's tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/lab-tests.test.ts tests/api/lab-orders.test.ts tests/lib/queries/lab-results-patient-scoping.test.ts tests/api/lab-orders-routes.test.ts`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/lib/queries/lab-tests.ts src/lib/queries/lab-orders.ts src/app/api/patients/[anonId]/lab-orders src/app/api/lab-orders tests/lib/queries/lab-tests.test.ts tests/api/lab-orders.test.ts tests/lib/queries/lab-results-patient-scoping.test.ts tests/api/lab-orders-routes.test.ts
git commit -m "feat: add lab order lifecycle routes with conditional status transitions"
```

---

### Task 3: Lab worklist UI

**Files:**
- Create: `src/components/LabWorklist.tsx`
- Create: `src/components/OrderLabTestModal.tsx`
- Create: `src/components/EnterLabResultModal.tsx`
- Create: `src/app/(dashboard)/labs/page.tsx`
- Modify: `src/components/LeftNav.tsx` (add a nav entry)
- Modify: `src/lib/role-capabilities.ts` (if this file gates nav items by role — read it first to confirm the exact mechanism)
- Test: none new (UI wiring over already-tested routes) — verify per this plan's UI verification discipline.

**Interfaces:**
- Consumes: `GET /api/lab-orders`, `POST /api/lab-orders/[id]/collect`, `POST /api/lab-orders/[id]/result`, `POST /api/lab-orders/[id]/cancel` (Task 2, called by URL from client components).

- [ ] **Step 1: Read the existing queue/status-board pattern**

Read Front Desk's assignment queue and/or the Inpatient bed board component (whichever is more directly analogous — grouped-by-status list with a status pill and a next-action button per row) before building this screen. Match the pattern exactly, including this codebase's "never color alone" status-pill convention (icon or text label alongside color).

- [ ] **Step 2: Build the page and worklist component**

Create `src/app/(dashboard)/labs/page.tsx` as a Server Component: `requireSessionOrRedirect()` first, fetch `listWorklist()` directly (Server Components call the query layer directly, never their own API routes — this codebase's own established rule), pass to `<LabWorklist orders={...} role={session.role} />`.

Create `src/components/LabWorklist.tsx` (`'use client'`): orders grouped into three columns/sections — Ordered, Collected, Resulted (cancelled orders shown in a collapsed/lighter section per spec §5's "lighter Pending sub-list" spirit, applied here to cancelled rather than pending since this is the worklist not the chart view) — each row showing patient, test, ordering provider, order date, and the next available action gated by role: "Mark collected" (visible to admin/pi/frontdesk) on Ordered rows, "Enter result" (visible to admin/pi) opening `EnterLabResultModal` on Collected rows, "Cancel" (visible to admin/pi) on both Ordered and Collected rows.

- [ ] **Step 3: Build the two action modals**

Create `src/components/EnterLabResultModal.tsx` (`'use client'`): value, unit, reference range (pre-filled from the order's test catalog default, editable), flag `<select>` (normal/abnormal/critical), notes — `POST /api/lab-orders/[id]/result`, `router.refresh()` on success, inline error display. Follow the Dialog-modal-with-fetch pattern already established by this codebase's other action modals (e.g. `TransferAdmissionModal.tsx` or the sibling Pharmacy plan's `DispenseMedicationModal.tsx` — read one for the exact shape).

Create `src/components/OrderLabTestModal.tsx` (`'use client'`): a test `<select>` populated from `listLabTests()` (fetch via a small `GET` — reuse `/api/lab-orders` worklist response's test list if convenient, or add a minimal catalog read inline; implementer's call), `POST /api/patients/[anonId]/lab-orders`. This modal is opened from the patient chart context (Task 4 wires the entry point on the Medical Record page) — accept `patientId`/`anonId` as a prop, don't fetch it internally.

- [ ] **Step 4: Verify via a real running dev server, not narration**

Real login, real GET of `/labs`, confirm the worklist renders grouped by status. Real order creation (via the modal wired in Task 4, or directly against the route if Task 4 hasn't landed yet in your working tree at verification time — note which in your report), real "mark collected", real "enter result", confirm the order moves between sections on each transition. Paste actual commands and actual output.

- [ ] **Step 5: Commit**

```bash
git add src/components/LabWorklist.tsx src/components/OrderLabTestModal.tsx src/components/EnterLabResultModal.tsx "src/app/(dashboard)/labs/page.tsx" src/components/LeftNav.tsx src/lib/role-capabilities.ts
git commit -m "feat: add Lab worklist screen with collect/result/cancel actions"
```

---

### Task 4: Medical Record — Lab Results section + order entry point

**Files:**
- Modify: `src/app/(dashboard)/patients/[anonId]/medical-record/page.tsx`
- Test: none new — verify per this plan's UI verification discipline.

**Interfaces:**
- Consumes: `listOrdersForPatient(patientId)` (Task 2), `OrderLabTestModal` (Task 3).

- [ ] **Step 1: Read the current state of the Medical Record page**

This file has already had Notes, Insurance, and (per the sibling Pharmacy plan) a Medications Dispensed section added by prior plans in this session's history — read its actual current state in this worktree, don't assume any particular prior version.

- [ ] **Step 2: Add the "Lab Results" section**

Fetch `listOrdersForPatient(anonId)` alongside this page's existing data fetches. Add a new `<section className={SECTION}>` (this file's existing convention) titled "Lab Results": resulted orders newest-first (test name, value + unit, reference range, a flag pill — critical rendered with this codebase's existing destructive-tone treatment, matching how other critical/urgent states are already styled elsewhere), and a lighter "Pending" sub-list for orders still `ordered`/`collected` (spec §6). Include an "Order labs" button opening `OrderLabTestModal` (Task 3) scoped to this patient — this is the entry point the modal's `patientId`/`anonId` prop (Task 3, Step 3) is for.

- [ ] **Step 3: Verify via a real running dev server, not narration**

Real login, real "Order labs" for a specific patient from this page, real mark-collected and enter-result via `/labs`, real reload of this patient's medical-record page, confirm the result appears under Lab Results and any other still-pending order appears under Pending. Paste actual commands and output.

- [ ] **Step 4: Run the full suite once**

Run: `npx dotenv -e .env.local -- npx vitest run`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/patients/[anonId]/medical-record/page.tsx"
git commit -m "feat: add Lab Results section and order entry point to Medical Record page"
```
