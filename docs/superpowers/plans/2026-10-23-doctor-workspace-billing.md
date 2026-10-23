# Doctor Workspace and Automatic Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A doctor runs a whole OPD consultation on one page (`/encounters/[id]`), and every billable event (registration, consultation, test, procedure, dispensed medicine) becomes a priced charge line automatically, so a finished visit becomes one GST invoice with one action.

**Architecture:** The encounter (SP3) is the workspace; clinical rows hang off `encounters.id`. Every automatic charge goes through one seam, `captureAutoChargeInTx`, a refactor of SP4 `captureChargeLine` that runs inside the caller's transaction and never blocks the clinical act. Pharmacy prices come from a GST-inclusive MRP on the medication master. Pure modules (dose pattern, allergy matcher, vitals, visit-charge plan, MRP split, ready-line grouping, bill summary) carry the rules and are unit-tested; DB route tests cover the rest. Every new route follows the repo pattern: `requireSession`, inline role allowlist (constants from `src/lib/role-policy.ts`), strict Zod body, audit entry, rows in both RBAC harnesses.

**Tech Stack:** Next.js 16 App Router (**read `node_modules/next/dist/docs/` before touching routing, params or caching**: route `params` are a `Promise`, as in every existing `[id]` route), TypeScript, Drizzle + Postgres, Vitest, Zod 4, React client components with the existing UI kit.

**Spec:** `docs/superpowers/specs/2026-10-23-doctor-workspace-billing-design.md` (rulings 1–14 are binding). Findings: `docs/superpowers/plans/2026-10-23-gap-closure-plan.md` sections A, B, J, WS1, WS2.

## Streams (run in parallel in separate git worktrees)

| Stream | Tasks | Theme | Owns these existing files exclusively |
|---|---|---|---|
| **0** (serial, first) | T1 | Shared seams: ownership helper, role constants, enum values | `src/lib/role-policy.ts` (only T1 edits it) |
| **A** | T2 → T3 → T4 → T5 | Clinical workspace (WS1) | `src/app/(dashboard)/doctor/page.tsx`, `src/components/DoctorScheduleTimeline.tsx`, `src/components/follow-ups/EncounterList.tsx`, `src/components/NoteForm.tsx`, `src/lib/queries/encounter-notes.ts`, `src/app/api/encounters/[id]/status/route.ts`, notes routes |
| **B** | T6 → T7 → T8 | Prescribing and pharmacy billing (WS1 Rx + WS2 pharmacy) | `src/lib/queries/prescriptions.ts`, `src/app/api/patients/[anonId]/prescriptions/*`, `src/components/AddPrescriptionModal.tsx`, `src/app/prescriptions/print/page.tsx`, `src/lib/queries/medication-dispenses.ts`, pharmacy routes/components |
| **C** | T9 → T10 → T11 → T12 → T13 | Automatic charges, orders, invoicing, discharge (WS2) | `src/lib/queries/charge-capture.ts`, `src/lib/queries/encounters.ts`, `src/lib/queries/providers.ts`, `src/lib/queries/lab-requisitions.ts`, `src/lib/queries/lab-lifecycle.ts`, `src/lib/labs/validation.ts`, `src/components/OrderLabTestModal.tsx`, `src/components/CheckInModal.tsx`, `src/components/home-collection/BookHomeCollectionModal.tsx`, discharge route/modal, billing pages |
| **final** (serial, after A, B, C merge) | T14 | Mount panels, end-to-end acceptance, walkthrough | — |

Branch each stream from `feat/hospital-completion` **after T1 is merged**. Merge order A, B, C, then T14. Within a stream, tasks run in order in the same worktree.

**Shared files every stream appends to (conflict rules):**
- `src/db/schema.ts`: each task appends its tables/columns inside its own block near the end of the file, after `// end Foundations T11`, delimited `// WS1 Tn …` / `// end WS1 Tn` (or `WS2`). New columns on existing tables are declared on the existing table with a trailing `// WS1 Tn` comment on each line; keep them as the last columns of that table. On merge keep both blocks.
- `src/lib/queries/patients.ts` `deletePatientRows`: each task adds its deletes in a `// WS1 Tn` block placed immediately after the `hasNhcxExchanges` check line (children before parents); exception T6, whose `prescriptions` delete goes right after the existing `medicationEpisodes` delete. On merge keep both blocks.
- `tests/api/rbac-route-gates.test.ts`: imports appended at the end of the import block with `// WS1 Tn` comments; gate rows appended at the **end of `API_GATES`**; deny-before-parse rows (every POST/PUT/PATCH with a body) appended at the **end of `SP8_WRITE_GATES`**. `tests/pages/page-gates-harness.ts`: rows appended at the **end of `PAGE_GATES`**.
- `src/db/seed-india.ts`: each task's change in a `// WS2 Tn` block in the function it touches.
- `src/lib/queries/hospital-kpis.ts`: T8 edits only `getPharmacyKpis`; T12 edits only `loadBillingQueue`; T3 edits only `getDoctorWorkload`.
- Migrations: uniquely named `scripts/migrations/2026-10-24-ws1-<topic>.sql` / `2026-10-24-ws2-<topic>.sql`, each `BEGIN; … COMMIT;`, re-runnable (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `DO $$ … $$` guards for constraints). Enum values live only in the `-0-enum-values` files (T1), which sort first.

## Global Constraints

- Tests run **only** against the isolated database: `source $SCRATCH/testenv.sh` (DB `hims_test`). Never `.env.local`, never the demo DB `hims`, never a cloud DB. `tests/db/seed.test.ts` truncates its database.
- Never commit `.env*` values, secrets, `data/`, code-set content or generated files.
- Never log or return a secret, a provider error body, a file path or a blob URL. Log error class names and pg error codes only. Audit details carry ids, codes and amounts only: never vitals values, history/notes text, reasons, allergy text or drug names.
- Money is integer paise (`int4` unit prices capped at `MAX_AMOUNT_PAISE`, `bigint` computed amounts); GST per SP4 ruling 5 (`lineTax`, half-up per line, no round-off line). Time is IST (`istDateOf`, `todayIsoIn`); business dates are IST dates.
- Ids shown to users are **UHID**, never chart ids (`patients.id`). URLs may carry the chart id or encounter id; visible text never shows the chart id.
- Schema: edit `src/db/schema.ts` and add a re-runnable, checksummed migration in `scripts/migrations/`. Never edit an applied migration. Never `db:push`. After each migration task run `npm run db:migrate` on the test DB and `db:schema-diff` against a from-empty DB.
- Every new route: `requireSession()` first, inline `if (!ROLES.includes(session.role)) return 403 {"error":"Forbidden"}` before parsing, strict Zod body, `logAudit`, a row in `API_GATES` and (for bodies) `SP8_WRITE_GATES`; every new page: `requireSessionOrRedirect` + role check + `PAGE_GATES` row.
- Route handler `params` are `Promise<…>` (Next 16); read the docs in `node_modules/next/dist/docs/` before adding a page, a dynamic segment or anything cached.
- Existing behaviour stays intact with `ENABLE_TRIALS=true` (Vitest default from `vitest.config.ts`); add flag-off cases with `vi.stubEnv('ENABLE_TRIALS', '')`.
- Charge-side locks: in visit transactions the patient billing lock (`lockPatientBilling`) is taken **last**; no billing path locks an `encounters` row. Automatic capture never throws for a business reason and never aborts its caller's transaction (check existence under the lock before inserting; the unique index is only a backstop).
- Each task ends with its tests passing, `npx tsc --noEmit` clean, `npm run lint` clean on touched files, and one commit on the stream branch.

## Review Focus

- Double-click / retry: two check-ins, two Complete clicks, two dispenses or two lab submits never create a second consultation, registration, lab or pharmacy line.
- A `pi` cannot write vitals/diagnoses/Rx/orders/complete on another doctor's encounter; `crc` can record vitals and allergies but nothing else.
- Cancelling a visit or order whose line is on a **finalised** invoice: visit cancel refused with the invoice number; order cancel succeeds and reports `credit_note_needed`; nothing on a finalised invoice changes.
- Pharmacy line total never exceeds MRP × quantity; an unpriced or expired medicine cannot be dispensed with a charge.
- A check-in, lab order or dispense still succeeds when billing cannot price it; the outcome says why and the item appears under "Orders not billed".
- `ENABLE_TRIALS` off: doctor home has no trial columns or "Principal Investigator"; on: today's panel unchanged.

---

### Task 1 (Stream 0): Shared seams — encounter ownership, role constants, enum values

**Files:**
- Create: `src/lib/encounters/ownership.ts`, `scripts/migrations/2026-10-24-ws1-0-enum-values.sql`, `scripts/migrations/2026-10-24-ws2-0-enum-values.sql`
- Modify: `src/db/schema.ts` (`signableTypeEnum` + `'encounter_note'` last; `chargeLineSourceEnum` + `'registration', 'consultation', 'lab_order', 'procedure'` last), `src/lib/role-policy.ts` (block `// WS1/WS2 roles` at the end of the file; add `'pi'` to `HOME_COLLECTION_BOOKING_ROLES`), `tests/lib/role-policy.test.ts` / `tests/lib/sp5-role-policy.test.ts` if they pin those arrays
- Test: `tests/lib/encounters/ownership.test.ts`, `tests/lib/ws-role-policy.test.ts`

