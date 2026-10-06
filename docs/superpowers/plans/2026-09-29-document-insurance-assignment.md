# Document Receiving & Insurance Document Assignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the read-only Documents report into a real receive → tag → file workflow — a genuine upload endpoint backed by Vercel Blob, a file-to-patient action that does not exist today, download/delete affordances, and Unfiled/Not-yet-processed filter tabs — and route insurance paperwork (secondary cards, EOBs, authorizations) through that same pipeline via a widened `documentType`.

**Architecture:** Insurance documents are a `documentType` value inside the existing generic `documents` table, not a new table — the `label` column is renamed to `document_type` in place and its enum widened with six `insurance_*` values. `documents` gains `file_url` (the first real bytes this table has ever stored), a nullable `admission_id` FK into the already-built admissions/inpatient tracking, and `filed_by_name`/`filed_at` as a server-set filing audit trail. `InsuranceCardUpload` (`patients.primaryCard*Url`) is deliberately left untouched as a separate, narrower fast path for the one highest-frequency case; the two systems share a storage convention and nothing else, and this plan documents that boundary rather than reconciling them.

**Tech Stack:** Next.js 16 App Router (Server Components) + Drizzle ORM over a `pg` Pool (schema changes via a hand-written one-off script, never `drizzle-kit push`) + `@vercel/blob` (`put`/`del`) + Zod `.strict()` validation + vitest.

**Spec:** `docs/superpowers/specs/2026-09-29-document-insurance-assignment.md`

**Working directory note:** this plan is executed in an isolated git worktree at `/Users/k2a/Desktop/clinsync/.worktrees/document-assignment` on branch `feature/document-assignment`. This worktree has its own `.env.local` but, at plan time, **no `node_modules`** — Task 1 Step 0 installs them. Every implementer/reviewer dispatch for this plan must work from this exact directory, not the main checkout — the main checkout and every other active worktree (`.worktrees/esignatures`, `.worktrees/public-booking`, `.worktrees/unified-patient-record`, and ~15 others) have their own concurrent work in flight; do not touch them.

## Global Constraints

- **This plan's schema change is NOT additive, and that is the single biggest hazard here.** It renames a type (`document_label` → `document_type`) and a column (`documents.label` → `documents.document_type`) on an **existing** table in a **single shared Neon Postgres database used by every branch and worktree simultaneously**. The moment Task 1's migration runs, every other worktree's checked-out code that reads `documents.label` starts failing at runtime until it rebases onto this branch. That is an accepted, spec-mandated consequence (spec §2 rejects a parallel column), not a bug to route around — but it means Task 1's migration and its `schema.ts`/`seed.ts`/`DocumentsReportTable.tsx` updates must land in **one commit**, and the Task 1 report must state plainly that the shared DB has been renamed. This session's history already contains one real incident from adding a `NOT NULL` column with no default to a shared existing table; this change is in the same risk class.
- Apply schema changes via a hand-written one-off script run with `npx dotenv -e .env.local -- npx tsx <script>` — never `drizzle-kit push`, never `drizzle-kit generate`.
- `psql` is not installed in this environment — verify a migration's live-DB effect with a Node script using `pg`'s `Pool` and an `information_schema.columns` query.
- Every write route uses `.strict()` Zod validation.
- Every state-changing route calls `logAudit(session, <action>, <patientId or null>)`. `logAudit` takes a real non-null `Session` by its own type signature (`src/lib/audit.ts`) — that is a deliberate compile-time guard, not an inconvenience.
- Every protected route starts with `requireSession()` (API routes) or `requireSessionOrRedirect()` (pages) as its first statement.
- Role gating per spec §7, enforced in code, not just described: read/download = `admin`, `pi`, `crc`, `frontdesk`; receive (`POST`) / file / re-file / un-file / re-type / mark-processed (`PATCH`) = `admin`, `crc`, `frontdesk` (**not** `pi`); delete = `admin` only. Note that `PATCH /api/documents/[id]` has **no role gate at all** today — adding one is an intentional tightening this plan owns, matching spec §7.
- Server-set fields are never client-supplied: `filedByName` comes from `session.name` and `filedAt` from `new Date()` inside the route, never from the request body. `.strict()` rejects a client that tries.
- Commit messages end with no attribution trailer.
- UI verification discipline: verify via a real running dev server hit with real HTTP requests (mint a staff session cookie the way `src/lib/auth.ts` actually does it — `SignJWT` under cookie `clinsync_demo_session`, secret from `SESSION_SECRET`), with actual commands and actual output pasted in the report. Never a narrated, unreproduced claim — this codebase's own session history includes a prior implementer fabricating UI verification evidence and being caught; do not repeat that.
- Vitest invocation: `npx dotenv -e .env.local -- npx vitest run <path>` (`fileParallelism: false`, `testTimeout: 15000`).
- Routes that read `request.formData()` need `// @vitest-environment node` at the top of their test file — jsdom's `File` fails undici's webidl brand check. See the comment block at the top of `tests/api/patients-insurance-card.test.ts`.

## Scope Decisions

These are plan-time rulings on the two questions the spec's own self-review (§9, Ambiguity check) left open, plus two smaller calls the spec does not pin. The implementer follows them; they are not open for re-derivation mid-task.

