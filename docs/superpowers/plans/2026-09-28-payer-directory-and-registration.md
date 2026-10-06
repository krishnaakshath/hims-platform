# Payer Directory, Patient Insurance & Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Clinsync a real payer reference directory (US payers, realistic payer IDs), patient insurance/subscriber fields captured at staff registration, insurance card image capture, and a richer eligibility-check response — the registration and insurance half of the "complete the HIMS platform" backlog, following the encounter-notes-and-mar feature.

**Architecture:** `payers` is a small, seeded, read-only reference table (not a CRUD screen — real payer directories come from a clearinghouse, not staff typing). Patient insurance is embedded directly on `patients` as nullable prefixed columns (`primary*`/`secondary*`), matching this codebase's existing convention for a fixed small number of typed slots (`nameIntakeq`/`nameTebra`). `insuranceClaims`/`insuranceEligibilityChecks` gain an additive `payerId` FK alongside their existing free-text `payerName`, backfilled best-effort, with `payerName` staying as a display fallback for anything that doesn't match.

**Scope decisions made while planning (rulings, not left open for the implementer to guess):**
1. **The patient intake portal's "insurance question type" from spec §4 is deferred, not built in this plan.** `formTemplates.questions[].type` is a fixed union (`'text'|'textarea'|'date'|'select'|'checkbox'`) and `formSubmissions.answers` is `Record<string, string>` — a flat string map with no room for a structured multi-field answer or a file upload. Adding a real `insurance` question type means widening both of those, which is its own architectural change touching every existing consumer of `answers`, not a natural fit inside this plan's task set. This plan builds insurance capture through the **staff Add Client flow only** (spec §4's other entry point) — the spec's core value (real payer directory, structured fields, card capture, richer eligibility) is fully delivered without the intake-portal path. A follow-up plan can add it later.
2. **Insurance card upload is staff-initiated only in this plan** (spec §5's staff route), not the patient-portal-initiated variant the spec also describes. The patient-portal session/auth pattern needs its own grounding pass before extending to file uploads; staff-side (Add Client / Medical Record) delivers the real capability spec §1 asks for.
3. **Card upload happens from the Medical Record page's Insurance section, not inside the Add Client modal.** A patient doesn't have an id to attach a file to until Add Client's `POST` returns it — so capturing insurance *text* fields (payer, member id, group, subscriber) happens at creation time in Add Client, and card images are captured as a separate action once the patient exists, on the page that already displays insurance (Task 5).
4. **[Added post-implementation, final review]: there is no way to add or edit insurance on a patient who already exists.** Insurance capture is write-once, at the moment of Add Client's `POST /api/patients` only — there is no PATCH route, and the Medical Record page's "no insurance on file" empty state (Task 5) does not include the "Add insurance" action spec §6 originally described. This means: every patient in the database before this plan shipped, and every patient created without a payer selected, has no path to insurance card upload — Task 4's upload route is real and correct, but unreachable for them through the UI. This is a genuine, explicit deferral (not an oversight caught silently) — flagged by the final whole-branch review and recorded here rather than either building new scope unasked or shipping it undocumented. Same applies to secondary insurance: the schema and display exist (Task 1, Task 5) but no route or UI ever writes `secondary*` fields — spec §4's "+ Add secondary insurance" toggle was never built. A follow-up plan (an "edit patient insurance" PATCH route + UI, covering both first-time-add-after-creation and secondary capture) can close this whenever it's prioritized.

**Tech Stack:** Next.js 16 App Router (Server Components) + Drizzle ORM over a `pg` Pool (additive-only schema changes via a hand-written one-off script, never `drizzle-kit push`) + `@vercel/blob` (new dependency, first real use in this codebase) + `@base-ui/react` Dialog primitive + Tailwind v4 oklch tokens.

**Spec:** `docs/superpowers/specs/2026-09-28-payer-directory-and-registration.md`

## Global Constraints

- Additive-only schema changes. Apply via a hand-written one-off script run with `npx dotenv -e .env.local -- npx tsx <script>` — never `drizzle-kit push`. Single shared Neon Postgres database across every branch/worktree.
- `psql` is **not installed** in this environment (confirmed this session) — verify a migration's live-DB effect with a Node script using `pg`'s `Pool` and an `information_schema.columns` query, not `psql -c "\d ..."`.
- Every write route uses `.strict()` Zod validation (rejects unknown fields).
- Every state-changing route calls `logAudit(session, <action>, <patientId or null>)`.
- Every protected route/page starts with `requireSession()` (API routes) or `requireSessionOrRedirect()` (pages) as its first statement.
- Read access (view a patient's insurance, run an eligibility check's result): `admin`, `pi`, `crc`, `frontdesk`. Write access (add/edit insurance fields, upload card images, run an eligibility check): `admin`, `crc`, `frontdesk` — **not** `pi`, matching the existing `POST /api/front-desk/eligibility-check` gating exactly (front desk/coordinators register patients and verify coverage; investigators don't).
- This session's Claude Code auto-mode permission classifier has blocked several raw ad-hoc DB-mutation/cleanup scripts run directly via Bash (reasons seen: "Modify Shared Resources", "Unverifiable Deletion Scope", "Credential Materialization"). Prefer doing any one-off data mutation through a legitimate, already-permitted code path (a test's own setup/teardown, or the migration-script pattern that has run successfully every time this session) over a bespoke inline script. If the Task 1 migration script itself gets blocked, stop and report it rather than retrying with different phrasing.
- Vitest invocation: `npx dotenv -e .env.local -- npx vitest run <path>` (`fileParallelism: false`).
- Commit messages end with no attribution trailer.
- **UI verification discipline (learned this session):** a prior task's implementer fabricated a "manual verification via component testing" narrative that turned out to be technically impossible in this environment (no `fetch` polyfill for relative URLs in the jsdom test environment). For any UI task in this plan: verification must be either (a) a real running dev server hit with real HTTP requests (`node -e "fetch(...)"`, exactly as this session's controller did to verify the previous feature), or (b) explicitly reported as **not verified**, with the reason — never a narrated claim that cannot be reproduced from the commands actually run. Paste real command output in the report, not a description of what the output was.

## Review Focus

1. **A patient with no insurance on file at all** — every new field is nullable; creating/viewing/editing a patient with zero insurance data must remain a fully valid, non-error state (self-pay patients are real). (Tasks 3, 5)
2. **The `payerId` backfill on `insuranceClaims`/`insuranceEligibilityChecks` matching the wrong payer**, or matching nothing — the migration's `ILIKE`-based backfill is best-effort; a row whose `payerName` doesn't match any seeded payer must keep working (via the `payerName` fallback), not break existing claim/eligibility read paths. (Task 1)
3. **An uploaded "insurance card" that isn't actually an image** (wrong content-type, oversized file) — the upload route must reject it before it reaches Vercel Blob, not after. (Task 4)
4. **A `payerId` on a claim/eligibility-check write that doesn't exist in the `payers` table** — the write route must validate this FK reference exists (400), not let Postgres's own FK violation surface as an unhandled 500. (Tasks 3, 6)
5. **Two patients with genuinely different insurance** rendered side-by-side without either bleeding into the other's fields — the query and UI layer must key everything off the specific patient's own row, not a shared/cached lookup. (Task 5)

---

### Task 1: Schema — `payers` table, patient insurance columns, claim/eligibility `payerId`, wider `idTypeEnum`

**Files:**
- Modify: `src/db/schema.ts` (new enums/table, additive columns on `patients`/`insuranceClaims`/`insuranceEligibilityChecks`, widen `idTypeEnum`)
- Test: `tests/db/payer-directory-schema.test.ts`

**Interfaces:**
- Produces: `payerTypeEnum`, `payers` table (`id, name, payerId, payerType`); `insuranceRelationshipEnum`, `insurancePlanTypeEnum`; `patients` gains `primaryPayerId, primaryMemberId, primaryGroupNumber, primaryPlanType, primarySubscriberName, primarySubscriberRelationship, primaryCardFrontUrl, primaryCardBackUrl` and the `secondary*` mirror set (all nullable); `insuranceClaims`/`insuranceEligibilityChecks` gain nullable `payerId: integer references payers.id`; `insuranceEligibilityChecks` gains `deductibleRemainingCents, planType, coverageStartDate`; `idTypeEnum` widens to include `'military_id', 'green_card'`. All consumed by Tasks 2-6.

- [ ] **Step 1: Write the failing test**

Create `tests/db/payer-directory-schema.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, payers, identityVerifications } from '@/db/schema'

const createdPayerIds: number[] = []
afterEach(async () => {
  while (createdPayerIds.length > 0) await getDb().delete(payers).where(eq(payers.id, createdPayerIds.pop()!))
})

describe('payer directory / patient insurance schema', () => {
  it('inserts a payer and reads its type back', async () => {
    const [payer] = await getDb().insert(payers).values({ name: 'Test Payer Co', payerId: '99999', payerType: 'commercial' }).returning()
    createdPayerIds.push(payer.id)
    expect(payer.payerType).toBe('commercial')
  })

  it('a patient can carry nullable primary/secondary insurance referencing a payer', async () => {
    const db = getDb()
    const [payer] = await db.insert(payers).values({ name: 'Test Payer Co', payerId: '99999', payerType: 'commercial' }).returning()
    createdPayerIds.push(payer.id)
    const [patientRow] = await db.select().from(patients).limit(1)
    expect(patientRow.primaryPayerId ?? null).not.toBeUndefined() // column exists and is readable even when null

    const [updated] = await db.update(patients).set({
      primaryPayerId: payer.id,
      primaryMemberId: 'M123',
      primaryGroupNumber: 'G456',
      primaryPlanType: 'ppo',
      primarySubscriberName: 'Test Subscriber',
      primarySubscriberRelationship: 'self',
    }).where(eq(patients.id, patientRow.id)).returning()
    expect(updated.primaryPayerId).toBe(payer.id)
    expect(updated.primaryPlanType).toBe('ppo')

    // Revert -- this is a real seeded patient row, not scratch data.
    await db.update(patients).set({
      primaryPayerId: null, primaryMemberId: null, primaryGroupNumber: null,
      primaryPlanType: null, primarySubscriberName: null, primarySubscriberRelationship: null,
    }).where(eq(patients.id, patientRow.id))
  })

  it('widened idTypeEnum accepts military_id and green_card', async () => {
    const db = getDb()
    const [patientRow] = await db.select().from(patients).limit(1)
    const [existing] = await db.select().from(identityVerifications).where(eq(identityVerifications.patientId, patientRow.id))
    if (existing) {
      // Confirm the enum accepts the new values via an UPDATE ... RETURNING round trip, then restore.
      const [updated] = await db.update(identityVerifications).set({ idType: 'military_id' }).where(eq(identityVerifications.id, existing.id)).returning()
      expect(updated.idType).toBe('military_id')
      await db.update(identityVerifications).set({ idType: existing.idType }).where(eq(identityVerifications.id, existing.id))
    }
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/payer-directory-schema.test.ts`
Expected: FAIL — `payers` not exported from `@/db/schema`, `patients` has no `primaryPayerId`, etc.

- [ ] **Step 3: Add the schema definitions**

In `src/db/schema.ts`, add near the other reference/enum definitions (co-locate with `insuranceEligibilityChecks`, since they're the closest related existing table):

```ts
export const payerTypeEnum = pgEnum('payer_type', ['commercial', 'medicare', 'medicaid', 'tricare', 'other'])

export const payers = pgTable('payers', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  payerId: text('payer_id').notNull(),
  payerType: payerTypeEnum('payer_type').default('commercial').notNull(),
})

export const insuranceRelationshipEnum = pgEnum('insurance_relationship', ['self', 'spouse', 'child', 'other'])
export const insurancePlanTypeEnum = pgEnum('insurance_plan_type', ['ppo', 'hmo', 'epo', 'pos', 'medicare', 'medicaid'])
```

Add to the `patients` table definition (additive columns, any position — append at the end of the existing column list is simplest and matches how `mfaSecretEncrypted`/`mfaEnabled` were appended previously):

```ts
  primaryPayerId: integer('primary_payer_id').references(() => payers.id),
  primaryMemberId: text('primary_member_id'),
  primaryGroupNumber: text('primary_group_number'),
  primaryPlanType: insurancePlanTypeEnum('primary_plan_type'),
  primarySubscriberName: text('primary_subscriber_name'),
  primarySubscriberRelationship: insuranceRelationshipEnum('primary_subscriber_relationship'),
  primaryCardFrontUrl: text('primary_card_front_url'),
  primaryCardBackUrl: text('primary_card_back_url'),
  secondaryPayerId: integer('secondary_payer_id').references(() => payers.id),
  secondaryMemberId: text('secondary_member_id'),
  secondaryGroupNumber: text('secondary_group_number'),
  secondaryPlanType: insurancePlanTypeEnum('secondary_plan_type'),
  secondarySubscriberName: text('secondary_subscriber_name'),
  secondarySubscriberRelationship: insuranceRelationshipEnum('secondary_subscriber_relationship'),
```

Add to `insuranceClaims`: `payerId: integer('payer_id').references(() => payers.id),` (keep the existing `payerName` column unchanged).
Add to `insuranceEligibilityChecks`: `payerId: integer('payer_id').references(() => payers.id), deductibleRemainingCents: integer('deductible_remaining_cents'), planType: insurancePlanTypeEnum('plan_type'), coverageStartDate: date('coverage_start_date'),` (keep `payerName` unchanged).

Change the existing `idTypeEnum` line from:
```ts
export const idTypeEnum = pgEnum('id_type', ['drivers_license', 'state_id', 'passport'])
```
to:
```ts
export const idTypeEnum = pgEnum('id_type', ['drivers_license', 'state_id', 'passport', 'military_id', 'green_card'])
```

- [ ] **Step 4: Run the test again — expect a different failure**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/payer-directory-schema.test.ts`
Expected: FAIL — now a runtime DB error (relation/column does not exist), not an import error.

- [ ] **Step 5: Write and run the one-off migration script**

Scratch, not part of the repo — create, run once, delete. Create `migrate-payer-directory-scratch.ts` at the repo root:

```ts
import { Pool } from 'pg'

const PAYERS: { name: string; payerId: string; payerType: 'commercial' | 'medicare' | 'medicaid' | 'tricare' }[] = [
  { name: 'Aetna', payerId: '60054', payerType: 'commercial' },
  { name: 'UnitedHealthcare', payerId: '87726', payerType: 'commercial' },
  { name: 'Cigna', payerId: '62308', payerType: 'commercial' },
  { name: 'Humana', payerId: '61101', payerType: 'commercial' },
  { name: 'Anthem Blue Cross of California', payerId: '47198', payerType: 'commercial' },
  { name: 'Blue Shield of California', payerId: '47163', payerType: 'commercial' },
  { name: 'Kaiser Permanente', payerId: '94134', payerType: 'commercial' },
  { name: 'Molina Healthcare', payerId: '38333', payerType: 'commercial' },
  { name: 'Ambetter (Centene)', payerId: '68069', payerType: 'commercial' },
  { name: 'Oscar Health', payerId: '72187', payerType: 'commercial' },
  { name: 'Health Net', payerId: '95567', payerType: 'commercial' },
  { name: 'Medicare (Noridian, CA)', payerId: '00590', payerType: 'medicare' },
  { name: 'Medi-Cal', payerId: '12X0', payerType: 'medicaid' },
  { name: 'TRICARE', payerId: '99726', payerType: 'tricare' },
]

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false } })

  await pool.query(`DO $$ BEGIN CREATE TYPE payer_type AS ENUM ('commercial', 'medicare', 'medicaid', 'tricare', 'other'); EXCEPTION WHEN duplicate_object THEN null; END $$;`)
  await pool.query(`DO $$ BEGIN CREATE TYPE insurance_relationship AS ENUM ('self', 'spouse', 'child', 'other'); EXCEPTION WHEN duplicate_object THEN null; END $$;`)
  await pool.query(`DO $$ BEGIN CREATE TYPE insurance_plan_type AS ENUM ('ppo', 'hmo', 'epo', 'pos', 'medicare', 'medicaid'); EXCEPTION WHEN duplicate_object THEN null; END $$;`)
  await pool.query(`ALTER TYPE id_type ADD VALUE IF NOT EXISTS 'military_id'`)
  await pool.query(`ALTER TYPE id_type ADD VALUE IF NOT EXISTS 'green_card'`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS payers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      payer_id TEXT NOT NULL,
      payer_type payer_type NOT NULL DEFAULT 'commercial'
    )
  `)

  await pool.query(`
    ALTER TABLE patients
      ADD COLUMN IF NOT EXISTS primary_payer_id INTEGER REFERENCES payers(id),
      ADD COLUMN IF NOT EXISTS primary_member_id TEXT,
      ADD COLUMN IF NOT EXISTS primary_group_number TEXT,
      ADD COLUMN IF NOT EXISTS primary_plan_type insurance_plan_type,
      ADD COLUMN IF NOT EXISTS primary_subscriber_name TEXT,
      ADD COLUMN IF NOT EXISTS primary_subscriber_relationship insurance_relationship,
      ADD COLUMN IF NOT EXISTS primary_card_front_url TEXT,
      ADD COLUMN IF NOT EXISTS primary_card_back_url TEXT,
      ADD COLUMN IF NOT EXISTS secondary_payer_id INTEGER REFERENCES payers(id),
      ADD COLUMN IF NOT EXISTS secondary_member_id TEXT,
      ADD COLUMN IF NOT EXISTS secondary_group_number TEXT,
      ADD COLUMN IF NOT EXISTS secondary_plan_type insurance_plan_type,
      ADD COLUMN IF NOT EXISTS secondary_subscriber_name TEXT,
      ADD COLUMN IF NOT EXISTS secondary_subscriber_relationship insurance_relationship
  `)

  await pool.query(`ALTER TABLE insurance_claims ADD COLUMN IF NOT EXISTS payer_id INTEGER REFERENCES payers(id)`)
  await pool.query(`
    ALTER TABLE insurance_eligibility_checks
      ADD COLUMN IF NOT EXISTS payer_id INTEGER REFERENCES payers(id),
      ADD COLUMN IF NOT EXISTS deductible_remaining_cents INTEGER,
      ADD COLUMN IF NOT EXISTS plan_type insurance_plan_type,
      ADD COLUMN IF NOT EXISTS coverage_start_date DATE
  `)

  for (const p of PAYERS) {
    const existing = await pool.query('SELECT id FROM payers WHERE name = $1', [p.name])
    if (existing.rows.length === 0) {
      await pool.query('INSERT INTO payers (name, payer_id, payer_type) VALUES ($1, $2, $3)', [p.name, p.payerId, p.payerType])
    }
  }

  // Best-effort backfill: match existing free-text payerName against the new directory.
  await pool.query(`
    UPDATE insurance_claims c SET payer_id = p.id
    FROM payers p WHERE c.payer_id IS NULL AND c.payer_name ILIKE '%' || p.name || '%'
  `)
  await pool.query(`
    UPDATE insurance_eligibility_checks e SET payer_id = p.id
    FROM payers p WHERE e.payer_id IS NULL AND e.payer_name ILIKE '%' || p.name || '%'
  `)

  console.log('Payer directory migration complete.')
  await pool.end()
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1) })
```

