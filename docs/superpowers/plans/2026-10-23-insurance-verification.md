# Insurance Verification and Pre-authorisation (WS12) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cashless insurance works end to end: saved eligibility results with who/when/source/limits, manual verification for insurers off NHCX, validity and verification checked at policy add, OPD check-in, IPD admission and pre-auth, sub-limits in charge rules and the estimate, an ABHA identity guard, and pre-auths that explain and fix frozen snapshots. All of it runs in the labelled mock and says "Not configured" otherwise.

**Architecture:** One append-only `coverage_verifications` table fed by the NHCX callback and by a manual-verification route; one pure evaluator (`evaluateCoverage`) that every surface asks; `admission_coverage` written through a hook in the existing check-in transaction; a pure identity comparison behind the ABHA link and Scan & Share resolve; a `refresh_snapshot` pre-auth action that appends a new event. Every new route follows the repo pattern: `requireSession`, inline role allowlist (a `role-policy.ts` constant checked at the top), strict Zod body, audit entry, rows in the RBAC harnesses.

**Tech Stack:** Next.js 16 (App Router; read `node_modules/next/dist/docs/` before touching routing, layouts or caching: Task 11 adds a route-segment layout and Tasks 4/7 rely on `router.refresh()`), TypeScript, Drizzle + Postgres, Vitest, Zod 4, the existing NHCX/ABDM mock adapters (`ABDM_USE_MOCKS=1`), the Foundations blob driver (`putPrivateBlob`, `streamPrivateBlob`).

**Spec:** `docs/superpowers/specs/2026-10-23-insurance-verification-design.md` (rulings R1–R15 are referenced below). Findings: `docs/superpowers/plans/2026-10-23-gap-closure-plan.md` K3, K5–K8, K10, L1–L4, L7–L9, I6, I7.

## Streams (parallel worktrees)

Task 1 is the **prerequisite**: merge it to `feat/hospital-completion` first. Then each stream runs in its own worktree branched from that merge, tasks in order within the stream. Task 12 runs last, after every stream has merged.

| Stream | Tasks | Theme | Depends on |
|---|---|---|---|
| 0 | T1 | Schema, evaluator, summary query, roles | Foundations (merged) |
| A | T2 → T3 → T4 | Saved NHCX results, manual verification, header/Insurance tab/policy add | T1 |
| B | T5 → T6 | ABHA identity guard, simulate share | none (may start before T1 merges) |
| C | T7 → T8 | Pre-auth snapshot refresh and NHCX state; pre-auth defaults, messages, coverage gate | T1 |
| D | T9 | OPD check-in badge and IPD admission insurance | T1 |
| E | T10 | Sub-limits in the charge rules | T1 |
| F | T11 | RCM settings confirmation, missing-ID notice, dashboard tiles | T1 |
| — | T12 | Docs and walkthrough | all |

**Shared files and how each task touches them** (keeps the streams mergeable):
- `src/db/schema.ts`: T1 appends a `// WS12 T1` … `// end WS12 T1` block at the end of the file and adds one column in place inside `patientPolicies` (commented `// WS12 T1`). T5 appends a `// WS12 T5` block. T7 edits the `preauthActionEnum` array in place (one value appended, commented `// WS12 T7`). Nobody else edits schema.ts.
- Migrations (unique names): T1 `scripts/migrations/2026-10-24-ws12-coverage.sql`; T5 `scripts/migrations/2026-10-24-ws12-abha-link-overrides.sql`; T7 `scripts/migrations/2026-10-24-ws12-preauth-refresh-enum.sql`.
- `src/lib/role-policy.ts`: T1 only (all WS12 constants in one `// WS12` block at the end).
- `src/lib/rcm/errors.ts`: T1 only (two errors appended to `RCM_ERRORS`).
- `tests/api/rbac-route-gates.test.ts`: T2, T3, T6, T9 append rows **at the end** of `API_GATES` and (JSON write routes) at the end of `SP8_WRITE_GATES`, each inside `// WS12 Tn` … `// end WS12 Tn`. Imports go at the end of the import list under the same comment. `tests/pages/page-gates-harness.ts`: no new pages; no rows (T11 adds a layout, not a page, and does not change any page gate).
- `src/app/(dashboard)/patients/[anonId]/page.tsx`: T4 only. `src/components/CheckInModal.tsx` and `src/app/api/front-desk/check-in/route.ts`: T9 only. `src/lib/queries/preauths.ts`, `PreauthForm.tsx`, `EstimateTable.tsx`, pre-auth pages: stream C only. `src/lib/billing/charge-rules.ts`, `src/lib/queries/charge-capture.ts`: T10 only. `src/lib/nhcx/inbound.ts`, `src/lib/fhir/nhcx/eligibility.ts`: T2 only. `src/lib/nhcx/constants.ts`: T1 (`ELIGIBILITY_CONTEXTS`) and T2 (`NhcxResponseSummary`), different hunks, same stream order.

## Global Constraints

- Tests run **only** against the isolated database: `source $SCRATCH/testenv.sh` (DB `hims_test`) then `npx vitest run <paths>`. Never `npm test` (it loads `.env.local`), never `.env.local`, never the demo DB `hims`, never a cloud DB. `tests/db/seed.test.ts` truncates its database.
- No committed secrets: never commit `.env*` values, keys, `data/`, or generated files.
- Never log or return a secret, a provider error body, an NHCX/ABDM payload, a file path, or a blob URL. Log error class names only. Audit details carry ids, enum values and paise only: never a patient name, ABHA number, insurer reference, override reason or document URL.
- Money is integer paise (`bigint` mode number; `copay` in basis points); time is IST (`todayIsoIn`, `istDateOf`, `formatIstDate` from `src/lib/india-time.ts`); ids shown to users are UHID, never chart ids.
- Schema changes: edit `src/db/schema.ts` (per the shared-file rules above) and add a re-runnable, checksummed `BEGIN; … COMMIT;` migration `scripts/migrations/2026-10-24-ws12-<topic>.sql` (`CREATE … IF NOT EXISTS`, `DO $$ … $$` guards for constraints and triggers). Never edit an applied migration. Never `db:push`. Apply to the test DB with the migrate runner and confirm `db:schema-diff` (pointed at the test DB, never `.env.local`) reports no drift.
- Every new route: `requireSession()` first; the role allowlist checked inline before reading the body (deny before parse); a `.strict()` Zod schema; an audit entry for every write and every read of PHI; rows in `tests/api/rbac-route-gates.test.ts` (and `tests/pages/page-gates-harness.ts` if a page gate changes).
- Mock honesty: anything produced by the NHCX or ABDM mock carries `is_mock`/`source = 'nhcx_mock'` and shows "Sandbox mock - not real". With NHCX/ABDM unconfigured, surfaces say "Not configured" and never fabricate a result.
- Each task ends with its tests passing, `npx tsc --noEmit` clean, `npx eslint` clean on touched files, and one commit on the stream's branch (merged to `feat/hospital-completion` by the controller).

## Review Focus

- An expired policy (valid-to yesterday IST) at a **cashless** IPD admission: 409 `coverage_blocked`, no room claimed, no admission row; the same patient as **emergency**: admitted with a warning; at OPD check-in: checked in with a warning, never blocked.
- The NHCX mock callback for a check run twice: exactly one `coverage_verifications` row per check (`nhcx_check_id` unique), and no row at all for a check that errored before an answer.
- Manual verification upload with no storage driver: 503 `storage_not_configured`, no verification row; the stored blob URL never appears in any JSON response or log line.
- ABHA link where the ABDM profile name differs from the chart: 409 `identity_mismatch` without a reason; with a reason the link commits, `abha_link_overrides` has the reason, and the audit row has field names only.
- `refresh_snapshot` after the latest snapshot was accepted by NHCX: refused, no new event; after a `send_failed` exchange: allowed, and the next send uses the new snapshot's payer code.
- `POST /api/abdm/shares/simulate` with mocks off (production-like env): 404, nothing written.
- Charge capture with a room-rent line above the policy limit: a `warn` violation, the line still saves; a disabled rule config suppresses it.

