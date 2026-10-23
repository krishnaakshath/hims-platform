# Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the blockers that stop HIMS working as a real hospital system: a trial-module flag, real ICD-10 codes, working file storage and notifications, a price-mapping gate for tests, one payment path, and a demo-able Docker stack.

**Architecture:** Small focused modules behind existing seams: a pure `features` module, a blob-store driver interface, a channel registry behind the existing `Notifier`, a payment-provider interface that writes the existing cash-desk ledger. Schema changes are re-runnable SQL migrations plus `schema.ts`. Every new route follows the repo pattern: `requireSession`, inline role allowlist, strict Zod body, audit entry, rows in both RBAC harnesses.

**Tech Stack:** Next.js 16 (App Router; read `node_modules/next/dist/docs/` before touching routing or caching), TypeScript, Drizzle + Postgres, Upstash-style Redis, Vitest, Zod 4, nodemailer, Twilio (existing), `qrcode` (existing dependency).

**Spec:** `docs/superpowers/specs/2026-10-23-hospital-completion-design.md` (section 4). Findings: `docs/superpowers/plans/2026-10-23-gap-closure-plan.md`.

## Global Constraints

- Tests run **only** against the isolated database: `source $SCRATCH/testenv.sh` (DB `hims_test`). Never `.env.local`, never the demo DB `hims`, never a cloud DB. `tests/db/seed.test.ts` truncates its database.
- Never commit code-set content, `.env*` values, secrets, `data/`, or generated files. Add `data/` to `.gitignore`.
- Never log or return a secret, a provider error body, a file path, or a blob URL. Log error class names only.
- Money is integer paise; time is IST; ids shown to users are UHID, never chart ids.
- Schema changes: edit `src/db/schema.ts` and add a re-runnable, `BEGIN; … COMMIT;` migration `scripts/migrations/2026-10-23-<topic>.sql`. Never edit an applied migration. Never `db:push`.
- Existing behaviour stays intact when `ENABLE_TRIALS=true`. Vitest sets it to `true` once in `vitest.config.ts` so the current suite is unchanged.
- Each task ends with its tests passing, `npx tsc --noEmit` clean for the files touched, and one commit on branch `feat/hospital-completion`.

## Review Focus

- `ENABLE_TRIALS` unset in a deployment (the Docker env): a bookmarked trial URL redirects or 404s cleanly, never a 500; nav shows no dead links.
- Local blob driver given a path containing `../` or an absolute path: refused, never written outside `BLOB_LOCAL_DIR`.
- A patient who opted out of SMS/WhatsApp/email never receives that channel even when its credentials exist; a failed send is recorded, never reported as delivered.
- Recording a UPI payment with a UTR already used: rejected, no second ledger row (double-click and retry safe).
- Unmapping or deactivating a lab test's tariff service while orders for it are open: refused with the reason.

---

### Task 1: Feature flag module

**Files:**
- Create: `src/lib/features.ts`
- Test: `tests/lib/features.test.ts`
- Modify: `vitest.config.ts` (set `test.env.ENABLE_TRIALS = 'true'`), `.env.example` (document `ENABLE_TRIALS`)

