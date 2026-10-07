# SP7: RCM, Insurer/TPA & Claims Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the hospital's revenue-cycle (insurance desk) team a complete cashless-insurance workflow:
- **insurer and TPA masters** (empanelment, contacts, submission channel, turnaround SLAs, GSTIN/state, required documents) as a 1:1 profile on the existing `payers` table, and **patient policy/card records** that replace the US-style primary/secondary fields gradually;
- a **pre-authorisation lifecycle** (request with a tariff-priced estimate → query → approval with amount and validity → enhancement → rejection/cancellation) whose approved reference SP4 charge capture validates;
- a **claim entity and state machine** built from finalised SP4 invoices plus SP6-finalised coding, with a pure **readiness engine** that blocks submission while required documents or checks are missing;
- the owner's **"two copies" rule**: every submission freezes an immutable, SHA-256-fingerprinted snapshot. The **RCM copy** is retained in the system. The **insurer copy** is generated and its dispatch (channel, tracking reference, who, when) recorded. Every resubmission, query response or appeal is a new version;
- manual recording of **insurer-portal updates** (queries with due dates, approvals with reason-coded disallowances, rejections, appeals, settlements with UTR/TDS/bank charges, bank reconciliation, write-offs with second-person approval) in an append-only event log;
- settlement and write-off credits flowing into the **SP4 patient ledger** exactly once, with an insurer-payable vs patient-payable split;
- an `rcm` role, an RCM dashboard with worklists, SLA flags, ageing, denial and payer reports, and a `ClaimGateway` interface (manual now, NHCX stub for SP8).

The owner's words: "Revenue cycle management (accounts dept): they will CLAIM the insurance bills (ONE COPY should be kept with the RCM and then ONE SENT to the insurance provider, and they keep the copy and update it in THEIR PORTAL)".

**Architecture:**
- Every rule is pure, client-safe code under `src/lib/rcm/`: constants, the pre-auth and claim status machines, worklist classification, money invariants (approval, settlement, write-off, covered-pending), ageing and SLA flags, the readiness engine, the claim/pre-auth snapshot builders and canonical JSON, request schemas, the error catalogue and the `ClaimGateway` registry. Server-only helpers (`hash.ts`, `claim-pdf.ts`, `route-responses.ts`) sit beside them.
- Query modules run one `getDb().transaction` per write. A write that touches money or invoices takes the SP4 per-patient lock (`billing:patient:<id>`) first, then the claim or pre-auth row `FOR UPDATE`, and writes `logAudit(…, tx)` on the same transaction. Routes are thin; their tests mock the query modules.
- Immutability is enforced twice, as SP4 does: no app path updates a submission, dispatch, event, disallowance or settlement, and migration-only triggers reject `UPDATE`/`DELETE` on them (narrow, column-checked exceptions for acknowledgement, reconciliation and write-off decisions).
- Side effects that can fail (PDF render, blob upload) happen **before** the submission transaction. The transaction rebuilds the snapshot and refuses with `stale` if its hash changed (SP5 pattern).

**Tech Stack:** Next.js 16 App Router (route `params` and page `searchParams` are `Promise`s; `src/proxy.ts`, not middleware), drizzle-orm 0.45 + node-postgres (real transactions; `bigint(…, { mode: 'number' })`; `pgSequence`), Postgres 15, zod v4, `@vercel/blob` private store via SP5 `src/lib/blob-store.ts`, `pdf-lib` (added by SP5), `node:crypto` SHA-256, vitest + jsdom + Testing Library, lucide-react.

**Spec:** `docs/superpowers/specs/2026-10-07-indian-hims-design.md` (sections 1–4, 6, 7 are binding; this plan implements sub-project 7, "RCM, insurer/TPA & claims"). §3 "RBAC: new roles `coder` and `rcm` (insurance desk)" — SP7 adds `rcm`. §3 "NHCX … behind a gateway interface with a mock" — SP7 ships the interface, a manual implementation and a not-configured NHCX stub; FHIR bundles and the mock are SP8. §3 "Documents: server-side PDF generation (… claim copy)" — built here.

**Depends on:**
- SP1 + SP2 (merged): `payers`, `patients` (SP1 columns, legacy `primary*`/`secondary*` insurance columns, `abhaNumber`), `departments`, `providers`, `service_catalog`, `loadPricingContext` + `resolvePrice` (SP2), `parseId` / `invalid` / `isRetryableConflict` / `RETRY_MESSAGE` (`src/lib/tariff/route-responses.ts`), `logAudit(session, action, patientId, details, executor)`, `publicPatientColumns`, `isUniqueViolation` (`src/lib/db-errors.ts`), `containsAadhaarLike` (`src/lib/india/aadhaar.ts`), `formatAbhaNumber`, `formatPaise` / `parseRupeesToPaise`, `invalidateCache` / `patientDetailCacheKey`, `tests/db/migration-sql.ts` (`readMigration`, `idempotencyProblems`, `missingColumns`).
- **SP3** (`docs/superpowers/plans/2026-10-07-sp3-encounters-followup.md`): `encounters` (`admissionId`, `encounterType` `opd|ipd|lab`, `status`), `WriteExecutor`, `istDateOf` / `todayIsoIn` / `formatIsoDate` / `formatDateTimeIn` / `ageOnDate`, `readJsonBody`, `getDischargeSummaryData(admissionId)` + `DischargeSummaryData`, `isoDateSchema`.
- **SP4** (`docs/superpowers/plans/2026-10-07-sp4-charge-capture.md`): `invoices` / `invoice_lines` (immutable, `status` `draft|finalised|cancelled|discarded`, `payerId`, `admissionId`, `encounterId`, `totalPaise`), `charge_lines.preAuthReference`, `cancelInvoice`, `computeLedger` / `LedgerEntry` / `loadLedgerEntries` / `getPatientLedger`, `paiseFromDb`, `sumPaise`, `MAX_DOCUMENT_PAISE`, `lineTaxablePaise`, `lineTax`, `isValidGstin`, `paymentReferenceProblem`, `evaluateChargeRules` / `CHARGE_RULES` / `CHARGE_RULE_CODES`, `billing_settings`, `payers.requiresPreauth|gstin|stateCode`, `PatientHasFinancialRecordsError`, `purgeBillingFixtures`, `CHARGE_CAPTURE_ROLES`, `BILLING_AUTHORITY_ROLES`, `CASH_DESK_ROLES`, `SP4_WRITE_GATES`.
- **SP5** (`…sp5-lab-home-collection.md`): `putPrivateBlob(path, bytes, contentType)`, `streamPrivateBlob(url, { filename, disposition })` (`src/lib/blob-store.ts`), `pdf-lib`, the PDF-safe text helper exported by `src/lib/labs/report-data.ts`, `lab_reports` (`patientId`, `blobUrl`, `sha256`, `releasedAt`, `supersededAt`, `reportNumber`), `collector` role.
- **SP6** (`…sp6-clinical-coding.md`): `getEncounterCodingGate(encounterId, executor?)` (`finalised` required for claims, SP6 ruling 2), `diagnoses` coded columns (`encounterId`, `codeId`, `codeSystemKind`, `codeDisplay`, `diagnosisType`, `codingStatus`, `sequence`, `voidedAt`), `encounter_procedures`, `code_systems`, `getCodesByIds(ids, executor?)` + `CodeDetail`, `CodeSystemKind`, `DIAGNOSIS_CODE_KINDS`, `PROCEDURE_CODE_KINDS`, `CODE_LOOKUP_ROLES`, the `coder` role.

## Global Constraints

- Read `AGENTS.md`. Before writing any route or page, read the matching guide in `node_modules/next/dist/docs/`. Route context is `{ params: Promise<{ … }> }`; page props are `{ params: Promise<…>; searchParams: Promise<…> }`.
- **Worktree:** fresh `.worktrees/sp7` off `main`, branch `feature/sp7-rcm-claims`. Copy `.env.local` from the main checkout. **Task 1 Step 0:** `test -f src/lib/queries/invoices.ts && test -f src/lib/queries/coding.ts && test -f src/lib/blob-store.ts && test -f scripts/migrations/2026-10-07-sp4-b-invoices-ledger.sql && test -f scripts/migrations/2026-10-07-sp6-b-clinical-coding.sql && node -e "require('pdf-lib')"`. If any fails, stop and report; never cherry-pick. Never touch other worktrees.
- **Money (spec §3):** integer paise, `INR`. Every SP7 amount column is `bigint(…, { mode: 'number' })`, capped by `MAX_DOCUMENT_PAISE`. Parse rupee input only with `parseRupeesToPaise`; display with `formatPaise` (in PDFs `formatPaise(p).replace('₹', 'Rs. ')`, because the standard PDF fonts cannot encode ₹). Every SQL `sum()` goes through `paiseFromDb`. No floats.
- **Time:** business dates are Asia/Kolkata `date` values via `todayIsoIn(DEFAULT_TIMEZONE, now)` / `istDateOf(instant)`; instants are `timestamp` (UTC). Never `toISOString().slice(0, 10)` on an instant.
- **IDs:** `serial` integer PKs; patient FKs are `text`. Pre-auth numbers `PA-<IST yyyy>-<6 digits>` and claim numbers `CLM-<IST yyyy>-<6 digits>` come from Postgres sequences (not tax documents; gaps allowed, ruling 8).
- **PHI:**
  - Every read of `patients` names its columns; `tests/lib/no-credential-leak.test.ts` stays green.
  - **RCM minimum (ruling 9):** an RCM-facing patient payload carries `id`, `name`, `uhid`, `gender`, `dob`, `ageYears` only; `abhaNumber` is added only when the claim's payer profile has `requiresAbha` **and** the role is in `CLAIM_ABHA_READ_ROLES`. Never phone, email, address, contacts, notes or anything Aadhaar.
  - Files under `src/lib/rcm/snapshot.ts`, `src/lib/rcm/claim-pdf.ts`, `src/lib/queries/claim-submissions.ts` and `src/app/api/rcm/claims` must not contain the word "aadhaar" in any case (Tasks 12 and 14 add them to `EXPORT_PATHS` of `tests/lib/no-aadhaar-leak.test.ts`). The only SP7 file allowed to call `containsAadhaarLike` is `src/lib/rcm/identifier-guard.ts`.
  - Blob URLs are stored server-side only and never appear in a JSON response, a page prop or the audit log.
  - Audit `details` carry ids, claim/pre-auth numbers, enum values, reason codes and paise amounts only. Never policy numbers, member ids, UTRs, approval references, query text, notes, reasons, document titles or file names.
- **Locks:** a write that touches a claim, pre-auth, settlement, write-off or invoice link calls `lockPatientBilling(tx, patientId)` (Task 6, the same `hashtext('billing:patient:' || id)` key SP4 uses) first, then locks its own row `FOR UPDATE`.
- **RBAC** (constants added in Task 1 to `src/lib/role-policy.ts`, block commented `// SP7`):

  | Constant | Roles | Grants |
  |---|---|---|
  | `RCM_ROLES` | admin, rcm | every `/rcm` page except settings; claims, pre-auths, their documents, insurer updates, settlements, reconciliation, write-off requests, pre-auth estimate |
  | `PAYER_MASTER_ROLES` | admin, rcm | insurer/TPA profile, contacts, network and document-requirement writes |
  | `RCM_SETTINGS_ROLES` | admin | hospital ROHINI / HFR identifiers |
  | `POLICY_READ_ROLES` | admin, rcm, frontdesk, billing, crc | a patient's policies and policy-card images |
  | `POLICY_WRITE_ROLES` | admin, rcm, frontdesk | add/edit policies, upload cards |
  | `PREAUTH_LOOKUP_ROLES` | admin, rcm, billing, crc | approved pre-auths of a patient (charge-capture picker) |
  | `WRITE_OFF_APPROVE_ROLES` | admin | approve or reject a write-off |
  | `CLAIM_ABHA_READ_ROLES` | admin, rcm | ABHA on a claim whose payer requires it |

  - `rcm` is also appended to `TARIFF_LOOKUP_ROLES` (pre-auth estimate service search) and `CODE_LOOKUP_ROLES` (pre-auth diagnosis/procedure search). Nothing else gains `rcm`.
  - **API order:** `requireSession()`, then the inline allowlist returning exactly `NextResponse.json({ error: 'Forbidden' }, { status: 403 })`, then the body (`readJsonBody`, or `readUpload` for multipart). Bad JSON → `400 { error: 'Invalid JSON' }`; a non-multipart body on an upload route → `400 { error: 'Send the file as multipart form data' }`.
  - **Page order:** `requireSessionOrRedirect()`, then `redirect('/')` for a denied role, before any data load.
  - **Harnesses:** every new route gets an `API_GATES` row (wrapped in `settle()`); every new POST/PUT/PATCH/DELETE gets an `SP7_WRITE_GATES` deny-before-parse row in `tests/api/rbac-route-gates.test.ts` (Task 7 creates the array and adds it to the `describe.each` spread); every new page gets a `PAGE_GATES` row in `tests/pages/page-gates-harness.ts`. No `gap` tags. `LeftNav` roles equal the page gate.
- **Audit:** every write calls `logAudit(session, action, patientId | null, details, tx)` inside its transaction. Action strings start `rcm: ` and are exactly those each task names. Every page that shows a claim, pre-auth or policy, and every document/copy download, is audited.
- **Errors:** query modules return `RcmWriteResult<T>` (Task 4); routes map it with `rcmErrorResponse`. A `40P01` / `40001` maps to `409 { error: RETRY_MESSAGE }` via `rcmServerError`; other unexpected errors are a 500 that logs only the pg code and constraint.
- **Uploads:** `application/pdf`, `image/jpeg`, `image/png`, at most `RCM_UPLOAD_MAX_BYTES = 4_000_000` (under the Vercel request-body limit). SHA-256 of the bytes is stored with every upload. Paths: `rcm/policies/<policyId>/<uuid>.<ext>`, `rcm/preauths/<preauthId>/<uuid>.<ext>`, `rcm/claims/<claimId>/docs/<uuid>.<ext>`, `rcm/claims/<claimId>/v<version>/<rcm|insurer>-<uuid>.pdf`.
- **Schema changes:** `src/db/schema.ts` block commented `// SP7` + idempotent SQL in the SP1/SP4 style: `scripts/migrations/2026-10-07-sp7-a-rcm-role.sql` (Task 1), `…-sp7-b-payers-policies.sql` (Task 5), `…-sp7-c-preauth-claims.sql` (Task 6).
  - `BEGIN; … COMMIT;`, `IF NOT EXISTS` everywhere, each `CREATE TYPE` in a `DO` block catching `duplicate_object`, each FK/unique/check in a `DO` block testing `pg_constraint`, named exactly as drizzle names it, each trigger in a `DO` block testing `pg_trigger`, functions `CREATE OR REPLACE`, `CREATE SEQUENCE IF NOT EXISTS`, no `DROP`, no `UPDATE` of existing rows.
  - Apply **only** to the local container, **twice** (both runs end in `COMMIT`): `/Users/k2a/.docker/bin/docker exec -i hims-local-pg psql -U postgres -d hims -v ON_ERROR_STOP=1 < scripts/migrations/<file>`. Never `db:push` / `drizzle-kit push`; never `scripts/apply-sql.mjs`.
- **Tests:**
  - Pure and mocked: `npx vitest run <file>`. DB: `npm test -- <file>` (loads `.env.local`).
  - New DB tests: `describe.skipIf(!process.env.DATABASE_URL)('… (DB)', …)`, fixtures prefixed `TEST-SP7-${RUN}` (payer codes `TSP7${RUN}`); invoices finalised with `now = new Date('2099-06-01T06:00:00Z')` (financial year `2099-00`). Cleanup: `purgeRcmFixtures` (Task 6), then SP4 `purgeBillingFixtures`, then the SP6/SP3 order.
  - **Never run the whole suite or `tests/db/seed.test.ts`** (it truncates the shared local DB).
- **Per-task verification:** the task's tests + `npx tsc --noEmit` + `npx eslint <changed files>`.
- **Branding:** no hard-coded product name (`brand` server-side, `useBrand()` client-side).
- **Merge hygiene:** keep additions in `// SP7` blocks in `schema.ts`, `seed.ts`, `role-policy.ts`, `role-capabilities.ts`, `LeftNav.tsx`, both harness files, and in the SP4 files this plan edits (`charge-rules.ts`, `validation.ts`, `charge-capture.ts`, `invoices.ts`, `ledger.ts`, `patient-ledger.ts`, `ChargeCaptureForm.tsx`, `LedgerTable.tsx`).
- No secrets. The executor commits per task as written. Nothing is committed while planning.

## Review Focus