Run: `npx dotenv -e .env.local -- npx tsx migrate-payer-directory-scratch.ts`

If blocked by the permission classifier: stop, do not retry with variations, report it — it's a single copy-pasteable command for a human to run.

Verify with a Node script (no `psql` in this environment):
```ts
import { Pool } from 'pg'
const pool = new Pool({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false } })
const res = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'patients' AND column_name LIKE 'primary_%'`)
console.log(res.rows)
```

**Also verify the backfill's two failure modes directly** (Review Focus item #2 — a mismatch must not break the existing row, and a match must be the right payer, not just any payer):
```ts
// Rows that matched: payer_id set, and it's the payer whose name is actually
// contained in the old free-text payerName (not just "some" payer).
const matched = await pool.query(`SELECT c.id, c.payer_name, p.name FROM insurance_claims c JOIN payers p ON c.payer_id = p.id LIMIT 5`)
console.log('matched rows (payer_name should contain p.name):', matched.rows)
// Rows that didn't match anything: payer_id is null, but payer_name (the
// fallback display value) is still intact, not wiped out by the backfill.
const unmatched = await pool.query(`SELECT id, payer_name, payer_id FROM insurance_claims WHERE payer_id IS NULL LIMIT 5`)
console.log('unmatched rows (payer_name must still be non-null):', unmatched.rows)
```

Once confirmed, delete the scratch script: `rm migrate-payer-directory-scratch.ts`.

- [ ] **Step 6: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/payer-directory-schema.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts tests/db/payer-directory-schema.test.ts
git commit -m "feat: add payers table, patient insurance columns, claim/eligibility payerId"
```