---

### Task 1: Coverage schema, evaluator, summary query and roles (prerequisite)

**Files:**
- Create: `scripts/migrations/2026-10-24-ws12-coverage.sql`, `src/lib/insurance/coverage.ts`, `src/lib/insurance/estimate-split.ts`, `src/lib/queries/coverage.ts`
- Modify: `src/db/schema.ts` (append `// WS12 T1` block: `coverageVerifications`, `admissionCoverage`, row types; add `icuLimitPaise` to `patientPolicies` in place), `src/lib/nhcx/constants.ts` (`ELIGIBILITY_CONTEXTS` gains `'checkin'`), `src/lib/role-policy.ts` (WS12 block), `src/lib/rcm/errors.ts` (append `policy_not_in_force` 422, `coverage_inactive` 409 with messages), `src/lib/queries/rcm-policies.ts` (`PolicyView.icuLimitPaise`), `src/lib/rcm/validation.ts` (`policySchema` accepts optional `icuLimitPaise`), `src/components/rcm/PolicyForm.tsx` (ICU limit field), `tests/db/sp8-schema.test.ts` (context list)
- Test: `tests/lib/insurance/coverage.test.ts`, `tests/lib/insurance/estimate-split.test.ts`, `tests/lib/queries/coverage.test.ts`, `tests/db/ws12-coverage-schema.test.ts`

**Interfaces:**
- Produces (`src/lib/insurance/coverage.ts`, pure, client-safe):
  ```ts
  export const COVERAGE_FRESH_HOURS = 24
  export const MANUAL_VERIFICATION_MAX_DAYS = 30
  export const MANUAL_VERIFICATION_DEFAULT_DAYS = 7
  export const ICU_ROOM_CATEGORY_CODES = ['ICU', 'HDU', 'NICU', 'PICU', 'CCU'] as const
  export const VERIFICATION_SOURCES = ['nhcx', 'nhcx_mock', 'manual'] as const
  export const VERIFICATION_RESULTS = ['active', 'inactive', 'error'] as const
  export const VERIFICATION_METHODS = ['insurer_portal', 'tpa_portal', 'phone', 'email', 'letter'] as const
  export const VERIFICATION_CONTEXTS = ['registration', 'checkin', 'admission', 'preauth', 'manual'] as const
  export type CoverageContext = 'view' | 'registration' | 'opd_checkin' | 'ipd_admission' | 'preauth'
  export type CoverageState = 'no_policy' | 'policy_inactive' | 'policy_not_started' | 'policy_expired'
    | 'verified_active' | 'verified_inactive' | 'verification_error' | 'pending' | 'stale' | 'unverified'
  export interface CoverageLimits { sumInsuredPaise: number | null; balancePaise: number | null; copayBp: number | null; roomRentLimitPaise: number | null; icuLimitPaise: number | null }
  export interface CoveragePolicyFacts { id: number; status: 'active' | 'inactive'; validFrom: string; validTo: string; insurerName: string; onNhcx: boolean; limits: CoverageLimits }
  export interface CoverageVerificationFacts { id: number; source: (typeof VERIFICATION_SOURCES)[number]; result: (typeof VERIFICATION_RESULTS)[number]; verifiedAt: Date; validUntil: Date; verifiedByName: string; method: string | null; insurerReference: string | null; limits: CoverageLimits }
  export interface CoverageVerdict { state: CoverageState; severity: 'ok' | 'info' | 'warn' | 'block'; label: string; detail: string | null; verifiedHoursAgo: number | null; isMock: boolean; policyId: number | null; verificationId: number | null }
  export function evaluateCoverage(i: { policy: CoveragePolicyFacts | null; verification: CoverageVerificationFacts | null; pendingCheck: boolean; context: CoverageContext; now: Date; emergency?: boolean; onDate?: string }): CoverageVerdict
  export function effectiveLimits(policy: CoverageLimits, verification: CoverageLimits | null): CoverageLimits
  export function manualValidUntilBounds(todayIso: string, policyValidTo: string): { defaultIso: string; maxIso: string }
  export function hoursAgoLabel(hours: number): string   // 'less than an hour ago' | '1 hour ago' | 'N hours ago' | 'N days ago' (≥ 48 h)
  ```
  Severity per R4: `opd_checkin`/`registration`/`view` never `block`; `ipd_admission` blocks `policy_expired|policy_not_started|policy_inactive|verified_inactive` unless `emergency`; `preauth` blocks the same three policy states (checked against `onDate`, default today) and `verified_inactive`. `verified_active` label: `Policy valid, verified <hoursAgoLabel>`; `stale`: current verification expired; `unverified`: none ever; `pending`: an NHCX check awaiting answer and no current verification.
- Produces (`src/lib/insurance/estimate-split.ts`, pure): `applyCoverageToEstimate(i: { lines: { amountPaise: number; category: string | null; unitPricePaise: number; quantity: number }[]; limits: CoverageLimits; roomCategoryCode: string | null; lengthOfStayDays: number }): { totalPaise: number; insurerPaise: number; patientPaise: number; warnings: string[] }` (room-rent/ICU excess per day × quantity to patient; then co-pay % of the remainder; then any excess over `balancePaise` (or `sumInsuredPaise`) to patient; warnings in plain English with `formatPaise` amounts; label "Indicative").
- Produces (`src/lib/queries/coverage.ts`):
  ```ts
  export interface PolicyCoverage { policyId: number; verdict: CoverageVerdict; current: CoverageVerificationFacts | null; history: CoverageVerificationFacts[]; pendingCheckId: number | null; limits: CoverageLimits }
  export interface CoverageSummary { primary: PolicyCoverage | null; policies: PolicyCoverage[] }
  export async function getCoverageSummary(patientId: string, context: CoverageContext, now?: Date, executor?: WriteExecutor): Promise<CoverageSummary>
  export async function currentVerification(executor: WriteExecutor, policyId: number, now: Date): Promise<CoverageVerificationFacts | null>
  ```
  History is the last 5 rows by `verified_at DESC`; `pendingCheckId` = latest `nhcx_eligibility_checks` row with status `pending` newer than the latest verification; `onNhcx` from `payer_profiles.nhcx_participant_code` (TPA first, then insurer, as `payersOnNhcx`).
- Produces (`role-policy.ts`): `COVERAGE_READ_ROLES = POLICY_READ_ROLES`, `COVERAGE_VERIFY_ROLES = POLICY_WRITE_ROLES`, `ADMISSION_COVERAGE_ROLES: readonly Role[] = ['admin', 'frontdesk', 'crc', 'rcm']`.
- Schema: tables and checks exactly as spec §4 (`coverage_verifications`, `admission_coverage`, `patient_policies.icu_limit_paise`, `nhcx_eligibility_checks_context_valid` re-created with `checkin`). Migration installs trigger `ws12_coverage_verifications_append_only` (raises 55000 on UPDATE/DELETE unless `current_setting('hims.allow_document_purge', true) = 'on'`, same function shape as the SP7 `sp7_append_only`).

