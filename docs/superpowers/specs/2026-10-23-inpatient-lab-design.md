# Inpatient care and laboratory results: design (sub-project 4, WS3 + WS4)

**Date:** 2026-10-23 · **Status:** approved under the owner's standing instruction · **Parent:** `docs/superpowers/specs/2026-10-23-hospital-completion-design.md` §3 item 4 · **Findings:** `docs/superpowers/plans/2026-10-23-gap-closure-plan.md` C1–C4, B4, E1–E2, A6–A7, I2, WS3, WS4 · **Plan:** `docs/superpowers/plans/2026-10-23-inpatient-lab.md`

Implementers: this Next.js has breaking changes. Read `node_modules/next/dist/docs/` before touching routing, layouts, `searchParams` or caching (AGENTS.md).

## 1. Intent

- **WS3:** admitting a patient becomes a real admission (type, provisional diagnosis, expected stay, attendant, payer/policy, pre-auth, deposit) with safety rules (ward gender, one active stay, no OPD token, no silent coexistence with an open OPD visit, only free beds). The bed board becomes the ward's working surface (Transfer / Discharge / MAR / Charges, tariff, days stayed). Discharge gets a dues-clearance step and draws diagnosis and drugs from coded data and the MAR. A nursing station shows today's medication round and a vitals chart.
- **WS4:** lab results are entered per analyte with automatic flags from age/sex reference ranges; critical values follow a logged notify → acknowledge loop; verification belongs to the pathologist (or the reporting specialist) with an optional doctor co-sign; the catalogue grows from the tariff master; the order dialog captures priority, clinical notes, fasting and can book home collection; the PDF and FHIR output show per-analyte rows.

## 2. What exists today (verified in code)

- Admission is created inside `checkInVisit` (`src/lib/queries/encounters.ts`) when `POST /api/front-desk/check-in` gets `visitType: 'inpatient'`: it always allocates an OPD token, sets `admission_type = 'elective'`, and an already-admitted patient re-checked in without a room gets a second IPD encounter and token. The room is claimed outside the transaction (`assignRoomToPatient`), so a failure strands it.
- `admissions` holds only type, status, room, attending, times and five free-text discharge fields. `rooms.ward` is free text ("General Ward (Male)"); there is no gender attribute.
- `BedBoard.tsx` says "Transfer and discharge actions … are on their Patient Detail page" and shows the chart id. `InpatientHistoryPanel.tsx` owns Transfer / Discharge / MAR.
- `DischargeAdmissionModal.tsx` takes five free-text fields; `dischargeAdmission` never looks at money.
- No vitals table exists anywhere.
- `lab_tests` has one `default_unit` / `reference_range`; `lab_results` is one row per order (`lab_order_id` unique) with a hand-picked `flag`.
- `LAB_VERIFY_ROLES = ['admin','pi']`; `verifyLabResult` only refuses self-verification. The seed's pathologist (Dr. Suresh Babu) is a `labs` user, so the UI never lets the pathologist verify, and any doctor can verify any order.
- "Critical today" is `loadLabKpis().criticalToday` behind a 20 s Redis cache (`getLabKpis`) that no write invalidates; it counts results entered today and never "clears".
- Catalogue: 17 lab + 7 imaging tests; Foundations T10 made `lab_tests.service_id` mandatory to order.

## 3. Decisions (rulings where the findings are silent)