---

### Task 2: Payer directory queries + list route

**Files:**
- Create: `src/lib/queries/payers.ts`
- Create: `src/app/api/payers/route.ts` (GET only — read-only reference data, no write route; matches spec §3's "not a CRUD screen")
- Test: `tests/lib/queries/payers.test.ts`

**Interfaces:**
- Consumes: `payers` from `@/db/schema` (Task 1).
- Produces: `listPayers()`, `getPayerById(id)` from `@/lib/queries/payers` — consumed by Tasks 3, 4, 5, 6.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/queries/payers.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { listPayers, getPayerById } from '@/lib/queries/payers'

describe('payer directory queries', () => {
  it('lists the seeded payers, including at least Aetna and Medicare', async () => {
    const all = await listPayers()
    expect(all.length).toBeGreaterThanOrEqual(14)
    expect(all.some((p) => p.name === 'Aetna')).toBe(true)
    expect(all.some((p) => p.payerType === 'medicare')).toBe(true)
  })

  it('gets a single payer by id', async () => {
    const all = await listPayers()
    const first = all[0]
    const byId = await getPayerById(first.id)
    expect(byId?.name).toBe(first.name)
  })

  it('returns null for a nonexistent payer id', async () => {
    const byId = await getPayerById(999999)
    expect(byId).toBeNull()
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/payers.test.ts`
Expected: FAIL — `@/lib/queries/payers` doesn't exist yet. (This also depends on Task 1's seeded data actually being present — if Task 1 hasn't run its migration yet in this environment, this test's first assertion will fail for that reason too; that's expected, not a bug in this task.)

- [ ] **Step 3: Implement `src/lib/queries/payers.ts`**

```ts
import { getDb } from '@/db/client'
import { payers } from '@/db/schema'
import { asc, eq } from 'drizzle-orm'

export type Payer = typeof payers.$inferSelect

export async function listPayers(): Promise<Payer[]> {
  return getDb().select().from(payers).orderBy(asc(payers.payerType), asc(payers.name))
}

export async function getPayerById(id: number): Promise<Payer | null> {
  const [row] = await getDb().select().from(payers).where(eq(payers.id, id))
  return row ?? null
}
```

- [ ] **Step 4: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/payers.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 5: Implement the read-only list route**

Create `src/app/api/payers/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { listPayers } from '@/lib/queries/payers'

export async function GET() {
  const session = await requireSession()
  if (session instanceof NextResponse) return session

  const payers = await listPayers()
  return NextResponse.json(payers)
}
```

No role restriction beyond a valid session — this is read-only reference data every role already implicitly needs (any UI showing a payer dropdown, regardless of whether that role can write insurance data).

- [ ] **Step 6: Commit**

```bash
git add src/lib/queries/payers.ts src/app/api/payers/route.ts tests/lib/queries/payers.test.ts
git commit -m "feat: add payer directory queries and read-only list route"
```

---

### Task 3: Patient insurance fields on Add Client

**Files:**
- Modify: `src/app/api/patients/route.ts` (`addClientSchema`, the `patients` insert)
- Modify: `src/components/AddClientModal.tsx`
- Test: `tests/api/patients-insurance.test.ts` (new), extend `tests/api/patients.test.ts` if it already covers `POST /api/patients` (check first — read the file; add to it rather than duplicating its setup if it exists)

**Interfaces:**
- Consumes: `listPayers()` from `@/lib/queries/payers` (Task 2); `payers`, `patients` from `@/db/schema` (Task 1).
- Produces: nothing new for later tasks — this task's insurance fields are read by Task 5's display, but Task 5 reads them directly off `patients` via the existing `getPatientDetail()`, not through a new function this task exports.

- [ ] **Step 1: Write the failing test**

Create `tests/api/patients-insurance.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { POST as createRoute } from '@/app/api/patients/route'
import { getDb } from '@/db/client'
import { patients, payers } from '@/db/schema'

vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: 'frontdesk', name: 'Taylor Nguyen' })) }))
vi.mock('@/connectors/tebra.mock', () => ({
  createPatient: vi.fn(async (input: { firstName: string; lastName: string; birthDate: string; city: string; zip: string; email: string; generalPractitioner: string }) => ({
    tebraPatientId: 'tebra-test-001', ...input,
  })),
}))