1. **A double-clicked "Record settlement", or two RCM users posting the same remittance.** It must produce one settlement row and one ledger credit; the total settled can never exceed the approved amount still due, so the patient ledger is never credited twice. Test: Task 13 `a double-submitted settlement with the same UTR posts once` and `settlement above the approved amount still due is refused`, Task 13 `the ledger shows each settlement exactly once`.
2. **An invoice cancelled, or claimed twice, after it went on a claim.** SP4 `cancelInvoice` must refuse an invoice on a non-draft claim; two claims on one invoice (primary + top-up policy, or two clerks at once) must never claim more than its total. Test: Task 11 `cancelInvoice refuses an invoice on a submitted claim`, `two concurrent claims on one invoice never exceed its total`, `a draft claim whose invoice was cancelled is not ready`.
3. **The RCM copy drifting from what was sent.** The stored snapshot, its hash and both PDFs must never change after submission, and a coding reopen after submission must flag the claim and block the next version until coding is finalised again. Test: Task 6 `refuses to update or delete a submission`, Task 12 `verify recomputes the stored hashes`, `coding reopened after submission flags the claim and blocks resubmission`, `a change between render and commit is refused as stale`.
4. **Approval amounts that do not add up.** An insurer approval typed with disallowances that do not reconcile to the claimed amount, an approval above the claim, or a write-off above what is still open must be refused with a plain message naming the rupee gap. Test: Task 2 `approval amounts must reconcile`, `write-off ceiling`, Task 13 `a write-off needs a second person`.
5. **Identity data where it must not be.** An Aadhaar typed into a policy or member number is refused; ABHA reaches a snapshot only when the payer requires it; UTRs, policy numbers and notes never reach the audit log; RCM payloads carry no contact fields. Test: Task 4 `refuses an Aadhaar-like policy or member number`, Task 3 `ABHA only when the payer requires it`, Task 8 `policy audit carries no policy or member number`, Task 13 `audit details carry no UTR or note`, Task 15 `workspace patient header carries only the RCM minimum`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/rcm/constants.ts` | Enum constants, labels, number format, upload limits (pure) |
| `src/lib/rcm/preauth-status.ts` | Pre-auth machine, reference status (pure) |
| `src/lib/rcm/claim-status.ts` | Claim machine, approval action, worklists (pure) |
| `src/lib/rcm/amounts.ts` | Approval/settlement/write-off/close invariants, covered-pending split (pure) |
| `src/lib/rcm/sla.ts` | Ageing buckets and SLA flags (pure) |
| `src/lib/rcm/readiness.ts` | Required documents and the readiness engine (pure) |
| `src/lib/rcm/snapshot.ts` | `ClaimSnapshot` / `PreauthSnapshot` builders, canonical JSON, coding fingerprint (pure) |
| `src/lib/rcm/validation.ts` | zod request schemas (client-safe) |
| `src/lib/rcm/identifier-guard.ts` | National-ID-looking input guard (the only SP7 caller of `containsAadhaarLike`) |
| `src/lib/rcm/errors.ts` | `RcmWriteError`, status and message maps (pure) |
| `src/lib/rcm/gateway.ts` | `ClaimGateway`, manual gateway, NHCX stub, registry (pure) |
| `src/lib/rcm/hash.ts` | SHA-256 helpers (server) |
| `src/lib/rcm/claim-pdf.ts` | RCM / insurer / draft copy PDF renderer (server) |
| `src/lib/rcm/route-responses.ts` | `rcmErrorResponse`, `rcmServerError`, `readUpload` (server) |
| `src/lib/rcm/csv.ts` | Formula-safe CSV (pure) |
| `src/lib/queries/billing-lock.ts` | `lockPatientBilling` |
| `src/lib/queries/rcm-payers.ts` | Payer profiles, contacts, networks, requirements, reason codes, hospital ids |
| `src/lib/queries/rcm-policies.ts` | Patient policies, cards, legacy prefill, RCM patient search |
| `src/lib/queries/preauths.ts`, `src/lib/queries/preauth-reference.ts` | Pre-auth lifecycle; SP4 reference validator |
| `src/lib/queries/claims.ts`, `src/lib/queries/claim-documents.ts` | Claim drafts, invoice links, documents, readiness loader |
| `src/lib/queries/claim-submissions.ts` | Versions, two copies, dispatch, acknowledgement, verify |
| `src/lib/queries/claim-updates.ts` | Insurer updates, settlements, reconciliation, write-offs |
| `src/lib/queries/rcm-worklist.ts`, `src/lib/queries/claim-workspace.ts`, `src/lib/queries/rcm-reports.ts` | Dashboard, worklists, workspace loader, reports |
| `src/app/api/rcm/**` | Routes |
| `src/app/(dashboard)/rcm/**` | Pages |
| `src/components/rcm/*` | Client components |
| `scripts/migrations/2026-10-07-sp7-{a-rcm-role,b-payers-policies,c-preauth-claims}.sql` | DDL |
| `tests/db/rcm-fixtures.ts` | `purgeRcmFixtures` |

---

### Task 1: The `rcm` role everywhere + SP7 role constants

**Files:**
- Modify: `src/db/schema.ts` (`roleEnum` + `'rcm'` last), `src/lib/auth.ts` (`Role` + `'rcm'`), `src/lib/role-policy.ts` (`ALL_ROLES` + `'rcm'` last; `rcm` into `TARIFF_LOOKUP_ROLES` and `CODE_LOOKUP_ROLES`; `// SP7` block), `src/lib/role-capabilities.ts`, `src/lib/staff-portals.ts`, `src/app/api/users/route.ts` (zod enum), `src/components/settings/StaffManagementPanel.tsx` (role union, `ROLE_LABEL`, `ROLE_BADGE`, `<option>`), `src/app/(dashboard)/page.tsx` (`staffByRole` list), `src/db/seed.ts` (demo user)
- Create: `src/app/login/rcm/page.tsx` (copy of `login/labs/page.tsx` with `'rcm'`), `scripts/migrations/2026-10-07-sp7-a-rcm-role.sql`, `tests/db/rcm-role.test.ts`, `tests/lib/sp7-role-policy.test.ts`
- Modify tests: add `'rcm'` to every hand-written denied-role roster that already lists `'coder'` (find with `grep -rln "'coder'" tests`), exactly as SP6 Task 1 did for `coder`.
- Test: `tests/lib/role-capabilities.test.ts` (append)

**Interfaces:**
- Produces:
  - `type Role` gains `'rcm'`; `ALL_ROLES.at(-1) === 'rcm'`; `roleEnum.enumValues` equals `ALL_ROLES` in order.
  - The eight constants of the Global Constraints RBAC table, each `readonly Role[]`, in exactly that role order.
  - `ROLE_CAPABILITIES.rcm`:
    - `label: 'Revenue Cycle (Insurance Desk)'`
    - `summary: 'Runs cashless insurance: keeps insurer and TPA details, records patient policies, requests pre-authorisations, builds claims from finalised bills, keeps the hospital copy of every submission, and records what the insurer decides and pays. Sees only what claims need.'`
    - bullets: `'Maintain insurers and TPAs: empanelment, contacts, submission channel, turnaround times and required documents'`, `'Record patient policies and policy cards'`, `'Request pre-authorisations with an estimate, and record queries, approvals, enhancements and rejections'`, `'Build claims from finalised bills with coded diagnoses and procedures, and check them for missing documents'`, `'Submit a claim: the hospital copy is kept and fingerprinted, and the insurer copy is generated and its dispatch recorded'`, `'Record insurer portal updates: queries, approvals, deductions, rejections, appeals and settlements with TDS'`, `'Reconcile settlements with the bank and request write-offs'`, `'View the RCM dashboard, worklists, ageing and denial reports'`
  - Appended bullets: admin `'Approve or reject claim write-offs'`, `'Set the hospital ROHINI and HFR identifiers'`; frontdesk `'Record a patient\'s insurance policy and card at registration or admission'`; billing and crc `'Pick an approved pre-authorisation when capturing a charge billed to an insurer'`.
  - `STAFF_PORTALS` entry before admin: `{ key: 'rcm', label: 'Insurance Desk (RCM)', description: 'Pre-auths, claims and settlements', icon: Landmark, iconBg: 'bg-indigo-500/10', iconText: 'text-indigo-700' }`; `ROLE_LABEL.rcm = 'Revenue Cycle (RCM)'`, `ROLE_BADGE.rcm = 'bg-indigo-500/10 text-indigo-700'`.
  - Seed: `{ name: 'Farah Siddiqui', email: seedEmail('rcm'), role: 'rcm', passwordHash: demoHash }`.
  - Migration a: header comment (additive; the value is not used in the same transaction), body `BEGIN; ALTER TYPE role ADD VALUE IF NOT EXISTS 'rcm'; COMMIT;`.

- [ ] **Step 0: Confirm SP3–SP6 are merged** (Global Constraints). Stop and report if not.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/db/rcm-role.test.ts
it('roleEnum equals ALL_ROLES and ends with rcm', () => { expect(roleEnum.enumValues).toEqual([...ALL_ROLES]); expect(ALL_ROLES.at(-1)).toBe('rcm') })
it('rcm-role migration is idempotent and adds the value', () => {
  const s = readMigration('2026-10-07-sp7-a-rcm-role.sql'); expect(idempotencyProblems(s)).toEqual([]); expect(s).toMatch(/ADD VALUE IF NOT EXISTS 'rcm'/)
})
describe.skipIf(!process.env.DATABASE_URL)('rcm role (DB)', () => {
  it('the database accepts the rcm role', async () => { const r = await getDb().execute(sql`select 'rcm'::role as r`); expect(r.rows[0].r).toBe('rcm') })
})
// tests/lib/sp7-role-policy.test.ts
it('every SP7 allowlist is exactly as specified', () => {
  expect(RCM_ROLES).toEqual(['admin', 'rcm']); expect(PAYER_MASTER_ROLES).toEqual(['admin', 'rcm']); expect(RCM_SETTINGS_ROLES).toEqual(['admin'])
  expect(POLICY_READ_ROLES).toEqual(['admin', 'rcm', 'frontdesk', 'billing', 'crc']); expect(POLICY_WRITE_ROLES).toEqual(['admin', 'rcm', 'frontdesk'])
  expect(PREAUTH_LOOKUP_ROLES).toEqual(['admin', 'rcm', 'billing', 'crc']); expect(WRITE_OFF_APPROVE_ROLES).toEqual(['admin']); expect(CLAIM_ABHA_READ_ROLES).toEqual(['admin', 'rcm'])
})
it('rcm has no search, clinical, directory, coding or SP4 billing powers, and only the two lookups', () => {
  expect(hasSearchScope('rcm')).toBe(false)
  for (const l of [CLINICAL_ROLES, PATIENT_DIRECTORY_ROLES, CHARGES_ROLES, BILLING_AUTHORITY_ROLES, CASH_DESK_ROLES, CODING_ROLES, INSURANCE_CARD_READ_ROLES]) expect(l).not.toContain('rcm')
  expect(TARIFF_LOOKUP_ROLES).toContain('rcm'); expect(CODE_LOOKUP_ROLES).toContain('rcm')
})
// tests/lib/role-capabilities.test.ts (append)
it('states the rcm capabilities and no clinical-note write', () => {
  expect(has('rcm', /pre-authorisation/i)).toBe(true); expect(has('rcm', /hospital copy/i)).toBe(true)
  expect(has('rcm', /encounter note|care plan|prescri|finalise an invoice/i)).toBe(false); expect(has('admin', /write-offs/i)).toBe(true)
})
```

- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/db/rcm-role.test.ts tests/lib/sp7-role-policy.test.ts tests/lib/role-capabilities.test.ts` → FAIL (`rcm` missing).
- [ ] **Step 3: Implement** every listed edit. `npx tsc --noEmit` lists any remaining `Record<Role, …>` needing an `rcm` key; fix each. Then `grep -rln "'coder'" tests src` and confirm every roster that lists `coder` as denied also lists `rcm`.
- [ ] **Step 4: Apply migration a twice, then verify:** run the docker command on `2026-10-07-sp7-a-rcm-role.sql` twice (both `COMMIT`). Then `npx vitest run tests/db/rcm-role.test.ts tests/lib/sp7-role-policy.test.ts tests/lib/role-capabilities.test.ts tests/components tests/pages/nav-role-enforcement.test.tsx tests/api/search.test.ts`, `npm test -- tests/db/rcm-role.test.ts tests/api/rbac-route-gates.test.ts`, each modified test file, `npx tsc --noEmit` → PASS; every existing API/PAGE gate row now also proves `rcm` is denied.
- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/lib/auth.ts src/lib/role-policy.ts src/lib/role-capabilities.ts src/lib/staff-portals.ts src/app/api/users/route.ts src/components/settings/StaffManagementPanel.tsx "src/app/(dashboard)/page.tsx" src/app/login/rcm src/db/seed.ts scripts/migrations/2026-10-07-sp7-a-rcm-role.sql tests
git commit -m "feat(sp7): rcm role across enums, rosters, login door and SP7 role constants"
```

---

### Task 2: Pure constants, status machines, money rules, ageing and SLA

**Files:**
- Create: `src/lib/rcm/constants.ts`, `src/lib/rcm/preauth-status.ts`, `src/lib/rcm/claim-status.ts`, `src/lib/rcm/amounts.ts`, `src/lib/rcm/sla.ts`
- Test: `tests/lib/rcm/status.test.ts`, `tests/lib/rcm/amounts.test.ts`, `tests/lib/rcm/sla.test.ts`

**Interfaces:**
- Consumes: `formatPaise`, `sumPaise` (SP4 `src/lib/billing/amounts.ts`).
- Produces (`constants.ts`; each `as const` with its exported type):
  - `PAYER_KINDS = ['insurer', 'tpa', 'government_scheme', 'corporate']`; `SUBMISSION_CHANNELS = ['portal', 'email', 'nhcx', 'courier', 'hand_delivery']`; `CHANNEL_LABEL` = `{ portal: 'Insurer/TPA portal', email: 'Email', nhcx: 'NHCX', courier: 'Courier', hand_delivery: 'Hand delivery' }`
  - `EMPANELMENT_STATUSES = ['empanelled', 'pending', 'suspended', 'not_empanelled']`
  - `POLICY_TYPES = ['individual', 'family_floater', 'group_corporate', 'government_scheme']`; `POLICY_RELATIONSHIPS = ['self', 'spouse', 'child', 'parent', 'sibling', 'other']`; `POLICY_PRIORITIES = ['primary', 'secondary']`; `POLICY_STATUSES = ['active', 'inactive']`
  - `CLAIM_TYPES = ['ipd', 'daycare', 'opd']`
  - `CLAIM_DOCUMENT_KINDS = ['id_proof', 'policy_card', 'claim_form', 'discharge_summary', 'itemised_bill', 'investigation_reports', 'preauth_approval', 'operation_notes', 'prescription', 'query_response', 'appeal_letter', 'settlement_advice', 'other']`, `CLAIM_DOCUMENT_KIND_LABEL` = `{ id_proof: 'Photo ID proof', policy_card: 'Policy or TPA card', claim_form: 'Claim form', discharge_summary: 'Discharge summary', itemised_bill: 'Itemised final bill', investigation_reports: 'Investigation reports', preauth_approval: 'Pre-authorisation approval letter', operation_notes: 'Operation notes', prescription: 'Prescription', query_response: 'Query response', appeal_letter: 'Appeal letter', settlement_advice: 'Settlement advice', other: 'Other document' }`
  - `ID_PROOF_TYPES = ['pan', 'voter_id', 'passport', 'driving_licence', 'masked_uid', 'other_government_id']`; label `masked_uid: 'Masked UID card (first 8 digits hidden)'` (ruling 9)
  - `DOCUMENT_SOURCES = ['upload', 'invoice', 'lab_report', 'discharge_summary', 'preauth_letter', 'policy_card', 'waiver']`
  - `REASON_CATEGORIES = ['disallowance', 'rejection', 'query', 'write_off']`; `SUBMISSION_KINDS = ['initial', 'query_response', 'appeal', 'resubmission']`; `RCM_QUERY_STATUSES = ['open', 'answered', 'closed']`; `WRITE_OFF_STATUSES = ['requested', 'approved', 'rejected']`
  - `RCM_UPLOAD_MAX_BYTES = 4_000_000`; `RCM_UPLOAD_TYPES = ['application/pdf', 'image/jpeg', 'image/png']`
  - `formatRcmNumber(prefix: 'PA' | 'CLM', istYear: string, value: number): string` → `'CLM-2026-000123'`; `RangeError` for `value < 1` or `> 999_999` or a year not `^\d{4}$`.
- Produces (`preauth-status.ts`):
  - `PREAUTH_STATUSES = ['draft', 'requested', 'queried', 'approved', 'enhancement_requested', 'enhancement_queried', 'enhanced', 'rejected', 'cancelled']`
  - `PREAUTH_ACTIONS = ['request', 'record_query', 'respond_query', 'approve', 'reject', 'request_enhancement', 'approve_enhancement', 'reject_enhancement', 'cancel']`
  - `LIVE_APPROVED_PREAUTH_STATUSES = ['approved', 'enhancement_requested', 'enhancement_queried', 'enhanced']`
  - `nextPreauthStatus(from: PreauthStatus, action: PreauthAction, ctx?: { enhancedBefore: boolean }): PreauthStatus | null`, exactly:
    - `request`: draft → requested · `record_query`: requested → queried, enhancement_requested → enhancement_queried · `respond_query`: queried → requested, enhancement_queried → enhancement_requested
    - `approve`, `reject`: requested | queried → approved / rejected
    - `request_enhancement`: approved | enhanced → enhancement_requested · `approve_enhancement`: enhancement_requested | enhancement_queried → enhanced · `reject_enhancement`: same sources → `ctx.enhancedBefore ? 'enhanced' : 'approved'`
    - `cancel`: every status except rejected and cancelled → cancelled · anything else → null
  - `PREAUTH_STATUS_LABEL: Record<PreauthStatus, string>`
  - `PREAUTH_REFERENCE_STATUSES = ['valid', 'not_found', 'not_approved', 'expired', 'payer_mismatch']`; `preauthReferenceStatus(p: { status: PreauthStatus; payerIds: number[]; validUntil: string | null } | null, ctx: { payerId: number | null; serviceDate: string }): PreauthReferenceStatus` — null → not_found; status not live-approved → not_approved; `ctx.payerId !== null` and not in `payerIds` → payer_mismatch; `validUntil < serviceDate` → expired; else valid (checked in that order).
- Produces (`claim-status.ts`):
  - `CLAIM_STATUSES = ['draft', 'submitted', 'queried', 'approved', 'partially_approved', 'rejected', 'appealed', 'settled', 'closed', 'withdrawn']`
  - `CLAIM_ACTIONS = ['submit', 'record_query', 'respond_query', 'record_approval', 'record_partial_approval', 'record_rejection', 'appeal', 'record_settlement', 'close', 'reopen', 'withdraw']`; `CLAIM_EVENT_ACTIONS = [...CLAIM_ACTIONS, 'note']`; `OUTBOUND_CLAIM_ACTIONS = ['submit', 'respond_query', 'appeal']`
  - `nextClaimStatus(from: ClaimStatus, action: ClaimAction, ctx: { hasSettlement: boolean }): ClaimStatus | null`, exactly:
    - `submit`: draft → submitted · `record_query`: submitted | appealed → queried · `respond_query`: queried → submitted
    - `record_approval` / `record_partial_approval`: submitted | appealed → approved / partially_approved
    - `record_rejection`: submitted | queried | appealed → rejected
    - `appeal`: rejected | partially_approved | settled → appealed
    - `record_settlement`: approved | partially_approved | settled → settled
    - `close`: settled | rejected → closed · `reopen`: closed → `ctx.hasSettlement ? 'settled' : 'rejected'`
    - `withdraw`: draft | submitted | queried → withdrawn · anything else → null
  - `approvalActionFor(claimedPaise: number, approvedPaise: number): 'record_approval' | 'record_partial_approval'` — equal → approval, less → partial.
  - `CLAIM_STATUS_LABEL: Record<ClaimStatus, string>`
  - `CLAIM_WORKLISTS = ['to_submit', 'queried', 'awaiting_insurer', 'to_reconcile', 'denied']`; `claimWorklists(c: { status: ClaimStatus; unreconciledSettlements: number; openDenialPaise: number }): ClaimWorklist[]`: draft → to_submit; queried → queried; submitted | appealed | approved | partially_approved → awaiting_insurer; `unreconciledSettlements > 0` → to_reconcile; rejected, or partially_approved | settled with `openDenialPaise > 0` → denied. A claim may be on several lists, returned in `CLAIM_WORKLISTS` order.
- Produces (`amounts.ts`):
  - `interface DisallowanceInput { reasonCode: string; amountPaise: number; patientRecoverable: boolean }`
  - `approvalProblems(i: { claimedPaise: number; approvedPaise: number; disallowances: DisallowanceInput[] }): string | null` — in order: approved < 0 or not an integer → `Enter the approved amount`; approved > claimed → `The approved amount cannot exceed the claimed amount (<fmt claimed>)`; any disallowance amount < 1 → `Each deduction needs an amount`; Σ disallowances ≠ claimed − approved → `Disallowed amounts must add up to the claimed amount less the approved amount (<fmt gap>)`.
  - `settlementProblems(i: { approvedPaise: number; alreadySettledPaise: number; receivedPaise: number; tdsPaise: number; bankChargesPaise: number }): string | null` — received < 1 → `Enter the amount received`; tds or bank < 0 → `TDS and bank charges cannot be negative`; received + tds + bank > approved − alreadySettled → `Settlement exceeds the approved amount still due (<fmt due>)`.
  - `settlementWarnings(i: same): string[]` — `tds × 10 > received + tds` → `TDS is more than 10% of the gross payment`.
  - `interface ClaimMoney { status: ClaimStatus; claimedPaise: number; approvedPaise: number | null; nonRecoverableDisallowedPaise: number; settledPaise: number; writtenOffPaise: number; pendingWriteOffPaise: number }`
  - `claimCoveredPendingPaise(c: ClaimMoney): number` — the part of the bill neither the patient owes nor is yet credited: 0 for withdrawn, rejected, closed; otherwise `max(0, (approved === null ? claimed : approved + nonRecoverableDisallowed) − settled − writtenOff)` (ruling 5).
  - `insurerOutstandingPaise(c: ClaimMoney): number` — 0 for draft, withdrawn, rejected, closed; else `max(0, (approved ?? claimed) − settled)`.
  - `writeOffCeilingPaise(c: ClaimMoney): number` — 0 when `approvedPaise === null`; else `max(0, nonRecoverableDisallowed + max(0, approved − settled) − writtenOff − pendingWriteOff)`.
  - `closeProblems(c: ClaimMoney & { unreconciledSettlements: number; openQueries: number }): string | null` — in order: pendingWriteOff > 0 → `Decide the pending write-off first`; unreconciledSettlements > 0 → `Reconcile every settlement with the bank first`; openQueries > 0 → `Close the open insurer queries first`; `claimCoveredPendingPaise(c) > 0` → `<fmt> is still due from the insurer or must be written off`.
  - `splitPatientOutstanding(outstandingPaise: number, coveredPendingPaise: number): { coveredPendingPaise: number; patientPayablePaise: number }` — patient payable = `max(0, outstanding − coveredPending)`.
- Produces (`sla.ts`):
  - `AGING_BUCKETS = [{ label: '0-30', min: 0, max: 30 }, { label: '31-60', min: 31, max: 60 }, { label: '61-90', min: 61, max: 90 }, { label: '91-180', min: 91, max: 180 }, { label: '181+', min: 181, max: Infinity }] as const`; `agingBucketLabel(days: number): string` (negative → `'0-30'`)
  - `daysBetweenIso(fromIso: string, toIso: string): number` (calendar days, UTC arithmetic on the date strings)
  - `SLA_FLAGS = ['submission_due_soon', 'submission_overdue', 'query_due_soon', 'query_overdue', 'settlement_overdue', 'preauth_decision_overdue']`
  - `claimSlaFlags(i: { status: ClaimStatus; episodeEndDate: string | null; firstSubmittedOn: string | null; openQueryDueDates: string[]; today: string; payer: { submissionWindowDays: number; claimSettlementSlaDays: number } }): SlaFlag[]`:
    - draft with `episodeEndDate`: `today > end + window` → submission_overdue, else `today >= end + window − 2` → submission_due_soon
    - any due date `< today` → query_overdue, else any due within `[today, today + 2]` → query_due_soon
    - status submitted | queried | approved | partially_approved | appealed with `firstSubmittedOn` and `today > first + settlementSlaDays` → settlement_overdue
    - flags are returned in `SLA_FLAGS` order
  - `preauthDecisionOverdue(i: { status: PreauthStatus; lastRequestedAt: Date | null; now: Date; preauthSlaHours: number }): boolean` — status requested | enhancement_requested and `now − lastRequestedAt > hours`.

- [ ] **Step 1: Write the failing tests**

```ts
// status.test.ts
it('pre-auth walks request, query, response, approval, enhancement', () => {
  expect(nextPreauthStatus('draft', 'request')).toBe('requested'); expect(nextPreauthStatus('requested', 'record_query')).toBe('queried')
  expect(nextPreauthStatus('queried', 'respond_query')).toBe('requested'); expect(nextPreauthStatus('requested', 'approve')).toBe('approved')
  expect(nextPreauthStatus('approved', 'request_enhancement')).toBe('enhancement_requested'); expect(nextPreauthStatus('enhancement_requested', 'record_query')).toBe('enhancement_queried')
  expect(nextPreauthStatus('enhancement_queried', 'approve_enhancement')).toBe('enhanced')
})
it('a rejected enhancement falls back to the last approval', () => {
  expect(nextPreauthStatus('enhancement_requested', 'reject_enhancement', { enhancedBefore: false })).toBe('approved')
  expect(nextPreauthStatus('enhancement_requested', 'reject_enhancement', { enhancedBefore: true })).toBe('enhanced')
})
it('terminal pre-auths refuse every action', () => { for (const a of PREAUTH_ACTIONS) { expect(nextPreauthStatus('rejected', a)).toBeNull(); expect(nextPreauthStatus('cancelled', a)).toBeNull() } })
it('reference status checks in order', () => {
  const p = { status: 'approved' as const, payerIds: [7, 9], validUntil: '2026-10-31' }
  expect(preauthReferenceStatus(null, { payerId: 7, serviceDate: '2026-10-20' })).toBe('not_found')
  expect(preauthReferenceStatus({ ...p, status: 'queried' }, { payerId: 7, serviceDate: '2026-10-20' })).toBe('not_approved')
  expect(preauthReferenceStatus(p, { payerId: 8, serviceDate: '2026-10-20' })).toBe('payer_mismatch')
  expect(preauthReferenceStatus(p, { payerId: 9, serviceDate: '2026-11-01' })).toBe('expired')
  expect(preauthReferenceStatus(p, { payerId: null, serviceDate: '2026-10-31' })).toBe('valid')
})
it('claim happy path, query loop and appeal loop', () => {
  const c = { hasSettlement: false }
  expect(nextClaimStatus('draft', 'submit', c)).toBe('submitted'); expect(nextClaimStatus('submitted', 'record_query', c)).toBe('queried')
  expect(nextClaimStatus('queried', 'respond_query', c)).toBe('submitted'); expect(nextClaimStatus('submitted', 'record_partial_approval', c)).toBe('partially_approved')
  expect(nextClaimStatus('partially_approved', 'appeal', c)).toBe('appealed'); expect(nextClaimStatus('appealed', 'record_approval', c)).toBe('approved')
  expect(nextClaimStatus('approved', 'record_settlement', c)).toBe('settled'); expect(nextClaimStatus('settled', 'close', c)).toBe('closed')
  expect(nextClaimStatus('draft', 'record_settlement', c)).toBeNull(); expect(nextClaimStatus('closed', 'withdraw', c)).toBeNull()
})
it('reopen returns to settled or rejected', () => {
  expect(nextClaimStatus('closed', 'reopen', { hasSettlement: true })).toBe('settled'); expect(nextClaimStatus('closed', 'reopen', { hasSettlement: false })).toBe('rejected')
})
it('approval action follows the amounts', () => { expect(approvalActionFor(100, 100)).toBe('record_approval'); expect(approvalActionFor(100, 60)).toBe('record_partial_approval') })
it('worklists can overlap', () => {
  expect(claimWorklists({ status: 'settled', unreconciledSettlements: 1, openDenialPaise: 500 })).toEqual(['to_reconcile', 'denied'])
  expect(claimWorklists({ status: 'draft', unreconciledSettlements: 0, openDenialPaise: 0 })).toEqual(['to_submit'])
})
it('formats claim numbers', () => { expect(formatRcmNumber('CLM', '2026', 123)).toBe('CLM-2026-000123'); expect(() => formatRcmNumber('PA', '2026', 1_000_000)).toThrow(RangeError) })
// amounts.test.ts
it('approval amounts must reconcile', () => {
  const d = [{ reasonCode: 'NME', amountPaise: 15_000_00, patientRecoverable: true }]
  expect(approvalProblems({ claimedPaise: 100_000_00, approvedPaise: 80_000_00, disallowances: d })).toBe('Disallowed amounts must add up to the claimed amount less the approved amount (₹20,000.00)')
  expect(approvalProblems({ claimedPaise: 100_000_00, approvedPaise: 85_000_00, disallowances: d })).toBeNull()
  expect(approvalProblems({ claimedPaise: 100, approvedPaise: 101, disallowances: [] })).toMatch(/cannot exceed/)
})
it('settlement above the approved amount still due is refused; TDS over 10% warns', () => {
  const s = { approvedPaise: 80_000_00, alreadySettledPaise: 70_000_00, receivedPaise: 9_000_00, tdsPaise: 1_000_00, bankChargesPaise: 1 }
  expect(settlementProblems(s)).toBe('Settlement exceeds the approved amount still due (₹10,000.00)')
  expect(settlementProblems({ ...s, bankChargesPaise: 0 })).toBeNull()
  expect(settlementWarnings({ ...s, receivedPaise: 8_000_00, tdsPaise: 2_000_00, bankChargesPaise: 0 })).toEqual(['TDS is more than 10% of the gross payment'])
})
const M = { status: 'partially_approved' as const, claimedPaise: 100_000_00, approvedPaise: 80_000_00, nonRecoverableDisallowedPaise: 5_000_00, settledPaise: 0, writtenOffPaise: 0, pendingWriteOffPaise: 0 }
it('covered pending excludes the patient-recoverable deduction', () => {
  expect(claimCoveredPendingPaise(M)).toBe(85_000_00); expect(claimCoveredPendingPaise({ ...M, approvedPaise: null, status: 'submitted' })).toBe(100_000_00)
  expect(claimCoveredPendingPaise({ ...M, status: 'rejected' })).toBe(0); expect(splitPatientOutstanding(100_000_00, 85_000_00)).toEqual({ coveredPendingPaise: 85_000_00, patientPayablePaise: 15_000_00 })
})
it('write-off ceiling', () => {
  expect(writeOffCeilingPaise({ ...M, settledPaise: 78_000_00 })).toBe(7_000_00)
  expect(writeOffCeilingPaise({ ...M, settledPaise: 78_000_00, pendingWriteOffPaise: 7_000_00 })).toBe(0); expect(writeOffCeilingPaise({ ...M, approvedPaise: null })).toBe(0)
})
it('close is blocked in order', () => {
  const settled = { ...M, status: 'settled' as const, settledPaise: 80_000_00, unreconciledSettlements: 0, openQueries: 0 }
  expect(closeProblems({ ...settled, unreconciledSettlements: 1 })).toBe('Reconcile every settlement with the bank first')
  expect(closeProblems(settled)).toBe('₹5,000.00 is still due from the insurer or must be written off')
  expect(closeProblems({ ...settled, writtenOffPaise: 5_000_00 })).toBeNull()
})
it('sums past 2^31 exactly', () => { expect(claimCoveredPendingPaise({ ...M, claimedPaise: 3_000_000_000, approvedPaise: null, status: 'submitted' })).toBe(3_000_000_000) })
// sla.test.ts
it('buckets ages', () => { expect(agingBucketLabel(30)).toBe('0-30'); expect(agingBucketLabel(91)).toBe('91-180'); expect(agingBucketLabel(-2)).toBe('0-30'); expect(daysBetweenIso('2026-03-31', '2026-04-01')).toBe(1) })
it('flags submission, query and settlement deadlines', () => {
  const p = { submissionWindowDays: 15, claimSettlementSlaDays: 30 }
  expect(claimSlaFlags({ status: 'draft', episodeEndDate: '2026-10-01', firstSubmittedOn: null, openQueryDueDates: [], today: '2026-10-17', payer: p })).toEqual(['submission_overdue'])
  expect(claimSlaFlags({ status: 'draft', episodeEndDate: '2026-10-01', firstSubmittedOn: null, openQueryDueDates: [], today: '2026-10-14', payer: p })).toEqual(['submission_due_soon'])
  expect(claimSlaFlags({ status: 'queried', episodeEndDate: null, firstSubmittedOn: '2026-09-01', openQueryDueDates: ['2026-10-16'], today: '2026-10-17', payer: p })).toEqual(['query_overdue', 'settlement_overdue'])
})
it('pre-auth decision overdue after the SLA hours', () => {
  expect(preauthDecisionOverdue({ status: 'requested', lastRequestedAt: new Date('2026-10-20T05:00:00Z'), now: new Date('2026-10-20T06:01:00Z'), preauthSlaHours: 1 })).toBe(true)
})
```

- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/lib/rcm` → FAIL (modules missing).
- [ ] **Step 3: Implement** the five modules. No `@/db` or `node:` imports.
- [ ] **Step 4: Verify:** same command + `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/rcm tests/lib/rcm
git commit -m "feat(sp7): pre-auth and claim state machines, money invariants, ageing and SLA flags"
```

---

### Task 3: Pure readiness engine and claim/pre-auth snapshots

**Files:**
- Create: `src/lib/rcm/readiness.ts`, `src/lib/rcm/snapshot.ts`
- Test: `tests/lib/rcm/readiness.test.ts`, `tests/lib/rcm/snapshot.test.ts`

**Interfaces:**
- Consumes: Task 2 constants/types; `type CodeSystemKind` (SP6, `import type`); `type DischargeSummaryData` (SP3, `import type`); `formatPaise`.
- Produces (`readiness.ts`):
  - `DEFAULT_REQUIRED_DOCUMENTS: Record<ClaimType, readonly ClaimDocumentKind[]>`: ipd and daycare `['id_proof', 'policy_card', 'claim_form', 'discharge_summary', 'itemised_bill', 'investigation_reports', 'preauth_approval']`; opd `['id_proof', 'policy_card', 'itemised_bill', 'prescription']`.
  - `requiredDocumentKinds(claimType: ClaimType, overrides: { documentKind: ClaimDocumentKind; required: boolean }[]): ClaimDocumentKind[]` — defaults, plus `required: true` overrides, minus `required: false`, in `CLAIM_DOCUMENT_KINDS` order.
  - `READINESS_CODES = ['no_invoices', 'invoice_not_finalised', 'invoice_cancelled', 'claimed_exceeds_invoice', 'coding_not_finalised', 'policy_inactive', 'policy_expired', 'tpa_not_linked', 'preauth_missing', 'preauth_not_approved', 'preauth_expired', 'claimed_exceeds_preauth', 'sum_insured_exceeded', 'document_missing', 'patient_dob_missing', 'patient_gender_missing', 'abha_missing', 'hospital_ids_missing', 'payer_not_empanelled']`
  - `interface ReadinessItem { code: ReadinessCode; severity: 'block' | 'warn'; message: string; documentKind?: ClaimDocumentKind }`
  - `interface ClaimReadinessInput { claimType: ClaimType; claimedPaise: number; episodeStartDate: string; invoices: { id: number; number: string | null; status: 'draft' | 'finalised' | 'cancelled' | 'discarded'; totalPaise: number | null; claimedPaise: number }[]; coding: { finalised: boolean } | null; policy: { status: 'active' | 'inactive'; validFrom: string; validTo: string; sumInsuredPaise: number | null; hasTpa: boolean }; tpaLinkedToInsurer: boolean; payer: { requiresPreauthForIpd: boolean; requiresAbha: boolean; empanelmentStatus: EmpanelmentStatus }; preauth: { status: PreauthStatus; approvedPaise: number | null; validUntil: string | null } | null; requiredDocuments: ClaimDocumentKind[]; presentDocuments: ClaimDocumentKind[]; patient: { dob: string | null; gender: string | null; hasAbha: boolean }; hospital: { rohiniId: string | null } }`
  - `checkClaimReadiness(input: ClaimReadinessInput): { ready: boolean; items: ReadinessItem[] }` — items in `READINESS_CODES` order, documents in required order; `ready` = no `block` item. Exact rules and messages:

    | code | sev | when | message |
    |---|---|---|---|
    | no_invoices | block | `invoices.length === 0` | `Add at least one finalised invoice` |
    | invoice_not_finalised | block | per invoice with status draft/discarded | `Invoice draft #<id> is not finalised` |
    | invoice_cancelled | block | per cancelled invoice | `Invoice <number> was cancelled by a credit note; remove it from the claim` |
    | claimed_exceeds_invoice | block | per invoice `claimedPaise > totalPaise` | `The amount claimed on <number> is more than its total` |
    | coding_not_finalised | block | `coding === null` or `!coding.finalised` | `Clinical coding for this visit or stay is not finalised` |
    | policy_inactive | block | policy status inactive | `The policy is marked inactive` |
    | policy_expired | block | `episodeStartDate` outside `[validFrom, validTo]` | `The policy was not valid on <formatIsoDate(start)>` |
    | tpa_not_linked | warn | `policy.hasTpa && !tpaLinkedToInsurer` | `This TPA is not recorded as servicing this insurer` |
    | preauth_missing | block | claimType ≠ opd, `payer.requiresPreauthForIpd`, `preauth === null` | `This insurer needs an approved pre-authorisation for inpatient claims` |
    | preauth_not_approved | block | preauth present, status not live-approved | `The linked pre-authorisation is not approved` |
    | preauth_expired | warn | `validUntil < episodeStartDate` | `The pre-authorisation validity ended before admission` |
    | claimed_exceeds_preauth | warn | `claimedPaise > approvedPaise` | `The claim is <fmt diff> more than the pre-authorised amount; request an enhancement or expect a deduction` |
    | sum_insured_exceeded | warn | `sumInsuredPaise !== null && claimedPaise > sumInsuredPaise` | `The claim exceeds the sum insured (<fmt sum>)` |
    | document_missing | block | per required kind not in `presentDocuments` | `Missing document: <CLAIM_DOCUMENT_KIND_LABEL>` |
    | patient_dob_missing / patient_gender_missing | block | null | `The patient's date of birth is missing` / `The patient's gender is missing` |
    | abha_missing | block | `payer.requiresAbha && !patient.hasAbha` | `This payer needs the patient's ABHA number` |
    | hospital_ids_missing | warn | `rohiniId === null` | `Set the hospital ROHINI ID in RCM settings` |
    | payer_not_empanelled | warn | `empanelmentStatus !== 'empanelled'` | `The hospital is not recorded as empanelled with this payer` |
- Produces (`snapshot.ts`; this file never mentions national IDs, Global Constraints):
  - `CLAIM_SNAPSHOT_SCHEMA_VERSION = 1`
  - `interface CodedEntry { kind: CodeSystemKind; code: string; display: string; version: string | null }`; `interface SnapshotDiagnosis extends CodedEntry { sequence: number; type: 'primary' | 'secondary' | 'provisional' }`; `interface SnapshotProcedure extends CodedEntry { sequence: number; performedOn: string }`
  - `interface SnapshotItem { sequence: number; invoiceNumber: string; lineNo: number; itemCode: string; itemName: string; hsnSac: string; serviceDate: string; quantity: number; unitPricePaise: number; taxablePaise: number; taxPaise: number; totalPaise: number }`
  - `interface SnapshotDocument { kind: ClaimDocumentKind; source: DocumentSource; title: string; contentType: string | null; sha256: string | null; waived: boolean }`
  - `interface PayerRef { payerId: number; name: string; kind: PayerKind; irdaiRegistrationNo: string | null; nhcxParticipantCode: string | null }`
  - `interface ClaimSnapshot { schemaVersion: 1; claim: { claimNumber: string; claimType: ClaimType; version: number; kind: SubmissionKind; preparedAt: string }; hospital: { legalName: string; gstin: string | null; stateCode: string | null; rohiniId: string | null; hfrId: string | null }; patient: { id: string; uhid: string | null; name: string; gender: string | null; dob: string | null; abhaNumber: string | null }; policy: { insurer: PayerRef; tpa: PayerRef | null; policyNumber: string; memberId: string; planName: string | null; policyType: PolicyType; holderName: string; relationship: PolicyRelationship; validFrom: string; validTo: string; sumInsuredPaise: number | null; corporateName: string | null }; episode: { admissionId: number | null; encounterId: number | null; startDate: string; endDate: string | null; lengthOfStayDays: number | null; attendingName: string | null; attendingRegistration: string | null; departmentName: string | null }; preauth: { preauthNumber: string; approvalReference: string | null; approvedPaise: number | null; validUntil: string | null } | null; diagnoses: SnapshotDiagnosis[]; procedures: SnapshotProcedure[]; dischargeSummary: { diagnosis: string; notes: string; drugs: string; devices: string; diet: string; followUpDue: string | null } | null; invoices: { number: string; date: string; totalPaise: number; claimedPaise: number }[]; items: SnapshotItem[]; totals: { billedPaise: number; claimedPaise: number }; documents: SnapshotDocument[]; coverNote: string | null; codingFingerprint: string }`
  - `interface ClaimSnapshotSource` = the same fields as raw inputs plus `includeAbha: boolean`, `patientAbhaNumber: string | null` and `discharge: DischargeSummaryData | null`.
  - `buildClaimSnapshot(src: ClaimSnapshotSource): ClaimSnapshot` — picks only the fields above (so a wider source object never leaks), sets `abhaNumber` only when `includeAbha` (formatted with `formatAbhaNumber`), maps `discharge.clinical` and `followUp.dueDate`, sorts diagnoses (primary first, then sequence, then code) and procedures (sequence, performedOn, code), numbers `items` from 1 in invoice then line order, computes totals with `sumPaise`.
  - `interface EstimateLine { serviceId: number; code: string; name: string; quantity: number; unitPricePaise: number; amountPaise: number; priceSource: string }`
  - `interface PreauthSnapshot { schemaVersion: 1; preauthNumber: string; kind: 'initial' | 'enhancement'; preparedAt: string; hospital: ClaimSnapshot['hospital']; patient: ClaimSnapshot['patient']; policy: ClaimSnapshot['policy']; claimType: ClaimType; plannedAdmissionDate: string; expectedLengthOfStayDays: number; treatingDoctorName: string; diagnoses: CodedEntry[]; procedures: CodedEntry[]; provisionalDiagnosisText: string | null; estimate: EstimateLine[]; estimatedPaise: number; requestedPaise: number }`; `buildPreauthSnapshot(src: PreauthSnapshotSource): PreauthSnapshot` (same picking and ABHA rule).
  - `canonicalJson(value: unknown): string` — object keys sorted recursively, arrays in order, no whitespace; throws `TypeError` on `undefined` values, functions, `NaN`/`Infinity`, `bigint`.
  - `codingFingerprintSource(dx: SnapshotDiagnosis[], px: SnapshotProcedure[]): string` — `canonicalJson` of `[sorted 'kind:code:type', sorted 'kind:code:performedOn']`.
  - Header comment: the SP8 mapping — `ClaimSnapshot` → FHIR R4 `Claim` (`use = claim`), `PreauthSnapshot` → `Claim` (`use = preauthorization`): `patient` → Patient, `policy` → Coverage (`subscriberId = memberId`, `payor` = insurer/TPA Organization by `nhcxParticipantCode`), `hospital` → provider Organization (ROHINI/HFR identifiers), `diagnoses` → `Claim.diagnosis`, `procedures` → `Claim.procedure`, `items` → `Claim.item` (`unitPrice`/`net` in INR from paise), `totals.claimedPaise` → `Claim.total`, `preauth.approvalReference` → `Claim.insurance.preAuthRef`, `documents` → `Claim.supportingInfo` (attachment hash = `sha256`).

- [ ] **Step 1: Write the failing tests**

```ts
// readiness.test.ts — READY is a fully satisfied ipd input
it('a complete ipd claim is ready', () => { expect(checkClaimReadiness(READY)).toEqual({ ready: true, items: [] }) })
it('each missing required document blocks with its label', () => {
  const r = checkClaimReadiness({ ...READY, presentDocuments: READY.presentDocuments.filter((k) => k !== 'discharge_summary' && k !== 'claim_form') })
  expect(r.ready).toBe(false); expect(r.items.map((i) => i.message)).toEqual(['Missing document: Claim form', 'Missing document: Discharge summary'])
})
it('a cancelled invoice and unfinalised coding block', () => {
  const r = checkClaimReadiness({ ...READY, coding: { finalised: false }, invoices: [{ ...READY.invoices[0], status: 'cancelled' }] })
  expect(r.items.map((i) => i.code)).toEqual(['invoice_cancelled', 'coding_not_finalised'])
})
it('pre-auth: missing blocks for ipd only; over the approval warns', () => {
  expect(checkClaimReadiness({ ...READY, preauth: null }).items[0].code).toBe('preauth_missing')
  expect(checkClaimReadiness({ ...READY, claimType: 'opd', preauth: null, requiredDocuments: [...DEFAULT_REQUIRED_DOCUMENTS.opd], presentDocuments: [...DEFAULT_REQUIRED_DOCUMENTS.opd] }).ready).toBe(true)
  const over = checkClaimReadiness({ ...READY, claimedPaise: 1_20_000_00, preauth: { status: 'approved', approvedPaise: 1_00_000_00, validUntil: '2099-12-31' } })
  expect(over.ready).toBe(true); expect(over.items[0].message).toBe('The claim is ₹20,000.00 more than the pre-authorised amount; request an enhancement or expect a deduction')
})
it('policy validity is checked on the episode start date', () => { expect(checkClaimReadiness({ ...READY, policy: { ...READY.policy, validTo: '2026-09-30' }, episodeStartDate: '2026-10-01' }).items[0].message).toBe('The policy was not valid on 1 Oct 2026') })
it('per-payer overrides add and remove required documents', () => {
  expect(requiredDocumentKinds('opd', [{ documentKind: 'claim_form', required: true }, { documentKind: 'prescription', required: false }])).toEqual(['id_proof', 'policy_card', 'claim_form', 'itemised_bill'])
})
// snapshot.test.ts
it('canonical JSON is key-order independent and refuses undefined', () => {
  expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe('{"a":{"c":null,"d":[2,1]},"b":1}')
  expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 })); expect(() => canonicalJson({ a: undefined })).toThrow(TypeError)
})
it('ABHA only when the payer requires it', () => {
  expect(buildClaimSnapshot({ ...SRC, includeAbha: false }).patient.abhaNumber).toBeNull()
  expect(buildClaimSnapshot({ ...SRC, includeAbha: true }).patient.abhaNumber).toBe('91-1234-5678-9012')
})
it('the snapshot carries no contact or address keys even from a wide source', () => {
  const s = JSON.stringify(buildClaimSnapshot({ ...SRC, patient: { ...SRC.patient, phone: '+919845013210', email: 'x@y.in', address: '1 MG Road' } as never }))
  expect(s).not.toMatch(/phone|email|address|9845013210/i)
})
it('orders diagnoses primary first and numbers items across invoices', () => {
  const s = buildClaimSnapshot(SRC); expect(s.diagnoses[0].type).toBe('primary'); expect(s.items.map((i) => i.sequence)).toEqual([1, 2, 3])
  expect(s.totals.claimedPaise).toBe(SRC.invoices.reduce((a, i) => a + i.claimedPaise, 0))
})
it('coding fingerprint ignores order but not content', () => {
  expect(codingFingerprintSource(DX, PX)).toBe(codingFingerprintSource([...DX].reverse(), PX))
  expect(codingFingerprintSource(DX, PX)).not.toBe(codingFingerprintSource(DX.slice(1), PX))
})
```

- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/lib/rcm/readiness.test.ts tests/lib/rcm/snapshot.test.ts` → FAIL.
- [ ] **Step 3: Implement** both modules (pure; `formatIsoDate` and `formatAbhaNumber` are pure helpers and may be imported).
- [ ] **Step 4: Verify:** same + `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/rcm/readiness.ts src/lib/rcm/snapshot.ts tests/lib/rcm
git commit -m "feat(sp7): claim readiness engine and NHCX-ready claim and pre-auth snapshots"
```

---

### Task 4: Request schemas, error catalogue, identifier guard and the `ClaimGateway`

**Files:**
- Create: `src/lib/rcm/validation.ts`, `src/lib/rcm/errors.ts`, `src/lib/rcm/identifier-guard.ts`, `src/lib/rcm/gateway.ts`
- Test: `tests/lib/rcm/validation.test.ts`, `tests/lib/rcm/errors.test.ts`, `tests/lib/rcm/gateway.test.ts`

**Interfaces:**
- Consumes: Task 2/3; `isoDateSchema` (SP3); `isValidGstin`, `paymentReferenceProblem`, `MAX_DOCUMENT_PAISE` (SP4); `isIndianStateCode`; `containsAadhaarLike` (identifier-guard only).
- Produces (`identifier-guard.ts`): `looksLikeNationalId(text: string): boolean` = `containsAadhaarLike(text)`; `NATIONAL_ID_MESSAGE = 'This looks like a national ID number; enter the policy or card number instead'`.
- Produces (`validation.ts`; every object `.strict()`; `paise` = int 0..`MAX_DOCUMENT_PAISE`; `positivePaise` = int 1..`MAX_DOCUMENT_PAISE`; types exported via `z.infer` with the names in brackets):
  - `payerProfileSchema` [`PayerProfileInput`]: `{ kind, shortName?: trim 1..40, irdaiRegistrationNo?: /^[0-9A-Z/-]{1,30}$/, nhcxParticipantCode?: trim 1..100, defaultChannel, portalUrl?: https URL ≤ 300, claimsEmail?: email, empanelmentStatus, empanelledFrom?: isoDate, empanelledTo?: isoDate, agreementReference?: trim ≤ 80, preauthSlaHours: int 1..720, claimSettlementSlaDays: int 1..365, queryResponseDays: int 1..90, submissionWindowDays: int 1..365, requiresAbha: boolean, requiresPreauthForIpd: boolean, active: boolean, notes?: trim ≤ 1000, gstin?: (isValidGstin, 'Enter a valid 15-character GSTIN') | null, stateCode?: (isIndianStateCode) | null }`; refinement `empanelledTo >= empanelledFrom`.
  - `payerCreateSchema` [`PayerCreateInput`] = `payerProfileSchema.extend({ name: trim 2..200, code: /^[A-Z0-9-]{2,30}$/ })`
  - `payerContactsSchema = { contacts: { name: trim 1..120, designation?: trim ≤ 80, phone?: trim ≤ 20, email?: email, isEscalation: boolean }[] max 20 }`; `payerNetworkSchema = { tpaPayerIds: positive int[] max 50, unique }`; `documentRequirementsSchema = { claimType, entries: { documentKind, required: boolean }[] max 13, unique kind }`
  - `rcmSettingsSchema = { rohiniId: /^\d{13}$/ ('The ROHINI ID has 13 digits') | null, hfrId: /^IN\d{10}$/ ('The HFR facility ID looks like IN followed by 10 digits') | null }`
  - `policySchema` [`PolicyInput`]: `{ patientId: trim 1..40, insurerPayerId: positive int, tpaPayerId?: positive int | null, policyNumber: /^[A-Za-z0-9/-]{1,40}$/, memberId: /^[A-Za-z0-9/-]{1,40}$/, planName?: trim ≤ 120, policyType, corporateName?: trim ≤ 200, employeeId?: trim ≤ 40, holderName: trim 1..200, relationship, validFrom, validTo, sumInsuredPaise?: paise | null, copayBp?: int 0..10000 | null, roomRentLimitPaise?: paise | null, priority, status? (default 'active') }`. Refinements, in order: `validTo >= validFrom` (`The policy end date is before its start`); `group_corporate` needs `corporateName` (`Enter the employer for a corporate policy`); `looksLikeNationalId(policyNumber)` or `(memberId)` → `NATIONAL_ID_MESSAGE` (paths `policyNumber` / `memberId`). `policyPatchSchema` [`PolicyPatchInput`] = every field optional except `patientId` (omitted), at least one key, same refinements where both dates are present.
  - `preauthCreateSchema` [`PreauthCreateInput`]: `{ policyId: positive int, claimType, admissionId?: positive int, encounterId?: positive int, plannedAdmissionDate: isoDate, expectedLengthOfStayDays: int 1..365, treatingProviderId: positive int, diagnosisCodeIds: positive int[] max 10, procedureCodeIds: positive int[] max 10, provisionalDiagnosisText?: trim ≤ 500, estimate: { serviceId: positive int, quantity: int 1..1000 }[] 1..50, requestedPaise?: positivePaise, roomCategoryCode?: trim 1..20 }`; refinement: opd ⇒ no admissionId; at least one diagnosis code or text (`Give a provisional diagnosis or a diagnosis code`).
  - `preauthEstimateSchema = preauthCreateSchema.pick({ policyId, estimate, roomCategoryCode, plannedAdmissionDate })`
  - `preauthActionSchema` [`PreauthActionRequest`] = `z.discriminatedUnion('action', [ { action: 'request' }, { action: 'record_query', question: trim 1..2000, raisedOn: isoDate, dueOn: isoDate }, { action: 'respond_query', queryId: positive int, body: trim 1..2000, respondedOn: isoDate }, { action: 'approve', approvedPaise: positivePaise, approvalReference: /^[A-Za-z0-9/-]{1,40}$/, validUntil: isoDate, decidedOn: isoDate }, { action: 'reject', reasonCode: /^[A-Z0-9_]{2,16}$/, note?: trim ≤ 1000, decidedOn: isoDate }, { action: 'request_enhancement', requestedPaise: positivePaise, note: trim 5..1000 }, { action: 'approve_enhancement', approvedPaise: positivePaise, validUntil: isoDate, approvalReference?: same pattern, decidedOn: isoDate }, { action: 'reject_enhancement', reasonCode, note?, decidedOn }, { action: 'cancel', note: trim 5..500 } ])`; `dueOn >= raisedOn`, `validUntil >= decidedOn`.
  - `claimCreateSchema` [`ClaimCreateInput`]: `{ policyId, claimType, admissionId?, encounterId?, preauthId?: positive int, invoices: { invoiceId: positive int, claimedPaise?: positivePaise }[] 1..20 unique }`; refinement: opd ⇔ encounterId and no admissionId (`An OPD claim is for a visit; an inpatient or daycare claim is for an admission`).
  - `claimInvoicesSchema = claimCreateSchema.pick({ invoices })`
  - `claimDocumentMetaSchema` [`ClaimDocumentMeta`] (multipart fields): `{ kind, title: trim 1..120, idProofType?: z.enum(ID_PROOF_TYPES), maskedConfirmed?: 'true' }` — `id_proof` needs `idProofType`; `masked_uid` needs `maskedConfirmed === 'true'` (`Confirm the first 8 digits are hidden`).
  - `attachLabReportSchema = { labReportId: positive int }`; `waiveDocumentSchema = { kind, reason: trim 5..300 }`
  - `claimSubmitSchema` [`ClaimSubmitRequest`] = `z.discriminatedUnion('action', [ { action: 'submit', channel, trackingReference?: trim 1..80, coverNote?: trim ≤ 2000 }, { action: 'respond_query', queryId, body: trim 1..2000, channel, trackingReference?, respondedOn: isoDate }, { action: 'appeal', appealKind: z.enum(['appeal', 'resubmission']), grounds: trim 10..2000, channel, trackingReference? } ])`
  - `claimUpdateSchema` [`ClaimUpdateRequest`] = `z.discriminatedUnion('action', [ { action: 'record_query', question, raisedOn, dueOn, insurerClaimReference?: trim 1..80 }, { action: 'record_decision', approvedPaise: positivePaise, decidedOn, disallowances: { reasonCode, amountPaise: positivePaise, patientRecoverable: boolean, note?: trim ≤ 500 }[] max 30, insurerClaimReference? }, { action: 'record_rejection', decidedOn, reasonCode, patientRecoverable: boolean, note? }, { action: 'close' }, { action: 'reopen', reason: trim 5..500 }, { action: 'withdraw', reason: trim 5..500 }, { action: 'note', note: trim 1..1000, portalCheckedOn: isoDate } ])`
  - `settlementSchema` [`SettlementInput`] `{ utr: trim 6..40, paymentDate: isoDate, receivedPaise: positivePaise, tdsPaise: paise, bankChargesPaise: paise }`, refined with `paymentReferenceProblem('neft', utr)` (path `utr`); `reconcileSchema = { bankCreditDate: isoDate }`; `acknowledgeSchema = { insurerReference: trim 1..80, acknowledgedOn: isoDate }`
  - `writeOffRequestSchema = { amountPaise: positivePaise, reasonCode, note: trim 5..500 }`; `writeOffDecisionSchema = { decision: z.enum(['approve', 'reject']), note?: trim ≤ 500 }`
- Produces (`errors.ts`):
  - `RCM_ERRORS` (as const) = `claim_not_found, preauth_not_found, policy_not_found, payer_not_found, patient_not_found, query_not_found, document_not_found, settlement_not_found, write_off_not_found, dispatch_not_found, submission_not_found, invalid_transition, stale, not_draft, invoice_unavailable, invoice_over_claimed, not_ready, preauth_unavailable, preauth_in_use, primary_exists, payer_kind_invalid, payer_inactive, context_mismatch, code_not_found, service_not_found, price_unresolved, duplicate_reference, duplicate_utr, amounts_invalid, write_off_exceeds, same_approver, no_user_account, close_blocked, gateway_not_configured, already_acknowledged, already_reconciled, already_decided, query_closed, upload_invalid, lab_report_unavailable`; `type RcmWriteError`
  - `type RcmWriteResult<T> = { ok: true; value: T } | { ok: false; error: RcmWriteError; message?: string; items?: ReadinessItem[] }` — `message` overrides the catalogue text for computed messages (amount problems, readiness).
  - `RCM_ERROR_STATUS: Record<RcmWriteError, 400 | 403 | 404 | 409 | 422>`: 404 for every `*_not_found`; 403 `same_approver`, `no_user_account`; 422 `not_ready`, `amounts_invalid`, `write_off_exceeds`, `price_unresolved`; 400 `payer_kind_invalid`, `context_mismatch`, `code_not_found`, `service_not_found`, `upload_invalid`; 409 the rest.
  - `RCM_ERROR_MESSAGE: Record<RcmWriteError, string>`, verbatim: claim_not_found `'Claim not found'`; preauth_not_found `'Pre-authorisation not found'`; policy_not_found `'Policy not found'`; payer_not_found `'Insurer or TPA not found'`; patient_not_found `'Patient not found'`; query_not_found `'Query not found'`; document_not_found `'Document not found'`; settlement_not_found `'Settlement not found'`; write_off_not_found `'Write-off not found'`; dispatch_not_found `'Dispatch record not found'`; submission_not_found `'Submission not found'`; invalid_transition `'That step is not possible from the current status'`; stale `'The claim changed while its copy was being prepared; please try again'`; not_draft `'Only a draft claim can be changed'`; invoice_unavailable `'That invoice is not a finalised bill of this visit or stay for this payer'`; invoice_over_claimed `'This invoice is already claimed up to its total'`; not_ready `'This claim is not ready to submit'`; preauth_unavailable `'That pre-authorisation is not an approved one for this patient and policy'`; preauth_in_use `'This pre-authorisation is on a submitted claim'`; primary_exists `'This patient already has an active primary policy'`; payer_kind_invalid `'Choose an insurer for the insurer field and a TPA for the TPA field'`; payer_inactive `'This insurer or TPA is marked inactive'`; context_mismatch `'That admission or visit is not this patient\'s'`; code_not_found `'Code not found in any loaded code set'`; service_not_found `'Service not found'`; price_unresolved `'No tariff rate covers one of the services'`; duplicate_reference `'This approval reference is already recorded for another pre-authorisation of this insurer'`; duplicate_utr `'This UTR is already recorded on this claim'`; amounts_invalid `'The amounts do not add up'`; write_off_exceeds `'The write-off is more than what is still open on this claim'`; same_approver `'A write-off must be approved by someone other than the person who requested it'`; no_user_account `'Your login has no staff account, so it cannot approve write-offs'`; close_blocked `'This claim cannot be closed yet'`; gateway_not_configured `'NHCX is not connected yet; submit through the insurer portal or email and record it'`; already_acknowledged `'The insurer reference is already recorded'`; already_reconciled `'This settlement is already reconciled'`; already_decided `'This write-off is already decided'`; query_closed `'This query is already answered or closed'`; upload_invalid `'Upload a PDF, JPEG or PNG file of at most 4 MB'`; lab_report_unavailable `'That lab report is not this patient\'s current report'`
- Produces (`gateway.ts`):
  ```ts
  export interface SubmissionPackage { claimNumber: string; version: number; kind: SubmissionKind; snapshot: ClaimSnapshot; insurerCopySha256: string; trackingReference: string | null }
  export type GatewaySubmitResult = { ok: true; transport: 'manual' | 'nhcx'; trackingReference: string | null } | { ok: false; error: 'not_configured' | 'rejected'; message: string }
  export interface ClaimGateway { readonly channel: SubmissionChannel; status(): { configured: boolean; label: string }; submit(pkg: SubmissionPackage): Promise<GatewaySubmitResult> }
  export function manualGateway(channel: Exclude<SubmissionChannel, 'nhcx'>): ClaimGateway
  export const nhcxGatewayStub: ClaimGateway
  export function getClaimGateway(channel: SubmissionChannel, registry?: Partial<Record<SubmissionChannel, ClaimGateway>>): ClaimGateway
  ```
  - `manualGateway`: `status()` → `{ configured: true, label: \`Recorded manually (${CHANNEL_LABEL[channel]})\` }`; `submit` → `{ ok: true, transport: 'manual', trackingReference: pkg.trackingReference }`.
  - `nhcxGatewayStub`: `status()` → `{ configured: false, label: 'NHCX not connected (planned)' }`; `submit` → `{ ok: false, error: 'not_configured', message: RCM_ERROR_MESSAGE.gateway_not_configured }`. No mock here: spec §3 "No fake data in production"; SP8 registers the real and env-flagged mock adapters through `registry`.
  - `getClaimGateway`: `registry?.[channel]` when given, else `nhcx` → stub, others → `manualGateway(channel)`.

- [ ] **Step 1: Write the failing tests**

```ts
// validation.test.ts
it('refuses an Aadhaar-like policy or member number', () => {
  const r = policySchema.safeParse({ ...POLICY, memberId: '234123412346' /* Verhoeff-valid test vector */ })
  expect(r.success).toBe(false); expect(r.error!.issues[0]).toMatchObject({ path: ['memberId'], message: NATIONAL_ID_MESSAGE })
  expect(policySchema.safeParse(POLICY).success).toBe(true)
})
it('a corporate policy needs the employer, and dates must be ordered', () => {
  expect(policySchema.safeParse({ ...POLICY, policyType: 'group_corporate' }).error!.issues[0].message).toBe('Enter the employer for a corporate policy')
  expect(policySchema.safeParse({ ...POLICY, validFrom: '2026-10-02', validTo: '2026-10-01' }).error!.issues[0].message).toBe('The policy end date is before its start')
})
it('a UTR that is a card number is refused', () => { expect(settlementSchema.safeParse({ utr: '4111 1111 1111 1111', paymentDate: '2026-10-20', receivedPaise: 1, tdsPaise: 0, bankChargesPaise: 0 }).success).toBe(false) })
it('an OPD claim is for a visit', () => { expect(claimCreateSchema.safeParse({ policyId: 1, claimType: 'opd', admissionId: 3, invoices: [{ invoiceId: 1 }] }).success).toBe(false) })
it('a masked UID needs the confirmation; schemas are strict', () => {
  expect(claimDocumentMetaSchema.safeParse({ kind: 'id_proof', title: 'ID', idProofType: 'masked_uid' }).success).toBe(false)
  expect(claimUpdateSchema.safeParse({ action: 'close', extra: 1 }).success).toBe(false)
})
it('ROHINI and HFR formats', () => { expect(rcmSettingsSchema.safeParse({ rohiniId: '8900080123456', hfrId: 'IN2910000123' }).success).toBe(true); expect(rcmSettingsSchema.safeParse({ rohiniId: '123', hfrId: null }).success).toBe(false) })
// errors.test.ts
it('every error has a status and a message', () => { for (const e of RCM_ERRORS) { expect(RCM_ERROR_STATUS[e]).toBeDefined(); expect(RCM_ERROR_MESSAGE[e].length).toBeGreaterThan(5) } })
// gateway.test.ts
it('manual channels record the tracking reference', async () => {
  const g = getClaimGateway('portal'); expect(g.status().configured).toBe(true)
  expect(await g.submit({ ...PKG, trackingReference: 'TPA/77' })).toEqual({ ok: true, transport: 'manual', trackingReference: 'TPA/77' })
})
it('NHCX is not configured and never fakes a submission', async () => {
  expect(getClaimGateway('nhcx').status()).toEqual({ configured: false, label: 'NHCX not connected (planned)' })
  expect(await getClaimGateway('nhcx').submit(PKG)).toMatchObject({ ok: false, error: 'not_configured' })
})
it('a registry adapter replaces the stub', () => { const fake = { ...nhcxGatewayStub, status: () => ({ configured: true, label: 'x' }) }; expect(getClaimGateway('nhcx', { nhcx: fake })).toBe(fake) })
```

- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/lib/rcm/validation.test.ts tests/lib/rcm/errors.test.ts tests/lib/rcm/gateway.test.ts` → FAIL.
- [ ] **Step 3: Implement** the four modules.
- [ ] **Step 4: Verify:** same + `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/rcm tests/lib/rcm
git commit -m "feat(sp7): RCM request schemas, error catalogue, national-ID guard and ClaimGateway"
```