### 3.1 Admission
1. **One admission path.** A new `admitPatient` query and `POST /api/inpatient/admissions` own admission. `POST /api/front-desk/check-in` with `visitType: 'inpatient'` answers `400 {code:'use_admission_form'}`; `checkInVisit` becomes outpatient-only. The check-in dialog's "Inpatient" choice and the bed board's "Admit here" open the admission dialog.
2. **Admission type** reuses `admission_type` (`elective` is labelled **Planned**, plus Emergency and Transfer in). No enum change.
3. **Provisional diagnosis** is a `diagnoses` row (`diagnosis_type='provisional'`, `encounter_id` = the IPD encounter, `code_id` from the WHO ICD-10 picker, `coding_status='proposed'`), so coding and pre-auth see it. Free text is accepted only when no code is chosen (`coding_status='uncoded'`, `code=''`). `frontdesk` is added to `CODE_LOOKUP_ROLES` (code search carries no patient data).
4. **Payer**: `admissions.policy_id` (null = self-pay); the policy must be the patient's, `active`, and valid today. **Pre-auth link** reuses `preauths.admission_id`: choosing a pre-auth of the same patient with no admission sets it in the same transaction.
5. **Deposit**: `admissions.deposit_required_paise`. Money is taken only at the Cash Desk (one payment path); the confirmation links to `/cash-desk?patientId=…&amountPaise=…`, which posts an advance against the active admission. Dues later read the advance.
6. **No OPD token for IPD**: the IPD encounter has `opd_token = null`; the doctor assignment keeps `queue_ticket_number = 0` (the queue display already skips ≤ 0). `/print/token/[encounterId]` answers not-found for an IPD encounter. The success screen shows the admission summary and the deposit link, not a token.
7. **Open OPD visit**: if the patient has an OPD encounter today in `checked_in` or `in_consultation`, admission answers `409 {code:'open_opd_visit', openEncounterId}` until the request says `openOpdVisit: 'complete'` (the OPD encounter is completed in the same transaction, audited "converted to admission") or `'keep'`.
8. **One active stay**: partial unique index `admissions_one_active_per_patient (patient_id) WHERE status='admitted'` plus a per-patient advisory lock; the migration refuses to run while duplicates exist and names the admission ids.
9. **Beds**: the room is claimed inside the admission transaction (`UPDATE … WHERE status='available'`), so occupied, dirty and blocked beds cannot be taken and a failure releases nothing by accident. Pickers list only `available` beds.
10. **Ward-gender policy**: `rooms.gender_restriction` is `'male' | 'female' | null` (null = mixed: ICU, private, semi-private). The migration backfills from ward names containing `(male)` / `(female)`; admins edit it per bed. A conflict is (a) a male or female patient in the opposite-sex bed, or (b) a patient whose gender is transgender, other, unknown or missing in a restricted bed. **Children under 12 years are exempt** (they stay with a parent). Any role allowed to admit or transfer may override with a reason of at least 10 characters; the reason and the overrider are stored on the admission or the transfer row; the audit entry says "ward gender override" with ids only (free text is never audited, as elsewhere). The bed board marks such beds. The same rule applies to transfers.
11. **Admission roles** `ADMISSION_ROLES = ['frontdesk','admin','crc','pi']`; a `pi` may admit only as the attending (same ownership rule as transfer).

### 3.2 Bed board, discharge, nursing
12. **Bed board panel** for an occupied bed: patient name + UHID (never the chart id), attending, admitted on, **days stayed** (IST calendar days, admission day counts as day 1, the midnight-census convention used for room rent), **bed tariff** (ROOM_RENT service resolved for the bed's room category and the admission's payer, "₹1,500/day"), and actions **Transfer** (existing modal), **Discharge** (existing modal), **MAR** (existing panel in a dialog), **Charges** (`/billing/capture?admissionId=…`). Each action shows only for the roles its route already allows.
13. **Dues clearance**: dues = non-void charge lines of the admission (taxable + GST, intra-state) − net advances for the admission − receipts against the admission's invoices − insurer share; insurer share = min(approved pre-auth amount for the admission, payer-billed lines), 0 without an approved pre-auth. Discharge recomputes dues; if outstanding > 0 it is refused `409 {code:'dues_outstanding', dues}` unless the latest clearance carries an override reason **and** no charge was added after it. Clearance rows (`admission_dues_clearances`, append-only) are written by `BILLING_AUTHORITY_ROLES` (admin, billing). A clearance with outstanding 0 needs no reason. Un-posted room-rent days are shown as a warning, never silently added.
14. **Coded discharge data**: the discharge dialog pre-fills diagnoses from the stay's provisional/coded diagnoses and an ICD-10 picker (written as `diagnoses` rows on the IPD encounter, `primary` + `secondary`), and the drug list from the MAR (distinct medication + dose given or scheduled in the last 24 h). Both stay editable; the free-text columns remain the printed summary.
15. **Nursing station** `/inpatient/nursing` (admin, crc, pi): today's medication round (scheduled doses for admitted patients, grouped by hour, overdue after 30 min, charted through the existing administer route, which stays pi/admin) and a vitals chart (last 72 h). There is no nurse role; `crc` is the ward-staff stand-in. Adding a `nurse` role is deferred (it touches every RBAC row).
16. **Vitals** live in `vital_sign_readings` keyed by patient with optional `admission_id` / `encounter_id`, so the doctor workspace (sub-project 3) reuses the same table. Temperature is stored in tenths of °C, weight in grams (integers).

