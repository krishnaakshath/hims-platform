# Inpatient Care and Laboratory Results Implementation Plan (WS3 + WS4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn IPD admission into a real admission with safety rules, make the bed board the ward's working surface with a dues-gated, coded discharge and a nursing station; and make lab results per-analyte with automatic flags, a logged critical-value loop, pathologist verification, a tariff-sourced catalogue, richer orders and per-analyte PDF/FHIR output.

**Architecture:** Pure rule modules (`src/lib/inpatient/*`, `src/lib/labs/analytes.ts`, `src/lib/labs/verification.ts`) behind transactional query functions (`src/lib/queries/*`) and thin routes. `lab_results` stays the one summary row per order; analyte detail is a child table. Admission moves out of `checkInVisit` into `admitPatient`. Every new route follows the repo pattern: `requireSession`, inline role allowlist (`if (!X_ROLES.includes(session.role)) 403`), strict Zod body, audit entry with ids only, rows in both RBAC harnesses.

**Tech Stack:** Next.js 16 App Router (read `node_modules/next/dist/docs/` before touching routing, layouts, `searchParams` or caching: AGENTS.md says this Next.js has breaking changes), TypeScript, Drizzle + Postgres (node-postgres transactions), Redis cache (`src/lib/cache.ts`), Vitest, Zod 4, pdf-lib, recharts.

**Spec:** `docs/superpowers/specs/2026-10-23-inpatient-lab-design.md`. Findings: `docs/superpowers/plans/2026-10-23-gap-closure-plan.md` (C1–C4, B4, E1–E2, A6–A7, I2). Prior plans for context: `2026-09-26-inpatient-adt.md`, `2026-09-28-lab-orders-and-results.md`, `2026-09-28-encounter-notes-and-mar.md`, `2026-10-07-sp5-lab-home-collection.md`.

## Streams (run in parallel, one git worktree each, branched from `feat/hospital-completion`)

| Stream | Tasks | Area | Depends on |
|---|---|---|---|
| **A** | T1 → T2 → T3 → T4 | Admission and bed board | — |
| **B** | T5 → T6 → T7 | Dues clearance, coded discharge, nursing station | — |
| **C** | T8 → T9 → T10 → T11 → T12 | Analytes, result entry, report/FHIR, verification, critical values | — |
| **D** | T13 → T14 | Catalogue from tariff, order dialog | Foundations T9 merged first (both touch the lab-order notice) |

Tasks inside a stream are sequential. Streams share no business file except the append points below; merge order A, B, C, D, then run "Integration after merge".

**Shared append points (resolve merge conflicts by keeping both sides):**
- `src/db/schema.ts`: new tables go in a block near the end, after `// end Foundations T11`, delimited `// WS3 Tn` … `// end WS3 Tn` or `// WS4 Tn` … `// end WS4 Tn`. New columns on an existing table go at the end of that table's column list inside the same delimiters. Each existing table is changed by exactly one task: `admissions`, `admission_transfers`, `rooms` (T1); `lab_requisitions`, `lab_tests` (T14).
- `src/lib/role-policy.ts`: new constants in a `// WS3 Tn` / `// WS4 Tn` block appended at the end of the file. Changes to existing constants: `CODE_LOOKUP_ROLES` (T3), `LAB_VERIFY_ROLES` (T11).
- `tests/api/rbac-route-gates.test.ts`: imports appended after the last import; rows appended at the **end** of `API_GATES` (after `// end Foundations T11`), delimited by task. `tests/pages/page-gates-harness.ts`: rows appended at the end of `PAGE_GATES`.
- `src/db/seed-india-data.ts`: new exported constants appended at the end in delimited blocks; `src/db/seed-india.ts`: calls appended in the matching seeding function, delimited.
- Migrations: `scripts/migrations/2026-10-24-ws3-<topic>.sql` / `2026-10-24-ws4-<topic>.sql`, unique per task.

## Global Constraints

- Tests run **only** against the isolated database: `source $SCRATCH/testenv.sh` (DB `hims_test`), then `npx vitest run <paths>`. Never `npm test` (it loads `.env.local`), never `.env.local`, never the demo DB `hims`, never a cloud DB. `tests/db/seed.test.ts` truncates its database. Migrations on the test DB: `source $SCRATCH/testenv.sh && npx tsx scripts/db/migrate.ts`, twice (re-run must be a no-op).
- No committed secrets, `.env*` values, `data/` or generated files. Never log or return a secret, a provider error body, a file path or a blob URL; log error class names / pg codes only.
- Money is integer paise; time is IST (`src/lib/india-time.ts`); ids shown to users are UHID, never chart ids.
- Schema: edit `src/db/schema.ts` and add a re-runnable `BEGIN; … COMMIT;` migration (`IF NOT EXISTS`, guarded `DO $$` blocks for constraints/enum values). Never edit an applied migration. Never `db:push`. Confirm with the migration runner and `tests/db/*-schema.test.ts`.
- Every new route: `requireSession()`, inline role allowlist, strict Zod (`.strict()`), audit via `logAudit` (ids only; free text never audited), `readJsonBody` for JSON, rows in **both** RBAC harnesses. Every new page: gate as its first statement after the session, row in `PAGE_GATES`, nav entry roles equal the page gate.
- `ENABLE_TRIALS=true` behaviour stays intact (Vitest sets it); nothing here is gated by the flag.
- Each task ends with its tests passing, `npx tsc --noEmit` clean, `npm run lint` clean on touched files, and one commit on the stream branch. Do not edit unrelated files.

## Review Focus

- Two concurrent admissions of the same patient (double click, two desks): exactly one succeeds; the other gets 409; no bed is left occupied without an admission.
- A female patient into "General Ward (Male)": refused without a reason; with a reason it saves, the bed board marks it, the audit row has ids only.
- Discharge with outstanding dues and no clearance: 409 with the amounts; a clearance followed by a new charge line is stale and refused again.
- A CBC entered for a 30-year-old woman: Hb 6.5 → critical (LL), platelets 38 → critical; the summary row is critical; an alert exists; verify is refused until the call is logged; the tile drops when the doctor acknowledges.
- A doctor who ordered a test cannot verify it unless linked to the test's department; a lab technician without a provider link sees why Verify is unavailable.
- Every new table cascades from its parent: deleting a patient with all of this data succeeds.

---

### Task 1 (Stream A): Admission schema and pure admission rules

**Files:**
- Modify: `src/db/schema.ts` (`admissions` + columns, `admission_transfers` + column, `rooms` + `genderRestriction`, unique index), `src/db/seed-india-data.ts` (`ROOM_SEED` gains `genderRestriction`), `src/db/seed-india.ts` (room upsert writes it)
- Create: `scripts/migrations/2026-10-24-ws3-admission-fields.sql`, `src/lib/inpatient/admission-rules.ts`
- Test: `tests/lib/inpatient/admission-rules.test.ts`, `tests/db/ws3-admission-schema.test.ts`

**Interfaces:**
- Schema (inside `// WS3 T1`): `admissions`: `expectedStayDays integer`, `attendantName text`, `attendantRelationship text`, `attendantPhone text`, `policyId integer → patientPolicies.id`, `depositRequiredPaise integer default 0 notNull`, `wardGenderOverrideReason text`, `wardGenderOverrideByName text`, `admittedByName text`; checks `admissions_expected_stay_range` (null or 1–365), `admissions_deposit_range` (0–1000000000); `uniqueIndex('admissions_one_active_per_patient').on(t.patientId).where(sql\`status = 'admitted'\`)`. `admissionTransfers.wardGenderOverrideReason text`. `rooms.genderRestriction text({ enum: ['male','female'] })` + check.
- Migration: columns `ADD COLUMN IF NOT EXISTS`; constraints in guarded `DO $$`; backfill `UPDATE rooms SET gender_restriction = 'male' WHERE gender_restriction IS NULL AND ward ILIKE '%(male)%'` and the same for `(female)`; before the index, a `DO $$` that raises `'duplicate active admissions: <ids>'` (ids only) when any patient has two `admitted` rows; `CREATE UNIQUE INDEX IF NOT EXISTS`.
- `src/lib/inpatient/admission-rules.ts` (pure):
  - `export type WardGender = 'male' | 'female' | null`
  - `export type PatientGender = 'male' | 'female' | 'transgender' | 'other' | 'unknown' | null`
  - `export type WardGenderConflict = 'opposite_sex' | 'unverified_gender'`
  - `export const CHILD_EXEMPT_AGE_YEARS = 12`; `export const OVERRIDE_REASON_MIN = 10`
  - `export function wardGenderConflict(i: { patientGender: PatientGender; ageYears: number; ward: WardGender }): WardGenderConflict | null`
  - `export function admissionTypeLabel(t: 'elective' | 'emergency' | 'transfer_in'): 'Planned' | 'Emergency' | 'Transfer in'`
  - `export function daysStayed(admittedAt: Date, now: Date): number` (IST calendar days, admission day = 1, never < 1)

