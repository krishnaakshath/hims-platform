# Imaging Attachments on Lab Orders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the person who acquires an imaging study attach the image file to the lab order that requested it, in one action, so the ordering doctor sees the film on the chart — with no new file-storage machinery, no new table, and no new role.

**Architecture:** An imaging file is a `documents` row with `documentType: 'imaging_result'` and a new nullable `documents.labOrderId` FK — the same shape the prerequisite plan gave `admissionId`. Storage, download, delete, and audit are entirely the prerequisite plan's; this plan adds one enum value, one nullable FK, one `labTests.category` enum column, one order-scoped upload route (`POST /api/lab-orders/[id]/imaging`, on the `admin`/`pi` tier that already enters results, deliberately *not* the generic `/api/documents` tier of `admin`/`crc`/`frontdesk`), and one batched `listImagingForOrders()` that feeds both existing viewing surfaces without an N+1.

**Tech Stack:** Next.js 16 App Router (Server Components) + Drizzle ORM over a `pg` Pool (schema changes via a hand-written one-off script, never `drizzle-kit push`) + `@vercel/blob` (`put`) + Zod `.strict()` validation + vitest.

**Spec:** `docs/superpowers/specs/2026-09-29-imaging-attachment.md`

**Working directory note:** this plan is executed in an isolated git worktree at `/Users/k2a/Desktop/clinsync/.worktrees/imaging-attachment` on branch `feature/imaging-attachment`. That branch has already been merged up to `origin/hims-platform` (merge commit on top of `5cd5856`), so the real Documents pipeline is present. Every implementer/reviewer dispatch must work from this exact directory — the main checkout and ~20 sibling worktrees have concurrent work in flight against the same shared Neon database; do not touch them.

## Global Constraints

- **Branch: `hims-platform` lineage only.** Work happens on `feature/imaging-attachment`, which is already merged up to `origin/hims-platform`. Nothing here targets `main`.
- **Schema changes are additive only** — one new enum type, one new column on `lab_tests` with a `NOT NULL DEFAULT 'lab'`, one appended `document_type` enum value, one nullable FK column on `documents`. No renames, no drops, no backfill, no data rewrite. Applied via a hand-written one-off script run with `npx dotenv -e .env.local -- npx tsx <script>`; **never `drizzle-kit push`, never `drizzle-kit generate`**.
- `psql` is not installed here — verify a migration's live-DB effect with a Node script using `pg`'s `Pool` against `information_schema.columns` and `pg_enum`, and paste the real output.
- **Check the live DB's current state before writing the migration.** Multiple concurrent worktrees have been mutating this shared Neon database all session. Task 1 Step 1 re-runs the state check; the drift recorded below was true at plan time and may have moved.
- Every write route is `.strict()`-Zod-validated and calls `logAudit(session, <action>, <patientId or null>)`. `logAudit` takes a non-null `Session` by its own type signature — a deliberate compile-time guard.
- Every protected route starts with `requireSession()` (API) or `requireSessionOrRedirect()` (pages) as its first statement.
- **The words "Tebra" and "IntakeQ" must not appear in any new code.** This bites in Task 4: the existing `listWorklist()` reads `r.patient.nameTebra ?? r.patient.nameIntakeq`, and the replacement written there uses a narrow raw-`sql` select of `patients.name` instead.
- Server-set fields are never client-supplied: `patientId`, `labOrderId`, `documentType`, `fileType`, `filedByName`, `filedAt`, `status` are all derived inside the route. `.strict()` rejects a client that tries to send them.
- Commit messages end with no attribution trailer.
- Vitest invocation: `npx dotenv -e .env.local -- npx vitest run <path>` (`fileParallelism: false`, `testTimeout: 15000`).
- A test file whose route reads `request.formData()` needs `// @vitest-environment node` on line 1 — jsdom's `File` fails undici's webidl brand check. See the comment block atop `tests/api/documents-receive.test.ts`.
- UI verification is done against a real running dev server with real HTTP requests (mint a staff session cookie the way `src/lib/auth.ts` does — `SignJWT` under cookie `clinsync_demo_session`, secret from `SESSION_SECRET`), with actual commands and actual output pasted into the report. Never a narrated, unreproduced claim.

## Plan-time findings that change the spec's assumptions

The spec was written before `feature/document-assignment` merged. Three of its predictions are now stale. These are rulings, not open questions.

1. **`createDocument()` already exists — do not extract it.** Spec §3b says "implementing this spec begins by extracting that sequence into `createDocument(input)`." The prerequisite plan's own execution already did exactly that: `src/lib/queries/documents.ts:67` exports `createDocument(input: CreateDocumentInput): Promise<DocumentRow>`, and `POST /api/documents` is already the thin caller the spec asked for. The architectural intent is preserved by **widening `CreateDocumentInput` with `labOrderId`** (Task 2) so both routes keep producing byte-identical rows. Task 2's scope shrinks accordingly; nothing else about §3b changes.
2. **`status` is not part of `CreateDocumentInput` and must not be added.** `documents.status` carries a DB-level `DEFAULT 'new'`. Spec §3b step 4's "`status: 'new'`" is satisfied by that default; passing it explicitly would add a field to the shared input type that the generic route does not set.
3. **`listWorklist()` is broken against the live database right now, before this plan touches anything.** A sibling worktree's migration has already collapsed the live `patients` table to single `name`/`dob` columns, while `src/db/schema.ts:54-57` on this branch still declares `nameIntakeq`/`nameTebra`/`dobIntakeq`/`dobTebra` plus `intakeq_client_id_encrypted` and friends. `listWorklist()` does a bare `select({ ..., patient: patients, ... })`, which spreads every declared column and 42703s. Verified at plan time: **all 8 tests in `tests/api/lab-orders.test.ts` fail on this branch's HEAD** with `column "intakeq_client_id_encrypted" does not exist`. `src/lib/queries/documents.ts:26-40` already carries the narrow raw-`sql` workaround and a comment explaining it. Task 4 applies the same workaround to `listWorklist()` and to the two test helpers that do `select().from(patients).limit(1)`. This is pre-existing breakage this plan repairs because it modifies those exact functions — it is not new damage.

Live-DB state verified at plan time (re-verify in Task 1 Step 1): `documents` has `document_type`, `admission_id`, `file_url`, `filed_by_name`, `filed_at` and **no** `lab_order_id`; `document_type` has nine values and **no** `imaging_result`; `lab_tests` has `id, name, code, default_unit, reference_range` and **no** `category`; there is **no** `lab_test_category` type; `lab_tests` holds the ten seeded chemistry rows (ids 3–12).

## Review Focus

