# Forms, Portal, Communication, Governance and Polish Implementation Plan (WS7, WS8, WS9)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hospital forms in English, Hindi and Kannada with a capable builder; re-authenticated note signing; a portal that shows real visits, bills with Pay now and self-service uploads; real, filtered broadcasts; video visits that survive a reload; a usable audit log; archive instead of delete; a DPDP request register; and the remaining UI polish.

**Architecture:** One pure question model (`src/lib/forms/question-model.ts`) shared by the builder, the intake renderer and the routes. Re-authentication is one pure-plus-IO module (`src/lib/reauth.ts`). Portal payments reuse the foundations UPI request; a patient-reported UTR is only a hint for the cashier. Broadcasts go through `sendNotification`. Archive is three columns on `patients` and one shared filter. Every new route follows the repo pattern: `requireSession` (or `requirePatientSession`, or the intake token), inline role allowlist, strict Zod body, audit, rows in both RBAC harnesses.

**Tech Stack:** Next.js 16 App Router (read `node_modules/next/dist/docs/` before touching routing, caching, `searchParams`, route handlers or `cookies()`; AGENTS.md: breaking changes), TypeScript, Drizzle + Postgres, Vitest + Testing Library, Zod 4, existing `qrcode`. No new packages.

**Spec:** `docs/superpowers/specs/2026-10-23-operations-portal-governance-design.md` (decisions D9–D20, D22). Findings: `docs/superpowers/plans/2026-10-23-gap-closure-plan.md` A4, F1–F5, G5, H3, H4, I12–I14, J1–J8, K9, K11, UI items 3, 10, 11 (UI 7, the bed board, is WS3's).

## Ownership boundaries (read first)

- WS1/WS2 (`docs/superpowers/specs/2026-10-23-doctor-workspace-billing-design.md`) add `encounter_notes.encounter_id`, the `signable_type` value `encounter_note`, remove `J3490`, and own the lab-order and dispense dialogs' toasts. WS3 (`docs/superpowers/specs/2026-10-23-inpatient-lab-design.md`) owns `BedBoard.tsx` cards and actions and the discharge dialog. This plan does not edit those surfaces except the one "Wound VAC" placeholder (Task 11).

## Preconditions

- Foundations Tasks 8–9 (notification service, `feat/hc-s8`) merged before Tasks 10 and 9 (they call `sendNotification` / append template keys).
- Plan `2026-10-23-pharmacy-frontdesk.md` Task 1 (toast and `EmptyState`) merged before stream U; other streams may use the toast if it is present and must not create a second one.
- Plan A Task 6 adds `providers.portal_bookable`. Task 7 here ships its own migration with the identical guarded `DO $$ … $$` block (add the column and set it false for non-`clinical` departments only when the column is missing), so whichever migration runs second is a no-op; in `src/db/schema.ts` the column is declared once (Task 7 adds the line only if Plan A's is not already there when it rebases).
- WS1's `/encounters/[id]` workspace is optional: Task 6's end-of-call prompt links there when the route exists, otherwise to the patient's Visits tab.

## Streams (each in its own git worktree off `feat/hospital-completion`; merge in the order listed within a stream)

| Stream | Tasks | Notes |
|---|---|---|
| **F** (forms) | 1 → 2 → 3 → 4 | One model, then builder, renderer, content. |
| **N** (note signing) | 5 | Independent. |
| **P** (portal and video) | 6 → 7 → 8 → 9 | 7 reads `visit_mode` from 6. |
| **C** (communication and wording) | 10, 11 | Independent of each other. |
| **G** (governance) | 12 → 13 → 14 | 14 uses 13's archive. |
| **U** (UI polish) | 15 → 16 | Needs Plan A Task 1. Merge last: it touches several pages lightly. |

**Shared files and how to touch them without conflicts**
- `src/db/schema.ts`: append one block at the end, delimited `// WS7 T<n>` … `// end WS7 T<n>` (`WS8`, `WS9` likewise). New columns on existing tables go inside the table with a `// WS<n> T<k>` comment on each added line.
- Migrations: `scripts/migrations/2026-10-24-ws7-<topic>.sql`, `…-ws8-<topic>.sql`, `…-ws9-<topic>.sql`; `BEGIN; … COMMIT;`, re-runnable, checksummed by the runner; enum `ADD VALUE` lines live alone in a file that sorts before any file using the value.
- RBAC: append rows only at the end of `API_GATES` (`tests/api/rbac-route-gates.test.ts`) and `PAGE_GATES` (`tests/pages/page-gates-harness.ts`).
- `src/components/LeftNav.tsx`: add entries only at the end of the relevant group with a `// WS<n>` comment.
- `src/lib/notify/templates.ts`: append keys at the end of `NOTIFICATION_TEMPLATE_KEYS`, `TemplateVars`, `PARAM_KEYS`.
- `README.md`: Task 7 owns the MFA lines; Task 14 owns the DPDP paragraph; edit only those lines.

## Global Constraints

- Tests run **only** against the isolated database: `source $SCRATCH/testenv.sh` (DB `hims_test`). Never `.env.local`, never the demo DB `hims`, never a cloud DB.
- No committed secrets, `.env*` values, `data/` or generated files.
- Never log or return a secret, password, TOTP code, OTP, UTR, provider error body, file path or blob URL. Audit details carry ids, counts and enum values, never names, phones, answers or free text typed by patients.
- Money is integer paise; time is IST; ids shown to users are UHID, never chart ids.
- Schema: `src/db/schema.ts` plus a re-runnable, checksummed migration; `npm run db:migrate` on the test DB; `npm run db:schema-diff` must agree. Never `db:push`.
- Every new route: `requireSession()` / `requirePatientSession()` / intake-token check first, inline role allowlist, strict Zod (`.strict()`), `logAudit` / `logPatientPortalAction`, rows in both RBAC harnesses; patient-portal routes also get a row in `tests/api/sessionless-routes.test.ts` or the portal gate test as the existing portal routes do.
- `ENABLE_TRIALS=true` behaviour stays intact (Vitest sets it); trial-only filters and wording appear only when `trialsEnabled()`.
- Each task ends with its tests passing, `npx tsc --noEmit` and `npm run lint` clean on touched files, and one commit on the stream branch.

## Review Focus

- A conditional question hidden by another answer is never required and its stale answer is dropped on submit.
- An intake file upload cannot be reached with an expired or completed token, cannot exceed size/type limits, and is stored only through the blob driver.
- Note signing: wrong password five times is rate-limited; the password is never logged; a signed note cannot be re-signed.
- A patient-reported UTR never creates a receipt by itself.
- Archived patients appear in no list, search, picker, broadcast audience or portal sign-in, and every archive/restore has an audit row.
- Audit CSV: a cell beginning `=`, `+`, `-` or `@` is neutralised; the export is audited.

---

### Task 1: Question model v2 (types, sections, conditions, translations)

**Files:**
- Create: `src/lib/forms/question-model.ts`, `scripts/migrations/2026-10-24-ws7-form-languages.sql`
- Modify: `src/db/schema.ts` (`// WS7 T1`: `formTemplates.questions` jsonb type widened to `FormQuestion[]`; new `formTemplates.languages text[] NOT NULL DEFAULT '{en}'`; `consentDocuments.translations jsonb NOT NULL DEFAULT '{}'`), `src/app/api/form-templates/route.ts` and `src/app/api/form-templates/[id]/route.ts` (use `formQuestionSchema` / `formTemplateBodySchema`), `src/lib/form-answers.ts` (display values for new types)
- Test: `tests/lib/forms/question-model.test.ts`, extend `tests/api/form-templates.test.ts`

**Interfaces:**
- `type FormLang = 'en' | 'hi' | 'kn'`; `type QuestionType = 'text' | 'textarea' | 'date' | 'select' | 'checkbox' | 'number' | 'phone' | 'file' | 'signature' | 'section'`.
- `interface FormQuestion { id: string; label: string; type: QuestionType; options?: string[]; optionScores?: (number | null)[]; hipaaSensitive: boolean; required: boolean; autofillField?: 'name' | 'dob' | 'email' | 'phone' | null; compareToChart?: { type: 'medication_active'; medicationClass: string } | null; min?: number; max?: number; visibleIf?: { questionId: string; equals: string } | null; i18n?: Partial<Record<'hi' | 'kn', { label?: string; options?: string[] }>> }` (existing fields unchanged so stored templates parse).
- `formQuestionSchema` (Zod, strict; `section` has no `required`; `visibleIf.questionId` must refer to an earlier question; `i18n.*.options` length equals `options`).
- `visibleQuestions(qs: FormQuestion[], answers: Record<string, string>): FormQuestion[]`
- `validateAnswers(qs: FormQuestion[], answers: Record<string, string>): { ok: true; cleaned: Record<string, string> } | { ok: false; errors: Record<string, string> }` (drops answers of hidden questions and sections; number in `[min,max]`; phone via `normalizePhone` from `src/lib/india/phone`; file answer must be `doc:<id>`; signature answer is the typed name, non-empty).
- `localiseQuestion(q: FormQuestion, lang: FormLang): { label: string; options?: string[] }` (string-by-string fallback to English).

- [ ] **Step 1: Write failing tests**: an old template (5 types, no new fields) parses unchanged; `visibleIf` pointing at a later question → invalid; a hidden required question does not fail validation and its answer is removed from `cleaned`; `phone` "98450 12345" passes, "12345" fails; number 300 with max 250 fails; Kannada label missing falls back to English while the Kannada option list is used; API create with a `signature` question returns 201 and with an unknown type 400.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS (+ `tests/api/form-template*.test.ts`, `tests/lib/form-answers.test.ts`).
- [ ] **Step 5: Commit** `feat(forms): question model with number, phone, file, signature, sections, conditions and translations`.

### Task 2: Form builder: new types, sections, conditions, translations; no empty draft

**Files:**
- Create: `src/app/(dashboard)/forms/new/page.tsx`, `src/components/forms/QuestionConditionEditor.tsx`, `src/components/forms/TranslationsPanel.tsx`
- Modify: `src/components/FormBuilderEditor.tsx` (accept `templateId: number | null`; first edit POSTs and then `router.replace('/forms/<id>')`; later edits PUT as today; type menu lists all ten types; section rows render as headings; "Show only if…" editor; Translations tab per language with progress "Hindi 12/18 labels"), `src/components/CreateFormButton.tsx` (navigate to `/forms/new?folderId=…`, no POST), `tests/pages/page-gates-harness.ts` (row for `/forms/new`, `CLINICAL_ROLES`)
- Test: extend `tests/components/FormBuilderEditor.test.tsx`, create `tests/components/CreateFormButton.test.tsx`, `tests/components/forms/QuestionConditionEditor.test.tsx`

**Interfaces:**
- Consumes: `FormQuestion`, `formQuestionSchema` (Task 1).
- `FormBuilderEditor({ templateId: number | null; initial: { name; category; diagnosisTag; questions: FormQuestion[]; languages: FormLang[]; folderId: number | null } })`.

- [ ] **Step 1: Write failing tests**: clicking "Create New Form" performs no fetch and navigates to `/forms/new`; leaving `/forms/new` untouched creates no template (no POST recorded); typing a title sends exactly one POST and replaces the URL; adding a "Show only if Q2 = Yes" condition lists only earlier select/checkbox questions; Hindi translation inputs show the English text as placeholder; a section can be added and reordered.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(forms): builder with all question types, conditions, translations and no empty drafts`.

### Task 3: Intake renderer: language, conditions, file upload, signature; thank-you links and signed copy

**Files:**
- Create: `src/app/api/intake/[token]/files/route.ts`, `src/app/patient-portal/documents/forms/[submissionId]/page.tsx`, `src/components/intake/QuestionField.tsx`, `src/components/intake/LanguageSwitch.tsx`
- Modify: `src/components/IntakePortalForm.tsx` (render via `QuestionField`; hide invisible questions live; language switch `en | हिन्दी | ಕನ್ನಡ` limited to the template's `languages`; thank-you view adds "Back to your portal" and "View signed copy" when `portalLinked`), `src/app/intake/[token]/page.tsx` (computes `portalLinked` = a patient session exists for the submission's patient; never trusts a query parameter), `src/app/api/intake/[token]/route.ts` (PUT validates with `validateAnswers` and stores `cleaned`), `src/app/patient-portal/(authenticated)/forms/page.tsx` (completed forms link to the signed copy), `tests/api/rbac-route-gates.test.ts` (intake files route in the token-gated exemption list as the other intake routes are), `tests/pages/patient-portal-page-gates.test.tsx`
- Test: `tests/api/intake-files.test.ts`, extend `tests/components/IntakePortalForm.test.tsx`, `tests/api/intake-portal.test.ts`, create `tests/pages/patient-portal-form-copy.test.tsx`

**Interfaces:**
- `POST /api/intake/[token]/files` (token must be valid, unexpired, submission not completed; rate-limited by token) multipart `questionId`, `file` (PDF/JPEG/PNG ≤ 5 MB, magic-byte checked) → stores with `putPrivateBlob`, inserts a `documents` row (`patientId` from the submission, `receivedFrom: 'Patient form'`, `status: 'new'`) → `201 { answer: 'doc:<id>', fileName }`. Storage missing → 503 `serviceUnavailableBody('blob')`. Audit via `logPatientPortalAction('uploaded form file', patientId, 'submission=<id>')`.
- Signed copy page (patient session; the submission must belong to the session patient, else 404): printable answers in the language used, consent texts with `signatures` rows (typed name, time IST), UHID, no chart id. Audit `viewed signed form copy`.

- [ ] **Step 1: Write failing tests**: choosing "Yes" reveals the dependent question and choosing "No" hides it and drops its value on submit; switching to Hindi shows Hindi labels, English where untranslated; file upload with an expired token → 401/404 as the other intake routes answer; a 6 MB file → 413; a `.exe` renamed `.pdf` → 400; a valid file returns `doc:<id>` and no URL; thank-you shows both links only when a matching portal session exists; the copy page of another patient's submission → 404.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(intake): translated conditional forms with file and signature questions, portal back-link and signed copy`.

### Task 4: Hospital form pack (consents, admission, discharge, MLC, vaccination)

**Files:**
- Create: `src/db/seed-hospital-forms.ts`, `src/app/api/form-templates/hospital-pack/route.ts`
- Modify: `src/db/seed.ts` (call `seedHospitalForms` after existing form seeding; skip trial forms' creation when `!trialsEnabled()`), `src/app/(dashboard)/forms/page.tsx` (admin "Install hospital form pack" button when any pack form is missing), `tests/api/rbac-route-gates.test.ts`
- Test: `tests/db/seed-hospital-forms.test.ts`, `tests/api/form-templates-hospital-pack.test.ts`

**Interfaces:**
- `HOSPITAL_FORM_PACK: readonly { key: 'general_consent' | 'surgical_anaesthesia_consent' | 'admission_form' | 'discharge_consent' | 'mlc_intimation' | 'vaccination_record'; name: string; category: 'Consent Forms' | 'Admission' | 'Medico-legal' | 'Clinical records'; questions: FormQuestion[]; consents: { name: string; bodyText: string; translations: { hi?: string; kn?: string } }[] }[]` — every form `languages: ['en','hi','kn']`; Hindi/Kannada strings carry a leading `[DRAFT TRANSLATION]` marker in the consent body until reviewed; consent documents are inserted with `legal_review_status = 'draft'`.
- `seedHospitalForms(db): Promise<{ created: string[]; skipped: string[] }>` (idempotent by template name and consent name).
- `POST /api/form-templates/hospital-pack` (admin) body `{}` strict → `200 { created, skipped }`; audit `installed hospital form pack` with counts.

- [ ] **Step 1: Write failing tests**: running the seed twice creates six templates once; each consent template has its consent documents attached via `form_template_consents`; the surgical consent includes procedure, risks explained (checkbox), anaesthesia type (select), witness name, and a `signature` question; MLC intimation asks police station and intimation time and is marked `hipaaSensitive`; every question validates with `formQuestionSchema`; frontdesk POST → 403.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** the content in plain, legally neutral language (no US terms; "Notice of Privacy Practices" not used). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(forms): hospital form pack with consents, admission, discharge, MLC and vaccination in en/hi/kn`.

### Task 5: Clinical note signing with re-authentication

**Files:**
- Create: `src/lib/reauth.ts`, `scripts/migrations/2026-10-24-ws7-a-signable-note-enum.sql` (only `ALTER TYPE signable_type ADD VALUE IF NOT EXISTS 'encounter_note';` — a no-op when WS1 already added it), `src/components/notes/SignNoteDialog.tsx`
- Modify: `src/db/schema.ts` (`// WS7 T5`: add `'encounter_note'` at the end of `signableTypeEnum` only if WS1 has not), `src/lib/rate-limit.ts` (append `checkReauthRateLimit(identity: string)`: 5 per 15 min), `src/lib/queries/encounter-notes.ts` (`signNote` writes the `signatures` row in the same transaction), `src/app/api/patients/[anonId]/notes/[id]/sign/route.ts` (body now required), `src/components/NoteForm.tsx` (Sign opens the dialog)
- Test: `tests/lib/reauth.test.ts`, extend `tests/api/patient-notes.test.ts`, create `tests/components/notes/SignNoteDialog.test.tsx`

**Interfaces:**
- `reauthenticate(session: Session, proof: { password?: string; totpCode?: string }, deps?: { env?: NodeJS.ProcessEnv }): Promise<{ ok: true; method: 'password' | 'totp' } | { ok: false; error: 'invalid' | 'no_method' }>` — `userId` set: `users.password_hash` via `verifyPassword`, else TOTP via `verifyMfaCode` when `mfa_enabled`; `userId` null and role admin: `ADMIN_PASSWORD_HASH`; otherwise `no_method`.
- `PUT /api/patients/[anonId]/notes/[id]/sign` body `{ typedName: string(1..120); attested: true; password?: string(1..200); totpCode?: /^\d{6}$/ }` strict (exactly one of password/totpCode) → 200; refusals: typed name ≠ session name → 403 (no admin exception for notes); reauth invalid → 401 `{ code: 'reauth_failed' }`; rate limit → 429; already signed → 409.
- `SIGN_NOTE_ATTESTATION = 'I confirm I wrote or reviewed this note and that it is accurate.'` stored verbatim in `signatures.attestation_text`.

- [ ] **Step 1: Write failing tests**: correct password signs and writes one `signatures` row with `signable_type = 'encounter_note'`; wrong password → 401 and the note stays draft; a TOTP-only (Google) account signs with a valid code; env admin signs with `ADMIN_PASSWORD_HASH`; sixth wrong attempt in 15 minutes → 429; the password never appears in any `console` call (spy) or audit row; dialog disables Sign until name, tick and password are present.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS (+ `tests/api/route-hardening.test.ts`).
- [ ] **Step 5: Commit** `feat(notes): re-authenticated note signing with typed name and attestation`.

### Task 6: Visit mode and telemedicine continuity

**Files:**
- Create: `scripts/migrations/2026-10-24-ws7-visit-mode.sql`, `src/lib/telemedicine/call-duration.ts`
- Modify: `src/db/schema.ts` (`// WS7 T6`: `appointments.visitMode` text `CHECK IN ('in_person','video')` default `'in_person'`; `bookingRequests.requestedVisitMode` nullable same check), `src/app/api/appointments/route.ts` and `src/app/api/appointments/[id]/route.ts` (accept `visitMode`), `src/app/api/appointments/[id]/telemedicine/route.ts` (refuse in-person appointments: 409 `{ code: 'not_video' }`), `src/lib/queries/appointments.ts` (`AppointmentWithDetails` gains `visitMode`, `telemedicine: { sessionId: number; status: TelemedicineSessionStatus } | null`), `src/components/DashboardAppointmentsTable.tsx` (button only for video; "Rejoin (session active)" when a session is waiting/in progress; "Video" chip), `src/components/NewEventModal.tsx` (In person / Video toggle), `src/components/StartTelemedicineButton.tsx` (initial session prop), `src/components/TelemedicineCallScreen.tsx` (running `mm:ss` timer from `providerJoinedAt`; on end: "Call lasted 12 min" plus links Complete visit / Write note / Bill), `src/app/(dashboard)/telemedicine/[sessionId]/page.tsx` (pass patient id, encounter link)
- Test: `tests/lib/telemedicine/call-duration.test.ts`, extend `tests/api/appointments.test.ts`, `tests/pages/telemedicine-call-screen.test.tsx`, create `tests/components/DashboardAppointmentsTable.telemedicine.test.tsx`

**Interfaces:**
- `formatCallDuration(startedAt: Date | null, endedAt: Date): string` ("12 min", "1 h 05 min", "under a minute").
- End-of-call links: the server page passes `encounterHref`: `/encounters/<encounterId>` when WS1 has merged and the appointment has an encounter (looked up by `encounters.appointment_id`), otherwise `/patients/<id>?tab=visits`, `/patients/<id>/medical-record#notes`, `/cash-desk?patientId=<id>`.

- [ ] **Step 1: Write failing tests**: an in-person row has no telemedicine button; a video row with an active session shows "Rejoin" after a fresh render (state from the server, not local state); starting telemedicine on an in-person appointment → 409; creating an appointment with `visitMode: 'video'` stores it; the call screen shows a ticking timer (fake timers) and, after end, the duration and three links.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS (+ `tests/api/telemedicine-*.test.ts`).
- [ ] **Step 5: Commit** `feat(telemedicine): visit mode, active-session rejoin after reload, call duration and next steps`.

### Task 7: Portal visits from encounters, bookable doctors, video request, 2FA nudge and README

**Files:**
- Create: `scripts/migrations/2026-10-24-ws7-portal-bookable.sql` (same guarded block as Plan A Task 6; see Preconditions), `src/components/portal/MfaNudge.tsx`
- Modify: `src/lib/queries/patient-portal-records.ts` (`listPortalPastVisits(patientId): Promise<{ kind: 'opd' | 'ipd' | 'lab' | 'video'; date: string; doctorName: string; departmentName: string | null; status: string; dischargeSummaryHref: string | null }[]>` from `encounters` + `admissions`, newest first, last 24 months; `listPortalBookableProviders` filters `portal_bookable = true` and clinical departments), `src/app/patient-portal/(authenticated)/appointments/page.tsx` ("Past visits" from encounters, appointments only for upcoming), `src/components/portal/PortalAppointmentRequestForm.tsx` (In person / Video choice), `src/app/api/patient-portal/appointment-requests/route.ts` (`visitMode`), `src/lib/queries/booking-requests.ts` (`confirmBookingRequest` copies `requestedVisitMode` to `appointments.visit_mode`), `src/app/patient-portal/(authenticated)/layout.tsx` (renders `MfaNudge` when MFA is off), `src/app/patient-portal/(authenticated)/security/page.tsx` (copy: "Recommended"), `README.md` (lines 33, 150–151, 196–197: staff MFA required; patient MFA offered and recommended, OTP sign-in available)
- Test: `tests/lib/queries/portal-past-visits.test.ts`, extend `tests/pages/patient-portal-appointments.test.tsx`, `tests/api/patient-portal-appointment-requests.test.ts`, `tests/api/booking-requests-portal-confirm.test.ts`, create `tests/lib/readme-mfa-claim.test.ts`

**Interfaces:**
- `MfaNudge({ dismissible: boolean })` links to `/patient-portal/security`; dismissal stored for the session only (cookie-free: `sessionStorage`), shown again next sign-in.
- README test: `README.md` contains no sentence saying patient MFA is mandatory (regex `/mandatory[^.]*patient/i` and `/patient[^.]*mandatory/i` both absent) and does state staff MFA is required.

- [ ] **Step 1: Write failing tests**: a completed OPD encounter and a discharged admission appear under Past visits with doctor and date (IST), the discharge row links to its summary; a pathologist is not offered in the request form; a video request confirmed by staff yields a `video` appointment; the nudge shows when `mfa_enabled = false` and not when true; README assertions.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS (+ `tests/pages/patient-portal-*.test.tsx`).
- [ ] **Step 5: Commit** `feat(portal): past visits from encounters, bookable doctors only, video requests, MFA nudge; README matches code`.

### Task 8: Portal bills with Pay now (UPI QR) and patient-reported UTR

**Files:**
- Create: `scripts/migrations/2026-10-24-ws7-portal-payment-requests.sql`, `src/app/api/patient-portal/payments/upi-request/route.ts`, `src/app/api/patient-portal/payments/[id]/reported-utr/route.ts`, `src/components/portal/PayNowDialog.tsx`
- Modify: `src/db/schema.ts` (`// WS7 T8` on `paymentRequests`: `source` text default `'staff'` `CHECK IN ('staff','portal')`, `reportedUtr`, `reportedAt`), `src/lib/payments/manual-upi.ts` (add `createPortalUpiRequest(patientId: string, invoiceId: number, now?: Date)`, sharing the insert and QR code with `createUpiRequest` through a private helper; it writes `source = 'portal'`, `created_by = 'Patient portal'`, `created_by_user_id = NULL` and audits with `logPatientPortalAction`; it never fabricates a staff `Session`), `src/lib/queries/patient-portal-records.ts` (`PortalInvoiceRow` gains `paidPaise`, `outstandingPaise` from the foundations invoice paid/outstanding helper), `src/app/patient-portal/(authenticated)/bills/page.tsx` (outstanding column; "Pay now" for outstanding > 0), Cash Desk pending UPI list (`src/app/(dashboard)/cash-desk/*`: show "Patient reported UTR ••••1234" on portal requests; confirm uses the existing confirm route), `tests/api/rbac-route-gates.test.ts`
- Test: `tests/api/patient-portal-payments.test.ts`, create `tests/components/portal/PayNowDialog.test.tsx`, extend `tests/pages/cash-desk.test.tsx`

**Interfaces:**
- `POST /api/patient-portal/payments/upi-request` (patient session) body `{ invoiceId: number }` → `201 { requestId, qrDataUrl, upiUri, amountPaise }` for the invoice's outstanding amount; another patient's invoice → 404; fully paid → 409; UPI not configured → 503 with the UPI message; rate-limited 5 per hour per patient; reuses a pending portal request for the same invoice within its TTL instead of creating another.
- `POST /api/patient-portal/payments/[id]/reported-utr` body `{ utr: string }` → `200 { ok: true }`; stores `normaliseUtr(utr)` in `reported_utr` only; never posts a receipt; audit without the UTR.
- Display masking: `maskUtr(utr: string): string` → `••••` + last 4.

- [ ] **Step 1: Write failing tests**: Pay now creates one request for the outstanding amount; reporting a UTR leaves `patient_payments` unchanged; the cashier's confirm with that UTR posts one receipt and the portal bill shows paid; a UTR already used on another receipt is refused at confirm (existing 409); the patient cannot read or report on another patient's request (404); responses never echo the UTR.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS (+ `tests/api/payments-upi.test.ts`).
- [ ] **Step 5: Commit** `feat(portal): bills show outstanding with Pay now by UPI; cashier confirms patient-reported UTRs`.

### Task 9: Portal self-service policy and ABHA submissions with staff approval

**Files:**
- Create: `scripts/migrations/2026-10-24-ws7-portal-submissions.sql`, `src/lib/queries/portal-submissions.ts`, `src/app/api/patient-portal/self-service/route.ts`, `src/app/api/front-desk/portal-submissions/route.ts`, `src/app/api/front-desk/portal-submissions/[id]/decision/route.ts`, `src/app/(dashboard)/front-desk/portal-submissions/page.tsx`, `src/components/portal/SelfServiceForms.tsx`
- Modify: `src/db/schema.ts` (`// WS7 T9`: `portalSubmissions`), `src/app/patient-portal/(authenticated)/insurance/page.tsx` ("Add a policy" / "Add my ABHA" forms, pending status list), `src/lib/role-policy.ts` (append `PORTAL_SUBMISSION_REVIEW_ROLES = ['admin', 'frontdesk', 'rcm']`), `src/lib/nav-badges.ts` + `src/components/LeftNav.tsx` (badge "Portal submissions" for those roles), `tests/api/rbac-route-gates.test.ts`, `tests/pages/page-gates-harness.ts`
- Test: `tests/api/portal-submissions.test.ts`, `tests/lib/queries/portal-submissions.test.ts`

**Interfaces:**
- `portal_submissions(id, patient_id, kind CHECK IN ('policy','abha'), payload jsonb, document_id NULL → documents, status CHECK IN ('pending','approved','rejected') default 'pending', submitted_at, reviewed_by_name, reviewed_at, reject_reason)`; partial unique `(patient_id, kind) WHERE status = 'pending'`.
- `POST /api/patient-portal/self-service` multipart: `kind`, policy fields `{ insurerName: string(2..120); policyNumber: string(3..40); validFrom; validTo; sumInsuredPaise?: int }` or ABHA fields `{ abhaNumber: 14 digits (formatted XX-XXXX-XXXX-XXXX), abhaAddress?: string }`, optional `card` image (JPEG/PNG/PDF ≤ 5 MB) → `201 { id }`; second pending of the same kind → 409.
- `POST /api/front-desk/portal-submissions/[id]/decision` body `{ decision: 'approve'; insurerPayerId: number; tpaPayerId?: number | null } | { decision: 'approve' } (abha) | { decision: 'reject'; reason: string(5..300) }` → approve policy calls `createPolicy` (`src/lib/queries/rcm-policies.ts`) and links the card document; approve ABHA calls `updatePatientProfile` (`src/lib/queries/patient-profile.ts`) so it is "Recorded, not verified with ABDM"; ABHA already on another chart → 409 (existing unique). Audit `approved portal submission` / `rejected portal submission` with `kind` and id.

- [ ] **Step 1: Write failing tests**: patient submits a policy with a card image → pending row and a `documents` row; staff approve creates the real policy and the portal shows it; reject shows the reason to the patient; an ABHA used by another chart → 409 at approval; billing role → 403 on decision; the portal submission route refuses a staff session.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(portal): self-service policy and ABHA submissions with front-desk approval`.

### Task 10: Broadcasts: hospital audience filters, opt-out, count confirmation, real send and log

**Precondition:** Foundations Tasks 8–9 merged.

**Files:**
- Create: `src/lib/broadcasts/audience.ts`, `scripts/migrations/2026-10-24-ws7-broadcast-filters.sql`
- Modify: `src/db/schema.ts` (`// WS7 T10` on `broadcasts`: `filters jsonb`, `templateKey text`, `sentCount`, `skippedCount`, `failedCount` ints default 0), `src/lib/notify/templates.ts` (append `broadcast_notice` with vars `{ hospitalName, message }`, message ≤ 140), `src/lib/queries/broadcasts.ts` (`listBroadcastRecipientCandidates(filters: HospitalAudienceFilters)`; remove `simulateBroadcastDelivery` use), `src/app/api/broadcasts/recipients/route.ts` (new query params; trial params accepted only when `trialsEnabled()`), `src/app/api/broadcasts/route.ts` (body adds `filters`, `confirmCount: number`; sends via `sendNotification` per recipient; stores counts), `src/components/BroadcastWizard.tsx` (filter step, preview with "212 match · 18 opted out · 7 no phone", type-the-number confirmation), `src/app/(dashboard)/broadcasts/[id]/page.tsx` (counts and filter summary)
- Test: `tests/lib/broadcasts/audience.test.ts`, extend `tests/api/broadcasts.test.ts`, `tests/components/BroadcastWizard.test.tsx`

**Interfaces:**
- `interface HospitalAudienceFilters { departmentId?: number; providerId?: number; ageMin?: number; ageMax?: number; ward?: string; followUpDue?: 'overdue' | 'due_7_days'; language?: string; pinCodePrefix?: string /* 3–6 digits */; trialId?: string; overallStatus?: 'green'|'yellow'|'red'; formStatus?: 'sent'|'partial'|'completed'|'none' }` (department/doctor = had an encounter with them in the last 12 months; ward = currently admitted in that ward).
- `classifyRecipient(p: { phone: string | null; optedOut: boolean; smsOff: boolean; archived: boolean }): 'send' | 'opted_out' | 'no_phone' | 'archived'`.
- POST refuses when `confirmCount` ≠ the server's current sendable count (409 `{ code: 'count_changed', count }`); audience 0 → 422.

- [ ] **Step 1: Write failing tests**: age 60–120 + PIN prefix 560 selects only matching patients; opted-out and no-phone patients are excluded and counted; trial filters ignored (400) with the flag off; a wrong `confirmCount` → 409 with the fresh count; a send records one `notification_log` row per sendable recipient with template `broadcast_notice` and the broadcast row stores sent/skipped/failed; the wizard blocks Send until the typed number matches; a message over 140 characters is refused.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(broadcasts): hospital audience filters, opt-out and phone checks, count confirmation, real sends with log`.

### Task 11: Send Form search, "Document inbox", US-isms

**Files:**
- Modify: `src/components/SendFormModal.tsx` (replace the patient `<select>` with `PatientPicker`; drop the `patients` prop), `src/components/DashboardHomeClient.tsx` and `src/app/(dashboard)/page.tsx` (stop loading every patient for the modal), `src/components/DocumentsTabs.tsx` (labels "Document inbox" and, demo only, "Fax log (demo)"), `src/app/(dashboard)/documents/page.tsx` and `layout.tsx` (heading "Document inbox"), `src/components/LeftNav.tsx` (label unchanged "Documents"), `src/components/DischargeAdmissionModal.tsx` (placeholder "Devices (e.g. none, urinary catheter, NPWT dressing)"), `tests/lib/no-us-locale.test.ts` (add banned strings `Wound VAC` and `Fax History` in `src/`; `J3490` is WS2's and is added to the list only once WS2 has merged)
- Test: extend `tests/components/SendFormModal.test.tsx`, `tests/lib/no-us-locale.test.ts`, `tests/pages/documents-cache-hit.test.tsx`

**Interfaces:**
- `SendFormModal({ templates: { id: number; name: string }[]; onClose(): void; initialPatient?: PickedPatient | null })`.

- [ ] **Step 1: Write failing tests**: the modal shows a search box, typing "Saro" lists matches with UHID and never a full patient list; the dashboard page no longer queries `listPatientsWithStatus` for this modal; the documents heading reads "Document inbox"; the banned-strings test fails on the current tree.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS (+ `tests/pages/dashboard-routing.test.tsx`).
- [ ] **Step 5: Commit** `fix(ui): searchable Send Form, Document inbox wording, remove US-isms`.

### Task 12: Audit log filters, search, pagination and CSV export

**Files:**
- Create: `src/lib/audit/csv.ts`, `src/app/api/audit-log/export/route.ts`, `scripts/migrations/2026-10-24-ws8-audit-log-indexes.sql`, `src/components/audit/AuditLogFilters.tsx`
- Modify: `src/lib/queries/audit-log.ts` (`listAuditLog(filters: AuditLogFilters, cursor?: AuditCursor, pageSize = 50): Promise<{ entries: AuditLogEntry[]; nextCursor: AuditCursor | null }>`; `iterateAuditLog(filters, max = 50_000)` async generator), `src/app/api/audit-log/route.ts` (query params, strict Zod), `src/app/(dashboard)/audit-log/page.tsx` (filters in the URL, "Next page", "Export CSV"), `src/db/schema.ts` (`// WS8 T12`: indexes on `auditLog`), `tests/api/rbac-route-gates.test.ts`
- Test: `tests/lib/audit/csv.test.ts`, extend `tests/api/audit-log.test.ts`, `tests/pages/audit-log.test.tsx`

**Interfaces:**
- `interface AuditLogFilters { user?: string; role?: Role; patient?: string /* UHID or chart id, resolved to patient_id */; action?: string /* ILIKE contains */; from?: string; to?: string /* IST dates */; q?: string /* user, action or details */ }`; `type AuditCursor = { ts: string; id: number }` (base64url in the URL).
- `csvCell(v: string | null): string` (quotes, doubles quotes, prefixes `'` when the value starts with `=`, `+`, `-`, `@`, tab or CR); `toAuditCsv(rows): string` header `timestamp_ist,user,role,action,patient_uhid,details`.
- `GET /api/audit-log/export?<filters>` (admin) → `text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="audit-log-<from>-<to>.csv"`; over 50,000 rows → 422 "Narrow the filters"; audit `exported audit log` with filter keys and row count.

- [ ] **Step 1: Write failing tests**: filtering by role `pharmacy` and a date range returns only those rows; patient filter by UHID resolves to the chart; cursor pagination returns 50, then the next 50 with no overlap and no gap when timestamps tie; `csvCell('=SUM(A1)')` → `"'=SUM(A1)"`; export streams the CSV with a UHID column and writes its own audit row; non-admin → 403; invalid role param → 400.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(audit): filters, search, keyset pagination and safe CSV export`.

### Task 13: Archive instead of delete

**Files:**
- Create: `scripts/migrations/2026-10-24-ws8-patient-archive.sql`, `src/lib/queries/patient-archive.ts`, `src/app/api/patients/[anonId]/archive/route.ts`, `src/app/api/patients/[anonId]/restore/route.ts`, `src/components/ArchivePatientDialog.tsx`
- Modify: `src/db/schema.ts` (`// WS8 T13` on `patients`: `archivedAt`, `archivedByName`, `archiveReason`; partial index `WHERE archived_at IS NULL` on `uhid`), `src/app/api/patients/[anonId]/route.ts` (DELETE answers `405 { error: 'Patients are archived, not deleted. Use Archive.' }`), `src/components/DeletePatientButton.tsx` → renders "Archive patient" (admin only, secondary style, inside a "More" menu, not a red header button), `src/components/DeletePatientDialog.tsx` (removed; Workbook context menu uses the archive dialog), and the patient-facing queries: `src/lib/queries/patients.ts` (`listPatientsWithStatus`), `src/lib/queries/search.ts` (`searchAll`, `lookupPatients`, `getPickedPatient`), `src/lib/queries/patient-portal.ts` (`findPortalLoginCandidate`, `findPortalOtpCandidate`), `src/lib/queries/patient-ledger.ts` (`findPatientForCashDesk`), `src/lib/queries/rcm-policies.ts` (`findPatientsForRcm`), `src/lib/queries/broadcasts.ts`, `src/app/(dashboard)/patients/[anonId]/page.tsx` (archived banner with reason and Restore for admin; other roles 404), `tests/api/rbac-route-gates.test.ts`
- Test: `tests/api/patients-archive.test.ts`, `tests/lib/queries/patient-archive.test.ts`, replace `tests/components/DeletePatientDialog.test.tsx` with `tests/components/ArchivePatientDialog.test.tsx`

**Interfaces:**
- `notArchived(): SQL` (`isNull(patients.archivedAt)`), exported for every list query.
- `archivePatient(anonId: string, input: { reason: string; confirmUhid: string }, session: Session): Promise<{ ok: true } | { ok: false; error: 'not_found' | 'uhid_mismatch' | 'already_archived' | 'active_admission' }>` (one transaction with the audit row `archived patient` and `reason_length=<n>`; refuses while admitted).
- `restorePatient(anonId, session)`.
- `POST /api/patients/[anonId]/archive` (admin) body `{ reason: string(10..500); confirmUhid: string }`; `POST /api/patients/[anonId]/restore` (admin) body `{}`.
- `deletePatient` stays exported only for Task 14's erasure path; a test asserts no route file imports it except the DPDP erase route.

- [ ] **Step 1: Write failing tests**: wrong UHID → 400 `uhid_mismatch` and nothing changes; archive hides the chart from the patients list, global search, PatientPicker lookup, cash-desk search, RCM search and broadcast candidates; portal password and OTP sign-in fail like an unknown account; admin sees the banner and can restore; pi gets 404 on the archived chart; DELETE answers 405; an admitted patient cannot be archived.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS (+ `tests/api/patients*.test.ts`, `tests/api/search.test.ts`, `tests/pages/patient-detail-*.test.tsx`).
- [ ] **Step 5: Commit** `feat(governance): archive patients with reason and typed UHID instead of deleting`.

### Task 14: DPDP data-principal request register, export bundle and retention schedule

**Files:**
- Create: `scripts/migrations/2026-10-24-ws8-data-principal-requests.sql`, `src/lib/governance/retention.ts`, `src/lib/queries/data-principal-requests.ts`, `src/app/api/governance/data-requests/route.ts`, `src/app/api/governance/data-requests/[id]/route.ts`, `src/app/api/governance/data-requests/[id]/export/route.ts`, `src/app/api/governance/data-requests/[id]/export/download/route.ts`, `src/app/api/governance/data-requests/[id]/erase/route.ts`, `src/app/(dashboard)/governance/data-requests/page.tsx`, `src/app/(dashboard)/governance/data-requests/[id]/page.tsx`
- Modify: `src/db/schema.ts` (`// WS8 T14`: `dataPrincipalRequests`), `src/components/LeftNav.tsx` (admin "Data requests" under Audit Log), `README.md` (replace "not provided" DPDP sentence with what exists and what remains), `tests/api/rbac-route-gates.test.ts`, `tests/pages/page-gates-harness.ts`
- Test: `tests/lib/governance/retention.test.ts`, `tests/api/data-principal-requests.test.ts`

**Interfaces:**
- `RETENTION_SCHEDULE: readonly { category: 'medical_records' | 'mlc_records' | 'financial_records' | 'audit_log' | 'notification_log' | 'portal_uploads'; years: number; basis: string; status: 'default_pending_legal_review' }[]` (defaults: medical 3, MLC 10, financial 8, audit 8, notification log 2, portal uploads 3); `retentionBlocksErasure(facts: { hasFinancial: boolean; hasMlc: boolean; lastEncounterDate: string | null }, todayIso: string): string[]` (reasons).
- `data_principal_requests` per spec §3; `reference` `DPR-<YYYY>-<6 digits>`; `due_by` = received + 30 days; `checklist` keys `identity_verified`, `scope_confirmed`, `export_prepared`, `export_delivered`, `erasure_reviewed`, `response_sent`.
- `POST /api/governance/data-requests` (admin) body `{ patientRef: string; kind: 'access' | 'correction' | 'erasure' | 'grievance'; receivedVia: 'email' | 'portal_message' | 'letter' | 'in_person'; receivedAt: 'YYYY-MM-DD'; note?: string(..500) }` → `201 { id, reference, dueBy }`; `PATCH …/[id]` body `{ status?; checklist?: Partial<Record<ChecklistKey, boolean>>; decisionNote?: string }`; `POST …/[id]/export` builds `{ manifest: { reference, generatedAt, patientUhid, sections }, fhir: buildFullBundle(await gatherPatientFhirData(id)) }`, stores it with `putPrivateBlob` as JSON, sets `export_blob_url` (never returned) → `200 { ok: true }`; `GET …/export/download` streams it with `Content-Disposition: attachment`, audit `downloaded data-principal export`; `POST …/[id]/erase` body `{ confirmUhid: string }`: when `retentionBlocksErasure` returns reasons → archives the chart (Task 13) and scrubs `phone`, `email`, `address_line1/2`, `photo_blob_path`, portal credentials, then `200 { outcome: 'restricted', reasons }`; when none → `deletePatient` → `200 { outcome: 'erased' }`.
- Requests past `due_by` and not closed show as overdue on the list and in Task 15's strip.

- [ ] **Step 1: Write failing tests**: creating a request computes `due_by` 30 days later; the export contains the patient's FHIR bundle and manifest with UHID and no blob URL in any response; download is admin-only and audited; erasure of a patient with an invoice returns `restricted`, archives and scrubs contact fields while invoices remain; erasure of a patient with no retained records deletes the chart; wrong UHID → 400; non-admin → 403 on every route.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(governance): DPDP request register with export bundle, guarded erasure and retention schedule`.

### Task 15: Needs-attention strip and clickable tiles on role dashboards

**Files:**
- Create: `src/lib/queries/needs-attention.ts`, `src/components/dashboards/NeedsAttentionStrip.tsx`
- Modify: `src/app/(dashboard)/page.tsx` (load and render the strip above tiles), `src/components/dashboards/AdminDashboard.tsx` (fold `expiringCredentials` into the strip), `src/components/dashboards/PharmacyDashboard.tsx`, `src/components/dashboards/FrontDeskDashboard.tsx`, `src/components/dashboards/CoordinatorDashboard.tsx`, `src/app/(dashboard)/doctor/page.tsx`, `src/app/(dashboard)/labs/page.tsx`, `src/app/(dashboard)/rcm/page.tsx` (every count is a `KpiTile` with an `href` the role can open; plain numbers become links), `src/lib/queries/rcm-policies.ts` (append `countPoliciesExpiringBetween(fromIso, toIso)`)
- Test: `tests/lib/queries/needs-attention.test.ts`, `tests/components/dashboards/NeedsAttentionStrip.test.tsx`, extend `tests/pages/dashboard-link-gates.ts` cases

**Interfaces:**
- `interface AttentionItem { id: 'critical_labs' | 'overdue_follow_ups' | 'expiring_credentials' | 'expiring_policies' | 'low_stock' | 'expiring_stock' | 'pending_portal_submissions' | 'reported_upi' | 'overdue_data_requests'; label: string; count: number; href: string; tone: 'danger' | 'warning' }`
- `loadNeedsAttention(role: Role, todayIso: string): Promise<AttentionItem[]>` — only items the role may open (checked against the same role lists the target pages use), only `count > 0`, at most 6, danger first. Items whose source table is absent (a stream not merged yet) are skipped by feature checks on imported modules, not try/catch on SQL errors.

- [ ] **Step 1: Write failing tests**: admin sees credentials expiring in 30 days and overdue data requests; pharmacy sees low and expiring stock and never RCM items; front desk sees overdue follow-ups and expiring policies (7 days); a zero count is not shown; every item's `href` passes `tests/pages/dashboard-link-gates.ts` for that role; the strip renders nothing (not an empty box) when there are no items.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS (+ `tests/components/dashboards`, `tests/pages/dashboard-routing.test.tsx`).
- [ ] **Step 5: Commit** `feat(dashboards): needs-attention strip and clickable tiles for every role`.

### Task 16: Payers drawer, consistent empty states and next-step toasts

**Files:**
- Modify: `src/app/(dashboard)/rcm/payers/page.tsx` (list first; "Add insurer or TPA" button opens a right-side `Dialog` drawer containing `PayerProfileForm` from `src/components/rcm/PayerProfileForm.tsx`; success toast with "Open payer" link), next-step toasts on surfaces this sub-project owns: `SendFormModal` ("Form sent" → "Copy link"), `ArchivePatientDialog` ("Archived" → "Undo" for admin), `BroadcastWizard` ("Sent to 212" → "View log"), portal-submission decisions ("Policy added" → "Open policy"); and `EmptyState` in the list pages that render a bare "No …" paragraph today: `src/app/(dashboard)/front-desk/follow-ups/page.tsx`, `booking-requests/page.tsx`, `home-collections/page.tsx`, `pharmacy/billing/page.tsx`, `forms/page.tsx`, `documents/page.tsx`, `broadcasts/page.tsx`, `rcm/payers/page.tsx`, `staff/page.tsx`
- Not touched: `BedBoard.tsx`, `DischargeAdmissionModal.tsx`, `OrderLabTestModal.tsx`, `DispenseMedicationModal.tsx` (WS1–WS3 own their cards and toasts and use the same primitive).
- Test: create `tests/pages/rcm-payers-drawer.test.tsx`, `tests/lib/empty-state-usage.test.ts`; extend `tests/components/SendFormModal.test.tsx`, `tests/components/BroadcastWizard.test.tsx`

**Interfaces:**
- Consumes `useToast`, `EmptyState` (Plan A Task 1).
- `empty-state-usage` test: each listed page module (or the client component it renders) imports `EmptyState` and contains no bare `No … yet` paragraph matched by `/<p[^>]*>\s*No [^<]* yet/`.

- [ ] **Step 1: Write failing tests**: the payers page renders the table without the form until the button is pressed; saving shows the toast with a link to the new payer; Send Form and Broadcast success show their toasts with the next-step link; the empty-state usage test fails on today's pages.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS (+ `tests/pages/rcm-preauth-payer-pages.test.tsx`).
- [ ] **Step 5: Commit** `feat(ui): payers drawer, consistent empty states and next-step toasts`.

### Task 17 (closing, not a build task): Plan verification walkthrough

- [ ] **Step 1:** Merge streams F, N, P, C, G, U into `feat/hospital-completion` in that order; resolve only delimited shared blocks. `source $SCRATCH/testenv.sh && npm run db:migrate && npx vitest run` → green; `npx tsc --noEmit`, `npm run lint` → clean.
- [ ] **Step 2:** Docker walkthrough, `ENABLE_TRIALS` unset then `true`: install the hospital form pack; build a form with a condition and a Kannada translation; send it by search; fill it in Hindi from the portal with a file and signature; back-link and signed copy; sign a note with password; video appointment → rejoin after reload → end → duration and next steps; portal past visits; Pay now QR → reported UTR → cashier confirm; policy self-service → approve; broadcast to "age ≥ 60, PIN 560" with count confirmation and log; audit log filter + CSV; archive a test chart and confirm it vanishes from search and portal sign-in; DPDP request → export → restricted erasure; dashboards' needs-attention strip per role.
- [ ] **Step 3:** Tick A4, F1–F5, G5 (Wound VAC, Fax), H3, H4, I12–I14, J1–J8, K9, K11 and UI items 3, 10, 11 in the gap-closure plan (UI 7 bed board is WS3's); record the manual demo-data cleanup (junk consent "sdfghjk", F2) as done or pending. Commit `docs: WS7–WS9 verified`.