- [ ] **Step 1: Write failing tests** `admission-rules.test.ts`: `wardGenderConflict` → `opposite_sex` for female/male-ward and male/female-ward; `null` for same sex, for mixed (`null`) ward, and for a 7-year-old female in a male ward; `unverified_gender` for `transgender`, `other`, `unknown`, `null` in a restricted ward; `daysStayed` = 1 for admit 23:50 IST and now 23:55 IST same day, = 2 at 00:05 IST next day, = 1 when `now < admittedAt`; labels map. `ws3-admission-schema.test.ts`: migration SQL contains every new column and the index name; a second insert of an `admitted` admission for the same patient raises unique violation `admissions_one_active_per_patient`; a discharged + an admitted row coexist; `rooms.gender_restriction = 'x'` violates the check; the backfill sets `General Ward (Male)` to `male` and leaves `General Ward (Female)` as `female`, not `male`.
- [ ] **Step 2: Run** `source $SCRATCH/testenv.sh && npx vitest run tests/lib/inpatient/admission-rules.test.ts tests/db/ws3-admission-schema.test.ts` → FAIL.
- [ ] **Step 3: Implement** schema, migration, rules; seed `ROOM_SEED` gains `genderRestriction` (`'male'` for General Ward (Male), `'female'` for General Ward (Female), else `null`).
- [ ] **Step 4: Run** the migration twice on the test DB, then the tests → PASS; `npx vitest run tests/db/seed-india-data.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(ipd): admission fields, ward gender restriction, one active stay`.

### Task 2 (Stream A): `admitPatient` and the admission route

**Files:**
- Create: `src/lib/queries/admit-patient.ts`, `src/lib/inpatient/validation.ts`, `src/app/api/inpatient/admissions/route.ts`
- Modify: `src/lib/queries/encounters.ts` (`CheckInVisitInput.visitType` narrowed to `'outpatient'`; `createAdmission` removed), `src/app/api/front-desk/check-in/route.ts` (inpatient → 400 `use_admission_form`; `roomId` removed from the schema), `src/app/print/token/[encounterId]/page.tsx` (IPD encounter → `notFound()`), `src/lib/role-policy.ts` (`// WS3 T2`: `ADMISSION_ROLES`), `src/db/seed-india.ts` (`checkIn(..., { inpatient: true })` calls `admitPatient`), `tests/api/front-desk-check-in.test.ts`, `tests/api/front-desk-check-in-encounter.test.ts` (inpatient cases now expect 400), both RBAC harnesses
- Test: `tests/lib/queries/admit-patient.test.ts`, `tests/api/inpatient-admissions-create.test.ts`

**Interfaces:**
- `export const ADMISSION_ROLES: readonly Role[] = ['frontdesk', 'admin', 'crc', 'pi']`
- `src/lib/inpatient/validation.ts`: `export const admitPatientSchema` (strict): `patientId string 1..40`, `attendingProviderId int>0`, `roomId int>0`, `admissionType enum`, `reason` (= `visitReasonSchema`), `provisionalDiagnosis: { codeId: int>0 } | { text: string 3..200 }`, `expectedStayDays int 1..365`, `attendant: { name 1..100, relationship 1..40, phone (normalizePhone) } | null`, `policyId int>0 | null`, `preauthId int>0 | null`, `depositRequiredPaise int 0..1000000000`, `wardGenderOverrideReason string 10..300 | null`, `openOpdVisit: 'complete' | 'keep' | null`. `export type AdmitPatientRequest = z.infer<typeof admitPatientSchema>`.
- `src/lib/queries/admit-patient.ts`:
  - `export interface AdmitPatientInput extends AdmitPatientRequest {}` (with `patientId` resolved to the chart id)
  - `export type AdmitPatientError = 'patient_not_found' | 'provider_not_found' | 'room_unavailable' | 'already_admitted' | 'ward_gender_conflict' | 'open_opd_visit' | 'policy_mismatch' | 'policy_inactive' | 'preauth_mismatch' | 'code_not_found'`
  - `export type AdmitPatientResult = { ok: true; admissionId: number; encounterId: number; roomLabel: string } | { ok: false; error: AdmitPatientError; conflict?: WardGenderConflict; openEncounterId?: number }`
  - `export async function admitPatient(input: AdmitPatientInput, session: Session, now?: Date): Promise<AdmitPatientResult>`
  - One transaction, lock order: `pg_advisory_xact_lock(hashtext('admissions.patient:' || patientId))` → room row `for update` → open OPD encounter rows `for update`. Steps: patient/provider/room checks; gender rule (age from `patients.dob` on the IST date of `now`); claim the bed (`status='available'` → `occupied`); policy (patient's, `active`, `validFrom ≤ today ≤ validTo`); pre-auth (patient's, `admission_id IS NULL`); doctor assignment (`visitType 'inpatient'`, `status 'scheduled'`, `queueTicketNumber 0`); admission row; IPD encounter (`opdToken null`); provisional `diagnoses` row; pre-auth `admission_id`; open OPD handling; audit `admitted patient` (`admission=<id> room=<id>`), `ward gender override` when used, `completed OPD visit at admission` when used. Unique violation on `admissions_one_active_per_patient` → `already_admitted`.
- Route `POST /api/inpatient/admissions` (`ADMISSION_ROLES`; a `pi` must be the attending via `resolveDoctorQueueProvider`, else 403): 201 `{ admissionId, encounterId, patientId, uhid, roomLabel, depositRequiredPaise, cashDeskHref }` where `cashDeskHref = /cash-desk?patientId=<id>&amountPaise=<deposit>` (omitted when 0). Errors: 404 `patient_not_found|provider_not_found`, 409 `room_unavailable|already_admitted|open_opd_visit` (with `openEncounterId`), 422 `ward_gender_conflict` (with `conflict`), `policy_mismatch|policy_inactive|preauth_mismatch|code_not_found`. Body `{ error, code }`, messages fixed.

- [ ] **Step 1: Write failing tests** `admit-patient.test.ts`: creates admission + IPD encounter with `opdToken === null`, assignment `queueTicketNumber === 0`, room `occupied` by the patient, `diagnoses` row `provisional`/`proposed` with the code; second admission → `already_admitted` and the second room stays `available`; two concurrent `admitPatient` calls for one patient on two rooms → exactly one ok, the other room `available`; a `blocked` or `dirty` room → `room_unavailable`; female into male bed without reason → `ward_gender_conflict`/`opposite_sex` and nothing written; with reason → ok and `wardGenderOverrideReason` stored; patient with a `checked_in` OPD encounter today → `open_opd_visit` with its id; `'complete'` completes it in the same transaction; `'keep'` leaves it; expired policy → `policy_inactive`; another patient's pre-auth → `preauth_mismatch`; own pre-auth gets `admission_id`; a thrown error after the bed claim rolls the bed back to `available`. `inpatient-admissions-create.test.ts`: 403 for `billing`, `labs`; 400 on unknown key; `pi` admitting under another doctor → 403; 201 body has `uhid` and `cashDeskHref` only when deposit > 0; `POST /api/front-desk/check-in` with `visitType: 'inpatient'` → 400 `use_admission_form`; `/print/token/<ipd encounter>` → not found.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; switch the seed's inpatient check-ins to `admitPatient` (demo provisional diagnosis by free text when no licensed ICD-10 version is loaded).
- [ ] **Step 4: Run** the two new files plus `tests/api/front-desk-check-in*.test.ts tests/lib/queries/admissions.test.ts tests/db/seed.test.ts`; add `POST /api/inpatient/admissions` (`ADMISSION_ROLES`) to `API_GATES` → PASS.
- [ ] **Step 5: Commit** `feat(ipd): admission form backend with ward-gender, one-stay, bed-claim and open-OPD rules`.

### Task 3 (Stream A): Admission dialog

**Files:**
- Create: `src/components/inpatient/AdmitPatientModal.tsx`, `src/lib/queries/admission-form-context.ts`, `src/app/api/inpatient/admissions/form-context/route.ts`
- Modify: `src/components/CheckInModal.tsx` (choosing Inpatient opens `AdmitPatientModal` with the picked patient; room select removed), `src/components/BedBoard.tsx` (available bed → "Admit here" for `ADMISSION_ROLES`, opening the modal with the bed preselected), `src/app/(dashboard)/inpatient/beds/page.tsx` (pass `canAdmit = ADMISSION_ROLES.includes(role)`), `src/lib/role-policy.ts` (`CODE_LOOKUP_ROLES` + `'frontdesk'`), `tests/components/CheckInModal.test.tsx`, both RBAC harnesses (code search row now allows frontdesk)
- Test: `tests/components/AdmitPatientModal.test.tsx`, `tests/api/inpatient-admission-form-context.test.ts`