1. **Pre-existing seeded `documents` rows with a `patientId` but no filing audit trail keep `filedByName`/`filedAt` as `NULL`. Confirmed, not overridden.** A synthetic backfill would write a name and a timestamp for a filing action that never happened, into the exact columns whose only purpose is to record who did what — the same fabrication `src/lib/audit.ts`'s own comment exists to prevent ("A prior version defaulted to `role: 'crc'` for a null session, which fabricated a real staff role for an unknown principal in the exact compliance artifact this product's pitch rests on"). A cosmetic gap in a demo is recoverable; a fabricated audit attribution that a reviewer later believes is not. The cost is paid in the UI instead: Task 4 renders a null `filedByName` as the literal string **"Filed before filing history was tracked"** (not an empty cell, not a dash) so the gap reads as a known, dated boundary rather than a rendering bug. A demo that needs populated filing data reseeds through the real `POST /api/documents` route, which sets these columns honestly.
2. **`POST /api/documents` accepts `application/pdf` in addition to `image/jpeg`, `image/png`, `image/webp`. `InsuranceCardUpload` stays image-only. The divergence is intended.** The two routes have different jobs, and the image-only allowlist on the insurance-card route is a **rendering** constraint, not a security posture: it writes to `patients.primaryCardFrontUrl`/`primaryCardBackUrl`, which the Medical Record page renders as a plain `<img src>` — a PDF there is a broken image, so the route rejects one at the door. The generic Documents route has no such constraint: `fileUrl` is only ever reached through a redirecting download link, which serves any type correctly. And the real intake stream this route exists to receive — faxes, EOBs, prior-authorization letters, scanned card copies arriving by mail — is overwhelmingly PDF; rejecting PDF would leave the new receive flow unable to accept the majority of what it was built for. Both halves get a pinned regression test (Task 2: the generic route accepts a PDF; Task 5 confirms `tests/api/patients-insurance-card.test.ts`'s existing "rejects a non-image content type" case, which uses exactly an `application/pdf` file, still passes unchanged), so a future implementer who "harmonizes" the two allowlists breaks a test instead of silently breaking intake.
3. **Un-filing (`PATCH` with `patientId: null`) clears `filedByName`, `filedAt`, and `admissionId` in the same write.** A document with no patient that still names a filer, or still points at some patient's inpatient stay, is a cross-link to a chart it is no longer filed to — precisely the forgery class Review Focus #2 guards against on the way in. Re-filing to a *different* patient likewise clears `admissionId` unless the same request supplies a new one that validates against the new patient.
4. **`fileType` is derived server-side from the uploaded file's MIME type, not accepted as a form field**, and the size cap is 8 MB (`MAX_BYTES = 8 * 1024 * 1024`), mirroring `insurance-card/route.ts`. `fileType` is `NOT NULL` display metadata (`"PDF"`/`"JPG"`/`"PNG"`/`"WEBP"`); asking a coordinator to re-type what the file already says is a field that can only ever disagree with reality.

## Review Focus

1. **Deleting a patient who has an admission-linked document.** `deletePatient()` (`src/lib/queries/patients.ts`) deletes `admissions` *before* `documents` today. The moment `documents.admission_id` exists as an FK with no `ON DELETE` action, that ordering raises a 23503 mid-cascade and leaves a half-deleted chart — the fourth instance of the exact bug class `tests/lib/queries/delete-patient-fk-guard.test.ts` was written to catch. (Task 1)
2. **A forged or mismatched `admissionId` cross-linking a document to a different patient's inpatient stay.** Both `POST` and `PATCH` take a raw integer `admissionId` from the client; neither may trust it. The admission must exist *and* belong to the document's effective `patientId`, or the request is rejected — same cross-entity-forgery class this codebase's other plans have found and fixed. (Task 2, Task 3)
3. **Un-filing leaving a stale filing trail behind.** `PATCH { patientId: null }` must clear `filedByName`, `filedAt`, and `admissionId` together; an "Unfiled" document that still reports "Filed by Jamie Ruiz" under Admission #14 is worse than no filing data at all. (Task 3)
4. **A disallowed or oversize file reaching Blob storage through the one route in this app that genuinely stores bytes.** `text/html`, `application/octet-stream`, a zero-byte file, and a >8 MB file must all be rejected *before* `put()` is called, not after. (Task 2)
5. **The asymmetric role split actually enforced on every verb.** `pi` reads and downloads but gets 403 from `POST` and from every `PATCH` field including the pre-existing `status`; `crc`/`frontdesk` write but get 403 from `DELETE`. One role list reused across all four verbs is the failure. (Task 2, Task 3)

---

### Task 1: Schema — `document_type` enum rename/widening, `admission_id`/`file_url`/`filed_by_name`/`filed_at`

**Files:**
- Modify: `src/db/schema.ts:693-706`
- Modify: `src/db/seed.ts:325-336` (the ten seeded `documents` rows use `label:`)
- Modify: `src/lib/queries/patients.ts` (`deletePatient` FK ordering — Review Focus #1)
- Modify: `src/components/DocumentsReportTable.tsx` (mechanical `label` → `documentType` rename so the tree compiles; the real UI work is Task 4)
- Test: `tests/db/documents-schema.test.ts` (new), `tests/lib/queries/delete-patient-document-admission-fk.test.ts` (new)

**Interfaces:**
- Produces: `documentTypeEnum` (`'other' | 'drivers_license' | 'legal_document' | 'insurance_card_primary_front' | 'insurance_card_primary_back' | 'insurance_card_secondary_front' | 'insurance_card_secondary_back' | 'insurance_eob' | 'insurance_authorization'`), and the widened `documents` table with `documentType`, `admissionId`, `fileUrl`, `filedByName`, `filedAt`. Consumed by Tasks 2–5.
- Note for later tasks: `documentLabelEnum` no longer exists under that name. Import `documentTypeEnum`.

- [ ] **Step 0: Install dependencies**

This worktree has no `node_modules`. Run `npm install` from `/Users/k2a/Desktop/clinsync/.worktrees/document-assignment` before anything else. Confirm with `npx vitest --version`.

- [ ] **Step 1: Write the failing test**

Create `tests/db/documents-schema.test.ts`. Follow `tests/db/booking-requests-schema.test.ts`'s shape (real DB, `afterEach` cleanup of only the ids this file created). Assertions:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { documents, admissions } from '@/db/schema'

const createdIds: number[] = []
afterEach(async () => {
  while (createdIds.length > 0) await getDb().delete(documents).where(eq(documents.id, createdIds.pop()!))
})

describe('documents schema — documentType, admissionId, fileUrl, filing audit', () => {
  it('inserts an insurance_eob document with a blob URL and no patient (Unfiled)', async () => {
    const [row] = await getDb().insert(documents).values({
      name: 'EOB - Aetna 2026-09.pdf', documentDate: '2026-09-20', receivedFrom: 'Mail',
      documentType: 'insurance_eob', fileType: 'PDF', fileUrl: 'https://blob.test/documents/x.pdf',
    }).returning()
    createdIds.push(row.id)
    expect(row.status).toBe('new')
    expect(row.patientId).toBeNull()
    expect(row.admissionId).toBeNull()
    expect(row.filedByName).toBeNull()
    expect(row.filedAt).toBeNull()
  })

  it('accepts every new insurance_* documentType value', async () => {
    for (const documentType of ['insurance_card_primary_front', 'insurance_card_primary_back', 'insurance_card_secondary_front', 'insurance_card_secondary_back', 'insurance_eob', 'insurance_authorization'] as const) {
      const [row] = await getDb().insert(documents).values({
        name: `${documentType}.pdf`, documentDate: '2026-09-20', receivedFrom: 'Fax', documentType, fileType: 'PDF',
      }).returning()
      createdIds.push(row.id)
      expect(row.documentType).toBe(documentType)
    }
  })

  it('stores an admissionId referencing a real admission, alongside its patient and filing trail', async () => {
    const [admission] = await getDb().select().from(admissions).limit(1)
    const [row] = await getDb().insert(documents).values({
      name: 'Inpatient consent.pdf', documentDate: '2026-09-21', receivedFrom: 'Ward B',
      documentType: 'legal_document', fileType: 'PDF', patientId: admission.patientId,
      admissionId: admission.id, filedByName: 'Jamie Ruiz', filedAt: new Date(),
    }).returning()
    createdIds.push(row.id)
    expect(row.admissionId).toBe(admission.id)
    expect(row.filedByName).toBe('Jamie Ruiz')
  })

  it('rejects a documentType outside the enum', async () => {
    await expect(getDb().insert(documents).values({
      name: 'x', documentDate: '2026-09-21', receivedFrom: 'Fax',
      documentType: 'not_a_real_type' as never, fileType: 'PDF',
    })).rejects.toThrow()
  })

  it('leaves the pre-existing seeded rows readable with their original type values and a null filing trail', async () => {
    const rows = await getDb().select().from(documents).where(eq(documents.id, 1))
    expect(['other', 'drivers_license', 'legal_document']).toContain(rows[0].documentType)
    expect(rows[0].fileUrl).toBeNull()
    expect(rows[0].filedByName).toBeNull() // Scope Decision 1: no synthetic backfill
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/documents-schema.test.ts`
Expected: FAIL — `documentType` is not a property of the insert type (TS/runtime error on the unknown column), not a DB error.

- [ ] **Step 3: Update `src/db/schema.ts`**

Replace `documentLabelEnum` with `documentTypeEnum` carrying the nine values listed in this task's Interfaces block, and rewrite the `documents` table body to spec §2:

- `documentType: documentTypeEnum('document_type').default('other').notNull()` (replacing `label`)
- `admissionId: integer('admission_id').references(() => admissions.id)` — nullable, independent of `patientId`
- `fileUrl: text('file_url')` — nullable
- `filedByName: text('filed_by_name')`, `filedAt: timestamp('filed_at')` — nullable, server-set

Replace the existing `fileType` comment (`// metadata only, e.g. "PDF" / "JPG" -- no file is ever stored`), which is now false, with one saying `fileType` is display metadata derived from the uploaded file's MIME type, and that `fileUrl` is null only for pre-`2026-09-29` metadata-only rows. Add a short comment on `admissionId` explaining it is set only when staff explicitly associate the document with a stay, is never derived from "whatever admission is active now," and is cleared whenever `patientId` changes or is cleared.

`documents` is declared at line ~697 and `admissions` at ~555, so `admissions` is already in scope.

- [ ] **Step 4: Update `src/db/seed.ts` and `src/components/DocumentsReportTable.tsx`**

In `seed.ts`, rename the `label:` key to `documentType:` in all ten seeded `documents` rows (values unchanged — the three existing values are a strict subset of the new enum). Leave `clearExistingData()` alone: it already deletes `documents` before `admissions`.

In `DocumentsReportTable.tsx`, do the mechanical rename only: `DocumentReportRow.label` → `documentType` typed as the full nine-value union, `LABEL_TEXT` → `DOCUMENT_TYPE_TEXT` (**exported** — Task 4's receive modal reuses this exact map for its type `<select>`, and two divergent copies of these display strings is how the dropdown and the table start disagreeing) widened with display strings for all six new values (`'Insurance Card — Primary Front'`, `'Insurance Card — Primary Back'`, `'Insurance Card — Secondary Front'`, `'Insurance Card — Secondary Back'`, `'Insurance EOB'`, `'Insurance Authorization'`), the `filterFields` key `label` → `documentType` with label text `'Document Type'`, the column entry, and the `matchesFilters` branch. No new behavior in this task.

- [ ] **Step 5: Fix `deletePatient`'s FK ordering (Review Focus #1)**

In `src/lib/queries/patients.ts`, the current order is `... admissionTransfers → admissions → ... → documents ...`. Move the `documents` delete to **before** `admissionTransfers`, and immediately before it add a null-out for any document still pointing at one of this patient's admissions but not filed to this patient:

```ts
// documents.admission_id is a nullable FK to admissions(id) with no ON
// DELETE action -- the same ordering hazard already documented above for
// medicationAdministrations and doctorAssignments. Documents filed to this
// patient go first; the update then catches the pathological case of a
// document filed to someone else (or Unfiled) that still references one of
// this patient's admissions, which the DB permits even though the routes
// never create it.
await db.delete(documents).where(eq(documents.patientId, anonId))
if (patientAdmissionIds.length > 0) {
  await db.update(documents).set({ admissionId: null }).where(inArray(documents.admissionId, patientAdmissionIds))
}
```

`patientAdmissionIds` is already computed earlier in the function. Remove the now-duplicated `documents` delete from its old position.

- [ ] **Step 6: Write the failing FK-ordering test**

Create `tests/lib/queries/delete-patient-document-admission-fk.test.ts`. It must **not** call `deletePatient()` — that would really delete a seeded patient from the shared DB. Follow `tests/db/seed-clear-existing-data-fk-order.test.ts`'s technique instead: create throwaway rows, issue the same scoped statements, assert the constraint. Two tests:

- *"deleting an admission fails while a document references it, and succeeds once the document is gone"* — insert a throwaway `admissions` row (seeded `patients` and `providers` rows supply `patientId`/`attendingProviderId`), insert a `documents` row with that `admissionId`, assert `db.delete(admissions).where(eq(admissions.id, id))` rejects with Postgres SQL state `23503`, then delete the document and assert the same delete now succeeds. Clean up both rows in `afterEach` regardless.
- *"deletePatient's source deletes documents before admissions"* — `readFileSync` `src/lib/queries/patients.ts` (same technique as `delete-patient-fk-guard.test.ts`), find `indexOf('.delete(documents)')` and `indexOf('.delete(admissions)')`, assert both are `> -1` and the documents index is the smaller.

- [ ] **Step 7: Run both tests — expect a DB-level failure now, not a type failure**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/documents-schema.test.ts tests/lib/queries/delete-patient-document-admission-fk.test.ts`
Expected: FAIL — `column "document_type" of relation "documents" does not exist` (the live DB hasn't been migrated yet). The source-ordering test should already PASS after Step 5.

- [ ] **Step 8: Write and run the one-off migration script**

Scratch, not part of the repo. Create `migrate-documents-scratch.ts` at this worktree's root. Every statement is individually idempotent so a partial run can be re-run safely. `ALTER TYPE ... ADD VALUE` must not share a transaction with a statement that uses the new value, so issue each `pool.query` separately (the `pg` Pool autocommits each one):

```ts
import { Pool } from 'pg'

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false } })

  // Rename the type and the column in place, each guarded so a re-run is a no-op.
  await pool.query(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'document_label')
       AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'document_type')
    THEN ALTER TYPE document_label RENAME TO document_type; END IF; END $$;`)
  await pool.query(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'documents' AND column_name = 'label')
    THEN ALTER TABLE documents RENAME COLUMN label TO document_type; END IF; END $$;`)

  for (const value of ['insurance_card_primary_front', 'insurance_card_primary_back', 'insurance_card_secondary_front', 'insurance_card_secondary_back', 'insurance_eob', 'insurance_authorization']) {
    await pool.query(`ALTER TYPE document_type ADD VALUE IF NOT EXISTS '${value}'`)
  }

  await pool.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS admission_id INTEGER REFERENCES admissions(id)`)
  await pool.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_url TEXT`)
  await pool.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS filed_by_name TEXT`)
  await pool.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS filed_at TIMESTAMP`)

  console.log('Documents schema migration complete.')
  await pool.end()
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1) })
```

Run: `npx dotenv -e .env.local -- npx tsx migrate-documents-scratch.ts`. If blocked by the permission classifier: stop, report it, do not retry with variations.

Verify with a Node script (no `psql` here): `SELECT column_name FROM information_schema.columns WHERE table_name = 'documents'` (expect `document_type`, `admission_id`, `file_url`, `filed_by_name`, `filed_at`, and **no** `label`) and `SELECT enumlabel FROM pg_enum JOIN pg_type ON pg_type.oid = enumtypid WHERE typname = 'document_type'` (expect nine values). Paste both outputs.

Delete the scratch script once confirmed: `rm migrate-documents-scratch.ts`.

- [ ] **Step 9: Run the tests again to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/documents-schema.test.ts tests/lib/queries/delete-patient-document-admission-fk.test.ts tests/lib/queries/documents.test.ts tests/api/documents.test.ts tests/lib/queries/delete-patient-fk-guard.test.ts`
Expected: PASS. The last three are regression checks that the rename didn't break existing behavior.