### 3.3 Lab analytes
17. **Analytes per test**: `lab_test_analytes` (code, name, unit, value type `numeric | option | text`, decimals, sort order, optional LOINC code, option lists) and `lab_analyte_ranges` (sex `any | male | female`, age band in days `[min, max)`, normal low/high, critical low/high, display text). Range choice: exact sex before `any`, then the narrowest age band. A test with no analytes keeps the single-value entry (imaging, legacy).
18. **Mapping onto `lab_results`**: `lab_results` stays one summary row per order, so every existing reader (KPIs, staff feed, patient chart, portal, discharge summary, report loader) keeps working. For an analyte test: `value` = the single analyte's value when there is one analyte, else `"<n> analytes"`; `unit`/`reference_range` = that analyte's or null; `flag` = the worst analyte flag. Detail rows go to `lab_result_values` (one per analyte, `UNIQUE(lab_result_id, analyte_id)`), each with a **snapshot** of unit and range text, the numeric value, `flag`, `interpretation` (`N L H LL HH A AA`), `flag_source` (`auto | manual`) and `flag_reason`.
19. **Auto-flagging**: numeric values outside normal → abnormal (`L`/`H`); at or beyond a critical limit → critical (`LL`/`HH`). Option values in the analyte's abnormal/critical option lists flag accordingly. Comparator values (`<0.1`), text values and analytes with no applicable range get no auto flag: the entry form requires a manual flag. A technician may **raise** a flag with a reason, never lower a computed one (`422 flag_below_computed`); a wrong value is corrected by amendment.
20. **Age/sex**: age in days on the collection date (else the result date) from `patients.dob`; sex from `patients.gender` (`male`/`female`, else only `any` ranges apply).
21. **Seeded ranges** (CBC, LFT, KFT, lipid, glucose, CRP, TSH, HbA1c) are demo adult values labelled "Demo reference ranges: the laboratory director must review before clinical use"; the Lab setup editor (admin) changes them. Removing an analyte that has results deactivates it instead of deleting it.
22. **LIS webhook**: unchanged for tests without analytes; a single Observation for an analyte test is refused `422 analytes_required` (real LIS integration is WS10).

### 3.4 Verification permission model (written down)

| Action | Who may | Notes |
|---|---|---|
| Enter / amend result | `labs`, `admin` (unchanged) | only before verification |
| **Verify** | gate `['admin','labs','pi']`, then: the session resolves through its **staff link** (`resolveSessionProvider`, never the surname fallback) to an active provider whose **department equals the department of the test's tariff service**, and is not the person who entered the result | LAB tests → pathologists; RADIO → radiologists; ECG/echo (CARDIO services) → cardiologists. The ordering doctor verifies only if they belong to that department. `admin` has no implicit clinical authority. |
| Co-sign (optional) | `pi`/`admin` gate, then the resolved provider is the **ordering** provider or the **attending** of the patient's active admission; typed name must equal the session name | after verification; one per provider; shown on the report |
| Acknowledge (reviewed) | same as co-sign | required to close a critical alert; replaces the doctor home's "Results to verify" with "Results to review" |
| Log critical notification | `labs`, `admin`, and any provider allowed to verify that order | records who called whom, when, how, and read-back |
| Release report | unchanged (`admin`, `pi`, `labs`) | storage from Foundations T5/T6 |

Reason: Indian lab practice (NABL / ISO 15189) requires results to be authorised by a qualified pathologist or the reporting specialist of that discipline; the clinician acknowledges, and critical values are phoned with read-back. When nobody is linked, the worklist explains why Verify is unavailable ("No pathologist is linked to Laboratory. Settings → Staff: link the user to the provider."). The seed already links the pathologist user to Dr. Suresh Babu (LAB).

