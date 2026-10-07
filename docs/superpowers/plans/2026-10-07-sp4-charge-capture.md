# SP4: Charge Capture & Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the hospital's accounts department a validated, GST-correct billing flow:
- **charge lines** captured against an OPD encounter or an IPD admission, auto-priced from the SP2 tariff resolver (room rent per census day from the admission's room history), with a manual price override that needs permission, a reason and an audit row;
- a pure, table-driven **validation engine** ("valid intake charge against procedural requirements") with an admin rule-configuration screen;
- **GST invoices** with gapless financial-year numbering per document series, immutable once finalised, cancelled only by a credit note;
- **advances, receipts and refunds** with payment modes, a running patient ledger and a pure outstanding computation, all record-keeping only (no gateway);
- billing pages: charge capture, invoice list/detail/print, cash desk (front desk may take money), rules & settings.

The owner's words: "Tariff fixation by room/ward/department" (done in SP2; SP4 consumes `resolvePrice`), "VALID INTAKE CHARGE against PROCEDURAL REQUIREMENTS", "Revenue cycle (accounts dept)".

**Architecture:**
- Every rule and every rupee computation is pure, client-safe code under `src/lib/billing/`: amounts and int4/bigint limits, GST place of supply and the per-line CGST/SGST/IGST split, document numbering, the rule engine, the room-rent census planner, the ledger, request schemas.
- New tables: `billing_settings` (singleton), `charge_rule_configs`, `charge_lines`, `document_counters`, `invoices`, `invoice_lines`, `credit_notes`, `patient_payments`, `refunds`. `payers` and `service_catalog` gain additive billing flags. The legacy `charges` table, its routes, screens, claims and `mock_payments` are **not** altered.
- Query modules run one `getDb().transaction` per write. Each takes the per-patient advisory lock `billing:patient:<id>` first, so captures, finalisations, payments and refunds for one patient serialise. The audit row is written on the same `tx`. Routes are thin; their tests mock the query modules. Query modules have DB tests against the local Postgres container.
- Immutability of issued documents is enforced twice: no app code path updates them, and migration-only triggers reject `UPDATE`/`DELETE` on issued rows.

**Tech Stack:** Next.js 16 App Router (route `params` and page `searchParams` are `Promise`s; `src/proxy.ts`, not middleware), drizzle-orm 0.45 + node-postgres (real transactions; `bigint(…, { mode: 'number' })`), Postgres 15, zod v4, vitest + jsdom + Testing Library, Tailwind `print:` variants, lucide-react.

**Spec:** `docs/superpowers/specs/2026-10-07-indian-hims-design.md` (sections 1–4, 6, 7 are binding; this plan implements sub-project 4, "Charge capture & validation"). §3 "Money: integer paise everywhere … GST per line (HSN/SAC, rate, CGST/SGST/IGST split)". §3 "Documents: server-side PDF generation (… invoice/receipt …)" is **deferred**: SP4 ships HTML print views only (owner instruction).

**Depends on:**
- SP1 + SP2 (merged on `main`): `departments`, `providers`, `patients` SP1 columns (`uhid`, `stateCode` as `IN-xx`, address), `INDIAN_STATES` / `isIndianStateCode` / `stateName` (`src/lib/india/reference.ts`), `formatPaise` / `parseRupeesToPaise` (`src/lib/money.ts`), `service_catalog`, `tariff_rates`, `room_categories`, `rooms.room_category_id`, `resolvePrice` + `PriceResolution` + `ServiceForPricing` (`src/lib/tariff/resolve.ts`), `loadPricingContext(serviceId)` (`src/lib/queries/tariff.ts`), `MAX_AMOUNT_PAISE`, `isoDate`, `GST_RATES_BP`, `serviceUpdateSchema`, `type ServiceCategory` (`src/lib/tariff/validation.ts`), `parseId` / `invalid` / `isRetryableConflict` / `RETRY_MESSAGE` (`src/lib/tariff/route-responses.ts`), `sendJson` / `FIELD_CLASS` (`src/components/tariff/api.ts`), `logAudit(session, action, patientId, details, executor)`, `publicPatientColumns`.
- **SP3 merged on `main`**: `encounters` + `EncounterRow`, `getEncounterById(id, executor)`, `listEncountersForPatient`, `WriteExecutor` (`src/lib/queries/executor.ts`), `istDateOf` / `startOfIstDay` / `formatIsoDate` / `formatDateTimeIn` (`src/lib/india-time.ts`), `addDaysIso` (`src/lib/follow-ups/rules.ts`), `readJsonBody` (`src/lib/follow-ups/route-responses.ts`), `getAdmissionById` / `getActiveAdmissionForPatient` (`src/lib/queries/admissions.ts`), `admission_transfers`.
- **SP6 is optional** (ruling 9): SP4 reads SP6's `service_procedure_codes` table when it exists and treats every service as unmapped when it does not. SP4 never imports SP6 modules. SP5 is not used.

## Global Constraints

- Read `AGENTS.md`. Before writing any route or page, read the matching guide in `node_modules/next/dist/docs/`, because Next 16 differs from training data. Route context is `{ params: Promise<{ … }> }`. Page props are `{ params: Promise<…>; searchParams: Promise<…> }`.
- **Worktree:** fresh `.worktrees/sp4` off `main`, branch `feature/sp4-charge-capture`. Copy `.env.local` from the main checkout. **Task 1 Step 0:** `test -f src/lib/queries/encounters.ts && test -f scripts/migrations/2026-10-07-sp3-encounters-follow-up.sql`. If either is missing, stop and report; do not cherry-pick SP3. Never touch other worktrees.
- **Money (spec §3, exact):** integer paise, `currency 'INR'`. Parse rupee input only with `parseRupeesToPaise`, display only with `formatPaise`. No floats anywhere in a computation; GST maths uses `BigInt`.
  - **int4 paise stays** for per-unit prices and configured amounts, all capped at `MAX_AMOUNT_PAISE = 1_000_000_000` (SP2 ruling): `tariff_rates.amount_paise`, `charge_lines.unit_price_paise`, `charge_lines.resolved_price_paise`, `invoice_lines.unit_price_paise`, `billing_settings.ipd_deposit_threshold_paise`.
  - **bigint paise** (drizzle `bigint(name, { mode: 'number' })`) for every computed amount, every document total, every payment and every sum: `charge_lines.taxable_paise`; `invoice_lines` taxable/CGST/SGST/IGST/total; `invoices` and `credit_notes` totals; `patient_payments.amount_paise`; `refunds.amount_paise`. App cap `MAX_DOCUMENT_PAISE = 1_000_000_000_000` (₹1,000 crore), far below 2^53.
  - Postgres `sum()` over bigint returns `numeric`, which node-postgres returns as a **string**. Every SQL sum goes through `paiseFromDb` (Task 1). Never `Number()` it inline.
  - Legacy `*_cents` columns are untouched. Where SP4 reads one (the pharmacy `unitChargeCents`), its value is taken as paise (spec §3: "migrate existing cents columns' meaning").
- **GST rounding (ruling 5):** per line, half-up to the paise. Intra-state: CGST = SGST = round(taxable × rate/2). Inter-state: IGST = round(taxable × rate). Document totals are sums of line values, never re-rounded. No rupee round-off line.
- **Time:** business dates (service date, invoice date, receipt date, financial year) are Asia/Kolkata `date` values via `todayIsoIn(DEFAULT_TIMEZONE, now)` / `istDateOf(instant)`. Instants are `timestamp` (UTC). Display with `formatIsoDate` / `formatDateTimeIn`. Never `toISOString().slice(0, 10)` on an instant.
- **IDs:** `serial` integer PKs; patient FKs are `text`.
- **PHI (SP1 rules):**
  - Every read of `patients` names its columns or uses `publicPatientColumns`; `tests/lib/no-credential-leak.test.ts` stays green.
  - SP4 code never references `patientAadhaar`, `aadhaar*` or `src/lib/crypto.ts`. `tests/lib/no-aadhaar-leak.test.ts` stays green, and Task 15 adds `src/lib/billing`, `src/lib/queries/invoices.ts`, `src/app/print` and `src/app/(dashboard)/billing/invoices` to its `EXPORT_PATHS`.
  - The invoice snapshot carries patient id, name, UHID and postal address only: no Aadhaar, no ABHA, no phone, no email, no DOB.
  - Audit `details` carry ids, document numbers, codes, enum values and paise amounts only. They never carry reasons, payment references or item names.
- **RBAC** (constants added in Task 4 to `src/lib/role-policy.ts`, block commented `// SP4`):

  | Constant | Roles | Grants |
  |---|---|---|
  | `CHARGE_CAPTURE_ROLES` | admin, crc, billing (= `CHARGES_ROLES`) | capture, preview and void lines; post room rent; create and discard draft invoices; every `/billing/*` SP4 page; invoice print |
  | `BILLING_AUTHORITY_ROLES` | admin, billing | manual price override; overriding an overridable blocking rule; finalise an invoice; cancel by credit note; issue a refund |
  | `CASH_DESK_ROLES` | admin, billing, crc, frontdesk | `/cash-desk`; record advances and receipts; view a patient's ledger; receipt print |
  | `BILLING_CONFIG_ROLES` | admin (= `MASTER_DATA_ADMIN_ROLES`) | billing settings, rule configuration and payer billing flags writes |

  - frontdesk records advances and receipts but never overrides a price, finalises, cancels or refunds.
  - **API order:** `requireSession()`, then the inline allowlist returning exactly `NextResponse.json({ error: 'Forbidden' }, { status: 403 })`, then `readJsonBody`. Bad JSON → `400 { error: 'Invalid JSON' }`, never a 500. Field-level permission (price override, rule override) is checked after parse and answers `403` with the task's exact message.
  - **Page order:** `requireSessionOrRedirect()` first, then `redirect('/')` for a denied role, before any data load.
  - **Harnesses:** every new route gets an `API_GATES` row (wrapped in `settle()`) and every POST/PUT gets an `SP4_WRITE_GATES` deny-before-parse row in `tests/api/rbac-route-gates.test.ts` (Task 6 creates the `SP4_WRITE_GATES` array and adds it to the `describe.each` spread). Every new page gets a `PAGE_GATES` row in `tests/pages/page-gates-harness.ts`. No `gap` tags. `LeftNav` roles equal the page gate; every `NAV_BILLING_ITEMS` entry is gated to exactly `BILLING_ROLES`.
- **Audit:** every write calls `logAudit(session, action, patientId | null, details, tx)` inside its transaction. Action strings start `billing: ` and are exactly those each task names.
- **Errors:** a deadlock or serialization failure (`40P01` / `40001`, `isRetryableConflict`) maps to `409 { error: RETRY_MESSAGE }`. Other unexpected errors are a generic 500 that logs only the pg code and constraint (`billingServerError`, Task 6).
- **Schema changes:** `src/db/schema.ts` block commented `// SP4` + idempotent SQL `scripts/migrations/2026-10-07-sp4-a-charge-lines.sql` (Task 4) and `scripts/migrations/2026-10-07-sp4-b-invoices-ledger.sql` (Task 5), in the SP1/SP3 style:
  - `BEGIN; … COMMIT;`, `IF NOT EXISTS` everywhere, each `CREATE TYPE` in a `DO` block catching `duplicate_object`, each FK/unique/check in a `DO` block testing `pg_constraint`, named exactly as drizzle names it, each `CREATE TRIGGER` in a `DO` block testing `pg_trigger`, functions as `CREATE OR REPLACE FUNCTION`, no `DROP`.
  - Apply **only** to the local container, **twice** (both runs end in `COMMIT`): `/Users/k2a/.docker/bin/docker exec -i hims-local-pg psql -U postgres -d hims -v ON_ERROR_STOP=1 < scripts/migrations/<file>`.
  - Never `db:push` / `drizzle-kit push`; never `scripts/apply-sql.mjs`. The triggers exist only in migration B (like SP2's exclusion constraint), and `docs/DEPLOYING.md` §4 already says to apply every migration after `db:push`.
- **Tests:**
  - Pure and mocked: `npx vitest run <file>`. DB: `npm test -- <file>` (loads `.env.local`).
  - New DB tests: `describe.skipIf(!process.env.DATABASE_URL)('… (DB)', …)`, fixtures prefixed `TEST-SP4-${RUN}`. Finalising tests pass `now = new Date('2099-06-01T06:00:00Z')` so they number in the `2099-00` financial year, never a real one. Cleanup uses `purgeBillingFixtures` (Task 5), children first: `refunds` → `patient_payments` → `credit_notes` → `invoice_lines` → `charge_lines` → `invoices` → `document_counters` (`financial_year = '2099-00'`), then the SP3 order.
  - **Never run the whole suite or `tests/db/seed.test.ts` during task work**: it truncates and reseeds the shared local DB.
- **Per-task verification:** the task's tests, plus `npx tsc --noEmit` and `npx eslint <changed files>`.
- **Branding:** no hard-coded product name. Use `brand` (server) or `useBrand()` (client).
- **Merging:** SP5/SP6 also edit `schema.ts`, `seed.ts`, `role-policy.ts`, `role-capabilities.ts`, `LeftNav.tsx` and both harness files. Keep SP4 additions in their own blocks commented `// SP4`.
- No secrets. The executor commits per task as written. Nothing is committed while planning.

## Review Focus

1. **Two clerks finalising at the same moment, or a finalise that fails after a number was drawn.** Numbers must stay consecutive, with no duplicate and no gap; the failed invoice stays a draft. Test: Task 10 `concurrent finalisations get consecutive numbers` and `a finalise that throws after numbering leaves no gap`.
2. **A large IPD bill crossing 2^31 paise (≈ ₹2.15 crore).** Line totals, invoice totals, receipts and ledger sums must be exact, including SQL `sum()` results that come back as strings. Test: Task 1 `line of ₹1 crore × 3 is exact`, Task 5 `stores and reads back 2^31 paise`, Task 12 `ledger sum above 2^31 is exact`.
3. **The IST midnight and 1 April boundaries.** A finalise at 00:10 IST on 1 April (18:40 UTC on 31 March) numbers in the new financial year; a room-rent census day ends at IST midnight, not UTC midnight. Test: Task 1 `financial year turns at IST midnight on 1 April`, Task 3 `census day ends at IST midnight`, Task 10 `finalise just after IST midnight on 1 April uses the new series`.
4. **A double-clicked "Add charge"**, or two clerks adding the same service at once. The second capture must see the first and be refused as a duplicate, never a silent double charge. Test: Task 7 `two concurrent identical captures: one line, one duplicate_charge refusal`.
5. **A full card number or other sensitive digits typed into a payment reference.** It must be refused with a plain message, while a 12-digit UPI UTR is accepted. References never reach the audit log. Test: Task 3 `rejects a Luhn-valid card number, accepts a 12-digit UTR`, Task 12 `audit details carry no reference`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/billing/amounts.ts` | Limits, bigint-safe sums, `paiseFromDb` (pure) |
| `src/lib/billing/gst.ts` | GST state codes, GSTIN check, place of supply, per-line tax split, document title (pure) |
| `src/lib/billing/numbering.ts` | Financial year, series prefixes, document number format (pure) |
| `src/lib/billing/charge-rules.ts` | Rule table, `evaluateChargeRules`, override resolution (pure) |
| `src/lib/billing/room-rent.ts` | Census-day planner for an admission's room history (pure) |
| `src/lib/billing/ledger.ts` | Running ledger, outstanding, credit, admission deposit (pure) |
| `src/lib/billing/validation.ts` | zod request schemas, payment-reference rules (client-safe) |
| `src/lib/billing/route-responses.ts` | Billing route helpers (server-only) |
| `src/lib/queries/billing-settings.ts` | Settings, rule config, payer flags reads/writes |
| `src/lib/queries/service-code-lookup.ts` | SP6 `service_procedure_codes` read by table detection |
| `src/lib/queries/charge-capture.ts` | Context loader, preview, capture, void |
| `src/lib/queries/room-rent.ts` | Room-rent posting |
| `src/lib/queries/document-numbers.ts` | Gapless counter allocation |
| `src/lib/queries/invoices.ts` | Draft, finalise, discard, cancel, reads |
| `src/lib/queries/patient-ledger.ts` | Payments, refunds, ledger load, legacy charges list |
| `src/app/api/billing/**` | Routes (Tasks 6, 8, 9, 11, 12) |
| `src/app/(dashboard)/billing/{capture,invoices,rules}/**`, `src/app/(dashboard)/cash-desk/page.tsx` | Pages |
| `src/app/print/{invoices,receipts}/[id]/page.tsx` | Print views (outside the dashboard layout) |
| `src/components/billing/*` | Client components |
| `scripts/migrations/2026-10-07-sp4-{a-charge-lines,b-invoices-ledger}.sql` | DDL |

---

### Task 1: Pure amounts, GST and document numbering

**Files:**
- Create: `src/lib/billing/amounts.ts`, `src/lib/billing/gst.ts`, `src/lib/billing/numbering.ts`
- Test: `tests/lib/billing/amounts.test.ts`, `tests/lib/billing/gst.test.ts`, `tests/lib/billing/numbering.test.ts`

**Interfaces:**
- Consumes: `MAX_AMOUNT_PAISE` (`src/lib/tariff/validation.ts`), `INDIAN_STATES`, `isIndianStateCode` (`src/lib/india/reference.ts`).
- Produces (`amounts.ts`):
  - `MAX_LINE_QUANTITY = 1000`, `MAX_DOCUMENT_PAISE = 1_000_000_000_000`, `INT4_MAX = 2_147_483_647`
  - `lineTaxablePaise(unitPricePaise: number, quantity: number): number`. Throws `RangeError` when either input is not a non-negative safe integer, quantity is 0, or quantity > `MAX_LINE_QUANTITY`.
  - `sumPaise(values: readonly number[]): number`. BigInt accumulation; throws `RangeError` when the result exceeds `Number.MAX_SAFE_INTEGER`.
  - `paiseFromDb(value: string | number | bigint | null): number`. `null` → 0; a string must match `/^-?\d+$/` (a `numeric` with a fraction throws); the result must be a safe integer, else `RangeError`.
- Produces (`gst.ts`):
  - `GST_STATE_CODES: Record<string, string>`, keyed by the SP1 `IN-xx` code, exactly: AN 35, AP 37, AR 12, AS 18, BR 10, CH 04, CG 22, DH 26, DL 07, GA 30, GJ 24, HR 06, HP 02, JK 01, JH 20, KA 29, KL 32, LA 38, LD 31, MP 23, MH 27, MN 14, ML 17, MZ 15, NL 13, OD 21, PY 34, PB 03, RJ 08, SK 11, TN 33, TS 36, TR 16, UP 09, UK 05, WB 19 (keys `IN-AN` …).
  - `isValidGstin(gstin: string): boolean`. Format `^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$`, a first-two-digit state code that is a value of `GST_STATE_CODES`, and the mod-36 check digit:
    ```ts
    const C = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    let s = 0
    for (let i = 0; i < 14; i++) { const p = C.indexOf(g[i]) * (i % 2 ? 2 : 1); s += Math.floor(p / 36) + (p % 36) }
    return C[(36 - (s % 36)) % 36] === g[14]
    ```
  - `stateCodeOfGstin(gstin: string): string | null`. The `IN-xx` code whose GST code equals the first two digits.
  - `type PlaceOfSupplyMode = 'location_of_service' | 'recipient_state'`; `type SupplyType = 'intra' | 'inter'`
  - `placeOfSupply(input: { mode: PlaceOfSupplyMode; hospitalStateCode: string; recipientStateCode: string | null }): { stateCode: string; supplyType: SupplyType }`. `location_of_service` → always the hospital state, `intra`. `recipient_state` → the recipient state when it is a valid `IN-xx` code, else the hospital state; `inter` when it differs from the hospital's.
  - `interface LineTax { cgstRateBp: number; sgstRateBp: number; igstRateBp: number; cgstPaise: number; sgstPaise: number; igstPaise: number; taxPaise: number; totalPaise: number }`
  - `lineTax(taxablePaise: number, gstRateBp: number, supplyType: SupplyType): LineTax`. Half-up: `roundHalfUp(a × r / 10000) = (a × r × 2 + 10000) / 20000` with BigInt floor division. Intra: `cgstRateBp = sgstRateBp = gstRateBp / 2`, each amount `roundHalfUp(taxable × gstRateBp/2 / 10000)`. Inter: `igstRateBp = gstRateBp`. `gstRateBp` must be one of `GST_RATES_BP`, else `RangeError`.
  - `type DocumentTitle = 'Tax Invoice' | 'Bill of Supply' | 'Bill'`
  - `documentTitle(lineRatesBp: readonly number[], hospitalGstin: string | null): DocumentTitle`. No GSTIN → `'Bill'`; any rate > 0 → `'Tax Invoice'`; else `'Bill of Supply'`.
- Produces (`numbering.ts`):
  - `DOCUMENT_SERIES = ['invoice', 'receipt', 'credit_note', 'refund'] as const`, `type DocumentSeries`
  - `SERIES_PREFIX: Record<DocumentSeries, string> = { invoice: 'INV', receipt: 'RCT', credit_note: 'CRN', refund: 'RFD' }`
  - `MAX_SERIES_VALUE = 999_999`
  - `financialYearOf(isoDate: string): string`. April–March: `'2026-04-01'` → `'2026-27'`, `'2027-03-31'` → `'2026-27'`, `'2099-06-01'` → `'2099-00'`.
  - `formatDocumentNumber(series: DocumentSeries, financialYear: string, value: number): string`. `'INV/26-27/000123'`: prefix, `/`, the year label shortened to `yy-yy`, `/`, the value zero-padded to 6. Throws `RangeError('Document series exhausted')` for `value < 1` or `> MAX_SERIES_VALUE`.

- [ ] **Step 0: Confirm SP3 is merged** (Global Constraints). Stop and report if not.

- [ ] **Step 1: Write the failing tests**

```ts
// amounts.test.ts
it('line of ₹1 crore × 3 is exact', () => { expect(lineTaxablePaise(1_000_000_000, 3)).toBe(3_000_000_000) })
it('refuses zero, fractional, negative and over-limit quantities', () => {
  for (const q of [0, 1.5, -1, 1001]) expect(() => lineTaxablePaise(100, q)).toThrow(RangeError)
})
it('sums across 2^31 exactly and refuses past MAX_SAFE_INTEGER', () => {
  expect(sumPaise([2_147_483_647, 1])).toBe(2_147_483_648)
  expect(() => sumPaise([Number.MAX_SAFE_INTEGER, 1])).toThrow(RangeError)
})
it('paiseFromDb reads node-postgres numeric strings', () => {
  expect(paiseFromDb('3000000000')).toBe(3_000_000_000); expect(paiseFromDb(null)).toBe(0)
  expect(() => paiseFromDb('12.50')).toThrow(RangeError); expect(() => paiseFromDb('99999999999999999')).toThrow(RangeError)
})
// gst.test.ts
it('accepts a valid GSTIN and rejects a wrong check digit or state', () => {
  expect(isValidGstin('27AAPFU0939F1ZV')).toBe(true); expect(isValidGstin('29AAGCB7383J1Z4')).toBe(true)
  expect(isValidGstin('27AAPFU0939F1ZW')).toBe(false); expect(isValidGstin('99AAPFU0939F1ZV')).toBe(false)
  expect(stateCodeOfGstin('29AAGCB7383J1Z4')).toBe('IN-KA')
})
it('maps every SP1 state to a GST code', () => { for (const s of INDIAN_STATES) expect(GST_STATE_CODES[s.code]).toMatch(/^\d{2}$/) })
it('health services are supplied where performed', () => {
  expect(placeOfSupply({ mode: 'location_of_service', hospitalStateCode: 'IN-KA', recipientStateCode: 'IN-TN' })).toEqual({ stateCode: 'IN-KA', supplyType: 'intra' })
})
it('recipient_state mode goes inter-state for another state and falls back to the hospital', () => {
  expect(placeOfSupply({ mode: 'recipient_state', hospitalStateCode: 'IN-KA', recipientStateCode: 'IN-TN' })).toEqual({ stateCode: 'IN-TN', supplyType: 'inter' })
  expect(placeOfSupply({ mode: 'recipient_state', hospitalStateCode: 'IN-KA', recipientStateCode: null })).toEqual({ stateCode: 'IN-KA', supplyType: 'intra' })
})
it('rounds each half per line, half-up', () => {
  // 105 paise at 5%: half-rate 250 bp → 2.625 → 3 each
  expect(lineTax(105, 500, 'intra')).toMatchObject({ cgstRateBp: 250, sgstRateBp: 250, cgstPaise: 3, sgstPaise: 3, igstPaise: 0, taxPaise: 6, totalPaise: 111 })
  expect(lineTax(105, 500, 'inter')).toMatchObject({ igstRateBp: 500, igstPaise: 5, taxPaise: 5, totalPaise: 110 })
  expect(lineTax(3_000_000_000, 1800, 'intra')).toMatchObject({ cgstPaise: 270_000_000, sgstPaise: 270_000_000, totalPaise: 3_540_000_000 })
})
it('per-line rounding differs from per-invoice rounding, and per-line is the rule', () => {
  const lines = [lineTax(105, 500, 'intra'), lineTax(105, 500, 'intra')]
  expect(lines.reduce((s, l) => s + l.taxPaise, 0)).toBe(12)   // per-invoice would give round(210 × 5%) = 11
})
it('titles the document', () => {
  expect(documentTitle([0, 500], '29AAGCB7383J1Z4')).toBe('Tax Invoice'); expect(documentTitle([0], '29AAGCB7383J1Z4')).toBe('Bill of Supply'); expect(documentTitle([0], null)).toBe('Bill')
})
// numbering.test.ts
it('financial year turns at 1 April', () => {
  expect(financialYearOf('2027-03-31')).toBe('2026-27'); expect(financialYearOf('2027-04-01')).toBe('2027-28'); expect(financialYearOf('2099-06-01')).toBe('2099-00')
})
it('financial year turns at IST midnight on 1 April', () => { expect(financialYearOf(istDateOf(new Date('2027-03-31T18:40:00Z')))).toBe('2027-28') })
it('formats every series within the GST 16-character limit', () => {
  expect(formatDocumentNumber('invoice', '2026-27', 123)).toBe('INV/26-27/000123')
  for (const s of DOCUMENT_SERIES) expect(formatDocumentNumber(s, '2026-27', MAX_SERIES_VALUE).length).toBeLessThanOrEqual(16)
  expect(() => formatDocumentNumber('invoice', '2026-27', 1_000_000)).toThrow('Document series exhausted')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/billing/amounts.test.ts tests/lib/billing/gst.test.ts tests/lib/billing/numbering.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement** the three modules with the signatures above. No imports from `@/db/*`, so they stay client-safe.

- [ ] **Step 4: Run the tests to verify they pass**

Run: same command, then `npx tsc --noEmit`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/billing tests/lib/billing
git commit -m "feat(sp4): paise limits, GST place of supply and per-line split, document numbering"
```

---

### Task 2: Pure charge-validation rule engine

**Files:**
- Create: `src/lib/billing/charge-rules.ts`
- Test: `tests/lib/billing/charge-rules.test.ts`

**Interfaces:**
- Consumes: `addDaysIso` (`src/lib/follow-ups/rules.ts`), `formatPaise`, `type ServiceCategory`.
- Produces:
  ```ts
  export const CHARGE_RULE_CODES = ['service_not_found', 'service_inactive', 'price_unresolved', 'date_outside_encounter',
    'department_mismatch', 'consultation_required', 'deposit_below_threshold', 'duplicate_charge', 'preauth_required',
    'quantity_limit', 'procedure_code_not_mapped'] as const
  export type ChargeRuleCode = (typeof CHARGE_RULE_CODES)[number]
  export type RuleSeverity = 'block' | 'warn'
  export type ViolationField = 'serviceId' | 'quantity' | 'serviceDate' | 'unitPrice' | 'preAuthReference' | 'procedureCodes' | 'context'
  export interface ChargeViolation { code: ChargeRuleCode; severity: RuleSeverity; message: string; field: ViolationField; overridable: boolean }
  export interface ChargeRuleDefinition { code: ChargeRuleCode; label: string; defaultSeverity: RuleSeverity; configurable: boolean; overridable: boolean; field: ViolationField }
  export const CHARGE_RULES: readonly ChargeRuleDefinition[]       // one row per code, in CHARGE_RULE_CODES order
  export interface RuleConfigEntry { enabled: boolean; severity: RuleSeverity | null }
  export type RuleConfig = Partial<Record<ChargeRuleCode, RuleConfigEntry>>
  export interface ChargeRuleSettings { consultationWindowDays: number; ipdDepositThresholdPaise: number }
  export interface ProcedureCodeRef { kind: string; code: string }
  export interface ChargeRuleInput {
    service: { id: number; departmentId: number; category: ServiceCategory; isActive: boolean; requiresPreauth: boolean; maxQuantity: number | null } | null
    quantity: number
    serviceDate: string
    today: string
    context: { departmentId: number | null; startDate: string; endDate: string | null; isInpatient: boolean; isEmergencyAdmission: boolean }
    payer: { id: number; requiresPreauth: boolean } | null      // null = self-pay
    preAuthReference: string | null
    priceResolved: boolean                                       // resolver ok, or a manual price was given
    consultationDates: string[]                                  // the patient's non-cancelled opd/ipd encounter dates
    admissionDepositPaise: number | null                         // null outside an admission
    sameDayDuplicates: number                                    // non-void lines: same patient, service, context, date
    mappedProcedureCodes: ProcedureCodeRef[]
    requestedProcedureCodes: ProcedureCodeRef[]
  }
  export function evaluateChargeRules(input: ChargeRuleInput, settings: ChargeRuleSettings, config: RuleConfig): ChargeViolation[]
  export interface RuleOverride { code: ChargeRuleCode; reason: string }
  export const OVERRIDE_REASON_MIN = 5
  export function appliedOverrides(violations: ChargeViolation[], overrides: RuleOverride[], canOverride: boolean): RuleOverride[]
  export function unresolvedBlocks(violations: ChargeViolation[], overrides: RuleOverride[], canOverride: boolean): ChargeViolation[]
  ```
- The rule table (exact):

  | code | default | configurable | overridable | field | violated when | message |
  |---|---|---|---|---|---|---|
  | `service_not_found` | block | no | no | serviceId | `service === null` (then **no other rule runs**) | `This service is not in the service master` |
  | `service_inactive` | block | no | no | serviceId | `!service.isActive` (then no other rule runs) | `This service is inactive` |
  | `price_unresolved` | block | no | no | unitPrice | `!priceResolved` | `No tariff rate covers this service on this date; add a rate or enter a manual price` |
  | `date_outside_encounter` | block | no | no | serviceDate | `serviceDate > today` → `The service date cannot be in the future`; `< startDate` or `> (endDate ?? today)` → `The service date must fall within the visit or stay (<formatIsoDate(start)> to <formatIsoDate(end ?? today)>)` |
  | `department_mismatch` | warn | yes | no | context | category ∈ {consultation, procedure} and `context.departmentId !== null` and ≠ `service.departmentId` | `This service belongs to a different department from the visit` |
  | `consultation_required` | block | yes | yes | context | category `procedure` and no date d in `consultationDates` with `addDaysIso(serviceDate, -N) <= d <= serviceDate` | `A procedure needs a doctor consultation in the <N> days before it` |
  | `deposit_below_threshold` | block | yes | yes | context | `context.isInpatient`, category ∈ {procedure, package}, threshold > 0, `admissionDepositPaise < threshold` | `The admission deposit (<formatPaise(dep)>) is below the <formatPaise(thr)> required before procedures` |
  | `duplicate_charge` | block | yes | yes | serviceId | `sameDayDuplicates > 0` | `This service is already charged for this visit on this date` |
  | `preauth_required` | block | yes | no | preAuthReference | `payer?.requiresPreauth && service.requiresPreauth && !preAuthReference?.trim()` | `This payer needs a pre-authorisation reference for this service` |
  | `quantity_limit` | block | yes | yes | quantity | `maxQuantity !== null && quantity > maxQuantity` | `Quantity cannot exceed <max> for this service` |
  | `procedure_code_not_mapped` | block | yes | no | procedureCodes | per requested code not in a non-empty `mappedProcedureCodes` (compare `kind` + upper-cased `code`); unmapped service → none | `<code> is not a procedure code mapped to this service` |

  - Config applies only to configurable rules: `enabled: false` skips the rule; `severity` replaces the default. A config entry for a non-configurable rule is ignored.
  - After config: `deposit_below_threshold` on an emergency admission (`isEmergencyAdmission`) is forced to `warn` and its message gains ` (emergency admission: warning only)`. Emergency care is never held for a deposit.
  - `appliedOverrides`: entries whose code matches a `block` violation that is `overridable`, with `reason.trim().length >= OVERRIDE_REASON_MIN`, only when `canOverride`; trimmed reasons, deduplicated by code. `unresolvedBlocks`: the `block` violations not covered by `appliedOverrides`.

- [ ] **Step 1: Write the failing tests**

```ts
const base: ChargeRuleInput = { service: { id: 1, departmentId: 10, category: 'procedure', isActive: true, requiresPreauth: false, maxQuantity: null },
  quantity: 1, serviceDate: '2026-10-20', today: '2026-10-20',
  context: { departmentId: 10, startDate: '2026-10-20', endDate: null, isInpatient: false, isEmergencyAdmission: false },
  payer: null, preAuthReference: null, priceResolved: true, consultationDates: ['2026-10-20'], admissionDepositPaise: null,
  sameDayDuplicates: 0, mappedProcedureCodes: [], requestedProcedureCodes: [] }
const S = { consultationWindowDays: 30, ipdDepositThresholdPaise: 0 }
const codes = (v: ChargeViolation[]) => v.map((x) => x.code)

it('a clean procedure has no violations', () => { expect(evaluateChargeRules(base, S, {})).toEqual([]) })
it('a missing service short-circuits every other rule', () => { expect(codes(evaluateChargeRules({ ...base, service: null, priceResolved: false }, S, {}))).toEqual(['service_not_found']) })
it('blocks a procedure with no consultation in the window, and accepts one exactly N days back', () => {
  expect(codes(evaluateChargeRules({ ...base, consultationDates: ['2026-09-19'] }, S, {}))).toEqual(['consultation_required'])
  expect(evaluateChargeRules({ ...base, consultationDates: ['2026-09-20'] }, S, {})).toEqual([])
})
it('dates: future and outside the stay', () => {
  expect(evaluateChargeRules({ ...base, serviceDate: '2026-10-21' }, S, {})[0].message).toBe('The service date cannot be in the future')
  expect(codes(evaluateChargeRules({ ...base, serviceDate: '2026-10-19', consultationDates: ['2026-10-19'] }, S, {}))).toEqual(['date_outside_encounter'])
})
it('deposit: blocks an elective IPD procedure below threshold, only warns for an emergency', () => {
  const ipd = { ...base, context: { ...base.context, isInpatient: true }, admissionDepositPaise: 1_000_00 }
  const s = { ...S, ipdDepositThresholdPaise: 5_000_00 }
  expect(evaluateChargeRules(ipd, s, {})).toEqual([expect.objectContaining({ code: 'deposit_below_threshold', severity: 'block', overridable: true })])
  const em = evaluateChargeRules({ ...ipd, context: { ...ipd.context, isEmergencyAdmission: true } }, s, {})
  expect(em[0]).toMatchObject({ severity: 'warn' }); expect(em[0].message).toMatch(/emergency admission: warning only\)$/)
})
it('pre-auth needs both flags and a blank reference', () => {
  const v = { ...base, payer: { id: 7, requiresPreauth: true }, service: { ...base.service!, requiresPreauth: true } }
  expect(codes(evaluateChargeRules(v, S, {}))).toEqual(['preauth_required'])
  expect(evaluateChargeRules({ ...v, preAuthReference: '  ' }, S, {})).toHaveLength(1)
  expect(evaluateChargeRules({ ...v, preAuthReference: 'PA-123' }, S, {})).toEqual([])
})
it('procedure codes: unmapped services are unconstrained; mapped ones must match (case-insensitive code)', () => {
  expect(evaluateChargeRules({ ...base, requestedProcedureCodes: [{ kind: 'hbp', code: 'X1' }] }, S, {})).toEqual([])
  const m = { ...base, mappedProcedureCodes: [{ kind: 'hbp', code: 'SMP001A' }] }
  expect(evaluateChargeRules({ ...m, requestedProcedureCodes: [{ kind: 'hbp', code: 'smp001a' }] }, S, {})).toEqual([])
  expect(evaluateChargeRules({ ...m, requestedProcedureCodes: [{ kind: 'hbp', code: 'SMP002A' }] }, S, {})[0].message).toBe('SMP002A is not a procedure code mapped to this service')
})
it('config disables or re-grades configurable rules only', () => {
  const dup = { ...base, sameDayDuplicates: 1 }
  expect(evaluateChargeRules(dup, S, { duplicate_charge: { enabled: false, severity: null } })).toEqual([])
  expect(evaluateChargeRules(dup, S, { duplicate_charge: { enabled: true, severity: 'warn' } })[0].severity).toBe('warn')
  expect(codes(evaluateChargeRules({ ...base, priceResolved: false }, S, { price_unresolved: { enabled: false, severity: null } }))).toEqual(['price_unresolved'])
})
it('overrides: only authority roles, only overridable blocks, only with a real reason', () => {
  const v = evaluateChargeRules({ ...base, sameDayDuplicates: 1, priceResolved: false }, S, {})
  const ov = [{ code: 'duplicate_charge' as const, reason: 'second dressing, other leg' }, { code: 'price_unresolved' as const, reason: 'please allow' }]
  expect(codes(unresolvedBlocks(v, ov, true))).toEqual(['price_unresolved'])
  expect(codes(unresolvedBlocks(v, ov, false))).toEqual(['price_unresolved', 'duplicate_charge'])   // table order
  expect(unresolvedBlocks(v, [{ code: 'duplicate_charge', reason: ' ok ' }], true)).toHaveLength(2)
})
it('CHARGE_RULES has one row per code in order', () => { expect(CHARGE_RULES.map((r) => r.code)).toEqual([...CHARGE_RULE_CODES]) })
```

- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/lib/billing/charge-rules.test.ts` → FAIL.
- [ ] **Step 3: Implement** `charge-rules.ts`: one predicate per `CHARGE_RULES` row (each returns a message or `null`), run in table order, then config, then the emergency downgrade.
- [ ] **Step 4: Verify:** same command + `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/billing/charge-rules.ts tests/lib/billing/charge-rules.test.ts
git commit -m "feat(sp4): table-driven charge validation rules with config and overrides"
```

---

### Task 3: Pure room-rent census, ledger and request schemas

**Files:**
- Create: `src/lib/billing/room-rent.ts`, `src/lib/billing/ledger.ts`, `src/lib/billing/validation.ts`
- Test: `tests/lib/billing/room-rent.test.ts`, `tests/lib/billing/ledger.test.ts`, `tests/lib/billing/validation.test.ts`

**Interfaces:**
- Consumes: `istDateOf`, `startOfIstDay` (`src/lib/india-time.ts`), `addDaysIso`, Task 1 (`sumPaise`, `MAX_LINE_QUANTITY`, `MAX_DOCUMENT_PAISE`), Task 2 (`CHARGE_RULE_CODES`, `OVERRIDE_REASON_MIN`), `isoDate`, `MAX_AMOUNT_PAISE`, `GST_RATES_BP`, `isIndianStateCode`.
- Produces (`room-rent.ts`):
  - `interface StayRoom { roomId: number; ward: string; roomCategoryCode: string | null }`
  - `interface CensusDay { date: string; room: StayRoom | null }`
  - `planRoomRentDays(input: { admittedAt: Date; dischargedAt: Date | null; now: Date; initialRoom: StayRoom | null; transfers: { at: Date; toRoom: StayRoom }[] }): CensusDay[]`
  - **Census rule (ruling 7):** IST date `d` is billable when the patient was admitted before the end of `d` (`startOfIstDay(d + 1)`) and was not discharged before that instant. While admitted, only days whose end is `<= now` are returned, so today is billed after midnight. An admit and discharge on the same IST date gives exactly one day (the admission date). The room for `d` is the room occupied at the end of `d`: the last transfer with `at < startOfIstDay(d + 1)`, else `initialRoom`.
- Produces (`ledger.ts`):
  - `type LedgerEntryKind = 'invoice' | 'credit_note' | 'advance' | 'receipt' | 'refund'`
  - `interface LedgerEntry { kind: LedgerEntryKind; id: number; number: string; at: Date; amountPaise: number; admissionId: number | null }`
  - `interface LedgerSummary { invoicedPaise: number; creditedPaise: number; receivedPaise: number; refundedPaise: number; balancePaise: number; outstandingPaise: number; creditBalancePaise: number }`
  - `computeLedger(entries: LedgerEntry[]): { rows: (LedgerEntry & { balancePaise: number })[]; summary: LedgerSummary }`. Rows sorted by `at`, then kind order `invoice, credit_note, advance, receipt, refund`, then `id`. The sign is `+` for invoice and refund and `−` for credit note, advance and receipt. `balancePaise` is the running sum (positive = the patient owes), with `outstandingPaise = max(0, balance)` and `creditBalancePaise = max(0, −balance)`. All sums go through `sumPaise`.
  - `admissionDepositPaise(entries: LedgerEntry[], admissionId: number): number`. Advances minus refunds carrying that admission id, floored at 0.
- Produces (`validation.ts`, zod, all `.strict()`):
  - `procedureCodeRef = z.object({ kind: z.string().regex(/^[a-z0-9]{2,12}$/), code: z.string().trim().min(1).max(20) })`
  - `chargeContextRef = z.union([z.object({ encounterId: positiveInt }).strict(), z.object({ admissionId: positiveInt }).strict()])`
  - `chargeCaptureSchema`: `{ context: chargeContextRef, serviceId: positiveInt, quantity: int 1..MAX_LINE_QUANTITY, serviceDate: isoDate, billTo: z.enum(['patient', 'payer']), preAuthReference?: trimmed 1..40, procedureCodes?: procedureCodeRef[] max 5, performingProviderId?: positiveInt, manualUnitPricePaise?: int 0..MAX_AMOUNT_PAISE, priceOverrideReason?: trimmed max 300, overrides?: { code: z.enum(CHARGE_RULE_CODES), reason: trimmed max 300 }[] max 11 }`. Refinement (code `custom`, path `priceOverrideReason`): `manualUnitPricePaise` set ⇒ reason length ≥ `OVERRIDE_REASON_MIN`, message `Give a reason for the manual price (at least 5 characters)`.
  - `chargePreviewSchema` = `chargeCaptureSchema` (same shape).
  - `voidLineSchema = { reason: trimmed 5..300 }`; `roomRentPostSchema = { throughDate?: isoDate }`
  - `draftInvoiceSchema = { lineIds: positiveInt[] 1..500, unique }`; `cancelInvoiceSchema = { reason: trimmed 5..300 }`
  - `PAYMENT_MODES = ['cash', 'upi', 'card', 'cheque', 'neft', 'other'] as const`
  - `paymentReferenceProblem(mode: PaymentMode, reference: string | null): string | null`. Rules, in this order:
    1. Non-cash with a blank reference → `Enter the transaction reference for this payment mode`.
    2. Any run of 13–19 digits (spaces and dashes ignored) that passes Luhn → `Do not enter card numbers; record the approval code or the last 4 digits`.
    3. Otherwise `null`. Cash may carry an optional reference.
  - `paymentSchema = { patientId: string 1..40, kind: z.enum(['advance', 'receipt']), admissionId?: positiveInt, invoiceId?: positiveInt, mode: z.enum(PAYMENT_MODES), reference?: trimmed max 40, amountPaise: int 1..MAX_DOCUMENT_PAISE }`, refined with `paymentReferenceProblem` (path `reference`).
  - `refundSchema = { patientId, admissionId?, againstPaymentId?: positiveInt, mode, reference?, amountPaise, reason: trimmed 5..300 }`, same refinement.
  - `billingSettingsSchema = { legalName: trimmed 2..200, gstin: string | null (when set, uppercase and isValidGstin, message 'Enter a valid 15-character GSTIN'), stateCode (isIndianStateCode), address: trimmed max 500 | null, placeOfSupplyMode: z.enum(['location_of_service', 'recipient_state']), consultationWindowDays: int 1..365, ipdDepositThresholdPaise: int 0..MAX_AMOUNT_PAISE, roomRentServiceId: positiveInt | null, pharmacyGstRateBp: one of GST_RATES_BP, pharmacyHsn: /^\d{4,8}$/ }`. Refinement: a GSTIN whose `stateCodeOfGstin` ≠ `stateCode` → `The GSTIN does not belong to the selected state`.
  - `ruleConfigSchema = { enabled: boolean, severity: z.enum(['block', 'warn']).nullable() }`
  - `payerBillingFlagsSchema = { requiresPreauth: boolean, gstin: string | null (valid when set), stateCode: string | null (valid when set) }`
  - Exported inferred types: `ChargeCaptureInput`, `PaymentInput`, `RefundInput`, `BillingSettingsInput`, `PaymentMode`.

- [ ] **Step 1: Write the failing tests**

```ts
// room-rent.test.ts
const A = { roomId: 1, ward: 'General', roomCategoryCode: 'GEN' }; const B = { roomId: 2, ward: 'ICU', roomCategoryCode: 'ICU' }
it('bills census nights and not the discharge day', () => {
  const d = planRoomRentDays({ admittedAt: new Date('2026-10-20T05:00:00Z'), dischargedAt: new Date('2026-10-23T06:00:00Z'), now: new Date('2026-10-30T00:00:00Z'), initialRoom: A, transfers: [] })
  expect(d.map((x) => x.date)).toEqual(['2026-10-20', '2026-10-21', '2026-10-22'])
})
it('same-day admit and discharge bills one day', () => {
  expect(planRoomRentDays({ admittedAt: new Date('2026-10-20T03:00:00Z'), dischargedAt: new Date('2026-10-20T10:00:00Z'), now: new Date('2026-10-21T00:00:00Z'), initialRoom: A, transfers: [] })).toEqual([{ date: '2026-10-20', room: A }])
})
it('census day ends at IST midnight', () => {
  // admitted 23:50 IST on 20 Oct (18:20Z); still admitted at 21 Oct 00:05 IST (18:35Z)
  expect(planRoomRentDays({ admittedAt: new Date('2026-10-20T18:20:00Z'), dischargedAt: null, now: new Date('2026-10-20T18:35:00Z'), initialRoom: A, transfers: [] }).map((x) => x.date)).toEqual(['2026-10-20'])
})
it('a day takes the room held at its end', () => {
  const d = planRoomRentDays({ admittedAt: new Date('2026-10-20T05:00:00Z'), dischargedAt: null, now: new Date('2026-10-22T19:00:00Z'), initialRoom: A, transfers: [{ at: new Date('2026-10-21T12:00:00Z'), toRoom: B }] })
  expect(d).toEqual([{ date: '2026-10-20', room: A }, { date: '2026-10-21', room: B }, { date: '2026-10-22', room: B }])
})
// ledger.test.ts
it('runs the balance and splits outstanding from credit', () => {
  const r = computeLedger([
    { kind: 'advance', id: 1, number: 'RCT/26-27/000001', at: new Date('2026-10-20T05:00:00Z'), amountPaise: 50_000_00, admissionId: 9 },
    { kind: 'invoice', id: 1, number: 'INV/26-27/000001', at: new Date('2026-10-22T05:00:00Z'), amountPaise: 80_000_00, admissionId: 9 },
  ])
  expect(r.rows.map((x) => x.balancePaise)).toEqual([-50_000_00, 30_000_00])
  expect(r.summary).toMatchObject({ outstandingPaise: 30_000_00, creditBalancePaise: 0 })
})
it('a credit note reverses its invoice', () => { /* invoice 100, credit_note 100, receipt 40 → creditBalancePaise 40 */ })
it('ledger sum above 2^31 is exact', () => { /* two invoices of 2_000_000_000 → invoicedPaise 4_000_000_000 */ })
it('admission deposit counts only that admission, net of refunds', () => { /* advance 9:5000, advance 8:7000, refund 9:2000 → admissionDepositPaise(e, 9) === 3000 */ })
// validation.test.ts
it('rejects a Luhn-valid card number, accepts a 12-digit UTR', () => {
  expect(paymentReferenceProblem('card', '4111 1111 1111 1111')).toBe('Do not enter card numbers; record the approval code or the last 4 digits')
  expect(paymentReferenceProblem('upi', '412345678901')).toBeNull()
  expect(paymentReferenceProblem('neft', '')).toBe('Enter the transaction reference for this payment mode')
  expect(paymentReferenceProblem('cash', null)).toBeNull()
})
it('a manual price needs a reason', () => {
  const r = chargeCaptureSchema.safeParse({ context: { encounterId: 1 }, serviceId: 1, quantity: 1, serviceDate: '2026-10-20', billTo: 'patient', manualUnitPricePaise: 100 })
  expect(r.success).toBe(false); expect(r.error!.issues[0].message).toBe('Give a reason for the manual price (at least 5 characters)')
})
it('context is exactly one of encounter or admission', () => { /* { encounterId: 1, admissionId: 2 } fails */ })
it('settings refuse a GSTIN from another state', () => { /* gstin 29AAGCB7383J1Z4 with stateCode IN-TN → 'The GSTIN does not belong to the selected state' */ })
```

- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/lib/billing/room-rent.test.ts tests/lib/billing/ledger.test.ts tests/lib/billing/validation.test.ts` → FAIL.
- [ ] **Step 3: Implement** the three modules.
- [ ] **Step 4: Verify:** same command + `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/billing tests/lib/billing
git commit -m "feat(sp4): room-rent census planner, patient ledger and billing request schemas"
```