**Interfaces:**
- `export interface AdmissionFormContext { patient: { id: string; name: string; uhid: string | null; gender: PatientGender; ageYears: number }; beds: { id: number; label: string; ward: string; genderRestriction: WardGender; roomCategoryName: string | null; tariffPaise: number | null; conflict: WardGenderConflict | null }[]; policies: { id: number; label: string; insurerName: string; validTo: string }[]; preauths: { id: number; preauthNumber: string; status: string; approvedPaise: number | null }[]; openOpdEncounter: { id: number; opdToken: number | null; providerName: string } | null; activeAdmissionId: number | null; depositThresholdPaise: number }`
- `export async function loadAdmissionFormContext(patientId: string, now?: Date): Promise<AdmissionFormContext | null>` (beds: `available` only; tariff via `loadPricingContext(billingSettings.roomRentServiceId)` + `resolvePrice` with the room category; deposit hint from `billing_settings.ipd_deposit_threshold_paise`).
- `GET /api/inpatient/admissions/form-context?patientId=` (`ADMISSION_ROLES`; 400 without `patientId`; 404 unknown; audit `viewed admission form`).
- `AdmitPatientModal({ patient, initialRoomId, providers, onClose }: { patient: PickedPatient; initialRoomId?: number | null; providers: { id: number; name: string }[]; onClose: () => void })`: sections Admission (type, attending, reason, ICD-10 `CodePicker kinds={['icd10']}` with "type instead" fallback, expected stay), Bed (only free beds; a conflicting bed shows "Female patient, male ward" and reveals a required override reason), Attendant, Payer (Self-pay or a policy; optional pre-auth), Deposit (₹ input, default the threshold); on `open_opd_visit` shows "This patient has an open OPD visit (token N with Dr X)" with "Complete it and admit" / "Keep it open and admit"; success screen: UHID, bed, "Collect deposit" link, no token.

- [ ] **Step 1: Write failing tests**: modal lists only beds from context (no occupied/blocked); selecting a conflicting bed disables Admit until a 10-character reason is typed; posts the exact body; renders the open-OPD prompt from a 409 and re-posts with `openOpdVisit`; success shows UHID and the cash-desk link and never the word "Token"; CheckInModal with Inpatient renders the admission dialog and no room select; form-context route gated (`labs` 403), returns `conflict` per bed for a female patient. Code search (`GET /api/coding/codes`) now allows `frontdesk`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** the new tests plus `tests/components/CheckInModal.test.tsx tests/pages/front-desk-check-in-page.test.tsx` and both harnesses → PASS.
- [ ] **Step 5: Commit** `feat(ipd): admission dialog with ICD-10 diagnosis, payer, deposit and ward-gender override`.

### Task 4 (Stream A): Bed board panel, bed gender setting, transfer rule

**Files:**
- Modify: `src/lib/queries/rooms.ts` (`RoomWithOccupant` + fields), `src/components/BedBoard.tsx` (occupied-bed panel actions; UHID not chart id; tariff and days stayed on the card), `src/app/(dashboard)/inpatient/beds/page.tsx` (role flags, available rooms for Transfer), `src/lib/queries/admissions.ts` (`transferAdmission` gains the gender rule and override), `src/app/api/inpatient/admissions/[id]/transfer/route.ts` (body gains `wardGenderOverrideReason?: string 10..300`; 422 `ward_gender_conflict`), `src/components/TransferAdmissionModal.tsx` (override reason field on conflict)
- Create: `src/app/api/inpatient/rooms/[id]/route.ts` (PATCH)
- Test: `tests/lib/queries/rooms-with-occupant.test.ts` (extend), `tests/components/BedBoard.test.tsx`, `tests/api/inpatient-rooms-gender.test.ts`, `tests/api/inpatient-admissions-transfer.test.ts` (extend)

**Interfaces:**
- `RoomWithOccupant` gains `admissionId: number | null; occupantUhid: string | null; occupantGender: PatientGender; genderRestriction: WardGender; roomCategoryName: string | null; bedTariffPaise: number | null; daysStayed: number | null; wardGenderOverride: boolean`. `listAllRoomsWithOccupant(now?: Date)`.
- `PATCH /api/inpatient/rooms/[id]` body `{ genderRestriction: 'male' | 'female' | null }` strict; `MASTER_DATA_ADMIN_ROLES`; 409 `room_occupied_conflict` when the current occupant would conflict; audit `changed bed gender restriction`.
- `transferAdmission(admissionId, toRoomId, reason, transferredByName, opts?: { wardGenderOverrideReason?: string | null; now?: Date }): Promise<TransferResult>` where `TransferResult.error` may be `'ward_gender_conflict'` with `conflict`.
- BedBoard props: `{ rooms; availableRooms; canManageFacilities; canBlock; canAdmit; canTransfer; canDischarge; canManageMedications; canCaptureCharges }` (flags from `['frontdesk','admin','crc','pi']`, `DISCHARGE_ROLES`, `['pi','admin']`, `CHARGE_CAPTURE_ROLES`).

- [ ] **Step 1: Write failing tests**: query returns UHID, tariff for the bed's category (₹1,500/day general ward from the seed tariff), `daysStayed` 3 for an admission two IST midnights ago, `wardGenderOverride` true when the admission has a reason; BedBoard: occupied panel shows Transfer/Discharge/MAR/Charges per flags, the Charges link is `/billing/capture?admissionId=<id>`, never renders the chart id, shows "Day 3" and "₹1,500/day"; frontdesk sees Transfer but not Discharge or MAR; PATCH gated to admin, refuses an invalid value 400, refuses making a bed `male` while a female patient occupies it (409); transfer of a female patient to a male bed → 422 without reason, 200 with reason and the reason on `admission_transfers`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; add `PATCH /api/inpatient/rooms/[id]` to `API_GATES`.
- [ ] **Step 5: Commit** `feat(ipd): bed board actions, tariff and days stayed; bed gender setting; gender rule on transfer`.

### Task 5 (Stream B): Dues computation, clearance and the discharge gate

**Files:**
- Create: `src/lib/inpatient/dues.ts`, `src/lib/queries/admission-dues.ts`, `src/app/api/inpatient/admissions/[id]/dues-clearance/route.ts`, `scripts/migrations/2026-10-24-ws3-dues-clearance.sql`
- Modify: `src/db/schema.ts` (`// WS3 T5`: `admissionDuesClearances`), `src/lib/queries/admissions.ts` (`dischargeAdmission` calls the gate inside its transaction), `src/app/api/inpatient/admissions/[id]/discharge/route.ts` (409 `dues_outstanding` body), `src/lib/role-policy.ts` (`// WS3 T5`: `DUES_VIEW_ROLES = ['admin','billing','crc','frontdesk','pi']`), both RBAC harnesses
- Test: `tests/lib/inpatient/dues.test.ts`, `tests/lib/queries/admission-dues.test.ts`, `tests/api/inpatient-dues-clearance.test.ts`, `tests/api/inpatient-admissions-discharge.test.ts` (extend)

**Interfaces:**
- `src/lib/inpatient/dues.ts` (pure):
  - `export interface DuesInput { lines: { taxablePaise: number; gstRateBp: number; payerId: number | null }[]; netAdvancesPaise: number; receiptsPaise: number; approvedPreauthPaise: number | null }`
  - `export interface DischargeDues { chargesPaise: number; payerChargesPaise: number; insurerSharePaise: number; paidPaise: number; outstandingPaise: number; creditPaise: number }`
  - `export function computeDischargeDues(i: DuesInput): DischargeDues` (charges = Σ `lineTax(taxable, rate, 'intra').totalPaise`; insurer share = `min(approved ?? 0, payerCharges)`; outstanding = `max(0, charges − insurer − paid)`; credit = the negative remainder)
  - `export function clearanceIsCurrent(c: { chargesPaise: number; overrideReason: string | null; outstandingPaise: number } | null, now: DischargeDues): boolean`
