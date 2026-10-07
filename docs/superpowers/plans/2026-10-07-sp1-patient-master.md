# SP1: Indian Patient Master & Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the US-flavoured `patients` record into an Indian hospital patient master: structured demographics and address, NOK/guardian/emergency contacts, a UHID generator, Aadhaar (encrypted, masked, consented or declined with a reason), ABHA number/address, KYC document type, MLC flag, a department master, and doctor NMC/SMC registration with a consultation fee. It covers registration, the staff profile, the portal view, FHIR, RBAC and audit.

**Architecture:** New columns are added to `patients` and `providers`. Two new child tables (`patient_contacts`, `patient_aadhaar`) and one master table (`departments`) are added, plus a Postgres sequence `uhid_seq`. Aadhaar has its own table so every existing whole-row `select().from(patients)` (detail cache, workbook export, FHIR, list API) can never carry it. All validation lives in pure, client-safe modules under `src/lib/india/` and `src/lib/validation/`. Route handlers and the registration modal share these modules. All DB writes go through query modules that route tests mock, so every task is verifiable without a database.

**Tech Stack:** Next.js 16 App Router (route params are `Promise`s; `src/proxy.ts`, not middleware), drizzle-orm 0.45 + node-postgres, zod v4, vitest 5 + jsdom + Testing Library, AES-256-GCM helper `src/lib/crypto.ts`.

**Spec:** `docs/superpowers/specs/2026-10-07-indian-hims-design.md` (sections 1–4, 6, 7 are binding; this plan implements sub-project 1).

## Global Constraints

- Read `AGENTS.md`. Before writing any route or page, read the relevant guide in `node_modules/next/dist/docs/`, because Next 16 differs from training data. Route context is `{ params: Promise<{ … }> }`.
- **Money:** integer **paise** only, with column `currency text NOT NULL DEFAULT 'INR'` beside every money column. Format with `formatPaise` from Task 2 and never with `formatCents` (USD).
- **Time:** the default timezone is `Asia/Kolkata`. "Today" for any business rule (age, minor check) is `todayIsoIn('Asia/Kolkata')` from Task 2, never `new Date().toISOString().slice(0, 10)`.
- **Aadhaar (spec §3, verbatim intent):**
  - Collect it only with explicit consent.
  - Encrypt it at rest with `encryptSensitive` from `src/lib/crypto.ts`.
  - Show only the last 4 digits, in the form `XXXX XXXX 1234`.
  - Never put it in logs, URLs, query strings, exports (workbook/Excel), FHIR, C-CDA, audit `action`/`details`, error messages or 4xx bodies.
  - Validate the Verhoeff checksum.
  - "Mandatory" means registration is rejected unless the request has either the number with consent or a decline reason. A decline is a recorded override and is written to the audit log. Care is never denied.
- **Aadhaar RBAC:**
  - Write: `admin`, `crc`, `frontdesk` (`AADHAAR_WRITE_ROLES`). Registration itself stays `admin`/`frontdesk`, so `crc` writes Aadhaar only through `PUT /api/patients/[anonId]/aadhaar`.
  - Read masked (last 4): `admin`, `crc` only (`AADHAAR_MASKED_READ_ROLES`).
  - Every other viewer, the portal included, sees only the status (`On file` / `Declined` / `Not recorded`).
  - No role can export it.
- **ABHA:** a 14-digit number (stored as 14 digits with no hyphens, displayed `XX-XXXX-XXXX-XXXX`) and an ABHA address. Validation checks format only. Verification/linking with the ABDM gateway is SP8. The UI says "ABDM not connected" next to ABHA fields.
- **FHIR:** identifiers are the local id, the UHID and ABHA only. Aadhaar never appears.
- **RBAC:**
  - Every new or changed API calls `requireSession()` first. It then runs an inline allowlist check from `src/lib/role-policy.ts` and returns exactly `NextResponse.json({ error: 'Forbidden' }, { status: 403 })`. Both happen **before** the body is parsed or any query runs.
  - Every new API gets a row in `API_GATES` in `tests/api/rbac-route-gates.test.ts`, with no `gap` tag.
  - SP1 adds **no new `(dashboard)` page**: the profile is a tab on the existing patient page, and departments and the UHID prefix are Settings tabs. So `PAGE_GATES` in `tests/pages/page-gates-harness.ts` gets no new row. The existing `/patients/[anonId]` and `/settings` rows must stay green.
- **Branding:** no hard-coded product name. Server code reads `brand` from `src/lib/brand.ts`; client code calls `useBrand()` from `src/components/BrandProvider.tsx`.
- **Schema changes:** each change ships as a `src/db/schema.ts` edit **and** a reviewed, idempotent SQL file under `scripts/migrations/2026-10-07-sp1-*.sql`. Copy the style of `scripts/migrations/2026-10-04-assignment-notifications.sql`:
  - The file is wrapped in `BEGIN; … COMMIT;`.
  - Use `IF NOT EXISTS` everywhere.
  - Wrap each `CREATE TYPE` in `DO $$ BEGIN … EXCEPTION WHEN duplicate_object THEN null; END $$;`.
  - Wrap each named constraint in a `DO` block that checks `pg_constraint`.
  - Use no `DROP`.
  - Apply it with `node --env-file=.env.local scripts/apply-sql.mjs <file>`.
  - `db:push` is for a fresh database only (`docs/DEPLOYING.md` §4).
- **No database is attached** (there is no `.env.local`). Run single files with `npx vitest run <file>`, not `npm test`, which needs `.env.local`.
- **DB-backed tests:** wrap DB-integration tests in `describe.skipIf(!process.env.DATABASE_URL)('… (DB)', …)` so they skip here and run once the owner connects the HIMS Neon DB. They create their own fixture rows with ids prefixed `TEST-SP1-` and delete them in `afterEach`, children before parents, like `tests/api/patients-create.test.ts`.
- **Encryption key in tests:** tests that encrypt call `vi.stubEnv('IDENTITY_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'))` in `beforeEach` and `vi.unstubAllEnvs()` in `afterEach`.
- **Per-task verification:** `npx tsc --noEmit` and `npx eslint <changed files>`, in addition to the task's tests.
- **No secrets** in code, tests or migrations. Commit nothing until execution. The commit steps below are for the executor.

## Review Focus

1. **Aadhaar typed with spaces or hyphens** (`2345 6789 0124`, `2345-6789-0124`) must be accepted after normalisation. A wrong checksum must give a 400 whose JSON body contains no 4-or-more-digit run from the input. Test: Task 4 `aadhaar union accepts spaced input and rejects bad checksum without echoing it`, and Task 7 `400 body never contains the submitted Aadhaar digits`.
2. **A minor registered without a guardian:** age is under 18 on today's Asia/Kolkata date, and a DOB in the future must be rejected. Test: Task 4 `requires a guardian contact for a patient under 18 on the Asia/Kolkata date` and `rejects a DOB after today`.
3. **Editing a profile must never touch Aadhaar.** `PATCH /profile` is `.strict()` and rejects any `aadhaar` key, so an edit cannot wipe or overwrite the stored number or its consent. Test: Task 4 `profile update schema rejects an aadhaar key`, and Task 8 `PATCH profile with an aadhaar key 400s and never calls updatePatientProfile`.
4. **Switching between declined and on-file:**
   - Moving from declined to provided clears `declineReason`/`declineNote`.
   - Moving from provided to declined clears `aadhaarEncrypted`/`aadhaarLast4`.
   - Each switch writes its own audit action.
   - Test: Task 6 `buildAadhaarRow for a decline nulls ciphertext and last4` and `identityAuditEntries reports declined→on_file as recorded-with-consent`.