**Interfaces:**
- Produces (role-policy):
  `WORKSPACE_READ_ROLES = ['admin','pi','crc']`, `CLINICAL_WRITE_ROLES = ['admin','pi']`, `VITALS_ROLES = ['admin','pi','crc']`, `ALLERGY_WRITE_ROLES = ['admin','pi','crc']`, `PRESCRIBE_ROLES = ['admin','pi']`, `MEDICATION_SEARCH_ROLES = ['admin','pi','pharmacy']`, `DISPENSE_ROLES = ['admin','pi','pharmacy']`, `MEDICATION_PRICE_ROLES = ['admin','pharmacy']`, `INVOICE_READY_ROLES = CHARGE_CAPTURE_ROLES`, `BILL_SUMMARY_ROLES = ['admin','pi','billing']` (all `readonly Role[]`).
- Produces (`src/lib/encounters/ownership.ts`):
  ```ts
  export function parseEncounterId(raw: string): number | null            // /^\d+$/, 1..2147483647
  export type EncounterWriteCheck =
    | { ok: true; encounter: EncounterRow; actingProviderId: number | null }
    | { ok: false; status: 403 | 404 | 409; body: { error: string; code?: 'not_owner' | 'visit_closed' } }
  export async function checkEncounterWriter(
    session: Session, encounterId: number,
    opts?: { allowCrc?: boolean; allowClosed?: boolean },
  ): Promise<EncounterWriteCheck>
  ```
  Rules: `admin` any encounter; `pi` only when `resolveDoctorQueueProvider(session)?.id === encounter.providerId` (else 403 `not_owner`; no linked profile → 403); `crc` only with `allowCrc`; other roles 403; missing → 404 `{"error":"Not found"}`; status `completed`/`cancelled` → 409 `visit_closed` unless `allowClosed`.
- Enum SQL: `ALTER TYPE signable_type ADD VALUE IF NOT EXISTS 'encounter_note' AFTER 'form_submission_consent';` and `ALTER TYPE charge_line_source ADD VALUE IF NOT EXISTS 'registration' AFTER 'pharmacy';` then `'consultation' AFTER 'registration'`, `'lab_order' AFTER 'consultation'`, `'procedure' AFTER 'lab_order'`. Only `ADD VALUE` lines in these files (Postgres forbids using a new value in the adding transaction; later files use them).

- [ ] **Step 1: Write failing tests**: `parseEncounterId('12')` → 12, `('0')`, `('-1')`, `('1e3')`, `('2147483648')` → null; with a mocked DB: admin passes on any encounter; pi with matching provider passes, `actingProviderId` set; pi on another doctor's encounter → `{status:403, body.code:'not_owner'}`; crc → 403 unless `allowCrc`; frontdesk → 403; cancelled encounter → 409 `visit_closed`, passes with `allowClosed`; unknown id → 404. Role test: each new constant equals the arrays above and `HOME_COLLECTION_BOOKING_ROLES` contains `'pi'`.
- [ ] **Step 2: Run** `npx vitest run tests/lib/encounters/ownership.test.ts tests/lib/ws-role-policy.test.ts` → FAIL.
- [ ] **Step 3: Implement**; edit the enum arrays so their order equals the migration result.
- [ ] **Step 4: Run** the tests → PASS; `npm run db:migrate` on the test DB twice (second run is a no-op); `db:schema-diff` clean; `npx vitest run tests/api/rbac-route-gates.test.ts tests/lib/role-policy.test.ts` → PASS (home-collection rows now allow `pi`).
- [ ] **Step 5: Commit** `feat(ws1): encounter ownership helper, workspace roles, enum values`.

---

### Task 2 (Stream A): Vitals and consultation record

**Files:**
- Create: `src/lib/encounters/vitals.ts` (pure), `src/lib/encounters/consult-validation.ts`, `src/lib/queries/encounter-clinical.ts`, `src/app/api/encounters/[id]/vitals/route.ts`, `src/app/api/encounters/[id]/consult/route.ts`, `src/components/encounters/VitalsForm.tsx`, `src/components/encounters/ConsultForm.tsx`, `scripts/migrations/2026-10-24-ws1-vitals-consult.sql`
- Modify: `src/db/schema.ts` (block `// WS1 T2`: `encounterVitals`, `encounterConsults`), `src/lib/queries/patients.ts` (`deletePatientRows`, block `// WS1 T2`), both RBAC harnesses
- Test: `tests/lib/encounters/vitals.test.ts`, `tests/api/encounter-vitals-consult.test.ts`, `tests/components/encounters/VitalsForm.test.tsx`

**Interfaces:**
- Tables: `encounter_vitals(id serial, encounter_id int not null FK encounters, patient_id text not null FK patients, recorded_at timestamp default now, recorded_by_name text not null, recorded_by_user_id int FK users, systolic_mmhg, diastolic_mmhg, pulse_bpm, temp_deci_c, spo2_pct, resp_rate, weight_g, height_mm int null)`, checks: each range below, `diastolic < systolic` when both, at least one measurement non-null; index on `encounter_id`. `encounter_consults(id serial, encounter_id int not null unique FK, patient_id text not null FK, chief_complaint, history_present_illness, past_history, family_history, personal_history, examination, advice, no_diagnosis_reason text null (each check char_length ≤ 4000; reason ≤ 300), updated_at timestamp not null, updated_by_name text not null)`.
- Pure (`src/lib/encounters/vitals.ts`):
  ```ts
  export interface VitalsInput { systolicMmhg?: number; diastolicMmhg?: number; pulseBpm?: number; tempC?: number; spo2Pct?: number; respRate?: number; weightKg?: number; heightCm?: number }
  export const vitalsInputSchema: z.ZodType<VitalsInput>   // strict; ranges: systolic 50–300, diastolic 20–200 and < systolic, pulse 20–250, temp 30.0–45.0 (≤1 decimal), SpO2 50–100, resp 4–80, weight 0.3–400 (≤3 decimals), height 30–250 (≤1 decimal); at least one field
  export function toVitalsColumns(i: VitalsInput): { systolicMmhg: number|null; diastolicMmhg: number|null; pulseBpm: number|null; tempDeciC: number|null; spo2Pct: number|null; respRate: number|null; weightG: number|null; heightMm: number|null }
  export function bmiTenths(weightG: number | null, heightMm: number | null): number | null
  export type VitalsFlag = 'bp_high' | 'bp_low' | 'fever' | 'spo2_low' | 'tachycardia' | 'bradycardia'
  export function vitalsFlags(v: ReturnType<typeof toVitalsColumns>): VitalsFlag[]   // ≥140/90, <90 systolic, ≥38.0 °C, <94 %, >100, <50
  ```
- Consult schema (`consult-validation.ts`): `consultPatchSchema` strict, every field optional `string.trim().max(4000)` or `null`, at least one key.
- Queries:
  ```ts
  export async function addVitals(encounter: EncounterRow, input: VitalsInput, session: Session): Promise<EncounterVitalsRow>
  export async function listVitals(encounterId: number): Promise<EncounterVitalsRow[]>              // newest first
  export async function upsertConsult(encounter: EncounterRow, patch: ConsultPatch, session: Session): Promise<EncounterConsultRow>
  export async function getConsult(encounterId: number): Promise<EncounterConsultRow | null>
  export interface PriorConsult { encounterId: number; encounterDate: string; providerName: string; chiefComplaint: string | null; diagnoses: string[] }
  export async function priorConsults(patientId: string, beforeEncounterId: number, limit?: number): Promise<PriorConsult[]>   // default 5, completed encounters only
  ```
- Routes: `POST /api/encounters/[id]/vitals` (`VITALS_ROLES`; `checkEncounterWriter(…, { allowCrc: true })`) → 201 `{ vitals: { …columns, bmiTenths, flags } }`; `PUT /api/encounters/[id]/consult` (`CLINICAL_WRITE_ROLES`) → 200 `{ consult }`. Audit `recorded vitals` / `updated consultation record` with `encounter=<id>` only.

- [ ] **Step 1: Write failing tests**: `bmiTenths(70000, 1750)` → 229; `bmiTenths(null, 1750)` → null; `toVitalsColumns({ tempC: 37.4, weightKg: 70.25, heightCm: 175.5 })` → `tempDeciC 374, weightG 70250, heightMm 1755`; schema rejects `{}`, diastolic ≥ systolic, SpO2 101, temp 37.45, unknown key; `vitalsFlags` for 150/95 → `['bp_high']`. Route (DB): crc records vitals on any open encounter (201, row has `recorded_by_name`); pi on own encounter 201, on another doctor's 403; frontdesk 403; completed encounter 409; audit detail contains no measurement value; consult PUT upserts (second PUT updates the same row, `encounter_id` unique); `deletePatient` removes both tables' rows.
- [ ] **Step 2: Run** `npx vitest run tests/lib/encounters/vitals.test.ts tests/api/encounter-vitals-consult.test.ts` → FAIL.
- [ ] **Step 3: Implement** schema, migration, queries, routes; `VitalsForm` (BP as two inputs, °C/°F toggle converting to °C client-side, live BMI, flag chips) and `ConsultForm` (autosave on blur via PUT, "Saved" state). Add harness rows.
- [ ] **Step 4: Run** tests, `npm run db:migrate` (twice), `db:schema-diff`, harness tests → PASS.
- [ ] **Step 5: Commit** `feat(ws1): encounter vitals and consultation record`.

### Task 3 (Stream A): Workspace page, Start Encounter, allergies, hospital-first doctor home

