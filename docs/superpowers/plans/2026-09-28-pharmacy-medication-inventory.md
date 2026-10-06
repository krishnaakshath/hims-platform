# Pharmacy: Medication Catalog, Inventory & Dispensing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Clinsync a real medication catalog, on-hand inventory tracking, and a dispensing workflow that decrements stock — the pharmacy half of the "complete the HIMS platform" backlog.

**Architecture:** `medications` is a small, seeded, read-only reference catalog (same posture as `payers`). `medicationInventory` is a one-to-one side table holding the one thing that actually changes per-drug (quantity on hand), kept separate from the catalog for the same reason `identityVerifications` is separate from `patients`. `medicationDispenses` is an append-only event log — a dispense is never edited or deleted, only recorded, mirroring this codebase's established append-only conventions (encounter notes, admission transfers).

**Tech Stack:** Next.js 16 App Router (Server Components) + Drizzle ORM over a `pg` Pool (additive-only schema changes via a hand-written one-off script, never `drizzle-kit push`) + `@base-ui/react` Dialog primitive + Tailwind v4 oklch tokens.

**Spec:** `docs/superpowers/specs/2026-09-28-pharmacy-medication-inventory.md`

**Working directory note:** this plan is executed in an isolated git worktree at `/Users/k2a/Desktop/clinsync/.worktrees/pharmacy-med-inventory` on branch `feature/pharmacy-med-inventory`, forked from `hims-platform`. This worktree has its own `.env.local` and `node_modules` already set up. Every implementer/reviewer dispatch for this plan must work from this exact directory, not the main checkout — the main checkout and other worktrees have their own concurrent work in flight; do not touch them.

## Global Constraints

- Additive-only schema changes. Apply via a hand-written one-off script run with `npx dotenv -e .env.local -- npx tsx <script>` — never `drizzle-kit push`. This is a **single shared Neon Postgres database across every branch/worktree** — a schema mistake here is visible everywhere immediately, including the main checkout and every other active worktree.
- `psql` is not installed in this environment — verify a migration's live-DB effect with a Node script using `pg`'s `Pool` and an `information_schema.columns`/row-count query.
- Every write route uses `.strict()` Zod validation.
- Every state-changing route calls `logAudit(session, <action>, <patientId or null>)`.
- Every protected route/page starts with `requireSession()` (API routes) or `requireSessionOrRedirect()` (pages) as its first statement.
- Read access: admin, pi, crc, frontdesk. Write access (dispense a medication): admin, pi only (a clinical action).
- Seed data goes in `src/db/seed.ts`, idempotent (check-before-insert by name), matching the `payers`-seeding pattern already established in this same repo's `hims-platform` branch — read that function for the exact convention before writing this one.
- Commit messages end with no attribution trailer.
- UI verification discipline: verify via a real running dev server hit with real HTTP requests (mint a session cookie the way `src/lib/auth.ts` actually does it — `SignJWT` under cookie `clinsync_demo_session`, secret from `SESSION_SECRET`), with actual commands and actual output pasted in the report. Never a narrated, unreproduced claim.
- Vitest invocation: `npx dotenv -e .env.local -- npx vitest run <path>` (`fileParallelism: false`).

## Review Focus

1. **Dispensing more than is on hand** — the route must reject a dispense whose quantity exceeds `quantityOnHand`, not let it go negative. (Task 2)
2. **Two concurrent dispenses of the same drug** — the stock decrement must be a single conditional UPDATE (`WHERE quantity_on_hand >= requested`), not a read-then-write race, matching this codebase's established conditional-UPDATE pattern (Front Desk room assignment, MAR administration). (Task 2)
3. **A dispense referencing a `medicationEpisodeId` that belongs to a different patient than the dispense's own `patientId`** — same cross-entity-forgery class this session's encounter-notes plan found and fixed twice; the route must verify the episode (when provided) belongs to the same patient. (Task 2)
4. **Two patients' dispense histories staying independent** — the Medical Record section and the underlying query must key strictly off the specific patient, no shared/cached bleed. (Task 2, 4)
5. **A medication with zero inventory rendering correctly** (`out of stock`, not a crash or a negative-looking display) — the Pharmacy dashboard's status-pill logic must handle the zero case explicitly, not just "below threshold." (Task 3)