5. **A duplicate ABHA number or ABHA address on another patient** must give a 409 with a plain message, not a 500. Test: Task 7 `maps a unique violation on patients_abha_number_unique to 409`, and Task 8 for `PATCH profile`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/india/verhoeff.ts` | Verhoeff checksum generate/validate (pure) |
| `src/lib/india/aadhaar.ts` | Aadhaar normalise/validate/mask (pure, client-safe) |
| `src/lib/india/abha.ts` | ABHA number/address normalise/validate/format (pure) |
| `src/lib/india/reference.ts` | States (ISO 3166-2:IN), genders, marital status, blood groups, KYC doc types, reason codes, relationships, languages |
| `src/lib/india/phone.ts` | Indian / international phone normalisation |
| `src/lib/money.ts` | `formatPaise`, `parseRupeesToPaise` (shared with SP2) |
| `src/lib/india-time.ts` | `DEFAULT_TIMEZONE`, `todayIsoIn`, `ageOnDate` (shared with SP2) |
| `src/lib/db-errors.ts` | Postgres error code / constraint extraction (shared with SP2) |
| `src/lib/uhid.ts` | UHID format/parse/prefix validation (pure) |
| `src/lib/validation/patient-registration.ts` | zod schemas for registration, profile, contacts, Aadhaar |
| `src/lib/validation/provider-profile.ts` | zod schema for provider registration/fee/department |
| `src/lib/patient-identity.ts` | Aadhaar row builder, summary/view, identity audit entries |
| `src/lib/queries/departments.ts` | Department master CRUD |
| `src/lib/queries/uhid.ts` | `nextUhid` (sequence + prefix), prefix get/set |
| `src/lib/queries/patient-registration.ts` | Transactional `registerPatient` |
| `src/lib/queries/patient-profile.ts` | Profile update, contacts replace, Aadhaar upsert, identity read |
| `src/lib/fhir/identifier-systems.ts` | FHIR identifier system URIs |
| `src/components/registration/*` | Registration form sections + form-state helpers |
| `src/components/patient-profile/*` | Profile panel, edit modal, Aadhaar panel |
| `src/components/settings/DepartmentsPanel.tsx`, `UhidPrefixForm.tsx` | Settings tabs |
| `scripts/migrations/2026-10-07-sp1-departments.sql` | Departments DDL (Task 2) |
| `scripts/migrations/2026-10-07-sp1-patient-master.sql` | Patient master DDL (Task 3) |
| `tests/db/migration-sql.ts` | Plain (non-`.test`) helper that checks migration SQL statically (shared with SP2) |
| `tests/fixtures/patient-row.ts` | In-memory `patients` row builder for pure tests |

---

### Task 1: Identity validators (Verhoeff, Aadhaar, ABHA)

**Files:**
- Create: `src/lib/india/verhoeff.ts`, `src/lib/india/aadhaar.ts`, `src/lib/india/abha.ts`
- Test: `tests/lib/india/verhoeff.test.ts`, `tests/lib/india/aadhaar.test.ts`, `tests/lib/india/abha.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `verhoeffCheckDigit(digits: string): number` (throws on a non-digit input)
  - `verhoeffValidate(digitsWithCheck: string): boolean`
  - `normalizeAadhaar(input: string): string`, which strips spaces and hyphens only
  - `isValidAadhaar(input: string): boolean`: after normalising, 12 digits, the first digit 2–9, and Verhoeff valid
  - `aadhaarLast4(normalized: string): string`
  - `maskAadhaarLast4(last4: string): string` returns `` `XXXX XXXX ${last4}` ``
  - `normalizeAbhaNumber(input: string): string`, which strips spaces and hyphens
  - `isValidAbhaNumber(input: string): boolean`: exactly 14 digits after normalising
  - `formatAbhaNumber(digits14: string): string`, which gives `XX-XXXX-XXXX-XXXX`
  - `normalizeAbhaAddress(input: string): string`: trim and lower-case
  - `isValidAbhaAddress(input: string): boolean`. The local part is 8–18 characters of `[a-z0-9]`, with at most one `.` and at most one `_`, neither leading nor trailing. The suffix is `@abdm` or `@sbx`.
  - All are pure, with no `node:` imports, so the client modal can import them.

- [ ] **Step 1: Write the failing tests**

```ts
// verhoeff.test.ts
it('computes the textbook check digit', () => { expect(verhoeffCheckDigit('236')).toBe(3); expect(verhoeffValidate('2363')).toBe(true) })
it('detects a single-digit error and an adjacent transposition', () => {
  expect(verhoeffValidate('234567890124')).toBe(true)
  expect(verhoeffValidate('234567890125')).toBe(false)
  expect(verhoeffValidate('324567890124')).toBe(false)
})
// aadhaar.test.ts
it.each(['234567890124', '2345 6789 0124', '2345-6789-0124', '498765432102', '987654321012'])('accepts %s', (v) => expect(isValidAadhaar(v)).toBe(true))
it.each(['234567890125', '134567890124', '034567890124', '23456789012', '2345678901245', 'abcd56789012', ''])('rejects %s', (v) => expect(isValidAadhaar(v)).toBe(false))
it('masks to last four', () => { expect(maskAadhaarLast4(aadhaarLast4(normalizeAadhaar('2345 6789 0124')))).toBe('XXXX XXXX 0124') })
// abha.test.ts
it('normalises and formats a 14-digit ABHA number', () => {
  expect(normalizeAbhaNumber('12-3456-7890-1234')).toBe('12345678901234')
  expect(isValidAbhaNumber('12-3456-7890-1234')).toBe(true)
  expect(isValidAbhaNumber('1234567890123')).toBe(false)
  expect(formatAbhaNumber('12345678901234')).toBe('12-3456-7890-1234')
})
it.each(['ravi.kumar@abdm', 'ravi_kumar1@sbx', 'RaviKumar99@ABDM'])('accepts ABHA address %s', (v) => expect(isValidAbhaAddress(v)).toBe(true))
it.each(['ravi@abdm', '.ravikumar@abdm', 'ravikumar.@abdm', 'ra.vi.kumar@abdm', 'ravikumar@gmail.com', 'ravikumar'])('rejects ABHA address %s', (v) => expect(isValidAbhaAddress(v)).toBe(false))
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/india`
Expected: FAIL with "Failed to resolve import".

- [ ] **Step 3: Implement the three modules** with the signatures above. Verhoeff uses the standard dihedral D5 multiplication table `d`, permutation table `p` (8 rows) and inverse `inv = [0,4,3,2,1,5,6,7,8,9]`. To generate, iterate the reversed digits with `p[(i+1)%8]`. To validate, use `p[i%8]` and require a final value of 0.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/lib/india`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/india tests/lib/india
git commit -m "feat(sp1): Verhoeff, Aadhaar and ABHA validators"
```

---

### Task 2: Shared foundation: department master, INR money, IST date, PG errors, migration checker

This task is **self-contained on purpose**. SP2 (`docs/superpowers/plans/2026-10-07-sp2-tariff-master.md`) cherry-picks this one commit if SP1 is not merged yet. Touch nothing outside the files listed.

**Files:**
- Modify: `src/db/schema.ts`. Add `departmentKindEnum` and `departments` after `providers`, around line 492. Add `uniqueIndex` usage as needed. The import line already has `uniqueIndex`.
- Create: `scripts/migrations/2026-10-07-sp1-departments.sql`
- Create: `src/lib/queries/departments.ts`, `src/lib/money.ts`, `src/lib/india-time.ts`, `src/lib/db-errors.ts`
- Create: `tests/db/migration-sql.ts` (a plain helper module, not a test file)
- Test: `tests/db/departments-schema.test.ts`, `tests/lib/money.test.ts`, `tests/lib/india-time.test.ts`, `tests/lib/db-errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - Schema:
    ```ts
    export const departmentKindEnum = pgEnum('department_kind', ['clinical', 'diagnostic', 'support', 'administrative'])
    export const departments = pgTable('departments', {
      id: serial('id').primaryKey(),
      code: text('code').notNull().unique(),          // ^[A-Z][A-Z0-9_]{1,15}$
      name: text('name').notNull(),
      kind: departmentKindEnum('kind').default('clinical').notNull(),
      isActive: boolean('is_active').default(true).notNull(),
      createdAt: timestamp('created_at').defaultNow().notNull(),
    })
    export type Department = typeof departments.$inferSelect
    ```
  - `src/lib/queries/departments.ts`:
    - `DEPARTMENT_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,15}$/`
    - `listDepartments(opts?: { activeOnly?: boolean }): Promise<Department[]>`, ordered by name
    - `getDepartmentById(id: number): Promise<Department | null>`
    - `getDepartmentByCode(code: string): Promise<Department | null>`
    - `createDepartment(input: { code: string; name: string; kind: Department['kind'] }): Promise<Department>`
    - `updateDepartment(id: number, patch: Partial<{ name: string; kind: Department['kind']; isActive: boolean }>): Promise<Department | null>`
  - `src/lib/money.ts`:
    - `CURRENCY = 'INR' as const`
    - `formatPaise(paise: number): string`, using `Intl` `en-IN` currency INR, with 2 decimals
    - `parseRupeesToPaise(input: string): number | null`. It accepts `1234`, `1,234.5`, `₹ 1,23,456.78`. It rejects a negative, more than 2 decimals, an empty string, non-numeric text, and anything above `Number.MAX_SAFE_INTEGER` paise.
  - `src/lib/india-time.ts`:
    - `DEFAULT_TIMEZONE = 'Asia/Kolkata'`
    - `todayIsoIn(tz: string = DEFAULT_TIMEZONE, now: Date = new Date()): string`, returning `YYYY-MM-DD`
    - `ageOnDate(dobIso: string, onIso: string): number`, in whole years
  - `src/lib/db-errors.ts`:
    - `pgErrorCode(err: unknown): string | null`, which reads `err.code`, or else `err.cause.code`, because drizzle wraps pg errors
    - `pgConstraint(err: unknown): string | null`, the same lookup for `.constraint`
    - `isUniqueViolation(err: unknown, constraint?: string): boolean` (code `23505`)
    - `isExclusionViolation(err: unknown, constraint?: string): boolean` (code `23P01`)
  - `tests/db/migration-sql.ts`:
    - `readMigration(fileName: string): string`, which reads `scripts/migrations/<fileName>`
    - `idempotencyProblems(sqlText: string): string[]`, which returns an empty array when the SQL is clean
    - `missingColumns(table: PgTable, sqlText: string): string[]`, which uses `getTableConfig` from `drizzle-orm/pg-core`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/lib/money.test.ts
it('formats paise in Indian grouping', () => {
  expect(formatPaise(123456789)).toBe('₹12,34,567.89'); expect(formatPaise(5)).toBe('₹0.05'); expect(formatPaise(0)).toBe('₹0.00')
})
it.each([['1234', 123400], ['1,234.5', 123450], ['₹ 1,23,456.78', 12345678], ['0', 0]])('parses %s', (s, p) => expect(parseRupeesToPaise(s)).toBe(p))
it.each(['-1', '1.234', '', 'abc', '1e3'])('rejects %s', (s) => expect(parseRupeesToPaise(s)).toBeNull())
// tests/lib/india-time.test.ts
it('uses the Kolkata calendar date, not UTC', () => { expect(todayIsoIn('Asia/Kolkata', new Date('2026-10-06T19:00:00Z'))).toBe('2026-10-07') })
it('computes age in whole years across a birthday', () => { expect(ageOnDate('2008-10-08', '2026-10-07')).toBe(17); expect(ageOnDate('2008-10-07', '2026-10-07')).toBe(18) })
// tests/lib/db-errors.test.ts
it('reads the code through a drizzle cause wrapper', () => {
  const wrapped = { message: 'Failed query', cause: { code: '23505', constraint: 'patients_abha_number_unique' } }
  expect(isUniqueViolation(wrapped, 'patients_abha_number_unique')).toBe(true); expect(isExclusionViolation(wrapped)).toBe(false)
})
// tests/db/departments-schema.test.ts
it('migration is idempotent and covers every departments column', () => {
  const sqlText = readMigration('2026-10-07-sp1-departments.sql')
  expect(idempotencyProblems(sqlText)).toEqual([]); expect(missingColumns(departments, sqlText)).toEqual([])
})
it('idempotencyProblems flags a bare CREATE TABLE and a DROP', () => {
  expect(idempotencyProblems('BEGIN; CREATE TABLE x (id int); DROP TABLE y; COMMIT;').length).toBe(2)
})
describe.skipIf(!process.env.DATABASE_URL)('departments (DB)', () => {
  it('rejects a duplicate code', async () => { /* create TEST_SP1_A twice; second throws isUniqueViolation; afterEach deletes by code */ })
})
```

`idempotencyProblems` reports one string for each of these:
- a missing leading `BEGIN;` or trailing `COMMIT;`
- `CREATE TABLE`, `CREATE INDEX`, `CREATE UNIQUE INDEX`, `CREATE SEQUENCE`, `ADD COLUMN` or `CREATE EXTENSION` without `IF NOT EXISTS`
- a `CREATE TYPE` not inside a `DO $$` block that has `duplicate_object`
- an `ADD CONSTRAINT` not inside a `DO $$` block that references `pg_constraint`
- any `DROP `

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/money.test.ts tests/lib/india-time.test.ts tests/lib/db-errors.test.ts tests/db/departments-schema.test.ts`
Expected: FAIL (modules missing). The DB block is reported as skipped.

- [ ] **Step 3: Implement the schema, migration, query module and helpers.** The migration creates the `department_kind` type in a `DO` block. It also creates `departments` with the `UNIQUE (code)` constraint named `departments_code_unique`. Copy the header comment from the 2026-10-04 migration.

- [ ] **Step 4: Run the tests to verify they pass**

