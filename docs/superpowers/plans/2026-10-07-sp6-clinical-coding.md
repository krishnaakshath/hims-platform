# SP6: Clinical Coding ("L5") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the hospital a clinical-coding tier:
- versioned **code systems** (ICD-10, ICD-10-PCS, SNOMED CT, LOINC, PM-JAY HBP packages) loaded by the owner from licensed files through a validated, all-or-nothing CSV importer (admin screen for small files, CLI for full releases), with prefix/text search;
- **coded diagnoses** per encounter (primary / secondary / provisional) on top of the existing free-text `diagnoses` table, with no destructive backfill;
- **coded procedures** per encounter (code, date, performing doctor, optional billed service) and a **service ↔ procedure-code map** that SP4 charge capture will validate against;
- a **`coder` role**, a **coding worklist**, a coding workspace (claim/assign, code, query the doctor with a response log, mark coded, finalise, reopen with reason), doctor proposals on the chart;
- pure **validation rules** and an **encounter coding status machine** (`uncoded → in_progress → queried → coded → finalised`);
- **FHIR** Condition / Procedure / Encounter / Observation codings that carry a `system` URI only when the code came from a loaded, non-sample code system;
- a coding productivity/backlog report, all audited.

**Architecture:**
- Pure, client-safe modules under `src/lib/coding/` hold every rule: code-system kinds and patterns, the CSV import validator, the coding checks, the status machine, request schemas, error messages, worklist parsing and service-code compatibility. Query modules under `src/lib/queries/` run one `getDb().transaction` per write, lock the encounter's `encounter_coding` row `FOR UPDATE` first, and write `logAudit(…, tx)` on the same transaction (SP1/SP3 pattern). Routes are thin and their unit tests mock the query modules.
- New tables: `code_systems`, `codes`, `encounter_procedures`, `encounter_coding`, `encounter_coding_events`, `coding_queries`, `coding_query_responses`, `service_procedure_codes`. `diagnoses` gains nullable/defaulted columns only; legacy rows stay exactly as they are and read as `uncoded`.
- Code-system content is **never** shipped: the repo ships the importer, three tiny fictional `SAMPLE-` fixtures, and `docs/CODE-SYSTEMS.md`.

**Tech Stack:** Next.js 16 App Router (route `params` / page `searchParams` are `Promise`s; `src/proxy.ts`, not middleware), drizzle-orm 0.45 + node-postgres (real transactions), Postgres 15 (`pg_trgm`), zod v4, vitest 5 + jsdom + Testing Library, tsx (CLI), lucide-react.

**Spec:** `docs/superpowers/specs/2026-10-07-indian-hims-design.md` (sections 1–4, 6, 7 binding; this plan implements sub-project 6 "Clinical coding (L5)"; §3 "RBAC: new roles `coder` and `rcm`" — SP6 adds `coder` only; §7 "code-set licensing (ICD-10-PCS/SNOMED) must be confirmed" — see ruling 1).

**Depends on:**
- SP1 + SP2 (merged on `main`): `departments`, `providers`, `service_catalog` (+ `serviceCategoryEnum`), `parseCsv` / `CsvSyntaxError` (`src/lib/tariff/csv.ts`), `ImportIssue` (`src/lib/tariff/import.ts`), `parseId` / `invalid` / `isRetryableConflict` / `RETRY_MESSAGE` (`src/lib/tariff/route-responses.ts`), `logAudit(session, action, patientId, details, executor)`, `publicPatientColumns`, `ageOnDate`, `todayIsoIn`, `tests/db/migration-sql.ts`.
- **SP3 merged on `main`** (`docs/superpowers/plans/2026-10-07-sp3-encounters-followup.md`): `encounters` table + `EncounterRow`, `ENCOUNTER_TYPES` / `ENCOUNTER_STATUSES` (`src/lib/encounters/status.ts`), `WriteExecutor` (`src/lib/queries/executor.ts`), `getEncounterById`, `listEncountersForPatient` (`src/lib/queries/encounters.ts`), `istDateOf`, `startOfIstDay`, `formatIsoDate`, `formatDateTimeIn` (`src/lib/india-time.ts`), `isoDateSchema` (`src/lib/follow-ups/validation.ts`), `readJsonBody`, `errorResponse` (`src/lib/follow-ups/route-responses.ts`), `deletePatient` encounter handling, and the SP3 migration. An encounter is "finished" when `encounters.status = 'completed'` (OPD consultation completed, or IPD encounter completed at discharge by `completeAdmissionEncounter`).

## Global Constraints

- Read `AGENTS.md`. Before writing any route or page, read the matching guide in `node_modules/next/dist/docs/`. Route context is `{ params: Promise<{ … }> }`; page props are `{ params: Promise<…>; searchParams: Promise<…> }`.
- **Worktree:** fresh `.worktrees/sp6` off `main`, branch `feature/sp6-clinical-coding`. Copy `.env.local` from the main checkout. **Task 1 Step 0:** confirm SP3 is merged (`test -f src/lib/queries/encounters.ts && test -f scripts/migrations/2026-10-07-sp3-encounters-follow-up.sql`). If not, stop and report; do not cherry-pick SP3. Never touch `.worktrees/sp3` or other worktrees.
- **Time:** business dates are Asia/Kolkata `date` values via `todayIsoIn(DEFAULT_TIMEZONE, now)` / `istDateOf(instant)`. Instants are `timestamp` (UTC). Display with `formatIsoDate` / `formatDateTimeIn`. Never `toISOString().slice(0, 10)` on a `new Date()`.
- **IDs:** `serial` integer PKs; patient FKs are `text`.
- **PHI (SP1 rules):**
  - Every read of `patients` names its columns (or uses `publicPatientColumns`); `tests/lib/no-credential-leak.test.ts` stays green.
  - SP6 code never references `patientAadhaar`, `aadhaar*` or `src/lib/crypto.ts`; `tests/lib/no-aadhaar-leak.test.ts` stays green and Task 9 adds the coding paths to its `EXPORT_PATHS`.
  - **Coder minimum PHI (ruling 4):** a coder-facing payload carries patient `id`, `name`, `uhid`, `gender` and `ageYears` only — never `dob`, phone, email, address, contacts, ABHA, insurance, or Aadhaar status.
  - Audit `details` carry ids, codes and enum values only — never query text, response text, reopen reasons, note text or diagnosis wording.
- **Money:** none in SP6 (service mapping carries no prices).
- **RBAC** (constants added to `src/lib/role-policy.ts` in Task 1, block commented `// SP6`):

  | Constant | Roles | Grants |
  |---|---|---|
  | `CODING_ROLES` | admin, coder | `/coding*` pages (except code systems), workspace, status actions, raise/close queries, service-code mapping writes |
  | `CODING_ENTRY_ROLES` | admin, coder, pi | gate of the diagnosis/procedure write routes (behaviour by role, Task 7) |
  | `CODE_PROPOSE_ROLES` | admin, pi | chart "propose code" UI |
  | `CODING_QUERY_RESPOND_ROLES` | admin, pi, coder | reply on a coding query |
  | `CODE_LOOKUP_ROLES` | admin, coder, pi, crc, billing | code search, service-code lookup (no PHI) |
  | `CODE_SYSTEM_ADMIN_ROLES` | admin | code-system import / set current, `/coding/code-systems` |

  - Per-action roles for the status route live in `CODING_ACTION_ROLES` (Task 3): `assign` is admin only.
  - **API order:** `requireSession()`, then the inline allowlist returning exactly `NextResponse.json({ error: 'Forbidden' }, { status: 403 })`, then body parse. Bad JSON → `400 { error: 'Invalid JSON' }` (`readJsonBody`).
  - **Page order:** `requireSessionOrRedirect()` first, then `redirect('/')` for a denied role, before any data load.
  - **Harnesses:** every new route gets an `API_GATES` row; every new POST/PUT/PATCH gets an `SP6_WRITE_GATES` deny-before-parse row in `tests/api/rbac-route-gates.test.ts`; every new page a `PAGE_GATES` row in `tests/pages/page-gates-harness.ts`. No `gap` tags. `LeftNav` roles equal the page gate.
- **Audit:** every write calls `logAudit(session, action, patientId | null, details, tx)` inside its transaction. Action strings start `coding: ` and are exactly those each task names.
- **Schema changes:** `src/db/schema.ts` block commented `// SP6` + idempotent SQL in `scripts/migrations/2026-10-07-sp6-a-coder-role.sql` (Task 1) and `scripts/migrations/2026-10-07-sp6-b-clinical-coding.sql` (Task 4), SP1/SP3 style: `BEGIN; … COMMIT;`, `IF NOT EXISTS`, `CREATE TYPE` in `DO` blocks catching `duplicate_object`, each FK/unique/check in a `pg_constraint`-guarded `DO` block named exactly as drizzle names it, no `DROP`.
  - Apply **only** to the local container, twice: `/Users/k2a/.docker/bin/docker exec -i hims-local-pg psql -U postgres -d hims -v ON_ERROR_STOP=1 < scripts/migrations/<file>`. Both runs end in `COMMIT`.
  - Never `db:push` / `drizzle-kit push`; never `scripts/apply-sql.mjs`.
- **Tests:**
  - Pure/mocked: `npx vitest run <file>`. DB: `npm test -- <file>` (loads `.env.local`).
  - New DB tests: `describe.skipIf(!process.env.DATABASE_URL)('… (DB)', …)`, fixtures prefixed `TEST-SP6-${RUN}` (code-system versions `TEST-SP6-${RUN}`), deleted in `afterEach` children-first: `coding_query_responses` → `coding_queries` → `encounter_coding_events` → `encounter_coding` → `encounter_procedures` → `diagnoses` (fixture rows) → `service_procedure_codes` → `codes` → `code_systems` → then the SP3 order (`encounters` → … → `patients`).
  - **Never run the whole suite or `tests/db/seed.test.ts`** (it truncates the shared local DB).
- **Per-task verification:** the task's tests + `npx tsc --noEmit` + `npx eslint <changed files>`.
- **Branding:** no hard-coded product name (`brand` / `useBrand()`).
- **Merge hygiene:** SP5 runs in parallel and edits `schema.ts`, `role-policy.ts`, `LeftNav.tsx`, both harness files and `seed.ts`; keep SP6 additions in `// SP6` blocks.
- No secrets. The executor commits per task as written. Nothing is committed while planning.

## Review Focus

1. **Finalised coding must be immovable without a reopen.** A coder or doctor POST/PATCH/DELETE on a finalised encounter's codes, or an edit racing `finalise`, must 409 with no row change; the end state is never "finalised but edited after". Test: Task 7 `refuses every entry write on a finalised encounter` and `an edit racing finalise never leaves a finalised encounter edited`.
2. **Legacy free-text diagnoses survive untouched and never pose as coded.** The migration must not rewrite `code`/`description`; legacy rows read `uncoded` with `encounter_id` null; FHIR must not add a `system` to them, and an empty `code` must not become a `coding` entry. Test: Task 4 `migration leaves a legacy diagnosis untouched and uncoded`, Task 15 `legacy free-text diagnosis has no system` and `an empty code yields text only`.
3. **The fictional sample fixtures must never look like real terminology.** `SAMPLE-` versions are flagged `is_sample`, never get a FHIR `system`, show a "Sample" badge, and cannot be made current while a licensed version of the same kind is loaded. Test: Task 2 `SAMPLE- versions are flagged sample`, Task 5 `refuses to make a sample current over a licensed version`, Task 15 `a sample code system never carries a system URI`.
4. **A real licensed file in the wrong place or shape.** An 8 MB ICD file posted to the web importer gets a clean 413 pointing at the CLI; an Excel-saved CSV (BOM, CRLF, quoted commas) imports; a display starting `=`/`+`/`-`/`@` or one duplicate code blocks the whole import with its line number. Test: Task 2 `parses an Excel-style file`, `one bad row blocks the import with its line`, `rejects formula-like displays`, Task 6 `413s an oversize CSV and names the CLI`.
5. **A coder sees the minimum.** The workspace and worklist payloads have no `dob`, `phone`, `email`, address or Aadhaar keys; a coder is redirected from `/patients/*` and the chart, and 403'd from the notes write routes. Test: Task 8 `workspace patient header carries only id, name, uhid, gender, ageYears`, Task 10 `worklist rows carry no contact fields`, Task 1 harness rows for the notes routes.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/coding/code-systems.ts` | Kinds, labels, code/version patterns, normalisation, FHIR URIs, validity-on-date, exclusion matching (pure) |
| `src/lib/coding/import.ts` | CSV import validator for code systems (pure) |
| `src/lib/coding/rules.ts` | Coding checks (`validateEncounterCoding`, `checkCodeForEntry`) (pure) |
| `src/lib/coding/status.ts` | Status/enum constants, status machine, per-action roles (pure) |
| `src/lib/coding/validation.ts` | zod request schemas (client-safe) |
| `src/lib/coding/errors.ts` | `CodingWriteError` union, HTTP status and message maps (pure) |
| `src/lib/coding/worklist.ts` | Worklist search-param parsing, age buckets, labels (pure) |
| `src/lib/coding/service-codes.ts` | Service-category ↔ code-kind compatibility, SP4 charge-code check (pure) |
| `src/lib/coding/import-cli.ts` | CLI argument parsing + flow (testable) |
| `src/lib/coding/route-responses.ts` | `codingErrorResponse`, `codingServerError` (server) |
| `src/lib/http/read-capped-body.ts` | Byte-capped request body reader (extracted from the tariff import route) |
| `src/lib/queries/code-systems.ts` | Import commit, list, set current, search, code lookups |
| `src/lib/queries/diagnoses.ts` | `liveDiagnosis` filter shared by legacy readers |
| `src/lib/queries/coding.ts` | Diagnosis/procedure writes, status actions, rule-input loader, gate |
| `src/lib/queries/coding-queries.ts` | Doctor queries + response log |
| `src/lib/queries/coding-workspace.ts` | Workspace loader, chart loader |
| `src/lib/queries/coding-worklist.ts` | Worklist and productivity/backlog queries |
| `src/lib/queries/service-procedure-codes.ts` | Service ↔ code map reads/writes |
| `src/lib/fhir/{condition,observation,procedure,encounter,gather,bundle}.ts` | Coded FHIR mapping |
| `src/app/api/coding/**` | Coding routes |
| `src/app/(dashboard)/coding/**` | Worklist, workspace, report, service codes, code systems pages |
| `src/components/coding/*` | Coding UI |
| `scripts/import-code-system.ts`, `scripts/code-systems/samples/*.csv` | CLI entry, fictional fixtures |
| `scripts/migrations/2026-10-07-sp6-a-coder-role.sql`, `…-sp6-b-clinical-coding.sql` | DDL |
| `docs/CODE-SYSTEMS.md` | Licensing ruling and owner loading guide |

---

### Task 1: The `coder` role everywhere + SP6 role constants

**Files:**
- Modify: `src/db/schema.ts:5` (`roleEnum` + `'coder'`), `src/lib/auth.ts:8` (`Role` + `'coder'`), `src/lib/role-policy.ts` (`ALL_ROLES` + `'coder'`; append `// SP6` block), `src/lib/role-capabilities.ts` (coder entry; admin and pi bullets), `src/lib/staff-portals.ts`, `src/app/api/users/route.ts:10`, `src/components/settings/StaffManagementPanel.tsx` (type, `ROLE_LABEL`, `ROLE_BADGE`, `<option>`), `src/app/(dashboard)/page.tsx:53` (`staffByRole` list), `src/db/seed.ts` (demo user after line 1062)
- Create: `src/app/login/coder/page.tsx` (copy of `login/labs/page.tsx` with `'coder'`), `scripts/migrations/2026-10-07-sp6-a-coder-role.sql`, `tests/db/coder-role.test.ts`
- Modify tests (add `'coder'` to every hand-written denied-role list that contains `'labs'`): `tests/components/LeftNav.test.tsx:46,59`, `tests/components/TopBanner.test.tsx:29`, `tests/lib/role-capabilities.test.ts:7`, `tests/lib/patient-identity.test.ts:145,157`, `tests/api/{patients:51, staff-directory:47,96, appointments:262, inpatient-medications:48, identity-verification:47, form-templates:273, settings-uhid-prefix:23, fhir-export-routes:134, patients-register:65, search:31, form-submissions:76, patient-profile-routes:90,222,255}.test.ts`, `tests/pages/{staff-directory-pages:88,115, calendar:26, prescriptions-print:183, patients-frontdesk-view:255,265}.test.tsx`
- Modify: `tests/api/rbac-route-gates.test.ts` (rows for the notes write routes)

**Interfaces:**
- Produces:
  - `type Role = 'crc' | 'pi' | 'admin' | 'frontdesk' | 'pharmacy' | 'billing' | 'labs' | 'coder'`; `ALL_ROLES` ends `'labs', 'coder'`; `roleEnum` values identical and in the same order.
  - `role-policy.ts` `// SP6`: `CODING_ROLES`, `CODING_ENTRY_ROLES`, `CODE_PROPOSE_ROLES`, `CODING_QUERY_RESPOND_ROLES`, `CODE_LOOKUP_ROLES`, `CODE_SYSTEM_ADMIN_ROLES` (`readonly Role[]`, exactly the Global Constraints table). `searchScopesFor('coder')` stays all-false (coder is in neither `CLINICAL_ROLES` nor `PATIENT_DIRECTORY_ROLES`), so the coder has no global search.
  - `ROLE_CAPABILITIES.coder`, verbatim:
    - label `'Clinical Coder'`
    - summary `'Codes finished visits and discharges: assigns ICD-10 diagnosis and procedure/package codes, queries the treating doctor, and finalises coding for billing and claims. Sees only what coding needs; never edits clinical notes and has no chart or patient-directory access.'`
    - bullets: `'Work the coding worklist: claim finished visits and discharges awaiting coding'`, `'Assign and correct diagnosis codes (primary, secondary, provisional) and procedure or package codes from the loaded code sets'`, `'Read the signed clinical notes of the visit being coded (read-only)'`, `'Send a coding query to the treating doctor and log the replies'`, `'Mark a visit coded, finalise it, or reopen a finalised visit with a reason'`, `'Map service-catalogue procedures and packages to procedure codes'`, `'View the coding productivity and backlog report'`
  - admin bullets append: `'Load licensed code sets (ICD-10, ICD-10-PCS, SNOMED CT, LOINC, HBP packages) and choose the current version'`, `'Assign coding work to a coder'`. pi bullets append: `'Propose diagnosis and procedure codes for a visit on the chart, and answer coding queries'`.
  - `STAFF_PORTALS` entry `{ key: 'coder', label: 'Clinical Coding', description: 'Coding worklist, codes and queries', icon: FileCode2, iconBg: 'bg-teal-500/10', iconText: 'text-teal-700' }` (insert before admin); `ROLE_BADGE.coder = 'bg-teal-500/10 text-teal-700'`, `ROLE_LABEL.coder = 'Clinical Coder'`.
  - Seed: `{ name: 'Asha Menon', email: seedEmail('coder'), role: 'coder', passwordHash: demoHash }`.
  - Migration a: header comment (additive; `ALTER TYPE … ADD VALUE` inside a transaction is valid on PG ≥ 12, and the new value is deliberately not used in this file), body `BEGIN; ALTER TYPE role ADD VALUE IF NOT EXISTS 'coder'; COMMIT;`.

