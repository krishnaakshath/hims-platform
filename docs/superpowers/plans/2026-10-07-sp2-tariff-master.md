# SP2: Service/Charge Master & Tariffs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the hospital a priced service master, where every chargeable service carries:
- a code, department, category, HSN/SAC and GST rate
- effective-dated rates at three levels: hospital base, department price list, and per-payer/TPA override
- rates that can vary by room category and ward
- package bundles

Admin screens and CSV import maintain it. A pure resolver and a lookup API (`/api/tariff/resolve`) answer "what does this service cost here, for this payer, on this date".

**Architecture:**
- One `tariff_rates` table holds every price version. `scope` is one of `base` / `department` / `payer`, with optional room-category and ward dimensions, and an inclusive `[valid_from, valid_to]` range.
- A Postgres `EXCLUDE USING gist` constraint rules out overlapping versions on the same dimensions. The same rule is enforced in pure code before insert.
- `resolvePrice` is a pure function over pre-loaded rows. The precedence is payer > department > base. Inside the winning scope, the most specific room/ward match wins.
- The query layer only loads rows and writes transactions. Routes and pages are thin, and their tests mock the query module, so everything except the SQL runs without a database.

**Tech Stack:** Next.js 16 App Router (`params` are Promises; `src/proxy.ts`), drizzle-orm 0.45 + node-postgres (`getDb().transaction`), Postgres `btree_gist`, zod v4, vitest 5 + jsdom.

**Spec:** `docs/superpowers/specs/2026-10-07-indian-hims-design.md` (sections 1–4, 6, 7 binding; this plan implements sub-project 2. Charge-capture integration is sub-project 4 and out of scope here).

**Depends on SP1:** `docs/superpowers/plans/2026-10-07-sp1-patient-master.md`, **Task 2 only**.

## SP1 dependency (chosen approach: cherry-pick SP1 Task 2)

SP1 Task 2 is one self-contained commit (`feat(sp1): department master, INR money, IST date and migration helpers`). SP2 consumes exactly what that commit produces:

- **Consumes:** the `departments(id, name, code)` table and its siblings from SP1 Task 2:
  ```ts
  // src/db/schema.ts
  export const departmentKindEnum = pgEnum('department_kind', ['clinical', 'diagnostic', 'support', 'administrative'])
  export const departments = pgTable('departments', { id: serial('id').primaryKey(), code: text('code').notNull().unique(), name: text('name').notNull(), kind: departmentKindEnum('kind').default('clinical').notNull(), isActive: boolean('is_active').default(true).notNull(), createdAt: timestamp('created_at').defaultNow().notNull() })
  export type Department = typeof departments.$inferSelect
  ```
  - `src/lib/queries/departments.ts`: `listDepartments(opts?: { activeOnly?: boolean })`, `getDepartmentById(id: number)`, `getDepartmentByCode(code: string)`
  - `src/lib/money.ts`: `CURRENCY`, `formatPaise(paise: number): string`, `parseRupeesToPaise(input: string): number | null`
  - `src/lib/india-time.ts`: `DEFAULT_TIMEZONE`, `todayIsoIn(tz?: string, now?: Date): string`
  - `src/lib/db-errors.ts`: `isUniqueViolation(err, constraint?)`, `isExclusionViolation(err, constraint?)`, `pgConstraint(err)`
  - `tests/db/migration-sql.ts`: `readMigration`, `idempotencyProblems`, `missingColumns`
  - The migration file `scripts/migrations/2026-10-07-sp1-departments.sql`
- **Rule:** SP2 Task 1 Step 0 checks for these. If SP1 is not merged into the SP2 branch, it runs `git cherry-pick <sha of the SP1 Task 2 commit>`. If that commit does not exist yet anywhere, the implementer builds SP1 Task 2 **exactly** as specified in the SP1 plan, as its own commit with the same message, then continues. When SP1 later merges, the identical change is a no-op, and the departments migration is idempotent, so applying it twice is harmless.
- **Why not a throwaway stub:** a stub would have to be deleted and re-pointed at merge time. Cherry-picking the real, tiny commit removes that step.

## Global Constraints

- Read `AGENTS.md`. Before writing routes or pages, read the matching guide in `node_modules/next/dist/docs/`, because Next 16 is non-standard. Route context is `{ params: Promise<{ … }> }`.
- **Money:** integer **paise** everywhere, with `currency text NOT NULL DEFAULT 'INR'` on `tariff_rates`.
  - Parse rupee input only with `parseRupeesToPaise` and display only with `formatPaise`. Never use floats in storage.
  - GST is stored as basis points (`gst_rate_bp`, 1800 = 18%). The CGST/SGST/IGST split is SP4.
- **Dates:** `valid_from`/`valid_to` are `date`, ISO `YYYY-MM-DD` strings in code. The range is inclusive on both ends, and a null `valid_to` means open-ended. "Today" is `todayIsoIn('Asia/Kolkata')`.
- **Precedence (spec, exact):** payer-specific > department list > base. The scope decides first; specificity breaks ties only inside the chosen scope.
- **RBAC:**
  - `TARIFF_MANAGE_ROLES = ['admin', 'billing']` covers every page and every write.
  - `TARIFF_LOOKUP_ROLES = ['admin', 'billing', 'crc', 'frontdesk']` covers `GET /api/tariff/resolve` and `GET /api/tariff/services` (search).
  - Every route runs `requireSession()` first, then the inline allowlist, and returns exactly `NextResponse.json({ error: 'Forbidden' }, { status: 403 })` before any body parse or query.
  - Every page calls `requireSessionOrRedirect()` as its first statement, then runs `redirect('/')` for a denied role before any data load.
  - Every new route gets an `API_GATES` row in `tests/api/rbac-route-gates.test.ts`, and every new page a `PAGE_GATES` row in `tests/pages/page-gates-harness.ts`, all with no `gap` tag. `LeftNav` roles must equal the page gate (`tests/pages/nav-role-enforcement.test.tsx`).
- **Audit:** every write calls `logAudit(session, action, null)` with an action string that starts `tariff: `. Use the three-argument form, so SP2 does not depend on SP1's `details` parameter. Lookups are not audited, because they carry no PHI.
- **No PHI in this sub-project:** no route accepts a patient id. The query schemas are `.strict()`.
- **Branding:** no hard-coded product name. Use `brand` / `useBrand()` where a name is shown.
- **Schema changes:**
  - Each change is a `src/db/schema.ts` edit plus an idempotent `scripts/migrations/2026-10-07-sp2-*.sql`, in `BEGIN; … COMMIT;` with `IF NOT EXISTS`.
  - Types and constraints go in `DO $$ … $$` blocks guarded by `duplicate_object` or `pg_constraint`.
  - No `DROP`.
  - Apply with `node --env-file=.env.local scripts/apply-sql.mjs <file>`.
  - The exclusion constraint cannot be expressed in drizzle. Therefore `db:push` on a fresh DB must be followed by applying the SP2 migrations, and `docs/DEPLOYING.md` §4 says so (Task 2).
- **No database is attached here:**
  - Run single files with `npx vitest run <file>`, never `npm test` (it needs `.env.local`).
  - DB-integration tests use `describe.skipIf(!process.env.DATABASE_URL)('… (DB)', …)`, with fixtures whose codes start `TEST_SP2_`, deleted in `afterEach` children-first (`tariff_rates` → `service_package_items` → `service_catalog` → `room_categories`).
  - New `API_GATES` rows wrap the call in the file's existing `settle()`, so the allowed half passes without a DB (it gives 400 or 500, never 403).
- **Per-task verification:** `npx tsc --noEmit` and `npx eslint <changed files>`.
- **No secrets.** Commit nothing until execution.

## Review Focus

1. **Date boundaries:**
   - A rate whose `valid_from` is tomorrow must not price today.
   - A rate whose `valid_to` is today must still price today.
   - A revision must leave no gap and no overlap (old row ends the day before the new one starts).
   - Test: Task 4 `honours inclusive valid_to and future valid_from`, and Task 5 `planRevision closes the day before and keeps the original end`.
2. **The payer scope wins even when less specific.** A payer's generic rate beats a base rate that matches the room category exactly, because the payer contract governs. A payer with no matching rate falls through to department, then base. Test: Task 4 `payer generic beats base room-specific` and `payer without a matching rate falls back to department then base`.
3. **Ward and room-category text typed inconsistently** (`' ICU '`, `'icu'`, `'Icu  Ward'`) must match the same tariff. Test: Task 4 `matches ward case- and whitespace-insensitively` and Task 5 `sameDims treats wards case-insensitively`.
4. **A CSV exported from Excel:** a UTF-8 BOM, CRLF line ends, quoted fields with commas (`"Dressing, small"`), quoted amounts (`"1,250.00"`) and trailing blank lines must import. Any bad row must block the whole import, with line-numbered messages. Test: Task 6 `parses an Excel-style CSV` and `one bad row blocks commit with its line number`.
5. **Two admins adding overlapping rates at once,** or a revision dated on/before the current `valid_from`, must give a 409 or 400 with a plain message, never a 500 or a negative range. Test: Task 5 `planRevision rejects effectiveFrom <= validFrom`, and Task 9 `maps tariff_rates_no_overlap exclusion to 409`.

---

## File Structure

| File | Responsibility |
|---|---|
| `scripts/migrations/2026-10-07-sp2-service-catalog.sql` | room categories, `rooms.room_category_id`, service catalogue |
| `scripts/migrations/2026-10-07-sp2-tariff-rates.sql` | `btree_gist`, tariff rates, package items, exclusion constraint |
| `src/lib/tariff/validation.ts` | Codes, categories, HSN/SAC, GST slabs, zod schemas (client-safe) |
| `src/lib/tariff/resolve.ts` | `resolvePrice` + types (pure) |
| `src/lib/tariff/versions.ts` | ward normalisation, overlap detection, revision planning (pure) |
| `src/lib/tariff/csv.ts` | RFC 4180 CSV parser (pure) |
| `src/lib/tariff/import.ts` | Service/rate CSV validation against lookups (pure) |
| `src/lib/queries/tariff.ts` | All tariff DB reads/writes + `loadPricingContext` |
| `src/app/api/tariff/**` | Routes (see Tasks 8–11) |
| `src/app/(dashboard)/tariffs/**` | Admin pages (Tasks 12–14) |
| `src/components/tariff/*` | Client components for those pages |

