# SP5: Lab LIS Extension & Home Collection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry a lab test from the doctor's order to the patient's return visit, as the owner described it: "If they are a LOCAL patient they should be notified that they should perform these tests, then there should be HOME COLLECTION for the labs, then form the reports, then they should again come for the checkup." Concretely:
- a lab order status machine `ordered → scheduled → collected → received → resulted → verified → reported` (+ `cancelled`), with a human-readable, check-digited **sample ID** per order;
- **local patient** = the collection address PIN is in an admin-managed service-area PIN list; everyone else is walk-in only;
- **home-collection booking**: IST date + collection window with capacity, an address snapshot from the SP1 address (editable for the visit), contact phone, collector assignment, reschedule/cancel with reason codes, double-booking guards under a lock; a new `collector` role with a "My route" page;
- a **notification service** (`src/lib/notify`): notifier interface with a log-only implementation, template registry, delivery log table, per-patient opt-out; the doctor's order of tests for a local patient triggers the first notice;
- **result entry by labs, verification by pi/admin**, the FHIR webhook mapped onto the new statuses;
- a server-side **PDF lab report** stored privately in the blob store, downloadable only through audited routes, and a portal "Your lab reports" page;
- on report release, a **follow-up order** (SP3) with source `lab_report` and `originating_lab_order_id` when the doctor asked for one;
- each order line carries a **price quoted** from the SP2 tariff resolver (no invoicing; SP4 owns that).

**Architecture:**
- Orders stay one test per `lab_orders` row. A new `lab_requisitions` row groups the tests a doctor orders together. It is the unit for the patient notice, the report and the follow-up request. Existing orders get one requisition each from an idempotent backfill.
- All status, sample-ID, service-area, pricing-mapping and booking-date logic is pure, client-safe code under `src/lib/labs/` and `src/lib/home-collection/`. Writes go through query modules that run one `getDb().transaction` each, with the audit row on the same `tx` (the SP1/SP3 pattern). Routes are thin and their unit tests mock the query modules.
- Every DB write path that hands out a number takes a Postgres advisory transaction lock: sample sequence per IST date, window capacity per (date, window).
- Side effects that can fail (blob upload, PDF render) happen **before** the transaction. The transaction re-checks that nothing changed. Notifications happen **after** commit and never fail the request.

**Tech Stack:** Next.js 16 App Router (route `params` and page `searchParams` are `Promise`s; `src/proxy.ts`, not middleware), drizzle-orm 0.45 + node-postgres (real transactions), zod v4, `@vercel/blob` (private store), **`pdf-lib` 1.17.1 (new, see Ruling 2)**, `qrcode` (already a dependency), vitest + jsdom + Testing Library, lucide-react.

**Spec:** `docs/superpowers/specs/2026-10-07-indian-hims-design.md`. Sections 1–4, 6 and 7 are binding. This plan implements sub-project 5, "Lab LIS extension & home collection", and the parts of §3 "Notifications" and §3 "Documents" (lab report PDF) that it needs.

**Depends on:**
- SP1 (merged): patient address/state/PIN/phone/UHID, `publicPatientColumns`, `logAudit(session, action, patientId, details, executor)`, `tests/db/migration-sql.ts`, `normalizePhone`, `isValidPinCode`, `isIndianStateCode`, `verhoeffCheckDigit`/`verhoeffValidate`, `ageOnDate`.
- SP2 (merged): `resolvePrice`, `loadPricingContext`, `PriceResolution`, `service_catalog`, `tariff_rates`.
- SP3 (**must be merged to `main` before Task 1**; plan `docs/superpowers/plans/2026-10-07-sp3-encounters-followup.md`): `encounters` (type `lab` reserved), `follow_up_orders.originating_lab_order_id` and source `lab_report` (reserved), `followUpIntervalUnitEnum`, `createFollowUpOrder(…, { executor, today })`, `notifyFollowUpSafely`, `WriteExecutor` (`src/lib/queries/executor.ts`), `istDateOf` / `startOfIstDay` / `formatIsoDate` / `formatDateTimeIn` / `istSlotString`, `isoDateSchema` / `followUpIntervalSchema` / `followUpReasonSchema` (`src/lib/follow-ups/validation.ts`), `readJsonBody` (`src/lib/follow-ups/route-responses.ts`), the `SP3_WRITE_GATES` harness list.

## Global Constraints

- Read `AGENTS.md`. Before writing any route or page, read the matching guide in `node_modules/next/dist/docs/`, because Next 16 differs from training data. Route context is `{ params: Promise<{ … }> }`. Page props are `{ params: Promise<…>; searchParams: Promise<…> }`.
- **Worktree:** `.worktrees/sp5`, branch `feature/sp5-lab-home-collection`, off `main` after the SP3 merge. Copy `.env.local` from the main checkout. Never touch other worktrees.
- **Time (spec §3 "default timezone Asia/Kolkata"):**
  - Business dates (visit date, sample date, "today", report year) are `date` / `YYYY-MM-DD` strings computed only with `todayIsoIn()` or `istDateOf(instant)`.
  - Window times are `'HH:MM'` IST strings. An instant is built only with `new Date(istSlotString(dateIso, hhmm))`.
  - Instants stay `timestamp` (UTC). Display uses `formatIsoDate` / `formatDateTimeIn`, never `toLocaleString()` in new code.
  - Never `new Date().toISOString().slice(0, 10)` for a business day.
- **Money (spec §3):** integer paise, `INR`. A quoted price is `0 ≤ paise ≤ 1_000_000_000` (int4-safe cap, DB check). Display with `formatPaise`.
- **PHI rules:**
  - Every read of `patients` selects named columns or `publicPatientColumns`. `tests/lib/no-credential-leak.test.ts` stays green.
  - **No Aadhaar anywhere:** SP5 code never references `patientAadhaar`, `aadhaar*` or `src/lib/crypto.ts`. `tests/lib/no-aadhaar-leak.test.ts` stays green, unchanged. The report data type has no Aadhaar or ABHA field.
  - Audit `details` carry ids, dates, counts and enum codes only. They never carry addresses, phone numbers, free-text reasons/notes, result values or test names.
  - Patient notification texts carry the hospital name, dates and window labels only. Never the patient's name, test names or results.
- **RBAC** (constants from Task 3, in `src/lib/role-policy.ts`, an `// SP5` block):

  | Constant | Roles | Grants |
  |---|---|---|
  | `LAB_WORKLIST_ROLES` | admin, pi, crc, labs | `/labs`, `GET /api/lab-orders` (existing gate, now named) |
  | `LAB_ORDER_ROLES` | admin, pi | order tests (requisition), cancel an order |
  | `LAB_COLLECT_ROLES` | admin, pi, labs | walk-in collect, imaging attach (existing gate, now named) |
  | `LAB_RECEIVE_ROLES` | admin, labs | receive a sample by sample ID |
  | `LAB_RESULT_ENTRY_ROLES` | admin, labs | enter or amend a result (pi removed: spec role split) |
  | `LAB_VERIFY_ROLES` | admin, pi | verify a result |
  | `LAB_REPORT_RELEASE_ROLES` | admin, pi, labs | generate and release the PDF report |
  | `LAB_REPORT_READ_ROLES` | admin, pi, crc, labs | staff report download |
  | `LAB_LABEL_ROLES` | admin, pi, labs, frontdesk | `/lab-labels` sample label sheet |
  | `LAB_SETUP_ROLES` | admin | service-area PINs, collection windows, lab test sample/tariff setup |
  | `HOME_COLLECTION_BOOKING_ROLES` | admin, frontdesk, labs | `/home-collections`, booking context, availability, book, reschedule |
  | `HOME_COLLECTION_CANCEL_ROLES` | admin, frontdesk, labs, collector | cancel a visit (collector: own visit, collector reasons only) |
  | `HOME_COLLECTION_DISPATCH_ROLES` | admin, labs | assign a collector |
  | `COLLECTOR_ROUTE_ROLES` | admin, collector | `/collections`, mark a visit collected (collector: own visits only) |
  | `NOTIFICATION_PREFERENCE_ROLES` | admin, crc, frontdesk | toggle a patient's notification opt-out |

  - **API order:** `requireSession()` → inline allowlist check returning exactly `NextResponse.json({ error: 'Forbidden' }, { status: 403 })` → only then parse the body with SP3's `readJsonBody` (non-JSON → `400 { error: 'Invalid JSON' }`, never a 500) → zod → path id (`parseId` from `src/lib/tariff/route-responses.ts`).
  - **Page order:** `requireSessionOrRedirect()` is the first statement, then `redirect('/')` for a denied role, before any data load.
  - **Harnesses:** every new or changed staff route gets an `API_GATES` row in `tests/api/rbac-route-gates.test.ts`. Every route with a JSON body also gets a row in a new `const SP5_WRITE_GATES: typeof SP1_WRITE_GATES` list, appended to the existing deny-before-parse `describe.each([...])`. Every new page gets a `PAGE_GATES` row in `tests/pages/page-gates-harness.ts`. No `gap` tags. `LeftNav` roles equal the page gate.
- **Audit:** every write calls `logAudit(session, action, patientId, details, tx)` on the transaction that makes the change, with the exact action strings each task names. The LIS webhook audits through `logIntegrationEvent(…, tx)`. Notification audits run after commit.
- **Notifications:** SP5 never imports `src/lib/sms.ts` or `src/lib/email.ts`. Patient notices go only through `notifyPatientSafely` (Task 5). Follow-up notices keep using SP3's `notifyFollowUpSafely`.
- **Blob:** reports are stored with `access: 'private'`. A blob URL never reaches a client or a log line. Bytes are streamed only by the two authenticated, audited download routes.
- **Schema changes** are a `src/db/schema.ts` edit plus SQL migrations in the SP1/SP3 style: `BEGIN; … COMMIT;`, `IF NOT EXISTS` everywhere, each `CREATE TYPE` in a `DO` block catching `duplicate_object`, each FK/unique/check in a `DO` block testing `pg_constraint` and named exactly as drizzle names it, no `DROP`.
  - Apply only to the local container, twice, each run ending in `COMMIT`: `/Users/k2a/.docker/bin/docker exec -i hims-local-pg psql -U postgres -d hims -v ON_ERROR_STOP=1 < scripts/migrations/<file>`
  - Never `db:push` / `drizzle-kit push`. Never `scripts/apply-sql.mjs`.
- **Tests:**
  - Pure and mocked tests: `npx vitest run <file>`. DB tests: `npm test -- <file>` (loads `.env.local`).
  - Wrap DB tests in `describe.skipIf(!process.env.DATABASE_URL)('… (DB)', …)`. Fixtures are prefixed `TEST-SP5-${RUN}`. Service-area PINs used by tests start with `99` (e.g. `990001`). Use dates in 2099 so daily sequences and capacities never collide with real rows.
  - Clean up children first: `notification_deliveries` → `lab_reports` → `lab_results` → `lab_orders` → `home_collection_visits` → `lab_requisitions` → `follow_up_orders` → `encounters` → test windows/PINs → `patients`.
  - **Never run the whole suite or `tests/db/seed.test.ts` during task work**: they truncate and reseed the shared local DB.
- **Per-task verification:** the task's tests, `npx tsc --noEmit`, and `npx eslint <changed files>`.
- **Branding:** no hard-coded product name. Use `brand` (server) or `useBrand()` (client).
- No secrets. The executor commits per task as written. Nothing is committed while planning.

## Review Focus

1. **Two staff booking the last place in a collection window at the same moment.**
   - Exactly one booking succeeds. The other gets `slot_full` (409), and no orphan visit or half-scheduled order remains.
   - Test: Task 10 `concurrent bookings for the last place in a window: exactly one wins`.
2. **A mistyped or swapped sample ID at the patient's door or at the lab bench.** It must be rejected by the check digit or by "not on this visit", and must never mark another patient's tube.
   - Test: Task 1 `rejects a single-digit typo and an adjacent transposition`, Task 8 `receive 400s a bad check digit before any DB call`, Task 12 `refuses a sample ID from another visit and changes nothing`.
3. **The IST midnight boundary.**
   - A collector opening "My route" at 00:15 IST sees that IST day's visits.
   - A window starting within 60 minutes (IST) can no longer be booked.
   - A sample collected at 00:10 IST carries that IST date in its ID.
   - Test: Task 6 `sample date is the IST date`, Task 10 `a window starting within 60 minutes is closed`, Task 12 `route list at 00:15 IST shows that day's visits`.
4. **Unverified or changed results reaching the patient.**
   - The portal shows only released, non-superseded reports, and only for the signed-in patient.
   - A result amended or verified while the PDF was being rendered gives 409 `stale`, never a report whose PDF disagrees with the DB.
   - Test: Task 14 `a change between render and commit is stale and writes nothing`, Task 15 `another patient's report is 404`.