- [ ] **Step 0: Check SP3 is on `main`** (Global Constraints). Stop if not.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/db/coder-role.test.ts
it('roleEnum equals ALL_ROLES and ends with coder', () => { expect(roleEnum.enumValues).toEqual([...ALL_ROLES]); expect(ALL_ROLES.at(-1)).toBe('coder') })
it('coder-role migration is idempotent and adds the value', () => {
  const s = readMigration('2026-10-07-sp6-a-coder-role.sql'); expect(idempotencyProblems(s)).toEqual([]); expect(s).toMatch(/ADD VALUE IF NOT EXISTS 'coder'/)
})
it('coder has no global search scope and no clinical/directory access', () => {
  expect(hasSearchScope('coder')).toBe(false); expect(CLINICAL_ROLES).not.toContain('coder'); expect(PATIENT_DIRECTORY_ROLES).not.toContain('coder')
})
describe.skipIf(!process.env.DATABASE_URL)('coder role (DB)', () => {
  it('the database accepts the coder role', async () => { const r = await getDb().execute(sql`select 'coder'::role as r`); expect(r.rows[0].r).toBe('coder') })
})
// tests/lib/role-capabilities.test.ts (append)
it('states the coder capabilities and no clinical-note write', () => {
  expect(has('coder', /coding worklist/i)).toBe(true); expect(has('coder', /query/i)).toBe(true)
  expect(has('coder', /encounter note|care plan|prescri/i)).toBe(false); expect(has('pi', /propose diagnosis/i)).toBe(true)
})
// tests/api/rbac-route-gates.test.ts — API_GATES rows (coder must be denied clinical notes)
{ name: 'POST /api/patients/[anonId]/notes', call: () => settle(() => postNote(send('POST', `/api/patients/${BOGUS_PATIENT}/notes`), ctx({ anonId: BOGUS_PATIENT }))), allowed: ['admin', 'pi'] },
{ name: 'POST /api/patients/[anonId]/notes/[id]/sign', call: () => settle(() => signNoteRoute(send('POST', `/api/patients/${BOGUS_PATIENT}/notes/${BOGUS_ID}/sign`), ctx({ anonId: BOGUS_PATIENT, id: BOGUS_ID }))), allowed: ['admin', 'pi'] },
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/db/coder-role.test.ts tests/lib/role-capabilities.test.ts`
Expected: FAIL (`coder` missing).

- [ ] **Step 3: Implement** every listed edit. `npx tsc --noEmit` lists any remaining `Record<Role, …>` that needs a coder key; fix each. Then `grep -rn "'labs'" tests src | grep -v coder` and confirm every remaining hit is a role-specific allowlist (e.g. the labs worklist), not a "denied roles" roster.

- [ ] **Step 4: Apply migration a twice, then verify**

Run the docker apply command on `2026-10-07-sp6-a-coder-role.sql` twice (both end `COMMIT`). Then:
`npx vitest run tests/db/coder-role.test.ts tests/lib/role-capabilities.test.ts tests/components tests/pages/nav-role-enforcement.test.tsx tests/api/search.test.ts`, `npm test -- tests/db/coder-role.test.ts tests/api/rbac-route-gates.test.ts`, then each modified test file with `npx vitest run`, then `npx tsc --noEmit`.
Expected: all PASS; every API_GATES/PAGE_GATES row now also proves `coder` is denied.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/lib/auth.ts src/lib/role-policy.ts src/lib/role-capabilities.ts src/lib/staff-portals.ts src/app/api/users/route.ts src/components/settings/StaffManagementPanel.tsx "src/app/(dashboard)/page.tsx" src/app/login/coder src/db/seed.ts scripts/migrations/2026-10-07-sp6-a-coder-role.sql tests
git commit -m "feat(sp6): coder role across enums, rosters, login door and SP6 role constants"
```

---

### Task 2: Code-system kinds and the CSV import validator (pure) + sample fixtures

**Files:**
- Create: `src/lib/coding/code-systems.ts`, `src/lib/coding/import.ts`, `scripts/code-systems/samples/SAMPLE-icd10.csv`, `SAMPLE-icd10pcs.csv`, `SAMPLE-hbp.csv`
- Test: `tests/lib/coding/code-systems.test.ts`, `tests/lib/coding/import.test.ts`

**Interfaces:**
- Consumes: `parseCsv`, `CsvSyntaxError` (`src/lib/tariff/csv.ts`); `type ImportIssue` (`src/lib/tariff/import.ts`, `import type`).
- Produces (`code-systems.ts`, no `node:`/DB imports):
  - `CODE_SYSTEM_KINDS = ['icd10', 'icd10pcs', 'snomed', 'loinc', 'hbp'] as const`; `type CodeSystemKind`
  - `CODE_SYSTEM_LABEL: Record<CodeSystemKind, string>` = `{ icd10: 'ICD-10', icd10pcs: 'ICD-10-PCS', snomed: 'SNOMED CT', loinc: 'LOINC', hbp: 'PM-JAY HBP package' }`
  - `CODE_PATTERN: Record<CodeSystemKind, RegExp>`: icd10 `^[A-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$`; icd10pcs `^[0-9A-HJ-NP-Z]{7}$`; snomed `^[1-9][0-9]{5,17}$`; loinc `^[1-9][0-9]{0,6}-[0-9]$`; hbp `^[A-Z]{1,4}[0-9]{1,4}[A-Z0-9]{0,4}$`
  - `normalizeCode(raw: string): string` — trim + uppercase
  - `CODE_SYSTEM_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/`; `isSampleVersion(version: string): boolean` (`startsWith('SAMPLE-')`)
  - `FHIR_SYSTEM_URI: Record<CodeSystemKind, string | null>` = `{ icd10: 'http://hl7.org/fhir/sid/icd-10', icd10pcs: 'http://www.cms.gov/Medicare/Coding/ICD10', snomed: 'http://snomed.info/sct', loinc: 'http://loinc.org', hbp: null }`
  - `interface CodeBinding { kind: CodeSystemKind; version: string; isSample: boolean }`; `fhirSystemFor(b: CodeBinding): string | null` — null when `isSample`, else the map value
  - `DIAGNOSIS_CODE_KINDS = ['icd10', 'snomed'] as const`, `PROCEDURE_CODE_KINDS = ['icd10pcs', 'snomed', 'hbp'] as const`
  - `isCodeValidOn(c: { active: boolean; effectiveFrom: string | null; effectiveTo: string | null }, dateIso: string): boolean` (inclusive range)
  - `codeMatchesExclusion(code: string, entry: string): boolean` — both stripped of `.` and uppercased; true when `code` starts with `entry` (so `E10` excludes `E10.9`)
- Produces (`import.ts`):
  - `CODE_CSV_HEADERS = ['code', 'display', 'parent_code', 'selectable', 'active', 'effective_from', 'effective_to', 'sex', 'age_min_years', 'age_max_years', 'excludes'] as const`
  - `WEB_IMPORT_LIMITS = { maxBytes: 4_000_000, maxRows: 60_000 }`, `CLI_IMPORT_LIMITS = { maxBytes: 300_000_000, maxRows: 2_000_000 }`, `MAX_REPORTED_ISSUES = 200`
  - `interface CodeImportMeta { kind: CodeSystemKind; version: string; name: string; licenceNote: string | null }`
  - `interface CodeImportRow { code: string; display: string; parentCode: string | null; selectable: boolean; active: boolean; effectiveFrom: string | null; effectiveTo: string | null; sexRestriction: 'male' | 'female' | null; ageMinYears: number | null; ageMaxYears: number | null; excludes: string[] }`
  - `validateCodeSystemImport(text: string, meta: CodeImportMeta, limits: { maxBytes: number; maxRows: number }): { rows: CodeImportRow[]; issues: ImportIssue[]; isSample: boolean }` — all-or-nothing: callers commit only when `issues` is empty. Rules, each issue carrying `line` and `column`:
    - meta: version matches `CODE_SYSTEM_VERSION_PATTERN`; name 1–120 chars; `licenceNote` required (1–500) unless `isSampleVersion(version)`; a `SAMPLE-` version is only accepted for files whose every display starts `SAMPLE` (`'Sample code sets must label every display SAMPLE'`)
    - size (UTF-8 bytes) > `maxBytes` → single issue `File is larger than ${maxBytes} bytes`; rows > `maxRows` → `File has more than ${maxRows} rows`; header exactly `CODE_CSV_HEADERS` (case-insensitive, trimmed); zero rows → `File has no codes`; `CsvSyntaxError` → its line
    - `code`: `normalizeCode`, must match `CODE_PATTERN[kind]`, unique in file (`Duplicate code`)
    - `display`: trimmed 1–500 chars, no control characters, must not start with `=`, `+`, `-` or `@` (`Display may not start with = + - or @`)
    - `parent_code`: empty or another code in the file, not itself; following parents must terminate within 20 steps (`Parent chain loops`)
    - `selectable` / `active`: empty → true; `yes/true/1` / `no/false/0`
    - dates: empty or real ISO `YYYY-MM-DD`; `effective_to ≥ effective_from`
    - `sex`: empty, `m`/`male` → `'male'`, `f`/`female` → `'female'` (case-insensitive)
    - ages: empty or integer 0–150; min ≤ max
    - `excludes`: `;`-separated, each `normalizeCode`d and matching `^[A-Z0-9][A-Z0-9.\-]{0,19}$`, at most 50
    - collecting stops after `MAX_REPORTED_ISSUES`, adding a final `{ line: 1, message: 'More problems were found; fix these first' }`
    - messages echo at most 40 characters of a cell, never a whole row
- Fixtures: headers exactly `CODE_CSV_HEADERS`; every display begins `SAMPLE fictional` and says it is not a real code. `SAMPLE-icd10.csv` codes `U8Z` (non-selectable group), `U8Z.0` (excludes `U8Z.1`), `U8Z.1`, `U8Z.2` (sex female), `U8Z.3` (ages 0–17), `U8Z.4` (inactive, effective_to `2025-12-31`), `U9Z` (group), `U9Z.0` (effective_from `2026-01-01`). `SAMPLE-icd10pcs.csv`: `ZZ00000`, `ZZ00001`, `ZZ00002`. `SAMPLE-hbp.csv`: `SMP001A`, `SMP002A`. Versions used with them: `SAMPLE-ICD10-0`, `SAMPLE-PCS-0`, `SAMPLE-HBP-0`.

- [ ] **Step 1: Write the failing tests**

```ts
// code-systems.test.ts
it.each([['icd10', 'E11.9', true], ['icd10', 'E1', false], ['icd10pcs', '0DTJ4ZZ', true], ['icd10pcs', '0DTI4ZZ', false], ['loinc', '2345-7', true], ['snomed', '22298006', true], ['hbp', 'SMP001A', true]] as const)(
  '%s pattern on %s is %s', (k, c, ok) => { expect(CODE_PATTERN[k].test(c)).toBe(ok) })
it('SAMPLE- versions are flagged sample and never get a FHIR system', () => {
  expect(isSampleVersion('SAMPLE-ICD10-0')).toBe(true); expect(fhirSystemFor({ kind: 'icd10', version: 'SAMPLE-ICD10-0', isSample: true })).toBeNull()
  expect(fhirSystemFor({ kind: 'icd10', version: '2019', isSample: false })).toBe('http://hl7.org/fhir/sid/icd-10'); expect(fhirSystemFor({ kind: 'hbp', version: '2022', isSample: false })).toBeNull()
})
it('validity is inclusive at both ends', () => {
  const c = { active: true, effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31' }
  expect(isCodeValidOn(c, '2026-01-01')).toBe(true); expect(isCodeValidOn(c, '2026-12-31')).toBe(true); expect(isCodeValidOn(c, '2027-01-01')).toBe(false)
  expect(isCodeValidOn({ ...c, active: false }, '2026-06-01')).toBe(false)
})
it('exclusion entries match by prefix ignoring dots', () => { expect(codeMatchesExclusion('E10.9', 'E10')).toBe(true); expect(codeMatchesExclusion('E11.9', 'E10')).toBe(false) })
// import.test.ts
const META = { kind: 'icd10', version: 'TEST-1', name: 'Test', licenceNote: 'licence ref' } as const
const H = CODE_CSV_HEADERS.join(',')
it('parses an Excel-style file (BOM, CRLF, quoted comma)', () => {
  const r = validateCodeSystemImport(`﻿${H}\r\nE11,"Diabetes, type 2",,no,yes,,,,,,\r\nE11.9,Without complications,E11,,,,,,,,\r\n\r\n`, META, WEB_IMPORT_LIMITS)
  expect(r.issues).toEqual([]); expect(r.rows[0]).toMatchObject({ code: 'E11', display: 'Diabetes, type 2', selectable: false }); expect(r.rows[1].parentCode).toBe('E11')
})
it('one bad row blocks the import with its line', () => {
  const r = validateCodeSystemImport(`${H}\nE11,Ok,,,,,,,,,\nBAD,Nope,,,,,,,,,\n`, META, WEB_IMPORT_LIMITS)
  expect(r.issues).toEqual([expect.objectContaining({ line: 3, column: 'code' })])
})
it('rejects formula-like displays, duplicates, bad parents and loops', () => {
  const r = validateCodeSystemImport(`${H}\nE11,=HYPERLINK(1),,,,,,,,,\nE11,dup,,,,,,,,,\nE12,x,E99,,,,,,,,\nE13,a,E14,,,,,,,,\nE14,b,E13,,,,,,,,\n`, META, WEB_IMPORT_LIMITS)
  expect(r.issues.map((i) => i.message)).toEqual(expect.arrayContaining(['Display may not start with = + - or @', 'Duplicate code', 'Parent chain loops']))
  expect(r.issues.some((i) => i.line === 4 && i.column === 'parent_code')).toBe(true)
})
it('requires a licence note unless the version is SAMPLE-', () => {
  expect(validateCodeSystemImport(`${H}\nE11,x,,,,,,,,,\n`, { ...META, licenceNote: null }, WEB_IMPORT_LIMITS).issues[0].message).toMatch(/licence/i)
})
it('caps size and rows', () => {
  expect(validateCodeSystemImport('x'.repeat(11), META, { maxBytes: 10, maxRows: 5 }).issues[0].message).toMatch(/larger than 10 bytes/)
})
it.each([['SAMPLE-icd10.csv', 'icd10', 'SAMPLE-ICD10-0'], ['SAMPLE-icd10pcs.csv', 'icd10pcs', 'SAMPLE-PCS-0'], ['SAMPLE-hbp.csv', 'hbp', 'SAMPLE-HBP-0']] as const)(
  'fixture %s validates as a sample', (f, kind, version) => {
    const r = validateCodeSystemImport(readFileSync(join('scripts/code-systems/samples', f), 'utf8'), { kind, version, name: 'Sample', licenceNote: null }, WEB_IMPORT_LIMITS)
    expect(r.issues).toEqual([]); expect(r.isSample).toBe(true); expect(r.rows.every((row) => row.display.startsWith('SAMPLE'))).toBe(true)
  })
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/lib/coding` → FAIL (modules missing).
- [ ] **Step 3: Implement** both modules and the three fixtures as specified.
- [ ] **Step 4: Verify** — `npx vitest run tests/lib/coding`, `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/coding/code-systems.ts src/lib/coding/import.ts scripts/code-systems tests/lib/coding
git commit -m "feat(sp6): code-system kinds, patterns, FHIR URIs and the validated CSV importer with sample fixtures"
```

---

### Task 3: Coding rules, status machine, request schemas, error catalogue (pure)

**Files:**
- Create: `src/lib/coding/status.ts`, `src/lib/coding/rules.ts`, `src/lib/coding/validation.ts`, `src/lib/coding/errors.ts`
- Test: `tests/lib/coding/status.test.ts`, `tests/lib/coding/rules.test.ts`, `tests/lib/coding/validation.test.ts`

**Interfaces:**
- Consumes: Task 2 (`CodeSystemKind`, `isCodeValidOn`, `codeMatchesExclusion`, `DIAGNOSIS_CODE_KINDS`, `PROCEDURE_CODE_KINDS`); `ageOnDate` (`src/lib/india-time.ts`); `isoDateSchema` (SP3 `src/lib/follow-ups/validation.ts`); `type Role` (`import type`).
- Produces (`status.ts`):
  - `DIAGNOSIS_TYPES = ['primary', 'secondary', 'provisional'] as const`, `CODE_ENTRY_STATUSES = ['uncoded', 'proposed', 'coded'] as const`, `ENCOUNTER_CODING_STATUSES = ['uncoded', 'in_progress', 'queried', 'coded', 'finalised'] as const`, `CODING_QUERY_STATUSES = ['open', 'answered', 'closed', 'withdrawn'] as const`, `CODING_ACTIONS = ['claim', 'assign', 'release', 'raise_query', 'resume', 'mark_coded', 'finalise', 'reopen'] as const`, `CODING_EVENT_ACTIONS = [...CODING_ACTIONS, 'edit_after_coded'] as const`, with their types (`DiagnosisType`, `CodeEntryStatus`, `EncounterCodingStatus`, `CodingQueryStatus`, `CodingAction`, `CodingEventAction`)
  - `nextCodingStatus(from: EncounterCodingStatus, action: CodingAction): EncounterCodingStatus | null`, exactly:
    - `claim`, `assign`: uncoded→in_progress; in_progress/queried/coded → unchanged; finalised → null
    - `release`: in_progress/queried/coded → unchanged; uncoded/finalised → null
    - `raise_query`: uncoded/in_progress/queried/coded → queried; finalised → null
    - `resume`: queried → in_progress only · `mark_coded`: in_progress → coded only · `finalise`: coded → finalised only · `reopen`: finalised → in_progress only
  - `statusAfterCoderEdit(from): EncounterCodingStatus | null` — uncoded→in_progress, in_progress→in_progress, queried→queried, coded→in_progress, finalised→null
  - `doctorMayPropose(status: EncounterCodingStatus): boolean` — true for uncoded, in_progress, queried
  - `CODING_ACTION_ROLES: Record<CodingAction, readonly Role[]>` — `assign: ['admin']`; every other action `['admin', 'coder']`
  - `CODING_STATUS_LABEL: Record<EncounterCodingStatus, string>` = `{ uncoded: 'Not started', in_progress: 'In progress', queried: 'Query open', coded: 'Coded, awaiting finalise', finalised: 'Finalised' }`