---

### Task 4: Roles, charge-lines schema and migration A

**Files:**
- Modify: `src/db/schema.ts`:
  - add `bigint` and `primaryKey` to the `drizzle-orm/pg-core` import
  - `// SP4` columns on `payers` and `serviceCatalog`
  - a `// SP4` block after the SP3 block with the new enums and tables
- Modify: `src/lib/role-policy.ts` (`// SP4` block), `src/lib/role-capabilities.ts` (bullets: billing + crc "Capture charges and build invoices", billing "Override prices, finalise and cancel invoices, issue refunds", frontdesk "Take advances and receipts at the cash desk", admin "Configure billing rules and GST settings")
- Modify: `src/db/seed.ts` `clearExistingData`: delete `chargeLines` before `charges`; `chargeRuleConfigs` is cleared, `billingSettings` is not.
- Create: `scripts/migrations/2026-10-07-sp4-a-charge-lines.sql`
- Test: `tests/db/sp4-charge-lines-schema.test.ts`, `tests/lib/role-policy.test.ts` (append)

**Interfaces:**
- Produces (role policy): `CHARGE_CAPTURE_ROLES`, `BILLING_AUTHORITY_ROLES`, `CASH_DESK_ROLES`, `BILLING_CONFIG_ROLES`, exactly the Global Constraints table, `readonly Role[]`.
- Produces (schema):
  - `payers` + `requiresPreauth: boolean('requires_preauth').default(false).notNull()`, `gstin: text('gstin')`, `stateCode: text('state_code')`
  - `serviceCatalog` + `requiresPreauth: boolean('requires_preauth').default(false).notNull()`, `maxQuantity: integer('max_quantity')`, check `service_catalog_max_quantity_range` (`max_quantity IS NULL OR max_quantity BETWEEN 1 AND 1000`)
  - `chargeLineSourceEnum = pgEnum('charge_line_source', ['manual', 'room_rent', 'pharmacy'])`
  - `chargeLineStatusEnum = pgEnum('charge_line_status', ['captured', 'invoiced', 'void'])`
  - `PRICE_SOURCES = ['base', 'department', 'payer', 'manual', 'pharmacy'] as const`
  - `billingSettings` (`billing_settings`):
    - `id integer PK default 1`, check `billing_settings_singleton` (`id = 1`)
    - `legalName text`, `gstin text`, `stateCode text`, `address text`
    - `placeOfSupplyMode text {enum ['location_of_service','recipient_state']} default 'location_of_service' not null`
    - `consultationWindowDays integer default 30 not null` (check 1..365)
    - `ipdDepositThresholdPaise integer default 0 not null` (check 0..1_000_000_000)
    - `roomRentServiceId integer → serviceCatalog`
    - `pharmacyGstRateBp integer default 500 not null` (check `IN (0,500,1200,1800,2800,4000)`)
    - `pharmacyHsn text default '3004' not null`
    - `updatedAt timestamp defaultNow not null`, `updatedByName text`
  - `chargeRuleConfigs` (`charge_rule_configs`): `ruleCode text PK`, `enabled boolean default true not null`, `severity text {enum ['block','warn']}` (nullable), `updatedAt`, `updatedByName text not null`
  - `chargeLines` (`charge_lines`):
    - `id serial PK`, `patientId text not null → patients`, `encounterId integer → encounters`, `admissionId integer → admissions`
    - `source chargeLineSourceEnum not null`, `status chargeLineStatusEnum default 'captured' not null`
    - `serviceId integer → serviceCatalog`, `itemCode text not null`, `itemName text not null`, `serviceCategory serviceCategoryEnum` (snapshot; null for pharmacy)
    - `departmentId → departments`, `orderingProviderId → providers`, `performingProviderId → providers`
    - `serviceDate date not null`, `quantity integer not null`
    - `unitPricePaise integer not null`, `priceSource text {enum PRICE_SOURCES} not null`, `tariffRateId integer → tariffRates`, `resolvedPricePaise integer`, `priceOverrideReason text`
    - `taxablePaise bigint({mode:'number'}) not null`, `gstRateBp integer not null`, `hsnSac text not null`
    - `payerId → payers` (null = self-pay), `preAuthReference text`
    - `procedureCodes jsonb $type<ProcedureCodeRef[]> default [] not null`, `violations jsonb $type<ChargeViolation[]> default [] not null`, `ruleOverrides jsonb $type<RuleOverride[]> default [] not null`
    - `legacyChargeId integer → charges, unique`, `medicationDispenseId integer → medicationDispenses, unique`
    - `voidReason text`, `voidedAt timestamp`, `voidedByName text`
    - `createdByName text not null`, `createdByUserId integer → users`, `createdAt timestamp defaultNow not null`
    - Config:
      - `index('charge_lines_patient_idx').on(patientId)`, `index('charge_lines_encounter_idx').on(encounterId)`, `index('charge_lines_admission_idx').on(admissionId)`
      - `uniqueIndex('charge_lines_room_rent_day_unique').on(admissionId, serviceDate).where(sql\`source = 'room_rent' AND status <> 'void'\`)`
      - checks:
        - `charge_lines_quantity_range` (1..1000)
        - `charge_lines_unit_price_range` (0..1_000_000_000)
        - `charge_lines_taxable_nonneg`
        - `charge_lines_gst_rate_allowed` (same slab list)
        - `charge_lines_service_required` (`source = 'pharmacy' OR service_id IS NOT NULL`)
        - `charge_lines_context_required` (`source = 'pharmacy' OR encounter_id IS NOT NULL OR admission_id IS NOT NULL`)
        - `charge_lines_manual_reason` (`price_source <> 'manual' OR price_override_reason IS NOT NULL`)
        - `charge_lines_void_reason` (`status <> 'void' OR void_reason IS NOT NULL`)
  - Types: `BillingSettingsRow`, `ChargeRuleConfigRow`, `ChargeLineRow`. `ProcedureCodeRef` / `ChargeViolation` / `RuleOverride` are `import type` from `src/lib/billing/charge-rules.ts`.