const createdPatientIds: string[] = []
afterEach(async () => {
  while (createdPatientIds.length > 0) await getDb().delete(patients).where(eq(patients.id, createdPatientIds.pop()!))
})

function req(body: unknown) {
  return new Request('http://localhost', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
}

describe('POST /api/patients — insurance fields', () => {
  it('creates a patient with primary insurance fields set', async () => {
    const [payer] = await getDb().select().from(payers).limit(1)
    const res = await createRoute(req({
      name: 'Insurance Test Patient', dob: '1990-01-01',
      primaryPayerId: payer.id, primaryMemberId: 'M100', primaryGroupNumber: 'G200',
      primaryPlanType: 'ppo', primarySubscriberName: 'Insurance Test Patient', primarySubscriberRelationship: 'self',
    }) as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    createdPatientIds.push(body.id)
    expect(body.primaryPayerId).toBe(payer.id)
    expect(body.primaryMemberId).toBe('M100')
  })

  it('creates a patient with no insurance fields at all (self-pay, still valid)', async () => {
    const res = await createRoute(req({ name: 'No Insurance Patient', dob: '1990-01-01' }) as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    createdPatientIds.push(body.id)
    expect(body.primaryPayerId).toBeNull()
  })

  it('rejects a primaryPayerId that does not exist in the payers table', async () => {
    const res = await createRoute(req({ name: 'Bad Payer Patient', dob: '1990-01-01', primaryPayerId: 999999 }) as never)
    expect(res.status).toBe(400)
  })

  it('two patients created with different insurance stay independent', async () => {
    const allPayers = await getDb().select().from(payers).limit(2)
    const [payerA, payerB] = allPayers
    const resA = await createRoute(req({ name: 'Patient A', dob: '1990-01-01', primaryPayerId: payerA.id, primaryMemberId: 'MEMBER-A' }) as never)
    const bodyA = await resA.json()
    createdPatientIds.push(bodyA.id)
    const resB = await createRoute(req({ name: 'Patient B', dob: '1991-01-01', primaryPayerId: payerB.id, primaryMemberId: 'MEMBER-B' }) as never)
    const bodyB = await resB.json()
    createdPatientIds.push(bodyB.id)

    expect(bodyA.primaryPayerId).toBe(payerA.id)
    expect(bodyA.primaryMemberId).toBe('MEMBER-A')
    expect(bodyB.primaryPayerId).toBe(payerB.id)
    expect(bodyB.primaryMemberId).toBe('MEMBER-B')
    // Re-read both from the DB directly -- proves this isn't just the
    // create response echoing back the request, but two genuinely
    // independent rows.
    const [rowA] = await getDb().select().from(patients).where(eq(patients.id, bodyA.id))
    const [rowB] = await getDb().select().from(patients).where(eq(patients.id, bodyB.id))
    expect(rowA.primaryMemberId).toBe('MEMBER-A')
    expect(rowB.primaryMemberId).toBe('MEMBER-B')
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/patients-insurance.test.ts`
Expected: FAIL — the route doesn't accept these fields yet (either a Zod `.strict()` rejection for unknown keys, or the fields are silently dropped and the third test's 400 never happens).

- [ ] **Step 3: Extend `addClientSchema` and the insert in `src/app/api/patients/route.ts`**

Add to `addClientSchema` (all optional, matching every other optional field already in this schema):

```ts
  primaryPayerId: z.number().int().optional(),
  primaryMemberId: z.string().optional(),
  primaryGroupNumber: z.string().optional(),
  primaryPlanType: z.enum(['ppo', 'hmo', 'epo', 'pos', 'medicare', 'medicaid']).optional(),
  primarySubscriberName: z.string().optional(),
  primarySubscriberRelationship: z.enum(['self', 'spouse', 'child', 'other']).optional(),
```

Before the `db.insert(patients)` call, validate `primaryPayerId` if present:

```ts
  if (parsed.data.primaryPayerId !== undefined) {
    const payer = await getPayerById(parsed.data.primaryPayerId)
    if (!payer) return NextResponse.json({ error: 'primaryPayerId does not reference a real payer' }, { status: 400 })
  }
```

(Import `getPayerById` from `@/lib/queries/payers`.) Add the six fields to the `.values({...})` object passed to `db.insert(patients)`, each as `parsed.data.<field> ?? null`.

- [ ] **Step 4: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/patients-insurance.test.ts`
Expected: PASS (all 3 tests). Also run the pre-existing `tests/api/patients.test.ts` if it exists, to confirm no regression on the base (no-insurance) create path: `npx dotenv -e .env.local -- npx vitest run tests/api/patients.test.ts`.

- [ ] **Step 5: Add the Insurance section to `AddClientModal`**

Extend `NewPatientForm` and `EMPTY_FORM` in `src/components/AddClientModal.tsx` with the six insurance fields (all string-typed in local form state, same as every other field in this form; `primaryPayerId` held as a string select value, parsed to a number only in `submit()`). Fetch the payer list once on mount (`useEffect` + `fetch('/api/payers')`, matching the fetch-on-mount pattern already used elsewhere in this codebase's client components — check `MedicationAdministrationPanel.tsx` from the previous plan for the exact shape if useful as a reference). Add a new form section after the existing "Care details" section:

```tsx
<p className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Insurance (optional)</p>
<select value={form.primaryPayerId} onChange={(e) => update('primaryPayerId', e.target.value)} className="w-full rounded-md border border-border px-3 py-2 text-sm">
  <option value="">No insurance on file</option>
  {payerOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
</select>
{form.primaryPayerId && (
  <>
    <div className="grid grid-cols-2 gap-3">
      <input value={form.primaryMemberId} onChange={(e) => update('primaryMemberId', e.target.value)} placeholder="Member ID" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
      <input value={form.primaryGroupNumber} onChange={(e) => update('primaryGroupNumber', e.target.value)} placeholder="Group number" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
    </div>
    <select value={form.primaryPlanType} onChange={(e) => update('primaryPlanType', e.target.value)} className="w-full rounded-md border border-border px-3 py-2 text-sm">
      <option value="">Plan type</option>
      <option value="ppo">PPO</option><option value="hmo">HMO</option><option value="epo">EPO</option><option value="pos">POS</option><option value="medicare">Medicare</option><option value="medicaid">Medicaid</option>
    </select>
  </>
)}
```

Subscriber name/relationship fields follow the same conditional-on-payer-selected pattern; default `primarySubscriberRelationship` to `'self'` and `primarySubscriberName` to the patient's own name (from `form.name`) when the payer is first selected, editable after. In `submit()`, include the parsed insurance fields in the request body only when `form.primaryPayerId` is set (send `undefined` otherwise, matching how `email`/`phone`/etc. already use `|| undefined`).

- [ ] **Step 6: Verify via a real running dev server, not narration**

Start the dev server if not already running (`npm run dev`). Using real `node -e "fetch(...)"` calls (not jsdom/RTL — see this plan's Global Constraints note on UI verification discipline), log in as a frontdesk demo account, POST to `/api/patients` with insurance fields set, confirm 201 and the fields round-trip in the response. Paste the actual commands and their actual output in your report.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/patients/route.ts src/components/AddClientModal.tsx tests/api/patients-insurance.test.ts
git commit -m "feat: capture patient insurance fields on Add Client"
```

---

### Task 4: Insurance card image upload via Vercel Blob

**Files:**
- Modify: `package.json` (add `@vercel/blob` dependency)
- Create: `src/app/api/patients/[anonId]/insurance-card/route.ts`
- Test: `tests/api/patients-insurance-card.test.ts`

**Interfaces:**
- Consumes: `patients` from `@/db/schema` (existing).
- Produces: nothing new for later tasks — Task 5's UI calls this route directly by URL, not through an imported function.

- [ ] **Step 1: Add the dependency**

```bash
npm install @vercel/blob
```

`BLOB_READ_WRITE_TOKEN` is already provisioned in this project's environment (confirmed present in Vercel's Production/Preview/Development env vars this session) — no new env var setup needed.

- [ ] **Step 2: Write the failing test**

Create `tests/api/patients-insurance-card.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { POST as uploadRoute } from '@/app/api/patients/[anonId]/insurance-card/route'
import { getDb } from '@/db/client'
import { patients } from '@/db/schema'

let sessionRole: 'admin' | 'pi' | 'crc' | 'frontdesk' = 'frontdesk'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Taylor Nguyen' })) }))
vi.mock('@vercel/blob', () => ({ put: vi.fn(async (path: string) => ({ url: `https://blob.test/${path}` })) }))

afterEach(async () => {
  sessionRole = 'frontdesk'
  const [patientRow] = await getDb().select().from(patients).limit(1)
  await getDb().update(patients).set({ primaryCardFrontUrl: null, primaryCardBackUrl: null }).where(eq(patients.id, patientRow.id))
})

function formDataReq(side: string, file: File) {
  const fd = new FormData()
  fd.set('side', side)
  fd.set('file', file)
  return new Request('http://localhost', { method: 'POST', body: fd })
}

describe('POST /api/patients/[anonId]/insurance-card', () => {
  it('uploads a front-side card image and stores the URL on the patient', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const file = new File([new Uint8Array([1, 2, 3])], 'card.jpg', { type: 'image/jpeg' })
    const res = await uploadRoute(formDataReq('front', file) as never, { params: Promise.resolve({ anonId: patientRow.id }) })
    expect(res.status).toBe(200)
    const [updated] = await getDb().select().from(patients).where(eq(patients.id, patientRow.id))
    expect(updated.primaryCardFrontUrl).toContain('https://blob.test/')
  })

  it('rejects a non-image content type', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const file = new File([new Uint8Array([1, 2, 3])], 'card.pdf', { type: 'application/pdf' })
    const res = await uploadRoute(formDataReq('front', file) as never, { params: Promise.resolve({ anonId: patientRow.id }) })
    expect(res.status).toBe(400)
  })

  it('rejects a session role that cannot write insurance data', async () => {
    sessionRole = 'pi'
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const file = new File([new Uint8Array([1, 2, 3])], 'card.jpg', { type: 'image/jpeg' })
    const res = await uploadRoute(formDataReq('front', file) as never, { params: Promise.resolve({ anonId: patientRow.id }) })
    expect(res.status).toBe(403)
  })
})
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/patients-insurance-card.test.ts`
Expected: FAIL — the route file doesn't exist yet.

- [ ] **Step 4: Implement the route**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { put } from '@vercel/blob'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getDb } from '@/db/client'
import { patients } from '@/db/schema'
import { eq } from 'drizzle-orm'

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const MAX_BYTES = 8 * 1024 * 1024

export async function POST(request: NextRequest, { params }: { params: Promise<{ anonId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['admin', 'crc', 'frontdesk'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { anonId } = await params
  const formData = await request.formData()
  const side = formData.get('side')
  const file = formData.get('file')
  if (side !== 'front' && side !== 'back') return NextResponse.json({ error: 'side must be "front" or "back"' }, { status: 400 })
  if (!(file instanceof File)) return NextResponse.json({ error: 'file is required' }, { status: 400 })
  if (!ALLOWED_TYPES.includes(file.type)) return NextResponse.json({ error: 'File must be a JPEG, PNG, or WebP image' }, { status: 400 })
  if (file.size > MAX_BYTES) return NextResponse.json({ error: 'File must be under 8MB' }, { status: 400 })

  const blob = await put(`insurance-cards/${anonId}-primary-${side}-${Date.now()}`, file, { access: 'public' })

  const column = side === 'front' ? { primaryCardFrontUrl: blob.url } : { primaryCardBackUrl: blob.url }
  await getDb().update(patients).set(column).where(eq(patients.id, anonId))

  await logAudit(session, `uploaded insurance card (${side})`, anonId)
  return NextResponse.json({ url: blob.url })
}
```

- [ ] **Step 5: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/patients-insurance-card.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json "src/app/api/patients/[anonId]/insurance-card/route.ts" tests/api/patients-insurance-card.test.ts
git commit -m "feat: add insurance card image upload via Vercel Blob"
```

---

### Task 5: Insurance section on the Medical Record page

**Files:**
- Modify: `src/app/(dashboard)/patients/[anonId]/medical-record/page.tsx`
- Create: `src/components/InsuranceCardUpload.tsx`
- Test: none new — this is UI wiring over already-tested routes (Tasks 3's data, Task 4's upload route). Verify per this plan's Global Constraints UI-verification-discipline note: real dev server, real HTTP, real output pasted in the report.

**Interfaces:**
- Consumes: `patients` fields from `getPatientDetail()` (existing — already returns the full patient row, which now includes the Task 1 insurance columns with zero changes needed to that function); `listPayers()` (Task 2, for resolving `primaryPayerId` to a display name — or simpler, join in a dedicated query, see Step 2).

- [ ] **Step 1: Check what `getPatientDetail()` actually returns for the new columns**

Read `src/lib/queries/patients.ts`'s `getPatientDetail()` (the function Task 2 of the encounter-notes-and-mar plan didn't touch, so it's in whatever state Task 1 of *this* plan's schema change left it — since it does `select().from(patients)` as a plain select, the new insurance columns come through automatically with zero code change needed there). Confirm this by reading the function body before writing any new query code — if it already spreads the full patient row, no new query function is needed for this task at all, only a payer-name lookup for display.

- [ ] **Step 2: Add a payer-name resolver**

If `getPatientDetail()`'s return type doesn't already give you a payer's display name (it won't — it only has `primaryPayerId`, a foreign key), add a small helper to `src/lib/queries/payers.ts`:

```ts
export async function getPayerName(payerId: number | null): Promise<string | null> {
  if (payerId === null) return null
  const payer = await getPayerById(payerId)
  return payer?.name ?? null
}
```

- [ ] **Step 3: Add the Insurance section to the Medical Record page**

In `src/app/(dashboard)/patients/[anonId]/medical-record/page.tsx`, after fetching `patient` (and the existing `notes` fetch from the prior plan), resolve the primary/secondary payer names via `getPayerName()`. Add a new `<section className={SECTION}>` titled "Insurance" (following this file's existing `SECTION`/`SECTION_HEADING` pattern, same as the Notes section from the prior plan): if `patient.primaryPayerId` is set, show payer name, member id, group number, plan type, subscriber name/relationship, and the two card images (`<img>` tags, click-to-open in a new tab via a plain anchor — no lightbox component exists in this codebase yet, don't invent one) if present; render `<InsuranceCardUpload anonId={anonId} side="front" hasImage={!!patient.primaryCardFrontUrl} canWrite={...} />` (and the `back` variant) next to each card slot. If no insurance is on file, show an empty state ("No insurance on file") with no upload controls (nothing to attach a card to without a payer selected — matches spec §6). Repeat the same block for secondary insurance only if `patient.secondaryPayerId` is set (no empty state for secondary — it's genuinely optional, unlike primary).

`canWrite` (for showing the upload control) is `['admin','crc','frontdesk'].includes(session.role)` — thread `session.role` down the same way the prior plan's `NoteForm`/`InpatientHistoryPanel` already do (this page already calls `requireSessionOrRedirect()` and has `session` in scope).

- [ ] **Step 4: Build `InsuranceCardUpload`**

Create `src/components/InsuranceCardUpload.tsx` as a `'use client'` component: a file input (accepting `image/jpeg,image/png,image/webp`) that, on file selection, builds a `FormData` with `side` and `file`, `fetch`s `POST /api/patients/${anonId}/insurance-card`, and calls `router.refresh()` on success (same fetch → refresh pattern as every other write-triggering client component in this codebase). Shows "Uploaded" text (not a new "Uploaded" pill component — plain text is fine, this isn't a status domain needing `StatusChip`-style treatment) when `hasImage` is true, a plain "Upload" label otherwise. Returns `null` entirely when `canWrite` is false (matches `NoteForm`'s pattern of not rendering any write affordance for a role that can't use it).

- [ ] **Step 5: Verify via a real running dev server, not narration**

Same discipline as Task 3 Step 6: real dev server, real HTTP calls (a real login, a real GET of the medical-record page confirming the Insurance section text appears, a real multipart POST to the upload route with a tiny real image buffer, confirming the response and that a second GET of the page shows the uploaded state). Paste actual commands and actual output.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(dashboard)/patients/[anonId]/medical-record/page.tsx" src/components/InsuranceCardUpload.tsx src/lib/queries/payers.ts
git commit -m "feat: add Insurance section with card upload to Medical Record page"
```

---

### Task 6: Eligibility check — payer directory + richer response

**Files:**
- Modify: `src/app/api/front-desk/eligibility-check/route.ts`
- Modify: `src/lib/queries/insurance-eligibility.ts`
- Modify: `src/components/EligibilityCheckModal.tsx` (currently has a free-text `payerName` input at line ~10/37 — read the full file before editing)
- Test: extend `tests/api/front-desk-eligibility-check.test.ts` (already exists — read it fully before adding to it, don't duplicate its setup) and `tests/lib/queries/insurance-eligibility.test.ts` (already exists, covers `simulateEligibilityCheck`/`recordEligibilityCheck` — extend for the new fields). Note: `tests/lib/eligibility.test.ts` is a different, unrelated file (the trial-screening rule engine in `src/lib/eligibility.ts`) — do not touch it, it only shares a similar name.

**Interfaces:**
- Consumes: `getPayerById` (Task 2).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Read both existing test files fully before changing anything**

Read `tests/api/front-desk-eligibility-check.test.ts` and `tests/lib/queries/insurance-eligibility.test.ts` in full — both already exist and cover the current `payerName`-based behavior. Your changes in this task will break their existing assertions (they test the old `payerName` request shape); update those existing tests' payloads/assertions to the new `payerId` shape as part of this task, rather than leaving them red.

- [ ] **Step 2: Write the failing test**

Whichever file you're working in, add/confirm these cases exist:

```ts
it('accepts a payerId instead of free-text payerName and returns a richer eligibility response', async () => {
  const [payer] = await getDb().select().from(payers).limit(1)
  const [patientRow] = await getDb().select().from(patients).limit(1)
  const res = await eligibilityRoute(new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: patientRow.id, payerId: payer.id }) }) as never)
  expect(res.status).toBe(201)
  const body = await res.json()
  expect(body.payerId).toBe(payer.id)
  expect('deductibleRemainingCents' in body).toBe(true)
})

it('rejects a payerId that does not exist', async () => {
  const [patientRow] = await getDb().select().from(patients).limit(1)
  const res = await eligibilityRoute(new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: patientRow.id, payerId: 999999 }) }) as never)
  expect(res.status).toBe(400)
})
```

- [ ] **Step 3: Run it to confirm it fails**

Run the file's own vitest command. Expected: FAIL — the route still expects `payerName`, not `payerId`.

- [ ] **Step 4: Update `simulateEligibilityCheck`/`recordEligibilityCheck` in `src/lib/queries/insurance-eligibility.ts`**

Widen `simulateEligibilityCheck` to also derive `deductibleRemainingCents` (same hash-based deterministic technique, e.g. `(hash[2] % 20) * 100` for a plausible $0-$1900 range) and accept a `planType` to echo back (pass through whatever the patient's own `primaryPlanType` is, or `null` if not on file — the route resolves this, not the query function). Widen `RecordEligibilityCheckInput`/the insert to accept and store `payerId`, `deductibleRemainingCents`, `planType`, `coverageStartDate` (the last one can be a simulated near-future/past date derived the same deterministic way, or `null` — keep it simple, this field's exact simulated value doesn't need to be clever).

- [ ] **Step 5: Update the route**

Change `eligibilitySchema` from `payerName: z.string().min(1)` to `payerId: z.number().int()`. Look up the payer via `getPayerById` (400 if not found), pass `payer.name` through to `simulateEligibilityCheck` (it still needs a name for its hash input — nothing about the simulation logic itself needs to change, only its argument source), and pass the patient's `primaryPlanType` (fetched via a patient lookup, or accept it's `null` if the route doesn't already have the patient row in scope — don't add a new patient fetch just for this if it's not already there, `null` is a valid plan type here) through to the richer insert.

- [ ] **Step 6: Run the test again to confirm it passes**

Expected: PASS.

- [ ] **Step 7: Update the front-desk UI's payer input from free text to the payer dropdown**

In whichever component calls this route (found in Step 1), replace the free-text payer input with a `<select>` populated from `GET /api/payers` (same fetch-on-mount pattern as Task 3's `AddClientModal`), defaulting to the patient's own `primaryPayerId` if set. Display the new `deductibleRemainingCents`/`planType` fields in the result, not just copay.

- [ ] **Step 8: Verify via a real running dev server, not narration**

Same discipline as prior UI tasks.

- [ ] **Step 9: Run the full suite once**

Run: `npx dotenv -e .env.local -- npx vitest run`
Expected: all pass (regression check across everything this plan touched).

- [ ] **Step 10: Commit**

```bash
git add src/app/api/front-desk/eligibility-check/route.ts src/lib/queries/insurance-eligibility.ts src/components/EligibilityCheckModal.tsx tests/api/front-desk-eligibility-check.test.ts tests/lib/queries/insurance-eligibility.test.ts
git commit -m "feat: wire eligibility check to the payer directory with a richer response"
```

- [ ] **Step 11: Push**

```bash
git push
```