- Produces (`rules.ts`):
  - `type Gender = 'male' | 'female' | 'transgender' | 'other' | 'unknown'`
  - `interface RuleCode { id: number; kind: CodeSystemKind; code: string; active: boolean; effectiveFrom: string | null; effectiveTo: string | null; selectable: boolean; sexRestriction: 'male' | 'female' | null; ageMinYears: number | null; ageMaxYears: number | null; excludes: string[] }`
  - `interface RuleDiagnosis { id: number; type: DiagnosisType | null; codingStatus: CodeEntryStatus; code: RuleCode | null }`
  - `interface RuleProcedure { id: number; codingStatus: CodeEntryStatus; performedOn: string; code: RuleCode | null; serviceMappedCodes: { kind: CodeSystemKind; code: string }[] | null }`
  - `interface CodingRuleInput { encounterDate: string; encounterEndDate: string | null; patient: { gender: Gender | null; dob: string }; diagnoses: RuleDiagnosis[]; procedures: RuleProcedure[] }`
  - `type CodingStage = 'coded' | 'finalise'`
  - `CODING_ISSUE_CODES = ['no_diagnoses', 'not_coded', 'code_inactive', 'code_not_valid_on_date', 'code_not_selectable', 'code_system_not_allowed', 'sex_mismatch', 'sex_unverifiable', 'age_out_of_range', 'excludes_conflict', 'duplicate_code', 'primary_missing', 'multiple_primary', 'provisional_remaining', 'procedure_date_outside_encounter', 'procedure_not_mapped_to_service'] as const`; `type CodingIssueCode`
  - `interface CodingIssue { severity: 'error' | 'warning'; code: CodingIssueCode; entry: { kind: 'diagnosis' | 'procedure'; id: number } | null; message: string }`
  - `checkCodeForEntry(code: RuleCode, entryKind: 'diagnosis' | 'procedure', ctx: { onDate: string; gender: Gender | null; dob: string }, entryId?: number): CodingIssue[]` — single-code checks used at write time: `code_system_not_allowed` (kind not in the entry's allowed kinds), `code_inactive`, `code_not_valid_on_date`, `code_not_selectable`, `sex_mismatch` (restriction set, gender male/female and different), `sex_unverifiable` (restriction set, gender null/transgender/other/unknown — warning), `age_out_of_range` (`ageOnDate(dob, onDate)` outside inclusive min/max). All errors except `sex_unverifiable`.
  - `validateEncounterCoding(input: CodingRuleInput, stage: CodingStage): CodingIssue[]` — runs `checkCodeForEntry` on every coded/proposed entry (diagnoses on `encounterDate`, procedures on `performedOn`), plus: `no_diagnoses` (error), `not_coded` per uncoded/proposed entry (error), `duplicate_code` (same kind+code twice among diagnoses: error; among procedures: warning), `excludes_conflict` (diagnosis A's `excludes` matches diagnosis B of the same kind: error, reported once per pair), `multiple_primary` (error), `primary_missing` and `provisional_remaining` (warning at `coded`, error at `finalise`), `procedure_date_outside_encounter` (performedOn before `encounterDate` or after `encounterEndDate ?? encounterDate`: warning), `procedure_not_mapped_to_service` (service has a mapping and the code is not in it: warning). Messages are fixed strings naming only the code value.
  - `hasBlockingIssues(issues: CodingIssue[]): boolean`
- Produces (`validation.ts`, all `.strict()`):
  - `codingStatusRequestSchema` = `z.discriminatedUnion('action', [{ action: 'claim' }, { action: 'assign', assigneeUserId: positive int }, { action: 'release' }, { action: 'resume' }, { action: 'mark_coded' }, { action: 'finalise' }, { action: 'reopen', reason: trim 1–500 }])`; type `CodingStatusRequest`
  - `addDiagnosisSchema = { codeId?: positive int, description?: trim 1–500, type: z.enum(DIAGNOSIS_TYPES), sequence?: int 1–99 }`, refined `codeId !== undefined || description !== undefined` (message `'Choose a code or describe the diagnosis'`); type `AddDiagnosisRequest`
  - `updateDiagnosisSchema = { codeId?: positive int, type?: …, sequence?: … }`, refined at least one key; type `UpdateDiagnosisRequest`
  - `addProcedureSchema = { codeId?, description?: trim 1–500, performedOn: isoDateSchema, performedByProviderId?: positive int, serviceId?: positive int, sequence? }`, same refinement; `updateProcedureSchema` (every field optional, at least one); types `AddProcedureRequest`, `UpdateProcedureRequest`
  - `raiseQuerySchema = { addressedToProviderId: positive int, question: trim 1–1000 }`; `queryResponseSchema = { body: trim 1–2000 }`; `queryActionSchema = { action: z.enum(['close', 'withdraw']) }`
  - `codeSearchParamsSchema = { kind: z.enum(CODE_SYSTEM_KINDS), q: trim 1–60, on?: isoDateSchema, limit?: coerce int 1–50 default 20 }`
  - `codeSystemImportSchema = { kind, version: string, name: string, licenceNote: string | null, sourceFileName: trim 1–200, csv: string, commit: boolean, makeCurrent: boolean }`
  - `serviceCodesSchema = { codes: array max 20 of { kind: z.enum(CODE_SYSTEM_KINDS), code: string trim 1–20, isPrimary: boolean } }`, refined ≤ 1 primary and no duplicate kind+code
- Produces (`errors.ts`):
  - `type CodingWriteError = 'not_found' | 'entry_not_found' | 'query_not_found' | 'encounter_cancelled' | 'encounter_not_completed' | 'locked' | 'not_claimed' | 'already_assigned' | 'invalid_transition' | 'open_queries' | 'primary_exists' | 'query_closed' | 'code_required' | 'code_not_found' | 'code_invalid' | 'validation_failed' | 'no_user_account' | 'assignee_not_coder' | 'provider_not_found' | 'service_not_found' | 'performed_in_future'`
  - `type CodingWriteResult<T> = { ok: true; value: T } | { ok: false; error: CodingWriteError; issues?: CodingIssue[] }`
  - `CODING_ERROR_STATUS: Record<CodingWriteError, 400 | 404 | 409 | 422>`: 404 = not_found, entry_not_found, query_not_found; 409 = encounter_cancelled, encounter_not_completed, locked, not_claimed, already_assigned, invalid_transition, open_queries, primary_exists, query_closed; 422 = code_invalid, validation_failed; 400 = the rest
  - `CODING_ERROR_MESSAGE: Record<CodingWriteError, string>`, verbatim: not_found `'Encounter not found'`; entry_not_found `'That diagnosis or procedure is not on this encounter'`; query_not_found `'Coding query not found'`; encounter_cancelled `'This visit was cancelled, so it is not coded'`; encounter_not_completed `'Coding starts once the visit is completed or the patient is discharged'`; locked `'Coding for this visit is closed to changes'`; not_claimed `'Claim this encounter before changing its codes'`; already_assigned `'Another coder has already claimed this encounter'`; invalid_transition `'That step is not possible from the current coding status'`; open_queries `'Close or withdraw the open doctor queries first'`; primary_exists `'This visit already has a primary diagnosis'`; query_closed `'This query is already closed'`; code_required `'Choose a code from the loaded code set'`; code_not_found `'Code not found in any loaded code set'`; code_invalid `'That code cannot be used here'`; validation_failed `'Coding checks failed; fix the errors listed'`; no_user_account `'Your login has no staff account, so it cannot claim work'`; assignee_not_coder `'Assign the encounter to a staff member with the coder role'`; provider_not_found `'Doctor not found or inactive'`; service_not_found `'Service not found'`; performed_in_future `'The procedure date cannot be in the future'`

- [ ] **Step 1: Write the failing tests**

```ts
// status.test.ts
it('walks the happy path and refuses skips', () => {
  expect(nextCodingStatus('uncoded', 'claim')).toBe('in_progress'); expect(nextCodingStatus('in_progress', 'raise_query')).toBe('queried')
  expect(nextCodingStatus('queried', 'resume')).toBe('in_progress'); expect(nextCodingStatus('in_progress', 'mark_coded')).toBe('coded')
  expect(nextCodingStatus('coded', 'finalise')).toBe('finalised'); expect(nextCodingStatus('in_progress', 'finalise')).toBeNull()
  expect(nextCodingStatus('finalised', 'claim')).toBeNull(); expect(nextCodingStatus('finalised', 'reopen')).toBe('in_progress')
})
it('a coder edit after coded reverts to in_progress; finalised refuses edits and proposals', () => {
  expect(statusAfterCoderEdit('coded')).toBe('in_progress'); expect(statusAfterCoderEdit('finalised')).toBeNull()
  expect(doctorMayPropose('coded')).toBe(false); expect(doctorMayPropose('queried')).toBe(true)
})
it('only admin assigns', () => { expect(CODING_ACTION_ROLES.assign).toEqual(['admin']); expect(CODING_ACTION_ROLES.finalise).toEqual(['admin', 'coder']) })
// rules.test.ts  (helper code(over) builds an active selectable icd10 RuleCode)
const base = { encounterDate: '2026-10-07', encounterEndDate: '2026-10-09', patient: { gender: 'male' as const, dob: '1990-05-01' }, procedures: [] }
it('primary missing warns at coded and blocks finalise', () => {
  const input = { ...base, diagnoses: [{ id: 1, type: 'secondary' as const, codingStatus: 'coded' as const, code: code() }] }
  expect(validateEncounterCoding(input, 'coded')).toEqual([expect.objectContaining({ code: 'primary_missing', severity: 'warning' })])
  expect(hasBlockingIssues(validateEncounterCoding(input, 'finalise'))).toBe(true)
})
it('flags sex and age edits from the code table', () => {
  expect(checkCodeForEntry(code({ sexRestriction: 'female' }), 'diagnosis', { onDate: '2026-10-07', gender: 'male', dob: '1990-05-01' }).map((i) => i.code)).toEqual(['sex_mismatch'])
  expect(checkCodeForEntry(code({ sexRestriction: 'female' }), 'diagnosis', { onDate: '2026-10-07', gender: 'unknown', dob: '1990-05-01' })[0].severity).toBe('warning')
  expect(checkCodeForEntry(code({ ageMaxYears: 17 }), 'diagnosis', { onDate: '2026-10-07', gender: 'male', dob: '2008-10-07' }).map((i) => i.code)).toEqual(['age_out_of_range'])
  expect(checkCodeForEntry(code({ ageMaxYears: 17 }), 'diagnosis', { onDate: '2026-10-07', gender: 'male', dob: '2008-10-08' })).toEqual([])
})
it('rejects a PCS code as a diagnosis, inactive and out-of-date codes, header codes', () => {
  const ctx = { onDate: '2026-10-07', gender: 'male' as const, dob: '1990-05-01' }
  expect(checkCodeForEntry(code({ kind: 'icd10pcs' }), 'diagnosis', ctx).map((i) => i.code)).toContain('code_system_not_allowed')
  expect(checkCodeForEntry(code({ active: false }), 'diagnosis', ctx).map((i) => i.code)).toContain('code_inactive')
  expect(checkCodeForEntry(code({ effectiveTo: '2026-10-06' }), 'diagnosis', ctx).map((i) => i.code)).toContain('code_not_valid_on_date')
  expect(checkCodeForEntry(code({ selectable: false }), 'diagnosis', ctx).map((i) => i.code)).toContain('code_not_selectable')
})
it('finds excludes conflicts and duplicates once', () => {
  const dx = [{ id: 1, type: 'primary' as const, codingStatus: 'coded' as const, code: code({ code: 'U8Z.0', excludes: ['U8Z.1'] }) },
    { id: 2, type: 'secondary' as const, codingStatus: 'coded' as const, code: code({ id: 2, code: 'U8Z.1' }) }, { id: 3, type: 'secondary' as const, codingStatus: 'coded' as const, code: code({ id: 2, code: 'U8Z.1' }) }]
  const codes = validateEncounterCoding({ ...base, diagnoses: dx }, 'coded').map((i) => i.code)
  expect(codes.filter((c) => c === 'excludes_conflict')).toHaveLength(2) // 1↔2 and 1↔3
  expect(codes.filter((c) => c === 'duplicate_code')).toHaveLength(1)
})
it('uncoded and proposed rows block both stages; an encounter with no diagnoses blocks', () => {
  expect(validateEncounterCoding({ ...base, diagnoses: [] }, 'coded').map((i) => i.code)).toContain('no_diagnoses')
  expect(validateEncounterCoding({ ...base, diagnoses: [{ id: 1, type: 'primary', codingStatus: 'proposed', code: code() }] }, 'coded').map((i) => i.code)).toContain('not_coded')
})
it('warns on a procedure dated outside the stay and not in the service map', () => {
  const p = { id: 9, codingStatus: 'coded' as const, performedOn: '2026-10-10', code: code({ kind: 'icd10pcs', code: 'ZZ00000' }), serviceMappedCodes: [{ kind: 'icd10pcs' as const, code: 'ZZ00001' }] }
  const issues = validateEncounterCoding({ ...base, diagnoses: [{ id: 1, type: 'primary', codingStatus: 'coded', code: code() }], procedures: [p] }, 'finalise')
  expect(issues.map((i) => [i.code, i.severity])).toEqual(expect.arrayContaining([['procedure_date_outside_encounter', 'warning'], ['procedure_not_mapped_to_service', 'warning']]))
})
// validation.test.ts
it('reopen needs a reason; assign needs a user', () => {
  expect(codingStatusRequestSchema.safeParse({ action: 'reopen' }).success).toBe(false)
  expect(codingStatusRequestSchema.safeParse({ action: 'reopen', reason: 'payer query' }).success).toBe(true)
  expect(codingStatusRequestSchema.safeParse({ action: 'assign' }).success).toBe(false)
})
it('a diagnosis needs a code or a description, and is strict', () => {
  expect(addDiagnosisSchema.safeParse({ type: 'primary' }).success).toBe(false)
  expect(addDiagnosisSchema.safeParse({ type: 'primary', description: 'Chest pain' }).success).toBe(true)
  expect(addDiagnosisSchema.safeParse({ type: 'primary', codeId: 3, codingStatus: 'coded' }).success).toBe(false)
})
it('every error has a status and a message', () => { for (const k of Object.keys(CODING_ERROR_STATUS)) expect(CODING_ERROR_MESSAGE[k as CodingWriteError].length).toBeGreaterThan(0) })
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/lib/coding` → FAIL.
- [ ] **Step 3: Implement** the four modules. Date comparisons are string comparisons on ISO dates; no `Date` local getters.
- [ ] **Step 4: Verify** — `npx vitest run tests/lib/coding`, `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/coding tests/lib/coding
git commit -m "feat(sp6): coding rules, encounter coding status machine, request schemas and error catalogue"
```

---

### Task 4: Schema + migration for code systems, coded diagnoses/procedures, coding workflow

**Files:**
- Modify: `src/db/schema.ts` (`// SP6` block after the SP3 block; give `diagnoses` new columns and an extra-config array), `src/lib/queries/patients.ts` `deletePatient` (delete `codingQueries` (responses cascade), `encounterCodingEvents` for the patient's encounter ids, `encounterCoding`, `encounterProcedures` — all **before** the SP3 `encounters` delete), `src/db/seed.ts` `clearExistingData` (same four tables before `encounters`; `serviceProcedureCodes` before `tariffRates`; code systems are **not** cleared — they are owner-loaded reference data)
- Create: `scripts/migrations/2026-10-07-sp6-b-clinical-coding.sql`
- Test: `tests/db/clinical-coding-schema.test.ts`

**Interfaces:**
- Consumes: Task 2/3 constants (the test asserts each pgEnum's values equal them).
- Produces (exact):

```ts
// SP6 clinical coding (scripts/migrations/2026-10-07-sp6-b-clinical-coding.sql)
export const codeSystemKindEnum = pgEnum('code_system_kind', ['icd10', 'icd10pcs', 'snomed', 'loinc', 'hbp'])
export const codeEntryStatusEnum = pgEnum('code_entry_status', ['uncoded', 'proposed', 'coded'])
export const diagnosisTypeEnum = pgEnum('diagnosis_type', ['primary', 'secondary', 'provisional'])
export const encounterCodingStatusEnum = pgEnum('encounter_coding_status', ['uncoded', 'in_progress', 'queried', 'coded', 'finalised'])
export const codingEventActionEnum = pgEnum('coding_event_action', ['claim', 'assign', 'release', 'raise_query', 'resume', 'mark_coded', 'finalise', 'reopen', 'edit_after_coded'])
export const codingQueryStatusEnum = pgEnum('coding_query_status', ['open', 'answered', 'closed', 'withdrawn'])
```

- **`codeSystems`** (`code_systems`): `id` serial; `kind` not null; `version` text not null; `name` text not null; `isSample` boolean default false not null; `isCurrent` boolean default false not null; `licenceNote` text; `sourceFileName` text not null; `sourceSha256` text not null; `codeCount` integer not null; `importedByName` text not null; `importedAt` timestamp defaultNow not null. Config: `uniqueIndex('code_systems_kind_version_unique').on(kind, version)`, `uniqueIndex('code_systems_one_current_per_kind').on(kind).where(sql\`${t.isCurrent}\`)`, `check('code_systems_count_nonneg', code_count >= 0)`, `check('code_systems_licence_unless_sample', is_sample OR licence_note IS NOT NULL)`.
- **`codes`**: `id` serial; `codeSystemId` integer not null → codeSystems; `code` text not null; `display` text not null; `parentCode` text; `selectable` boolean default true not null; `active` boolean default true not null; `effectiveFrom` date; `effectiveTo` date; `sexRestriction` `text('sex_restriction', { enum: ['male', 'female'] })`; `ageMinYears` integer; `ageMaxYears` integer; `excludes` `text('excludes').array().default(sql\`'{}'::text[]\`).notNull()`. Config: `uniqueIndex('codes_system_code_unique').on(codeSystemId, code)`, `index('codes_code_prefix_idx').on(t.codeSystemId, t.code.op('text_pattern_ops'))`, `check('codes_effective_range', effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from)`, `check('codes_age_range', (age_min_years IS NULL OR age_min_years BETWEEN 0 AND 150) AND (age_max_years IS NULL OR age_max_years BETWEEN 0 AND 150) AND (age_min_years IS NULL OR age_max_years IS NULL OR age_min_years <= age_max_years))`.
  - **MIGRATION-ONLY** (comment in `schema.ts`, like SP2's exclusion constraint): `CREATE EXTENSION IF NOT EXISTS pg_trgm;` and `CREATE INDEX IF NOT EXISTS codes_display_trgm_idx ON codes USING gin (lower(display) gin_trgm_ops);`. Search works without it, only slower.
- **`diagnoses`** gains (all nullable unless stated; existing columns untouched): `encounterId` → encounters; `codeId` → codes; `codeSystemKind`; `codeDisplay` text; `diagnosisType`; `codingStatus` `codeEntryStatusEnum('coding_status').default('uncoded').notNull()`; `sequence` integer; `proposedByName` text; `proposedAt` timestamp; `codedByName` text; `codedAt` timestamp; `voidedAt` timestamp; `voidedByName` text; `createdByName` text; `createdAt` timestamp. Config: `index('diagnoses_encounter_id_idx').on(encounterId)`, `uniqueIndex('diagnoses_one_primary_per_encounter').on(t.encounterId).where(sql\`${t.diagnosisType} = 'primary' AND ${t.voidedAt} IS NULL\`)`, `check('diagnoses_coded_complete', coding_status <> 'coded' OR (code_id IS NOT NULL AND encounter_id IS NOT NULL AND diagnosis_type IS NOT NULL))`, `check('diagnoses_proposed_has_code', coding_status <> 'proposed' OR code_id IS NOT NULL)`, `check('diagnoses_code_kind_pair', (code_id IS NULL) = (code_system_kind IS NULL))`. **Convention:** an SP6-written diagnosis without a code stores `code = ''` (the legacy column is NOT NULL and the migration may not drop that).
- **`encounterProcedures`** (`encounter_procedures`): `id` serial; `encounterId` not null → encounters; `patientId` text not null → patients; `description` text not null; `codeId` → codes; `codeSystemKind`; `code` text; `codeDisplay` text; `codingStatus` default `'uncoded'` not null; `performedOn` date not null; `performedByProviderId` → providers; `serviceId` → serviceCatalog; `sequence` integer; `createdByName` text not null; `createdAt` defaultNow not null; `proposedByName`, `proposedAt`, `codedByName`, `codedAt`, `voidedAt`, `voidedByName`. Config: `index('encounter_procedures_encounter_id_idx')`, `index('encounter_procedures_patient_id_idx')`, `check('encounter_procedures_code_required', coding_status = 'uncoded' OR (code_id IS NOT NULL AND code IS NOT NULL))`, `check('encounter_procedures_code_kind_pair', (code_id IS NULL) = (code_system_kind IS NULL))`.
- **`encounterCoding`** (`encounter_coding`): `encounterId` `integer('encounter_id').primaryKey().references(() => encounters.id)`; `patientId` text not null → patients; `status` default `'uncoded'` not null; `assignedToUserId` → users; `assignedToName` text; `assignedAt` timestamp; `codedAt`, `codedByName`, `finalisedAt`, `finalisedByName`; `reopenCount` integer default 0 not null; `updatedAt` defaultNow not null. Config: `index('encounter_coding_status_idx').on(status)`, `index('encounter_coding_assignee_idx').on(assignedToUserId)`, `check('encounter_coding_finalised_stamp', status <> 'finalised' OR finalised_at IS NOT NULL)`.
- **`encounterCodingEvents`** (`encounter_coding_events`): `id` serial; `encounterId` not null → encounters; `action` `codingEventActionEnum` not null; `fromStatus`, `toStatus` `encounterCodingStatusEnum` not null; `reason` text; `byName` text not null; `byUserId` → users; `at` timestamp defaultNow not null. Config: `index('encounter_coding_events_encounter_idx')`, `index('encounter_coding_events_at_idx').on(at)`, `check('encounter_coding_events_reason_len', reason IS NULL OR char_length(reason) <= 500)`.
- **`codingQueries`** (`coding_queries`): `id` serial; `encounterId` not null → encounters; `patientId` not null → patients; `addressedToProviderId` not null → providers; `question` text not null; `status` `codingQueryStatusEnum` default `'open'` not null; `raisedByName` text not null; `raisedByUserId` → users; `raisedAt` defaultNow not null; `answeredAt` timestamp; `closedAt` timestamp; `closedByName` text. Config: `index('coding_queries_encounter_idx')`, `index('coding_queries_provider_status_idx').on(addressedToProviderId, status)`, `check('coding_queries_question_len', char_length(question) BETWEEN 1 AND 1000)`.
- **`codingQueryResponses`** (`coding_query_responses`): `id` serial; `queryId` integer not null; `authorName` text not null; `authorRole` `roleEnum('author_role')` not null; `body` text not null; `createdAt` defaultNow not null. Config: `foreignKey({ name: 'coding_query_responses_query_fk', columns: [t.queryId], foreignColumns: [codingQueries.id] }).onDelete('cascade')`, `index('coding_query_responses_query_idx')`, `check('coding_query_responses_body_len', char_length(body) BETWEEN 1 AND 2000)`.
- **`serviceProcedureCodes`** (`service_procedure_codes`): `id` serial; `serviceId` not null → serviceCatalog; `codeSystemKind` not null; `code` text not null; `isPrimary` boolean default false not null; `createdByName` text not null; `createdAt` defaultNow not null. Config: `uniqueIndex('service_procedure_codes_unique').on(serviceId, codeSystemKind, code)`, `uniqueIndex('service_procedure_codes_one_primary').on(t.serviceId).where(sql\`${t.isPrimary}\`)`.
- Types: `CodeSystemRow`, `CodeRow`, `EncounterProcedureRow`, `EncounterCodingRow`, `EncounterCodingEventRow`, `CodingQueryRow`, `CodingQueryResponseRow`, `ServiceProcedureCodeRow` (`$inferSelect`); `DiagnosisRow = typeof diagnoses.$inferSelect`.
- **Migration b:** header (additive, safe to re-run, requires the SP1/SP2/SP3 migrations and `2026-10-07-sp6-a-coder-role.sql`, the docker command, and the MIGRATION-ONLY trigram note). Order: extension, types, `CREATE TABLE IF NOT EXISTS` without inline FKs, `ALTER TABLE diagnoses ADD COLUMN IF NOT EXISTS …` (with `coding_status code_entry_status NOT NULL DEFAULT 'uncoded'`), then every FK/unique/check in its own `pg_constraint`-guarded `DO` block named exactly as `getTableConfig` names it, then `CREATE [UNIQUE] INDEX IF NOT EXISTS` (partial ones with their `WHERE`). No data `UPDATE`s.

- [ ] **Step 1: Write the failing tests** (`tests/db/clinical-coding-schema.test.ts`)

```ts
const MIGRATION = '2026-10-07-sp6-b-clinical-coding.sql'
const NEW_TABLES = [codeSystems, codes, encounterProcedures, encounterCoding, encounterCodingEvents, codingQueries, codingQueryResponses, serviceProcedureCodes]
const SP6_DIAGNOSIS_COLUMNS = ['encounter_id', 'code_id', 'code_system_kind', 'code_display', 'diagnosis_type', 'coding_status', 'sequence', 'proposed_by_name', 'proposed_at', 'coded_by_name', 'coded_at', 'voided_at', 'voided_by_name', 'created_by_name', 'created_at']
it('migration is idempotent and non-destructive, with no data updates', () => {
  const s = readMigration(MIGRATION); expect(idempotencyProblems(s)).toEqual([]); expect(s).not.toMatch(/\bUPDATE\s+diagnoses\b/i)
})
it.each(NEW_TABLES.map((t) => [getTableConfig(t).name, t] as const))('declares every %s column', (_n, t) => { expect(missingColumns(t, readMigration(MIGRATION))).toEqual([]) })
it('declares the SP6 diagnosis columns', () => { expect(missingColumns(diagnoses, readMigration(MIGRATION)).filter((c) => SP6_DIAGNOSIS_COLUMNS.includes(c))).toEqual([]) })
it('every FK, unique, check and index name is in the SQL and fits 63 chars', () => { /* same loop as SP3 Task 2 over NEW_TABLES + diagnoses (diagnoses: only names starting 'diagnoses_' plus its new FK names) */ })
it('pgEnum values match the pure constants', () => {
  expect(codeSystemKindEnum.enumValues).toEqual([...CODE_SYSTEM_KINDS]); expect(encounterCodingStatusEnum.enumValues).toEqual([...ENCOUNTER_CODING_STATUSES])
  expect(codeEntryStatusEnum.enumValues).toEqual([...CODE_ENTRY_STATUSES]); expect(diagnosisTypeEnum.enumValues).toEqual([...DIAGNOSIS_TYPES])
  expect(codingEventActionEnum.enumValues).toEqual([...CODING_EVENT_ACTIONS]); expect(codingQueryStatusEnum.enumValues).toEqual([...CODING_QUERY_STATUSES])
})
it('the trigram index and extension are in the migration only', () => { expect(readMigration(MIGRATION)).toMatch(/codes_display_trgm_idx[\s\S]*gin_trgm_ops/) })
describe.skipIf(!process.env.DATABASE_URL)('SP6 schema (DB)', () => {
  it('migration leaves a legacy diagnosis untouched and uncoded', async () => { /* insert {patientId, code:'F32.1', description:'Depression', date:'2025-01-15'} → row.code 'F32.1', codingStatus 'uncoded', encounterId null, codeId null */ })
  it('allows one live primary per encounter', async () => { /* SP3 encounter fixture; two primary rows → isUniqueViolation(err, 'diagnoses_one_primary_per_encounter'); voiding the first lets the second insert */ })
  it('refuses a coded diagnosis without a code', async () => { /* codingStatus 'coded', codeId null → check 'diagnoses_coded_complete' */ })
  it('allows one current version per kind and cascades query responses', async () => { /* two is_current icd10 rows → unique 'code_systems_one_current_per_kind'; delete a query → responses gone */ })
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/db/clinical-coding-schema.test.ts` → FAIL.
- [ ] **Step 3: Implement** the schema block, migration b, `deletePatient` and seed edits. Add `foreignKey` to the `drizzle-orm/pg-core` import if SP3 has not.
- [ ] **Step 4: Apply twice to the local DB, then verify**

Run the docker apply command on migration b twice (both `COMMIT`). Then `npx vitest run tests/db/clinical-coding-schema.test.ts tests/db/schema.test.ts tests/lib/no-credential-leak.test.ts tests/lib/no-aadhaar-leak.test.ts`, `npm test -- tests/db/clinical-coding-schema.test.ts tests/lib/queries/delete-patient-fk-guard.test.ts tests/db/seed-clear-existing-data-fk-order.test.ts`.
Expected: all PASS; the FK guard sees every new `patients` FK handled.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts scripts/migrations/2026-10-07-sp6-b-clinical-coding.sql src/lib/queries/patients.ts src/db/seed.ts tests/db/clinical-coding-schema.test.ts
git commit -m "feat(sp6): code systems, coded diagnoses/procedures and coding workflow schema + migration"
```

---

### Task 5: Code-system queries, CLI importer, owner docs

**Files:**
- Create: `src/lib/queries/code-systems.ts`, `src/lib/coding/import-cli.ts`, `scripts/import-code-system.ts`, `docs/CODE-SYSTEMS.md`
- Modify: `package.json` (script `"codes:import": "dotenv -e .env.local -- tsx scripts/import-code-system.ts"`), `docs/DEPLOYING.md` §4 (SP6 migrations, the migration-only `codes_display_trgm_idx`, and "load code sets with `npm run codes:import`, see docs/CODE-SYSTEMS.md")
- Test: `tests/lib/queries/code-systems.test.ts` (DB), `tests/lib/coding/import-cli.test.ts`

**Interfaces:**
- Consumes: Task 2 (`validateCodeSystemImport`, `CodeImportMeta`, `CodeImportRow`, `CLI_IMPORT_LIMITS`, `normalizeCode`, `CodeBinding`), Task 3 (`RuleCode`), Task 4 tables, `logAudit`, `WriteExecutor`.
- Produces (`code-systems.ts`):
  - `class CodeSystemVersionExistsError extends Error {}`; `class SampleOverLicensedError extends Error {}`
  - `sha256Hex(text: string): string` (`node:crypto`)
  - `interface CommitCodeSystemInput extends CodeImportMeta { sourceFileName: string; sourceSha256: string; makeCurrent: boolean; isSample: boolean }`
  - `commitCodeSystemImport(input: CommitCodeSystemInput, rows: CodeImportRow[], session: Session): Promise<{ codeSystemId: number; codeCount: number; isCurrent: boolean }>` — one transaction: `pg_advisory_xact_lock(hashtext('code_systems:' || kind))`; existing `(kind, version)` → throw `CodeSystemVersionExistsError`; insert the `code_systems` row; insert `codes` in chunks of 1000; becomes current when `makeCurrent` or no current version of the kind exists — but a sample never becomes current while a non-sample version of the kind exists (throw `SampleOverLicensedError` when `makeCurrent`, silently stay non-current otherwise); audit `coding: imported code system`, patient null, details `kind=<k> version=<v> codes=<n> sample=<bool> current=<bool>`.
  - `listCodeSystems(): Promise<CodeSystemRow[]>` (kind, then importedAt desc)
  - `setCurrentCodeSystem(id: number, session: Session): Promise<'ok' | 'not_found' | 'sample_over_licensed'>` — same lock; clears the kind's current flag then sets it; audit `coding: set current code system`, details `kind=<k> version=<v>`.
  - `interface CodeSearchHit { id: number; kind: CodeSystemKind; code: string; display: string; selectable: boolean; version: string; isSample: boolean }`
  - `searchCodes(i: { kind: CodeSystemKind; q: string; onDate: string | null; limit: number }): Promise<{ codeSystem: { id: number; version: string; isSample: boolean } | null; hits: CodeSearchHit[] }>` — current version only; `code LIKE <normalizeCode(q) escaped>%` OR `lower(display) LIKE %<lower(q) escaped>%`; only active and (when `onDate`) valid on it; order: exact code, code-prefix matches, selectable first, code asc; `escapeLike` escapes `\`, `%`, `_`.
  - `type CodeDetail = RuleCode & { display: string; version: string; isSample: boolean; codeSystemId: number }`
  - `getCodesByIds(ids: number[], executor?: WriteExecutor): Promise<Map<number, CodeDetail>>`
  - `findCurrentCode(kind: CodeSystemKind, code: string, executor?: WriteExecutor): Promise<CodeDetail | null>` (Task 14)
  - `findLoadedCodes(kind: CodeSystemKind, codes: string[]): Promise<Map<string, CodeBinding>>` — current, non-sample, active codes only (Task 15)
- Produces (`import-cli.ts`):
  - `parseImportArgs(argv: string[]): { ok: true; args: { file: string; kind: CodeSystemKind; version: string; name: string; licence: string | null; by: string; makeCurrent: boolean; dryRun: boolean } } | { ok: false; usage: string }` — flags `--file --kind --version --name --licence --by --make-current --dry-run`
  - `runCodeImportCli(argv: string[], deps: { readFile: (p: string) => Promise<string>; commit: typeof commitCodeSystemImport; log: (l: string) => void }): Promise<number>` (exit code) — validates with `CLI_IMPORT_LIMITS`, prints up to 50 issues as `line <n> [<column>]: <message>`, commits unless `--dry-run`, with session `{ role: 'admin', name: \`CLI: ${by}\`, userId: null }` (ruling 9). Exit 0 on success/dry-run clean, 1 on issues, 2 on usage.
  - `scripts/import-code-system.ts` only wires `runCodeImportCli(process.argv.slice(2), …)` and `process.exit`.
- `docs/CODE-SYSTEMS.md` sections: **Licensing ruling** (ruling 1, verbatim from Execution notes); **What ships** (importer, the three `SAMPLE-` fixtures, nothing else); **The CSV format** (`CODE_CSV_HEADERS`, each column's rules); **Loading each code set** — for ICD-10 (WHO ICD-10 as adopted in India; obtain under the WHO licence / MoHFW guidance), ICD-10-PCS (CMS release files), SNOMED CT (India is a SNOMED International member; obtain from NRCeS under its affiliate licence), LOINC (Regenstrief licence, attribution), PM-JAY HBP (NHA published package master): where to get it, which source columns map to `code`/`display`/`parent_code`/`active`/`sex`/age/`excludes`, then `npm run codes:import -- --file … --kind … --version … --name … --licence "<licence ref>" --by "<name>" --make-current`; **Versions** (never deleted, one current per kind, old coded rows keep their version); **Web import** (≤ 4 MB / 60,000 rows; use the CLI for full releases).

- [ ] **Step 1: Write the failing tests**

```ts
// import-cli.test.ts
it('prints usage without required flags', async () => { const lines: string[] = []; expect(await runCodeImportCli([], { readFile: vi.fn(), commit: vi.fn(), log: (l) => lines.push(l) })).toBe(2); expect(lines.join('\n')).toMatch(/--kind/) })
it('dry-run validates and never commits', async () => {
  const commit = vi.fn(); const code = await runCodeImportCli(['--file', 'f.csv', '--kind', 'icd10', '--version', 'SAMPLE-ICD10-0', '--name', 'S', '--by', 'Me', '--dry-run'],
    { readFile: async () => readFileSync('scripts/code-systems/samples/SAMPLE-icd10.csv', 'utf8'), commit, log: () => {} })
  expect(code).toBe(0); expect(commit).not.toHaveBeenCalled()
})
it('commits with a CLI-attributed admin session', async () => { /* … expect(commit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'icd10', isSample: true }), expect.any(Array), { role: 'admin', name: 'CLI: Me', userId: null }) */ })
// code-systems.test.ts (DB)
describe.skipIf(!process.env.DATABASE_URL)('code systems (DB)', () => {
  it('imports all-or-nothing in one transaction with an audit row', async () => { /* commit 2,500 generated TEST rows → codeCount 2500; force a failure (duplicate code injected past validation) → no code_systems row for that version */ })
  it('refuses a second import of the same kind+version', async () => { await expect(commit(sameVersion)).rejects.toBeInstanceOf(CodeSystemVersionExistsError) })
  it('refuses to make a sample current over a licensed version', async () => { /* licensed TEST version current; sample commit with makeCurrent → SampleOverLicensedError; setCurrentCodeSystem(sampleId) → 'sample_over_licensed' */ })
  it('searches the current version by code prefix and display text, valid on a date', async () => {
    // TEST kind icd10 current; codes E11 (header), E11.9, X99.1 display 'Diabetic foot' inactive
    const r = await searchCodes({ kind: 'icd10', q: 'e11', onDate: '2026-10-07', limit: 20 })
    expect(r.hits.map((h) => h.code)).toEqual(['E11', 'E11.9'])
    expect((await searchCodes({ kind: 'icd10', q: 'diabetic', onDate: null, limit: 20 })).hits).toEqual([])  // inactive excluded
    expect((await searchCodes({ kind: 'icd10', q: '50%_', onDate: null, limit: 20 })).hits).toEqual([])      // LIKE metacharacters escaped
  })
})
```

Tests that need a "current" version save and restore the real current flag of their kind in `beforeEach`/`afterEach`, so a developer's loaded code set is untouched.

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/lib/coding/import-cli.test.ts` and `npm test -- tests/lib/queries/code-systems.test.ts` → FAIL.
- [ ] **Step 3: Implement** the query module, CLI module/entry, package script and both docs.
- [ ] **Step 4: Verify** — the same commands → PASS; `npm run codes:import -- --file scripts/code-systems/samples/SAMPLE-icd10.csv --kind icd10 --version SAMPLE-ICD10-0 --name Sample --by Dev --dry-run` prints `0 issues` and exits 0; `npx tsc --noEmit`.
- [ ] **Step 5: Commit**

```bash
git add src/lib/queries/code-systems.ts src/lib/coding/import-cli.ts scripts/import-code-system.ts package.json docs/CODE-SYSTEMS.md docs/DEPLOYING.md tests/lib/queries/code-systems.test.ts tests/lib/coding/import-cli.test.ts
git commit -m "feat(sp6): code-system import/search queries, CLI importer and licensing docs"
```

---

### Task 6: Code-system routes, admin import page, code search API

**Files:**
- Create: `src/lib/http/read-capped-body.ts`; `src/app/api/coding/codes/route.ts` (GET); `src/app/api/coding/code-systems/route.ts` (GET); `src/app/api/coding/code-systems/import/route.ts` (POST); `src/app/api/coding/code-systems/[id]/route.ts` (PATCH); `src/app/(dashboard)/coding/code-systems/page.tsx`; `src/components/coding/CodeSystemImportForm.tsx`; `src/components/coding/CodeSystemList.tsx`
- Modify: `src/app/api/tariff/import/route.ts` (use `readCappedBody`; behaviour unchanged), `src/components/LeftNav.tsx` (`NAV_TRAILING_ITEMS`: `{ href: '/coding/code-systems', label: 'Code Systems', icon: BookOpenCheck, roles: ['admin'] }`), `tests/api/rbac-route-gates.test.ts`, `tests/pages/page-gates-harness.ts`
- Test: `tests/api/coding-code-systems.test.ts`, `tests/lib/http/read-capped-body.test.ts`

**Interfaces:**
- Consumes: Task 5 queries; Task 2 `validateCodeSystemImport`, `WEB_IMPORT_LIMITS`; Task 3 `codeSystemImportSchema`, `codeSearchParamsSchema`; `invalid`, `parseId`, `serverError` patterns (`src/lib/tariff/route-responses.ts`).
- Produces:
  - `readCappedBody(request: Request, maxBytes: number): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: 'too_large' | 'bad_length' }>` — the tariff route's `readCapped` logic moved verbatim.
  - `GET /api/coding/codes?kind&q&on&limit` — `CODE_LOOKUP_ROLES`; 400 `'Invalid code search'` on a bad param; 200 `searchCodes(…)` result. Not audited (no PHI).
  - `GET /api/coding/code-systems` — `CODING_ROLES`; 200 `listCodeSystems()`.
  - `POST /api/coding/code-systems/import` — `CODE_SYSTEM_ADMIN_ROLES`; 415 unless `application/json`; body cap `2 * WEB_IMPORT_LIMITS.maxBytes + 4096`; 413 `{ error: 'This file is too large for the web importer (4 MB). Load it with npm run codes:import; see docs/CODE-SYSTEMS.md.' }` for any oversize body or `csv`; 400 `'Invalid import'` for bad JSON/schema; validation issues → 400 `{ error: 'Invalid import', issues }`; `commit: false` → 200 `{ ok: true, codeCount, isSample }`; commit → 201 `{ codeSystemId, codeCount, isCurrent }`; `CodeSystemVersionExistsError` → 409 `'That version of this code set is already loaded'`; `SampleOverLicensedError` → 409 `'A sample code set cannot replace a licensed one'`. `sourceSha256 = sha256Hex(csv)`.
  - `PATCH /api/coding/code-systems/[id]` body `{ isCurrent: true }` (strict) — `CODE_SYSTEM_ADMIN_ROLES`; 404/409 per `setCurrentCodeSystem`.
  - Page `/coding/code-systems` (admin): list of versions per kind (Sample badge, current badge, count, imported by/at via `formatDateTimeIn`), "Make current" button, an upload form (kind, version, name, licence note, file picker read client-side as text) with "Check file" (dry run) then "Load", showing up to 200 line-numbered issues; a callout linking the CLI instructions; empty state per kind: "No <label> code set loaded. Coders cannot assign <label> codes until an administrator loads one."

- [ ] **Step 1: Write the failing tests**

```ts
// coding-code-systems.test.ts (queries mocked)
it('413s an oversize CSV and names the CLI', async () => {
  const res = await POST(jsonReq({ ...BODY, csv: 'x'.repeat(WEB_IMPORT_LIMITS.maxBytes + 1) })); expect(res.status).toBe(413); expect((await res.json()).error).toMatch(/codes:import/)
})
it('dry run never commits; commit audits through the query layer', async () => {
  expect((await POST(jsonReq({ ...BODY, commit: false }))).status).toBe(200); expect(commitCodeSystemImport).not.toHaveBeenCalled()
  expect((await POST(jsonReq({ ...BODY, commit: true }))).status).toBe(201)
})
it('returns line-numbered issues and commits nothing on a bad file', async () => { /* csv with a bad code → 400 { error: 'Invalid import', issues: [{ line: 2, column: 'code', … }] } */ })
it('maps a duplicate version to 409', async () => { vi.mocked(commitCodeSystemImport).mockRejectedValueOnce(new CodeSystemVersionExistsError()); expect((await POST(jsonReq({ ...BODY, commit: true }))).status).toBe(409) })
it('code search validates params and returns hits', async () => { expect((await GET_CODES(get('/api/coding/codes?kind=xyz&q=a'))).status).toBe(400); expect((await GET_CODES(get('/api/coding/codes?kind=icd10&q=e11'))).status).toBe(200) })
// read-capped-body.test.ts
it('stops at the cap and rejects a lying content-length', async () => { /* 11 bytes, cap 10 → too_large; content-length 'abc' → bad_length */ })
// rbac-route-gates: API_GATES rows
{ name: 'GET /api/coding/codes', call: () => settle(() => getCodes(get('/api/coding/codes'))), allowed: [...CODE_LOOKUP_ROLES] },
{ name: 'GET /api/coding/code-systems', call: () => settle(() => listCodeSystemsRoute(get('/api/coding/code-systems'))), allowed: [...CODING_ROLES] },
{ name: 'POST /api/coding/code-systems/import', call: () => settle(() => postCodeImport(send('POST', '/api/coding/code-systems/import'))), allowed: [...CODE_SYSTEM_ADMIN_ROLES] },
{ name: 'PATCH /api/coding/code-systems/[id]', call: () => settle(() => patchCodeSystem(send('PATCH', `/api/coding/code-systems/${BOGUS_ID}`), ctx({ id: BOGUS_ID }))), allowed: [...CODE_SYSTEM_ADMIN_ROLES] },
// new SP6_WRITE_GATES (deny-before-parse; add it to the describe.each list)
{ name: 'POST /api/coding/code-systems/import', call: () => postCodeImport(new NextRequest(url('/api/coding/code-systems/import'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: NOT_JSON })), allowed: CODE_SYSTEM_ADMIN_ROLES },
{ name: 'PATCH /api/coding/code-systems/[id]', call: () => patchCodeSystem(send('PATCH', `/api/coding/code-systems/${BOGUS_ID}`, NOT_JSON), ctx({ id: BOGUS_ID })), allowed: CODE_SYSTEM_ADMIN_ROLES },
// page-gates-harness: PAGE_GATES row
{ route: '/coding/code-systems', load: () => import('@/app/(dashboard)/coding/code-systems/page'), allowed: ['admin'] },
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/api/coding-code-systems.test.ts tests/lib/http` → FAIL.
- [ ] **Step 3: Implement** the helper, routes, page, components, nav entry and harness rows.
- [ ] **Step 4: Verify** — `npx vitest run tests/api/coding-code-systems.test.ts tests/lib/http tests/api/tariff-import.test.ts tests/pages/nav-role-enforcement.test.tsx`, `npm test -- tests/api/rbac-route-gates.test.ts tests/api/tariff-import-db.test.ts`, `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/http src/app/api/coding/codes src/app/api/coding/code-systems "src/app/(dashboard)/coding/code-systems" src/components/coding src/app/api/tariff/import/route.ts src/components/LeftNav.tsx tests
git commit -m "feat(sp6): code-system import/list/current routes, code search API and admin import page"
```

---

### Task 7: Encounter coding writes: diagnoses, procedures, status actions

**Files:**
- Create: `src/lib/queries/coding.ts`, `src/lib/queries/diagnoses.ts`
- Modify (hide voided rows from legacy readers via `liveDiagnosis`): `src/lib/queries/patients.ts:131,285`, `src/lib/queries/eligibility.ts:26`, `src/lib/queries/patient-portal.ts:64`, `src/lib/queries/workbook.ts:65`, `src/lib/auto-classify.ts:28`, `src/app/api/pharmacy/dispenses/[dispenseId]/charge/route.ts:45` (also skip `code = ''`), `src/lib/fhir/gather.ts:29`
- Test: `tests/lib/queries/coding.test.ts` (DB), `tests/lib/queries/diagnoses-live.test.ts` (DB)

**Interfaces:**
- Consumes: Task 3 (status machine, rules, schemas' request types, `CodingWriteResult`, `CodingWriteError`), Task 5 `getCodesByIds`, Task 4 tables, SP3 `WriteExecutor`, `istDateOf`, `todayIsoIn`, `logAudit`.
- Produces (`diagnoses.ts`): `liveDiagnosis: SQL` = `isNull(diagnoses.voidedAt)`; `withCodeValue: SQL` = `ne(diagnoses.code, '')`.
- Produces (`coding.ts`):
  - `lockEncounterCoding(tx: WriteExecutor, encounterId: number): Promise<{ coding: EncounterCodingRow; encounter: EncounterRow } | null>` — `insert … on conflict do nothing` (patientId from the encounter), then `select … for update` on `encounter_coding` joined to `encounters`.
  - `type EntryActor = 'doctor' | 'coder'` — `actorFor(role: Role): EntryActor` (`pi` → doctor; `coder`, `admin` → coder)
  - Shared write guard (internal), in order: lock (missing → `not_found`); encounter `cancelled` → `encounter_cancelled`; **doctor:** `doctorMayPropose(status)` else `locked`; **coder:** encounter `completed` else `encounter_not_completed`, status `finalised` → `locked`, a `coder` session must equal `assignedToUserId` else `not_claimed` (admin exempt); after the write `statusAfterCoderEdit` is applied, writing an `edit_after_coded` event when it moves `coded → in_progress`.
  - Code checks on every `codeId`: `getCodesByIds(tx)` miss → `code_not_found`; `checkCodeForEntry(…)` errors → `code_invalid` with `issues`; warnings are returned.
  - `addEncounterDiagnosis(encounterId: number, input: AddDiagnosisRequest, session: Session, now?: Date): Promise<CodingWriteResult<{ diagnosisId: number; warnings: CodingIssue[] }>>` — doctor: `proposed` with a code else `uncoded` (`code = ''`), `proposedByName/At`; coder: `codeId` required else `code_required`, `coded`, `codedByName/At`; `description = input.description ?? code.display`; `date = encounterDate`; `primary` while a live primary exists → `primary_exists` (also map `isUniqueViolation(err, 'diagnoses_one_primary_per_encounter')`). Audit `coding: added diagnosis`, details `encounter=<id> diagnosis=<id> status=<s> type=<t> code=<kind:code|none>`.
  - `updateEncounterDiagnosis(encounterId, diagnosisId, input: UpdateDiagnosisRequest, session, now?)` — row must be live and on this encounter (`entry_not_found`); doctor may change only `uncoded`/`proposed` rows (`locked` otherwise); a coder setting `codeId` (same or new) marks the row `coded`. `description` is never changed. Audit `coding: changed diagnosis`, details `encounter= diagnosis= from=<kind:code|none> to=<kind:code|none> type=<t>`.
  - `voidEncounterDiagnosis(encounterId, diagnosisId, session, now?)` — sets `voidedAt/ByName`; doctor only on `uncoded`/`proposed`. Audit `coding: removed diagnosis`.
  - `addEncounterProcedure` / `updateEncounterProcedure` / `voidEncounterProcedure` — same shapes and rules (`procedureId`); `performedOn > todayIsoIn(DEFAULT_TIMEZONE, now)` → `performed_in_future`; inactive/missing `performedByProviderId` → `provider_not_found`; missing `serviceId` → `service_not_found`. Audit `coding: added procedure` / `changed procedure` / `removed procedure` (same detail shapes, `procedure=<id>`).
  - `loadCodingRuleInput(executor: WriteExecutor, encounterId: number): Promise<CodingRuleInput | null>` — live rows only; `encounterEndDate = completedAt ? istDateOf(completedAt) : null`; patient `gender`, `dob` (named columns); `serviceMappedCodes` from `service_procedure_codes` (null when the service has none).
  - `applyCodingAction(encounterId: number, req: CodingStatusRequest, session: Session, now?: Date): Promise<CodingWriteResult<{ status: EncounterCodingStatus; issues: CodingIssue[] }>>` — lock; encounter must be `completed` (`encounter_not_completed`); `nextCodingStatus` null → `invalid_transition`; then per action:
    - `claim`: `session.userId` null → `no_user_account`; assigned to someone else → `already_assigned`; sets `assignedToUserId/Name/At`
    - `assign`: target user must exist with role `coder` → else `assignee_not_coder`
    - `release`: a coder may release only their own claim (`not_claimed`); clears assignment
    - `resume`: any `open` query → `open_queries`
    - `mark_coded` / `finalise`: coder must hold the claim (admin exempt); `validateEncounterCoding(await loadCodingRuleInput(tx), stage)`; blocking → `validation_failed` with `issues`; stamps `codedAt/By` or `finalisedAt/By`
    - `reopen`: `reopenCount + 1`; event `reason = req.reason`
    - every action: update `status`, `updatedAt`; insert an `encounter_coding_events` row; audit `coding: <action>`, patient id, details `encounter=<id> from=<s> to=<s>` (+ ` assignee=<userId>` for claim/assign). Never the reason.
  - `getEncounterCodingGate(encounterId: number, executor?: WriteExecutor): Promise<{ status: EncounterCodingStatus; finalised: boolean } | null>` — no row → `uncoded`; null when the encounter does not exist. **SP4/SP7 consume this (ruling 2).**

- [ ] **Step 1: Write the failing DB tests** (fixtures: TEST patient, SP3 encounter `completed` on `2099-03-01`, a TEST `icd10` code system with the sample codes, a TEST coder user; restore any real current flag)

```ts
describe.skipIf(!process.env.DATABASE_URL)('encounter coding (DB)', () => {
  it('a doctor proposes; a coder must claim before coding', async () => {
    const p = await addEncounterDiagnosis(enc.id, { codeId: U8Z0, type: 'primary' }, PI)
    expect(p.ok && (await dx(p.value.diagnosisId)).codingStatus).toBe('proposed')
    expect(await updateEncounterDiagnosis(enc.id, id(p), { codeId: U8Z0 }, CODER)).toEqual({ ok: false, error: 'not_claimed' })
    expect((await applyCodingAction(enc.id, { action: 'claim' }, CODER)).ok).toBe(true)
    expect((await updateEncounterDiagnosis(enc.id, id(p), { codeId: U8Z0 }, CODER)).ok).toBe(true)
    expect((await dx(id(p))).codingStatus).toBe('coded')
  })
  it('concurrent claims: exactly one succeeds', async () => {
    const rs = await Promise.all([applyCodingAction(enc.id, { action: 'claim' }, CODER_A), applyCodingAction(enc.id, { action: 'claim' }, CODER_B)])
    expect(rs.filter((r) => r.ok)).toHaveLength(1); expect(rs.find((r) => !r.ok)).toEqual({ ok: false, error: 'already_assigned' })
  })
  it('mark_coded blocks on errors and returns them; finalise needs a primary', async () => { /* only a secondary coded → mark_coded ok with warning primary_missing; finalise → validation_failed with issues containing primary_missing */ })
  it('refuses every entry write on a finalised encounter', async () => {
    // finalise a valid encounter, then:
    for (const r of [await addEncounterDiagnosis(enc.id, { codeId: U8Z1, type: 'secondary' }, CODER), await updateEncounterDiagnosis(enc.id, dxId, { type: 'secondary' }, ADMIN),
      await voidEncounterDiagnosis(enc.id, dxId, PI), await addEncounterProcedure(enc.id, { codeId: PCS0, performedOn: '2099-03-01' }, CODER)]) expect(r).toEqual({ ok: false, error: 'locked' })
  })
  it('an edit racing finalise never leaves a finalised encounter edited', async () => {
    const [f, e] = await Promise.all([applyCodingAction(enc.id, { action: 'finalise' }, CODER), updateEncounterDiagnosis(enc.id, secId, { codeId: U9Z0 }, CODER)])
    const gate = await getEncounterCodingGate(enc.id)
    if (gate!.finalised) expect((await dx(secId)).codeId).toBe(U8Z1); else expect(f.ok).toBe(false)
    expect(e.ok || (!e.ok && e.error === 'locked')).toBe(true)
  })
  it('a coder edit after coded reverts to in_progress with an event', async () => { /* coded → update → gate.status 'in_progress'; events include 'edit_after_coded' */ })
  it('reopen requires finalised, counts, and keeps the reason out of the audit', async () => { /* reopen → status in_progress, reopenCount 1, event.reason 'payer query'; audit_log details for this encounter never contain 'payer query' */ })
  it('rejects a PCS code as a diagnosis and a female-only code for a male patient', async () => { /* → { ok: false, error: 'code_invalid', issues: [code_system_not_allowed] } and [sex_mismatch] */ })
  it('a doctor cannot edit a coded row or propose once coded', async () => { /* → 'locked' */ })
  it('coding requires a completed encounter', async () => { /* in_consultation encounter: coder add → encounter_not_completed; doctor add → ok (uncoded free text, code '') */ })
  it('refuses a future procedure date and an unknown service', async () => { /* performedOn tomorrow IST → performed_in_future; serviceId 2147483000 → service_not_found */ })
})
// diagnoses-live.test.ts (DB)
it('voided diagnoses vanish from the chart, eligibility, portal and FHIR gather', async () => { /* void one of two rows → getPatientDetail(...).diagnoses, gatherPatientFhirData(...).diagnosisRows each have 1 row */ })
```

- [ ] **Step 2: Run to verify failure** — `npm test -- tests/lib/queries/coding.test.ts tests/lib/queries/diagnoses-live.test.ts` → FAIL.
- [ ] **Step 3: Implement** `coding.ts`, `diagnoses.ts` and the reader filters. Every write is one `getDb().transaction` that calls `lockEncounterCoding` first.
- [ ] **Step 4: Verify** — the same command, plus `npx vitest run tests/lib/fhir tests/lib/eligibility.test.ts tests/api/pharmacy-dispense-charge.test.ts tests/lib/queries/workbook.test.ts tests/pages/patient-portal-overview.test.tsx`, `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/queries/coding.ts src/lib/queries/diagnoses.ts src/lib/queries/patients.ts src/lib/queries/eligibility.ts src/lib/queries/patient-portal.ts src/lib/queries/workbook.ts src/lib/auto-classify.ts "src/app/api/pharmacy/dispenses/[dispenseId]/charge/route.ts" src/lib/fhir/gather.ts tests/lib/queries/coding.test.ts tests/lib/queries/diagnoses-live.test.ts
git commit -m "feat(sp6): encounter diagnosis/procedure coding writes and the coding status actions"
```

---

### Task 8: Doctor queries, workspace and chart loaders

**Files:**
- Create: `src/lib/queries/coding-queries.ts`, `src/lib/queries/coding-workspace.ts`
- Test: `tests/lib/queries/coding-queries.test.ts` (DB), `tests/lib/queries/coding-workspace.test.ts` (DB)

**Interfaces:**
- Consumes: Task 7 (`lockEncounterCoding`, `loadCodingRuleInput`, `applyCodingAction` semantics), Task 3 (`nextCodingStatus`, `validateEncounterCoding`, errors), `ageOnDate`, `encounterNotes`.
- Produces (`coding-queries.ts`):
  - `raiseCodingQuery(encounterId: number, input: { addressedToProviderId: number; question: string }, session: Session): Promise<CodingWriteResult<{ queryId: number }>>` — under `lockEncounterCoding`; same coder-claim rule as Task 7; provider must be active (`provider_not_found`); status via `nextCodingStatus(…, 'raise_query')`; event `raise_query`; audit `coding: raised query`, details `encounter=<id> query=<id> to=provider:<id>`.
  - `respondToCodingQuery(queryId: number, body: string, session: Session): Promise<CodingWriteResult<{ responseId: number }>>` — query `closed`/`withdrawn` → `query_closed`; inserts the response with `authorRole = session.role`; a `pi`/`admin` response on an `open` query sets `answered` + `answeredAt`; audit `coding: responded to query`, details `query=<id> encounter=<id>`.
  - `closeCodingQuery(queryId: number, action: 'close' | 'withdraw', session: Session): Promise<CodingWriteResult<{ status: CodingQueryStatus }>>` — `open`/`answered` → `closed` / `withdrawn` with `closedAt/ByName`; audit `coding: closed query` / `coding: withdrew query`.
  - `listOpenCodingQueriesForProvider(providerId: number): Promise<ProviderCodingQuery[]>`, `interface ProviderCodingQuery { queryId: number; encounterId: number; patientId: string; patientName: string; uhid: string | null; encounterDate: string; question: string; raisedByName: string; raisedAt: Date }` — status `open` only, oldest first.
- Produces (`coding-workspace.ts`):
  - `interface WorkspaceEntryCode { codeId: number | null; kind: CodeSystemKind | null; code: string; display: string | null; version: string | null; isSample: boolean }`
  - `interface WorkspaceDiagnosis extends WorkspaceEntryCode { id: number; description: string; type: DiagnosisType | null; codingStatus: CodeEntryStatus; sequence: number | null; proposedByName: string | null; codedByName: string | null }`
  - `interface WorkspaceProcedure extends WorkspaceEntryCode { id: number; description: string; codingStatus: CodeEntryStatus; performedOn: string; performedByName: string | null; serviceId: number | null; serviceName: string | null; sequence: number | null }`
  - `interface WorkspaceQuery { id: number; status: CodingQueryStatus; question: string; addressedToProviderId: number; addressedToName: string; raisedByName: string; raisedAt: Date; responses: { id: number; authorName: string; authorRole: Role; body: string; createdAt: Date }[] }`
  - `interface CodingWorkspace { patient: { id: string; name: string; uhid: string | null; gender: Gender | null; ageYears: number }; encounter: { id: number; encounterType: EncounterType; visitType: EncounterVisitType; status: EncounterStatus; encounterDate: string; completedAt: Date | null; departmentName: string | null; providerId: number; providerName: string; admissionId: number | null }; coding: { status: EncounterCodingStatus; assignedToUserId: number | null; assignedToName: string | null; codedByName: string | null; codedAt: Date | null; finalisedByName: string | null; finalisedAt: Date | null; reopenCount: number }; diagnoses: WorkspaceDiagnosis[]; procedures: WorkspaceProcedure[]; notes: { id: number; noteType: string; authorName: string; signedAt: Date | null; subjective: string | null; objective: string | null; assessment: string | null; plan: string | null }[]; queries: WorkspaceQuery[]; events: { action: CodingEventAction; fromStatus: EncounterCodingStatus; toStatus: EncounterCodingStatus; byName: string; at: Date; reason: string | null }[]; issues: CodingIssue[] }`
  - `getCodingWorkspace(encounterId: number): Promise<CodingWorkspace | null>` — patient by **named columns** `id, name, uhid, gender, dob` (dob used only for `ageYears = ageOnDate(dob, encounterDate)` and never returned); notes = `encounter_notes` with `status = 'signed'` matching the encounter's `appointmentId` or `admissionId` (none when both null); diagnoses ordered primary first, then `sequence`, `id`; `issues = validateEncounterCoding(…, 'finalise')`.
  - `interface ChartEncounterCoding { encounterId: number; encounterDate: string; encounterType: EncounterType; encounterStatus: EncounterStatus; providerName: string; codingStatus: EncounterCodingStatus; diagnoses: WorkspaceDiagnosis[]; procedures: WorkspaceProcedure[]; openQueries: WorkspaceQuery[] }`
  - `listEncounterCodingForPatient(patientId: string, limit = 10): Promise<ChartEncounterCoding[]>` — non-cancelled encounters, newest first; `openQueries` = status `open` or `answered`.

- [ ] **Step 1: Write the failing DB tests**

```ts
it('raising a query moves the encounter to queried; resume waits for open queries', async () => {
  const q = await raiseCodingQuery(enc.id, { addressedToProviderId: doc.id, question: 'Laterality?' }, CODER)
  expect((await getEncounterCodingGate(enc.id))!.status).toBe('queried')
  expect(await applyCodingAction(enc.id, { action: 'resume' }, CODER)).toEqual({ ok: false, error: 'open_queries' })
  await respondToCodingQuery(qid(q), 'Left', PI); expect((await query(qid(q))).status).toBe('answered')
  expect((await applyCodingAction(enc.id, { action: 'resume' }, CODER)).ok).toBe(true)
})
it('a closed query refuses replies; audit details never carry question or reply text', async () => { /* close → respond → query_closed; audit rows for the encounter: none contains 'Laterality' or 'Left' */ })
it('lists open queries for the addressed doctor only', async () => { /* other provider gets [] */ })
it('workspace patient header carries only id, name, uhid, gender, ageYears', async () => {
  const w = await getCodingWorkspace(enc.id); expect(Object.keys(w!.patient).sort()).toEqual(['ageYears', 'gender', 'id', 'name', 'uhid'])
  expect(JSON.stringify(w)).not.toMatch(/"(dob|phone|email|addressLine1|pinCode|abhaNumber)"/)
})
it('workspace shows only signed notes of this visit', async () => { /* a draft note and a signed note on another appointment are absent; the signed note on enc.appointmentId is present */ })
it('chart loader lists non-cancelled encounters newest first with live entries only', async () => { /* voided row absent; cancelled encounter absent */ })
```

- [ ] **Step 2: Run to verify failure** — `npm test -- tests/lib/queries/coding-queries.test.ts tests/lib/queries/coding-workspace.test.ts` → FAIL.
- [ ] **Step 3: Implement** both modules.
- [ ] **Step 4: Verify** — same command, `npx vitest run tests/lib/no-credential-leak.test.ts tests/lib/no-aadhaar-leak.test.ts`, `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/queries/coding-queries.ts src/lib/queries/coding-workspace.ts tests/lib/queries/coding-queries.test.ts tests/lib/queries/coding-workspace.test.ts
git commit -m "feat(sp6): coding queries to doctors with a response log; workspace and chart loaders"
```

---

### Task 9: Coding API routes + RBAC rows

**Files:**
- Create: `src/lib/coding/route-responses.ts`; routes `src/app/api/coding/encounters/[id]/diagnoses/route.ts` (POST), `…/diagnoses/[diagnosisId]/route.ts` (PATCH, DELETE), `…/procedures/route.ts` (POST), `…/procedures/[procedureId]/route.ts` (PATCH, DELETE), `…/status/route.ts` (POST), `…/queries/route.ts` (POST), `src/app/api/coding/queries/[queryId]/route.ts` (PATCH), `src/app/api/coding/queries/[queryId]/responses/route.ts` (POST)
- Modify: `tests/api/rbac-route-gates.test.ts`, `tests/lib/no-aadhaar-leak.test.ts` (`EXPORT_PATHS` += `'src/lib/coding'`, `'src/app/api/coding'`, `'src/lib/queries/coding.ts'`, `'src/lib/queries/coding-workspace.ts'`, `'src/lib/queries/coding-queries.ts'`; the walker throws on a missing path, so Task 10 adds `'src/lib/queries/coding-worklist.ts'` when it creates that file)
- Test: `tests/api/coding-routes.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 7, 8; `readJsonBody`, `errorResponse` (SP3); `parseId`, `invalid`, `isRetryableConflict`, `RETRY_MESSAGE` (tariff).
- Produces:
  - `codingErrorResponse(error: CodingWriteError, issues?: CodingIssue[]): NextResponse` — status `CODING_ERROR_STATUS[error]`, body `{ error: CODING_ERROR_MESSAGE[error], ...(issues ? { issues } : {}) }`
  - `codingServerError(tag: string, err: unknown): NextResponse` — retryable → 409 `RETRY_MESSAGE`; else logs `[coding] <tag> failed (code …, constraint …)` and 500 `'Could not save the coding change'`
  - Gates (inline, before parse): diagnoses/procedures POST/PATCH/DELETE → `CODING_ENTRY_ROLES`; status POST → `CODING_ROLES`, then after parse `CODING_ACTION_ROLES[req.action].includes(session.role)` else plain 403; queries POST → `CODING_ROLES`; query PATCH → `CODING_ROLES`; responses POST → `CODING_QUERY_RESPOND_ROLES`.
  - Responses: add → 201 `{ id, warnings }`; update/void → 200; status → 200 `{ status, issues }`; bad path id → 400 `'Invalid id'`; zod failure → `invalid(err, 'Invalid coding request')`.

- [ ] **Step 1: Write the failing tests**

```ts
// coding-routes.test.ts (query modules mocked)
it('a pi cannot run a status action; a coder cannot assign', async () => {
  as('pi'); expect((await postStatus(req({ action: 'claim' }), ctx(7))).status).toBe(403)
  as('coder'); const r = await postStatus(req({ action: 'assign', assigneeUserId: 3 }), ctx(7)); expect(r.status).toBe(403); expect(applyCodingAction).not.toHaveBeenCalled()
})
it('maps write errors to status and message, with issues for 422', async () => {
  vi.mocked(applyCodingAction).mockResolvedValueOnce({ ok: false, error: 'validation_failed', issues: [ISSUE] })
  const r = await postStatus(req({ action: 'finalise' }), ctx(7)); expect(r.status).toBe(422); expect(await r.json()).toEqual({ error: CODING_ERROR_MESSAGE.validation_failed, issues: [ISSUE] })
  vi.mocked(addEncounterDiagnosis).mockResolvedValueOnce({ ok: false, error: 'locked' }); expect((await postDx(req({ type: 'primary', codeId: 1 }), ctx(7))).status).toBe(409)
})
it('bad JSON is a 400, unknown keys are a 400, a bad id is a 400', async () => { /* '{not json' → 400 Invalid JSON; { type: 'primary', codeId: 1, codingStatus: 'coded' } → 400; id 'abc' → 400 */ })
it('a deadlock is a retryable 409', async () => { vi.mocked(addEncounterDiagnosis).mockRejectedValueOnce(Object.assign(new Error(), { code: '40P01' })); expect((await postDx(req(OK), ctx(7))).status).toBe(409) })
// rbac-route-gates: API_GATES rows (add a `del` helper: new NextRequest(url(p), { method: 'DELETE' }))
{ name: 'POST /api/coding/encounters/[id]/diagnoses', allowed: [...CODING_ENTRY_ROLES], call: … },
{ name: 'PATCH /api/coding/encounters/[id]/diagnoses/[diagnosisId]', allowed: [...CODING_ENTRY_ROLES], call: … },
{ name: 'DELETE /api/coding/encounters/[id]/diagnoses/[diagnosisId]', allowed: [...CODING_ENTRY_ROLES], call: … },
// …the same three for procedures; status, queries POST, query PATCH → CODING_ROLES; responses POST → CODING_QUERY_RESPOND_ROLES
// SP6_WRITE_GATES: every POST/PATCH above with NOT_JSON (allowed role → 400, denied → 403 { error: 'Forbidden' })
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/api/coding-routes.test.ts` → FAIL.
- [ ] **Step 3: Implement** the helper and routes (each reads `params` with `await`).
- [ ] **Step 4: Verify** — `npx vitest run tests/api/coding-routes.test.ts tests/lib/no-aadhaar-leak.test.ts`, `npm test -- tests/api/rbac-route-gates.test.ts`, `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/coding/route-responses.ts src/app/api/coding/encounters src/app/api/coding/queries tests/api/coding-routes.test.ts tests/api/rbac-route-gates.test.ts tests/lib/no-aadhaar-leak.test.ts
git commit -m "feat(sp6): coding entry, status and query routes with RBAC and deny-before-parse rows"
```

---

### Task 10: Worklist and productivity/backlog queries

**Files:**
- Create: `src/lib/coding/worklist.ts`, `src/lib/queries/coding-worklist.ts`
- Modify: `tests/lib/no-aadhaar-leak.test.ts` (`EXPORT_PATHS` += `'src/lib/queries/coding-worklist.ts'`)
- Test: `tests/lib/coding/worklist.test.ts`, `tests/lib/queries/coding-worklist.test.ts` (DB)

**Interfaces:**
- Consumes: Task 3 statuses/labels; `istDateOf`, `startOfIstDay`, `todayIsoIn`; SP3 `ENCOUNTER_TYPES`.
- Produces (`worklist.ts`, pure):
  - `WORKLIST_STATUS_FILTERS = ['pending', 'uncoded', 'in_progress', 'queried', 'coded', 'finalised'] as const` (`pending` = not finalised); `WORKLIST_ASSIGNEE_FILTERS = ['all', 'mine', 'unassigned'] as const`; `WORKLIST_PAGE_SIZE = 50`
  - `interface CodingWorklistFilters { status: …; assignee: …; encounterType: 'opd' | 'ipd' | null; departmentId: number | null; fromDate: string | null; toDate: string | null; page: number }`
  - `parseCodingWorklistParams(sp: Record<string, string | string[] | undefined>): CodingWorklistFilters` — unknown values fall back to `pending` / `all` / null / page 1; dates must be real ISO dates; a reversed range is swapped
  - `BACKLOG_AGE_BUCKETS = ['0-2', '3-7', '8-30', '31+'] as const`; `backlogAgeBucket(completedIstDate: string, todayIso: string): BacklogAgeBucket` (days elapsed, inclusive lower bounds)
- Produces (`coding-worklist.ts`):
  - `interface CodingWorklistRow { encounterId: number; encounterType: EncounterType; encounterDate: string; completedAt: Date; completedIstDate: string; patientId: string; patientName: string; uhid: string | null; departmentName: string | null; providerName: string; codingStatus: EncounterCodingStatus; assignedToName: string | null; assignedToUserId: number | null; uncodedCount: number; proposedCount: number; openQueryCount: number; ageBucket: BacklogAgeBucket }`
  - `listCodingWorklist(filters: CodingWorklistFilters, session: Session, now?: Date): Promise<{ rows: CodingWorklistRow[]; total: number; counts: Record<EncounterCodingStatus, number> }>` — encounters with `status = 'completed'` and `encounter_type IN ('opd','ipd')`, `LEFT JOIN encounter_coding` (missing = `uncoded`); `mine` = `assigned_to_user_id = session.userId`; date filters on the IST date of `completedAt` (`>= startOfIstDay(from)`, `< startOfIstDay(to + 1 day)`); oldest `completedAt` first; counts ignore the status filter; one query for rows + one for counts (no N+1).
  - `interface CodingProductivity { from: string; to: string; perCoder: { name: string; claimed: number; coded: number; finalised: number; queriesRaised: number; reopened: number; medianHoursToFinalise: number | null }[]; backlog: { byStatus: Record<EncounterCodingStatus, number>; byAge: Record<BacklogAgeBucket, number>; oldestCompletedDate: string | null } }`
  - `getCodingProductivity(range: { from: string; to: string }, now?: Date): Promise<CodingProductivity>` — per-coder counts from `encounter_coding_events` (`byName`, `at` within the IST range) and median hours from the encounter's `completedAt` to its `finalise` event; backlog over all non-finalised completed encounters.

- [ ] **Step 1: Write the failing tests**

```ts
// worklist.test.ts
it('defaults and sanitises params', () => {
  expect(parseCodingWorklistParams({ status: 'bogus', page: '-3' })).toMatchObject({ status: 'pending', assignee: 'all', page: 1 })
  expect(parseCodingWorklistParams({ from: '2026-10-09', to: '2026-10-01' })).toMatchObject({ fromDate: '2026-10-01', toDate: '2026-10-09' })
  expect(parseCodingWorklistParams({ from: '2026-02-30' }).fromDate).toBeNull()
})
it.each([['2026-10-07', '0-2'], ['2026-10-04', '3-7'], ['2026-09-30', '8-30'], ['2026-09-08', '31+']])('completed %s is %s on 2026-10-09', (d, b) => { expect(backlogAgeBucket(d, '2026-10-09')).toBe(b) })
// coding-worklist.test.ts (DB, encounters completed in 2099)
it('lists completed encounters awaiting coding, oldest first, with counts', async () => { /* two completed + one in_consultation + one finalised → pending rows = the two, oldest first; counts.finalised = 1 */ })
it('worklist rows carry no contact fields', async () => { const { rows } = await listCodingWorklist(F, CODER, NOW); expect(Object.keys(rows[0])).not.toEqual(expect.arrayContaining(['phone'])); expect(JSON.stringify(rows)).not.toMatch(/"(phone|email|dob)"/) })
it('mine and unassigned filter by the claim', async () => { /* … */ })
it('a 00:30 IST completion counts on that IST day for date filters', async () => { /* completedAt 2099-03-04T19:00Z → fromDate=toDate='2099-03-05' includes it */ })
it('productivity counts events per coder and the median time to finalise', async () => { /* claim+mark_coded+finalise for CODER_A → perCoder A finalised 1, medianHoursToFinalise ≈ known value */ })
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/lib/coding/worklist.test.ts`, `npm test -- tests/lib/queries/coding-worklist.test.ts` → FAIL.
- [ ] **Step 3: Implement** both modules.
- [ ] **Step 4: Verify** — same commands, `npx vitest run tests/lib/no-aadhaar-leak.test.ts`, `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/coding/worklist.ts src/lib/queries/coding-worklist.ts tests/lib/coding/worklist.test.ts tests/lib/queries/coding-worklist.test.ts tests/lib/no-aadhaar-leak.test.ts
git commit -m "feat(sp6): coding worklist and productivity/backlog queries"
```

---

### Task 11: Coding worklist page, report page, nav, coder home

**Files:**
- Create: `src/app/(dashboard)/coding/page.tsx`, `src/app/(dashboard)/coding/report/page.tsx`, `src/components/coding/CodingWorklist.tsx`, `src/components/coding/ClaimButton.tsx`, `src/components/coding/CodingStatusBadge.tsx`, `src/components/coding/codingApi.ts` (client fetch helpers for every SP6 route; returns `{ ok: true, data } | { ok: false, error: string, issues?: CodingIssue[] }`)
- Modify: `src/components/LeftNav.tsx` (`NAV_ITEMS` after Labs: `{ href: '/coding', label: 'Coding', icon: FileCode2, roles: ['admin', 'coder'] }`), `src/app/(dashboard)/page.tsx` (`if (session.role === 'coder') redirect('/coding')`, beside the labs redirect), `tests/pages/page-gates-harness.ts`, `tests/pages/dashboard-routing.test.tsx`, `tests/components/LeftNav.test.tsx`
- Test: `tests/pages/coding-worklist-page.test.tsx`

**Interfaces:**
- Consumes: Task 10 (`parseCodingWorklistParams`, `listCodingWorklist`, `getCodingProductivity`), Task 3 `CODING_STATUS_LABEL`, Task 9 status route, `formatIsoDate`, `formatDateTimeIn`.
- Produces:
  - `/coding` (`CODING_ROLES`): status tabs with counts (`CODING_STATUS_LABEL` + "All pending"), assignee filter, OPD/IPD, department, completed-date range (GET form), table: UHID, patient name, visit type/date, completed (IST), department, doctor, status badge, assignee, "N uncoded · N proposed · N queries", age bucket; row link to `/coding/encounters/<id>`; `ClaimButton` (POST `{ action: 'claim' }`, then `router.refresh()`; shows the 409 message). Pagination "Showing 1–50 of N". Links to `/coding/report` and `/coding/service-codes`. Empty state: "Nothing is waiting for coding." Audit: none (no per-patient view) — the page is a list.
  - `/coding/report` (`CODING_ROLES`): `from`/`to` (default: first of the current IST month → today IST), per-coder table, backlog by status and age; audit `coding: viewed productivity report` (patient null).
  - `CodingStatusBadge({ status }: { status: EncounterCodingStatus })`.

- [ ] **Step 1: Write the failing tests**

```ts
// page-gates-harness: PAGE_GATES rows
{ route: '/coding', load: () => import('@/app/(dashboard)/coding/page'), props: { searchParams: Promise.resolve({}) }, allowed: ['admin', 'coder'] },
{ route: '/coding/report', load: () => import('@/app/(dashboard)/coding/report/page'), props: { searchParams: Promise.resolve({}) }, allowed: ['admin', 'coder'] },
// dashboard-routing.test.tsx
it('redirects a coder session to /coding', async () => { /* … expect(mockRedirect).toHaveBeenCalledWith('/coding') */ })
// LeftNav.test.tsx
it('shows Coding to coder and admin only, and nothing clinical to a coder', () => {
  render(<LeftNav role="coder" />); expect(screen.getByRole('link', { name: /^coding$/i })).toBeInTheDocument()
  expect(screen.queryByRole('link', { name: /patients/i })).not.toBeInTheDocument(); expect(screen.queryByRole('link', { name: /code systems/i })).not.toBeInTheDocument()
})
// coding-worklist-page.test.tsx (queries mocked)
it('renders rows with status labels and a claim button for unassigned rows', async () => { /* expect 'Not started', UHID, 'Claim' */ })
it('shows the empty state', async () => { /* rows [] → 'Nothing is waiting for coding.' */ })
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/pages/coding-worklist-page.test.tsx tests/pages/dashboard-routing.test.tsx tests/components/LeftNav.test.tsx` → FAIL.
- [ ] **Step 3: Implement** pages, components, nav entry, home redirect, harness rows.
- [ ] **Step 4: Verify** — same, plus `npx vitest run tests/pages/nav-role-enforcement.test.tsx`, `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/coding/page.tsx" "src/app/(dashboard)/coding/report" src/components/coding src/components/LeftNav.tsx "src/app/(dashboard)/page.tsx" tests/pages tests/components/LeftNav.test.tsx
git commit -m "feat(sp6): coding worklist and productivity report pages, Coding nav and coder home"
```

---

### Task 12: Coding workspace page

**Files:**
- Create: `src/app/(dashboard)/coding/encounters/[id]/page.tsx`, `src/components/coding/CodingWorkspaceView.tsx`, `src/components/coding/CodePicker.tsx`, `src/components/coding/EntryEditor.tsx` (diagnoses and procedures, `kind: 'diagnosis' | 'procedure'` prop), `src/components/coding/CodingIssuesPanel.tsx`, `src/components/coding/CodingQueriesPanel.tsx`, `src/components/coding/CodingActions.tsx`
- Modify: `tests/pages/page-gates-harness.ts`
- Test: `tests/pages/coding-workspace-page.test.tsx`, `tests/components/coding/CodePicker.test.tsx`

**Interfaces:**
- Consumes: Task 8 `getCodingWorkspace`, Task 9 routes via `codingApi.ts`, Task 6 `GET /api/coding/codes`, Task 3 (`nextCodingStatus`, `CODING_ACTION_ROLES`, `DIAGNOSIS_CODE_KINDS`, `PROCEDURE_CODE_KINDS`), `listAllProviders` (query addressee select), `formatIsoDate` / `formatDateTimeIn`.
- Produces:
  - Page `/coding/encounters/[id]` (`CODING_ROLES`): bad id → `notFound()`; missing → `notFound()`; audit `coding: viewed coding workspace` with the patient id and details `encounter=<id>`.
  - Layout: header (name, UHID, sex, age in years, visit type/date, department, doctor, `CodingStatusBadge`, assignee); `CodingActions` shows only buttons for which `nextCodingStatus(status, action)` is non-null and the role is in `CODING_ACTION_ROLES` (reopen opens a reason dialog, assign shows a coder select for admin); "Clinical notes (read-only, signed)" section rendering note text as plain text with no edit control; `EntryEditor` lists entries with status chips (`Uncoded` / `Proposed by <name>` / `Coded`), "Accept" on a proposal (PATCH with the same `codeId`), edit, remove; `CodePicker` (debounced 250 ms, `kind` select limited to the entry's allowed kinds, shows "Sample" for sample hits, "No <label> code set loaded" when `codeSystem` is null, keyboard-accessible listbox); `CodingIssuesPanel` (errors first, then warnings, linked to their entries); `CodingQueriesPanel` (raise to a doctor, thread of responses, close/withdraw); history of events (reason shown to the coding roles only — this page is already coding-only).
  - The page is read-only (no editors, no action buttons) when status is `finalised`, apart from "Reopen".
  - `CodePicker({ kinds, onDate, onPick }: { kinds: readonly CodeSystemKind[]; onDate: string; onPick: (hit: CodeSearchHit) => void })`.

- [ ] **Step 1: Write the failing tests**

```ts
// PAGE_GATES row
{ route: '/coding/encounters/[id]', load: () => import('@/app/(dashboard)/coding/encounters/[id]/page'), props: { params: Promise.resolve({ id: '1' }) }, allowed: ['admin', 'coder'] },
// coding-workspace-page.test.tsx (getCodingWorkspace mocked)
it('shows notes read-only with no edit control', async () => { /* note text present; no textbox/button inside the notes region */ })
it('finalised shows only Reopen', async () => { /* status finalised → buttons: ['Reopen'] */ })
it('in_progress offers Mark coded and Raise query; a coder never sees Assign', async () => { /* … */ })
it('renders no dob, phone or address', async () => { /* container text lacks the fixture's dob/phone values (the fixture deliberately omits them from the payload type) */ })
// CodePicker.test.tsx (fetch mocked)
it('searches after typing and picks with Enter', async () => { /* type 'e11' → one fetch to /api/coding/codes?kind=icd10&q=e11&on=… → ArrowDown, Enter → onPick(hit) */ })
it('says when no code set is loaded', async () => { /* { codeSystem: null, hits: [] } → 'No ICD-10 code set loaded' */ })
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/pages/coding-workspace-page.test.tsx tests/components/coding` → FAIL.
- [ ] **Step 3: Implement** the page and components.
- [ ] **Step 4: Verify** — same, plus `npx vitest run tests/pages/nav-role-enforcement.test.tsx`, `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/coding/encounters" src/components/coding tests/pages tests/components/coding
git commit -m "feat(sp6): coding workspace with code picker, checks, doctor queries and status actions"
```

---

### Task 13: Doctor proposals and query replies on the chart

**Files:**
- Create: `src/components/coding/EncounterCodingPanel.tsx`, `src/components/coding/DoctorCodingQueries.tsx`
- Modify: `src/app/(dashboard)/patients/[anonId]/medical-record/page.tsx` (new "Visit coding" section after "Diagnoses"; legacy rows in "Diagnoses" with `encounterId === null` get an `Uncoded (legacy)` chip and their code is shown as "unverified"), `src/app/(dashboard)/doctor/page.tsx` ("Coding queries for you" card from `listOpenCodingQueriesForProvider(provider.id)`)
- Test: `tests/components/coding/EncounterCodingPanel.test.tsx`, `tests/pages/doctor.test.tsx` (append), `tests/pages/pi-chart-access.test.tsx` (append)

**Interfaces:**
- Consumes: Task 8 (`listEncounterCodingForPatient`, `listOpenCodingQueriesForProvider`), Task 9 routes via `codingApi.ts`, Task 12 `CodePicker`, Task 3 `doctorMayPropose`, `CODE_PROPOSE_ROLES`, `CODING_QUERY_RESPOND_ROLES`.
- Produces:
  - `EncounterCodingPanel({ patientId, encounters, canPropose, canRespond }: { patientId: string; encounters: ChartEncounterCoding[]; canPropose: boolean; canRespond: boolean })` — per encounter: date/type/doctor, `CodingStatusBadge`, diagnoses and procedures with status chips; when `canPropose && doctorMayPropose(codingStatus)`: "Propose diagnosis" (CodePicker over `DIAGNOSIS_CODE_KINDS` or free-text description + type) and "Add procedure"; otherwise the text "Coding is closed for this visit; send changes through a coding query reply." Open queries with a reply box when `canRespond`.
  - medical-record page: `canPropose = CODE_PROPOSE_ROLES.includes(session.role)`, `canRespond = CODING_QUERY_RESPOND_ROLES.includes(session.role)`; crc sees the panel read-only. The page gate is unchanged (`CLINICAL_ROLES`).
  - `DoctorCodingQueries({ queries }: { queries: ProviderCodingQuery[] })` — each links to `/patients/<patientId>/medical-record#visit-coding`; empty → card hidden.

- [ ] **Step 1: Write the failing tests**

```ts
it('a pi can propose on an in-progress visit but not on a coded one', () => {
  render(<EncounterCodingPanel patientId="RD-0001" encounters={[enc('in_progress'), enc('coded')]} canPropose canRespond />)
  expect(screen.getAllByRole('button', { name: /propose diagnosis/i })).toHaveLength(1); expect(screen.getByText(/coding is closed for this visit/i)).toBeInTheDocument()
})
it('crc sees the panel read-only', () => { /* canPropose false, canRespond false → no propose or reply controls */ })
it('posts a reply to the query route', async () => { /* type, submit → fetch('/api/coding/queries/5/responses', POST { body }) */ })
// doctor.test.tsx (append)
it('lists open coding queries addressed to the signed-in doctor', async () => { /* mocked listOpenCodingQueriesForProvider → 'Coding queries for you' + question text */ })
// pi-chart-access.test.tsx (append)
it('labels legacy free-text diagnoses as uncoded', async () => { /* encounterId null row → 'Uncoded (legacy)' */ })
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/components/coding/EncounterCodingPanel.test.tsx tests/pages/doctor.test.tsx tests/pages/pi-chart-access.test.tsx` → FAIL.
- [ ] **Step 3: Implement** the components and page edits.
- [ ] **Step 4: Verify** — same, plus `npx vitest run tests/pages/patients-frontdesk-view.test.tsx`, `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/components/coding "src/app/(dashboard)/patients/[anonId]/medical-record/page.tsx" "src/app/(dashboard)/doctor/page.tsx" tests/components/coding tests/pages/doctor.test.tsx tests/pages/pi-chart-access.test.tsx
git commit -m "feat(sp6): doctors propose codes and answer coding queries on the chart"
```

---

### Task 14: Service ↔ procedure-code map (SP4 hook)

**Files:**
- Create: `src/lib/coding/service-codes.ts`, `src/lib/queries/service-procedure-codes.ts`, `src/app/api/coding/services/[serviceId]/procedure-codes/route.ts` (GET, PUT), `src/app/(dashboard)/coding/service-codes/page.tsx`, `src/components/coding/ServiceCodeEditor.tsx`
- Modify: `tests/api/rbac-route-gates.test.ts`, `tests/pages/page-gates-harness.ts`
- Test: `tests/lib/coding/service-codes.test.ts`, `tests/lib/queries/service-procedure-codes.test.ts` (DB), `tests/api/coding-service-codes.test.ts`

**Interfaces:**
- Consumes: Task 5 `findCurrentCode`, Task 3 `serviceCodesSchema`, SP2 `serviceCatalog`, `type ServiceCategory`.
- Produces (`service-codes.ts`, pure):
  - `SERVICE_CODE_KINDS_BY_CATEGORY: Partial<Record<ServiceCategory, readonly CodeSystemKind[]>>` = `{ procedure: ['icd10pcs', 'snomed', 'hbp'], package: ['hbp'], investigation_lab: ['loinc'], investigation_imaging: ['snomed', 'icd10pcs'] }`
  - `serviceCodeProblems(category: ServiceCategory, codes: { kind: CodeSystemKind; code: string }[]): string[]` — `'This kind of service cannot carry procedure codes'` for an unmapped category; `'<label> codes do not fit a <category> service'` per bad kind
  - `chargeProcedureCodeProblems(mapped: { kind: CodeSystemKind; code: string }[], requested: { kind: CodeSystemKind; code: string }[]): string[]` — **for SP4**: empty `mapped` → `[]` (unmapped services are unconstrained, ruling 15); else one `'<code> is not a procedure code mapped to this service'` per requested code not in `mapped`
- Produces (query):
  - `listServiceProcedureCodes(serviceIds: number[]): Promise<Map<number, ServiceProcedureCodeRow[]>>`
  - `replaceServiceProcedureCodes(serviceId: number, codes: { kind: CodeSystemKind; code: string; isPrimary: boolean }[], session: Session): Promise<{ ok: true } | { ok: false; error: 'service_not_found' | 'incompatible' | 'code_not_found'; problems?: string[] }>` — one transaction, `select … for update` on the service; `serviceCodeProblems` → `incompatible`; each code must be active in the **current** version of its kind (`findCurrentCode`) → `code_not_found` naming the code; delete + insert; audit `coding: replaced service procedure codes`, patient null, details `service=<id> codes=<n>`.
- Produces (route): GET → `CODE_LOOKUP_ROLES`, 200 `{ codes }`; PUT → `CODING_ROLES`, body `serviceCodesSchema`; 404 / 400 `{ error, problems }`.
- Page `/coding/service-codes` (`CODING_ROLES`): services whose category is a key of `SERVICE_CODE_KINDS_BY_CATEGORY`, searchable by code/name, each with its mapped codes and an editor (CodePicker limited to the category's kinds, primary radio).

- [ ] **Step 1: Write the failing tests**

```ts
it('a package takes only HBP codes; a consultation takes none', () => {
  expect(serviceCodeProblems('package', [{ kind: 'icd10pcs', code: 'ZZ00000' }])).toEqual(['ICD-10-PCS codes do not fit a package service'])
  expect(serviceCodeProblems('consultation', [{ kind: 'hbp', code: 'SMP001A' }])).toEqual(['This kind of service cannot carry procedure codes'])
})
it('SP4 check: unmapped services are unconstrained; mapped ones must match', () => {
  expect(chargeProcedureCodeProblems([], [{ kind: 'hbp', code: 'X1' }])).toEqual([])
  expect(chargeProcedureCodeProblems([{ kind: 'hbp', code: 'SMP001A' }], [{ kind: 'hbp', code: 'SMP002A' }])).toEqual(['SMP002A is not a procedure code mapped to this service'])
})
// DB
it('replaces the map atomically and refuses unknown codes', async () => { /* TEST package service + current TEST hbp version; replace [SMP001A primary] ok; replace [SMP999Z] → code_not_found and the old row still there */ })
// rbac-route-gates rows
{ name: 'GET /api/coding/services/[serviceId]/procedure-codes', allowed: [...CODE_LOOKUP_ROLES], call: … },
{ name: 'PUT /api/coding/services/[serviceId]/procedure-codes', allowed: [...CODING_ROLES], call: … },   // + SP6_WRITE_GATES row with NOT_JSON
// PAGE_GATES
{ route: '/coding/service-codes', load: () => import('@/app/(dashboard)/coding/service-codes/page'), props: { searchParams: Promise.resolve({}) }, allowed: ['admin', 'coder'] },
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/lib/coding/service-codes.test.ts tests/api/coding-service-codes.test.ts`, `npm test -- tests/lib/queries/service-procedure-codes.test.ts` → FAIL.
- [ ] **Step 3: Implement** all files.
- [ ] **Step 4: Verify** — same, plus `npm test -- tests/api/rbac-route-gates.test.ts`, `npx vitest run tests/pages/nav-role-enforcement.test.tsx`, `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/coding/service-codes.ts src/lib/queries/service-procedure-codes.ts src/app/api/coding/services "src/app/(dashboard)/coding/service-codes" src/components/coding tests
git commit -m "feat(sp6): service to procedure-code map with the SP4 charge-code check"
```

---

### Task 15: FHIR Condition / Procedure / Encounter / Observation codings

**Files:**
- Create: `src/lib/fhir/procedure.ts`, `src/lib/fhir/encounter.ts`, `src/app/api/patients/[anonId]/fhir/Procedure/route.ts`, `src/app/api/patients/[anonId]/fhir/Encounter/route.ts`
- Modify: `src/lib/fhir/types.ts` (`FhirCoding` + `version?: string`), `src/lib/fhir/condition.ts` (replace the "system deliberately omitted" comment with the ruling), `src/lib/fhir/observation.ts`, `src/lib/fhir/gather.ts`, `src/lib/fhir/bundle.ts`, `src/lib/fhir/ccda.ts` (type only), `src/app/api/patients/[anonId]/fhir/{Condition,Observation}/route.ts`, `tests/api/rbac-route-gates.test.ts` (two `fhir('Procedure', …)`, `fhir('Encounter', …)` rows)
- Test: `tests/lib/fhir/condition-mapping.test.ts`, `tests/lib/fhir/observation-mapping.test.ts`, `tests/lib/fhir/procedure-mapping.test.ts`, `tests/lib/fhir/encounter-mapping.test.ts`, `tests/lib/fhir/gather.test.ts`, `tests/api/fhir-export-routes.test.ts`, `tests/lib/fhir/no-aadhaar-bundle.test.ts`

**Interfaces:**
- Consumes: Task 2 `fhirSystemFor`, `CodeBinding`; Task 5 `findLoadedCodes`; Task 7 `liveDiagnosis`; Task 4 tables.
- Produces:
  - `gather.ts`: `type DiagnosisFhirRow = DiagnosisRow & { binding: CodeBinding | null }`; `type ProcedureFhirRow = EncounterProcedureRow & { binding: CodeBinding | null; performedByName: string | null }`; `type EncounterFhirRow = EncounterRow & { providerName: string; diagnosisRanks: { diagnosisId: number; rank: number }[] }` (rank 1 = primary, then by `sequence`, `id`); `PatientFhirData` gains `procedureRows`, `encounterRows`, `loincBindings: Map<string, CodeBinding>`; `diagnosisRows` becomes `DiagnosisFhirRow[]` (live only, joined to `codes`/`code_systems` when `codeId` is set). `binding` is built only from the joined code system (`kind`, `version`, `isSample`).
  - `codingFor(code: string, display: string | null, binding: CodeBinding | null): FhirCoding[] | undefined` (in `condition.ts`, exported) — `undefined` when `code === ''`; otherwise one coding `{ code, display }` plus `system` and `version` only when `binding && fhirSystemFor(binding)`.
  - `conditionToFhir(row: DiagnosisFhirRow): FhirCondition` — adds `category` (`http://terminology.hl7.org/CodeSystem/condition-category`: `encounter-diagnosis` when `encounterId` is set, else `problem-list-item`), `encounter: { reference: 'Encounter/encounter-<id>' }` when linked, `verificationStatus` (`http://terminology.hl7.org/CodeSystem/condition-ver-status`: `provisional` for type provisional, `confirmed` for primary/secondary, omitted for legacy), `code: { text: description, coding: codingFor(code, codeDisplay ?? description, binding) }`.
  - `procedureToFhir(row: ProcedureFhirRow): FhirProcedure` = `{ resourceType: 'Procedure', id: 'procedure-<id>', status: 'completed', subject, encounter: { reference: 'Encounter/encounter-<encounterId>' }, code: { text: description, coding: codingFor(code ?? '', codeDisplay, binding) }, performedDateTime: performedOn, performer?: [{ actor: { display: performedByName } }] }`; `proceduresToFhir`.
  - `encounterToFhir(row: EncounterFhirRow): FhirEncounter` = `{ resourceType: 'Encounter', id: 'encounter-<id>', status, class, subject, period: { start: checkedInAt ISO, end?: completedAt ISO }, participant: [{ individual: { display: providerName } }], diagnosis: [{ condition: { reference: 'Condition/condition-<diagnosisId>' }, rank }] }`; status map `checked_in→arrived`, `in_consultation→in-progress`, `completed→finished`, `cancelled→cancelled`; class `{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: ipd ? 'IMP' : 'AMB' }`; `encountersToFhir`.
  - `observationToFhir(patientId, order, loinc: CodeBinding | null = null)` — coding gains `system: 'http://loinc.org'` and `version` only when `loinc` is non-null and non-sample; `observationsToFhir(patientId, orders, loincBindings = new Map())`.
  - `buildFullBundle` adds encounters and procedures. Routes `/fhir/Procedure` and `/fhir/Encounter` copy the Condition route (`CLINICAL_ROLES`, audit `exported FHIR Procedure bundle` / `exported FHIR Encounter bundle`).
  - `ccda.ts`: only the type change; C-CDA `codeSystem` attributes are unchanged in SP6 (ambiguity 6).

- [ ] **Step 1: Write the failing tests**

```ts
// condition-mapping.test.ts (replace the 'no system' case)
it('legacy free-text diagnosis has no system', () => { expect(conditionToFhir(legacy({ code: 'F32.1' })).code.coding).toEqual([{ code: 'F32.1', display: 'Depression' }]) })
it('an empty code yields text only', () => { expect(conditionToFhir(legacy({ code: '' })).code).toEqual({ text: 'Chest pain' }) })
it('a code from a loaded ICD-10 system carries the WHO URI and version', () => {
  expect(conditionToFhir(coded({ binding: { kind: 'icd10', version: '2019', isSample: false } })).code.coding).toEqual([{ system: 'http://hl7.org/fhir/sid/icd-10', version: '2019', code: 'E11.9', display: 'Type 2 diabetes mellitus without complications' }])
})
it('a sample code system never carries a system URI', () => { expect(conditionToFhir(coded({ binding: { kind: 'icd10', version: 'SAMPLE-ICD10-0', isSample: true } })).code.coding![0].system).toBeUndefined() })
it('SNOMED-coded conditions use http://snomed.info/sct; HBP never gets a system', () => { /* … */ })
it('links the encounter and marks provisional', () => { /* encounterId 5, type provisional → encounter.reference 'Encounter/encounter-5', verificationStatus code 'provisional', category 'encounter-diagnosis' */ })
// procedure-mapping.test.ts
it('maps a PCS-coded procedure with the CMS URI', () => { /* system 'http://www.cms.gov/Medicare/Coding/ICD10', performedDateTime '2099-03-01' */ })
// encounter-mapping.test.ts
it('maps an IPD encounter to IMP/finished with ranked diagnoses', () => { /* class.code 'IMP', status 'finished', diagnosis[0] { condition: Condition/condition-11, rank: 1 } */ })
// observation-mapping.test.ts
it('adds http://loinc.org only when the test code is in a loaded LOINC set', () => {
  expect(observationToFhir('RD-1', order, { kind: 'loinc', version: '2.78', isSample: false })!.code.coding![0]).toMatchObject({ system: 'http://loinc.org', version: '2.78' })
  expect(observationToFhir('RD-1', order)!.code.coding![0].system).toBeUndefined()
})
// gather.test.ts (DB): voided diagnosis absent; coded row has binding; loincBindings keyed by loaded current codes only
// fhir-export-routes.test.ts: Procedure and Encounter routes 403 for non-CLINICAL_ROLES (incl. coder), 200 bundle for admin
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/lib/fhir tests/api/fhir-export-routes.test.ts` → FAIL.
- [ ] **Step 3: Implement** the mapping, gather, bundle and routes.
- [ ] **Step 4: Verify** — same, plus `npm test -- tests/lib/fhir/gather.test.ts tests/api/rbac-route-gates.test.ts`, `npx vitest run tests/lib/no-aadhaar-leak.test.ts tests/lib/fhir/ccda-export.test.ts tests/lib/fhir/no-aadhaar-bundle.test.ts`, `npx tsc --noEmit`, `npm run build` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/fhir "src/app/api/patients/[anonId]/fhir" tests/lib/fhir tests/api/fhir-export-routes.test.ts tests/api/rbac-route-gates.test.ts
git commit -m "feat(sp6): FHIR Condition/Procedure/Encounter/Observation with system URIs from loaded code sets only"
```

---

## Execution notes

**Model tier per task:**

| Task | Tier | Local DB needed |
|---|---|---|
| 1 Coder role everywhere | standard (wide but mechanical; tsc finds the gaps) | **yes** (apply migration a twice; `coder-role` DB test; harness) |
| 2 Code-system kinds + importer | standard | no |
| 3 Rules, status machine, schemas | most capable (the rule table and the stage severities are the contract) | no |
| 4 Schema + migration | standard | **yes** (apply twice; schema DB tests; FK guard; seed FK order) |
| 5 Code-system queries + CLI + docs | standard | **yes** |
| 6 Code-system routes + import page | standard | harness + tariff-import DB test |
| 7 Encounter coding writes | most capable (locking order, role semantics, race with finalise) | **yes** |
| 8 Queries + workspace loaders | most capable (PHI minimisation, query/status interplay) | **yes** |
| 9 Coding routes + RBAC | standard | harness file only |
| 10 Worklist + productivity | standard | **yes** |
| 11 Worklist/report pages + nav | standard | no |
| 12 Workspace page | standard | no |
| 13 Chart proposals + doctor queries | standard | no |
| 14 Service ↔ code map | standard | **yes** |
| 15 FHIR | standard | **yes** (gather test, harness) |

Order: 1 → 2 → 3 → 4 → 5 → 6, then 7 → 8 → 9 → 10, then 11 → 12 → 13, with 14 and 15 after 9. Tasks 11–15 touch disjoint files apart from the two harness files and `LeftNav.tsx`; serialise those edits if run in parallel.

**Rulings made in this plan:**

1. **Licensing and shipping.** The repository ships **no** code-system content — not WHO ICD-10, not ICD-10-PCS (even though CMS publishes it in the public domain), not SNOMED CT, LOINC or the PM-JAY HBP master. Reasons: the repo is public, WHO ICD-10 and SNOMED CT/LOINC carry licence terms that forbid or condition redistribution, and the owner must choose the edition (WHO ICD-10 as adopted in India vs. ICD-10-CM) and version. The repo ships the importer, three tiny **fictional** fixtures whose versions start `SAMPLE-` and whose every display starts `SAMPLE fictional`, and `docs/CODE-SYSTEMS.md` explaining where the owner obtains each set and how to load it. Non-sample imports require a licence note, which is stored with the version. Sample versions never emit a FHIR `system` and never displace a licensed current version.
2. **"Coded" vs charge finalisation.** SP6 exposes `getEncounterCodingGate(encounterId)` and `chargeProcedureCodeProblems`. SP4 charge capture does **not** wait for coding (charges are captured at service time and cash bills are not held), but SP4 validates a charge's procedure codes against the service map when the service has one. **SP7 claim submission (and NHCX bundles in SP8) require `finalised`.** Reopening a finalised encounter is allowed; SP7 decides what that does to a submitted claim (it should raise a claim revision).
3. **Per-encounter vs per-patient diagnoses.** `diagnoses` stays the patient's list. Rows with `encounter_id` are that visit's diagnoses and are what gets coded; legacy rows (no encounter) remain patient-level history, read `uncoded`, keep their free-text `code` (shown as "unverified"), are never auto-matched to a code set, and are never on the worklist. SP6-written rows without a code store `code = ''` because the legacy column is NOT NULL and migrations may not `DROP` it. Removal is a soft void (`voided_at`), and every legacy reader ignores voided rows.
4. **What coders see.** Patient id, name, UHID, sex and age in years; the visit's department, doctor, dates; its diagnoses, procedures, queries and coding history; and the **signed** notes of that visit, read-only (coders need the documentation to code). Never DOB, phone, email, address, contacts, ABHA, insurance or anything Aadhaar. Coders have no global search, no `/patients` pages, no chart, and cannot write notes (harness rows for the notes routes).
5. **Role naming.** The enum value is `coder` (spec §3), labelled "Clinical Coder"; login door `/login/coder`; home `/coding`.
6. **Two-step close.** `mark_coded` needs no errors (primary missing and provisional diagnoses are warnings); `finalise` needs no errors at the `finalise` stage (they become errors). Finalised locks every code write for every role. `reopen` (coder or admin, reason mandatory, counted, reason stored in `encounter_coding_events` and never in the audit log) returns it to `in_progress`.
7. **Claim model.** A coder must claim an encounter before changing its codes or moving its status; admin may act without a claim and is the only role that can `assign`. Claiming needs a staff user account (`session.userId`), so the env-only admin login can assign but not claim. A coder edit on a `coded` encounter reverts it to `in_progress` (event `edit_after_coded`).
8. **Doctors propose; coders decide.** A pi's code becomes `proposed`; a pi may also add free-text, `uncoded` entries when no code set is loaded. Doctors may propose while coding is `uncoded`/`in_progress`/`queried` and may not touch `coded` rows. Any pi (or admin) may answer a coding query, matching SP3's cross-cover ruling; the addressed doctor sees it on `/doctor`.
9. **Two import paths.** Web import is capped at 4 MB / 60,000 rows (under Vercel's request-body limit); full releases go through `npm run codes:import`, which shares the validator and commit and audits as role `admin` with user name `CLI: <--by>` (the operator already has database credentials).
10. **Versions.** Code-system versions are never deleted or updated in place. One current version per kind (partial unique index). Search uses the current version; coded rows keep the `code_id` of the version they were coded against, so earlier codings stay valid.
11. **FHIR systems.** ICD-10 `http://hl7.org/fhir/sid/icd-10`, ICD-10-PCS `http://www.cms.gov/Medicare/Coding/ICD10`, SNOMED `http://snomed.info/sct`, LOINC `http://loinc.org`, with `version`, only when the code came from a loaded non-sample code system (diagnoses and procedures by `code_id`; lab tests by matching a loaded current LOINC code). HBP gets **no** system until SP8 confirms the NHCX canonical URI. Legacy free text keeps today's behaviour.
12. **Rules are table-driven.** Sex, age (whole years), selectability, validity dates and excludes come from the imported columns; `excludes` entries match by prefix (`E10` excludes `E10.9`).
13. **Search index.** `pg_trgm` + `codes_display_trgm_idx` are migration-only (like SP2's exclusion constraint); code-prefix search uses the drizzle-declared `text_pattern_ops` index.
14. **Audit.** Actions start `coding: `; details carry ids, codes and enums only. Query questions/replies live in their tables; reopen reasons in the events table.
15. **Service map is version-independent** (kind + code value, validated against the current version when written). Services with no mapping are unconstrained so SP4 can roll checks out gradually.
16. **No seed data** for code systems or coding; one demo `coder` user is seeded. Tests create `TEST-SP6-` fixtures.

**Ambiguities flagged for the owner:**
- **Which ICD-10 edition.** India uses WHO ICD-10; some payers/TPAs ask for ICD-10-CM-style codes. The `icd10` pattern accepts both (up to 4 characters after the dot); confirm the edition before loading.
- **HBP code format and FHIR URI.** The HBP pattern is permissive (`^[A-Z]{1,4}[0-9]{1,4}[A-Z0-9]{0,4}$`) and HBP carries no FHIR system until SP8 confirms NHCX profiles.
- **Who may reopen.** Coders and admin may reopen (with reason). If finalisation should be a supervisor-only lock, restrict `reopen` (and perhaps `finalise`) to admin in `CODING_ACTION_ROLES`.
- **Coders reading notes.** Coders read signed notes of the visit being coded. If policy requires coders to code only from a discharge summary, drop the notes section (SP3 ships the discharge-summary data shape only).
- **Release-format converters.** The importer reads one documented CSV shape; converters for WHO ClaML, CMS PCS order files, SNOMED RF2 and `Loinc.csv` are not built (docs describe the column mapping). Worth a follow-up if the owner loads sets often.
- **Not covered:** C-CDA `codeSystem` OIDs (unchanged), SNOMED coding of medications/allergies, DRG/grouping, neonatal age edits in days, per-payer coding rules, and a "my patients' coding queries" badge in the nav.