**Files:**
- Create: `src/app/(dashboard)/encounters/[id]/page.tsx`, `src/components/encounters/WorkspaceShell.tsx` (client; tabs Vitals / History / Diagnosis / Rx / Orders / Notes; sticky footer slot), `src/components/encounters/PatientStrip.tsx`, `src/components/encounters/StartEncounterButton.tsx`, `src/components/encounters/AllergyEditor.tsx`, `src/lib/queries/encounter-workspace.ts`, `src/lib/queries/allergies.ts`, `src/app/api/encounters/[id]/start/route.ts`, `src/app/api/patients/[anonId]/allergies/route.ts` (POST), `src/app/api/patients/[anonId]/allergies/[id]/route.ts` (PATCH: inactivate), `src/app/api/patients/[anonId]/allergy-status/route.ts` (PUT), `scripts/migrations/2026-10-24-ws1-allergies.sql`
- Modify: `src/db/schema.ts` (`patients.allergy_status` text default `'unknown'` check in (`unknown`,`none_known`,`recorded`); `allergies.recorded_by_name`, `recorded_at`, `inactivated_at`, all `// WS1 T3`), `src/app/(dashboard)/doctor/page.tsx`, `src/components/DoctorScheduleTimeline.tsx`, `src/lib/queries/hospital-kpis.ts` (`getDoctorWorkload` only: each `encountersToday` row gains `encounterId`, already present as `id` — link target changes), both RBAC harnesses
- Test: `tests/api/encounter-start.test.ts`, `tests/api/patient-allergies.test.ts`, `tests/pages/encounter-workspace.test.tsx`, `tests/pages/doctor-home-hospital.test.tsx`

**Interfaces:**
```ts
export interface WorkspaceView {
  encounter: { id: number; status: EncounterStatus; encounterType: EncounterType; visitType: EncounterVisitType; encounterDate: string; opdToken: number | null; departmentName: string | null; providerId: number; providerName: string; checkedInAt: Date }
  patient: { id: string; uhid: string | null; name: string; ageYears: number | null; sex: string | null; phone: string | null; payerName: string | null;
             allergyStatus: 'unknown' | 'none_known' | 'recorded'; allergies: { id: number; allergen: string; reaction: string | null; severity: 'mild'|'moderate'|'severe' }[];
             alerts: ('allergy_status_unknown' | 'currently_admitted')[] }
  vitals: (EncounterVitalsRow & { bmiTenths: number | null; flags: VitalsFlag[] })[]
  consult: EncounterConsultRow | null
  history: PriorConsult[]
  canWrite: boolean          // CLINICAL_WRITE_ROLES and (admin or own encounter) and status open
  canRecordVitals: boolean
}
export async function getWorkspace(encounterId: number, session: Session): Promise<WorkspaceView | null>
export async function startConsultation(encounterId: number, session: Session, actingProviderId: number | null):
  Promise<{ ok: true; status: 'in_consultation'; changed: boolean } | { ok: false; error: 'not_found' | 'not_owner' | 'invalid_transition' }>
export async function encountersForAppointments(appointmentIds: number[]): Promise<Map<number, { encounterId: number; status: EncounterStatus }>>
export async function listMyRecentPatients(providerId: number, sinceIso: string): Promise<PatientRow[]>  // distinct patients from this provider's encounters/admissions since date, PatientsTable hospitalView shape
// allergies
export const addAllergySchema = z.object({ allergen: z.string().trim().min(2).max(120), reaction: z.string().trim().max(200).optional(), severity: z.enum(['mild','moderate','severe']) }).strict()
export async function addAllergy(patientId: string, input: AddAllergy, session: Session): Promise<AllergyRow>          // sets allergy_status='recorded'
export async function inactivateAllergy(patientId: string, allergyId: number, session: Session): Promise<boolean>
export async function setAllergyStatus(patientId: string, status: 'none_known' | 'unknown', session: Session): Promise<'ok' | 'has_active_allergies'>
```
- `startConsultation`: `checked_in` → calls existing `transitionEncounter(id, 'in_consultation', session, { actingProviderId })`; already `in_consultation` → `{ ok:true, changed:false }` (idempotent); `completed`/`cancelled` → `invalid_transition`.
- `POST /api/encounters/[id]/start` (`CLINICAL_WRITE_ROLES`, empty strict body `{}` or no body) → 200 `{ status, changed }`; 403/404/409 mapped.
- Page `/encounters/[id]`: `requireSessionOrRedirect`; roles `WORKSPACE_READ_ROLES` else redirect to role home; `notFound()` for a missing encounter. GET never mutates: a `checked_in` encounter shows a "Start consultation" button (StartEncounterButton). Until T14, the Rx tab mounts the existing `AddPrescriptionModal` (unchanged props), Orders tab the existing `OrderLabTestModal` (unchanged props), Notes tab the existing `NoteForm`. Do not edit those three components here (owned by streams B, C and T5).
- Doctor home: `DoctorScheduleTimeline` rows receive `{ encounterId: number | null; encounterStatus: EncounterStatus | null; uhid: string | null }`; shows `StartEncounterButton` (POST then `router.push('/encounters/<id>')`) when checked in, "Continue" link when in consultation, a muted "Awaiting check-in" chip when no encounter; patient text shows UHID, not chart id. "Today's OPD" rows link to `/encounters/<id>`. With `trialsEnabled()` false: panel title "My patients (last 90 days)" from `listMyRecentPatients`, `PatientsTable hospitalView`, header subtitle "Consultant · <department>"; with it true the current panel and "Principal Investigator" remain.

- [ ] **Step 1: Write failing tests**: start: checked_in → 200 `changed:true` and DB status `in_consultation`; repeat → 200 `changed:false`; other doctor → 403; frontdesk → 403; cancelled → 409; GET of the page for a checked_in encounter leaves status unchanged. Allergies: crc adds → 201, patient `allergy_status='recorded'`; `none_known` while an active allergy exists → 409; inactivate → 200 and list excludes it; audit has no allergen text. Page: renders strip with UHID (not chart id), allergy chips, "Allergy status not recorded" alert, six tabs; labs role is redirected. Doctor home flag off: no "Principal Investigator", no "Meets"/screening column, Start Encounter button targets the encounter; appointment without encounter shows "Awaiting check-in"; flag on: trial panel still rendered.
- [ ] **Step 2: Run** `npx vitest run tests/api/encounter-start.test.ts tests/api/patient-allergies.test.ts tests/pages/encounter-workspace.test.tsx tests/pages/doctor-home-hospital.test.tsx` → FAIL.
- [ ] **Step 3: Implement**; add `PAGE_GATES` row `{ route: '/encounters/[id]', …, allowed: [...WORKSPACE_READ_ROLES] }`, API rows for the four routes.
- [ ] **Step 4: Run** tests + `npx vitest run tests/pages tests/api/rbac-route-gates.test.ts` → PASS; migrate twice; schema-diff.
- [ ] **Step 5: Commit** `feat(ws1): consultation workspace page, Start Encounter, allergies, hospital-first doctor home`.

### Task 4 (Stream A): Diagnoses, problem list, referral, follow-up and advice

**Files:**
- Create: `src/lib/encounters/diagnosis-validation.ts`, `src/lib/queries/encounter-diagnoses.ts`, `src/lib/queries/referrals.ts`, `src/app/api/encounters/[id]/diagnoses/route.ts` (POST), `src/app/api/encounters/[id]/diagnoses/[diagnosisId]/route.ts` (PATCH, DELETE), `src/app/api/encounters/[id]/referrals/route.ts` (POST), `src/components/encounters/DiagnosisPicker.tsx`, `src/components/encounters/ProblemList.tsx`, `src/components/encounters/ReferralForm.tsx`, `src/components/encounters/FollowUpAdvice.tsx`, `scripts/migrations/2026-10-24-ws1-diagnoses-referrals.sql`
- Modify: `src/db/schema.ts` (`diagnoses.on_problem_list boolean default false not null // WS1 T4`; block `// WS1 T4`: `referrals`), `src/lib/queries/patients.ts` (`deletePatientRows`: referrals), `src/components/encounters/WorkspaceShell.tsx` (Diagnosis tab), `src/app/(dashboard)/doctor/page.tsx` ("Referred to me" list), both RBAC harnesses
- Test: `tests/api/encounter-diagnoses.test.ts`, `tests/api/encounter-referrals.test.ts`, `tests/components/encounters/DiagnosisPicker.test.tsx`

