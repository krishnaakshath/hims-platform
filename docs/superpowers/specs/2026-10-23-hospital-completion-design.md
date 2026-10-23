# Hospital completion: design

**Date:** 2026-10-23 · **Status:** approved by the owner's standing instruction ("do not ask me anything, keep going") · **Source of requirements:** `docs/superpowers/plans/2026-10-23-gap-closure-plan.md` (findings A–L, workstreams WS1–WS12)

## 1. Intent

Make HIMS work as a complete Indian hospital system, end to end: register → consult → order → bill → collect → insure → discharge, with the UI changes from the gap analysis. Every sub-project ships with tests and a verified walkthrough in the running app. Anything that needs a real credential, licence or external account is built to work today with a mock or local fallback and switches to the real service by configuration only.

## 2. Owner decisions (recorded)

| Topic | Decision |
|---|---|
| Trial-screening module | Hidden behind `ENABLE_TRIALS`; **off by default**, so hospital deployments show only hospital features. The research client sets it to `true`. |
| ICD-10 source | WHO ICD-10 (2019) is downloaded into a git-ignored folder and loaded with the existing importer. Nothing from the code set is committed. WHO attribution is shown wherever codes are searched. |
| Notification channels | SMS with DLT template ids, email (SMTP), WhatsApp Business (Meta Cloud API) and in-app/portal. Each runs in log-only mode until its credentials exist. |
| Payments | UPI QR plus a payment-provider interface. The cashier shows a QR for the hospital VPA and records the UTR; all modes post to the one cash-desk ledger. A gateway adapter (Razorpay-style links) sits behind the interface and stays off without keys. |

## 3. Decomposition (each is its own spec → plan → build → review)

1. **Foundations (this document, section 4).**
2. **Insurance verification** (WS12): persisted eligibility, manual verification, ABHA mismatch guard, pre-auth fixes.
3. **Doctor workspace and automatic billing** (WS1, WS2).
4. **Inpatient and lab** (WS3, WS4).
5. **Pharmacy, front desk, forms, governance, polish** (WS5–WS9), including the UI changes.

Order follows dependencies: foundations first because later work cannot be verified without real codes, working storage, notifications and priced services.

## 4. Sub-project 1: foundations