1. **`listWorklist()`'s bare `patient: patients` spread 42703-ing against the live shared DB.** Pre-existing (finding 3 above), but Task 4 rewrites this function's select and must not leave it broken. (Task 4)
2. **Deleting a patient whose *unfiled* document still carries a `labOrderId`.** `deletePatient()` deletes `documents WHERE patient_id = ?` at line ~228 but `labOrders` only at line ~266. An admin who un-files an imaging document (`PATCH { patientId: null }`, which clears `patientId` but has no reason to touch `labOrderId`) leaves a row the first delete misses and the second collides with — 23503 mid-cascade, half-deleted chart. The same bug class `tests/lib/queries/delete-patient-document-admission-fk.test.ts` exists to catch. (Task 1)
3. **`labOrderId` mass-assigned through the generic `POST /api/documents` or `PATCH /api/documents/[id]`.** Spec §2c's patient/order consistency invariant is structural only as long as those two `.strict()` schemas keep rejecting the field. Assert it, don't trust it. (Task 2)
4. **A disallowed, zero-byte, or oversize file reaching Blob `put()`.** `application/dicom`, `text/html`, a 0-byte scan, and a >16 MB file must all be rejected *before* `put()` is called, not after. (Task 3)
5. **Upload against a cancelled order, a missing order, or a non-integer id — and the `ordered → collected` side effect firing on exactly one status.** A 409/404/400 must write no `documents` row and call no `put()`; a successful upload onto `collected` or `resulted` must not re-stamp `collectedAt` or change `status`. (Task 3)

---

### Task 1: Schema, migration, seed, and the `deletePatient` FK ordering