**Interfaces:**
```ts
export const addDiagnosisSchema = z.object({
  codeId: z.number().int().positive().optional(),
  text: z.string().trim().min(2).max(300).optional(),
  diagnosisType: z.enum(['primary', 'secondary', 'provisional']),
  onProblemList: z.boolean().optional(),
}).strict().refine((b) => b.codeId !== undefined || b.text !== undefined, { message: 'Choose a code or type a diagnosis' })
export const patchDiagnosisSchema = z.object({ diagnosisType: z.enum(['primary','secondary','provisional']).optional(), onProblemList: z.boolean().optional() }).strict()
export type DiagnosisError = 'code_not_current' | 'coding_locked' | 'primary_exists' | 'not_found'
export async function addEncounterDiagnosis(encounter: EncounterRow, input: AddDiagnosis, session: Session): Promise<{ ok: true; diagnosis: DiagnosisRow } | { ok: false; error: DiagnosisError }>
export async function updateEncounterDiagnosis(encounter: EncounterRow, diagnosisId: number, patch: PatchDiagnosis, session: Session): Promise<{ ok: true } | { ok: false; error: DiagnosisError }>
export async function voidEncounterDiagnosis(encounter: EncounterRow, diagnosisId: number, session: Session): Promise<{ ok: true } | { ok: false; error: DiagnosisError }>
export async function listEncounterDiagnoses(encounterId: number): Promise<DiagnosisRow[]>   // live only
export async function listProblemList(patientId: string): Promise<{ id: number; label: string; code: string | null; since: string | null }[]>
export const referralSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('internal'), toDepartmentId: z.number().int().positive().optional(), toProviderId: z.number().int().positive().optional(), reason: z.string().trim().min(5).max(1000), urgency: z.enum(['routine','urgent','emergency']) }).strict(),
  z.object({ kind: z.literal('external'), externalFacility: z.string().trim().min(2).max(200), externalDoctor: z.string().trim().max(120).optional(), reason: z.string().trim().min(5).max(1000), urgency: z.enum(['routine','urgent','emergency']) }).strict(),
])
export async function createReferral(encounter: EncounterRow, input: ReferralInput, session: Session): Promise<ReferralRow>
export async function listOpenReferralsToProvider(providerId: number, departmentId: number | null): Promise<{ id: number; patientId: string; patientName: string; uhid: string | null; fromProviderName: string; urgency: string; createdAt: Date }[]>
```
- Coded add: `getCodesByIds([codeId])`; must be kind `icd10`, not sample, and `findCurrentCode('icd10', detail.code)?.id === codeId`, else `code_not_current` (422). Writes `diagnoses { patientId, encounterId, codeId, codeSystemKind:'icd10', code: detail.code, codeDisplay: detail.display, description: detail.display, diagnosisType, codingStatus:'proposed', proposedByName, proposedAt, createdByName, createdAt, date: encounterDate, onProblemList }`. Free text: `code:''`, `codingStatus:'uncoded'`, `description: text`. `encounter_coding.status` in (`coded`,`finalised`) → `coding_locked` (409). Unique violation `diagnoses_one_primary_per_encounter` → `primary_exists` (409). Void = SP6 soft void (`voidedAt`, `voidedByName`).
- `referrals` table per spec §4 (check: internal ⇒ `to_department_id` or `to_provider_id` not null; external ⇒ `external_facility` not null).
- `FollowUpAdvice` posts to the existing `POST /api/follow-ups` with `source: 'encounter'`, `originatingEncounterId` (already in `src/lib/follow-ups/validation.ts`) and saves advice through `PUT /api/encounters/[id]/consult` (T2). The picker calls `GET /api/coding/codes?kind=icd10&q=…` (`CODE_LOOKUP_ROLES` already includes `pi`) and shows "WHO ICD-10 (2019)".

- [ ] **Step 1: Write failing tests**: coded add → 201, row `coding_status='proposed'`, `code` equals the code value; sample-version code → 422 `code_not_current`; free text → `uncoded`, `code=''`; second primary → 409 `primary_exists`; after the encounter's coding is `coded` → 409 `coding_locked`; PATCH `onProblemList:true` makes it appear in `listProblemList`; DELETE voids (not deleted) and frees the primary slot; other doctor 403; referral internal without department/provider → 400; external → 201; `listOpenReferralsToProvider` lists it for the target doctor; audit has no diagnosis text or reason. Picker: typing "fev" calls the codes route with `kind=icd10`, renders attribution.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; migrate twice; schema-diff; harness.
- [ ] **Step 5: Commit** `feat(ws1): diagnoses with ICD-10 picker, problem list, referrals, follow-up and advice`.

### Task 5 (Stream A): Complete visit, signed notes, visit actions in the workspace

**Files:**
- Create: `src/app/api/encounters/[id]/complete/route.ts`, `src/components/encounters/CompleteVisitBar.tsx`, `scripts/migrations/2026-10-24-ws1-notes-encounter.sql`
- Modify: `src/lib/queries/encounter-workspace.ts` (`completeEncounter`), `src/app/api/encounters/[id]/status/route.ts` (`to:'completed'` delegates to `completeEncounter` with no reason), `src/db/schema.ts` (`encounterNotes.encounterId` FK nullable `// WS1 T5`), `src/lib/queries/encounter-notes.ts` (`signNote` new signature; `createNote` accepts `encounterId`), `src/app/api/patients/[anonId]/notes/route.ts` (optional `encounterId`, must belong to the patient), `src/app/api/patients/[anonId]/notes/[id]/sign/route.ts` (strict body), `src/components/NoteForm.tsx` (sign dialog: typed name + attestation checkbox, same layout as `DischargeAdmissionModal`; optional `encounterId` prop), `src/components/follow-ups/EncounterList.tsx` (admin/pi see "Open workspace" instead of Start/Complete; Cancel stays for its roles), `tests/api/encounter-status.test.ts`, `tests/api/patient-notes.test.ts`, both RBAC harnesses
- Test: `tests/api/encounter-complete.test.ts`, `tests/api/note-sign-attestation.test.ts`, `tests/components/encounters/CompleteVisitBar.test.tsx`

**Interfaces:**
```ts
export const NOTE_ATTESTATION = 'I attest that this note is accurate and that I wrote or reviewed it.'
export const noteSignSchema = z.object({ typedName: z.string().trim().min(1).max(120), attestation: z.literal(true) }).strict()
export async function signNote(noteId: number, patientId: string, input: { typedName: string; session: Session }):
  Promise<{ ok: true; signatureId: number } | { ok: false; error: 'Note not found' | 'Note is already signed' | 'Only the author can sign' | 'Typed name does not match' }>
export const completeEncounterSchema = z.object({ noDiagnosisReason: z.string().trim().min(5).max(300).optional() }).strict()
export type CompleteEncounterResult =
  | { ok: true; encounter: EncounterRow; warnings: ('no_vitals' | 'unsigned_notes')[] }
  | { ok: false; error: 'not_found' | 'not_owner' | 'invalid_transition' | 'diagnosis_missing' }
export async function completeEncounter(encounterId: number, session: Session, opts: { noDiagnosisReason?: string; actingProviderId: number | null }): Promise<CompleteEncounterResult>
```
- `completeEncounter`: OPD with zero live diagnoses and no reason → `diagnosis_missing`; with a reason → upsert `encounter_consults.no_diagnosis_reason` (before the transition; harmless if the transition then fails); then `transitionEncounter(id, 'completed', session, { actingProviderId })` unchanged. `ipd` and `lab` encounters skip the diagnosis guard. Warnings: no vitals row; any draft note linked to the encounter.
- `POST /api/encounters/[id]/complete` (`CLINICAL_WRITE_ROLES`) → 200 `{ encounter, warnings }`; 409 `{ error: 'Add a diagnosis or give a reason before completing the visit.', code: 'diagnosis_missing' }`.
- Sign: `typedName !== session.name && role !== 'admin'` → 403 `Typed name does not match`; writes `signatures { signableType:'encounter_note', signableId, signerTypedName, signerRole, attestationText: NOTE_ATTESTATION }` and sets the note `signed`, both in one transaction. A body-less PUT is now 400.
- `CompleteVisitBar` (sticky): "Complete visit" → POST; on `diagnosis_missing` opens a dialog "No diagnosis recorded" with "Add diagnosis" (jumps to the tab) or a reason field; shows warnings as a toast with "Sign note" link.

- [ ] **Step 1: Write failing tests**: OPD with no diagnosis → 409 `diagnosis_missing`, status unchanged; with reason → 200 `completed`, reason stored, audit has no reason text; with a diagnosis → 200; warnings list `no_vitals` when none; other doctor 403; IPD encounter not guarded; status route `to:'completed'` on an OPD encounter with no diagnosis → 409 (update `encounter-status.test.ts` fixtures to add a diagnosis where they complete); note sign without body → 400; wrong typed name → 403; correct → 200 with one `signatures` row of type `encounter_note`; second sign → 409; EncounterList for pi shows "Open workspace" linking `/encounters/<id>`, not "Complete visit".
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS, plus `npx vitest run tests/api tests/components/follow-ups` for regressions; migrate twice; schema-diff.
- [ ] **Step 5: Commit** `feat(ws1): complete visit with diagnosis prompt; typed-name attestation for notes; visit actions in the workspace`.

---

### Task 6 (Stream B): Prescriptions v2: multi-drug, dose pattern, mandatory dose, allergy check

**Files:**
- Create: `src/lib/prescriptions/dose-pattern.ts`, `src/lib/prescriptions/allergy-check.ts`, `src/lib/prescriptions/validation.ts`, `src/app/api/encounters/[id]/prescriptions/route.ts` (POST), `src/app/api/medications/search/route.ts` (GET), `scripts/migrations/2026-10-24-ws1-prescriptions-v2.sql`
- Modify: `src/db/schema.ts` (block `// WS1 T6`: `prescriptions`; `medicationEpisodes` + `prescriptionId, dosePattern, route, foodTiming, isSos, quantityPrescribed, allergyOverrideReason` each `// WS1 T6`), `src/lib/queries/prescriptions.ts` (`createPrescriptionSet`), `src/app/api/patients/[anonId]/prescriptions/route.ts` (dose required; optional `dosePattern` overriding `frequencyPerDay`), `src/lib/queries/patients.ts` (delete `prescriptions` right after the `medicationEpisodes` delete), `tests/api/patients-prescriptions.test.ts`, both RBAC harnesses
- Test: `tests/lib/prescriptions/dose-pattern.test.ts`, `tests/lib/prescriptions/allergy-check.test.ts`, `tests/api/encounter-prescriptions.test.ts`

