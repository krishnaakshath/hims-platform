# Doctor consultation workspace and automatic billing: design

**Date:** 2026-10-23 · **Sub-project 3** of `2026-10-23-hospital-completion-design.md` (WS1, WS2) · **Status:** approved under the owner's standing instruction · **Findings fixed:** A1–A8, B1–B5, D1 (pricing/quantity/allergy/confirmation only), I1 residue, J4 (data side), J12/G1 residue on the doctor home · **Plan:** `docs/superpowers/plans/2026-10-23-doctor-workspace-billing.md`

## 1. Intent

A doctor sees a checked-in patient, records vitals, history, diagnosis, prescription, orders, advice, follow-up and referral, and completes the visit on **one page**. Every billable event on the way (registration, consultation, lab/imaging test, procedure, dispensed medicine) becomes a priced, GST-ready charge line **without anyone typing a price**, and the cashier turns a finished visit into one invoice with one action.

Acceptance (from WS1/WS2): a walk-in OPD patient with one lab test and one medicine ends with **one draft GST invoice** holding consultation + test + medicine at tariff/MRP prices, finalised and paid at the Cash Desk, with no manual charge entry; completing a visit with no diagnosis prompts for one.

## 2. What exists today (verified in code)

| Area | Today | Gap |
|---|---|---|
| Visit row | `encounters` (SP3): one row per OPD visit / IPD stay, created by `checkInVisit` in `src/lib/queries/encounters.ts`; status machine `checked_in → in_consultation → completed`, `cancelled` (`src/lib/encounters/status.ts`); `POST /api/encounters/[id]/status`. | No clinical content hangs off it except SP6 `diagnoses.encounter_id` and `encounter_procedures`. |
| Doctor home | `src/app/(dashboard)/doctor/page.tsx`; "Start Encounter" in `src/components/DoctorScheduleTimeline.tsx` links to `/patients/<chartId>` (trial page when trials on); "Today's OPD" links to the patient page; "Assigned Patient Panel" uses the trial `PatientsTable` columns; header says "Principal Investigator". | A1, J12. |
| Visit actions | `src/components/follow-ups/EncounterList.tsx` (patient Visits tab) calls the status route; Complete asks nothing. | A2. |
| Clinical record | `allergies` (no write route), `diagnoses` (legacy free text + SP6 coded columns), `encounter_notes` (no `encounter_id`; signed by one click via `signNote`), `medication_episodes` (one drug per row, `dose` optional, `frequency_per_day` int). | A3–A5. |
| Lab orders | `createLabRequisition` (`src/lib/queries/lab-requisitions.ts`) quotes from the tariff and, since Foundations T10, refuses unmapped/unpriced tests; **no charge line is created**. Old orders show "Not priced" (`quote_status <> 'quoted'`). Booking a home visit exists (`POST /api/home-collections`, `BookHomeCollectionModal`) but is not reachable from the order dialog and `pi` is not in `HOME_COLLECTION_BOOKING_ROLES`. | A6–A8, B (lab). |
| Charges | SP4 `charge_lines` (`source` = `manual`/`room_rent`/`pharmacy`), `captureChargeLine` (`src/lib/queries/charge-capture.ts`) prices with `resolvePrice` and runs the rule engine inside its own transaction under `lockPatientBilling`. Drafts: `createDraftInvoice(lineIds)` (one patient, one payer, one admission or one encounter). | Nothing calls capture automatically except room rent and the manual pharmacy "Log bill". |
| Pharmacy | `dispenseMedication` decrements stock only. Billing is a later manual "Log bill" (`POST /api/pharmacy/dispenses/[dispenseId]/charge`) that requires a diagnosis, a typed unit price and defaults to HCPCS `J3490`, writes a legacy `charges` row plus a `charge_lines` row with no visit link. `medications` has no price. | B2, B3, D1. |
| Discharge | `dischargeAdmission` + typed-name/attestation signature; no money check. | B4. |

