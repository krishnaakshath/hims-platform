# Unified Patient Record Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the Tebra/IntakeQ dual-sourced patient data model into a single source of truth, and remove every feature whose entire premise was reconciling two systems that no longer exist for this product (Identity Matching, the EHR sync engine, the mock connectors, EHR Connections settings).

**Architecture:** A destructive (column-dropping) schema migration on the shared live Neon DB, run once and verified against real rows before any other task starts, followed by systematic removal/simplification across ~56 files grouped by the kind of change each needs (pure field-rename vs. real logic removal vs. outright deletion vs. seed data vs. the test suite sweep).

**Tech Stack:** Next.js 16 App Router, Drizzle ORM over a `pg` Pool, Zod `.strict()` validation, vitest.

**Spec:** `docs/superpowers/specs/2026-09-29-unified-patient-record.md`

**Working directory note:** this plan is executed in an isolated git worktree at `/Users/k2a/Desktop/clinsync/.worktrees/unified-patient-record` on branch `feature/unified-patient-record`, forked from `hims-platform`. Every implementer/reviewer dispatch for this plan works from this exact directory. This branch merges into `hims-platform` only — never `master`.

**Scope decisions made while planning (rulings, not left open for the implementer to guess):**
1. **`referralType`, `availability`, `commConsentSigned`, `commConsentPref`, `ratingScales`, `currentProvider` stay as plain fields, untouched by this plan** beyond `currentProvider` becoming staff-editable (§Task 4) — they were never dual-sourced pairs, just concepts historically associated with one mock system or the other. Renaming them further is out of scope; the spec only requires removing the word "Tebra"/"IntakeQ", not re-litigating every field's name.
2. **`src/app/api/patients/[anonId]/refresh/route.ts` is deleted outright**, not simplified. Its entire job was re-pulling from the two mock connectors; with them gone, there is nothing left for this route to do. Task 2 confirms and removes its one UI call site (if any) rather than leaving a dead button.
3. **The medical-record page's Dual-Sourced Fields table is deleted in this plan (Task 6), not deferred to the later Medical Record Redesign plan.** A comparison table with nothing left to compare would be visibly broken in the interim between this plan merging and the redesign plan starting.
4. **`diagnoses.source` is dropped, not repurposed.** The spec confirms it: no UI reads it (`SourceTag.tsx` has zero importers), and every write path only ever wrote `'tebra'`. Dropping it is strictly simpler than inventing a new meaning for a column nothing displays.
5. **Task 1 (migration) is a hard gate.** No other task's implementer starts until Task 1 is reviewed, merged, and its live-DB verification (query real patient rows, confirm `name`/`dob` match the old `nameTebra ?? nameIntakeq` precedence) is independently re-confirmed by that task's reviewer.

## Global Constraints

- This is `hims-platform` only, never `master`.
- This is a **single shared Neon Postgres database across every branch/worktree**. Unlike this project's usual additive-only migrations, Task 1 DROPS columns and a table — destructive, and visible everywhere immediately. Before running any drop step, the implementer must run `git worktree list` from the main checkout (`/Users/k2a/Desktop/clinsync`) and confirm no other currently-active worktree has uncommitted work touching `patients`, `diagnoses`, `identityMatches`, or `appSettings` — if one does, that is a real blocker to escalate to the controller, not something to silently route around or wait out.
- Migration scripts are hand-written, run once via `npx dotenv -e .env.local -- npx tsx <script>`, verified against `information_schema` before AND after each destructive step — never `drizzle-kit push`. `psql` is not installed in this environment; use a Node script with `pg`'s `Pool`.
- No word "Tebra" or "IntakeQ" appears in any new code comment, UI copy, or identifier this plan adds. Existing occurrences are being removed, not added to.
- Every write route uses `.strict()` Zod validation. Every state-changing route calls `logAudit(session, <action>, <patientId or null>)`. Every protected route/page starts with `requireSession()`/`requireSessionOrRedirect()` as its first statement.
- Vitest invocation: `npx dotenv -e .env.local -- npx vitest run <path>`.
- Commit messages end with no attribution trailer.
- **UI/behavior verification discipline (standing rule this session):** every task's non-trivial behavioral claim (a route's new response shape, a deleted page genuinely returning 404, a migrated field's value) is verified against a real running dev server or a real DB query — pasted commands and pasted output in the task report, never a narrated, unreproduced claim.