- [ ] **Step 1: Write failing tests.** `coverage.test.ts`: (a) `evaluateCoverage({policy: null…})` → `no_policy`, severity `info` for `view`, `warn` for `ipd_admission`; (b) policy `validTo` yesterday → `policy_expired`, `block` for `ipd_admission`, `warn` for `opd_checkin`, `warn` for `ipd_admission` with `emergency: true`; (c) `validFrom` tomorrow → `policy_not_started`; (d) verification `active` 3 h old with `validUntil` in future → `verified_active`, label `Policy valid, verified 3 hours ago`, `verifiedHoursAgo` 3; (e) `validUntil` passed → `stale`, `warn` at admission; (f) current `inactive` → `verified_inactive`, `block` for `preauth`; (g) `nhcx_mock` source → `isMock: true`; (h) `pendingCheck` with no current → `pending`; (i) `preauth` with `onDate` after `validTo` → `policy_expired` `block`; (j) `effectiveLimits` prefers verification values and falls back per field; (k) `manualValidUntilBounds('2026-10-24','2026-10-27')` → default and max both `2026-10-27`. `estimate-split.test.ts`: room rent ₹5,000/day × 3 with limit ₹3,000 → patient ₹6,000 + co-pay share; co-pay 10% on ₹1,00,000 → patient ₹10,000; balance ₹50,000 against ₹80,000 → patient gets the ₹30,000 excess; ICU code `ICU` uses `icuLimitPaise`; all integers. `ws12-coverage-schema.test.ts` (DB): manual row without `method` refused (check violation); document triple partial refused; UPDATE on a row raises 55000; `valid_until <= verified_at` refused; `admission_coverage` self_pay with a policy refused; `nhcx_eligibility_checks` accepts context `checkin`. `queries/coverage.test.ts` (DB, use `tests/lib/queries/preauth-world.ts` style fixtures): `getCoverageSummary` returns the primary policy with the newest current verification, history ≤ 5, and `pendingCheckId` for a newer pending check.
- [ ] **Step 2: Run** `source $SCRATCH/testenv.sh && npx vitest run tests/lib/insurance tests/lib/queries/coverage.test.ts tests/db/ws12-coverage-schema.test.ts` → FAIL (modules and tables missing).
- [ ] **Step 3: Implement** the migration, schema block, constants, evaluator, split, query, roles, errors and the ICU field (policy form, schema, `createPolicy`/`updatePolicy` pass-through). Apply the migration to `hims_test` with the migrate runner; run `db:schema-diff` against the test DB.
- [ ] **Step 4: Run** the Step 2 command plus `npx vitest run tests/db/sp8-schema.test.ts tests/lib/queries/rcm-policies.test.ts tests/components/rcm/PolicyForm.test.tsx` → PASS.
- [ ] **Step 5: Commit** `feat(insurance): coverage verification schema, evaluator and summary (WS12 T1)`.

### Task 2: Save every NHCX eligibility result with its limits (stream A)

**Files:**
- Modify: `src/lib/nhcx/constants.ts` (`NhcxResponseSummary` gains optional `coverage?: { sumInsuredPaise; balancePaise; copayBp; roomRentLimitPaise; icuLimitPaise; benefitPeriodEnd: string | null } | null`), `src/lib/fhir/nhcx/eligibility.ts` (`parseEligibilityResponse` reads limits per R6; `emptySummary()` sets `coverage: null`; returns `insurerReference: string | null` from `CoverageEligibilityResponse.identifier[0].value`, clipped to 64), `src/lib/nhcx/inbound.ts` (in the `coverageeligibility/on_check` branch call `recordNhcxVerificationTx`; `synthesizeMockResponse` answers with fixed labelled limits: sum insured ₹5,00,000, used ₹50,000, co-pay 10%, room rent ₹4,000/day, ICU ₹8,000/day, `benefitPeriod.end` = policy valid-to), `src/lib/queries/coverage.ts` (add `recordNhcxVerificationTx`), `src/components/nhcx/EligibilityCheckPanel.tsx` (on a final status call `router.refresh()`; show the saved limits line), `docs/ABDM-NHCX.md` (U20 entry for the item/category codes), `tests/api/rbac-route-gates.test.ts`
- Create: `src/app/api/patients/[anonId]/coverage/route.ts`
- Test: extend `tests/lib/fhir/nhcx/eligibility.test.ts`, `tests/api/nhcx-callback.test.ts`; create `tests/api/patient-coverage.test.ts`; extend `tests/components/nhcx/EligibilityCheckPanel.test.tsx`

**Interfaces:**
- Consumes: `getCoverageSummary`, `evaluateCoverage`, `COVERAGE_FRESH_HOURS`, `COVERAGE_READ_ROLES` (T1).
- Produces: `recordNhcxVerificationTx(tx: WriteExecutor, i: { checkId: number; summary: NhcxResponseSummary; insurerReference: string | null; status: EligibilityStatus; isMock: boolean; now: Date }): Promise<number | null>` (returns the new row id; `null` when the status is `error`/`no_response`, which write no row; `ON CONFLICT (nhcx_check_id) DO NOTHING`; `verified_by_name` = the check's `requested_by_name`, `context` = the check's context, `result` `active`/`inactive`, `valid_until = now + 24 h`).
- Produces: `GET /api/patients/[anonId]/coverage?context=view|opd_checkin|ipd_admission` → `200 CoverageSummary` (dates as ISO strings; no blob URL, no `nhcx_check_id`), `404` unknown patient, `400` bad context. Roles `COVERAGE_READ_ROLES`. Audit `insurance: viewed coverage` with `context=<ctx>`.

- [ ] **Step 1: Write failing tests**: parser reads sum insured, balance (allowed − used), co-pay bp, room-rent and ICU per-day limits and benefit period end from a fixture; a bundle without them gives `coverage: null`; the mock callback for a check writes one `coverage_verifications` row with `source 'nhcx_mock'`, the fixed limits and `valid_until` 24 h later; replaying the same callback writes no second row; an `error` answer writes none; the coverage route returns the verdict `verified_active` with label `Policy valid, verified less than an hour ago`, is role-gated, and never contains `blob` or `http` substrings; the panel calls `router.refresh` when the poll ends.
- [ ] **Step 2: Run** `source $SCRATCH/testenv.sh && npx vitest run tests/lib/fhir/nhcx/eligibility.test.ts tests/api/nhcx-callback.test.ts tests/api/patient-coverage.test.ts tests/components/nhcx` → FAIL.
- [ ] **Step 3: Implement.** Append the route to `API_GATES` (`GET /api/patients/[anonId]/coverage`, allowed `COVERAGE_READ_ROLES`) inside `// WS12 T2`.
- [ ] **Step 4: Run** the Step 2 command plus `npx vitest run tests/api/rbac-route-gates.test.ts tests/lib/nhcx tests/lib/queries/nhcx-eligibility.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(nhcx): save eligibility results with limits and expose patient coverage (WS12 T2)`.

### Task 3: Manual verification record with document upload (stream A)

**Files:**
- Create: `src/app/api/rcm/policies/[id]/verifications/route.ts` (POST multipart), `src/app/api/rcm/verification-documents/[id]/route.ts` (GET stream), `src/components/insurance/ManualVerificationDialog.tsx`, `src/lib/insurance/validation.ts`
- Modify: `src/lib/queries/coverage.ts` (`recordManualVerification`, `getVerificationDocumentBlob`), `tests/api/rbac-route-gates.test.ts`
- Test: `tests/api/coverage-manual-verification.test.ts`, `tests/components/insurance/ManualVerificationDialog.test.tsx`, `tests/lib/insurance/validation.test.ts`

