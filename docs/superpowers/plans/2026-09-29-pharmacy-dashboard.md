# Pharmacy Staff Role & Patient-First Dispensing Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `pharmacy` as a fifth role in `roleEnum`/`Role`, give it a patient-first dispensing screen at `/pharmacy/patient-lookup`, and let a dispense be turned into a real `draft` charge — extending, never redesigning, the catalog/inventory/dispense feature built by `2026-09-28-pharmacy-medication-inventory.md`.

**Architecture:** Every role check in this app is an allowlist (`['admin','pi'].includes(session.role)`), with no denylist and no `!== 'x'` gate anywhere, so appending `pharmacy` to the enum is **denied by default** at every existing gate. That property is what lets this plan name the three gates it opens and close the two routes (`POST /api/charges`, `PATCH /api/charges/[id]`) that have no gate at all and would otherwise become reachable. The dispense→bill link is a nullable, `.unique()` `medicationDispenses.chargeId` column — not a pharmacy-specific FK on the general `charges` table — so double-billing one dispense is a database-level impossibility while the many never-billed dispenses keep a `NULL` (Postgres does not treat NULLs as equal). `dispenseMedication()`, its conditional-UPDATE race safety and its transaction are reused verbatim; the only change to that path is one role added to its allowlist and a caller that finally sets the long-dormant `medicationEpisodeId`.

**Tech Stack:** Next.js 16 App Router (Server Components) + Drizzle ORM over a `pg` Pool (additive-only schema changes via a hand-written one-off script, never `drizzle-kit push`) + Zod `.strict()` validation + `@base-ui/react` Dialog primitive + Tailwind v4 oklch tokens + vitest.

**Spec:** `docs/superpowers/specs/2026-09-29-pharmacy-dashboard.md`

**Working directory note:** this plan is executed in an isolated git worktree at `/Users/k2a/Desktop/clinsync/.worktrees/pharmacy-dashboard` on branch `feature/pharmacy-dashboard`, forked from `hims-platform`. This worktree has its own `.env.local` and `node_modules` already set up. Every implementer/reviewer dispatch for this plan must work from this exact directory, not the main checkout — the main checkout and every other active worktree (`.worktrees/unified-patient-record`, `.worktrees/esignatures`, `.worktrees/care-plans`, and ~14 others) have their own concurrent work in flight; do not touch them.

## Global Constraints

- **`patients` still has the SPLIT identity columns in this worktree.** The spec's dependency (single-sourcing `patients.name`/`patients.dob`) has **not** landed here — `src/db/schema.ts:54-57` still declares `nameIntakeq`/`nameTebra`/`dobIntakeq`/`dobTebra`. Apply the spec's own stated fallback everywhere it says `patient.name`/`patient.dob`: coalesce as `nameTebra ?? nameIntakeq` and `dobTebra ?? dobIntakeq`, matching `src/lib/queries/charges.ts:37,51-52`. Do **not** attempt the column collapse — another worktree owns it.
- Additive-only schema changes. Apply via a hand-written one-off script run with `npx dotenv -e .env.local -- npx tsx <script>` — never `drizzle-kit push`. This is a **single shared Neon Postgres database across every branch/worktree** — a schema mistake here is visible everywhere immediately, including the main checkout and every other active worktree (README.md:131-148).
- `psql` is not installed in this environment — verify a migration's live-DB effect with a Node script using `pg`'s `Pool` and an `information_schema.columns` query.
- **A new `roleEnum` value is appended last, never reordered** — a Postgres enum's stored values are ordinal and existing `users.role`/`auditLog.role`/`encounterNotes.authorRole` rows must keep meaning what they mean. `ALTER TYPE "role" ADD VALUE` must be its own statement: Postgres will not let a newly-added enum value be *used* in the same transaction that adds it.
- Every write route uses `.strict()` Zod validation.
- Every state-changing route calls `logAudit(session, <action>, <patientId or null>)` (`src/lib/audit.ts:13`).
- Every protected route starts with `requireSession()` (API) or `requireSessionOrRedirect()` (pages) as its first statement. A page-level role gate is `if (!['a','b'].includes(session.role)) redirect('/')`, matching `(dashboard)/labs/page.tsx:11` and `(dashboard)/booking-requests/page.tsx:10`.
- Server Components call the query layer directly, never `fetch()` their own API routes.
- Role gating per spec §8: dispense = admin, pi, **pharmacy**; patient lookup + bill logging = **pharmacy**, admin; catalog add = admin, **pharmacy**; `POST /api/charges` + `PATCH /api/charges/[id]` = admin, crc, frontdesk (and **no longer pi**). Everything else unchanged and denied by default.
- `charges.diagnosisCodes` stays `.min(1)`. A pharmacy-logged bill picks from the patient's existing `diagnoses` rows or is not creatable at all — never a placeholder code.
- Commit messages end with no attribution trailer.
- UI verification discipline: verify via a real running dev server hit with real HTTP requests (mint a staff session cookie the way `src/lib/auth.ts:37-43` actually does it — `SignJWT` with `kind: 'staff'` under cookie `clinsync_demo_session`, secret from `SESSION_SECRET`), with actual commands and actual output pasted in the report. Never a narrated, unreproduced claim — this codebase's own session history includes a prior implementer fabricating UI verification evidence and being caught; do not repeat that.
- Vitest invocation: `npx dotenv -e .env.local -- npx vitest run <path>` (`fileParallelism: false`, `testTimeout: 15000`).

## Review Focus

1. **A `pharmacy`-role JWT that authenticates and is then silently rejected on every request** — `VALID_ROLES` (`auth.ts:9`) is module-private and easy to miss when widening the `Role` type; `parseSessionCookie` checks membership before trusting the JWT's `role` claim, and the comment at `auth.ts:48-51` records that an unvalidated role once crashed every audited request with a Postgres enum violation. (Task 1)
2. **A `pharmacy` session reaching `POST /api/charges` or `PATCH /api/charges/[id]`** — both have `requireSession()` and **no role gate at all** today, so pharmacy would gain arbitrary-charge creation and the billing team's approval authority the moment the role exists. Pharmacy's whole bill-logging design depends on this being closed. (Task 2)
3. **Billing the same dispense twice** — two calls (or two concurrent calls) to the charge route for one `dispenseId` must produce exactly one `charges` row; the route's 409 is for a clean message, the `.unique()` column is what actually enforces it. (Task 5)
4. **A `diagnosisId` belonging to a different patient than the dispense's own patient** — the same cross-entity-forgery class already found and fixed for `medicationEpisodeId` in `dispenseMedication` and for `admissionId` in `POST /api/patients/[anonId]/notes`; must be a clean 400 that creates nothing. (Task 5)
5. **The patient-lookup payload leaking the rest of the chart** — `getPatientPharmacyView` must not return screening criteria, evidence quotes, identity-verification records, discrepancies or `portalPasswordHash`; asserted as an exact-key-set check on the response body, not merely "the fields I wanted are present." (Task 4)

---

### Task 1: Schema + role plumbing — `pharmacy` in `roleEnum`/`Role`, `medicationDispenses.chargeId`