- `src/lib/queries/admission-dues.ts`: `export async function loadAdmissionDues(admissionId: number, ex?: WriteExecutor): Promise<{ dues: DischargeDues; roomRentPostedThrough: string | null; unpostedRoomRentDays: number; latestClearance: ClearanceRow | null } | null>` (non-void `charge_lines` of the admission; `admissionDepositPaise(loadLedgerEntries(...), id)`; receipts whose invoice has this `admission_id`; approved pre-auth = latest `preauths` with this `admission_id` in `approved|enhanced`); `export async function recordDuesClearance(admissionId: number, overrideReason: string | null, session: Session, now?: Date): Promise<{ ok: true; clearance: ClearanceRow } | { ok: false; error: 'not_found' | 'not_admitted' | 'reason_required' }>`.
- Schema `admission_dues_clearances` per spec §4 with check `admission_dues_clearances_reason` (`outstanding_paise = 0 OR override_reason IS NOT NULL`), FK cascade from `admissions`.
- `GET /api/inpatient/admissions/[id]/dues-clearance` (`DUES_VIEW_ROLES`) → `{ dues, roomRentPostedThrough, unpostedRoomRentDays, latestClearance }`; `POST` (`BILLING_AUTHORITY_ROLES`) body `{ overrideReason?: string 10..500 }` strict → 201; audit `cleared discharge dues` (`admission=<id> outstanding=<paise>`).
- Discharge: inside the transaction after the admission lock, `loadAdmissionDues(id, tx)`; when `outstandingPaise > 0` and `!clearanceIsCurrent(...)` → rollback with `{ ok: false, error: 'dues_outstanding', dues }`; route answers 409 `{ error: 'Dues are outstanding. Ask billing to clear or override them.', code: 'dues_outstanding', dues }`.

- [ ] **Step 1: Write failing tests** `dues.test.ts`: 2 lines ₹1,500 at 0% and ₹350 at 12% → charges 1,50,000 + 39,200 paise; advance ₹1,000 → outstanding 89,200; approved pre-auth larger than payer lines caps at payer lines; overpayment gives `creditPaise` and outstanding 0; `clearanceIsCurrent` false when charges grew after it, true when unchanged with reason, true when the stored outstanding was 0 and charges unchanged. `admission-dues.test.ts` (DB): void lines ignored; refunds net the advance; receipts on another admission's invoice ignored; cascade delete of the admission removes clearances. API: GET gated (`labs` 403); POST by `frontdesk` 403, by `billing` with outstanding and no reason 422 `reason_required`; discharge with dues and no clearance → 409 with `dues.outstandingPaise`; after a reasoned clearance → 200; add a charge line → 409 again; zero dues → 200 without clearance.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** + migration (run twice). **Step 4: Run** → PASS (incl. `tests/api/inpatient-admissions-discharge.test.ts`, `tests/lib/queries/admissions.test.ts`); harness rows for GET and POST.
- [ ] **Step 5: Commit** `feat(ipd): discharge dues computation, billing clearance with override, discharge gate`.

### Task 6 (Stream B): Coded discharge from diagnoses and the MAR

**Files:**
- Create: `src/lib/queries/discharge-context.ts`, `src/app/api/inpatient/admissions/[id]/discharge-context/route.ts`
- Modify: `src/app/api/inpatient/admissions/[id]/discharge/route.ts` (body + `diagnosisCodeIds?: number[]` max 5, unique), `src/lib/queries/admissions.ts` (`DischargeInput.diagnosisCodeIds: number[]`; writes `diagnoses` rows on the IPD encounter, first `primary`, rest `secondary`, `coding_status 'proposed'`; `code_not_found` rollback), `src/components/DischargeAdmissionModal.tsx` (new first step "Dues", then summary with ICD-10 chips and MAR-prefilled drugs)
- Test: `tests/lib/queries/discharge-context.test.ts`, `tests/api/inpatient-discharge-context.test.ts`, `tests/components/DischargeAdmissionModal.test.tsx` (extend)

**Interfaces:**
- `export interface DischargeContext { diagnoses: { codeId: number | null; code: string; display: string; type: 'provisional' | 'primary' | 'secondary' }[]; medications: { name: string; dose: string; lastStatus: 'scheduled' | 'given' | 'held' | 'refused' }[]; dues: DischargeDues; latestClearance: ClearanceRow | null; unpostedRoomRentDays: number }`
- `export async function loadDischargeContext(admissionId: number, now?: Date): Promise<DischargeContext | null>` (diagnoses: non-void rows on the admission's IPD encounter; medications: distinct `(medicationName, dose)` from `medication_administrations` with `scheduledFor` in the last 24 h and status `scheduled|given`).
- `GET /api/inpatient/admissions/[id]/discharge-context` (`DISCHARGE_ROLES`; `pi` limited to own attending patients like the discharge route); audit `viewed discharge context`.
- Modal steps: `'dues' | 'summary' | 'followup' | 'confirmation'`; Dues step shows charges, paid, insurer share, outstanding, latest clearance, room-rent warning; with outstanding and no current clearance it shows "Billing must clear or override dues before discharge" and disables Next.

- [ ] **Step 1: Write failing tests**: context returns the provisional diagnosis from Task 2's admission shape (insert directly in the test) and two MAR drugs, excludes a drug last scheduled 3 days ago; route gated (`frontdesk` 403, other doctor's `pi` 403); discharge with `diagnosisCodeIds` writes one `primary` and one `secondary` diagnosis on the IPD encounter; an unknown code id → 422 `code_not_found` and no discharge; modal prefills the drugs textarea with "Paracetamol 650 mg" lines, picking an ICD-10 code fills the diagnosis text, Next is disabled on outstanding dues.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS (+ `tests/lib/queries/discharge-summary*.test.ts`); harness row for the GET.
- [ ] **Step 5: Commit** `feat(ipd): discharge prefilled from coded diagnoses and the MAR, with a dues step`.

### Task 7 (Stream B): Nursing station: medication round and vitals chart

**Files:**
- Create: `scripts/migrations/2026-10-24-ws3-vital-signs.sql`, `src/lib/inpatient/vitals.ts`, `src/lib/queries/vitals.ts`, `src/lib/queries/medication-round.ts`, `src/app/api/inpatient/admissions/[id]/vitals/route.ts`, `src/app/api/inpatient/medication-round/route.ts`, `src/app/(dashboard)/inpatient/nursing/page.tsx`, `src/components/inpatient/NursingStation.tsx`, `src/components/inpatient/VitalsChart.tsx`
- Modify: `src/db/schema.ts` (`// WS3 T7`: `vitalSignReadings`), `src/components/LeftNav.tsx` ("Nursing station", roles `CLINICAL_ROLES`), `tests/pages/nav-role-enforcement.test.tsx`, both RBAC harnesses (two API rows, one page row)
- Test: `tests/lib/inpatient/vitals.test.ts`, `tests/lib/queries/medication-round.test.ts`, `tests/api/inpatient-vitals.test.ts`, `tests/pages/inpatient-nursing.test.tsx`

**Interfaces:**
- Schema `vital_sign_readings` per spec §4; checks: systolic 40–300, diastolic 20–200, pulse 20–250, resp_rate 4–80, temperature_c_tenths 300–450, spo2 50–100, weight_grams 300–400000, pain_score 0–10, at least one measure non-null.
- `src/lib/inpatient/vitals.ts`: `export const vitalsSchema` (strict; `recordedAt` = `appointmentInstantSchema` with offset, not in the future by > 5 min; `temperatureC` 30.0–45.0 one decimal; `weightKg` 0.3–400 up to 3 decimals; others ints; `notes` ≤ 300; refine at least one measure); `export type VitalsRequest`; `export function toVitalsRow(r: VitalsRequest): { temperatureCTenths: number | null; weightGrams: number | null; ... }`; `export type VitalWarning = 'fever' | 'hypothermia' | 'tachycardia' | 'bradycardia' | 'hypotension' | 'hypertension' | 'hypoxia' | 'tachypnoea'`; `export function vitalWarnings(row): VitalWarning[]` (fever ≥ 38.0 °C, hypoxia SpO₂ < 94, hypotension systolic < 90, tachycardia > 100, bradycardia < 50, tachypnoea > 24, hypertension ≥ 180/110, hypothermia < 35.0).
- `src/lib/queries/vitals.ts`: `recordVitals(admissionId: number, input: VitalsRequest, session: Session): Promise<{ ok: true; id: number } | { ok: false; error: 'not_found' | 'not_admitted' }>` (stores `patient_id`, `admission_id`, the IPD `encounter_id`); `listVitals(admissionId: number, sinceHours = 72, now?: Date): Promise<VitalReadingRow[]>`.
- `src/lib/queries/medication-round.ts`: `export interface RoundRow { medicationId: number; admissionId: number; patientName: string; uhid: string | null; bedLabel: string | null; medicationName: string; dose: string; scheduledFor: Date; status: 'scheduled' | 'given' | 'held' | 'refused'; overdue: boolean }`; `listMedicationRound(dateIso: string, ward: string | null, now?: Date): Promise<RoundRow[]>` (admitted patients only, IST day, `overdue` = scheduled and `scheduledFor < now − 30 min`).
- Routes: `GET|POST /api/inpatient/admissions/[id]/vitals` (`CLINICAL_ROLES`; audit `recorded vitals` / `viewed vitals`); `GET /api/inpatient/medication-round?date=YYYY-MM-DD&ward=` (`CLINICAL_ROLES`; date defaults to today IST).
- Page `/inpatient/nursing` (`CLINICAL_ROLES`, else redirect `/`): tabs "Medication round" (rows grouped by hour, Give/Hold/Refuse buttons shown for `pi`/`admin` and posting to the existing administer route) and "Vitals" (patient select from admitted patients, record form, `VitalsChart` recharts lines for BP, pulse, temperature, SpO₂, warning chips).