---

### Task 1: Schema — `medications`, `medication_inventory`, `medication_dispenses`, seed data

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/seed.ts`
- Test: `tests/db/pharmacy-schema.test.ts`

**Interfaces:**
- Produces: `medicationFormEnum`, `medications` table (`id, name, genericName, medicationClass, commonDose, form`), `medicationInventory` table (`id, medicationId, quantityOnHand, reorderThreshold, unit, updatedAt`), `medicationDispenses` table (`id, patientId, medicationId, medicationEpisodeId, quantity, dispensedByName, dispensedAt, notes`). Consumed by Tasks 2-4.

- [ ] **Step 1: Write the failing test**

Create `tests/db/pharmacy-schema.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, medications, medicationInventory, medicationDispenses } from '@/db/schema'

const createdMedIds: number[] = []
const createdDispenseIds: number[] = []
afterEach(async () => {
  while (createdDispenseIds.length > 0) await getDb().delete(medicationDispenses).where(eq(medicationDispenses.id, createdDispenseIds.pop()!))
  while (createdMedIds.length > 0) {
    const id = createdMedIds.pop()!
    await getDb().delete(medicationInventory).where(eq(medicationInventory.medicationId, id))
    await getDb().delete(medications).where(eq(medications.id, id))
  }
})

describe('pharmacy schema', () => {
  it('inserts a medication with inventory and a dispense record', async () => {
    const db = getDb()
    const [med] = await db.insert(medications).values({ name: 'Test Med', medicationClass: 'Test Class', form: 'tablet' }).returning()
    createdMedIds.push(med.id)
    const [inv] = await db.insert(medicationInventory).values({ medicationId: med.id, quantityOnHand: 50, reorderThreshold: 10, unit: 'tablets' }).returning()
    expect(inv.quantityOnHand).toBe(50)

    const [patientRow] = await db.select().from(patients).limit(1)
    const [dispense] = await db.insert(medicationDispenses).values({ patientId: patientRow.id, medicationId: med.id, quantity: 5, dispensedByName: 'Test Staff' }).returning()
    createdDispenseIds.push(dispense.id)
    expect(dispense.medicationEpisodeId).toBeNull()
    expect(dispense.quantity).toBe(5)
  })

  it('enforces one inventory row per medication via the unique constraint', async () => {
    const db = getDb()
    const [med] = await db.insert(medications).values({ name: 'Test Med 2', medicationClass: 'Test Class', form: 'tablet' }).returning()
    createdMedIds.push(med.id)
    await db.insert(medicationInventory).values({ medicationId: med.id, quantityOnHand: 10, reorderThreshold: 5, unit: 'tablets' })
    await expect(db.insert(medicationInventory).values({ medicationId: med.id, quantityOnHand: 20, reorderThreshold: 5, unit: 'tablets' })).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/pharmacy-schema.test.ts`
Expected: FAIL — tables don't exist / not exported.

- [ ] **Step 3: Add the schema definitions**

In `src/db/schema.ts`, add near the other reference-table definitions:

```ts
export const medicationFormEnum = pgEnum('medication_form', ['tablet', 'capsule', 'liquid', 'injection', 'other'])

export const medications = pgTable('medications', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  genericName: text('generic_name'),
  medicationClass: text('medication_class').notNull(),
  commonDose: text('common_dose'),
  form: medicationFormEnum('form').default('tablet').notNull(),
})

export const medicationInventory = pgTable('medication_inventory', {
  id: serial('id').primaryKey(),
  medicationId: integer('medication_id').notNull().references(() => medications.id).unique(),
  quantityOnHand: integer('quantity_on_hand').default(0).notNull(),
  reorderThreshold: integer('reorder_threshold').default(10).notNull(),
  unit: text('unit').default('units').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export const medicationDispenses = pgTable('medication_dispenses', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  medicationId: integer('medication_id').notNull().references(() => medications.id),
  medicationEpisodeId: integer('medication_episode_id').references(() => medicationEpisodes.id),
  quantity: integer('quantity').notNull(),
  dispensedByName: text('dispensed_by_name').notNull(),
  dispensedAt: timestamp('dispensed_at').defaultNow().notNull(),
  notes: text('notes'),
})
```

(`medicationEpisodes` is already imported/defined earlier in this file.)

- [ ] **Step 4: Run the test again — expect a different failure**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/pharmacy-schema.test.ts`
Expected: FAIL — now a runtime DB error (relation does not exist), not an import error.

- [ ] **Step 5: Write and run the one-off migration script**

Scratch, not part of the repo. Create `migrate-pharmacy-scratch.ts` at the repo root:

```ts
import { Pool } from 'pg'

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false } })

  await pool.query(`DO $$ BEGIN CREATE TYPE medication_form AS ENUM ('tablet', 'capsule', 'liquid', 'injection', 'other'); EXCEPTION WHEN duplicate_object THEN null; END $$;`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS medications (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      generic_name TEXT,
      medication_class TEXT NOT NULL,
      common_dose TEXT,
      form medication_form NOT NULL DEFAULT 'tablet'
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS medication_inventory (
      id SERIAL PRIMARY KEY,
      medication_id INTEGER NOT NULL UNIQUE REFERENCES medications(id),
      quantity_on_hand INTEGER NOT NULL DEFAULT 0,
      reorder_threshold INTEGER NOT NULL DEFAULT 10,
      unit TEXT NOT NULL DEFAULT 'units',
      updated_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS medication_dispenses (
      id SERIAL PRIMARY KEY,
      patient_id TEXT NOT NULL REFERENCES patients(id),
      medication_id INTEGER NOT NULL REFERENCES medications(id),
      medication_episode_id INTEGER REFERENCES medication_episodes(id),
      quantity INTEGER NOT NULL,
      dispensed_by_name TEXT NOT NULL,
      dispensed_at TIMESTAMP NOT NULL DEFAULT now(),
      notes TEXT
    )
  `)

  console.log('Pharmacy schema migration complete.')
  await pool.end()
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1) })
```

Run: `npx dotenv -e .env.local -- npx tsx migrate-pharmacy-scratch.ts`. If blocked by the permission classifier: stop, report it, do not retry with variations.

Verify with a Node script (no `psql` here): `SELECT column_name FROM information_schema.columns WHERE table_name IN ('medications','medication_inventory','medication_dispenses')`.

Delete the scratch script once confirmed: `rm migrate-pharmacy-scratch.ts`.

- [ ] **Step 6: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/pharmacy-schema.test.ts`
Expected: PASS (both tests).