## Review Focus

1. **A patient whose `nameTebra`/`dobTebra` was null before migration** (an IntakeQ-only referral with no matched clinical chart, e.g. seed data's Jordan Reyes-equivalent) must end up with `name = nameIntakeq`, `dob = dobIntakeq` after migration — the backfill's `COALESCE(tebra, intakeq)` must not silently produce NULL for these rows. (Task 1)
2. **Add Client (`POST /api/patients`) must still succeed and produce a normal, fully-usable patient row once the Tebra mock call is removed** — a reasonable person filling out this form expects it to keep working exactly as before, just without the now-invisible mock side effect. (Task 4)
3. **Every deleted route (`/identity-matching`, `/api/identity-matches/*`, `/api/settings/ehr-connections`, `/api/patients/[anonId]/refresh`) must return a real 404, not a 500 from a stale import or a silently-broken build** — the sibling Questionnaire-Scoring plan earlier in this session shipped a build-breaking TypeScript error that passed all per-task vitest runs; this plan's final task explicitly runs `npx tsc --noEmit` and `next build`, not just vitest. (Task 7)
4. **The Workbook export (`GET /api/workbook/export`) must still produce a valid file with every remaining (non-Match/Mismatch) column populated correctly** after Group B's changes — a reasonable coordinator exporting the workbook the day after this migration should see the same data, just without two now-meaningless columns, not a broken or truncated export. (Task 6)
5. **No leftover reference to a dropped column/table anywhere in the codebase** — a stray `patient.nameTebra` in a file nobody thought to check would compile-error loudly (good) but a stray reference inside a string literal, a comment, or dead code wouldn't; the final task's full-repo grep for every removed identifier (spec §6's list) is the actual proof, not "I think I got everything." (Task 7)

---

### Task 1: Migration script — collapse patient fields, drop dead tables/columns

**Files:**
- Create: `src/db/schema.ts` changes (see below)
- Create: a one-off migration script (e.g. `scripts/scratch-unify-patient-record.ts`, deleted after a successful run — matching this repo's established "hand-written script, verify, delete" convention)
- Test: `tests/db/unified-patient-record-migration.test.ts`

**Interfaces:**
- Produces: `patients.name` (text, not null), `patients.dob` (date, not null), `patients.city`/`zip`/`phone`/`email` (text, nullable) — consumed by every later task in this plan and by every file in Groups A/B/E/F.
- Produces: confirmation that `identityMatches`, `matchStatusEnum`, `diagnoses.source`, `patients.intakeqClientIdRef`/`tebraPatientIdRef`/`tebraChartUrl`, and `appSettings`'s four EHR-credential columns no longer exist in the live schema.

- [ ] **Step 1: Snapshot current live values for the migration-correctness test**

Before touching anything, run a read-only script against the live DB selecting every patient's `id`, `nameTebra`, `nameIntakeq`, `dobTebra`, `dobIntakeq` and compute what `nameTebra ?? nameIntakeq` / `dobTebra ?? dobIntakeq` produces for each — save this as the expected-values fixture the test in Step 5 checks against. Paste the actual query and actual output in the report.

- [ ] **Step 2: Update `src/db/schema.ts`**

On `patients`: replace the six dual-sourced pairs with `name: text('name').notNull()`, `dob: date('dob').notNull()`, `city: text('city')`, `zip: text('zip')`, `phone: text('phone')`, `email: text('email')`. Remove `intakeqClientIdRef`, `tebraPatientIdRef`, `tebraChartUrl` fields entirely (and their doc comments).
On `diagnoses`: remove the `source` field.
Remove the `identityMatches` table and `matchStatusEnum` definitions entirely.
On `appSettings`: remove `intakeqApiKeyEncrypted`, `tebraCustomerKeyEncrypted`, `tebraUserEncrypted`, `tebraPasswordEncrypted`.

Do not touch any other field on any of these tables.

- [ ] **Step 3: Write and run the migration script**

In order: (a) add the six new columns nullable; (b) backfill every row via `UPDATE patients SET name = COALESCE(name_tebra, name_intakeq), dob = COALESCE(dob_tebra, dob_intakeq), city = COALESCE(city_tebra, city_intakeq), zip = COALESCE(zip_tebra, zip_intakeq), phone = COALESCE(phone_tebra, phone_intakeq), email = COALESCE(email_tebra, email_intakeq)`; (c) verify via `information_schema` + a real `SELECT` that every row now has a non-null `name`/`dob`; (d) `ALTER TABLE patients ALTER COLUMN name SET NOT NULL, ALTER COLUMN dob SET NOT NULL`; (e) drop the twelve old patient columns plus `intakeq_client_id_encrypted`/`tebra_patient_id_encrypted`/`tebra_chart_url`; (f) drop `diagnoses.source`; (g) drop the `identity_matches` table and `match_status` enum type; (h) drop the four `app_settings` EHR-credential columns. Run the script with `npx dotenv -e .env.local -- npx tsx <script>`. Delete the script after a successful, verified run.

- [ ] **Step 4: Verify live**

Query `information_schema.columns` for `patients`/`diagnoses`/`app_settings` and confirm the exact new/removed column sets match Step 2 precisely. Query `information_schema.tables` and confirm `identity_matches` no longer exists. Paste actual queries and actual output.

- [ ] **Step 5: Write the migration-correctness test**

```ts
// tests/db/unified-patient-record-migration.test.ts
it('every patient row has a name/dob matching the pre-migration Tebra-preferred value', async () => {
  // For each id captured in Step 1's snapshot, assert the live row's
  // name/dob equals the expected value computed in Step 1.
})
it('patients table no longer has the old dual-sourced or cross-system-reference columns', async () => {
  // Query information_schema.columns for 'patients'; assert nameTebra,
  // nameIntakeq, dobTebra, dobIntakeq, cityTebra, cityIntakeq, zipTebra,
  // zipIntakeq, phoneTebra, phoneIntakeq, emailTebra, emailIntakeq,
  // intakeq_client_id_encrypted, tebra_patient_id_encrypted,
  // tebra_chart_url are all absent.
})
it('identity_matches table no longer exists', async () => { /* information_schema.tables */ })
```

- [ ] **Step 6: Run the test, confirm PASS**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/unified-patient-record-migration.test.ts`

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts tests/db/unified-patient-record-migration.test.ts
git commit -m "$(cat <<'EOF'
feat: collapse dual-sourced patient fields into a single source of truth

EOF
)"
```

---

### Task 2: Delete the reconciliation engine, EHR Connections settings, and dead code (Groups C, D, G)

**Files:**
- Delete: `src/lib/ehr-sync.ts`, `src/lib/matcher.ts`, `src/connectors/intakeq.mock.ts`, `src/connectors/tebra.mock.ts`, `src/connectors/types.ts`, `src/app/(dashboard)/identity-matching/` (page + loading), `src/app/api/identity-matches/[id]/confirm/route.ts`, `src/app/api/identity-matches/[id]/reject/route.ts`, `src/lib/queries/identity-matches.ts`, `src/components/EhrConnectionsForm.tsx`, `src/app/api/settings/ehr-connections/route.ts`, `src/components/SourceTag.tsx`, `src/app/api/patients/[anonId]/refresh/route.ts`.
- Modify: `src/components/LeftNav.tsx` (remove the Identity Matching nav entry), `src/lib/role-capabilities.ts` (remove identity-matching bullets), `src/app/(dashboard)/settings/page.tsx` (remove the EHR Connections tab), `src/lib/queries/settings.ts` (remove `intakeqApiKeyEncrypted`/`tebraCustomerKeyEncrypted`/`tebraUserEncrypted`/`tebraPasswordEncrypted` handling and the `intakeqConfigured`/`tebraConfigured` computed booleans in `getSettingsSummary()`).
- Test: update/remove whichever test files exist for identity-matching, ehr-sync, the connectors, and ehr-connections settings (search `tests/` for each).

**Interfaces:**
- Consumes: Task 1's schema (this task's deletions must not reference any column/table Task 1 removed).
- Produces: nothing new. This task only removes.

- [ ] **Step 1: Find every remaining reference to what's being deleted**

`grep -rn "ehr-sync\|identity-matching\|identityMatches\|EhrConnectionsForm\|ehr-connections\|SourceTag\|connectors/" src/ tests/` — confirm the exact set of files that import any of these, beyond the ones already listed above (the spec's own file audit may have missed a test file or a nav/settings reference).

- [ ] **Step 2: Delete the files and their imports**

Delete every file listed above. Remove the corresponding nav entry, role-capabilities bullets, settings tab, and settings-query fields. Remove any now-dangling import.

- [ ] **Step 3: Update or remove affected tests**

For each test file found in Step 1 that tested deleted code: delete the test file if it tests nothing but deleted code, or remove just the deleted-feature assertions if the file also covers something still-standing (e.g. a broader settings test file that also covers practice-info/auto-classify).

- [ ] **Step 4: Run `npx tsc --noEmit`, confirm zero errors from this task's deletions**

A dangling import elsewhere in the codebase (not yet fixed by this task — expected, since Groups A/B/E haven't run yet) is fine to note as "expected, fixed in a later task" IF it's specifically an import of `nameTebra`/`nameIntakeq`/etc. from Task 1's schema change; anything referencing a file THIS task deleted must be zero.

- [ ] **Step 5: Verify live — every deleted route returns 404, not 500**

Start the dev server. Real `curl` (with a real staff session cookie) to `/identity-matching`, `/api/identity-matches/1/confirm`, `/api/settings/ehr-connections`, `/api/patients/RD-0001/refresh` — confirm each is genuinely gone (404 or Next's not-found page), not a 500 from a half-deleted route. Paste actual commands/output.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat: remove identity matching, EHR sync engine, and EHR connections settings

EOF
)"
```

---

### Task 3: Seed data rewrite (Group F)

**Files:**
- Modify: `src/db/seed.ts`
- Test: `tests/db/seed.test.ts` (update existing assertions referencing the old dual-sourced fields)

**Interfaces:**
- Consumes: Task 1's single-sourced `patients` columns.
- Produces: seeded patients with `name`/`dob`/`city`/`zip`/`phone`/`email` set directly; no `identityMatches` seed rows; no `intakeqClientIdRef`/`tebraPatientIdRef` values anywhere.

- [ ] **Step 1: Read the current seed file's patient-creation logic in full**

Read every place `src/db/seed.ts` currently sets a `nameTebra`/`nameIntakeq` pair (named demo patients, the filler-patient generation loop) and every place it seeds `identityMatches` rows (six hardcoded near-duplicate-name pairs, per the spec).

- [ ] **Step 2: Rewrite each patient-seeding call site to single-sourced fields**

Each named demo patient and the filler-patient loop get one `name`, one `dob`, etc. instead of a mirrored pair. Preserve the same actual demo values used today (e.g. if `nameTebra` was previously the "real" displayed value per the `?? ` precedence, that's what `name` becomes now) so demo data doesn't visibly change.

- [ ] **Step 3: Remove the `identityMatches` seeding block entirely**

- [ ] **Step 4: Run the seed test**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/seed.test.ts`
Update any assertion that referenced the old field names or the identity-matches seed rows.

- [ ] **Step 5: Commit**

```bash
git add src/db/seed.ts tests/db/seed.test.ts
git commit -m "$(cat <<'EOF'
feat: rewrite seed data for single-sourced patient fields

EOF
)"
```

---

### Task 4: Query/route layer — Add Client, patient search, intake autofill (Group E)

**Files:**
- Modify: `src/app/api/patients/route.ts`, `src/app/api/patients/[anonId]/route.ts`, `src/lib/queries/intake-portal.ts`, `src/lib/queries/patients.ts`
- Test: `tests/api/patients-create.test.ts` (or the current test file for Add Client — confirm exact name), `tests/lib/queries/intake-portal.test.ts` (or equivalent), `tests/lib/queries/patients.test.ts` (search-by-name/dob tests)

**Interfaces:**
- Consumes: Task 1's single-sourced `patients` columns.
- Produces: `POST /api/patients` (Add Client) inserting a single-sourced row with no Tebra-mock side effect. `AUTOFILL_SOURCE` in `intake-portal.ts` reading from the single columns.

- [ ] **Step 1: Read `src/app/api/patients/route.ts` in full**

Confirm the exact current shape: the `tebra.createPatient(...)` call, the mirrored-write-into-both-column-sets logic, the `intakeqClientIdRef` sentinel value.

- [ ] **Step 2: Write the failing tests**

Add/update a test asserting: Add Client with valid input returns 201 and the created row has `name`/`dob`/etc. set directly from the request body (not mirrored into two now-nonexistent column sets), and that the route does NOT import or reference anything from `src/connectors/` (Task 2 deleted those files, so a stray reference would already fail to compile — this test is a behavioral belt-and-suspenders, not the only proof).

- [ ] **Step 3: Rewrite `POST /api/patients`**

Remove the `tebra.createPatient()` call and its import. Insert directly: `name`, `dob`, `city`, `zip`, `phone`, `email`, `currentProvider` (now a plain optional field from the request body, not something only a Tebra pull could set), plus the existing insurance fields untouched.

- [ ] **Step 4: Update `src/app/api/patients/[anonId]/route.ts`**

Read its current comment/logic (per the spec's research, it already says "Never touches Tebra/IntakeQ; this only un-mirrors the [name]" — confirm what that means exactly and simplify accordingly now that there's only one name field to begin with, not two to un-mirror).

- [ ] **Step 5: Update `src/lib/queries/intake-portal.ts`**

Change `AUTOFILL_SOURCE` (currently keyed to `nameIntakeq`/`dobIntakeq`/`emailIntakeq`/`phoneIntakeq`) to read the single `name`/`dob`/`email`/`phone` columns.

- [ ] **Step 6: Update `src/lib/queries/patients.ts`**

Change the search-by-name/dob logic (currently checking both pairs) to check the single columns.

- [ ] **Step 7: Run tests, confirm PASS**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/patients-create.test.ts tests/lib/queries/intake-portal.test.ts tests/lib/queries/patients.test.ts` (adjust paths to the actual file names found in Step 1-6).

- [ ] **Step 8: Verify live — Add Client end to end**

Real `curl` (staff session cookie) `POST /api/patients` with real demographic data, confirm 201 and the created patient's `name`/`dob` match what was sent, confirm no error referencing a Tebra connector. Paste actual commands/output.

- [ ] **Step 9: Commit**

```bash
git add src/app/api/patients/route.ts "src/app/api/patients/[anonId]/route.ts" src/lib/queries/intake-portal.ts src/lib/queries/patients.ts tests/
git commit -m "$(cat <<'EOF'
feat: Add Client inserts single-sourced patient fields directly

EOF
)"
```

---

### Task 5: Mechanical field-rename across display/read-only call sites (Group A)

**Files:**
- Modify (batched, same-shape change in each): `src/components/PatientsTable.tsx`, `src/components/SendFormModal.tsx`, `src/components/DashboardHomeClient.tsx`, `src/components/dashboards/AdminDashboard.tsx`, `src/components/dashboards/CoordinatorDashboard.tsx`, `src/app/(dashboard)/reports/patients/page.tsx`, `src/app/(dashboard)/calendar/page.tsx`, `src/app/(dashboard)/doctor/page.tsx`, `src/app/(dashboard)/page.tsx`, `src/app/(dashboard)/billing/charges/page.tsx`, `src/app/(dashboard)/billing/pay/page.tsx`, `src/lib/queries/dashboard.ts`, `src/lib/queries/reports.ts`, `src/lib/queries/search.ts`, `src/lib/fhir/patient.ts`.
- Test: run the existing test suite for each touched query/route (no new tests needed — this is a pure rename, not a behavior change; existing tests should already assert on the *displayed* value, which is unchanged).

**Interfaces:**
- Consumes: Task 1's single-sourced `patients` columns.
- Produces: nothing new. Every `patient.nameTebra ?? patient.nameIntakeq` (and the dob/city/zip/phone/email equivalents) across these 15 files becomes `patient.name` (or the relevant single field).

- [ ] **Step 1: Find every occurrence across these files**

`grep -n "Tebra ?? \|Intakeq ?? \|nameTebra\|nameIntakeq\|dobTebra\|dobIntakeq\|cityTebra\|cityIntakeq\|zipTebra\|zipIntakeq\|phoneTebra\|phoneIntakeq\|emailTebra\|emailIntakeq" <each file>` — confirm the exact line(s) in each of the 15 files before editing (line numbers will have drifted from any earlier reads).

- [ ] **Step 2: Replace each occurrence**

`patient.nameTebra ?? patient.nameIntakeq` → `patient.name`, and the same pattern for dob/city/zip/phone/email, in every one of the 15 files. This is a pure rename — the resulting displayed value for any existing patient is identical (Task 1's migration already applied the same `Tebra ?? Intakeq` precedence when backfilling), so no existing test's expected output changes.

- [ ] **Step 3: Run `npx tsc --noEmit`, confirm these 15 files produce zero errors**

- [ ] **Step 4: Run the existing test suite for these files**

Run: `npx dotenv -e .env.local -- npx vitest run tests/components/PatientsTable.test.tsx tests/lib/queries/dashboard.test.ts tests/lib/queries/reports.test.ts tests/lib/queries/search.test.ts tests/lib/fhir/patient-mapping.test.ts` (adjust to whichever of these files actually have their own test files — some of the 15 may only be covered indirectly by page-level tests; note which in the report).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor: read single-sourced patient fields across display/report call sites

EOF
)"
```

---

### Task 6: Remove real dual-source reconciliation UI/logic (Group B)

**Files:**
- Modify: `src/app/(dashboard)/patients/[anonId]/medical-record/page.tsx` (delete the Dual-Sourced Fields section and its `ComparisonRow` component/usage only — leave every other section on this page untouched, it gets a full redesign in a later plan), `src/lib/excel-export.ts`, `src/app/api/workbook/export/route.ts`, `src/lib/queries/workbook.ts`, `src/components/WorkbookTable.tsx`, `src/lib/form-chart-discrepancy.ts` (comment only — confirm no actual logic dependency on the removed comparison).
- Test: whichever test files cover the Workbook export and the medical-record page (search `tests/` for each).

**Interfaces:**
- Consumes: Task 1's single-sourced `patients` columns, Task 5's renamed call sites (for consistency of pattern, though this task's files are distinct from Task 5's list).
- Produces: a Workbook export/table with single-valued name/DOB columns and no Match/Mismatch columns. A medical-record page with no Dual-Sourced Fields table.

- [ ] **Step 1: Read each file's current dual-source logic in full**

Confirm exactly what `ComparisonRow` does on the medical-record page (the `mismatch` boolean and its highlight styling), exactly what Match/Mismatch columns `excel-export.ts` computes and how `workbook.ts`'s 30-column shape carries both field pairs into them.

- [ ] **Step 2: Remove the Dual-Sourced Fields section from the medical-record page**

Delete the `ComparisonRow` component definition and its three usages (Name/DOB/Email), and the section wrapper around them. Leave every other section on the page exactly as it is.

- [ ] **Step 3: Simplify the Workbook export/table**

Remove the Name/DOB Match-vs-Mismatch columns and their computation from `excel-export.ts` and `lib/queries/workbook.ts`; `WorkbookTable.tsx` drops the corresponding columns. Every remaining column (already using genericized labels per the existing convention) keeps working against the single-sourced fields.

- [ ] **Step 4: Confirm `form-chart-discrepancy.ts` has no real logic dependency**

Read it fully; if its only reference to the old dual-source comparison is an explanatory code comment distinguishing itself from that other feature, just update the comment's wording (it can no longer say "the existing Dual-Sourced Fields comparison" since that no longer exists) — do not change its actual discrepancy-detection logic, which is a different feature (form answers vs. chart data, not Tebra vs. IntakeQ).

- [ ] **Step 5: Run the affected tests**

Run whichever test files cover the Workbook export and the medical-record page; update any assertion that checked a Match/Mismatch column or the Dual-Sourced Fields table.

- [ ] **Step 6: Verify live — Workbook export still produces a valid file**

Real `curl` (staff session, admin/crc role) `GET /api/workbook/export`, confirm 200 and a valid file with the expected remaining columns populated for a known real patient. Paste actual command/output.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(dashboard)/patients/[anonId]/medical-record/page.tsx" src/lib/excel-export.ts src/app/api/workbook/export/route.ts src/lib/queries/workbook.ts src/components/WorkbookTable.tsx src/lib/form-chart-discrepancy.ts tests/
git commit -m "$(cat <<'EOF'
feat: remove dual-source comparison UI from medical record and workbook

EOF
)"
```

---

### Task 7: Full-repo sweep — find every remaining reference, typecheck, build, full test run

**Files:**
- Modify: whatever the sweep in Step 1 turns up (expected to be small — a handful of test files or stray comments Tasks 1-6 didn't already catch).
- Test: the full suite.

**Interfaces:**
- Consumes: everything from Tasks 1-6.
- Produces: a branch that compiles clean, builds clean, and has zero remaining references to any removed identifier.

- [ ] **Step 1: Full-repo grep for every removed identifier**

```
grep -rn "nameTebra\|nameIntakeq\|dobTebra\|dobIntakeq\|cityTebra\|cityIntakeq\|zipTebra\|zipIntakeq\|phoneTebra\|phoneIntakeq\|emailTebra\|emailIntakeq\|tebraPatientIdRef\|intakeqClientIdRef\|tebraChartUrl\|identityMatches\|ehr-sync\|tebra.mock\|intakeq.mock\|intakeqApiKeyEncrypted\|tebraCustomerKeyEncrypted\|tebraUserEncrypted\|tebraPasswordEncrypted\|intakeqConfigured\|tebraConfigured" src/ tests/ docs/superpowers/specs/2026-09-28*.md docs/superpowers/plans/2026-09-28*.md
```
(Excluding this plan's own spec/plan files and the ones being superseded — those are historical record, not live code.) Every hit outside a `.git` history or an already-superseded doc must be fixed.

- [ ] **Step 2: Fix whatever the grep turns up**

- [ ] **Step 3: `npx tsc --noEmit` — zero errors**

- [ ] **Step 4: `npm run build` (or `next build`) — confirm it succeeds**

This is the check a sibling plan earlier in this session skipped, shipping a build-breaking error that passed every per-task vitest run. Do not skip it here.

- [ ] **Step 5: Full test suite**

Run: `npx dotenv -e .env.local -- npx vitest run`
Expected: all pass, or only pre-existing shared-DB-contention failures unrelated to this branch's own touched files (per this session's established discipline for distinguishing the two — name each failure and confirm it's in a file this plan never touched before calling it unrelated).

- [ ] **Step 6: Commit any final fixes**

```bash
git add -A
git commit -m "$(cat <<'EOF'
fix: close remaining references to removed Tebra/IntakeQ identifiers

EOF
)"
```
