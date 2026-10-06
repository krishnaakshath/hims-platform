# Forms Hub and Embedded Consents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize `/forms` around real, possibly-empty folders instead of a grouping derived from `formTemplates.category`, add a reusable consent-document library, and move consent signing from a post-hoc patient-portal action into a page of the intake packet itself.

**Architecture:** Four additive tables and one nullable column. `formTemplateFolders` + `formTemplates.folderId` give the library UI a grouping that can be empty, while `category` keeps its existing job as the live gate in the legacy sign route. `consentDocuments` ⟷ `formTemplateConsents` ⟷ `formTemplates` is a genuine many-to-many read from both directions. `formSubmissionConsents` is the per-submission snapshot of *which* consents a packet carries, written at send time, and its `id` is the single integer `signatures.signableId` needs — so the e-signature mechanism gains a third `signableType` value and nothing else. No wording is ever copied into a new table: `signatures.attestationText` remains the one verbatim record of what a person agreed to.

**Tech Stack:** Next.js 16 App Router (Server + Client Components) + Drizzle ORM over a `pg` Pool + Zod v4 `.strict()` validation + vitest against the real shared Neon Postgres DB.

**Spec:** `docs/superpowers/specs/2026-09-29-forms-hub-and-embedded-consents.md`

**Working directory note:** this plan is executed in an isolated git worktree at `/Users/k2a/Desktop/clinsync/.worktrees/forms-redesign` on branch `feature/forms-redesign`, forked from `hims-platform`. This worktree already has its own `.env.local` **and** its own `node_modules` — both were verified present while planning, so **no `npm install` step is needed**; Task 1 starts at the schema test. Every implementer/reviewer dispatch works from this exact directory, never the main checkout — 17 other worktrees (`.worktrees/unified-patient-record`, `.worktrees/eligibility-auto-notify`, `.worktrees/master-fix`, …) have concurrent work in flight; do not touch them.

**Scope decisions made while planning (rulings, not left open for the implementer to guess):**

1. **`POST /api/form-templates` must also accept `folderId`, even though spec §8's route table only lists `PUT`.** Spec §3 requires "Create New" to send `folderId` (the folder's id when the hub is scoped to a folder, `null` at the top level), and `createTemplateSchema` is `.strict()` — so without this the entire create-inside-a-folder flow 400s. Task 2 extends both schemas.
2. **`npm run db:generate` is NOT run.** Verified while planning: `drizzle/meta/_journal.json`'s latest snapshot (`0004`) describes 24 tables while `src/db/schema.ts` defines 49, because this repo's later tables were applied by hand-written scripts. `generate` would emit `CREATE TABLE` for 25 tables that already exist and commit a migration file that is a lie. `npm run db:push` diffs `schema.ts` against the **live** DB, which is the true state, so Task 1 uses `push` only — with a `--tablesFilter` and a hard statement-review gate (see Global Constraints).
3. **`identity_matches` is the concrete reason Task 1 needs `--tablesFilter`.** Verified: it exists in `src/db/schema.ts` but has *already been dropped from the shared live DB* by the `unified-patient-record` worktree. An unfiltered `db:push` from here would re-create it, silently undoing another worktree's destructive migration.
4. **The preview modal (§4) reuses the intake field renderer by extraction, not duplication.** `IntakePortalForm.tsx`'s per-question `switch` is lifted into `src/components/IntakeQuestionField.tsx` and rendered by both. Spec §4 says the preview "cannot drift from what a patient sees"; two copies of the switch would drift by construction.
5. **Every new page gets an explicit `['admin', 'crc']` gate, and `/forms` + `/forms/[templateId]` get one too.** Spec §11 row 1 names the Forms Hub itself. Spec §10.2's carve-out is scoped by its own wording to "`/api/form-templates` write routes" — two API endpoints, not the pages. `LeftNav` already restricts `/forms` to `admin`/`crc`, so no role loses access it actually uses. Pages `redirect('/')` on a wrong role (there is no 403 for a page); the API routes return 403.
6. **"Archive" lives in the template editor toolbar.** Spec §3 requires an archived count and §4's info panel lists "archive the template" as a common action, but no section says where the button is. It goes in the editor toolbar and reuses the existing `PUT /api/form-templates/[id]` `{ isActive: false }`; Restore on `/forms/archived` is the same route with `{ isActive: true }`. No new route either way.
7. **`/forms/archived` and `/forms/folders/[folderId]` are static-first segments under the existing `/forms/[templateId]` dynamic segment.** Next.js resolves static segments before dynamic siblings, so these do not collide. No change to `/forms/[templateId]` routing is needed.
8. **Spec §10's three open questions are explicitly out of scope** — no task resolves IP/user-agent capture, tightens the two pre-existing `/api/form-templates` write routes, or retires the `category = 'Consent Forms'` gate. Task 9 leaves a one-line ledger note pointing at §10 and nothing more.

## Global Constraints