**Interfaces:**
- Consumes: `COVERAGE_VERIFY_ROLES`, `COVERAGE_READ_ROLES`, `manualValidUntilBounds` (T1); `readUpload`, `parseId`, `rcmErrorResponse` (`src/lib/rcm/route-responses.ts`); `putPrivateBlob`, `streamPrivateBlob` (`src/lib/blob-store.ts`); `serviceUnavailableBody` (`src/lib/http/service-message.ts`, Foundations T6).
- Produces: `manualVerificationSchema = z.object({ result: z.enum(['active', 'inactive']), method: z.enum(VERIFICATION_METHODS), reference: z.string().trim().min(3).max(64), verifiedOn: isoDate, validUntil: isoDate, sumInsuredPaise, balancePaise, copayBp, roomRentLimitPaise, icuLimitPaise (all optional, integer, ranges as the table), note: z.string().trim().max(500).optional() }).strict()` over the multipart text fields (numbers parsed from strings by `z.coerce` inside the schema), with refinements `verifiedOn ≤ today`, `validUntil ≥ today`, `validUntil ≤ manualValidUntilBounds().maxIso`.
- Produces: `recordManualVerification(policyId: number, input: ManualVerificationInput, file: { bytes: Uint8Array; contentType: string } | null, session: Session, now?: Date): Promise<RcmWriteResult<{ verificationId: number }>>` (file optional; PDF/JPEG/PNG ≤ 4 MB via the existing `readUpload` limits; blob path `insurance/verifications/<policyId>/<uuid>.<ext>`; blob put before the transaction; `valid_until` = end of `validUntil` IST day; audit `insurance: recorded manual verification` with `policy=<id> verification=<id> result=<r> method=<m> document=<yes|no>`).
- Produces: `POST /api/rcm/policies/[id]/verifications` → `201 { verificationId }`; `404` policy; `422` validation; `503 storage_not_configured` when a file is sent and no driver exists (no row written). `GET /api/rcm/verification-documents/[id]` → streamed file (inline, filename `verification-<id>.<ext>`), audit `insurance: viewed verification document`; roles `COVERAGE_READ_ROLES`.
- Produces: `<ManualVerificationDialog policyId insurerName policyValidTo todayIso onSaved />` showing the "Do not upload national ID cards here." warning (reuse `CARD_UPLOAD_WARNING` from `PolicyCardUpload.tsx`).

- [ ] **Step 1: Write failing tests**: a manual `active` verification with a PDF writes one row with `source 'manual'`, the document triple, and `valid_until` at the chosen day's end IST; without `method` → 400/422 with a field message; `validUntil` beyond 30 days or beyond the policy valid-to → refused; with a file and `getBlobDriver()` null → 503 `storage_not_configured` and no row; the JSON response and audit details never include the blob URL or the reference text; the document route streams the bytes for a read role and 403s `pi`; the dialog shows the national-ID warning and disables Save until method, reference and dates are filled, naming what is missing.
- [ ] **Step 2: Run** `source $SCRATCH/testenv.sh && npx vitest run tests/api/coverage-manual-verification.test.ts tests/components/insurance tests/lib/insurance/validation.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Append both routes to `API_GATES` inside `// WS12 T3` (`POST /api/rcm/policies/[id]/verifications` allowed `COVERAGE_VERIFY_ROLES`; `GET /api/rcm/verification-documents/[id]` allowed `COVERAGE_READ_ROLES`). The POST reads multipart, so it gets no `SP8_WRITE_GATES` row; its test asserts a denied role gets 403 before `readUpload` is called.
- [ ] **Step 4: Run** the Step 2 command plus `npx vitest run tests/api/rbac-route-gates.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(insurance): manual verification with document upload and expiry (WS12 T3)`.

### Task 4: Coverage on the patient header, Insurance tab and policy add (stream A)

**Files:**
- Create: `src/components/insurance/CoverageBadge.tsx`, `src/components/insurance/VerificationHistory.tsx`
- Modify: `src/app/(dashboard)/patients/[anonId]/page.tsx` (header badge for `COVERAGE_READ_ROLES`; pass `coverage` to the Insurance tab), `src/components/rcm/PatientPoliciesPanel.tsx` (per policy: verdict badge, current verification with who/when/source/method/reference/limits/until, history, "Record manual verification" opening the T3 dialog; when the payer is not on NHCX or NHCX is not configured, the manual button is the primary action with the text "This insurer is not on NHCX: confirm cover with the insurer or TPA, then record it here"), `src/lib/queries/rcm-policies.ts` (`createPolicy` refuses `status 'active'` with `validTo < today IST` → `policy_not_in_force`), `src/app/api/rcm/policies/route.ts` (after a successful create call `maybeStartEligibility`; response gains `eligibility`), `src/lib/queries/coverage.ts` (add `maybeStartEligibility`, `defaultEligibilityProviderId`), `src/components/rcm/PolicyForm.tsx` (show the returned eligibility message)
- Test: `tests/components/insurance/CoverageBadge.test.tsx`, `tests/components/rcm/PatientPoliciesPanel.test.tsx`, extend `tests/api/rcm-policies.test.ts`, `tests/lib/queries/coverage.test.ts`

**Interfaces:**
- Consumes: `CoverageVerdict`, `getCoverageSummary` (T1); `ManualVerificationDialog` (T3); `requestEligibility`, `nhcxEligibilityAvailable` (`src/lib/queries/nhcx-eligibility.ts`).
- Produces: `CoverageBadge({ verdict }: { verdict: CoverageVerdict })` (colour by severity; text = `verdict.label`; adds "Sandbox mock - not real" when `isMock`; `role="status"`).
- Produces: `maybeStartEligibility(i: { policyId: number; context: EligibilityContext; providerId: number | null; purpose?: EligibilityPurpose }, session: Session, now?: Date): Promise<{ started: true; checkId: number } | { started: false; reason: 'nhcx_not_configured' | 'not_on_nhcx' | 'already_verified' | 'no_doctor' | 'not_ready'; message: string }>` (never throws for business reasons; `not_ready` carries the `requestEligibility` message such as the missing ROHINI/HFR text). `defaultEligibilityProviderId(patientId: string): Promise<number | null>` = provider of the latest non-cancelled encounter.
- Produces: `POST /api/rcm/policies` response `201 { policyId, eligibility: { started: boolean; checkId?: number; message?: string } }` (existing fields unchanged).

- [ ] **Step 1: Write failing tests**: header shows `Policy valid, verified 2 hours ago` for a patient with a current mock verification and the mock label; shows `Policy expired on 22 Oct 2026` (red) for an expired policy; front desk sees the badge, `pi` (not in `COVERAGE_READ_ROLES`) does not; Insurance tab lists who/when/source/reference and the limits, and history newest first; a payer off NHCX shows the manual button as primary; creating an already-expired active policy → 422 `policy_not_in_force` with the dates in the message; creating a valid policy in mock mode for a patient with an encounter starts a check (`eligibility.started: true`, one `nhcx_eligibility_checks` row with context `registration`); without an encounter → `started: false`, `reason 'no_doctor'`; with NHCX unconfigured → `nhcx_not_configured` and the create still succeeds.
- [ ] **Step 2: Run** `source $SCRATCH/testenv.sh && npx vitest run tests/components/insurance tests/components/rcm/PatientPoliciesPanel.test.tsx tests/api/rcm-policies.test.ts tests/lib/queries/coverage.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Keep the page edit to the header block and the `policiesTab` block (Task 5's ABHA work does not touch this page).
- [ ] **Step 4: Run** the Step 2 command plus `npx vitest run tests/pages` → PASS.
- [ ] **Step 5: Commit** `feat(insurance): coverage badge, verification history and checks at policy add (WS12 T4)`.

### Task 5: ABHA identity guard on link and Scan & Share (stream B)

**Files:**
- Create: `src/lib/abdm/identity-match.ts`, `scripts/migrations/2026-10-24-ws12-abha-link-overrides.sql`
- Modify: `src/db/schema.ts` (append `// WS12 T5` block: `abhaLinkOverrides`), `src/lib/abdm/flow-store.ts` (`AbhaFlow.verified.profile?: AbhaIdentityProfile`), `src/app/api/abdm/abha/enrol/verify/route.ts`, `src/app/api/abdm/abha/login/verify/route.ts`, `src/app/api/abdm/abha/login/account/route.ts` (store the profile in the flow; when `flow.patientId` is set, add `comparison` to the response), `src/lib/validation/abha-flow.ts` (`linkSchema` gains `mismatchReason`), `src/app/api/patients/[anonId]/abha/link/route.ts`, `src/lib/queries/abha-link.ts` (`applyVerifiedAbha` and `applyVerifiedAbhaTx` accept `override`), `src/lib/queries/abdm-profile-shares.ts` (`resolveShare('linked')` compares and accepts `mismatchReason`), `src/app/api/abdm/shares/[id]/route.ts` (`resolveSchema` gains `mismatchReason`; maps `identity_mismatch`), `src/components/abdm/AbhaVerifyDialog.tsx`, `src/components/abdm/ProfileShareQueue.tsx`
- Test: `tests/lib/abdm/identity-match.test.ts`, extend `tests/lib/queries/abha-link.test.ts`, `tests/api/abdm-abha.test.ts`, `tests/components/abdm/AbhaVerifyDialog.test.tsx`; create `tests/api/abdm-share-resolve-identity.test.ts`