**Interfaces:**
```ts
export interface DosePattern { slots: number[]; perDay: number; label: string }
export function parseDosePattern(raw: string): DosePattern | null
export function prescribedQuantity(i: { pattern: DosePattern | null; frequencyPerDay: number | null; durationDays: number; form: 'tablet'|'capsule'|'liquid'|'injection'|'other'; isSos: boolean }): number | null
export interface DrugIdentity { name: string; genericName: string | null; medicationClass: string | null }
export interface AllergyInput { allergen: string; severity: 'mild' | 'moderate' | 'severe' }
export interface AllergyConflict { allergen: string; severity: AllergyInput['severity']; matchedOn: 'name' | 'generic' | 'class' | 'cross_reactivity' }
export function allergyConflicts(drug: DrugIdentity, allergies: AllergyInput[]): AllergyConflict[]
export const ROUTES = ['oral','iv','im','sc','topical','inhaled','sublingual','rectal','vaginal','eye','ear','nasal','other'] as const
export const FOOD_TIMINGS = ['before_food','after_food','with_food','any'] as const
export const prescriptionItemSchema = z.object({
  medicationId: z.number().int().positive().nullable(), name: z.string().trim().min(1).max(200), genericName: z.string().trim().max(200).optional(),
  medicationClass: z.string().trim().min(1).max(100), dose: z.string().trim().min(1).max(100),
  dosePattern: z.string().trim().max(20).optional(), frequencyPerDay: z.number().int().min(1).max(6).optional(), isSos: z.boolean().default(false),
  durationDays: z.number().int().min(1).max(365), route: z.enum(ROUTES), foodTiming: z.enum(FOOD_TIMINGS).optional(),
  instructions: z.string().trim().max(500).optional(), allergyOverrideReason: z.string().trim().min(5).max(300).optional(),
}).strict()   // refine: valid dosePattern, or frequencyPerDay, or isSos
export const createPrescriptionSetSchema = z.object({ items: z.array(prescriptionItemSchema).min(1).max(15), advice: z.string().trim().max(1000).optional() }).strict()
export async function createPrescriptionSet(i: { encounter: EncounterRow; prescribedByProviderId: number; advice: string | null; items: PrescriptionItem[] }, session: Session):
  Promise<{ ok: true; prescriptionId: number; episodeIds: number[] }
        | { ok: false; error: 'allergy_conflict'; conflicts: { index: number; conflicts: AllergyConflict[] }[] }
        | { ok: false; error: 'medication_not_found'; index: number }>
```
- `parseDosePattern`: 3 or 4 dash-separated slots, each `0`, `1`, `2`, `½` or `0.5`; `perDay` = number of non-zero slots; `'1-0-1'` → `{ slots:[1,0,1], perDay:2 }`; `'1-1-1-1'` → 4; `'½-0-½'` → 2; null for `'1-0'`, `'3-0-1'`, `''`, `'1-0-1-1-1'`, `'a-b-c'`.
- `prescribedQuantity`: tablet/capsule → `ceil(sum(slots) × durationDays)` (pattern) or `frequencyPerDay × durationDays`; liquid/injection/other or SOS → null. `'1-0-1'`, 5 days → 10; `'½-0-½'`, 5 days → 5.
- `allergyConflicts`: case-insensitive whole-token match of allergen against name, generic, class; plus cross-reactivity table (spec ruling 9). "Penicillin" allergy vs Amoxicillin → `cross_reactivity`; "Sulfa" vs Co-trimoxazole (generic sulfamethoxazole) → match; "Peanut" vs Paracetamol → none.
- Each episode: `frequencyPerDay` = pattern `perDay` (or given, or null for SOS), `quantityPrescribed`, `status:'active'`, `prescribedAt` now, `startDate` = encounter date; all in one transaction with the header. Conflict without `allergyOverrideReason` → 422, nothing written. Audit `wrote prescription` with `prescription=<id> items=<n> overrides=<k>`.
- `GET /api/medications/search?q=` (`MEDICATION_SEARCH_ROLES`, q 2–60 chars) → `{ items: { id, name, genericName, medicationClass, form, commonDose, inStock: boolean }[] }` (≤ 20).