**Files:**
- Modify: `src/db/schema.ts:694-699` (`documentTypeEnum`), `:702-722` (`documents`), `:759-768` (new `labTestCategoryEnum`, `labTests`)
- Modify: `src/db/seed.ts:393-403` (`LAB_TESTS_SEED` literal type + six imaging rows), `:849` (the "Seeded lab test catalog (10 tests)." log line)
- Modify: `src/lib/queries/patients.ts:262-266` (`deletePatient` — Review Focus #2)
- Modify: `src/lib/document-types.ts` (add `imaging_result` to `DocumentType` and `DOCUMENT_TYPE_TEXT`)
- Test: `tests/db/imaging-schema.test.ts` (new), `tests/lib/queries/delete-patient-lab-order-document-fk.test.ts` (new), `tests/lib/queries/lab-tests.test.ts` (extend)

**Interfaces:**
- Produces, consumed by Tasks 2–6:
  - `labTestCategoryEnum` — `pgEnum('lab_test_category', ['lab', 'imaging'])`
  - `labTests.category: 'lab' | 'imaging'`, `NOT NULL DEFAULT 'lab'`
  - `documentTypeEnum` gains a tenth value `'imaging_result'` (appended last)
  - `documents.labOrderId: number | null` — `integer('lab_order_id').references(() => labOrders.id)`
  - `DOCUMENT_TYPE_TEXT.imaging_result === 'Imaging Result'`
- Ordering note: `documents` is declared at schema.ts ~702 but `labOrders` at ~770. Drizzle's `.references(() => labOrders.id)` is a thunk, so the forward reference is legal and no reordering is needed.

- [ ] **Step 0: Confirm the worktree is usable**

`.env.local` and `node_modules` were both put in place at plan time. Confirm, and only act if something is missing:
- `ls /Users/k2a/Desktop/clinsync/.worktrees/imaging-attachment/.env.local` — if absent, `cp /Users/k2a/Desktop/clinsync/.env.local .env.local`.
- `npx vitest --version` — if it fails, `npm install`.

- [ ] **Step 1: Re-check the live DB before writing anything**

Write a throwaway `dbcheck-scratch.ts` at the worktree root using `pg`'s `Pool` (`ssl: { rejectUnauthorized: false }`) that prints, for the live `DATABASE_URL`:
- `SELECT column_name FROM information_schema.columns WHERE table_name IN ('documents','lab_tests')`
- `SELECT t.typname, e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname IN ('document_type','lab_test_category')`

Run `npx dotenv -e .env.local -- npx tsx dbcheck-scratch.ts` and paste the output. Compare against the plan-time state recorded in Global Constraints. **If any of `lab_tests.category`, `lab_test_category`, `documents.lab_order_id`, or `document_type.imaging_result` already exists, another worktree got here first — report that drift before proceeding and make Step 5's statements no-ops rather than re-applying them.** Keep the script for Step 6; delete it at the end of the task.

- [ ] **Step 2: Write the failing schema test**

Create `tests/db/imaging-schema.test.ts`, following `tests/db/lab-schema.test.ts`'s shape (real DB, `afterEach` cleanup of only the ids this file created, throwaway `labTests` rows rather than seeded ones).

```ts
describe('imaging schema — labTests.category, imaging_result, documents.labOrderId', () => {
  it('defaults a new labTests row to category "lab"', /* insert {name,code} only; expect row.category === 'lab' */)
  it('stores category "imaging" on a labTests row with null unit and reference range', /* expect category === 'imaging', defaultUnit === null, referenceRange === null */)
  it('rejects a category outside the enum', /* category: 'radiology' as never -> rejects.toThrow() */)
  it('inserts an imaging_result document carrying a labOrderId and the order\'s patientId', /* expect row.documentType === 'imaging_result', row.labOrderId === order.id, row.admissionId === null */)
  it('defaults labOrderId to null on a document with no order', /* expect row.labOrderId === null */)
  it('rejects a labOrderId that references no lab order', /* labOrderId: 2_000_000_000 -> rejects.toThrow() */)
})
```

The fourth and sixth cases need a throwaway `labOrders` row; build it the way `tests/db/lab-schema.test.ts` does, but select the seed patient with a **narrow** select — `db.select({ id: patients.id }).from(patients).limit(1)` — never `select().from(patients)`, per finding 3.

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/imaging-schema.test.ts`
Expected: FAIL — `category` / `labOrderId` are not properties of the Drizzle insert types (a TS/runtime error on an unknown column), not yet a DB error.

- [ ] **Step 4: Update `src/db/schema.ts`, `src/db/seed.ts`, and `src/lib/document-types.ts`**

In `schema.ts`:
- Append `'imaging_result'` as the tenth and last value of `documentTypeEnum`.
- Add to `documents`, directly under `admissionId`: `labOrderId: integer('lab_order_id').references(() => labOrders.id)`, with a comment that it is set only by the order-scoped upload route (which derives `patientId` from the order), never by the generic documents routes, so the two can never disagree.
- Declare `export const labTestCategoryEnum = pgEnum('lab_test_category', ['lab', 'imaging'])` beside the existing `labOrderStatusEnum`/`labResultFlagEnum`, and add `category: labTestCategoryEnum('category').default('lab').notNull()` to `labTests` between `code` and `defaultUnit`. Comment it as a catalog-level property: whether a study produces an image belongs to the test, not to one patient's order for it.

In `seed.ts`, widen `LAB_TESTS_SEED`'s inline literal type from `referenceRange: string` to `referenceRange: string | null`, add `category: 'lab' | 'imaging'` to it, mark the ten existing rows `category: 'lab'`, and append exactly these six rows (values are spec §3a's table, verbatim):

| name | code | category | defaultUnit | referenceRange |
|---|---|---|---|---|
| X-Ray, chest, 2 view | XR-CHEST-2V | imaging | null | null |
| X-Ray, chest, 1 view | XR-CHEST-1V | imaging | null | null |
| X-Ray, wrist | XR-WRIST | imaging | null | null |
| X-Ray, knee | XR-KNEE | imaging | null | null |
| CT, head, without contrast | CT-HEAD-NC | imaging | null | null |
| Ultrasound, abdominal | US-ABD | imaging | null | null |

`seedLabTests()` itself is unchanged — it is already idempotent by `code`. Update the `console.log('Seeded lab test catalog (10 tests).')` line to say 16.

In `document-types.ts`, add `| 'imaging_result'` to the `DocumentType` union and `imaging_result: 'Imaging Result',` to `DOCUMENT_TYPE_TEXT`.

- [ ] **Step 5: Fix `deletePatient`'s FK ordering (Review Focus #2)**

In `src/lib/queries/patients.ts`, `labOrderIds` is already computed at line ~262. Immediately before `await db.delete(labOrders).where(eq(labOrders.patientId, anonId))`, add the null-out that mirrors the existing `admissionId` one at line ~229:

```ts
// documents.lab_order_id is a nullable FK to lab_orders(id) with no ON
// DELETE action. Documents filed to this patient are already gone (line
// ~228), but an un-filed document (PATCH { patientId: null }, which clears
// patientId and leaves labOrderId alone) can still point at one of this
// patient's orders -- exactly the case the patient-scoped delete above
// misses and this delete would collide with.
if (labOrderIds.length > 0) {
  await db.update(documents).set({ labOrderId: null }).where(inArray(documents.labOrderId, labOrderIds))
}
```

- [ ] **Step 6: Write the failing FK test**

Create `tests/lib/queries/delete-patient-lab-order-document-fk.test.ts`. It must **not** call `deletePatient()` — that would really delete a seeded patient from the shared DB. Use `tests/lib/queries/delete-patient-document-admission-fk.test.ts`'s technique: throwaway rows, the same scoped statements, assert the constraint. Two tests:

- *"deleting a lab order fails while a document references it, and succeeds once the reference is cleared"* — throwaway `labTests` + `labOrders` rows, then a `documents` row with that `labOrderId` and `patientId: null`; assert `db.delete(labOrders).where(eq(labOrders.id, id))` rejects with Postgres SQL state `23503`; null out `documents.labOrderId`; assert the same delete now succeeds. Clean up both rows in `afterEach` regardless.
- *"deletePatient's source nulls out documents.labOrderId before deleting labOrders"* — `readFileSync` `src/lib/queries/patients.ts` (same technique as `delete-patient-fk-guard.test.ts`), assert `indexOf("set({ labOrderId: null })") > -1` and that it is less than `indexOf('.delete(labOrders)')`.

- [ ] **Step 7: Extend `tests/lib/queries/lab-tests.test.ts`**

Add two cases to the existing describe block. Leave the existing `toBeGreaterThanOrEqual(10)` assertion alone — the six new rows do not break it, and re-pinning it to an exact count would make the catalog brittle.

```ts
it('includes the seeded imaging studies with a category of "imaging"', async () => {
  const all = await listLabTests()
  const chest = all.find((t) => t.code === 'XR-CHEST-2V')
  expect(chest).toBeDefined()
  expect(chest!.category).toBe('imaging')
  expect(chest!.defaultUnit).toBeNull()
  expect(chest!.referenceRange).toBeNull()
})

it('gives every catalog row a category, with the chemistry panels on "lab"', async () => {
  const all = await listLabTests()
  expect(all.every((t) => t.category === 'lab' || t.category === 'imaging')).toBe(true)
  expect(all.find((t) => t.code === 'TSH')!.category).toBe('lab')
})
```

- [ ] **Step 8: Run the tests — expect DB-level failures now, not type failures**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/imaging-schema.test.ts tests/lib/queries/delete-patient-lab-order-document-fk.test.ts tests/lib/queries/lab-tests.test.ts`
Expected: FAIL — `column "category" of relation "lab_tests" does not exist` / `column "lab_order_id" of relation "documents" does not exist`. The source-ordering test should already PASS after Step 5.

- [ ] **Step 9: Write and run the one-off migration script**

Scratch, not part of the repo. Create `migrate-imaging-scratch.ts` at the worktree root. Every statement is individually idempotent so a partial run is safely re-runnable. `ALTER TYPE ... ADD VALUE` must not share a transaction with a statement that uses the new value, so issue each `pool.query` separately (the `pg` Pool autocommits each one).

```ts
import { Pool } from 'pg'

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false } })

  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lab_test_category')
    THEN CREATE TYPE lab_test_category AS ENUM ('lab', 'imaging'); END IF; END $$;`)
  await pool.query(`ALTER TABLE lab_tests ADD COLUMN IF NOT EXISTS category lab_test_category NOT NULL DEFAULT 'lab'`)
  await pool.query(`ALTER TYPE document_type ADD VALUE IF NOT EXISTS 'imaging_result'`)
  await pool.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS lab_order_id INTEGER REFERENCES lab_orders(id)`)

  console.log('Imaging schema migration complete.')
  await pool.end()
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1) })
```

Run: `npx dotenv -e .env.local -- npx tsx migrate-imaging-scratch.ts`. If blocked by the permission classifier: stop, report it, do not retry with variations.

Re-run Step 1's `dbcheck-scratch.ts` and paste the output. Expect `lab_tests.category` present with default `'lab'::lab_test_category` and `is_nullable = NO`; `documents.lab_order_id` present and nullable; `lab_test_category` = `lab, imaging`; `document_type` = ten values ending in `imaging_result`.

Then `npx dotenv -e .env.local -- npm run db:seed` to insert the six catalog rows, and `rm migrate-imaging-scratch.ts dbcheck-scratch.ts`.