**Files:**
- Modify: `src/db/schema.ts:4` (`roleEnum`), `src/db/schema.ts:651-660` (`medicationDispenses`)
- Modify: `src/lib/auth.ts:6,9` (`Role`, `VALID_ROLES`)
- Modify: `src/lib/role-capabilities.ts` (new `pharmacy` entry; one new `admin` bullet)
- Modify: `src/lib/queries/encounter-notes.ts:13` (`authorRole` union)
- Modify: `src/components/settings/StaffManagementPanel.tsx:10` (`StaffRow.role` union) and its `ROLE_LABEL` at :14
- Modify: `src/app/(dashboard)/page.tsx:44` (`staffByRole` list)
- Modify: `src/db/seed.ts:911-920` (one demo pharmacy user)
- Modify: `tests/lib/role-capabilities.test.ts` (asserts "exactly the four real roles" today — will fail until widened)
- Modify: `tests/lib/auth.test.ts` (add the `VALID_ROLES` trap test)
- Test: `tests/db/pharmacy-dashboard-schema.test.ts`

**Interfaces:**
- Produces: `Role` widened to `'crc' | 'pi' | 'admin' | 'frontdesk' | 'pharmacy'`; `roleEnum` with a fifth value; `medicationDispenses.chargeId: number | null` (nullable, unique, FK → `charges.id`). Consumed by every later task.

- [ ] **Step 1: Write the failing tests**

Create `tests/db/pharmacy-dashboard-schema.test.ts`. It needs a real patient, a throwaway medication, a throwaway charge, and dispense rows; clean up children-before-parents in `afterEach` (`medicationDispenses` → `charges` → `medicationInventory` → `medications` → `users`), following `tests/api/pharmacy-dispense.test.ts:12-20`'s pop-loop convention.

```ts
describe('pharmacy dashboard schema', () => {
  it('defaults medicationDispenses.chargeId to null', async () => {
    // insert a dispense with no chargeId
    expect(dispense.chargeId).toBeNull()
  })

  it('links a dispense to a charge and rejects a second dispense claiming the same charge', async () => {
    // update dispense A: chargeId = charge.id  -> succeeds
    // update dispense B: chargeId = charge.id  -> rejects (unique)
    await expect(/* second update */).rejects.toThrow()
  })

  it('allows many dispenses to share a null chargeId', async () => {
    // two dispenses, both chargeId null, both insert fine -- NULLs are not equal in Postgres
  })

  it('accepts pharmacy as a users.role value', async () => {
    const [user] = await getDb().insert(users).values({ name: 'Schema Test Pharmacist', email: `pharm.${Date.now()}@example.com`, role: 'pharmacy' }).returning()
    expect(user.role).toBe('pharmacy')
  })
})
```

In `tests/lib/auth.test.ts`, add to the existing `describe('auth session cookie')` block — this is Review Focus #1:

```ts
it('parses a validly-signed token carrying the pharmacy role', async () => {
  const value = await buildSessionCookieValue('pharmacy', 'Robin Shah')
  expect(await parseSessionCookie(value)).toEqual({ role: 'pharmacy', name: 'Robin Shah' })
})
```

In `tests/lib/role-capabilities.test.ts`, change the existing `'has an entry for exactly the four real roles, no more, no less'` test to five and add `'pharmacy'` to its expected set. Rename it to `'...exactly the five real roles...'`.

- [ ] **Step 2: Run them to confirm they fail**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/pharmacy-dashboard-schema.test.ts tests/lib/auth.test.ts tests/lib/role-capabilities.test.ts`
Expected: FAIL — `chargeId` isn't on the schema type, `'pharmacy'` isn't assignable to `Role`, `ROLE_CAPABILITIES` has four keys.

- [ ] **Step 3: Widen the schema**

In `src/db/schema.ts`, line 4 becomes:

```ts
export const roleEnum = pgEnum('role', ['crc', 'pi', 'admin', 'frontdesk', 'pharmacy'])
```

Append to the `medicationDispenses` definition (after `notes`), with a comment recording why the link lives here:

```ts
  // The dispense->bill link lives on this table, not as a
  // medicationDispenseId column on `charges`: charges is the general billing
  // table every service line shares, and "is this dispense billed yet" is a
  // property of the dispense. The .unique() is the real work -- it makes
  // double-billing one dispense a database-level impossibility rather than a
  // check the route has to remember, while still permitting unlimited NULLs
  // (Postgres does not treat NULLs as equal) for the many dispenses that are
  // samples or in-office doses and are never billed.
  chargeId: integer('charge_id').references(() => charges.id).unique(),
```

(`charges` is defined at schema.ts:202, already in scope.)

- [ ] **Step 4: Widen `Role` and `VALID_ROLES`**

`src/lib/auth.ts` lines 6 and 9:

```ts
export type Role = 'crc' | 'pi' | 'admin' | 'frontdesk' | 'pharmacy'
const VALID_ROLES: readonly Role[] = ['crc', 'pi', 'admin', 'frontdesk', 'pharmacy']
```

Then run `npx tsc --noEmit` and fix every error it reports. The three known hand-written copies of the four-role union are `src/lib/queries/encounter-notes.ts:13`, `src/components/settings/StaffManagementPanel.tsx:10`, and `src/lib/role-capabilities.ts` (a `Record<Role, ...>`, so TypeScript *forces* the new entry — that is the desired failure mode; do not loosen the type to silence it). Also widen `StaffManagementPanel.tsx:14`'s `ROLE_LABEL` with `pharmacy: 'Pharmacy'`, and `src/app/(dashboard)/page.tsx:44`'s `staffByRole` array to `['admin', 'pi', 'crc', 'frontdesk', 'pharmacy']` (a plain string array, so `tsc` will *not* catch this one).

- [ ] **Step 5: Add the `ROLE_CAPABILITIES` entry**

In `src/lib/role-capabilities.ts`, add after `frontdesk`. Use this exact copy (spec §3.6 — sourced only from behavior this plan actually enforces):

```ts
  pharmacy: {
    label: 'Pharmacy',
    summary: 'Works the dispensing counter: looks a patient up by ID, reads what their doctor prescribed, dispenses from practice stock, and logs the bill — never prescribes, never edits a prescription, and never approves a charge.',
    bullets: [
      'Look up any patient by their patient ID to see their prescribed medications',
      'View a patient\'s active medication episodes as the prescriber entered them (read-only)',
      'Dispense a medication from practice stock against a specific prescription',
      'Log a bill for a dispense as a draft charge for the billing team to review',
      'View the medication catalog, stock levels, and what the practice is currently prescribing',
      'Add a medication to the practice catalog',
    ],
  },
```

Add one bullet to `admin`'s existing list (it already carries "Dispense medications from the Pharmacy dashboard", which stays): `'Look up a patient at the pharmacy counter, dispense, and log a dispense bill.'`

- [ ] **Step 6: Add the demo pharmacy user to the seed**

In `src/db/seed.ts`, add to the `users` insert array at :911-920, matching the existing rows' exact shape:

```ts
    { name: 'Robin Shah', email: 'rshah.demo@example.com', role: 'pharmacy', passwordHash: hashPassword('PharmacyDemo123!') },
```

- [ ] **Step 7: Write and run the one-off migration script**

Scratch, not part of the repo. Create `migrate-pharmacy-dashboard-scratch.ts` at this worktree's root. Each statement runs on its own `pool.query()` — `ALTER TYPE ... ADD VALUE` must not share a transaction with anything that uses the new value:

```ts
import { Pool } from 'pg'

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false } })

  await pool.query(`ALTER TYPE "role" ADD VALUE IF NOT EXISTS 'pharmacy'`)
  await pool.query(`ALTER TABLE medication_dispenses ADD COLUMN IF NOT EXISTS charge_id INTEGER REFERENCES charges(id)`)
  // Drizzle's .unique() on the column expects this exact constraint name.
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS medication_dispenses_charge_id_unique ON medication_dispenses(charge_id)`)

  console.log('Pharmacy dashboard schema migration complete.')
  await pool.end()
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1) })
```