**Interfaces:**
- Produces: `trialsEnabled(env?: Record<string, string|undefined>): boolean`; `TRIALS_PATHS: readonly string[]` (the dashboard paths hidden when off: `/workbook`, `/trials`, `/pipeline-dashboard`; Form Templates, Client Forms and the form-submission API stay available because they carry the hospital's own consents and intake forms); `isTrialsPath(pathname: string): boolean`.

- [ ] **Step 1: Write failing tests** `trialsEnabled` returns true for `'true'`, `'1'`, `' TRUE '`; false for unset, `''`, `'false'`, `'yes'`, `'0'`; `isTrialsPath('/trials/3')` is true, `isTrialsPath('/trials-x')` is false, `isTrialsPath('/patients')` is false.
- [ ] **Step 2: Run** `npx vitest run tests/lib/features.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** the three exports in `src/lib/features.ts`, pure over an env object, read per call.
- [ ] **Step 4: Run** the test → PASS; run `npx vitest run tests/lib` quickly for regressions.
- [ ] **Step 5: Commit** `feat(flags): ENABLE_TRIALS feature flag module`.

### Task 2: Hide the trial module when the flag is off

**Files:**
- Modify: `src/components/LeftNav.tsx` (drop the three entries when off), the three page files under `src/app/(dashboard)/` (`workbook`, `trials`, `pipeline-dashboard`: redirect to the role home when off), their API routes (`src/app/api/workbook`, `src/app/api/trials`, the pipeline/reports route; answer `404 {"error":"Not found"}` when off). Do NOT gate `form-submissions`, `form-templates` or `client-forms`, `tests/pages/page-gates-harness.ts`, `tests/api/rbac-route-gates.test.ts`, `tests/pages/nav-role-enforcement.test.tsx`
- Test: `tests/lib/trials-flag-gates.test.ts`

**Interfaces:**
- Consumes: `trialsEnabled`, `isTrialsPath` (Task 1).
- Produces: nothing new; behaviour only.

- [ ] **Step 1: Write failing tests**: with `ENABLE_TRIALS` unset, `LeftNav` for admin renders none of Workbook / Trials & Protocols / Pipeline Dashboard, and still renders Form Templates, Consent Documents and Client Forms; each of the three trial pages redirects before any query; each trial API route answers 404; with `true` all current behaviour holds.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the gating. Pages check the flag as their first statement after the session gate; routes check it right after `requireSession()`.
- [ ] **Step 4: Update** both RBAC harnesses so a flag-off run expects the redirect/404 and a flag-on run keeps today's expectations; run `npx vitest run tests/pages tests/api/rbac-route-gates.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(flags): hide trial nav, pages and routes unless ENABLE_TRIALS`.

### Task 3: Hospital-first lists and wording when trials are off

**Files:**
- Modify: patients list page and client (`src/app/(dashboard)/patients/*`, patients table components): when off, columns are UHID, name, age/sex, phone, last visit, doctor, payer; no trial filter or screening status; patient header (`src/app/(dashboard)/patients/[anonId]/*`): no trial banner, no "Needs Verification"; patient portal copy and `src/app/(dashboard)/broadcasts` filters; search placeholders "anon #" / "Anonymous #" become "UHID or chart ID" everywhere; `src/lib/queries/patients.ts` gains `lastVisitAt` and `primaryPayerName` for the new columns.
- Test: `tests/pages/patients-hospital-view.test.tsx`

**Interfaces:**
- Consumes: `trialsEnabled`.
- Produces: `PatientListRow` gains `lastVisitAt: string | null` and `primaryPayerName: string | null`.

- [ ] **Step 1: Write failing tests**: flag off → rendered list has the hospital column headers and no "Meets"/"Needs Verification"; header has no trial banner; no string `anon #` remains in `src/` (grep test); flag on → current columns unchanged.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS. 
- [ ] **Step 5: Commit** `feat(ui): hospital patient list and header when trials are off`.

### Task 4: Demo-able stack: mock gating, payload key, Docker template, banner

**Files:**
- Modify: `src/lib/integrations/runtime.ts` (`mocksEnabled` accepts `ABDM_USE_MOCKS` `'1'` or `'true'`; allowed when not production, or when production AND `DEMO_FEATURES` is explicitly on AND `ALLOW_DEMO_MOCKS=true`), `src/lib/abdm/route-helpers.ts` (missing payload key answers a distinct `abdm_payload_key_missing` 503 with its own message), `src/lib/abdm/constants.ts`, settings integrations page (a "Demo mode: mock integrations are active" banner whenever `mocksEnabled()`), create `.env.docker.example` (do not edit `docker-compose.yml`: Task 5 owns the blob volume)
- Test: `tests/lib/integrations/runtime.test.ts` (extend), `tests/api/abdm-payload-key.test.ts`

**Interfaces:**
- Produces: `mocksEnabled(env?)` signature unchanged; new error code `payload_key_missing` in the ABDM error map.

- [ ] **Step 1: Write failing tests**: `mocksEnabled` true for `ABDM_USE_MOCKS='true'` in development; false in production without `ALLOW_DEMO_MOCKS`; true in production only with `DEMO_FEATURES=true` and `ALLOW_DEMO_MOCKS=true`; consent POST with `INTEGRATION_PAYLOAD_KEY` unset answers 503 with the payload-key message, not "ABDM is not configured".
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(demo): mock gating, clear payload-key error, Docker env template`.

### Task 5: File storage driver with local-disk fallback

**Files:**
- Modify: `src/lib/blob-store.ts` (driver interface; `getBlobDriver()`), `src/lib/service-config.ts` (`requireBlobStore` consults the driver), `.gitignore` (`data/`), `docker-compose.yml` (`hims_blobs` volume mounted at `/app/data/blobs`)
- Create: `src/lib/blob-local.ts` (local driver)
- Test: `tests/lib/blob-local.test.ts`, extend `tests/lib/blob-store.test.ts`

**Interfaces:**
- Produces: `interface BlobDriver { put(path: string, body: Uint8Array, contentType: string): Promise<{ url: string }>; get(url: string): Promise<{ bytes: Uint8Array; contentType: string } | null> }`; `getBlobDriver(env?): BlobDriver | null` (Vercel when a token exists; local when `BLOB_DRIVER=local` or when no token and not production; otherwise null). Existing `putPrivateBlob`, `streamPrivateBlob`, `getPrivateBlobBytes` keep their signatures.

- [ ] **Step 1: Write failing tests**: local driver round-trips bytes and content type; a path with `..` segments, a leading `/`, or a NUL is rejected; the returned url is opaque (`local:` + safe key) and never a filesystem path; `get` of an unknown url returns null; with no driver `putPrivateBlob` throws `ServiceNotConfiguredError('blob')`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `BLOB_LOCAL_DIR` (default `./data/blobs`), create directories as needed, derive file names by hashing the key. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(storage): local-disk blob driver and specific not-configured handling`.

### Task 6: Staff-facing message when storage is missing

**Files:**
- Modify: lab report release route and UI (`src/app/api/lab-reports/*`, the labs page client), RCM document upload routes; shared helper `src/lib/http/service-message.ts`
- Test: `tests/api/lab-reports-release-storage.test.ts`

**Interfaces:**
- Produces: `serviceUnavailableBody(service: Service): { error: string; code: 'storage_not_configured' | 'service_unavailable' }`; UI shows "File storage is not set up. Ask your administrator." for `storage_not_configured`.

- [ ] **Step 1: Write failing tests**: releasing a report with no driver answers 503 with `code: 'storage_not_configured'`; with the local driver the release succeeds and the PDF streams back through the authenticated route.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `fix(labs): report release works with local storage and explains missing storage`.

### Task 7: WHO ICD-10 fetch, import and attribution

**Files:**
- Create: `scripts/code-systems/fetch-who-icd10.ts`, `scripts/code-systems/convert-who-icd10.ts` (pure converter), `tests/scripts/convert-who-icd10.test.ts`
- Modify: `package.json` (`codes:fetch-who`), `.gitignore` (`data/`), `src/lib/queries/code-systems.ts` (pickers exclude `SAMPLE-` versions once a licensed current version exists), coding/pre-auth/discharge pickers (attribution line "WHO ICD-10 (2019)")
- Test: `tests/lib/queries/code-systems-picker.test.ts`

**Interfaces:**
- Produces: `convertWhoIcd10(source: string): { csv: string; codeCount: number }` producing the importer's exact header `code,display,parent_code,selectable,active,effective_from,effective_to,sex,age_min_years,age_max_years,excludes`.

- [ ] **Step 1: Write failing tests**: the converter turns a small WHO-format fixture (chapters, blocks, categories, subcategories) into valid importer CSV (passes `validateCodeImport`); display never starts with `= + - @`; a SAMPLE version is not offered by the picker once a licensed current version exists, and is still offered when none exists.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** the converter and picker rule; the fetch script downloads the official WHO ICD-10 2019 release (resolve the current official file URL from the WHO site; the owner has authorised this download), writes it under `data/code-systems/`, refuses when `NODE_ENV=production`, prints SHA-256 of what it fetched. **Step 4: Run** → PASS.
- [ ] **Step 5: Run the fetch and import locally** against the Docker demo database only after Task 7's tests pass: `npm run codes:fetch-who` then `npm run codes:import -- --file data/code-systems/who-icd10-2019.csv --kind icd10 --version WHO-2019 --licence-note "WHO ICD-10 (2019), downloaded <date>"` with `DATABASE_URL` pointing at the Docker `hims` database (not the test database); confirm `/coding` search for "fever" returns codes.
- [ ] **Step 6: Commit** `feat(coding): WHO ICD-10 fetch, converter, picker rule and attribution`.

### Task 8: Notification log, channel registry and opt-out

**Files:**
- Create: `scripts/migrations/2026-10-23-notification-log.sql`, `src/lib/notify/registry.ts`, `src/lib/notify/channels/{sms,email,whatsapp,in-app}.ts`, `src/lib/notify/send.ts`, `src/lib/queries/notification-log.ts`
- Modify: `src/db/schema.ts` (`notification_log`, `notification_template_config`, patient channel preference columns), `src/lib/notify/notifier.ts` (`getNotifier()` returns the registry), `src/lib/notify/templates.ts` (add `form_sent`, `video_visit_link`, `booking_confirmed`, `appointment_reminder`), settings screen for template channels
- Test: `tests/lib/notify/send.test.ts`, `tests/lib/notify/channels.test.ts`, `tests/lib/queries/notification-log.test.ts`

**Interfaces:**
- Produces: `sendNotification(input: { patientId: string; templateKey: NotificationTemplateKey; vars: unknown; destination: { phone?: string; email?: string } }): Promise<{ attempts: { channel: Channel; status: 'sent'|'failed'|'skipped'|'log_only'; providerMessageId?: string }[] }>` where `Channel = 'sms' | 'email' | 'whatsapp' | 'in_app' | 'log'`; each channel adapter implements `{ name: Channel; configured(): boolean; send(msg): Promise<{ ok: boolean; providerMessageId?: string; errorClass?: string }> }`.
- `notification_log` columns: `id, patient_id, template_key, channel, destination_masked, status, provider_message_id, error_class, created_at`; never a message body.

- [ ] **Step 1: Write failing tests**: routing sends to every channel enabled for the template and configured; an unconfigured channel records `log_only` (never `sent`); an opted-out channel records `skipped` and the adapter is not called; an adapter failure records `failed` with only the error class; the PHI rule holds (rendered text has no patient name, test names or results); SMS adapter attaches the DLT template id and sender id; WhatsApp adapter sends a template (not free text).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** with adapters reading credentials from env (`TWILIO_*` plus `SMS_DLT_SENDER_ID`, `SMS_DLT_TEMPLATE_IDS` JSON; `SMTP_*`; `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_TEMPLATE_NAMES` JSON) and `fetch` for WhatsApp. **Step 4: Run** → PASS.
- [ ] **Step 5: Run** `npm run db:migrate` on the test DB and `db:schema-diff` against a from-empty DB to confirm both routes agree.
- [ ] **Step 6: Commit** `feat(notify): notification log, channel registry, opt-out, SMS/email/WhatsApp adapters`.

### Task 9: Use the notification service where staff copy links today

**Files:**
- Modify: Send Form to Client route and dialog (`src/app/api/form-submissions/*`, `SendFormDialog`), telemedicine start route (`src/app/api/appointments/[id]/telemedicine/route.ts`) and `StartTelemedicineButton.tsx`, booking-request confirm route, home-collection and lab-order notices (already call `getNotifier`; switch to `sendNotification`), patient chart "Recent notices" panel
- Test: `tests/api/form-send-notify.test.ts`, `tests/api/telemedicine-notify.test.ts`

**Interfaces:**
- Consumes: `sendNotification` (Task 8).
- Produces: `GET /api/patients/[anonId]/notices` → `{ items: { templateKey; channel; status; createdAt }[] }` (admin, crc, pi, frontdesk).

- [ ] **Step 1: Write failing tests**: sending a form records a `form_sent` attempt and still returns the link; starting a video visit records `video_visit_link`; confirming a booking records `booking_confirmed`; the notices route is role-gated.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**, keeping the visible copy-link as a fallback. **Step 4: Run** → PASS. Add the new route to both RBAC harnesses.
- [ ] **Step 5: Commit** `feat(notify): send forms, video links and booking notices through the notification service`.

### Task 10: Lab test price-mapping gate

**Files:**
- Modify: `src/lib/queries/lab-tests.ts` (or the existing module that lists tests), order route `src/app/api/lab-orders/route.ts`, `OrderLabTestModal.tsx`, Settings → Lab setup client, seed (`src/db/seed-india.ts`: map every seeded test), `src/lib/queries/providers.ts` (fee from tariff)
- Test: `tests/api/lab-order-price-gate.test.ts`, `tests/lib/queries/provider-fee.test.ts`

**Interfaces:**
- Produces: order route answers `422 {"error":"This test has no price. Map it to a tariff service first.","code":"test_unmapped"}` for an unmapped test; `unmappedTests(): Promise<{ id: number; code: string; name: string }[]>`; `consultationFeePaise(providerId: number): Promise<number | null>` reads the department's consultation service rate.

- [ ] **Step 1: Write failing tests**: ordering an unmapped test is 422 and writes nothing; ordering a mapped test succeeds and the order shows its price; activating an unmapped test is refused; unmapping a service that has open orders is refused with the reason; provider fee equals the tariff's current consultation rate and follows a revised rate.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; the modal greys unmapped tests with "No price: ask billing". Settings lists unmapped tests first with a "Map" select. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(lab): require a price mapping before a test can be ordered; doctor fees from tariff`.

### Task 11: Payment providers and one payment path

**Files:**
- Create: `scripts/migrations/2026-10-23-payment-requests.sql`, `src/lib/payments/provider.ts`, `src/lib/payments/manual-upi.ts`, `src/lib/payments/gateway.ts`, `src/app/api/billing/payments/upi-request/route.ts`
- Modify: `src/db/schema.ts` (`payment_requests`: id, patient_id, amount_paise, vpa, reference, status, utr unique-when-set), Cash Desk page and client, `src/app/api/billing/payments/route.ts`, Patient Collections page ("Collect Payment" → `/cash-desk?patientId=…&amountPaise=…`), remove `VirtualCardPaymentForm.tsx`, `src/app/(dashboard)/billing/pay`, and the mock-payments routes, billing nav, invoice list (paid / outstanding columns), invoice page (Collect payment button; print/email/WhatsApp share through Task 8), legacy `insurance-collections` and `statements` pages (redirect to RCM claims and the ledger)
- Test: `tests/lib/payments/manual-upi.test.ts`, `tests/api/payments-upi.test.ts`, `tests/pages/cash-desk-modes.test.tsx`

**Interfaces:**
- Produces: `interface PaymentProvider { name: string; createRequest(i: { patientId: string; amountPaise: number; note: string }): Promise<{ requestId: number; qrPayload?: string; link?: string }>; recordConfirmation(i: { requestId: number; utr: string }): Promise<{ receiptNo: string }> }`; `upiUri(vpa: string, payeeName: string, amountPaise: number, note: string): string` (a standards-compliant `upi://pay?pa=…&pn=…&am=…&cu=INR&tn=…`); env `HOSPITAL_UPI_VPA`, `HOSPITAL_UPI_PAYEE`.

- [ ] **Step 1: Write failing tests**: `upiUri` encodes amount as rupees with two decimals and escapes the note; creating a request without `HOSPITAL_UPI_VPA` answers a clear "UPI is not set up" 503; confirming with a UTR posts exactly one ledger row and one receipt; the same UTR a second time is rejected 409 with no extra row; every payment mode lands in the same ledger; "Collect Payment" links to the Cash Desk; the invoice list shows paid and outstanding.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; render the QR with the existing `qrcode` dependency on the server. **Step 4: Run** → PASS; add routes to both RBAC harnesses (billing, admin, crc where payments are already allowed).
- [ ] **Step 5: Commit** `feat(billing): UPI QR payments, one ledger path, invoice paid/outstanding, legacy pages retired`.

### Task 12: Foundations verification walkthrough

**Files:**
- Modify: `docs/superpowers/plans/2026-10-23-gap-closure-plan.md` (tick what is done), `README.md` (new env vars, flag, local storage, WHO attribution), `.env.example`
- Test: full suite + build

- [ ] **Step 1: Run** `source $SCRATCH/testenv.sh && npx vitest run` → all green (known skips documented). Run `npx tsc --noEmit` and `npm run lint` on touched files → clean.
- [ ] **Step 2: Build** the Docker image from this worktree and run it on a different port with a copy of `.env.docker` plus the new variables; walk each foundation in the browser: trial nav hidden; ICD-10 search returns codes; lab report releases and downloads; a form send logs a notice; unmapped test is blocked; UPI QR payment posts a receipt; ABHA flow works in demo mode with the banner.
- [ ] **Step 3: Commit** `docs: foundations verified; env and README updates`.