**Why lines sit "not invoiced" (B5), verified:** no code path creates an invoice. `createDraftInvoice` is reached only from `POST /api/billing/invoices`, which the Charge Capture page calls per visit/stay when a clerk ticks lines. Room-rent lines, seeded demo lines and every pharmacy line (no encounter link, so it appears only under "Unbilled pharmacy charges") stay `captured` until a clerk drafts them by hand. The dashboard tile (`loadBillingQueue` in `src/lib/queries/hospital-kpis.ts`) counts exactly these. Fix: link every auto line to its visit/stay and add "Invoice all ready lines" (section 4.6).

## 3. Rulings (where the gap analysis is silent)

1. **The workspace is the encounter.** No new visit table. `/encounters/[id]` (page `src/app/(dashboard)/encounters/[id]/page.tsx`) reads and writes child rows keyed by `encounters.id`. The encounter register at `/encounters` is unchanged.
2. **Starting is explicit and POST-only.** "Start Encounter" calls `POST /api/encounters/[id]/start` (moves `checked_in → in_consultation`, idempotent when already in consultation), then navigates. Opening the page never mutates. A scheduled appointment that is not checked in shows "Awaiting check-in" instead of the button; the doctor does not check patients in.
3. **Ownership.** A `pi` writes only to encounters whose `provider_id` is their own provider profile (`resolveDoctorQueueProvider`), the SP3 rule; `admin` may write any. Any `pi` may read. `crc` (nursing/coordinator) may record vitals and allergies only.
4. **Diagnosis before completion.** Completing an OPD visit with no live diagnosis on the encounter answers `409 diagnosis_missing` unless the body carries `noDiagnosisReason` (5–300 chars, stored on the encounter, audited). The same guard applies to `POST /api/encounters/[id]/status` with `to: 'completed'` for OPD; IPD encounters complete through discharge (unchanged) and `lab` encounters are exempt.
5. **Doctor diagnoses go through SP6, not around it.** A coded pick writes `diagnoses` with `encounter_id`, `code_id`, `code_system_kind='icd10'`, `coding_status='proposed'`, `code` = the code value; a free-text diagnosis writes `coding_status='uncoded'`, `code=''`. Only codes from the current, non-sample WHO ICD-10 version are accepted. Once SP6 marks the encounter `coded`/`finalised`, doctor edits are refused (409) and the doctor raises it through the existing coding query.
6. **Charge timing.**
   - **OPD consultation:** captured **at check-in** (Indian OPDs collect the fee before the consult), self-pay, priced by the tariff for the encounter's department. `completeEncounter` re-checks and captures it if missing (e.g. no rate existed at check-in and billing fixed it since). A follow-up/review visit within `billing_settings.free_review_days` (default 0 = always charge) of the last charged consultation with the same department gets no consultation line.
   - **Registration:** captured at the patient's first ever non-cancelled encounter, from `billing_settings.registration_service_id` (seeded to `REG_FEE`). One live registration line per patient (partial unique index).
   - **IPD:** no automatic consultation line (IPD doctor visits stay in Charge Capture; daily room rent is WS3).
   - **Lab/imaging:** one line per order, **at order time**, in the order transaction; context = the active admission when the patient is admitted, else the originating encounter; price = the same resolver call as the quote (the quote and the line can no longer differ).
   - **Procedure:** one line per procedure order, at order time.
   - **Pharmacy:** one line per dispense, **in the dispense transaction**.
   - **Bill-to:** OPD and walk-in lines are self-pay. Lines in an admission bill to the patient's primary payer when one is set (the SP4 room-rent rule), falling back to self-pay, with an audit row, when a payer-only rule (`preauth_required`) blocks.
   - **Never block the clinical act.** Automatic capture runs with no overrides. If a rule blocks or no price resolves, the clinical row is still written, no line is created, and the outcome (`{ ok:false, reason }`) is returned to the UI and listed on Charge Capture as "Orders not billed" (derived: an order or dispense with no live line and no no-charge reason).
   - **Cancellation.** Cancelling a visit voids its captured auto lines (draft invoices lose them, the SP4 void rule). Cancelling a lab order or procedure voids its line the same way. A line already on a **finalised** invoice is never touched: visit cancel answers `409 visit_billed` ("Cancel invoice INV-… first"); order cancel succeeds and returns `billing: 'credit_note_needed'`.