Run: `npx dotenv -e .env.local -- npx tsx migrate-pharmacy-dashboard-scratch.ts`. If blocked by the permission classifier: stop, report it, do not retry with variations.

Verify with a Node script (no `psql` here): `SELECT unnest(enum_range(NULL::role))` returns five values with `pharmacy` last, and `SELECT column_name FROM information_schema.columns WHERE table_name = 'medication_dispenses'` includes `charge_id`.

Delete the scratch script once confirmed: `rm migrate-pharmacy-dashboard-scratch.ts`.

- [ ] **Step 8: Run this task's tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/pharmacy-dashboard-schema.test.ts tests/lib/auth.test.ts tests/lib/role-capabilities.test.ts`
Expected: PASS. Then `npx tsc --noEmit` — expected: clean.

- [ ] **Step 9: Commit**

```bash
git add src/db/schema.ts src/db/seed.ts src/lib/auth.ts src/lib/role-capabilities.ts src/lib/queries/encounter-notes.ts src/components/settings/StaffManagementPanel.tsx "src/app/(dashboard)/page.tsx" tests/db/pharmacy-dashboard-schema.test.ts tests/lib/auth.test.ts tests/lib/role-capabilities.test.ts
git commit -m "$(cat <<'EOF'
feat: add pharmacy role and medicationDispenses.chargeId link column

EOF
)"
```

---

### Task 2: Role gates — close the two ungated charges routes, open dispense to pharmacy

**Files:**
- Modify: `src/app/api/charges/route.ts` (`POST` only — `GET` stays open)
- Modify: `src/app/api/charges/[id]/route.ts` (`PATCH` only — `GET` stays open)
- Modify: `src/app/api/pharmacy/dispense/route.ts:18`
- Modify: `tests/api/charges.test.ts` (its mock is a hardcoded `role: 'crc'` literal at :8 and must become the mutable-`sessionRole` pattern)
- Modify: `tests/api/pharmacy-dispense.test.ts`

**Interfaces:**
- Consumes: the widened `Role` (Task 1).
- Produces: no new exports. `POST /api/charges` and `PATCH /api/charges/[id]` restricted to `['admin','crc','frontdesk']`; `POST /api/pharmacy/dispense` widened to `['admin','pi','pharmacy']`.

- [ ] **Step 1: Convert `tests/api/charges.test.ts`'s auth mock and write the failing tests**

Replace line 8's hardcoded mock with the mutable pattern already established in `tests/api/pharmacy-dispense.test.ts:7-8`, and reset it in an `afterEach`. `crc` must stay the default or all 11 existing tests break:

```ts
let sessionRole: 'admin' | 'pi' | 'crc' | 'frontdesk' | 'pharmacy' = 'crc'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Jamie Ruiz' })) }))

afterEach(() => { sessionRole = 'crc' })
```

Add a new `describe('charges route role gating')` block — Review Focus #2:

```ts
it('rejects a pharmacy session on POST /api/charges', async () => {
  sessionRole = 'pharmacy'
  const res = await POST(/* a fully valid charge body */ as never)
  expect(res.status).toBe(403)
})

it('rejects a pi session on POST /api/charges -- incidental access the missing gate allowed', async () => {
  sessionRole = 'pi'
  // ...expect 403
})

it('rejects a pharmacy session on PATCH /api/charges/[id]', async () => {
  sessionRole = 'pharmacy'
  // ...PATCH an existing draft charge to pending_approval, expect 403, and
  // assert the charge's status in the DB is still 'draft'
})

it('rejects a pi session on PATCH /api/charges/[id]', async () => { /* ...403 */ })

it('still allows admin and frontdesk on POST /api/charges', async () => {
  // sessionRole = 'admin' -> 201; sessionRole = 'frontdesk' -> 201; push both ids to createdChargeIds
})
```

In `tests/api/pharmacy-dispense.test.ts`, widen the union at :7 to include `'pharmacy'` and add:

```ts
it('dispenses successfully as pharmacy', async () => { /* ...same shape as the pi test, expect 201 */ })
it('rejects a crc session', async () => { sessionRole = 'crc'; /* ...expect 403 */ })
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/charges.test.ts tests/api/pharmacy-dispense.test.ts`
Expected: FAIL — the four new charges gating tests get 201/200 instead of 403 (no gate exists); the pharmacy dispense test gets 403 instead of 201.

- [ ] **Step 3: Add the gates**

In `src/app/api/charges/route.ts`, in `POST` only, immediately after the `requireSession()` instanceof check (line 27) and before the Zod parse:

```ts
  // Creating a charge is billing/registration staff's authority. This gate
  // was missing entirely until the `pharmacy` role was added: without it,
  // pharmacy would have been able to create an arbitrary charge for any
  // patient with any code and amount, outside the one narrow, server-derived
  // dispense-billing path it is actually given (POST
  // /api/pharmacy/dispenses/[dispenseId]/charge). Same tier as /billing's own
  // nav visibility (LeftNav.tsx:98). This also, correctly, closes the route
  // to `pi`, which had incidental access via the missing gate.
  if (!['admin', 'crc', 'frontdesk'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
```

In `src/app/api/charges/[id]/route.ts`, in `PATCH` only, after line 23's instanceof check, the same allowlist with a comment naming the reason: advancing `draft → pending_approval → approved → submitted` is the billing team's approval authority, and pharmacy records that a billable thing happened without deciding what to do about it.

Leave both `GET` handlers untouched.

In `src/app/api/pharmacy/dispense/route.ts`, line 18 becomes `['admin', 'pi', 'pharmacy']`.

- [ ] **Step 4: Run this task's tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/charges.test.ts tests/api/pharmacy-dispense.test.ts`
Expected: PASS — all 11 pre-existing charges tests plus the 5 new ones, and all 5 pre-existing dispense tests plus the 2 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/charges "src/app/api/charges/[id]" src/app/api/pharmacy/dispense/route.ts tests/api/charges.test.ts tests/api/pharmacy-dispense.test.ts
git commit -m "$(cat <<'EOF'
feat: gate charge create/status routes to billing staff, allow pharmacy to dispense