- [ ] **Step 1: Write failing tests**: schema refuses an empty reading, a temperature of 50, a future time; `toVitalsRow({ temperatureC: 38.4, weightKg: 62.5 })` → 384 / 62500; warnings for 38.4 °C and SpO₂ 91; round lists today's doses only for admitted patients, marks a 08:00 dose overdue at 08:45 IST and not at 08:20; vitals POST for a discharged admission → 409; gated (`frontdesk` 403); cascade: deleting the patient removes readings; page redirects `billing`, renders both tabs for `crc`, hides Give for `crc`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** + migration (run twice). **Step 4: Run** → PASS; harness rows.
- [ ] **Step 5: Commit** `feat(ipd): nursing station with today's medication round and a vitals chart`.

### Task 8 (Stream C): Analyte definitions, ranges and pure flagging

**Files:**
- Create: `scripts/migrations/2026-10-24-ws4-lab-analytes.sql`, `src/lib/labs/analytes.ts`, `src/lib/queries/lab-analytes.ts`, `src/app/api/lab-tests/[id]/analytes/route.ts`, `src/components/settings/LabAnalytesEditor.tsx`
- Modify: `src/db/schema.ts` (`// WS4 T8`: `labTestAnalytes`, `labAnalyteRanges`, `labResultValues`), `src/lib/labs/validation.ts` (append `analyteDefinitionsSchema`), `src/components/settings/LabTestSetupPanel.tsx` ("Analytes" button per test), `src/db/seed-india-data.ts` (`// WS4 T8`: `LAB_ANALYTE_SEED`), `src/db/seed-india.ts` (upsert analytes by test code), both RBAC harnesses
- Test: `tests/lib/labs/analytes.test.ts`, `tests/lib/queries/lab-analytes.test.ts`, `tests/api/lab-test-analytes.test.ts`, `tests/db/ws4-lab-analytes-schema.test.ts`

**Interfaces:**
- `src/lib/labs/analytes.ts` (pure, client-safe):
  - `export type AnalyteValueType = 'numeric' | 'option' | 'text'`
  - `export type Interpretation = 'N' | 'L' | 'H' | 'LL' | 'HH' | 'A' | 'AA'`
  - `export interface AnalyteDef { id: number; code: string; name: string; unit: string | null; valueType: AnalyteValueType; decimals: number | null; options: string[] | null; abnormalOptions: string[] | null; criticalOptions: string[] | null; ranges: AnalyteRange[] }`
  - `export interface AnalyteRange { sex: 'any' | 'male' | 'female'; ageMinDays: number; ageMaxDays: number | null; normalLow: number | null; normalHigh: number | null; criticalLow: number | null; criticalHigh: number | null; displayText: string | null }`
  - `export function selectRange(ranges: AnalyteRange[], sex: 'male' | 'female' | null, ageDays: number): AnalyteRange | null`
  - `export function rangeText(r: AnalyteRange | null, unit: string | null): string | null` (e.g. `"12.0-15.5 g/dL"`, `"<200"`, `"≥40"`)
  - `export function flagAnalyteValue(def: AnalyteDef, value: string, range: AnalyteRange | null): { flag: LabResultFlag; interpretation: Interpretation } | null` (null = no auto flag: comparator, text, no range, unparseable)
  - `export function worstFlag(flags: LabResultFlag[]): LabResultFlag`
  - `export function ageInDays(dobIso: string, onIso: string): number`
- `src/lib/queries/lab-analytes.ts`: `listAnalytesForTest(labTestId: number, opts?: { includeInactive?: boolean }): Promise<AnalyteDef[]>`; `listAnalytesForTests(labTestIds: number[]): Promise<Map<number, AnalyteDef[]>>`; `replaceAnalytesForTest(labTestId: number, defs: AnalyteDefinitionInput[], session: Session): Promise<{ ok: true } | { ok: false; error: 'not_found' }>` (upsert by `code`; an analyte dropped from the list is deactivated if it has `lab_result_values`, else deleted; ranges replaced).
- `analyteDefinitionsSchema`: strict array (≤ 40) of `{ code ^[A-Z][A-Z0-9_]{0,15}$, name 1..80, unit ≤ 20 | null, valueType, decimals 0..4 | null, loincCode ≤ 20 | null, options/abnormalOptions/criticalOptions string[] ≤ 20 | null, ranges: { sex, ageMinDays ≥0, ageMaxDays > ageMinDays | null, normalLow, normalHigh, criticalLow, criticalHigh (numbers | null, ordered criticalLow ≤ normalLow ≤ normalHigh ≤ criticalHigh where present), displayText ≤ 60 | null }[] ≤ 12 }`; codes unique.
- `GET /api/lab-tests/[id]/analytes` (`LAB_SETUP_ROLES` + `LAB_RESULT_ENTRY_ROLES`), `PUT` (`LAB_SETUP_ROLES`); audit `updated lab test analytes` (`test=<id> count=<n>`).
- Seed `LAB_ANALYTE_SEED: Record<testCode, AnalyteSeed[]>` for `CBC-DIFF` (HGB, WBC, NEUT, LYMPH, MONO, EOS, BASO, PLT, RBC, HCT, MCV, MCH, MCHC; sex-specific Hb/RBC/HCT; critical Hb < 7 or > 20 g/dL, PLT < 50 or > 1000 ×10³/µL, WBC < 2 or > 30 ×10³/µL), `LFT`, `KFT` (incl. K critical < 2.8 / > 6.2, Na < 120 / > 160), `LIPID`, `FBS` (critical < 50 / > 400 mg/dL), `CRP`, `TSH`, `HBA1C`, `DENGUE-NS1` (option Negative/Positive, abnormal Positive). Each test's analytes carry the note "Demo reference ranges: the laboratory director must review before clinical use" in the setup UI.

- [ ] **Step 1: Write failing tests** `analytes.test.ts`: female 30 y picks the female Hb range over `any`; a neonate band (0–28 days) beats an adult `any` band for a 10-day-old; Hb 6.5 → critical/LL, 6.99 → LL, 7.0 → abnormal/L (critical limits inclusive at the stated bound), 13.0 → normal/N, 21 → HH; `"<0.1"` → null; option `Positive` → abnormal/A; a `transgender` patient with only sex-specific ranges → `selectRange` null; `worstFlag(['normal','critical','abnormal'])` = critical; `rangeText` formats. Schema test: unique `(lab_test_id, code)`, cascade from analyte to ranges, `lab_result_values` unique `(lab_result_id, analyte_id)` and cascades from `lab_results`. Query test: replacing analytes keeps one with results as inactive. API: GET allowed for `labs`, PUT 403 for `labs`, 400 on unordered range bounds.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** + migration (run twice) + seed + editor (rows of analytes with a nested range table). **Step 4: Run** → PASS (+ `tests/db/seed-india-data.test.ts tests/lib/labs/validation.test.ts`); harness rows for GET and PUT.
- [ ] **Step 5: Commit** `feat(lab): analytes with age/sex reference ranges and automatic flagging rules`.

### Task 9 (Stream C): Per-analyte result entry