- [ ] **Step 10: Commit (one commit — see Global Constraints)**

```bash
git add src/db/schema.ts src/db/seed.ts src/lib/queries/patients.ts src/components/DocumentsReportTable.tsx tests/db/documents-schema.test.ts tests/lib/queries/delete-patient-document-admission-fk.test.ts
git commit -m "$(cat <<'EOF'
feat: rename documents.label to documentType, widen the enum, add file/admission/filing columns

EOF
)"
```

---

### Task 2: Query layer + `POST /api/documents` (the receive endpoint)

**Files:**
- Modify: `src/lib/queries/documents.ts`
- Create: `src/app/api/documents/route.ts`
- Test: `tests/lib/queries/documents.test.ts` (extend), `tests/api/documents-receive.test.ts` (new)

**Interfaces:**
- Consumes: `documents`, `documentTypeEnum`, `admissions`, `patients` from `@/db/schema` (Task 1); `requireSession` from `@/lib/auth`; `logAudit` from `@/lib/audit`; `invalidateCache`, `documentsListCacheKey`, `patientDetailCacheKey` from `@/lib/cache`; `put` from `@vercel/blob`.
- Produces, from `@/lib/queries/documents` — consumed by Tasks 3 and 4:

```ts
export type DocumentRow = typeof documents.$inferSelect
export type DocumentType = (typeof documentTypeEnum.enumValues)[number]

export interface CreateDocumentInput {
  name: string; documentDate: string; receivedFrom: string; documentType: DocumentType
  patientId: string | null; admissionId: number | null
  fileUrl: string | null; fileType: string
  filedByName: string | null; filedAt: Date | null
}
export async function createDocument(input: CreateDocumentInput): Promise<DocumentRow>
export async function listDocumentsForPatient(patientId: string): Promise<DocumentRow[]>
export async function isAdmissionForPatient(admissionId: number, patientId: string): Promise<boolean>
```