7. **Pharmacy price model (minimal, correct).** `medications` gains `mrp_per_unit_paise` (GST-inclusive MRP per dispensing unit), optional `gst_rate_bp` and `hsn` (defaults: `billing_settings.pharmacy_gst_rate_bp` / `pharmacy_hsn`). The tariff is not used for drugs: drugs are not services and have no department. The line's unit price is the **taxable value backed out of MRP** with `pharmacyLinePrice`, chosen so that taxable + GST never exceeds MRP × quantity (selling above MRP is unlawful) and falls short by less than quantity + 2 paise. Batch and expiry are **snapshot text on the dispense** (`batch_no`, `expiry_month`), required for a charged dispense, printed in the line name; an expired month is refused. Stock by batch, FEFO and GRN are WS5. An unpriced medicine cannot be dispensed with a charge (`422 medication_unpriced`); a free dispense needs `noChargeReason`. HCPCS `J3490`, the diagnosis requirement and the legacy `charges` write are removed for new dispenses; the old route becomes "bill a legacy unbilled dispense at current MRP".
8. **Prescriptions v2 extend `medication_episodes`.** A new header table `prescriptions` groups the drugs written together on one visit (advice, encounter, prescriber); each drug stays a `medication_episodes` row (pharmacy, MAR, portal and print already read it) with new columns for the Indian dose pattern (`1-0-1`), route, food timing, SOS, prescribed quantity and allergy override. `frequency_per_day` is derived from the pattern so existing readers keep working. Dose is mandatory on every new prescription (both routes); legacy rows stay nullable.
9. **Allergy check.** A pure matcher compares a drug's name, generic name and class with each active allergy (case-insensitive token match plus a small cross-reactivity table: penicillin→amoxicillin/ampicillin/cloxacillin/piperacillin; sulfa→sulfamethoxazole/sulfasalazine; NSAID→ibuprofen/diclofenac/naproxen/aspirin/ketorolac; cephalosporin→cef*). Prescribing a conflict needs `allergyOverrideReason`; dispensing one needs `allergyAcknowledged: true`. Unknown allergy status is a warning, never a block.
10. **Note signing reuses discharge.** Signing a clinical note needs `{ typedName, attestation: true }`; `typedName` must equal the session name (admin exempt, as discharge); a `signatures` row of new type `encounter_note` is written. Password/OTP re-authentication stays WS7.
11. **Discharge dues gate.** Discharge shows the bill summary (live charges incl. estimated GST, advances net of refunds, receipts against the stay's invoices, approved pre-auth amount as insurer share, dues). Dues > 0 needs `duesOverrideReason` (10–500 chars), audited as "discharged with dues outstanding". Clinical discharge is not blocked outright: the doctor discharges clinically, billing collects.
12. **"Ready" lines** for "Invoice all ready lines": OPD encounter `completed`; `lab`-type encounter any status; admission `discharged`; pharmacy lines with no visit or stay. Groups follow `createDraftInvoice`'s rule (patient, payer, admission-or-encounter). The action only creates **drafts**; finalising (numbering) stays a deliberate Cash Desk/Invoice step.
13. **Trials off.** The doctor home's panel lists the doctor's own patients from encounters and admissions (last 90 days) with `hospitalView` columns; header reads "Consultant · <department>". With `ENABLE_TRIALS=true` the existing panel, wording and `/patients/<id>` links remain, and "Start Encounter" still opens the workspace (the workspace is hospital functionality, not trial).
14. **Overlap with later workstreams.** Lab order priority/clinical notes/fasting and "Book home collection" are done here (needed by the workspace); WS4 drops its item 4. Pharmacy quantity prefill, allergy banner, price and toast are done here; WS5 keeps batches/FEFO/GRN.

## 4. Data model (all additive; one re-runnable migration per task)

**WS1 (clinical)**
- `encounter_vitals`: `id, encounter_id FK, patient_id FK, recorded_at, recorded_by_name, recorded_by_user_id, systolic_mmhg, diastolic_mmhg, pulse_bpm, temp_deci_c, spo2_pct, resp_rate, weight_g, height_mm` (all measurement columns nullable integers with range checks; at least one present; diastolic < systolic). BMI is computed on read (`bmiTenths`), not stored.
- `encounter_consults` (one per encounter, unique `encounter_id`): `chief_complaint, history_present_illness, past_history, family_history, personal_history, examination, advice, no_diagnosis_reason, updated_at, updated_by_name` (each text ≤ 4000).
- `diagnoses.on_problem_list boolean default false` (problem list = live diagnoses flagged, plus legacy encounter-less rows).
- `patients.allergy_status text default 'unknown'` check in (`unknown`, `none_known`, `recorded`); `allergies` gains `recorded_by_name, recorded_at, inactivated_at`.
- `encounter_notes.encounter_id` FK nullable; `signable_type` + `'encounter_note'`.
- `referrals`: `id, encounter_id FK, patient_id FK, kind ('internal'|'external'), to_department_id, to_provider_id, external_facility, external_doctor, reason (≤1000), urgency ('routine'|'urgent'|'emergency'), status ('open'|'seen'|'closed') default open, created_by_name, created_by_user_id, created_at`; check internal → department or provider set, external → facility set.
- `prescriptions`: `id, patient_id FK, encounter_id FK nullable, prescribed_by_provider_id FK, advice (≤1000), entered_by_name, entered_by_user_id, created_at`.
- `medication_episodes` + `prescription_id FK, dose_pattern, route, food_timing, is_sos boolean default false, quantity_prescribed int, allergy_override_reason`.
- `lab_requisitions` + `priority ('routine'|'urgent'|'stat') default 'routine', clinical_notes (≤500), fasting_required boolean default false`.

**WS2 (billing)**
- `charge_line_source` + `'registration', 'consultation', 'lab_order', 'procedure'` (enum-only migration file, runs first).
- `charge_lines` + `lab_order_id FK unique`, `encounter_procedure_id FK unique`; partial unique indexes `charge_lines_one_consultation_per_encounter (encounter_id) WHERE source='consultation' AND status<>'void'` and `charge_lines_one_registration_per_patient (patient_id) WHERE source='registration' AND status<>'void'`.
- `billing_settings` + `registration_service_id FK`, `free_review_days int default 0 check 0..30`.
- `medications` + `mrp_per_unit_paise int check 0..1e9`, `gst_rate_bp int null` (allowed slabs), `hsn text null`.
- `medication_dispenses` + `batch_no text, expiry_month text ('YYYY-MM'), no_charge_reason text, unit_mrp_paise int` (snapshot).
- `admissions` + `discharge_dues_paise bigint null`, `discharge_dues_override_reason text null`.
- Every new patient-linked table is cleared in `deletePatientRows` (`src/lib/queries/patients.ts`).

## 5. Interfaces (summary; exact signatures in the plan)

| Route | Roles | Purpose |
|---|---|---|
| `POST /api/encounters/[id]/start` | admin, pi(own) | checked_in → in_consultation |
| page `/encounters/[id]` (server component, `getWorkspace`) | admin, pi, crc | workspace read model; GET never mutates |
| `POST /api/encounters/[id]/vitals` | admin, pi(own), crc | add a vitals set |
| `PUT /api/encounters/[id]/consult` | admin, pi(own) | history/exam/advice |
| `POST /api/patients/[anonId]/allergies`, `PATCH …/allergies/[id]`, `PUT …/allergy-status` | admin, pi, crc | allergy list and NKDA |
| `POST /api/encounters/[id]/diagnoses`, `PATCH|DELETE …/diagnoses/[diagnosisId]` | admin, pi(own) | coded/free-text diagnosis, type, problem list |
| `POST /api/encounters/[id]/referrals` | admin, pi(own) | referral |
| `POST /api/encounters/[id]/complete` | admin, pi(own) | complete with diagnosis guard; ensures consultation charge |
| `PUT /api/patients/[anonId]/notes/[id]/sign` | admin, pi | now needs typed name + attestation |
| `POST /api/encounters/[id]/prescriptions`; `GET /api/medications/search` | admin, pi(own); admin, pi, pharmacy | multi-drug Rx |
| `POST /api/pharmacy/dispense` (changed) | admin, pi, pharmacy | dispense + auto bill |
| `PATCH /api/pharmacy/medications/[id]/price` | admin, pharmacy | MRP/GST/HSN |
| `GET /api/front-desk/check-in/fee-preview` | CHECK_IN_ROLES | fee shown before check-in |
| `POST /api/encounters/[id]/procedures`, `DELETE …/procedures/[procedureId]`, `GET /api/encounters/[id]/procedure-options` | admin, pi(own) | procedure orders + charge |
| `GET|POST /api/billing/invoice-ready` | CHARGE_CAPTURE_ROLES | preview / create drafts for ready lines |
| `GET /api/inpatient/admissions/[id]/bill-summary` | DISCHARGE_ROLES + billing | dues before discharge |

Library seams: `captureAutoChargeInTx` (one function every automatic charge goes through, inside the caller's transaction, after taking the patient billing lock last), `planVisitCharges` (pure), `pharmacyLinePrice` (pure), `parseDosePattern`/`prescribedQuantity` (pure), `allergyConflicts` (pure), `vitalsSchema`/`bmiTenths` (pure), `admissionBillSummary`, `invoiceReadyLines`.

## 6. Error handling

- Business failures return typed results; routes map them to 4xx with a plain message and a `code` (`diagnosis_missing`, `allergy_conflict`, `medication_unpriced`, `batch_expired`, `visit_billed`, `dues_outstanding`, `not_owner`, `coding_locked`). Nothing throws through a check-in, order or dispense because billing could not price something.
- **Lock order** (deadlock safety): follow-up → appointment → token → encounter → **patient billing lock last** in visit transactions; order/dispense transactions take the billing lock before inserting the line. No billing path locks an encounter row.
- Audit rows carry ids, codes and amounts only; never vitals values, history text, reasons, drug names with patient names, or allergy text.
- Unique indexes make double-click and retry safe (one consultation per encounter, one registration per patient, one line per order/procedure/dispense); a unique violation on retry returns the existing line as the outcome.

## 7. Testing

- Pure unit tests: dose pattern, prescribed quantity, allergy matcher, vitals ranges/BMI, `planVisitCharges`, `pharmacyLinePrice` (property: never above MRP), ready-line grouping.
- DB route tests on the isolated test DB for every new/changed route, including the ownership rule, idempotence, the void-on-cancel paths and the finalised-invoice refusals.
- Both RBAC harnesses get a row per new handler and the workspace page.
- Component tests: workspace tabs render, Complete prompts for diagnosis, Rx builder pattern chips and allergy override, dispense dialog prefill/price/allergy banner/toast, check-in fee preview, discharge dues step.
- One end-to-end acceptance test (section 1) plus a Docker walkthrough.
- Every existing suite runs with `ENABLE_TRIALS=true` (vitest default) and stays green; flag-off cases are added for the doctor home.

## 8. Out of scope

Batch stock/FEFO/GRN (WS5), analyte result entry and critical-value workflow (WS4), IPD room-rent accrual and admission form (WS3), eligibility at check-in (WS12), note re-authentication (WS7), drug–drug interaction database, e-prescription transmission.