### 3.5 Critical values
23. A **critical alert** (`lab_critical_alerts`, one per order) is raised inside the result transaction when the summary flag becomes critical (before verification: critical values are communicated on the preliminary result), and withdrawn if an amendment removes the critical flag.
24. Lifecycle `open → notified → acknowledged` (or `withdrawn`). "Notified Dr X at 10:42 by Meenakshi (phone, read back)" is the logged line. **Verifying a critical result requires the notification to be logged** (`409 critical_not_notified`). Acknowledgement is by the ordering or attending doctor.
25. A banner lists open/notified alerts on the patient's lab section, the lab worklist and the doctor home, with the action the viewer may take. The staff feed's `lab_critical` item lists only unacknowledged alerts.
26. The **"Critical" tile** shows open + notified alerts (it falls when acknowledged) with "N today" as its sub-line, and every result, verify, notify and acknowledge write invalidates the `kpi:labs:<date>` cache key.

### 3.6 Catalogue and orders
27. **One source**: every lab test is created from a tariff service (`investigation_lab` → lab, `investigation_imaging` → imaging, `procedure` → imaging only when an admin picks it, e.g. ECG). Lab setup gets "Add from tariff", listing active services that have no test. A **panel** (e.g. fever panel) is one orderable test with its own service and its own analytes; panels do not nest tests. The seed adds services and tests for panels, ECG, echo, TMT, Doppler, MRI and ultrasound variants, CT chest and common chemistry.
28. **Order fields** on `lab_requisitions`: `priority` (`routine | urgent | stat`), `clinical_notes` (≤ 1000), `fasting_note` (≤ 200). `lab_tests.fasting_required` pre-fills the note. The worklist sorts STAT, then urgent, then routine, with a badge.
29. **Book home collection** appears after ordering when the patient is in the service area and a lab (not imaging) test was ordered; it opens the existing booking dialog pre-filled with the patient and the new order ids. `pi` may book through a new `HOME_COLLECTION_ORDERING_ROLES` used by the booking, context and availability routes only (the day board stays as is).