**Interfaces:**
- Produces (pure, client-safe):
  ```ts
  export type IdentityField = 'name' | 'dob' | 'gender'
  export interface AbhaIdentityProfile { name: string | null; gender: string | null; yearOfBirth: number | null; monthOfBirth: number | null; dayOfBirth: number | null }
  export interface IdentityComparison { fields: { field: IdentityField; result: 'match' | 'mismatch' | 'unavailable'; chart: string | null; abdm: string | null }[]; mismatch: boolean; mismatchedFields: IdentityField[] }
  export function normaliseIndianName(name: string): string[]
  export function compareAbhaIdentity(chart: { name: string; dob: string | null; gender: string | null }, profile: AbhaIdentityProfile | null): IdentityComparison
  export const IDENTITY_MISMATCH_MESSAGE = 'The ABHA profile does not match this patient. Check the details, or give a reason to link anyway.'
  ```
  (R9 rules; `profile === null` → name `mismatch`, others `unavailable`.) The `chart`/`abdm` display strings reach the browser only in the dialog of the staff member who ran the flow, never in logs or audit.
- Produces: `linkSchema = z.object({ flowId, mismatchReason: z.string().trim().min(10).max(300).optional() }).strict()`; link route → `409 { error: IDENTITY_MISMATCH_MESSAGE, code: 'identity_mismatch', fields: IdentityField[] }` when mismatched without a reason; with a reason, `applyVerifiedAbha(patientId, flow, session, { override: { fields, reason } })` inserts `abha_link_overrides` in the same transaction and audits `abdm: linked ABHA despite identity mismatch` with `fields=name,dob`.
- Produces: `resolveShare(shareId, { action, patientId, mismatchReason? }, session)` returns the new error `'identity_mismatch'` (with `fields`) for a `linked` action that mismatches without a reason. `ResolveShareError` gains `'identity_mismatch'`.
- Schema: `abha_link_overrides` per spec §4, append-only trigger `ws12_abha_link_overrides_append_only`.

- [ ] **Step 1: Write failing tests**: `normaliseIndianName('Smt. FATHIMA  Beevi')` → `['fathima', 'beevi']`; `compareAbhaIdentity` gives `match` for reordered tokens, `match` for `'R. Kumar'` vs `'Ravi Kumar'`, `mismatch` for `'Sandbox Mock Patient'` vs `'Fathima Beevi'`, `mismatch` for gender `F` vs `male`, `unavailable` for null year of birth or chart gender `unknown`, `mismatch` for year 1980 vs DOB `1979-05-02`; the mock ABHA link to a differently named chart → 409 `identity_mismatch` with `fields ['name']` and no patient update; the same with a 12-character reason → 200, `abha_link_overrides` has the reason, the audit details are `fields=name` with no name text; a matching profile links without a reason; a share `linked` to a mismatched patient → 409 and the share stays `pending`; the dialog shows a side-by-side table with mismatched rows highlighted, requires the reason textbox before "Link anyway", and keeps "Link to this patient" for a full match.
- [ ] **Step 2: Run** `source $SCRATCH/testenv.sh && npx vitest run tests/lib/abdm/identity-match.test.ts tests/lib/queries/abha-link.test.ts tests/api/abdm-abha.test.ts tests/api/abdm-share-resolve-identity.test.ts tests/components/abdm` → FAIL.
- [ ] **Step 3: Implement** (migration applied to `hims_test`; schema-diff clean).
- [ ] **Step 4: Run** the Step 2 command plus `npx vitest run tests/lib/abdm tests/api/abdm-share-callback.test.ts tests/api/rbac-route-gates.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(abdm): compare name, DOB and gender before linking an ABHA; override reason on mismatch (WS12 T5)`.

### Task 6: Simulate an ABHA Scan & Share in mock mode (stream B)

**Files:**
- Create: `src/app/api/abdm/shares/simulate/route.ts`, `src/components/abdm/SimulateShareButton.tsx`
- Modify: `src/lib/abdm/mock-adapter.ts` (export `fabricatedAbhaNumber(seed: string): string`, the existing `fabricatedAbha`), `src/app/(dashboard)/front-desk/abdm-shares/page.tsx` (render the button only when `scanShareSetup().state === 'mock'`), `tests/api/rbac-route-gates.test.ts`
- Test: `tests/api/abdm-share-simulate.test.ts`, `tests/components/abdm/SimulateShareButton.test.tsx`

**Interfaces:**
- Consumes: `recordProfileShare`, `scanShareSetup` (`src/lib/queries/abdm-profile-shares.ts`), `readAbdmConfig` (`src/lib/integrations/config.ts`), `ABDM_SHARE_QUEUE_ROLES`.
- Produces: `POST /api/abdm/shares/simulate` body `z.object({ counterId: z.string().regex(/^[A-Za-z0-9_-]{1,20}$/).default('DESK-1'), likePatientId: z.string().trim().min(1).max(40).optional(), name: z.string().trim().min(2).max(80).optional(), gender: z.enum(['M', 'F', 'O']).optional(), yearOfBirth: z.number().int().min(1900).max(2100).optional() }).strict()` → `201 { shareId, tokenNumber }`. Order: session → role (403) → body (400) → mock gate (`readAbdmConfig().state !== 'mock'` → 404 `{ error: 'Not found' }`) → `likePatientId` lookup (404 if unknown). `likePatientId` copies the chart's name, gender (male→M, female→F, other/transgender→O) and DOB parts; otherwise typed values with name default `Sandbox Mock Patient`. ABHA number `fabricatedAbhaNumber(requestId)`; `isMock: true`; `requestId` a fresh UUID; `on-share` is **not** sent (read `sendOnShare` at `src/lib/queries/abdm-profile-shares.ts:103`; leave `ack_state 'pending'` unless it already no-ops for mock rows). Audit `abdm: simulated profile share` with `share=<id> like_patient=<yes|no>`.

- [ ] **Step 1: Write failing tests**: with `ABDM_USE_MOCKS=1` and `NODE_ENV=test`, `frontdesk` posting `{ likePatientId }` gets 201 and a pending share with `is_mock true` whose name equals the chart's; posting `{ name: 'Wrong Person' }` and then resolving `linked` to that patient yields 409 `identity_mismatch` (Task 5); with mocks off (`NODE_ENV=production`, no `ALLOW_DEMO_MOCKS`) → 404 and no row; `pi` → 403 before parsing; the button is absent on the queue page when setup is `not_configured`.
- [ ] **Step 2: Run** `source $SCRATCH/testenv.sh && npx vitest run tests/api/abdm-share-simulate.test.ts tests/components/abdm/SimulateShareButton.test.tsx` → FAIL.
- [ ] **Step 3: Implement.** Append the route to `API_GATES` (allowed `ABDM_SHARE_QUEUE_ROLES`) and `SP8_WRITE_GATES` (deny before parse; allowed role gets 400 on `NOT_JSON` because the body is parsed before the mock gate) inside `// WS12 T6`.
- [ ] **Step 4: Run** the Step 2 command plus `npx vitest run tests/api/rbac-route-gates.test.ts tests/lib/abdm/mock-adapter.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(abdm): simulate a Scan & Share in mock mode (WS12 T6)`.