5. **A notification that cannot or must not be sent.**
   - An opted-out patient or a patient with no valid phone gets a delivery-log row and no send.
   - A retried request does not notify twice.
   - A notifier crash never fails the clinical write.
   - Test: Task 5 `opt-out suppresses`, `no phone is skipped`, `the same dedupe key notifies once`, `a throwing notifier is logged as failed and does not throw`; Task 7 `a notifier failure still returns 201`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/labs/status.ts` | Lab order status machine, labels, FHIR status mapping (pure) |
| `src/lib/labs/sample-id.ts` | Sample ID format/parse/display with Verhoeff check digit (pure) |
| `src/lib/labs/service-area.ts` | PIN list parsing, local test (pure) |
| `src/lib/labs/catalog.ts` | Sample types, containers, quote statuses, tariff → quote mapping (pure) |
| `src/lib/labs/validation.ts` | zod schemas for every SP5 request (client-safe) |
| `src/lib/labs/qr.ts` | QR module matrix for sample labels (no innerHTML) |
| `src/lib/labs/report-data.ts` | `LabReportData` shape + pure builder + PDF-safe text |
| `src/lib/labs/report-pdf.ts` | `pdf-lib` renderer (server only) |
| `src/lib/home-collection/rules.ts` | Visit statuses, reason codes, booking-date and window rules (pure) |
| `src/lib/notify/templates.ts` | Template registry and renderer (pure) |
| `src/lib/notify/notifier.ts` | `Notifier` interface, log-only implementation, destination masking |
| `src/lib/blob-store.ts` | Private blob put + authenticated streaming helper |
| `src/lib/queries/lab-setup.ts` | Service-area PINs, collection windows, lab test setup |
| `src/lib/queries/notifications.ts` | Delivery log, opt-out, `notifyPatient(Safely)` |
| `src/lib/queries/lab-lifecycle.ts` | Sample-ID allocation and every order transition |
| `src/lib/queries/lab-requisitions.ts` | Doctor's order: requisition + priced orders |
| `src/lib/queries/home-collections.ts` | Context, availability, book/reschedule/cancel/assign, board, route, collect |
| `src/lib/queries/lab-reports.ts` | Report release transaction, follow-up trigger, report reads |
| `src/app/api/…` | Routes listed per task |
| `src/app/(dashboard)/home-collections`, `collections`, `lab-labels` | New staff pages |
| `src/app/patient-portal/(authenticated)/lab-reports` | Portal page |
| `src/components/home-collection/*`, `src/components/labs/*`, `src/components/settings/Lab*.tsx` | UI |
| `scripts/migrations/2026-10-08-sp5-lab-enum-values.sql`, `scripts/migrations/2026-10-08-sp5-lab-home-collection.sql` | DDL (two files, see Ruling 5) |

---

### Task 1: Pure lab rules: status machine, sample ID, service area, catalog, validation, home-collection rules

**Files:**
- Create: `src/lib/labs/status.ts`, `src/lib/labs/sample-id.ts`, `src/lib/labs/service-area.ts`, `src/lib/labs/catalog.ts`, `src/lib/labs/validation.ts`, `src/lib/home-collection/rules.ts`
- Test: `tests/lib/labs/status.test.ts`, `tests/lib/labs/sample-id.test.ts`, `tests/lib/labs/service-area.test.ts`, `tests/lib/labs/catalog.test.ts`, `tests/lib/labs/validation.test.ts`, `tests/lib/home-collection/rules.test.ts`

**Interfaces:**
- Consumes: `verhoeffCheckDigit`, `verhoeffValidate` (`src/lib/india/verhoeff.ts`); `isValidPinCode`, `isIndianStateCode` (`src/lib/india/reference.ts`); `normalizePhone`; `istSlotString` (SP3 `src/lib/follow-ups/rules.ts`); `isoDateSchema`, `followUpIntervalSchema`, `followUpReasonSchema` (SP3 `src/lib/follow-ups/validation.ts`); `import type { PriceResolution }` (`src/lib/tariff/resolve.ts`). No DB or `node:` imports in any of these files.
- Produces:
  - **`status.ts`:**
    - `LAB_ORDER_STATUSES = ['ordered', 'scheduled', 'collected', 'received', 'resulted', 'verified', 'reported', 'cancelled'] as const`; `type LabOrderStatus`
    - `LAB_TRANSITIONS: Record<LabOrderStatus, readonly LabOrderStatus[]>` = `{ ordered: ['scheduled', 'collected', 'cancelled'], scheduled: ['ordered', 'collected', 'cancelled'], collected: ['received', 'cancelled'], received: ['resulted', 'cancelled'], resulted: ['verified'], verified: ['reported'], reported: [], cancelled: [] }`
    - `canTransitionLabOrder(from: LabOrderStatus, to: LabOrderStatus): boolean`
    - `PRE_RESULT_STATUSES = ['ordered', 'scheduled', 'collected', 'received'] as const` (also the cancellable set); `RESULT_EDITABLE_STATUSES = ['received', 'resulted'] as const`
    - `LAB_STATUS_LABEL: Record<LabOrderStatus, string>` = `{ ordered: 'Ordered', scheduled: 'Home collection booked', collected: 'Sample collected', received: 'Received at lab', resulted: 'Awaiting verification', verified: 'Verified', reported: 'Reported', cancelled: 'Cancelled' }`
    - `fhirObservationStatusFor(s: LabOrderStatus): 'preliminary' | 'final' | null`: resulted → preliminary; verified/reported → final; otherwise null
    - `LIS_ACCEPTED_OBSERVATION_STATUSES = ['preliminary', 'final', 'amended', 'corrected'] as const`; `isAcceptedLisObservationStatus(s: string): boolean`
  - **`sample-id.ts`:**
    - `formatSampleId(dateIso: string, seq: number): string`. The result is `'L' + yymmdd + seq.padStart(4, '0') + verhoeffCheckDigit(yymmdd + seqStr)`. It throws for seq < 1 or > 999999.
    - `parseSampleId(input: string): { canonical: string; dateIso: string; seq: number } | null`:
      - strips spaces and hyphens and upper-cases
      - matches `^L(\d{6})(\d{4,6})(\d)$`
      - requires `verhoeffValidate(digits)`
      - requires a real calendar date (yy → 20yy)
    - `displaySampleId(canonical: string): string`, e.g. `'L261008-0042-9'`
  - **`service-area.ts`:**
    - `parsePinList(text: string): { pins: string[]; invalid: string[] }`. It splits on `/[\s,;]+/` and returns both lists de-duplicated and sorted.
    - `isLocalPin(pin: string | null | undefined, active: ReadonlySet<string>): boolean`. It trims the PIN; a null PIN is false.
  - **`catalog.ts`:**
    - `SAMPLE_TYPES = ['blood', 'serum', 'plasma', 'urine', 'stool', 'sputum', 'swab', 'csf', 'other'] as const` + `SAMPLE_TYPE_LABEL`
    - `SAMPLE_CONTAINERS = ['edta_lavender', 'plain_red', 'sst_gold', 'fluoride_grey', 'citrate_blue', 'heparin_green', 'urine_container', 'stool_container', 'swab_tube', 'other'] as const` + `SAMPLE_CONTAINER_LABEL`. Each label is the cap colour in words, e.g. `'EDTA (lavender cap)'`.
    - `LAB_QUOTE_STATUSES = ['quoted', 'unmapped', 'no_rate', 'service_inactive', 'service_not_found'] as const`; `type LabQuoteStatus`
    - `MAX_QUOTED_PAISE = 1_000_000_000`
    - `quoteFromResolution(res: PriceResolution | null): { quotedPricePaise: number | null; quotedTariffRateId: number | null; quoteStatus: LabQuoteStatus }`:
      - `null` → `unmapped`
      - ok and `amountPaise ≤ MAX` → `quoted`
      - ok but above MAX → `no_rate` with nulls (a data error; the order is still created, unpriced)
      - `invalid_date` → `no_rate`; other reasons map 1:1
  - **`home-collection/rules.ts`:**
    - `HOME_COLLECTION_STATUSES = ['booked', 'collected', 'cancelled'] as const`
    - `RESCHEDULE_REASONS = ['patient_request', 'collector_unavailable', 'address_issue', 'other'] as const`
    - `VISIT_CANCEL_REASONS = ['patient_request', 'patient_unavailable', 'patient_refused', 'address_not_found', 'tests_cancelled', 'other'] as const`
    - `COLLECTOR_CANCEL_REASONS = ['patient_unavailable', 'patient_refused', 'address_not_found'] as const`
    - `RESCHEDULE_REASON_LABEL`, `VISIT_CANCEL_REASON_LABEL`
    - `MAX_BOOKING_DAYS_AHEAD = 30`, `MIN_BOOKING_LEAD_MINUTES = 60`, `HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/`
    - `bookingDateProblem(visitDate: string, todayIso: string): string | null` returns:
      - `'Pick today or a later date.'` when the date is in the past
      - `'Home collection can be booked up to 30 days ahead.'` beyond today + 30
      - null otherwise
    - `windowClosed(visitDate: string, startTime: string, now: Date): boolean` is true when `new Date(istSlotString(visitDate, startTime)) - now < 60 min`
    - `windowsOverlap(a: { startTime: string; endTime: string }, b: same): boolean` is `a.start < b.end && b.start < a.end` (string compare)
  - **`validation.ts`** (all `.strict()`):
    - `labResultSchema` `{ value: trim 1–200; unit?: trim ≤40; referenceRange?: trim ≤120; flag: 'normal'|'abnormal'|'critical'; notes?: trim ≤1000 }`; type `LabResultRequest`
    - `labOrderCancelSchema` `{ reason: trim 1–300 }`
    - `receiveSampleSchema` `{ sampleId: trim 1–32 }`
    - `createLabRequisitionSchema` is a `z.union` of:
      - the legacy `{ labTestId }`
      - `{ labTestIds: int[] 1–20, unique; followUp?: { interval: followUpIntervalSchema; reason: followUpReasonSchema } | null; originatingEncounterId?: positive int }`
      Both transform to `CreateLabRequisitionRequest = { labTestIds: number[]; followUp: { interval: FollowUpInterval; reason: string } | null; originatingEncounterId: number | null }`.
    - `servicePinsRequestSchema` `{ pins: string ≤5000; areaLabel?: trim ≤80 }`; `servicePinPatchSchema` `{ isActive: boolean }`
    - `collectionWindowSchema` `{ label: trim 1–40; startTime: HHMM; endTime: HHMM; capacity: int 1–50; sortOrder?: int 0–99 }`, refined so start < end
    - `collectionWindowPatchSchema`: all optional plus `isActive?`, at least one key, start < end when both are given
    - `labTestSetupSchema` `{ sampleType?: enum | null; container?: enum | null; serviceId?: positive int | null }`, at least one key
    - `visitAddressSchema` `{ line1: trim 1–200; line2?: ≤200; city: trim 1–100; district?: ≤100; stateCode: isIndianStateCode; pinCode: isValidPinCode; landmark?: ≤200 }`
    - `bookHomeCollectionSchema` `{ patientId: 1–40; labOrderIds: int[] 1–20, unique; visitDate: isoDateSchema; windowId: positive int; address: visitAddressSchema; contactPhone: string → normalizePhone(…, { allowLandline: true }), error 'Enter a valid phone number'; notes?: trim ≤300 }`; type `BookHomeCollectionRequest`
    - `rescheduleHomeCollectionSchema` `{ visitDate; windowId; reason: enum RESCHEDULE_REASONS; note?: ≤300 }`
    - `cancelHomeCollectionSchema` `{ reason: enum VISIT_CANCEL_REASONS; note?: ≤300 }`
    - `assignCollectorSchema` `{ collectorUserId: positive int | null }`
    - `collectHomeVisitSchema` `{ sampleIds: (trim 1–32)[] 1–20 }`
    - `notificationPreferenceSchema` `{ optOut: boolean }`

- [ ] **Step 1: Write the failing tests**

```ts
// status.test.ts
it('allows exactly the documented transitions', () => {
  expect(canTransitionLabOrder('ordered', 'scheduled')).toBe(true); expect(canTransitionLabOrder('scheduled', 'ordered')).toBe(true)
  expect(canTransitionLabOrder('collected', 'resulted')).toBe(false); expect(canTransitionLabOrder('resulted', 'cancelled')).toBe(false)
  expect(canTransitionLabOrder('verified', 'reported')).toBe(true); expect(LAB_TRANSITIONS.reported).toEqual([])
})
it('maps statuses to FHIR observation status', () => {
  expect(fhirObservationStatusFor('resulted')).toBe('preliminary'); expect(fhirObservationStatusFor('reported')).toBe('final')
  expect(fhirObservationStatusFor('received')).toBeNull(); expect(isAcceptedLisObservationStatus('cancelled')).toBe(false)
})
// sample-id.test.ts
it('formats with a Verhoeff check digit and displays grouped', () => {
  expect(formatSampleId('2026-10-08', 42)).toBe('L26100800429'); expect(formatSampleId('2026-12-31', 1234)).toBe('L26123112342')
  expect(displaySampleId('L26100800429')).toBe('L261008-0042-9')
})
it('parses scanner and typed forms', () => {
  expect(parseSampleId(' l261008-0042-9 ')).toEqual({ canonical: 'L26100800429', dateIso: '2026-10-08', seq: 42 })
})
it('rejects a single-digit typo and an adjacent transposition', () => {
  expect(parseSampleId('L26100800439')).toBeNull() // 42 → 43
  expect(parseSampleId('L26100800249')).toBeNull() // 42 → 24
  expect(parseSampleId('L26133100011')).toBeNull() // month 13
})
// service-area.test.ts
it('parses a pasted PIN list and reports invalid entries', () => {
  expect(parsePinList('560001, 560002\n560001;06001 abc')).toEqual({ pins: ['560001', '560002'], invalid: ['06001', 'abc'] })
})
it('a patient is local only when the PIN is active', () => {
  expect(isLocalPin(' 560001 ', new Set(['560001']))).toBe(true); expect(isLocalPin(null, new Set(['560001']))).toBe(false)
})
// catalog.test.ts
it('maps tariff resolutions to quotes', () => {
  expect(quoteFromResolution(null)).toEqual({ quotedPricePaise: null, quotedTariffRateId: null, quoteStatus: 'unmapped' })
  expect(quoteFromResolution({ ok: true, amountPaise: 45000, rateId: 9 } as never)).toEqual({ quotedPricePaise: 45000, quotedTariffRateId: 9, quoteStatus: 'quoted' })
  expect(quoteFromResolution({ ok: true, amountPaise: 1_000_000_001, rateId: 9 } as never).quoteStatus).toBe('no_rate')
  expect(quoteFromResolution({ ok: false, reason: 'service_inactive' }).quoteStatus).toBe('service_inactive')
})
// rules.test.ts
it('bookingDateProblem rejects past and >30 days', () => {
  expect(bookingDateProblem('2099-01-09', '2099-01-10')).toMatch(/today or a later/); expect(bookingDateProblem('2099-02-10', '2099-01-10')).toMatch(/30 days/)
  expect(bookingDateProblem('2099-02-09', '2099-01-10')).toBeNull()
})
it('windowClosed uses IST and a 60-minute lead', () => {
  // 07:00 IST on 2099-01-10 is 01:30Z
  expect(windowClosed('2099-01-10', '07:00', new Date('2099-01-10T00:29:00Z'))).toBe(false)
  expect(windowClosed('2099-01-10', '07:00', new Date('2099-01-10T00:31:00Z'))).toBe(true)
})
it('windowsOverlap is touch-exclusive', () => {
  expect(windowsOverlap({ startTime: '07:00', endTime: '09:00' }, { startTime: '09:00', endTime: '11:00' })).toBe(false)
  expect(windowsOverlap({ startTime: '07:00', endTime: '09:30' }, { startTime: '09:00', endTime: '11:00' })).toBe(true)
})
// validation.test.ts
it('createLabRequisitionSchema accepts the legacy body and normalises it', () => {
  expect(createLabRequisitionSchema.parse({ labTestId: 3 })).toEqual({ labTestIds: [3], followUp: null, originatingEncounterId: null })
  expect(createLabRequisitionSchema.safeParse({ labTestIds: [3, 3] }).success).toBe(false)
  expect(createLabRequisitionSchema.safeParse({ labTestIds: [3], followUp: { interval: { value: 2, unit: 'weeks' }, reason: 'Review LFT' } }).success).toBe(true)
})
it('bookHomeCollectionSchema normalises the phone and validates PIN/state', () => {
  const ok = { patientId: 'RD-0001', labOrderIds: [1], visitDate: '2099-01-10', windowId: 1, contactPhone: '98450 12345',
    address: { line1: '12 MG Road', city: 'Bengaluru', stateCode: 'KA', pinCode: '560001' } }
  expect(bookHomeCollectionSchema.parse(ok).contactPhone).toBe('+919845012345')
  expect(bookHomeCollectionSchema.safeParse({ ...ok, address: { ...ok.address, pinCode: '060001' } }).success).toBe(false)
  expect(bookHomeCollectionSchema.safeParse({ ...ok, contactPhone: '123' }).success).toBe(false)
})
it('collectionWindowSchema requires start before end', () => {
  expect(collectionWindowSchema.safeParse({ label: 'Early', startTime: '09:00', endTime: '07:00', capacity: 5 }).success).toBe(false)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/labs tests/lib/home-collection`
Expected: FAIL with "Failed to resolve import".

- [ ] **Step 3: Implement** the six modules with the signatures above. Date maths is UTC on parsed `YYYY-MM-DD` parts, as SP3 does. There are no local-time getters.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/lib/labs tests/lib/home-collection`, then `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/labs src/lib/home-collection tests/lib/labs tests/lib/home-collection
git commit -m "feat(sp5): lab status machine, sample IDs, service area, quote mapping and validation"
```

---

### Task 2: Schema + migrations (enum values file, tables file) + type widening

**Files:**
- Modify: `src/db/schema.ts`:
  - `labOrderStatusEnum` takes `LAB_ORDER_STATUSES` order (literal array)
  - SP5 columns are added inside `labTests`, `labOrders`, `labResults` and `patients`, each commented `// SP5`
  - a `// SP5 lab LIS & home collection` block of new enums and tables goes after `labResults`
- Create: `scripts/migrations/2026-10-08-sp5-lab-enum-values.sql`, `scripts/migrations/2026-10-08-sp5-lab-home-collection.sql`
- Modify: `src/lib/queries/patients.ts` (`deletePatient`), `src/db/seed.ts` (`clearExistingData`, requisitions for seeded orders, three default windows), `tests/fixtures/patient-row.ts` (`notificationOptOut: false, notificationOptOutAt: null`)
- Modify (type widening only, no behaviour change): `src/lib/queries/lab-orders.ts`:
  - `PatientLabOrderRow.status` and `WorklistRow.status` become `LabOrderStatus`
  - `listPatientsWithLabOrders` counts `resulted|verified|reported` as resulted and `PRE_RESULT_STATUSES` as pending
- Modify (type widening only, no behaviour change): the components
  - `src/components/LabWorklist.tsx`: `STATUS_CONFIG` gets all 8 keys, labels from `LAB_STATUS_LABEL`
  - `src/components/LabResultsSection.tsx`: `PENDING_STATUS_LABEL` is keyed by `PRE_RESULT_STATUSES`
  - `src/components/LabsPatientReports.tsx`
- Test: `tests/db/lab-home-collection-schema.test.ts`

**Interfaces:**
- Consumes: Task 1 constants (the test asserts that the enum values equal them); SP3 `followUpIntervalUnitEnum`, `encounters`, `followUpOrders`.
- Produces (exact):
  - **Enums:**
    - `labSampleTypeEnum = pgEnum('lab_sample_type', [...SAMPLE_TYPES values])`
    - `labSampleContainerEnum = pgEnum('lab_sample_container', [...])`
    - `homeCollectionStatusEnum = pgEnum('home_collection_status', ['booked', 'collected', 'cancelled'])`
    - `notificationChannelEnum = pgEnum('notification_channel', ['log', 'sms', 'whatsapp', 'email'])`
    - `notificationDeliveryStatusEnum = pgEnum('notification_delivery_status', ['logged', 'sent', 'failed', 'suppressed_opt_out', 'skipped_no_contact'])`
    - `labReportSeq = pgSequence('lab_report_seq', { startWith: 1, increment: 1 })`
  - **`patients`** + `notificationOptOut boolean default false not null`, `notificationOptOutAt timestamp`.
  - **`labTests`** + `sampleType`, `container`, `serviceId → serviceCatalog.id` (all nullable).
  - **`labResults`** + `resultedByUserId → users.id`, `amendedAt timestamp`.
  - **`labOrders`:**
    - New columns, all nullable unless stated:
      - `requisitionId → labRequisitions.id`
      - `homeCollectionVisitId → homeCollectionVisits.id { onDelete: 'set null' }`
      - `sampleId text .unique()`, `sampleDate date`, `sampleSeq integer`
      - `collectedByName`, `receivedAt`, `receivedByName`
      - `verifiedAt`, `verifiedByName`, `verifiedByUserId → users`
      - `reportedAt`, `cancelledAt`, `cancelledByName`, `cancelReason`
      - `quotedPricePaise integer`, `quotedTariffRateId → tariffRates`, `quotedOn date`
      - `quoteStatus text({ enum: LAB_QUOTE_STATUSES }) default 'unmapped' not null`
      - `statusChangedAt timestamp`
    - Extra config:
      - `uniqueIndex('lab_orders_sample_date_seq_unique').on(t.sampleDate, t.sampleSeq)`
      - `index('lab_orders_requisition_idx')`, `index('lab_orders_visit_idx')`, `index('lab_orders_status_idx')`
      - `check('lab_orders_quoted_price_range', quoted_price_paise IS NULL OR quoted_price_paise BETWEEN 0 AND 1000000000)`
      - `check('lab_orders_sample_pair', (sample_id IS NULL) = (sample_date IS NULL) AND (sample_id IS NULL) = (sample_seq IS NULL))`
      - `check('lab_orders_scheduled_has_visit', status <> 'scheduled' OR home_collection_visit_id IS NOT NULL)`
  - **`labServiceAreaPins`** (`'lab_service_area_pins'`):
    - Columns: `id` serial, `pinCode text not null .unique()`, `areaLabel text`, `isActive bool default true not null`, `createdByName text not null`, `createdAt`/`updatedAt` defaultNow
    - `check('lab_service_area_pins_pin_format', pin_code ~ '^[1-9][0-9]{5}$')`
  - **`homeCollectionWindows`** (`'home_collection_windows'`):
    - Columns: `id`, `label text not null`, `startTime text not null`, `endTime text not null`, `capacity integer not null`, `isActive default true`, `sortOrder integer default 0 not null`, `createdAt`, `updatedAt`
    - Checks:
      - `home_collection_windows_time_format`: both times match `'^([01][0-9]|2[0-3]):[0-5][0-9]$'`
      - `home_collection_windows_time_order`: `start_time < end_time`
      - `home_collection_windows_capacity_range`: `capacity BETWEEN 1 AND 50`
  - **`labRequisitions`** (`'lab_requisitions'`):
    - Columns:
      - `id`
      - `patientId not null → patients`, `orderedByProviderId not null → providers`
      - `originatingEncounterId → encounters { onDelete: 'set null' }`
      - `followUpRequested bool default false not null`, `followUpIntervalValue integer`, `followUpIntervalUnit followUpIntervalUnitEnum`, `followUpReason text`
      - `followUpOrderId → followUpOrders { onDelete: 'set null' }`
      - `followUpResolvedAt timestamp`, `followUpOutcome text({ enum: ['created', 'linked', 'failed'] })`
      - `legacyLabOrderId integer .unique()`: backfill key only, no FK
      - `createdByName text not null`, `createdByUserId → users`, `createdAt`
    - `check('lab_requisitions_follow_up_fields', (NOT follow_up_requested AND follow_up_interval_value IS NULL AND follow_up_interval_unit IS NULL) OR (follow_up_requested AND follow_up_interval_value BETWEEN 1 AND 365 AND follow_up_interval_unit IS NOT NULL))`
    - `index('lab_requisitions_patient_idx')`
  - **`homeCollectionVisits`** (`'home_collection_visits'`):
    - Columns:
      - `id`, `patientId not null → patients`, `visitDate date not null`
      - `windowId not null → homeCollectionWindows`, plus the snapshots `windowLabel`, `windowStart`, `windowEnd` (text not null)
      - `status default 'booked' not null`
      - Address snapshot: `addressLine1 not null`, `addressLine2`, `city not null`, `district`, `stateCode not null`, `pinCode not null`, `landmark`
      - `contactPhone not null`, `notes`
      - `collectorUserId → users`, `collectorAssignedAt`, `collectorAssignedByName`
      - `bookedByName not null`, `bookedByUserId → users`, `bookedAt defaultNow`
      - `rescheduleCount integer default 0 not null`, `lastRescheduleReason`, `lastRescheduleNote`
      - `cancelledAt`, `cancelledByName`, `cancelReason`, `cancelNote`
      - `collectedAt`, `collectedByName`
      - `encounterId → encounters { onDelete: 'set null' }`
      - `updatedAt`
    - Extra config:
      - `uniqueIndex('home_collection_visits_patient_slot_unique').on(t.patientId, t.visitDate, t.windowId).where(sql\`status = 'booked'\`)`
      - `index('home_collection_visits_date_window_idx').on(t.visitDate, t.windowId)`
      - `index('home_collection_visits_collector_date_idx').on(t.collectorUserId, t.visitDate)`
      - `check('home_collection_visits_pin_format', …)`
      - `check('home_collection_visits_cancel_reason', status <> 'cancelled' OR cancel_reason IS NOT NULL)`
      - `check('home_collection_visits_collected_at', status <> 'collected' OR collected_at IS NOT NULL)`
  - **`labReports`** (`'lab_reports'`):
    - Columns:
      - `id`, `reportNumber text not null .unique()`
      - `requisitionId not null → labRequisitions`, `patientId not null → patients`
      - `version integer not null`, `orderIds jsonb $type<number[]> not null`, `testSummary text not null`
      - `blobUrl text not null`, `byteSize integer not null`, `sha256 text not null`
      - `releasedByName text not null`, `releasedByUserId → users`, `releasedAt defaultNow`
      - `supersededAt timestamp`
    - Extra config: `uniqueIndex('lab_reports_requisition_version_unique').on(t.requisitionId, t.version)`, `index('lab_reports_patient_idx')`, `check('lab_reports_version_positive', version > 0)`
  - **`notificationDeliveries`** (`'notification_deliveries'`):
    - Columns:
      - `id`, `patientId not null → patients`, `templateKey text not null`
      - `channel not null`, `status not null`
      - `destinationMasked text`, `relatedType text`, `relatedId integer`
      - `dedupeKey text .unique()`, `errorCode text`
      - `createdByName text not null`, `createdAt`
    - Extra config: `index('notification_deliveries_patient_idx')`, `index('notification_deliveries_related_idx').on(t.relatedType, t.relatedId)`
  - Types: `LabOrderRow`, `LabRequisitionRow`, `HomeCollectionVisitRow`, `HomeCollectionWindowRow`, `ServiceAreaPinRow`, `LabReportRow`, `NotificationDeliveryRow` (`$inferSelect`).
- **Migration files:**
  - **Enum values file:** only these lines between `BEGIN;`/`COMMIT;`. Each neighbour value already exists before the migration (Ruling 5):
    ```sql
    ALTER TYPE lab_order_status ADD VALUE IF NOT EXISTS 'scheduled' BEFORE 'collected';
    ALTER TYPE lab_order_status ADD VALUE IF NOT EXISTS 'received' AFTER 'collected';
    ALTER TYPE lab_order_status ADD VALUE IF NOT EXISTS 'reported' BEFORE 'cancelled';
    ALTER TYPE lab_order_status ADD VALUE IF NOT EXISTS 'verified' AFTER 'resulted';
    ALTER TYPE role ADD VALUE IF NOT EXISTS 'collector';
    ```
  - **Tables file:**
    - The header says it must run **after** the enum file has committed (it references `'scheduled'` in `lab_orders_scheduled_has_visit`), and that it requires SP1–SP3.
    - Order: types → `CREATE SEQUENCE IF NOT EXISTS lab_report_seq` → new tables without inline FKs → `ADD COLUMN IF NOT EXISTS` for the four existing tables → guarded FKs, uniques and checks → indexes.
    - Then the **backfill**:
      ```sql
      INSERT INTO lab_requisitions (patient_id, ordered_by_provider_id, created_by_name, created_at, legacy_lab_order_id)
        SELECT o.patient_id, o.ordered_by_provider_id, 'migration', o.ordered_at, o.id FROM lab_orders o
        WHERE o.requisition_id IS NULL ON CONFLICT (legacy_lab_order_id) DO NOTHING;
      UPDATE lab_orders o SET requisition_id = r.id FROM lab_requisitions r WHERE r.legacy_lab_order_id = o.id AND o.requisition_id IS NULL;
      ```
- **`deletePatient` order** (before the existing lab block):
  1. `notificationDeliveries`
  2. `labReports`
  3. then the existing `labResults` / documents / `labOrders` deletes
  4. then `homeCollectionVisits`
  5. then `labRequisitions`
- **Seed:**
  - `clearExistingData` mirrors the `deletePatient` order and also clears `homeCollectionWindows` / `labServiceAreaPins`.
  - Each seeded lab order gets its own requisition.
  - Three windows are seeded: `Early morning 07:00–09:00 cap 10`, `Morning 09:00–11:00 cap 10`, `Late morning 11:00–13:00 cap 8`.
  - No PINs are seeded (deployment-specific).

- [ ] **Step 1: Write the failing tests** (`tests/db/lab-home-collection-schema.test.ts`)

```ts
const ENUMS = '2026-10-08-sp5-lab-enum-values.sql', TABLES = '2026-10-08-sp5-lab-home-collection.sql'
it('both migrations are idempotent and non-destructive', () => {
  expect(idempotencyProblems(readMigration(ENUMS))).toEqual([]); expect(idempotencyProblems(readMigration(TABLES))).toEqual([])
})
it('the enum file only uses pre-existing neighbours', () => {
  const s = readMigration(ENUMS)
  expect(s).toMatch(/'scheduled' BEFORE 'collected'/); expect(s).toMatch(/'received' AFTER 'collected'/)
  expect(s).toMatch(/'reported' BEFORE 'cancelled'/); expect(s).toMatch(/'verified' AFTER 'resulted'/)
  expect(s).toMatch(/ADD VALUE IF NOT EXISTS 'collector'/); expect(s).not.toMatch(/CREATE TABLE|ADD COLUMN/i)
})
it.each([['lab_service_area_pins', labServiceAreaPins], ['home_collection_windows', homeCollectionWindows], ['lab_requisitions', labRequisitions],
  ['home_collection_visits', homeCollectionVisits], ['lab_reports', labReports], ['notification_deliveries', notificationDeliveries]] as const)(
  'tables migration declares every %s column', (_n, t) => { expect(missingColumns(t, readMigration(TABLES))).toEqual([]) })
it('declares every SP5 column on existing tables', () => {
  const s = readMigration(TABLES)
  for (const c of ['notification_opt_out', 'sample_type', 'container', 'service_id', 'resulted_by_user_id', 'amended_at', 'requisition_id',
    'home_collection_visit_id', 'sample_id', 'sample_date', 'sample_seq', 'received_at', 'verified_at', 'reported_at', 'cancel_reason',
    'quoted_price_paise', 'quoted_tariff_rate_id', 'quote_status', 'status_changed_at']) expect(s).toMatch(new RegExp(`\\b${c}\\b`))
})
it('every constraint/index name is in the SQL and ≤63 chars', () => { /* SP3 pattern over the 6 new tables + labOrders */ })
it('enum values match the pure constants, in order', () => {
  expect(labOrderStatusEnum.enumValues).toEqual([...LAB_ORDER_STATUSES]); expect(homeCollectionStatusEnum.enumValues).toEqual([...HOME_COLLECTION_STATUSES])
  expect(labSampleTypeEnum.enumValues).toEqual([...SAMPLE_TYPES]); expect(labSampleContainerEnum.enumValues).toEqual([...SAMPLE_CONTAINERS])
})
describe.skipIf(!process.env.DATABASE_URL)('SP5 schema (DB)', () => {
  it('the live lab_order_status enum has the schema order', async () => {
    const r = await getDb().execute(sql`select enum_range(null::lab_order_status)::text as v`)
    expect(rows(r)[0].v).toBe(`{${LAB_ORDER_STATUSES.join(',')}}`)
  })
  it('a patient cannot hold two booked visits in one slot, but can rebook after cancelling', async () => { /* second insert → isUniqueViolation(err, 'home_collection_visits_patient_slot_unique'); after update first to cancelled (+cancel_reason) insert succeeds */ })
  it('a scheduled order must point at a visit', async () => { /* update order status 'scheduled' with null visit → check violation 'lab_orders_scheduled_has_visit' */ })
  it('rejects a quoted price over 1e9 paise', async () => { /* check 'lab_orders_quoted_price_range' */ })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/db/lab-home-collection-schema.test.ts`
Expected: FAIL (the exports and migration files do not exist).

- [ ] **Step 3: Implement** the schema, the two migrations, the `deletePatient` / seed / fixture edits and the type widening.

- [ ] **Step 4: Apply both migrations twice, in order, and verify**

Run, twice each:
1. `… psql … < scripts/migrations/2026-10-08-sp5-lab-enum-values.sql`
2. `… psql … < scripts/migrations/2026-10-08-sp5-lab-home-collection.sql`

Every run must end in `COMMIT`.

Then check with `… psql -U postgres -d hims -tAc "select count(*) from lab_orders where requisition_id is null"`. Expected: `0`.

Then run:
- `npx vitest run tests/db/lab-home-collection-schema.test.ts tests/db/schema.test.ts tests/lib/no-aadhaar-leak.test.ts tests/lib/no-credential-leak.test.ts`
- `npm test -- tests/db/lab-home-collection-schema.test.ts tests/lib/queries/delete-patient-fk-guard.test.ts tests/lib/queries/delete-patient-lab-order-document-fk.test.ts tests/lib/queries/lab-orders-roster.test.ts tests/db/lab-schema.test.ts`
- `npx tsc --noEmit`

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts scripts/migrations/2026-10-08-sp5-*.sql src/lib/queries/patients.ts src/lib/queries/lab-orders.ts src/db/seed.ts tests/fixtures/patient-row.ts src/components/LabWorklist.tsx src/components/LabResultsSection.tsx src/components/LabsPatientReports.tsx tests/db/lab-home-collection-schema.test.ts
git commit -m "feat(sp5): lab status values, requisitions, home-collection, report and notification schema + migrations"
```

---

### Task 3: `collector` role, SP5 role constants, capability bullets

**Files:**
- Modify:
  - `src/db/schema.ts` (`roleEnum` + `'collector'` last)
  - `src/lib/auth.ts` (`Role`)
  - `src/lib/role-policy.ts` (`ALL_ROLES` + `'collector'`; `// SP5` block of constants)
  - `src/lib/role-capabilities.ts`
  - `src/lib/staff-portals.ts`
  - `src/app/(dashboard)/page.tsx` (`if (session.role === 'collector') redirect('/collections')`, next to the labs redirect; add `'collector'` to `staffByRole`)
  - `src/app/api/users/route.ts` (zod enum)
  - `src/components/settings/StaffManagementPanel.tsx` (role union, `ROLE_LABEL.collector = 'Sample Collector'`, badge `'bg-orange-500/10 text-orange-700'`, `<option>`)
  - `src/db/seed.ts` (demo user `{ name: 'Ravi Kumar', email: seedEmail('collector'), role: 'collector' }`)
- Create: `src/app/login/collector/page.tsx` (copy of `login/labs/page.tsx` with `'collector'`)
- Test: `tests/lib/role-capabilities.test.ts` (append), `tests/lib/sp5-role-policy.test.ts`, `tests/pages/dashboard-routing.test.tsx` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `type Role` gains `'collector'`.
  - Every constant in the Global Constraints RBAC table, each `readonly Role[]`.
  - Staff portal `{ key: 'collector', label: 'Sample Collector', description: 'Home sample collection route', icon: Truck, iconBg: 'bg-orange-500/10', iconText: 'text-orange-700' }`.
  - `ROLE_CAPABILITIES.collector`:
    - `label: 'Home Sample Collector'`
    - `summary: 'Visits patients at home to collect lab samples on the visits assigned to them.'`
    - `bullets`:
      - `"See today's assigned home-collection visits: patient, phone, address and the tubes to collect"`
      - `'Mark a visit collected by entering each tube\'s sample ID, or record why it could not be collected'`
  - Appended bullets:
    - labs: `'Book and dispatch home sample collection visits and assign collectors'` and `'Receive samples by sample ID, enter results and release lab reports'`
    - pi: `'Order several lab tests at once and ask for a follow-up visit once the report is released'` and `'Verify lab results before they are reported to the patient'`
    - frontdesk: `'Book, reschedule or cancel a home sample collection for a patient in the service area'`
    - admin: all four of the labs/pi lines, plus `'Manage the home-collection service area, collection windows and lab test sample setup'`

- [ ] **Step 1: Write the failing tests**

```ts
// sp5-role-policy.test.ts
it('every SP5 allowlist is exactly as specified', () => {
  expect(LAB_RESULT_ENTRY_ROLES).toEqual(['admin', 'labs']); expect(LAB_VERIFY_ROLES).toEqual(['admin', 'pi'])
  expect(HOME_COLLECTION_CANCEL_ROLES).toEqual(['admin', 'frontdesk', 'labs', 'collector']); expect(COLLECTOR_ROUTE_ROLES).toEqual(['admin', 'collector'])
  // …one line per constant in the table
})
it('collector is in ALL_ROLES and in no pre-SP5 allowlist', () => {
  expect(ALL_ROLES).toContain('collector')
  for (const list of [CLINICAL_ROLES, PATIENT_DIRECTORY_ROLES, SCHEDULING_ROLES, DOCUMENT_READ_ROLES, CHARGES_ROLES, TARIFF_LOOKUP_ROLES]) expect(list).not.toContain('collector')
})
// role-capabilities.test.ts (append)
it('states the SP5 capabilities the server grants', () => {
  expect(has('collector', /sample ID/i)).toBe(true); expect(has('labs', /release lab reports/i)).toBe(true)
  expect(has('pi', /verify lab results/i)).toBe(true); expect(has('frontdesk', /home sample collection/i)).toBe(true)
})
// dashboard-routing.test.tsx (append)
it('sends collector to /collections', async () => { /* role collector → mockRedirect('/collections') */ })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/sp5-role-policy.test.ts tests/lib/role-capabilities.test.ts tests/pages/dashboard-routing.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement.** `tsc` lists every `Record<Role, …>` that needs a collector entry; fill each one.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the same command, then:
- `npx vitest run tests/pages/nav-role-enforcement.test.tsx tests/components/LeftNav.test.tsx`
- `npm test -- tests/api/rbac-route-gates.test.ts tests/api/users.test.ts`
- `npx tsc --noEmit`

Expected: PASS. Every existing gate now also proves that `collector` is denied.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/lib/auth.ts src/lib/role-policy.ts src/lib/role-capabilities.ts src/lib/staff-portals.ts "src/app/(dashboard)/page.tsx" src/app/api/users/route.ts src/components/settings/StaffManagementPanel.tsx src/app/login/collector src/db/seed.ts tests/lib/sp5-role-policy.test.ts tests/lib/role-capabilities.test.ts tests/pages/dashboard-routing.test.tsx
git commit -m "feat(sp5): collector role, lab and home-collection role allowlists and capability bullets"
```

---

### Task 4: Lab setup: service-area PINs, collection windows, lab test sample/tariff mapping (queries, routes, Settings tab)

**Files:**
- Create:
  - `src/lib/queries/lab-setup.ts`
  - Routes:
    - `src/app/api/settings/lab-service-area/route.ts` (POST)
    - `src/app/api/settings/lab-service-area/[id]/route.ts` (PATCH)
    - `src/app/api/settings/home-collection-windows/route.ts` (POST)
    - `src/app/api/settings/home-collection-windows/[id]/route.ts` (PATCH)
    - `src/app/api/lab-tests/[id]/route.ts` (PATCH)
  - Components: `src/components/settings/LabServiceAreaPanel.tsx`, `src/components/settings/HomeCollectionWindowsPanel.tsx`, `src/components/settings/LabTestSetupPanel.tsx`
- Modify:
  - `src/app/(dashboard)/settings/page.tsx`: a new tab `{ id: 'lab-setup', label: 'Lab setup' }` with the three panels, editable only when `isAdmin`; it loads `listServiceAreaPins()`, `listCollectionWindows()`, `listLabTestsWithSetup()` and `listServices({ category: 'investigation_lab', limit: 500 })`
  - every test that renders the settings page: add `vi.mock('@/lib/queries/lab-setup', …)` returning empty lists
  - `tests/api/rbac-route-gates.test.ts`: 5 rows in `API_GATES` and in `SP5_WRITE_GATES`, allowed `[...LAB_SETUP_ROLES]`
- Test: `tests/lib/queries/lab-setup.test.ts` (DB), `tests/api/lab-setup-routes.test.ts` (mocked), `tests/components/settings/LabServiceAreaPanel.test.tsx`

**Interfaces:**
- Consumes: Task 1 (`parsePinList`, `isLocalPin`, `windowsOverlap`, validation schemas); Task 2 tables; Task 3 `LAB_SETUP_ROLES`; SP3 `readJsonBody`, `WriteExecutor`; `parseId`.
- Produces (`lab-setup.ts`):
  - **Service-area PINs:**
    - `listServiceAreaPins(): Promise<ServiceAreaPinRow[]>`, ordered by PIN
    - `getActiveServicePins(ex?: Pick<WriteExecutor, 'select'>): Promise<Set<string>>`
    - `isLocalPatientPin(pinCode: string | null, ex?): Promise<boolean>`
    - `addServiceAreaPins(pins: string[], areaLabel: string | null, session: Session): Promise<{ added: number; reactivated: number; unchanged: number }>`:
      - insert `ON CONFLICT (pin_code) DO UPDATE SET is_active = true, area_label = coalesce(excluded.area_label, …)`
      - audit `changed lab service area`, details `added=<n> reactivated=<n>`
    - `setServiceAreaPinActive(id: number, isActive: boolean, session: Session): Promise<ServiceAreaPinRow | null>`. Audits `changed lab service area`, details `pin=<id> active=<bool>`.
  - **Collection windows:**
    - `listCollectionWindows(includeInactive = true): Promise<HomeCollectionWindowRow[]>`, ordered by `sortOrder, startTime`
    - `createCollectionWindow(input: CollectionWindowInput, session): Promise<{ ok: true; window } | { ok: false; error: 'overlap' }>`
    - `updateCollectionWindow(id, patch, session): Promise<{ ok: true; window } | { ok: false; error: 'not_found' | 'overlap' }>`
    - Both take `pg_advisory_xact_lock(hashtext('home_collection_windows'))` and refuse an active window that overlaps another active one.
    - Audits: `created home collection window` / `changed home collection window`, details `window=<id>`.
    - Windows are never deleted, only deactivated. Visits keep their snapshot.
  - **Lab tests:**
    - `interface LabTestSetupRow { id; name; code; category; sampleType; container; serviceId; serviceCode: string | null; serviceName: string | null }`
    - `listLabTestsWithSetup(): Promise<LabTestSetupRow[]>`
    - `updateLabTestSetup(id: number, patch: LabTestSetupRequest, session): Promise<{ ok: true; test: LabTestSetupRow } | { ok: false; error: 'not_found' | 'service_not_found' | 'service_not_investigation' }>`:
      - the service category must be `investigation_lab` or `investigation_imaging`
      - audits `changed lab test setup`, details `labTest=<id> fields=<sorted keys>`
- **Routes:**
  - `POST /api/settings/lab-service-area` body `servicePinsRequestSchema`. `parsePinList(pins)`: any invalid → 400 `{ error: 'Some PIN codes are not valid', invalid }`; no valid → 400. Success is 200 with the counts.
  - The PATCH routes give 404 when not found and 409 `'This window overlaps another active window'` on overlap.

- [ ] **Step 1: Write the failing tests**

```ts
// lab-setup.test.ts (DB)
it('adds, de-duplicates and reactivates PINs', async () => {
  expect(await addServiceAreaPins(['990001', '990002'], 'Test area', S)).toMatchObject({ added: 2 })
  const [row] = (await listServiceAreaPins()).filter((p) => p.pinCode === '990001'); await setServiceAreaPinActive(row.id, false, S)
  expect(await addServiceAreaPins(['990001'], null, S)).toMatchObject({ added: 0, reactivated: 1 })
  expect(await isLocalPatientPin('990001')).toBe(true); expect(await isLocalPatientPin('990009')).toBe(false)
})
it('refuses an overlapping active window but allows touching windows', async () => { /* 05:00-06:00 ok; 05:30-06:30 → overlap; 06:00-07:00 ok (use labels TEST-SP5-…; times 05:xx avoid seeded windows) */ })
it('maps a lab test to an investigation service only', async () => { /* consultation service → service_not_investigation */ })
// lab-setup-routes.test.ts (mocked queries)
it('400s a PIN list with invalid entries and names them', async () => {
  const res = await POST(send({ pins: '560001, 12345' })); expect(res.status).toBe(400); expect(await res.json()).toMatchObject({ invalid: ['12345'] })
})
it.each(['pi', 'labs', 'frontdesk'] as const)('%s gets 403 before parsing', async (r) => { /* body '{not json' → 403, addServiceAreaPins not called */ })
// LabServiceAreaPanel.test.tsx
it('is read-only for non-admin', () => { /* no textarea/button when isAdmin false */ })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/api/lab-setup-routes.test.ts tests/components/settings/LabServiceAreaPanel.test.tsx` and `npm test -- tests/lib/queries/lab-setup.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the query module, the five routes, the three panels, the settings tab and the harness rows.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the same commands, then `npm test -- tests/api/rbac-route-gates.test.ts`, `npx vitest run tests/pages` (the settings-rendering tests), and `npx tsc --noEmit`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/queries/lab-setup.ts src/app/api/settings/lab-service-area src/app/api/settings/home-collection-windows src/app/api/lab-tests src/components/settings/Lab*.tsx src/components/settings/HomeCollectionWindowsPanel.tsx "src/app/(dashboard)/settings/page.tsx" tests/lib/queries/lab-setup.test.ts tests/api/lab-setup-routes.test.ts tests/components/settings/LabServiceAreaPanel.test.tsx tests/api/rbac-route-gates.test.ts tests/pages
git commit -m "feat(sp5): admin lab setup for service-area PINs, collection windows and test sample/tariff mapping"
```

---

### Task 5: Notification service (`src/lib/notify`), delivery log, opt-out

**Files:**
- Create: `src/lib/notify/templates.ts`, `src/lib/notify/notifier.ts`, `src/lib/queries/notifications.ts`, `src/app/api/patients/[anonId]/notification-preference/route.ts` (PUT), `src/components/patient-profile/NotificationPreferenceToggle.tsx`
- Modify:
  - `src/components/patient-profile/PatientProfilePanel.tsx`: render the toggle with `patient.notificationOptOut` when `canEditNotifications`
  - the page that renders that panel: pass `canEditNotifications = NOTIFICATION_PREFERENCE_ROLES.includes(role)`
  - `tests/api/rbac-route-gates.test.ts`: one row in `API_GATES` and `SP5_WRITE_GATES`, allowed `[...NOTIFICATION_PREFERENCE_ROLES]`
- Test: `tests/lib/notify/templates.test.ts`, `tests/lib/notify/notifier.test.ts`, `tests/lib/queries/notifications.test.ts` (DB), `tests/api/notification-preference.test.ts`

**Interfaces:**
- Consumes: Task 2 tables; Task 3 `NOTIFICATION_PREFERENCE_ROLES`; `normalizePhone`; `formatIsoDate`; `logAudit`.
- Produces:
  - **`templates.ts`:**
    - `NOTIFICATION_TEMPLATE_KEYS = ['lab_tests_ordered', 'home_collection_booked', 'home_collection_rescheduled', 'home_collection_cancelled', 'lab_report_ready'] as const`; `type NotificationTemplateKey`
    - `interface TemplateVars { lab_tests_ordered: { hospitalName: string }; home_collection_booked: { hospitalName: string; visitDate: string; windowLabel: string }; home_collection_rescheduled: same as booked; home_collection_cancelled: { hospitalName: string; visitDate: string }; lab_report_ready: { hospitalName: string } }`
    - `renderNotification<K extends NotificationTemplateKey>(key: K, vars: TemplateVars[K]): string`. The copy is exact (dates via `formatIsoDate`):
      - `lab_tests_ordered`: `` `${h}: Your doctor has ordered lab tests. We can collect your samples at home. Please contact the hospital to book a collection slot.` ``
      - `home_collection_booked`: `` `${h}: Home sample collection booked for ${date}, ${windowLabel}. Our collector will call before arriving.` ``
      - `home_collection_rescheduled`: `` `${h}: Your home sample collection has moved to ${date}, ${windowLabel}.` ``
      - `home_collection_cancelled`: `` `${h}: Your home sample collection on ${date} has been cancelled. Please contact the hospital to rebook.` ``
      - `lab_report_ready`: `` `${h}: Your lab report is ready. Sign in to the patient portal to view and download it.` ``
  - **`notifier.ts`:**
    - `interface OutboundNotification { patientId: string; templateKey: NotificationTemplateKey; text: string; destination: string }`
    - `interface NotifierResult { channel: 'log' | 'sms' | 'whatsapp' | 'email'; delivered: boolean; errorCode?: string }`
    - `interface Notifier { send(msg: OutboundNotification): Promise<NotifierResult> }`
    - `maskDestination(phone: string): string` keeps `+91` and the last 4 digits, e.g. `'+91******3210'`
    - `createLogOnlyNotifier(log: (line: string) => void = console.info): Notifier`. It writes exactly one line, `[notify] template=<key> patient=<id> to=<masked> channel=log delivered=false`, never the text, and returns `{ channel: 'log', delivered: false }`.
    - `getNotifier(): Notifier` returns log-only. Add a comment: a real SMS/WhatsApp provider is chosen here per deployment, behind an explicit env credential (spec §3 "No fake data").
  - **`notifications.ts`:**
    - `interface NotifyPatientRequest<K extends NotificationTemplateKey> { patientId: string; templateKey: K; vars: TemplateVars[K]; related: { type: 'lab_requisition' | 'home_collection_visit' | 'lab_report'; id: number }; dedupeKey: string }`
    - `type NotifyOutcome = 'logged' | 'sent' | 'failed' | 'suppressed_opt_out' | 'skipped_no_contact' | 'duplicate'`
    - `notifyPatient<K>(actorName: string, req: NotifyPatientRequest<K>, notifier: Notifier = getNotifier()): Promise<NotifyOutcome>`:
      1. Insert the delivery row first, with `status 'logged'`, `channel 'log'`, `ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`. No row means `duplicate`.
      2. Read the patient's `phone` and `notificationOptOut` (named columns).
      3. Opted out → update the row to `suppressed_opt_out`.
      4. `normalizePhone(phone)` null → `skipped_no_contact`.
      5. Otherwise send. A thrown error or `delivered: false` with an `errorCode` → `failed` (store `errorCode`, or `'exception'` for a throw). A log-only result → `logged`. A delivered result → `sent`. Store `channel` and `destinationMasked`.
    - `notifyPatientSafely<K>(session: Session, req: NotifyPatientRequest<K>, notifier?: Notifier): Promise<NotifyOutcome | 'error'>`. It never throws. It audits `patient notification`, details `template=<k> outcome=<o> related=<type>:<id>`. On a throw it logs only `console.error('[notify] failed', err.name)`.
    - `setNotificationOptOut(patientId: string, optOut: boolean, session: Session): Promise<boolean>` (false = no such patient). Sets `notificationOptOutAt = optOut ? now : null`. Audits `changed notification preference`, details `optOut=<bool>`.
  - **`PUT /api/patients/[anonId]/notification-preference`:** body `notificationPreferenceSchema`. 404 `'Patient not found'`. Success is 200 `{ optOut }`.

- [ ] **Step 1: Write the failing tests**

```ts
// templates.test.ts
it('renders exact copy with IST dates and no personal data', () => {
  expect(renderNotification('home_collection_booked', { hospitalName: 'City Hospital', visitDate: '2026-10-21', windowLabel: 'Morning 09:00–11:00' }))
    .toBe('City Hospital: Home sample collection booked for 21 Oct 2026, Morning 09:00–11:00. Our collector will call before arriving.')
})
// notifier.test.ts
it('log-only notifier logs ids and a masked number, never the text', async () => {
  const lines: string[] = []; const r = await createLogOnlyNotifier((l) => lines.push(l)).send({ patientId: 'RD-0007', templateKey: 'lab_report_ready', text: 'SECRET', destination: '+919845013210' })
  expect(r).toEqual({ channel: 'log', delivered: false }); expect(lines).toEqual(['[notify] template=lab_report_ready patient=RD-0007 to=+91******3210 channel=log delivered=false'])
})
// notifications.test.ts (DB)
describe.skipIf(!process.env.DATABASE_URL)('notify (DB)', () => {
  it('logs one delivery for a reachable patient', async () => { expect(await notifyPatient('t', req('k1'))).toBe('logged') })
  it('opt-out suppresses', async () => { /* setNotificationOptOut true → 'suppressed_opt_out', spy notifier never called */ })
  it('no phone is skipped', async () => { /* patient phone null → 'skipped_no_contact' */ })
  it('the same dedupe key notifies once', async () => { /* second call 'duplicate'; spy called once; one row */ })
  it('a throwing notifier is logged as failed and does not throw', async () => {
    expect(await notifyPatientSafely(S, req('k5'), { send: async () => { throw new Error('boom') } })).toBe('failed')
  })
})
// notification-preference.test.ts
it('frontdesk can opt a patient out; pi gets 403 before parse', async () => { /* … */ })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/notify tests/api/notification-preference.test.ts` and `npm test -- tests/lib/queries/notifications.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the modules, the route, the toggle and the harness rows.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the same commands, then `npm test -- tests/api/rbac-route-gates.test.ts`, `npx vitest run tests/components/patient-profile tests/lib/no-credential-leak.test.ts`, and `npx tsc --noEmit`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/notify src/lib/queries/notifications.ts "src/app/api/patients/[anonId]/notification-preference" src/components/patient-profile tests/lib/notify tests/lib/queries/notifications.test.ts tests/api/notification-preference.test.ts tests/api/rbac-route-gates.test.ts "src/app/(dashboard)/patients/[anonId]/page.tsx"
git commit -m "feat(sp5): notification service with templates, delivery log, dedupe and patient opt-out (log-only channel)"
```

---

### Task 6: Lab lifecycle queries: sample-ID allocation and every order transition

**Files:**
- Create: `src/lib/queries/lab-lifecycle.ts`
- Test: `tests/lib/queries/lab-lifecycle.test.ts` (DB)

**Interfaces:**
- Consumes: Task 1 (`formatSampleId`, `parseSampleId`, `canTransitionLabOrder`, `PRE_RESULT_STATUSES`, `RESULT_EDITABLE_STATUSES`, `LabResultRequest`); Task 2 tables; SP3 `istDateOf`, `WriteExecutor`; `logAudit`, `logIntegrationEvent`.
- Produces:
  - `allocateSampleId(ex: WriteExecutor, dateIso: string): Promise<{ sampleId: string; sampleDate: string; sampleSeq: number }>`. It must be called inside a transaction. It takes `pg_advisory_xact_lock(hashtext('lab_orders.sample_seq:' || dateIso))` and returns `coalesce(max(sample_seq) where sample_date = dateIso, 0) + 1`.
  - `ensureSampleIds(ex: WriteExecutor, orderIds: number[], now: Date): Promise<Map<number, string>>`. It allocates for the rows whose `sampleId` is null, using `istDateOf(now)`, and never re-allocates.
  - `type LabActor = { kind: 'staff'; session: Session } | { kind: 'lis' }`
  - **`collectLabOrder(orderId: number, session: Session, now = new Date())`** returns `{ ok: true; order: LabOrderRow; sampleId: string } | { ok: false; error: 'not_found' | 'booked_for_home' | 'invalid_status' }`. Walk-in collection:
    - Locks the row `for update`. `scheduled` → `booked_for_home`. Anything but `ordered` → `invalid_status`.
    - Allocates a sample ID if missing.
    - Sets `collectedAt`, `collectedByName` and `statusChangedAt`.
    - Audits `marked lab order collected`, details `order=<id> sample=<sampleId>`.
  - **`receiveLabSample(sampleIdInput: string, session: Session, now = new Date())`** returns `{ ok: true; order: LabOrderRow } | { ok: false; error: 'invalid_sample_id' | 'not_found' | 'already_received' | 'invalid_status' }`:
    - `parseSampleId` runs first. Then `select … where sample_id = canonical for update`.
    - `received` or later → `already_received`. Anything but `collected` → `invalid_status`.
    - Audits `received lab sample`, details `order=<id> sample=<canonical>`.
  - **`recordLabResult(orderId: number, input: LabResultRequest, actor: LabActor, opts?: { expectedPatientId?: string; now?: Date })`** returns `{ ok: true; patientId: string; amended: boolean } | { ok: false; error: 'not_found' | 'patient_mismatch' | 'invalid_status' }`. It locks the row `for update`.
    - **Staff:** the status must be `received` (insert the result, go to `resulted`) or `resulted` (update the result, set `amendedAt`, `amended: true`). `resultedByName = session.name`, `resultedByUserId = session.userId`. Audit `entered lab result` or `amended lab result`, details `order=<id>`.
    - **LIS:** a `collected` order first gets `receivedAt = now` and `receivedByName = 'System (LIS API)'`. Allowed statuses are `collected`, `received` and `resulted` (amend). `resultedByName = 'System (LIS API)'`. Audit `logIntegrationEvent(\`accepted LIS lab result for order ${orderId}\`, patientId, undefined, tx)` (the existing text).
    - `expectedPatientId` that differs from the order → `patient_mismatch`, checked before any write.
  - **`verifyLabResult(orderId: number, session: Session, now = new Date())`** returns `{ ok: true; order: LabOrderRow } | { ok: false; error: 'not_found' | 'invalid_status' | 'self_verification' }`:
    - The status must be `resulted`.
    - `self_verification` when `session.userId !== null && result.resultedByUserId === session.userId`.
    - Sets `verifiedAt`, `verifiedByName` and `verifiedByUserId`.
    - Audits `verified lab result`, details `order=<id>`.
  - **`cancelLabOrder(orderId: number, reason: string, session: Session, now = new Date())`** returns `{ ok: true; patientId: string; cancelledVisitId: number | null } | { ok: false; error: 'not_found' | 'not_cancellable' }`:
    - The status must be in `PRE_RESULT_STATUSES`.
    - It sets `cancelledAt` / `cancelledByName` / `cancelReason`, clears `homeCollectionVisitId`, and sets `statusChangedAt`.
    - If the order was `scheduled` and its visit has no other `scheduled` order left, the visit is cancelled in the same transaction, with `cancelReason 'tests_cancelled'`.
    - Audits `cancelled lab order`, details `order=<id>` plus ` visit=<id>` when a visit was cancelled. The free-text reason never goes into the audit.
  - `getLabOrder(id: number, ex?): Promise<LabOrderRow | null>`

- [ ] **Step 1: Write the failing DB tests**

```ts
describe.skipIf(!process.env.DATABASE_URL)('lab lifecycle (DB)', () => {
  const NOW = new Date('2099-05-01T05:00:00Z')
  it('walk-in collect allocates a valid sample ID and is not repeatable', async () => {
    const r = await collectLabOrder(o1.id, S, NOW); expect(r.ok && parseSampleId(r.sampleId)?.dateIso).toBe('2099-05-01')
    expect(await collectLabOrder(o1.id, S, NOW)).toEqual({ ok: false, error: 'invalid_status' })
  })
  it('sample date is the IST date', async () => {
    const r = await collectLabOrder(o2.id, S, new Date('2099-05-01T18:40:00Z')) // 00:10 IST 2 May
    expect(r.ok && parseSampleId(r.sampleId)?.dateIso).toBe('2099-05-02')
  })
  it('concurrent collections on one date get distinct sequence numbers', async () => {
    const rs = await Promise.all(orders5.map((o) => collectLabOrder(o.id, S, NOW3)))
    expect(new Set(rs.map((r) => (r.ok ? r.sampleId : null))).size).toBe(5)
  })
  it('refuses walk-in collection of a home-booked order', async () => { /* status scheduled fixture → booked_for_home */ })
  it('receive needs the exact sample ID; a typo is invalid_sample_id', async () => { /* … */ })
  it('staff result needs received; amending a resulted order sets amendedAt', async () => { /* collected → invalid_status; received → ok amended false; again → amended true */ })
  it('LIS result on a collected order stamps receipt and results it', async () => { /* receivedByName 'System (LIS API)'; status resulted */ })
  it('LIS result for another patient changes nothing', async () => { /* patient_mismatch; status still collected */ })
  it('the person who entered a result cannot verify it', async () => {
    /* enter as { userId: U1 }, verify as { userId: U1 } → self_verification; verify as { userId: U2 } → ok; admin (userId null) → ok on another order */
  })
  it('cancelling the last scheduled order of a visit cancels the visit', async () => { /* … visit.status 'cancelled', cancelReason 'tests_cancelled' */ })
  it('audit details never carry the cancel reason or result value', async () => { /* reason 'SECRETWORD', value 'SECRETVAL' → no audit_log row contains either */ })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/lib/queries/lab-lifecycle.test.ts`
Expected: FAIL ("Failed to resolve import").

- [ ] **Step 3: Implement** `lab-lifecycle.ts`. Read raw rows as SP1's `nextUhid` does (`Array.isArray(res) ? res : res.rows`). Use `tx.execute(sql\`select pg_advisory_xact_lock(hashtext(${key}))\`)`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/lib/queries/lab-lifecycle.test.ts`, then `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/queries/lab-lifecycle.ts tests/lib/queries/lab-lifecycle.test.ts
git commit -m "feat(sp5): lab order transitions with IST sample IDs, receipt by scan and verifier separation"
```

---

### Task 7: Doctor's order: requisitions, tariff-quoted lines, follow-up request, local-patient notice

**Files:**
- Create: `src/lib/queries/lab-requisitions.ts`
- Modify:
  - `src/app/api/patients/[anonId]/lab-orders/route.ts`:
    - gate `LAB_ORDER_ROLES` → `readJsonBody` → `createLabRequisitionSchema`
    - the provider resolution block is unchanged
  - `src/components/OrderLabTestModal.tsx`: a multi-select checklist (lab tests only from the catalog) plus an optional "Ask for a follow-up visit after the report" fieldset (number + unit + reason)
  - `tests/api/rbac-route-gates.test.ts`: `POST /api/patients/[anonId]/lab-orders` in `API_GATES` and `SP5_WRITE_GATES`, allowed `[...LAB_ORDER_ROLES]`
  - `tests/api/lab-orders-routes.test.ts` (the creation cases): cleanup also deletes requisitions; the response shape changes
- Remove: `createLabOrder` from `src/lib/queries/lab-orders.ts` (replaced)
- Test: `tests/lib/queries/lab-requisitions.test.ts` (DB), `tests/api/lab-requisition-route.test.ts` (mocked), `tests/components/OrderLabTestModal.test.tsx`

**Interfaces:**
- Consumes:
  - SP2: `loadPricingContext`, `resolvePrice`
  - Task 1: `quoteFromResolution`, `CreateLabRequisitionRequest`
  - Task 4: `isLocalPatientPin`
  - Task 5: `notifyPatientSafely`
  - SP3: `getEncounterById`, `istDateOf`
  - `brand`, `resolveDoctorQueueProvider`, `listActiveProviders`
- Produces:
  - `interface CreateLabRequisitionInput extends CreateLabRequisitionRequest { patientId: string; orderedByProviderId: number }`
  - `type QuotedLine = { orderId: number; labTestId: number; quotedPricePaise: number | null; quoteStatus: LabQuoteStatus }`
  - **`createLabRequisition(input, session, now = new Date())`** returns `{ ok: true; requisition: LabRequisitionRow; lines: QuotedLine[]; patientIsLocal: boolean } | { ok: false; error: 'patient_not_found' | 'test_not_found' | 'encounter_not_found' | 'encounter_mismatch' }`. In order:
    1. **Before the transaction:** read the patient (`pinCode`, `primaryPayerId`), the tests (`id`, `serviceId`) and the provider's `departmentId`.
    2. For each test with a `serviceId`, quote with `resolvePrice({ serviceId, payerId: primaryPayerId ?? undefined, departmentId: providerDept ?? undefined, onDate: istDateOf(now) }, await loadPricingContext(serviceId))`, then `quoteFromResolution`. A test with no `serviceId` gives `quoteFromResolution(null)`.
    3. **One transaction:**
       - insert the requisition, with the follow-up fields from `followUp` (`followUpRequested = followUp !== null`)
       - insert one `lab_orders` row per test (`status 'ordered'`, `requisitionId`, quote fields, `quotedOn = istDateOf(now)`)
       - audit `created lab order` per order, details `order=<id> requisition=<id> quote=<quoteStatus>`
    4. `patientIsLocal = await isLocalPatientPin(patient.pinCode)`.
  - `getRequisitionWithOrders(id: number): Promise<{ requisition: LabRequisitionRow; orders: LabOrderRow[] } | null>`
- **Route:**
  - Success is 201 `{ requisitionId, lines, patientIsLocal, notification: NotifyOutcome | 'error' | null }`.
  - After commit, **only when `patientIsLocal`**, call `notifyPatientSafely(session, { patientId, templateKey: 'lab_tests_ordered', vars: { hospitalName: brand.name }, related: { type: 'lab_requisition', id }, dedupeKey: \`lab_tests_ordered:requisition=${id}\` })`.
  - Error mapping: `patient_not_found` / `test_not_found` / `encounter_not_found` → 404; `encounter_mismatch` → 409 `'That visit belongs to a different patient.'`.
- **Modal:** after a 201 it shows `"Home collection available for this patient"` when `patientIsLocal`, else `"Patient is outside the home-collection area: walk-in only"`, then refreshes.

- [ ] **Step 1: Write the failing tests**

```ts
// lab-requisitions.test.ts (DB)
it('creates one requisition with one priced order per test', async () => {
  // fixture: lab test mapped to a TEST-SP5 service with a base rate of 45000 paise valid 2099-01-01..null; second test unmapped
  const r = await createLabRequisition({ patientId: P, orderedByProviderId: PROV, labTestIds: [T1, T2], followUp: null, originatingEncounterId: null }, S, new Date('2099-05-01T05:00:00Z'))
  expect(r.ok && r.lines.map((l) => [l.quotedPricePaise, l.quoteStatus])).toEqual([[45000, 'quoted'], [null, 'unmapped']])
})
it('stores the follow-up request on the requisition', async () => { /* followUpRequested true, interval 2 weeks, reason */ })
it('a payer-scoped rate wins for a patient with that primary payer', async () => { /* … */ })
it('patientIsLocal follows the active service-area PINs', async () => { /* patient pin 990011 active → true; deactivate → false */ })
it('rejects an encounter of another patient and writes nothing', async () => { /* encounter_mismatch; no lab_orders rows for P */ })
// lab-requisition-route.test.ts (mocked)
it('notifies only local patients, with a requisition dedupe key', async () => {
  vi.mocked(createLabRequisition).mockResolvedValue({ ok: true, requisition: { id: 12 } as never, lines: [], patientIsLocal: true })
  await POST(send({ labTestIds: [1] }), ctx); expect(notifyPatientSafely).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ templateKey: 'lab_tests_ordered', dedupeKey: 'lab_tests_ordered:requisition=12' }))
})
it('a notifier failure still returns 201', async () => { /* notifyPatientSafely resolves 'error' → 201 with notification 'error' */ })
it('keeps accepting the legacy { labTestId } body', async () => { /* createLabRequisition called with labTestIds [5] */ })
// OrderLabTestModal.test.tsx
it('posts the checked tests and the follow-up request', async () => { /* body { labTestIds: [1,3], followUp: { interval: { value: 2, unit: 'weeks' }, reason: 'Review' } } */ })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/lib/queries/lab-requisitions.test.ts` and `npx vitest run tests/api/lab-requisition-route.test.ts tests/components/OrderLabTestModal.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** the query module, the route, the modal, the harness rows and the existing-test updates.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the same commands, then `npm test -- tests/api/lab-orders-routes.test.ts tests/api/rbac-route-gates.test.ts`, then `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/queries/lab-requisitions.ts src/lib/queries/lab-orders.ts "src/app/api/patients/[anonId]/lab-orders/route.ts" src/components/OrderLabTestModal.tsx tests/lib/queries/lab-requisitions.test.ts tests/api/lab-requisition-route.test.ts tests/components/OrderLabTestModal.test.tsx tests/api/lab-orders-routes.test.ts tests/api/rbac-route-gates.test.ts
git commit -m "feat(sp5): multi-test lab requisitions priced from the tariff master, follow-up request and local-patient notice"
```

---

### Task 8: Lifecycle routes, receive-by-scan, verify, FHIR webhook mapping, FHIR export status

**Files:**
- Modify:
  - `src/app/api/lab-orders/route.ts`: GET gate `LAB_WORKLIST_ROLES`
  - `src/app/api/lab-orders/[id]/collect/route.ts`: `LAB_COLLECT_ROLES` → `collectLabOrder`
  - `src/app/api/lab-orders/[id]/result/route.ts`: `LAB_RESULT_ENTRY_ROLES` → `readJsonBody` → `labResultSchema` → `recordLabResult(…, { kind: 'staff', session })`
  - `src/app/api/lab-orders/[id]/cancel/route.ts`: `LAB_ORDER_ROLES` → `labOrderCancelSchema` → `cancelLabOrder`. The route's own audit is removed; the query audits, without the reason text.
  - `src/app/api/lab-orders/[id]/imaging/route.ts`: `LAB_COLLECT_ROLES`; `collectLabOrder` replaces `markCollected`, result ignored as today
  - `src/app/api/webhooks/fhir-labs/route.ts`
  - `src/lib/fhir/observation.ts`
  - `src/lib/queries/lab-orders.ts`: delete `markCollected`, `enterResult`, `cancelOrder` and `DbTx`
- Create: `src/app/api/lab-orders/receive/route.ts` (POST), `src/app/api/lab-orders/[id]/verify/route.ts` (POST, no body)
- Modify tests: `tests/api/lab-orders.test.ts`, `tests/api/lab-orders-routes.test.ts`, `tests/api/webhooks-fhir-labs.test.ts`, `tests/api/lab-orders-imaging.test.ts`, `tests/lib/fhir/observation-mapping.test.ts`, `tests/api/rbac-route-gates.test.ts`
- Test: `tests/api/lab-lifecycle-routes.test.ts` (mocked)

**Interfaces:**
- Consumes: Task 6 functions; Task 1 `isAcceptedLisObservationStatus`, `fhirObservationStatusFor`, `parseSampleId`; Task 3 constants.
- Produces:
  - **Error mapping (all routes):**
    - `not_found` → 404 `'Lab order not found'`
    - `invalid_status` → 409 `'This order is not at a stage where that can be done.'`
    - `booked_for_home` → 409 `'This test is booked for home collection. Cancel the home visit first.'`
    - `self_verification` → 409 `'Results must be verified by someone other than the person who entered them.'`
    - `not_cancellable` → 409 `'Only tests without a result can be cancelled.'`
  - **`POST /api/lab-orders/receive`:**
    - gate `LAB_RECEIVE_ROLES` → JSON → `receiveSampleSchema` → `parseSampleId` null → 400 `'That sample ID is not valid. Re-scan or re-type it.'` **before** any query
    - then `not_found` → 404 `'No lab order has that sample ID.'`; `already_received` → 409 `'This sample has already been received.'`
    - success is 200 `{ orderId, sampleId }`
  - `POST /api/lab-orders/[id]/verify` returns 200 `{ ok: true }`.
  - `POST /api/lab-orders/[id]/collect` returns 200 `{ ok: true, sampleId }`.
  - **Webhook:**
    - `isAcceptedLisObservationStatus(obs.status)` false → 400 `{ error: 'Unsupported Observation status' }` before any write
    - otherwise `recordLabResult(orderId, …, { kind: 'lis' }, { expectedPatientId })`
    - every `ok: false` → the existing 409 message
    - token handling is unchanged
  - **FHIR export:** `FhirObservation.status: 'preliminary' | 'final'`. `observationToFhir` uses `fhirObservationStatusFor(order.status)` and returns null when that is null. `PatientLabOrderRow` already carries `status`.
  - **Harness rows:**
    - `API_GATES`:
      - `GET /api/lab-orders`
      - `POST /api/lab-orders/[id]/collect`
      - `POST /api/lab-orders/receive`
      - `POST /api/lab-orders/[id]/result`
      - `POST /api/lab-orders/[id]/verify`
      - `POST /api/lab-orders/[id]/cancel`
      - `POST /api/lab-orders/[id]/imaging`
      Each uses its constant, through `settle()` with the bogus id.
    - `SP5_WRITE_GATES`: receive, result and cancel.

- [ ] **Step 1: Write the failing tests**

```ts
// lab-lifecycle-routes.test.ts (mock lab-lifecycle + auth + audit)
it.each(['pi', 'crc', 'frontdesk', 'collector'] as const)('%s cannot enter a result (403, query not called)', async (r) => { /* … */ })
it('pi verifies; labs cannot', async () => { role = 'labs'; expect((await VERIFY(post(), ctx('4'))).status).toBe(403); role = 'pi'; vi.mocked(verifyLabResult).mockResolvedValue({ ok: true } as never); expect((await VERIFY(post(), ctx('4'))).status).toBe(200) })
it('maps self_verification to 409 with the message', async () => { /* … */ })
it('receive 400s a bad check digit before any DB call', async () => {
  role = 'labs'; const res = await RECEIVE(send({ sampleId: 'L26100800439' })); expect(res.status).toBe(400); expect(receiveLabSample).not.toHaveBeenCalled()
})
it('cancel never puts the reason in the audit log', async () => { /* logAudit not called by the route; cancelLabOrder called with reason */ })
// webhooks-fhir-labs.test.ts (append, DB)
it('a final observation lands as resulted (awaiting verification), not verified', async () => { /* status 'resulted' */ })
it('rejects an entered-in-error observation with 400 and writes nothing', async () => { /* … */ })
it('409s a result for an already verified order', async () => { /* … */ })
// observation-mapping.test.ts (update)
it('resulted is preliminary, verified/reported are final, received has no observation', () => { /* … */ })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/api/lab-lifecycle-routes.test.ts tests/lib/fhir/observation-mapping.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the route changes, the two new routes, the webhook and FHIR mapping, and the harness rows. Migrate the existing lab tests to the new statuses and functions. In the old tests, an order reaches `resulted` via collect → receive → result.

- [ ] **Step 4: Run the tests to verify they pass**

Run:
- `npx vitest run tests/api/lab-lifecycle-routes.test.ts tests/lib/fhir`
- `npm test -- tests/api/lab-orders.test.ts tests/api/lab-orders-routes.test.ts tests/api/webhooks-fhir-labs.test.ts tests/api/lab-orders-imaging.test.ts tests/api/rbac-route-gates.test.ts tests/api/fhir-export-routes.test.ts`
- `npx tsc --noEmit`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/lab-orders src/app/api/webhooks/fhir-labs src/lib/fhir/observation.ts src/lib/queries/lab-orders.ts tests/api/lab-lifecycle-routes.test.ts tests/api/lab-orders.test.ts tests/api/lab-orders-routes.test.ts tests/api/webhooks-fhir-labs.test.ts tests/api/lab-orders-imaging.test.ts tests/lib/fhir tests/api/rbac-route-gates.test.ts
git commit -m "feat(sp5): receive-by-scan, verification by pi/admin, LIS results land as preliminary"
```

---

### Task 9: `/labs` worklist by stage, chart lab section, sample label sheet, doctor "to verify"

**Files:**
- Modify:
  - `src/lib/queries/lab-orders.ts`:
    - `WorklistRow` + `sampleId`, `requisitionId`, `homeCollectionVisitId`, `visitDate: string | null`, `receivedAt`, `verifiedAt`, `patientUhid`, `result: { value; unit; flag; resultedByName; amendedAt } | null`
    - `PatientLabOrderRow` + `sampleId`, `requisitionId`, `quotedPricePaise`, `quoteStatus`, `verifiedByName`, `verifiedAt`
    - patient columns stay named
  - `src/components/LabWorklist.tsx`: stage sections and actions (below)
  - `src/app/(dashboard)/labs/page.tsx`:
    - gate `LAB_WORKLIST_ROLES`
    - tiles: Awaiting collection = `ordered|scheduled`; In transit = `collected`; At the bench = `received`; To verify = `resulted`
  - `src/components/LabResultsSection.tsx`: `LAB_STATUS_LABEL` chip, `formatPaise(quotedPricePaise)` or `'Not priced'`, `displaySampleId`, a "Preliminary: awaiting verification" note for `resulted`
  - `src/app/(dashboard)/doctor/page.tsx`: a "Results to verify" list (my patients' `resulted` orders) linking to `/labs`
- Create:
  - `src/lib/labs/qr.ts`
  - `src/app/(dashboard)/lab-labels/page.tsx`
  - `src/components/labs/SampleLabelSheet.tsx` (server component)
  - `src/components/labs/ReceiveSampleForm.tsx` (client)
- Modify: `tests/pages/page-gates-harness.ts`: row `{ route: '/lab-labels', load: …, props: { searchParams: Promise.resolve({ orders: '1' }) }, allowed: ['admin', 'pi', 'labs', 'frontdesk'] }`. No nav entry; the page is reached from links.
- Modify tests: `tests/pages/labs-lis-status.test.tsx`, `tests/pages/lab-worklist-imaging.test.tsx`, `tests/pages/lab-results-section-imaging.test.tsx`, `tests/pages/doctor.test.tsx` (fixture shapes)
- Test: `tests/components/LabWorklist.stages.test.tsx`, `tests/pages/lab-labels.test.tsx`, `tests/lib/labs/qr.test.ts`

**Interfaces:**
- Consumes: Task 1 labels and `displaySampleId`; Task 3 constants; Task 8 routes; `formatPaise`, `formatDateTimeIn`; `QRCode.create` from `qrcode`.
- Produces:
  - `qrModules(text: string): { size: number; dark: boolean[] }`, from `QRCode.create(text, { errorCorrectionLevel: 'M' }).modules`
  - `listLabelsForOrders(ids: number[]): Promise<{ orderId: number; sampleId: string | null; testName: string; container: string | null; patientName: string; uhid: string | null }[]>`, in `lab-orders.ts`
  - **`LabWorklist`** props `{ orders: WorklistOrder[]; labTests: LabTestOption[]; role: Role }`. Sections, in order:
    - **To collect** (`ordered`, `scheduled`). A `scheduled` row shows the `Home visit <formatIsoDate(visitDate)>` badge and has no Collect button. "Mark collected" shows for `LAB_COLLECT_ROLES`. Success shows the returned sample ID and a "Print label" link to `/lab-labels?orders=<id>`.
    - **In transit** (`collected`). A `ReceiveSampleForm` sits at the top for `LAB_RECEIVE_ROLES`: one text input labelled "Scan or type sample ID", submitted on Enter.
    - **At the bench** (`received`). "Enter result" for `LAB_RESULT_ENTRY_ROLES`.
    - **To verify** (`resulted`). Shows value/unit/flag. "Amend" for entry roles, "Verify" for `LAB_VERIFY_ROLES`.
    - **To report** (`verified`), grouped by `requisitionId`. Task 14 adds the release button here.
    - **Reported** and **Cancelled**.
    - "Cancel" stays on pre-result rows for `LAB_ORDER_ROLES`.
  - **`/lab-labels` page:**
    - gate `LAB_LABEL_ROLES`
    - `orders` search param: comma-separated positive ints, max 50, invalid ones dropped, none → the text `'No orders selected.'`
    - renders one label per order: QR as `<svg>` `<rect>`s of the **canonical** sample ID (no `dangerouslySetInnerHTML`), the display ID, the test name, the container label, the patient name and UHID; an order with no sample ID shows "No sample ID yet"
    - a print stylesheet (`@media print`) hides the app chrome
    - audits `printed lab sample labels`, details `orders=<ids>`

- [ ] **Step 1: Write the failing tests**

```ts
// LabWorklist.stages.test.tsx
it('labs sees Receive and Enter result but not Verify', () => { /* role labs: ReceiveSampleForm present; Verify button absent */ })
it('pi sees Verify on resulted rows and no receive box', () => { /* … */ })
it('a home-booked order shows its visit date and no Mark collected', () => { /* status scheduled visitDate '2099-05-02' → /Home visit 2 May 2099/ */ })
// lab-labels.test.tsx (page, mocked queries)
it('renders a QR and the grouped sample ID and audits ids only', async () => { /* svg rect count > 0; text 'L261008-0042-9'; logAudit details 'orders=1' */ })
it('drops invalid ids from the orders param', async () => { /* orders 'x,-1,2' → listLabelsForOrders called with [2] */ })
// qr.test.ts
it('produces a square module matrix', () => { const m = qrModules('L26100800429'); expect(m.dark.length).toBe(m.size * m.size) })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/components/LabWorklist.stages.test.tsx tests/pages/lab-labels.test.tsx tests/lib/labs/qr.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the queries, components, pages and harness row, and update the four existing page tests' fixtures.

- [ ] **Step 4: Run the tests to verify they pass**

Run:
- `npx vitest run tests/components/LabWorklist.stages.test.tsx tests/pages/lab-labels.test.tsx tests/lib/labs tests/pages/labs-lis-status.test.tsx tests/pages/lab-worklist-imaging.test.tsx tests/pages/lab-results-section-imaging.test.tsx tests/pages/doctor.test.tsx tests/pages/nav-role-enforcement.test.tsx`
- `npm test -- tests/lib/queries/lab-orders-roster.test.ts tests/lib/queries/lab-results-patient-scoping.test.ts`
- `npx tsc --noEmit`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/queries/lab-orders.ts src/lib/labs/qr.ts src/components/LabWorklist.tsx src/components/LabResultsSection.tsx src/components/labs "src/app/(dashboard)/labs/page.tsx" "src/app/(dashboard)/lab-labels" "src/app/(dashboard)/doctor/page.tsx" tests/pages tests/components/LabWorklist.stages.test.tsx tests/lib/labs/qr.test.ts
git commit -m "feat(sp5): stage-based lab worklist, receive box, verify actions and printable sample labels"
```

---

### Task 10: Home-collection booking queries (context, availability, book, reschedule, cancel, assign, board)

**Files:**
- Create: `src/lib/queries/home-collections.ts`
- Test: `tests/lib/queries/home-collections.test.ts` (DB)

**Interfaces:**
- Consumes:
  - Task 1: `bookingDateProblem`, `windowClosed`, reason enums, `BookHomeCollectionRequest`
  - Task 4: `getActiveServicePins`, `isLocalPin`
  - Task 6: `ensureSampleIds`
  - SP3: `istDateOf`, `todayIsoIn`
  - `logAudit`
- Produces:
  - `interface WindowAvailability { windowId: number; label: string; startTime: string; endTime: string; capacity: number; booked: number; remaining: number; closed: boolean }`
  - `listWindowAvailability(dateIso: string, now = new Date()): Promise<WindowAvailability[]>`. It covers active windows only. `booked` counts visits in `booked|collected` for that date and window.
  - `interface HomeCollectionContext { patient: { id; name; uhid; phone; addressLine1; addressLine2; city; district; stateCode; pinCode; notificationOptOut }; isLocal: boolean; bookableOrders: { id: number; testName: string; sampleType: string | null; container: string | null }[]; activeVisits: { id: number; visitDate: string; windowLabel: string }[] }`
  - `getHomeCollectionContext(patientIdOrUhid: string): Promise<HomeCollectionContext | null>`. It matches `patients.id` or `patients.uhid`. `bookableOrders` are `status 'ordered'` and category `lab` only (imaging is never home-collected).
  - **`bookHomeCollection(input: BookHomeCollectionRequest, session: Session, now = new Date())`** returns `{ ok: true; visit: HomeCollectionVisitRow; sampleIds: Map<number, string> } | { ok: false; error: 'invalid_date' | 'window_not_found' | 'window_closed' | 'not_in_service_area' | 'order_not_bookable' | 'slot_full' | 'already_booked' | 'patient_not_found'; message?: string }`. One transaction, in this order:
    1. `bookingDateProblem(visitDate, istDateOf(now))` → `invalid_date` with the message.
    2. Active window, else `window_not_found`. `windowClosed` → `window_closed`.
    3. `address.pinCode` must be in the active service area, else `not_in_service_area`.
    4. Lock the orders `for update`. Every id must exist, belong to the patient, be `ordered` and be category `lab`, else `order_not_bookable`.
    5. Take `pg_advisory_xact_lock(hashtext('home_collection:' || visitDate || ':' || windowId))`.
    6. An existing `booked` visit for the patient, date and window → `already_booked`.
    7. Count `booked|collected` visits ≥ capacity → `slot_full`.
    8. Insert the visit with the window snapshot and the address snapshot.
    9. `ensureSampleIds(tx, orderIds, now)`.
    10. Update the orders: `status 'scheduled'`, `homeCollectionVisitId`, `statusChangedAt`.
    11. Audit `booked home sample collection`, details `visit=<id> orders=<ids> date=<visitDate> window=<windowId>`.
  - **`rescheduleHomeCollection(visitId: number, input: { visitDate; windowId; reason; note? }, session, now = new Date())`** returns `{ ok: true; visit } | { ok: false; error: 'not_found' | 'not_reschedulable' | 'same_slot' | 'invalid_date' | 'window_not_found' | 'window_closed' | 'slot_full' | 'already_booked'; message?: string }`:
    - Locks the visit; it must be `booked`.
    - Runs the same checks 1, 2, 5, 6 and 7 on the new slot, excluding itself.
    - If the date changes, the collector assignment is cleared.
    - Bumps `rescheduleCount` and sets `lastRescheduleReason` / `lastRescheduleNote`.
    - Audits `rescheduled home sample collection`, details `visit=<id> date=<d> window=<w> reason=<code>`.
  - **`cancelHomeCollection(visitId: number, input: { reason: VisitCancelReason; note?: string }, session, now = new Date())`** returns `{ ok: true; visit; releasedOrderIds: number[] } | { ok: false; error: 'not_found' | 'not_cancellable' | 'not_assigned' | 'reason_not_allowed' }`:
    - The visit must be `booked`.
    - For a collector session: the visit's `collectorUserId` must be `session.userId`, else `not_assigned`; the reason must be in `COLLECTOR_CANCEL_REASONS`, else `reason_not_allowed`.
    - Its `scheduled` orders go back to `ordered`, with the visit link cleared. The sample IDs are kept.
    - Audits `cancelled home sample collection`, details `visit=<id> reason=<code> orders=<ids>`.
  - `assignCollector(visitId: number, collectorUserId: number | null, session)` returns `{ ok: true; visit } | { ok: false; error: 'not_found' | 'not_assignable' | 'collector_not_found' }`. The user must have role `collector`. Audits `assigned home collection collector`, details `visit=<id> collector=<id|none>`.
  - `listCollectors(): Promise<{ id: number; name: string }[]>`
  - `interface BoardVisit { id; status; visitDate; windowId; windowLabel; patientId; patientName; uhid; city; pinCode; contactPhone; collector: { userId: number; name: string } | null; rescheduleCount: number; tests: { orderId: number; testName: string; sampleId: string | null; container: string | null; status: LabOrderStatus }[] }`
  - `listHomeCollectionBoard(dateIso: string, now = new Date()): Promise<{ windows: WindowAvailability[]; visits: BoardVisit[] }>`. It uses one query for visits and one for their orders (no N+1), sorted by window start then id.

- [ ] **Step 1: Write the failing DB tests**

```ts
describe.skipIf(!process.env.DATABASE_URL)('home collections (DB)', () => {
  const NOW = new Date('2099-07-01T03:00:00Z') // 08:30 IST
  it('books a local patient, snapshots the address and schedules the orders with sample IDs', async () => {
    const r = await bookHomeCollection(req({ visitDate: '2099-07-02' }), S, NOW)
    expect(r.ok && r.visit).toMatchObject({ status: 'booked', pinCode: '990021', windowLabel: W.label })
    // orders status 'scheduled', homeCollectionVisitId = visit.id, sampleId parses
  })
  it('refuses an address outside the service area', async () => { /* pinCode 990029 (inactive) → not_in_service_area, orders still 'ordered' */ })
  it('a window starting within 60 minutes is closed', async () => { /* window 09:00, NOW 08:30 IST same day → window_closed */ })
  it('concurrent bookings for the last place in a window: exactly one wins', async () => {
    // window capacity 1, two different patients
    const [a, b] = await Promise.all([bookHomeCollection(reqA, S, NOW), bookHomeCollection(reqB, S, NOW)])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1); expect([a, b].find((r) => !r.ok)).toMatchObject({ error: 'slot_full' })
    // exactly one visit row for that date/window; the loser's orders are still 'ordered'
  })
  it('the same patient cannot double-book one slot', async () => { /* already_booked */ })
  it('refuses imaging and already-scheduled orders', async () => { /* order_not_bookable */ })
  it('reschedule moves the slot, clears the collector on a date change, and bumps the count', async () => { /* … */ })
  it('cancel returns the orders to ordered and keeps their sample IDs', async () => { /* … */ })
  it('a collector may cancel only their own visit with a collector reason', async () => { /* not_assigned; reason 'patient_request' → reason_not_allowed; 'patient_unavailable' on own → ok */ })
  it('assignCollector accepts only collector-role users', async () => { /* labs user → collector_not_found */ })
  it('audit details carry no address, phone or note', async () => { /* note 'SECRETNOTE', line1 'SECRETLINE' absent from audit_log */ })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/lib/queries/home-collections.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `home-collections.ts`. The patient reads use named columns. `getHomeCollectionContext` never selects Aadhaar or credentials.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/lib/queries/home-collections.test.ts`, then `npx tsc --noEmit` and `npx vitest run tests/lib/no-aadhaar-leak.test.ts tests/lib/no-credential-leak.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/queries/home-collections.ts tests/lib/queries/home-collections.test.ts
git commit -m "feat(sp5): home-collection booking with capacity locks, service-area check, reschedule/cancel and dispatch"
```

---

### Task 11: Home-collection routes, `/home-collections` board, booking UI, notices

**Files:**
- Create routes:
  - `src/app/api/home-collections/route.ts` (POST book)
  - `src/app/api/home-collections/context/route.ts` (GET)
  - `src/app/api/home-collections/availability/route.ts` (GET)
  - `src/app/api/home-collections/[id]/route.ts` (PATCH reschedule)
  - `src/app/api/home-collections/[id]/cancel/route.ts` (POST)
  - `src/app/api/home-collections/[id]/collector/route.ts` (PUT)
- Create page and components:
  - `src/app/(dashboard)/home-collections/page.tsx`
  - `src/components/home-collection/api.ts`
  - `src/components/home-collection/HomeCollectionBoard.tsx`
  - `src/components/home-collection/BookHomeCollectionModal.tsx`
  - `src/components/home-collection/RescheduleVisitModal.tsx`
  - `src/components/home-collection/CancelVisitDialog.tsx`
- Modify:
  - `src/components/LeftNav.tsx`: `{ href: '/home-collections', label: 'Home Collection', icon: House, roles: ['admin', 'frontdesk', 'labs'] as Role[] }` directly after Labs; update the frontdesk comment ("home-collection booking, no lab results")
  - `tests/pages/page-gates-harness.ts`: `{ route: '/home-collections', load: …, props: { searchParams: Promise.resolve({}) }, allowed: ['admin', 'frontdesk', 'labs'] }` with a `// LeftNav.tsx` comment
  - `tests/api/rbac-route-gates.test.ts`:
    - 6 `API_GATES` rows, allowed: `HOME_COLLECTION_BOOKING_ROLES` (context, availability, book, reschedule), `HOME_COLLECTION_CANCEL_ROLES` (cancel), `HOME_COLLECTION_DISPATCH_ROLES` (collector)
    - `SP5_WRITE_GATES` rows for book, reschedule, cancel and collector
- Test: `tests/api/home-collections-routes.test.ts` (mocked), `tests/pages/home-collections.test.tsx`, `tests/components/home-collection/BookHomeCollectionModal.test.tsx`

**Interfaces:**
- Consumes: Task 10 functions; Task 5 `notifyPatientSafely`; Task 1 schemas; `brand`; `formatIsoDate`.
- Produces:
  - **GET routes:**
    - `GET …/context?patient=<id or UHID>`: missing → 400; null → 404 `'Patient not found'`. Success is 200 with the context. Audits `viewed home collection booking context` (patientId).
    - `GET …/availability?date=YYYY-MM-DD`: an invalid date → 400. Success is 200 `WindowAvailability[]`.
  - **Book** (201 `{ visit, sampleIds: Record<orderId, sampleId> }`). Error mapping:
    - `invalid_date` → 400 with its message
    - `window_not_found` → 404 `'Collection window not found'`
    - `window_closed` → 409 `'That collection window has already started or is too close to book.'`
    - `not_in_service_area` → 409 `'That address is outside the home-collection service area. The patient can visit the lab instead.'`
    - `order_not_bookable` → 409 `'One or more tests are already booked, collected, cancelled, or cannot be collected at home.'`
    - `slot_full` → 409 `'That collection window is full. Pick another window.'`
    - `already_booked` → 409 `'This patient already has a home collection in that window.'`
    - `patient_not_found` → 404
  - **Reschedule:** the same mapping plus `same_slot` → 400 `'Pick a different date or window.'` and `not_reschedulable` → 409 `'Only a booked visit can be rescheduled.'`.
  - **Cancel:** `not_assigned` → 403 `{ error: 'Forbidden' }`; `reason_not_allowed` → 400; `not_cancellable` → 409.
  - **Collector:** `collector_not_found` → 400; `not_assignable` → 409.
  - **Notices after commit** (never on error):
    - booked → `home_collection_booked`, dedupe `home_collection_booked:visit=<id>`
    - rescheduled → `home_collection_rescheduled`, dedupe `home_collection_rescheduled:visit=<id>:n=<rescheduleCount>`
    - cancelled → `home_collection_cancelled`, dedupe `home_collection_cancelled:visit=<id>`
    - vars use `brand.name`, `visitDate` and `windowLabel`; related `{ type: 'home_collection_visit', id }`
  - **Page `HomeCollectionsPage({ searchParams })`:**
    - first statement `requireSessionOrRedirect()`, then a `HOME_COLLECTION_BOOKING_ROLES` redirect
    - `date` = a valid `?date` or `todayIsoIn()`
    - loads `listHomeCollectionBoard(date)` and `listCollectors()`
    - audits `viewed home collection board`
    - renders `<HomeCollectionBoard date windows visits collectors canDispatch={HOME_COLLECTION_DISPATCH_ROLES.includes(role)} />`
  - **`HomeCollectionBoard`:**
    - a date picker (prev/next day links)
    - window cards `label · booked/capacity`
    - a visit table: Patient (UHID), area PIN, phone `tel:`, tests with sample IDs, collector select (dispatch only), status, actions (Reschedule, Cancel, "Print labels" → `/lab-labels?orders=…`)
    - a "New booking" button opens `BookHomeCollectionModal`
  - **`BookHomeCollectionModal`:**
    - patient id/UHID input → context
    - when `!isLocal` it shows `'Outside the service area: walk-in only'` and still lets staff edit the address (the visit PIN decides)
    - test checkboxes (`bookableOrders`, all checked by default)
    - date + window select from availability, showing `remaining` and disabling full or closed windows
    - address fields prefilled from the patient
    - contact phone prefilled, notes
    - on 201 it shows the sample IDs and a "Print labels" link

- [ ] **Step 1: Write the failing tests**

```ts
// home-collections-routes.test.ts
it.each(['pi', 'crc', 'billing', 'pharmacy', 'collector'] as const)('%s cannot book (403 before parse)', async (r) => { /* body '{not json' → 403; bookHomeCollection not called */ })
it.each([['slot_full', 409], ['not_in_service_area', 409], ['window_closed', 409], ['invalid_date', 400], ['window_not_found', 404]] as const)('maps %s to %i', async (error, status) => { /* … */ })
it('notifies booked with a visit dedupe key only after success', async () => { /* … notifyPatientSafely not called on 409 */ })
it('labs can assign a collector; frontdesk cannot', async () => { /* … */ })
it('collector cancel of someone else\'s visit is 403', async () => { /* cancelHomeCollection → not_assigned → 403 Forbidden */ })
// home-collections.test.tsx (page)
it('frontdesk sees the board without the collector select', async () => { /* … */ })
it('uses the IST date by default and a valid ?date', async () => { /* listHomeCollectionBoard called with todayIsoIn(); with '2099-07-02' */ })
// BookHomeCollectionModal.test.tsx
it('disables full and closed windows and shows the walk-in-only note for a non-local patient', async () => { /* … */ })
it('posts the edited address snapshot and selected orders', async () => { /* fetch body matches bookHomeCollectionSchema */ })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/api/home-collections-routes.test.ts tests/pages/home-collections.test.tsx tests/components/home-collection`
Expected: FAIL.

- [ ] **Step 3: Implement** the routes, the page, the components, the nav item and the harness rows.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the same command, then `npx vitest run tests/pages/nav-role-enforcement.test.tsx tests/components/LeftNav.test.tsx`, `npm test -- tests/api/rbac-route-gates.test.ts`, and `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/home-collections "src/app/(dashboard)/home-collections" src/components/home-collection src/components/LeftNav.tsx tests/pages/page-gates-harness.ts tests/api/rbac-route-gates.test.ts tests/api/home-collections-routes.test.ts tests/pages/home-collections.test.tsx tests/components/home-collection
git commit -m "feat(sp5): home-collection board, booking and dispatch UI with patient notices"
```

---

### Task 12: Collector "My route" page and mark-collected with sample IDs (lab encounter)

**Files:**
- Modify: `src/lib/queries/home-collections.ts` (add the two functions below)
- Create:
  - `src/app/api/home-collections/[id]/collect/route.ts` (POST)
  - `src/app/(dashboard)/collections/page.tsx`
  - `src/components/home-collection/CollectorRoute.tsx` (client)
- Modify:
  - `src/components/LeftNav.tsx`: `{ href: '/collections', label: 'My Route', icon: Route, roles: ['admin', 'collector'] as Role[] }` after Home Collection
  - `tests/pages/page-gates-harness.ts`: row `/collections`, allowed `['admin', 'collector']`, `props: { searchParams: Promise.resolve({}) }`
  - `tests/api/rbac-route-gates.test.ts`: `POST /api/home-collections/[id]/collect` in `API_GATES` and `SP5_WRITE_GATES`, allowed `[...COLLECTOR_ROUTE_ROLES]`
  - if SP3's `EncounterList` maps encounter types with a `Record`, add `lab: 'Home sample collection'`
- Test: `tests/lib/queries/home-collections-collect.test.ts` (DB), `tests/api/home-collections-collect-route.test.ts`, `tests/pages/collections.test.tsx`

**Interfaces:**
- Consumes: Task 10 (visit rows, `cancelHomeCollection` for "Could not collect"); Task 1 `parseSampleId`, `displaySampleId`, `SAMPLE_CONTAINER_LABEL`, `COLLECTOR_CANCEL_REASONS`; SP3 `encounters`, `istDateOf`, `todayIsoIn`; `ageOnDate`.
- Produces:
  - `interface RouteStop { visitId: number; status: HomeCollectionStatus; windowLabel: string; windowStart: string; windowEnd: string; patient: { id: string; name: string; uhid: string | null; ageYears: number; gender: string | null }; contactPhone: string; address: { line1; line2; city; district; stateCode; pinCode; landmark }; notes: string | null; tests: { orderId: number; testName: string; sampleType: string | null; container: string | null; sampleId: string | null; status: LabOrderStatus }[] }`
  - `listCollectorRoute(collectorUserId: number | null, dateIso: string): Promise<RouteStop[]>`. Null means all visits (admin view). Sorted by `windowStart`, then id. Visits in every status are listed, so the collector sees what they finished.
  - **`collectHomeVisit(visitId: number, sampleIds: string[], session: Session, now = new Date())`** returns `{ ok: true; collectedOrderIds: number[]; notCollectedOrderIds: number[]; encounterId: number } | { ok: false; error: 'not_found' | 'not_collectable' | 'not_assigned' | 'invalid_sample_id' | 'sample_not_on_visit'; sampleId?: string }`. One transaction:
    1. Lock the visit. It must be `booked`, else `not_collectable`.
    2. A collector session must be the assigned collector, else `not_assigned`.
    3. Each input goes through `parseSampleId`. A null or a duplicate → `invalid_sample_id` with that input.
    4. Lock the visit's `scheduled` orders. Every canonical ID must equal one of their `sampleId`s, else `sample_not_on_visit` with that ID. Nothing is written in either error case.
    5. Matched orders → `collected` (`collectedAt = now`, `collectedByName`). Unmatched `scheduled` orders → `ordered` with the visit link cleared.
    6. Insert an `encounters` row:
       - `encounterType 'lab'`, `visitType 'new'`, `status 'completed'`
       - `encounterDate = istDateOf(now)`, `opdToken null`
       - `providerId` = the first collected order's `orderedByProviderId`, `departmentId` = that provider's department
       - `checkedInByName = session.name`; `checkedInAt`, `completedAt` and `statusChangedAt` = now; `statusChangedByName`
    7. Update the visit: `status 'collected'`, `collectedAt`, `collectedByName`, `encounterId`.
    8. Audit `collected home samples`, details `visit=<id> orders=<collected ids> missed=<ids> encounter=<id>`.
- **Route:**
  - gate `COLLECTOR_ROUTE_ROLES` → JSON → `collectHomeVisitSchema`
  - `not_assigned` → 403 `{ error: 'Forbidden' }`
  - `invalid_sample_id` → 400 `` `Sample ID ${input} is not valid. Re-scan or re-type it.` ``
  - `sample_not_on_visit` → 409 `` `Sample ${displaySampleId(id)} does not belong to this visit. Check the tube label.` ``
  - `not_collectable` → 409
  - success is 200 with the result
- **Page `/collections`:**
  - gate `COLLECTOR_ROUTE_ROLES`
  - `date = todayIsoIn()`; admin may pass `?date`
  - `listCollectorRoute(role === 'collector' ? session.userId : null, date)`. A collector with `userId === null` sees an empty list.
  - audits `viewed collection route`
  - **`CollectorRoute`:** per stop, the window, the patient (name, UHID, age/gender), a `tel:` link, the address and landmark, and per test the container label and the expected sample ID.
    - "Mark collected" opens one input per expected tube ("Scan or type the tube's sample ID") and posts the entered IDs. Tubes left empty count as not collected.
    - "Could not collect" posts to `…/cancel` with a `COLLECTOR_CANCEL_REASONS` select.
  - Mobile-first layout: single column, large tap targets. Geo and signature are not collected.

- [ ] **Step 1: Write the failing tests**

```ts
// home-collections-collect.test.ts (DB)
it('collects matching tubes, releases the rest, and opens a completed lab encounter', async () => {
  const r = await collectHomeVisit(visit.id, [sidA], COLLECTOR_S, NOW)
  expect(r).toMatchObject({ ok: true, collectedOrderIds: [oA.id], notCollectedOrderIds: [oB.id] })
  // oA 'collected'; oB 'ordered' & no visit; encounter type 'lab' status 'completed'; visit 'collected' with encounterId
})
it('refuses a sample ID from another visit and changes nothing', async () => { /* sample_not_on_visit; all orders still 'scheduled'; visit 'booked'; no encounter */ })
it('refuses a collector who is not assigned', async () => { /* not_assigned */ })
it('route list at 00:15 IST shows that IST day\'s visits', async () => { /* visits on 2099-06-02; listCollectorRoute(uid, istDateOf(new Date('2099-06-01T18:45:00Z'))) includes them, excludes 2099-06-01 */ })
// collect-route.test.ts
it('400s a typo before calling the query; 409 names the wrong tube', async () => { /* … */ })
// collections.test.tsx
it('collector sees only own stops; admin sees all', async () => { /* listCollectorRoute called with (7, today) vs (null, today) */ })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/lib/queries/home-collections-collect.test.ts` and `npx vitest run tests/api/home-collections-collect-route.test.ts tests/pages/collections.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** the functions, the route, the page, the component, the nav item and the harness rows.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the same commands, then `npx vitest run tests/pages/nav-role-enforcement.test.tsx`, `npm test -- tests/api/rbac-route-gates.test.ts`, and `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/queries/home-collections.ts src/app/api/home-collections/[id]/collect "src/app/(dashboard)/collections" src/components/home-collection/CollectorRoute.tsx src/components/LeftNav.tsx tests/pages/page-gates-harness.ts tests/api/rbac-route-gates.test.ts tests/lib/queries/home-collections-collect.test.ts tests/api/home-collections-collect-route.test.ts tests/pages/collections.test.tsx src/components/follow-ups/EncounterList.tsx
git commit -m "feat(sp5): collector route list and sample-ID-checked home collection with a lab encounter"
```

---

### Task 13: Lab report data shape and PDF renderer (`pdf-lib`)

**Files:**
- Modify: `package.json` / `package-lock.json` (`npm install pdf-lib@1.17.1`)
- Create: `src/lib/labs/report-data.ts` (pure), `src/lib/labs/report-pdf.ts` (server only; first line `import 'server-only'` if the package is present, otherwise a header comment)
- Test: `tests/lib/labs/report-data.test.ts`, `tests/lib/labs/report-pdf.test.ts`

**Interfaces:**
- Consumes: `ageOnDate`, `istDateOf`, `formatDateTimeIn`, `formatIsoDate`; `displaySampleId`; `type Brand`.
- Produces:
  - **`LabReportData`:**
    ```ts
    export interface LabReportData {
      hospital: { name: string; legalName: string; site: string | null }
      reportNumber: string; version: number; generatedAt: string        // ISO instant
      patient: { name: string; uhid: string | null; patientId: string; ageYears: number; gender: string | null }
      referringDoctor: { name: string; registration: string | null }
      rows: { testName: string; testCode: string; sampleId: string | null; value: string; unit: string | null; referenceRange: string | null;
              flag: 'normal' | 'abnormal' | 'critical'; collectedAt: string | null; receivedAt: string | null; verifiedByName: string; verifiedAt: string }[]
      verifiers: string[]                                               // distinct, in row order
    }
    ```
  - `interface LabReportSource { hospital; reportNumber; version; patient: { id; name; dob; uhid; gender }; provider: { name; registrationCouncil; registrationStateCode; registrationNumber }; orders: { testName; testCode; sampleId; collectedAt: Date | null; receivedAt: Date | null; verifiedAt: Date; verifiedByName: string; result: { value; unit; referenceRange; flag } }[] }`
  - `buildLabReportData(src: LabReportSource, now: Date): LabReportData`:
    - `ageYears = ageOnDate(dob, istDateOf(now))`
    - a result's `referenceRange` falls back to the test's
    - `registration` is `'NMC <number>'` / `'SMC <stateCode> <number>'` / null (the same rule as SP3's discharge summary)
    - rows keep the source order
  - `flagLabel(flag): '' | 'ABNORMAL' | 'CRITICAL'`
  - `toPdfSafeText(s: string): string`. It replaces every character outside printable WinAnsi (`\x20-\x7E`, `\xA0-\xFF`) with `'?'` and collapses whitespace. `₹` is never needed (no money on the report).
  - `renderLabReportPdf(data: LabReportData): Promise<Uint8Array>`:
    - A4, Helvetica and Helvetica-Bold, every string through `toPdfSafeText`
    - header: `legalName` (bold), `site`, title `LABORATORY REPORT`
    - patient block: Name, UHID, Age / Gender, Referred by (+ registration), Report no. / version, Generated (IST via `formatDateTimeIn`)
    - table columns: Test · Result · Unit · Reference range · Flag. Rows wrap within their column. A new page starts below y = 90 pt with the header row repeated.
    - after the table: `Verified by: <names>`, a signature line `Authorised signatory: ______________________`, and `This is a computer-generated report.`
    - footer on every page: `Report <no> v<version> · Page n of m`
    - metadata: title `Lab report <no>`, producer `hospital.name`, creation date = `generatedAt`
    - no network or filesystem access (standard fonts only)

- [ ] **Step 1: Write the failing tests**

```ts
// report-data.test.ts
it('builds IST age, registration and range fallback', () => {
  const d = buildLabReportData(SRC, new Date('2099-03-02T19:00:00Z')) // IST 3 Mar 2099
  expect(d.patient.ageYears).toBe(/* dob 2059-03-03 → */ 40); expect(d.referringDoctor.registration).toBe('SMC KA 12345')
  expect(d.rows[1].referenceRange).toBe('70-110 mg/dL')
})
it('has no Aadhaar or ABHA anywhere in the shape', () => { expect(JSON.stringify(buildLabReportData(SRC, NOW))).not.toMatch(/aadhaar|abha/i) })
it('toPdfSafeText replaces non-WinAnsi characters', () => { expect(toPdfSafeText('राम  Kumar\t')).toBe('??? Kumar') })
// report-pdf.test.ts
it('renders a one-page PDF with metadata', async () => {
  const bytes = await renderLabReportPdf(DATA3); expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-')
  const doc = await PDFDocument.load(bytes); expect(doc.getPageCount()).toBe(1); expect(doc.getTitle()).toBe('Lab report LR-2099-000001')
})
it('breaks long reports across pages', async () => { expect((await PDFDocument.load(await renderLabReportPdf(DATA60))).getPageCount()).toBeGreaterThan(1) })
it('does not throw on a Devanagari name', async () => { await expect(renderLabReportPdf({ ...DATA3, patient: { ...DATA3.patient, name: 'राम' } })).resolves.toBeInstanceOf(Uint8Array) })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/labs/report-data.test.ts tests/lib/labs/report-pdf.test.ts`
Expected: FAIL.

- [ ] **Step 3: Install `pdf-lib@1.17.1` and implement** both modules.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the same command, then `npx tsc --noEmit` and `npx vitest run tests/lib/no-aadhaar-leak.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/lib/labs/report-data.ts src/lib/labs/report-pdf.ts tests/lib/labs/report-data.test.ts tests/lib/labs/report-pdf.test.ts
git commit -m "feat(sp5): lab report data shape and dependency-light pdf-lib renderer"
```

---

### Task 14: Report release (blob, versioning, stale guard, follow-up trigger) and staff download

**Files:**
- Create:
  - `src/lib/blob-store.ts`
  - `src/lib/queries/lab-reports.ts`
  - `src/app/api/lab-requisitions/[id]/report/route.ts` (POST, no body)
  - `src/app/api/lab-reports/[id]/download/route.ts` (GET)
  - `src/components/labs/ReleaseReportButton.tsx`
  - `src/components/labs/LabReportList.tsx`
- Modify:
  - SP3 `src/lib/queries/follow-ups.ts`: `CreateFollowUpOrderInput.source` adds `'lab_report'`, the input gains `originatingLabOrderId?: number | null`, and the insert writes `originatingLabOrderId: input.originatingLabOrderId ?? null`
  - `src/components/LabWorklist.tsx`: `ReleaseReportButton` per requisition group in "To report", for `LAB_REPORT_RELEASE_ROLES`
  - `src/app/(dashboard)/patients/[anonId]/medical-record/page.tsx` + `LabResultsSection`: load `listReportsForPatient(anonId)` and render `LabReportList` with download links
  - `tests/api/rbac-route-gates.test.ts`: two `API_GATES` rows (`LAB_REPORT_RELEASE_ROLES`, `LAB_REPORT_READ_ROLES`)
  - the medical-record page tests: mock `@/lib/queries/lab-reports`
- Test: `tests/lib/queries/lab-reports.test.ts` (DB, blob and render injected), `tests/api/lab-reports-routes.test.ts` (mocked), `tests/lib/blob-store.test.ts` (`@vercel/blob` mocked)

**Interfaces:**
- Consumes:
  - Task 13: `buildLabReportData`, `renderLabReportPdf`, `LabReportSource`
  - Task 6 statuses
  - Task 5: `notifyPatientSafely`
  - SP3: `createFollowUpOrder`, `notifyFollowUpSafely`, `istDateOf`, `todayIsoIn`
  - `brand`, `getPracticeIdentity`, `put`/`get` from `@vercel/blob`
- Produces:
  - **`blob-store.ts`:**
    - `putPrivateBlob(path: string, body: Uint8Array, contentType: string): Promise<{ url: string }>`, as `put(path, Buffer.from(body), { access: 'private', contentType, addRandomSuffix: false })`
    - `streamPrivateBlob(url: string, opts: { filename: string; disposition: 'inline' | 'attachment' }): Promise<Response | null>`:
      - null when `get` throws or `statusCode !== 200`; only `err.name` is logged
      - otherwise a `NextResponse(blob.stream)` with `Content-Type` from the blob, `Content-Disposition`, and `Cache-Control: private, no-store`
  - **`lab-reports.ts`:**
    - `nextLabReportNumber(now: Date): Promise<string>` returns `` `LR-${istDateOf(now).slice(0, 4)}-${String(nextval('lab_report_seq')).padStart(6, '0')}` ``
    - `interface ReleaseDeps { render(d: LabReportData): Promise<Uint8Array>; putBlob(path: string, bytes: Uint8Array): Promise<{ url: string }>; now(): Date }`
    - `type LabFollowUpOutcome = 'not_requested' | 'pending' | 'created' | 'linked' | 'failed' | 'already_resolved'`
    - **`releaseLabReport(requisitionId: number, session: Session, deps?: Partial<ReleaseDeps>)`** returns `{ ok: true; report: LabReportRow; followUp: { outcome: LabFollowUpOutcome; followUpOrderId: number | null; dueDate: string | null } } | { ok: false; error: 'not_found' | 'nothing_to_report' | 'stale' }`:
      1. **Snapshot** (no lock): the requisition, the patient (named columns: id, name, dob, uhid, gender), the provider, and the orders with `status in (verified, reported)` plus their results. No `verified` order → `nothing_to_report`. Record `verifiedIds`, `reportedIds` and each result's `amendedAt`.
      2. `reportNumber = await nextLabReportNumber(now)`. `version` = max existing + 1.
      3. Render, then `putBlob(\`lab-reports/${requisitionId}/${reportNumber}-${randomUUID()}.pdf\`, bytes)`. Compute `sha256` and `byteSize`.
      4. **One transaction:**
         - Lock the requisition `for update`. Re-select its orders `for update`.
         - If the `verified` / `reported` id sets or any `amendedAt` differ from the snapshot → `stale`. The orphan blob is accepted (blob-before-DB precedent).
         - Insert `lab_reports`. A unique violation on `lab_reports_requisition_version_unique` → `stale`.
         - Set `supersededAt = now` on earlier versions.
         - Update the verified orders to `reported` (`reportedAt`, `statusChangedAt`).
         - Audit `released lab report`, details `report=<id> requisition=<id> version=<n> orders=<ids>`.
         - Then the **follow-up trigger**:
           - `not_requested` if `!followUpRequested`
           - `already_resolved` if `followUpResolvedAt` is set
           - `pending` while any order of the requisition is still in `PRE_RESULT_STATUSES` or `resulted`
           - otherwise `resolveLabFollowUp(tx, requisition, lastReportedOrderId, session, istDateOf(now))`
    - **`resolveLabFollowUp(ex: WriteExecutor, req: LabRequisitionRow, originatingLabOrderId: number, session: Session, todayIso: string): Promise<{ outcome: 'created' | 'linked' | 'failed'; followUpOrderId: number | null; dueDate: string | null }>`:
      - **Link** when the patient has an open follow-up from the same prescriber (stored `status in ('planned', 'scheduled')`, `windowEnd >= today`, soonest `dueDate`, `for update`):
        - set its `originatingLabOrderId` only if null
        - audit `linked lab report to follow-up`, details `followUp=<id> requisition=<id>`
      - **Otherwise create:** `createFollowUpOrder({ patientId, source: 'lab_report', prescribedByProviderId: req.orderedByProviderId, departmentId: null, timing: { kind: 'interval', interval: { value, unit } }, reason: req.followUpReason ?? 'Review of lab results', planNotes: null, originatingEncounterId: null, originatingAdmissionId: null, originatingLabOrderId }, session, { executor: ex, today })`
        - `ok: false` → `failed`, audited `lab follow-up not created`, details `requisition=<id> error=<code>`
        - a failure never rolls back the report
      - It always sets `followUpResolvedAt`, `followUpOutcome` and `followUpOrderId` on the requisition.
    - `listReportsForPatient(patientId: string): Promise<{ id; reportNumber; version; releasedAt; testSummary; supersededAt }[]>`, newest first
    - `getLabReportForDownload(id: number): Promise<{ id; patientId; reportNumber; blobUrl; supersededAt } | null>`
    - `listPortalLabReports(patientId: string): Promise<{ id: number; reportNumber: string; releasedAt: Date; testSummary: string }[]>`: `supersededAt IS NULL` only, newest first
- **Routes:**
  - `POST /api/lab-requisitions/[id]/report`:
    - `not_found` → 404; `nothing_to_report` → 409 `'No verified results to report yet.'`; `stale` → 409 `'Results changed while the report was being generated. Please try again.'`
    - success is 201 `{ report: { id, reportNumber, version }, followUp }`
    - after commit: `notifyPatientSafely(… 'lab_report_ready', related { type: 'lab_report', id }, dedupe \`lab_report_ready:report=${id}\`)`
    - when the outcome is `created`: `notifyFollowUpSafely(session, { kind: 'planned', followUpOrderId, patientId, dueDate, appointmentStartsAt: null })`
  - `GET /api/lab-reports/[id]/download`:
    - gate `LAB_REPORT_READ_ROLES`; 404 `'Report not found'`
    - `streamPrivateBlob(…, { filename: \`${reportNumber}.pdf\`, disposition: 'inline' })`; null → 404 `'Stored file is missing'`
    - audits `downloaded lab report`, details `report=<id>`, only after the blob was found

- [ ] **Step 1: Write the failing tests**

```ts
// lab-reports.test.ts (DB; deps: render → fake bytes, putBlob → { url: 'https://blob.test/x' })
it('releases a report of the verified orders, marks them reported, versions it', async () => {
  const r = await releaseLabReport(req.id, S, deps); expect(r.ok && r.report).toMatchObject({ version: 1, supersededAt: null })
  // orders 'reported'; reportNumber matches /^LR-2099-\d{6}$/
})
it('a second release (after another order is verified) supersedes v1 with a cumulative v2', async () => { /* v2.orderIds ⊇ v1.orderIds; v1.supersededAt set */ })
it('a change between render and commit is stale and writes nothing', async () => {
  const r = await releaseLabReport(req.id, S, { ...deps, render: async (d) => { await verifyLabResult(o3.id, VERIFIER, NOW); return new Uint8Array([1]) } })
  expect(r).toEqual({ ok: false, error: 'stale' }) // no lab_reports row; o1/o2 still 'verified'
})
it('nothing verified → nothing_to_report', async () => { /* … */ })
it('creates a lab_report follow-up once every test is reported, due = today + interval', async () => {
  // requisition followUp 2 weeks; today IST '2099-08-01' → dueDate '2099-08-15'; source 'lab_report'; originatingLabOrderId = last order; outcome 'created'
})
it('is pending while a test is still at the bench, and never creates twice', async () => { /* first release 'pending'; final release 'created'; a v3 release 'already_resolved' */ })
it('links an existing open follow-up from the same doctor instead of creating one', async () => { /* outcome 'linked'; follow_up_orders count unchanged */ })
it('an inactive prescriber yields failed but the report is still released', async () => { /* … */ })
// lab-reports-routes.test.ts
it.each(['frontdesk', 'billing', 'pharmacy', 'collector'] as const)('%s cannot download (403)', async (r) => { /* … */ })
it('download streams through the helper and audits after the blob is found', async () => { /* streamPrivateBlob → null → 404 and logAudit not called */ })
it('notifies report-ready and the planned follow-up after a 201', async () => { /* … */ })
// blob-store.test.ts
it('puts with private access and never logs the URL', async () => { /* put called with { access: 'private', contentType: 'application/pdf', addRandomSuffix: false } */ })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/lib/queries/lab-reports.test.ts` and `npx vitest run tests/api/lab-reports-routes.test.ts tests/lib/blob-store.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the modules, routes, UI pieces, the SP3 extension and the harness rows. The SP3 follow-up tests must stay unchanged and green.

- [ ] **Step 4: Run the tests to verify they pass**

Run:
- the same commands
- `npm test -- tests/lib/queries/follow-ups.test.ts tests/api/rbac-route-gates.test.ts`
- `npx vitest run tests/pages tests/lib/no-aadhaar-leak.test.ts tests/lib/no-credential-leak.test.ts`
- `npx tsc --noEmit`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/blob-store.ts src/lib/queries/lab-reports.ts src/lib/queries/follow-ups.ts src/app/api/lab-requisitions src/app/api/lab-reports src/components/labs src/components/LabWorklist.tsx src/components/LabResultsSection.tsx "src/app/(dashboard)/patients/[anonId]/medical-record/page.tsx" tests/lib/queries/lab-reports.test.ts tests/api/lab-reports-routes.test.ts tests/lib/blob-store.test.ts tests/api/rbac-route-gates.test.ts tests/pages
git commit -m "feat(sp5): versioned PDF lab report release with stale guard, private storage and lab-report follow-up"
```

---

### Task 15: Portal "Your lab reports" and patient download

**Files:**
- Create: `src/app/patient-portal/(authenticated)/lab-reports/page.tsx`, `src/app/api/patient-portal/lab-reports/[id]/download/route.ts` (GET)
- Modify:
  - `src/components/PatientPortalSideNav.tsx`: `{ href: '/patient-portal/lab-reports', label: 'Lab reports', icon: FileCheck }` after Medications
  - `src/app/patient-portal/(authenticated)/page.tsx`: a "Lab reports" `SummaryTile` with `listPortalLabReports(...).length` and an href
  - `tests/pages/patient-portal-overview.test.tsx`: mock `@/lib/queries/lab-reports`
- Test: `tests/pages/patient-portal-lab-reports.test.tsx`, `tests/api/patient-portal-lab-report-download.test.ts`, `tests/components/PatientPortalSideNav.test.tsx` (append)

**Interfaces:**
- Consumes: Task 14 `listPortalLabReports`, `getLabReportForDownload`, `streamPrivateBlob`; `requirePatientSession(OrRedirect)`, `logPatientPortalAction`; `formatDateTimeIn`.
- Produces:
  - **Page:**
    - heading "Your lab reports"
    - one row per report: `testSummary`, `Released <formatDateTimeIn(releasedAt)>`, `Report <reportNumber>`, and a Download link to `/api/patient-portal/lab-reports/<id>/download`
    - empty state `'No lab reports yet. Reports appear here once your doctor has verified the results.'`
    - audits `logPatientPortalAction('viewed patient portal lab reports', patientId)`
  - **Download:**
    - `requirePatientSession()`
    - a report that does not belong to the session patient or is superseded → **404** `'Report not found'` (never 403, which would confirm it exists)
    - otherwise `streamPrivateBlob(…, { filename: \`${reportNumber}.pdf\`, disposition: 'attachment' })`; null → 404
    - audits `logPatientPortalAction('downloaded lab report via patient portal', patientId, \`report=${id}\`)` after the blob is found

- [ ] **Step 1: Write the failing tests**

```ts
// patient-portal-lab-reports.test.tsx
it('lists only the session patient\'s current reports with download links', async () => { /* listPortalLabReports called with session.patientId; link href */ })
it('shows the empty state', async () => { /* … */ })
// patient-portal-lab-report-download.test.ts
it('another patient\'s report is 404 and nothing is streamed or audited', async () => { /* getLabReportForDownload → { patientId: 'RD-0002' }; session RD-0001 → 404; streamPrivateBlob not called */ })
it('a superseded report is 404', async () => { /* … */ })
it('streams as an attachment and audits the download', async () => { /* Content-Disposition attachment; filename LR-…pdf */ })
it('no patient session → 401 from requirePatientSession', async () => { /* … */ })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/pages/patient-portal-lab-reports.test.tsx tests/api/patient-portal-lab-report-download.test.ts tests/components/PatientPortalSideNav.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the tests to verify they pass, then do the final sweep**

Run: the same command, then `npx vitest run tests/pages/patient-portal-overview.test.tsx` and `npx tsc --noEmit`.

Then do a final sweep **of the SP5-touched files only**:
- `npx vitest run tests/lib/labs tests/lib/home-collection tests/lib/notify tests/api/lab-* tests/api/home-collections* tests/pages tests/components tests/lib/no-aadhaar-leak.test.ts tests/lib/no-credential-leak.test.ts`
- `npm test -- tests/api/rbac-route-gates.test.ts tests/lib/queries/lab-lifecycle.test.ts tests/lib/queries/lab-requisitions.test.ts tests/lib/queries/home-collections.test.ts tests/lib/queries/home-collections-collect.test.ts tests/lib/queries/lab-reports.test.ts tests/lib/queries/notifications.test.ts tests/lib/queries/delete-patient-fk-guard.test.ts`
- `npm run build`

Expected: PASS, and the build succeeds.

- [ ] **Step 5: Commit**

```bash
git add "src/app/patient-portal/(authenticated)/lab-reports" "src/app/patient-portal/(authenticated)/page.tsx" src/app/api/patient-portal/lab-reports src/components/PatientPortalSideNav.tsx tests/pages/patient-portal-lab-reports.test.tsx tests/pages/patient-portal-overview.test.tsx tests/api/patient-portal-lab-report-download.test.ts tests/components/PatientPortalSideNav.test.tsx
git commit -m "feat(sp5): portal 'Your lab reports' with owner-checked, audited PDF download"
```

---

## Execution notes

**Model tier per task:**

| Task | Tier | Local DB needed |
|---|---|---|
| 1 Pure rules / sample ID / validation | standard (check-digit and IST lead-time contract) | no |
| 2 Schema + two migrations + type widening | most capable (enum ADD VALUE ordering, backfill, constraint names, deletePatient order) | **yes** (apply both files twice; schema DB tests; FK guard) |
| 3 Collector role + constants | standard (wide but mechanical; tsc finds every Record) | harness only (`npm test -- tests/api/rbac-route-gates.test.ts tests/api/users.test.ts`) |
| 4 Lab setup | standard | **yes** |
| 5 Notify service | standard | **yes** |
| 6 Lifecycle queries | most capable (locks, LIS path, verifier separation, visit side effect) | **yes** |
| 7 Requisitions + pricing | standard | **yes** |
| 8 Lifecycle routes + webhook + FHIR | standard | **yes** (existing lab DB route tests) |
| 9 Worklist UI + labels | standard | roster/scoping tests only |
| 10 Booking queries | most capable (capacity lock, IST windows, snapshot) | **yes** |
| 11 Booking routes + board UI | standard | harness only |
| 12 Collector route + collect | most capable (sample matching, partial collection, encounter insert) | **yes** |
| 13 Report data + PDF | cheap | no |
| 14 Report release + follow-up | most capable (blob-before-DB stale guard, SP3 integration) | **yes** |
| 15 Portal reports | cheap | no |

Order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9, then 10 → 11 → 12, then 13 → 14 → 15. Task 13 depends only on Task 1 and may run in parallel with 10–12. Tasks 9 and 10 touch disjoint files and may also run in parallel. Serialise every edit to `rbac-route-gates.test.ts`, `page-gates-harness.ts` and `LeftNav.tsx`.

**Rulings made in this plan:**

1. **Collector role: a new `collector` role, not `labs`.** The spec names a "collector role/page". It is also least privilege:
   - A home collector is field staff, often on a personal phone, sometimes a contractor.
   - `labs` reads every patient's results and imaging across the hospital. A collector needs only today's assigned stops: name, UHID, phone, address and tube list.
   - With a separate role, every existing allowlist denies collectors by default. Adding it to `ALL_ROLES` makes both RBAC harnesses re-prove that denial on every route and page.
   - The cost is mechanical: one enum value, the `Role` union, the capability record, a login door, the staff panel and a seed user.
   - Admin can act as a collector, for cover.
2. **PDF: `pdf-lib` 1.17.1.**
   - It is pure JavaScript (deps `pako`, `tslib`, its standard-font metrics). It has no native build, no headless browser, and no filesystem or network access at runtime. It runs in a Vercel function.
   - It gives correct xref/page handling, text-width measurement for wrapping, page breaks and metadata.
   - Rejected alternatives: a hand-rolled writer (more code to get xref offsets and wrapping right), `pdfkit` (reads AFM files from disk; bundling friction), Puppeteer/Chromium (heavy; a network-capable browser).
   - Limit: standard fonts are WinAnsi only. Non-Latin characters print as `?` via `toPdfSafeText`. Embedding a Devanagari font is a later improvement, flagged below.
3. **Local patient:**
   - A patient is local when the **collection address PIN** is in the active `lab_service_area_pins` list (admin screen, Settings → Lab setup).
   - The order-time notice and the "home collection available" badge use the registered SP1 `pin_code`.
   - Booking is decided by the PIN of the visit's address snapshot. That is where the collector must travel, and it lets staff book a patient staying at a local address.
   - Everyone else is walk-in only: the booking API refuses `not_in_service_area`, and no "do your tests" notice is sent.
4. **What "received" means.** The sample has physically arrived at the lab bench and been accessioned by scanning its sample ID.
   - For home collection, `collected → received` spans transport.
   - For walk-in, the two steps can follow each other at the counter.
   - An LIS result for a `collected` order implies receipt and stamps it, as `System (LIS API)`.
   - Results can be entered only on received samples.
5. **Enum `ADD VALUE` safety.**
   - The new `lab_order_status` values and `role 'collector'` are added in their **own** migration file, inside `BEGIN … COMMIT`. This is valid on PG 12+ (the local container is PG 15, Neon is newer).
   - Each value is placed `BEFORE`/`AFTER` a value that existed before the migration. The resulting order equals the drizzle enum array, so a fresh `db:push` and a migrated DB agree. The DB test pins this order.
   - Postgres forbids **using** a value in the transaction that added it. So everything that references a new value (the `lab_orders_scheduled_has_visit` check) is in the second file, which runs after the first has committed.
   - Existing rows keep their literal status and meaning. Legacy `resulted` rows now show as "Awaiting verification", which is correct: they were never verified.
   - Nothing is renamed or dropped. Other branches inserting `ordered`/`collected`/`resulted`/`cancelled` keep working.
6. **Blob access.**
   - Reports are put with `access: 'private'` under `lab-reports/<requisition>/<reportNumber>-<uuid>.pdf`. The blob URL is stored server-side only.
   - Bytes reach a browser only through `GET /api/lab-reports/[id]/download` (staff, `LAB_REPORT_READ_ROLES`) or `GET /api/patient-portal/lab-reports/[id]/download` (owner only, latest version only). Both stream with `Cache-Control: private, no-store` and audit after the blob is found.
   - Reports are **not** rows in `documents`: `DOCUMENT_READ_ROLES` includes frontdesk, who by product direction must not see lab results.
7. **Requisition as the grouping unit.**
   - One notice, one report and one follow-up per doctor's order of several tests, instead of one per test.
   - Legacy orders each get a one-test requisition from an idempotent backfill. `lab_orders.requisition_id` stays nullable at DB level, so other branches' raw inserts keep working; app code always sets it.
8. **Sample IDs.**
   - Format: `L` + IST `yymmdd` + a daily sequence (≥4 digits) + a Verhoeff check digit (SP1's implementation). It is displayed as `L261008-0042-9` and stored canonical.
   - Allocation uses an advisory lock per IST date with `max + 1` and a unique `(sample_date, sample_seq)`.
   - One ID per order (one tube per test). Sharing a tube across tests is out of scope.
   - IDs are allocated at booking, so labels can be printed before the trip, or at walk-in collection. They are never reused.
   - The label is a QR code (existing `qrcode` dependency) plus the human-readable ID. There is no 1-D barcode dependency.
9. **Result/verify split.**
   - labs (and admin) enter and amend results. pi (and admin) verify.
   - The person who entered a result cannot verify it (by `userId`; the env admin has none and is exempt).
   - LIS results land as `resulted` (FHIR `preliminary`) and need in-house verification, whatever the incoming Observation status.
   - Corrections after verification are out of scope (409).
10. **Follow-up trigger.**
    - The trigger runs only when the doctor ticked "ask for a follow-up", and only once every non-cancelled test of the requisition is reported.
    - It **links** to an open (`planned`/`scheduled`, window not passed) follow-up from the same prescriber if one exists. Otherwise it **creates** one with source `lab_report`, `originating_lab_order_id` = the last reported order, and the due date = report date (IST) + the requested interval.
    - SP3's `createFollowUpOrder` gains the `lab_report` source and the optional `originatingLabOrderId`; its other behaviour is unchanged.
    - A follow-up failure is recorded and audited but never blocks the report.
11. **Pricing.**
    - Each order line stores `quoted_price_paise`, `quoted_tariff_rate_id`, `quoted_on` and `quote_status`, via SP2 `resolvePrice`, using the ordering doctor's department and the patient's primary payer, on the IST order date.
    - The mapping is the new `lab_tests.service_id`, set in Lab setup.
    - An unmapped or unpriced test is still ordered (`quote_status` says why). There is no invoice or charge row (SP4).
12. **Notifications.**
    - The new `src/lib/notify` has a log-only channel by default (spec §3 "No fake data").
    - Every attempt writes one `notification_deliveries` row: dedupe key unique, masked destination, no message text.
    - Opt-out is `patients.notification_opt_out`, set by `NOTIFICATION_PREFERENCE_ROLES`.
    - SP3's follow-up notices keep their own log-only notifier. Swapping `getFollowUpNotifier()` onto `src/lib/notify` is a small later change.
13. **Lab encounter.** Each completed home-collection visit writes one SP3 `encounters` row of type `lab` (`completed`, no OPD token), so the visit appears in the patient's "Visits" list. Walk-in collections do not create encounters.

**Ambiguities flagged for the owner:**
- **Non-local patients get no "do your tests" notice.** The owner's sentence scopes the notice to local patients. A "please visit the lab" notice for others is a one-template addition.
- **Patient self-service.** Patients cannot book home collection or change their notification opt-out from the portal yet. Staff do both.
- **Report fonts.** Patient names in Indian scripts print as `?` on the PDF until a Unicode font is embedded (a deliberate dependency-light trade-off). The portal and the chart show names correctly.
- **One tube per test.** Real labs often draw several tests from one tube. Tube sharing would change the sample-ID model, so confirm whether it is needed.
- **Who may release reports.** Labs, pi and admin may release once results are verified. If the hospital requires the pathologist (pi) to release, drop `labs` from `LAB_REPORT_RELEASE_ROLES`.
- **Frontdesk on the booking board.** Frontdesk books home collections (logistics: address, slot, phone) but still never sees results. This narrows the earlier "no lab access for frontdesk" product direction; confirm.
- **Pre-existing hazard left as-is:** the imaging attach route uploads to blob before its DB write and ignores a lost collect race, unchanged from today.