### 3.7 Output
30. **PDF**: each test is a heading row; each analyte a row with value, unit, the snapshot range and a flag (`LOW`, `HIGH`, `CRITICAL LOW`, `CRITICAL HIGH`, `ABNORMAL`); co-signers are listed under the verifier. Single-value tests render as today.
31. **FHIR**: an analyte test yields one Observation per analyte (`observation-<orderId>-<analyteCode>`, code via the existing `codingFor` rule with the analyte's LOINC binding when loaded, interpretation `N L H LL HH A AA`) plus a panel Observation `observation-<orderId>` with `hasMember` and no value. Tests without analytes are unchanged.

## 4. Data model (all additive; migrations re-runnable, checksummed, named `scripts/migrations/2026-10-24-ws3-*.sql` / `ws4-*.sql`)

| Object | Change |
|---|---|
| `admissions` | + `expected_stay_days int` (1–365), `attendant_name`, `attendant_relationship`, `attendant_phone` (text), `policy_id → patient_policies`, `deposit_required_paise int not null default 0` (0–1e9), `ward_gender_override_reason text`, `ward_gender_override_by_name text`, `admitted_by_name text`; partial unique `admissions_one_active_per_patient` |
| `admission_transfers` | + `ward_gender_override_reason text` |
| `rooms` | + `gender_restriction text` check `IN ('male','female')` |
| `admission_dues_clearances` (new) | `id, admission_id → admissions ON DELETE CASCADE, charges_paise, paid_paise, insurer_share_paise, outstanding_paise` (bigint), `override_reason, cleared_by_name, cleared_by_user_id, cleared_at`; check: `outstanding_paise = 0 OR override_reason IS NOT NULL` |
| `vital_sign_readings` (new) | `id, patient_id → patients ON DELETE CASCADE, admission_id → admissions ON DELETE CASCADE, encounter_id → encounters ON DELETE SET NULL, recorded_at, systolic, diastolic, pulse, resp_rate, temperature_c_tenths, spo2, weight_grams, pain_score, notes, recorded_by_name, recorded_by_user_id`; range checks; at least one measure |
| `lab_test_analytes` (new) | `id, lab_test_id → lab_tests, code, name, unit, value_type, decimals, sort_order, loinc_code, options jsonb, abnormal_options jsonb, critical_options jsonb, is_active`; unique `(lab_test_id, code)` |
| `lab_analyte_ranges` (new) | `id, analyte_id → lab_test_analytes ON DELETE CASCADE, sex, age_min_days, age_max_days, normal_low, normal_high, critical_low, critical_high` (numeric(14,4)), `display_text` |
| `lab_result_values` (new) | `id, lab_result_id → lab_results ON DELETE CASCADE, lab_order_id → lab_orders ON DELETE CASCADE, analyte_id, value_text, value_numeric, unit, reference_range_text, flag lab_result_flag, interpretation, flag_source, flag_reason`; unique `(lab_result_id, analyte_id)` |
| `lab_result_signoffs` (new) | `id, lab_order_id → lab_orders ON DELETE CASCADE, kind ('acknowledge','cosign'), provider_id, user_id, signed_by_name, note, signed_at`; unique `(lab_order_id, kind, provider_id)` |
| `lab_critical_alerts` (new) | `id, lab_order_id unique → lab_orders ON DELETE CASCADE, patient_id → patients ON DELETE CASCADE, summary, status, raised_at, notified_at, notified_by_name, notified_by_user_id, notified_to_name, notify_channel, read_back, acknowledged_at, acknowledged_by_name, acknowledged_by_user_id, ack_note, withdrawn_at` |
| `lab_requisitions` | + `priority text not null default 'routine'`, `clinical_notes`, `fasting_note` |
| `lab_tests` | + `fasting_required boolean not null default false` |

New child tables cascade from their parent, so `deletePatient` (`src/lib/queries/patients.ts`) and the seed's clear step need no new lines; a test proves it for each table.

## 5. Interfaces (summary; exact signatures are in the plan)

- Routes: `POST /api/inpatient/admissions`, `GET /api/inpatient/admissions/form-context`, `PATCH /api/inpatient/rooms/[id]`, `GET|POST /api/inpatient/admissions/[id]/dues-clearance`, `GET /api/inpatient/admissions/[id]/discharge-context`, `GET|POST /api/inpatient/admissions/[id]/vitals`, `GET /api/inpatient/medication-round`, `GET|PUT /api/lab-tests/[id]/analytes`, `GET|POST /api/lab-tests/from-tariff`, `POST /api/lab-orders/[id]/acknowledge`, `POST /api/lab-orders/[id]/cosign`, `POST /api/lab-orders/[id]/critical/notify`, `POST /api/lab-orders/[id]/critical/acknowledge`. Changed: check-in (inpatient refused), transfer (gender rule), discharge (dues gate, coded diagnoses), lab result (analytes), verify (department rule, critical gate), lab requisition (priority/notes/fasting), home-collection booking/context/availability (ordering roles).
- Pages: `/inpatient/nursing` (new); `/inpatient/beds`, `/labs`, `/doctor`, patient lab section, Settings → Lab setup (changed).

## 6. Error handling
- Every new route: `requireSession`, inline role allowlist, strict Zod, fixed error messages that never echo input, a stable `code` per business refusal, audit with ids only, `isRetryableConflict → 409 RETRY_MESSAGE`, other failures logged by error class/code only.
- Unique-index races (second active admission, duplicate alert, duplicate signoff) map to 409 with a plain message, never 500.
- Money is integer paise end to end; dues use `bigint` columns in mode `number` (≤ `MAX_DOCUMENT_PAISE`).
- No new secret; no file path, blob URL or provider body in responses or logs.

## 7. Testing
- Pure units: ward-gender rule (incl. child exemption), days stayed (IST midnight), dues arithmetic, range selection and flagging (sex/age bands, critical edges inclusive, comparator/text → manual), verification denial reasons, vitals schema and warnings, service → test category.
- DB-backed (isolated `hims_test` only): `admitPatient` (one active stay under concurrency, room claim rollback, open OPD prompt, no token, pre-auth link), dues gate, analyte entry and summary row, alert raise/withdraw, verification by department, cascade deletes, migrations re-run twice cleanly.
- Routes: role gates in both RBAC harnesses for every new route and page; business refusals.
- Components: admission dialog (gender warning + override), bed board actions per role, discharge dues step, analyte entry table auto-flags, critical banner, order dialog fields and home-collection button.
- Walkthrough in the Docker stack after merge (plan, final section).

## 8. Out of scope
Nurse role; OT, diet, blood bank; LIS DiagnosticReport ingestion; QC/analyser tracking (E3, E4); automatic daily room-rent accrual (sub-project 3, WS2); patient-facing critical-value messages; nested panels.