### Task 7: Pre-auth "Refresh snapshot" and honest NHCX state (stream C)

**Files:**
- Create: `scripts/migrations/2026-10-24-ws12-preauth-refresh-enum.sql` (only `ALTER TYPE preauth_action ADD VALUE IF NOT EXISTS 'refresh_snapshot';` inside `BEGIN; … COMMIT;`, as `2026-10-08-sp5-lab-enum-values.sql`)
- Modify: `src/db/schema.ts` (`preauthActionEnum` array: append `'refresh_snapshot'`, comment `// WS12 T7`), `src/lib/rcm/preauth-status.ts` (`PREAUTH_ACTIONS` appends `'refresh_snapshot'`; `nextPreauthStatus` returns `from` for `requested` and `enhancement_requested`, else null), `src/lib/rcm/validation.ts` (`preauthActionSchema` variant `{ action: 'refresh_snapshot' }`), `src/lib/queries/preauths.ts` (`applyPreauthAction` case), `src/lib/queries/nhcx-exchanges.ts` (`createPreauthExchange` picks the latest of `request`/`request_enhancement`/`refresh_snapshot`; its "no participant code" failure says to refresh when live data has a code), `src/lib/queries/nhcx-review.ts` (`preauthNhcxState`), `src/components/rcm/PreauthActions.tsx` (`LABEL.refresh_snapshot = 'Refresh snapshot'`, `FIELDS.refresh_snapshot = []`, short help text), `src/components/nhcx/NhcxExchangePanel.tsx` (call `router.refresh()` after a failed send too; show `sendReason`), `src/components/rcm/PreauthTimeline.tsx` (label the new event "Snapshot refreshed")
- Test: extend `tests/lib/rcm/status.test.ts`, `tests/db/sp7-claims-schema.test.ts` (enum parity holds), `tests/lib/queries/preauths.test.ts`, `tests/api/rcm-preauth-nhcx.test.ts`, `tests/api/nhcx-review.test.ts`, `tests/components/nhcx/NhcxExchangePanel.test.tsx`

**Interfaces:**
- Produces: `applyPreauthAction(id, { action: 'refresh_snapshot' }, session)` → `rcmOk({ status })` with an appended `preauth_events` row (`from_status = to_status`, new snapshot and SHA-256, kind of the latest request event, `requestedPaise` unchanged); refusals: `invalid_transition` outside the two statuses; `preauth_in_use` with "Already sent through NHCX; the insurer has this version" when an outbound exchange for the latest snapshot event is in any state other than `send_failed`/`error`; `not_ready` with "Nothing has changed since this request was prepared" when the SHA-256 equals the latest. Audit `rcm: pre-authorisation refresh_snapshot`.
- Produces: `preauthNhcxState(preauthId: number): Promise<{ canSend: boolean; reason: string | null; snapshotStale: boolean }>`; stale when the latest snapshot lacks a recipient code (or hospital HFR/ROHINI) that live data now has; reason `This request was saved before the insurer's NHCX code was added. Use "Refresh snapshot", then send.` (or the hospital-ID variant).

- [ ] **Step 1: Write failing tests**: `nextPreauthStatus('requested','refresh_snapshot')` is `requested`, `('approved','refresh_snapshot')` null, terminal statuses refuse it (existing loop still passes); enum parity test passes with the new value; in a world where PA was requested before the TPA got an NHCX code: `preauthNhcxState` → `canSend false`, `snapshotStale true`, the stale reason; after `refresh_snapshot` → `canSend true` and `createPreauthExchange` queues an exchange whose `recipient_code` is the new code and whose `preauth_event_id` is the refresh event; a second refresh with nothing changed → `not_ready`; refresh after an accepted (`sent`) exchange → `preauth_in_use`; refresh after `send_failed` → allowed; `NhcxExchangePanel` calls `router.refresh` after a 422 send.
- [ ] **Step 2: Run** `source $SCRATCH/testenv.sh && npx vitest run tests/lib/rcm/status.test.ts tests/db/sp7-claims-schema.test.ts tests/lib/queries/preauths.test.ts tests/api/rcm-preauth-nhcx.test.ts tests/api/nhcx-review.test.ts tests/components/nhcx` → FAIL.
- [ ] **Step 3: Implement** (apply the enum migration to `hims_test` before running DB tests; schema-diff clean).
- [ ] **Step 4: Run** the Step 2 command plus `npx vitest run tests/api/rcm-preauths.test.ts tests/lib/queries/nhcx-exchanges.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(rcm): refresh a requested pre-auth's snapshot and explain stale NHCX state (WS12 T7)`.

### Task 8: Pre-auth defaults from the admission, clear form messages, coverage gate and auto eligibility (stream C)

**Files:**
- Create: `src/lib/rcm/preauth-form.ts`
- Modify: `src/app/(dashboard)/rcm/preauths/new/page.tsx` (accept `admissionId`/`encounterId` search params; load `preauthDefaultsFor`; show the patient's `CoverageBadge` with context `preauth`), `src/components/rcm/PreauthForm.tsx` (props `defaults?: PreauthFormDefaults`; doctor defaults to `defaults.treatingProviderId` or empty, never `doctors[0]`; a "To create the draft, add: …" line under the button from `missingPreauthFields`, wired with `aria-describedby`; requested-vs-estimate warning and a confirm checkbox above 25 %; shows the create response's eligibility message before navigating), `src/components/rcm/EstimateTable.tsx` (renders the indicative split returned by the estimate route), `src/lib/queries/preauths.ts` (`preauthDefaultsFor`; `createPreauth` gate; `estimateForPolicy` returns `coverage`), `src/app/api/rcm/preauths/route.ts` (after create, `maybeStartEligibility` with context `preauth`, purpose `auth-requirements`, provider = treating doctor; response gains `eligibility`), `src/app/api/rcm/preauths/estimate/route.ts` (returns `coverage`)
- Test: `tests/lib/rcm/preauth-form.test.ts`, extend `tests/components/rcm/PreauthForm.test.tsx`, `tests/api/rcm-preauths.test.ts`, `tests/lib/queries/preauths.test.ts`

**Interfaces:**
- Consumes: `evaluateCoverage`, `getCoverageSummary`, `currentVerification`, `applyCoverageToEstimate`, `effectiveLimits` (T1); `maybeStartEligibility` — **defined in T4 (stream A)**. To keep stream C independent, T8 calls it through `import { maybeStartEligibility } from '@/lib/queries/coverage'` only if T4 has merged; otherwise T8 adds a minimal `maybeStartEligibility` with the T4 signature in `src/lib/queries/coverage-eligibility.ts`, and whichever stream merges second deletes the duplicate and re-points the import (the controller checks this at merge).
- Produces (`src/lib/rcm/preauth-form.ts`, pure):
  ```ts
  export interface PreauthFormState { policyId: number | null; plannedAdmissionDate: string; treatingProviderId: string; estimateItems: number; diagnosisCodes: number; provisionalDiagnosisText: string }
  export function missingPreauthFields(s: PreauthFormState): string[]   // e.g. ['planned admission date', 'treating doctor', 'at least one estimate line', 'a diagnosis code or provisional diagnosis']
  export function requestedVsEstimate(requestedPaise: number | null, estimatePaise: number | null): { level: 'none' | 'info' | 'warn'; message: string | null; needsConfirm: boolean }
  ```
- Produces: `preauthDefaultsFor(patientId: string, opts: { admissionId?: number; encounterId?: number }, now?: Date): Promise<PreauthFormDefaults>` where `PreauthFormDefaults = { admissionId: number | null; encounterId: number | null; claimType: 'ipd' | 'daycare' | 'opd'; plannedAdmissionDate: string | null; treatingProviderId: number | null; policyId: number | null; roomCategoryCode: string | null }` (from the admission: IST date of `admitted_at`, `attending_provider_id`, current room category, `admission_coverage.policy_id` else the primary active policy; the only active admission is used when no id is given).
- Produces: `createPreauth` refuses with `policy_not_in_force` when `plannedAdmissionDate` is outside the policy's dates, and with `coverage_inactive` when the current verification is `inactive`; `POST /api/rcm/preauths` → `201 { preauthId, preauthNumber, eligibility }`; `POST /api/rcm/preauths/estimate` → `{ lines, totalPaise, coverage: { insurerPaise, patientPaise, warnings } | null }`.