---

### Task 5: Schema B — payer profiles, networks, contacts, requirements, reason codes, patient policies

**Files:**
- Modify: `src/db/schema.ts` (`// SP7` block after the SP6 block; `billingSettings` gains two columns), `src/db/seed.ts` (`clearExistingData`: delete `patientPolicies` before `patients`, `payerDocumentRequirements`, `payerContacts`, `payerNetworks`, `payerProfiles` before `payers`; reason codes are reference data and not cleared), `src/lib/queries/patients.ts` `deletePatient` (delete the patient's `patient_policies` before the patient row)
- Create: `scripts/migrations/2026-10-07-sp7-b-payers-policies.sql`
- Test: `tests/db/sp7-payers-policies-schema.test.ts`

**Interfaces:**
- Consumes: Task 2 constants (the test asserts each pgEnum equals them).
- Produces (schema, exact):
  - Enums: `payerKindEnum('payer_kind', PAYER_KINDS)`, `submissionChannelEnum('claim_submission_channel', SUBMISSION_CHANNELS)`, `empanelmentStatusEnum('empanelment_status', …)`, `policyTypeEnum('policy_type', …)`, `policyRelationshipEnum('policy_relationship', …)`, `policyPriorityEnum('policy_priority', …)`, `policyStatusEnum('policy_status', …)`, `claimTypeEnum('claim_type', CLAIM_TYPES)`, `claimDocumentKindEnum('claim_document_kind', CLAIM_DOCUMENT_KINDS)`, `rcmReasonCategoryEnum('rcm_reason_category', REASON_CATEGORIES)`.
  - `payerProfiles` (`payer_profiles`): `payerId integer PK → payers`, `kind not null`, `shortName`, `irdaiRegistrationNo`, `nhcxParticipantCode`, `defaultChannel default 'portal' not null`, `portalUrl`, `claimsEmail`, `empanelmentStatus default 'pending' not null`, `empanelledFrom date`, `empanelledTo date`, `agreementReference`, `preauthSlaHours int default 1 not null`, `claimSettlementSlaDays int default 30 not null`, `queryResponseDays int default 7 not null`, `submissionWindowDays int default 15 not null`, `requiresAbha boolean default false not null`, `requiresPreauthForIpd boolean default true not null`, `active boolean default true not null`, `notes`, `updatedAt defaultNow not null`, `updatedByName text not null`. Checks `payer_profiles_sla_ranges` (hours 1..720, settlement 1..365, query 1..90, window 1..365), `payer_profiles_empanelment_dates` (`empanelled_to IS NULL OR empanelled_from IS NULL OR empanelled_to >= empanelled_from`). GSTIN and state stay on `payers` (SP4 columns).
  - `payerNetworks` (`payer_networks`): `id serial`, `insurerPayerId not null → payers`, `tpaPayerId not null → payers`, `createdByName not null`, `createdAt`; `uniqueIndex('payer_networks_pair_unique').on(insurerPayerId, tpaPayerId)`.
  - `payerContacts` (`payer_contacts`): `id`, `payerId not null → payers`, `name not null`, `designation`, `phone`, `email`, `isEscalation boolean default false not null`, `createdAt`; `index('payer_contacts_payer_idx')`.
  - `payerDocumentRequirements` (`payer_document_requirements`): `id`, `payerId not null → payers`, `claimType not null`, `documentKind not null`, `required boolean not null`, `updatedByName not null`, `updatedAt`; `uniqueIndex('payer_document_requirements_unique').on(payerId, claimType, documentKind)`.
  - `rcmReasonCodes` (`rcm_reason_codes`): `code text PK`, `label not null`, `category not null`, `patientRecoverableDefault boolean not null`, `active boolean default true not null`, `sortOrder int not null`; check `rcm_reason_codes_code_format` (`code ~ '^[A-Z0-9_]{2,16}$'`). Migration seeds, `ON CONFLICT (code) DO NOTHING`, exactly: `NME` 'Non-medical expenses not payable' disallowance true 10; `RRP` 'Proportionate deduction for room rent above eligibility' disallowance true 20; `COPAY` 'Co-payment as per policy' disallowance true 30; `SUBLIMIT` 'Sub-limit or capping exceeded' disallowance true 40; `TARIFF` 'Charged above the agreed tariff or package rate' disallowance false 50; `EXCL` 'Policy exclusion' rejection true 60; `PED` 'Pre-existing disease waiting period' rejection true 70; `WAIT` 'Initial waiting period' rejection true 80; `NONDISC` 'Non-disclosure' rejection true 90; `LATE` 'Late intimation or submission' rejection false 100; `DUP` 'Duplicate claim' rejection false 110; `DOCS` 'Documents incomplete' query false 120; `CLARIFY` 'Clinical clarification needed' query false 130; `SHORTPAY` 'Short payment by the insurer' write_off false 140; `BANK` 'Bank charges' write_off false 150; `ABSORB` 'Deduction absorbed by the hospital' write_off false 160; `OTHER` 'Other' disallowance false 999.
  - `patientPolicies` (`patient_policies`): `id`, `patientId not null → patients`, `insurerPayerId not null → payers`, `tpaPayerId → payers`, `policyNumber not null`, `memberId not null`, `planName`, `policyType not null`, `corporateName`, `employeeId`, `holderName not null`, `relationship not null`, `validFrom date not null`, `validTo date not null`, `sumInsuredPaise bigint`, `copayBp int`, `roomRentLimitPaise bigint`, `priority default 'primary' not null`, `status default 'active' not null`, `cardFrontBlobUrl`, `cardFrontSha256`, `cardBackBlobUrl`, `cardBackSha256`, `createdByName not null`, `createdAt`, `updatedAt`, `updatedByName`. Config: `index('patient_policies_patient_idx')`, `uniqueIndex('patient_policies_one_active_primary').on(patientId).where(sql\`status = 'active' AND priority = 'primary'\`)`, checks `patient_policies_dates` (`valid_to >= valid_from`), `patient_policies_amounts` (sum insured and room limit null or 0..1e12; copay null or 0..10000), `patient_policies_card_pairs` (`(card_front_blob_url IS NULL) = (card_front_sha256 IS NULL) AND (card_back_blob_url IS NULL) = (card_back_sha256 IS NULL)`).
  - `billingSettings` + `rohiniId: text('rohini_id')`, `hfrId: text('hfr_id')` (migration `ADD COLUMN IF NOT EXISTS`).
  - Types: `PayerProfileRow`, `PayerNetworkRow`, `PayerContactRow`, `PayerDocumentRequirementRow`, `RcmReasonCodeRow`, `PatientPolicyRow`.

- [ ] **Step 1: Write the failing tests**

```ts
const M = '2026-10-07-sp7-b-payers-policies.sql'
it('migration B is idempotent and declares every column', () => {
  const s = readMigration(M); expect(idempotencyProblems(s)).toEqual([])
  for (const t of [payerProfiles, payerNetworks, payerContacts, payerDocumentRequirements, rcmReasonCodes, patientPolicies]) expect(missingColumns(t, s)).toEqual([])
  for (const c of ['rohini_id', 'hfr_id']) expect(s).toContain(c)
  expect(s).not.toMatch(/\bUPDATE\s+(payers|patients)\b/i)
})
it('pins every named constraint and seeds every reason code', () => {
  const s = readMigration(M)
  for (const n of ['patient_policies_one_active_primary', 'patient_policies_card_pairs', 'payer_networks_pair_unique', 'payer_document_requirements_unique', 'rcm_reason_codes_code_format', 'payer_profiles_sla_ranges']) expect(s).toContain(n)
  for (const c of ['NME', 'RRP', 'COPAY', 'TARIFF', 'EXCL', 'PED', 'SHORTPAY', 'BANK', 'ABSORB', 'OTHER']) expect(s).toMatch(new RegExp(`'${c}'`))
})
it('pgEnum values match the pure constants', () => { expect(payerKindEnum.enumValues).toEqual([...PAYER_KINDS]); expect(claimDocumentKindEnum.enumValues).toEqual([...CLAIM_DOCUMENT_KINDS]) /* … each enum */ })
describe.skipIf(!process.env.DATABASE_URL)('payers and policies (DB)', () => {
  it('allows one active primary policy per patient', async () => { /* second active primary → isUniqueViolation(err, 'patient_policies_one_active_primary'); a secondary inserts */ })
  it('a legacy payer row without a profile still reads and prices', async () => { /* listPayers() still returns it; payer_profiles has no row */ })
  it('stores a sum insured above 2^31', async () => { /* 5_00_00_000_00 reads back as a number */ })
})
```

- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/db/sp7-payers-policies-schema.test.ts` → FAIL.
- [ ] **Step 3: Implement** the schema, the migration, the seed and `deletePatient` edits.
- [ ] **Step 4: Apply twice, then verify:** docker command on migration B twice (both `COMMIT`). Then `npm test -- tests/db/sp7-payers-policies-schema.test.ts tests/lib/queries/delete-patient-fk-guard.test.ts tests/db/seed-clear-existing-data-fk-order.test.ts tests/lib/queries/payers.test.ts` + `npx vitest run tests/db/schema.test.ts` + `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/db/seed.ts src/lib/queries/patients.ts scripts/migrations/2026-10-07-sp7-b-payers-policies.sql tests/db/sp7-payers-policies-schema.test.ts
git commit -m "feat(sp7): payer profiles, networks, contacts, document requirements, reason codes and patient policies schema"
```

---

### Task 6: Schema C — pre-auths, queries, claims, versions, dispatches, events, settlements, write-offs, immutability

**Files:**
- Modify: `src/db/schema.ts` (`// SP7` block; `chargeLines` + `preauthId`), `src/db/seed.ts` (`clearExistingData`: in the SP4 purge transaction, delete the SP7 tables in the `purgeRcmFixtures` order before `charge_lines`), `src/lib/queries/patients.ts` `deletePatient` (ruling 11)
- Create: `scripts/migrations/2026-10-07-sp7-c-preauth-claims.sql`, `src/lib/queries/billing-lock.ts`, `tests/db/rcm-fixtures.ts`
- Test: `tests/db/sp7-claims-schema.test.ts`, `tests/lib/queries/delete-patient-claims.test.ts` (DB)

**Interfaces:**
- Consumes: Task 2 constants; Task 5 enums and tables; SP4 `invoices`, `chargeLines`, `PatientHasFinancialRecordsError`; SP5 `labReports`.
- Produces (`billing-lock.ts`): `lockPatientBilling(executor: WriteExecutor, patientId: string): Promise<void>` — `select pg_advisory_xact_lock(hashtext('billing:patient:' || ${patientId}))`, byte-for-byte the SP4 key.
- Produces (schema):
  - Enums: `preauthStatusEnum('preauth_status', PREAUTH_STATUSES)`, `preauthActionEnum('preauth_action', PREAUTH_ACTIONS)`, `claimStatusEnum('claim_status', CLAIM_STATUSES)`, `claimEventActionEnum('claim_event_action', CLAIM_EVENT_ACTIONS)`, `submissionKindEnum('claim_submission_kind', SUBMISSION_KINDS)`, `rcmQueryStatusEnum('rcm_query_status', …)`, `writeOffStatusEnum('claim_write_off_status', …)`, `documentSourceEnum('claim_document_source', DOCUMENT_SOURCES)`.
  - Sequences: `preauthNumberSeq = pgSequence('preauth_number_seq')`, `claimNumberSeq = pgSequence('claim_number_seq')`.
  - `preauths`: `id`, `preauthNumber text not null unique`, `patientId not null`, `policyId not null → patientPolicies`, `insurerPayerId not null → payers`, `tpaPayerId → payers`, `admissionId → admissions`, `encounterId → encounters`, `claimType not null`, `status default 'draft' not null`, `plannedAdmissionDate date not null`, `expectedLengthOfStayDays int not null`, `roomCategoryCode`, `treatingProviderId not null → providers`, `diagnoses jsonb $type<CodedEntry[]> default [] not null`, `procedures jsonb $type<CodedEntry[]> default [] not null`, `provisionalDiagnosisText`, `estimateLines jsonb $type<EstimateLine[]> not null`, `estimatedPaise bigint not null`, `requestedPaise bigint not null`, `approvedPaise bigint`, `approvalReference`, `validUntil date`, `firstRequestedAt`, `lastRequestedAt`, `decidedAt`, `createdByName not null`, `createdAt`, `updatedAt`. Config: `index('preauths_patient_idx')`, `index('preauths_status_idx')`, `uniqueIndex('preauths_insurer_reference_unique').on(insurerPayerId, sql\`lower(approval_reference)\`).where(sql\`approval_reference IS NOT NULL\`)`, checks `preauths_approved_fields` (`status NOT IN ('approved','enhancement_requested','enhancement_queried','enhanced') OR (approved_paise IS NOT NULL AND approval_reference IS NOT NULL AND valid_until IS NOT NULL)`), `preauths_amounts_range`.
  - `preauthEvents` (`preauth_events`): `id`, `preauthId not null`, `action not null`, `fromStatus`, `toStatus` not null, `amountPaise bigint`, `reasonCode → rcmReasonCodes`, `note`, `snapshot jsonb $type<PreauthSnapshot>`, `snapshotSha256`, `byName not null`, `byUserId → users`, `at`. Check `preauth_events_note_len` (≤ 1000), `preauth_events_snapshot_pair`.
  - `rcmQueries` (`rcm_queries`): `id`, `preauthId → preauths`, `claimId → claims`, `question not null`, `raisedOn date not null`, `dueOn date not null`, `status default 'open' not null`, `answeredAt`, `closedAt`, `createdByName not null`, `createdAt`. Checks `rcm_queries_one_subject` (`(preauth_id IS NULL) <> (claim_id IS NULL)`), `rcm_queries_due_after_raised`, `rcm_queries_question_len` (1..2000). Index `rcm_queries_claim_idx`, `rcm_queries_preauth_idx`.
  - `rcmQueryResponses` (`rcm_query_responses`): `id`, `queryId not null` (FK `rcm_query_responses_query_fk`), `body not null`, `respondedOn date not null`, `submissionId → claimSubmissions`, `byName not null`, `at`.
  - `preauthDocuments` (`preauth_documents`): `id`, `preauthId not null`, `kind not null`, `title not null`, `blobUrl not null`, `contentType not null`, `byteSize int not null`, `sha256 not null`, `queryResponseId → rcmQueryResponses`, `uploadedByName not null`, `uploadedAt`.
  - `claims`: `id`, `claimNumber text not null unique`, `patientId`, `policyId → patientPolicies`, `insurerPayerId`, `tpaPayerId`, `billingPayerId not null → payers`, `claimType`, `admissionId`, `encounterId`, `preauthId → preauths`, `status default 'draft'`, `claimedPaise bigint default 0`, `approvedPaise bigint`, `disallowedPaise bigint default 0`, `nonRecoverableDisallowedPaise bigint default 0`, `settledPaise bigint default 0`, `writtenOffPaise bigint default 0`, `currentDecisionEventId integer` (no FK; avoids a cycle), `currentVersion int default 0`, `rowVersion int default 0`, `insurerClaimReference`, `firstSubmittedAt`, `lastStatusAt`, `closedAt`, `createdByName not null`, `createdByUserId → users`, `createdAt`, `updatedAt`. Checks: `claims_context` (`(claim_type = 'opd' AND encounter_id IS NOT NULL AND admission_id IS NULL) OR (claim_type IN ('ipd','daycare') AND admission_id IS NOT NULL)`), `claims_amounts_nonneg`, `claims_approved_le_claimed` (`approved_paise IS NULL OR approved_paise <= claimed_paise`), `claims_credits_le_claimed` (`settled_paise + written_off_paise <= claimed_paise`), `claims_nonrecoverable_le_disallowed`. Indexes `claims_patient_idx`, `claims_status_idx`, `claims_billing_payer_idx`.
  - `claimInvoices` (`claim_invoices`): `claimId not null`, `invoiceId not null → invoices`, `invoiceTotalPaise bigint not null`, `claimedPaise bigint not null`, `addedByName not null`, `addedAt`; `primaryKey({ name: 'claim_invoices_pk', columns: [claimId, invoiceId] })`, `index('claim_invoices_invoice_idx')`, check `claim_invoices_claimed_range` (`claimed_paise BETWEEN 1 AND invoice_total_paise`).
  - `claimSubmissions` (`claim_submissions`): `id`, `claimId not null`, `version int not null`, `kind not null`, `snapshot jsonb $type<ClaimSnapshot> not null`, `snapshotSha256 not null`, `rcmCopyBlobUrl not null`, `rcmCopySha256 not null`, `insurerCopyBlobUrl not null`, `insurerCopySha256 not null`, `createdByName not null`, `createdByUserId`, `createdAt`; `uniqueIndex('claim_submissions_claim_version_unique').on(claimId, version)`.
  - `claimDispatches` (`claim_dispatches`): `id`, `submissionId not null unique`, `channel not null`, `transport text {enum ['manual','nhcx']} not null`, `trackingReference`, `dispatchedOn date not null`, `dispatchedByName not null`, `dispatchedAt`, `insurerReference`, `acknowledgedOn date`, `acknowledgedByName`.
  - `claimEvents` (`claim_events`): `id`, `claimId not null`, `action not null`, `fromStatus`, `toStatus not null`, `submissionId → claimSubmissions`, `amountPaise bigint`, `note`, `portalCheckedOn date`, `byName not null`, `byUserId`, `at`; check `claim_events_note_len` (≤ 2000); `index('claim_events_claim_idx')`.
  - `claimDocuments` (`claim_documents`): `id`, `claimId not null`, `kind not null`, `source not null`, `title not null`, `blobUrl`, `contentType`, `byteSize int`, `sha256`, `sourceId int`, `idProofType text {enum ID_PROOF_TYPES}`, `waiverReason`, `queryResponseId → rcmQueryResponses`, `supersededAt`, `supersededByName`, `uploadedByName not null`, `uploadedAt`. Checks `claim_documents_upload_complete` (`source <> 'upload' OR (blob_url IS NOT NULL AND sha256 IS NOT NULL AND content_type IS NOT NULL)`), `claim_documents_waiver_reason` (`source <> 'waiver' OR waiver_reason IS NOT NULL`), `claim_documents_id_proof_type` (`kind <> 'id_proof' OR source <> 'upload' OR id_proof_type IS NOT NULL`).
  - `claimDisallowances` (`claim_disallowances`): `id`, `claimId not null`, `eventId not null → claimEvents`, `reasonCode not null → rcmReasonCodes`, `amountPaise bigint not null` (check > 0), `patientRecoverable boolean not null`, `note`.
  - `claimSettlements` (`claim_settlements`): `id`, `claimId not null`, `eventId not null → claimEvents`, `utr not null`, `paymentDate date not null`, `receivedPaise`, `tdsPaise`, `bankChargesPaise`, `settledPaise` (bigint not null), `bankCreditDate date`, `reconciledAt`, `reconciledByName`, `recordedByName not null`, `recordedAt`. Checks `claim_settlements_sum` (`settled_paise = received_paise + tds_paise + bank_charges_paise`), `claim_settlements_amounts` (received > 0, others ≥ 0). `uniqueIndex('claim_settlements_claim_utr_unique').on(claimId, sql\`lower(utr)\`)`.
  - `claimWriteOffs` (`claim_write_offs`): `id`, `claimId not null`, `amountPaise bigint not null` (> 0), `reasonCode not null → rcmReasonCodes`, `note not null`, `status default 'requested' not null`, `requestedByName not null`, `requestedByUserId`, `requestedAt`, `decidedByName`, `decidedByUserId`, `decidedAt`, `decisionNote`. Checks `claim_write_offs_decided` (`status = 'requested' OR (decided_at IS NOT NULL AND decided_by_name IS NOT NULL)`), `claim_write_offs_second_person` (`decided_by_user_id IS NULL OR decided_by_user_id IS DISTINCT FROM requested_by_user_id`).
  - `chargeLines` + `preauthId: integer('preauth_id').references(() => preauths.id)`.
  - Types: `PreauthRow`, `PreauthEventRow`, `RcmQueryRow`, `RcmQueryResponseRow`, `PreauthDocumentRow`, `ClaimRow`, `ClaimInvoiceRow`, `ClaimSubmissionRow`, `ClaimDispatchRow`, `ClaimEventRow`, `ClaimDocumentRow`, `ClaimDisallowanceRow`, `ClaimSettlementRow`, `ClaimWriteOffRow`.
- Migration C also defines (header comment: migration-only, like SP4's triggers; bypassed only when `current_setting('hims.allow_document_purge', true) = 'on'`):
  - `sp7_append_only()` raising `'claim records are append-only'` `USING ERRCODE = '55000'`; triggers `claim_submissions_append_only`, `claim_events_append_only`, `claim_disallowances_append_only`, `preauth_events_append_only`, `preauth_documents_append_only` (`BEFORE UPDATE OR DELETE … FOR EACH ROW`).
  - `sp7_dispatch_guard()` on `claim_dispatches`: delete raises; update raises unless `OLD.insurer_reference IS NULL` and only `insurer_reference`, `acknowledged_on`, `acknowledged_by_name` change.
  - `sp7_settlement_guard()` on `claim_settlements`: delete raises; update raises unless `OLD.reconciled_at IS NULL` and only `bank_credit_date`, `reconciled_at`, `reconciled_by_name` change.
  - `sp7_write_off_guard()` on `claim_write_offs`: delete raises; update raises unless `OLD.status = 'requested'` and only `status`, `decided_*`, `decision_note` change.
- `deletePatient` (ruling 11): before any delete, throw SP4's `PatientHasFinancialRecordsError` when the patient has any claim with status ≠ `draft`/`withdrawn`, any `claim_submissions` row, or any pre-auth with status ≠ `draft`/`cancelled`. Otherwise, inside the purge-enabled transaction, delete the patient's SP7 rows in the `purgeRcmFixtures` order before the SP4 deletes.
- Produces (`tests/db/rcm-fixtures.ts`): `purgeRcmFixtures(patientIds: string[], payerIds: number[]): Promise<void>` — one transaction, `set_config('hims.allow_document_purge', 'on', true)`, then: `claim_write_offs` → `claim_settlements` → `claim_disallowances` → `claim_documents` → `preauth_documents` → `rcm_query_responses` → `rcm_queries` → `claim_events` → `claim_dispatches` → `claim_submissions` → `claim_invoices` → `update charge_lines set preauth_id = null` → `claims` → `preauth_events` → `preauths` → `patient_policies` → `payer_document_requirements` → `payer_contacts` → `payer_networks` → `payer_profiles` → `payers` (the given ids).

- [ ] **Step 1: Write the failing tests**

```ts
const M = '2026-10-07-sp7-c-preauth-claims.sql'
it('migration C is idempotent and declares every column', () => {
  const s = readMigration(M); expect(idempotencyProblems(s)).toEqual([])
  for (const t of [preauths, preauthEvents, rcmQueries, rcmQueryResponses, preauthDocuments, claims, claimInvoices, claimSubmissions, claimDispatches, claimEvents, claimDocuments, claimDisallowances, claimSettlements, claimWriteOffs]) expect(missingColumns(t, s)).toEqual([])
  for (const n of ['preauth_number_seq', 'claim_number_seq', 'sp7_append_only', 'claim_dispatches', 'claim_settlements_claim_utr_unique', 'claims_credits_le_claimed', 'claim_write_offs_second_person', 'pg_trigger', 'preauth_id']) expect(s).toContain(n)
})
describe.skipIf(!process.env.DATABASE_URL)('claims schema (DB)', () => {
  it('refuses to update or delete a submission', async () => { /* update snapshot → pgErrorCode 55000; delete → 55000 */ })
  it('a dispatch accepts the insurer reference once', async () => { /* set insurer_reference → ok; set again → 55000; change channel → 55000 */ })
  it('a settlement is reconciled once and its amounts never change', async () => {})
  it('the same UTR twice on one claim is a unique violation; on two claims it is fine', async () => {})
  it('settled plus written off can never pass the claimed amount', async () => { /* check claims_credits_le_claimed */ })
  it('purgeRcmFixtures removes append-only fixtures', async () => {})
})
// delete-patient-claims.test.ts (DB)
it('refuses to delete a patient with a submitted claim and deletes one with only a draft claim and a policy', async () => {})
```

- [ ] **Step 2: Run to verify failure:** `npm test -- tests/db/sp7-claims-schema.test.ts tests/lib/queries/delete-patient-claims.test.ts` → FAIL.
- [ ] **Step 3: Implement** schema, migration, lock helper, fixture helper, seed and `deletePatient` edits.
- [ ] **Step 4: Apply twice, then verify:** docker command on migration C twice. Then the same `npm test` command + `npm test -- tests/lib/queries/delete-patient-fk-guard.test.ts tests/db/seed-clear-existing-data-fk-order.test.ts tests/db/sp4-invoices-schema.test.ts` + `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/db/seed.ts src/lib/queries/patients.ts src/lib/queries/billing-lock.ts scripts/migrations/2026-10-07-sp7-c-preauth-claims.sql tests/db/rcm-fixtures.ts tests/db/sp7-claims-schema.test.ts tests/lib/queries/delete-patient-claims.test.ts
git commit -m "feat(sp7): pre-auth and claim lifecycle schema with append-only triggers and patient retention"
```

---

### Task 7: Insurer/TPA master and hospital identifiers (queries + routes)

**Files:**
- Create: `src/lib/rcm/route-responses.ts`, `src/lib/queries/rcm-payers.ts`, `src/app/api/rcm/payers/route.ts` (POST), `src/app/api/rcm/payers/[id]/route.ts` (PUT), `src/app/api/rcm/payers/[id]/contacts/route.ts` (PUT), `src/app/api/rcm/payers/[id]/networks/route.ts` (PUT), `src/app/api/rcm/payers/[id]/requirements/route.ts` (PUT), `src/app/api/rcm/settings/route.ts` (PUT)
- Modify: `tests/api/rbac-route-gates.test.ts` (create `SP7_WRITE_GATES`, add to the deny-before-parse `describe.each` spread; rows for these routes)
- Test: `tests/lib/queries/rcm-payers.test.ts` (DB), `tests/api/rcm-payers.test.ts`

**Interfaces:**
- Consumes: Task 4 schemas/errors; Task 5 tables; `getBillingSettings` (SP4).
- Produces (`route-responses.ts`, server): re-exports `readJsonBody`, `parseId`, `invalid`; `rcmErrorResponse(r: Extract<RcmWriteResult<unknown>, { ok: false }>): NextResponse` → `RCM_ERROR_STATUS[r.error]` with `{ error: r.message ?? RCM_ERROR_MESSAGE[r.error], items?: r.items }`; `rcmServerError(tag: string, err: unknown, message: string)` (409 `RETRY_MESSAGE` for `isRetryableConflict`, else 500 logging `[rcm] <tag> failed (code …, constraint …)` only); `readUpload(request: Request): Promise<{ ok: true; file: File; fields: Record<string, string> } | { ok: false; response: NextResponse }>` — `request.formData()` in try/catch (→ 400 `Send the file as multipart form data`), `file` must be a `File` with a type in `RCM_UPLOAD_TYPES` and size ≤ `RCM_UPLOAD_MAX_BYTES` (else 400 `RCM_ERROR_MESSAGE.upload_invalid`); other string fields returned.
- Produces (`rcm-payers.ts`):
  - `interface RcmPayerRow { payerId: number; name: string; code: string; gstin: string | null; stateCode: string | null; profile: PayerProfileRow | null }`
  - `listRcmPayers(opts?: { kind?: PayerKind; includeInactive?: boolean }): Promise<RcmPayerRow[]>` — every `payers` row left-joined to its profile; `kind` filters profiled rows only; ordered by name.
  - `getRcmPayer(payerId: number): Promise<(RcmPayerRow & { contacts: PayerContactRow[]; tpaIds: number[]; insurerIds: number[]; requirements: PayerDocumentRequirementRow[] }) | null>`
  - `createPayerWithProfile(input: PayerCreateInput, session: Session): Promise<RcmWriteResult<{ payerId: number }>>` — inserts `payers { name, payerId: code, payerType: 'other', gstin, stateCode }` and the profile in one transaction. Audit `rcm: created payer`, details `payer=<id> kind=<k>`.
  - `upsertPayerProfile(payerId: number, input: PayerProfileInput, session: Session): Promise<RcmWriteResult<null>>` — for new and legacy payers; also writes `payers.gstin/state_code`; `payers.payer_type` is never touched (ruling 6). Audit `rcm: updated payer profile`, details `payer=<id> fields=<sorted changed keys>`.
  - `setPayerContacts(payerId, contacts, session)`, `setPayerNetworks(insurerPayerId, tpaPayerIds, session)` (insurer profile kind ∈ insurer | government_scheme | corporate, each TPA profile kind `tpa`, else `payer_kind_invalid`), `setDocumentRequirements(payerId, claimType, entries, session)` — replace-set writes, each `RcmWriteResult<null>`, audits `rcm: updated payer contacts` (`payer=<id> contacts=<n>`), `rcm: updated payer network` (`payer=<id> tpas=<n>`), `rcm: updated document requirements` (`payer=<id> claim_type=<t> entries=<n>`).
  - `listReasonCodes(category?: ReasonCategory): Promise<RcmReasonCodeRow[]>` (active, by `sortOrder`)
  - `getHospitalIdentifiers(): Promise<{ rohiniId: string | null; hfrId: string | null }>`; `updateHospitalIdentifiers(input, session)` — audit `rcm: updated hospital identifiers`.
- Routes (session → inline gate → body → zod → query):

  | Route | Gate | Body | Responses |
  |---|---|---|---|
  | `POST /api/rcm/payers` | `PAYER_MASTER_ROLES` | `payerCreateSchema` | 201 `{ payerId }`; 409 `A payer with this code already exists` (unique on `payers.payer_id` is not guaranteed, so check first under `pg_advisory_xact_lock(hashtext('rcm:payer-code'))`) |
  | `PUT /api/rcm/payers/[id]` | `PAYER_MASTER_ROLES` | `payerProfileSchema` | 400 bad id; 404; 200 |
  | `PUT …/[id]/contacts`, `…/networks`, `…/requirements` | `PAYER_MASTER_ROLES` | their schemas | 400/404/200 |
  | `PUT /api/rcm/settings` | `RCM_SETTINGS_ROLES` | `rcmSettingsSchema` | 200 |

- [ ] **Step 1: Write the failing tests**

```ts
// rcm-payers.test.ts (DB)
it('creates a payer with its profile; legacy payers keep pricing and gain a profile', async () => {})
it('networks accept only TPAs for an insurer', async () => { /* tpaPayerIds containing an insurer → { ok:false, error:'payer_kind_invalid' } */ })
it('requirements replace the set for one claim type only', async () => {})
it('audit rows carry ids and kinds only', async () => { /* no name, email or phone in audit_log.details */ })
// rcm-payers.test.ts (routes, query mocked)
it('billing gets 403 on POST /api/rcm/payers before the body is read', async () => {})
it('rcm gets 403 on PUT /api/rcm/settings; admin gets 200', async () => {})
it('a bad GSTIN is a 400 with the authored message', async () => {})
// rbac-route-gates.test.ts: API_GATES + SP7_WRITE_GATES rows for all six routes
```

- [ ] **Step 2: Run to verify failure:** `npm test -- tests/lib/queries/rcm-payers.test.ts`, `npx vitest run tests/api/rcm-payers.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify:** same + `npm test -- tests/api/rbac-route-gates.test.ts` + `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/rcm/route-responses.ts src/lib/queries/rcm-payers.ts src/app/api/rcm tests
git commit -m "feat(sp7): insurer and TPA master on payers, networks, contacts, required documents, hospital identifiers"
```

---

### Task 8: Patient policies and policy cards (queries + routes)

**Files:**
- Create: `src/lib/rcm/hash.ts`, `src/lib/queries/rcm-policies.ts`, `src/app/api/rcm/policies/route.ts` (POST), `src/app/api/rcm/policies/[id]/route.ts` (PATCH), `src/app/api/rcm/policies/[id]/card/route.ts` (POST multipart), `src/app/api/rcm/policies/[id]/card/[side]/route.ts` (GET)
- Modify: `tests/api/rbac-route-gates.test.ts`
- Test: `tests/lib/queries/rcm-policies.test.ts` (DB), `tests/api/rcm-policies.test.ts`

**Interfaces:**
- Consumes: Task 4 `policySchema`, `policyPatchSchema`; Task 7 `readUpload`; SP5 `putPrivateBlob`, `streamPrivateBlob`; `invalidateCache`, `patientDetailCacheKey`; `ageOnDate`, `todayIsoIn`.
- Produces (`hash.ts`, server): `sha256Hex(input: string | Uint8Array): string`; `snapshotSha256(value: unknown): string` = `sha256Hex(canonicalJson(value))`.
- Produces (`rcm-policies.ts`):
  - `interface RcmPatientHit { id: string; name: string; uhid: string | null; gender: string | null; ageYears: number | null }`; `findPatientsForRcm(q: string): Promise<RcmPatientHit[]>` — exact UHID or id first, then name prefix, max 10, named columns only.
  - `interface PolicyView { id: number; patientId: string; insurer: { payerId: number; name: string }; tpa: { payerId: number; name: string } | null; policyNumber: string; memberId: string; planName: string | null; policyType: PolicyType; corporateName: string | null; holderName: string; relationship: PolicyRelationship; validFrom: string; validTo: string; sumInsuredPaise: number | null; copayBp: number | null; roomRentLimitPaise: number | null; priority: PolicyPriority; status: PolicyStatus; hasCardFront: boolean; hasCardBack: boolean }` (no URLs)
  - `listPatientPolicies(patientId: string): Promise<PolicyView[]>` (active first, primary first)
  - `billingPayerOf(p: { insurerPayerId: number; tpaPayerId: number | null }): number` = tpa ?? insurer (exported, pure).
  - `createPolicy(input: PolicyInput, session: Session): Promise<RcmWriteResult<{ policyId: number }>>`:
    - patient exists (`patient_not_found`); insurer profile kind ∈ insurer | government_scheme | corporate and TPA profile kind `tpa` (`payer_kind_invalid`; a payer with no profile is also invalid); both active (`payer_inactive`)
    - insert; `isUniqueViolation(err, 'patient_policies_one_active_primary')` → `primary_exists`
    - an active primary sets `patients.primary_payer_id = billingPayerOf(policy)` in the same transaction (ruling 6) and invalidates `patientDetailCacheKey` after commit
    - audit `rcm: added policy`, details `policy=<id> insurer=<id> tpa=<id|none> priority=<p>`
  - `updatePolicy(policyId: number, patch: PolicyPatchInput, session: Session): Promise<RcmWriteResult<null>>` — same checks; when an active primary becomes inactive or secondary, clears `primary_payer_id` only if it still equals this policy's billing payer; becoming the active primary sets it. Audit `rcm: updated policy`, details `policy=<id> fields=<sorted changed keys>`.
  - `uploadPolicyCard(policyId: number, side: 'front' | 'back', file: { bytes: Uint8Array; contentType: string }, session: Session): Promise<RcmWriteResult<null>>` — hash and `putPrivateBlob` **before** the transaction (path from Global Constraints), then update URL + sha. Audit `rcm: uploaded policy card`, details `policy=<id> side=<s>`.
  - `getPolicyCardBlob(policyId: number, side: 'front' | 'back'): Promise<{ url: string; patientId: string; contentType: string } | null>`
  - `legacyPolicyPrefill(patientId: string): Promise<Partial<PolicyInput> | null>` — from `primary_payer_id` (only when that payer has an insurer/TPA profile; TPA goes to `tpaPayerId`), `primary_member_id` → `memberId`, `primary_subscriber_name` → `holderName`, `primary_subscriber_relationship` (`self|spouse|child|other` map 1:1). Null when the legacy fields are empty. Never writes.
- Routes:

  | Route | Gate | Body | Responses |
  |---|---|---|---|
  | `POST /api/rcm/policies` | `POLICY_WRITE_ROLES` | `policySchema` | 201 `{ policyId }`; errors via `rcmErrorResponse` |
  | `PATCH /api/rcm/policies/[id]` | `POLICY_WRITE_ROLES` | `policyPatchSchema` | 200 |
  | `POST /api/rcm/policies/[id]/card` | `POLICY_WRITE_ROLES` | multipart `side` + `file` | 200 `{ ok: true }` |
  | `GET /api/rcm/policies/[id]/card/[side]` | `POLICY_READ_ROLES` | — | streams `inline`, audit `rcm: viewed policy card` (`policy=<id> side=<s>`); 404 `Card image not found`; a stored-but-missing blob → 404 `Stored file is missing` |

- [ ] **Step 1: Write the failing tests**

```ts
// DB
it('an active primary mirrors its billing payer onto patients.primary_payer_id', async () => { /* insurer + TPA → primary_payer_id = TPA id; deactivate → null */ })
it('a second active primary is primary_exists, a secondary is fine', async () => {})
it('a TPA in the insurer field is payer_kind_invalid; an unprofiled legacy payer too', async () => {})
it('legacy prefill reads the US-style fields and never writes', async () => { /* patient row unchanged afterwards */ })
it('policy audit carries no policy or member number', async () => {})
it('card upload stores the hash and never returns the URL', async () => { /* putPrivateBlob injected via vi.mock('@/lib/blob-store') */ })
// routes
it('frontdesk can add a policy; billing reads but gets 403 on POST', async () => {})
it('a non-multipart card upload is a 400; a 5 MB file is a 400 with the authored message', async () => {})
// API_GATES + SP7_WRITE_GATES rows (the GET card row: POLICY_READ_ROLES)
```

- [ ] **Step 2: Run to verify failure:** `npm test -- tests/lib/queries/rcm-policies.test.ts`, `npx vitest run tests/api/rcm-policies.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify:** same + `npm test -- tests/api/rbac-route-gates.test.ts` + `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/rcm/hash.ts src/lib/queries/rcm-policies.ts src/app/api/rcm/policies tests
git commit -m "feat(sp7): patient policies with private card images, primary-payer mirror and legacy prefill"
```

---

### Task 9: Pre-authorisation lifecycle (queries) and the SP4 reference validator

**Files:**
- Create: `src/lib/queries/preauths.ts`, `src/lib/queries/preauth-reference.ts`
- Test: `tests/lib/queries/preauths.test.ts` (DB), `tests/lib/queries/preauth-reference.test.ts` (DB)

**Interfaces:**
- Consumes: Task 2 (`nextPreauthStatus`, `preauthReferenceStatus`, `LIVE_APPROVED_PREAUTH_STATUSES`, `formatRcmNumber`), Task 3 (`buildPreauthSnapshot`, `EstimateLine`), Task 4 (schemas, `RcmWriteResult`), Task 6 (`lockPatientBilling`), Task 8 (`snapshotSha256`, `billingPayerOf`); SP2 `loadPricingContext` + `resolvePrice` (called exactly as SP4 `charge-capture.ts` step 3 does); SP4 `lineTaxablePaise`, `lineTax`, `sumPaise`; SP6 `getCodesByIds`, `DIAGNOSIS_CODE_KINDS`, `PROCEDURE_CODE_KINDS`; SP5 `putPrivateBlob`.
- Produces (`preauths.ts`):
  - `estimatePreauth(input: { payerId: number; onDate: string; roomCategoryCode: string | null; items: { serviceId: number; quantity: number }[] }): Promise<RcmWriteResult<{ lines: EstimateLine[]; totalPaise: number }>>` — per item: missing/inactive service → `service_not_found`; resolver `no_rate` → `price_unresolved` with `message: \`No tariff rate covers ${code}\``; `amountPaise = lineTax(lineTaxablePaise(unit, qty), gstRateBp, 'intra').totalPaise`.
  - `createPreauth(input: PreauthCreateInput, session: Session, now?: Date): Promise<RcmWriteResult<{ preauthId: number; preauthNumber: string }>>` — policy must be active (`policy_not_found` / `payer_inactive`); `admissionId`/`encounterId` must be the policy patient's (`context_mismatch`); each code id via `getCodesByIds` (`code_not_found`; a diagnosis id of a non-diagnosis kind → `code_not_found`), snapshotted as `CodedEntry`; estimate with the policy's billing payer; `requestedPaise` defaults to the estimate; number `formatRcmNumber('PA', istDateOf(now).slice(0, 4), nextval('preauth_number_seq'))`; status `draft`. Audit `rcm: created pre-authorisation`, details `preauth=<id> number=<no> estimate=<paise>`.
  - `applyPreauthAction(preauthId: number, req: PreauthActionRequest, session: Session, now?: Date): Promise<RcmWriteResult<{ status: PreauthStatus }>>` — `lockPatientBilling`, then the pre-auth `FOR UPDATE`; `nextPreauthStatus(from, action, { enhancedBefore })` (`enhancedBefore` = an `approve_enhancement` event exists) null → `invalid_transition`. Effects:
    - `request` / `request_enhancement`: stamp `firstRequestedAt` (once) and `lastRequestedAt`; the event stores `buildPreauthSnapshot(…)` and its `snapshotSha256` (kind `initial` / `enhancement`); `request_enhancement.requestedPaise` must exceed `approvedPaise` (`amounts_invalid`, message `The enhancement must be more than the approved <fmt>`).
    - `record_query`: insert `rcm_queries` (preauth subject, open). `respond_query`: the query must be this pre-auth's and `open` (`query_not_found` / `query_closed`); insert the response; query → `answered`.
    - `approve`: set `approvedPaise`, `approvalReference`, `validUntil`, `decidedAt`; unique violation `preauths_insurer_reference_unique` → `duplicate_reference`.
    - `approve_enhancement`: `approvedPaise` must exceed the current approval (`amounts_invalid`); update amount, validity and (when given) reference.
    - `reject` / `reject_enhancement`: reason code must exist with category `rejection` (`code_not_found`).
    - `cancel`: refused with `preauth_in_use` when a claim with status ∉ {draft, withdrawn} links it.
    - Every action inserts a `preauth_events` row (`amountPaise` for approve/enhance) and audits `rcm: pre-authorisation <action>`, details `preauth=<id> from=<s> to=<s>` plus ` amount=<paise>` for approvals. Notes, questions and references never reach the audit.
  - `uploadPreauthDocument(preauthId: number, input: { kind: 'preauth_approval' | 'query_response' | 'other'; title: string; queryResponseId?: number }, file: { bytes: Uint8Array; contentType: string }, session: Session): Promise<RcmWriteResult<{ documentId: number }>>` — blob put before the transaction. Audit `rcm: uploaded pre-authorisation document`, details `preauth=<id> document=<id> kind=<k>`.
  - Reads: `getPreauthDetail(id: number): Promise<PreauthDetail | null>` (row + events without snapshots + queries with responses + documents without URLs + patient RCM minimum + policy view + payer SLA hours); `listPreauths(opts: { status?: PreauthStatus; q?: string; page?: number; now?: Date }): Promise<{ rows: PreauthListRow[]; total: number }>` (50 per page; `PreauthListRow` carries `decisionOverdue` from `preauthDecisionOverdue`); `getPreauthDocumentBlob(id)`.
- Produces (`preauth-reference.ts`) — **the interface SP4 validates against (ruling 7):**
  - `validatePreauthReference(executor: WriteExecutor, input: { patientId: string; payerId: number | null; reference: string; serviceDate: string }): Promise<{ status: PreauthReferenceStatus; preauthId: number | null }>` — candidates: the patient's pre-auths whose `lower(approval_reference)` or `lower(preauth_number)` equals `lower(trim(reference))`; each scored with `preauthReferenceStatus(…, { payerId, serviceDate })` using `payerIds = [insurer, tpa]`; return the first `valid`, else the first candidate's status, else `not_found`.
  - `listApprovedPreauthsForPatient(patientId: string, onDate: string): Promise<{ id: number; preauthNumber: string; approvalReference: string; approvedPaise: number; validUntil: string; payerIds: number[] }[]>` — live-approved and `validUntil >= onDate`.

- [ ] **Step 1: Write the failing tests** (DB; fixtures: TEST insurer + TPA with profiles and a base tariff rate, a policy, an admission, SAMPLE SP6 codes)

```ts
it('estimates from the payer tariff and refuses an unpriced service with its code', async () => {})
it('walks draft → requested → queried → requested → approved and snapshots the request', async () => {
  /* events: request carries snapshot + snapshotSha256 === snapshotSha256(snapshot); approve sets amount/reference/validity */
})
it('an enhancement must exceed the approval; a rejected enhancement keeps the approval', async () => {})
it('the same approval reference for the same insurer is duplicate_reference', async () => {})
it('a pre-auth on a submitted claim cannot be cancelled', async () => {})
it('concurrent approve and cancel: one wins, the other is invalid_transition', async () => {})
it('audit details carry no reference, question or note', async () => {})
// preauth-reference.test.ts
it('validates by approval reference or PA number, case-insensitive', async () => { /* ' pa-2099-000001 ' → valid */ })
it('reports not_approved, expired and payer_mismatch', async () => {})
it('another patient\'s reference is not_found', async () => {})
```

- [ ] **Step 2: Run to verify failure:** `npm test -- tests/lib/queries/preauths.test.ts tests/lib/queries/preauth-reference.test.ts` → FAIL.
- [ ] **Step 3: Implement** both modules.
- [ ] **Step 4: Verify:** same + `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/queries/preauths.ts src/lib/queries/preauth-reference.ts tests/lib/queries
git commit -m "feat(sp7): pre-authorisation lifecycle with tariff estimate, queries, enhancements and the reference validator"
```

---

### Task 10: Pre-auth routes and SP4 charge-capture integration

**Files:**
- Create: `src/app/api/rcm/preauths/route.ts` (POST), `src/app/api/rcm/preauths/estimate/route.ts` (POST), `src/app/api/rcm/preauths/[id]/actions/route.ts` (POST), `src/app/api/rcm/preauths/[id]/documents/route.ts` (POST multipart), `src/app/api/rcm/preauth-documents/[id]/route.ts` (GET), `src/app/api/rcm/patients/[anonId]/approved-preauths/route.ts` (GET)
- Modify (SP4, `// SP7` comments): `src/lib/billing/charge-rules.ts`, `src/lib/billing/validation.ts`, `src/lib/queries/charge-capture.ts`, `tests/lib/billing/charge-rules.test.ts` (base input gains `preAuthCheck: null`), `tests/api/rbac-route-gates.test.ts`
- Test: `tests/api/rcm-preauths.test.ts`, `tests/lib/billing/charge-rules.test.ts` (append), `tests/lib/queries/charge-capture.test.ts` (append, DB)

**Interfaces:**
- Consumes: Task 9; Task 7 route helpers; SP4 Task 2/3/7.
- Routes:

  | Route | Gate | Body | Responses |
  |---|---|---|---|
  | `POST /api/rcm/preauths` | `RCM_ROLES` | `preauthCreateSchema` | 201 `{ preauthId, preauthNumber }` |
  | `POST /api/rcm/preauths/estimate` | `RCM_ROLES` | `preauthEstimateSchema` | 200 `{ lines, totalPaise }` (not audited, no write) |
  | `POST /api/rcm/preauths/[id]/actions` | `RCM_ROLES` | `preauthActionSchema` | 200 `{ status }` |
  | `POST /api/rcm/preauths/[id]/documents` | `RCM_ROLES` | multipart `kind`, `title`, optional `queryResponseId`, `file` | 201 `{ documentId }` |
  | `GET /api/rcm/preauth-documents/[id]` | `RCM_ROLES` | — | stream inline; audit `rcm: viewed pre-authorisation document` |
  | `GET /api/rcm/patients/[anonId]/approved-preauths?onDate=` | `PREAUTH_LOOKUP_ROLES` | — | 200 `{ preauths }` (`listApprovedPreauthsForPatient`; numbers and amounts only); 400 bad date |

- SP4 changes (ruling 7):
  - `CHARGE_RULE_CODES` gains `'preauth_invalid'` **last**; `CHARGE_RULES` gains `{ code: 'preauth_invalid', label: 'Pre-authorisation reference is valid', defaultSeverity: 'block', configurable: true, overridable: false, field: 'preAuthReference' }`.
  - `ChargeRuleInput` gains `preAuthCheck: PreauthReferenceStatus | null` (`import type` from `src/lib/rcm/preauth-status.ts`). The rule fires when `payer !== null`, `preAuthReference?.trim()` is non-empty and `preAuthCheck` ∉ {null, 'valid'}. Messages: not_found `No pre-authorisation with this reference exists for this patient`; not_approved `This pre-authorisation is not approved`; expired `This pre-authorisation expired before the service date`; payer_mismatch `This pre-authorisation is for a different payer`.
  - `chargeCaptureSchema.overrides` max becomes `CHARGE_RULE_CODES.length`.
  - `charge-capture.ts` `evaluate`: when `billTo === 'payer'` and a reference is given, `validatePreauthReference(executor, { patientId, payerId, reference, serviceDate })` on the same executor; `preAuthCheck` = its status. `captureChargeLine` writes `preauthId` when `valid`.

- [ ] **Step 1: Write the failing tests**

```ts
// charge-rules.test.ts (append)
it('a typed reference that is not an approved pre-auth blocks; a valid one passes', () => {
  const v = { ...base, payer: { id: 7, requiresPreauth: true }, service: { ...base.service!, requiresPreauth: true }, preAuthReference: 'PA-1' }
  expect(evaluateChargeRules({ ...v, preAuthCheck: 'expired' }, S, {})[0]).toMatchObject({ code: 'preauth_invalid', message: 'This pre-authorisation expired before the service date', overridable: false })
  expect(evaluateChargeRules({ ...v, preAuthCheck: 'valid' }, S, {})).toEqual([])
})
it('CHARGE_RULES still has one row per code in order', () => { expect(CHARGE_RULES.map((r) => r.code)).toEqual([...CHARGE_RULE_CODES]) })
// charge-capture.test.ts (append, DB)
it('capture links the approved pre-auth and refuses an expired one', async () => {})
// rcm-preauths.test.ts (routes, queries mocked)
it('billing can list approved pre-auths but gets 403 on POST /api/rcm/preauths', async () => {})
it('an unknown action is a 400; invalid_transition is a 409 with the catalogue message', async () => {})
it('a 40001 from the query is a 409 with the retry message', async () => {})
// API_GATES rows for all six; SP7_WRITE_GATES rows for the four POSTs
```

- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/lib/billing/charge-rules.test.ts tests/api/rcm-preauths.test.ts`, `npm test -- tests/lib/queries/charge-capture.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify:** same + `npx vitest run tests/lib/billing tests/api/billing-charge-lines.test.ts` (SP4 stays green) + `npm test -- tests/api/rbac-route-gates.test.ts` + `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/app/api/rcm src/lib/billing/charge-rules.ts src/lib/billing/validation.ts src/lib/queries/charge-capture.ts tests
git commit -m "feat(sp7): pre-auth routes and SP4 charge capture validating the approved pre-auth reference"
```

---

### Task 11: Claim drafts, invoice links, documents and readiness (queries) + SP4 cancel guard

**Files:**
- Create: `src/lib/queries/claims.ts`, `src/lib/queries/claim-documents.ts`
- Modify (SP4, `// SP7`): `src/lib/queries/invoices.ts` (`cancelInvoice` gains error `'on_claim'`), `src/app/api/billing/invoices/[id]/cancel/route.ts` (409 mapping), `tests/api/billing-invoices.test.ts` (append)
- Test: `tests/lib/queries/claims.test.ts` (DB), `tests/lib/queries/claim-documents.test.ts` (DB)

**Interfaces:**
- Consumes: Tasks 2–6, 8, 9; SP6 `getEncounterCodingGate`; SP3 `getDischargeSummaryData`; SP5 `lab_reports`, `putPrivateBlob`; SP4 `invoices`.
- Produces (`claims.ts`):
  - `episodeOf(executor, ref: { admissionId: number } | { encounterId: number }): Promise<{ patientId: string; admissionId: number | null; encounterId: number | null; codingEncounterId: number | null; startDate: string; endDate: string | null } | null>` — admission: start/end = IST dates of `admittedAt`/`dischargedAt`, `codingEncounterId` = the encounter whose `admission_id` is it; encounter: start = `encounterDate`, end = IST date of `completedAt`, `codingEncounterId` = itself.
  - `interface ClaimableInvoice { invoiceId: number; number: string; date: string; totalPaise: number; claimedElsewherePaise: number; availablePaise: number }`; `listClaimableInvoices(executor, episode, billingPayerId: number, excludeClaimId?: number): Promise<ClaimableInvoice[]>` — the episode's `finalised` invoices with `payer_id = billingPayerId`; `claimedElsewherePaise` = Σ `claim_invoices.claimed_paise` over claims with status ≠ `withdrawn` (excluding `excludeClaimId`), via `paiseFromDb`.
  - `createClaimDraft(input: ClaimCreateInput, session: Session, now?: Date): Promise<RcmWriteResult<{ claimId: number; claimNumber: string }>>`:
    1. Policy active (`policy_not_found`); episode is the policy patient's (`context_mismatch`); `lockPatientBilling`.
    2. `preauthId`, when given: the patient's, same policy, live-approved (`preauth_unavailable`).
    3. Each invoice in `listClaimableInvoices(tx, …)` (`invoice_unavailable`); `claimedPaise` defaults to `availablePaise`; more than available → `invoice_over_claimed` (ruling 2).
    4. Number `CLM-…`; insert claim (`billingPayerId = billingPayerOf(policy)`, `claimedPaise` = Σ) and `claim_invoices` (`invoiceTotalPaise` snapshot).
    5. Auto-attach system documents (`attachSystemDocuments`, below).
    6. Audit `rcm: created claim`, details `claim=<id> number=<no> invoices=<n> claimed=<paise>`.
  - `setClaimInvoices(claimId: number, invoices: ClaimCreateInput['invoices'], session: Session): Promise<RcmWriteResult<null>>` — draft only (`not_draft`); same checks with `excludeClaimId`; replaces the set, recomputes `claimedPaise`, bumps `rowVersion`. Audit `rcm: changed claim invoices`.
  - `attachSystemDocuments(tx, claim): Promise<void>` — idempotent (skips a kind+source+sourceId already live): `itemised_bill` per invoice (source `invoice`, title = invoice number); `discharge_summary` (source `discharge_summary`) when the admission is discharged and `getDischargeSummaryData` returns data; `policy_card` (source `policy_card`) when the policy has a front image; `preauth_approval` (source `preauth_letter`, `sourceId` = pre-auth document id) per `preauth_approval` document of the linked pre-auth; `investigation_reports` (source `lab_report`) per non-superseded `lab_reports` row of the patient released within `[startOfIstDay(start), startOfIstDay(addDaysIso(end ?? start, 1)))`. System documents carry the source's sha256 when it has one (lab report, pre-auth document, policy card).
  - `loadClaimReadiness(executor, claimId: number): Promise<{ input: ClaimReadinessInput; result: ReturnType<typeof checkClaimReadiness> } | null>` — builds the input from the claim, its invoices (current status), `getEncounterCodingGate(codingEncounterId)`, the policy, `payer_networks`, the billing payer profile (the TPA's profile when there is a TPA, else the insurer's), the pre-auth, `requiredDocumentKinds(claimType, payer requirements)`, live documents (`supersededAt` null; a waiver counts as present), patient `dob`/`gender`/ABHA presence and `getHospitalIdentifiers()`.
  - `getClaimReadiness(claimId: number): Promise<ReturnType<typeof checkClaimReadiness> | null>`
- Produces (`claim-documents.ts`):
  - `uploadClaimDocument(claimId: number, meta: ClaimDocumentMeta, file: { bytes: Uint8Array; contentType: string }, session: Session): Promise<RcmWriteResult<{ documentId: number }>>` — any status except closed/withdrawn; hash + blob before the transaction; bumps `rowVersion`. Audit `rcm: uploaded claim document`, details `claim=<id> document=<id> kind=<k>`.
  - `attachLabReport(claimId: number, labReportId: number, session: Session)` — the patient's, not superseded (`lab_report_unavailable`). Audit `rcm: attached lab report`.
  - `waiveClaimDocument(claimId: number, kind: ClaimDocumentKind, reason: string, session: Session)` — inserts a `waiver` row. Audit `rcm: waived claim document`, details `claim=<id> kind=<k>`.
  - `removeClaimDocument(claimId: number, documentId: number, session: Session)` — sets `supersededAt/ByName` (rows are never deleted; earlier snapshots keep their hashes). Audit `rcm: removed claim document`.
  - `getClaimDocumentBlob(documentId: number): Promise<{ url: string; claimId: number; patientId: string; contentType: string; title: string } | null>` — for `upload`; for `lab_report` / `preauth_letter` / `policy_card` it resolves the source row's blob.
- SP4 `cancelInvoice`: after the locks, if `claim_invoices` links the invoice to a claim with status ∉ {draft, withdrawn} → `{ ok: false, error: 'on_claim' }`; route 409 `This invoice is on a submitted insurance claim; withdraw the claim or record its outcome before cancelling` (ruling 2).

- [ ] **Step 1: Write the failing tests** (DB; fixtures: TEST payers + policy, admission discharged, SP3 IPD encounter, SP6 coding finalised for it, SP4 finalised invoices with the TPA as payer at `now = 2099-06-01`)

```ts
it('creates a draft claim from finalised invoices and auto-attaches the bill, discharge summary and lab report', async () => {})
it('refuses a self-pay invoice, another stay\'s invoice and a draft invoice', async () => { /* each → invoice_unavailable */ })
it('two concurrent claims on one invoice never exceed its total', async () => {
  const [a, b] = await Promise.all([createClaimDraft(full(inv), RCM), createClaimDraft(full(inv), RCM)])
  expect([a.ok, b.ok].sort()).toEqual([false, true]); expect((a.ok ? b : a)).toMatchObject({ ok: false, error: 'invoice_over_claimed' })
})
it('a top-up claim may take the remainder', async () => { /* claim 1 claims 60%, claim 2 defaults to the 40% available */ })
it('a withdrawn claim frees its invoices', async () => {})
it('cancelInvoice refuses an invoice on a submitted claim', async () => {})
it('a draft claim whose invoice was cancelled is not ready', async () => { /* readiness items contain invoice_cancelled */ })
it('readiness lists missing documents until uploaded or waived, and needs finalised coding', async () => {})
it('documents are superseded, never deleted', async () => {})
```

- [ ] **Step 2: Run to verify failure:** `npm test -- tests/lib/queries/claims.test.ts tests/lib/queries/claim-documents.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify:** same + `npm test -- tests/lib/queries/invoices.test.ts` (SP4 green) + `npx vitest run tests/api/billing-invoices.test.ts` + `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/queries/claims.ts src/lib/queries/claim-documents.ts src/lib/queries/invoices.ts "src/app/api/billing/invoices/[id]/cancel/route.ts" tests
git commit -m "feat(sp7): claim drafts from finalised invoices with partial claims, documents, readiness, and no credit note under a live claim"
```

---

### Task 12: Submission versions — the two copies, dispatch through the gateway, acknowledgement, verify

**Files:**
- Create: `src/lib/rcm/claim-pdf.ts`, `src/lib/queries/claim-submissions.ts`
- Modify: `tests/lib/no-aadhaar-leak.test.ts` (`EXPORT_PATHS` + `'src/lib/rcm/snapshot.ts'`, `'src/lib/rcm/claim-pdf.ts'`, `'src/lib/queries/claim-submissions.ts'`)
- Test: `tests/lib/rcm/claim-pdf.test.ts`, `tests/lib/queries/claim-submissions.test.ts` (DB)

**Interfaces:**
- Consumes: Tasks 2–4, 6, 8 (`sha256Hex`, `snapshotSha256`), 11 (`loadClaimReadiness`); SP6 `getEncounterCodingGate`; SP4 invoice lines; SP5 `putPrivateBlob`, `streamPrivateBlob`, its PDF-safe text helper; `brand`.
- Produces (`claim-pdf.ts`, server only):
  - `renderClaimCopyPdf(snapshot: ClaimSnapshot, copy: 'rcm' | 'insurer' | 'draft', opts?: { snapshotSha256?: string }): Promise<Uint8Array>` — A4, `StandardFonts.Helvetica`, every string through the SP5 PDF-safe helper, amounts as `Rs. …`. A banner on every page: rcm `RCM COPY - RETAINED BY HOSPITAL`, insurer `INSURER COPY`, draft `DRAFT - NOT SUBMITTED`; footer `<claimNumber> v<version> - page n of m`. Sections in order: claim and hospital (ROHINI/HFR), patient and policy, episode, pre-authorisation, diagnoses (kind, code, display), procedures, discharge summary, itemised bill (items, then totals), document index (kind, title, first 12 hex of sha256 or `waived`), cover note. Only the `rcm` copy ends with the line `Snapshot SHA-256: <opts.snapshotSha256>` (the caller computes the hash; `rcm` without it throws `TypeError`).
- Produces (`claim-submissions.ts`):
  - `buildClaimSnapshotFor(executor: WriteExecutor, claimId: number, kind: SubmissionKind, coverNote: string | null, now: Date): Promise<{ snapshot: ClaimSnapshot; sha256: string; rowVersion: number; readiness: ReturnType<typeof checkClaimReadiness> } | null>` — `version = currentVersion + 1`; diagnoses = live `coded` `diagnoses` of the coding encounter (with code version from `code_systems`); procedures likewise from `encounter_procedures`; items from `invoice_lines`; documents = live claim documents; `includeAbha` = payer profile `requiresAbha`; `codingFingerprint = sha256Hex(codingFingerprintSource(dx, px))`.
  - `interface SubmissionDeps { render: typeof renderClaimCopyPdf; putBlob: (path: string, bytes: Uint8Array) => Promise<{ url: string }>; gateway: (channel: SubmissionChannel) => ClaimGateway }`; `defaultSubmissionDeps`.
  - `submitClaimVersion(claimId: number, req: ClaimSubmitRequest, session: Session, deps?: SubmissionDeps, now?: Date): Promise<RcmWriteResult<{ version: number; submissionId: number; status: ClaimStatus; warnings: ReadinessItem[] }>>`:
    1. **Before the transaction:** `nextClaimStatus(status, req.action, …)` null → `invalid_transition`; `deps.gateway(req.channel).status().configured` false → `gateway_not_configured`; build the snapshot (`kind`: submit → `initial`, respond_query → `query_response`, appeal → `req.appealKind`; `coverNote` = `coverNote` / `body` / `grounds`); readiness not ready → `not_ready` with `items`; render the `rcm` (with the hash) and `insurer` copies; `putBlob` both; hash both PDFs.
    2. **Transaction:** `lockPatientBilling`; claim `FOR UPDATE`; rebuild the snapshot on `tx` with the **same** `now` (so `preparedAt` matches) and compare `rowVersion` **and** `sha256` → mismatch `stale` (log `[rcm] orphaned claim copy <path>` for both uploads, path only); re-check the transition; `respond_query`: the query must be this claim's and `open`.
    3. `deps.gateway(channel).submit(pkg)`; `ok: false` → that error.
    4. Insert `claim_submissions` (`version`), `claim_dispatches` (`transport`, `trackingReference`, `dispatchedOn = istDateOf(now)`), `claim_events` (`submissionId`), and for `respond_query` the `rcm_query_responses` row (`submissionId`) with the query → `answered`.
    5. Update the claim: `status`, `currentVersion`, `rowVersion + 1`, `firstSubmittedAt` (once), `lastStatusAt`, `updatedAt`.
    6. Audit `rcm: submitted claim version`, details `claim=<id> version=<n> kind=<k> channel=<c> sha=<first 12 hex>`.
    7. Return the `warn` readiness items as `warnings`.
  - `acknowledgeDispatch(dispatchId: number, input: { insurerReference: string; acknowledgedOn: string }, session: Session): Promise<RcmWriteResult<null>>` — once (`already_acknowledged`); sets `claims.insurerClaimReference` when null. Audit `rcm: recorded insurer acknowledgement`, details `claim=<id> dispatch=<id>`.
  - `renderDraftCopy(claimId: number, session: Session, now?: Date): Promise<Uint8Array | null>` — draft PDF from a not-stored snapshot. Audit `rcm: previewed claim copy`.
  - `getSubmissionCopy(submissionId: number, copy: 'rcm' | 'insurer'): Promise<{ url: string; claimNumber: string; version: number; patientId: string } | null>`
  - `verifySubmission(submissionId: number, deps?: { fetchBytes(url: string): Promise<Uint8Array | null> }): Promise<{ snapshotOk: boolean; rcmCopyOk: boolean; insurerCopyOk: boolean } | null>` — recomputes `snapshotSha256(row.snapshot)` and the two blob hashes against the stored ones (ruling 3).
  - `claimCodingDrift(executor, claimId: number): Promise<{ drifted: boolean; codingFinalised: boolean }>` — `drifted` when a submission exists and the latest snapshot's `codingFingerprint` differs from the current one or the coding gate is not finalised (SP6 ruling 2: a reopened coding raises a claim revision). The next version is then blocked by readiness (`coding_not_finalised`) until coding is finalised again.

- [ ] **Step 1: Write the failing tests**

```ts
// claim-pdf.test.ts
it('renders each copy with its banner and the RCM copy with the hash', async () => {
  const pdf = await PDFDocument.load(await renderClaimCopyPdf(SNAP, 'rcm', { snapshotSha256: 'a'.repeat(64) })); expect(pdf.getPageCount()).toBeGreaterThan(0)
  /* text extraction via the SP5 test helper: contains 'RCM COPY - RETAINED BY HOSPITAL' and the hash; insurer copy contains 'INSURER COPY' and not the hash line */
})
it('survives non-Latin names and amounts above 2^31', async () => { /* name 'श्रीनिवास', total 3_540_000_000 → renders, shows 'Rs. 3,54,00,000.00' */ })
// claim-submissions.test.ts (DB; deps inject an in-memory blob store and render)
it('submits v1: two copies stored with hashes, dispatch recorded, claim submitted', async () => {})
it('verify recomputes the stored hashes', async () => { /* fresh → all true; tampered in-memory blob → insurerCopyOk false */ })
it('a not-ready claim is a 422 with readiness items and stores nothing', async () => {})
it('NHCX is refused as not configured and stores nothing', async () => {})
it('a change between render and commit is refused as stale', async () => { /* deps.render bumps the claim (upload a document) before returning */ })
it('responding to a query creates v2 of kind query_response and answers the query', async () => {})
it('coding reopened after submission flags the claim and blocks resubmission', async () => {
  /* applyCodingAction reopen (SP6) → claimCodingDrift drifted true; respond_query → not_ready with coding_not_finalised */
})
it('concurrent submits of one draft create one version', async () => {})
it('snapshot has no contact keys and ABHA only for a payer that requires it', async () => {})
it('the acknowledgement is recorded once', async () => {})
```

- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/lib/rcm/claim-pdf.test.ts`, `npm test -- tests/lib/queries/claim-submissions.test.ts` → FAIL.
- [ ] **Step 3: Implement** both modules and the `EXPORT_PATHS` additions.
- [ ] **Step 4: Verify:** same + `npx vitest run tests/lib/no-aadhaar-leak.test.ts tests/lib/no-credential-leak.test.ts` + `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/rcm/claim-pdf.ts src/lib/queries/claim-submissions.ts tests
git commit -m "feat(sp7): immutable claim versions with retained RCM copy, generated insurer copy, gateway dispatch and hash verification"
```

---

### Task 13: Insurer updates, settlements, reconciliation, write-offs and the SP4 ledger split

**Files:**
- Create: `src/lib/queries/claim-updates.ts`
- Modify (SP4, `// SP7`): `src/lib/billing/ledger.ts`, `src/lib/queries/patient-ledger.ts`, `src/components/billing/LedgerTable.tsx`, `src/app/(dashboard)/cash-desk/page.tsx` (summary shows "Awaiting insurer" and "Patient payable"), `tests/lib/billing/ledger.test.ts` (append)
- Test: `tests/lib/queries/claim-updates.test.ts` (DB), `tests/lib/queries/patient-ledger-claims.test.ts` (DB)

**Interfaces:**
- Consumes: Task 2 (`nextClaimStatus`, `approvalActionFor`, `approvalProblems`, `settlementProblems`, `settlementWarnings`, `writeOffCeilingPaise`, `closeProblems`, `claimCoveredPendingPaise`, `splitPatientOutstanding`), Task 4 schemas, Task 6 lock; SP4 `computeLedger`, `loadLedgerEntries`, `getPatientLedger`, `paiseFromDb`.
- Produces (`claim-updates.ts`):
  - `loadClaimMoney(executor, claimId: number): Promise<(ClaimMoney & { unreconciledSettlements: number; openQueries: number; hasSettlement: boolean }) | null>` (`pendingWriteOffPaise` = Σ requested write-offs).
  - `applyClaimUpdate(claimId: number, req: ClaimUpdateRequest, session: Session, now?: Date): Promise<RcmWriteResult<{ status: ClaimStatus; warnings: string[] }>>` — `lockPatientBilling`; claim `FOR UPDATE`; then:
    - `record_query`: transition; insert `rcm_queries` (claim subject); store `insurerClaimReference` when given and empty.
    - `record_decision`: action = `approvalActionFor(claimed, approved)`; transition; `approvalProblems` → `amounts_invalid` with the message; reason codes must exist with category `disallowance` (`code_not_found`); insert the event (`amountPaise = approved`) and its `claim_disallowances`; set `approvedPaise`, `disallowedPaise`, `nonRecoverableDisallowedPaise` (Σ `!patientRecoverable`), `currentDecisionEventId`.
    - `record_rejection`: transition; reason category `rejection`; event; one disallowance of the full claimed amount with that reason and `patientRecoverable`; `approvedPaise = 0`.
    - `close`: `closeProblems` → `close_blocked` with the message; `closedAt`.
    - `reopen`: `ctx.hasSettlement`; the reason goes in the event `note` only.
    - `withdraw`: the reason in the event `note`; the invoices become claimable again (Task 11 counts non-withdrawn claims only).
    - `note`: no transition; event `note` with `portalCheckedOn` and `toStatus = fromStatus`.
    - every action: event row, `rowVersion + 1`, `lastStatusAt`; audit `rcm: claim <action>` (for decisions the resolved `record_approval` / `record_partial_approval`), details `claim=<id> from=<s> to=<s>` plus ` approved=<paise> disallowed=<paise>` for decisions. Never the note, reason or question.
  - `recordSettlement(claimId: number, input: SettlementInput, session: Session, now?: Date): Promise<RcmWriteResult<{ settlementId: number; warnings: string[] }>>` — lock; transition `record_settlement`; `settlementProblems({ approvedPaise: approved ?? 0, alreadySettledPaise: settledPaise, … })` → `amounts_invalid`; insert the event and the settlement (`settledPaise` = sum); unique violation `claim_settlements_claim_utr_unique` → `duplicate_utr`; `claims.settledPaise += settled`, status `settled`. Audit `rcm: recorded settlement`, details `claim=<id> settlement=<id> received=<p> tds=<p> bank=<p>` (never the UTR).
  - `reconcileSettlement(settlementId: number, input: { bankCreditDate: string }, session: Session): Promise<RcmWriteResult<null>>` — once (`already_reconciled`). Audit `rcm: reconciled settlement`, details `claim=<id> settlement=<id>`.
  - `requestWriteOff(claimId: number, input: { amountPaise: number; reasonCode: string; note: string }, session: Session): Promise<RcmWriteResult<{ writeOffId: number }>>` — reason category `write_off`; `amountPaise > writeOffCeilingPaise(money)` → `write_off_exceeds` with message `The write-off is more than the <fmt ceiling> still open on this claim`. Audit `rcm: requested write-off`, details `claim=<id> write_off=<id> amount=<paise>`.
  - `decideWriteOff(writeOffId: number, input: { decision: 'approve' | 'reject'; note?: string }, session: Session): Promise<RcmWriteResult<null>>` — `session.userId === null` → `no_user_account`; equal to `requestedByUserId` → `same_approver`; not `requested` → `already_decided`; approve re-checks the ceiling excluding this request's own pending amount, then `claims.writtenOffPaise += amount`. Audit `rcm: approved write-off` / `rcm: rejected write-off`, details `claim=<id> write_off=<id> amount=<paise>`.
- SP4 ledger changes (ruling 5):
  - `LedgerEntryKind` gains `'insurer_settlement' | 'write_off'`, sign `−`, ordered after `refund`.
  - `LedgerSummary` gains `insurerSettledPaise` and `writtenOffPaise`.
  - `loadLedgerEntries` adds one entry per `claim_settlements` row of the patient's claims (`at = recordedAt`, `number = \`${claimNumber}/S${id}\``, `amountPaise = settledPaise`, `admissionId = claim.admissionId`) and one per **approved** `claim_write_offs` row (`at = decidedAt`, `number = \`${claimNumber}/W${id}\``). Settlement money never enters `patient_payments`, so it cannot be counted twice.
  - `getPatientLedger` result gains `coveredPendingPaise` (Σ `claimCoveredPendingPaise` over the patient's claims) and `patientPayablePaise` (`splitPatientOutstanding(summary.outstandingPaise, coveredPendingPaise).patientPayablePaise`).
  - `LedgerTable` labels: `Insurer settlement`, `Write-off`.

- [ ] **Step 1: Write the failing tests**

```ts
// ledger.test.ts (append, pure)
it('insurer settlements and write-offs credit the patient ledger', () => {
  /* invoice 1_00_000_00, insurer_settlement 80_000_00, write_off 5_000_00 → balance 15_000_00, insurerSettledPaise 80_000_00, writtenOffPaise 5_000_00 */
})
// claim-updates.test.ts (DB; fixtures through Task 12 to a submitted claim of 1_00_000_00)
it('a partial approval with reconciling deductions sets the money columns', async () => {})
it('approval amounts that do not add up are refused with the gap', async () => {})
it('a double-submitted settlement with the same UTR posts once', async () => {
  const [a, b] = await Promise.all([recordSettlement(id, S, RCM), recordSettlement(id, S, RCM)])
  expect([a.ok, b.ok].sort()).toEqual([false, true]); expect((a.ok ? b : a)).toMatchObject({ error: 'duplicate_utr' })
})
it('settlement above the approved amount still due is refused', async () => {})
it('a write-off needs a second person and stays within the ceiling', async () => { /* same user → same_approver; env admin (userId null) → no_user_account; other admin → ok */ })
it('close is blocked until reconciled and nothing is pending, then reopens to settled', async () => {})
it('a rejection is a full-amount disallowance with its reason', async () => {})
it('audit details carry no UTR or note', async () => {})
// patient-ledger-claims.test.ts (DB)
it('the ledger shows each settlement exactly once', async () => { /* load twice; one insurer_settlement row; balance unchanged between loads */ })
it('patient payable excludes what the insurer still owes', async () => {
  /* invoice 1_00_000_00 on a claim approved 80_000_00 with 15_000_00 recoverable and 5_000_00 non-recoverable → coveredPending 85_000_00, patientPayable 15_000_00; after settling 80_000_00 and writing off 5_000_00 → coveredPending 0, outstanding 15_000_00 */
})
```

- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/lib/billing/ledger.test.ts`, `npm test -- tests/lib/queries/claim-updates.test.ts tests/lib/queries/patient-ledger-claims.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify:** same + `npm test -- tests/lib/queries/patient-ledger.test.ts` (SP4 green) + `npx vitest run tests/pages/cash-desk.test.tsx tests/components/billing` + `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/queries/claim-updates.ts src/lib/billing/ledger.ts src/lib/queries/patient-ledger.ts src/components/billing/LedgerTable.tsx "src/app/(dashboard)/cash-desk/page.tsx" tests
git commit -m "feat(sp7): insurer decisions, settlements with TDS, bank reconciliation, two-person write-offs and the ledger split"
```

---

### Task 14: Claim routes

**Files:**
- Create (all under `src/app/api/rcm/`): `claims/route.ts` (POST), `claims/[id]/invoices/route.ts` (PUT), `claims/[id]/documents/route.ts` (POST multipart), `claims/[id]/documents/attach/route.ts` (POST), `claims/[id]/documents/waive/route.ts` (POST), `claims/[id]/documents/[docId]/route.ts` (DELETE), `claims/[id]/preview/route.ts` (GET), `claims/[id]/submissions/route.ts` (POST), `claims/[id]/actions/route.ts` (POST), `claims/[id]/settlements/route.ts` (POST), `claims/[id]/write-offs/route.ts` (POST), `claim-documents/[id]/route.ts` (GET), `dispatches/[id]/acknowledge/route.ts` (POST), `submissions/[id]/copy/[copy]/route.ts` (GET), `submissions/[id]/verify/route.ts` (GET), `settlements/[id]/reconcile/route.ts` (POST), `write-offs/[id]/decision/route.ts` (POST)
- Modify: `tests/api/rbac-route-gates.test.ts`
- Test: `tests/api/rcm-claims.test.ts`

**Interfaces:**
- Consumes: Tasks 11–13 query functions; Task 7 helpers.
- Every route: gate `RCM_ROLES` except `write-offs/[id]/decision` (`WRITE_OFF_APPROVE_ROLES`). Bodies: Task 4 schemas (`claimCreateSchema`, `claimInvoicesSchema`, multipart via `readUpload` + `claimDocumentMetaSchema`, `attachLabReportSchema`, `waiveDocumentSchema`, `claimSubmitSchema`, `claimUpdateSchema`, `settlementSchema`, `writeOffRequestSchema`, `acknowledgeSchema`, `reconcileSchema`, `writeOffDecisionSchema`). Errors through `rcmErrorResponse`; unexpected through `rcmServerError`.
- Success responses: create 201 `{ claimId, claimNumber }`; submissions 201 `{ version, submissionId, status, warnings }`; actions 200 `{ status, warnings }`; settlements 201 `{ settlementId, warnings }`; write-offs 201 `{ writeOffId }`; others 200 `{ ok: true }`.
- Streams: `claims/[id]/preview` → `application/pdf` inline, `Cache-Control: private, no-store`, filename `<claimNumber>-draft.pdf`; `submissions/[id]/copy/[copy]` (`copy` ∈ `rcm|insurer`, else 400 `Unknown copy`) → `streamPrivateBlob(url, { filename: \`${claimNumber}-v${version}-${copy}.pdf\`, disposition: 'attachment' })`, audit `rcm: downloaded claim copy` (`claim=<id> version=<n> copy=<c>`); `claim-documents/[id]` inline, audit `rcm: viewed claim document`. Missing blob → 404 `Stored file is missing`.
- `submissions/[id]/verify` → 200 `{ snapshotOk, rcmCopyOk, insurerCopyOk }`, audit `rcm: verified claim copy`.

- [ ] **Step 1: Write the failing tests**

```ts
it('billing, crc and frontdesk get 403 on every claim route before the body is read', async () => {})
it('a not-ready submission is a 422 carrying the readiness items', async () => {})
it('rcm gets 403 on the write-off decision; admin gets 200', async () => {})
it('a copy download sets attachment and no-store, and never returns the blob URL in JSON', async () => {})
it('an unknown copy name is a 400', async () => {})
it('a 40P01 from submitClaimVersion is a 409 with the retry message', async () => {})
// API_GATES rows for all 17 routes; SP7_WRITE_GATES rows for every POST/PUT/DELETE (multipart rows send NOT_JSON and expect 403 for denied roles)
```

- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/api/rcm-claims.test.ts` → FAIL.
- [ ] **Step 3: Implement** the routes.
- [ ] **Step 4: Verify:** same + `npm test -- tests/api/rbac-route-gates.test.ts` + `npx vitest run tests/lib/no-aadhaar-leak.test.ts` (after adding `'src/app/api/rcm/claims'` to `EXPORT_PATHS`) + `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/app/api/rcm tests/api/rcm-claims.test.ts tests/api/rbac-route-gates.test.ts tests/lib/no-aadhaar-leak.test.ts
git commit -m "feat(sp7): claim, document, submission, insurer update, settlement and write-off routes"
```

---

### Task 15: RCM dashboard, worklists and the claim workspace

**Files:**
- Create: `src/lib/queries/rcm-worklist.ts`, `src/lib/queries/claim-workspace.ts`, `src/app/(dashboard)/rcm/page.tsx`, `src/app/(dashboard)/rcm/claims/page.tsx`, `src/app/(dashboard)/rcm/claims/new/page.tsx`, `src/app/(dashboard)/rcm/claims/[id]/page.tsx`, `src/components/rcm/{RcmKpis,ClaimWorklistTable,ClaimCandidateTable,NewClaimForm,ClaimHeader,ReadinessPanel,ClaimInvoicesPanel,ClaimDocumentsPanel,ClaimVersionsPanel,SubmitClaimDialog,ClaimTimeline,InsurerUpdateForms,SettlementPanel,WriteOffPanel,SlaBadges}.tsx`
- Modify: `src/components/LeftNav.tsx` (`NAV_ITEMS` `// SP7`: `{ href: '/rcm', label: 'RCM Dashboard', icon: Landmark, roles: ['admin', 'rcm'] }`, `{ href: '/rcm/claims', label: 'Claims', icon: FileStack, roles: ['admin', 'rcm'] }`), `src/app/(dashboard)/page.tsx` (`if (session.role === 'rcm') redirect('/rcm')`), `tests/pages/page-gates-harness.ts`, `tests/pages/dashboard-routing.test.tsx`, `tests/components/LeftNav.test.tsx`
- Test: `tests/lib/queries/rcm-worklist.test.ts` (DB), `tests/lib/queries/claim-workspace.test.ts` (DB), `tests/components/rcm/ReadinessPanel.test.tsx`, `tests/components/rcm/InsurerUpdateForms.test.tsx`, `tests/pages/rcm-pages.test.tsx`

**Interfaces:**
- Consumes: Tasks 2, 11–13; `todayIsoIn`; `formatPaise`; `parseRupeesToPaise`.
- Produces (`rcm-worklist.ts`):
  - `interface ClaimListRow { id: number; claimNumber: string; status: ClaimStatus; claimType: ClaimType; patient: { id: string; name: string; uhid: string | null }; payerName: string; claimedPaise: number; approvedPaise: number | null; settledPaise: number; insurerOutstandingPaise: number; ageDays: number | null; agingBucket: string | null; slaFlags: SlaFlag[]; worklists: ClaimWorklist[] }`
  - `listClaims(opts: { tab?: ClaimWorklist; status?: ClaimStatus; payerId?: number; q?: string; page?: number; now?: Date }): Promise<{ rows: ClaimListRow[]; total: number }>` — 50 per page; `q` = claim number prefix or UHID; `ageDays` from `istDateOf(firstSubmittedAt)`.
  - `listClaimCandidates(now?: Date): Promise<{ patient: …; admissionId: number | null; encounterId: number | null; policyId: number; payerName: string; invoiceCount: number; availablePaise: number; episodeEndDate: string | null; slaFlags: SlaFlag[] }[]>` — episodes with an active policy and finalised invoices for its billing payer that still have `availablePaise > 0`.
  - `getRcmDashboard(now?: Date): Promise<{ counts: Record<ClaimWorklist, number> & { candidates: number; preauthsOverdue: number }; slaBreaches: Record<SlaFlag, number>; insurerOutstandingPaise: number; aging: { label: string; paise: number }[]; settledThisMonthPaise: number; tdsThisMonthPaise: number }>` (IST month).
- Produces (`claim-workspace.ts`):
  - `getClaimWorkspace(claimId: number, session: Session, now?: Date): Promise<ClaimWorkspace | null>` with `ClaimWorkspace = { claim: ClaimRow (blob-free); patient: { id; name; uhid; gender; dob; ageYears; abhaNumber?: string }; policy: PolicyView; payer: { name; kind; channel; slaHours; settlementSlaDays; requiresAbha }; preauth: { id; preauthNumber; status; approvedPaise; validUntil } | null; invoices: { invoiceId; number; date; status; totalPaise; claimedPaise }[]; documents: { id; kind; source; title; contentType; sha256; waived; supersededAt }[]; readiness; versions: { id; version; kind; createdAt; createdByName; snapshotSha256; dispatch: { channel; transport; trackingReference; dispatchedOn; insurerReference; acknowledgedOn } }[]; events: { id; action; fromStatus; toStatus; amountPaise; note; portalCheckedOn; byName; at }[]; queries; disallowances (current decision); settlements (no UTR masking; RCM sees the UTR); writeOffs; money: ClaimMoney & { coveredPendingPaise; writeOffCeilingPaise; insurerOutstandingPaise }; slaFlags; codingDrift; allowedActions: (ClaimAction | 'note')[]; reasonCodes }` — `abhaNumber` present only when `payer.requiresAbha` and `session.role ∈ CLAIM_ABHA_READ_ROLES`; `allowedActions` from `nextClaimStatus` over every action.
- Pages (`RCM_ROLES`; each audited `rcm: viewed …` with the patient id where there is one):
  - `/rcm`: `RcmKpis` (worklist counts linking to `/rcm/claims?tab=`, SLA breaches, insurer outstanding, ageing table, this month's settled and TDS) + "Ready to claim" `ClaimCandidateTable` (links to `/rcm/claims/new?admissionId=|encounterId=&policyId=`). Audit `rcm: viewed RCM dashboard`.
  - `/rcm/claims` (`searchParams: Promise<{ tab?; status?; payerId?; q?; page? }>`): tabs `To submit`, `Queried`, `Awaiting insurer`, `To reconcile`, `Denied`, `All`; `ClaimWorklistTable` with `SlaBadges`; "Showing 1–50 of N".
  - `/rcm/claims/new`: `NewClaimForm` (claim type, pre-auth select, invoice checkboxes with editable claimed rupees defaulting to available) → POST → navigate to the workspace. Bad params → `notFound()`.
  - `/rcm/claims/[id]`: `ClaimHeader` (number, status, payer, policy, patient RCM minimum, money summary, SLA badges, coding-drift banner `Coding changed after the last submission; it must be finalised again before the next version`), `ReadinessPanel` (blocks red, warnings amber, each missing document with Upload / Waive), `ClaimInvoicesPanel` (editable while draft), `ClaimDocumentsPanel`, `ClaimVersionsPanel` (each version: kind, date, who, hash prefix, **Download RCM copy**, **Download insurer copy**, dispatch channel/reference, acknowledgement form, **Verify** button showing the three booleans), `SubmitClaimDialog` (channel select with NHCX disabled and labelled from the gateway status, tracking reference, cover note; disabled while readiness has blocks), `InsurerUpdateForms` (only the forms in `allowedActions`: record query with due date, record decision with deduction rows (reason, rupees, recoverable from patient), rejection, appeal/resubmission, withdraw, close, reopen, portal note), `SettlementPanel` (UTR, payment date, received, TDS, bank charges with inline `settlementProblems`/`settlementWarnings`; reconcile per settlement), `WriteOffPanel` (request; approve/reject shown only to `WRITE_OFF_APPROVE_ROLES`), `ClaimTimeline`. Every form posts to its Task 14 route and calls `router.refresh()`; 4xx shows the returned `error` (and readiness `items`).

- [ ] **Step 1: Write the failing tests**

```ts
// rcm-worklist.test.ts (DB)
it('places claims on their worklists and candidates appear until claimed', async () => {})
it('ageing buckets use the first submission date in IST', async () => {})
// claim-workspace.test.ts (DB)
it('workspace patient header carries only the RCM minimum', async () => {
  const w = await getClaimWorkspace(id, RCM); expect(Object.keys(w!.patient).sort()).toEqual(['ageYears', 'dob', 'gender', 'id', 'name', 'uhid'])
  expect(JSON.stringify(w)).not.toMatch(/phone|email|address|blob\.vercel|blobUrl/i)
})
it('ABHA appears only for a requiring payer and an allowed role', async () => {})
it('allowedActions follow the status', async () => { /* submitted → record_query, record_rejection, record_approval, record_partial_approval, withdraw, note */ })
// ReadinessPanel.test.tsx
it('lists blocks before warnings and offers Upload and Waive for a missing document', () => {})
// InsurerUpdateForms.test.tsx
it('the decision form shows the deduction gap live and blocks submit until it is zero', async () => { /* claimed ₹1,00,000, approved ₹80,000, one deduction ₹15,000 → 'Disallowed amounts must add up … (₹20,000.00)' */ })
// rcm-pages.test.tsx + PAGE_GATES rows: '/rcm', '/rcm/claims' (searchParams {}), '/rcm/claims/new' (searchParams {}), '/rcm/claims/[id]' (params { id: '1' }) — all ['admin', 'rcm']
// dashboard-routing.test.tsx: rcm → '/rcm'; LeftNav.test.tsx: rcm sees RCM Dashboard and Claims and no Billing group
```

- [ ] **Step 2: Run to verify failure:** `npm test -- tests/lib/queries/rcm-worklist.test.ts tests/lib/queries/claim-workspace.test.ts`, `npx vitest run tests/components/rcm tests/pages/rcm-pages.test.tsx tests/pages/dashboard-routing.test.tsx tests/components/LeftNav.test.tsx` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify:** same + `npx vitest run tests/pages/nav-role-enforcement.test.tsx` + `npx tsc --noEmit` + `npx eslint src/components/rcm "src/app/(dashboard)/rcm"` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/queries/rcm-worklist.ts src/lib/queries/claim-workspace.ts "src/app/(dashboard)/rcm" "src/app/(dashboard)/page.tsx" src/components/rcm src/components/LeftNav.tsx tests
git commit -m "feat(sp7): RCM dashboard, claim worklists with SLA flags, and the claim workspace"
```

---

### Task 16: Pre-authorisation and insurer/TPA master pages

**Files:**
- Create: `src/app/(dashboard)/rcm/preauths/page.tsx`, `src/app/(dashboard)/rcm/preauths/new/page.tsx`, `src/app/(dashboard)/rcm/preauths/[id]/page.tsx`, `src/app/(dashboard)/rcm/payers/page.tsx`, `src/app/(dashboard)/rcm/payers/[id]/page.tsx`, `src/app/(dashboard)/rcm/settings/page.tsx`, `src/components/rcm/{PreauthForm,EstimateTable,PreauthActions,PreauthTimeline,PayerProfileForm,PayerContactsForm,PayerNetworkForm,DocumentRequirementsForm,HospitalIdentifiersForm}.tsx`
- Modify: `src/components/LeftNav.tsx` (`NAV_ITEMS` `// SP7`: `{ href: '/rcm/preauths', label: 'Pre-authorisations', icon: FileCheck2, roles: ['admin', 'rcm'] }`, `{ href: '/rcm/payers', label: 'Insurers & TPAs', icon: Building2, roles: ['admin', 'rcm'] }`; `NAV_TRAILING_ITEMS`: `{ href: '/rcm/settings', label: 'RCM Settings', icon: Settings2, roles: ['admin'] }`), `tests/pages/page-gates-harness.ts`
- Test: `tests/components/rcm/PreauthForm.test.tsx`, `tests/components/rcm/PayerProfileForm.test.tsx`, `tests/pages/rcm-preauth-payer-pages.test.tsx`

**Interfaces:**
- Consumes: Task 7 (`listRcmPayers`, `getRcmPayer`, `listReasonCodes`, `getHospitalIdentifiers`), Task 8 (`findPatientsForRcm`, `listPatientPolicies`), Task 9 (`listPreauths`, `getPreauthDetail`), Task 10 routes, `GET /api/tariff/services?q=` and `GET /api/coding/codes?kind&q` (both now admit `rcm`).
- Pages (`RCM_ROLES`, except `/rcm/settings` = `RCM_SETTINGS_ROLES`):
  - `/rcm/preauths` (`searchParams` `status`, `q`, `page`): table of number, patient + UHID, payer, status badge, requested/approved, valid until, a red `Decision overdue` badge.
  - `/rcm/preauths/new` (`searchParams` `q`, `patientId`): patient search (`findPatientsForRcm`) → the patient's active policies → `PreauthForm`: claim type, admission/visit select, planned date, length of stay, room category, treating doctor, diagnosis and procedure code pickers (SP6 code search), provisional text, `EstimateTable` (service search rows with quantity; every change posts `/api/rcm/preauths/estimate`, debounced 300 ms, showing each line's price source and the total), requested amount (defaults to the estimate). Submit creates the draft and navigates to its page.
  - `/rcm/preauths/[id]`: header, estimate, `PreauthActions` (only the actions `nextPreauthStatus` allows: request, record query, respond (with document upload), approve (amount, reference, valid until), reject (reason), request/approve/reject enhancement, cancel), documents, `PreauthTimeline`. Audit `rcm: viewed pre-authorisation`, patient id.
  - `/rcm/payers`: payers with kind, empanelment, channel, SLA, active; "Add insurer or TPA"; legacy payers without a profile listed under "Needs a profile".
  - `/rcm/payers/[id]`: `PayerProfileForm`, `PayerContactsForm`, `PayerNetworkForm` (insurers only: pick TPAs), `DocumentRequirementsForm` (per claim type, defaults shown ticked from `DEFAULT_REQUIRED_DOCUMENTS`).
  - `/rcm/settings`: `HospitalIdentifiersForm` (ROHINI, HFR).
  - No PHI on payer/settings pages, so they are not audited on view.

- [ ] **Step 1: Write the failing tests**

```ts
it('PreauthForm shows the live estimate with price sources and an unpriced service message', async () => { /* mock fetch → 'Payer rate', 'No tariff rate covers SVC9' */ })
it('PreauthActions offers only the allowed actions for the status', () => { /* approved → Request enhancement, Cancel */ })
it('PayerProfileForm shows the network section only for insurers', () => {})
// PAGE_GATES rows: '/rcm/preauths', '/rcm/preauths/new' (searchParams {}), '/rcm/preauths/[id]' (params { id: '1' }), '/rcm/payers', '/rcm/payers/[id]' (params { id: '1' }) — ['admin', 'rcm']; '/rcm/settings' — ['admin']
```

- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/components/rcm tests/pages/rcm-preauth-payer-pages.test.tsx` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify:** same + `npx vitest run tests/pages/nav-role-enforcement.test.tsx tests/components/LeftNav.test.tsx` + `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/rcm" src/components/rcm src/components/LeftNav.tsx tests
git commit -m "feat(sp7): pre-authorisation screens with live tariff estimate, insurer/TPA master and RCM settings pages"
```

---

### Task 17: Policies UI — RCM policy page, patient-page panel, charge-capture pre-auth picker

**Files:**
- Create: `src/app/(dashboard)/rcm/policies/page.tsx`, `src/components/rcm/{PatientPoliciesPanel,PolicyForm,PolicyCardUpload}.tsx`, `src/components/billing/PreauthPicker.tsx`
- Modify: the patient detail page under `src/app/(dashboard)/patients/[anonId]/` (render `PatientPoliciesPanel` for `POLICY_READ_ROLES ∩ PATIENT_DIRECTORY_ROLES`; editable for `POLICY_WRITE_ROLES`), `src/components/billing/ChargeCaptureForm.tsx` (`// SP7`: the pre-auth reference input becomes `PreauthPicker`), `src/components/LeftNav.tsx` (`{ href: '/rcm/policies', label: 'Policies', icon: IdCard, roles: ['admin', 'rcm'] }`), `tests/pages/page-gates-harness.ts`
- Test: `tests/components/rcm/PolicyForm.test.tsx`, `tests/components/billing/PreauthPicker.test.tsx`, `tests/pages/rcm-policies-page.test.tsx`, `tests/pages/patient-policies-panel.test.tsx`

**Interfaces:**
- Consumes: Task 8 (`findPatientsForRcm`, `listPatientPolicies`, `legacyPolicyPrefill`), Task 8 routes, Task 10 `GET /api/rcm/patients/[anonId]/approved-preauths`, `listRcmPayers({ kind })`.
- `PatientPoliciesPanel({ patientId, policies, payers, canEdit, legacyPrefill })`: cards per policy (insurer, TPA, policy/member number, plan, validity with an `Expired` badge when `validTo < today IST`, sum insured, priority, status, card thumbnails loaded from `/api/rcm/policies/<id>/card/<side>`); "Add policy" opens `PolicyForm`; when `legacyPrefill` is non-null and the patient has no policy, a notice `Older insurance details are on file. Use them to start a policy?` with a button that pre-fills the form (ruling 6).
- `PolicyForm`: every `policySchema` field; insurer select limited to insurer/government/corporate profiles, TPA select to TPAs; rupee inputs via `parseRupeesToPaise`; client-side `policySchema.safeParse` shows the authored messages (incl. `NATIONAL_ID_MESSAGE`); the card upload says `Do not upload national ID cards here.`
- `/rcm/policies` (`RCM_ROLES`, `searchParams` `q`, `patientId`): patient search, then the panel (editable). Audit `rcm: viewed patient policies`, patient id.
- The patient page panel is audited by the page's existing audit; no new audit.
- `PreauthPicker({ patientId, serviceDate, value, onChange })`: fetches approved pre-auths for the date; shows `<PA number> · <approval reference> · <fmt approved> · valid to <date>`; free text still allowed (validated server-side by `preauth_invalid`).

- [ ] **Step 1: Write the failing tests**

```ts
it('PolicyForm refuses an Aadhaar-like member number with the authored message', async () => {})
it('PolicyForm needs the employer for a corporate policy', async () => {})
it('the panel offers the legacy prefill only when there is no policy', () => {})
it('PreauthPicker lists approved pre-auths and keeps free text', async () => {})
it('frontdesk sees an editable panel; billing a read-only one; pi none', async () => {})
// PAGE_GATES: '/rcm/policies' (searchParams {}) ['admin', 'rcm']
```

- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/components/rcm/PolicyForm.test.tsx tests/components/billing/PreauthPicker.test.tsx tests/pages/rcm-policies-page.test.tsx tests/pages/patient-policies-panel.test.tsx` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify:** same + `npx vitest run tests/components/billing/ChargeCaptureForm.test.tsx tests/pages/nav-role-enforcement.test.tsx tests/pages/patients-frontdesk-view.test.tsx` + `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/rcm/policies" "src/app/(dashboard)/patients" src/components/rcm src/components/billing src/components/LeftNav.tsx tests
git commit -m "feat(sp7): policy screens, patient-page policies panel with legacy prefill, and the charge-capture pre-auth picker"
```

---

### Task 18: RCM reports — ageing, denials, payer performance, claim register CSV

**Files:**
- Create: `src/lib/rcm/csv.ts`, `src/lib/queries/rcm-reports.ts`, `src/app/(dashboard)/rcm/reports/page.tsx`, `src/app/api/rcm/reports/claims-csv/route.ts` (GET), `src/components/rcm/{AgingByPayerTable,DenialAnalysisTable,PayerPerformanceTable}.tsx`
- Modify: `src/components/LeftNav.tsx` (`{ href: '/rcm/reports', label: 'RCM Reports', icon: FileSpreadsheet, roles: ['admin', 'rcm'] }`), `src/app/(dashboard)/billing/insurance-collections/page.tsx` and `ar-dashboard/page.tsx` (heading suffix ` (legacy demo data)` and a line `Insurance claims are managed under RCM.` linking to `/rcm` for `RCM_ROLES`; behaviour unchanged, ruling 6), `tests/pages/page-gates-harness.ts`, `tests/api/rbac-route-gates.test.ts`
- Test: `tests/lib/rcm/csv.test.ts`, `tests/lib/queries/rcm-reports.test.ts` (DB), `tests/api/rcm-reports.test.ts`, `tests/pages/rcm-reports.test.tsx`

**Interfaces:**
- Consumes: Task 2 (`AGING_BUCKETS`, `agingBucketLabel`, `insurerOutstandingPaise`, `daysBetweenIso`); `paiseFromDb`; `formatPaise`.
- Produces (`csv.ts`): `toCsv(rows: (string | number | null)[][]): string` — CRLF lines, RFC 4180 quoting, `null` → empty, and any cell starting `=`, `+`, `-`, `@`, tab or CR prefixed with `'` (formula injection).
- Produces (`rcm-reports.ts`; ranges are IST dates, inclusive, on `firstSubmittedAt`):
  - `agingByPayer(now?: Date): Promise<{ payerId: number; payerName: string; buckets: Record<string, number>; totalPaise: number }[]>` — `insurerOutstandingPaise` per live claim, bucketed by days since first submission.
  - `denialAnalysis(range: { from: string; to: string }): Promise<{ reasonCode: string; label: string; category: ReasonCategory; claims: number; amountPaise: number; patientRecoverablePaise: number }[]>` — current-decision disallowances only.
  - `payerPerformance(range): Promise<{ payerId: number; payerName: string; claims: number; claimedPaise: number; approvedPaise: number; settledPaise: number; tdsPaise: number; disallowedPaise: number; writtenOffPaise: number; approvalRateBp: number; avgDaysToSettle: number | null }[]>` — `approvalRateBp = round(approved × 10000 / claimed)` with BigInt; days to settle = first submission → first settlement.
  - `claimRegisterRows(range): Promise<(string | number | null)[][]>` — header `['Claim number', 'Status', 'Claim type', 'UHID', 'Patient', 'Payer', 'First submitted', 'Claimed (Rs)', 'Approved (Rs)', 'Settled (Rs)', 'TDS (Rs)', 'Written off (Rs)', 'Insurer reference']`; rupees as `'12345.67'` strings from paise (no floats). No policy number, member id, UTR or diagnosis.
- Page `/rcm/reports` (`RCM_ROLES`, `searchParams` `from`, `to`; default the current IST month): the three tables and a "Download claim register (CSV)" link. Audit `rcm: viewed RCM reports`.
- Route `GET /api/rcm/reports/claims-csv?from&to` (`RCM_ROLES`): bad or reversed dates → 400 `Choose a valid date range`; a range over 366 days → 400 `Choose at most one year`; 200 `text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="claim-register-<from>-to-<to>.csv"`, `Cache-Control: private, no-store`. Audit `rcm: exported claim register`, details `from=<d> to=<d> rows=<n>`.

- [ ] **Step 1: Write the failing tests**

```ts
// csv.test.ts
it('quotes, escapes and neutralises formulas', () => {
  expect(toCsv([['a,b', 'say "hi"', null], ['=SUM(A1)', '-5', 3]])).toBe('"a,b","say ""hi""",\r\n\'=SUM(A1),\'-5,3\r\n')
})
// rcm-reports.test.ts (DB)
it('ageing by payer sums insurer outstanding into buckets', async () => {})
it('denial analysis groups current deductions by reason with the recoverable split', async () => {})
it('payer performance computes approval rate and days to settle', async () => {})
it('the claim register has no policy, member, UTR or diagnosis columns', async () => {})
// rcm-reports.test.ts (route)
it('a reversed range is a 400; a valid one is an attachment CSV', async () => {})
// PAGE_GATES '/rcm/reports' (searchParams {}) ['admin', 'rcm']; API_GATES row for the CSV route
```

- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/lib/rcm/csv.test.ts tests/api/rcm-reports.test.ts tests/pages/rcm-reports.test.tsx`, `npm test -- tests/lib/queries/rcm-reports.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify:** same + `npx vitest run tests/pages/nav-role-enforcement.test.tsx tests/lib/no-aadhaar-leak.test.ts tests/lib/no-credential-leak.test.ts` + `npm test -- tests/api/rbac-route-gates.test.ts` + `npx vitest run tests/pages` (page harness) + `npx tsc --noEmit` + `npx eslint src/lib/rcm src/lib/queries src/app/api/rcm "src/app/(dashboard)/rcm" src/components/rcm` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/rcm/csv.ts src/lib/queries/rcm-reports.ts "src/app/(dashboard)/rcm/reports" src/app/api/rcm/reports src/components/rcm src/components/LeftNav.tsx "src/app/(dashboard)/billing/insurance-collections/page.tsx" "src/app/(dashboard)/billing/ar-dashboard/page.tsx" tests
git commit -m "feat(sp7): RCM ageing, denial, payer performance reports and a formula-safe claim register export"
```

---

## Execution notes

**Model tier per task:**

| Task | Tier | Local DB needed |
|---|---|---|
| 1 rcm role everywhere | standard (wide but mechanical; tsc finds the gaps) | **yes** (apply migration a twice; role DB test; harness) |
| 2 Machines / money / SLA | standard (the transition tables and invariants are the contract) | no |
| 3 Readiness / snapshots | standard | no |
| 4 Schemas / errors / gateway | cheap | no |
| 5 Schema B | standard | **yes** (apply twice; FK-guard and seed-order tests) |
| 6 Schema C + triggers + retention | most capable (trigger column checks, purge setting, deletePatient guard) | **yes** |
| 7 Payer master | standard | **yes** (query DB test; harness) |
| 8 Policies + cards | standard | **yes** |
| 9 Pre-auth lifecycle + reference validator | most capable (lock order, enhancement fallback, reference matching) | **yes** |
| 10 Pre-auth routes + SP4 rule | standard (edits SP4's rule table; SP4 tests must stay green) | **yes** (capture DB test, harness) |
| 11 Claim drafts + SP4 cancel guard | most capable (over-claim race, available-amount maths, readiness loader) | **yes** |
| 12 Submission / two copies | most capable (render-before-tx, stale detection, hashes, coding drift) | **yes** |
| 13 Insurer updates / settlements / ledger | most capable (double-post race, ceilings, ledger split across SP4) | **yes** |
| 14 Claim routes | cheap | harness only (`npm test -- tests/api/rbac-route-gates.test.ts`) |
| 15 Dashboard / worklists / workspace | standard | **yes** (worklist and workspace DB tests) |
| 16 Pre-auth and payer pages | standard | no |
| 17 Policies UI + picker | standard | no |
| 18 Reports + CSV | standard | **yes** (report DB tests) |

Order: 1 → 2 → 3 → 4, then 5 → 6, then 7 → 8 → 9 → 10, then 11 → 12 → 13 → 14, then 15 → 16 → 17 → 18. Tasks 7, 8, 10, 14 and 18 edit `rbac-route-gates.test.ts`, and 15–18 edit `LeftNav.tsx` and `page-gates-harness.ts`: serialise those. Tasks 10, 11 and 13 edit SP4 files; run the named SP4 tests in each.

**Rulings made in this plan:**

1. **A new `rcm` role, not a widened `billing`.** The spec names `rcm` (§3), and two reasons make it necessary rather than cosmetic. *Separation of duties:* `billing` finalises invoices and issues refunds (SP4); if the same login could also post insurer settlements and write-offs, one person could raise a bill and quietly extinguish it. *PHI:* claims need coded diagnoses, the discharge summary and lab reports, which `billing` is deliberately denied today ("billing section only; no clinical routes"). `rcm` gets exactly what claims need: no global search, no patient directory, no chart, no charge capture, no invoice finalisation; read-only coded clinical content only inside a claim. Admin keeps every power and alone approves write-offs. frontdesk records policies at the desk; billing and crc pick an approved pre-auth while capturing. The role is added to every roster SP6 touched for `coder`, and every existing gate row proves it is denied.
2. **How claims reference SP4 invoices.**
   - A claim links **finalised** invoices of one patient's episode (one admission, or one OPD encounter) whose `payer_id` is the policy's billing payer (the TPA when there is one, else the insurer). Invoices stay immutable; the claim stores each invoice's total at link time and its own `claimedPaise`.
   - **Partial claims:** `claimedPaise` may be less than the invoice total (non-payables left to the patient). One invoice may sit on several claims (secondary policy, corporate buffer, top-up) as long as the claimed amounts on non-withdrawn claims never exceed its total; all claim writes take the SP4 per-patient lock, so two clerks cannot over-claim.
   - **Credit notes after a claim:** SP4 `cancelInvoice` is refused while the invoice is on a claim that is not draft or withdrawn. After submission, corrections go through the insurer's decision (deductions) or by withdrawing the claim, cancelling, re-invoicing and claiming again. A draft claim does not block cancellation; its readiness then shows `invoice_cancelled`.
3. **Two copies.** Every outbound package (initial submission, query response, appeal, resubmission) is a new **version**: a `claim_submissions` row holding the canonical snapshot and its SHA-256, plus two PDFs rendered from that one snapshot. The **RCM copy** (banner "RCM COPY - RETAINED BY HOSPITAL", ending with the snapshot hash) is the hospital's retained record. The **insurer copy** (banner "INSURER COPY") is what the RCM user uploads to the insurer's portal, emails or couriers. Its dispatch is recorded with channel, tracking reference, date and user, and later the insurer's own claim reference. Snapshots, versions and events are append-only in the database (triggers), every copy's hash is stored, and **Verify** recomputes all three hashes. Attachments travel by reference: the snapshot's document index carries each file's SHA-256, and no ZIP is built.
4. **Manual now, gateway-shaped.** There is no live insurer integration. `ClaimGateway` has a `manual` implementation for portal, email, courier and hand delivery: submitting records the dispatch, and insurer outcomes are entered by hand. `nhcxGatewayStub` reports "not configured" and refuses, with no mock. SP8 registers the real NHCX adapter (and its env-flagged mock) through `getClaimGateway`'s registry and maps `ClaimSnapshot` / `PreauthSnapshot` to FHIR `Claim` bundles (mapping in `snapshot.ts`). Because the snapshot already carries ROHINI/HFR ids, NHCX participant codes, coded diagnoses and procedures with versions, items and document hashes, SP8 needs no schema change.
5. **Settlement posts to the SP4 ledger once.**
   - Insurer money never enters `patient_payments`. SP4's ledger reads `claim_settlements` (received + TDS + bank charges, all of which extinguish what the patient owed) and **approved** write-offs as two new credit kinds, one row per source row.
   - Each settlement is unique per claim and UTR, bounded by the approved amount still due, and immutable, so it cannot be posted twice or over-posted.
   - The DB check `settled + written_off ≤ claimed` and the per-invoice claimed cap bound every credit by the bill.
   - While a claim is open, `coveredPendingPaise` (the claimed, or the approved plus the hospital-absorbed deductions, less what is already credited) is shown as "Awaiting insurer", and only the remainder is "Patient payable" at the cash desk. Patient-recoverable deductions become patient payable the moment they are recorded.
   - A bulk NEFT covering many claims is entered once per claim with the same UTR (unique per claim, not globally).
6. **Legacy coexistence.**
   - `insurance_claims`, its US status enum, `/billing/insurance-collections`, the legacy A/R dashboard, `insurance_eligibility_checks` and `mock_payments` are untouched; the two pages are labelled "legacy demo data" and point to RCM. New claims never write `insurance_claims`.
   - `payers` is extended, not replaced: a 1:1 `payer_profiles` row makes a payer an insurer, TPA, government scheme or corporate. `payer_type` (US enum) is ignored, and new payers get `'other'`. SP2 payer tariffs and SP4 `requires_preauth/gstin/state_code` keep working on the same ids.
   - Patient policies replace the US-style `primary*`/`secondary*` columns gradually: nothing is migrated or dropped, the policy form can pre-fill from them, and an active primary policy mirrors its billing payer into `patients.primary_payer_id`, so SP4 pricing and "bill to payer" keep working unchanged.
7. **Pre-auth reference interface for SP4.** `validatePreauthReference(executor, { patientId, payerId, reference, serviceDate })` matches the insurer's approval reference or the hospital's `PA-` number (case-insensitive) among the patient's pre-auths and returns `valid | not_found | not_approved | expired | payer_mismatch` with the pre-auth id. SP4 gains the configurable, non-overridable `preauth_invalid` rule and stores `charge_lines.preauth_id` when valid. The typed reference stays on the line, as SP4 built it.
8. **Numbering.** Claims and pre-auths are not GST documents, so they use Postgres sequences (`CLM-2026-000123`, `PA-2026-000123`), which may have gaps, not SP4's gapless counters.
9. **PHI.**
   - RCM sees patient id, name, UHID, gender, DOB and age; ABHA only when the payer requires it (e.g. a government scheme) and for `admin`/`rcm`. Never phone, email, address, contacts or Aadhaar.
   - Snapshots and PDFs follow the same rule, and the export-path Aadhaar scan covers them.
   - ID-proof uploads choose a type from a list without Aadhaar; a masked UID card needs an explicit "first 8 digits hidden" confirmation, and the system never reads the digits.
   - Policy and member numbers that look like a national ID number (Verhoeff check) are refused.
   - Audit rows never carry UTRs, policy or member numbers, references, notes, questions or file names.
10. **Coding gate.** A claim cannot be submitted (or resubmitted) unless the episode's coding is `finalised` (SP6 ruling 2). If coding is reopened after a submission, the workspace flags the drift, and the next version stays blocked until coding is finalised again. Earlier versions keep the codes they were sent with.
11. **Retention.** A patient with any submitted claim, any submission, or any pre-auth beyond draft/cancelled cannot be deleted (SP4's `PatientHasFinancialRecordsError`). Draft claims, draft pre-auths and policies are deleted with the patient.
12. **Write-offs need two people.** rcm or admin requests; a different admin with a staff account approves. The env-only admin login cannot approve. Only approved write-offs reach the ledger, and only up to what is still open.
13. **Decisions decide the status.** RCM enters the approved amount and deductions; the server picks `approved` (equal to claimed) or `partially_approved`. A rejection is recorded as approved 0 with one full-amount deduction carrying the reason and whether the patient must pay. Deductions must add up to the gap exactly.
14. **SLA defaults** follow the IRDAI master circular on health insurance (May 2024): a cashless decision within 1 hour (`preauthSlaHours` 1) and claim settlement within 30 days. The submission window (15 days) and query response (7 days) are common TPA terms. All four are editable per payer.
15. **Uploads ≤ 4 MB** (PDF/JPEG/PNG) to stay under the platform request-body limit; larger scans must be split or compressed.

**Ambiguities flagged for the owner:**
- **SLA and empanelment values** are defaults. Confirm per payer agreement and the current IRDAI circular.
- **ROHINI and HFR formats** (13 digits; `IN` + 10 digits) are assumed. Confirm with an actual hospital registration.
- **Insurer claim forms (Part A/B) are not generated.** They are uploaded as scanned documents. A generated claim form could follow once the owner names the insurers whose formats matter.
- **No ZIP "insurer package".** The insurer copy is one PDF plus individually downloadable attachments listed with hashes. A ZIP needs a new dependency.
- **Masked UID uploads** are allowed with confirmation, because many insurers still ask for KYC. If the hospital's legal position is "never", remove `masked_uid` from `ID_PROOF_TYPES`.
- **Reason codes** are seeded and read-only in SP7. If RCM must add insurer-specific codes, a small admin screen is needed.
- **Not built:** insurer statement-of-account import and auto-matching of bulk remittances; TDS certificate (Form 16A) tracking; room-rent proportionate-deduction calculation; reimbursement claims filed by patients; coordination-of-benefits ordering between primary and secondary policies (multiple claims per invoice are allowed, but order is not enforced); automatic eligibility checks (the legacy simulated eligibility stays; NHCX `CoverageEligibilityRequest` is SP8).
- **Discharge summary in the claim** comes from SP3's data shape, rendered inside the claim copy. If the insurer needs the signed paper summary, RCM uploads the scan as `discharge_summary`; the readiness check accepts either.
- **SP4 receipts against claims:** payments the patient makes are not allocated to a claim; the cash desk shows patient payable as a per-patient figure.