- [ ] **Step 10: Run the tests again to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/imaging-schema.test.ts tests/lib/queries/delete-patient-lab-order-document-fk.test.ts tests/lib/queries/lab-tests.test.ts tests/db/lab-schema.test.ts tests/db/documents-schema.test.ts tests/lib/queries/documents.test.ts`
Expected: PASS. The last three are regression checks that the additive change broke nothing.

Note for the report: `tests/api/lab-orders.test.ts` fails on this branch for an unrelated, pre-existing reason (finding 3) and is repaired in Task 4, not here.

- [ ] **Step 11: Commit**

```bash
git add src/db/schema.ts src/db/seed.ts src/lib/document-types.ts src/lib/queries/patients.ts tests/db/imaging-schema.test.ts tests/lib/queries/delete-patient-lab-order-document-fk.test.ts tests/lib/queries/lab-tests.test.ts
git commit -m "$(cat <<'EOF'
feat: add labTests.category, imaging_result documentType, and documents.labOrderId

EOF
)"
```

---

### Task 2: Document query layer — `labOrderId` on `createDocument`, and `listImagingForOrders()`

**Files:**
- Modify: `src/lib/queries/documents.ts` (`CreateDocumentInput`, new `listImagingForOrders`)
- Test: `tests/lib/queries/documents.test.ts` (extend), `tests/api/documents.test.ts` (extend — Review Focus #3), `tests/api/documents-receive.test.ts` (extend — Review Focus #3)

**Interfaces:**
- Consumes: `documents`, `labOrders` from `@/db/schema` (Task 1).
- Produces, from `@/lib/queries/documents` — consumed by Tasks 3, 4:

```ts
export interface CreateDocumentInput {
  // ...existing fields, unchanged...
  labOrderId: number | null   // NEW -- required in the object, nullable in value
}

export interface ImagingAttachment {
  id: number
  name: string
  fileUrl: string | null
  fileType: string
  filedAt: Date | null
  filedByName: string | null
}

export function listImagingForOrders(orderIds: number[]): Promise<Map<number, ImagingAttachment[]>>
```

- Note: `labOrderId` is a **required key** on `CreateDocumentInput` (value `number | null`), not optional. `POST /api/documents` must therefore pass `labOrderId: null` explicitly — that is the point: a new caller cannot silently omit the field.

- [ ] **Step 1: Write the failing tests**

Extend `tests/lib/queries/documents.test.ts` with a `listImagingForOrders` describe block. Create two throwaway `labOrders` rows and attach two documents to the first, one to the second, and one to neither.

```ts
it('returns an empty Map for an empty orderIds array without querying', async () => {
  expect(await listImagingForOrders([])).toEqual(new Map())
})

it('groups each order\'s attachments under its own id and excludes other orders\' documents', async () => {
  const map = await listImagingForOrders([orderA.id, orderB.id])
  expect(map.get(orderA.id)!.map((a) => a.id).sort()).toEqual([docA1.id, docA2.id].sort())
  expect(map.get(orderB.id)!.map((a) => a.id)).toEqual([docB.id])
  expect([...map.values()].flat().some((a) => a.id === unattachedDoc.id)).toBe(false)
})

it('omits an order that has no attachments from the Map entirely', async () => {
  const map = await listImagingForOrders([orderA.id, orderWithNoImages.id])
  expect(map.has(orderWithNoImages.id)).toBe(false)
})