---

### Task 1: Dependency gate + room categories + service catalogue schema

**Files:**
- Modify: `src/db/schema.ts`:
  - add `index` to the `drizzle-orm/pg-core` import
  - add `roomCategories` before `rooms` (line 555)
  - add `roomCategoryId` to `rooms`
  - add `serviceCategoryEnum` and `serviceCatalog` after `departments`
- Create: `scripts/migrations/2026-10-07-sp2-service-catalog.sql`
- Modify: `src/db/seed.ts`, in `clearExistingData`. Delete `serviceCatalog` and `roomCategories` (and, after Task 2, `tariffRates` and `servicePackageItems` first). Null `rooms.room_category_id` by deleting rooms first, which already happens at line 882.
- Test: `tests/db/sp2-dependency.test.ts`, `tests/db/service-catalog-schema.test.ts`

**Interfaces:**
- Consumes: the SP1 Task 2 items listed at the top.
- Produces:
  ```ts
  export const roomCategories = pgTable('room_categories', {
    id: serial('id').primaryKey(),
    code: text('code').notNull().unique(),            // constraint room_categories_code_unique; ^[A-Z][A-Z0-9_]{1,15}$
    name: text('name').notNull(),
    isActive: boolean('is_active').default(true).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  })
  // rooms: roomCategoryId: integer('room_category_id').references(() => roomCategories.id)
  export const serviceCategoryEnum = pgEnum('service_category', ['consultation', 'procedure', 'investigation_lab', 'investigation_imaging', 'room_rent', 'nursing', 'pharmacy', 'consumable', 'package', 'other'])
  export const serviceCatalog = pgTable('service_catalog', {
    id: serial('id').primaryKey(),
    code: text('code').notNull().unique(),            // constraint service_catalog_code_unique
    name: text('name').notNull(),
    departmentId: integer('department_id').notNull().references(() => departments.id),
    category: serviceCategoryEnum('category').notNull(),
    hsnSac: text('hsn_sac').notNull(),
    gstRateBp: integer('gst_rate_bp').default(0).notNull(),
    isActive: boolean('is_active').default(true).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  }, (t) => [
    check('service_catalog_gst_rate_bp_allowed', sql`${t.gstRateBp} IN (0, 500, 1200, 1800, 2800, 4000)`),
    index('service_catalog_department_idx').on(t.departmentId),
  ])
  export type ServiceCatalogRow = typeof serviceCatalog.$inferSelect
  export type RoomCategory = typeof roomCategories.$inferSelect
  ```

- [ ] **Step 0: Satisfy the SP1 dependency.** Run `grep -n "export const departments = pgTable" src/db/schema.ts && ls src/lib/money.ts src/lib/india-time.ts src/lib/db-errors.ts tests/db/migration-sql.ts`. If anything is missing:
  1. Run `git log --all --oneline --grep "department master, INR money"`.
  2. If a commit is found, run `git cherry-pick <sha>`. Otherwise implement SP1 Task 2 verbatim from `docs/superpowers/plans/2026-10-07-sp1-patient-master.md` and commit it with that plan's message.

- [ ] **Step 1: Write the failing tests**

```ts
// sp2-dependency.test.ts -- fails loudly if SP1 Task 2 drifted from what SP2 consumes
it('departments exposes id, code, name', () => { expect(Object.keys(getTableColumns(departments))).toEqual(expect.arrayContaining(['id', 'code', 'name'])) })
it('shared helpers exist with the consumed names', async () => {
  const money = await import('@/lib/money'); const t = await import('@/lib/india-time'); const e = await import('@/lib/db-errors')
  expect(typeof money.formatPaise).toBe('function'); expect(typeof money.parseRupeesToPaise).toBe('function')
  expect(typeof t.todayIsoIn).toBe('function'); expect(typeof e.isExclusionViolation).toBe('function')
})
// service-catalog-schema.test.ts
it('migration is idempotent', () => { expect(idempotencyProblems(readMigration('2026-10-07-sp2-service-catalog.sql'))).toEqual([]) })
it.each([['room_categories', roomCategories], ['service_catalog', serviceCatalog], ['rooms', rooms]])('declares every %s column', (_n, t) => {
  expect(missingColumns(t, readMigration('2026-10-07-sp2-service-catalog.sql')).filter((c) => t !== rooms || c === 'room_category_id')).toEqual([])
})
it('pins the GST slab check and the unique codes', () => {
  const s = readMigration('2026-10-07-sp2-service-catalog.sql')
  for (const n of ['service_catalog_gst_rate_bp_allowed', 'service_catalog_code_unique', 'room_categories_code_unique', 'service_category']) expect(s).toContain(n)
})
describe.skipIf(!process.env.DATABASE_URL)('service catalogue (DB)', () => {
  it('rejects gst_rate_bp 1000', async () => { /* expect pgErrorCode(err) === '23514' */ })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/db/sp2-dependency.test.ts tests/db/service-catalog-schema.test.ts`
Expected: the dependency test PASSes after Step 0; the schema test FAILs.

- [ ] **Step 3: Implement** the schema edits, the migration (enum in a `DO` block, two tables, `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS room_category_id integer REFERENCES room_categories(id)`, check and index) and the seed cleanup.

- [ ] **Step 4: Run the tests to verify they pass**