- [ ] **Step 7: Add idempotent seed data to `src/db/seed.ts`**

Read `src/db/seed.ts`'s existing `payers`-seeding code first (added in a sibling branch/plan this same session — if not present in this worktree's history, read the closest existing idempotent-reference-data seeding pattern, e.g. how `trials` or `providers` are seeded) for the exact convention: check-by-name before insert, called unconditionally near the top of `seed()` before any branch that depends on it.

Add a `MEDICATIONS_SEED` array of 15 medications (name, genericName where a real one is well-known, medicationClass, commonDose, form) covering: Sertraline (SSRI), Escitalopram (SSRI), Venlafaxine (SNRI), Bupropion (atypical antidepressant), Trazodone (atypical antidepressant), Mirtazapine (atypical antidepressant), Aripiprazole (atypical antipsychotic), Quetiapine (atypical antipsychotic), Risperidone (atypical antipsychotic), Lorazepam (benzodiazepine), Clonazepam (benzodiazepine), Methylphenidate ER (stimulant), Amphetamine/dextroamphetamine (stimulant), Lithium (mood stabilizer), Esketamine/Spravato (NMDA antagonist, form: `injection`). A `seedMedications()` function inserting any missing-by-name medication, then inserting a `medicationInventory` row for any medication that doesn't have one yet (quantity 20-200 depending on form — a plausible starting stock, doesn't need to be clever — reorder threshold 10-20).