EOF
)"
```

---

### Task 3: Medication catalog add + practice-wide "currently prescribed" query

**Files:**
- Modify: `src/lib/queries/medications.ts`
- Modify: `src/app/api/pharmacy/medications/route.ts` (add a `POST` handler; the 9-line `GET` stays unchanged and open to all authenticated roles)
- Modify: `tests/lib/queries/medications.test.ts`
- Test: `tests/api/pharmacy-medications-create.test.ts`

**Interfaces:**
- Consumes: `medications`, `medicationInventory`, `medicationEpisodes` from `@/db/schema`; the widened `Role` (Task 1).
- Produces, from `@/lib/queries/medications`:
  - `createMedicationWithInventory(input: CreateMedicationInput): Promise<CreateMedicationResult>` where
    `CreateMedicationInput = { name: string; genericName: string | null; medicationClass: string; commonDose: string | null; form: 'tablet' | 'capsule' | 'liquid' | 'injection' | 'other'; quantityOnHand: number; reorderThreshold: number; unit: string }`
    and `CreateMedicationResult = { ok: boolean; error?: string; medicationId?: number }`
  - `listActiveMedicationEpisodeSummary(): Promise<ActiveMedicationSummaryRow[]>` where
    `ActiveMedicationSummaryRow = { name: string; medicationClass: string; activeEpisodeCount: number; inCatalog: boolean }`
  - `POST /api/pharmacy/medications` → `201 { id: number }`. All consumed by Task 7.

- [ ] **Step 1: Write the failing tests — query layer**

Extend `tests/lib/queries/medications.test.ts` (it currently has 2 tests and no cleanup — add an `afterEach` pop-loop for anything it now creates):

```ts
describe('listActiveMedicationEpisodeSummary', () => {
  it('counts only active episodes and groups by class', async () => {
    // Insert against a real seeded patient: 2 active episodes named 'Zztestdrug'
    // (medicationClass 'Test Class') and 1 inactive one with the same name.
    const summary = await listActiveMedicationEpisodeSummary()
    const row = summary.find((r) => r.name === 'Zztestdrug')
    expect(row?.activeEpisodeCount).toBe(2)
    expect(row?.medicationClass).toBe('Test Class')
  })

  it('flags a prescribed drug name with no catalog row', async () => {
    // 'Zztestdrug' is not in `medications`
    expect(summary.find((r) => r.name === 'Zztestdrug')?.inCatalog).toBe(false)
  })

  it('does not flag a prescribed name that matches a catalog row case-insensitively', async () => {
    // an active episode named 'sertraline' (lowercase) vs the seeded catalog 'Sertraline'
    expect(summary.find((r) => r.name.toLowerCase() === 'sertraline')?.inCatalog).toBe(true)
  })
})