Run: same command as Step 2, then `npx tsc --noEmit`.
Expected: PASS. The DB block is skipped.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/db/seed.ts scripts/migrations/2026-10-07-sp2-service-catalog.sql tests/db/sp2-dependency.test.ts tests/db/service-catalog-schema.test.ts
git commit -m "feat(sp2): service catalogue and room category schema"
```

---

### Task 2: Tariff rates + package items schema, no-overlap constraint, deploy note

**Files:**
- Modify: `src/db/schema.ts`. Add `tariffRates` and `servicePackageItems` after `serviceCatalog`.
- Create: `scripts/migrations/2026-10-07-sp2-tariff-rates.sql`
- Modify: `docs/DEPLOYING.md` §4. After `npm run db:push`, add: "Then apply every file in `scripts/migrations/` dated after the schema baseline, in name order (`node --env-file=.env.local scripts/apply-sql.mjs <file>`). They are idempotent. Some constraints (for example `tariff_rates_no_overlap`) cannot be expressed in `schema.ts` and exist only there."
- Modify: `src/db/seed.ts`. Delete `tariffRates` and `servicePackageItems` before `serviceCatalog`.
- Test: `tests/db/tariff-rates-schema.test.ts`

**Interfaces:**
- Consumes: `serviceCatalog`, `roomCategories` (Task 1), `departments` (SP1 Task 2) and `payers` (existing, `schema.ts:219`).
- Produces:
  ```ts
  export const TARIFF_SCOPES = ['base', 'department', 'payer'] as const
  export const tariffRates = pgTable('tariff_rates', {
    id: serial('id').primaryKey(),
    serviceId: integer('service_id').notNull().references(() => serviceCatalog.id),
    scope: text('scope', { enum: TARIFF_SCOPES }).notNull(),     // text, not pgEnum: used inside the gist exclusion
    departmentId: integer('department_id').references(() => departments.id),
    payerId: integer('payer_id').references(() => payers.id),
    roomCategoryId: integer('room_category_id').references(() => roomCategories.id),
    ward: text('ward'),                                             // stored normalised (normalizeWard, Task 5)
    amountPaise: integer('amount_paise').notNull(),
    currency: text('currency').default('INR').notNull(),
    validFrom: date('valid_from').notNull(),
    validTo: date('valid_to'),                                      // inclusive; null = open-ended
    deactivatedAt: timestamp('deactivated_at'),
    createdByName: text('created_by_name').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  }, (t) => [
    check('tariff_rates_amount_nonneg', sql`${t.amountPaise} >= 0`),
    check('tariff_rates_range_ordered', sql`${t.validTo} IS NULL OR ${t.validTo} >= ${t.validFrom}`),
    check('tariff_rates_scope_keys', sql`(${t.scope} = 'base' AND ${t.departmentId} IS NULL AND ${t.payerId} IS NULL) OR (${t.scope} = 'department' AND ${t.departmentId} IS NOT NULL AND ${t.payerId} IS NULL) OR (${t.scope} = 'payer' AND ${t.payerId} IS NOT NULL AND ${t.departmentId} IS NULL)`),
    index('tariff_rates_service_idx').on(t.serviceId),
  ])
  export const servicePackageItems = pgTable('service_package_items', {
    id: serial('id').primaryKey(),
    packageServiceId: integer('package_service_id').notNull().references(() => serviceCatalog.id),
    itemServiceId: integer('item_service_id').notNull().references(() => serviceCatalog.id),
    quantity: integer('quantity').default(1).notNull(),
  }, (t) => [
    uniqueIndex('service_package_items_pkg_item_unique').on(t.packageServiceId, t.itemServiceId),
    check('service_package_items_qty_positive', sql`${t.quantity} > 0`),
    check('service_package_items_not_self', sql`${t.packageServiceId} <> ${t.itemServiceId}`),
  ])
  export type TariffRateRow = typeof tariffRates.$inferSelect
  ```
- The migration-only constraint is added in a `pg_constraint`-guarded `DO` block, after `CREATE EXTENSION IF NOT EXISTS btree_gist;`:
  ```sql
  ALTER TABLE tariff_rates ADD CONSTRAINT tariff_rates_no_overlap EXCLUDE USING gist (
    service_id WITH =, scope WITH =, (coalesce(department_id, 0)) WITH =, (coalesce(payer_id, 0)) WITH =,
    (coalesce(room_category_id, 0)) WITH =, (coalesce(ward, '')) WITH =,
    daterange(valid_from, valid_to, '[]') WITH &&
  ) WHERE (deactivated_at IS NULL);
  ```

- [ ] **Step 1: Write the failing tests**

```ts
it('migration is idempotent and declares every column', () => {
  const s = readMigration('2026-10-07-sp2-tariff-rates.sql'); expect(idempotencyProblems(s)).toEqual([])
  expect(missingColumns(tariffRates, s)).toEqual([]); expect(missingColumns(servicePackageItems, s)).toEqual([])
})
it('creates btree_gist and the partial inclusive-range exclusion', () => {
  const s = readMigration('2026-10-07-sp2-tariff-rates.sql')
  expect(s).toContain('CREATE EXTENSION IF NOT EXISTS btree_gist'); expect(s).toContain('tariff_rates_no_overlap')
  expect(s).toMatch(/daterange\(valid_from, valid_to, '\[\]'\) WITH &&/); expect(s).toMatch(/WHERE \(deactivated_at IS NULL\)/)
})
it('DEPLOYING.md tells a fresh deploy to apply the migrations after db:push', () => {
  expect(readFileSync(join(process.cwd(), 'docs/DEPLOYING.md'), 'utf8')).toContain('tariff_rates_no_overlap')
})
describe.skipIf(!process.env.DATABASE_URL)('tariff rates (DB)', () => {
  it('rejects an overlapping base rate for the same service and dims', async () => { /* expect isExclusionViolation(err, 'tariff_rates_no_overlap') */ })
  it('allows the overlap once the first is deactivated', async () => {})
  it('rejects scope=payer without payer_id', async () => { /* 23514 tariff_rates_scope_keys */ })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/db/tariff-rates-schema.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the schema, migration, `DEPLOYING.md` paragraph and seed cleanup.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/db/tariff-rates-schema.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/db/seed.ts scripts/migrations/2026-10-07-sp2-tariff-rates.sql docs/DEPLOYING.md tests/db/tariff-rates-schema.test.ts
git commit -m "feat(sp2): effective-dated tariff rates with no-overlap exclusion, package items"
```

---

### Task 3: Tariff validation module (codes, HSN/SAC, GST, zod schemas)

**Files:**
- Create: `src/lib/tariff/validation.ts`
- Test: `tests/lib/tariff/validation.test.ts`

**Interfaces:**
- Consumes: `TARIFF_SCOPES` (Task 2). It is client-safe, so it imports **types only** from `@/db/schema`. The scopes are re-declared locally as `RATE_SCOPES` and tied to the schema by a test.
- Produces:
  - `RATE_SCOPES = ['base', 'department', 'payer'] as const`
  - `SERVICE_CODE_PATTERN = /^[A-Z0-9][A-Z0-9._-]{1,23}$/`
  - `ROOM_CATEGORY_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,15}$/`
  - `SERVICE_CATEGORIES`: a tuple of `{ code, label }`, with codes identical to `serviceCategoryEnum`
  - `GOODS_CATEGORIES = ['pharmacy', 'consumable'] as const`
  - `GST_RATES_BP = [0, 500, 1200, 1800, 2800, 4000] as const`
  - `gstPercentToBp(input: string): number | null`. It accepts `'18'`, `'18%'`, `'18.0'` and `'0'`, and returns null for anything not in `GST_RATES_BP`.
  - `hsnSacKind(code: string): 'sac' | 'hsn' | null`. SAC is 6 digits starting `99`. HSN is 4, 6 or 8 digits not starting `99`.
  - `hsnSacProblem(category: ServiceCategory, code: string): string | null`. Goods categories need HSN; every other category needs SAC (`other` accepts either).
  - zod schemas (all `.strict()`):
    - `serviceCreateSchema { code (trim, toUpperCase, pattern), name (1..200), departmentId (int+), category, hsnSac, gstRateBp (in GST_RATES_BP) }`, with `superRefine` running `hsnSacProblem`
    - `serviceUpdateSchema`: a partial of the create schema **without `code`**, plus `isActive?`, with at least one key
    - `rateCreateSchema { serviceId, scope, departmentId?, payerId?, roomCategoryId?, ward? (1..60), amountPaise (int 0..10_000_000_000), validFrom (ISO date), validTo? (ISO date) }`. It has a `superRefine` for the scope keys (mirroring `tariff_rates_scope_keys`) and `validTo >= validFrom`.
    - `rateRevisionSchema { amountPaise, effectiveFrom }`
    - `ratePatchSchema`: either `{ validTo: ISO date }` or `{ deactivate: literal(true) }`
    - `roomCategoryCreateSchema { code, name }` and `roomCategoryUpdateSchema { name?, isActive? }`
    - `roomAssignmentSchema { roomCategoryId: int | null }`
    - `packageItemsSchema { items: { serviceId: int, quantity: int 1..999 }[] (max 100, unique serviceId) }`
    - `resolveQuerySchema`. Its fields come from `URLSearchParams` as strings: `{ serviceId?: coerce int, serviceCode?: string, payerId?: coerce int, departmentId?: coerce int, roomCategory?: string, ward?: string, onDate?: ISO date }`. Exactly one of `serviceId` and `serviceCode` is required.
  - Types: `ServiceCategory`, `ServiceCreateInput`, `ServiceUpdateInput`, `RateCreateInput`, `RateRevisionInput`, `RatePatchInput`, `PackageItemsInput`, `ResolveQueryInput`
  - `isoDate`: a shared zod refinement. It matches `/^\d{4}-\d{2}-\d{2}$/` and the date must round-trip through `Date.UTC`, so `2026-02-30` is rejected.

- [ ] **Step 1: Write the failing tests**

```ts
it('SERVICE_CATEGORIES and TARIFF scopes mirror the schema', () => {
  expect(SERVICE_CATEGORIES.map((c) => c.code)).toEqual(serviceCategoryEnum.enumValues); expect([...RATE_SCOPES]).toEqual([...TARIFF_SCOPES]) // TARIFF_SCOPES from '@/db/schema' (test-only import)
})
it.each([['999312', 'sac'], ['3004', 'hsn'], ['30049099', 'hsn'], ['9993', 'hsn'], ['99931', null], ['abc123', null]])('hsnSacKind %s', (c, k) => expect(hsnSacKind(c)).toBe(k))
it('needs SAC for a consultation and HSN for a consumable', () => {
  expect(hsnSacProblem('consultation', '3004')).not.toBeNull(); expect(hsnSacProblem('consultation', '999312')).toBeNull()
  expect(hsnSacProblem('consumable', '999312')).not.toBeNull(); expect(hsnSacProblem('consumable', '30059010')).toBeNull()
})
it.each([['18', 1800], ['18%', 1800], ['0', 0], ['40', 4000], ['10', null], ['-5', null]])('gstPercentToBp %s', (i, o) => expect(gstPercentToBp(i)).toBe(o))
it('upper-cases the service code and rejects a bad one', () => {
  expect(serviceCreateSchema.parse({ code: 'opd-cons', name: 'OPD consultation', departmentId: 1, category: 'consultation', hsnSac: '999312', gstRateBp: 0 }).code).toBe('OPD-CONS')
  expect(serviceCreateSchema.safeParse({ code: '-X', name: 'n', departmentId: 1, category: 'consultation', hsnSac: '999312', gstRateBp: 0 }).success).toBe(false)
})
it('serviceUpdateSchema refuses a code change', () => { expect(serviceUpdateSchema.safeParse({ code: 'NEW' }).success).toBe(false) })
it('rateCreateSchema enforces scope keys and ordered dates', () => {
  const base = { serviceId: 1, amountPaise: 50000, validFrom: '2026-10-01' }
  expect(rateCreateSchema.safeParse({ ...base, scope: 'base' }).success).toBe(true)
  expect(rateCreateSchema.safeParse({ ...base, scope: 'payer' }).success).toBe(false)
  expect(rateCreateSchema.safeParse({ ...base, scope: 'base', payerId: 3 }).success).toBe(false)
  expect(rateCreateSchema.safeParse({ ...base, scope: 'base', validTo: '2026-09-30' }).success).toBe(false)
  expect(rateCreateSchema.safeParse({ ...base, scope: 'base', validFrom: '2026-02-30' }).success).toBe(false)
})
it('resolveQuerySchema needs exactly one service key and rejects unknown params', () => {
  expect(resolveQuerySchema.safeParse({ serviceId: '4', onDate: '2026-10-07' }).success).toBe(true)
  expect(resolveQuerySchema.safeParse({}).success).toBe(false)
  expect(resolveQuerySchema.safeParse({ serviceId: '4', patientId: 'RD-0001' }).success).toBe(false)
})
it('packageItemsSchema rejects duplicate items', () => {})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/lib/tariff/validation.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `validation.ts`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/lib/tariff/validation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tariff/validation.ts tests/lib/tariff/validation.test.ts
git commit -m "feat(sp2): tariff validation (codes, HSN/SAC, GST slabs, schemas)"
```

---

### Task 4: The price resolver (pure)

**Files:**
- Create: `src/lib/tariff/resolve.ts`
- Test: `tests/lib/tariff/resolve.test.ts`

**Interfaces:**
- Consumes: `normalizeWard` (Task 5 produces it; to keep Task 4 independent, define it **here** and have Task 5 re-export it from `versions.ts`).
- Produces:
  ```ts
  export type TariffScope = 'base' | 'department' | 'payer'
  export function normalizeWard(ward: string): string            // trim, collapse internal whitespace, lower-case
  export interface ServiceForPricing { id: number; code: string; name: string; departmentId: number; isActive: boolean; hsnSac: string; gstRateBp: number }
  export interface TariffRateCandidate { id: number; serviceId: number; scope: TariffScope; departmentId: number | null; payerId: number | null; roomCategoryCode: string | null; ward: string | null; amountPaise: number; validFrom: string; validTo: string | null; deactivated: boolean }
  export interface PriceQuery { serviceId: number; payerId?: number; departmentId?: number; roomCategory?: string; ward?: string; onDate: string }
  export type PriceResolution =
    | { ok: true; serviceId: number; serviceCode: string; serviceName: string; amountPaise: number; currency: 'INR'; gstRateBp: number; hsnSac: string; rateId: number; scope: TariffScope; matched: { roomCategory: boolean; ward: boolean } }
    | { ok: false; reason: 'invalid_date' | 'service_not_found' | 'service_inactive' | 'no_rate' }
  export function resolvePrice(query: PriceQuery, ctx: { service: ServiceForPricing | null; rates: TariffRateCandidate[] }): PriceResolution
  ```
- Algorithm, which the tests determine. Spelled out here because the order is the contract:
  1. A malformed `onDate` gives `invalid_date`. A null service gives `service_not_found`. `!service.isActive` gives `service_inactive`.
  2. Live rates have `serviceId === query.serviceId`, `!deactivated`, `validFrom <= onDate` and (`validTo === null` or `onDate <= validTo`). Compare ISO strings.
  3. Dimension match:
     - The room category matches if `r.roomCategoryCode === null`, or if `query.roomCategory` is given and equals it case-insensitively.
     - The ward matches if `r.ward === null`, or if `query.ward` is given and `normalizeWard` of both are equal.
  4. The effective department is `query.departmentId ?? service.departmentId`.
  5. Tiers, in order:
     - `payer`, only when `query.payerId` is set and `r.payerId === query.payerId`
     - `department`, when `r.departmentId === effectiveDepartment`
     - `base`
  6. In the first tier that has a match, pick the highest specificity, where specificity is `(ward ? 2 : 0) + (roomCategory ? 1 : 0)`. Break a tie by the later `validFrom`, then by the higher `id`.
  7. If no tier has a match, return `no_rate`.

- [ ] **Step 1: Write the failing tests.** Use a fixture builder `rate(overrides)` and a service `svc` with `departmentId: 10`.

```ts
it('returns the base rate when nothing more specific exists', () => { expect(resolvePrice(q(), ctx([rate({ id: 1, scope: 'base', amountPaise: 50000 })]))).toMatchObject({ ok: true, amountPaise: 50000, scope: 'base', rateId: 1 }) })
it('department list beats base for the service department', () => {})
it('an explicit departmentId selects that department list', () => { /* rate dept 20; query departmentId 20 -> dept rate; no departmentId -> base */ })
it('payer-specific beats department and base', () => {})
it('payer generic beats base room-specific', () => {
  const r = resolvePrice(q({ payerId: 7, roomCategory: 'PRIVATE' }), ctx([rate({ id: 1, scope: 'base', roomCategoryCode: 'PRIVATE', amountPaise: 90000 }), rate({ id: 2, scope: 'payer', payerId: 7, amountPaise: 60000 })]))
  expect(r).toMatchObject({ ok: true, rateId: 2, scope: 'payer' })
})
it('payer without a matching rate falls back to department then base', () => {})
it('another payer\'s rate is never used', () => {})
it('picks the most specific within a scope: ward+category > ward > category > generic', () => {})
it('a category-specific rate does not apply when no room category is queried', () => {})
it('matches ward case- and whitespace-insensitively', () => { /* rate ward 'icu ward'; query ward '  ICU   Ward ' -> matched.ward true */ })
it('honours inclusive valid_to and future valid_from', () => {
  const rates = [rate({ id: 1, scope: 'base', validFrom: '2026-01-01', validTo: '2026-10-07', amountPaise: 100 }), rate({ id: 2, scope: 'base', validFrom: '2026-10-08', amountPaise: 200 })]
  expect(resolvePrice(q({ onDate: '2026-10-07' }), ctx(rates))).toMatchObject({ rateId: 1 }); expect(resolvePrice(q({ onDate: '2026-10-08' }), ctx(rates))).toMatchObject({ rateId: 2 })
})
it('ignores deactivated rates', () => {})
it('reports service_not_found, service_inactive, no_rate and invalid_date', () => {})
it('carries GST basis points and HSN/SAC from the service', () => {})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/lib/tariff/resolve.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `resolve.ts`, with no imports beyond types.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/lib/tariff/resolve.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tariff/resolve.ts tests/lib/tariff/resolve.test.ts
git commit -m "feat(sp2): pure tariff price resolver with payer > department > base precedence"
```

---

### Task 5: Version helpers: overlap detection and revision planning (pure)

**Files:**
- Create: `src/lib/tariff/versions.ts`
- Test: `tests/lib/tariff/versions.test.ts`

**Interfaces:**
- Consumes: `normalizeWard` and `TariffScope` (Task 4).
- Produces:
  ```ts
  export { normalizeWard } from './resolve'
  export interface RateDims { serviceId: number; scope: TariffScope; departmentId: number | null; payerId: number | null; roomCategoryId: number | null; ward: string | null }
  export interface DatedRate extends RateDims { id?: number; validFrom: string; validTo: string | null; deactivated?: boolean }
  export function sameDims(a: RateDims, b: RateDims): boolean                 // wards via normalizeWard; null === null
  export function rangesOverlap(a: Pick<DatedRate, 'validFrom' | 'validTo'>, b: Pick<DatedRate, 'validFrom' | 'validTo'>): boolean  // inclusive, null = +infinity
  export function findOverlap(candidate: DatedRate, existing: DatedRate[]): DatedRate | null   // skips deactivated and same id
  export function addDays(iso: string, days: number): string                 // UTC date arithmetic
  export type RevisionPlan =
    | { ok: true; close: { id: number; validTo: string }; insert: DatedRate & { amountPaise: number } }
    | { ok: false; error: string }
  export function planRevision(current: DatedRate & { id: number; amountPaise: number; deactivated: boolean }, input: { amountPaise: number; effectiveFrom: string }): RevisionPlan
  ```
- `planRevision` errors use these exact strings:
  - `'The rate is deactivated'`
  - `'New rate must start after the current rate starts'` when `effectiveFrom <= validFrom`
  - `'The current rate ends before that date; add a new rate instead'` when `validTo !== null && effectiveFrom > validTo`
  - `'The new amount equals the current amount'`
- On success, it closes `current` at `addDays(effectiveFrom, -1)` and inserts the same dims from `effectiveFrom` to the **original** `current.validTo`.

- [ ] **Step 1: Write the failing tests**

```ts
it('rangesOverlap is inclusive and treats null as open', () => {
  expect(rangesOverlap({ validFrom: '2026-01-01', validTo: '2026-01-31' }, { validFrom: '2026-01-31', validTo: null })).toBe(true)
  expect(rangesOverlap({ validFrom: '2026-01-01', validTo: '2026-01-30' }, { validFrom: '2026-01-31', validTo: null })).toBe(false)
})
it('sameDims treats wards case-insensitively and distinguishes payers', () => {})
it('findOverlap ignores deactivated rows and the row itself', () => {})
it('addDays crosses month and leap-year boundaries', () => { expect(addDays('2028-03-01', -1)).toBe('2028-02-29'); expect(addDays('2026-12-31', 1)).toBe('2027-01-01') })
it('planRevision closes the day before and keeps the original end', () => {
  const plan = planRevision({ id: 9, serviceId: 1, scope: 'base', departmentId: null, payerId: null, roomCategoryId: null, ward: null, validFrom: '2026-01-01', validTo: '2026-12-31', amountPaise: 100, deactivated: false }, { amountPaise: 150, effectiveFrom: '2026-10-08' })
  expect(plan).toEqual({ ok: true, close: { id: 9, validTo: '2026-10-07' }, insert: expect.objectContaining({ validFrom: '2026-10-08', validTo: '2026-12-31', amountPaise: 150 }) })
})
it('planRevision rejects effectiveFrom <= validFrom', () => {})
it('planRevision rejects a date after the current end and an unchanged amount', () => {})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/lib/tariff/versions.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `versions.ts`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/lib/tariff/versions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tariff/versions.ts tests/lib/tariff/versions.test.ts
git commit -m "feat(sp2): tariff overlap detection and revision planning"
```

---

### Task 6: CSV parser and import validation (pure)

**Files:**
- Create: `src/lib/tariff/csv.ts`, `src/lib/tariff/import.ts`
- Test: `tests/lib/tariff/csv.test.ts`, `tests/lib/tariff/import.test.ts`

**Interfaces:**
- Consumes: Task 3 schemas and `gstPercentToBp`, Task 5 `findOverlap`, `normalizeWard` and `DatedRate`, and `parseRupeesToPaise` (SP1 Task 2).
- Produces:
  - `csv.ts`:
    - `class CsvSyntaxError extends Error { line: number }`
    - `parseCsv(text: string): { header: string[]; rows: { line: number; cells: string[] }[] }`. It follows RFC 4180: it handles quoted fields, `""` escapes, embedded commas and newlines in quotes, and CRLF or LF line ends. It strips a leading BOM and skips fully blank lines. `line` is the 1-based physical line where the record starts. An unterminated quote throws `CsvSyntaxError`.
  - `import.ts`:
    - `MAX_IMPORT_ROWS = 5000`
    - `MAX_IMPORT_BYTES = 1_000_000`
    - `SERVICE_CSV_HEADERS = ['code', 'name', 'department_code', 'category', 'hsn_sac', 'gst_rate_percent', 'active'] as const`
    - `RATE_CSV_HEADERS = ['service_code', 'scope', 'department_code', 'payer_code', 'room_category_code', 'ward', 'amount_inr', 'valid_from', 'valid_to'] as const`
    - `interface ImportLookups { departmentsByCode: Map<string, number>; payersByCode: Map<string, number>; roomCategoriesByCode: Map<string, number>; servicesByCode: Map<string, { id: number; category: ServiceCategory }>; existingRates: DatedRate[] }`. `payersByCode` is keyed by `payers.payer_id`.
    - `interface ImportIssue { line: number; column?: string; message: string }`
    - `type ServiceImportRow = ServiceCreateInput & { isActive: boolean; existingId: number | null }`
    - `validateServiceImport(text: string, lookups: ImportLookups): { rows: ServiceImportRow[]; issues: ImportIssue[] }`
    - `validateRateImport(text: string, lookups: ImportLookups): { rows: RateCreateInput[]; issues: ImportIssue[] }`
    - Rules:
      - Headers must match exactly, after trimming and lower-casing; otherwise there is one issue at line 1.
      - The `active` column accepts `yes/no/true/false/1/0`.
      - Amounts go through `parseRupeesToPaise`. GST goes through `gstPercentToBp`.
      - Codes are trimmed and upper-cased, and an unknown code is an issue that names the column.
      - A code repeated in the file is an issue.
      - Each rate row is validated with `rateCreateSchema`. It is then checked with `findOverlap` against `existingRates` **and** against the earlier rows of the same file.
      - More than `MAX_IMPORT_ROWS` rows, or text longer than `MAX_IMPORT_BYTES`, gives one issue.
      - Any `CsvSyntaxError` gives one issue at its line.
      - When `issues` is not empty, `rows` must not be committed. The API enforces this.

- [ ] **Step 1: Write the failing tests**

```ts
// csv.test.ts
it('parses an Excel-style CSV', () => {
  const text = '﻿code,name,amount\r\nDRS-S,"Dressing, small","1,250.00"\r\n\r\nDRS-L,"Dressing ""large""",900\r\n'
  expect(parseCsv(text)).toEqual({ header: ['code', 'name', 'amount'], rows: [{ line: 2, cells: ['DRS-S', 'Dressing, small', '1,250.00'] }, { line: 4, cells: ['DRS-L', 'Dressing "large"', '900'] }] })
})
it('keeps a newline inside quotes and reports the record start line', () => {})
it('throws CsvSyntaxError with the line of an unterminated quote', () => {})
// import.test.ts
it('accepts a valid service file and marks existing codes as updates', () => {})
it('one bad row blocks commit with its line number', () => {
  const r = validateServiceImport('code,name,department_code,category,hsn_sac,gst_rate_percent,active\nOPD,OPD consult,GEN_MED,consultation,999312,0,yes\nBAD,X,NOPE,consultation,999312,0,yes\n', lookups)
  expect(r.issues).toEqual([{ line: 3, column: 'department_code', message: 'Unknown department code NOPE' }])
})
it('rejects a wrong header with a single line-1 issue', () => {})
it('flags a rate that overlaps an existing rate and one that overlaps an earlier row', () => {})
it('converts amount_inr "1,250.50" to 125050 paise and gst "18%" to 1800', () => {})
it('rejects files over MAX_IMPORT_ROWS', () => {})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/tariff/csv.test.ts tests/lib/tariff/import.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** both modules. The parser is a character-level state machine. Add no new dependency.

- [ ] **Step 4: Run the tests to verify they pass**

Run: same command as Step 2.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tariff/csv.ts src/lib/tariff/import.ts tests/lib/tariff/csv.test.ts tests/lib/tariff/import.test.ts
git commit -m "feat(sp2): CSV parser and tariff import validation"
```

---

### Task 7: Tariff query layer

**Files:**
- Create: `src/lib/queries/tariff.ts`
- Test: `tests/lib/queries/tariff-mapping.test.ts` (pure), `tests/lib/queries/tariff.test.ts` (DB, skipIf)

**Interfaces:**
- Consumes: Tasks 1–6 and SP1 Task 2 (`departments` and the `db-errors` helpers).
- Produces:
  - `interface ServiceRow extends ServiceCatalogRow { departmentCode: string; departmentName: string }`
  - `interface RateRow extends TariffRateRow { payerName: string | null; departmentName: string | null; roomCategoryCode: string | null }`
  - `class TariffOverlapError extends Error { conflictingRateId: number | null }`
  - `toRateCandidate(row: RateRow): TariffRateCandidate` (pure, and exported for the mapping test)
  - `toDatedRate(row: TariffRateRow): DatedRate` (pure)
  - Reads:
    - `listServices(opts: { q?: string; departmentId?: number; category?: ServiceCategory; includeInactive?: boolean; limit?: number }): Promise<ServiceRow[]>`. `q` matches the code prefix or a case-insensitive substring of the name. The default limit is 200.
    - `listServicesWithCurrentPrices(opts: same as listServices, onDate: string): Promise<(ServiceRow & { basePaise: number | null; departmentPaise: number | null })[]>`. It runs one rates query for all listed ids and resolves in memory with `resolvePrice`.
    - `getService(id: number): Promise<ServiceRow | null>` and `getServiceByCode(code: string): Promise<ServiceRow | null>`
  - Service writes: `createService(input: ServiceCreateInput): Promise<ServiceRow>` and `updateService(id: number, patch: ServiceUpdateInput): Promise<ServiceRow | null>`, which also sets `updatedAt`.
  - Rate reads and writes:
    - `listRatesForService(serviceId: number): Promise<RateRow[]>`, ordered by scope, dims and `validFrom` descending
    - `getRate(id: number): Promise<RateRow | null>`
    - `createRate(input: RateCreateInput, byName: string): Promise<RateRow>`. It normalises `ward`, runs `findOverlap` against the service's live rates first and throws `TariffOverlapError`; the DB exclusion is the backstop.
    - `reviseRate(id: number, input: RateRevisionInput, byName: string): Promise<{ closed: RateRow; created: RateRow }>`. It runs in one transaction with `planRevision`, and throws `Error(plan.error)` on a rejected plan.
    - `endRate(id: number, validTo: string): Promise<RateRow | null>` and `deactivateRate(id: number): Promise<RateRow | null>`
  - `loadPricingContext(serviceId: number): Promise<{ service: ServiceForPricing | null; rates: TariffRateCandidate[] }>`
  - Room categories:
    - `listRoomCategories(includeInactive?: boolean): Promise<RoomCategory[]>`
    - `getRoomCategoryByCode(code: string): Promise<RoomCategory | null>`
    - `createRoomCategory(input: { code: string; name: string }): Promise<RoomCategory>`
    - `updateRoomCategory(id: number, patch: { name?: string; isActive?: boolean }): Promise<RoomCategory | null>`
    - `listRoomsWithCategory(): Promise<{ id: number; ward: string; roomNumber: string; bedNumber: string; roomCategoryId: number | null }[]>`
    - `setRoomCategory(roomId: number, roomCategoryId: number | null): Promise<boolean>`
  - Packages:
    - `listPackageItems(packageServiceId: number): Promise<{ itemServiceId: number; code: string; name: string; quantity: number }[]>`
    - `replacePackageItems(packageServiceId: number, items: PackageItemsInput['items']): Promise<void>` (a transaction)
    - `packageItemsProblem(pkg: ServiceRow, items: PackageItemsInput['items'], servicesById: Map<number, ServiceRow>): string | null` (pure and exported). The checks are: the package's category must be `package`; an item cannot be the package itself; an item cannot itself be a package (no nesting); and items must be active.
  - Import:
    - `getImportLookups(): Promise<ImportLookups>`
    - `commitServiceImport(rows: ServiceImportRow[]): Promise<number>`
    - `commitRateImport(rows: RateCreateInput[], byName: string): Promise<number>`
    - Both run in one transaction and return the count.

- [ ] **Step 1: Write the failing tests**

```ts
// tariff-mapping.test.ts (pure)
it('toRateCandidate maps deactivatedAt to deactivated and keeps the room category code', () => {})
it('packageItemsProblem rejects self, nested packages, inactive items and a non-package parent', () => {})
// tariff.test.ts -- describe.skipIf(!process.env.DATABASE_URL)
// fixtures: department TEST_SP2_D (or reuse via getDepartmentByCode), room category TEST_SP2_PVT, services TEST_SP2_*; afterEach deletes children-first
it('createRate throws TariffOverlapError for an overlapping base rate', async () => {})
it('reviseRate closes and inserts atomically; resolver sees the new amount from effectiveFrom', async () => {})
it('loadPricingContext + resolvePrice returns the payer rate for that payer only', async () => {})
it('commitRateImport is all-or-nothing when the DB rejects one row', async () => {})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/queries/tariff-mapping.test.ts tests/lib/queries/tariff.test.ts`
Expected: FAIL for mapping; DB file skipped.

- [ ] **Step 3: Implement** `tariff.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: same command as Step 2, then `npx tsc --noEmit`.
Expected: PASS for mapping; DB file skipped.

- [ ] **Step 5: Commit**

```bash
git add src/lib/queries/tariff.ts tests/lib/queries/tariff-mapping.test.ts tests/lib/queries/tariff.test.ts
git commit -m "feat(sp2): tariff query layer and pricing context loader"
```

---

### Task 8: Role policy + service and room-category APIs

**Files:**
- Modify: `src/lib/role-policy.ts`. Add:
  ```ts
  export const TARIFF_MANAGE_ROLES: readonly Role[] = ['admin', 'billing']
  export const TARIFF_LOOKUP_ROLES: readonly Role[] = ['admin', 'billing', 'crc', 'frontdesk']
  ```
- Modify: `src/lib/role-capabilities.ts`:
  - admin and billing: `'Manage the service catalogue, tariffs, packages and room categories, including CSV tariff import'`
  - crc and frontdesk: `'Look up the current price of a service'`
- Create:
  - `src/app/api/tariff/services/route.ts` (GET, POST)
  - `src/app/api/tariff/services/[id]/route.ts` (PATCH)
  - `src/app/api/tariff/room-categories/route.ts` (GET, POST)
  - `src/app/api/tariff/room-categories/[id]/route.ts` (PATCH)
  - `src/app/api/tariff/rooms/[id]/category/route.ts` (PUT)
- Modify: `tests/api/rbac-route-gates.test.ts`. If `send` does not yet accept `'PATCH'`, which SP1 Task 8 adds, widen it to `'POST' | 'PUT' | 'PATCH'`. Add rows.
- Test: `tests/api/tariff-services.test.ts`

**Interfaces:**
- Consumes: the Task 7 query functions and Task 3 schemas.
- Produces:
  - `GET /api/tariff/services?q=&departmentId=&category=&includeInactive=`:
    - Gated to `TARIFF_LOOKUP_ROLES`.
    - `includeInactive` is honoured only for `TARIFF_MANAGE_ROLES`.
    - Returns `{ services: { id, code, name, departmentId, departmentName, category, hsnSac, gstRateBp, isActive }[] }`.
  - `POST /api/tariff/services`:
    - Gated to `TARIFF_MANAGE_ROLES`. The body is `serviceCreateSchema`.
    - Returns 400 for an unknown `departmentId` (via `getDepartmentById`) and 409 `{ error: 'Service code already exists' }` on `service_catalog_code_unique`; otherwise 201 `ServiceRow`.
    - Audits `` `tariff: created service ${code}` ``.
  - `PATCH /api/tariff/services/[id]`:
    - Gated to `TARIFF_MANAGE_ROLES`. The body is `serviceUpdateSchema`. Returns 400 for a non-integer id and 404 for an unknown one.
    - Audits `` `tariff: updated service ${code}` ``, or `` `tariff: deactivated service ${code}` `` when `isActive === false`.
  - `GET /api/tariff/room-categories` is gated to `TARIFF_LOOKUP_ROLES`. `POST /api/tariff/room-categories` is gated to `TARIFF_MANAGE_ROLES`, returns 409 on `room_categories_code_unique`, and audits `` `tariff: created room category ${code}` ``.
  - `PATCH /api/tariff/room-categories/[id]` is gated to `TARIFF_MANAGE_ROLES`.
  - `PUT /api/tariff/rooms/[id]/category`:
    - Gated to `TARIFF_MANAGE_ROLES`. The body is `roomAssignmentSchema`.
    - Returns 404 for an unknown room.
    - Audits `` `tariff: set room category for room #${id}` ``.

- [ ] **Step 1: Write the failing tests** (`vi.mock('@/lib/queries/tariff')`, `vi.mock('@/lib/queries/departments')`, `vi.mock('@/lib/audit')`)

```ts
it('GET services admits crc and frontdesk but hides inactive for them', async () => { /* listServices called with includeInactive false for crc even if ?includeInactive=1 */ })
it('GET services 403s pi, pharmacy, labs', async () => {})
it('POST services 403s crc and frontdesk before parsing', async () => {})
it('POST services maps service_catalog_code_unique to 409', async () => {})
it('POST services 400s an unknown departmentId', async () => {})
it('PATCH services refuses a code change', async () => {})
it('PATCH services with isActive:false audits a deactivation', async () => {})
it('PUT rooms/[id]/category accepts null to clear', async () => {})
```

Harness rows (all `settle`-wrapped):

```ts
{ name: 'GET /api/tariff/services', call: () => settle(() => listTariffServices(get('/api/tariff/services'))), allowed: [...TARIFF_LOOKUP_ROLES] },
{ name: 'POST /api/tariff/services', call: () => settle(() => postTariffService(send('POST', '/api/tariff/services'))), allowed: [...TARIFF_MANAGE_ROLES] },
{ name: 'PATCH /api/tariff/services/[id]', call: () => settle(() => patchTariffService(send('PATCH', `/api/tariff/services/${BOGUS_ID}`), ctx({ id: BOGUS_ID }))), allowed: [...TARIFF_MANAGE_ROLES] },
{ name: 'GET /api/tariff/room-categories', call: () => settle(() => listRoomCategoriesRoute(get('/api/tariff/room-categories'))), allowed: [...TARIFF_LOOKUP_ROLES] },
{ name: 'POST /api/tariff/room-categories', call: () => settle(() => postRoomCategory(send('POST', '/api/tariff/room-categories'))), allowed: [...TARIFF_MANAGE_ROLES] },
{ name: 'PATCH /api/tariff/room-categories/[id]', call: () => settle(() => patchRoomCategory(send('PATCH', `/api/tariff/room-categories/${BOGUS_ID}`), ctx({ id: BOGUS_ID }))), allowed: [...TARIFF_MANAGE_ROLES] },
{ name: 'PUT /api/tariff/rooms/[id]/category', call: () => settle(() => putRoomCategory(send('PUT', `/api/tariff/rooms/${BOGUS_ID}/category`), ctx({ id: BOGUS_ID }))), allowed: [...TARIFF_MANAGE_ROLES] },
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/api/tariff-services.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the routes, the role constants and the capability bullets.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/api/tariff-services.test.ts tests/lib/role-capabilities.test.ts && npx vitest run tests/api/rbac-route-gates.test.ts -t "/api/tariff/(services|room-categories|rooms)" && npx vitest run tests/api/rbac-route-gates.test.ts -t "gap tag"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/role-policy.ts src/lib/role-capabilities.ts src/app/api/tariff/services src/app/api/tariff/room-categories src/app/api/tariff/rooms tests/api/tariff-services.test.ts tests/api/rbac-route-gates.test.ts
git commit -m "feat(sp2): service catalogue and room-category APIs with RBAC"
```

---

### Task 9: Rate and package APIs

**Files:**
- Create:
  - `src/app/api/tariff/rates/route.ts` (POST)
  - `src/app/api/tariff/rates/[id]/route.ts` (PATCH)
  - `src/app/api/tariff/rates/[id]/revise/route.ts` (POST)
  - `src/app/api/tariff/packages/[id]/items/route.ts` (PUT)
- Modify: `tests/api/rbac-route-gates.test.ts`. Add four rows.
- Test: `tests/api/tariff-rates.test.ts`

**Interfaces:**
- Consumes: Task 7 (`createRate`, `reviseRate`, `endRate`, `deactivateRate`, `getRate`, `getService`, `replacePackageItems`, `packageItemsProblem`, `TariffOverlapError`) and Task 3 schemas. Also `isExclusionViolation`.
- Produces (every route is gated to `TARIFF_MANAGE_ROLES`):
  - `POST /api/tariff/rates`:
    - The body is `rateCreateSchema`. It returns 400 for an unknown service, payer, department or room category, and returns 201 `RateRow`.
    - It returns 409 `{ error: 'This rate overlaps an existing rate for the same service, scope and room/ward' }` on `TariffOverlapError` **or** on `isExclusionViolation(err, 'tariff_rates_no_overlap')`.
    - It audits `` `tariff: added ${scope} rate for ${serviceCode}` ``.
  - `POST /api/tariff/rates/[id]/revise`:
    - The body is `rateRevisionSchema`. An error from `planRevision` gives 400 `{ error: <its exact message> }`, and an overlap gives 409.
    - On success it returns 200 `{ closed, created }` and audits `` `tariff: revised rate #${id} for ${serviceCode} from ${effectiveFrom}` ``.
  - `PATCH /api/tariff/rates/[id]`:
    - The body is `ratePatchSchema`. `{ validTo }` calls `endRate` (400 if `validTo < validFrom`) and audits `` `tariff: ended rate #${id}` ``.
    - `{ deactivate: true }` calls `deactivateRate` and audits `` `tariff: deactivated rate #${id}` ``.
  - `PUT /api/tariff/packages/[id]/items`:
    - The body is `packageItemsSchema`. It returns 400 `{ error: packageItemsProblem(...) }` when that is not null.
    - It audits `` `tariff: updated package items for ${code}` ``.

- [ ] **Step 1: Write the failing tests** (mock `@/lib/queries/tariff` and `@/lib/audit`)

```ts
it('POST rates 403s crc and frontdesk before parsing', async () => {})
it('POST rates maps TariffOverlapError to 409', async () => {})
it('maps tariff_rates_no_overlap exclusion to 409', async () => {
  vi.mocked(createRate).mockRejectedValue({ message: 'Failed query', cause: { code: '23P01', constraint: 'tariff_rates_no_overlap' } })
  expect((await POST(req(validRate()))).status).toBe(409)
})
it('revise returns 400 with the planRevision message for a back-dated revision', async () => {
  vi.mocked(reviseRate).mockRejectedValue(new Error('New rate must start after the current rate starts'))
  const res = await revise(req({ amountPaise: 1, effectiveFrom: '2020-01-01' }), ctx('5')); expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: 'New rate must start after the current rate starts' })
})
it('PATCH rates deactivates and audits', async () => {})
it('PUT package items rejects a nested package', async () => {})
```

Harness rows (all `settle`-wrapped):
- `POST /api/tariff/rates`
- `POST /api/tariff/rates/[id]/revise`
- `PATCH /api/tariff/rates/[id]`
- `PUT /api/tariff/packages/[id]/items`

Each has `allowed: [...TARIFF_MANAGE_ROLES]`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/api/tariff-rates.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the four routes.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/api/tariff-rates.test.ts && npx vitest run tests/api/rbac-route-gates.test.ts -t "/api/tariff/(rates|packages)"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/tariff/rates src/app/api/tariff/packages tests/api/tariff-rates.test.ts tests/api/rbac-route-gates.test.ts
git commit -m "feat(sp2): effective-dated rate create/revise/end and package APIs"
```

---

### Task 10: Lookup API `GET /api/tariff/resolve`

**Files:**
- Create: `src/app/api/tariff/resolve/route.ts`
- Modify: `tests/api/rbac-route-gates.test.ts`. Add one row.
- Test: `tests/api/tariff-resolve.test.ts`

**Interfaces:**
- Consumes: `resolveQuerySchema` (Task 3), `resolvePrice` (Task 4), `loadPricingContext` and `getServiceByCode` (Task 7), and `todayIsoIn` (SP1 Task 2).
- Produces: `GET /api/tariff/resolve?serviceId=|serviceCode=&payerId=&departmentId=&roomCategory=&ward=&onDate=`:
  - It is gated to `TARIFF_LOOKUP_ROLES`.
  - It builds the query with `Object.fromEntries(request.nextUrl.searchParams)` and `resolveQuerySchema`, which is strict. An unknown parameter such as `patientId` gives 400 `{ error: 'Invalid price lookup' }`.
  - `onDate` defaults to `todayIsoIn('Asia/Kolkata')`.
  - `serviceCode` is turned into an id with `getServiceByCode`. An unknown code gives 200 `{ ok: false, reason: 'service_not_found' }`.
  - It always returns 200 with the `PriceResolution` JSON for valid parameters, plus `{ formatted: formatPaise(amountPaise) }` when `ok`.
  - It writes no audit entry.
  - This is the single entry point SP4 charge capture will call. Charges are not changed in this plan.

- [ ] **Step 1: Write the failing tests** (mock `@/lib/queries/tariff`)

```ts
it('frontdesk can look up a price; pi, pharmacy, labs cannot', async () => {})
it('rejects an unknown query parameter such as patientId', async () => {})
it('defaults onDate to today in Asia/Kolkata', async () => {
  vi.setSystemTime(new Date('2026-10-06T19:00:00Z')) // already 7 Oct in IST
  /* loadPricingContext returns rates valid from 2026-10-07 -> ok true */
})
it('resolves by serviceCode and returns the formatted INR amount', async () => { /* body.formatted === '₹500.00' */ })
it('returns ok:false no_rate with 200', async () => {})
```

Harness row: `{ name: 'GET /api/tariff/resolve', call: () => settle(() => resolveTariff(get('/api/tariff/resolve'))), allowed: [...TARIFF_LOOKUP_ROLES] }`

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/api/tariff-resolve.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the route.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/api/tariff-resolve.test.ts && npx vitest run tests/api/rbac-route-gates.test.ts -t "/api/tariff/resolve"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/tariff/resolve tests/api/tariff-resolve.test.ts tests/api/rbac-route-gates.test.ts
git commit -m "feat(sp2): /api/tariff/resolve price lookup"
```

---

### Task 11: CSV import API

**Files:**
- Create: `src/app/api/tariff/import/route.ts` (POST)
- Modify: `tests/api/rbac-route-gates.test.ts`. Add one row.
- Test: `tests/api/tariff-import.test.ts`

**Interfaces:**
- Consumes: `validateServiceImport`, `validateRateImport` and `MAX_IMPORT_BYTES` (Task 6), and `getImportLookups`, `commitServiceImport` and `commitRateImport` (Task 7).
- Produces: `POST /api/tariff/import`, gated to `TARIFF_MANAGE_ROLES`:
  - The body is `{ kind: 'services' | 'rates', csv: string, commit: boolean }`, `.strict()`. A CSV longer than `MAX_IMPORT_BYTES` gives 400 `{ error: 'CSV is larger than 1 MB' }`.
  - It always validates first. The response is `{ kind, rowCount, issues: ImportIssue[], committed: boolean, applied?: number }`.
  - When `commit` is true and `issues` is not empty, it returns 422 with `committed: false`.
  - When `commit` is true and there are no issues, it commits and audits `` `tariff: imported ${applied} ${kind}` ``.
  - A DB exclusion or unique violation during commit gives 409 `{ error: 'Import conflicts with existing data; nothing was applied' }`.

- [ ] **Step 1: Write the failing tests**

```ts
it('dry run returns issues and never commits', async () => {})
it('commit with issues returns 422 and does not call commitRateImport', async () => {})
it('commit without issues applies and audits the count', async () => {})
it('maps a commit-time exclusion violation to 409', async () => {})
it('rejects a CSV over 1 MB', async () => {})
it('403s crc and frontdesk', async () => {})
```

Harness row: `{ name: 'POST /api/tariff/import', call: () => settle(() => postTariffImport(send('POST', '/api/tariff/import'))), allowed: [...TARIFF_MANAGE_ROLES] }`

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/api/tariff-import.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the route.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/api/tariff-import.test.ts && npx vitest run tests/api/rbac-route-gates.test.ts -t "/api/tariff/import"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/tariff/import tests/api/tariff-import.test.ts tests/api/rbac-route-gates.test.ts
git commit -m "feat(sp2): validated all-or-nothing tariff CSV import API"
```

---

### Task 12: `/tariffs` service catalogue page + nav entry

**Files:**
- Create: `src/app/(dashboard)/tariffs/page.tsx`, `src/components/tariff/ServicesTable.tsx`, `src/components/tariff/ServiceFormModal.tsx`
- Modify: `src/components/LeftNav.tsx`. Add `{ href: '/tariffs', label: 'Tariffs', icon: Tags, roles: ['admin', 'billing'] as Role[] }` to `NAV_TRAILING_ITEMS`, before Settings at line 105, and import `Tags` from lucide.
- Modify: `tests/pages/page-gates-harness.ts`. Add a row.
- Test: `tests/components/tariff/ServicesTable.test.tsx`, `tests/components/tariff/ServiceFormModal.test.tsx`

**Interfaces:**
- Consumes: `listServicesWithCurrentPrices` and `listRoomCategories` (Task 7), `listDepartments` (SP1 Task 2), `TARIFF_MANAGE_ROLES` (Task 8), the service APIs (Task 8), `formatPaise`, `todayIsoIn`, and `SERVICE_CATEGORIES` and `GST_RATES_BP` (Task 3).
- Produces:
  - The page runs `requireSessionOrRedirect()` first. If `!TARIFF_MANAGE_ROLES.includes(role)` it runs `redirect('/')`. It reads `searchParams: Promise<{ q?: string; departmentId?: string; category?: string; inactive?: string }>`.
  - It loads `listServicesWithCurrentPrices(filters, todayIsoIn())` and `listDepartments({ activeOnly: true })`.
  - It renders `<ServicesTable>` with links to `/tariffs/room-categories` and `/tariffs/import`.
  - `<ServicesTable services departments />`:
    - The columns are Code, Name, Department, Category, HSN/SAC, GST %, Base price, Department price and Status.
    - The department filter acts as the **department price list** view: it filters by department and shows each service's current department price.
    - Each row links to `/tariffs/services/[id]`. "New service" opens `<ServiceFormModal mode="create">` and "Edit" opens it with `mode="edit"`.
    - "Deactivate" asks for confirmation, then PATCHes `{ isActive: false }`.
  - `<ServiceFormModal>` validates client-side with `serviceCreateSchema` / `serviceUpdateSchema`. The code field is read-only in edit mode. The GST select uses `GST_RATES_BP` labelled as percent. Errors from the server show inline.

- [ ] **Step 1: Write the failing tests**

```ts
// ServicesTable.test.tsx
it('shows base and department prices in INR and a dash when missing', () => { /* basePaise 50000 -> '₹500.00'; departmentPaise null -> '—' */ })
it('links each row to its detail page', () => {})
it('asks for confirmation before deactivating and PATCHes isActive false', async () => {})
// ServiceFormModal.test.tsx
it('flags a SAC/HSN mismatch for a consumable before submitting', async () => {})
it('keeps the code read-only in edit mode', () => {})
```

Harness row:

```ts
// LeftNav NAV_TRAILING_ITEMS /tariffs -- TARIFF_MANAGE_ROLES
{ route: '/tariffs', load: () => import('@/app/(dashboard)/tariffs/page'), props: { searchParams: Promise.resolve({}) }, allowed: ['admin', 'billing'] },
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/components/tariff/ServicesTable.test.tsx tests/components/tariff/ServiceFormModal.test.tsx tests/pages/nav-role-enforcement.test.tsx`
Expected: FAIL. The component tests fail, and the nav test fails once the nav entry is added without the page.

- [ ] **Step 3: Implement** the page, components and nav entry.

- [ ] **Step 4: Run the tests to verify they pass**

Run: same command as Step 2, plus `npx vitest run tests/components/LeftNav.test.tsx`.
Expected: PASS. The `/tariffs` row admits admin and billing and redirects every other role without calling `getDb`.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/tariffs/page.tsx" src/components/tariff/ServicesTable.tsx src/components/tariff/ServiceFormModal.tsx src/components/LeftNav.tsx tests/pages/page-gates-harness.ts tests/components/tariff
git commit -m "feat(sp2): tariffs service catalogue page and nav entry"
```

---

### Task 13: Service detail page: rate versions, revisions, packages

**Files:**
- Create: `src/app/(dashboard)/tariffs/services/[id]/page.tsx`, `src/components/tariff/RateVersionsTable.tsx`, `AddRateModal.tsx`, `ReviseRateModal.tsx`, `PackageItemsEditor.tsx`
- Modify: `tests/pages/page-gates-harness.ts`. Add a row.
- Test: `tests/components/tariff/RateVersionsTable.test.tsx`, `tests/components/tariff/AddRateModal.test.tsx`, `tests/components/tariff/PackageItemsEditor.test.tsx`

**Interfaces:**
- Consumes:
  - Task 7: `getService`, `listRatesForService`, `listPackageItems`, `listServices` and `listRoomCategories`
  - `listPayers` from `src/lib/queries/payers.ts`
  - `listDepartments`
  - the Task 9 APIs
  - `formatPaise`, `parseRupeesToPaise` and `todayIsoIn`
- Produces:
  - The page runs `requireSessionOrRedirect()`, then the `TARIFF_MANAGE_ROLES` gate, then `await params`. A non-integer or unknown id calls `notFound()`.
  - It renders the service header (code, name, department, category, HSN/SAC, GST) and `<RateVersionsTable>`. For a `package` service it also renders `<PackageItemsEditor>`.
  - `<RateVersionsTable rates today: string />`:
    - It groups rows by scope (Base / Department price list / Payer), then by room category and ward.
    - The status of each row is computed against `today`: `current`, `scheduled` (validFrom > today), `ended` (validTo < today), or `deactivated`.
    - Actions:
      - **Revise** is shown on current and scheduled rows and opens `<ReviseRateModal>`.
      - **End on date** PATCHes `{ validTo }`.
      - **Deactivate** asks for confirmation and PATCHes `{ deactivate: true }`.
  - `<AddRateModal serviceId departments payers roomCategories />`:
    - The scope select shows the department select for `department` and the payer select for `payer`.
    - Optional room category and ward fields are labelled "per day" when the service category is `room_rent`.
    - The amount is entered in rupees and converted with `parseRupeesToPaise`.
    - `validFrom` defaults to today.
    - It POSTs `/api/tariff/rates` and shows the 409 message verbatim.
  - `<ReviseRateModal rate />` shows "Current ₹X until <date>, new ₹Y from <effectiveFrom>". It POSTs `/revise` and shows the server's 400 message verbatim.
  - `<PackageItemsEditor packageServiceId items services />` has a service search, quantity inputs, and PUTs `/api/tariff/packages/[id]/items`.

- [ ] **Step 1: Write the failing tests**

```ts
it('labels current, scheduled, ended and deactivated rows against today', () => { /* today '2026-10-07': validFrom 2026-10-08 -> Scheduled; validTo 2026-10-06 -> Ended */ })
it('shows the payer name and room/ward for a payer rate', () => {})
it('AddRateModal converts ₹1,250.50 to amountPaise 125050 and shows the payer select only for payer scope', async () => {})
it('AddRateModal shows the server overlap message on 409', async () => {})
it('PackageItemsEditor PUTs items with quantities and blocks adding the package to itself', async () => {})
```

Harness row: `{ route: '/tariffs/services/[id]', load: () => import('@/app/(dashboard)/tariffs/services/[id]/page'), props: { params: Promise.resolve({ id: '1' }) }, allowed: ['admin', 'billing'] }`

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/components/tariff/RateVersionsTable.test.tsx tests/components/tariff/AddRateModal.test.tsx tests/components/tariff/PackageItemsEditor.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** the page and components.

- [ ] **Step 4: Run the tests to verify they pass**

Run: same command as Step 2, then `npx vitest run tests/pages/nav-role-enforcement.test.tsx -t "tariffs"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/tariffs/services" src/components/tariff/RateVersionsTable.tsx src/components/tariff/AddRateModal.tsx src/components/tariff/ReviseRateModal.tsx src/components/tariff/PackageItemsEditor.tsx tests/pages/page-gates-harness.ts tests/components/tariff
git commit -m "feat(sp2): service detail page with rate versions, revisions and packages"
```

---

### Task 14: Room categories / ward tariffs page and CSV import page

**Files:**
- Create: `src/app/(dashboard)/tariffs/room-categories/page.tsx`, `src/app/(dashboard)/tariffs/import/page.tsx`, `src/components/tariff/RoomCategoriesPanel.tsx`, `src/components/tariff/RoomTariffMatrix.tsx`, `src/components/tariff/TariffImportForm.tsx`
- Modify: `tests/pages/page-gates-harness.ts`. Add two rows.
- Test: `tests/components/tariff/RoomCategoriesPanel.test.tsx`, `tests/components/tariff/RoomTariffMatrix.test.tsx`, `tests/components/tariff/TariffImportForm.test.tsx`

**Interfaces:**
- Consumes:
  - Task 7: `listRoomCategories`, `listRoomsWithCategory`, `listServices({ category: 'room_rent' })` and `listRatesForService`
  - the Task 8 room APIs and the Task 11 import API
  - `SERVICE_CSV_HEADERS` and `RATE_CSV_HEADERS` (Task 6)
  - `todayIsoIn` and `formatPaise`
- Produces:
  - `/tariffs/room-categories` (same gate as the other tariff pages):
    - `<RoomCategoriesPanel categories rooms />` lists categories (create, rename, activate/deactivate). It has a rooms table grouped by ward, with a category select per room that PUTs `/api/tariff/rooms/[id]/category`.
    - `<RoomTariffMatrix services rates categories today />` is a read-only grid with one row per `room_rent` service and one column per room category. Each cell holds the **current** per-day base rate. Ward-specific overrides are listed under the grid. Each service name links to `/tariffs/services/[id]` for editing.
  - `/tariffs/import`:
    - `<TariffImportForm />` has a kind toggle, a file input (read as text in the browser) or a paste textarea, and a "Check file" button that sends `commit: false`.
    - Issues show in a table (Line, Column, Message).
    - "Apply import" is enabled only when there are 0 issues, and sends `commit: true`.
    - It shows the expected headers for the chosen kind (`SERVICE_CSV_HEADERS` / `RATE_CSV_HEADERS`) and a downloadable header-only template built client-side with `Blob`.

- [ ] **Step 1: Write the failing tests**

```ts
it('RoomCategoriesPanel PUTs the chosen category for a room and null for "None"', async () => {})
it('RoomTariffMatrix shows the current per-day base rate per category and lists ward overrides', () => {})
it('TariffImportForm keeps Apply disabled until a dry run returns zero issues', async () => {})
it('TariffImportForm renders line-numbered issues from the dry run', async () => {})
it('TariffImportForm shows the expected headers for the selected kind', () => {})
```

Harness rows:

```ts
{ route: '/tariffs/room-categories', load: () => import('@/app/(dashboard)/tariffs/room-categories/page'), allowed: ['admin', 'billing'] },
{ route: '/tariffs/import', load: () => import('@/app/(dashboard)/tariffs/import/page'), allowed: ['admin', 'billing'] },
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/components/tariff/RoomCategoriesPanel.test.tsx tests/components/tariff/RoomTariffMatrix.test.tsx tests/components/tariff/TariffImportForm.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** the pages and components.

- [ ] **Step 4: Run the tests to verify they pass, along with the full no-DB SP2 slice**

Run: same command as Step 2, then `npx vitest run tests/lib/tariff tests/api/tariff-*.test.ts tests/components/tariff tests/db/service-catalog-schema.test.ts tests/db/tariff-rates-schema.test.ts tests/db/sp2-dependency.test.ts tests/pages/nav-role-enforcement.test.tsx && npx vitest run tests/api/rbac-route-gates.test.ts -t "tariff" && npx tsc --noEmit && npx eslint src`
Expected: PASS. Every page file under `(dashboard)/tariffs` has a `PAGE_GATES` row.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/tariffs/room-categories" "src/app/(dashboard)/tariffs/import" src/components/tariff/RoomCategoriesPanel.tsx src/components/tariff/RoomTariffMatrix.tsx src/components/tariff/TariffImportForm.tsx tests/pages/page-gates-harness.ts tests/components/tariff
git commit -m "feat(sp2): room-category/ward tariff page and CSV import page"
```

---

## Execution notes

**Tests that cannot run here (no `DATABASE_URL`).** These are written now and skip via `describe.skipIf`:
- Task 1: `service catalogue (DB)`
- Task 2: `tariff rates (DB)`, which covers the exclusion constraint, deactivated overlap and scope-keys check
- Task 7: `tests/lib/queries/tariff.test.ts`, which covers overlap, atomic revision, payer resolution end-to-end and an all-or-nothing import

Without a DB, the exclusion constraint is verified only statically (the migration text) and through the pure `findOverlap`. Once the HIMS Neon DB is connected:
1. Apply `2026-10-07-sp1-departments.sql`, then `2026-10-07-sp2-service-catalog.sql`, then `2026-10-07-sp2-tariff-rates.sql`.
2. Run `npm test`.

**Suggested model tier per task:**

| Task | Tier |
|---|---|
| 1 Schema + dependency | standard |
| 2 Rates schema + exclusion | most capable (gist exclusion, immutable expressions, `DO`-block idempotency) |
| 3 Validation | standard |
| 4 Resolver | most capable (the pricing contract) |
| 5 Versions | standard |
| 6 CSV/import | standard |
| 7 Query layer | most capable (transactions, error mapping) |
| 8 Services APIs | standard |
| 9 Rates APIs | standard |
| 10 Resolve API | cheap |
| 11 Import API | cheap |
| 12 List page | standard |
| 13 Detail page | standard |
| 14 Room/import pages | standard |

**Rulings made in this plan:**
1. **SP1 dependency.** SP2 cherry-picks SP1 Task 2's single commit when SP1 is not merged; there is no stub. That commit also carries `money.ts`, `india-time.ts`, `db-errors.ts` and the migration checker, which SP2 uses. SP2 does **not** depend on SP1's `logAudit(details)` extension; it puts identifiers in the action string instead.
2. **One `tariff_rates` table with `scope`** (text plus a check constraint, not a pg enum, so it can sit in the gist exclusion), rather than separate tables per price list.
   - "Department price list" means the `scope='department'` rates of one department.
   - "Payer/TPA tariff" means `scope='payer'` rates referencing the existing `payers` table. Insurer/TPA masters are SP7.
3. **Resolver precedence.** The scope wins first (payer > department > base). Room-category/ward specificity only ranks rates *within* the winning scope.
   - The resolver takes the spec's signature fields: `serviceId`, `payerId?`, `roomCategory?` (category **code**), `ward?` and `onDate`.
   - It also takes one optional addition, `departmentId?`, for the ordering department. It defaults to the service's own department.
4. **Date ranges are inclusive** (`'[]'`). A revision closes the old row the day before the new one starts.
5. **Wards** stay free text, matching `rooms.ward`, compared via `normalizeWard`. Room categories are a new master, with a nullable `rooms.room_category_id` assigned on the room-categories page.
6. **Packages** are services with `category='package'`, priced through the same resolver. There is no nesting. Package items carry a quantity only; there are no per-item price apportionments, which belong to SP4/SP6.
7. **GST** is stored as basis points, restricted to 0/5/12/18/28/40%. The list keeps the pre-September-2025 slabs because tariffs are effective-dated. HSN is required for goods categories (pharmacy, consumable) and SAC (`99xxxx`) for the rest. Tax computation and the CGST/SGST/IGST split are SP4.
8. **Price lookups are not audited** (no PHI, and they would be high-volume). Every write is audited with a `tariff: ` action.
9. **Charges stay as they are.** The existing free-typed `charges.procedureCodes[].chargeCents` is untouched. SP2 only exposes `resolvePrice` and `/api/tariff/resolve`. Wiring charge capture to them, and retiring the USD-cents columns, is SP4.
10. **Fresh deployments:** `db:push` cannot create `tariff_rates_no_overlap`, so `docs/DEPLOYING.md` now requires applying `scripts/migrations/` after `db:push`. The app-level `findOverlap` check covers the gap until then.