- [ ] **Step 1: Write failing tests** for the pure modules (cases above) and the route: 3 drugs in one call → one `prescriptions` row, 3 episodes with the header id and `frequency_per_day` 2/3/null; missing dose → 400; conflict → 422 listing the item index, no rows; with override → 201 and reason stored; other doctor 403; legacy patient route without dose → 400 (update `patients-prescriptions.test.ts`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; migrate twice; schema-diff; harness rows.
- [ ] **Step 5: Commit** `feat(rx): multi-drug prescriptions with 1-0-1 dose patterns, mandatory dose and allergy check`.

### Task 7 (Stream B): Rx builder and printed prescription

**Files:**
- Create: `src/components/encounters/RxBuilder.tsx`
- Modify: `src/components/AddPrescriptionModal.tsx` (dose required, pattern chips, sends `dosePattern`), `src/lib/queries/prescriptions.ts` (`getPrintablePrescriptions` adds `genericName` via the medication, `dosePattern`, `route`, `foodTiming`, `isSos`, `quantityPrescribed`, header `advice`), `src/app/prescriptions/print/page.tsx`
- Test: `tests/components/encounters/RxBuilder.test.tsx`, `tests/components/AddPrescriptionModal.test.tsx` (extend or create), `tests/lib/queries/printable-prescriptions.test.ts`

**Interfaces:**
- Consumes: T6 route and search route, `parseDosePattern`, `prescribedQuantity`, `allergyConflicts` (client-side preview; the server stays authoritative).
- Produces: `export function RxBuilder(props: { encounterId: number; patientAllergies: AllergyInput[]; allergyStatus: 'unknown'|'none_known'|'recorded'; canWrite: boolean; onSaved?: (prescriptionId: number) => void }): JSX.Element`.
- UI: rows with drug search (shows generic under brand), dose (required), pattern chips `1-0-0`, `0-0-1`, `1-0-1`, `1-1-1`, `1-1-1-1`, `SOS` plus free pattern, days, route, food timing, computed quantity; red banner per conflicting row with an override reason input; amber banner when allergy status unknown; "Save prescription" posts once; success toast with "Print" link `/prescriptions/print?ids=…`. Print shows `1-0-1 (morning, night) × 5 days, after food`, generic name, advice and the doctor's registration line.

- [ ] **Step 1: Write failing tests**: choosing `1-0-1` and 5 days shows quantity 10; Save disabled until every row has a dose; a penicillin-allergic patient + amoxicillin shows the conflict banner and Save stays disabled until a reason is typed; 422 from the server maps the conflict onto the row; print data for a v2 row includes pattern, generic and advice; legacy row (no pattern) still prints.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(rx): Rx builder with pattern chips, allergy banner and printable slip`.

### Task 8 (Stream B): Medicine prices and dispense that bills itself

**Files:**
- Create: `src/lib/billing/pharmacy-price.ts`, `src/app/api/pharmacy/medications/[id]/price/route.ts` (PATCH), `src/components/MedicationPriceEditor.tsx`, `scripts/migrations/2026-10-24-ws2-pharmacy-billing.sql`
- Modify: `src/db/schema.ts` (`medications` + `mrpPerUnitPaise`, `gstRateBp`, `hsn`; `medicationDispenses` + `batchNo`, `expiryMonth`, `noChargeReason`, `unitMrpPaise`, each `// WS2 T8`, checks: mrp 0..1e9, gst in allowed slabs, `expiry_month ~ '^\d{4}-(0[1-9]|1[0-2])$'`), `src/lib/queries/medication-dispenses.ts` (`dispenseMedication` bills in its transaction; `createChargeForDispense` → `billLegacyDispense`; `listAllDispensesWithBilling` reads `charge_lines`), `src/app/api/pharmacy/dispense/route.ts` (`DISPENSE_ROLES`, new body), `src/app/api/pharmacy/dispenses/[dispenseId]/charge/route.ts` (strict empty body; bills a legacy unbilled dispense at current MRP), `src/components/DispenseMedicationModal.tsx`, `src/components/PharmacyPatientLookup.tsx` (passes episode quantity/allergies), `src/components/PharmacyBillingTable.tsx` (status from charge lines; "Bill at current price" for legacy rows), `src/app/(dashboard)/pharmacy/billing/page.tsx`, `src/app/(dashboard)/pharmacy/page.tsx` (price column + editor), `src/lib/queries/hospital-kpis.ts` (`getPharmacyKpis` only: unbilled = no live line and no `no_charge_reason`), `src/db/seed-india.ts` (`// WS2 T8`: MRP for every seeded formulary item), `tests/api/pharmacy-dispense.test.ts`, `tests/api/pharmacy-dispense-charge.test.ts`, `tests/components/DispenseMedicationModal.test.tsx`
- Delete: `src/components/LogDispenseBillModal.tsx`
- Test: `tests/lib/billing/pharmacy-price.test.ts`, `tests/api/pharmacy-dispense-billing.test.ts`

**Interfaces:**
```ts
export function pharmacyLinePrice(i: { mrpPerUnitPaise: number; quantity: number; gstRateBp: number }):
  { unitPricePaise: number; taxablePaise: number; gstPaise: number; totalPaise: number }
// unitPricePaise = largest u with u*q + max(lineTax(u*q, r, 'intra').total, lineTax(u*q, r, 'inter').total) <= mrp*q
export const dispenseSchema = z.object({
  patientId: z.string().min(1).max(40), medicationId: z.number().int().positive(), medicationEpisodeId: z.number().int().positive().optional(),
  quantity: z.number().int().min(1).max(1000), notes: z.string().trim().max(300).optional(),
  batchNo: z.string().trim().min(1).max(30).optional(), expiryMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  noChargeReason: z.string().trim().min(5).max(200).optional(), allergyAcknowledged: z.boolean().default(false),
}).strict()
export type DispenseError = 'unknown_patient' | 'unknown_medication' | 'episode_mismatch' | 'not_enough_stock' | 'medication_unpriced' | 'batch_required' | 'batch_expired' | 'allergy_conflict'
export type DispenseResult =
  | { ok: true; dispenseId: number; charge: { lineId: number; quantity: number; unitMrpPaise: number; totalPaise: number } | null }
  | { ok: false; error: DispenseError; conflicts?: AllergyConflict[] }
export async function dispenseMedication(input: DispenseInput, session: Session, now?: Date): Promise<DispenseResult>
export async function billLegacyDispense(dispenseId: number, session: Session): Promise<{ ok: true; lineId: number } | { ok: false; error: 'not_found' | 'already_billed' | 'medication_unpriced' }>
export const medicationPriceSchema = z.object({ mrpPerUnitPaise: z.number().int().min(0).max(1_000_000_000), gstRateBp: z.union([z.literal(0), z.literal(500), z.literal(1200), z.literal(1800), z.literal(2800), z.literal(4000)]).nullable().optional(), hsn: z.string().regex(/^\d{4,8}$/).nullable().optional() }).strict()
```
- Dispense transaction: stock decrement (existing guard) → dispense row (with batch/expiry/mrp snapshot) → unless `noChargeReason`: `lockPatientBilling`, then one `charge_lines` row `source:'pharmacy', priceSource:'pharmacy', serviceId:null, itemCode: 'MED-<id>', itemName: '<name> (Batch <b>, Exp <MM/YYYY>)', quantity, unitPricePaise, taxablePaise, gstRateBp: med.gstRateBp ?? settings.pharmacyGstRateBp, hsnSac: med.hsn ?? settings.pharmacyHsn, medicationDispenseId`, context: active admission (existing rule) else the episode's `prescriptions.encounter_id` when that encounter is OPD and not cancelled, else none. No legacy `charges` row, no diagnosis, no `J3490`. Expiry month earlier than the IST current month → `batch_expired`; charged dispense without batch/expiry → `batch_required`; `mrpPerUnitPaise` null → `medication_unpriced` (422); allergy conflict (T6 matcher against active allergies) without `allergyAcknowledged` → 409 with conflicts. Audit `dispensed medication` with `dispense=<id> line=<id|none>`.
- Route 201 body: `{ id, charge, message: 'Dispensed 15 tablets. ₹42.00 added to the bill.' }` (formatted with the existing `formatPaise`).
- Modal: quantity pre-filled from `quantityPrescribed` (or `prescribedQuantity`), unit MRP × qty, GST included, total; allergy banner with an acknowledge checkbox; batch and expiry inputs; on success a toast with the message and "Bill now" → `/cash-desk?patientId=<id>`.

- [ ] **Step 1: Write failing tests**: `pharmacyLinePrice({ mrp: 350, q: 15, gst: 1200 })` total ≤ 5250 and > 5250 − 17; property loop over mrp 1..2000, q 1..50, every slab: total ≤ mrp×q and mrp×q − total < q + 2. Route (DB): prescription-linked dispense on an OPD visit creates one line with that `encounter_id`; inpatient → `admission_id`; unpriced → 422 and stock unchanged; expired → 422; no batch → 422; `noChargeReason` → 201, `charge:null`, not counted as unbilled; allergy conflict → 409 then 201 with `allergyAcknowledged`; double POST of the same dispense payload creates two dispenses only if stock allows (each has its own line; unique `medication_dispense_id` holds); legacy route bills an old dispense once, second call 409; no `J3490` string remains in `src/` (grep test); price PATCH by billing role → 403, by pharmacy → 200 with audit `old→new` amounts only.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS (update the two existing pharmacy tests to the new body/errors); migrate twice; schema-diff; harness rows for the PATCH route and changed bodies.
- [ ] **Step 5: Commit** `feat(pharmacy): MRP-based GST billing on dispense, batch/expiry snapshot, quantity prefill and confirmation`.

---

### Task 9 (Stream C): Automatic charge seam; consultation and registration fees

**Files:**
- Create: `src/lib/billing/visit-charges.ts` (pure), `src/lib/queries/auto-charge.ts`, `src/app/api/front-desk/check-in/fee-preview/route.ts` (GET), `scripts/migrations/2026-10-24-ws2-auto-charges.sql`
- Modify: `src/db/schema.ts` (`chargeLines` + `labOrderId` FK unique, `encounterProcedureId` FK unique, the two partial unique indexes from the spec; `billingSettings` + `registrationServiceId` FK, `freeReviewDays` int default 0 check 0..30; all `// WS2 T9`), `src/lib/queries/charge-capture.ts` (extract `captureInTx`; `captureChargeLine` keeps its signature and behaviour), `src/lib/queries/providers.ts` (export `consultationServiceIdFor`; `currentConsultationRates` uses it), `src/lib/queries/encounters.ts` (`checkInVisit` captures visit charges; `transitionEncounter` ensures consultation on `completed`, voids auto lines on `cancelled`), `src/app/api/front-desk/check-in/route.ts` (response `charges`), `src/app/api/encounters/[id]/status/route.ts` is **not** touched (Stream A owns it; `visit_billed` maps through `transitionEncounter`'s error union — add the mapping in T14), `src/lib/queries/billing-settings.ts`, `src/app/api/billing/settings/route.ts`, `src/components/billing/BillingSettingsForm.tsx`, `src/components/CheckInModal.tsx`, `src/db/seed-india.ts` (`// WS2 T9`: set `registration_service_id` to `REG_FEE`), both RBAC harnesses
- Test: `tests/lib/billing/visit-charges.test.ts`, `tests/api/auto-charge-visit.test.ts`, `tests/components/CheckInModal.test.tsx` (extend)

**Interfaces:**
```ts
export type AutoChargeSource = 'registration' | 'consultation' | 'lab_order' | 'procedure'
export interface AutoChargeInput { context: ChargeContextRef; serviceId: number; quantity: number; serviceDate: string; source: AutoChargeSource; links?: { labOrderId?: number; encounterProcedureId?: number } }
export type AutoChargeOutcome =
  | { ok: true; source: AutoChargeSource; lineId: number; itemName: string; taxablePaise: number; billTo: 'self' | 'payer'; existing: boolean }
  | { ok: false; source: AutoChargeSource; reason: 'no_service' | 'no_context' | 'context_cancelled' | 'price_unresolved' | 'blocked'; rules?: ChargeRuleCode[] }
export async function captureAutoChargeInTx(tx: WriteExecutor, input: AutoChargeInput, session: Session, now?: Date): Promise<AutoChargeOutcome>
export function autoBillTo(ctx: Pick<ChargeContext, 'admissionId' | 'primaryPayerId' | 'isInpatient'>): 'self' | 'payer'
export function planVisitCharges(i: {
  encounterType: 'opd' | 'ipd' | 'lab'; visitType: 'new' | 'follow_up' | 'review' | 'emergency'; encounterDate: string; departmentId: number | null;
  hasLiveRegistrationLine: boolean; priorEncounterCount: number; lastChargedConsultDate: string | null; freeReviewDays: number;
}): { registration: boolean; consultation: boolean; consultationSkip: 'ipd' | 'lab' | 'free_review' | 'no_department' | null }
export async function consultationServiceIdFor(executor: WriteExecutor, departmentId: number): Promise<number | null>   // lowest-id active 'consultation' service of the department (Foundations T10 rule)
export async function captureVisitChargesInTx(tx: WriteExecutor, encounter: EncounterRow, session: Session, now: Date): Promise<AutoChargeOutcome[]>
export async function ensureConsultationChargeInTx(tx: WriteExecutor, encounter: EncounterRow, session: Session, now: Date): Promise<AutoChargeOutcome | null>
export async function voidAutoLinesForEncounterInTx(tx: WriteExecutor, encounterId: number, session: Session): Promise<{ ok: true; voided: number } | { ok: false; error: 'visit_billed'; invoiceNumber: string }>
export interface FeePreview { registration: { itemName: string; amountPaise: number } | null; consultation: { itemName: string; amountPaise: number } | null; note: 'no_rate' | 'no_department' | 'free_review' | 'inpatient' | null }
export async function checkInFeePreview(i: { patientId: string; providerId: number; visitType: 'inpatient' | 'outpatient'; urgency: 'routine' | 'urgent' | 'emergency' }): Promise<FeePreview>
```
- `captureInTx(tx, input, session, now, opts: { source: ChargeLineRow['source']; links?; overrides allowed: boolean })` is the body of today's `captureChargeLine` transaction minus `getDb().transaction`; `captureChargeLine` wraps it (manual source, unchanged tests). `captureAutoChargeInTx`: takes `lockPatientBilling` (last lock), checks for an existing live line for the same `(source, encounter)` / `(registration, patient)` / `labOrderId` / `encounterProcedureId` and returns it with `existing:true`; else evaluates with no overrides; `billTo = autoBillTo(ctx)`; when billing a payer is blocked only by `preauth_required`/`preauth_invalid`, retries as self and audits `billing: auto charge fell back to self-pay`; any other block → `{ ok:false, reason:'blocked', rules }`; audit `billing: auto-captured <source>` with `line=<id> service=<code>`.
- `checkInVisit` result gains `charges: AutoChargeOutcome[]` (OPD only; empty for IPD). `transitionEncounter` result union gains `'visit_billed'` and `charges?: AutoChargeOutcome[]` (on `completed`: `ensureConsultationChargeInTx`; on `cancelled`: `voidAutoLinesForEncounterInTx`, `visit_billed` rolls the cancel back). Lock order: existing locks, then the billing lock.
- `GET /api/front-desk/check-in/fee-preview?patientId&providerId&visitType&urgency` (`CHECK_IN_ROLES`, strict query schema) → `FeePreview`. `CheckInModal` shows "Consultation ₹600 · Registration ₹100 (first visit)" before submit and, after check-in, the outcomes plus "Collect now" → `/cash-desk?patientId=…&amountPaise=…`.

- [ ] **Step 1: Write failing tests**: `planVisitCharges`: first OPD visit → both; second visit → consultation only; `follow_up` within `freeReviewDays=7` of last charged consult → `free_review`; `ipd` → none; `lab` → none; no department → `no_department`. DB: OPD check-in creates one registration and one consultation line (self-pay, tariff price, `encounter_id` set) in the check-in transaction; a department with no consultation rate → check-in 201, `charges[0].ok === false, reason:'price_unresolved'`, encounter exists; second check-in same day → consultation only; completing a visit whose consultation was missing captures it (after billing adds a rate); completing twice → still one line (`existing:true`); cancelling voids both lines; cancelling after the lines are on a **finalised** invoice → 409 `visit_billed`, nothing changed; lines on a draft invoice are voided and leave the draft; `captureChargeLine` manual tests unchanged (`npx vitest run tests/api/billing-charge-lines.test.ts`). Fee preview route role-gated.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `npx vitest run tests/api/front-desk-check-in*.test.ts tests/api/encounter-status.test.ts tests/api/billing-*.test.ts` → PASS; migrate twice; schema-diff.
- [ ] **Step 5: Commit** `feat(billing): automatic consultation and registration charges at check-in through one auto-charge seam`.

### Task 10 (Stream C): Lab and imaging orders: priority, notes, fasting, price, charge, home collection

**Files:**
- Create: `src/components/encounters/OrdersPanel.tsx`, `scripts/migrations/2026-10-24-ws1-lab-order-fields.sql`
- Modify: `src/db/schema.ts` (`labRequisitions` + `priority` text default `'routine'` check in (`routine`,`urgent`,`stat`), `clinicalNotes` ≤ 500, `fastingRequired` boolean default false, each `// WS1 T10`), `src/lib/labs/validation.ts` (`multiRequisitionSchema` + optional `priority`, `clinicalNotes`, `fastingRequired`), `src/lib/queries/lab-requisitions.ts` (quote with the same bill-to as the charge; capture one `lab_order` line per order inside the transaction; result `charges`), `src/app/api/patients/[anonId]/lab-orders/route.ts` (when no `originatingEncounterId`, use the patient's open OPD encounter with the ordering doctor today, if any; response adds `charges`, `homeCollectionEligible`), `src/lib/queries/lab-lifecycle.ts` (`cancelLabOrder` voids the order's captured line; result `billing: 'voided' | 'none' | 'credit_note_needed'`), `src/app/api/lab-orders/[id]/cancel/route.ts`, `src/lib/queries/lab-orders.ts` (worklist: `priority` field, `stat` then `urgent` first), `src/components/LabWorklist.tsx` (priority chip), `src/components/OrderLabTestModal.tsx` (new fields; per-test price and total; "Billed to: Self/Insurer"; after success: "Book home collection" when `homeCollectionEligible`; optional `originatingEncounterId` prop), `src/components/home-collection/BookHomeCollectionModal.tsx` (optional `initialPatient?: string`, `initialOrderIds?: number[]`), `tests/api/lab-orders-routes.test.ts`, `tests/components/OrderLabTestModal.test.tsx`
- Test: `tests/api/lab-order-charges.test.ts`

**Interfaces:**
- Request additions: `priority?: 'routine' | 'urgent' | 'stat'`, `clinicalNotes?: string (≤500)`, `fastingRequired?: boolean`.
- `CreateLabRequisitionResult` ok branch gains `charges: AutoChargeOutcome[]` (one per order, same order as `lines`).
- `CancelLabOrderResult` ok branch gains `billing: 'voided' | 'none' | 'credit_note_needed'`.
- `OrdersPanel(props: { encounterId: number; patientId: string; labTests: LabTestOption[]; canWrite: boolean })` renders the order form inline (lab and imaging tabs) and the encounter's existing orders with status and price.
- Context for the line: active admission → `{ admissionId }`; else `{ encounterId: originatingEncounterId }`; else outcome `no_context` (order still created). `homeCollectionEligible` = `patientIsLocal && includesLabTest && session role in HOME_COLLECTION_BOOKING_ROLES`.

- [ ] **Step 1: Write failing tests**: order of 2 tests from an OPD encounter → 2 `lab_order` lines with `lab_order_id`, price = `quoted_price_paise`; `priority:'stat'` stored and sorted first in the worklist; inpatient order → line on the admission, billed to the primary payer when set; order with no encounter and no open visit → 201, `charges[*].reason === 'no_context'`; cancel a captured order → line void, `billing:'voided'`; cancel after finalised invoice → 200 `billing:'credit_note_needed'`, line unchanged; modal shows the total and, for a local patient, "Book home collection" opening the booking modal with the order ids pre-selected; `pi` can now book (role row updated in T1).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS + `npx vitest run tests/api/lab-* tests/components/home-collection tests/components/LabWorklist*` → PASS; migrate twice; schema-diff.
- [ ] **Step 5: Commit** `feat(lab): order priority, notes, fasting; tests billed at order; home collection booking from the order`.

### Task 11 (Stream C): Procedure orders with charges

**Files:**
- Create: `src/lib/queries/procedure-orders.ts`, `src/app/api/encounters/[id]/procedures/route.ts` (POST), `src/app/api/encounters/[id]/procedures/[procedureId]/route.ts` (DELETE), `src/app/api/encounters/[id]/procedure-options/route.ts` (GET), `src/components/encounters/ProceduresPanel.tsx`
- Modify: both RBAC harnesses
- Test: `tests/api/encounter-procedures.test.ts`

**Interfaces:**
```ts
export const orderProcedureSchema = z.object({ serviceId: z.number().int().positive(), quantity: z.number().int().min(1).max(10).default(1), notes: z.string().trim().max(300).optional() }).strict()
export async function listProcedureOptions(encounterId: number, q: string): Promise<{ serviceId: number; code: string; name: string; departmentName: string; pricePaise: number | null }[]>   // active 'procedure' services, ≤ 20, price via resolvePrice for the encounter context
export async function orderProcedure(encounter: EncounterRow, input: OrderProcedure, session: Session):
  Promise<{ ok: true; procedureId: number; charge: AutoChargeOutcome } | { ok: false; error: 'service_not_procedure' }>
export async function cancelProcedure(encounter: EncounterRow, procedureId: number, session: Session):
  Promise<{ ok: true; billing: 'voided' | 'none' | 'credit_note_needed' } | { ok: false; error: 'not_found' | 'already_void' | 'coded' }>
export function ProceduresPanel(props: { encounterId: number; canWrite: boolean }): JSX.Element
```
- One transaction: `encounter_procedures { encounterId, patientId, description: service.name, serviceId, performedOn: IST today, performedByProviderId: encounter.providerId, codingStatus:'uncoded', createdByName }` then `captureAutoChargeInTx({ source:'procedure', links:{ encounterProcedureId }, quantity })`. A rule block (e.g. `deposit_below_threshold` in IPD) keeps the procedure and returns the outcome. Cancel: SP6 soft void; refused when the procedure's `coding_status` is `coded` (409 `coded`); line handling as T10. Routes use `checkEncounterWriter` (`CLINICAL_WRITE_ROLES`).

- [ ] **Step 1: Write failing tests**: ordering a procedure service creates the procedure row and a `procedure` line linked by `encounter_procedure_id`; a non-procedure service → 422; IPD below deposit threshold → 201 with `charge.ok === false, reason:'blocked', rules:['deposit_below_threshold']`; cancel voids both; coded procedure → 409; options route returns only active procedure services with prices; other doctor 403.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; harness rows.
- [ ] **Step 5: Commit** `feat(billing): procedure orders from the workspace, billed at order`.

### Task 12 (Stream C): "Invoice all ready lines" and "Orders not billed"

**Files:**
- Create: `src/lib/billing/ready-lines.ts` (pure), `src/lib/queries/invoice-ready.ts`, `src/app/api/billing/invoice-ready/route.ts` (GET preview, POST create), `src/components/billing/InvoiceReadyButton.tsx`
- Modify: `src/lib/queries/hospital-kpis.ts` (`loadBillingQueue` only: `readyLines`, `readyPaise`, `waitingLines`), `src/app/(dashboard)/billing/page.tsx` (tile "Lines to invoice: N ready, M waiting for the visit/stay to close" + button), `src/app/(dashboard)/billing/capture/page.tsx` ("Orders not billed" section), `src/app/(dashboard)/cash-desk/page.tsx` (per-patient "Invoice ready charges"), `src/lib/dashboard-tiles.ts` (sub-text), both RBAC harnesses
- Test: `tests/lib/billing/ready-lines.test.ts`, `tests/api/billing-invoice-ready.test.ts`

**Interfaces:**
```ts
export interface ReadyLineInput { id: number; patientId: string; payerId: number | null; encounterId: number | null; admissionId: number | null;
  encounterType: 'opd' | 'ipd' | 'lab' | null; encounterStatus: 'checked_in' | 'in_consultation' | 'completed' | 'cancelled' | null; admissionStatus: 'admitted' | 'discharged' | null }
export interface ReadyGroup { patientId: string; payerId: number | null; admissionId: number | null; encounterId: number | null; lineIds: number[] }
export function groupReadyLines(lines: ReadyLineInput[]): { groups: ReadyGroup[]; waiting: { lineId: number; why: 'visit_open' | 'still_admitted' }[] }
export async function previewInvoiceReady(opts?: { patientId?: string }): Promise<{ groups: number; lines: number; taxablePaise: number; waitingLines: number }>
export async function invoiceReadyLines(session: Session, opts?: { patientId?: string }): Promise<{
  created: { invoiceId: number; patientId: string; lineCount: number }[]; skipped: { patientId: string; error: 'lines_not_found' | 'lines_not_available' | 'mixed_lines' }[] }>
export async function listUnbilledOrders(): Promise<{ kind: 'lab_order' | 'procedure' | 'dispense'; id: number; patientId: string; patientName: string; uhid: string | null; itemName: string; createdAt: Date }[]>
```
- Ready rule = spec ruling 12. Groups key `(patientId, payerId, admissionId ?? 'enc:'+encounterId ?? 'none')`. Each group → existing `createDraftInvoice(lineIds, session)` (its own transaction and lock); a group that loses a race is reported in `skipped`, never fails the batch. `POST /api/billing/invoice-ready` body strict `{ patientId?: string }`; `INVOICE_READY_ROLES`; audit `billing: invoiced ready lines` with counts. Unbilled orders: non-cancelled lab orders and non-void procedures with no live line; dispenses with no line and no `no_charge_reason`.
- Document the B5 cause in the module header (spec §2) and pin it with a test.

- [ ] **Step 1: Write failing tests**: pure grouping: completed OPD lines grouped per encounter; `in_consultation` lines → `waiting: visit_open`; admitted → `still_admitted`; discharged admission → one group; pharmacy lines with no context → one group per patient/payer; self and payer lines of one stay → two groups. DB: a completed visit with consultation + lab + pharmacy lines (pharmacy linked to the encounter) → one draft invoice containing all three; repeat POST → nothing new created; billing dashboard tile counts ready vs waiting; B5 pin: captured lines of a completed encounter stay uninvoiced until the action runs; "Orders not billed" lists a lab order whose charge outcome was `no_context`; frontdesk → 403.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; harness rows.
- [ ] **Step 5: Commit** `feat(billing): invoice all ready lines; list orders not billed; explain uninvoiced backlog`.

### Task 13 (Stream C): Discharge dues gate

**Files:**
- Create: `src/lib/billing/bill-summary.ts` (pure), `src/lib/queries/admission-bill.ts`, `src/app/api/inpatient/admissions/[id]/bill-summary/route.ts` (GET), `scripts/migrations/2026-10-24-ws2-discharge-dues.sql`
- Modify: `src/db/schema.ts` (`admissions` + `dischargeDuesPaise` bigint null, `dischargeDuesOverrideReason` text null, `// WS2 T13`), `src/app/api/inpatient/admissions/[id]/discharge/route.ts` (schema + optional `duesOverrideReason`; gate before discharge), `src/lib/queries/admissions.ts` (`dischargeAdmission` stores dues and reason), `src/components/DischargeAdmissionModal.tsx` ("Bill" step), `tests/api/inpatient-admissions-discharge.test.ts`, `tests/components/DischargeAdmissionModal.test.tsx`, both RBAC harnesses
- Test: `tests/lib/billing/bill-summary.test.ts`, `tests/api/discharge-dues.test.ts`

**Interfaces:**
```ts
export interface BillSummaryInput {
  liveLines: { taxablePaise: number; gstRateBp: number; invoiceStatus: 'none' | 'draft' | 'finalised' }[]
  finalisedInvoiceTotalsPaise: number[]; advancesNetPaise: number; receiptsPaise: number; approvedPreauthPaise: number | null; supplyType: SupplyType }
export interface BillSummary { chargesPaise: number; advancesPaise: number; receiptsPaise: number; insurerSharePaise: number; duesPaise: number; uninvoicedLines: number; roomRentPostedThrough: string | null }
export function computeBillSummary(i: BillSummaryInput): BillSummary
export async function admissionBillSummary(admissionId: number): Promise<BillSummary | null>
```
- `chargesPaise` = Σ finalised invoice totals + Σ (taxable + `lineTax`) of live lines not on a finalised invoice; `insurerSharePaise` = min(approved pre-auth `approved_paise` for the admission, charges); `duesPaise` = max(0, charges − insurer − advances − receipts). Discharge with `duesPaise > 0` and no `duesOverrideReason` (10–500) → 409 `{ error: 'This patient has dues of ₹… . Collect them or give a reason.', code: 'dues_outstanding', summary }`. With a reason: discharge proceeds; audit `discharged with dues outstanding` with `admission=<id> dues=<paise>` (no reason text). `GET …/bill-summary` (`BILL_SUMMARY_ROLES`).

- [ ] **Step 1: Write failing tests**: pure: charges 10 000 + GST, advance 5 000, pre-auth 3 000 → dues correct to the paise; pre-auth larger than charges caps at charges; no lines → zero. DB: discharge with dues and no reason → 409, still admitted; with reason → 200, `discharge_dues_paise` stored; zero dues → 200 without reason (existing discharge tests unchanged); bill-summary role-gated; modal shows the bill step and requires the reason when dues > 0.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; migrate twice; schema-diff.
- [ ] **Step 5: Commit** `feat(ipd): bill summary and dues check before discharge`.

---

### Task 14 (final, after A, B, C merge): Assemble the workspace and prove visit-to-invoice

**Files:**
- Modify: `src/components/encounters/WorkspaceShell.tsx` / `src/app/(dashboard)/encounters/[id]/page.tsx` (Rx tab → `RxBuilder`; Orders tab → `OrdersPanel` + `ProceduresPanel` with `originatingEncounterId`; Notes tab → `NoteForm encounterId`; header chip "Visit charges ₹… (n lines)" from `listChargeLinesForContext({ encounterId })`), `src/lib/queries/encounter-workspace.ts` (`completeEncounter` passes through `charges` from `transitionEncounter`), `src/app/api/encounters/[id]/complete/route.ts` and `src/app/api/encounters/[id]/status/route.ts` (return `charges`; map `visit_billed` → 409 with the invoice number), `src/components/encounters/CompleteVisitBar.tsx` (shows "Consultation ₹600 on the bill" or the not-billed reason), `docs/superpowers/plans/2026-10-23-gap-closure-plan.md` (tick A1–A8, B1–B5, D1 parts, J12 doctor home), `README.md` (workspace, auto-billing rules, MRP setup, `free_review_days`)
- Test: `tests/api/opd-visit-to-invoice.test.ts`, `tests/pages/encounter-workspace.test.tsx` (extend)

**Interfaces:**
- Consumes everything above. `CompleteEncounterResult` ok branch gains `charges: AutoChargeOutcome[]`.

- [ ] **Step 1: Write the failing acceptance test** (DB, isolated): seed a department with a consultation rate, a mapped lab test with a rate, a priced medicine with stock; walk-in check-in (frontdesk) → consultation + registration lines; doctor starts, records vitals, adds a coded diagnosis, writes a 1-0-1 × 5 days prescription, orders the test; complete → 200; pharmacist dispenses with batch/expiry (quantity 10 prefilled) → line on the encounter; `POST /api/billing/invoice-ready` → exactly **one** draft invoice with 4 lines (registration, consultation, test, medicine); finalise → total equals the sum of line totals and the medicine line ≤ MRP × 10; record a cash payment for the outstanding → receipt; patient ledger balance 0. Workspace page test: all six tabs mount their real panels.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** the wiring. **Step 4: Run** `source $SCRATCH/testenv.sh && npx vitest run` → all green (document known skips); `npx tsc --noEmit`; `npm run lint`; `npm run build`.
- [ ] **Step 5: Docker walkthrough**: build the image from this worktree, run on a spare port with a copy of `.env.docker` (`ENABLE_TRIALS` unset); in the browser as front desk → doctor → pharmacist → cashier, repeat the acceptance path; confirm "Awaiting check-in", Start Encounter, diagnosis prompt, allergy banner, dispense toast, check-in fee preview, invoice-ready button, discharge dues step for an inpatient; then flip `ENABLE_TRIALS=true` and confirm the doctor home still shows the trial panel.
- [ ] **Step 6: Commit** `feat(ws1/ws2): assemble consultation workspace; OPD visit to one invoice end to end`.

---

## Execution notes

- **Dependency map:** T1 → {A: T2→T3→T4→T5}, {B: T6→T7→T8}, {C: T9→T10→T11→T12→T13} → T14. T8 needs T6 (prescription header for the encounter link and the allergy matcher); T10–T13 need T9 (`captureAutoChargeInTx`, schema columns). No task in one stream imports a module created in another stream; T14 is the only place their pieces meet.
- **Placeholder rule for the workspace (T3):** until T14 the Rx/Orders/Notes tabs mount the existing `AddPrescriptionModal`, `OrderLabTestModal` and `NoteForm` with their current props, so the page is usable on its own and Stream A never edits files owned by B or C.
- **Merge seam A×C:** T9 widens `TransitionEncounterResult` (`'visit_billed'`, `charges?`). When Stream C merges after A, make `completeEncounter` (T5) map `visit_billed` to its own error union in the merge commit so `npx tsc --noEmit` stays clean; T14 then surfaces `charges`.
- **Existing tests that must change** (each listed in its task): `encounter-status.test.ts` (T5 diagnosis guard), `patient-notes.test.ts` (T5 sign body), `patients-prescriptions.test.ts` (T6 dose), `pharmacy-dispense*.test.ts` and `DispenseMedicationModal.test.tsx` (T8), `lab-orders-routes.test.ts` and `OrderLabTestModal.test.tsx` (T10), `inpatient-admissions-discharge.test.ts` (T13: zero-dues path unchanged).
- **Overlap with later sub-projects:** WS4 drops "order priority / notes / fasting / book home collection" (done in T10); WS5 keeps batch stock, FEFO, GRN, reorder; WS7 adds password/OTP re-authentication on top of T5's attestation; WS3 adds room-rent accrual which T13's summary then includes automatically.