- [ ] **Step 1: Write failing tests**: `missingPreauthFields` names the planned admission date when only it is empty; the form shows "To create the draft, add: planned admission date" and the button's `aria-describedby` points at it; with `defaults` from an admission the date, doctor, admission and policy are pre-filled; with no defaults the doctor select is empty (not the first doctor); requested ₹90,000 against estimate ₹600 shows the warning and requires the confirm checkbox; `preauthDefaultsFor` for an ICU admission returns the attending doctor and `ICU`; creating a pre-auth whose planned date is after the policy's valid-to → 422 `policy_not_in_force`; with a current `inactive` verification → 409 `coverage_inactive`; in mock mode a create for an NHCX payer returns `eligibility.started true` and one check with context `preauth`; with NHCX unconfigured the create succeeds and `eligibility.started false`; the estimate route returns the split and the room-rent warning when the room category's rate exceeds the limit.
- [ ] **Step 2: Run** `source $SCRATCH/testenv.sh && npx vitest run tests/lib/rcm/preauth-form.test.ts tests/components/rcm/PreauthForm.test.tsx tests/api/rcm-preauths.test.ts tests/lib/queries/preauths.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the Step 2 command plus `npx vitest run tests/pages tests/lib/queries/charge-capture-preauth.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(rcm): pre-auth defaults from the admission, explained submit, coverage gate and auto eligibility (WS12 T8)`.

### Task 9: Coverage at OPD check-in and insurance at IPD admission (stream D)

**Files:**
- Create: `src/lib/queries/admission-coverage.ts`, `src/app/api/admissions/[id]/coverage/route.ts`, `src/components/insurance/AdmissionCoverageSection.tsx`
- Modify: `src/app/api/front-desk/check-in/route.ts` (optional `coverage` in the strict schema, inpatient only; gate before any room is claimed; after commit start eligibility; response gains `coverage`), `src/lib/queries/encounters.ts` (`CheckInVisitInput.afterAdmission?: (tx: WriteExecutor, admissionId: number) => Promise<void>`, called inside the transaction right after the admission insert; no other change), `src/components/CheckInModal.tsx` (fetch `GET /api/patients/[anonId]/coverage` when a patient is chosen; show `CoverageBadge`; inpatient shows `AdmissionCoverageSection`), `tests/api/rbac-route-gates.test.ts`
- Test: `tests/api/check-in-coverage.test.ts`, `tests/api/admission-coverage.test.ts`, extend `tests/components/CheckInModal.test.tsx`, `tests/api/front-desk-check-in.test.ts` (existing bodies without `coverage` still pass)

**Interfaces:**
- Consumes: `evaluateCoverage`, `getCoverageSummary`, `ADMISSION_COVERAGE_ROLES` (T1); `GET /api/patients/[anonId]/coverage` (T2) — if T2 has not merged when T9 starts, the modal test mocks the fetch and the route contract in T2 is binding; `maybeStartEligibility` (same arrangement as T8); `CoverageBadge` (T4; same arrangement: a 15-line local badge in `AdmissionCoverageSection.tsx` until T4 merges, then replaced).
- Produces: check-in body addition `coverage?: { mode: 'self_pay' | 'cashless' | 'reimbursement'; policyId?: number; preauthId?: number; depositRequiredPaise?: number }` (`.strict()`; rejected for outpatient). For inpatient `cashless`, `evaluateCoverage(context 'ipd_admission', emergency: urgency === 'emergency')` with `severity 'block'` → `409 { error, code: 'coverage_blocked', state }` **before** `assignRoomToPatient`. Policy must belong to the patient (404 otherwise); pre-auth must belong to the patient and policy and not be `rejected`/`cancelled` (409). Response `201 { …existing, coverage: CoverageVerdict | null, eligibility?: {...} }`.
- Produces: `upsertAdmissionCoverage(executor: WriteExecutor, admissionId: number, input: AdmissionCoverageInput, verdict: CoverageVerdict, session: Session): Promise<void>` (deposit default per R12; audit `insurance: recorded admission coverage` with `admission=<id> mode=<m> policy=<id|none> preauth=<id|none> state=<s>`); `getAdmissionCoverage(admissionId: number): Promise<AdmissionCoverageView | null>`.
- Produces: `PUT /api/admissions/[id]/coverage` (same body as `coverage` above, strict) → `200 { coverage: AdmissionCoverageView, verdict }`; 404 unknown or discharged admission; same block rules (emergency taken from `admissions.admission_type === 'emergency'`). Roles `ADMISSION_COVERAGE_ROLES`.
- Produces: `<AdmissionCoverageSection patientId coverage onChange />`: mode radio (Self-pay / Cashless / Reimbursement), policy select, approved/requested pre-auth select (from `GET /api/rcm/patients/[anonId]/approved-preauths` where the role allows, else hidden), deposit field in rupees converted to paise, a "Collect deposit at the Cash Desk" link `/cash-desk?patientId=<id>&amountPaise=<n>` shown after admission.

- [ ] **Step 1: Write failing tests**: OPD check-in of a patient with an expired policy → 201 with `coverage.state 'policy_expired'`, `severity 'warn'`; OPD check-in in mock mode with an NHCX payer and no current verification → one check with context `checkin`; inpatient cashless with an expired policy → 409 `coverage_blocked`, the requested room still `available`, no admission row; the same with urgency `emergency` → 201, admission plus `admission_coverage` row with `coverage_state 'policy_expired'`; self-pay inpatient → row with `deposit_required_paise` = the billing threshold; a pre-auth of another patient → 409; outpatient with `coverage` → 400; `PUT /api/admissions/[id]/coverage` role-gated (`pi` 403 before parse), 404 after discharge; the modal shows the badge text for the chosen patient and the coverage section only for Inpatient.
- [ ] **Step 2: Run** `source $SCRATCH/testenv.sh && npx vitest run tests/api/check-in-coverage.test.ts tests/api/admission-coverage.test.ts tests/components/CheckInModal.test.tsx tests/api/front-desk-check-in.test.ts` → FAIL.
- [ ] **Step 3: Implement.** If WS3's admission form has already landed when this task runs, put `AdmissionCoverageSection` in that form instead of `CheckInModal`; the route contracts stay as written. Append `PUT /api/admissions/[id]/coverage` to `API_GATES` and `SP8_WRITE_GATES` inside `// WS12 T9`.
- [ ] **Step 4: Run** the Step 2 command plus `npx vitest run tests/api/front-desk-check-in-encounter.test.ts tests/api/rbac-route-gates.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(insurance): coverage at OPD check-in; payer, policy, pre-auth and deposit at IPD admission (WS12 T9)`.

### Task 10: Sum-insured balance and sub-limits in the charge rules (stream E)

**Files:**
- Create: `src/lib/queries/coverage-limits.ts`
- Modify: `src/lib/billing/charge-rules.ts` (append `'room_rent_over_limit'`, `'sum_insured_exceeded'` to `CHARGE_RULE_CODES` and `CHARGE_RULES` after `preauth_invalid`: default `warn`, configurable, not overridable, field `context`; `ChargeRuleInput.coverage`), `src/lib/queries/charge-capture.ts` (build `coverage` for payer lines via `coverageLimitsForCharge`; self-pay lines get `null`), Settings → billing rules client if it lists codes explicitly (check `src/lib/queries/billing-settings.ts` consumers)
- Test: extend `tests/lib/billing/charge-rules.test.ts`; create `tests/lib/queries/coverage-limits.test.ts`