it('carries name, fileUrl, fileType and the filing trail on each attachment', async () => {
  const [attachment] = (await listImagingForOrders([orderA.id])).get(orderA.id)!
  expect(attachment.name).toBe('chest-ap.jpg')
  expect(attachment.fileUrl).toBe('https://blob.test/imaging/x.jpg')
  expect(attachment.fileType).toBe('JPG')
  expect(attachment.filedByName).toBe('Dr. Chen')
  expect(attachment.filedAt).toBeInstanceOf(Date)
})
```

Extend `tests/api/documents.test.ts` with the Review Focus #3 guard on `PATCH /api/documents/[id]`:

```ts
it('rejects labOrderId as an unknown field (.strict() mass-assignment guard)', async () => {
  const res = await PATCH(patchReq(someDocId, { labOrderId: 1 }) as never, { params: Promise.resolve({ id: String(someDocId) }) })
  expect(res.status).toBe(400)
})
```

Extend `tests/api/documents-receive.test.ts` with the matching guard on `POST /api/documents`:

```ts
it('rejects a labOrderId form field (.strict() mass-assignment guard)', async () => {
  const file = new File([new Uint8Array([1, 2, 3])], 'scan.pdf', { type: 'application/pdf' })
  const res = await receiveDocument(formDataReq(baseFields({ labOrderId: '1' }), file) as never)
  expect(res.status).toBe(400)
  expect(vi.mocked(mockedPut)).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/documents.test.ts tests/api/documents.test.ts tests/api/documents-receive.test.ts`
Expected: the `listImagingForOrders` cases FAIL with "is not a function". The two `.strict()` guards should already PASS — they assert existing behavior; if either fails, that is a live security gap to report before continuing.

- [ ] **Step 3: Implement in `src/lib/queries/documents.ts`**

Add `labOrderId: number | null` to `CreateDocumentInput` (no other change to `createDocument` itself — it spreads `input` into `.values()`), and add `labOrderId: null` to `POST /api/documents`'s `createDocument({ ... })` call in `src/app/api/documents/route.ts` so the tree compiles. Do **not** add `labOrderId` to `UpdateDocumentInput` or to either route's Zod schema — spec §2c makes the patient/order invariant structural precisely by leaving it out.

Implement `listImagingForOrders(orderIds)`: return `new Map()` immediately when `orderIds.length === 0` (`inArray(x, [])` is a SQL footgun — see the short-circuit comment convention already used elsewhere in this codebase), otherwise one `select` of the six `ImagingAttachment` columns from `documents` `where inArray(documents.labOrderId, orderIds)`, ordered `asc(documents.id)` so multi-view strips render in upload order, reduced into the `Map`. Not cached — `documentsListCacheKey()` is list-wide and would return another query's rows on a hit.

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/documents.test.ts tests/api/documents.test.ts tests/api/documents-receive.test.ts tests/api/documents-delete.test.ts tests/api/documents-download.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/queries/documents.ts src/app/api/documents/route.ts tests/lib/queries/documents.test.ts tests/api/documents.test.ts tests/api/documents-receive.test.ts
git commit -m "$(cat <<'EOF'
feat: widen CreateDocumentInput with labOrderId and add batched listImagingForOrders

EOF
)"
```

---

### Task 3: `POST /api/lab-orders/[id]/imaging`

**Files:**
- Create: `src/app/api/lab-orders/[id]/imaging/route.ts`
- Test: `tests/api/lab-orders-imaging.test.ts` (new)

**Interfaces:**
- Consumes: `requireSession` from `@/lib/auth`; `logAudit` from `@/lib/audit`; `put` from `@vercel/blob`; `createDocument` from `@/lib/queries/documents` (Task 2); `markCollected` from `@/lib/queries/lab-orders`; `invalidateCache`, `documentsListCacheKey`, `patientDetailCacheKey` from `@/lib/cache`; `labOrders` from `@/db/schema`.
- Produces: `POST(request, { params }: { params: Promise<{ id: string }> })`. Success is `201` with `{ id, fileUrl }`.
- Follows the shape of `src/app/api/lab-orders/[id]/result/route.ts` (session → role gate → integer-id parse → act → `logAudit` → JSON) and the upload discipline of `src/app/api/documents/route.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/api/lab-orders-imaging.test.ts` with `// @vitest-environment node` on line 1 plus the realm-mismatch comment block copied in spirit from `tests/api/documents-receive.test.ts`. Mock `@/lib/auth` with a mutable `sessionRole`/`sessionName`, and `@vercel/blob` with `put: vi.fn(async (path) => ({ url: \`https://blob.test/${path}\` }))`. Build orders with a `seedOrder(status)` helper modelled on `tests/api/lab-orders-routes.test.ts`'s, but selecting the seed patient and provider with **narrow** selects (`select({ id: patients.id })`) per finding 3. `afterEach` deletes every created `documents`, `labResults`, and `labOrders` row and resets `sessionRole`.

```ts
describe('POST /api/lab-orders/[id]/imaging', () => {
  it('lets admin attach an image', /* 201 */)
  it('lets pi attach an image', /* 201 */)
  it('returns 403 for crc', /* and put not called */)
  it('returns 403 for frontdesk', /* and put not called */)

  it('creates the document and transitions an "ordered" order to collected', async () => {
    const order = await seedOrder('ordered')
    const res = await attach(order.id, jpegFile())
    expect(res.status).toBe(201)
    const [after] = await getDb().select().from(labOrders).where(eq(labOrders.id, order.id))
    expect(after.status).toBe('collected')
    expect(after.collectedAt).not.toBeNull()
  })

  it('leaves an already-collected order\'s status and collectedAt untouched', async () => {
    const order = await seedOrder('collected')   // collectedAt stamped at seed time
    await attach(order.id, jpegFile())
    const [after] = await getDb().select().from(labOrders).where(eq(labOrders.id, order.id))
    expect(after.status).toBe('collected')
    expect(after.collectedAt!.getTime()).toBe(order.collectedAt!.getTime())
  })

  it('accepts an attachment on a resulted order (addendum) without changing its status', /* 201, status stays 'resulted' */)

  it('returns 409 on a cancelled order and writes no document row', async () => {
    const order = await seedOrder('cancelled')
    const before = await countDocumentsFor(order.id)
    const res = await attach(order.id, jpegFile())
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('Cannot attach an image to a cancelled order')
    expect(await countDocumentsFor(order.id)).toBe(before)
    expect(vi.mocked(mockedPut)).not.toHaveBeenCalled()
  })

  it('returns 404 for an order id that does not exist', /* id 2_000_000_000 */)
  it('returns 400 for a non-integer order id', /* id 'abc' */)

  it('sets labOrderId, documentType, the order\'s patientId, and the session filing trail', async () => {
    const order = await seedOrder('ordered')
    const body = await (await attach(order.id, jpegFile())).json()
    const row = await getDocumentRow(body.id)
    expect(row.labOrderId).toBe(order.id)
    expect(row.documentType).toBe('imaging_result')
    expect(row.patientId).toBe(order.patientId)
    expect(row.filedByName).toBe(sessionName)
    expect(row.filedAt).not.toBeNull()
    expect(row.status).toBe('new')
    expect(row.fileType).toBe('JPG')
    expect(row.fileUrl).toContain('https://blob.test/imaging/')
    expect(row.name).toBe('chest-ap.jpg')
  })

  it('accepts application/pdf (a radiology report)', /* fileType === 'PDF' */)
  it('rejects application/dicom before calling put', /* 400, put not called */)
  it('rejects a zero-byte file before calling put', /* 400, put not called */)
  it('rejects a file over 16MB before calling put', /* new File([new Uint8Array(16*1024*1024 + 1)], ...) -> 400, put not called */)
  it('rejects an unrecognized form field', /* fd.set('patientId', 'X') -> 400, put not called */)
  it('uses an explicit name field over the uploaded filename', /* fd.set('name', 'Chest AP view') -> row.name === 'Chest AP view' */)

  it('produces two rows for two successive uploads against one order', async () => {
    const order = await seedOrder('ordered')
    await attach(order.id, jpegFile('view1.jpg'))
    await attach(order.id, jpegFile('view2.jpg'))
    expect(await countDocumentsFor(order.id)).toBe(2)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/lab-orders-imaging.test.ts`
Expected: FAIL — the module `@/app/api/lab-orders/[id]/imaging/route` cannot be resolved.

- [ ] **Step 3: Implement the route**

Create `src/app/api/lab-orders/[id]/imaging/route.ts`.

Module constants, pinned by the tests above:

```ts
const ALLOWED_TYPES: Record<string, string> = {
  'application/pdf': 'PDF',
  'image/jpeg': 'JPG',
  'image/png': 'PNG',
  'image/webp': 'WEBP',
}
const MAX_BYTES = 16 * 1024 * 1024   // double the generic route's 8MB -- a diagnostic film is not a phone snapshot of an insurance card
const attachImagingSchema = z.object({ name: z.string().trim().min(1) }).strict()
```

`export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> })`, in this order:

1. `requireSession()`; `if (session instanceof NextResponse) return session`. Role gate `['admin', 'pi']` → 403. Same tier as `result/route.ts`, deliberately **not** the generic documents tier — add a comment saying so and why (spec §5).
2. `const orderId = Number((await params).id)`; `if (!Number.isInteger(orderId))` → 400 `'Invalid order id'`.
3. `request.formData()`; `file` must be a `File` → 400 `'file is required'`. Reject in this order, each **before** `put()`: unknown MIME → 400 `'File must be a PDF, JPEG, PNG, or WebP'`; `file.size === 0` → 400 `'File is empty'`; `file.size > MAX_BYTES` → 400 `'File must be under 16MB'`.
4. Build the parse target from the non-`file` string entries exactly the way `POST /api/documents` does (skip `''`, default `name` to `file.name` when absent, then `safeParse`) so `.strict()` still rejects a client that tries to send `patientId`/`labOrderId`/`filedByName`. Invalid → 400 `'Invalid imaging payload'` with `parsed.error.flatten()`.
5. Load the order with a narrow select — `select({ id, patientId, status }).from(labOrders).where(eq(labOrders.id, orderId))`. Missing → 404 `'Not found'`. `status === 'cancelled'` → 409 `'Cannot attach an image to a cancelled order'`.
6. `put(\`imaging/${orderId}-${crypto.randomUUID()}-${file.name}\`, file, { access: 'public' })`. Blob before DB, matching `POST /api/documents` — an orphaned blob is invisible and cheap; a row pointing at bytes that were never stored is a broken link in a chart.
7. `createDocument({ name, documentDate: <today as YYYY-MM-DD>, receivedFrom: session.name, documentType: 'imaging_result', patientId: order.patientId, admissionId: null, labOrderId: orderId, fileUrl: blob.url, fileType, filedByName: session.name, filedAt: new Date() })`. `status` is left to the DB default (`'new'`).
8. `if (order.status === 'ordered') await markCollected(orderId)` — the return value is deliberately ignored; a racing transition means someone else already collected the order, which does not invalidate the upload that just succeeded. Add that as a comment.
9. `await invalidateCache(documentsListCacheKey())` and `await invalidateCache(patientDetailCacheKey(order.patientId))`.
10. `await logAudit(session, \`attached imaging to lab order ${orderId}\`, order.patientId)`; return `NextResponse.json({ id: created.id, fileUrl: created.fileUrl }, { status: 201 })`.

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/lab-orders-imaging.test.ts tests/api/lab-orders-routes.test.ts`
Expected: PASS. `lab-orders-routes.test.ts` is the regression check that the lifecycle guards are untouched.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/lab-orders/[id]/imaging/route.ts" tests/api/lab-orders-imaging.test.ts
git commit -m "$(cat <<'EOF'
feat: add order-scoped imaging upload route on the admin/pi tier

EOF
)"
```

---

### Task 4: `category` + `attachments` on both lab-order row shapes, and the `listWorklist` drift repair

**Files:**
- Modify: `src/lib/queries/lab-orders.ts` (`PatientLabOrderRow`, `WorklistRow`, both mappers, both list functions)
- Test: `tests/api/lab-orders.test.ts` (extend + repair its `makeOrder` helper)

**Interfaces:**
- Consumes: `listImagingForOrders`, `ImagingAttachment` from `@/lib/queries/documents` (Task 2); `labTests.category` (Task 1).
- Produces, from `@/lib/queries/lab-orders` — consumed by Tasks 5, 6:
  - `PatientLabOrderRow` gains `category: 'lab' | 'imaging'` and `attachments: ImagingAttachment[]` (always an array, never `null`)
  - `WorklistRow` gains the same two fields
  - `listOrdersForPatient` and `listWorklist` keep their existing signatures and now populate both.

**Deviation from spec §4, deliberate:** the spec says the calling Server Components compose `listWorklist()` with `listImagingForOrders()`. But spec §6 then asks the *query-layer* tests to assert `attachments` on those rows, which is only possible if the query populates it — and a row type that declares `attachments` while the function never sets it is a type that lies. So `listOrdersForPatient`/`listWorklist` each call `listImagingForOrders` themselves, one batched call after the join. No cycle is created: `documents.ts` does not import `lab-orders.ts`.

- [ ] **Step 1: Write the failing test**

First repair `tests/api/lab-orders.test.ts`'s `makeOrder` helper (line ~20) and any other `select().from(patients)` / `select().from(providers)` in the file: narrow them to `select({ id: patients.id })` / `select({ id: providers.id })`. This is Review Focus #1 — without it every test in this file 42703s before reaching an assertion.

Then add:

```ts
it('exposes the test category on every worklist row', async () => {
  const order = await makeOrder()
  const rows = await listWorklist()
  const row = rows.find((r) => r.id === order.id)!
  expect(['lab', 'imaging']).toContain(row.category)
})

it('returns attachments as an empty array, never null, for an order with no images', async () => {
  const order = await makeOrder()
  expect((await listWorklist()).find((r) => r.id === order.id)!.attachments).toEqual([])
  expect((await listOrdersForPatient(order.patientId)).find((r) => r.id === order.id)!.attachments).toEqual([])
})

it('returns an imaging order\'s own attachments on both surfaces, and no other order\'s', async () => {
  // two orders for the same patient, two documents on the first, one on the second
  expect(worklistRowA.attachments.map((a) => a.id).sort()).toEqual([docA1.id, docA2.id].sort())
  expect(worklistRowB.attachments.map((a) => a.id)).toEqual([docB.id])
  expect(patientRowA.attachments).toHaveLength(2)
})

it('resolves the patient name on the worklist without selecting retired patient columns', async () => {
  const order = await makeOrder()
  const row = (await listWorklist()).find((r) => r.id === order.id)!
  expect(typeof row.patientName).toBe('string')
  expect(row.patientName.length).toBeGreaterThan(0)
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/lab-orders.test.ts`
Expected: the new `category`/`attachments` cases FAIL on undefined properties. The `patientName` case FAILS with `42703 column "intakeq_client_id_encrypted" does not exist` — the pre-existing breakage, now pinned by a test.

- [ ] **Step 3: Repair `listWorklist`'s select and add the two fields**

In `src/lib/queries/lab-orders.ts`:

Replace `listWorklist`'s `select({ order: labOrders, test: labTests, patient: patients, provider: providers })` with a select that spreads `order`/`test` as today but takes only the narrow columns it needs from the other two: `patientName: sql<string>\`patients.name\`` and `providerName: providers.name`. Carry the same explanatory comment `src/lib/queries/documents.ts:26-40` uses: `schema.ts` on this branch still declares patient columns a sibling worktree's migration has already collapsed in the live DB, so a bare table spread 42703s. `mapWorklistRow` then reads `r.patientName` directly — **do not** reintroduce the `nameTebra ?? nameIntakeq` expression; those words are barred from new code by the Global Constraints, and the columns no longer exist.

Add `category: r.test.category` to both `mapWorklistRow` and `mapPatientOrderRow`, and add `category` + `attachments` to both row interfaces.

In each of `listOrdersForPatient` and `listWorklist`, after mapping: `const byOrder = await listImagingForOrders(mapped.map((r) => r.id))`, then return `mapped.map((r) => ({ ...r, attachments: byOrder.get(r.id) ?? [] }))`. The `?? []` is what makes `attachments` never null.

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/lab-orders.test.ts tests/lib/queries/lab-results-patient-scoping.test.ts tests/api/lab-orders-imaging.test.ts`
Expected: PASS — **all** of `tests/api/lab-orders.test.ts`, including the 8 cases that were failing before this task.

- [ ] **Step 5: Commit**

```bash
git add src/lib/queries/lab-orders.ts tests/api/lab-orders.test.ts
git commit -m "$(cat <<'EOF'
feat: expose test category and imaging attachments on both lab-order row shapes

EOF
)"
```

---

### Task 5: Worklist surface — attach control and thumbnail strip on `/labs`

**Files:**
- Create: `src/components/ImagingAttachmentStrip.tsx`, `src/components/AttachImagingModal.tsx`
- Modify: `src/components/LabWorklist.tsx` (`WorklistOrder`, `LabRow`, `LabWorklist`)
- Test: `tests/pages/lab-worklist-imaging.test.tsx` (new)

**Interfaces:**
- Consumes: `WorklistRow`'s `category` and `attachments` (Task 4); `POST /api/lab-orders/[id]/imaging` (Task 3).
- Produces, consumed by Task 6 as well as this task:
  - `AttachmentView` — the client-side mirror of `ImagingAttachment`: `{ id: number; name: string; fileUrl: string | null; fileType: string; filedAt: Date | null; filedByName: string | null }`, exported from `ImagingAttachmentStrip.tsx`
  - `ImagingAttachmentStrip({ attachments }: { attachments: AttachmentView[] })` — renders nothing when the array is empty. Built here once and imported by all three consumers (`LabWorklist`, `EnterLabResultModal`, `LabResultsSection`); do not inline a second copy.
  - `AttachImagingModal({ orderId, testName, onClose }: { orderId: number; testName: string; onClose: () => void })` — named export matching `EnterLabResultModal`'s signature convention.
- `WorklistOrder` (the client-side mirror of `WorklistRow`) gains `category: 'lab' | 'imaging'` and `attachments: AttachmentView[]`.
- `src/app/(dashboard)/labs/page.tsx` needs **no change** — it already passes `listWorklist()`'s rows straight through, and Task 4 populated the new fields there.

- [ ] **Step 1: Write the failing test**

Create `tests/pages/lab-worklist-imaging.test.tsx`, following the render-with-props convention of the existing `tests/pages/*.test.tsx` files (`@testing-library/react`, `vi.mock('next/navigation', ...)` for `useRouter`). Build `WorklistOrder` fixtures inline.

```tsx
it('shows Attach image on an ordered imaging row for admin', /* getByRole('button', { name: /attach image/i }) */)
it('shows Attach image on a collected imaging row for pi', /* present */)
it('does not render Attach image for crc', /* queryByRole(...) === null -- hidden, not disabled */)
it('does not render Attach image for frontdesk', /* null */)
it('does not render Attach image on a lab-category row', /* null, even for admin */)
it('does not render Attach image in the Resulted group', /* showActions={false} suppresses it */)
it('renders a thumbnail link per attachment pointing at the audited download route', () => {
  // order with two attachments
  const links = screen.getAllByRole('link', { name: /chest-ap\.jpg|chest-lat\.jpg/ })
  expect(links.map((l) => l.getAttribute('href'))).toEqual(['/api/documents/101/download', '/api/documents/102/download'])
})
it('renders the thumbnail strip on a resulted imaging row with no action buttons', /* links present, no Attach image button */)
it('renders no strip for an order with an empty attachments array', /* queryAllByRole('link') is empty */)
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/pages/lab-worklist-imaging.test.tsx`
Expected: FAIL — no "Attach image" button, no links.

- [ ] **Step 3: Create `ImagingAttachmentStrip`**

`'use client'`, exporting `AttachmentView` and `ImagingAttachmentStrip` per this task's Interfaces block. Returns `null` when `attachments.length === 0`. Otherwise a wrapped flex list; each entry is an `<a href={\`/api/documents/${a.id}/download\`}>` — the prerequisite plan's audit-logged redirect, so every *view* of a patient image is logged, not just the upload — wrapping an `<img src={a.fileUrl ?? undefined} alt={a.name}>` for `fileType` `JPG`/`PNG`/`WEBP`, and a text chip labelled with `a.name` for `PDF`. Title each link with `a.name` plus, when `filedByName` is set, who filed it and when.

- [ ] **Step 4: Create `AttachImagingModal`**

Model it on `EnterLabResultModal.tsx`'s exact structure (`'use client'`, `Dialog`/`DialogContent`/`DialogHeader`/`DialogTitle`/`DialogFooter`, local `submitting`/`error` state, `useRouter().refresh()` then `onClose()` on success, `body?.error ?? <fallback>` on failure). Body: a `<input type="file" aria-label="Imaging file" accept="image/jpeg,image/png,image/webp,application/pdf">` and an optional `<input aria-label="Name">` that defaults to the chosen file's name. Submit builds a `FormData` with `file` and, when the name input is non-empty and differs from the filename, `name` — then `fetch(\`/api/lab-orders/${orderId}/imaging\`, { method: 'POST', body: fd })` with **no** `Content-Type` header (the browser sets the multipart boundary). Title: `Attach Image — {testName}`. Submit button: `Attach image`, disabled without a file or while submitting.

- [ ] **Step 5: Wire both into `LabWorklist`/`LabRow`**

In `LabWorklist.tsx`: widen the `WorklistOrder` interface per this task's Interfaces block; add `const canAttachImaging = ['admin', 'pi'].includes(role)` beside the existing `canCollect`/`canResultOrCancel` lines, with a comment that this is the `enterResult` tier, not the generic-documents tier; add `attachFor` state and `onOpenAttach`/`canAttachImaging` to `rowProps`; render `{attachFor && <AttachImagingModal orderId={attachFor.id} testName={attachFor.testName} onClose={() => setAttachFor(null)} />}` alongside the existing `{resultFor && ...}`.

In `LabRow`: add an **Attach image** button in the existing action cluster under `showActions && o.category === 'imaging' && o.status !== 'cancelled' && canAttachImaging` — hidden entirely when the role lacks the tier, never greyed out (the `InsuranceCardUpload` convention). Below the header row, render `<ImagingAttachmentStrip attachments={o.attachments} />` unconditionally — the component self-suppresses when empty, and rendering it outside the `showActions` guard is what makes the Resulted and Cancelled groups show it read-only.

- [ ] **Step 6: Run the tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/pages/lab-worklist-imaging.test.tsx`
Expected: PASS.

- [ ] **Step 7: Verify against a real dev server**

Start `npx dotenv -e .env.local -- npm run dev`, mint an `admin` session cookie via `SignJWT` under `clinsync_demo_session` with the secret from `SESSION_SECRET`, order an `XR-CHEST-2V` for a seeded patient, then `curl -F file=@<a real jpeg> http://localhost:3000/api/lab-orders/<id>/imaging` with that cookie. Paste the 201 body, then `curl -sI http://localhost:3000/api/documents/<returned id>/download` and paste the 302 and its `location`. Then confirm the order is now `collected`. Paste every command and its real output — a narrated claim is not verification.

- [ ] **Step 8: Commit**

```bash
git add src/components/ImagingAttachmentStrip.tsx src/components/AttachImagingModal.tsx src/components/LabWorklist.tsx tests/pages/lab-worklist-imaging.test.tsx
git commit -m "$(cat <<'EOF'
feat: attach-image control and thumbnail strip on the lab worklist

EOF
)"
```

---

### Task 6: Chart surface — imaging in the order modal, the result modal, and the Medical Record page

**Files:**
- Modify: `src/components/OrderLabTestModal.tsx` (`LabTestOption`, `<optgroup>`s)
- Modify: `src/components/EnterLabResultModal.tsx` (`category` + `attachments` props, Impression mode)
- Modify: `src/components/LabResultsSection.tsx` (`PatientLabOrder`, strips on resulted and pending)
- Modify: `src/components/LabWorklist.tsx` (pass the two new props through to `EnterLabResultModal`)
- Modify: `src/lib/role-capabilities.ts` (`admin` and `pi` bullets)
- Test: `tests/pages/lab-results-section-imaging.test.tsx` (new), `tests/lib/role-capabilities.test.ts` (extend, if it exists — otherwise fold the assertion into the new file)

**Interfaces:**
- Consumes: `PatientLabOrderRow`'s `category`/`attachments` (Task 4); `labTests.category` via `listLabTests()` (Task 1); `ImagingAttachmentStrip` and `AttachmentView` from `@/components/ImagingAttachmentStrip` (Task 5) — import it, do not write a second strip.
- Produces: `LabTestOption` gains `category: 'lab' | 'imaging'`; `EnterLabResultModal` gains `category: 'lab' | 'imaging'` and `attachments: AttachmentView[]` props; `PatientLabOrder` gains `category: 'lab' | 'imaging'` and `attachments: AttachmentView[]`.
- `src/app/(dashboard)/patients/[anonId]/medical-record/page.tsx` needs **no change** — line 93 already passes `listOrdersForPatient(anonId)` and `listLabTests()` straight into `LabResultsSection`, and Tasks 1 and 4 populated the new fields upstream. Confirm this by reading the file; do not edit it if it type-checks.

- [ ] **Step 1: Write the failing test**

Create `tests/pages/lab-results-section-imaging.test.tsx`:

```tsx
it('renders an imaging impression with its flag pill and no unit or reference range', /* resulted imaging order, value 'No acute cardiopulmonary process.', unit null, referenceRange null */)
it('renders a thumbnail strip under a resulted imaging order', /* links to /api/documents/<id>/download */)
it('renders a thumbnail strip on a pending imaging order that already has attachments', /* the case the user actually asked about: the film is viewable before anyone has written a read */)
it('renders no strip for a pending order with no attachments', /* queryAllByRole('link') is empty */)
it('groups the order modal\'s options into Labs and Imaging optgroups', /* two <optgroup label="Labs"|"Imaging">, XR-CHEST-2V under Imaging */)
it('labels the result field Impression and hides unit/reference range for category "imaging"', /* getByLabelText('Impression') is a TEXTAREA; queryByLabelText('Unit') === null */)
it('keeps the Result value input and unit/reference range for category "lab"', /* the regression half */)
it('lists the order\'s existing attachments inside the result modal', /* so whoever writes the impression can see what they are reading */)
it('names imaging attachment on the admin and pi capability bullets', () => {
  for (const role of ['admin', 'pi'] as const) {
    expect(ROLE_CAPABILITIES[role].bullets.join(' ')).toContain('attach imaging results')
  }
  expect(ROLE_CAPABILITIES.frontdesk.bullets.join(' ')).not.toContain('attach imaging')
  expect(ROLE_CAPABILITIES.crc.bullets.join(' ')).not.toContain('attach imaging')
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/pages/lab-results-section-imaging.test.tsx`
Expected: FAIL — no optgroups, no Impression label, no strips, the capability string absent.

- [ ] **Step 3: `OrderLabTestModal` — optgroups**

Add `category: 'lab' | 'imaging'` to `LabTestOption`. Partition `labTests` into two arrays and render `<optgroup label="Labs">` / `<optgroup label="Imaging">`, each only when non-empty, keeping the existing `"Select a test…"` placeholder option and the existing `{t.name} ({t.code})` option text unchanged.

- [ ] **Step 4: `EnterLabResultModal` — Impression mode**

Add `category: 'lab' | 'imaging'` and `attachments: AttachmentView[]` props. When `category === 'imaging'`: render the value field as `<textarea aria-label="Impression" placeholder="Impression" rows={3}>` and do **not** render the Unit / Reference range inputs (they submit as `undefined`, which `enterResultSchema`'s existing `.optional()` fields already accept — no route change). Above the fields, render `<ImagingAttachmentStrip attachments={attachments} />`, so whoever writes the impression can see what they are reading. When `category === 'lab'`, the existing markup is unchanged. `POST /api/lab-orders/[id]/result` and `enterResult()` are **not** modified.

Update `LabWorklist.tsx`'s `<EnterLabResultModal ... />` call site to pass `category={resultFor.category}` and `attachments={resultFor.attachments}`.

- [ ] **Step 5: `LabResultsSection` — strips on both lists**

Add `category` and `attachments` to `PatientLabOrder`. In the resulted `<li>`, render `<ImagingAttachmentStrip attachments={o.attachments} />` beneath the existing result/reference/resulted-by lines. In the pending `<li>`, render it beneath the existing name/status row — this is the case the user actually asked about: the film is viewable on the chart before anyone has written a formal read. No upload control is added on this page; uploading belongs on the worklist (spec §4). The existing `{r.unit ? ...}` / `{r.referenceRange && ...}` conditionals already render nothing for imaging, because those catalog rows are null — leave them alone.

- [ ] **Step 6: `ROLE_CAPABILITIES`**

In `src/lib/role-capabilities.ts`, change the `admin` (line ~53) and `pi` (line ~37) lab bullets to read exactly: `'Order lab tests and manage the Lab worklist: mark samples collected, attach imaging results, enter results, and cancel orders'`. Leave `crc` (line ~20) and `frontdesk` (line ~69) untouched — neither gains the upload.

- [ ] **Step 7: Run the tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/pages/lab-results-section-imaging.test.tsx tests/pages/lab-worklist-imaging.test.tsx`
Expected: PASS.

- [ ] **Step 8: Full suite, lint, and build**

Run, pasting real output for each:
- `npx dotenv -e .env.local -- npx vitest run`
- `npm run lint`
- `npm run build`

- [ ] **Step 9: Verify the chart surface against a real dev server**

With the dev server running and an `admin` cookie, open the Medical Record page for the patient whose imaging order Task 5 attached to, and confirm the film renders in the Pending list before any impression is entered — then enter an impression through the modal and confirm it moves to the resulted list with its strip intact. Paste the HTTP status and the relevant fragment of the returned HTML for both states.

- [ ] **Step 10: Commit**

```bash
git add src/components/OrderLabTestModal.tsx src/components/EnterLabResultModal.tsx src/components/LabResultsSection.tsx src/components/LabWorklist.tsx src/lib/role-capabilities.ts tests/pages/lab-results-section-imaging.test.tsx
git commit -m "$(cat <<'EOF'
feat: surface imaging attachments on the medical record and in the result modal

EOF
)"
```