- [ ] **Step 8: Run the full pharmacy-schema test plus a spot-check that seeding is idempotent**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/pharmacy-schema.test.ts`. Confirm your `seedMedications()` reasoning is idempotent by reading it carefully — do NOT run `npm run db:seed` against the live shared dev database as part of this task (that's a real, disruptive action outside this task's scope, same discipline as the payer-directory plan). If you want extra confidence, write a small throwaway read-only check confirming your insert logic's `WHERE NOT EXISTS`/check-before-insert shape is correct, not by executing the full seed script.

- [ ] **Step 9: Commit**

```bash
git add src/db/schema.ts src/db/seed.ts tests/db/pharmacy-schema.test.ts
git commit -m "feat: add medications catalog, inventory, and dispense tables with seed data"
```

---

### Task 2: Query layer + dispense route

**Files:**
- Create: `src/lib/queries/medications.ts`
- Create: `src/lib/queries/medication-dispenses.ts`
- Create: `src/app/api/pharmacy/medications/route.ts` (GET — catalog + inventory joined)
- Create: `src/app/api/pharmacy/dispense/route.ts` (POST)
- Test: `tests/lib/queries/medications.test.ts`, `tests/lib/queries/medication-dispenses.test.ts`, `tests/api/pharmacy-dispense.test.ts`

**Interfaces:**
- Consumes: `medications`, `medicationInventory`, `medicationDispenses` from `@/db/schema` (Task 1); `medicationEpisodes` from `@/db/schema` (existing).
- Produces: `listMedicationsWithInventory()`, `getMedicationById(id)` from `@/lib/queries/medications`; `dispenseMedication(input)`, `listDispensesForPatient(patientId)` from `@/lib/queries/medication-dispenses` — consumed by Tasks 3, 4.

- [ ] **Step 1: Write the failing test — query layer**

Create `tests/lib/queries/medications.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { listMedicationsWithInventory, getMedicationById } from '@/lib/queries/medications'

describe('medications queries', () => {
  it('lists medications with their inventory joined', async () => {
    const all = await listMedicationsWithInventory()
    expect(all.length).toBeGreaterThanOrEqual(15)
    expect(all.every((m) => typeof m.quantityOnHand === 'number')).toBe(true)
    expect(all.some((m) => m.name === 'Sertraline')).toBe(true)
  })

  it('gets a single medication by id', async () => {
    const all = await listMedicationsWithInventory()
    const byId = await getMedicationById(all[0].id)
    expect(byId?.name).toBe(all[0].name)
  })
})
```

Create `tests/lib/queries/medication-dispenses.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, medications, medicationInventory, medicationDispenses } from '@/db/schema'
import { dispenseMedication, listDispensesForPatient } from '@/lib/queries/medication-dispenses'

const createdDispenseIds: number[] = []
afterEach(async () => {
  while (createdDispenseIds.length > 0) await getDb().delete(medicationDispenses).where(eq(medicationDispenses.id, createdDispenseIds.pop()!))
})

async function makeMedWithStock(qty: number) {
  const db = getDb()
  const [med] = await db.insert(medications).values({ name: `Test Dispense Med ${Date.now()}`, medicationClass: 'Test', form: 'tablet' }).returning()
  await db.insert(medicationInventory).values({ medicationId: med.id, quantityOnHand: qty, reorderThreshold: 5, unit: 'tablets' })
  return med
}