- Migration A: two enum `DO` blocks; `ALTER TABLE payers/service_catalog ADD COLUMN IF NOT EXISTS …`; the three tables; every constraint guarded; and `INSERT INTO billing_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;`.

- [ ] **Step 1: Write the failing tests**

```ts
it('migration A is idempotent and declares every column', () => {
  const s = readMigration('2026-10-07-sp4-a-charge-lines.sql'); expect(idempotencyProblems(s)).toEqual([])
  for (const t of [billingSettings, chargeRuleConfigs, chargeLines]) expect(missingColumns(t, s)).toEqual([])
  for (const c of ['requires_preauth', 'max_quantity', 'gstin', 'state_code']) expect(s).toContain(c)
})
it('pins every named constraint', () => {
  const s = readMigration('2026-10-07-sp4-a-charge-lines.sql')
  for (const n of ['billing_settings_singleton', 'charge_lines_room_rent_day_unique', 'charge_lines_service_required', 'charge_lines_context_required',
    'charge_lines_manual_reason', 'charge_lines_void_reason', 'charge_lines_unit_price_range', 'service_catalog_max_quantity_range']) expect(s).toContain(n)
})
it('role constants match the plan', () => {
  expect(CHARGE_CAPTURE_ROLES).toEqual(CHARGES_ROLES); expect([...BILLING_AUTHORITY_ROLES].sort()).toEqual(['admin', 'billing'])
  expect([...CASH_DESK_ROLES].sort()).toEqual(['admin', 'billing', 'crc', 'frontdesk']); expect(BILLING_CONFIG_ROLES).toEqual(MASTER_DATA_ADMIN_ROLES)
})
describe.skipIf(!process.env.DATABASE_URL)('charge lines (DB)', () => {
  it('has the singleton settings row', async () => { /* select from billing_settings → exactly one row, id 1 */ })
  it('refuses a manual price without a reason (23514 charge_lines_manual_reason)', async () => {})
  it('refuses a second live room-rent line for the same admission day, allows it after the first is voided', async () => {})
  it('stores a taxable amount above 2^31', async () => { /* taxable 3_000_000_000 reads back as number 3000000000 */ })
})
```

- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/lib/role-policy.test.ts` and `npm test -- tests/db/sp4-charge-lines-schema.test.ts` → FAIL.
- [ ] **Step 3: Implement** the schema, the roles, the bullets, the seed cleanup and the migration. Then apply migration A to the local container **twice** (Global Constraints); both runs must end in `COMMIT`.
- [ ] **Step 4: Verify:** same commands + `npx vitest run tests/lib/role-capabilities.test.ts` + `npx tsc --noEmit` → PASS (DB block runs).
- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/db/seed.ts src/lib/role-policy.ts src/lib/role-capabilities.ts scripts/migrations/2026-10-07-sp4-a-charge-lines.sql tests/db/sp4-charge-lines-schema.test.ts tests/lib/role-policy.test.ts
git commit -m "feat(sp4): billing roles, settings, rule config and charge-lines schema"
```

---

### Task 5: Invoices, documents and ledger schema, immutability triggers (migration B)

**Files:**
- Modify: `src/db/schema.ts` (`// SP4` block): new enums and tables; `chargeLines.invoiceId`
- Modify: `src/db/seed.ts` `clearExistingData`: before `chargeLines`, set `hims.allow_document_purge`, then delete `refunds`, `patientPayments`, `creditNotes`, `invoiceLines`, then after `chargeLines` delete `invoices`, `documentCounters`. Run these in one `getDb().transaction` that first runs `select set_config('hims.allow_document_purge', 'on', true)`.
- Create: `scripts/migrations/2026-10-07-sp4-b-invoices-ledger.sql`, `tests/db/billing-fixtures.ts`
- Test: `tests/db/sp4-invoices-schema.test.ts`

**Interfaces:**
- Produces (schema):
  - `documentSeriesEnum = pgEnum('document_series', ['invoice', 'receipt', 'credit_note', 'refund'])`
  - `invoiceStatusEnum = pgEnum('invoice_status', ['draft', 'finalised', 'cancelled', 'discarded'])`
  - `paymentModeEnum = pgEnum('payment_mode', ['cash', 'upi', 'card', 'cheque', 'neft', 'other'])`
  - `patientPaymentKindEnum = pgEnum('patient_payment_kind', ['advance', 'receipt'])`
  - `documentCounters` (`document_counters`): `series documentSeriesEnum not null`, `financialYear text not null`, `lastValue integer default 0 not null`, `primaryKey({ name: 'document_counters_pk', columns: [series, financialYear] })`, checks `document_counters_fy_format` (`financial_year ~ '^[0-9]{4}-[0-9]{2}$'`) and `document_counters_value_range` (0..999999)
  - `invoices` (`invoices`):
    - `id serial`, `invoiceNumber text unique`, `status invoiceStatusEnum default 'draft' not null`
    - `patientId text not null → patients`, `encounterId → encounters`, `admissionId → admissions`, `payerId → payers`
    - `financialYear text`, `invoiceDate date`, `documentTitle text`, `supplyType text {enum ['intra','inter']}`, `placeOfSupplyStateCode text`
    - `snapshot jsonb $type<InvoiceSnapshot>`
    - `taxablePaise`, `cgstPaise`, `sgstPaise`, `igstPaise`, `totalPaise`: all `bigint` nullable
    - `createdByName text not null`, `createdAt`, `finalisedAt`, `finalisedByName`, `cancelledAt`, `cancelledByName`, `discardedAt`, `discardedByName`
    - checks:
      - `invoices_number_when_issued` (`(status IN ('finalised','cancelled')) = (invoice_number IS NOT NULL)`)
      - `invoices_totals_when_issued` (`status NOT IN ('finalised','cancelled') OR (total_paise IS NOT NULL AND snapshot IS NOT NULL AND invoice_date IS NOT NULL)`)
    - `index('invoices_patient_idx')`
  - `invoiceLines` (`invoice_lines`):
    - `id serial`, `invoiceId not null → invoices`, `chargeLineId not null → chargeLines`, `lineNo integer not null`
    - snapshots: `itemCode`, `itemName`, `hsnSac`, `serviceDate date`, `quantity integer`, `unitPricePaise integer`, `priceSource text`
    - `taxablePaise bigint`, `gstRateBp`, `cgstRateBp`, `sgstRateBp`, `igstRateBp` (integer), `cgstPaise`, `sgstPaise`, `igstPaise`, `totalPaise` (bigint): all not null
    - `uniqueIndex('invoice_lines_invoice_line_no_unique').on(invoiceId, lineNo)`
  - `creditNotes` (`credit_notes`): `id`, `creditNoteNumber text not null unique`, `invoiceId integer not null unique → invoices`, `financialYear text not null`, `issueDate date not null`, `reason text not null`, `taxablePaise`, `cgstPaise`, `sgstPaise`, `igstPaise`, `totalPaise` (bigint not null), `issuedByName text not null`, `issuedAt`
  - `patientPayments` (`patient_payments`):
    - `id`, `receiptNumber text not null unique`, `kind patientPaymentKindEnum not null`
    - `patientId not null`, `admissionId`, `encounterId`, `invoiceId → invoices`
    - `mode paymentModeEnum not null`, `reference text`, `amountPaise bigint not null`
    - `financialYear text not null`, `receiptDate date not null`, `receivedByName text not null`, `receivedByUserId → users`, `receivedAt`
    - checks `patient_payments_amount_positive`, `patient_payments_reference_required` (`mode = 'cash' OR reference IS NOT NULL`)
    - `index('patient_payments_patient_idx')`
  - `refunds` (`refunds`):
    - `id`, `refundNumber text not null unique`, `patientId not null`, `admissionId`, `againstPaymentId → patientPayments`
    - `mode`, `reference`, `amountPaise bigint not null`, `reason text not null`
    - `financialYear`, `refundDate`, `issuedByName`, `issuedAt`
    - checks `refunds_amount_positive`, `refunds_reference_required`
    - `index('refunds_patient_idx')`
  - `chargeLines` + `invoiceId: integer('invoice_id').references(() => invoices.id)` + `index('charge_lines_invoice_idx')`; migration B adds the column with `ADD COLUMN IF NOT EXISTS` and a guarded FK.
  - `interface InvoiceSnapshot`, exported from `src/lib/billing/gst.ts` as a type and imported here with `import type`:
    ```ts
    {
      hospital: { legalName: string; gstin: string | null; stateCode: string; gstStateCode: string; address: string | null }
      patient: { id: string; name: string; uhid: string | null; addressLine1: string | null; addressLine2: string | null; city: string | null; district: string | null; stateCode: string | null; pinCode: string | null }
      payer: { id: number; name: string; gstin: string | null; stateCode: string | null } | null
      context: { encounterId: number | null; admissionId: number | null; label: string }
    }
    ```
  - Types: `InvoiceRow`, `InvoiceLineRow`, `CreditNoteRow`, `PatientPaymentRow`, `RefundRow`.