- [ ] **Step 1: Write the failing query-layer tests**

Extend `tests/lib/queries/documents.test.ts` (keep its two existing tests). Add an `afterEach` that deletes only ids this file created, and:

- `createDocument` with `patientId: null` returns a row with `status: 'new'`, `patientId`/`filedByName`/`filedAt`/`admissionId` all null, and the given `fileUrl`.
- `createDocument` with a real `patientId` and `filedByName`/`filedAt` supplied returns them set.
- `listDocumentsForPatient('RD-0001')` returns only rows whose `patientId` is `'RD-0001'`, and each returned row has an `admissionId` property (spec §6.3 — the field is available to callers even when null).
- `listDocumentsForPatient` returns `[]` for a patient id with no documents.
- `isAdmissionForPatient(<a real admission's id>, <that admission's patientId>)` is `true`; the same admission id paired with a *different* seeded patient's id is `false`; a non-existent admission id is `false`.

- [ ] **Step 2: Run to confirm failure**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/documents.test.ts`
Expected: FAIL — the new functions are not exported.

- [ ] **Step 3: Implement the query-layer additions in `src/lib/queries/documents.ts`**

Add the four exports from this task's Interfaces block. `createDocument` is an `insert(...).values(input).returning()`; it invalidates nothing (the route owns cache invalidation, matching `insurance-card/route.ts`'s precedent of invalidating at the route). `listDocumentsForPatient` selects from `documents` where `patientId` matches, ordered `desc(documents.documentDate), desc(documents.id)` to match `listDocuments()`; it is **not** cached (no per-patient documents cache key exists and this plan does not add one — `documentsListCacheKey()` is list-wide and would be wrong here). `isAdmissionForPatient` is a single `select` on `admissions` with `and(eq(id), eq(patientId))` returning `rows.length > 0`.

- [ ] **Step 4: Run to confirm the query tests pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/documents.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing route test**

Create `tests/api/documents-receive.test.ts`. First line must be `// @vitest-environment node` with a comment pointing at `tests/api/patients-insurance-card.test.ts` for why. Mock auth with a mutable `sessionRole` let-binding and mock `@vercel/blob`:

```ts
let sessionRole: 'admin' | 'pi' | 'crc' | 'frontdesk' = 'crc'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Jamie Ruiz' })) }))
vi.mock('@vercel/blob', () => ({ put: vi.fn(async (path: string) => ({ url: `https://blob.test/${path}` })), del: vi.fn(async () => {}) }))
```

Build requests with a `formDataReq(fields: Record<string, string>, file?: File)` helper. Cases:

- accepts a JPEG with **no** `patientId` → 201; the created row has `patientId: null`, `status: 'new'`, `filedByName: null`, `fileUrl` containing `https://blob.test/documents/`, and `fileType === 'JPG'`.
- accepts an `application/pdf` → 201 with `fileType === 'PDF'` (Scope Decision 2's pin — a future allowlist "harmonization" must break here).
- accepts a `patientId` → the row has `filedByName: 'Jamie Ruiz'` and a non-null `filedAt`.
- accepts a `patientId` **and** a matching `admissionId` → the row stores that `admissionId`.
- rejects an `admissionId` belonging to a *different* patient → 400, and no `documents` row is created (Review Focus #2).
- rejects an `admissionId` with no `patientId` → 400.
- rejects a `patientId` that does not exist → 400 (not a 500 from an FK violation).
- rejects `text/plain` → 400, and asserts the mocked `put` was **never called** (Review Focus #4).
- rejects a file over 8 MB → 400, `put` never called.
- rejects a missing `file` → 400.
- rejects a `documentType` outside the enum → 400.
- rejects `sessionRole = 'pi'` → 403 (Review Focus #5).

- [ ] **Step 6: Run to confirm failure**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/documents-receive.test.ts`
Expected: FAIL — `src/app/api/documents/route.ts` does not exist.

- [ ] **Step 7: Implement `src/app/api/documents/route.ts`**

`export async function POST(request: NextRequest)`. Structure, in order: `requireSession()` → role gate `['admin', 'crc', 'frontdesk']` → `request.formData()` → file checks → Zod `.strict()` parse of the non-file fields → referential checks → `put()` → `createDocument()` → cache invalidation → `logAudit` → `201`.

Pin these values:

```ts
const ALLOWED_TYPES: Record<string, string> = {
  'application/pdf': 'PDF',
  'image/jpeg': 'JPG',
  'image/png': 'PNG',
  'image/webp': 'WEBP',
}
const MAX_BYTES = 8 * 1024 * 1024

const receiveDocumentSchema = z.object({
  name: z.string().trim().min(1),
  documentDate: z.string().min(1),
  receivedFrom: z.string().trim().min(1),
  documentType: z.enum(documentTypeEnum.enumValues),
  patientId: z.string().trim().min(1).optional(),
  admissionId: z.coerce.number().int().positive().optional(),
}).strict()
```

Notes the signature and tests do not determine:
- Build the object handed to `safeParse` from the `FormData` explicitly, omitting `file` and omitting any key whose value is an empty string — an unselected "Patient (leave blank if unknown)" `<select>` posts `''`, and `.strict()` plus `.min(1)` would otherwise turn "left blank on purpose" into a 400. Keeping `.strict()` on the rest still blocks mass assignment (a client sending `filedByName` or `status` gets a 400).
- `name` defaults to `file.name` when the form omits it — apply that default *before* `safeParse`, so `.min(1)` still guards the genuinely empty case.
- Reject `file.size === 0` alongside the `MAX_BYTES` check; a zero-byte upload is a failed scan, not a document.
- Referential checks, both 400 on failure: an `admissionId` with no `patientId`; a `patientId` with no matching `patients` row; an `admissionId` that fails `isAdmissionForPatient(admissionId, patientId)`.
- Blob path: `` put(`documents/${crypto.randomUUID()}-${file.name}`, file, { access: 'public' }) `` — mirrors `insurance-card/route.ts`'s convention. The UUID prefix, not a timestamp, because two coordinators scanning the same standard form name in the same second must not collide.
- `filedByName`/`filedAt` are set **only** when a `patientId` was supplied, both from the server (`session.name`, `new Date()`).
- Invalidate `documentsListCacheKey()` always, and `patientDetailCacheKey(patientId)` additionally when a patient was set — matching `insurance-card/route.ts`'s precedent.
- `` logAudit(session, `received document "${name}" (${documentType})`, patientId ?? null) ``.
- Return `NextResponse.json({ id: created.id, fileUrl: created.fileUrl }, { status: 201 })`.

- [ ] **Step 8: Run this task's tests**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/documents.test.ts tests/api/documents-receive.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/queries/documents.ts src/app/api/documents/route.ts tests/lib/queries/documents.test.ts tests/api/documents-receive.test.ts
git commit -m "$(cat <<'EOF'
feat: add POST /api/documents receive endpoint with real Blob file storage

EOF
)"
```

---

### Task 3: Widened `PATCH`, admin-only `DELETE`, audit-logged `GET .../download`

**Files:**
- Modify: `src/app/api/documents/[id]/route.ts`
- Create: `src/app/api/documents/[id]/download/route.ts`
- Modify: `src/lib/queries/documents.ts` (add `updateDocument`, `deleteDocument`)
- Test: `tests/api/documents.test.ts` (extend), `tests/api/documents-delete.test.ts` (new), `tests/api/documents-download.test.ts` (new)

**Interfaces:**
- Consumes: `createDocument`, `isAdmissionForPatient`, `getDocument` from `@/lib/queries/documents` (Task 2 / existing); `del` from `@vercel/blob`.
- Produces, from `@/lib/queries/documents` — consumed by Task 4's UI only through the routes:

```ts
export interface UpdateDocumentInput {
  status?: 'new' | 'processed'
  patientId?: string | null
  admissionId?: number | null
  documentType?: DocumentType
  filedByName?: string | null
  filedAt?: Date | null
}
export async function updateDocument(id: number, input: UpdateDocumentInput): Promise<DocumentRow | null>
export async function deleteDocument(id: number): Promise<DocumentRow | null> // returns the deleted row so the route can read fileUrl/name/patientId for Blob cleanup and audit
```

- [ ] **Step 1: Write the failing tests — `PATCH`**

Extend `tests/api/documents.test.ts`. Keep all four existing tests (they mock `role: 'crc'`, which stays authorized). Convert the auth mock to a mutable `sessionRole` let-binding so role cases can be added. Add cases — each creating its own throwaway `documents` row and cleaning it up, rather than mutating more seeded rows:

- `PATCH { patientId: 'RD-0001' }` on an Unfiled row → 200; the row now has that `patientId`, `filedByName: 'Jamie Ruiz'` (the mocked session name) and a non-null `filedAt`.
- `PATCH { patientId: null }` on a row that was filed with an `admissionId` → 200; `patientId`, `filedByName`, `filedAt`, **and** `admissionId` are all null (Review Focus #3).
- `PATCH { patientId: '<other patient>' }` on a row whose `admissionId` belongs to the previous patient → 200 and `admissionId` is now null (Scope Decision 3).
- `PATCH { admissionId: <an admission of a different patient> }` → 400, row unchanged (Review Focus #2).
- `PATCH { documentType: 'insurance_authorization' }` → 200 and the row's type changed.
- `PATCH {}` → 400 (the `.refine`).
- `PATCH { filedByName: 'Forged Name' }` → 400 (server-set fields are not client-settable; `.strict()`).
- `sessionRole = 'pi'` on `PATCH { status: 'processed' }` → 403 (Review Focus #5 — this is new behavior; the route has no role gate today).

- [ ] **Step 2: Write the failing tests — `DELETE` and download**

Create `tests/api/documents-delete.test.ts` (`// @vitest-environment node` not required — no `formData()` — but mock `@vercel/blob`'s `del`):
- `admin` deletes a row with a `fileUrl` → 200, the row is gone, and the mocked `del` was called once with that `fileUrl`.
- `admin` deletes a legacy row with `fileUrl: null` → 200 and `del` was **not** called.
- a `del` that rejects does not fail the request: mock it to throw once, assert 200 and that the DB row is still gone (the audit record of removal outlives storage cleanup).
- `crc` → 403. `frontdesk` → 403. `pi` → 403 (Review Focus #5).
- non-existent id → 404.

Create `tests/api/documents-download.test.ts`:
- `crc` on a row with a `fileUrl` → 302 with `res.headers.get('location')` equal to that `fileUrl`.
- `pi` on the same row → 302 (download is read access, all four roles).
- a row with `fileUrl: null` → 404.
- non-existent id → 404.
- a successful download writes an audit row: query `auditLog` for `` action = `downloaded document ${id}` `` and assert one exists.

- [ ] **Step 3: Run all three to confirm they fail**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/documents.test.ts tests/api/documents-delete.test.ts tests/api/documents-download.test.ts`
Expected: FAIL — `DELETE` and the download route are not exported/do not exist; the new `PATCH` cases 400 on unknown keys.

- [ ] **Step 4: Implement `updateDocument` and `deleteDocument`**

Both in `src/lib/queries/documents.ts`. `updateDocument` is `update(documents).set(input).where(eq(documents.id, id)).returning()`, returning `row ?? null` — it applies exactly the fields it is given and makes no policy decisions; the route computes what to clear. `deleteDocument` reads the row first, returns `null` if absent, then deletes and returns the row it read.

- [ ] **Step 5: Rewrite `src/app/api/documents/[id]/route.ts`**

Keep the existing imports and the `getDocument` 404 check. Changes:

```ts
const updateDocumentSchema = z.object({
  status: z.enum(['new', 'processed']).optional(),
  patientId: z.string().trim().min(1).nullable().optional(),
  admissionId: z.number().int().positive().nullable().optional(),
  documentType: z.enum(documentTypeEnum.enumValues).optional(),
}).strict().refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' })
```

`PATCH`, in order: `requireSession()` → role gate `['admin', 'crc', 'frontdesk']` → parse → `getDocument` 404 → build the update → write → invalidate → audit.

The update-building policy (this is the part the signature and tests do not determine):
- Compute `effectivePatientId` = `'patientId' in parsed.data ? parsed.data.patientId : existing.patientId`.
- If `patientId` was supplied and is non-null: verify the patient exists (400 if not), and set `filedByName: session.name`, `filedAt: new Date()`.
- If `patientId` was supplied as `null`: set `filedByName: null`, `filedAt: null`, `admissionId: null`, and ignore any `admissionId` in the same body (a 400 would also be defensible; clearing is chosen because `patientId: null` is unambiguous about intent).
- Else if `patientId` was supplied as a *different* non-null id than `existing.patientId` and the body supplies no `admissionId`: set `admissionId: null`.
- If `admissionId` was supplied as a number: 400 unless `effectivePatientId` is non-null **and** `isAdmissionForPatient(admissionId, effectivePatientId)` is true (Review Focus #2).
- Invalidate `documentsListCacheKey()`, plus `patientDetailCacheKey()` for both `existing.patientId` and `effectivePatientId` when non-null and different — a re-file changes what two patients' pages should show.
- Audit message describes what actually changed, keeping the existing route's phrasing style: `` `marked document ${id} as ${status}` `` for a status-only change, `` `filed document ${id} to patient ${patientId}` `` when filing, `` `unfiled document ${id}` `` when clearing, `` `changed document ${id} type to ${documentType}` `` for a retype. Multiple changed fields join their clauses with `'; '`. Pass `effectivePatientId ?? existing.patientId` as `logAudit`'s `patientId`.

Add `export async function DELETE(...)` to the same file: `requireSession()` → `if (session.role !== 'admin') return 403` (mirroring `src/app/api/patients/[anonId]/route.ts`'s admin-only DELETE, including a comment in the same register explaining why deletion is reserved) → `deleteDocument(Number(id))`, 404 if null → best-effort Blob cleanup:

```ts
if (deleted.fileUrl) {
  // Best-effort: a failed Blob delete must never block or reverse the DB
  // delete. The record that this document existed and was removed lives in
  // auditLog and outlives storage cleanup either way; an orphaned blob is a
  // janitorial problem, a half-deleted document row is a data-integrity one.
  try { await del(deleted.fileUrl) } catch (err) { console.error(`Failed to delete blob for document ${id}:`, err) }
}
```

Then invalidate `documentsListCacheKey()` (and `patientDetailCacheKey(deleted.patientId)` if set) and `` logAudit(session, `deleted document ${id} ("${deleted.name}")`, deleted.patientId) ``.

- [ ] **Step 6: Implement `src/app/api/documents/[id]/download/route.ts`**

`export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> })`: `requireSession()` (no role gate — all four roles read) → `getDocument(Number(id))`, 404 if null → 404 if `fileUrl` is null (with an error message saying this is a metadata-only record with no stored file) → `` logAudit(session, `downloaded document ${id}`, existing.patientId) `` → `NextResponse.redirect(existing.fileUrl, 302)`.

Add a comment stating plainly that the blob URL is already publicly reachable (same posture as `patients.primaryCardFrontUrl`, rendered as a bare `<img src>`), so this route's real job is producing the audit event, not gating the bytes.

- [ ] **Step 7: Run this task's tests**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/documents.test.ts tests/api/documents-delete.test.ts tests/api/documents-download.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add "src/app/api/documents/[id]" src/lib/queries/documents.ts tests/api/documents.test.ts tests/api/documents-delete.test.ts tests/api/documents-download.test.ts
git commit -m "$(cat <<'EOF'
feat: widen document PATCH to filing, add admin-only DELETE and audited download

EOF
)"
```

---

### Task 4: Receive form, filter tabs, inline filing, and row actions

**Files:**
- Create: `src/components/ReceiveDocumentModal.tsx`
- Create: `src/components/AssignDocumentPatientControl.tsx`
- Create: `src/components/DocumentRowActions.tsx`
- Modify: `src/components/DocumentsReportTable.tsx`
- Modify: `src/app/(dashboard)/documents/page.tsx`
- Modify: `src/lib/queries/admissions.ts` (add `listActiveAdmissions`)
- Test: none new — route behavior is covered by Tasks 2–3; verified per Global Constraints' UI verification discipline.

**Interfaces:**
- Consumes: `POST /api/documents`, `PATCH /api/documents/[id]`, `DELETE /api/documents/[id]`, `GET /api/documents/[id]/download` (Tasks 2–3, called by URL); `listDocuments()` and `listPatientsWithStatus(null)` (existing, called directly by the Server Component page).
- Produces: `listActiveAdmissions(): Promise<ActiveAdmissionSummary[]>` where `ActiveAdmissionSummary = { admissionId: number; patientId: string; roomLabel: string | null; admittedAt: Date }` — consumed by the receive modal's inline inpatient-status context (spec §6.1–6.2).

- [ ] **Step 1: Add `listActiveAdmissions` to `src/lib/queries/admissions.ts`**

A single `select` from `admissions` where `status = 'admitted'`, `leftJoin`ed to `rooms` on `currentRoomId`, mapped to the `ActiveAdmissionSummary` shape with `roomLabel` as `` `${ward} ${roomNumber}-${bedNumber}` `` (null when no room). One query for the whole page — no per-patient `getActiveAdmissionForPatient()` call, which would be an N+1 against the patient dropdown.

- [ ] **Step 2: Update the Documents page to supply what the UI needs**

`src/app/(dashboard)/documents/page.tsx` keeps `requireSessionOrRedirect()` first and its existing `logAudit(session, 'viewed documents', null)` and adds no role redirect (spec §7: all four roles read; the existing behavior is already correct and `LeftNav`'s narrower `['admin','crc']` visibility is out of scope). It additionally fetches `listPatientsWithStatus(null)` and `listActiveAdmissions()` directly (Server Components call the query layer, never the app's own API routes — see the comment on `listPatientsWithStatus`), and passes to `DocumentsReportTable`:

- `patientOptions: { id: string; name: string }[]` — mapped as `name: p.nameTebra ?? p.nameIntakeq ?? p.id`, matching how `listDocuments()` already resolves a display name, sorted by name.
- `activeAdmissions` from Step 1, serialized (`admittedAt` to an ISO string) — `DocumentsReportTable` is a Client Component and cannot receive a `Date`-bearing prop shape without this page deciding the serialization, exactly as `patients/[anonId]/page.tsx` already does for `InpatientHistoryPanel`.
- `canWrite={['admin', 'crc', 'frontdesk'].includes(session.role)}` and `canDelete={session.role === 'admin'}`.

- [ ] **Step 3: Add the filter tabs and the new columns to `DocumentsReportTable`**

Keep it a Client Component owning its own `columns`/`matchesFilters` (the block comment at the top of `ReportTable.tsx` explains why these can never be built in the Server Component). Changes:

- A `useState<'unfiled' | 'unprocessed' | 'all'>('unfiled')` tab strip rendered above `<ReportTable>`, styled like `DocumentsTabs.tsx`'s existing underline-tab treatment (`border-b-2`, `aria-current="page"` on the active one — reuse the visual convention, not the component, which is route-based). Each tab label carries its own count, e.g. `Unfiled (7)`. Filter `rows` by tab before passing them to `ReportTable`: `unfiled` → `patientId === null`; `unprocessed` → `status === 'new'`; `all` → everything. Default `'unfiled'` per spec §3.
- Extend `DocumentReportRow` with `fileUrl: string | null`, `admissionId: number | null`, `filedByName: string | null`, `filedAt: string | null`.
- A **Filed By** column: `filedByName` when set, otherwise the literal `Filed before filing history was tracked` in `text-muted-foreground` (Scope Decision 1). Render nothing for an Unfiled row.
- The existing **Patient** column's `render` becomes `<AssignDocumentPatientControl>` when `canWrite`, and the current read-only text otherwise.
- The **Actions** column's `render` becomes `<DocumentRowActions>`.
- A **Receive Document** button above the tab strip, rendered only when `canWrite` (no render, not disabled — `InsuranceCardUpload`'s established pattern), opening `ReceiveDocumentModal`.

- [ ] **Step 4: Build `ReceiveDocumentModal`**

`'use client'`, following `CheckInModal.tsx`'s Dialog-with-fetch shape (`Dialog`/`DialogContent`/`DialogHeader`/`DialogTitle`/`DialogFooter` from `@/components/ui/dialog`, `Button` from `@/components/ui/button`, local `submitting`/`error` state, `router.refresh()` on success). Props: `{ patientOptions, activeAdmissions, onClose }`.

Fields, matching `POST /api/documents`'s contract exactly: a file `<input type="file" accept="application/pdf,image/jpeg,image/png,image/webp">`; `name` (text, pre-filled from the chosen file's name on change, editable); `documentDate` (date); `receivedFrom` (text); `documentType` (`<select>` over all nine enum values using the same `DOCUMENT_TYPE_TEXT` map `DocumentsReportTable` exports); `patientId` (`<select>` with a first option labelled **"Leave blank if unknown"** mapping to `''`).

When a patient is selected, look them up in `activeAdmissions` and render, read-only beneath the select (spec §6.1 — context only, it gates nothing):
- matched → `Currently admitted — {roomLabel ?? 'no room assigned'}` plus an `<input type="checkbox">` labelled **"Associate with this admission"** which, when checked, posts that `admissionId` (spec §6.2). Use a plain checkbox — this codebase has no `Checkbox` primitive in `src/components/ui/`.
- no match → `Outpatient`.

Submit builds a `FormData` (never JSON — the route reads `request.formData()`), omitting `patientId` and `admissionId` when blank/unchecked, and `POST`s to `/api/documents`. Surface the route's `error` string inline on a non-2xx; do not invent client-side duplicates of the route's allowlist or size checks beyond the `accept` attribute, so the server stays the single source of truth for what is acceptable.

- [ ] **Step 5: Build `AssignDocumentPatientControl`**

`'use client'`. Props `{ documentId, patientId, patientName, patientDob, patientOptions }`. Renders a `<select>` of patients with a first option **"— Unfiled —"** mapping to `''`, whose current value is the row's `patientId`. On change, `PATCH /api/documents/${documentId}` with JSON `{ patientId: value === '' ? null : value }` and `router.refresh()` on success; inline error text otherwise. A `<select>` rather than a typeahead because no patient-autocomplete component exists in this codebase and this plan does not invent one — the same call `ConfirmBookingRequestModal` and `CheckInModal` already make for patient entry.

- [ ] **Step 6: Build `DocumentRowActions`**

`'use client'`. Props `{ documentId, documentName, status, fileUrl, canWrite, canDelete }`. Composes three things in a flex row:
- the existing `<MarkProcessedButton>`, unchanged and rendered only when `canWrite` (it already self-renders a "Processed" label when `disabled`);
- a **Download** link — a plain `<a href={`/api/documents/${documentId}/download`}>`, not a `fetch`, so the browser follows the 302 itself. Rendered for every role. When `fileUrl` is null, render the non-interactive text `No file` instead, since the route would 404;
- a **Delete** button rendered only when `canDelete`, styled like `DeletePatientButton`'s destructive treatment (`border-destructive/30`, `text-destructive`, `Trash2` icon), gated behind a `window.confirm` naming the document (`Delete "${documentName}"? This cannot be undone.`) before issuing `DELETE /api/documents/${documentId}`, then `router.refresh()`.

- [ ] **Step 7: Verify via a real running dev server, not narration**

Start the dev server on a free port (e.g. `npx next dev -p <port>`, backgrounded) and mint a `clinsync_demo_session` cookie per Global Constraints. Then, pasting every actual command and its actual output:

1. `GET /documents` as `crc` → 200, the Unfiled tab is active by default, the Receive Document button is present.
2. A real multipart `POST /api/documents` via `curl -F` with a real PDF and no `patientId` → 201; reload `/documents` and confirm the new row appears under Unfiled with `—` in the Patient column.
3. Use the inline Patient select (or an equivalent `curl` PATCH) to file that row to a real patient → confirm the row leaves the Unfiled tab and the Filed By column shows the session's name.
4. `GET /api/documents/<id>/download` with `curl -i` → 302 with a `Location` header pointing at the blob URL.
5. `GET /documents` as `pi` → 200 and the response body contains **no** Receive Document button and no Delete button; `DELETE /api/documents/<id>` as `crc` → 403; as `admin` → 200.
6. A seeded legacy row (e.g. id 1) shows `No file` in place of Download and `Filed before filing history was tracked` in Filed By.

Stop the dev server when done.

- [ ] **Step 8: Commit**

```bash
git add src/components/ReceiveDocumentModal.tsx src/components/AssignDocumentPatientControl.tsx src/components/DocumentRowActions.tsx src/components/DocumentsReportTable.tsx "src/app/(dashboard)/documents/page.tsx" src/lib/queries/admissions.ts
git commit -m "$(cat <<'EOF'
feat: add Receive Document form, Unfiled/Unprocessed tabs, inline filing and row actions

EOF
)"
```

---

### Task 5: Document the `InsuranceCardUpload` boundary, role capabilities, and whole-feature verification

**Files:**
- Modify: `src/components/InsuranceCardUpload.tsx` (doc comment only)
- Modify: `src/app/api/patients/[anonId]/insurance-card/route.ts` (comment on `ALLOWED_TYPES` only)
- Modify: `src/lib/role-capabilities.ts`
- Test: `tests/api/patients-insurance-card.test.ts` — **verified unchanged**, not edited (spec §8).

**Interfaces:**
- Consumes: everything from Tasks 1–4. Produces nothing new.

- [ ] **Step 1: Document the two-path boundary where a future implementer will actually look**

In `src/components/InsuranceCardUpload.tsx`'s existing JSDoc block, add that insurance paperwork beyond the primary card — secondary cards, EOBs, authorization letters, and primary cards arriving by fax rather than through this control — is received through the generic Documents flow (`POST /api/documents` with an `insurance_*` `documentType`), that the two paths are deliberately independent records of independently true facts and are **not** kept in sync in either direction, and that this control is kept narrow on purpose because both "which patient" and "what is it" are already fixed by context here. Point at spec §1 and §4 by path.

In `src/app/api/patients/[anonId]/insurance-card/route.ts`, add a comment directly above `ALLOWED_TYPES` recording Scope Decision 2: this list stays image-only because `primaryCardFrontUrl`/`primaryCardBackUrl` are rendered as bare `<img src>` on the Medical Record page, whereas `POST /api/documents` accepts `application/pdf` as well because its `fileUrl` is only ever reached through a redirecting download. Name it as an intended divergence so nobody "harmonizes" the two lists, and note that `tests/api/documents-receive.test.ts` and this route's own "rejects a non-image content type" test pin both halves.

Change no behavior in either file.

- [ ] **Step 2: Update `src/lib/role-capabilities.ts`**

- `crc`: replace `'View Reports and Documents'` with `'View Reports and Documents, and receive, file, and re-file incoming documents to a patient'`.
- `frontdesk`: add `'Receive, file, and re-file incoming documents (including insurance cards, EOBs, and authorizations) to a patient'`.
- `pi`: add `'View and download filed documents (read-only -- receiving and filing is a coordinator/front-desk action)'`.
- `admin`: add `'Permanently delete a received document'` (the only role that can).

These bullets must describe gating the code now actually enforces — Task 3 added the `PATCH` role gate that makes the `pi` line true.

- [ ] **Step 3: Confirm the insurance-card regression suite still passes untouched**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/patients-insurance-card.test.ts`
Expected: PASS, all three cases, with **no edits to that file** — `git diff --stat tests/api/patients-insurance-card.test.ts` must be empty. Its "rejects a non-image content type" case uses exactly an `application/pdf` file, so this is the live proof that Scope Decision 2's divergence is real in both directions.

- [ ] **Step 4: Run the full suite and the linter**

Run: `npx dotenv -e .env.local -- npx vitest run`
Expected: all pass. Pay particular attention to `tests/db/seed.test.ts`, `tests/lib/queries/reports.test.ts`, and anything touching `documents` — Task 1's rename reaches the shared DB, so a failure here is a real regression, not flake.

Run: `npx next lint` (or `npm run lint`).
Expected: clean.

- [ ] **Step 5: End-to-end verification of the whole feature against a real dev server**

Start the dev server, mint a staff cookie, and walk the full spec §3–§6 story once, in order, pasting every actual command and output:

1. Receive an insurance EOB **as a PDF** with no patient → lands Unfiled.
2. Receive a secondary insurance card image **for a currently-admitted patient**, with "Associate with this admission" checked → the created row has both a `patientId` and the correct `admissionId` (verify by querying the DB directly, not by reading the UI).
3. File the Unfiled EOB to that same patient → `filedByName`/`filedAt` populate.
4. Un-file it (`PATCH { patientId: null }`) → `filedByName`, `filedAt`, `admissionId` all return to null, and it reappears under the Unfiled tab.
5. `listDocumentsForPatient(<that patient>)` returns the admission-linked card with its `admissionId` present (spec §6.3's whole obligation).
6. Download one of the new documents → 302 to the blob URL, and a matching `downloaded document N` row exists in `auditLog`.
7. Delete it as `admin` → gone from the list, and a `deleted document N (...)` audit row exists.
8. Confirm `InsuranceCardUpload` still works untouched: upload a primary card front through the Medical Record page's control and confirm `patients.primaryCardFrontUrl` updated and **no** `documents` row was created (the two paths are independent — spec §4).

Stop the dev server when done.

- [ ] **Step 6: Commit**

```bash
git add src/components/InsuranceCardUpload.tsx "src/app/api/patients/[anonId]/insurance-card/route.ts" src/lib/role-capabilities.ts
git commit -m "$(cat <<'EOF'
docs: record the InsuranceCardUpload/generic-Documents boundary and update role capabilities

EOF
)"
```