- This is `hims-platform` only, never `master`. `feature/forms-redesign` merges into `hims-platform`.
- **Additive-only schema.** This plan adds four new tables (`form_template_folders`, `consent_documents`, `form_template_consents`, `form_submission_consents`), one new nullable column (`form_templates.folder_id`), one new enum (`legal_review_status`), and one new value on the existing `signable_type` enum. **Nothing is dropped, renamed, or backfilled.** This is a **single shared Neon Postgres database across every branch/worktree** — a schema mistake here is visible everywhere immediately. This session already had a real incident where a `NOT NULL` column with no default was added to an existing shared table and broke every other worktree; `folder_id` is nullable precisely so an older worktree's `INSERT INTO form_templates` keeps working untouched.
- **Migration command, exactly:**
  `npm run db:push -- --verbose --strict --tablesFilter='form_templates,form_template_folders,consent_documents,form_template_consents,form_submission_consents'`
  Never `--force`. Never `npm run db:generate` (Scope decision #2). `--verbose` prints every statement and `--strict` always prompts — the prompt is a real gate, not a formality (Task 1, Step 4 lists the only acceptable statements).
- `psql` is **not installed** in this environment — verify a migration's live-DB effect with a Node script using `pg`'s `Pool` against `information_schema` / `pg_enum`, not `psql -c "\d ..."`.
- Every write route uses `.strict()` Zod validation (rejects unknown fields).
- Every state-changing **staff** route calls `logAudit(session, <action>, null)` — forms and consent documents are practice-wide configuration, not per-patient records, so `patientId` is `null`. The one exception is the token-authorized patient route, which has no `Session` and calls `logPatientPortalAction(<action>, patientId)` from `@/lib/patient-portal-audit` instead (the one sanctioned session-free audit path, documented in that file).
- Every protected API route starts with `requireSession()` as its first statement; every protected page starts with `requireSessionOrRedirect()`. The sole exception is `POST /api/intake/[token]/consents/[formSubmissionConsentId]/sign`, which is token-authorized with no session at all, matching the posture documented verbatim at `src/app/api/intake/[token]/route.ts` lines 12–15.
- **Role gating per spec §11, enforced in the route/page each task creates — never deferred.** All staff actions (folders, consent documents, attach/detach, archive/restore, viewing signed counts) = `admin`, `crc`. Inline check immediately after the session call, matching this codebase's established style (`src/app/api/patients/route.ts:53`): `if (!['admin', 'crc'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })`. Inline consent signing = the patient holding the intake token, no session. The legacy portal sign path = patient-portal session only, unchanged.
- **Cache invalidation.** `listFormTemplates()` is cached 30s under `formTemplatesListCacheKey()`. Creating, renaming, or deleting a folder, filing a template into one, and archiving/restoring a template all call `invalidateFormTemplatesList()` from `@/lib/queries/form-templates` (per spec §3). Folder writes affect the hub's data even though they don't touch `form_templates` rows directly — the hub reads both through that one cached list.
- **No word "Tebra" or "IntakeQ" appears in any new code comment, UI copy, or identifier this plan adds.** (Standing constraint across this initiative; existing occurrences are being removed elsewhere, not added to.)
- **Five things spec §1 rules out, which no task may add even though each looks like an obvious next step:** an **"Upload Existing Form"** button (turning a PDF into a `questions` array needs a real document parser; a file picker that then can't do anything is worse than its absence), **nested folders** (one flat level — a folder has no parent), a **rich-text consent editor** (`bodyText` is a plain `<textarea>`, because "the exact string the patient saw" must be unambiguous), **consent document versioning** (no `consentDocumentVersions` table — each past signature already carries its own verbatim wording), and **any change to the e-signature mechanism itself** (the typed-name input, the attestation checkbox, `SignatureCapture`, or what `signatures` stores).
- Multi-write sequences stay **non-transactional and sequential**, matching the posture documented at length in `src/app/api/patients/[anonId]/form-submissions/[id]/sign/route.ts` lines 46–54. (Correction, final review: that comment is stale -- `src/db/client.ts` is node-postgres over TCP and supports real transactions via `getDb().transaction(...)`, as `care-plans.ts` and `medication-dispenses.ts` already use. The fix wave wraps the `POST /api/form-submissions` insert and `copyTemplateConsentsToSubmission` in one.) Spec §6 explicitly follows it: the signature insert and any completion update are two separate round-trips, and the completion gate re-checks on its own later request.
- Vitest invocation: `npx dotenv -e .env.local -- npx vitest run <path>` (`fileParallelism: false`, `testTimeout: 15000`).
- Test hygiene, per spec §9 and the existing files it names: mock `@/lib/auth`'s `requireSession` with `vi.mock`; track every created id and delete it in `afterEach`; scope audit-log assertions to that test's **own action string**, never "the latest row" (the shared dev DB has concurrent writers); scope signature cleanup by `(signableType, signableId)`, never `signableId` alone.
- Commit messages end with no attribution trailer.
- **UI verification discipline (standing rule this session):** a prior implementer fabricated a narrated, unreproduced UI verification claim and was caught. Every UI task verifies against a real running dev server with real HTTP requests — mint a staff cookie the way `src/lib/auth.ts` actually builds it (`SignJWT` via `buildSessionCookieValue(role, name)` under cookie `clinsync_demo_session`, secret from `SESSION_SECRET`), and hit the intake surfaces with **no cookie at all**, since that absence is the thing being tested. Paste actual commands and actual output in the report.

## Review Focus

1. **"Create New" inside a folder must actually work.** `createTemplateSchema` is `.strict()`, so the moment `CreateFormButton` starts sending `folderId` (spec §3), `POST /api/form-templates` rejects the whole payload with 400 unless its schema was extended too — and spec §8's route table only mentions `PUT`. A staff member clicking Create New inside "Research Forms" would get a silent no-op (that button has no error state today). (Task 2)
2. **A folder's "N forms" count and the folder's contents must agree.** Spec §3 counts `isActive` templates only. If the count filters on `isActive` but the folder page's grid doesn't (or vice versa), a folder reading "2 forms" opens to show three cards, one of them archived — exactly the state the redesign exists to remove from the default view. (Tasks 2 and 3)
3. **The inline sign route's body is `{ typedName }` and nothing else.** `renderedText` is composed server-side precisely so the client cannot decide what it attests to (spec §6). A request carrying `attestationText`, `consentDocumentId`, `signerRole`, or `signedAt` must 400 on `.strict()` and never reach the `signatures` insert. (Task 7)
4. **A consent-only packet — zero questions, one or more consents — must be completable.** Spec §6 calls this valid and supported. `getIntakePortalData` returns `questions: []`, `IntakePortalForm`'s progress bar divides by a total that is now 0, and the completion gate is the only thing between the patient and submit. It must not render a broken form, show `NaN%`, or let `complete: true` through unsigned. (Tasks 7 and 9)
5. **Flipping `legalReviewStatus` from `'draft'` to `'reviewed'` must not retroactively remove the draft banner from an existing signature.** Spec §5 derives the banner at render time and stores the composed string verbatim in `attestationText`; the whole point is that a signature collected against a draft carries permanent, self-evident proof of it. The `bodyText` case is spec §9's load-bearing assertion; the status case is the same invariant by a different edit and is just as easy to get wrong. (Task 4)

---

### Task 1: Schema — folders, consent documents, join tables, `'form_submission_consent'`

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/lib/queries/signatures.ts` (widen `SignableType`)
- Test: `tests/db/forms-hub-consents-schema.test.ts`

**Interfaces:**
- Produces: `formTemplateFolders`, `consentDocuments`, `formTemplateConsents`, `formSubmissionConsents` tables; `legalReviewStatusEnum`; `formTemplates.folderId`; `signableTypeEnum` extended with `'form_submission_consent'`; `SignableType` widened to `'form_submission' | 'admission_discharge' | 'form_submission_consent'`. Consumed by every later task.

- [ ] **Step 1: Write the failing test**

Create `tests/db/forms-hub-consents-schema.test.ts`. It creates its own template/submission/folder/document rows and deletes them all in `afterEach`, innermost-FK-first:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { formTemplates, formSubmissions, signatures, formTemplateFolders, consentDocuments, formTemplateConsents, formSubmissionConsents } from '@/db/schema'

const PATIENT_ID = 'RD-0001'
const createdSigIds: number[] = []
const createdSubConsentIds: number[] = []
const createdTplConsentIds: number[] = []
const createdSubmissionIds: number[] = []
const createdTemplateIds: number[] = []
const createdDocIds: number[] = []
const createdFolderIds: number[] = []

afterEach(async () => {
  const db = getDb()
  while (createdSigIds.length) await db.delete(signatures).where(eq(signatures.id, createdSigIds.pop()!))
  while (createdSubConsentIds.length) await db.delete(formSubmissionConsents).where(eq(formSubmissionConsents.id, createdSubConsentIds.pop()!))
  while (createdTplConsentIds.length) await db.delete(formTemplateConsents).where(eq(formTemplateConsents.id, createdTplConsentIds.pop()!))
  while (createdSubmissionIds.length) await db.delete(formSubmissions).where(eq(formSubmissions.id, createdSubmissionIds.pop()!))
  while (createdTemplateIds.length) await db.delete(formTemplates).where(eq(formTemplates.id, createdTemplateIds.pop()!))
  while (createdDocIds.length) await db.delete(consentDocuments).where(eq(consentDocuments.id, createdDocIds.pop()!))
  while (createdFolderIds.length) await db.delete(formTemplateFolders).where(eq(formTemplateFolders.id, createdFolderIds.pop()!))
})

describe('forms hub and embedded consents schema', () => {
  it('creates a folder with a default sortOrder of 0', async () => {
    const [folder] = await getDb().insert(formTemplateFolders).values({ name: 'Research Forms' }).returning()
    createdFolderIds.push(folder.id)
    expect(folder.sortOrder).toBe(0)
    expect(folder.createdAt).toBeInstanceOf(Date)
  })

  it('files a template into a folder and accepts folderId null', async () => {
    const db = getDb()
    const [folder] = await db.insert(formTemplateFolders).values({ name: 'Intake' }).returning()
    createdFolderIds.push(folder.id)
    const [filed] = await db.insert(formTemplates).values({ name: `T ${Date.now()}`, category: 'Uncategorized', diagnosisTag: 'General', questions: [], folderId: folder.id }).returning()
    createdTemplateIds.push(filed.id)
    expect(filed.folderId).toBe(folder.id)
    const [unfiled] = await db.insert(formTemplates).values({ name: `U ${Date.now()}`, category: 'Uncategorized', diagnosisTag: 'General', questions: [] }).returning()
    createdTemplateIds.push(unfiled.id)
    expect(unfiled.folderId).toBeNull()
  })

  it('defaults a consent document to legalReviewStatus draft', async () => {
    const [doc] = await getDb().insert(consentDocuments).values({ name: 'Telehealth Consent', bodyText: 'By signing below...' }).returning()
    createdDocIds.push(doc.id)
    expect(doc.legalReviewStatus).toBe('draft')
    expect(doc.updatedAt).toBeInstanceOf(Date)
  })

  it('rejects attaching the same consent document to the same template twice', async () => {
    const db = getDb()
    const [tpl] = await db.insert(formTemplates).values({ name: `T ${Date.now()}`, category: 'Uncategorized', diagnosisTag: 'General', questions: [] }).returning()
    createdTemplateIds.push(tpl.id)
    const [doc] = await db.insert(consentDocuments).values({ name: 'Dup probe', bodyText: 'x' }).returning()
    createdDocIds.push(doc.id)
    const [first] = await db.insert(formTemplateConsents).values({ formTemplateId: tpl.id, consentDocumentId: doc.id }).returning()
    createdTplConsentIds.push(first.id)
    await expect(db.insert(formTemplateConsents).values({ formTemplateId: tpl.id, consentDocumentId: doc.id })).rejects.toThrow()
  })

  it('stores a signature with signableType form_submission_consent pointing at a formSubmissionConsents id', async () => {
    const db = getDb()
    const [tpl] = await db.insert(formTemplates).values({ name: `T ${Date.now()}`, category: 'Uncategorized', diagnosisTag: 'General', questions: [] }).returning()
    createdTemplateIds.push(tpl.id)
    const [doc] = await db.insert(consentDocuments).values({ name: 'Sig probe', bodyText: 'x' }).returning()
    createdDocIds.push(doc.id)
    const [sub] = await db.insert(formSubmissions).values({ templateId: tpl.id, patientId: PATIENT_ID }).returning()
    createdSubmissionIds.push(sub.id)
    const [sc] = await db.insert(formSubmissionConsents).values({ formSubmissionId: sub.id, consentDocumentId: doc.id }).returning()
    createdSubConsentIds.push(sc.id)
    const [sig] = await db.insert(signatures).values({ signableType: 'form_submission_consent', signableId: sc.id, signerTypedName: 'Maria Alvarez', signerRole: 'patient', attestationText: 'x' }).returning()
    createdSigIds.push(sig.id)
    expect(sig.signableType).toBe('form_submission_consent')

    const found = await db.select().from(signatures).where(and(eq(signatures.signableType, 'form_submission_consent'), eq(signatures.signableId, sc.id)))
    expect(found).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/forms-hub-consents-schema.test.ts`
Expected: FAIL — the four tables are not exported from `@/db/schema`, and `'form_submission_consent'` is not a `signableType`.

- [ ] **Step 3: Add the schema definitions**

In `src/db/schema.ts`, all four tables and the new enum go in the existing forms block, following this file's convention that an enum is declared immediately above the table(s) using it (see `formSubmissionStatusEnum` at line 269, `signableTypeEnum` at line 603).

Place `formTemplateFolders` and `legalReviewStatusEnum` + `consentDocuments` **before** `formTemplates` (line 273) so the FK targets are declared first, and `formTemplateConsents` + `formSubmissionConsents` **after** `formSubmissions` (line 312), before the `formChartDiscrepancies` comment at line 314. Definitions exactly as spec §2 gives them, plus:

- On `formTemplateConsents`, the spec's UNIQUE on `(formTemplateId, consentDocumentId)` must be a **real DB unique index**, declared via `pgTable`'s third-argument callback (`(t) => [uniqueIndex('form_template_consents_template_document_unique').on(t.formTemplateId, t.consentDocumentId)]`). Add `uniqueIndex` to the `drizzle-orm/pg-core` import on line 1. An app-level check alone would let two concurrent attaches through; spec §2 calls a duplicate "a mistake, not a supported configuration".
- On `formTemplates`, add `folderId: integer('folder_id').references(() => formTemplateFolders.id),` after `category` (line 276), with a comment naming why it is a separate column from `category`: `category` is the live gate in the sign route and in the patient portal's decision to render `SignConsentFormAction`, so repurposing it as a folder name would break consent signing for every existing submission the moment a folder was renamed (spec §2).
- Extend line 603 in place: `export const signableTypeEnum = pgEnum('signable_type', ['form_submission', 'admission_discharge', 'form_submission_consent'])`.
- On `consentDocuments`, add a comment stating that the wording is deliberately **not** copied into `formSubmissionConsents`: `signatures.attestationText` is the one verbatim record, and a second copy would be a second source of truth (spec §2).

In `src/lib/queries/signatures.ts` line 6, widen: `export type SignableType = 'form_submission' | 'admission_discharge' | 'form_submission_consent'`.

- [ ] **Step 4: Push the schema to the live DB, reviewing every statement**

Run: `npm run db:push -- --verbose --strict --tablesFilter='form_templates,form_template_folders,consent_documents,form_template_consents,form_submission_consents'`

The `--strict` prompt is a real gate. **Confirm only if every printed statement is in this list:**

- `CREATE TYPE "public"."legal_review_status" AS ENUM('draft', 'reviewed')`
- `ALTER TYPE "public"."signable_type" ADD VALUE 'form_submission_consent'`
- `CREATE TABLE "form_template_folders" …`
- `CREATE TABLE "consent_documents" …`
- `CREATE TABLE "form_template_consents" …` (+ its unique index and two FK constraints)
- `CREATE TABLE "form_submission_consents" …` (+ its two FK constraints)
- `ALTER TABLE "form_templates" ADD COLUMN "folder_id" integer` (+ its FK constraint)

**Decline the prompt and stop** if anything else appears — any `DROP`, any `ALTER` to a table not named above, or any `CREATE TABLE "identity_matches"`. That last one is not hypothetical: `identity_matches` is defined in `src/db/schema.ts` but has already been dropped from the shared live DB by the `unified-patient-record` worktree, which is exactly why `--tablesFilter` is here. If it appears despite the filter, report it and stop rather than re-running with variations. Never pass `--force`.

If the `ALTER TYPE … ADD VALUE` step errors about running inside a transaction block, report that exact error rather than working around it — the live DB is PostgreSQL 18.6, which permits it, so a failure there means something unexpected.

- [ ] **Step 5: Verify the live-DB result with a Node script**

`psql` is unavailable. Write a scratch script at this worktree's root (it needs `node_modules` resolution, so it cannot live in the scratchpad directory), run it with `npx dotenv -e .env.local -- node <file>`, and delete it afterward. It must print and you must confirm:

- `information_schema.columns` shows `form_templates.folder_id` as `integer`, `is_nullable = YES`.
- `information_schema.tables` lists all four new tables.
- `pg_enum` for `signable_type` now has exactly three labels including `form_submission_consent`.
- `pg_enum` for `legal_review_status` has `draft`, `reviewed`.
- `information_schema.tables` still does **not** list `identity_matches` (proof the filter held).

Paste the actual output in the task report.

- [ ] **Step 6: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/forms-hub-consents-schema.test.ts tests/db/signatures-schema.test.ts`
Expected: PASS (the existing signatures schema test is included because this task widened its enum).

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts src/lib/queries/signatures.ts tests/db/forms-hub-consents-schema.test.ts
git commit -m "$(cat <<'EOF'
feat: add form template folders, consent documents, and consent join tables

EOF
)"
```

---

### Task 2: Folder query layer, folder routes, and `folderId` on the template routes

**Files:**
- Create: `src/lib/queries/form-template-folders.ts`
- Create: `src/app/api/form-template-folders/route.ts` (GET, POST)
- Create: `src/app/api/form-template-folders/[id]/route.ts` (PUT, DELETE)
- Modify: `src/app/api/form-templates/route.ts` (`createTemplateSchema` gains `folderId`)
- Modify: `src/app/api/form-templates/[id]/route.ts` (`updateTemplateSchema` gains `folderId`; validate it references a real folder)
- Test: `tests/api/form-template-folders.test.ts` (create), `tests/api/form-templates.test.ts` (extend)

**Interfaces:**
- Consumes: `formTemplateFolders`, `formTemplates` from `@/db/schema` (Task 1); `invalidateFormTemplatesList` from `@/lib/queries/form-templates`; `requireSession` from `@/lib/auth`; `logAudit` from `@/lib/audit`.
- Produces, from `@/lib/queries/form-template-folders`:

```ts
export type FormTemplateFolder = typeof formTemplateFolders.$inferSelect

export interface FolderWithCount { id: number; name: string; sortOrder: number; activeTemplateCount: number }

export async function listFormTemplateFolders(): Promise<FolderWithCount[]>
export async function getFormTemplateFolder(id: number): Promise<FormTemplateFolder | null>
export async function createFormTemplateFolder(name: string): Promise<FormTemplateFolder>
export async function renameFormTemplateFolder(id: number, name: string): Promise<boolean>
export async function deleteFormTemplateFolder(id: number): Promise<boolean>
export async function listActiveTemplatesInFolder(folderId: number): Promise<typeof formTemplates.$inferSelect[]>
export async function listArchivedTemplates(): Promise<typeof formTemplates.$inferSelect[]>
export async function countArchivedTemplates(): Promise<number>
```

  `activeTemplateCount` counts `formTemplates WHERE folderId = folder.id AND isActive = true` (spec §3). `listActiveTemplatesInFolder` applies the identical `isActive = true` filter — the two must agree (Review Focus #2). `deleteFormTemplateFolder` sets `folderId = null` on the folder's templates and then deletes the folder row, returning `false` if no such folder existed. Consumed by Task 3.
- Produces: `GET`/`POST /api/form-template-folders`, `PUT`/`DELETE /api/form-template-folders/[id]`; `POST` and `PUT /api/form-templates` accepting `folderId: number | null`. Consumed by Tasks 3 and 6.

- [ ] **Step 1: Write the failing tests — folders**

Create `tests/api/form-template-folders.test.ts`, following `tests/api/form-templates.test.ts`'s conventions exactly (`vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: 'crc', name: 'Jamie Ruiz' })) }))`, tracked ids deleted in `afterEach`, audit assertions scoped to this test's own action string). Route handler shapes are `GET()`, `POST(request)`, and `PUT(request, { params: Promise.resolve({ id: String(folder.id) }) })` / `DELETE(...)` — matching `src/app/api/form-templates/[id]/route.ts:29,39`.

Tests (spec §9, first bullet):

- **a newly created folder appears in the list with 0 templates** — `POST` `{ name: 'Research Forms' }` → 201; `GET` → the row is present with `activeTemplateCount === 0`. A folder with no children is a normal displayed value, which is the entire reason this table exists (spec §1).
- **filing a template into the folder makes the count 1** — insert a template directly with `folderId`, re-`GET`, assert `activeTemplateCount === 1`.
- **an archived template in the folder does not count and is not listed** (Review Focus #2) — insert a second template into the same folder with `isActive: false`; assert `activeTemplateCount` is still 1, and `listActiveTemplatesInFolder(folder.id)` returns exactly the one active template.
- **rename** — `PUT` `{ name: 'Renamed' }` → 200; re-`GET` shows the new name.
- **deleting a non-empty folder un-files its templates instead of deleting them** — `DELETE` → 200; the template row still exists and its `folderId` is now `null`; the folder is gone from `GET`.
- **`DELETE` on a folder id that does not exist** → 404.
- **every folder write invalidates the templates list cache** — call `listFormTemplates()` once to prime the 30-second cache entry, insert a template directly into the DB (bypassing the routes, so only the folder write can clear the cache), perform the folder `POST`, then assert `listFormTemplates()` now contains that template. Without `invalidateFormTemplatesList()` in the folder route it would still be missing for up to 30 seconds (spec §3).
- **role gating** — a `pi` session and a `frontdesk` session each get **403** from `POST`, `PUT`, and `DELETE`, and the folder table is unchanged afterward; an unauthenticated call (mock `requireSession` to resolve a 401 `NextResponse`) gets 401.
- **`.strict()`** — `POST` with `{ name: 'x', sortOrder: 5 }` → 400 (`sortOrder` is not caller-settable; spec §2 gives it a default).
- **audit** — a successful create writes an `auditLog` row with action `created form template folder`, asserted by that exact action string.

- [ ] **Step 2: Write the failing tests — `folderId` on the template routes**

Extend `tests/api/form-templates.test.ts` (add to it; do not restructure it). Spec §9, second bullet, plus Review Focus #1:

- **`POST /api/form-templates` accepts `folderId`** (Review Focus #1) — create a real folder, then `POST` `{ name: 'Untitled Form', category: 'Uncategorized', diagnosisTag: 'General', questions: [], folderId: <id> }` → **201**, and the created row's `folderId` matches. Without the schema change this is a 400 and the whole create-inside-a-folder flow is dead.
- **`POST` accepts `folderId: null`** → 201, `folderId` null.
- **`PUT` accepts `folderId`** → 200, row updated.
- **`PUT` accepts `folderId: null` to un-file** → 200, row's `folderId` is null.
- **a `folderId` pointing at no folder is rejected rather than stored** — `PUT` `{ folderId: 999999999 }` → **400**, and the template's `folderId` is unchanged. Same assertion for `POST`. (An unvalidated value would surface as a raw FK 500.)

- [ ] **Step 3: Run both to confirm they fail**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/form-template-folders.test.ts tests/api/form-templates.test.ts`
Expected: FAIL — the folder route modules don't exist; the template routes reject `folderId` as an unknown `.strict()` field.

- [ ] **Step 4: Implement `src/lib/queries/form-template-folders.ts`**

Signatures exactly as this task's Interfaces block gives them. `listFormTemplateFolders` is one `leftJoin` from `formTemplateFolders` to `formTemplates` with `count(...) FILTER`-equivalent aggregation, or a `leftJoin` restricted to `isActive` rows plus a `groupBy` — either is fine; what is fixed is that the count and `listActiveTemplatesInFolder` apply the **same** `isActive = true` predicate, written once as a shared `and(...)` condition rather than typed twice. Order by `sortOrder` then `name`.

`deleteFormTemplateFolder` is two sequential writes (un-file, then delete), matching this codebase's non-transactional posture; add a comment noting that a folder delete never deletes a template, because refusing to delete a non-empty folder would force staff through a manual un-file loop to reach the same end state with no data at risk either way (spec §3).

- [ ] **Step 5: Implement the two folder routes**

`src/app/api/form-template-folders/route.ts`:

- `export async function GET()` — `requireSession()` → role gate → `listFormTemplateFolders()` → `logAudit(session, 'viewed form template folders', null)`.
- `export async function POST(request: NextRequest)` — schema `z.object({ name: z.string().trim().min(1) }).strict()` → `createFormTemplateFolder` → `invalidateFormTemplatesList()` → `logAudit(session, 'created form template folder', null)` → 201 with the created row.

`src/app/api/form-template-folders/[id]/route.ts`, both handlers taking `{ params }: { params: Promise<{ id: string }> }`:

- `PUT` — schema `z.object({ name: z.string().trim().min(1) }).strict()`; 404 when `renameFormTemplateFolder` returns false; `invalidateFormTemplatesList()`; `logAudit(session, \`renamed form template folder ${id}\`, null)`.
- `DELETE` — no body; 404 when `deleteFormTemplateFolder` returns false; `invalidateFormTemplatesList()`; `logAudit(session, \`deleted form template folder ${id}\`, null)`.

All four handlers carry the `['admin', 'crc']` 403 gate immediately after `requireSession()`.

- [ ] **Step 6: Extend the two template-route schemas**

In `src/app/api/form-templates/route.ts`, add `folderId: z.number().int().positive().nullable().optional()` to `createTemplateSchema`. In `src/app/api/form-templates/[id]/route.ts`, add the same field to `updateTemplateSchema`.

In **both** routes, before the insert/update: when `parsed.data.folderId` is a number, look it up with `getFormTemplateFolder` and return `NextResponse.json({ error: 'No such folder' }, { status: 400 })` if it is missing. Add a one-line comment: a raw FK violation would surface as a 500, and the client needs to distinguish "you sent a bad folder" from "the server broke".

Do **not** add a role gate to these two pre-existing routes — spec §10.2 scopes that out explicitly as a behavior change to shipped endpoints belonging in its own change.

- [ ] **Step 7: Run this task's tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/form-template-folders.test.ts tests/api/form-templates.test.ts tests/lib/queries/form-templates.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/queries/form-template-folders.ts src/app/api/form-template-folders "src/app/api/form-templates/route.ts" "src/app/api/form-templates/[id]/route.ts" tests/api/form-template-folders.test.ts tests/api/form-templates.test.ts
git commit -m "$(cat <<'EOF'
feat: add form template folder routes and folderId on the template routes

EOF
)"
```

---

### Task 3: The Forms Hub — `/forms`, `/forms/folders/[folderId]`, `/forms/archived`

**Files:**
- Modify: `src/app/(dashboard)/forms/page.tsx` (rewrite the body)
- Create: `src/app/(dashboard)/forms/folders/[folderId]/page.tsx`
- Create: `src/app/(dashboard)/forms/archived/page.tsx`
- Create: `src/components/FolderCard.tsx`
- Create: `src/components/NewFolderButton.tsx`
- Create: `src/components/FolderActions.tsx`
- Create: `src/components/RestoreTemplateButton.tsx`
- Modify: `src/components/CreateFormButton.tsx`
- Test: none new — UI over routes fully tested in Task 2. Verified per Global Constraints' UI verification discipline.

**Interfaces:**
- Consumes: `listFormTemplateFolders`, `getFormTemplateFolder`, `listActiveTemplatesInFolder`, `listArchivedTemplates`, `countArchivedTemplates` from `@/lib/queries/form-template-folders` (Task 2); `listFormTemplates` from `@/lib/queries/form-templates`; the folder routes and `PUT /api/form-templates/[id]` (Task 2, called by URL from the client components).
- Produces: `CreateFormButton`'s new prop shape — **`{ folderId }: { folderId: number | null }`**, replacing today's `{ category: string }`. It POSTs `{ name: 'Untitled Form', category: 'Uncategorized', diagnosisTag: 'General', questions: [], folderId }`. Consumed by this task's three pages only (verified: `src/app/(dashboard)/forms/page.tsx` is its sole current call site).

- [ ] **Step 1: Rewrite `/forms`**

`src/app/(dashboard)/forms/page.tsx` keeps `requireSessionOrRedirect()` as its first statement and `logAudit(session, 'viewed form templates', null)`, and gains the role gate from Scope decision #5 immediately after the session call: `if (!['admin', 'crc'].includes(session.role)) redirect('/')`. Replace the `category`-derived sections entirely (spec §3):

- An `<h1>` reading **Questionnaires**.
- One `grid grid-cols-3 gap-4` containing, in order: a `<FolderCard>` per `listFormTemplateFolders()` row; a `<FormTemplateCard>` per template with `folderId === null` **and** `isActive === true`; then `<CreateFormButton folderId={null} />` and `<NewFolderButton />`.
- Above or beside the grid, when `countArchivedTemplates() > 0`, a `<Link href="/forms/archived">` reading `{n} archived`. Top-level hub only — the count is practice-wide, not per-folder (spec §3).
- Empty state when there are no folders and no un-foldered active templates.

Archived templates no longer appear in this grid. That is a deliberate behavior change (spec §3): they become reachable in one click instead of zero, which is the point of archiving them. Note it in the task report.

`FormTemplateCard` is unchanged — its `Inactive` badge branch simply no longer occurs on this page.

- [ ] **Step 2: Build `FolderCard` and `NewFolderButton`**

`src/components/FolderCard.tsx` — a server component, same shape as `FormTemplateCard.tsx` (a plain `<Link>` wrapping hand-rolled card classes, a `lucide-react` `Folder` icon):

```ts
export function FolderCard({ folder }: { folder: { id: number; name: string; activeTemplateCount: number } })
```

Links to `/forms/folders/${folder.id}`, shows the name and `{n} form{s}`. Render `0 forms` as ordinary text — never hide or dim an empty folder, since an empty folder having a visible row is the entire reason this feature exists (spec §1).

`src/components/NewFolderButton.tsx` (`'use client'`) — same dashed-border-button visual as `CreateFormButton`, but unlike that component it **does** surface an error: prompt for a name (a controlled inline input, not `window.prompt`), `POST /api/form-template-folders`, `router.refresh()` on success, an inline `text-xs text-destructive` message on failure.

- [ ] **Step 3: Build the folder page**

`src/app/(dashboard)/forms/folders/[folderId]/page.tsx`, signature `{ params }: { params: Promise<{ folderId: string }> }`, mirroring `src/app/(dashboard)/forms/[templateId]/page.tsx`'s shape. `requireSessionOrRedirect()` → `['admin','crc']` gate → `getFormTemplateFolder(Number(folderId))` → `notFound()` if missing → `logAudit(session, \`viewed form template folder ${folderId}\`, null)`.

Renders the folder name as `<h1>`, a back link to `/forms`, `<FolderActions folder={...} />`, and the same grid filtered to `listActiveTemplatesInFolder(folder.id)` with `<CreateFormButton folderId={folder.id} />`. No archived-count link here (spec §3: top-level only).

`src/components/FolderActions.tsx` (`'use client'`), `{ folder }: { folder: { id: number; name: string } }` — Rename (inline input → `PUT /api/form-template-folders/${id}`, `router.refresh()`) and Delete (`DELETE`, then `router.push('/forms')`). Delete's confirmation copy must state what actually happens: `Delete this folder? The {n} forms in it will be moved out of the folder, not deleted.`

- [ ] **Step 4: Build the archived page**

`src/app/(dashboard)/forms/archived/page.tsx` — `requireSessionOrRedirect()` → `['admin','crc']` gate → `listArchivedTemplates()` → `logAudit(session, 'viewed archived form templates', null)`. A simple list (not the card grid): each row shows the template name, its `diagnosisTag`, and a `<RestoreTemplateButton templateId={t.id} />`. Back link to `/forms`. Empty state: `No archived forms.`

`src/components/RestoreTemplateButton.tsx` (`'use client'`), `{ templateId }: { templateId: number }` — `PUT /api/form-templates/${templateId}` with body `{ isActive: true }` (the existing route already accepts it), `router.refresh()` on success, inline error otherwise.

- [ ] **Step 5: Change `CreateFormButton`'s contract**

`src/components/CreateFormButton.tsx`: replace the `category` prop with `folderId: number | null`, send `category: 'Uncategorized'` literally (spec §3 — `category` is `notNull`, the old category headings no longer exist, and staff change it in the editor's Category field), and include `folderId` in the POST body. Add an inline error message; the current silent-no-op-on-failure would now hide a real 400 from the folder validation added in Task 2.

- [ ] **Step 6: Verify against a real running dev server**

Start the dev server on a free port. Mint a `clinsync_demo_session` cookie for an `admin` via `buildSessionCookieValue('admin', 'Test Admin')` with `SESSION_SECRET` from `.env.local`.

Real requests, with actual commands and actual output pasted in the report:
- `GET /forms` — the Questionnaires heading renders; no archived template appears in the grid.
- Create a folder through the UI/route; `GET /forms` again — the new folder card renders reading **0 forms** (Review Focus #2's visible half).
- `GET /forms/folders/<id>` — empty grid, Create New present.
- Create a form there; confirm the response's `folderId` matches and the folder card now reads **1 form** on `/forms` immediately (not after 30s — proves the cache invalidation).
- Archive that template (`PUT /api/form-templates/<id>` `{ isActive: false }`); confirm the folder card drops back to **0 forms**, the template is gone from `/forms/folders/<id>`, and the `1 archived` link appears on `/forms`.
- `GET /forms/archived` — the template is listed; Restore returns it to the folder.
- Delete a non-empty folder; confirm its templates survive on `/forms` as un-foldered cards.
- Mint a `frontdesk` cookie and `GET /forms`, `/forms/archived`, `/forms/folders/<id>` — each redirects rather than rendering.

Stop the dev server and delete any folder/template you created.

- [ ] **Step 7: Run the full suite once**

Run: `npx dotenv -e .env.local -- npx vitest run`
Expected: all pass. (`tests/components/*` and `tests/pages/*` may reference `CreateFormButton`'s old prop — if so, update those call sites in this task rather than leaving a broken test.)

- [ ] **Step 8: Commit**

```bash
git add "src/app/(dashboard)/forms" src/components/FolderCard.tsx src/components/NewFolderButton.tsx src/components/FolderActions.tsx src/components/RestoreTemplateButton.tsx src/components/CreateFormButton.tsx
git commit -m "$(cat <<'EOF'
feat: rebuild /forms as a folder-based hub with archived and per-folder views

EOF
)"
```

---

### Task 4: Consent documents — rendering, query layer, routes, library page

**Files:**
- Create: `src/lib/queries/consent-documents.ts`
- Create: `src/app/api/consent-documents/route.ts` (GET, POST)
- Create: `src/app/api/consent-documents/[id]/route.ts` (GET, PUT)
- Create: `src/app/(dashboard)/consent-documents/page.tsx`
- Create: `src/app/(dashboard)/consent-documents/[id]/page.tsx`
- Create: `src/components/NewConsentDocumentButton.tsx`
- Create: `src/components/ConsentDocumentEditor.tsx`
- Modify: `src/components/LeftNav.tsx` (a `Consent Documents` entry, `roles: ['admin', 'crc']`)
- Test: `tests/api/consent-documents.test.ts`

**Interfaces:**
- Consumes: `consentDocuments`, `formTemplateConsents`, `formSubmissionConsents`, `signatures` from `@/db/schema` (Task 1).
- Produces, from `@/lib/queries/consent-documents`:

```ts
export type ConsentDocument = typeof consentDocuments.$inferSelect
export type LegalReviewStatus = 'draft' | 'reviewed'

export const CONSENT_DRAFT_BANNER = '[DRAFT — NOT YET REVIEWED BY LEGAL COUNSEL. DO NOT RELY ON THIS WORDING.]'

/** The exact string a signer is shown AND the exact string stored in
 *  signatures.attestationText. Derived from status at render time and never
 *  stored on consentDocuments, so the two cannot drift (spec §5). */
export function renderConsentText(doc: { bodyText: string; legalReviewStatus: LegalReviewStatus }): string

export interface ConsentDocumentRow {
  id: number
  name: string
  bodyText: string
  legalReviewStatus: LegalReviewStatus
  createdAt: Date
  updatedAt: Date
  onFormsCount: number
  signedCount: number
}

export async function listConsentDocumentsWithCounts(): Promise<ConsentDocumentRow[]>
export async function getConsentDocumentWithCounts(id: number): Promise<ConsentDocumentRow | null>
export async function listConsentDocuments(): Promise<ConsentDocument[]>
export async function createConsentDocument(input: { name: string; bodyText: string }): Promise<ConsentDocument>
export async function updateConsentDocument(id: number, patch: { name?: string; bodyText?: string; legalReviewStatus?: LegalReviewStatus }): Promise<boolean>
```

  `renderConsentText` returns `bodyText` unchanged when `legalReviewStatus === 'reviewed'`, and `${CONSENT_DRAFT_BANNER}\n\n${bodyText}` when it is `'draft'` (spec §5's exact composition). `updateConsentDocument` also sets `updatedAt: new Date()`. `onFormsCount` = `count(formTemplateConsents WHERE consentDocumentId = …)`; `signedCount` = `count(signatures WHERE signableType = 'form_submission_consent' AND signableId IN (SELECT id FROM formSubmissionConsents WHERE consentDocumentId = …))`, both derived at read time and never stored (spec §5). `listConsentDocuments` (no counts) is the cheap picker source consumed by Task 5's Attach control. `renderConsentText` is consumed by Task 7.
- Produces: `GET`/`POST /api/consent-documents`, `GET`/`PUT /api/consent-documents/[id]`. Consumed by this task's pages. **No DELETE route exists** (spec §8) — a document with recorded signatures must not vanish, and one without them is harmless to leave in the library.

- [ ] **Step 1: Write the failing tests**

Create `tests/api/consent-documents.test.ts`, following `tests/api/form-templates.test.ts`'s mocking and cleanup conventions. Handler shapes: `GET()`, `POST(request)`, `GET(request, { params: Promise.resolve({ id }) })`, `PUT(request, { params })`. Delete signatures scoped by `(signableType, signableId)` and clean up in FK order (signatures → formSubmissionConsents → formTemplateConsents → formSubmissions → formTemplates → consentDocuments).

Tests (spec §9, third bullet, plus Review Focus #5):

- **create / read / edit round-trip** — `POST` `{ name, bodyText }` → 201; `GET /[id]` returns it; `PUT` `{ name, bodyText, legalReviewStatus: 'reviewed' }` → 200 and the changes read back.
- **`legalReviewStatus` defaults to `'draft'`** on a create that omits it.
- **`renderConsentText` composes the banner for a draft and not for a reviewed document** — a direct unit assertion: for `{ bodyText: 'By signing…', legalReviewStatus: 'draft' }` the result **starts with** `CONSENT_DRAFT_BANNER` and **contains** `'By signing…'`; for `'reviewed'` it equals `'By signing…'` exactly.
- **the On Forms count reflects attachments across two templates** — create two templates, attach the same document to both via direct `formTemplateConsents` inserts, assert `onFormsCount === 2`.
- **the Signed count reflects signatures across submissions of both templates** — create one submission per template, one `formSubmissionConsents` row each, one `signatures` row each with `signableType: 'form_submission_consent'`; assert `signedCount === 2`.
- **editing `bodyText` after a signature exists leaves that signature's `attestationText` byte-for-byte unchanged** — *the load-bearing assertion of the whole spec.* Capture the exact stored string before the edit, `PUT` a completely different `bodyText`, re-read the signature row, and `expect(after.attestationText).toBe(before)` — a strict identity comparison, not `toContain`.
- **flipping `legalReviewStatus` from `'draft'` to `'reviewed'` after a signature exists leaves that signature's `attestationText` unchanged, banner included** (Review Focus #5) — same identity comparison, plus `expect(after.attestationText.startsWith(CONSENT_DRAFT_BANNER)).toBe(true)`.
- **role gating** — `pi` and `frontdesk` get 403 from `POST` and `PUT`, and from `GET` (spec §11: viewing the library is admin/crc); no session → 401.
- **`.strict()`** — `POST` with an extra field (e.g. `{ name, bodyText, signedCount: 99 }`) → 400. `PUT` with `{ legalReviewStatus: 'pending' }` → 400 (not an enum value).
- **audit** — a successful create writes an `auditLog` row with action `created consent document`, asserted by that exact string.

- [ ] **Step 2: Run them to confirm they fail**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/consent-documents.test.ts`
Expected: FAIL — the query module and route modules don't exist.

- [ ] **Step 3: Implement `src/lib/queries/consent-documents.ts`**

Signatures exactly as this task's Interfaces block gives them. The `signedCount` subquery must filter on **both** `signableType` and the `signableId` set — `signableId` alone would count an unrelated `form_submission` or `admission_discharge` signature that happens to share a small integer id, the same hazard `tests/api/form-submission-sign.test.ts`'s cleanup comment already documents.

Add a comment on `renderConsentText` explaining why the banner is derived rather than stored: a stored copy could drift from the status column, and the composed string is what goes into the attestation, so a signature collected against a draft carries permanent, self-evident proof the signer was shown the warning (spec §5).

- [ ] **Step 4: Implement the two routes**

`src/app/api/consent-documents/route.ts`:
- `GET()` — session → `['admin','crc']` gate → `listConsentDocumentsWithCounts()` → `logAudit(session, 'viewed consent documents', null)`.
- `POST(request)` — schema `z.object({ name: z.string().trim().min(1), bodyText: z.string().min(1) }).strict()` → `createConsentDocument` → `logAudit(session, 'created consent document', null)` → 201.

`src/app/api/consent-documents/[id]/route.ts`, both taking `{ params }: { params: Promise<{ id: string }> }`:
- `GET` — `getConsentDocumentWithCounts`; 404 when null; `logAudit(session, \`viewed consent document ${id}\`, null)`.
- `PUT` — schema `z.object({ name: z.string().trim().min(1).optional(), bodyText: z.string().min(1).optional(), legalReviewStatus: z.enum(['draft', 'reviewed']).optional() }).strict()`; 404 when `updateConsentDocument` returns false; `logAudit(session, \`updated consent document ${id}\`, null)`.

Neither route touches `formTemplatesListCacheKey()` — consent documents are not part of the hub's cached template list. (Task 5's attach/detach routes do, because the editor's consent counts hang off a template.)

- [ ] **Step 5: Build the library page**

`src/app/(dashboard)/consent-documents/page.tsx` — `requireSessionOrRedirect()` → `['admin','crc']` gate (`redirect('/')`) → `listConsentDocumentsWithCounts()` → `logAudit(session, 'viewed consent documents', null)`. Renders spec §5's table using the existing shadcn `Table` primitives from `@/components/ui/table`: columns **Name**, **Wording** (the first ~80 characters of `renderConsentText(doc)` followed by an ellipsis, so the draft banner is visible in the list exactly as it will be to a signer), **On Forms**, **Signed**, and an **Edit** link to `/consent-documents/${id}`. Plus `<NewConsentDocumentButton />`.

`src/components/NewConsentDocumentButton.tsx` (`'use client'`) — name input + `<textarea>` for `bodyText`, `POST /api/consent-documents`, `router.push('/consent-documents/' + created.id)` on success, inline error otherwise.

Add a `Consent Documents` entry to `src/components/LeftNav.tsx` with `roles: ['admin', 'crc']`, matching the existing `/forms` entry's shape.

- [ ] **Step 6: Build the edit page**

`src/app/(dashboard)/consent-documents/[id]/page.tsx`, `{ params }: { params: Promise<{ id: string }> }` — same guard/gate/audit shape, `getConsentDocumentWithCounts(Number(id))`, `notFound()` if missing, renders `<ConsentDocumentEditor document={doc} />`.

`src/components/ConsentDocumentEditor.tsx` (`'use client'`), taking the `ConsentDocumentRow`: a name `<input>`, a plain `<textarea>` for `bodyText` (spec explicitly rules out a rich-text editor), a `legalReviewStatus` control over `draft` / `reviewed`, and a Save button calling `PUT /api/consent-documents/${id}`.

When `document.signedCount > 0`, render above the textarea, exactly:

`{signedCount} signatures recorded against earlier wording — editing this text does not change what those people agreed to.`

(Spec §5 requires this because it is true and a person editing legal wording should be told it. Use the singular `signature` for a count of 1.)

- [ ] **Step 7: Run this task's tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/consent-documents.test.ts tests/components/LeftNav.test.tsx`
Expected: PASS.

- [ ] **Step 8: Verify against a real running dev server**

Admin cookie, real requests, pasted output: create a consent document; `GET /consent-documents` shows it with the `[DRAFT — NOT YET REVIEWED BY LEGAL COUNSEL. DO NOT RELY ON THIS WORDING.]` prefix in the Wording column and `0` / `0` counts; open the edit page, flip it to `reviewed`, confirm the banner disappears from the list. Mint a `pi` cookie and confirm `/consent-documents` redirects.

- [ ] **Step 9: Commit**

```bash
git add src/lib/queries/consent-documents.ts src/app/api/consent-documents "src/app/(dashboard)/consent-documents" src/components/NewConsentDocumentButton.tsx src/components/ConsentDocumentEditor.tsx src/components/LeftNav.tsx tests/api/consent-documents.test.ts
git commit -m "$(cat <<'EOF'
feat: add the consent documents library with draft-banner rendering

EOF
)"
```

---

### Task 5: Attaching and detaching consent documents to templates

**Files:**
- Create: `src/lib/queries/form-template-consents.ts`
- Create: `src/app/api/form-templates/[id]/consents/route.ts` (GET, POST)
- Create: `src/app/api/form-templates/[id]/consents/[consentDocumentId]/route.ts` (DELETE)
- Test: `tests/api/form-template-consents.test.ts`

**Interfaces:**
- Consumes: `formTemplateConsents`, `consentDocuments`, `formSubmissionConsents`, `formSubmissions`, `signatures` from `@/db/schema` (Task 1); `getFormTemplate` from `@/lib/queries/form-templates`; `invalidateFormTemplatesList`.
- Produces, from `@/lib/queries/form-template-consents`:

```ts
export interface AttachedConsentRow {
  formTemplateConsentId: number
  consentDocumentId: number
  name: string
  bodyPreview: string          // first line of bodyText, truncated
  legalReviewStatus: 'draft' | 'reviewed'
  sortOrder: number
  signedCount: number          // scoped to submissions of THIS template
}

export type AttachResult =
  | { ok: true; formTemplateConsentId: number }
  | { ok: false; reason: 'duplicate' | 'no_such_document' | 'no_such_template' }

export async function listConsentsForTemplate(formTemplateId: number): Promise<AttachedConsentRow[]>
export async function attachConsentToTemplate(formTemplateId: number, consentDocumentId: number): Promise<AttachResult>
export async function detachConsentFromTemplate(formTemplateId: number, consentDocumentId: number): Promise<boolean>
export async function countConsentsForTemplate(formTemplateId: number): Promise<number>
```

  `signedCount` is the per-template count from spec §4: `count(signatures WHERE signableType = 'form_submission_consent' AND signableId IN (formSubmissionConsents rows whose formSubmissionId belongs to a submission of this template AND whose consentDocumentId is this document))`, derived at read time, never stored. `attachConsentToTemplate` assigns `sortOrder = countConsentsForTemplate(...)` so attachment order is preserved. Consumed by Tasks 6 and 7.
- Produces: `GET`/`POST /api/form-templates/[id]/consents`, `DELETE /api/form-templates/[id]/consents/[consentDocumentId]`. Consumed by Task 6.

- [ ] **Step 1: Write the failing tests**

Create `tests/api/form-template-consents.test.ts`, same conventions. Handler param shapes: `{ params: Promise.resolve({ id: String(templateId) }) }` and `{ params: Promise.resolve({ id: String(templateId), consentDocumentId: String(docId) }) }`.

Tests (spec §9, fourth bullet):

- **attach** — `POST` `{ consentDocumentId }` → 201; `GET` lists it with the document's name, `legalReviewStatus`, and `signedCount === 0`.
- **detach** — `DELETE` → 200; `GET` is empty.
- **attaching the same document twice is rejected** — the second `POST` → **409**, and `GET` still shows exactly one row. (The DB unique index from Task 1 is the real boundary; the route maps the violation to a 409 rather than letting it surface as a 500.)
- **attaching a `consentDocumentId` that does not exist** → 400, nothing inserted.
- **attaching to a template id that does not exist** → 404.
- **detaching after signatures exist leaves both `formSubmissionConsents` and `signatures` rows intact** — attach; create a submission of that template with a `formSubmissionConsents` row; insert a `form_submission_consent` signature against it; `DELETE` the attachment → 200; assert the `formSubmissionConsents` row still exists and the `signatures` row still exists with its `attestationText` unchanged. Packets already sent keep their consent pages, and past signatures stay exactly where they are (spec §4).
- **the per-template signed count** — with the above signature in place, re-attach and assert `GET` reports `signedCount === 1`; a signature against a *different* template's submission of the same document does not raise it.
- **role gating** — `pi` and `frontdesk` get 403 from `GET`, `POST`, and `DELETE` (spec §11 gates the signed counts too); no session → 401.
- **`.strict()`** — `POST` with `{ consentDocumentId, sortOrder: 3 }` → 400.
- **audit** — a successful attach writes action `attached consent document to form template <id>`; detach writes `detached consent document from form template <id>`. Assert by exact string.

- [ ] **Step 2: Run them to confirm they fail**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/form-template-consents.test.ts`
Expected: FAIL — modules don't exist.

- [ ] **Step 3: Implement `src/lib/queries/form-template-consents.ts`**

Signatures exactly as the Interfaces block gives them. `attachConsentToTemplate` checks the template and document exist, then inserts and **catches the unique-constraint violation** to return `{ ok: false, reason: 'duplicate' }` — do not pre-check-then-insert, which loses the race the unique index exists to win. `bodyPreview` is the first line of `bodyText` truncated to 80 characters; it is a UI preview only, never the signed text (that is `renderConsentText` from Task 4).

- [ ] **Step 4: Implement the two routes**

`src/app/api/form-templates/[id]/consents/route.ts` — `GET` (list) and `POST` (schema `z.object({ consentDocumentId: z.number().int().positive() }).strict()`), mapping `AttachResult`:

| reason | response |
|---|---|
| `no_such_template` | 404 `{ error: 'Not found' }` |
| `no_such_document` | 400 `{ error: 'No such consent document' }` |
| `duplicate` | 409 `{ error: 'This consent document is already attached to this form' }` |
| `ok: true` | 201 `{ formTemplateConsentId }` |

`src/app/api/form-templates/[id]/consents/[consentDocumentId]/route.ts` — `DELETE`, no body, 404 when `detachConsentFromTemplate` returns false.

Both files: `requireSession()` first, then the `['admin', 'crc']` 403 gate, then `logAudit` on the writes and `invalidateFormTemplatesList()` on attach and detach (the hub's per-template data is read through that cached list).

- [ ] **Step 5: Run this task's tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/form-template-consents.test.ts tests/api/consent-documents.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/queries/form-template-consents.ts "src/app/api/form-templates/[id]/consents" tests/api/form-template-consents.test.ts
git commit -m "$(cat <<'EOF'
feat: add attach/detach routes for template consent documents

EOF
)"
```

---

### Task 6: The template editor frame — toolbar, info panel, Consent Forms tab, folder picker

**Files:**
- Create: `src/components/IntakeQuestionField.tsx` (extracted from `IntakePortalForm`)
- Create: `src/components/FormTemplatePreviewModal.tsx`
- Create: `src/components/TemplateConsentsPanel.tsx`
- Modify: `src/components/FormBuilderEditor.tsx`
- Modify: `src/components/IntakePortalForm.tsx` (render the extracted field component; no behavior change)
- Modify: `src/app/(dashboard)/forms/[templateId]/page.tsx` (pass the new props)
- Test: `tests/components/FormBuilderEditor.test.tsx` (extend)

**Interfaces:**
- Consumes: `AttachedConsentRow` and the attach/detach routes (Task 5); `listConsentDocuments` (Task 4); `listFormTemplateFolders` (Task 2); `PUT /api/form-templates/[id]` accepting `folderId` and `isActive` (Task 2 / existing); `SendFormModal` (existing, `{ templates: { id; name }[]; patients; onClose }`); `listPatientsWithStatus` from `@/lib/queries/patients` (existing) as `SendFormModal`'s patients source.
- Produces:

```ts
// src/components/IntakeQuestionField.tsx  ('use client')
export interface IntakeQuestion { id: string; label: string; type: 'text' | 'textarea' | 'date' | 'select' | 'checkbox'; options?: string[]; required: boolean }
export function IntakeQuestionField({ question, value, onChange, disabled }: {
  question: IntakeQuestion
  value: string | undefined
  onChange: (value: string) => void
  disabled?: boolean
}): React.ReactElement
```

  The single per-question renderer, consumed by `IntakePortalForm` (unchanged behavior) and `FormTemplatePreviewModal` (`disabled`, no state). Also consumed by Task 9.
- Produces: `FormBuilderEditor`'s new prop shape — `templateId`, `initialName`, `initialCategory`, `initialDiagnosisTag`, `initialQuestions` (all existing), plus `initialFolderId: number | null`, `initialIsActive: boolean`, `folders: { id: number; name: string }[]`, `attachedConsents: AttachedConsentRow[]`, `allConsentDocuments: { id: number; name: string }[]`, `patients` — whose element shape is fixed by `SendFormModal`'s **existing, unchanged** prop type, which this task only forwards. That is the one place a pre-existing dual-sourced field name appears in this plan's diff; it is not new code, and the parallel `unified-patient-record` plan is the thing removing it. Do not rename it here.

- [ ] **Step 1: Extract the intake field renderer**

Move `IntakePortalForm.tsx`'s per-question `switch` (textarea / select / checkbox-as-`'true'|'false'`-string / text|date) verbatim into `src/components/IntakeQuestionField.tsx` with the signature above, and have `IntakePortalForm` render `<IntakeQuestionField … />` in its place. `IntakePortalForm`'s progress bar, `isAnswered`, submit buttons, and PUT call are untouched. This is a pure extraction with **no behavior change** — spec §4 requires the preview to reuse the intake portal's own field rendering so it cannot drift (Scope decision #4).

- [ ] **Step 2: Run the existing intake tests to confirm the extraction changed nothing**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/intake-portal.test.ts tests/components/FormBuilderEditor.test.tsx`
Expected: PASS, unchanged.

- [ ] **Step 3: Write the failing editor tests**

Extend `tests/components/FormBuilderEditor.test.tsx` (add to it; it already renders the component with `@testing-library/react`). New assertions:

- the toolbar renders, in order, controls labelled `Send to Client`, `Preview`, `Consent Forms`, and `Add New Question`.
- the saved-status indicator reads `Unsaved changes` after a question's label is edited, and the editor still exposes an explicit `Save` control (no autosave: no `fetch` is issued by the edit alone).
- a Folder `<select>` renders beside Category, seeded to `initialFolderId`, with an option for un-filed.
- clicking `Consent Forms` swaps the body from the question list to the attached-consents view, and clicking back returns to the questions.
- with `attachedConsents` non-empty, that view shows each document's name, its `legalReviewStatus`, its signed count, and a `Detach` control.
- the right-hand info panel shows the template name, the question count, the attached-consent count, and the five static `Common things you can do here` items.

- [ ] **Step 4: Run them to confirm they fail**

Run: `npx dotenv -e .env.local -- npx vitest run tests/components/FormBuilderEditor.test.tsx`
Expected: FAIL — the toolbar, panel, tab, and folder picker don't exist.

- [ ] **Step 5: Build the toolbar, panel, folder picker, and saved status**

In `src/components/FormBuilderEditor.tsx`, keep the question list and the Name / Category / Diagnosis tag fields **exactly as they are** — Category remains an editable semantic tag, it is simply no longer what the hub groups by (spec §4). Add:

- **Toolbar**, in spec §4's order: `Send to Client` (renders the existing `SendFormModal` with `templates={[{ id: templateId, name }]}` and the `patients` prop — no new send mechanism), `Preview` (renders `FormTemplatePreviewModal`), `Consent Forms` (a tab, not a modal), the saved-status indicator with the existing explicit Save beside it, and `Add New Question` moved up from the bottom of the page.
- **Saved status:** hold a `savedSnapshot` string (`JSON.stringify` of the saved `{ name, category, diagnosisTag, folderId, questions }`) and a `lastSavedAt: Date | null`. Render `Saved · {lastSavedAt.toLocaleTimeString()}` when the current state serializes identically, `Unsaved changes` otherwise. **Do not introduce autosave** — spec §4 rules it out explicitly as a real behavior change (a half-edited question silently reaching a patient mid-edit) that must not be smuggled in under a visual redesign.
- **Folder picker** beside Category: a `<select>` over `folders` plus a `— No folder —` option mapping to `null`, included in the existing `save()`'s PUT body as `folderId`.
- **Archive** control (Scope decision #6): `PUT /api/form-templates/${templateId}` with `{ isActive: false }` then `router.push('/forms')`. Hidden when `initialIsActive` is already false.
- **Right-hand info panel:** the template name, the question count, the attached-consent count, and the static list — add a question, mark a question as containing PHI, attach a consent document, send the form to a client, archive the template. It is a static quick-reference, not a checklist with state (spec §4).

- [ ] **Step 6: Build the preview modal and the Consent Forms tab**

`src/components/FormTemplatePreviewModal.tsx` (`'use client'`), `{ name, questions, onClose }` — a shadcn `Dialog` rendering each question through `<IntakeQuestionField question={q} value={undefined} onChange={() => {}} disabled />`. It creates **no `formSubmissions` row and issues no token** (spec §4); add that as a code comment so nobody later "improves" it into a real send.

`src/components/TemplateConsentsPanel.tsx` (`'use client'`), `{ templateId, attached, allDocuments }` — lists each `AttachedConsentRow` (name, `bodyPreview`, `legalReviewStatus`, signed count) with a `Detach` control calling `DELETE /api/form-templates/${templateId}/consents/${consentDocumentId}`, plus an `Attach` picker over `allDocuments` calling `POST /api/form-templates/${templateId}/consents`. `router.refresh()` after either; surface the route's own error text (the 409 says why).

The signed count renders **next to** the Detach control, deliberately: detaching a document that already has signatures is allowed and removes only the `formTemplateConsents` row, so the person clicking it should be able to see what they are detaching from (spec §4). Add that sentence as a code comment and as the Detach confirmation copy.

- [ ] **Step 7: Feed the new props from the page**

In `src/app/(dashboard)/forms/[templateId]/page.tsx`, add the `['admin','crc']` gate (Scope decision #5) and `Promise.all` the four new reads — `listFormTemplateFolders()`, `listConsentsForTemplate(template.id)`, `listConsentDocuments()`, `listPatientsWithStatus(null)` — passing them plus `template.folderId` and `template.isActive` into `FormBuilderEditor`.

- [ ] **Step 8: Run this task's tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/components/FormBuilderEditor.test.tsx tests/components/SendFormModal.test.tsx tests/api/intake-portal.test.ts`
Expected: PASS.

- [ ] **Step 9: Verify against a real running dev server**

Admin cookie, real requests, pasted output: open `/forms/<id>`; confirm the toolbar order, that the status reads `Saved · …` on load and flips to `Unsaved changes` on an edit with **no network request fired**, that Save persists and the status returns to `Saved · …`; open Preview and confirm the fields render read-only and **no new `form_submissions` row appeared** (check the row count before and after); switch to Consent Forms, attach a document, confirm it appears with its status and a signed count of 0; move the template to a folder and confirm `/forms` reflects it immediately; Archive it and confirm it lands on `/forms/archived`.

- [ ] **Step 10: Commit**

```bash
git add src/components/IntakeQuestionField.tsx src/components/FormTemplatePreviewModal.tsx src/components/TemplateConsentsPanel.tsx src/components/FormBuilderEditor.tsx src/components/IntakePortalForm.tsx "src/app/(dashboard)/forms/[templateId]/page.tsx" tests/components/FormBuilderEditor.test.tsx
git commit -m "$(cat <<'EOF'
feat: add editor toolbar, info panel, folder picker, and Consent Forms tab

EOF
)"
```

---

### Task 7: Inline consent signing — submission rows, intake data, sign route, completion gate

**Files:**
- Create: `src/lib/queries/form-submission-consents.ts`
- Create: `src/app/api/intake/[token]/consents/[formSubmissionConsentId]/sign/route.ts`
- Modify: `src/app/api/form-submissions/route.ts` (POST also copies the template's consents)
- Modify: `src/lib/queries/intake-portal.ts` (`IntakePortalData` gains `consents`)
- Modify: `src/app/api/intake/[token]/route.ts` (PUT completion gate)
- Test: `tests/api/intake-consent-sign.test.ts`

**Interfaces:**
- Consumes: `formSubmissionConsents`, `consentDocuments`, `formTemplateConsents`, `signatures` from `@/db/schema` (Task 1); `renderConsentText` from `@/lib/queries/consent-documents` (Task 4); `createSignature` and the widened `SignableType` from `@/lib/queries/signatures` (Task 1); `getSubmissionPatientIdByToken` from `@/lib/queries/intake-portal` (existing); `logPatientPortalAction` from `@/lib/patient-portal-audit`.
- Produces, from `@/lib/queries/form-submission-consents`:

```ts
export interface SubmissionConsent {
  formSubmissionConsentId: number
  name: string
  renderedText: string              // server-composed; never client-supplied
  signedAt: Date | null
  signerTypedName: string | null
}

export async function copyTemplateConsentsToSubmission(formTemplateId: number, formSubmissionId: number): Promise<number>
export async function listConsentsForSubmission(formSubmissionId: number): Promise<SubmissionConsent[]>
export async function countUnsignedConsentsByToken(token: string): Promise<number>
export async function hasAttachedConsents(formSubmissionId: number): Promise<boolean>
export async function getSubmissionConsentForToken(token: string, formSubmissionConsentId: number): Promise<{ formSubmissionId: number; patientId: string; renderedText: string; alreadySigned: boolean } | null>
```

  `copyTemplateConsentsToSubmission` copies the template's **current** `formTemplateConsents` rows, preserving `sortOrder`, and returns the number created (0 when the template has none). `listConsentsForSubmission` orders by `sortOrder` and left-joins the latest `signatures` row for `('form_submission_consent', id)`. `getSubmissionConsentForToken` returns `null` when the token is invalid **or** when the consent row belongs to a different submission — the ownership check lives here, in one place, so the route cannot forget it. `countUnsignedConsentsByToken` is keyed by **token**, not submission id, precisely so the completion gate in `PUT /api/intake/[token]` needs no extra id-resolution round trip in a handler that only has the token in scope. `hasAttachedConsents` takes an id because its caller (Task 8's legacy route) already has one.
- Produces: `IntakePortalData.consents?: SubmissionConsent[]` on the `'active'` branch; `POST /api/intake/[token]/consents/[formSubmissionConsentId]/sign`. Consumed by Tasks 8 and 9.

- [ ] **Step 1: Write the failing tests**

Create `tests/api/intake-consent-sign.test.ts`. Reuse `tests/api/intake-portal.test.ts`'s `sendRealForm()` shape (call the real `POST /api/form-submissions` so send-time row creation is genuinely exercised), `vi.mock('@/lib/auth', …)` for that staff-side call only, and clean up in FK order with signatures scoped by `(signableType, signableId)`.

Tests (spec §9, fifth bullet, plus Review Focus #3 and #4):

- **sending a form with attached consents creates the matching `formSubmissionConsents` rows** — attach two documents to a template, `POST /api/form-submissions`, assert two rows exist for the new submission with `sortOrder` preserved.
- **a template with no attached consents produces no rows** and `GET /api/intake/[token]` returns `consents: []` (or absent) — the intake flow is byte-for-byte what it is today.
- **signing inserts a `signatures` row with `signableType = 'form_submission_consent'`** whose `signableId` is the `formSubmissionConsents` id and whose `signerRole` is `'patient'`.
- **`attestationText` contains the draft banner when the document is `'draft'`** — `expect(sig.attestationText.startsWith(CONSENT_DRAFT_BANNER)).toBe(true)` — **and does not when it is `'reviewed'`** — `expect(sig.attestationText).toBe(doc.bodyText)`.
- **signing the same row twice returns 409**, and exactly one signature row exists afterward.
- **a valid token for form A cannot sign a consent belonging to form B** — send two forms, attempt to sign B's `formSubmissionConsentId` with A's token → 404, and no signature row is created for either.
- **an unknown token** → 404. **An expired or already-completed submission's token** → 404 (`getSubmissionPatientIdByToken` already refuses these).
- **the body is `{ typedName }` and nothing else** (Review Focus #3) — `POST` with `{ typedName: 'Maria Alvarez', attestationText: 'I agree to nothing' }` → **400**, and no signature row is created. Same for an extra `consentDocumentId`, `signerRole`, or `signedAt`.
- **`PUT /api/intake/[token]` with `complete: true` is rejected while any consent is unsigned** → 400 with exactly `'This form has unsigned consent documents'`; the submission's status is still not `'completed'`.
- **saving partial progress is unaffected** — the same `PUT` with `complete: false` → 200 and the answers persist, with consents still unsigned.
- **`complete: true` succeeds once every consent is signed** → 200, status `'completed'`.
- **a submission with no attached consents completes exactly as it does today** → 200.
- **a consent-only packet is completable** (Review Focus #4) — a template with `questions: []` and one attached consent: `GET` returns `questions: []` and one consent; `PUT { answers: {}, complete: true }` → 400 while unsigned; sign; the same `PUT` → 200 and status `'completed'`.
- **audit** — signing writes an `auditLog` row with action `signed consent document via intake form`, asserted by that exact string.

- [ ] **Step 2: Run them to confirm they fail**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/intake-consent-sign.test.ts`
Expected: FAIL — the query module and sign route don't exist.

- [ ] **Step 3: Implement `src/lib/queries/form-submission-consents.ts`**

Signatures exactly as the Interfaces block gives them. Two comments are load-bearing and must be written:

- On `copyTemplateConsentsToSubmission`: rows are written at send time, so detaching a consent document from a template later does not change a packet already in a patient's hands. This is a deliberate, narrow divergence from how questions behave (`getIntakePortalData` reads `formTemplates.questions` live) — a question changing under a patient produces a confusing form, while a consent changing under a patient produces a signature against something they were never shown. Questions are **not** being changed to match (spec §2).
- On `SubmissionConsent.renderedText`: composed server-side from `renderConsentText`, so the client cannot render wording that differs from what will be stored (spec §6).

- [ ] **Step 4: Copy the consents at send time**

In `src/app/api/form-submissions/route.ts`'s `POST`, after the `formSubmissions` insert and before the audit call, `await copyTemplateConsentsToSubmission(parsed.data.templateId, created.id)`. Two sequential writes, matching this codebase's non-transactional posture. Everything else in this route is unchanged.

- [ ] **Step 5: Add `consents` to the intake portal payload**

In `src/lib/queries/intake-portal.ts`, add `consents?: SubmissionConsent[]` to `IntakePortalData` and populate it on the `'active'` return via `listConsentsForSubmission(row.submission.id)`. The `'not_found'` / `'expired'` / `'completed'` branches are unchanged.

- [ ] **Step 6: Implement the sign route**

`src/app/api/intake/[token]/consents/[formSubmissionConsentId]/sign/route.ts`:

```ts
export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string; formSubmissionConsentId: string }> })
```

Schema: `z.object({ typedName: z.string().trim().min(1) }).strict()`.

**It must not call `requireSession()` or `requirePatientSession()`.** Authorization is possession of the token, resolved through `getSubmissionConsentForToken`, matching the no-staff-session/no-portal-session posture documented verbatim at `src/app/api/intake/[token]/route.ts` lines 12–15. Copy that reasoning into this file's header comment rather than leaving the absence unexplained.

Order:
1. `getSubmissionConsentForToken(token, Number(formSubmissionConsentId))` → 404 when null (covers a bad token, an expired/completed submission, and a consent row belonging to a different submission — one check, three failure modes).
2. Parse the body → 400 on failure.
3. `alreadySigned` → 409 `{ error: 'This consent has already been signed' }`.
4. `createSignature({ signableType: 'form_submission_consent', signableId, signerTypedName: parsed.data.typedName, signerRole: 'patient', attestationText: renderedText })` — `attestationText` is the **server-composed** `renderedText` off the lookup result, never anything from the request body.
5. `logPatientPortalAction('signed consent document via intake form', patientId)`.
6. 200 `{ ok: true }`.

- [ ] **Step 7: Add the completion gate**

In `src/app/api/intake/[token]/route.ts`'s `PUT`, after the schema parse and before the `formSubmissions` update: when `parsed.data.complete` is true and `await countUnsignedConsentsByToken(token) > 0`, return `NextResponse.json({ error: 'This form has unsigned consent documents' }, { status: 400 })`. Saving partial progress (`complete: false`) is unaffected — a patient can answer half the questions and come back before signing anything (spec §6).

Nothing else in this handler moves: the existing conditional `UPDATE … WHERE accessToken = ? AND status != 'completed'` stays the write-time race guard it already is, and this gate is a separate earlier check, re-run on every completion attempt.

- [ ] **Step 8: Run this task's tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/intake-consent-sign.test.ts tests/api/intake-portal.test.ts tests/api/form-submissions.test.ts tests/api/form-submission-complete-signature-gate.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/queries/form-submission-consents.ts "src/app/api/intake/[token]" "src/app/api/form-submissions/route.ts" src/lib/queries/intake-portal.ts tests/api/intake-consent-sign.test.ts
git commit -m "$(cat <<'EOF'
feat: add inline intake consent signing and the unsigned-consent completion gate

EOF
)"
```

---

### Task 8: The legacy-path precedence rule

**Files:**
- Modify: `src/app/api/patients/[anonId]/form-submissions/[id]/sign/route.ts`
- Modify: `src/lib/queries/patient-portal.ts` (`forms` projection gains `hasAttachedConsents`)
- Modify: `src/app/patient-portal/(authenticated)/forms/page.tsx`
- Test: `tests/api/form-submission-sign.test.ts` (extend)

**Interfaces:**
- Consumes: `hasAttachedConsents` from `@/lib/queries/form-submission-consents` (Task 7).
- Produces: `getPatientPortalData`'s `forms[]` entries gain `hasAttachedConsents: boolean`. Consumed by this task's page change and by Task 9's verification.

- [ ] **Step 1: Write the failing tests**

Extend `tests/api/form-submission-sign.test.ts` (add to it; its `makeSubmission` helper and `(signableType, signableId)`-scoped cleanup already exist). Spec §9, sixth bullet:

- **the legacy route returns 409 for a submission that has `formSubmissionConsents` rows** — build a `'Consent Forms'`-category submission with real answers *and* one `formSubmissionConsents` row; `POST` the legacy sign route → **409** with exactly `"This form's consents are signed within the form itself"`; assert the submission's status is **still not** `'completed'` and **no** `form_submission` signature row was created. Without this, a `Consent Forms`-category template with attached consent documents would offer two ways to complete the same submission, one of which skips the consents entirely (spec §7).
- **it still behaves exactly as before for a submission that has none** — the file's existing success-path test must continue to pass unchanged, and add an explicit assertion that a submission with zero `formSubmissionConsents` rows still signs and completes.

- [ ] **Step 2: Run them to confirm they fail**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/form-submission-sign.test.ts`
Expected: FAIL — the new 409 case currently returns 200 and completes the submission.

- [ ] **Step 3: Add the 409**

In `src/app/api/patients/[anonId]/form-submissions/[id]/sign/route.ts`, after the existing `status === 'completed'` check on line 33 and before the empty-answers check on line 42:

```ts
if (await hasAttachedConsents(submissionId)) {
  return NextResponse.json({ error: "This form's consents are signed within the form itself" }, { status: 409 })
}
```

Add a comment stating the precedence rule in full: if a submission has one or more `formSubmissionConsents` rows, the inline path governs, and this route refuses rather than completing the submission behind the inline gate's back. The `category = 'Consent Forms'` gate on line 32 stays exactly as it is — it is still the live gate for every submission already in flight when this ships, and spec §10.3 explicitly does not set a date for retiring it.

- [ ] **Step 4: Suppress the portal's post-hoc action**

In `src/lib/queries/patient-portal.ts`, the `forms` projection (line 48) is an explicit column list — add `hasAttachedConsents` to each row. Compute it with one `leftJoin` to `formSubmissionConsents` plus a `groupBy`/`count`, not an N+1 loop over submissions.

In `src/app/patient-portal/(authenticated)/forms/page.tsx` line 65, narrow the condition to `f.category === 'Consent Forms' && f.status === 'partial' && !f.hasAttachedConsents`. Extend the existing comment block above it to name the new reason. Nothing else on that page changes: the `Start`/`Continue` link to `/intake/${f.accessToken}` at lines 49–54 already exists and already renders for any non-completed submission with a token, which is precisely the "Continue link instead of `SignConsentFormAction`" spec §7 asks for.

- [ ] **Step 5: Run this task's tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/form-submission-sign.test.ts tests/api/patient-portal.test.ts tests/pages/patient-portal-overview.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add "src/app/api/patients/[anonId]/form-submissions/[id]/sign/route.ts" src/lib/queries/patient-portal.ts "src/app/patient-portal/(authenticated)/forms/page.tsx" tests/api/form-submission-sign.test.ts
git commit -m "$(cat <<'EOF'
feat: give the inline consent path precedence over the legacy portal sign action

EOF
)"
```

---

### Task 9: Consent pages in the intake form + end-to-end verification

**Files:**
- Modify: `src/components/IntakePortalForm.tsx`
- Modify: `src/app/intake/[token]/page.tsx` (pass `consents` through)
- Test: none new — UI wiring over the routes fully tested in Task 7. Verified per Global Constraints' UI verification discipline.

**Interfaces:**
- Consumes: `IntakePortalData.consents` (Task 7); `POST /api/intake/[token]/consents/[formSubmissionConsentId]/sign` (Task 7); `SignatureCapture` from `@/components/SignatureCapture` (existing, unchanged: `{ attestationLabel, submitLabel?, submitting?, error?, onSign }`); `IntakeQuestionField` (Task 6).
- Produces: `IntakePortalForm`'s new prop `consents: SubmissionConsent[]`.

- [ ] **Step 1: Render the consent pages**

In `src/components/IntakePortalForm.tsx`, add a `consents` prop and turn the form into: questions, then one page per consent document in `sortOrder`, then submit (spec §6).

- An **unsigned** consent renders its `renderedText` in a `whitespace-pre-wrap` block followed by the existing `SignatureCapture`, unchanged — no new signing mechanism, no canvas, no second attestation widget. `onSign(typedName)` POSTs `{ typedName }` to `/api/intake/${token}/consents/${formSubmissionConsentId}/sign` and, on success, marks that consent signed in local state; on failure it surfaces the route's own error text through `SignatureCapture`'s `error` prop.
- An **already-signed** consent renders read-only: the text plus `Signed by {signerTypedName} on {new Date(signedAt).toLocaleDateString()}`.
- The `Submit` button is disabled while any consent is unsigned, with a visible reason. This is UX; the 400 from Task 7's completion gate is the boundary.
- **The progress bar must not divide by zero** (Review Focus #4): a consent-only packet has `questions.length === 0`. Count consents alongside questions in the progress total, or render no bar at all when the total is 0 — either is fine, `NaN%` is not.
- `renderedText` is rendered as **text**, never as HTML — `bodyText` is plain text by design (spec §1's out-of-scope list rules out rich text), and the draft banner's visibility to the signer depends on it appearing literally.

- [ ] **Step 2: Pass `consents` through the page**

In `src/app/intake/[token]/page.tsx`, pass `consents={data.consents ?? []}` alongside the existing `questions` / `existingAnswers` / `autofill` props. The `'not_found'` / `'expired'` / `'completed'` branches are unchanged.

- [ ] **Step 3: Verify the whole feature end to end against a real running dev server**

Start the dev server. Staff side uses an `admin` `clinsync_demo_session` cookie; the intake side uses **no cookie at all**, which is the thing being tested. Paste every actual command and its actual output.

1. Create a consent document, leave it `draft`. Create a second one and mark it `reviewed`.
2. Create a template in a folder, attach both documents, confirm the editor's Consent Forms tab shows both with signed counts of 0.
3. Send the form to a seeded patient via `POST /api/form-submissions`; confirm two `formSubmissionConsents` rows were created with the right `sortOrder`.
4. Open `/intake/<token>` **with no cookie**; confirm the questions render, then two consent pages, the draft one carrying the literal `[DRAFT — NOT YET REVIEWED BY LEGAL COUNSEL. DO NOT RELY ON THIS WORDING.]` line and the reviewed one not.
5. `PUT /api/intake/<token>` with `complete: true` before signing → 400 `This form has unsigned consent documents`.
6. Sign both consents through the real route; confirm two `signatures` rows with `signableType = 'form_submission_consent'`, and that the draft one's `attestationText` starts with the banner.
7. `PUT` with `complete: true` again → 200, status `completed`.
8. Back on the staff side, confirm the editor's Consent Forms tab and `/consent-documents` both now report a signed count of 1 for each document.
9. Edit the draft document's `bodyText` and flip it to `reviewed`; re-read the signature row and confirm its `attestationText` is byte-for-byte what it was — the spec's load-bearing property, confirmed against the live DB and not only in a test.
10. Legacy path: create a `Consent Forms`-category submission **with** an attached consent, log into the patient portal (`clinsync_patient_session`, `kind: 'patient'`) and confirm the forms list shows `Continue` and **not** the sign action; `POST` the legacy sign route directly and confirm 409.
11. Consent-only packet: a template with zero questions and one consent — confirm `/intake/<token>` renders without a broken or `NaN%` progress bar and completes only after signing.

Clean up every row you created and stop the dev server.

- [ ] **Step 4: Run the full suite, the type check, and the build**

Run, in order:
- `npx dotenv -e .env.local -- npx vitest run`
- `npx tsc --noEmit`
- `npm run build`

Expected: all pass. The type check and build are not optional here — a sibling plan earlier in this session shipped a build-breaking TypeScript error that passed every per-task vitest run.

- [ ] **Step 5: Leave the open-questions ledger note and commit**

Append one line to this plan file under a `## Ledger` heading: that spec §10's three open questions (IP/user-agent capture on `signatures`, role-gating the two pre-existing `/api/form-templates` write routes, and retiring the `category = 'Consent Forms'` gate) were deliberately **not** addressed by this plan and remain open. Do not open tasks for them.

```bash
git add src/components/IntakePortalForm.tsx "src/app/intake/[token]/page.tsx" docs/superpowers/plans/2026-09-29-forms-hub-and-embedded-consents.md
git commit -m "$(cat <<'EOF'
feat: render consent pages inside the intake form with inline signing

EOF
)"
```

## Ledger

- Spec §10's three open questions (IP/user-agent capture on `signatures`, role-gating the two pre-existing `/api/form-templates` write routes, and retiring the `category = 'Consent Forms'` gate) were deliberately not addressed by this plan and remain open.