**Interfaces:**
- Consumes: `currentVerification`, `effectiveLimits`, `ICU_ROOM_CATEGORY_CODES` (T1); `admission_coverage` (T1 table).
- Produces: `ChargeRuleInput.coverage: { roomCategoryCode: string | null; roomRentLimitPaise: number | null; icuLimitPaise: number | null; balancePaise: number | null; insuredRunningPaise: number; lineTaxablePaise: number } | null`. Predicates: `room_rent_over_limit` when `service.category === 'room_rent'` and the per-day unit price exceeds the applicable limit (ICU limit for ICU codes, else room-rent limit): message `Room rent ₹X/day is above the policy limit ₹Y/day; the insurer may deduct proportionately`; `sum_insured_exceeded` when `insuredRunningPaise + lineTaxablePaise > balancePaise`: message `This takes the insured total to ₹A, above the available sum insured ₹B`.
- Produces: `coverageLimitsForCharge(executor: WriteExecutor, i: { patientId: string; admissionId: number | null; payerId: number; now: Date }): Promise<Omit<NonNullable<ChargeRuleInput['coverage']>, 'roomCategoryCode' | 'lineTaxablePaise'> | null>` (policy from `admission_coverage` when cashless, else the patient's active primary policy whose billing payer is `payerId`; running total = sum of `charge_lines.taxable_paise` with `status <> 'void'`, same admission, same `payer_id`).

- [ ] **Step 1: Write failing tests**: a `room_rent` line at ₹5,000 with limit ₹3,000 → one `warn` `room_rent_over_limit`; an ICU room uses the ICU limit; no limits → no violation; config `enabled: false` suppresses it; `severity: 'block'` config makes it block; a running total ₹4,80,000 + ₹30,000 against balance ₹5,00,000 → `sum_insured_exceeded` warn; self-pay (`coverage: null`) → none; existing rule order and ids unchanged (the first 12 codes are identical); `coverageLimitsForCharge` uses a current mock verification's balance over the policy's sum insured and ignores void lines.
- [ ] **Step 2: Run** `source $SCRATCH/testenv.sh && npx vitest run tests/lib/billing/charge-rules.test.ts tests/lib/queries/coverage-limits.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the Step 2 command plus `npx vitest run tests/lib/queries tests/api -t "charge"` → PASS.
- [ ] **Step 5: Commit** `feat(billing): room-rent and sum-insured limits as charge rules (WS12 T10)`.

### Task 11: RCM settings confirmation, missing-identifier notice and insurance tiles (stream F)

**Files:**
- Create: `src/app/(dashboard)/rcm/layout.tsx`, `src/components/rcm/HospitalIdentifiersNotice.tsx`, `src/lib/queries/coverage-attention.ts`, `src/components/rcm/InsuranceAttentionTiles.tsx`
- Modify: `src/components/rcm/HospitalIdentifiersForm.tsx` (`role="status"` "Saved. Claims and NHCX checks will use these identifiers." after success; "Both cleared: claims and NHCX checks are blocked until they are set." when both empty), `src/app/(dashboard)/rcm/page.tsx` (render tiles), `src/app/(dashboard)/rcm/policies/page.tsx` (`expiring=7` filter)
- Test: `tests/components/rcm/HospitalIdentifiersForm.test.tsx`, `tests/components/rcm/HospitalIdentifiersNotice.test.tsx`, `tests/lib/queries/coverage-attention.test.ts`, extend `tests/pages/page-gates-harness.ts` consumers only if the layout changes a gate (it must not)

**Interfaces:**
- Consumes: `getHospitalIdentifiers` (`src/lib/queries/rcm-payers.ts`), `RCM_SETTINGS_ROLES`, `currentVerification` (T1).
- Produces: `HospitalIdentifiersNotice({ missing, canEdit }: { missing: ('rohini' | 'hfr')[]; canEdit: boolean })` → null when nothing missing; otherwise `role="alert"`: "The hospital's ROHINI ID is not set: claims and NHCX eligibility checks are blocked." plus, for `canEdit`, a link "Set it in RCM settings" to `/rcm/settings`, else "Ask an administrator to set it in RCM settings."
- Produces: the layout renders the notice above `children` for every `/rcm/*` page; it does **not** gate (pages keep their own `RCM_ROLES` check), so it calls `requireSessionOrRedirect()` only to read the role.
- Produces: `getInsuranceAttention(now?: Date): Promise<{ policiesExpiringIn7Days: number; admissionsTodayUnverified: { admissionId: number; patientId: string; uhid: string | null; name: string; payerName: string }[]; claimsBlockedByIdentifiers: number }>` (expiring: active policies with `valid_to` in [today, today+7] IST; unverified: admissions with `admitted_at` today IST whose `admission_coverage.mode = 'cashless'` and no current verification; blocked: draft claims while ROHINI and HFR are both missing). Tiles link to `/rcm/policies?expiring=7`, the patient pages (shown by UHID), and `/rcm/settings` (admin) respectively.

- [ ] **Step 1: Write failing tests**: saving shows the confirmation text; clearing both shows the blocked text; the notice for `rcm` says "Ask an administrator" with no link; for `admin` shows the link; nothing renders when both IDs exist; `getInsuranceAttention` counts a policy ending in 3 days and not one ending in 9, lists a cashless admission admitted today without verification by UHID and drops it after a manual verification; the `/rcm/policies?expiring=7` page lists only those policies.
- [ ] **Step 2: Run** `source $SCRATCH/testenv.sh && npx vitest run tests/components/rcm/HospitalIdentifiersForm.test.tsx tests/components/rcm/HospitalIdentifiersNotice.test.tsx tests/lib/queries/coverage-attention.test.ts` → FAIL.
- [ ] **Step 3: Implement** (read the layouts guide in `node_modules/next/dist/docs/` first).
- [ ] **Step 4: Run** the Step 2 command plus `npx vitest run tests/pages` → PASS (no page gate changed).
- [ ] **Step 5: Commit** `feat(rcm): confirm identifier saves, tell RCM staff what is missing, insurance attention tiles (WS12 T11)`.

### Task 12: Docs and mock-mode walkthrough

**Files:**
- Modify: `docs/ABDM-NHCX.md` (insurance verification section: sources, freshness, manual verification, identity guard, simulate share, U20), `docs/superpowers/plans/2026-10-23-gap-closure-plan.md` (tick K3, K5–K7, K10, L1–L4, L7 (guard), L8, L9, I6, I7), `README.md` (insurance verification in the feature list)
- Test: full suite + build

- [ ] **Step 1: Run** `source $SCRATCH/testenv.sh && npx vitest run` → all green (known skips documented); `npx tsc --noEmit` and `npm run lint` → clean; `db:migrate:status` against `hims_test` shows the three WS12 migrations applied and none changed.
- [ ] **Step 2: Walk through in Docker** (this worktree's image on a spare port, `.env.docker` copy with `ABDM_USE_MOCKS=1`, `ALLOW_DEMO_MOCKS=true`, `DEMO_FEATURES=true`, `BLOB_DRIVER=local`): set ROHINI/HFR (confirmation shows); add a policy for a patient with a visit (auto check, header badge "Policy valid, verified less than an hour ago · Sandbox mock - not real", limits on the Insurance tab); record a manual verification with a PDF for a non-NHCX insurer and open the document; OPD check-in shows the badge; admit cashless with an expired policy (blocked), then as emergency (admitted with warning); create a pre-auth from the admission (defaults filled, missing-field text, auto check); request it, add the TPA's NHCX code, see the stale reason, refresh the snapshot and send; capture a room-rent line above the limit (warning); ABHA link with the mock profile (mismatch warning, link with reason); simulate a share like an existing patient and link it without a warning.
- [ ] **Step 3: Commit** `docs: insurance verification (WS12) verified in mock mode`.