### 4.1 Feature flags (`src/lib/features.ts`)
One small module reads `ENABLE_TRIALS` (`true`/`1` enables; anything else disables). `trialsEnabled()` is the only way code asks. When off:
- the nav hides Workbook, Trials & Protocols and Pipeline Dashboard (Form Templates, Consent Documents and Client Forms stay: they carry the hospital's own consents and intake forms);
- those three pages redirect to the role's home and their API routes answer `404`; the form-submission API is never gated;
- the patients list drops the screening column and trial filter; the patient header drops trial status and "Needs Verification";
- the patient portal and broadcasts drop trial wording and trial filters.
Existing tests run with the flag on (set once in `vitest.config.ts`); new tests cover the flag off. The RBAC harnesses learn about the flag so a hidden page is expected to redirect.

### 4.2 Real code sets
- A fetch script (`scripts/code-systems/fetch-who-icd10.ts`) downloads the WHO ICD-10 (2019) files into `data/code-systems/` (git-ignored), converts them to the importer's CSV shape, and prints the file hashes. It refuses to run in production.
- `npm run codes:import` then loads them with a licence note naming the WHO terms and the download date.
- Pickers (coding, pre-auth, discharge) show a small "WHO ICD-10 2019" attribution and never offer SAMPLE codes once a licensed version exists.
- The free-text `diagnoses.code` the doctor chart uses gets a code picker backed by the same table (used by the workspace in sub-project 3).

### 4.3 File storage that works without Vercel
`src/lib/blob-store.ts` gains a driver interface with two implementations: Vercel Blob (current behaviour) and a **local-disk store** under `BLOB_LOCAL_DIR` (default `./data/blobs`, git-ignored) selected when `BLOB_DRIVER=local` or when no Blob token is configured outside production. Same private-access rules: bytes stream only through authenticated, audited routes, and a stored URL is never returned to a client. When no driver is usable the route answers a **specific** operator message and the staff UI says "File storage is not set up" with who to ask, instead of "Something went wrong". Docker compose gets a volume for the local store.

### 4.4 Notification service
`src/lib/notify` becomes a channel registry (`sms`, `email`, `whatsapp`, `in_app`, `log`) behind the existing `Notifier` interface.
- A `notification_log` table records every attempt: template key, channel, masked destination, patient, status (`queued`, `sent`, `failed`, `skipped`, `log_only`), provider message id, error class, timestamps. No message body with clinical content is stored.
- Per-template configuration chooses channels and holds the DLT template id and WhatsApp template name.
- Opt-out: a per-patient channel preference (existing notices toggle extended to SMS/WhatsApp/email) is checked before every send.
- Adapters: Twilio SMS (reuses the OTP credentials, adds DLT template and sender ids), SMTP via nodemailer, WhatsApp Cloud API (template messages). Each reads credentials from env, reports `not_configured` honestly, and falls back to `log_only` (never pretends to deliver).
- Forms, video-visit links, home-collection notices, booking confirmations and lab-report-ready notices call the service instead of showing a link to copy; the link remains visible as a fallback.
- The patient chart shows delivery status for the last notices.

### 4.5 Price mapping gate
- Every orderable lab or imaging test must map to a tariff service. The Lab setup screen shows unmapped tests first with a "Map" control; **ordering an unmapped test is blocked** with the reason, and activation of an unmapped test is refused.
- The Provider roster reads each doctor's consultation fee from the tariff service for their department (single source of truth); the stored fee column becomes a read-only display.
- The seed maps every seeded test.

### 4.6 One payment path
- `payment_mode` already includes `upi`. A new `payment_providers` interface (`createRequest`, `verify`, `refund`) has a `manual_upi_qr` implementation (QR for `HOSPITAL_UPI_VPA`, UTR required to record) and a `gateway` stub that is off without keys.
- Cash Desk gets the mode list with UPI QR, card (machine reference), cheque, NEFT, and cash; every mode writes the same ledger row and receipt.
- "Collect Payment" on Patient Collections opens the Cash Desk for that patient and amount instead of the demo card form; the demo form is removed.
- Invoice list gets paid/outstanding columns; the invoice page gets "Collect payment" and a share action (print, email, WhatsApp via 4.4).
- Legacy billing pages (Insurance Collections, old statements) redirect to RCM and the ledger.

### 4.7 Demo-able Docker stack
- `ABDM_USE_MOCKS` accepts `1` or `true`.
- Mocks run when `DEMO_FEATURES=true` even in a production build **only if** `ALLOW_DEMO_MOCKS=true` is also set, so a real production deployment can never enable them by accident; the settings screen shows a prominent "Demo mode" banner whenever any mock is active.
- `.env.docker.example` (committed) documents `INTEGRATION_PAYLOAD_KEY`, `ABDM_USE_MOCKS`, `ALLOW_DEMO_MOCKS`, `BLOB_DRIVER=local`, `ENABLE_TRIALS`. A missing payload key produces its own clear error, not "ABDM is not configured".

## 5. Error handling and safety
- Every external adapter returns a typed result; none throws raw provider text into logs or responses.
- No new secret is ever logged or returned. Local file paths never reach a client.
- All new routes use `requireSession`, an inline role allowlist, strict Zod bodies, audit entries, and get rows in both RBAC harnesses.
- Schema changes ship as re-runnable, checksummed SQL migrations in `scripts/migrations/` plus the `schema.ts` change; `db:push` is never used.

## 6. Testing
- Unit tests for each pure module (flags, price gate, notification routing and opt-out, payment provider, blob drivers).
- DB-backed route tests against the isolated test database (never the demo or cloud database).
- Component tests for the new UI states (unmapped-test warning, notification status, payment modes, demo banner).
- A scripted end-to-end walkthrough in the Docker stack after each sub-project.

## 7. Out of scope here
Anything in sub-projects 2–5; real provider credentials; ABDM/NHCX production onboarding; licensing of SNOMED CT, LOINC, ICD-10-PCS and HBP content (the importer supports them when the owner supplies files).