**Files:**
- Create: `src/lib/queries/lab-result-values.ts`
- Modify: `src/lib/labs/validation.ts` (`labResultSchema` becomes a union of today's single-value object and `{ analytes: { analyteId, value, flagOverride?: { flag, reason } }[], notes? }`), `src/lib/queries/lab-lifecycle.ts` (`recordLabResult` branches: analyte tests require analytes and write values + summary; single-value tests unchanged), `src/app/api/lab-orders/[id]/result/route.ts` (new 422 codes), `src/app/api/webhooks/fhir-labs/route.ts` (analyte test → 422 `analytes_required`), `src/lib/labs/route-responses.ts` (messages), `src/components/EnterLabResultModal.tsx` (analyte table), `src/components/LabWorklist.tsx` (passes analyte defs to the modal), `src/app/(dashboard)/labs/page.tsx` (loads `listAnalytesForTests`), `src/lib/queries/lab-orders.ts` (`WorklistRow.result.analytes`), `src/db/seed-india.ts` (CBC/LFT/KFT demo results entered per analyte), `src/lib/queries/hospital-kpis.ts` (invalidate `kpi:labs:<today>` after a result write; helper `invalidateLabKpis(now?: Date)`)
- Test: `tests/lib/queries/lab-result-values.test.ts`, `tests/api/lab-result-analytes.test.ts`, `tests/components/EnterLabResultModal.test.tsx`, `tests/lib/queries/lab-lifecycle.test.ts` (extend)

**Interfaces:**
- Request: `type AnalyteResultRequest = { analytes: { analyteId: number; value: string 1..60; flagOverride?: { flag: LabResultFlag; reason: string 5..200 } }[]; notes?: string ≤ 1000 }` (unique analyte ids, ≤ 40).
- `src/lib/queries/lab-result-values.ts`:
  - `export type AnalyteEntryError = 'analytes_required' | 'analyte_unknown' | 'analyte_missing' | 'flag_required' | 'flag_below_computed' | 'invalid_numeric'`
  - `export async function writeAnalyteResults(tx: WriteExecutor, i: { orderId: number; labResultId: number; patient: { dob: string; gender: string | null }; onDate: string; defs: AnalyteDef[]; entries: AnalyteResultRequest['analytes'] }): Promise<{ ok: true; summary: { value: string; unit: string | null; referenceRange: string | null; flag: LabResultFlag } } | { ok: false; error: AnalyteEntryError; analyteId?: number }>` (replaces the order's rows on amendment; every active analyte must be present).
  - `export interface AnalyteResultRow { analyteId: number; code: string; name: string; value: string; unit: string | null; referenceRange: string | null; flag: LabResultFlag; interpretation: Interpretation | null; flagSource: 'auto' | 'manual' }`; `listAnalyteResults(orderIds: number[]): Promise<Map<number, AnalyteResultRow[]>>`.
- `RecordLabResultResult` error union gains `AnalyteEntryError`; result `ok` gains `flag: LabResultFlag` (summary).
- Modal: one row per analyte (name, value input, unit, range text, live flag chip computed with `flagAnalyteValue` on the client); a computed flag can be raised (select + reason), never lowered; rows without auto flag require a flag; single-value tests keep today's form.

- [ ] **Step 1: Write failing tests**: CBC with all analytes for a female patient (dob 30 years before collection): Hb 6.5 and PLT 38 → two `critical` rows `LL`, summary row `flag 'critical'`, `value '13 analytes'`; one analyte missing → 422 `analyte_missing`, nothing written; lowering Hb to normal via override → 422 `flag_below_computed`; raising a normal WBC to abnormal with a reason → `flag_source 'manual'`; a text analyte with no flag → 422 `flag_required`; amendment replaces rows and `amendedAt` set; single-value body to a CBC → 422 `analytes_required`; analyte body to a test without analytes → 422 `analyte_unknown`; FHIR webhook for a CBC → 422 `analytes_required`; single-value tests behave exactly as before (existing `lab-lifecycle.test.ts` green). Modal: typing 6.5 for Hb shows "Critical low", the flag select offers only Critical for that row, submit posts `{ analytes: [...] }`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; update the seed's demo results to analyte bodies. **Step 4: Run** → PASS (+ `tests/api/lab-lifecycle-routes.test.ts tests/db/seed.test.ts tests/components/LabWorklist.stages.test.tsx`).
- [ ] **Step 5: Commit** `feat(lab): enter results per analyte with automatic abnormal and critical flags`.

### Task 10 (Stream C): Per-analyte report PDF, FHIR and chart display

**Files:**
- Modify: `src/lib/labs/report-data.ts` (`LabReportSource.orders[].result.analytes`, `LabReportData.rows[].analytes`, `cosigners`), `src/lib/labs/report-pdf.ts` (analyte sub-rows), `src/lib/queries/lab-reports.ts` (loader reads `listAnalyteResults`), `src/lib/fhir/observation.ts` (per-analyte Observations + panel with `hasMember`), `src/lib/queries/lab-orders.ts` (`PatientLabOrderRow.result.analytes`), `src/components/LabResultsSection.tsx` (expandable analyte table with flags), `tests/lib/labs/report-fixtures.ts`
- Test: `tests/lib/labs/report-data.test.ts`, `tests/lib/labs/report-pdf.test.ts`, `tests/lib/fhir/observation-mapping.test.ts` (extend all three), `tests/components/LabResultsSection.analytes.test.tsx`

**Interfaces:**
- `LabReportData.rows[]` gains `analytes: { name: string; value: string; unit: string | null; referenceRange: string | null; flagText: '' | 'LOW' | 'HIGH' | 'CRITICAL LOW' | 'CRITICAL HIGH' | 'ABNORMAL' | 'CRITICAL' }[]` and `cosignedBy: string[]`; `export function analyteFlagText(interpretation: Interpretation | null, flag: LabResultFlag): LabReportData['rows'][number]['analytes'][number]['flagText']`.
- `FhirObservation` gains `hasMember?: FhirReference[]`; `INTERPRETATION_CODE` covers `N L H LL HH A AA`; `export function observationsForOrder(patientId: string, order: PatientLabOrderRow, bindings: Map<string, CodeBinding>): FhirObservation[]` (`observationToFhir` remains for single-value orders); `observationsToFhir` flattens.

- [ ] **Step 1: Write failing tests**: report data for a CBC has one test row with 13 analyte rows in definition order and `CRITICAL LOW` on Hb; the PDF text extraction contains "Haemoglobin", "6.5", "12.0-15.5 g/dL", "CRITICAL LOW"; a single-value test renders as before (existing snapshot assertions green); FHIR for a CBC yields 14 resources: the panel `observation-<id>` with 13 `hasMember` and no value, and `observation-<id>-HGB` with `valueQuantity 6.5 g/dL` and interpretation `LL`; an analyte LOINC code present in a loaded LOINC version gains `system: 'http://loinc.org'`, else no system; chart section expands to the analyte table with a red "Critical" chip.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS (+ `tests/api/lab-reports-routes.test.ts tests/api/lab-reports-release-storage.test.ts tests/api/fhir-export-routes.test.ts`).
- [ ] **Step 5: Commit** `feat(lab): per-analyte rows with flags and ranges in the PDF report, FHIR and the chart`.

### Task 11 (Stream C): Verification by department, co-sign and acknowledgement

**Files:**
- Create: `src/lib/labs/verification.ts`, `src/lib/queries/lab-signoffs.ts`, `src/app/api/lab-orders/[id]/acknowledge/route.ts`, `src/app/api/lab-orders/[id]/cosign/route.ts`, `scripts/migrations/2026-10-24-ws4-lab-signoffs.sql`
- Modify: `src/db/schema.ts` (`// WS4 T11`: `labResultSignoffs`), `src/lib/role-policy.ts` (`LAB_VERIFY_ROLES = ['admin','labs','pi']`; `// WS4 T11`: `LAB_SIGNOFF_ROLES = ['pi','admin']`), `src/lib/queries/lab-lifecycle.ts` (`verifyLabResult` checks department), `src/lib/labs/route-responses.ts` (new codes), `src/lib/queries/lab-orders.ts` (`WorklistRow` + `testDepartmentId`, `resultedByUserId`), `src/components/LabWorklist.tsx` (Verify shown with the reason when unavailable), `src/app/(dashboard)/labs/page.tsx` (passes `verifierDepartmentId`, `userId`), `src/lib/queries/hospital-kpis.ts` (`resultsToVerify` → `resultsToReview`; `countResultsToVerifyForProvider` → `countResultsToReviewForProvider`), `src/lib/nav-badges.ts`, `src/app/(dashboard)/doctor/page.tsx` ("Results to review" with Acknowledge), `src/db/seed-india-data.ts` (`// WS4 T11`: radiologist provider in `RADIO` + `radiologist` demo user + staff link), `src/db/seed.ts` (`STAFF_SEED` row for the radiologist), `src/db/seed-india.ts` (imaging verified by the radiologist), `tests/pages/doctor.test.tsx`, `tests/api/nav-badges.test.ts`, both RBAC harnesses
- Test: `tests/lib/labs/verification.test.ts`, `tests/lib/queries/lab-signoffs.test.ts`, `tests/api/lab-verify-department.test.ts`, `tests/components/LabWorklist.verify.test.tsx`

**Interfaces:**
- `src/lib/labs/verification.ts` (pure): `export type VerifyDenial = 'not_resulted' | 'not_linked' | 'wrong_department' | 'self_verification'`; `export function verificationDenial(i: { status: LabOrderStatus; verifierDepartmentId: number | null; testDepartmentId: number | null; verifierUserId: number | null; resultedByUserId: number | null }): VerifyDenial | null`; `export const VERIFY_DENIAL_MESSAGE: Record<VerifyDenial, string>` (`not_linked`: "Verification needs a pathologist or reporting specialist account linked to a provider. Settings → Staff.").
- `src/lib/queries/lab-signoffs.ts`: `export async function resolveVerifierDepartmentId(session: Session): Promise<number | null>` (via `resolveSessionProvider` only); `export async function signOffLabResult(orderId: number, kind: 'acknowledge' | 'cosign', i: { note: string | null; typedName?: string }, session: Session, now?: Date): Promise<{ ok: true } | { ok: false; error: 'not_found' | 'not_verified' | 'not_owner' | 'name_mismatch' | 'already_signed' }>` (owner = resolved provider is the ordering provider or the attending of the patient's active admission; `acknowledge` allowed on `resulted|verified|reported`, `cosign` on `verified|reported`); `listSignoffs(orderIds: number[]): Promise<Map<number, SignoffRow[]>>`.
- `verifyLabResult` error union gains `'not_linked' | 'wrong_department'` (test department = `service_catalog.department_id` of the order's test).
- Routes `POST /api/lab-orders/[id]/acknowledge` body `{ note?: string ≤ 300 }`, `POST /api/lab-orders/[id]/cosign` body `{ typedName: string 1..120, note?: string ≤ 300 }` (`LAB_SIGNOFF_ROLES`); 409 `already_signed`, 403 `not_owner`/`name_mismatch`; audit `acknowledged lab result` / `co-signed lab result`.

- [ ] **Step 1: Write failing tests**: pure denial table (pathologist on a LAB test → null; same user who entered → `self_verification`; general physician → `wrong_department`; unlinked lab tech → `not_linked`; `received` → `not_resulted`); route: the seeded pathologist (labs role, linked to LAB) verifies a CBC (200); an ordering `pi` in GEN_MED verifying the same → 403 `wrong_department`; `admin` without a link → 403 `not_linked`; imaging verified by the radiologist; acknowledge by the ordering doctor → 201, by another doctor → 403, twice → 409; co-sign before verification → 409 `not_verified`, with a wrong typed name → 403; doctor home lists verified, unacknowledged results on own orders under "Results to review" and the nav badge counts them; worklist shows a disabled Verify with the `not_linked` message for a lab tech.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** + migration (run twice) + seed changes. **Step 4: Run** → PASS (+ `tests/lib/queries/lab-lifecycle.test.ts tests/api/lab-lifecycle-routes.test.ts tests/db/seed.test.ts tests/lib/nav-badges.test.ts`); harness: update the verify row's allowed roles, add both new rows.
- [ ] **Step 5: Commit** `feat(lab): pathologist verification by department, doctor acknowledgement and co-sign`.

### Task 12 (Stream C): Critical-value workflow and the Critical tile

**Files:**
- Create: `scripts/migrations/2026-10-24-ws4-critical-alerts.sql`, `src/lib/queries/lab-critical.ts`, `src/app/api/lab-orders/[id]/critical/notify/route.ts`, `src/app/api/lab-orders/[id]/critical/acknowledge/route.ts`, `src/components/labs/CriticalResultBanner.tsx`
- Modify: `src/db/schema.ts` (`// WS4 T12`: `labCriticalAlerts`), `src/lib/queries/lab-lifecycle.ts` (`recordLabResult` calls `raiseOrWithdrawCriticalAlert`; `verifyLabResult` refuses `critical_not_notified`), `src/lib/queries/hospital-kpis.ts` (`LabKpi.criticalOpen`; invalidate after notify/ack/verify), `src/app/(dashboard)/labs/page.tsx` (tile "Critical open", sub "N today"; banner), `src/components/LabResultsSection.tsx` and `src/app/(dashboard)/doctor/page.tsx` (banner), `src/lib/queries/staff-notifications.ts` (`lab_critical` reads unacknowledged alerts), `src/lib/role-policy.ts` (`// WS4 T12`: `LAB_CRITICAL_NOTIFY_ROLES = ['admin','labs','pi']`, `LAB_CRITICAL_ACK_ROLES = ['admin','pi']`), both RBAC harnesses
- Test: `tests/lib/queries/lab-critical.test.ts`, `tests/api/lab-critical-routes.test.ts`, `tests/components/CriticalResultBanner.test.tsx`, `tests/pages/labs-home.test.tsx` (extend), `tests/lib/queries/staff-notifications.test.ts` (extend)

**Interfaces:**
- `src/lib/queries/lab-critical.ts`:
  - `export type CriticalAlertStatus = 'open' | 'notified' | 'acknowledged' | 'withdrawn'`
  - `export interface CriticalAlertRow { orderId: number; patientId: string; patientName: string; uhid: string | null; testName: string; summary: string; status: CriticalAlertStatus; raisedAt: string; notifiedAt: string | null; notifiedByName: string | null; notifiedToName: string | null; notifyChannel: 'phone' | 'in_person' | 'in_app' | null; readBack: boolean | null; acknowledgedAt: string | null; acknowledgedByName: string | null; orderedByProviderId: number }`
  - `export async function raiseOrWithdrawCriticalAlert(tx: WriteExecutor, i: { orderId: number; patientId: string; flag: LabResultFlag; summary: string }, now: Date): Promise<'raised' | 'withdrawn' | 'unchanged'>` (summary = critical analytes as "Platelets 38 ×10³/µL; Haemoglobin 6.5 g/dL", or the single value)
  - `export async function logCriticalNotification(orderId: number, i: { notifiedToName: string; channel: 'phone' | 'in_person' | 'in_app'; readBack: boolean }, session: Session, now?: Date): Promise<{ ok: true } | { ok: false; error: 'not_found' | 'not_open' | 'read_back_required' }>` (phone requires `readBack: true`)
  - `export async function acknowledgeCriticalAlert(orderId: number, note: string | null, session: Session, now?: Date): Promise<{ ok: true } | { ok: false; error: 'not_found' | 'not_owner' | 'already_acknowledged' | 'withdrawn' }>` (also writes an `acknowledge` signoff from Task 11)
  - `export async function listOpenCriticalAlerts(filter: { patientId?: string; providerId?: number }): Promise<CriticalAlertRow[]>`
- Routes: `POST /api/lab-orders/[id]/critical/notify` body `{ notifiedToName: 1..120, channel, readBack: boolean }` (`LAB_CRITICAL_NOTIFY_ROLES`; a `pi` must be allowed to verify that order); `POST /api/lab-orders/[id]/critical/acknowledge` body `{ note?: ≤ 300 }` (`LAB_CRITICAL_ACK_ROLES` + ownership). Audit `logged critical result call` / `acknowledged critical result` (ids only).
- `CriticalResultBanner({ alerts, canNotify, canAcknowledge }: { alerts: CriticalAlertRow[]; canNotify: boolean; canAcknowledge: (a: CriticalAlertRow) => boolean })`: per alert "CRITICAL · Platelets 38 ×10³/µL · Ravi K (UH000…)", the log line "Notified Dr Rao at 10:42 by Meenakshi Sundar (phone, read back)", and the Notify / Acknowledge action.
- `LabKpi` gains `criticalOpen: number` (status `open|notified`); `export async function invalidateLabKpis(now?: Date): Promise<void>` deletes `hospitalKpiCacheKey('labs', todayIso)`.

- [ ] **Step 1: Write failing tests**: entering a critical CBC raises one `open` alert; amending to non-critical withdraws it; amending a critical again does not duplicate (unique per order); verify while `open` → 409 `critical_not_notified`; notify by phone without read-back → 422; notify → `notified` with name/time/channel; verify then succeeds; acknowledge by the ordering doctor → `acknowledged` and an `acknowledge` signoff exists; by another doctor → 403; `loadLabKpis` counts `criticalOpen` 1 → 0 after acknowledgement and `invalidateLabKpis` removes the cached key (mock cache); labs page tile shows the open count; staff feed drops the item after acknowledgement; banner renders the log line and hides Acknowledge for `labs`; routes gated (`frontdesk` 403).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** + migration (run twice). **Step 4: Run** → PASS (+ `tests/lib/queries/lab-lifecycle.test.ts tests/pages/doctor.test.tsx tests/pages/labs-home.test.tsx`); harness rows.
- [ ] **Step 5: Commit** `feat(lab): critical-value call log, doctor acknowledgement, banner and a live Critical tile`.

### Task 13 (Stream D): Catalogue from the tariff master

**Files:**
- Create: `src/lib/queries/lab-catalogue.ts`, `src/app/api/lab-tests/from-tariff/route.ts`
- Modify: `src/lib/labs/catalog.ts` (append `labCategoryForService`), `src/components/settings/LabTestSetupPanel.tsx` ("Add from tariff" section), `src/components/OrderLabTestModal.tsx` (search box; groups "Laboratory" and "Imaging & diagnostics"), `src/db/seed-india-data.ts` (`// WS4 T13`: `WS4_SERVICE_SEED`, `WS4_LAB_TESTS`), `src/db/seed-india.ts` (upsert them, map every test), both RBAC harnesses
- Test: `tests/lib/labs/catalog.test.ts` (extend), `tests/lib/queries/lab-catalogue.test.ts`, `tests/api/lab-tests-from-tariff.test.ts`, `tests/components/OrderLabTestModal.test.tsx` (extend), `tests/db/seed-india-data.test.ts` (extend)

**Interfaces:**
- `export function labCategoryForService(category: ServiceCategory, opts?: { allowProcedure?: boolean }): 'lab' | 'imaging' | null` (`investigation_lab → lab`, `investigation_imaging → imaging`, `procedure → imaging` only with `allowProcedure`, else null).
- `src/lib/queries/lab-catalogue.ts`: `export interface TariffTestCandidate { serviceId: number; code: string; name: string; category: 'investigation_lab' | 'investigation_imaging' | 'procedure'; departmentName: string; basePaise: number | null }`; `listTariffServicesWithoutTest(): Promise<TariffTestCandidate[]>` (active services in those categories with no `lab_tests.service_id`); `createLabTestsFromServices(serviceIds: number[], session: Session): Promise<{ ok: true; created: { id: number; code: string; name: string }[] } | { ok: false; error: 'service_not_found' | 'service_inactive' | 'already_has_test' | 'category_not_orderable'; serviceId: number }>` (all-or-nothing, one transaction, `code` = service code, `name` = service name, `isActive` true, `service_id` set; audit `created lab tests from tariff` with count).
- `GET /api/lab-tests/from-tariff` → `{ candidates }`; `POST` body `{ serviceIds: number[] 1..50 unique }` strict (`LAB_SETUP_ROLES`).
- Seed services (all `departmentCode` LAB unless noted, GST 0, SAC 999316): `LAB_FEVER_PANEL` (₹1,200), `LAB_WIDAL`, `LAB_ESR`, `LAB_ELECTROLYTES`, `LAB_PT_INR`, `LAB_BLOOD_GROUP`, `LAB_URINE_CULTURE`; RADIO: `IMG_USG_PELVIS`, `IMG_USG_KUB`, `IMG_USG_OBS`, `IMG_DOPPLER_LL`, `IMG_CT_CHEST`, `IMG_MRI_BRAIN` and `IMG_MRI_LSPINE` (`requiresPreauth`); CARDIO: `IMG_TMT`; plus tests for those and for the existing `IMG_ECHO` and `PROC_ECG` (ECG as imaging). Prices are demo values.

- [ ] **Step 1: Write failing tests**: `labCategoryForService('procedure')` → null, with `allowProcedure` → imaging; candidates exclude services that already have a test and inactive services; creating from `PROC_ECG` without it being a candidate-allowed procedure succeeds only when the admin picks it (route passes `allowProcedure: true` for explicitly chosen ids) and the test is orderable (price gate from Foundations T10 passes); a service already mapped → `already_has_test` and nothing created; route gated (`labs` 403); seed: every `WS4_LAB_TESTS` entry maps to a seeded service and ≥ 40 tests exist; order dialog filters by typed text and shows MRI and ECG under "Imaging & diagnostics".
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS (+ `tests/api/lab-order-price-gate.test.ts tests/api/lab-setup-routes.test.ts`); harness rows for GET and POST.
- [ ] **Step 5: Commit** `feat(lab): build the test catalogue from the tariff master; panels, ECG, echo, MRI and ultrasound`.

### Task 14 (Stream D): Order priority, clinical notes, fasting and home-collection booking

**Files:**
- Create: `scripts/migrations/2026-10-24-ws4-order-priority.sql`
- Modify: `src/db/schema.ts` (`lab_requisitions` + `priority`, `clinicalNotes`, `fastingNote`; `lab_tests` + `fastingRequired`, inside `// WS4 T14`), `src/lib/labs/validation.ts` (multi-test schema gains `priority`, `clinicalNotes`, `fastingNote`; `labTestSetupSchema` gains `fastingRequired`), `src/lib/queries/lab-requisitions.ts` (stores them), `src/app/api/patients/[anonId]/lab-orders/route.ts` (passes them through; no other change: Foundations T9 owns its notice call), `src/lib/queries/lab-orders.ts` (`WorklistRow.priority`, `clinicalNotes`, `fastingNote`; `listWorklist` orders STAT → urgent → routine, then `orderedAt`), `src/components/LabWorklist.tsx` (priority badge and notes in the row header only), `src/components/OrderLabTestModal.tsx` (priority radio, clinical notes, fasting note prefilled "Fasting 8–12 hours" when a chosen test has `fastingRequired`; after success, "Book home collection" when `patientIsLocal && includesLabTest` and the role may book), `src/components/home-collection/BookHomeCollectionModal.tsx` (optional `initial?: { patientId: string; labOrderIds: number[] }` pre-fills the lookup and selection), `src/lib/role-policy.ts` (`// WS4 T14`: `HOME_COLLECTION_ORDERING_ROLES = [...HOME_COLLECTION_BOOKING_ROLES, 'pi']`), `src/app/api/home-collections/route.ts`, `src/app/api/home-collections/context/route.ts`, `src/app/api/home-collections/availability/route.ts` (use the new constant), `src/components/settings/LabTestSetupPanel.tsx` (fasting checkbox), `src/db/seed-india.ts` (FBS, lipid flagged fasting), both RBAC harnesses (three rows now allow `pi`)
- Test: `tests/api/lab-requisition-route.test.ts` (extend), `tests/lib/queries/lab-orders-priority.test.ts`, `tests/components/OrderLabTestModal.test.tsx` (extend), `tests/components/BookHomeCollectionModal.initial.test.tsx`, `tests/db/ws4-order-priority-schema.test.ts`

**Interfaces:**
- `export const LAB_PRIORITIES = ['routine', 'urgent', 'stat'] as const` (in `src/lib/labs/catalog.ts`); `CreateLabRequisitionRequest` gains `priority: LabPriority; clinicalNotes: string | null; fastingNote: string | null` (legacy `{ labTestId }` body → `routine`, nulls).
- Schema check `lab_requisitions_priority_valid` (`priority IN ('routine','urgent','stat')`), lengths 1000 / 200.
- `BookHomeCollectionModal({ date, onClose, initial }: { date: string; onClose: () => void; initial?: { patientId: string; labOrderIds: number[] } })`.

- [ ] **Step 1: Write failing tests**: posting `{ labTestIds, priority: 'stat', clinicalNotes, fastingNote }` stores them; an unknown key or `priority: 'asap'` → 400; legacy body still 201 with `routine`; worklist puts a later STAT order before an earlier routine one; the modal sends priority/notes, pre-fills the fasting note for FBS, shows "Book home collection" for a local patient with a lab test and not for imaging-only or non-local; clicking it opens the booking dialog with the patient and the new order ids selected; `pi` may POST `/api/home-collections` and GET context/availability, the `/home-collections` page still redirects `pi`; migration re-runs cleanly and the check refuses `'asap'`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** + migration (run twice). **Step 4: Run** → PASS (+ `tests/api/home-collections-routes.test.ts tests/pages/home-collections.test.tsx`); harness updates.
- [ ] **Step 5: Commit** `feat(lab): order priority, clinical notes, fasting and a Book home collection shortcut`.

---

## Integration after merge (controller, on `feat/hospital-completion`)

- [ ] Merge streams in order A, B, C, D; resolve append-point conflicts by keeping both blocks; run all migrations twice on the test DB.
- [ ] Seed the fever panel's analytes (C's `LAB_ANALYTE_SEED` gains `LAB_FEVER_PANEL`: Hb, WBC, PLT, malaria antigen, dengue NS1, Widal; D created the test). Commit `feat(lab): fever panel analytes`.
- [ ] `source $SCRATCH/testenv.sh && npx vitest run` → all green; `npx tsc --noEmit`; `npm run lint`.
- [ ] Docker walkthrough on a copy of `.env.docker` (`BLOB_DRIVER=local`): admit a female patient (planned, ICD-10 diagnosis, policy, ₹10,000 deposit) and see the male-ward bed refused, then overridden with a reason; no token slip; second admission refused; open OPD prompt shown; bed board shows Day N and tariff, and Transfer/Discharge/MAR/Charges work; nursing round charts a dose and vitals plot; discharge blocked by dues, cleared by billing, discharged with coded diagnosis and MAR drugs; order a CBC (STAT, fasting note) and book home collection; enter Hb 6.5 / PLT 38 → critical banner, call logged, pathologist verifies, doctor acknowledges, Critical tile falls; release the report and open the PDF with analyte rows; FHIR export shows panel + analyte Observations. Tick the gap-closure plan's C1–C4, B4, E1–E2, A6–A7, I2 and commit `docs: inpatient and lab sub-project verified`.