describe('createMedicationWithInventory', () => {
  it('creates both the catalog row and its inventory row', async () => {
    const result = await createMedicationWithInventory({ name: `Zz New Drug ${Date.now()}`, genericName: null, medicationClass: 'Test Class', commonDose: null, form: 'tablet', quantityOnHand: 40, reorderThreshold: 10, unit: 'tablets' })
    expect(result.ok).toBe(true)
    const all = await listMedicationsWithInventory()
    const created = all.find((m) => m.id === result.medicationId)
    expect(created?.quantityOnHand).toBe(40)  // innerJoin means an orphan catalog row would be invisible here
  })

  it('rejects a case-insensitive duplicate name', async () => {
    const result = await createMedicationWithInventory({ /* name: 'sertraline', ...rest */ })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/already/i)
  })

  it('leaves no orphan catalog row when the transaction cannot complete', async () => {
    // Two concurrent calls with the SAME name via Promise.allSettled. The
    // medications_name_unique constraint fires inside one transaction and
    // rolls that whole transaction back, so exactly one catalog row and
    // exactly one inventory row exist afterwards -- never a catalog row
    // without inventory, which listMedicationsWithInventory's innerJoin
    // would render invisible on the very screen that created it.
    const rows = await getDb().select().from(medications).where(eq(medications.name, name))
    expect(rows).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/medications.test.ts`
Expected: FAIL — neither function is exported.

- [ ] **Step 3: Implement both query functions**

In `src/lib/queries/medications.ts`:

`createMedicationWithInventory` — check for an existing case-insensitive name first (`sql\`lower(${medications.name}) = lower(${input.name})\``, following the seed's check-by-name-before-insert idempotency convention) and return `{ ok: false, error: 'A medication with that name is already in the catalog' }`; then insert the `medications` row and its `medicationInventory` row inside one `getDb().transaction(async (tx) => ...)`, the same shape as `dispenseMedication` (`medication-dispenses.ts:57`) and `createCarePlan` (`care-plans.ts:59`). The transaction is load-bearing: the 1:1 relationship is enforced by `medicationInventory.medicationId`'s `.unique()` FK and `listMedicationsWithInventory()` uses an `innerJoin`, so a catalog row created without its inventory row would be invisible on the very screen that created it. A duplicate that slips past the pre-check (a concurrent caller) surfaces as the `medications_name_unique` violation rolling the transaction back — catch it and return the same `{ ok: false }` shape rather than letting a 500 escape.

`listActiveMedicationEpisodeSummary` — select `medicationEpisodes.name`, `medicationEpisodes.medicationClass`, `count(*)` from `medicationEpisodes` where `status = 'active'`, grouped by both selected columns, ordered by `medicationClass` asc then count desc. Resolve `inCatalog` by fetching every `medications.name` once and comparing lowercased in JS (the catalog is ~15 rows; a per-row correlated subquery buys nothing). Returns counts and drug names only — **no patient identities** — so this aggregate needs no per-patient audit entry.

- [ ] **Step 4: Run the query tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/medications.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test — the create route**

Create `tests/api/pharmacy-medications-create.test.ts`, following `tests/api/pharmacy-dispense.test.ts`'s conventions exactly (mutable `sessionRole`, real DB writes, `afterEach` pop-loop deleting inventory before medications). Union: `'admin' | 'pi' | 'crc' | 'frontdesk' | 'pharmacy'`, default `'pharmacy'`.

```ts
describe('POST /api/pharmacy/medications', () => {
  it('creates the catalog and inventory rows as pharmacy', async () => { /* expect 201, body.id a number */ })
  it('creates them as admin too', async () => { sessionRole = 'admin'; /* expect 201 */ })
  it('rejects pi, crc and frontdesk', async () => { /* each -> 403 */ })
  it('rejects a case-insensitive duplicate name with 409', async () => { /* create, then re-create with a different case -> 409 */ })
  it('rejects an unexpected extra field (mass-assignment guard)', async () => { /* .strict() -> 400 */ })
  it('makes the new drug appear in listMedicationsWithInventory()', async () => { /* proves the inventory row landed */ })
})
```

- [ ] **Step 6: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/pharmacy-medications-create.test.ts`
Expected: FAIL — the route file exports no `POST`.

- [ ] **Step 7: Implement the `POST` handler**

Add to the existing `src/app/api/pharmacy/medications/route.ts`. Gate `['admin', 'pharmacy']`. Schema, `.strict()`:

```ts
const createMedicationSchema = z.object({
  name: z.string().trim().min(1),
  genericName: z.string().trim().min(1).optional(),
  medicationClass: z.string().trim().min(1),
  commonDose: z.string().trim().min(1).optional(),
  form: z.enum(['tablet', 'capsule', 'liquid', 'injection', 'other']),
  quantityOnHand: z.number().int().nonnegative(),
  reorderThreshold: z.number().int().nonnegative(),
  unit: z.string().trim().min(1),
}).strict()
```

On `ok: false` return 409 with the error; on success `await logAudit(session, 'added a medication to the catalog', null)` and return `{ id: result.medicationId }` with status 201. Leave the existing `GET` exactly as it is — open to every authenticated role, per spec §6.2.

- [ ] **Step 8: Run this task's tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/medications.test.ts tests/api/pharmacy-medications-create.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/queries/medications.ts src/app/api/pharmacy/medications/route.ts tests/lib/queries/medications.test.ts tests/api/pharmacy-medications-create.test.ts
git commit -m "$(cat <<'EOF'
feat: let admin and pharmacy add catalog medications, add prescribed-drug summary query

EOF
)"
```

---

### Task 4: Patient lookup — narrow projection query + `GET /api/pharmacy/patients/[patientId]`

**Files:**
- Modify: `src/lib/queries/patients.ts` (add `getPatientPharmacyView`; do **not** touch `getPatientDetail`)
- Create: `src/app/api/pharmacy/patients/[patientId]/route.ts`
- Test: `tests/api/pharmacy-patient-lookup.test.ts`

**Interfaces:**
- Consumes: `patients`, `diagnoses`, `medicationEpisodes`, `medicationDispenses`, `medications`, `charges` from `@/db/schema`; `medicationDispenses.chargeId` (Task 1).
- Produces:

```ts
export interface PharmacyPatientView {
  id: string
  name: string                       // nameTebra ?? nameIntakeq (Global Constraints)
  dob: string                        // dobTebra ?? dobIntakeq
  currentProvider: string | null
  diagnoses: { id: number; code: string; description: string }[]
  activeMedications: PharmacyEpisode[]   // status = 'active'
  pastMedications: PharmacyEpisode[]     // status = 'inactive'
  dispenses: {
    id: number
    medicationId: number
    medicationName: string
    medicationEpisodeId: number | null
    quantity: number
    dispensedByName: string
    dispensedAt: Date
    notes: string | null
    charge: { id: number; status: ChargeStatus; amountCents: number } | null
  }[]                                    // newest first
}
export interface PharmacyEpisode {
  id: number
  name: string
  medicationClass: string
  dose: string | null
  startDate: string
  stopDate: string | null
  catalogMedicationId: number | null   // case-insensitive medications.name match, else null ("Not stocked")
}
export async function getPatientPharmacyView(patientId: string): Promise<PharmacyPatientView | null>
```

  `GET /api/pharmacy/patients/[patientId]` → `200 PharmacyPatientView` | `404 { error: 'No patient with that ID' }`. Both consumed by Tasks 5 (charge route reads the same diagnoses) and 6 (the UI).

- [ ] **Step 1: Write the failing test**

Create `tests/api/pharmacy-patient-lookup.test.ts`, following `tests/api/pharmacy-dispense.test.ts`'s conventions. Union includes `'pharmacy'`, default `'pharmacy'`. Use a real seeded patient with diagnoses (`RD-0001`); create throwaway `medicationEpisodes` rows and clean them up.

```ts
function req() { return new Request('http://localhost') }
function ctx(patientId: string) { return { params: Promise.resolve({ patientId }) } }

describe('GET /api/pharmacy/patients/[patientId]', () => {
  it('returns the narrow projection for an exact id', async () => {
    const res = await GET(req() as never, ctx('RD-0001'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe('RD-0001')
    expect(typeof body.name).toBe('string')
    expect(Array.isArray(body.activeMedications)).toBe(true)
  })

  it('matches case-insensitively and tolerates surrounding whitespace', async () => {
    const res = await GET(req() as never, ctx('  rd-0001 '))
    expect(res.status).toBe(200)
    expect((await res.json()).id).toBe('RD-0001')
  })

  it('returns a clean 404 for an unknown id', async () => {
    const res = await GET(req() as never, ctx('RD-999999'))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('No patient with that ID')
  })

  it('allows admin and rejects crc, pi and frontdesk', async () => {
    // admin -> 200; each of crc/pi/frontdesk -> 403
  })

  // Review Focus #5 -- assert on what the payload must NOT contain, not just
  // on what it must. Matching the queue-display spec's precedent.
  it('never leaks the rest of the chart', async () => {
    const body = await (await GET(req() as never, ctx('RD-0001'))).json()
    expect(Object.keys(body).sort()).toEqual(
      ['activeMedications', 'currentProvider', 'diagnoses', 'dispenses', 'dob', 'id', 'name', 'pastMedications']
    )
    const serialized = JSON.stringify(body)
    for (const forbidden of ['criteria', 'overallStatus', 'identityVerification', 'discrepancies', 'portalPasswordHash', 'portalConfigured', 'mfaSecretEncrypted', 'intakeqClientIdRef', 'reviewerNotes']) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  it('puts only active episodes in activeMedications and inactive ones in pastMedications', async () => {
    // create one 'active' and one 'inactive' episode for RD-0001 with distinct names, assert the split
  })

  it('marks an episode whose name has no catalog row with catalogMedicationId null', async () => {
    // episode named 'Zznotstocked' -> catalogMedicationId === null
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/pharmacy-patient-lookup.test.ts`
Expected: FAIL — route doesn't exist.

- [ ] **Step 3: Implement `getPatientPharmacyView`**

Add to `src/lib/queries/patients.ts`, modeled on the explicit-`.select({...})` projection discipline already used at `patients.ts:116-124` (whose rationale comment at 111-115 is the model to follow here). Carry a comment recording *why* this is not `getPatientDetail()`: that function returns screening criteria with evidence quotes, identity-verification records, data discrepancies and portal-credential state — none of which a pharmacist needs, all of which is PHI.

Details the signature and tests don't pin:
- Match `lower(trim(patients.id)) = lower(trim(<input>))` — exact after trimming, case-insensitive. **No fuzzy or partial matching**: front desk's name+DOB search is fuzzy because its job is finding candidate duplicates; a dispensing counter's job is confirming one specific chart, and a near-miss there is a dispensing error.
- `name`/`dob` coalesce per Global Constraints.
- `catalogMedicationId` comes from one `medications` fetch compared lowercased in JS, same as Task 3's `inCatalog`.
- `dispenses` left-joins `medications` for the name and left-joins `charges` on `medicationDispenses.chargeId`, ordered `desc(dispensedAt), desc(id)` — matching `listDispensesForPatient`'s tie-break comment at `medication-dispenses.ts:74-77`.
- **No caching.** `getPatientDetail` wraps itself in a 30s cache; this view must reflect a dispense or a just-logged bill immediately, and a stale "not billed yet" at a dispensing counter invites a double-bill attempt.

- [ ] **Step 4: Implement the route**

Create `src/app/api/pharmacy/patients/[patientId]/route.ts`. `requireSession()` first, then `if (!['pharmacy', 'admin'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })`. Call `getPatientPharmacyView(patientId)`; `null` → `404 { error: 'No patient with that ID' }`. On success `await logAudit(session, 'looked up a patient at the pharmacy counter', view.id)` — the real `patientId`, which is the whole reason this is its own route rather than a tab on `/pharmacy` (spec §4.1).

- [ ] **Step 5: Run this task's tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/pharmacy-patient-lookup.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/queries/patients.ts "src/app/api/pharmacy/patients" tests/api/pharmacy-patient-lookup.test.ts
git commit -m "$(cat <<'EOF'
feat: add pharmacy patient-lookup route with a narrow PHI projection

EOF
)"
```

---

### Task 5: Bill logging — `POST /api/pharmacy/dispenses/[dispenseId]/charge`

**Files:**
- Modify: `src/lib/queries/medication-dispenses.ts` (add `getDispenseById`, `createChargeForDispense`)
- Create: `src/app/api/pharmacy/dispenses/[dispenseId]/charge/route.ts`
- Test: `tests/api/pharmacy-dispense-charge.test.ts`

**Interfaces:**
- Consumes: `medicationDispenses.chargeId` (Task 1); `charges`, `diagnoses`, `patients` from `@/db/schema`; `invalidateChargesList` from `@/lib/queries/charges`.
- Produces, from `@/lib/queries/medication-dispenses`:

```ts
export async function getDispenseById(id: number): Promise<typeof medicationDispenses.$inferSelect | null>

export interface DispenseChargeInput {
  dispenseId: number
  patientId: string
  providerName: string
  dateOfService: string                                                  // 'YYYY-MM-DD'
  diagnosisCode: { code: string; description: string }
  procedureCode: { code: string; description: string; units: number; chargeCents: number }
  amountCents: number
}
export interface DispenseChargeResult { ok: boolean; error?: string; chargeId?: number }
export async function createChargeForDispense(input: DispenseChargeInput): Promise<DispenseChargeResult>
```

  `POST /api/pharmacy/dispenses/[dispenseId]/charge` → `201 { chargeId: number }`. Consumed by Task 6's UI.

- [ ] **Step 1: Write the failing test**

Create `tests/api/pharmacy-dispense-charge.test.ts`, following `tests/api/pharmacy-dispense.test.ts`'s conventions. Union includes `'pharmacy'`, default `'pharmacy'`. Set up: a throwaway medication with stock, a real dispense row for a seeded patient that **has** `diagnoses` rows, and a second patient with their own diagnosis for the cross-patient case. `afterEach` deletes dispenses before charges before inventory before medications.

```ts
function req(body: unknown) { return new Request('http://localhost', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }) }
function ctx(dispenseId: number) { return { params: Promise.resolve({ dispenseId: String(dispenseId) }) } }
const validBody = (diagnosisId: number) => ({ diagnosisId, procedureCode: 'J3490', procedureDescription: 'Unclassified drugs - Sertraline', unitChargeCents: 250 })

describe('POST /api/pharmacy/dispenses/[dispenseId]/charge', () => {
  it('creates a real draft charge and links it to the dispense', async () => {
    const res = await POST(req(validBody(dx.id)) as never, ctx(dispense.id))
    expect(res.status).toBe(201)
    const { chargeId } = await res.json()
    const [charge] = await getDb().select().from(charges).where(eq(charges.id, chargeId))
    expect(charge.status).toBe('draft')
    expect(charge.patientId).toBe(dispense.patientId)
    expect(charge.diagnosisCodes).toEqual([{ code: dx.code, description: dx.description }])
    expect(charge.procedureCodes).toEqual([{ code: 'J3490', description: 'Unclassified drugs - Sertraline', units: dispense.quantity, chargeCents: 250 }])
    const [updated] = await getDb().select().from(medicationDispenses).where(eq(medicationDispenses.id, dispense.id))
    expect(updated.chargeId).toBe(chargeId)
  })

  it('derives amountCents as quantity * unitChargeCents', async () => {
    // dispense.quantity = 6, unitChargeCents = 250 -> amountCents === 1500
  })

  it('rejects a client-supplied amountCents outright (mass-assignment guard)', async () => {
    const res = await POST(req({ ...validBody(dx.id), amountCents: 1 }) as never, ctx(dispense.id))
    expect(res.status).toBe(400)   // .strict()
  })

  // Review Focus #3
  it('returns 409 on a second bill for the same dispense and creates no second charge', async () => {
    // first call 201; second call 409; count charges for that patient created by this test === 1
  })

  it('creates exactly one charge when two bill calls race', async () => {
    const results = await Promise.allSettled([POST(...), POST(...)])
    // exactly one 201; the dispense's chargeId points at that one charge; no orphan charge row
  })

  // Review Focus #4
  it('rejects a diagnosisId belonging to a different patient with 400 and creates nothing', async () => {
    const res = await POST(req(validBody(otherPatientDx.id)) as never, ctx(dispense.id))
    expect(res.status).toBe(400)
    const [unchanged] = await getDb().select().from(medicationDispenses).where(eq(medicationDispenses.id, dispense.id))
    expect(unchanged.chargeId).toBeNull()
  })

  it('returns 404 for an unknown dispenseId', async () => { /* ...404 */ })
  it('rejects crc, pi and frontdesk with 403, allows admin', async () => { /* ... */ })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/pharmacy-dispense-charge.test.ts`
Expected: FAIL — route doesn't exist.

- [ ] **Step 3: Implement the query-layer functions**

In `src/lib/queries/medication-dispenses.ts`:

`getDispenseById(id)` — a plain single-row select, returning `null` when absent.

`createChargeForDispense(input)` — one `getDb().transaction(async (tx) => ...)`, same posture as `dispenseMedication` two functions above it, so a dispense is never left pointing at a charge that rolled back and a charge is never orphaned from its dispense:
1. `tx.insert(charges).values({ patientId, providerName, dateOfService, diagnosisCodes: [input.diagnosisCode], procedureCodes: [input.procedureCode], amountCents, status: 'draft' }).returning()`.
2. A **conditional** update — `tx.update(medicationDispenses).set({ chargeId: created.id }).where(and(eq(medicationDispenses.id, input.dispenseId), isNull(medicationDispenses.chargeId))).returning({ id })`. If it returns zero rows, the dispense was billed between the route's check and here; throw so the whole transaction (including the charge insert) rolls back, and translate that into `{ ok: false, error: 'This dispense has already been billed' }`. The `.unique()` index is the real backstop; this conditional WHERE is what turns a race into a clean rollback instead of a constraint-violation 500.
3. After the transaction commits, `await invalidateChargesList()` — the charges list is cached for 30s (`charges.ts:26`, `cache.ts:78`) and would otherwise not show the new row. Deliberately outside the transaction: a cache invalidation for a rolled-back write would be wasted work.

Do not route this through `createCharge()` in `charges.ts` — that function opens its own connection and cannot participate in this transaction.

- [ ] **Step 4: Implement the route**

Create `src/app/api/pharmacy/dispenses/[dispenseId]/charge/route.ts`. Gate `['pharmacy', 'admin']`. Schema, `.strict()`:

```ts
const dispenseChargeSchema = z.object({
  diagnosisId: z.number().int(),
  procedureCode: z.string().trim().min(1),
  procedureDescription: z.string().trim().min(1),
  unitChargeCents: z.number().int().positive(),
}).strict()
```

Order of checks, each with the status the tests pin:
1. Unknown `dispenseId` → 404.
2. `dispense.chargeId !== null` → `409 { error: 'This dispense has already been billed' }` (a clean message; the unique index enforces it regardless).
3. Load the patient's `diagnoses` rows; `diagnosisId` not among them → `400 { error: 'diagnosisId does not belong to this patient' }`, matching the ownership-400 convention at `src/app/api/patients/[anonId]/notes/route.ts:32-37` and `src/app/api/inpatient/admissions/[id]/medications/route.ts:49-54`. A patient with no diagnoses at all therefore cannot be billed here — correct, and the UI disables the action rather than the route inventing a placeholder code (`charges.diagnosisCodes` is `.min(1)` and stays that way).

Everything else is derived server-side from the dispense row and never accepted from the client (spec §5.2), extending `POST /api/charges`'s own rule — *"amountCents is never trusted from the client — it's derived here from procedureCodes so a charge's stored total can never drift from its own line items"* (`charges/route.ts:32-34`) — one step further, so the line items can't drift from the dispensing event either:

| `charges` field | Source |
|---|---|
| `patientId` | `dispense.patientId` |
| `dateOfService` | `dispense.dispensedAt` as `YYYY-MM-DD` (the column is a `date`, and `CreateChargeInput.dateOfService` is a string) |
| `providerName` | `patient.currentProvider` falling back to `dispense.dispensedByName` — `medicationEpisodes` has no prescriber column; the treating clinician on file is the best available answer and the dispensing staff member's name is a visibly wrong-but-attributable fallback rather than an empty required field |
| `diagnosisCodes` | `[{ code, description }]` from the one matched `diagnoses` row |
| `procedureCodes` | `[{ code, description, units: dispense.quantity, chargeCents: unitChargeCents }]` |
| `amountCents` | `dispense.quantity * unitChargeCents` |
| `status` | `'draft'` (the column default) |

On success: `await logAudit(session, 'logged a bill for a dispensed medication', dispense.patientId)` and `201 { chargeId }`. Pharmacy has no route to move the charge onward — `PATCH /api/charges/[id]` was closed to it in Task 2.

- [ ] **Step 5: Run this task's tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/pharmacy-dispense-charge.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/queries/medication-dispenses.ts "src/app/api/pharmacy/dispenses" tests/api/pharmacy-dispense-charge.test.ts
git commit -m "$(cat <<'EOF'
feat: turn a dispense into a real draft charge, linked by a unique chargeId

EOF
)"
```

---

### Task 6: `/pharmacy/patient-lookup` UI, nav, and the pharmacy role's landing redirect

**Files:**
- Create: `src/app/(dashboard)/pharmacy/patient-lookup/page.tsx`
- Create: `src/components/PharmacyPatientLookup.tsx`
- Create: `src/components/LogDispenseBillModal.tsx`
- Modify: `src/components/DispenseMedicationModal.tsx` (optional prefill props — existing call site must keep working unchanged)
- Modify: `src/components/LeftNav.tsx:29-47,59-67`
- Modify: `src/app/(dashboard)/page.tsx:17-20` (the redirect block)
- Modify: `src/app/(dashboard)/settings/page.tsx:22` (`ROLE_LABEL`)
- Test: none new (UI wiring over routes already tested in Tasks 4-5) — verify per this plan's UI verification discipline.

**Interfaces:**
- Consumes: `GET /api/pharmacy/patients/[patientId]` (Task 4), `POST /api/pharmacy/dispense` (existing, now open to pharmacy — Task 2), `POST /api/pharmacy/dispenses/[dispenseId]/charge` (Task 5), all called by URL from client components.
- Produces: `<PharmacyPatientLookup medications={MedicationWithInventory[]} />` (the catalog, passed down from the page so the dispense modal can be opened for a matched episode without a second fetch); `<LogDispenseBillModal dispense diagnoses onClose onLogged />`. `DispenseMedicationModal` gains three **optional** props: `initialPatientId?: string`, `medicationEpisodeId?: number`, `onDispensed?: () => void`.
- `PharmacyPatientView`'s `charge.status` is the existing `ChargeStatus` union, re-exported from `@/lib/queries/charges` (defined in the DB-free `@/lib/charge-status` so client components can import it too).

- [ ] **Step 1: Widen `DispenseMedicationModal` without changing its existing call site**

Read `src/components/DispenseMedicationModal.tsx` (58 lines) in full first. Add the three optional props. When `initialPatientId` is given, seed `patientId` state from it and render that input `readOnly` (the chart is already confirmed — retyping the id at this point is a dispensing-error opportunity, not a safety check). Include `medicationEpisodeId` in the POST body only when it is provided. Call `onDispensed?.()` alongside the existing `router.refresh()` on success. `PharmacyDashboard.tsx:84-86`'s existing `<DispenseMedicationModal medication={dispensing} onClose={...} />` must continue to compile and behave identically.

This is what finally gives `medicationDispenses.medicationEpisodeId` a caller. The whole path — column, patient-ownership validation in `dispenseMedication` (`medication-dispenses.ts:50-55`), the route field, and `tests/lib/queries/medication-dispenses.test.ts:67`'s cross-patient rejection test — already exists and has never been exercised from the UI; the original Pharmacy spec's §8 recorded the episode-picker dropdown as deferred. A patient-first entry point makes the dropdown unnecessary: the episode *is* the row you clicked.

- [ ] **Step 2: Build `<PharmacyPatientLookup />`**

`'use client'`. A patient-ID text input plus a **Look up** button that `GET`s `/api/pharmacy/patients/<encodeURIComponent(id)>`, owning its own `loading`/`error`/`view` state. On 404 show the route's own message; on 403 show a forbidden message. Once a view is loaded, render:

- **Identity summary** — name, dob, patient id, current provider.
- **Active medications** — one row per `activeMedications` entry: name, class, dose, start date, all static text with no edit affordance. `catalogMedicationId === null` renders a **"Not stocked"** marker and no Dispense button (there is nothing in the catalog to dispense); otherwise a **Dispense** button opens `DispenseMedicationModal` with that catalog medication, `initialPatientId={view.id}` and `medicationEpisodeId={episode.id}`. Pharmacy reads `medicationEpisodes` and never writes them.
- **Past medications** — `pastMedications` in a collapsed `<details>` group, not hidden: "they were on that until last month" is a real thing a pharmacist needs to see.
- **Dispense history** — `view.dispenses` newest first: medication name, quantity, dispensed-by, date, and the charge cell — `charge === null` → a **Log bill** button; otherwise the charge status and amount as **read-only text**, so the counter can answer "was that billed?" without being able to change the answer.

The modal needs the catalog row to render stock and take a quantity, so the page (Step 4) passes `listMedicationsWithInventory()` down as a prop and this component looks the row up by `catalogMedicationId`.

Use raw `<input>`/`<details>` with `aria-label` and inline Tailwind classes plus `@/components/ui/button`, `card`, `badge` — `src/components/ui/` has **no** textarea, label, checkbox or combobox primitive, and existing modals (`DispenseMedicationModal.tsx:46-48`) therefore use raw elements. Do not invent a new primitive.

- [ ] **Step 3: Build `<LogDispenseBillModal />`**

`'use client'`, Dialog-modal-with-fetch shape copied from `DispenseMedicationModal`. Props: the dispense row (for `quantity` and `medicationName`), the patient's `diagnoses` array, and `onClose`/`onLogged`.

- A `<select>` of the patient's diagnoses, labelled by `code — description`. When `diagnoses.length === 0`, render nothing but the disabled state and the message **"No coded diagnosis on file — billing needs one"**. Pharmacy never types a free-text ICD code: assigning a diagnosis is the clinician's act.
- `procedureCode` defaulting to **`J3490`** ("Unclassified drugs", the standard HCPCS code for an in-office dispensed drug with no specific J-code), editable. `procedureDescription` defaulting to the medication's name, editable. `charges.procedureCodes[].code` is free text today and has never been validated against a real code set — validating it needs a licensed code file, the same vendor boundary this codebase already accepts for CPT codes.
- A unit-charge input in dollars, converted to integer cents before sending. Show the computed total (`quantity × unitChargeCents`) read-only so the user sees what the server will derive.
- `POST` to `/api/pharmacy/dispenses/<id>/charge` with exactly `{ diagnosisId, procedureCode, procedureDescription, unitChargeCents }` — the route is `.strict()` and will 400 on anything else. Surface the 409 text verbatim if the dispense was already billed.

- [ ] **Step 4: Build the page**

Create `src/app/(dashboard)/pharmacy/patient-lookup/page.tsx` as a Server Component:

```ts
const session = await requireSessionOrRedirect()
if (!['pharmacy', 'admin'].includes(session.role)) redirect('/')
```

matching `(dashboard)/labs/page.tsx:11`. Fetch `listMedicationsWithInventory()` directly from the query layer and pass it to `<PharmacyPatientLookup medications={...} />`. **No `logAudit` here** — the page itself shows no patient; the per-patient audit entry is emitted by the lookup route (Task 4) with a real `patientId` attached, which is the reason this is its own route rather than a tab on `/pharmacy`.

- [ ] **Step 5: Nav, landing redirect, and role label**

In `src/components/LeftNav.tsx`: add an explicit four-role array to every `ITEMS` entry that currently has no `roles` key (Home, Patients, Trials & Protocols, Calendar, Client Forms, Staff, Messages) so pharmacy is excluded; give `/pharmacy` an explicit all-five array so the file reads uniformly; add, immediately after it:

```ts
  { href: '/pharmacy/patient-lookup', label: 'Patient Lookup', icon: Search, roles: ['pharmacy', 'admin'] as Role[] },
```

`TRAILING_ITEMS`' `Settings` stays unannotated — every role needs its own Account tab, and `isAdmin` is already `false` for any non-admin so the Practice/EHR/Providers/Staff tabs are already withheld with no change. Use the existing per-item `roles?: Role[]` allowlist and **do not** add an `excludeRoles` escape hatch: that file's header comment (`LeftNav.tsx:17-28`) commits it to one source of truth, and two competing ways to express the same thing is the cost this annotation pass is accepted to avoid. `isActive` (`LeftNav.tsx:69-71`) already lights the Pharmacy section for a nested child with no change. Pick the `Search` icon (or another already-imported `lucide-react` icon) and add it to the import block at lines 5-11.

In `src/app/(dashboard)/page.tsx`, add immediately alongside the existing `pi` redirect at :17-20, for the identical reason its comment records:

```ts
  if (session.role === 'pharmacy') redirect('/pharmacy/patient-lookup')
```

In `src/app/(dashboard)/settings/page.tsx:22`, extend `ROLE_LABEL` with `frontdesk: 'Front Desk / Reception'` and `pharmacy: 'Pharmacy'` — that map is already silently falling back to the raw role string for `frontdesk` (:98), and fixing it in the same edit is a one-line freebie.

- [ ] **Step 6: Verify via a real running dev server, not narration**

Mint a `clinsync_demo_session` cookie for `role: 'pharmacy'` per Global Constraints. Then, with real `curl`/HTTP requests against a running `npm run dev`, show actual commands and actual output for each of:
1. `GET /` as pharmacy → 307 to `/pharmacy/patient-lookup`.
2. `GET /pharmacy/patient-lookup` as pharmacy → 200 with the lookup form rendered; as `crc` → redirect to `/`.
3. `GET /api/pharmacy/patients/RD-0001` as pharmacy → the narrow projection.
4. A real dispense through `POST /api/pharmacy/dispense` including a `medicationEpisodeId`, then a fresh lookup showing it in the dispense history with `charge: null`.
5. A real `POST /api/pharmacy/dispenses/<id>/charge`, then a fresh lookup showing that dispense's charge status as `draft`, and the new row present in `GET /api/charges` (as an `admin` session — pharmacy is 403 on the POST but the list `GET` stays open).
6. `GET /pharmacy/patient-lookup` HTML confirming the nav shows exactly Pharmacy, Patient Lookup and Settings for a pharmacy session.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(dashboard)/pharmacy/patient-lookup" src/components/PharmacyPatientLookup.tsx src/components/LogDispenseBillModal.tsx src/components/DispenseMedicationModal.tsx src/components/LeftNav.tsx "src/app/(dashboard)/page.tsx" "src/app/(dashboard)/settings/page.tsx"
git commit -m "$(cat <<'EOF'
feat: add the pharmacy patient-lookup screen, nav, and landing redirect

EOF
)"
```

---

### Task 7: `/pharmacy` board — "Currently prescribed" section, Add medication, and whole-branch verification

**Files:**
- Create: `src/components/AddMedicationModal.tsx`
- Modify: `src/components/PharmacyDashboard.tsx:39` (two new props, one new section)
- Modify: `src/app/(dashboard)/pharmacy/page.tsx` (17 lines — fetch the summary, widen `canDispense`, pass the new props)
- Test: none new (UI wiring over routes tested in Task 3) — verify per this plan's UI verification discipline.

**Interfaces:**
- Consumes: `listActiveMedicationEpisodeSummary()` and `POST /api/pharmacy/medications` (Task 3); `ActiveMedicationSummaryRow` (Task 3).
- Produces: `PharmacyDashboard` gains `prescribedSummary: ActiveMedicationSummaryRow[]` and `canAddMedication: boolean`.

- [ ] **Step 1: Build `<AddMedicationModal />`**

`'use client'`, same Dialog-with-fetch shape as `DispenseMedicationModal`. Props: `{ initialName?: string; initialClass?: string; onClose: () => void }` — the prefill is what makes this worth building, since the whole workflow is "17 patients are on this and it isn't in our catalog, add it." Fields matching the route's `.strict()` schema exactly: name, genericName (optional), medicationClass, commonDose (optional), form (a `<select>` over the five `medicationFormEnum` values), quantityOnHand, reorderThreshold, unit. `POST /api/pharmacy/medications`, `router.refresh()` on success, surface the 409 duplicate-name message verbatim.

- [ ] **Step 2: Add the "Currently prescribed across the practice" section**

In `src/components/PharmacyDashboard.tsx`, below the existing stock table, add a read-only section rendering `prescribedSummary` grouped by `medicationClass` (which is what the spec's "so that everything is classified" asks for), each row showing the drug name and its active-episode count. A row with `inCatalog === false` gets a visible "Not in catalog" flag and, when `canAddMedication`, an **Add to catalog** button that opens `AddMedicationModal` prefilled with that name and class. A standalone **Add medication** button at the section header, also gated on `canAddMedication`.

This section carries **counts and drug names only, no patient identities** — an aggregate, not a roster. That is what keeps a screen a pharmacist leaves open at a counter free of PHI it doesn't need, and why it needs no per-patient audit entry. Keep the existing `stockStatus`/`StockPill` logic and the existing table untouched.

- [ ] **Step 3: Wire the page**

In `src/app/(dashboard)/pharmacy/page.tsx`, fetch `listActiveMedicationEpisodeSummary()` alongside the existing `listMedicationsWithInventory()`, widen line 14's `canDispense` to `['admin', 'pi', 'pharmacy'].includes(session.role)` so it matches the dispense route's allowlist exactly, and pass `prescribedSummary` plus `canAddMedication={['admin', 'pharmacy'].includes(session.role)}`. The page's `requireSessionOrRedirect()`-only gate stays as it is: viewing the catalog is open to every authenticated role today and pharmacy needs no grant for it (spec §6.2, §8).

- [ ] **Step 4: Verify via a real running dev server, not narration**

With real HTTP requests and pasted output: `GET /pharmacy` as `pharmacy` shows the stock table, the "Currently prescribed" section with class groupings and at least one count, and the Add medication control; as `crc` shows the table and the section but **no** Add control and **no** Dispense column. Then a real `POST /api/pharmacy/medications` for a name that appears in the summary as "Not in catalog", followed by a fresh `GET /pharmacy` showing that drug now in the stock table and no longer flagged.

- [ ] **Step 5: Run the full suite once**

Run: `npx dotenv -e .env.local -- npx vitest run`
Expected: all pass — including `tests/lib/role-capabilities.test.ts` (five roles, Task 1), `tests/api/charges.test.ts` (Task 2's converted mock plus the new gating tests), and every pre-existing pharmacy test.

Then: `npx tsc --noEmit` — expected clean; and `npm run lint`.

- [ ] **Step 6: Commit**

```bash
git add src/components/AddMedicationModal.tsx src/components/PharmacyDashboard.tsx "src/app/(dashboard)/pharmacy/page.tsx"
git commit -m "$(cat <<'EOF'
feat: add currently-prescribed summary and catalog-add action to the Pharmacy board

EOF
)"
```