Run: same command as Step 2.
Expected: PASS. The DB block is skipped.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts scripts/migrations/2026-10-07-sp1-departments.sql src/lib/queries/departments.ts src/lib/money.ts src/lib/india-time.ts src/lib/db-errors.ts tests/db/migration-sql.ts tests/db/departments-schema.test.ts tests/lib/money.test.ts tests/lib/india-time.test.ts tests/lib/db-errors.test.ts
git commit -m "feat(sp1): department master, INR money, IST date and migration helpers"
```

---

### Task 3: Patient master schema + migration

**Files:**
- Modify: `src/db/schema.ts`:
  - the import line 1: add `pgSequence`, `check`, and `sql` from `drizzle-orm`
  - `patients` (lines 43–95)
  - `idTypeEnum` (line 268)
  - `appSettings` (lines 453–470)
  - `providers` (lines 484–492)
  - new tables after `identityVerifications`
- Modify: `src/lib/queries/settings.ts:7-10`. The `getAppSettings` fallback literal gets `practiceTimezone: 'Asia/Kolkata'` and `uhidPrefix: 'UH'`.
- Modify: `src/lib/queries/patients.ts`, in `deletePatient` near line 443. Delete `patientContacts` and `patientAadhaar` before `patients`.
- Modify: `src/db/seed.ts`, in `clearExistingData` near line 903. Delete `patientContacts` and `patientAadhaar` before `patients`.
- Create: `scripts/migrations/2026-10-07-sp1-patient-master.sql`
- Test: `tests/db/patient-master-schema.test.ts`

**Interfaces:**
- Consumes: `departments` (Task 2) and `tests/db/migration-sql.ts` (Task 2).
- Produces (exact drizzle names, used by every later task):
  - Enums:
    - `genderEnum = pgEnum('gender', ['male','female','transgender','other','unknown'])`
    - `maritalStatusEnum = pgEnum('marital_status', ['single','married','divorced','widowed','separated','unknown'])`
    - `bloodGroupEnum = pgEnum('blood_group', ['A+','A-','B+','B-','AB+','AB-','O+','O-','unknown'])`
    - `patientContactKindEnum = pgEnum('patient_contact_kind', ['next_of_kin','guardian','emergency'])`
    - `registrationCouncilEnum = pgEnum('registration_council', ['nmc','smc'])`
    - `idTypeEnum` gains `'voter_id','pan','ration_card'`, appended in that order
  - `uhidSeq = pgSequence('uhid_seq', { startWith: 1, increment: 1 })`
  - `patients` gets these new nullable columns unless noted:
    - `uhid` (`text`, `.unique()` gives constraint `patients_uhid_unique`)
    - `gender`, `maritalStatus`, `bloodGroup`
    - `occupation`, `nationality` (`text`, default `'IN'`), `religion`, `preferredLanguage`, `photoBlobPath`
    - `addressLine1`, `addressLine2`, `district`, `stateCode`, `pinCode`
    - `abhaNumber` (unique, giving `patients_abha_number_unique`) and `abhaAddress` (unique, giving `patients_abha_address_unique`)
    - `abhaUnavailableReason` (`text` with `{ enum: ABHA_UNAVAILABLE_REASON_CODES }` typing, literal tuple inline: `['not_created','patient_declined','emergency','other']`) and `abhaUnavailableNote`
    - `isMlc` (`boolean`, NOT NULL, default false) and `mlcNumber`
    - The legacy `city` is kept and used as city/town. The legacy `zip` is kept, but registration no longer writes it.
  - `patientContacts`:
    ```ts
    export const patientContacts = pgTable('patient_contacts', {
      id: serial('id').primaryKey(),
      patientId: text('patient_id').notNull().references(() => patients.id),
      kind: patientContactKindEnum('kind').notNull(),
      name: text('name').notNull(),
      relationship: text('relationship').notNull(),
      phone: text('phone').notNull(),
      addressText: text('address_text'),
      isPrimary: boolean('is_primary').default(false).notNull(),
      createdAt: timestamp('created_at').defaultNow().notNull(),
    })
    ```
  - `patientAadhaar`. The primary key is the patient, so there is one row per patient:
    ```ts
    export const patientAadhaar = pgTable('patient_aadhaar', {
      patientId: text('patient_id').primaryKey().references(() => patients.id),
      aadhaarEncrypted: text('aadhaar_encrypted'),
      aadhaarLast4: text('aadhaar_last4'),
      consentGiven: boolean('consent_given').default(false).notNull(),
      consentRecordedAt: timestamp('consent_recorded_at'),
      declineReason: text('decline_reason', { enum: ['patient_declined','not_available','minor_no_aadhaar','emergency','foreign_national','other'] }),
      declineNote: text('decline_note'),
      recordedByName: text('recorded_by_name').notNull(),
      updatedAt: timestamp('updated_at').defaultNow().notNull(),
    }, (t) => [check('patient_aadhaar_value_xor_decline', sql`(${t.aadhaarEncrypted} IS NOT NULL AND ${t.aadhaarLast4} ~ '^[0-9]{4}$' AND ${t.consentGiven} AND ${t.declineReason} IS NULL) OR (${t.aadhaarEncrypted} IS NULL AND ${t.aadhaarLast4} IS NULL AND ${t.declineReason} IS NOT NULL)`)])
    ```
  - `appSettings` gets `uhidPrefix: text('uhid_prefix').default('UH').notNull()`. Its `practiceTimezone` default becomes `'Asia/Kolkata'`.
  - `providers` gets:
    - `departmentId` (`integer`, references `departments.id`)
    - `registrationCouncil` (`registrationCouncilEnum`)
    - `registrationStateCode` (`text`)
    - `registrationNumber` (`text`)
    - `consultationFeePaise` (`integer`)
    - `currency` (`text`, NOT NULL, default `'INR'`)
    - plus `check('providers_consultation_fee_nonneg', sql\`${t.consultationFeePaise} IS NULL OR ${t.consultationFeePaise} >= 0\`)`

- [ ] **Step 1: Write the failing test** `tests/db/patient-master-schema.test.ts`

```ts
it('migration is idempotent', () => { expect(idempotencyProblems(readMigration('2026-10-07-sp1-patient-master.sql'))).toEqual([]) })
it.each([['patients', patients], ['patient_contacts', patientContacts], ['patient_aadhaar', patientAadhaar], ['providers', providers], ['app_settings', appSettings]])
  ('migration declares every %s column', (_n, t) => { expect(missingColumns(t, readMigration('2026-10-07-sp1-patient-master.sql'))).toEqual([]) })
it('keeps Aadhaar off the patients table', () => {
  expect(getTableConfig(patients).columns.map((c) => c.name).filter((n) => /aadhaar/i.test(n))).toEqual([])
})
it('migration creates uhid_seq, the xor check and the three unique constraints', () => {
  const s = readMigration('2026-10-07-sp1-patient-master.sql')
  for (const needle of ['uhid_seq', 'patient_aadhaar_value_xor_decline', 'patients_uhid_unique', 'patients_abha_number_unique', 'patients_abha_address_unique', "ADD VALUE IF NOT EXISTS 'voter_id'", "SET DEFAULT 'Asia/Kolkata'"]) expect(s).toContain(needle)
})
it('deletePatient and clearExistingData clear the new child tables', () => {
  for (const f of ['src/lib/queries/patients.ts', 'src/db/seed.ts']) {
    const src = readFileSync(join(process.cwd(), f), 'utf8'); expect(src).toContain('patientContacts'); expect(src).toContain('patientAadhaar')
  }
})
describe.skipIf(!process.env.DATABASE_URL)('patient master (DB)', () => {
  it('rejects a patient_aadhaar row with both a value and a decline reason', async () => { /* insert TEST-SP1-X patient, insert bad row, expect pgErrorCode === '23514', cleanup */ })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/db/patient-master-schema.test.ts`
Expected: FAIL. The migration file is missing and the tables are not exported.

- [ ] **Step 3: Edit `schema.ts`, write the migration, and update `deletePatient`, `clearExistingData` and the settings fallback.** The migration must contain all of the following:
  - `ALTER TYPE id_type ADD VALUE IF NOT EXISTS …` ×3
  - `CREATE SEQUENCE IF NOT EXISTS uhid_seq START 1`
  - the enum types in `DO` blocks
  - `ALTER TABLE patients ADD COLUMN IF NOT EXISTS …` for each column
  - the unique constraints in `pg_constraint`-guarded `DO` blocks
  - the two tables, with the check in its `DO` block
  - `ALTER TABLE app_settings ALTER COLUMN practice_timezone SET DEFAULT 'Asia/Kolkata'`, then `UPDATE app_settings SET practice_timezone = 'Asia/Kolkata' WHERE practice_timezone = 'America/Los_Angeles'`
  - the `providers` columns and their check

- [ ] **Step 4: Run the test to verify it passes, then type-check**

Run: `npx vitest run tests/db/patient-master-schema.test.ts && npx tsc --noEmit`
Expected: PASS. tsc is clean.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/db/seed.ts src/lib/queries/settings.ts src/lib/queries/patients.ts scripts/migrations/2026-10-07-sp1-patient-master.sql tests/db/patient-master-schema.test.ts
git commit -m "feat(sp1): patient master schema, Aadhaar table, UHID sequence and migration"
```

---

### Task 4: Reference data + registration/profile zod schemas

**Files:**
- Create: `src/lib/india/reference.ts`, `src/lib/india/phone.ts`, `src/lib/validation/patient-registration.ts`
- Test: `tests/lib/india/reference.test.ts`, `tests/lib/validation/patient-registration.test.ts`

**Interfaces:**
- Consumes: Task 1 validators, and `todayIsoIn` and `ageOnDate` (Task 2).
- Produces:
  - `reference.ts` (pure and client-safe; every list is a `readonly` tuple of `{ code, label }` or of codes):
    - `INDIAN_STATES`: 36 entries for ISO 3166-2:IN as amended in 2023. Codes: `IN-AN, IN-AP, IN-AR, IN-AS, IN-BR, IN-CH, IN-CG, IN-DH, IN-DL, IN-GA, IN-GJ, IN-HR, IN-HP, IN-JK, IN-JH, IN-KA, IN-KL, IN-LA, IN-LD, IN-MP, IN-MH, IN-MN, IN-ML, IN-MZ, IN-NL, IN-OD, IN-PY, IN-PB, IN-RJ, IN-SK, IN-TN, IN-TS, IN-TR, IN-UP, IN-UK, IN-WB`, each with its English name.
    - `isIndianStateCode(code: string): boolean` and `stateName(code: string): string | null`
    - `isValidPinCode(pin: string): boolean`, matching `/^[1-9][0-9]{5}$/`
    - `GENDERS`, `MARITAL_STATUSES`, `BLOOD_GROUPS`. Their codes mirror the Task 3 enums exactly.
    - `KYC_DOC_TYPES = ['passport','drivers_license','voter_id','pan','ration_card'] as const`, labelled Passport, Driving licence, Voter ID (EPIC), PAN card, Ration card. Aadhaar is **deliberately absent**.
    - `AADHAAR_DECLINE_REASONS` (codes as in the Task 3 `declineReason` enum, with labels)
    - `ABHA_UNAVAILABLE_REASONS` (`not_created`, `patient_declined`, `emergency`, `other`)
    - `CONTACT_RELATIONSHIPS = ['spouse','parent','child','sibling','guardian','relative','friend','other'] as const`
    - `LANGUAGES`, a short list of ISO 639-1 codes: `en, hi, bn, te, mr, ta, ur, gu, kn, ml, or, pa, as`
  - `phone.ts`: `normalizePhone(input: string): string | null`.
    - An Indian mobile (`[6-9]` followed by 9 digits, optionally prefixed `+91`, `91` or `0`) becomes `+91XXXXXXXXXX`.
    - Any other `+` with 8–15 digits is kept as E.164.
    - Anything else gives `null`.
  - `patient-registration.ts` (zod v4, client-safe):
    - `aadhaarInputSchema`: a discriminated union on `status`. It is either `{ status: 'provided', number: string, consent: literal(true) }`, where `number` is transformed through `normalizeAadhaar` and refined with `isValidAadhaar`, or `{ status: 'declined', reason: enum(declineReason codes), note?: string }`, where `note` (trimmed, 1–500 characters) is required when `reason === 'other'`.
      - The refine message is the fixed string `'Enter a valid 12-digit Aadhaar number'`, which never echoes the value.
      - For `status: 'provided'`, `consent` must be `true`, and the message is `'Patient consent is required to record Aadhaar'`.
    - `abhaInputSchema`: a union on `status`. It is either `{ status: 'provided', abhaNumber?: string, abhaAddress?: string }` (normalised, validated, at least one present) or `{ status: 'unavailable', reason: enum(ABHA reasons), note?: string }` (`note` required when the reason is `other`).
    - `contactInputSchema`: `{ kind: enum(next_of_kin|guardian|emergency), name: string(1..120), relationship: enum(CONTACT_RELATIONSHIPS), phone: string → normalizePhone (non-null), addressText?: string(max 300), isPrimary?: boolean }`
    - `demographicsShape` (a plain object shape that is reused):
      - `name` (1..200)
      - `dob` (ISO date, not after `todayIsoIn()`)
      - `gender` (enum)
      - `maritalStatus?`, `bloodGroup?`
      - `occupation?` (max 100)
      - `nationality` (ISO alpha-2 `^[A-Z]{2}$`, default `'IN'`)
      - `religion?` (max 60)
      - `preferredLanguage?` (`LANGUAGES` code)
      - `email?` (`z.email()`)
      - `phone?` (`normalizePhone`, non-null)
      - `addressLine1` (1..200), `addressLine2?`
      - `city` (1..100), `district` (1..100)
      - `stateCode` (`isIndianStateCode`), `pinCode` (`isValidPinCode`)
      - `isMlc` (default false), `mlcNumber?` (max 50)
    - `patientRegistrationSchema`: `z.object({ ...demographicsShape, aadhaar: aadhaarInputSchema, abha: abhaInputSchema, kyc: z.object({ docType: z.enum(KYC_DOC_TYPES), docNumber: z.string().trim().min(1).max(40) }).optional(), contacts: z.array(contactInputSchema).max(5).default([]), currentProvider?, …the existing primary* insurance fields unchanged from route.ts:16-30 }).strict()`, followed by a `superRefine`:
      - If `ageOnDate(dob, todayIsoIn()) < 18` and no contact has `kind === 'guardian'`, add an issue at `['contacts']` with the message `'A guardian contact is required for a patient under 18'`.
      - If `isMlc` is false and `mlcNumber` is set, add an issue at `['mlcNumber']`.
    - `patientProfileUpdateSchema`: `z.object({ ...partial(demographicsShape), abha: abhaInputSchema.optional() }).strict()`. It has at least one key. It must reject `aadhaar`, `uhid`, `contacts` and `kyc`.
    - `contactsReplaceSchema = z.object({ contacts: z.array(contactInputSchema).max(5) }).strict()`
    - `guardianProblem(contacts: { kind: string }[], dobIso: string, todayIso: string): string | null`, used by both `superRefine` and the contacts route
    - Types: `PatientRegistrationInput = z.output<typeof patientRegistrationSchema>`, `PatientProfileUpdateInput`, `AadhaarInput`, `AbhaInput`, `ContactInput`

- [ ] **Step 1: Write the failing tests**

```ts
// reference.test.ts
it('lists exactly 36 unique ISO 3166-2:IN codes incl. 2023 renames', () => {
  const codes = INDIAN_STATES.map((s) => s.code); expect(new Set(codes).size).toBe(36)
  for (const c of ['IN-CG', 'IN-OD', 'IN-TS', 'IN-UK', 'IN-DH', 'IN-LA']) expect(isIndianStateCode(c)).toBe(true)
  for (const c of ['IN-OR', 'IN-CT', 'IN-TG', 'IN-UT', 'MH']) expect(isIndianStateCode(c)).toBe(false)
})
it.each([['110001', true], ['560034', true], ['011001', false], ['11001', false], ['1100011', false], ['11000a', false]])('PIN %s -> %s', (p, ok) => expect(isValidPinCode(p)).toBe(ok))
it('never offers Aadhaar as a KYC document type', () => { expect(KYC_DOC_TYPES as readonly string[]).not.toContain('aadhaar') })
it.each([['9876543210', '+919876543210'], ['+91 98765 43210', '+919876543210'], ['09876543210', '+919876543210'], ['+447700900123', '+447700900123'], ['5876543210', null], ['12345', null]])('phone %s', (i, o) => expect(normalizePhone(i)).toBe(o))
// patient-registration.test.ts -- `valid()` builds a minimal valid adult payload (dob 1990-01-01, IN-MH, PIN 400001, aadhaar provided 2345 6789 0124 with consent, abha unavailable not_created)
it('aadhaar union accepts spaced input and rejects bad checksum without echoing it', () => {
  expect(patientRegistrationSchema.parse(valid()).aadhaar).toEqual({ status: 'provided', number: '234567890124', consent: true })
  const r = patientRegistrationSchema.safeParse(valid({ aadhaar: { status: 'provided', number: '2345 6789 0125', consent: true } }))
  expect(r.success).toBe(false); expect(JSON.stringify(r.error!.flatten())).not.toMatch(/2345|6789|0125/)
})
it('requires consent to store Aadhaar', () => { expect(patientRegistrationSchema.safeParse(valid({ aadhaar: { status: 'provided', number: '234567890124', consent: false } })).success).toBe(false) })
it('accepts a decline and requires a note for reason other', () => {
  expect(patientRegistrationSchema.safeParse(valid({ aadhaar: { status: 'declined', reason: 'patient_declined' } })).success).toBe(true)
  expect(patientRegistrationSchema.safeParse(valid({ aadhaar: { status: 'declined', reason: 'other' } })).success).toBe(false)
})
it('rejects a registration with no aadhaar key at all (mandatory)', () => { const { aadhaar: _, ...rest } = valid(); expect(patientRegistrationSchema.safeParse(rest).success).toBe(false) })
it('requires a guardian contact for a patient under 18 on the Asia/Kolkata date', () => { /* vi.setSystemTime(new Date('2026-10-06T19:00:00Z')); dob '2008-10-07' (18 in IST) passes without guardian; dob '2008-10-08' fails at path ['contacts'] */ })
it('rejects a DOB after today', () => { /* dob = tomorrow in IST -> issue at ['dob'] */ })
it('profile update schema rejects an aadhaar key', () => { expect(patientProfileUpdateSchema.safeParse({ aadhaar: { status: 'declined', reason: 'emergency' } }).success).toBe(false) })
it('profile update schema rejects an empty object', () => { expect(patientProfileUpdateSchema.safeParse({}).success).toBe(false) })
it('normalises ABHA number with hyphens', () => { expect(patientRegistrationSchema.parse(valid({ abha: { status: 'provided', abhaNumber: '12-3456-7890-1234' } })).abha).toEqual({ status: 'provided', abhaNumber: '12345678901234' }) })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/india/reference.test.ts tests/lib/validation/patient-registration.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the three modules** with the interfaces above. Run `superRefine` on the object schema. Do not use `.refine` on individual fields for the guardian rule.

- [ ] **Step 4: Run the tests to verify they pass**

Run: same command as Step 2.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/india/reference.ts src/lib/india/phone.ts src/lib/validation/patient-registration.ts tests/lib/india/reference.test.ts tests/lib/validation/patient-registration.test.ts
git commit -m "feat(sp1): Indian reference data and registration/profile schemas"
```

---

### Task 5: UHID generator + configurable prefix

**Files:**
- Create: `src/lib/uhid.ts`, `src/lib/queries/uhid.ts`, `src/app/api/settings/uhid-prefix/route.ts`, `src/components/settings/UhidPrefixForm.tsx`
- Modify: `src/app/(dashboard)/settings/page.tsx`. Add `<UhidPrefixForm>` under `<PracticeInfoForm>` in `practiceTab`, and read the prefix through `getSettingsSummary`. Modify `src/lib/queries/settings.ts` so `getSettingsSummary` also returns `uhidPrefix`.
- Modify: `tests/api/rbac-route-gates.test.ts`. Add the import and a row.
- Test: `tests/lib/uhid.test.ts`, `tests/api/settings-uhid-prefix.test.ts`, `tests/components/settings/UhidPrefixForm.test.tsx`

**Interfaces:**
- Consumes: `verhoeffCheckDigit` and `verhoeffValidate` (Task 1), `uhidSeq` and `appSettings.uhidPrefix` (Task 3), and `MASTER_DATA_ADMIN_ROLES` (this task adds it to `role-policy.ts`; see below).
- Produces:
  - `src/lib/uhid.ts` (pure):
    - `UHID_PREFIX_PATTERN = /^[A-Z][A-Z0-9]{0,5}$/`
    - `UHID_SEQ_DIGITS = 8`
    - `formatUhid(prefix: string, seq: number): string`. The result is `prefix + seq zero-padded to 8 digits + Verhoeff check digit of those 8 digits`. It throws on a bad prefix, a non-integer, `seq < 1` or `seq > 99_999_999`.
    - `parseUhid(uhid: string): { prefix: string; seq: number } | null`, which returns null on a wrong checksum
    - `isValidUhidPrefix(p: string): boolean`
    - The signature takes **no patient data**, so a UHID holds no PHI.
  - `src/lib/queries/uhid.ts`:
    - `type DbExecutor = Pick<ReturnType<typeof getDb>, 'execute' | 'select'>`
    - `getUhidPrefix(executor?: DbExecutor): Promise<string>`
    - `setUhidPrefix(prefix: string): Promise<void>`
    - `nextUhid(executor: DbExecutor): Promise<string>`. It runs `select nextval('uhid_seq') as seq` through `executor.execute(sql…)`, then `formatUhid(await getUhidPrefix(executor), Number(seq))`.
  - `src/lib/role-policy.ts` gets `export const MASTER_DATA_ADMIN_ROLES: readonly Role[] = ['admin']`.
  - `PUT /api/settings/uhid-prefix`:
    - It is gated to `MASTER_DATA_ADMIN_ROLES`.
    - The body is `{ prefix: string }`, `.strict()`, refined with `isValidUhidPrefix`, so a bad body gives 400.
    - It calls `setUhidPrefix`, runs `logAudit(session, 'changed UHID prefix', null)`, and returns `{ ok: true, prefix }`.
  - `<UhidPrefixForm initialPrefix: string; isAdmin: boolean />`:
    - It shows a sample built with `formatUhid(prefix, 1)`.
    - Non-admins see it read-only.
    - The help text says "Changing the prefix affects new registrations only".

- [ ] **Step 1: Write the failing tests**

```ts
// uhid.test.ts
it('formats prefix + 8-digit sequence + Verhoeff digit', () => {
  expect(formatUhid('UH', 42)).toBe('UH000000427'); expect(formatUhid('UH', 1)).toBe('UH000000017'); expect(formatUhid('MH01', 100)).toBe('MH01000001002')
})
it('round-trips and rejects a typo', () => { expect(parseUhid('UH000000427')).toEqual({ prefix: 'UH', seq: 42 }); expect(parseUhid('UH000000428')).toBeNull(); expect(parseUhid('UH00000427')).toBeNull() })
it.each(['uh', '1UH', 'TOOLONGX', 'U-H', ''])('rejects prefix %s', (p) => expect(() => formatUhid(p, 1)).toThrow())
it.each([0, -1, 1.5, 100_000_000])('rejects seq %s', (n) => expect(() => formatUhid('UH', n)).toThrow())
// settings-uhid-prefix.test.ts -- vi.mock('@/lib/queries/uhid'); vi.mock('@/lib/audit'); requireSession mocked per role
it('403s every non-admin before parsing', async () => { /* for each of crc, pi, frontdesk, pharmacy, billing, labs: status 403, body {error:'Forbidden'}, setUhidPrefix not called */ })
it('400s an invalid prefix', async () => { /* admin, {prefix:'uh-1'} -> 400 */ })
it('saves a valid prefix and audits', async () => { /* admin, {prefix:'MH01'} -> 200 {ok:true,prefix:'MH01'}; setUhidPrefix called with 'MH01' */ })
// UhidPrefixForm.test.tsx
it('previews the first UHID for the typed prefix', () => { /* type 'AB' -> shows 'AB000000017' */ })
it('is read-only for non-admins', () => { /* isAdmin false -> no Save button, input disabled */ })
```

Harness row, added to `API_GATES`:

```ts
// MASTER_DATA_ADMIN_ROLES -- UHID prefix is practice configuration
{ name: 'PUT /api/settings/uhid-prefix', call: () => settle(() => putUhidPrefix(send('PUT', '/api/settings/uhid-prefix'))), allowed: [...MASTER_DATA_ADMIN_ROLES] },
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/uhid.test.ts tests/api/settings-uhid-prefix.test.ts tests/components/settings/UhidPrefixForm.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** the modules, route, form and settings wiring.

- [ ] **Step 4: Run the tests to verify they pass, plus the harness rows that need no DB**

Run: `npx vitest run tests/lib/uhid.test.ts tests/api/settings-uhid-prefix.test.ts tests/components/settings/UhidPrefixForm.test.tsx && npx vitest run tests/api/rbac-route-gates.test.ts -t "uhid-prefix" && npx vitest run tests/pages/nav-role-enforcement.test.tsx -t "/settings"`
Expected: PASS. The allowed half of the row reaches `settle` and gives 400 or 500, never 403.

- [ ] **Step 5: Commit**

```bash
git add src/lib/uhid.ts src/lib/queries/uhid.ts src/lib/queries/settings.ts src/lib/role-policy.ts src/app/api/settings/uhid-prefix src/components/settings/UhidPrefixForm.tsx "src/app/(dashboard)/settings/page.tsx" tests/lib/uhid.test.ts tests/api/settings-uhid-prefix.test.ts tests/components/settings/UhidPrefixForm.test.tsx tests/api/rbac-route-gates.test.ts
git commit -m "feat(sp1): UHID generator with configurable prefix"
```

---

### Task 6: Identity policy: roles, Aadhaar row builder, masked view, audit entries

**Files:**
- Modify: `src/lib/role-policy.ts`. Add the constants below.
- Modify: `src/lib/audit.ts`. Add the optional `details` parameter.
- Create: `src/lib/patient-identity.ts`
- Test: `tests/lib/patient-identity.test.ts`, `tests/lib/audit-details.test.ts`

**Interfaces:**
- Consumes: `encryptSensitive` (`src/lib/crypto.ts`), `normalizeAadhaar`, `aadhaarLast4` and `maskAadhaarLast4` (Task 1), `patientAadhaar` (Task 3), and `AadhaarInput` (Task 4).
- Produces:
  - `role-policy.ts`:
    ```ts
    export const REGISTRATION_ROLES: readonly Role[] = ['admin', 'frontdesk']
    export const PATIENT_PROFILE_EDIT_ROLES: readonly Role[] = ['admin', 'crc', 'frontdesk']
    export const AADHAAR_WRITE_ROLES: readonly Role[] = ['admin', 'crc', 'frontdesk']
    export const AADHAAR_MASKED_READ_ROLES: readonly Role[] = ['admin', 'crc']
    ```
  - `logAudit(session: Session, action: string, patientId: string | null, details?: string | null): Promise<void>`. It writes `details ?? null` into `audit_log.details`. Existing three-argument callers do not change.
  - `patient-identity.ts`:
    - `type NewPatientAadhaarRow = typeof patientAadhaar.$inferInsert`
    - `buildAadhaarRow(patientId: string, input: AadhaarInput, recordedByName: string, now: Date): NewPatientAadhaarRow`:
      - For `provided`, it sets `aadhaarEncrypted = encryptSensitive(number)`, `aadhaarLast4`, `consentGiven: true`, `consentRecordedAt: now`, and `declineReason`/`declineNote` null.
      - For `declined`, it sets `aadhaarEncrypted` and `aadhaarLast4` to null, `consentGiven: false`, `consentRecordedAt` null, and `declineReason`/`declineNote` from the input.
      - In both cases `updatedAt: now`.
    - `type AadhaarStatus = 'on_file' | 'declined' | 'not_recorded'`
    - `interface AadhaarSummary { status: AadhaarStatus; last4: string | null; declineReason: string | null; consentRecordedAt: Date | null; recordedByName: string | null }`
    - `toAadhaarSummary(row: Pick<typeof patientAadhaar.$inferSelect, 'aadhaarLast4' | 'declineReason' | 'consentRecordedAt' | 'recordedByName'> | null): AadhaarSummary`. The parameter type deliberately excludes `aadhaarEncrypted`.
    - `interface AadhaarView { status: AadhaarStatus; masked: string | null; declineReason: string | null }`
    - `toAadhaarView(summary: AadhaarSummary, role: Role): AadhaarView`. `masked` is set **only** when `AADHAAR_MASKED_READ_ROLES.includes(role)` and `status === 'on_file'`.
    - `interface IdentitySnapshot { aadhaarStatus: AadhaarStatus; aadhaarDeclineReason: string | null; abhaNumber: string | null; abhaAddress: string | null; abhaUnavailableReason: string | null; isMlc: boolean }`
    - `identityAuditEntries(before: IdentitySnapshot | null, after: IdentitySnapshot, aadhaarWritten: boolean): { action: string; details: string | null }[]`. It uses these exact action strings:
      - `'recorded Aadhaar with consent'` for a write that ends on file when the patient was not on file before
      - `'replaced Aadhaar'` for a write that ends on file when the patient was already on file
      - `'recorded Aadhaar decline'`, with details `` `reason: ${code}` ``
      - `'set ABHA number'`, `'changed ABHA number'`, `'removed ABHA number'`, and the same three for `ABHA address`
      - `'recorded ABHA unavailable'`, with details `` `reason: ${code}` ``
      - `'set MLC flag'` and `'cleared MLC flag'`
      - `before === null` means registration, and everything present in `after` is reported as "set" or "recorded".
      - No entry ever contains a number value.

- [ ] **Step 1: Write the failing tests**

```ts
// patient-identity.test.ts  (beforeEach stubEnv IDENTITY_ENCRYPTION_KEY)
it('buildAadhaarRow encrypts, keeps last4, records consent', () => {
  const row = buildAadhaarRow('TEST-SP1-1', { status: 'provided', number: '234567890124', consent: true }, 'Asha', new Date('2026-10-07T05:00:00Z'))
  expect(row.aadhaarEncrypted).not.toContain('234567890124'); expect(decryptSensitive(row.aadhaarEncrypted!)).toBe('234567890124')
  expect(row.aadhaarLast4).toBe('0124'); expect(row.consentGiven).toBe(true); expect(row.declineReason).toBeNull()
})
it('buildAadhaarRow for a decline nulls ciphertext and last4', () => {
  const row = buildAadhaarRow('TEST-SP1-1', { status: 'declined', reason: 'patient_declined' }, 'Asha', new Date())
  expect(row).toMatchObject({ aadhaarEncrypted: null, aadhaarLast4: null, consentGiven: false, declineReason: 'patient_declined' })
})
it('toAadhaarView shows last4 only to admin and crc', () => {
  const s = toAadhaarSummary({ aadhaarLast4: '0124', declineReason: null, consentRecordedAt: new Date(), recordedByName: 'Asha' })
  expect(toAadhaarView(s, 'admin').masked).toBe('XXXX XXXX 0124'); expect(toAadhaarView(s, 'crc').masked).toBe('XXXX XXXX 0124')
  for (const r of ['pi', 'frontdesk', 'pharmacy', 'billing', 'labs'] as const) expect(toAadhaarView(s, r)).toEqual({ status: 'on_file', masked: null, declineReason: null })
})
it('identityAuditEntries reports declined→on_file as recorded-with-consent', () => { /* before declined, after on_file, aadhaarWritten true -> [{action:'recorded Aadhaar with consent', details:null}] */ })
it('identityAuditEntries reports on_file→on_file write as replaced', () => {})
it('identityAuditEntries for a registration lists every set item and never contains digits', () => {
  const entries = identityAuditEntries(null, { aadhaarStatus: 'declined', aadhaarDeclineReason: 'emergency', abhaNumber: '12345678901234', abhaAddress: 'ravi.kumar@abdm', abhaUnavailableReason: null, isMlc: true }, true)
  expect(entries.map((e) => e.action)).toEqual(['recorded Aadhaar decline', 'set ABHA number', 'set ABHA address', 'set MLC flag'])
  expect(JSON.stringify(entries)).not.toMatch(/\d{4}|ravi/)
})
// audit-details.test.ts -- vi.mock('@/db/client') with an insert spy capturing .values()
it('writes details when given and null otherwise', async () => { /* logAudit(s,'x','P',"reason: emergency") -> values.details === 'reason: emergency'; 3-arg call -> details null */ })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/patient-identity.test.ts tests/lib/audit-details.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the role constants, the `logAudit` parameter and `patient-identity.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/lib/patient-identity.test.ts tests/lib/audit-details.test.ts tests/lib/crypto.test.ts` (the crypto test needs the key: run it with `IDENTITY_ENCRYPTION_KEY=$(node -e "console.log(Buffer.alloc(32,7).toString('base64'))")`, or skip it if it was already red before this task), then `npx tsc --noEmit`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/role-policy.ts src/lib/audit.ts src/lib/patient-identity.ts tests/lib/patient-identity.test.ts tests/lib/audit-details.test.ts
git commit -m "feat(sp1): Aadhaar row builder, masked view, identity audit entries and role constants"
```

---

### Task 7: Registration write path (`registerPatient` + `POST /api/patients`)

**Files:**
- Create: `src/lib/queries/patient-registration.ts`
- Modify: `src/app/api/patients/route.ts`:
  - replace `addClientSchema` (lines 16–30) with `patientRegistrationSchema`
  - move the RD-id logic (lines 59–71) into `registerPatient`
  - change the gate to `REGISTRATION_ROLES`
- Modify: `tests/api/patients-create.test.ts`. Update its payloads to the new schema and wrap it in `describe.skipIf(!process.env.DATABASE_URL)`.
- Modify: `tests/api/rbac-route-gates.test.ts`. Add `POST as postPatient` and a row.
- Test: `tests/api/patients-register.test.ts` (no DB), `tests/lib/queries/patient-registration.test.ts` (DB, skipIf)

**Interfaces:**
- Consumes:
  - `patientRegistrationSchema` and `PatientRegistrationInput` (Task 4)
  - `nextUhid` (Task 5)
  - `buildAadhaarRow` and `identityAuditEntries` (Task 6)
  - `REGISTRATION_ROLES` (Task 6)
  - `isUniqueViolation` and `pgConstraint` (Task 2)
  - `encryptSensitive`
  - `patients`, `patientContacts`, `patientAadhaar`, `identityVerifications`
- Produces:
  - `registerPatient(input: PatientRegistrationInput, recordedByName: string): Promise<{ id: string; uhid: string; auditEntries: { action: string; details: string | null }[] }>`. It runs in a single `getDb().transaction(async (tx) => …)`. Inside the transaction it:
    - computes the next `RD-####` id (the existing regex logic, moved verbatim)
    - calls `nextUhid(tx)`
    - inserts into `patients` the demographics, address and ABHA columns (or `abhaUnavailableReason`/`abhaUnavailableNote`), `isMlc` and `mlcNumber`. The legacy `zip` is left null.
    - inserts `contacts`
    - inserts `buildAadhaarRow(...)`
    - inserts the `kyc` row when it is present, into `identityVerifications` with `{ idType: kyc.docType, idNumberEncrypted: encryptSensitive(kyc.docNumber), verified: false }`
    - returns the entries from `identityAuditEntries(null, …, true)`
  - `POST /api/patients` responses:
    - 403 (gate first)
    - 400 `{ error: 'Invalid registration', details: parsed.error.flatten() }`
    - 400 for an unknown `primaryPayerId` (existing behaviour)
    - 409 `{ error: 'This ABHA number is already registered to another patient' }` or `{ error: 'This ABHA address is already registered to another patient' }`, from `isUniqueViolation(err, 'patients_abha_number_unique' | 'patients_abha_address_unique')`
    - 201 `{ id, uhid }`. The response must not include the created row.
    - After a 201 it calls `logAudit(session, 'registered patient', id)`, then one `logAudit(session, e.action, id, e.details)` for each audit entry, then `invalidateCache(patientListCacheKey(null))`.
  - The route never calls `console.*` with the body or the parsed data.

- [ ] **Step 1: Write the failing tests** `tests/api/patients-register.test.ts` (`vi.mock('@/lib/queries/patient-registration')`, `vi.mock('@/lib/audit')`, `vi.mock('@/lib/cache')`, `vi.mock('@/lib/queries/payers')`, and `requireSession` mocked per role)

```ts
it('403s crc, pi, pharmacy, billing, labs before parsing', async () => { /* body {} ; 403 {error:'Forbidden'}; registerPatient not called */ })
it('400 body never contains the submitted Aadhaar digits', async () => {
  const res = await POST(req({ ...valid(), aadhaar: { status: 'provided', number: '2345 6789 0125', consent: true } }))
  expect(res.status).toBe(400); expect(await res.text()).not.toMatch(/2345|6789|0125/)
})
it('400s a registration missing both Aadhaar and a decline reason', async () => {})
it('returns 201 {id, uhid} only and audits each identity entry', async () => {
  vi.mocked(registerPatient).mockResolvedValue({ id: 'RD-0100', uhid: 'UH000000427', auditEntries: [{ action: 'recorded Aadhaar with consent', details: null }] })
  const res = await POST(req(valid())); expect(res.status).toBe(201); expect(await res.json()).toEqual({ id: 'RD-0100', uhid: 'UH000000427' })
  expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'recorded Aadhaar with consent', 'RD-0100', null)
})
it('maps a unique violation on patients_abha_number_unique to 409', async () => {
  vi.mocked(registerPatient).mockRejectedValue({ message: 'Failed query', cause: { code: '23505', constraint: 'patients_abha_number_unique' } })
  expect((await POST(req(valid()))).status).toBe(409)
})
```

The DB test file `tests/lib/queries/patient-registration.test.ts` runs inside `describe.skipIf(!process.env.DATABASE_URL)`. It registers `TEST-SP1` fixtures and asserts:
- a row exists in `patient_aadhaar` whose ciphertext is not the plaintext
- `patients.uhid` matches `parseUhid`
- contacts were inserted
- a second registration with the same ABHA number throws `isUniqueViolation`
- afterEach deletes contacts, aadhaar, identity rows, audit rows and patients

Harness row:

```ts
// REGISTRATION_ROLES -- admin/frontdesk only (route.ts comment: crc removed by product direction)
{ name: 'POST /api/patients', call: () => settle(() => postPatient(send('POST', '/api/patients'))), allowed: [...REGISTRATION_ROLES] },
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/api/patients-register.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `registerPatient` and rewrite the POST handler. Leave `GET` unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/api/patients-register.test.ts tests/lib/queries/patient-registration.test.ts tests/api/patients-create.test.ts && npx vitest run tests/api/rbac-route-gates.test.ts -t "POST /api/patients"`
Expected: PASS. The DB files report skipped.

- [ ] **Step 5: Commit**

```bash
git add src/lib/queries/patient-registration.ts src/app/api/patients/route.ts tests/api/patients-register.test.ts tests/lib/queries/patient-registration.test.ts tests/api/patients-create.test.ts tests/api/rbac-route-gates.test.ts
git commit -m "feat(sp1): transactional patient registration with UHID, Aadhaar and ABHA"
```

---

### Task 8: Profile, contacts and Aadhaar update APIs

**Files:**
- Create: `src/lib/queries/patient-profile.ts`
- Create: `src/app/api/patients/[anonId]/profile/route.ts` (PATCH), `src/app/api/patients/[anonId]/contacts/route.ts` (PUT), `src/app/api/patients/[anonId]/aadhaar/route.ts` (PUT)
- Modify: `src/app/api/patients/[anonId]/identity/route.ts:13`. Change `verifySchema.idType` from `z.enum(['drivers_license', 'state_id', 'passport'])` to `z.enum(KYC_DOC_TYPES)` (Task 4), so staff can verify Indian KYC documents. Existing `state_id` rows stay readable because the enum value still exists.
- Modify: `src/lib/role-capabilities.ts`. Add bullets:
  - crc: `'Record or update a patient\'s Aadhaar with consent, seeing only its last 4 digits'`
  - frontdesk: `'Record a patient\'s Aadhaar with consent or the reason it was declined (the number is never shown back)'`
  - admin: `'Manage the department master and the UHID prefix'`
- Modify: `tests/api/rbac-route-gates.test.ts`. Extend `send` to `'POST' | 'PUT' | 'PATCH'` and add three rows.
- Test: `tests/api/patient-profile-routes.test.ts`, `tests/lib/queries/patient-profile.test.ts` (DB, skipIf)

**Interfaces:**
- Consumes:
  - Task 4 schemas, including `guardianProblem`
  - Task 6 `buildAadhaarRow`, `identityAuditEntries`, `toAadhaarSummary` and the role constants
  - Task 2 `isUniqueViolation` and `todayIsoIn`
  - `patientDetailCacheKey` and `invalidateCache` from `src/lib/cache.ts`
- Produces (in `patient-profile.ts`):
  - `getIdentitySnapshot(anonId: string): Promise<{ dob: string; snapshot: IdentitySnapshot } | null>`. It selects `aadhaarLast4` and `declineReason` only, **never** `aadhaarEncrypted`.
  - `updatePatientProfile(anonId: string, input: PatientProfileUpdateInput): Promise<boolean>`. `false` means not found. An `abha` value of `provided` sets the number/address and nulls the unavailable fields; `unavailable` does the reverse.
  - `replacePatientContacts(anonId: string, contacts: ContactInput[]): Promise<void>`. It deletes and then inserts, in one transaction.
  - `upsertPatientAadhaar(anonId: string, row: NewPatientAadhaarRow): Promise<void>`. It uses `onConflictDoUpdate` on `patientAadhaar.patientId`.
- Routes (each runs `requireSession`, then the gate, then `await params`, then parse, then the work; each returns 404 `{ error: 'Not found' }` for an unknown patient, then audits and calls `invalidateCache(patientDetailCacheKey(anonId))`):
  - `PATCH /profile` (`PATIENT_PROFILE_EDIT_ROLES`):
    - Body: `patientProfileUpdateSchema`.
    - Returns 409 on an ABHA unique violation, otherwise 200 `{ ok: true }`.
    - Audits `'updated patient profile'` plus the `identityAuditEntries(before, after, false)` entries.
  - `PUT /contacts` (`PATIENT_PROFILE_EDIT_ROLES`):
    - Body: `contactsReplaceSchema`.
    - Returns 400 `{ error: <guardianProblem message> }` when the patient is a minor.
    - Audits `'updated patient contacts'`.
  - `PUT /aadhaar` (`AADHAAR_WRITE_ROLES`):
    - Body: `aadhaarInputSchema`, with `.strict()` on each branch.
    - Calls `upsertPatientAadhaar(anonId, buildAadhaarRow(anonId, input, session.name, new Date()))`.
    - Returns 200 `{ status }`. It returns no last4, even to admin/crc, because the page re-reads the record.
    - Audits through `identityAuditEntries(before, after, true)`.

- [ ] **Step 1: Write the failing tests** (`vi.mock('@/lib/queries/patient-profile')`, `vi.mock('@/lib/audit')`, `vi.mock('@/lib/cache')`)

```ts
it('PATCH profile with an aadhaar key 400s and never calls updatePatientProfile', async () => {})
it('PATCH profile 403s pi, pharmacy, billing, labs with {error:"Forbidden"}', async () => {})
it('PATCH profile maps patients_abha_address_unique to 409', async () => {})
it('PATCH profile invalidates the patient detail cache', async () => { /* expect(invalidateCache).toHaveBeenCalledWith(patientDetailCacheKey('RD-0001')) */ })
it('PUT contacts rejects removing the guardian of a minor', async () => { /* getIdentitySnapshot -> dob 2015-01-01; body contacts [] -> 400 'A guardian contact is required for a patient under 18' */ })
it('PUT aadhaar lets crc write and returns only the status', async () => {
  /* stubEnv key; role crc; body provided 234567890124 consent -> 200 {status:'on_file'}; body text has no '0124' */
})
it('PUT aadhaar 403s pi before reading the body', async () => {})
it('PUT aadhaar audits a decline with its reason and no digits', async () => {})
it('PUT identity accepts voter_id and pan and rejects aadhaar as a KYC type', async () => { /* role frontdesk; idType 'aadhaar' -> 400 */ })
```

Add three harness rows, each wrapped in `settle`, using `ctx({ anonId: BOGUS_PATIENT })`:

```ts
{ name: 'PATCH /api/patients/[anonId]/profile', call: () => settle(() => patchProfile(send('PATCH', `/api/patients/${BOGUS_PATIENT}/profile`), ctx({ anonId: BOGUS_PATIENT }))), allowed: [...PATIENT_PROFILE_EDIT_ROLES] },
{ name: 'PUT /api/patients/[anonId]/contacts', call: () => settle(() => putContacts(send('PUT', `/api/patients/${BOGUS_PATIENT}/contacts`), ctx({ anonId: BOGUS_PATIENT }))), allowed: [...PATIENT_PROFILE_EDIT_ROLES] },
{ name: 'PUT /api/patients/[anonId]/aadhaar', call: () => settle(() => putAadhaar(send('PUT', `/api/patients/${BOGUS_PATIENT}/aadhaar`), ctx({ anonId: BOGUS_PATIENT }))), allowed: [...AADHAAR_WRITE_ROLES] },
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/api/patient-profile-routes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the query module, the three routes and the capability bullets.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/api/patient-profile-routes.test.ts tests/lib/role-capabilities.test.ts tests/lib/queries/patient-profile.test.ts && npx vitest run tests/api/rbac-route-gates.test.ts -t "/api/patients/\[anonId\]/(profile|contacts|aadhaar)" && npx vitest run tests/api/rbac-route-gates.test.ts -t "gap tag"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/queries/patient-profile.ts "src/app/api/patients/[anonId]/profile" "src/app/api/patients/[anonId]/contacts" "src/app/api/patients/[anonId]/aadhaar" "src/app/api/patients/[anonId]/identity/route.ts" src/lib/role-capabilities.ts tests/api/patient-profile-routes.test.ts tests/lib/queries/patient-profile.test.ts tests/api/rbac-route-gates.test.ts
git commit -m "feat(sp1): patient profile, contacts and Aadhaar update APIs"
```

---

### Task 9: Read model + no-leak guards

**Files:**
- Modify: `src/lib/queries/patients.ts`, in `getPatientDetail` (lines 130–172). Add `contacts` and `aadhaar: AadhaarSummary`. The `aadhaar` select uses only `aadhaarLast4`, `declineReason`, `consentRecordedAt` and `recordedByName`.
- Modify: `src/app/api/patients/[anonId]/route.ts`, in `GET`. Return `{ ...detail, aadhaar: toAadhaarView(detail.aadhaar, session.role) }`.
- Modify: `src/lib/queries/patient-portal.ts`, in `getPatientPortalData` (line 16). Add `profile: PortalProfile`.
- Test: `tests/lib/no-aadhaar-leak.test.ts`, `tests/api/patient-detail-redaction.test.ts`

**Interfaces:**
- Consumes: Task 6 `toAadhaarSummary`, `toAadhaarView` and `AadhaarSummary`; and `patientContacts` and `patientAadhaar`.
- Produces:
  - The `getPatientDetail(anonId)` return gains `contacts: (typeof patientContacts.$inferSelect)[]` and `aadhaar: AadhaarSummary`.
  - `interface PortalProfile { uhid: string | null; abhaAddress: string | null; abhaNumberMasked: string | null; addressSummary: string | null; emergencyContactName: string | null; aadhaarOnFile: boolean }`, exported from `patient-portal.ts`:
    - `abhaNumberMasked` is `` `XX-XXXX-XXXX-${last4}` ``.
    - `addressSummary` is `` `${city}, ${district}, ${stateName(stateCode)} ${pinCode}` `` when every part is present.

- [ ] **Step 1: Write the failing tests**

```ts
// no-aadhaar-leak.test.ts -- static source scan, no DB. walk(p) returns repo-root-relative POSIX paths of .ts/.tsx files under p (or p itself if a file)
const EXPORT_PATHS = ['src/lib/fhir', 'src/lib/excel-export.ts', 'src/app/api/workbook', 'src/app/api/patients/[anonId]/fhir', 'src/app/api/patients/[anonId]/ccda', 'src/app/api/search', 'src/lib/queries/search.ts', 'src/lib/queries/workbook.ts']
it.each(EXPORT_PATHS)('%s never references Aadhaar', (p) => { for (const f of walk(p)) expect(readFileSync(f, 'utf8'), f).not.toMatch(/aadhaar/i) })
it('no source file selects aadhaarEncrypted outside the identity writer and its tests', () => {
  const offenders = walk('src').filter((f) => /aadhaarEncrypted/.test(readFileSync(f, 'utf8')))
  expect(offenders.sort()).toEqual(['src/db/schema.ts', 'src/lib/patient-identity.ts'])
})
it('no route puts aadhaar in a URL or search param', () => { for (const f of walk('src/app')) expect(readFileSync(f, 'utf8'), f).not.toMatch(/searchParams\.get\(['"]aadhaar/i) })
// patient-detail-redaction.test.ts -- vi.mock('@/lib/queries/patients') getPatientDetail -> { id:'RD-0001', ..., aadhaar: { status:'on_file', last4:'0124', ... } }
it('GET /api/patients/[anonId] gives pi the status without last4', async () => { /* role pi -> body.aadhaar = {status:'on_file', masked:null, declineReason:null}; text has no '0124' */ })
it('GET /api/patients/[anonId] gives crc the masked value', async () => {})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/no-aadhaar-leak.test.ts tests/api/patient-detail-redaction.test.ts`
Expected: FAIL. The redaction test fails, and the leak test fails until `patient-identity.ts` is the only reader.

- [ ] **Step 3: Implement** the query and route changes and `PortalProfile`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: same command as Step 2, then `npx tsc --noEmit`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/queries/patients.ts src/lib/queries/patient-portal.ts "src/app/api/patients/[anonId]/route.ts" tests/lib/no-aadhaar-leak.test.ts tests/api/patient-detail-redaction.test.ts
git commit -m "feat(sp1): patient detail carries contacts and role-redacted Aadhaar; leak guards"
```

---

### Task 10: Registration form UI

**Files:**
- Create: `src/components/registration/registration-form-state.ts`, `DemographicsSection.tsx`, `AddressSection.tsx`, `NationalIdSection.tsx`, `ContactsSection.tsx`
- Modify: `src/components/AddClientModal.tsx`. Compose the sections. The insurance block stays as it is. Submit `toRegistrationPayload(form)`. Run `patientRegistrationSchema.safeParse` client-side and show field errors. On a 201, push `/patients/${id}`. Clear the Aadhaar input from state after submit, whether it succeeded or failed.
- Test: `tests/lib/registration-form-state.test.ts`, `tests/components/AddClientModal.test.tsx` (extend), `tests/components/registration/NationalIdSection.test.tsx`, `tests/components/registration/ContactsSection.test.tsx`

**Interfaces:**
- Consumes: Task 4 schemas and reference lists, and Task 1 `formatAbhaNumber`.
- Produces:
  - `registration-form-state.ts`: `interface RegistrationFormState`, a flat set of string/boolean fields plus `contacts: ContactDraft[]`, `aadhaarMode: 'provided' | 'declined'` and `abhaMode: 'provided' | 'unavailable'`. Also `EMPTY_REGISTRATION_FORM: RegistrationFormState` (nationality `'IN'`, `aadhaarMode` `'provided'`, `abhaMode` `'provided'`), `toRegistrationPayload(form: RegistrationFormState): unknown` (empty strings become omitted keys), and `fieldErrors(payload: unknown): Record<string, string>` (dotted paths taken from zod issues).
  - Each section has the props `{ form: RegistrationFormState; update: <K extends keyof RegistrationFormState>(k: K, v: RegistrationFormState[K]) => void; errors: Record<string, string> }`.
  - `NationalIdSection` behaviour:
    - The Aadhaar input has `inputMode="numeric"`, `autoComplete="off"` and `aria-label="Aadhaar number"`.
    - A required consent checkbox reads "Patient consents to recording their Aadhaar number".
    - A "Patient does not provide Aadhaar" toggle reveals the decline-reason select and a note.
    - ABHA number and ABHA address inputs each carry an "ABDM not connected" hint.
    - An "ABHA not available" toggle reveals the reason and note.
    - It also holds the KYC doc type select (from `KYC_DOC_TYPES`), the doc number, and the MLC checkbox with the MLC number.
  - The modal title stays "Add New Patient". The subtitle keeps `brandName` from `useBrand()`.

- [ ] **Step 1: Write the failing tests**

```ts
// registration-form-state.test.ts
it('maps an empty optional field to an omitted key and builds the aadhaar union', () => {
  const p = toRegistrationPayload({ ...EMPTY_REGISTRATION_FORM, name: 'A', aadhaarMode: 'declined', aadhaarDeclineReason: 'emergency' }) as Record<string, unknown>
  expect(p).not.toHaveProperty('email'); expect(p.aadhaar).toEqual({ status: 'declined', reason: 'emergency' })
})
it('fieldErrors keys a minor-without-guardian issue at contacts', () => {})
// NationalIdSection.test.tsx
it('hides the Aadhaar input and shows reason select when declined', () => {})
it('Aadhaar input is numeric and autocomplete-off', () => { /* getByLabelText('Aadhaar number') has inputmode numeric, autocomplete off */ })
it('never offers Aadhaar in the KYC document type select', () => {})
// ContactsSection.test.tsx
it('adds and removes contact rows up to five', () => {})
// AddClientModal.test.tsx (keep the existing two tests)
it('shows a checksum error and does not POST for a bad Aadhaar', async () => { /* fill required fields, Aadhaar '234567890125', click Save -> 'Enter a valid 12-digit Aadhaar number'; fetch not called with /api/patients */ })
it('shows the guardian error for a minor', async () => {})
it('clears the Aadhaar field after a failed submit', async () => { /* fetch -> 400; Aadhaar input value '' */ })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/registration-form-state.test.ts tests/components/AddClientModal.test.tsx tests/components/registration`
Expected: FAIL.

- [ ] **Step 3: Implement** the state helper, the four sections and the modal composition. Use the existing input class string from `AddClientModal.tsx` for consistency. Labels follow Indian usage: "PIN code", "State / UT", "District", "Address line 1".

- [ ] **Step 4: Run the tests to verify they pass**

Run: same command as Step 2, then `npx eslint src/components/registration src/components/AddClientModal.tsx`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/registration src/components/AddClientModal.tsx tests/lib/registration-form-state.test.ts tests/components/AddClientModal.test.tsx tests/components/registration
git commit -m "feat(sp1): Indian registration form with Aadhaar consent/decline and ABHA"
```

---

### Task 11: Patient profile tab + portal "Your details"

**Files:**
- Create: `src/components/patient-profile/PatientProfilePanel.tsx`, `EditPatientProfileModal.tsx`, `AadhaarPanel.tsx`
- Modify: `src/app/(dashboard)/patients/[anonId]/page.tsx`:
  - Add a `{ id: 'profile', label: 'Profile', content: profileTab }` tab, **first** for every role, so front desk sees it too.
  - Show the UHID in the header line (line 189): `{patient.uhid ?? patient.id} · DOB …`.
- Modify: `src/app/patient-portal/(authenticated)/page.tsx`. Add a "Your details" `SECTION` after the care-team grid.
- Test: `tests/components/patient-profile/PatientProfilePanel.test.tsx`, `tests/components/patient-profile/AadhaarPanel.test.tsx`, `tests/pages/patient-detail-profile-tab.test.tsx`, `tests/pages/patient-portal-overview.test.tsx` (extend the mock with `profile`)

**Interfaces:**
- Consumes: `getPatientDetail` (Task 9), `toAadhaarView` and the role constants (Task 6), the routes from Task 8, the reference labels from Task 4, `formatAbhaNumber` (Task 1), and `PortalProfile` (Task 9).
- Produces:
  - `<PatientProfilePanel patient={ProfileView} aadhaar={AadhaarView} canEdit: boolean canWriteAadhaar: boolean />`. Here `type ProfileView = Pick<detail, 'id' | 'uhid' | 'gender' | 'maritalStatus' | 'bloodGroup' | 'occupation' | 'nationality' | 'religion' | 'preferredLanguage' | 'addressLine1' | 'addressLine2' | 'city' | 'district' | 'stateCode' | 'pinCode' | 'phone' | 'email' | 'abhaNumber' | 'abhaAddress' | 'abhaUnavailableReason' | 'isMlc' | 'mlcNumber' | 'contacts'>`.
  - The ABHA number is displayed through `formatAbhaNumber`. The MLC flag is a visible badge "MLC".
  - `<AadhaarPanel anonId view={AadhaarView} canWrite: boolean />`:
    - It shows `view.masked`, or "On file", "Declined — <reason label>" or "Not recorded".
    - "Record Aadhaar" opens a modal that PUTs `/api/patients/[anonId]/aadhaar` and calls `router.refresh()`.
  - `<EditPatientProfileModal>` PATCHes `/profile` and PUTs `/contacts`.
  - Page wiring:
    - `canEdit = PATIENT_PROFILE_EDIT_ROLES.includes(session.role)`
    - `canWriteAadhaar = AADHAAR_WRITE_ROLES.includes(session.role)`
    - `aadhaar = toAadhaarView(patient.aadhaar, session.role)`. Compute this **on the server**; never pass the summary's `last4` to a client component.
  - The portal section shows the UHID, the ABHA address, `abhaNumberMasked`, the address summary and the emergency contact name. For Aadhaar it shows only "On file" or "Not on file".

- [ ] **Step 1: Write the failing tests**

```ts
// AadhaarPanel.test.tsx
it('renders the masked value when given', () => { /* view {status:'on_file', masked:'XXXX XXXX 0124'} -> text 'XXXX XXXX 0124' */ })
it('renders On file with no digits when masked is null', () => {})
it('hides Record Aadhaar when canWrite is false', () => {})
// PatientProfilePanel.test.tsx
it('formats ABHA number, state name and shows the MLC badge', () => { /* abhaNumber '12345678901234' -> '12-3456-7890-1234'; stateCode 'IN-MH' -> 'Maharashtra'; isMlc -> 'MLC' */ })
// patient-detail-profile-tab.test.tsx -- mock requireSessionOrRedirect, getPatientDetail (aadhaar.last4 '0124'), admissions/rooms queries, logAudit
it.each([['frontdesk', false], ['pi', false], ['crc', true], ['admin', true]])('role %s sees last4: %s', async (role, shows) => { /* render page; queryByText(/0124/) presence === shows */ })
it('frontdesk sees the Profile tab', async () => {})
// patient-portal-overview.test.tsx
it('shows Your details with UHID and Aadhaar on-file status but no digits', async () => {})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/components/patient-profile tests/pages/patient-detail-profile-tab.test.tsx tests/pages/patient-portal-overview.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** the components and the page edits.

- [ ] **Step 4: Run the tests to verify they pass, along with the existing gate rows for these pages**

Run: same command as Step 2, then `npx vitest run tests/pages/nav-role-enforcement.test.tsx -t "/patients" tests/pages/patients-frontdesk-view.test.tsx tests/pages/patient-detail-inpatient-tab.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/patient-profile "src/app/(dashboard)/patients/[anonId]/page.tsx" "src/app/patient-portal/(authenticated)/page.tsx" tests/components/patient-profile tests/pages/patient-detail-profile-tab.test.tsx tests/pages/patient-portal-overview.test.tsx
git commit -m "feat(sp1): patient profile tab with masked Aadhaar and portal details"
```

---

### Task 12: FHIR Patient mapping (UHID, ABHA, gender, address; never Aadhaar)

**Files:**
- Create: `src/lib/fhir/identifier-systems.ts`, `tests/fixtures/patient-row.ts`
- Modify: `src/lib/fhir/patient.ts`
- Modify: `tests/lib/fhir/patient-mapping.test.ts`. Rewrite it as a pure test with `makePatientRow`, removing the DB insert.
- Test: `tests/lib/fhir/patient-mapping.test.ts`

**Interfaces:**
- Consumes: the `patients` columns (Task 3), `stateName` (Task 4) and `formatAbhaNumber` (Task 1).
- Produces:
  - `identifier-systems.ts`:
    - `ABHA_NUMBER_SYSTEM = 'https://healthid.abdm.gov.in'`
    - `ABHA_ADDRESS_SYSTEM = 'https://healthid.abdm.gov.in/abha-address'`
    - `uhidSystem(): string`, which returns `` `${process.env.NEXT_PUBLIC_APP_URL}/fhir/sid/uhid` `` when that is set, else `'urn:x-local:uhid'`
    - These systems are provisional and must be confirmed against the NRCeS/ABDM profiles in SP8 (see Execution notes).
  - `FhirPatient` gains `gender?: 'male' | 'female' | 'other' | 'unknown'`, `address?: { line: string[]; city?: string; district?: string; state?: string; postalCode?: string; country: string }[]` and `identifier: { system?: string; type?: { text: string }; value: string }[]`.
  - `patientToFhir(patient)` keeps its signature. Identifiers, in this order:
    - `{ value: patient.id }` (unchanged, for back-compatibility)
    - then, when the UHID is present, `{ system: uhidSystem(), type: { text: 'UHID' }, value: uhid }`
    - then `{ system: ABHA_NUMBER_SYSTEM, type: { text: 'ABHA Number' }, value: formatAbhaNumber(abhaNumber) }`
    - then `{ system: ABHA_ADDRESS_SYSTEM, type: { text: 'ABHA Address' }, value: abhaAddress }`
  - Gender mapping: male→male, female→female, transgender→other, other→other, unknown→unknown, and null→omitted.
  - `address` is present only when `addressLine1` is set. `state = stateName(stateCode)` and `country = nationality === 'IN' || !nationality ? 'IN' : nationality`.
  - `tests/fixtures/patient-row.ts`: `makePatientRow(overrides?: Partial<typeof patients.$inferSelect>): typeof patients.$inferSelect` fills every column with its null or default.

- [ ] **Step 1: Write the failing tests**

```ts
it('keeps the local id identifier first and adds UHID and ABHA identifiers', () => {
  const f = patientToFhir(makePatientRow({ id: 'RD-0001', uhid: 'UH000000427', abhaNumber: '12345678901234', abhaAddress: 'ravi.kumar@abdm' }))
  expect(f.identifier[0]).toEqual({ value: 'RD-0001' })
  expect(f.identifier.map((i) => i.type?.text)).toEqual([undefined, 'UHID', 'ABHA Number', 'ABHA Address'])
  expect(f.identifier[2].value).toBe('12-3456-7890-1234')
})
it('omits gender when unknown to the record and maps transgender to other', () => {
  expect(patientToFhir(makePatientRow())).not.toHaveProperty('gender'); expect(patientToFhir(makePatientRow({ gender: 'transgender' })).gender).toBe('other')
})
it('maps the structured Indian address', () => { /* IN-KA, Bengaluru Urban, 560034 -> state 'Karnataka', postalCode '560034', country 'IN' */ })
it('never emits an Aadhaar identifier even if a caller smuggles the field in', () => {
  const f = patientToFhir({ ...makePatientRow(), aadhaar: '234567890124' } as never)
  expect(JSON.stringify(f)).not.toMatch(/aadhaar|234567890124/i)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/lib/fhir/patient-mapping.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the mapping. Build the output from named columns only, with no spread of `patient`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/lib/fhir/patient-mapping.test.ts tests/lib/no-aadhaar-leak.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/fhir/identifier-systems.ts src/lib/fhir/patient.ts tests/fixtures/patient-row.ts tests/lib/fhir/patient-mapping.test.ts
git commit -m "feat(sp1): FHIR Patient carries UHID, ABHA, gender and address, never Aadhaar"
```

---

### Task 13: Department master API + Settings "Departments" tab

**Files:**
- Create: `src/app/api/departments/route.ts` (GET, POST), `src/app/api/departments/[id]/route.ts` (PATCH), `src/components/settings/DepartmentsPanel.tsx`
- Modify: `src/app/(dashboard)/settings/page.tsx`. Add a `departments` tab (lucide `Building`), loaded with `listDepartments()`, and editable only when `isAdmin`.
- Modify: `src/db/seed.ts`. Seed reference departments: `GEN_MED` General Medicine, `GEN_SURG` General Surgery, `PAED` Paediatrics, `OBG` Obstetrics & Gynaecology, `ORTHO` Orthopaedics, `CARDIO` Cardiology, `EMERG` Emergency, `LAB` Laboratory (diagnostic), `RADIO` Radiology (diagnostic), `PHARM` Pharmacy (support), `ADMIN` Administration (administrative). Delete them in `clearExistingData` after `providers`.
- Modify: `tests/api/rbac-route-gates.test.ts`. Add three rows.
- Test: `tests/api/departments.test.ts`, `tests/components/settings/DepartmentsPanel.test.tsx`

**Interfaces:**
- Consumes: Task 2 `departments` queries, `DEPARTMENT_CODE_PATTERN` and `isUniqueViolation`; Task 5 `MASTER_DATA_ADMIN_ROLES`; and `ALL_ROLES`.
- Produces:
  - `GET /api/departments?active=1`: any staff role (`ALL_ROLES`). Returns `Department[]`.
  - `POST /api/departments`:
    - Gated to `MASTER_DATA_ADMIN_ROLES`.
    - Body: `{ code, name, kind }`, `.strict()`. The code is upper-cased and must match `DEPARTMENT_CODE_PATTERN`.
    - Returns 409 `{ error: 'Department code already exists' }` on `departments_code_unique`, otherwise 201 `Department`.
    - Audits `` `created department ${code}` ``.
  - `PATCH /api/departments/[id]`:
    - Gated to `MASTER_DATA_ADMIN_ROLES`.
    - Body: `{ name?, kind?, isActive? }`, `.strict()`, with at least one key.
    - Returns 400 for a non-integer id and 404 for an unknown one.
    - Audits `` `updated department ${code}` `` or `` `deactivated department ${code}` ``. The code is immutable.
  - `<DepartmentsPanel departments: Department[]; isAdmin: boolean />` shows a list with an inline add form and an active toggle.
  - SP2 consumes `departments(id, name, code)` from Task 2 and `GET /api/departments` for its pickers.

- [ ] **Step 1: Write the failing tests** (mock `@/lib/queries/departments`)

```ts
it('GET admits every staff role', async () => {})
it('POST 403s every non-admin before parsing', async () => {})
it('POST upper-cases and validates the code', async () => { /* 'card' -> createDepartment called with code 'CARD'; '1X' -> 400 */ })
it('POST maps departments_code_unique to 409', async () => {})
it('PATCH rejects a code change (strict)', async () => {})
// DepartmentsPanel.test.tsx
it('shows add form only to admins', () => {})
it('lists inactive departments with an Inactive badge', () => {})
```

Harness rows:

```ts
{ name: 'GET /api/departments', call: () => settle(() => listDepartmentsRoute(get('/api/departments'))), allowed: [...ALL_ROLES] },
{ name: 'POST /api/departments', call: () => settle(() => postDepartment(send('POST', '/api/departments'))), allowed: [...MASTER_DATA_ADMIN_ROLES] },
{ name: 'PATCH /api/departments/[id]', call: () => settle(() => patchDepartment(send('PATCH', `/api/departments/${BOGUS_ID}`), ctx({ id: BOGUS_ID }))), allowed: [...MASTER_DATA_ADMIN_ROLES] },
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/api/departments.test.ts tests/components/settings/DepartmentsPanel.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** the routes, the panel, the settings tab and the seed rows.

- [ ] **Step 4: Run the tests to verify they pass**

Run: same command as Step 2, then `npx vitest run tests/api/rbac-route-gates.test.ts -t "departments" && npx vitest run tests/pages/nav-role-enforcement.test.tsx -t "/settings"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/departments src/components/settings/DepartmentsPanel.tsx "src/app/(dashboard)/settings/page.tsx" src/db/seed.ts tests/api/departments.test.ts tests/components/settings/DepartmentsPanel.test.tsx tests/api/rbac-route-gates.test.ts
git commit -m "feat(sp1): department master API and settings tab"
```

---

### Task 14: Doctor registration (NMC/SMC), consultation fee and department on providers

**Files:**
- Create: `src/lib/validation/provider-profile.ts`
- Modify: `src/app/api/providers/[id]/route.ts`. Accept the extended schema. Change the 403 body to exactly `{ error: 'Forbidden' }` and gate with `MASTER_DATA_ADMIN_ROLES`.
- Modify: `src/lib/queries/providers.ts`. Replace `updateProviderName` with `updateProviderProfile`, and keep `updateProviderName` as a thin wrapper.
- Modify: `src/components/settings/ProviderProfilesPanel.tsx`. Extend `ProviderRow` and the edit form: a department select (from the `departments` prop), a council select, the state when SMC, the registration number, and the fee in rupees.
- Modify: `src/app/(dashboard)/settings/page.tsx`. Pass `departments` to `ProviderProfilesPanel`.
- Modify: `tests/api/rbac-route-gates.test.ts`. Add a row.
- Test: `tests/lib/validation/provider-profile.test.ts`, `tests/api/providers-profile.test.ts`, `tests/components/settings/ProviderProfilesPanel.test.tsx`

**Interfaces:**
- Consumes: Task 2 `parseRupeesToPaise`, `formatPaise` and `getDepartmentById`; Task 4 `isIndianStateCode`; Task 3 provider columns; and Task 5 `MASTER_DATA_ADMIN_ROLES`.
- Produces:
  - `providerProfileSchema = z.object({ name?, departmentId?: int | null, registrationCouncil?: 'nmc' | 'smc' | null, registrationStateCode?: string | null, registrationNumber?: string | null, consultationFeePaise?: int ≥ 0 ≤ 100_000_00 | null }).strict()`, with these rules:
    - It has at least one key.
    - `registrationStateCode` must be a valid `isIndianStateCode` value when `smc`, and must be absent or null when `nmc`.
    - `registrationNumber` is trimmed and matches `/^[A-Za-z0-9\/-]{1,20}$/`.
    - The fee is in paise. The UI converts with `parseRupeesToPaise`.
  - `updateProviderProfile(id: number, patch: ProviderProfileInput): Promise<typeof providers.$inferSelect | null>`, which invalidates `providersListCacheKey()`.
  - The route returns 400 for an unknown `departmentId`, via `getDepartmentById`. It audits `'updated provider profile'`, plus `'changed provider consultation fee'` when the fee changes. The details are `` `${formatPaise(old ?? 0)} → ${formatPaise(new ?? 0)}` ``, with no PHI.

- [ ] **Step 1: Write the failing tests**

```ts
it('requires a state for SMC and forbids one for NMC', () => {
  expect(providerProfileSchema.safeParse({ registrationCouncil: 'smc', registrationNumber: 'MMC/2011/12345' }).success).toBe(false)
  expect(providerProfileSchema.safeParse({ registrationCouncil: 'smc', registrationStateCode: 'IN-MH', registrationNumber: 'MMC/2011/12345' }).success).toBe(true)
  expect(providerProfileSchema.safeParse({ registrationCouncil: 'nmc', registrationStateCode: 'IN-MH', registrationNumber: '12345' }).success).toBe(false)
})
it('rejects a negative or fractional fee', () => { for (const v of [-1, 10.5]) expect(providerProfileSchema.safeParse({ consultationFeePaise: v }).success).toBe(false) })
it('route 403 body is exactly {error:"Forbidden"} for crc', async () => {})
it('route 400s an unknown departmentId', async () => {})
it('panel shows the fee as ₹ and converts rupee input to paise on save', async () => { /* type '500' -> PUT body consultationFeePaise 50000 */ })
```

Harness row:

```ts
{ name: 'PUT /api/providers/[id]', call: () => settle(() => putProvider(send('PUT', `/api/providers/${BOGUS_ID}`), ctx({ id: BOGUS_ID }))), allowed: [...MASTER_DATA_ADMIN_ROLES] },
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/validation/provider-profile.test.ts tests/api/providers-profile.test.ts tests/components/settings/ProviderProfilesPanel.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the tests to verify they pass, along with the whole no-DB harness slice for SP1**

Run: same command as Step 2, then `npx vitest run tests/api/rbac-route-gates.test.ts -t "providers|departments|uhid-prefix|/api/patients" && npx vitest run tests/pages/nav-role-enforcement.test.tsx && npx tsc --noEmit && npx eslint src`
Expected: PASS. The `/api/patients` GET rows may fail without a DB, because they predate SP1. If so, record them as "DB-only" in the task report and do not change them.

- [ ] **Step 5: Commit**

```bash
git add src/lib/validation/provider-profile.ts "src/app/api/providers/[id]/route.ts" src/lib/queries/providers.ts src/components/settings/ProviderProfilesPanel.tsx "src/app/(dashboard)/settings/page.tsx" tests/lib/validation/provider-profile.test.ts tests/api/providers-profile.test.ts tests/components/settings/ProviderProfilesPanel.test.tsx tests/api/rbac-route-gates.test.ts
git commit -m "feat(sp1): provider NMC/SMC registration, consultation fee and department"
```

---

## Execution notes

**Tests that cannot run here (no `DATABASE_URL`).** These are written now and skip via `describe.skipIf`:
- Task 2: the `departments (DB)` duplicate-code test
- Task 3: the `patient master (DB)` check-constraint test
- Task 7: `tests/lib/queries/patient-registration.test.ts` and the now-guarded `tests/api/patients-create.test.ts`
- Task 8: `tests/lib/queries/patient-profile.test.ts`
- The allowed-role half of every `API_GATES` row predating SP1 that hits the DB

Once the HIMS Neon DB is connected, in this order:
1. Apply `scripts/migrations/2026-10-07-sp1-departments.sql`, then `…-sp1-patient-master.sql`.
2. Run `npm test`, which includes `tests/lib/queries/delete-patient-fk-guard.test.ts`; it must see `patient_contacts` and `patient_aadhaar` covered.

**Suggested model tier per task:**

| Task | Tier |
|---|---|
| 1 Validators | cheap |
| 2 Shared foundation | standard |
| 3 Schema + migration | most capable (SQL idempotency, check constraint, enum `ADD VALUE`) |
| 4 Schemas | standard |
| 5 UHID | cheap |
| 6 Identity policy | most capable (the security boundary) |
| 7 Registration write | most capable |
| 8 Update APIs | standard |
| 9 Read model + leak guards | most capable |
| 10 Registration UI | standard |
| 11 Profile/portal UI | standard |
| 12 FHIR | cheap |
| 13 Departments | cheap |
| 14 Providers | standard |

**Rulings made in this plan:**
1. **Aadhaar lives in its own table** (`patient_aadhaar`), not on `patients`. Every existing whole-row `select().from(patients)` (detail cache, list API, workbook export, FHIR) then cannot leak it, and the static guard in Task 9 pins that.
2. **Last 4 digits are stored in plaintext** (`aadhaar_last4`) so the masked display never needs decryption. Duplicate-Aadhaar detection (it would need a keyed hash) is **not** built; it is flagged for the owner.
3. **"Mandatory" Aadhaar and ABHA** are both enforced as "value or recorded reason". The spec names the override only for Aadhaar. ABHA gets the same treatment because creating one needs the gateway (SP8) and patients may not have one.
4. **RBAC.** Registration stays `admin`/`frontdesk` (an existing product ruling in `src/app/api/patients/route.ts`). `crc` writes Aadhaar via `PUT …/aadhaar`. Masked read is `admin`/`crc` only. `frontdesk`, `pi` and the patient portal see the status only.
5. **UHID** is `prefix + 8-digit sequence + Verhoeff check digit`, from Postgres sequence `uhid_seq`. The internal `patients.id` (`RD-####`) stays the primary key. Existing demo patients get **no** backfilled UHID; they show the RD id.
6. **Address.** The new `pin_code` column is used, and the legacy `zip` is left untouched. District is free text, because there is no district master. State uses ISO 3166-2:IN codes as amended in 2023 (`IN-CG`, `IN-OD`, `IN-TS`, `IN-UK`).
7. **Department/specialty master** is one `departments` table with a `kind`. `providers.specialty` stays free text; there is no separate specialty table (YAGNI).
8. **`app_settings.practice_timezone`** default becomes `Asia/Kolkata`, and the migration rewrites only rows that still hold the old US default.
9. **Shared foundation for SP2.** Task 2 also carries `money.ts`, `india-time.ts`, `db-errors.ts` and the migration checker, so SP2 can cherry-pick that single commit.
10. **Photo.** Only `photo_blob_path` is stored. Upload UI is out of scope.
11. **KYC documents** reuse `identity_verifications` (encrypted number) with Indian document types added. Aadhaar is never a KYC type. Registration records KYC unverified, and verification stays the existing action.
12. **FHIR identifier system URIs** for ABHA are provisional constants in one file and must be checked against the NRCeS/ABDM FHIR profiles in SP8.