- Migration B also defines the migration-only immutability (header comment says so, like SP2's exclusion constraint):
  - `CREATE OR REPLACE FUNCTION sp4_reject_issued_change() RETURNS trigger`: when `current_setting('hims.allow_document_purge', true) = 'on'`, return `COALESCE(NEW, OLD)`; else `RAISE EXCEPTION 'issued billing documents cannot be changed' USING ERRCODE = '55000'`.
  - Triggers `invoice_lines_immutable`, `credit_notes_immutable`, `patient_payments_immutable`, `refunds_immutable`: `BEFORE UPDATE OR DELETE … FOR EACH ROW EXECUTE FUNCTION sp4_reject_issued_change()`.
  - `CREATE OR REPLACE FUNCTION sp4_invoice_guard() RETURNS trigger`, used by trigger `invoices_issued_guard` (`BEFORE UPDATE OR DELETE ON invoices`). With the purge setting on, it passes everything. Otherwise:
    - a `DELETE` of a finalised or cancelled row raises;
    - an `UPDATE` of a cancelled row raises;
    - an `UPDATE` of a finalised row raises unless `NEW.status = 'cancelled'` and every column other than `status`, `cancelled_at` and `cancelled_by_name` is `IS NOT DISTINCT FROM` its `OLD` value.
  - Each `CREATE TRIGGER` sits in a `DO` block testing `pg_trigger`.
- Produces (`tests/db/billing-fixtures.ts`): `purgeBillingFixtures(patientIds: string[]): Promise<void>`, which deletes in the Global Constraints order inside one transaction after `set_config('hims.allow_document_purge', 'on', true)`. It also deletes `document_counters` where `financial_year = '2099-00'`.

- [ ] **Step 1: Write the failing tests**

```ts
it('migration B is idempotent and declares every column', () => {
  const s = readMigration('2026-10-07-sp4-b-invoices-ledger.sql'); expect(idempotencyProblems(s)).toEqual([])
  for (const t of [documentCounters, invoices, invoiceLines, creditNotes, patientPayments, refunds]) expect(missingColumns(t, s)).toEqual([])
  for (const n of ['invoices_number_when_issued', 'patient_payments_reference_required', 'invoices_issued_guard', 'invoice_lines_immutable', 'pg_trigger']) expect(s).toContain(n)
})
describe.skipIf(!process.env.DATABASE_URL)('invoices and ledger (DB)', () => {
  it('stores and reads back 2^31 paise on payments and invoice totals', async () => { /* amount 2_147_483_648; total 3_540_000_000 */ })
  it('refuses to update or delete an invoice line', async () => { /* expect pgErrorCode === '55000' */ })
  it('allows finalised → cancelled only, and nothing on a cancelled invoice', async () => {
    /* finalised invoice: update total → 55000; update status cancelled + cancelled_at → ok; then any update → 55000; delete → 55000 */
  })
  it('purgeBillingFixtures removes issued fixtures', async () => {})
})
```

- [ ] **Step 2: Run to verify failure:** `npm test -- tests/db/sp4-invoices-schema.test.ts` → FAIL.
- [ ] **Step 3: Implement** the schema, the migration, the seed change and the fixture helper. Apply migration B to the local container **twice**.
- [ ] **Step 4: Verify:** same + `npm test -- tests/db/sp4-charge-lines-schema.test.ts` + `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/db/seed.ts src/lib/billing/gst.ts scripts/migrations/2026-10-07-sp4-b-invoices-ledger.sql tests/db/billing-fixtures.ts tests/db/sp4-invoices-schema.test.ts
git commit -m "feat(sp4): invoices, credit notes, receipts, refunds and counters with immutability triggers"
```

---

### Task 6: Billing settings, rule configuration, payer and service flags (queries + routes)

**Files:**
- Create: `src/lib/billing/route-responses.ts`, `src/lib/queries/billing-settings.ts`
- Create: `src/app/api/billing/settings/route.ts` (PUT), `src/app/api/billing/rules/[code]/route.ts` (PUT), `src/app/api/billing/payers/[id]/route.ts` (PUT)
- Modify: `src/lib/tariff/validation.ts`: `serviceBase` gains `requiresPreauth: z.boolean().optional()` and `maxQuantity: z.number().int().min(1).max(1000).nullable().optional()`. `updateService` already spreads the patch, so no change is needed there.
- Modify: `src/components/tariff/ServiceFormModal.tsx`: a "Needs pre-authorisation" checkbox and a "Max quantity per line" input.
- Modify: `tests/api/rbac-route-gates.test.ts`: create `SP4_WRITE_GATES` and add it to the deny-before-parse `describe.each` spread.
- Test: `tests/lib/queries/billing-settings.test.ts` (DB), `tests/api/billing-settings.test.ts`, `tests/lib/tariff/validation.test.ts` (append)

**Interfaces:**
- Produces (`route-responses.ts`): re-exports `readJsonBody` (SP3) and `parseId`, `invalid` (SP2); `billingError(status: number, error: string)`; `billingServerError(tag: string, err: unknown, message: string)`, which maps `isRetryableConflict` to 409 `RETRY_MESSAGE` and otherwise gives a 500, logging `[billing] <tag> failed (code …, constraint …)` only.
- Produces (`billing-settings.ts`):
  - `getBillingSettings(executor?: WriteExecutor): Promise<BillingSettingsRow>`. If the row is missing (a DB before migration A), it returns the migration defaults.
  - `updateBillingSettings(input: BillingSettingsInput, session: Session): Promise<{ ok: true } | { ok: false; error: 'room_rent_service_invalid' }>`. The room-rent service must exist with category `room_rent`. Audit: `billing: updated billing settings`, patient null, details `fields=<sorted keys that changed>`.
  - `getRuleConfig(executor?: WriteExecutor): Promise<RuleConfig>`
  - `setRuleConfig(code: ChargeRuleCode, entry: RuleConfigEntry, session: Session): Promise<{ ok: true } | { ok: false; error: 'not_configurable' }>`. Upsert. Audit: `billing: updated charge rule`, details `rule=<code> enabled=<true|false> severity=<block|warn|default>`.
  - `listRuleRows(): Promise<(ChargeRuleDefinition & RuleConfigEntry & { effectiveSeverity: RuleSeverity })[]>`
  - `updatePayerBillingFlags(payerId: number, input: PayerBillingFlagsInput, session: Session): Promise<boolean>`. False when the payer is missing. Audit: `billing: updated payer billing flags`, details `payer=<id>`.
- Routes (all: session → inline gate → `readJsonBody` → zod `.safeParse` → `invalid(err, fallback)`):

  | Route | Gate | Body | Responses |
  |---|---|---|---|
  | `PUT /api/billing/settings` | `BILLING_CONFIG_ROLES` | `billingSettingsSchema` | 200 `{ ok: true }`; 400 `Choose a room-rent service from the Room rent category` |
  | `PUT /api/billing/rules/[code]` | `BILLING_CONFIG_ROLES` | `ruleConfigSchema` | 404 `Unknown rule` (code not in `CHARGE_RULE_CODES`); 400 `This rule cannot be changed` (not configurable); 200 |
  | `PUT /api/billing/payers/[id]` | `BILLING_CONFIG_ROLES` | `payerBillingFlagsSchema` | 400 bad id; 404 `Payer not found`; 200 |

- [ ] **Step 1: Write the failing tests**

```ts
// billing-settings.test.ts (routes, query module mocked)
it('crc gets 403 on PUT /api/billing/settings and the query is never called', async () => {})
it('admin PUT with a GSTIN from another state is a 400 with the authored message', async () => {})
it('PUT /api/billing/rules/price_unresolved is a 400: not configurable', async () => {})
it('PUT /api/billing/rules/nope is a 404', async () => {})
// rbac-route-gates.test.ts rows
{ name: 'PUT /api/billing/settings', call: () => settle(() => putBillingSettings(send('PUT', '/api/billing/settings'))), allowed: [...BILLING_CONFIG_ROLES] },
{ name: 'PUT /api/billing/rules/[code]', call: () => settle(() => putBillingRule(send('PUT', '/api/billing/rules/duplicate_charge'), ctx({ code: 'duplicate_charge' }))), allowed: [...BILLING_CONFIG_ROLES] },
{ name: 'PUT /api/billing/payers/[id]', call: () => settle(() => putPayerFlags(send('PUT', `/api/billing/payers/${BOGUS_ID}`), ctx({ id: BOGUS_ID }))), allowed: [...BILLING_CONFIG_ROLES] },
// + the same three in SP4_WRITE_GATES with NOT_JSON
// queries/billing-settings.test.ts (DB)
it('round-trips settings and writes one audit row in the same transaction', async () => {})
it('rule config upsert is reflected by getRuleConfig and listRuleRows', async () => {})
// tariff/validation.test.ts
it('service update accepts requiresPreauth and a maxQuantity of 1..1000', () => {})
```

- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/api/billing-settings.test.ts tests/lib/tariff/validation.test.ts`, `npm test -- tests/lib/queries/billing-settings.test.ts tests/api/rbac-route-gates.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify:** same commands + `npx vitest run tests/api/tariff-services.test.ts tests/lib/tariff/validation.test.ts` (the SP2 service route still passes) + `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/billing/route-responses.ts src/lib/queries/billing-settings.ts src/app/api/billing src/lib/tariff/validation.ts src/components/tariff/ServiceFormModal.tsx tests
git commit -m "feat(sp4): billing settings, rule configuration, payer and service billing flags"
```

---

### Task 7: Charge capture query layer (context, preview, capture, void)

**Files:**
- Create: `src/lib/queries/service-code-lookup.ts`, `src/lib/queries/charge-capture.ts`
- Test: `tests/lib/queries/charge-capture.test.ts` (DB)

**Interfaces:**
- Consumes:
  - Tasks 1–6: `lineTaxablePaise`, `lineTax`, `placeOfSupply`, `evaluateChargeRules`, `unresolvedBlocks`, `appliedOverrides`, `admissionDepositPaise`, `ChargeCaptureInput`, `getBillingSettings`, `getRuleConfig`
  - SP2/SP3: `loadPricingContext`, `resolvePrice`, `getEncounterById`, `todayIsoIn`, `istDateOf`
- Produces (`service-code-lookup.ts`):
  - `loadMappedProcedureCodes(executor: WriteExecutor, serviceId: number): Promise<ProcedureCodeRef[]>`. Runs `select to_regclass('public.service_procedure_codes') is not null as present`. When absent it returns `[]`. Otherwise it runs `select code_system_kind as kind, code from service_procedure_codes where service_id = $1 order by is_primary desc, id`. Raw `sql` through `executor.execute`; no import from SP6.
- Produces (`charge-capture.ts`):
  - `interface ChargeContext { kind: 'encounter' | 'admission'; patientId: string; encounterId: number | null; admissionId: number | null; departmentId: number | null; orderingProviderId: number; startDate: string; endDate: string | null; isInpatient: boolean; isEmergencyAdmission: boolean; roomCategoryCode: string | null; ward: string | null; primaryPayerId: number | null; cancelled: boolean }`
  - `loadChargeContext(executor: WriteExecutor, ref: { encounterId: number } | { admissionId: number }): Promise<ChargeContext | null>`. The two kinds:
    - **Encounter:** `startDate = encounterDate`; `endDate = istDateOf(completedAt)` or null; `isInpatient = encounterType === 'ipd'`. An IPD encounter also carries its `admissionId` and the admission's room.
    - **Admission:** `startDate = istDateOf(admittedAt)`; `endDate = istDateOf(dischargedAt)` or null; `encounterId` is the admission's SP3 IPD encounter if any; `departmentId` is the attending provider's department; the room is `currentRoomId` → `rooms.ward` and `room_categories.code`.
    - `primaryPayerId` comes from `patients.primary_payer_id` (named column).
  - `interface ChargePreview { price: PriceResolution; unitPricePaise: number | null; priceSource: PriceSource | null; taxablePaise: number | null; estimatedTax: LineTax | null; violations: ChargeViolation[]; unresolved: ChargeRuleCode[] }`
  - `previewChargeLine(input: ChargeCaptureInput, session: Session, now?: Date): Promise<{ ok: true; preview: ChargePreview } | { ok: false; error: CaptureError }>`
  - `type CaptureError = 'context_not_found' | 'context_cancelled' | 'no_payer' | 'price_override_forbidden' | 'blocked'`
  - `captureChargeLine(input: ChargeCaptureInput, session: Session, now?: Date): Promise<{ ok: true; line: ChargeLineRow; violations: ChargeViolation[] } | { ok: false; error: CaptureError; violations?: ChargeViolation[] }>`
  - `voidChargeLine(lineId: number, reason: string, session: Session): Promise<{ ok: true } | { ok: false; error: 'not_found' | 'not_voidable' }>`. Only status `captured` lines can be voided (this includes one sitting on a draft invoice: void clears `invoice_id`). Audit: `billing: voided charge line`, details `line=<id>`.
- Algorithm for preview and capture (shared private `evaluate(executor, input, session, now)`):
  1. `manualUnitPricePaise` present and `session.role` ∉ `BILLING_AUTHORITY_ROLES` → `price_override_forbidden`.
  2. Load the context: null → `context_not_found`; `cancelled` → `context_cancelled`. `billTo === 'payer'` with no `primaryPayerId` → `no_payer`.
  3. Load the service row (with the SP4 flags), the payer flags, settings, rule config and mapped codes. Run `resolvePrice(…)` on `loadPricingContext(serviceId)` (loaded before the transaction), with `{ serviceId, payerId (when billTo payer), departmentId: context.departmentId ?? undefined, roomCategory, ward, onDate: serviceDate }`.
  4. Build the rule input:
     - `consultationDates`: the patient's encounters with type `opd`/`ipd`, status ≠ `cancelled`, `encounter_date` within `[serviceDate − N, serviceDate]`.
     - `admissionDepositPaise`: `admissionDepositPaise(entries, admissionId)` over the patient's advances and refunds.
     - `sameDayDuplicates`: count of non-void lines with the same patient, service and service date, and the same `admission_id` when the context has one, else the same `encounter_id`.
     - `today`: `todayIsoIn(DEFAULT_TIMEZONE, now)`.
  5. Unit price: manual if given (`priceSource 'manual'`, `resolvedPricePaise` = the resolver amount or null); else the resolver amount and scope.
  6. When the service has mapped codes and the request has none, the line's `procedureCodes` = the first mapped code (the primary one).
  7. `estimatedTax`: `lineTax(taxable, gstRateBp, placeOfSupply(settings…).supplyType)`. The hospital state is required to estimate; without it, `estimatedTax: null`.
- Capture adds:
  - `getDb().transaction`, which first runs `select pg_advisory_xact_lock(hashtext('billing:patient:' || $patientId))`, then steps 2–6 on `tx` (so the duplicate count sees committed concurrent captures).
  - Unresolved blocks (`canOverride` = role ∈ `BILLING_AUTHORITY_ROLES`) → `blocked`.
  - Insert the line: `violations` = the non-blocking violations plus the overridden ones; `ruleOverrides` = `appliedOverrides`; `itemCode`/`itemName`/`hsnSac`/`gstRateBp`/`serviceCategory` from the service; `orderingProviderId` from the context.
  - Audit, all on `tx`:
    - `billing: captured charge line`, details `line=<id> service=<code> qty=<n> price=<priceSource>`
    - plus `billing: overrode charge price`, details `line=<id> resolved=<paise|none> charged=<paise>`, when manual
    - plus `billing: overrode charge rule`, details `line=<id> rules=<codes comma-joined>`, when any override was applied

- [ ] **Step 1: Write the failing tests** (DB; fixtures: department, `TEST_SP4_` services with base rates, an OPD encounter and an admission with a room of a test category)

```ts
it('prices from the resolver and snapshots the rate id and scope', async () => { /* base 50000 → line.unitPricePaise 50000, priceSource 'base', tariffRateId = rate.id, taxable 50000 × qty */ })
it('uses the room category rate for an admission', async () => { /* base 50000 + ICU-category base 90000 → 90000 */ })
it('blocks no_rate unless an authority role gives a manual price', async () => {
  /* crc → { ok:false, error:'blocked' } with price_unresolved; crc with manual → price_override_forbidden; billing with manual+reason → ok, priceSource 'manual', resolvedPricePaise null, audit rows 'billing: overrode charge price' */
})
it('two concurrent identical captures: one line, one duplicate_charge refusal', async () => {
  const [a, b] = await Promise.all([captureChargeLine(req, crc), captureChargeLine(req, crc)])
  expect([a.ok, b.ok].sort()).toEqual([false, true]); expect((a.ok ? b : a).violations!.map((v) => v.code)).toContain('duplicate_charge')
})
it('billing may override the duplicate with a reason; the override is stored and audited', async () => {})
it('a procedure without a recent consultation is blocked for an encounter-less lab context', async () => {})
it('deposit threshold blocks an IPD procedure until an advance is recorded', async () => { /* threshold 500000; insert a patient_payments advance of 500000 for the admission → ok */ })
it('a cancelled encounter refuses capture', async () => {})
it.skipIf(!sp6TablePresent)('a mapped service refuses an unmapped procedure code and auto-fills the primary', async () => {})
it('void keeps the row with its reason and frees it from a draft invoice', async () => {})
it('audit details carry ids and codes only', async () => { /* no reason text, no item name in audit_log.details */ })
it('loadMappedProcedureCodes returns [] when the SP6 table is absent', async () => { /* executor double whose execute returns { rows: [{ present: false }] } */ })
```

- [ ] **Step 2: Run to verify failure:** `npm test -- tests/lib/queries/charge-capture.test.ts` → FAIL.
- [ ] **Step 3: Implement** both modules.
- [ ] **Step 4: Verify:** same + `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/queries/service-code-lookup.ts src/lib/queries/charge-capture.ts tests/lib/queries/charge-capture.test.ts
git commit -m "feat(sp4): charge capture with resolver pricing, validation, overrides and per-patient locking"
```

---

### Task 8: Charge-line routes (preview, capture, void)

**Files:**
- Create: `src/app/api/billing/charge-lines/route.ts` (POST), `src/app/api/billing/charge-lines/preview/route.ts` (POST), `src/app/api/billing/charge-lines/[id]/void/route.ts` (POST)
- Modify: `tests/api/rbac-route-gates.test.ts` (`API_GATES` and `SP4_WRITE_GATES` rows)
- Test: `tests/api/billing-charge-lines.test.ts`

**Interfaces:**
- Consumes: Task 7 (`previewChargeLine`, `captureChargeLine`, `voidChargeLine`), Task 3 schemas, Task 6 route helpers.
- Error mapping (exact):

  | Query result | HTTP |
  |---|---|
  | `context_not_found` | 404 `Visit or admission not found` |
  | `context_cancelled` | 409 `This visit was cancelled; charges cannot be added` |
  | `no_payer` | 400 `This patient has no primary payer on file` |
  | `price_override_forbidden` | 403 `Only billing or admin staff can override a price` |
  | `blocked` | 422 `{ error: 'This charge breaks billing rules', violations }` |
  | capture ok | 201 `{ line, violations }` |
  | preview ok | 200 `{ preview }` (a preview never 422s; blocks travel in `preview.unresolved`) |
  | void `not_found` | 404 `Charge line not found` |
  | void `not_voidable` | 409 `Only a charge that is not yet invoiced can be voided` |

- [ ] **Step 1: Write the failing tests**

```ts
it('frontdesk is 403 before the body is read', async () => {})
it('a blocked capture is a 422 with the typed violations', async () => {})
it('a crc manual price is a 403 with the exact message', async () => {})
it('preview returns 200 with unresolved blocks instead of 422', async () => {})
it('a 40P01 thrown by the query is a 409 with the retry message', async () => {})
// API_GATES (CHARGE_CAPTURE_ROLES) + SP4_WRITE_GATES rows for the three routes
```

- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/api/billing-charge-lines.test.ts`, `npm test -- tests/api/rbac-route-gates.test.ts` → FAIL.
- [ ] **Step 3: Implement** the three routes.
- [ ] **Step 4: Verify:** same + `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/app/api/billing/charge-lines tests/api/billing-charge-lines.test.ts tests/api/rbac-route-gates.test.ts
git commit -m "feat(sp4): charge-line preview, capture and void routes"
```

---

### Task 9: Room-rent posting (query + route)

**Files:**
- Create: `src/lib/queries/room-rent.ts`, `src/app/api/billing/admissions/[id]/room-rent/route.ts` (POST)
- Modify: `tests/api/rbac-route-gates.test.ts`
- Test: `tests/lib/queries/room-rent.test.ts` (DB), `tests/api/billing-room-rent.test.ts`

**Interfaces:**
- Consumes: `planRoomRentDays` (Task 3), `loadChargeContext` (Task 7), `getBillingSettings`, `loadPricingContext`, `resolvePrice`, `admission_transfers`.
- Produces:
  - `postRoomRent(admissionId: number, session: Session, opts?: { throughDate?: string; now?: Date }): Promise<{ ok: true; posted: number; skipped: { date: string; reason: 'no_rate' | 'no_room' }[] } | { ok: false; error: 'not_found' | 'service_not_configured' }>`
  - Steps:
    1. One transaction with the patient lock (Task 7 key).
    2. Load the admission, its transfers ordered by `transferredAt`, and each room's ward and category code. `initialRoom` is the first transfer's `fromRoomId` room when transfers exist, else `currentRoomId`.
    3. Plan the days and drop those after `throughDate`. Drop days that already have a live `room_rent` line.
    4. Price each remaining day with `settings.roomRentServiceId`, that day's room category and ward, and the patient's primary payer when one exists. Payer pricing for room rent follows the primary payer (ruling 6).
    5. Insert one line per priced day: `source 'room_rent'`, quantity 1. A day with `room === null` is skipped as `no_room`; a `no_rate` day is skipped and reported.
    6. Insert with `on conflict do nothing` against `charge_lines_room_rent_day_unique`, so a racing post never duplicates. `posted` counts the rows actually inserted.
    7. Audit: `billing: posted room rent`, details `admission=<id> days=<posted> skipped=<n>`.
  - Route `POST /api/billing/admissions/[id]/room-rent`:
    - gate `CHARGE_CAPTURE_ROLES`, body `roomRentPostSchema` (`{}` allowed)
    - 400 bad id; 404 `Admission not found`; 409 `Set the room-rent service in Billing rules & settings first`; 200 `{ posted, skipped }`

- [ ] **Step 1: Write the failing tests**

```ts
it('posts one line per census day with the day room category price', async () => { /* GEN 2000_00 then ICU 9000_00 after a transfer */ })
it('is idempotent: a second post adds nothing', async () => {})
it('reports a no_rate day and posts the rest', async () => {})
it('a voided day is re-posted on the next run', async () => {})
it('409 when the room-rent service is not configured', async () => {})
// API_GATES + SP4_WRITE_GATES rows (CHARGE_CAPTURE_ROLES)
```

- [ ] **Step 2: Run to verify failure:** `npm test -- tests/lib/queries/room-rent.test.ts`, `npx vitest run tests/api/billing-room-rent.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify:** same + `npm test -- tests/api/rbac-route-gates.test.ts` + `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/queries/room-rent.ts src/app/api/billing/admissions tests
git commit -m "feat(sp4): idempotent room-rent posting per census day from the admission's room history"
```

---

### Task 10: Gapless numbering and the invoice lifecycle (queries)

**Files:**
- Create: `src/lib/queries/document-numbers.ts`, `src/lib/queries/invoices.ts`
- Test: `tests/lib/queries/invoices.test.ts` (DB)

**Interfaces:**
- Consumes: Task 1 (`financialYearOf`, `formatDocumentNumber`, `lineTax`, `placeOfSupply`, `documentTitle`, `sumPaise`, `GST_STATE_CODES`, `stateCodeOfGstin`), `getBillingSettings`, `istDateOf`, `publicPatientColumns` or named patient columns.
- Produces (`document-numbers.ts`):
  - `allocateDocumentNumber(executor: WriteExecutor, series: DocumentSeries, financialYear: string): Promise<string>`. **Must run inside the caller's transaction.**
    1. `insert into document_counters (series, financial_year, last_value) values ($1, $2, 0) on conflict do nothing`
    2. `update document_counters set last_value = last_value + 1 where series = $1 and financial_year = $2 returning last_value`. The row lock is held to commit.
    3. `formatDocumentNumber(series, fy, value)`. Past `999999` the `document_counters_value_range` check fails before formatting; map that `23514` to `SeriesExhaustedError`.
- Produces (`invoices.ts`):
  - `createDraftInvoice(lineIds: number[], session: Session): Promise<{ ok: true; invoiceId: number } | { ok: false; error: 'lines_not_found' | 'lines_not_available' | 'mixed_lines' }>`
    - Lock the lines `for update` (after the patient lock).
    - Every line must have status `captured` and no `invoice_id`, else `lines_not_available`.
    - The lines must share one patient, one `payer_id` (null counts), and one context: the same `admission_id` when any line has one, else the same `encounter_id`. Pharmacy lines with neither form their own group. Otherwise `mixed_lines`.
    - Insert the invoice (`draft`, context ids, `payerId`) and set `charge_lines.invoice_id`.
    - Audit: `billing: created draft invoice`, details `invoice=<id> lines=<n>`.
  - `discardDraftInvoice(invoiceId: number, session: Session): Promise<{ ok: true } | { ok: false; error: 'not_found' | 'not_draft' }>`. Releases the lines and sets status `discarded`. Audit: `billing: discarded draft invoice`.
  - `finaliseInvoice(invoiceId: number, session: Session, now?: Date, hooks?: { afterNumber?: () => void }): Promise<{ ok: true; invoiceNumber: string } | { ok: false; error: 'not_found' | 'not_draft' | 'empty' | 'settings_incomplete' | 'taxable_without_gstin' | 'series_exhausted' }>`
    1. Patient lock, then the invoice `for update`, then its lines `for update`.
    2. Settings need `legalName` and `stateCode`, else `settings_incomplete`. Any line with `gstRateBp > 0` and no hospital GSTIN → `taxable_without_gstin`.
    3. Recipient state: the payer's `stateCode`, else `stateCodeOfGstin(payer.gstin)`, else the patient's `state_code`. Pass it with the settings mode to `placeOfSupply`.
    4. `invoiceDate = istDateOf(now)`, `fy = financialYearOf(invoiceDate)`.
    5. Per line, in `service_date, id` order: `lineTax`, then insert `invoice_lines` (`lineNo` from 1).
    6. Totals via `sumPaise`; `documentTitle`; the snapshot (`InvoiceSnapshot`, patient named columns only).
    7. `allocateDocumentNumber(tx, 'invoice', fy)` **after** every check, then update the invoice to `finalised` and the lines to `invoiced`.
    8. Audit: `billing: finalised invoice`, details `invoice=<id> number=<no> total=<paise>`.
  - `cancelInvoice(invoiceId: number, reason: string, session: Session, now?: Date): Promise<{ ok: true; creditNoteNumber: string } | { ok: false; error: 'not_found' | 'not_finalised' }>`
    1. Lock; the invoice must be `finalised`.
    2. Number a `credit_note` in the FY of `istDateOf(now)`, and insert it with amounts equal to the invoice totals and the reason.
    3. Update the invoice to `cancelled` (the trigger allows exactly this). Release its lines: status `captured`, `invoice_id` null.
    4. Audit: `billing: cancelled invoice by credit note`, details `invoice=<id> credit_note=<no>`.
  - Reads:
    - `getInvoice(id): Promise<InvoiceDetail | null>`. `InvoiceDetail` = invoice row + `lines` + `creditNote` + `patientName` + `uhid`. For drafts, `lines` are the attached charge lines mapped to the invoice-line shape with an **estimated** split.
    - `listInvoices(opts: { status?: InvoiceStatus; q?: string; page?: number }): Promise<{ rows: InvoiceListRow[]; total: number }>`. `q` matches the invoice number prefix or the UHID; 50 per page; newest first.
    - `listCapturedLinesForContext(ref): Promise<ChargeLineRow[]>`

- [ ] **Step 1: Write the failing tests** (DB, `now = new Date('2099-06-01T06:00:00Z')`, cleanup with `purgeBillingFixtures`)

```ts
it('finalises with consecutive numbers in the 2099-00 series', async () => { /* two invoices → INV/99-00/000001, INV/99-00/000002 */ })
it('concurrent finalisations get consecutive numbers', async () => { /* 5 drafts for 5 patients via Promise.all → numbers are exactly 000001..000005, no duplicates */ })
it('a finalise that throws after numbering leaves no gap', async () => {
  /* finaliseInvoice(id, session, now, { afterNumber: () => { throw new Error('boom') } }) rejects; the invoice is still 'draft';
     the next finalise gets INV/99-00/000001 */
})
it('finalise just after IST midnight on 1 April uses the new series', async () => { /* now 2099-03-31T18:40Z → INV/99-00/… (fy 2099-00) */ })
it('splits CGST/SGST intra-state and IGST for a recipient-state payer elsewhere', async () => {})
it('refuses taxable lines without a hospital GSTIN, and incomplete settings', async () => {})
it('mixed payers or contexts cannot share a draft', async () => {})
it('cancel issues a credit note for the full value and frees the lines for a new invoice', async () => {})
it('a finalised invoice cannot be finalised or discarded again', async () => {})
it('snapshot holds no aadhaar, phone, email or dob keys', async () => { expect(JSON.stringify(inv.snapshot)).not.toMatch(/aadhaar|phone|email|dob/i) })
```

  `hooks.afterNumber` is called right after `allocateDocumentNumber`. It is a test seam only; no app caller passes it.

- [ ] **Step 2: Run to verify failure:** `npm test -- tests/lib/queries/invoices.test.ts` → FAIL.
- [ ] **Step 3: Implement** both modules.
- [ ] **Step 4: Verify:** same + `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/queries/document-numbers.ts src/lib/queries/invoices.ts tests/lib/queries/invoices.test.ts
git commit -m "feat(sp4): gapless FY document numbering and the draft-finalise-cancel invoice lifecycle"
```

---

### Task 11: Invoice routes

**Files:**
- Create: `src/app/api/billing/invoices/route.ts` (POST draft), `src/app/api/billing/invoices/[id]/finalise/route.ts`, `.../[id]/discard/route.ts`, `.../[id]/cancel/route.ts` (POST each)
- Modify: `tests/api/rbac-route-gates.test.ts`
- Test: `tests/api/billing-invoices.test.ts`

**Interfaces:**
- Gates and bodies:

  | Route | Gate | Body |
  |---|---|---|
  | `POST /api/billing/invoices` | `CHARGE_CAPTURE_ROLES` | `draftInvoiceSchema` |
  | `POST …/[id]/discard` | `CHARGE_CAPTURE_ROLES` | `{}` (strict) |
  | `POST …/[id]/finalise` | `BILLING_AUTHORITY_ROLES` | `{}` (strict) |
  | `POST …/[id]/cancel` | `BILLING_AUTHORITY_ROLES` | `cancelInvoiceSchema` |

- Error mapping (exact):

  | Query result | HTTP |
  |---|---|
  | `lines_not_found` | 404 `Charge lines not found` |
  | `lines_not_available` | 409 `Some lines are already invoiced or voided` |
  | `mixed_lines` | 400 `Lines on one invoice must share the patient, the visit or stay, and the payer` |
  | `not_found` | 404 `Invoice not found` |
  | `not_draft` | 409 `Only a draft invoice can be changed` |
  | `empty` | 409 `This draft has no lines` |
  | `settings_incomplete` | 409 `Set the hospital legal name and state in Billing rules & settings before finalising` |
  | `taxable_without_gstin` | 409 `This bill has taxable lines but no hospital GSTIN is set` |
  | `series_exhausted` | 409 `The invoice number series for this financial year is full` |
  | `not_finalised` | 409 `Only a finalised invoice can be cancelled` |
  | draft ok | 201 `{ invoiceId }` |
  | finalise ok | 200 `{ invoiceNumber }` |
  | cancel ok | 200 `{ creditNoteNumber }` |

  Retry conflicts go through `billingServerError`.

- [ ] **Step 1: Write the failing tests:** crc finalise → 403 before parse; frontdesk cancel → 403; each error code maps to its exact message; `API_GATES` and `SP4_WRITE_GATES` rows for all four routes.
- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/api/billing-invoices.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify:** same + `npm test -- tests/api/rbac-route-gates.test.ts` + `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/app/api/billing/invoices tests/api/billing-invoices.test.ts tests/api/rbac-route-gates.test.ts
git commit -m "feat(sp4): invoice draft, finalise, discard and credit-note cancel routes"
```

---

### Task 12: Advances, receipts, refunds and the patient ledger

**Files:**
- Create: `src/lib/queries/patient-ledger.ts`, `src/app/api/billing/payments/route.ts` (POST), `src/app/api/billing/refunds/route.ts` (POST)
- Modify: `src/lib/queries/patients.ts` `deletePatient`, `src/app/api/patients/[anonId]/route.ts` (DELETE handler), `tests/api/rbac-route-gates.test.ts`
- Test: `tests/lib/queries/patient-ledger.test.ts` (DB), `tests/api/billing-payments.test.ts`

**Interfaces:**
- Consumes: Task 3 (`computeLedger`, `admissionDepositPaise`, `paymentSchema`, `refundSchema`), Task 10 (`allocateDocumentNumber`), Task 1 (`paiseFromDb`, `financialYearOf`).
- Produces (`patient-ledger.ts`):
  - `loadLedgerEntries(executor: WriteExecutor, patientId: string): Promise<LedgerEntry[]>`. Covers finalised and cancelled invoices (at `finalisedAt`), credit notes (`issuedAt`), payments (`advance` / `receipt` by kind, `receivedAt`) and refunds (`issuedAt`).
  - `getPatientLedger(patientId: string): Promise<{ patient: { id: string; name: string; uhid: string | null }; activeAdmissionId: number | null; ledger: ReturnType<typeof computeLedger>; unbilledPaise: number; legacyCharges: LegacyChargeRow[] } | null>`
    - `unbilledPaise` = SQL `sum(taxable_paise)` of `captured` lines through `paiseFromDb`.
    - `LegacyChargeRow = { id: number; dateOfService: string; amountPaise: number; status: ChargeStatus; legacy: true }`. These are legacy `charges` rows with no linked `charge_lines.legacy_charge_id` (`amount_cents` read as paise). They are shown flagged and are **excluded** from the ledger (ruling 3).
  - `findPatientForCashDesk(query: string): Promise<{ id: string; name: string; uhid: string | null }[]>`. Exact UHID or patient id match first, then a name prefix (max 10). Named columns only.
  - `recordPayment(input: PaymentInput, session: Session, now?: Date): Promise<{ ok: true; receiptNumber: string; paymentId: number } | { ok: false; error: 'patient_not_found' | 'admission_mismatch' | 'invoice_not_payable' }>`
    - Patient lock.
    - `admissionId` must belong to the patient. `invoiceId` must be the patient's `finalised` invoice.
    - Number in the `receipt` series (advances and receipts share it) for FY `istDateOf(now)`.
    - Audit: `billing: recorded advance` or `billing: recorded receipt`, details `receipt=<no> mode=<mode> amount=<paise>`. The reference is never in the audit.
  - `issueRefund(input: RefundInput, session: Session, now?: Date): Promise<{ ok: true; refundNumber: string } | { ok: false; error: 'patient_not_found' | 'payment_mismatch' | 'exceeds_credit'; creditPaise?: number }>`
    - Patient lock.
    - `againstPaymentId` must be the patient's.
    - The amount must be ≤ `computeLedger(loadLedgerEntries(tx)).summary.creditBalancePaise`, else `exceeds_credit` with the credit.
    - Number in the `refund` series.
    - Audit: `billing: issued refund`, details `refund=<no> mode=<mode> amount=<paise>`.
  - `getReceipt(id: number): Promise<(PatientPaymentRow & { patientName: string; uhid: string | null }) | null>`. Used by the print page.
- `deletePatient`:
  - Before any delete, if the patient has any invoice with status `finalised`/`cancelled`, or any `patient_payments` or `refunds` row, throw `PatientHasFinancialRecordsError` (exported). These are tax records that must be kept.
  - Otherwise delete the patient's `charge_lines` and draft/discarded `invoices` before the encounters/admissions deletes.
  - The DELETE route maps the error to 409 `This patient has issued bills or receipts, which must be kept; the patient cannot be deleted`.
- Routes:

  | Route | Gate | Body | Errors |
  |---|---|---|---|
  | `POST /api/billing/payments` | `CASH_DESK_ROLES` | `paymentSchema` | 404 `Patient not found`; 400 `That admission is not this patient's`; 409 `Payments can only be taken against a finalised invoice of this patient`; 201 `{ receiptNumber, paymentId }` |
  | `POST /api/billing/refunds` | `BILLING_AUTHORITY_ROLES` | `refundSchema` | 404; 400 `That receipt is not this patient's`; 409 `Refund is more than the patient's credit of <formatPaise(credit)>`; 201 `{ refundNumber }` |

- [ ] **Step 1: Write the failing tests**

```ts
// DB
it('advance then invoice then receipt gives the running balance', async () => {})
it('ledger sum above 2^31 is exact', async () => { /* two finalised fixture invoices of 2_000_000_000 → invoicedPaise 4_000_000_000 */ })
it('refund cannot exceed the credit balance', async () => {})
it('advances count toward the admission deposit used by capture', async () => {})
it('legacy charges are listed flagged and excluded from outstanding; a pharmacy-linked one is not listed', async () => {})
it('audit details carry no reference', async () => { /* reference 'UTR412345678901' never appears in audit_log.details */ })
it('deletePatient refuses a patient with a receipt and deletes one with only drafts', async () => {})
// routes
it('frontdesk can record a receipt but gets 403 on a refund', async () => {})
it('a card number in the reference is a 400 with the authored message', async () => {})
// API_GATES + SP4_WRITE_GATES rows for both routes; the patients DELETE test gains the 409 case
```

- [ ] **Step 2: Run to verify failure:** `npm test -- tests/lib/queries/patient-ledger.test.ts`, `npx vitest run tests/api/billing-payments.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify:** same + `npm test -- tests/api/rbac-route-gates.test.ts tests/api/patients.test.ts` + `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/queries/patient-ledger.ts src/lib/queries/patients.ts src/app/api/billing/payments src/app/api/billing/refunds "src/app/api/patients/[anonId]/route.ts" tests
git commit -m "feat(sp4): advances, receipts, refunds, running ledger, and keep patients with issued bills"
```

---

### Task 13: Pharmacy dispense charge writes a charge line

**Files:**
- Modify: `src/lib/queries/medication-dispenses.ts` (`createChargeForDispense`), `src/app/api/pharmacy/dispenses/[dispenseId]/charge/route.ts`
- Test: `tests/api/pharmacy-dispense-charge.test.ts` (existing; must stay green), `tests/lib/queries/medication-dispenses-charge-line.test.ts` (DB)

**Interfaces:**
- Consumes: `getBillingSettings(tx)`, `lineTaxablePaise`, `istDateOf`, `chargeLines`, the patient lock key from Task 7.
- Changes:
  - `DispenseChargeInput` gains `serviceDate: string`. The route passes `istDateOf(dispense.dispensedAt)`, replacing `toISOString().slice(0, 10)` for **both** the legacy `dateOfService` and the line.
  - Inside the existing transaction, after the legacy charge insert and the dispense link, insert one `charge_lines` row:
    - `source 'pharmacy'`, `priceSource 'pharmacy'`, `serviceId` null
    - `itemCode` = procedure code, `itemName` = description
    - `quantity` = dispense quantity, `unitPricePaise = unitChargeCents`
    - `taxablePaise = lineTaxablePaise(…)`, `gstRateBp = settings.pharmacyGstRateBp`, `hsnSac = settings.pharmacyHsn`
    - `admissionId` = the patient's active admission (looked up on `tx`), else null
    - `legacyChargeId` = the new charge id, `medicationDispenseId` = the dispense id
    - `serviceDate`, `createdByName` = the dispensing user
  - Take the patient lock first in that transaction.
  - The route's gate (`pharmacy`, `admin`), its body, its 409 on double billing and its response `{ chargeId }` are unchanged. The audit row gains details `charge=<id> line=<lineId>`.

- [ ] **Step 1: Write the failing tests:** `creates the legacy charge and one pharmacy charge line in one transaction`, `a second bill of the same dispense creates neither`, `the line attaches to the active admission`, `service date is the IST date of the dispense (18:40Z → next day)`.
- [ ] **Step 2: Run to verify failure:** `npm test -- tests/lib/queries/medication-dispenses-charge-line.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify:** same + `npx vitest run tests/api/pharmacy-dispense-charge.test.ts` + `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/queries/medication-dispenses.ts "src/app/api/pharmacy/dispenses/[dispenseId]/charge/route.ts" tests
git commit -m "feat(sp4): pharmacy dispense billing also records a charge line"
```

---

### Task 14: Charge capture page

**Files:**
- Create: `src/app/(dashboard)/billing/capture/page.tsx`, `src/components/billing/ChargeCaptureForm.tsx`, `src/components/billing/ChargeLinesTable.tsx`, `src/components/billing/ViolationList.tsx`
- Modify: `src/components/LeftNav.tsx` (`NAV_BILLING_ITEMS` + `{ href: '/billing/capture', label: 'Charge Capture', icon: ClipboardPlus }` after A/R Dashboard), `tests/pages/page-gates-harness.ts`
- Test: `tests/components/billing/ChargeCaptureForm.test.tsx`, `tests/pages/billing-capture.test.tsx`

**Interfaces:**
- Consumes: Task 10 `listCapturedLinesForContext`, Task 7 `loadChargeContext` (wrapped by a read `getCaptureHeader(ref)` added to `charge-capture.ts` returning patient name, UHID, context label, payer name and deposit), Task 3 schemas, `sendJson`, `FIELD_CLASS`, `GET /api/tariff/services?q=`.
- Page (`CHARGE_CAPTURE_ROLES`; `searchParams: Promise<{ encounterId?: string; admissionId?: string }>`):
  - **No param:** two tables, today's non-cancelled OPD encounters (IST) and active admissions, each row linking to `?encounterId=` / `?admissionId=`. Empty states: "No visits today." / "No patients admitted."
  - **With a param:**
    - a header: patient name, UHID, visit/stay label, payer, deposit for admissions
    - `ChargeLinesTable`: lines with status, price source badge, warnings, a void action with a reason dialog, checkboxes, and a "Create draft invoice" button that posts the selected ids and navigates to `/billing/invoices/<id>`
    - for an admission, a "Post room rent to date" button that shows `posted` / `skipped`
    - `ChargeCaptureForm`
  - A bad or unknown id → `notFound()`.
  - Audit: `billing: viewed charge capture`, patient id.
- `ChargeCaptureForm({ context, canOverride, hasPayer }: { context: { encounterId: number } | { admissionId: number }; canOverride: boolean; hasPayer: boolean })`:
  - fields: service search (debounced 300 ms), quantity, service date (default today IST), bill-to (payer option disabled when `!hasPayer`), pre-auth reference, procedure codes (kind + code rows)
  - when `canOverride`: a manual price (rupees, parsed with `parseRupeesToPaise`) with a reason
  - every change posts `/api/billing/charge-lines/preview` (debounced 300 ms) and renders the resolved price, source (`Base rate` / `Department rate` / `Payer rate` / `Manual`) and estimated GST, plus `ViolationList`
  - `ViolationList`: block in red, warn in amber, each with its message and field; overridable blocks get an override reason input when `canOverride`
  - Submit posts the capture. A 422 shows the returned violations; a 201 resets the form and calls `router.refresh()`.

- [ ] **Step 1: Write the failing tests**

```ts
it('shows the resolved price and a blocking violation from the preview', async () => { /* mock fetch preview → 'Payer rate', '₹500.00', 'This payer needs a pre-authorisation reference for this service' */ })
it('hides the manual price field when canOverride is false', () => {})
it('override reason input appears only for overridable blocks and only for authority roles', () => {})
it('a 422 on submit lists the violations and keeps the inputs', async () => {})
// PAGE_GATES: { route: '/billing/capture', load: () => import('@/app/(dashboard)/billing/capture/page'), props: { searchParams: Promise.resolve({}) }, allowed: ['admin', 'crc', 'billing'] }
```

- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/components/billing/ChargeCaptureForm.test.tsx tests/pages/billing-capture.test.tsx` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify:** same + `npx vitest run tests/pages/nav-role-enforcement.test.tsx tests/components/LeftNav.test.tsx` + `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/billing/capture" src/components/billing src/components/LeftNav.tsx src/lib/queries/charge-capture.ts tests
git commit -m "feat(sp4): charge capture screen with live price and rule preview"
```

---

### Task 15: Invoice list, detail and print view

**Files:**
- Create: `src/app/(dashboard)/billing/invoices/page.tsx`, `src/app/(dashboard)/billing/invoices/[id]/page.tsx`, `src/app/print/invoices/[id]/page.tsx`, `src/components/billing/InvoiceActions.tsx`, `src/components/billing/InvoiceDocument.tsx`
- Modify: `src/components/LeftNav.tsx` (`NAV_BILLING_ITEMS` + `{ href: '/billing/invoices', label: 'Invoices', icon: FileText }`), `tests/pages/page-gates-harness.ts`, `tests/lib/no-aadhaar-leak.test.ts` (`EXPORT_PATHS` + `'src/lib/billing'`, `'src/lib/queries/invoices.ts'`, `'src/app/print'`, `'src/app/(dashboard)/billing/invoices'`)
- Test: `tests/components/billing/InvoiceDocument.test.tsx`, `tests/pages/billing-invoices.test.tsx`

**Interfaces:**
- Consumes: Task 10 `listInvoices`, `getInvoice`; `stateName`, `GST_STATE_CODES`, `formatPaise`, `formatIsoDate`, `brand`, `PrintButton`, `BackLink`.
- `/billing/invoices` (`CHARGE_CAPTURE_ROLES`, searchParams `status`, `q`, `page`): a table of number (or "Draft #id"), date, patient + UHID, payer, total, status badge; "Showing 1–50 of N"; a GET filter form.
- `/billing/invoices/[id]`: `InvoiceDocument` + `InvoiceActions({ invoiceId, status, canAuthorise })`:
  - draft: Finalise (authority only) and Discard
  - finalised: Cancel by credit note (authority only), with a reason dialog
  - every status: a Print link to `/print/invoices/<id>`
  - Audit: `billing: viewed invoice`, patient id.
- `/print/invoices/[id]` (outside `(dashboard)`, `CHARGE_CAPTURE_ROLES`, audited `billing: printed invoice`): `InvoiceDocument` on a white A4-width layout, with `PrintButton` and `BackLink` marked `print:hidden`.
- `InvoiceDocument({ invoice }: { invoice: InvoiceDetail })`:
  - title (`documentTitle`; drafts read `PROVISIONAL BILL — NOT A TAX INVOICE`)
  - hospital legal name, address, GSTIN
  - number and date
  - place of supply as `<state name> (<GST code>)`
  - bill-to patient (name, UHID, address) and payer (name, GSTIN)
  - a lines table: #, item, HSN/SAC, date, qty, rate, taxable, then CGST % / ₹ and SGST % / ₹ for intra-state or IGST % / ₹ for inter-state, then total
  - a totals block
  - for a cancelled invoice, a red `CANCELLED — Credit note <number>` banner
- Print CSS: Tailwind `print:` variants only (`print:hidden`, `print:shadow-none`, `print:text-black`, `print:break-inside-avoid` on rows). No PDF.

- [ ] **Step 1: Write the failing tests**

```ts
it('renders CGST and SGST columns for an intra-state invoice and IGST for inter-state', () => {})
it('a draft reads PROVISIONAL BILL — NOT A TAX INVOICE and has no number', () => {})
it('a cancelled invoice shows the credit note banner', () => {})
it('formats amounts above 2^31 paise', () => { /* total 3_540_000_000 → '₹3,54,00,000.00' */ })
// PAGE_GATES rows: '/billing/invoices' (props searchParams {}), '/billing/invoices/[id]' (params { id: '1' }), '/print/invoices/[id]' (params { id: '1' }) — all ['admin', 'crc', 'billing']
```

- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/components/billing/InvoiceDocument.test.tsx tests/pages/billing-invoices.test.tsx` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify:** same + `npx vitest run tests/pages/nav-role-enforcement.test.tsx tests/lib/no-aadhaar-leak.test.ts` + `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/billing/invoices" src/app/print src/components/billing src/components/LeftNav.tsx tests
git commit -m "feat(sp4): invoice list, detail with actions, and HTML print view"
```

---

### Task 16: Cash desk, receipt print, billing rules & settings page, billing-only nav

**Files:**
- Create: `src/app/(dashboard)/cash-desk/page.tsx`, `src/app/print/receipts/[id]/page.tsx`, `src/app/(dashboard)/billing/rules/page.tsx`, `src/components/billing/CashDeskPanel.tsx`, `src/components/billing/LedgerTable.tsx`, `src/components/billing/BillingSettingsForm.tsx`, `src/components/billing/RuleConfigTable.tsx`
- Modify: `src/components/LeftNav.tsx`:
  - `NAV_ITEMS` + `{ href: '/cash-desk', label: 'Cash Desk', icon: Banknote, roles: ['admin', 'billing', 'crc', 'frontdesk'] }` after Booking Requests
  - `NAV_BILLING_ITEMS` + `{ href: '/billing/rules', label: 'Rules & Settings', icon: SlidersHorizontal }` at the end
  - For `isBillingOnly`, render a "Navigation" group containing only the `NAV_ITEMS` / `NAV_TRAILING_ITEMS` entries whose `roles` explicitly include `'billing'`. This shows Cash Desk, and also fixes SP2's Tariffs link being unreachable for billing. Entries without `roles` (e.g. Home) stay hidden for billing.
- Modify: `tests/pages/page-gates-harness.ts`, `tests/components/LeftNav.test.tsx`
- Test: `tests/components/billing/CashDeskPanel.test.tsx`, `tests/pages/cash-desk.test.tsx`, `tests/components/billing/RuleConfigTable.test.tsx`

**Interfaces:**
- Consumes: Task 12 (`findPatientForCashDesk`, `getPatientLedger`, `getReceipt`), Task 6 (`getBillingSettings`, `listRuleRows`), Task 3 schemas, `PAYMENT_MODES`, `listPayers`, `listServices({ category: 'room_rent' })`.
- `/cash-desk` (`CASH_DESK_ROLES`, searchParams `q`, `patientId`):
  - a search form; results link to `?patientId=`
  - with a patient: header (name, UHID, active admission), `LedgerTable` (date IST, document number, kind, debit/credit, running balance, receipt print links), the summary (outstanding, credit, unbilled estimate), the "Legacy charges (before charge capture)" table flagged `Legacy` (links to `/billing/charges/<id>` for `BILLING_ROLES` only), and `CashDeskPanel`
  - Audit: `billing: viewed patient ledger`, patient id.
- `CashDeskPanel({ patientId, admissionId, finalisedInvoices, canRefund })`:
  - Take advance / Take payment: mode, reference (required unless cash, with `paymentReferenceProblem` shown inline), amount in rupees, optional invoice
  - Refund (only when `canRefund`): amount, mode, reference, reason
  - Success shows the receipt number with a link to `/print/receipts/<id>`
- `/print/receipts/[id]` (`CASH_DESK_ROLES`, audited `billing: printed receipt`):
  - title `Advance Receipt` or `Payment Receipt`
  - hospital legal name and GSTIN, receipt number and date, patient name and UHID, mode, reference, amount, received by
- `/billing/rules` (`CHARGE_CAPTURE_ROLES` = `BILLING_ROLES`):
  - `RuleConfigTable`: label, default and effective severity, enabled toggle, severity select. Editable only for configurable rules and only when the role ∈ `BILLING_CONFIG_ROLES`; otherwise read-only text.
  - `BillingSettingsForm`: every `billingSettingsSchema` field, the room-rent service select, read-only for non-admins.
  - A payer flags table (pre-auth, GSTIN, state) editable by admin.
  - Audit: none (configuration, no PHI).

- [ ] **Step 1: Write the failing tests**

```ts
it('frontdesk sees take-payment but no refund form', () => {})
it('a card number in the reference shows the inline message and blocks submit', async () => {})
it('rule table is read-only for billing and editable for admin; non-configurable rules never editable', () => {})
it('billing-only nav shows Cash Desk and Tariffs but not Home', () => {})
// PAGE_GATES: '/cash-desk' ['admin','billing','crc','frontdesk']; '/billing/rules' ['admin','crc','billing']; '/print/receipts/[id]' (params { id: '1' }) ['admin','billing','crc','frontdesk']
```

- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/components/billing/CashDeskPanel.test.tsx tests/pages/cash-desk.test.tsx tests/components/billing/RuleConfigTable.test.tsx tests/components/LeftNav.test.tsx` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify:** same + `npx vitest run tests/pages/nav-role-enforcement.test.tsx tests/lib/no-aadhaar-leak.test.ts tests/lib/no-credential-leak.test.ts` + `npm test -- tests/api/rbac-route-gates.test.ts` + `npx tsc --noEmit` + `npx eslint src/components/billing src/app/print "src/app/(dashboard)/cash-desk" "src/app/(dashboard)/billing"` → PASS.
- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/cash-desk" "src/app/(dashboard)/billing/rules" src/app/print/receipts src/components/billing src/components/LeftNav.tsx tests
git commit -m "feat(sp4): cash desk with ledger and receipts, receipt print, billing rules and settings page"
```

---

## Execution notes

**Model tier per task:**

| Task | Tier | Local DB needed |
|---|---|---|
| 1 Amounts / GST / numbering | standard (rounding and the GSTIN check are the contract) | no |
| 2 Rule engine | standard | no |
| 3 Room-rent census / ledger / schemas | standard (IST census boundary) | no |
| 4 Roles + schema A | standard | **yes** (apply migration A twice; DB schema tests) |
| 5 Schema B + triggers | most capable (trigger semantics, purge setting, bigint round-trip) | **yes** |
| 6 Settings / rules / flags | standard | **yes** (query DB test; harness) |
| 7 Capture queries | most capable (lock order, duplicate race, deposit, override audit, SP6 table detection) | **yes** |
| 8 Charge-line routes | cheap | harness only (`npm test -- tests/api/rbac-route-gates.test.ts`) |
| 9 Room rent | standard | **yes** |
| 10 Numbering + invoice lifecycle | most capable (gapless under concurrency, rollback, FY at IST midnight, trigger-allowed cancel) | **yes** |
| 11 Invoice routes | cheap | harness only |
| 12 Payments / refunds / ledger | most capable (credit check under lock, deletePatient guard) | **yes** |
| 13 Pharmacy integration | standard (rewriting a live transaction) | **yes** |
| 14 Capture page | standard | no |
| 15 Invoice pages + print | standard | no |
| 16 Cash desk / rules page / nav | standard | no |

Order: 1 → 2 → 3, then 4 → 5, then 6 → 7 → 8 → 9, then 10 → 11, then 12 → 13, then 14 → 15 → 16. Tasks 8, 9 and 11 touch the shared harness file, so serialise those edits. Tasks 14–16 all edit `LeftNav.tsx` and `page-gates-harness.ts`, so run them in sequence.

**Rulings made in this plan:**

1. **Invoice numbering is gapless per series and financial year, through a locked counter row.**
   - `document_counters (series, financial_year)` is incremented with `UPDATE … RETURNING` inside the finalising transaction. The row lock serialises concurrent finalisations, and a rollback undoes the increment, so a failed finalise burns no number.
   - Numbers are drawn **only** at finalisation, after every check. Drafts have no number, so abandoned drafts leave no gaps.
   - A cancelled invoice keeps its number, and its credit note gets a number in its own series.
   - Format: `INV/26-27/000123`, likewise `RCT`, `CRN`, `RFD`. This is 16 characters, the GST Rule 46 limit, which is why the year is shortened from the requested `2026-27`.
   - At most 999,999 documents per series per year; beyond that the finalise refuses with a plain message.
   - Advances and receipts share the `RCT` series. Tax invoices and bills of supply share `INV`.
2. **Place of supply.**
   - Default `location_of_service`: health services are supplied where they are performed (IGST Act s.12(4)), so hospital bills are intra-state CGST + SGST whatever the patient's home state.
   - A settings switch `recipient_state` uses the payer's state (its `state_code`, else the GSTIN prefix), then the patient's `state_code`, and falls back to the hospital's. It is inter-state (IGST) when that differs.
   - The split is computed at finalisation from current settings. Capture only shows an estimate.
3. **Legacy charges coexist untouched.**
   - `charges`, its routes, its approval workflow, `insurance_claims` and `mock_payments` are unchanged, and nothing is backfilled or copied.
   - The cash desk lists a patient's legacy charges flagged **Legacy**, outside the SP4 ledger and outstanding, which have their own collections screens.
   - The one bridge is the pharmacy route (Task 13). It writes both a legacy charge and a linked charge line (`legacy_charge_id`), so that charge appears once, as a line.
   - New capture never writes `charges`. `POST /api/charges` keeps working for existing screens.
4. **Who may do what.**
   - admin, crc and billing capture charges and prepare drafts.
   - Only admin and billing override a price, override an overridable blocking rule, finalise, cancel or refund.
   - frontdesk (with admin, billing and crc) takes advances and receipts at the cash desk.
   - Only admin edits billing settings, rule configuration and payer flags. billing sees them read-only, because the department being policed should not switch its own controls off.
5. **Rounding.** GST per line, half-up to the paise, with CGST and SGST each rounded from half the rate. Document totals are sums of line values and are never re-rounded. There is no rupee round-off. Task 1 pins this, including a case where per-invoice rounding would differ.
6. **Pricing context.**
   - The ordering department is the encounter's department, or for an admission the attending doctor's. It is passed to the resolver.
   - For an admission, the current room's category and ward price every line, and each census day's own room prices room rent.
   - Bill-to `payer` uses the patient's primary payer for both pricing and pre-auth.
7. **Room rent is census-based:** one day per IST date the patient was in a bed at midnight, with a minimum of one day, priced by the room held at the end of that day. It is posted on demand and idempotently (a partial unique index), never by a cron.
8. **Cancellation only by credit note.**
   - A finalised invoice is immutable: no app path updates it, and migration-only triggers reject any change except `finalised → cancelled`.
   - Cancelling issues a full-value credit note and frees the charge lines so they can be corrected and re-invoiced.
   - Partial credit notes and discounts are out of scope (see ambiguities).
9. **SP6 wiring by table, not by module.**
   - SP4 reads `service_procedure_codes` through `to_regclass` and raw SQL. Without SP6 every service is unmapped (unconstrained, matching SP6 ruling 15); with SP6 merged the check switches on with no code change and no stub to delete.
   - The pure rule takes the mapped codes as data, so unit tests need no double. The one DB case is `it.skipIf` when the table is absent.
   - SP4 does not call `getEncounterCodingGate`: charges never wait for coding (SP6 ruling 2). SP7 consumes it.
10. **int4 vs bigint.**
    - Unit prices and configured amounts stay int4, capped at ₹1 crore (SP2).
    - Every computed amount, total, payment, refund and sum is `bigint` (`mode: 'number'`), capped at ₹1,000 crore.
    - SQL sums are read through `paiseFromDb`. Tasks 1, 4, 5 and 12 test values past 2^31.
11. **Retention:** a patient with issued bills, receipts or refunds cannot be deleted (409). Tax records are kept for the statutory period.
12. **Emergency admissions** are never blocked for a deposit: the rule downgrades to a warning.
13. **Bill of supply / bill.** A hospital without a GSTIN issues a `Bill`. Taxable lines then refuse to finalise until a GSTIN is set. All-exempt lines give a `Bill of Supply`; any taxable line gives a `Tax Invoice`.

**Ambiguities flagged for the owner:**
- **Tax treatment needs the hospital's CA.**
  - Healthcare services are generally GST-exempt, and SP2 rates carry each service's own GST rate.
  - Room rent above ₹5,000/day (non-ICU) attracting 5% is **not** computed automatically; it needs a separately rated room-rent service.
  - The pharmacy default is 5% under HSN 3004 (post-September-2025 slabs) and is editable.
  - Whether tariff amounts are GST-exclusive (as built) or inclusive must be confirmed.
- **Discounts, concessions, package-inclusion netting and partial credit notes** are not built. Correcting a bill means cancelling it and re-invoicing.
- **Advances are pooled per patient** (not allocated invoice by invoice). The deposit check uses the admission's advances net of refunds.
- **The pre-auth reference is stored per charge line.** SP7 should move it to the admission or claim when it builds the pre-auth lifecycle.
- **Payer GSTIN and state** are added to `payers` as nullable fields. SP7's insurer/TPA master may supersede them.
- **The requested number format `INV/2026-27/000123`** was shortened to `INV/26-27/000123` to stay within GST's 16-character limit.
- **Pre-existing:** the billing-only nav hid every non-billing link, including SP2's Tariffs. Task 16 shows billing-role entries that name `billing` explicitly.