describe('medication dispenses', () => {
  it('dispenses and decrements stock', async () => {
    const med = await makeMedWithStock(50)
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const result = await dispenseMedication({ patientId: patientRow.id, medicationId: med.id, medicationEpisodeId: null, quantity: 10, dispensedByName: 'Test Staff', notes: null })
    expect(result.ok).toBe(true)
    createdDispenseIds.push(result.dispenseId!)

    const [inv] = await getDb().select().from(medicationInventory).where(eq(medicationInventory.medicationId, med.id))
    expect(inv.quantityOnHand).toBe(40)

    const history = await listDispensesForPatient(patientRow.id)
    expect(history.some((d) => d.id === result.dispenseId)).toBe(true)
  })

  it('rejects dispensing more than is on hand', async () => {
    const med = await makeMedWithStock(5)
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const result = await dispenseMedication({ patientId: patientRow.id, medicationId: med.id, medicationEpisodeId: null, quantity: 10, dispensedByName: 'Test Staff', notes: null })
    expect(result.ok).toBe(false)
    const [inv] = await getDb().select().from(medicationInventory).where(eq(medicationInventory.medicationId, med.id))
    expect(inv.quantityOnHand).toBe(5) // unchanged
  })

  it('two patients dispense histories stay independent', async () => {
    const med = await makeMedWithStock(100)
    const patientsRows = await getDb().select().from(patients).limit(2)
    const [patientA, patientB] = patientsRows
    const resultA = await dispenseMedication({ patientId: patientA.id, medicationId: med.id, medicationEpisodeId: null, quantity: 5, dispensedByName: 'Staff A', notes: null })
    createdDispenseIds.push(resultA.dispenseId!)
    const resultB = await dispenseMedication({ patientId: patientB.id, medicationId: med.id, medicationEpisodeId: null, quantity: 7, dispensedByName: 'Staff B', notes: null })
    createdDispenseIds.push(resultB.dispenseId!)

    const historyA = await listDispensesForPatient(patientA.id)
    const historyB = await listDispensesForPatient(patientB.id)
    expect(historyA.some((d) => d.id === resultB.dispenseId)).toBe(false)
    expect(historyB.some((d) => d.id === resultA.dispenseId)).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/medications.test.ts tests/lib/queries/medication-dispenses.test.ts`
Expected: FAIL — modules don't exist.

- [ ] **Step 3: Implement `src/lib/queries/medications.ts`**

```ts
import { getDb } from '@/db/client'
import { medications, medicationInventory } from '@/db/schema'
import { asc, eq } from 'drizzle-orm'

export interface MedicationWithInventory {
  id: number
  name: string
  genericName: string | null
  medicationClass: string
  commonDose: string | null
  form: 'tablet' | 'capsule' | 'liquid' | 'injection' | 'other'
  quantityOnHand: number
  reorderThreshold: number
  unit: string
}

export async function listMedicationsWithInventory(): Promise<MedicationWithInventory[]> {
  const rows = await getDb()
    .select({
      id: medications.id, name: medications.name, genericName: medications.genericName,
      medicationClass: medications.medicationClass, commonDose: medications.commonDose, form: medications.form,
      quantityOnHand: medicationInventory.quantityOnHand, reorderThreshold: medicationInventory.reorderThreshold, unit: medicationInventory.unit,
    })
    .from(medications)
    .innerJoin(medicationInventory, eq(medicationInventory.medicationId, medications.id))
    .orderBy(asc(medications.name))
  return rows
}

export async function getMedicationById(id: number) {
  const [row] = await getDb().select().from(medications).where(eq(medications.id, id))
  return row ?? null
}
```

- [ ] **Step 4: Implement `src/lib/queries/medication-dispenses.ts`**

```ts
import { getDb } from '@/db/client'
import { medicationDispenses, medicationInventory, medicationEpisodes } from '@/db/schema'
import { and, desc, eq, gte } from 'drizzle-orm'

export interface DispenseInput {
  patientId: string
  medicationId: number
  medicationEpisodeId: number | null
  quantity: number
  dispensedByName: string
  notes: string | null
}

export interface DispenseResult {
  ok: boolean
  error?: string
  dispenseId?: number
}

// The stock decrement is a single conditional UPDATE (quantity_on_hand >=
// requested in the WHERE, not a separate read-then-write) so two concurrent
// dispenses of the same drug can't both succeed past the actual stock --
// same race-safety pattern as Front Desk's room assignment and the MAR's
// administerMedication elsewhere in this codebase.
export async function dispenseMedication(input: DispenseInput): Promise<DispenseResult> {
  const db = getDb()

  if (input.medicationEpisodeId !== null) {
    const [episode] = await db.select().from(medicationEpisodes).where(eq(medicationEpisodes.id, input.medicationEpisodeId))
    if (!episode || episode.patientId !== input.patientId) {
      return { ok: false, error: 'medicationEpisodeId does not belong to this patient' }
    }
  }

  const decremented = await db.update(medicationInventory)
    .set({ quantityOnHand: db.$count ? undefined : undefined }) // placeholder replaced below -- see note
    .where(and(eq(medicationInventory.medicationId, input.medicationId), gte(medicationInventory.quantityOnHand, input.quantity)))
    .returning({ id: medicationInventory.id })
  // NOTE for implementer: Drizzle's `set()` needs an actual decrement
  // expression here (e.g. `sql`${medicationInventory.quantityOnHand} - ${input.quantity}``
  // imported from 'drizzle-orm'), not the placeholder above -- write the
  // real decrement, then re-run this task's tests to confirm the exact
  // stock-after-dispense assertions pass.
  if (decremented.length === 0) return { ok: false, error: 'Not enough stock on hand for this quantity' }

  const [created] = await db.insert(medicationDispenses).values({
    patientId: input.patientId, medicationId: input.medicationId, medicationEpisodeId: input.medicationEpisodeId,
    quantity: input.quantity, dispensedByName: input.dispensedByName, notes: input.notes,
  }).returning()

  return { ok: true, dispenseId: created.id }
}

export async function listDispensesForPatient(patientId: string) {
  return getDb().select().from(medicationDispenses).where(eq(medicationDispenses.patientId, patientId)).orderBy(desc(medicationDispenses.dispensedAt))
}
```

- [ ] **Step 5: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/medications.test.ts tests/lib/queries/medication-dispenses.test.ts`
Expected: PASS (5 tests total). If the decrement expression placeholder in Step 4 needs fixing to actually compile/run — it does, deliberately left incomplete — fix it now using Drizzle's `sql` template for `quantity_on_hand - ${input.quantity}` in the `set()` call.

- [ ] **Step 6: Write the failing test — API route**

Create `tests/api/pharmacy-dispense.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { POST as dispenseRoute } from '@/app/api/pharmacy/dispense/route'
import { getDb } from '@/db/client'
import { patients, medications, medicationInventory, medicationDispenses } from '@/db/schema'

let sessionRole: 'admin' | 'pi' | 'crc' | 'frontdesk' = 'pi'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Dr. R. Kunam' })) }))

const createdDispenseIds: number[] = []
const createdMedIds: number[] = []
afterEach(async () => {
  sessionRole = 'pi'
  while (createdDispenseIds.length > 0) await getDb().delete(medicationDispenses).where(eq(medicationDispenses.id, createdDispenseIds.pop()!))
  while (createdMedIds.length > 0) {
    const id = createdMedIds.pop()!
    await getDb().delete(medicationInventory).where(eq(medicationInventory.medicationId, id))
    await getDb().delete(medications).where(eq(medications.id, id))
  }
})

async function makeMedWithStock(qty: number) {
  const db = getDb()
  const [med] = await db.insert(medications).values({ name: `Route Test Med ${Date.now()}`, medicationClass: 'Test', form: 'tablet' }).returning()
  createdMedIds.push(med.id)
  await db.insert(medicationInventory).values({ medicationId: med.id, quantityOnHand: qty, reorderThreshold: 5, unit: 'tablets' })
  return med
}

function req(body: unknown) {
  return new Request('http://localhost', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
}

describe('POST /api/pharmacy/dispense', () => {
  it('dispenses successfully as pi', async () => {
    const med = await makeMedWithStock(30)
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const res = await dispenseRoute(req({ patientId: patientRow.id, medicationId: med.id, quantity: 5, notes: 'Test dispense' }) as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    createdDispenseIds.push(body.id)
  })

  it('rejects a frontdesk session', async () => {
    sessionRole = 'frontdesk'
    const med = await makeMedWithStock(30)
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const res = await dispenseRoute(req({ patientId: patientRow.id, medicationId: med.id, quantity: 5 }) as never)
    expect(res.status).toBe(403)
  })

  it('rejects dispensing more than on hand', async () => {
    const med = await makeMedWithStock(3)
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const res = await dispenseRoute(req({ patientId: patientRow.id, medicationId: med.id, quantity: 10 }) as never)
    expect(res.status).toBe(409)
  })
})
```

- [ ] **Step 7: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/pharmacy-dispense.test.ts`
Expected: FAIL — route doesn't exist.

- [ ] **Step 8: Implement `src/app/api/pharmacy/dispense/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { dispenseMedication } from '@/lib/queries/medication-dispenses'

const dispenseSchema = z.object({
  patientId: z.string().min(1),
  medicationId: z.number().int(),
  medicationEpisodeId: z.number().int().optional(),
  quantity: z.number().int().positive(),
  notes: z.string().optional(),
}).strict()

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['admin', 'pi'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const parsed = dispenseSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid dispense payload', details: parsed.error.flatten() }, { status: 400 })

  const result = await dispenseMedication({
    patientId: parsed.data.patientId,
    medicationId: parsed.data.medicationId,
    medicationEpisodeId: parsed.data.medicationEpisodeId ?? null,
    quantity: parsed.data.quantity,
    dispensedByName: session.name,
    notes: parsed.data.notes ?? null,
  })
  if (!result.ok) {
    const status = result.error?.includes('does not belong') ? 400 : 409
    return NextResponse.json({ error: result.error }, { status })
  }

  await logAudit(session, 'dispensed medication', parsed.data.patientId)
  return NextResponse.json({ id: result.dispenseId }, { status: 201 })
}
```

- [ ] **Step 9: Implement the read-only catalog route**

Create `src/app/api/pharmacy/medications/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { listMedicationsWithInventory } from '@/lib/queries/medications'

export async function GET() {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  return NextResponse.json(await listMedicationsWithInventory())
}
```

- [ ] **Step 10: Run all this task's tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/medications.test.ts tests/lib/queries/medication-dispenses.test.ts tests/api/pharmacy-dispense.test.ts`
Expected: PASS (8 tests total).

- [ ] **Step 11: Commit**

```bash
git add src/lib/queries/medications.ts src/lib/queries/medication-dispenses.ts src/app/api/pharmacy tests/lib/queries/medications.test.ts tests/lib/queries/medication-dispenses.test.ts tests/api/pharmacy-dispense.test.ts
git commit -m "feat: add pharmacy dispense route with race-safe stock decrement"
```

---

### Task 3: Pharmacy dashboard UI

**Files:**
- Create: `src/components/PharmacyDashboard.tsx`
- Create: `src/components/DispenseMedicationModal.tsx`
- Create: `src/app/(dashboard)/pharmacy/page.tsx`
- Modify: `src/components/LeftNav.tsx` (add a nav entry)
- Modify: `src/lib/role-capabilities.ts` (if this file gates nav items by role — read it first to confirm the exact mechanism before editing)
- Test: none new (UI wiring over already-tested routes) — verify per this plan's UI verification discipline (Global Constraints).

**Interfaces:**
- Consumes: `GET /api/pharmacy/medications`, `POST /api/pharmacy/dispense` (Task 2, called by URL from client components, not imported functions).

- [ ] **Step 1: Read the existing nav/role-capability pattern**

Read `src/components/LeftNav.tsx` and `src/lib/role-capabilities.ts` in full to understand exactly how an existing nav item (e.g. `/inpatient/beds`) is registered and role-gated, before adding a new one for `/pharmacy`. Match the pattern exactly.

- [ ] **Step 2: Build the page and dashboard component**

Create `src/app/(dashboard)/pharmacy/page.tsx` as a Server Component: `requireSessionOrRedirect()` first, fetch `listMedicationsWithInventory()` directly (Server Components call the query layer directly, never `fetch()` their own API routes — this codebase's own established, security-motivated rule), pass to `<PharmacyDashboard medications={...} canDispense={['admin','pi'].includes(session.role)} />`.

Create `src/components/PharmacyDashboard.tsx` (`'use client'`): a table of medications, each row showing name, class, `quantityOnHand`/`unit`, and a status pill — `ok` (green) when `quantityOnHand > reorderThreshold`, `low stock` (amber) when `0 < quantityOnHand <= reorderThreshold`, `out of stock` (red) when `quantityOnHand === 0` (Review Focus item #5 — handle zero explicitly, don't just check "below threshold"). A "Dispense" button per row (only rendered when `canDispense`) opens `DispenseMedicationModal`.

- [ ] **Step 3: Build the dispense modal**

Create `src/components/DispenseMedicationModal.tsx` (`'use client'`), following the Dialog-modal-with-fetch pattern already established by this codebase's other action modals (e.g. `TransferAdmissionModal.tsx`/`MedicationAdministrationPanel.tsx` from prior plans — read one for the exact shape): patient-ID text input (matches the simple text-input pattern `EligibilityCheckModal.tsx` already uses for patient lookup, not a full autocomplete — no such component exists yet in this codebase, don't invent one), quantity number input, optional notes, `POST /api/pharmacy/dispense` on submit, `router.refresh()` on success, inline error display.

- [ ] **Step 4: Verify via a real running dev server, not narration**

Real login, real GET of `/pharmacy`, confirm the medication list and stock levels render; real dispense POST, confirm a second GET shows decremented stock. Paste actual commands and actual output.

- [ ] **Step 5: Commit**

```bash
git add src/components/PharmacyDashboard.tsx src/components/DispenseMedicationModal.tsx "src/app/(dashboard)/pharmacy/page.tsx" src/components/LeftNav.tsx src/lib/role-capabilities.ts
git commit -m "feat: add Pharmacy dashboard with dispense workflow"
```

---

### Task 4: Medical Record — Medications Dispensed history

**Files:**
- Modify: `src/app/(dashboard)/patients/[anonId]/medical-record/page.tsx`
- Test: none new — verify per this plan's UI verification discipline.

**Interfaces:**
- Consumes: `listDispensesForPatient(patientId)` (Task 2).

- [ ] **Step 1: Read the current state of the Medical Record page**

This file has already had a Notes section and an Insurance section added by prior plans in this session's history — read its actual current state (it may differ between this worktree and the main checkout depending on merge order; this worktree forked from `hims-platform` at a point that already includes both prior sections). Don't assume a version without them.

- [ ] **Step 2: Add the "Medications Dispensed" section**

Fetch `listDispensesForPatient(anonId)` alongside this page's existing data fetches. Add a new `<section className={SECTION}>` (this file's existing convention) titled "Medications Dispensed", listing each dispense newest-first: medication name (join `medications` for display, or accept `medicationId` display as a simple lookup against the already-fetched catalog if that's cheaper — implementer's call), quantity + unit, dispensed-by name, date. Read-only — no dispense action here (the Pharmacy dashboard, Task 3, is the one front door for that write).

- [ ] **Step 3: Verify via a real running dev server, not narration**

Real login, real dispense via the Pharmacy dashboard's route for a specific patient, real GET of that patient's medical-record page, confirm the dispensed medication appears. Paste actual commands and output.

- [ ] **Step 4: Run the full suite once**

Run: `npx dotenv -e .env.local -- npx vitest run`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/patients/[anonId]/medical-record/page.tsx"
git commit -m "feat: add Medications Dispensed history to Medical Record page"
```
