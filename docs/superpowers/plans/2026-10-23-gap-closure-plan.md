# HIMS gap-closure plan (from a hands-on walkthrough of the running app)

**Date:** 2026-10-23 · **Source:** manual testing of the Docker stack at `localhost:3001` (demo data, test records prefixed "QA Test") · **Status:** draft for owner review

## 0. How to read this

Everything here was observed by using the app as each role, not by reading all the code. Where a finding says *verify in code*, the cause (missing feature vs. missing wiring) still needs a look before estimating. Priorities:

- **P0** breaks the hospital story or loses money/safety.
- **P1** a real workflow gap that staff will hit daily.
- **P2** polish, wording, and later modules.

Effort: S ≤ 1 day, M ≈ 2–4 days, L ≈ 1–2 weeks, XL > 2 weeks.

## 1. What was tested

**Roles signed in:** admin, front desk, doctor (pi), coordinator (crc), pharmacy, labs, billing, RCM, collector, coder.

**Write flows exercised end to end (all worked unless noted in section 3):**

1. Patient registration (validation, opt-out reasons for Aadhaar and ABHA) → UHID issued.
2. OPD check-in → token → OPD register.
3. Cash desk: advance payment → receipt `RCT/26-27/…`.
4. Calendar booking, and overlapping booking blocked.
5. Doctor: prescription, lab and imaging order, SOAP note, sign note.
6. Pharmacy: dispense; billing dialog opened.
7. Labs: mark collected → receive by sample ID → enter result.
8. Visit: start consultation → complete visit.
9. IPD: admit to a bed → discharge (3-step, typed-name signature) → room freed for cleaning, follow-up recorded.

**Read-only passes:** every sidebar page for admin, billing, RCM, collector, coordinator; RCM claims, pre-auths, payers, policies, reports; coding worklist; tariffs; reports hub; settings; ABDM/NHCX settings; audit log; public `/book`; patient-portal login.

**Second pass (also done):** queue display with a PIN; settings tabs (queue, providers, lab setup); home-collection booking → collector assignment → collector scan-and-collect; lab verify (as doctor) and release attempt; invoice finalise (GST bill of supply); patient collections, statements, insurance collections, billing rules, demo card payment; coder claim and code-search; RCM policy creation, pre-auth creation and send; form send and public intake page; telemedicine session creation; portal access issue and portal sign-in up to the consent gate; reports (OPD statistics); global search, notifications; tariff room categories.

**Third pass (also done):** patient portal in full (accepted the draft consent gate for the QA patient only, then overview, forms, bills and receipts, discharge summaries, prescriptions, lab reports, insurance and ABHA, appointments, messages, security); completing a sent form on the patient side; two-way messaging (patient → staff reply); broadcast wizard up to recipients; form-template builder; tariff rate versions and the Add-rate dialog; RCM claim page (readiness checklist); coder accept and mark-coded; workbook and pipeline dashboard pages.

**Fourth pass (also done):**
- Broadcast sent (simulated) to all 51 patients.
- Workbook export: both `.xlsx` files returned valid, checked in memory without saving to disk.
- Tariffs: created a test service, saved a base rate, revised it (scheduled future version).
- Forms: saved a form with a question, then archived it.
- Telemedicine call screen (camera/microphone access had been granted): opens, then "Call ended".
- **Staff MFA, enforced** (in an isolated copy of the app on port 3002 against the Docker database, because the Docker app disables MFA): enrol with QR, wrong code rejected, correct code accepted, second login asks for a code, a reused code is rejected, repeated failures are rate-limited.
- **ABDM in mock mode** (same isolated copy): connection test, ABHA create with consent, mock Aadhaar OTP, ABHA address choice, link to patient.
- **NHCX in mock mode:** eligibility check from both the pre-auth page and the patient's Insurance tab ("Policy in force · Sandbox mock - not real"), hospital identifier settings, a second pre-auth and the send attempt.
- ABHA Scan & Share page in mock mode.

**Still could not be completed, and why:**
- Lab report release: needs a real file store. The only token on this machine is a real cloud Vercel Blob token in `.env.local`, which I did not use (see I3).
- Claim submission, coder finalise and NHCX pre-auth send: the product requires a coded diagnosis from a licensed code set (see I5, K8).
- ABHA Scan & Share inbound share: needs a signed ABDM gateway callback; the app has no way to simulate one (see K10).
- Live ABDM/NHCX calls: no credentials. Mock mode is the most that can be tested.
- Nothing in this list can be done without either real credentials, a licensed code set or a new development feature.

## 2. What is already good (keep)

- Registration: Aadhaar and ABHA validation, required reasons for opt-out, MLC flag, guardian contacts, optional insurance.
- Check-in issues a token and the visit appears in the OPD register; double-booking a doctor is blocked with a clear message.
- Doctor home: triage queue, coding queries, follow-ups due, schedule, assigned panel.
- Lab chain: order → worklist → sample label/ID → receive by scan → result → verify → report, with critical flags.
- IPD: bed board with ward status, discharge wizard with typed-name signature and attestation.
- RCM desk: pre-auths, claims, insurer/TPA master with SLAs, ageing, deductions, payer performance, CSV register.
- Cash desk receipts use Indian financial-year numbering.
- Audit log records views and writes; the role gates work (roles saw only their own navigation).

## 3. Findings

### A. Clinical workflow (doctor)

| # | Finding | Evidence | Pri |
|---|---|---|---|
| A1 | "Start Encounter" from the doctor's schedule opens the trial-screening patient page ("Meets", "Criteria evaluated", "Confirm Eligibility & Notify Patient"). There is no consultation workspace. | Doctor home → Start Encounter → `/patients/RD-0040` | P0 |
| A2 | Visit actions (Start consultation, Complete visit, Cancel visit) live in the patient's **Visits & follow-up** tab, away from where the doctor works. Completing a visit asks for nothing (no diagnosis, charges, follow-up). | Patient → Visits tab | P0 |
| A3 | The medical record has no vitals, no "Add diagnosis" action, no problem list or history, no referral, and no imaging/procedure orders beyond a short list. | `/patients/RD-0040/medical-record` | P0 |
| A4 | Clinical notes sign with one click and no re-authentication. Discharge uses typed name plus attestation, so the stronger pattern already exists. | Sign on note vs discharge dialog | P1 |
| A5 | Prescription: dose optional, no multi-drug prescription, no 1-0-1 style frequency, no generic/brand choice, no allergy interaction check shown, suggestion list is trial-drug oriented (stimulants for an ADHD code). | New Prescription dialog | P1 |
| A6 | Lab catalogue is small (17 lab tests, 7 imaging), no panels, no ECG/echo/MRI even though tariffs list echo and CT; no priority or clinical-notes field on orders. | Order Lab Tests dialog | P1 |
| A7 | After ordering, the dialog says "Home collection available for this patient" with no way to book it. | Lab order confirmation | P1 |
| A8 | Lab order rows show "Not priced". | Medical record → Lab results | P0 (see B) |

### B. Billing and revenue

| # | Finding | Evidence | Pri |
|---|---|---|---|
| B1 | OPD check-in creates no consultation or registration fee. The patient account stays at ₹0 billed. | Cash desk after check-in | P0 |
| B2 | Pharmacy billing needs a manual diagnosis and unit charge, shows the US code `J3490`, and has no tariff pricing, GST, MRP or batch. Dispensing does not bill automatically. | Pharmacy Billing → Log bill | P0 |
| B3 | Dispensing closes the dialog with no confirmation message. | Pharmacy lookup → Dispense | P1 |
| B4 | Discharge has no dues-clearance or final-bill step. | Discharge wizard | P0 |
| B5 | Billing dashboard shows 32 uninvoiced lines (₹39,060.50) and 144 days in A/R on demo data, which suggests charges are not flowing to invoices on their own. *Verify in code.* | Billing home | P1 |
| B6 | Cash desk accepts advances and payments, but there is no refund or credit-note flow visible in the account view. *Verify.* | Cash desk | P2 |

### C. Registration, front desk, scheduling

| # | Finding | Evidence | Pri |
|---|---|---|---|
| C1 | IPD admission is a room dropdown on the check-in dialog: no admission diagnosis, expected stay, deposit, payer/pre-auth, attendant or bed rate. | Check-in → Inpatient | P0 |
| C2 | No ward/gender validation: a female patient was admitted to a male ward without a warning. | Admission test | P0 |
| C3 | A patient with an open OPD visit can be admitted and gets a second OPD-style token slip ("Token 2") for the IPD stay. | Visits tab showed two Checked-in rows | P1 |
| C4 | Bed panel shows only status, doctor and "View patient". No transfer or discharge there; those are inside the patient's Inpatient History tab. | Beds board → occupied bed | P1 |
| C5 | Calendar booking is free-form time entry. No slot picker, no doctor working hours or availability view. | New Event dialog | P1 |
| C6 | Confirming a booking request for a new person needs a manual patient search first. No "register from this request". The date pre-fills with a past date. | Booking Requests → Confirm | P1 |
| C7 | Doctor list on check-in includes the pathologist (no department filter, no queue length or availability). | Check-in dialog | P2 |
| C8 | Check-in token slip lacks doctor, room and estimated wait. Queue display needs a PIN configured in Settings. | Token ticket; `/display/queue` | P1 |
| C9 | Assignments list shows chart IDs (RD-0035) instead of patient names. | Front desk → Assignments | P1 |
| C10 | Registration is one long scroll. No photo capture, no referral source. | Add New Patient | P2 |

### D. Pharmacy

| # | Finding | Pri |
|---|---|---|
| D1 | Dispense dialog does not pre-fill quantity from the prescription (3/day × 5 days = 15). No batch/expiry picker, no price, no allergy warning. | P1 |
| D2 | Stock table has no batch, expiry, reorder or purchase/GRN actions. | P1 |
| D3 | 5 "not in catalog" items on the dashboard with no resolve flow seen. *Verify.* | P2 |

### E. Lab

| # | Finding | Pri |
|---|---|---|
| E1 | Result entry takes one value, one unit and one range. A CBC (Hb, WBC, platelets, …) cannot be entered properly. Abnormal/Critical is chosen by hand, not computed from age- and sex-specific ranges. | P0 |
| E2 | "To verify" rows show only Amend for the labs user; critical result (platelets 38) sits with no "notify doctor" or acknowledgement log. | P1 |
| E3 | LIS integration shows "Not configured". | P2 |
| E4 | Lab sidebar is minimal (Home, Labs, Home Collection, Reports): no QC log, no analyser or reagent tracking. | P2 |

### F. Forms, communication, documents

| # | Finding | Pri |
|---|---|---|
| F1 | Forms are psychiatry/trial oriented (MDD, ADHD, PHQ-9, ASRS, GAD-7, research consent). No admission form, general or surgical consent, discharge consent, MLC, or vaccination forms. | P1 |
| F2 | A junk consent document ("sdfghjk") exists in demo data. Clean up. | P2 |
| F3 | Broadcasts are simulated with a 140-character SMS limit and no DLT template concept. Follow-up notices are "log only". WhatsApp is absent. | P1 |
| F4 | Documents uses "Fax History (Demo)" wording; US-style. | P2 |
| F5 | Audit log shows only the last 200 entries, with no filter, search or export. | P1 |

### G. Trial-screening leftovers in a hospital product

| # | Finding | Pri |
|---|---|---|
| G1 | Patients list (the main list) leads with trial status ("Meets", "Needs Verification", "No screening evidence yet") and a trial filter, for every patient. | P0 |
| G2 | Patient header shows "Needs Verification" and a trial banner for patients not in a trial. | P1 |
| G3 | Wording still says "anon #", "Anonymous #, e.g. RD-0001" in several search boxes and the Labs patient lookup. | P2 |
| G4 | Dashboard and nav items such as Workbook, Trials & Protocols, Client Forms appear for hospital roles. | P1 |
| G5 | A few remaining US-isms: `J3490` code, "Wound VAC" hint, Fax wording. | P2 |

### H. Integrations and compliance

| # | Finding | Pri |
|---|---|---|
| H1 | ABDM and NHCX report "Not configured" (expected). ABHA numbers shown "Recorded, not verified with ABDM". | owner/legal |
| H2 | Patient portal, public `/book`, intake pages exist; portal content after login not yet tested. | test |
| H3 | No data-principal erasure/export workflow, retention, breach tooling (already listed in the README as not provided). | P2 |
| H4 | "Delete Patient" is a prominent red button in the chart header for admin. Needs a stronger confirmation and soft-delete. *Verify behaviour.* | P1 |

### I. Second-pass findings

| # | Finding | Evidence | Pri |
|---|---|---|---|
| I1 | **Root cause of "Not priced":** about half the lab tests are "Not mapped" to a tariff service (CRP, Dengue NS1, FBS, KFT, CMP, lithium, …). Orders still go through, with no warning. | Settings → Lab setup → Lab tests table | P0 |
| I2 | Lab verification belongs to the ordering doctor, not the pathologist: both lab accounts only saw "Amend". Any doctor could verify another doctor's patient's critical result (platelets 38) in one click, with no acknowledgement or call log. The "Critical today" tile does not clear after verification. | Doctor "Results to verify"; lab worklist | P0 |
| I3 | "Release report" fails with a generic "Something went wrong on our side". The cause is `BLOB_READ_WRITE_TOKEN` not set: the Docker stack has no file store. `/api/health` already reports it, but the UI does not say so. | `docker logs hims-app-1`: "lab report release is unavailable" | P1 |
| I4 | Notifications are not delivered: logs show `channel=log delivered=false` for the home-collection booking notice. Forms and video links are shown for staff to copy by hand. | App logs; Send Form dialog; telemedicine row | P1 |
| I5 | **Only SAMPLE code sets are loaded.** The coder's search says "Fictional sample codes, for testing only"; fever returns nothing. Real ICD-10 and SNOMED must be imported before coding or pre-auth can be used for real. | Coding → Add diagnosis; pre-auth form | P0 |
| I6 | New pre-auth: the submit button is silently disabled until a *planned admission date* is entered, even when an admission is linked. The service line shows no price. The requested amount (₹90,000) is unrelated to the estimate (₹600) with no check. Treating doctor defaults to the first doctor in the list. | `/rcm/preauths/new` | P1 |
| I7 | An ICU inpatient (Fathima Beevi) had no insurance policy; admission does not capture one. | Policies page | P1 |
| I8 | Payments are split across disconnected paths: Cash Desk (ledger, receipts) vs. "Collect Payment" on Patient Collections, which opens a demo *virtual-card* form (URL still uses `amountCents`). No UPI QR or payment link. | Billing → Patient Collections | P0 |
| I9 | Legacy US-era billing pages remain: "Insurance Collections (legacy demo data)" duplicates RCM; Statements log shows Paper/SMS "Final Notice"; Patient Collections lists chart IDs. | Billing sidebar | P2 |
| I10 | Doctor fee exists in two places (Provider roster, e.g. Dr. Rao ₹600) and in the tariff services; Dr. Suresh Babu shows ₹0. Risk of inconsistent prices. | Settings → Providers vs Tariffs | P1 |
| I11 | Invoice list shows only document status. No paid/outstanding column, and no "Collect payment", share or WhatsApp button on the invoice page. | Billing → Invoices | P1 |
| I12 | Portal access is under the patient's **Verification** tab, next to trial-era "Form vs chart discrepancies". The portal consent gate shows a US-style "Notice of Privacy Practices", English only, marked draft. | Patient → Verification; `/patient-portal/consent` | P1 |
| I13 | Send Form: the client picker is a plain dropdown of every patient (no search). Forms are English only, with a typed-name signature only. | Home → Send Form to Client | P1 |
| I14 | Telemedicine: every appointment row shows "Start telemedicine visit". Appointments have no in-person/video mode. | Home → appointments table | P1 |
| I15 | Queue display is bare: Waiting and Ready lists only. No "now serving", doctor/room, language or audio. | `/display/queue` | P2 |
| I16 | Collector page: no map link, no handover OTP, no payment at the door. A visit booked for tomorrow could be marked collected today. | `/collections` | P1 |
| I17 | Only 4 room categories (general, semi-private, private, ICU): no deluxe, suite, HDU, NICU, isolation or daycare. | Tariffs → Room categories | P2 |
| I18 | Global search by phone works; notifications bell is useful (critical result, declined assignment, new requests). | Header | keep |

### J. Third-pass findings (patient portal, forms, tariffs, RCM, trial leftovers)

| # | Finding | Evidence | Pri |
|---|---|---|---|
| J1 | **README says patient MFA is mandatory; the portal lets a patient sign in with password only** and shows "Two-factor authentication is off / Enable". Either enforce it or correct the README. | Portal sign-in; Security page | P1 |
| J2 | Portal "Past visits" says none on file even though an OPD visit and an IPD stay were completed (it lists appointments only). | Portal → Appointments | P1 |
| J3 | Portal "Request an appointment" offers every doctor, including the pathologist. No video option. | Portal → Appointments | P2 |
| J4 | Portal bills: a patient sees receipts but no invoice for the OPD visit or IPD stay (consequence of no auto-billing), and there is no "Pay now". | Portal → Bills & receipts | P0 (with WS2) |
| J5 | Portal insurance and ABHA are read-only ("ask at the front desk"). No self-service policy upload, ABHA create/link, or consent management. | Portal → Insurance & ABHA | P2 |
| J6 | Portal forms open the public intake page in a separate layout; after submit the "Thank you" page has no link back to the portal and no copy of the signed consent. | Forms flow | P1 |
| J7 | Form builder supports only Text, Long text, Date, Select, Checkbox. No number, phone, file upload, signature, sections, conditional logic, scoring or translations. Clicking "Create New Form" saves an "Untitled Form" immediately. | `/forms/8` | P1 |
| J8 | Broadcast audience can only be filtered by trial, screening status and form status. No department, doctor, age, ward, follow-up due, language or PIN-code segments. | Broadcasts → recipients | P1 |
| J9 | Tariffs are well structured (base, department list, payer/TPA scopes, effective dating) but the "Ward" field is free text, and there are no scopes for emergency or after-hours surcharges, senior-citizen or staff discounts. | Tariffs → Add rate | P2 |
| J10 | RCM claim page has a clear readiness checklist (coding finalised, photo ID, policy card, prescription, ROHINI ID) with Waive options. Submission is blocked until real code sets are loaded. | `/rcm/claims/2` | keep / WS11 |
| J11 | The product refuses sample codes with "Sample code sets are fictional and cannot be used here; load a licensed code set". This is a deliberate guard and confirms I5. | Coder Mark coded | WS11 |
| J12 | **Trial-era modules still in the nav and data:** Workbook (anonymous number, referral type, PI recommendation, rating scales), Pipeline Performance (referrals received, patients classified), Trials & Protocols, Client Forms. All meaningless for a hospital workflow. | Admin nav | P0 (WS1) |
| J13 | Messaging works both ways with unread badges, but there is no ownership, response-time tracking or canned replies, and no attachments. | Messages | P2 |

### K. Fourth-pass findings (MFA, ABDM, NHCX, insurance verification, telemedicine, broadcast)

| # | Finding | Evidence | Pri |
|---|---|---|---|
| K1 | **ABDM mock mode can never run in the Docker image.** `.env.docker` sets `ABDM_USE_MOCKS=true`, but the code only accepts `1`; and the image runs with `NODE_ENV=production`, which blocks mocks regardless. So in Docker every ABDM/NHCX capability shows "Not configured", and there is no local way to demo ABHA or NHCX. | `src/lib/integrations/runtime.ts`; `.env.docker`; `Dockerfile` | P0 (dev setup) |
| K2 | **`INTEGRATION_PAYLOAD_KEY` is missing from `.env.docker`/`.env.example` defaults for Docker.** Without it, recording ABHA consent fails and the UI says the misleading "ABDM is not configured". A missing secret should say so. | ABHA consent POST → 503 | P1 |
| K3 | ABHA link dialog shows the profile returned by ABDM (here "Sandbox Mock Patient") next to a differently named chart and offers "Link to this patient" with **no name/DOB/gender mismatch warning**. A wrong-person ABHA link is possible with real data. | Link step | P0 |
| K4 | Staff MFA works correctly (enrol, verify, replay protection, rate limit). But the Docker app disables it (`DISABLE_STAFF_MFA=true`), so the demo never shows it. A new account's first login also enrols without any admin step. | Isolated instance | note |
| K5 | RCM settings: "Hospital identifiers on claims" (ROHINI, HFR) saves with **no confirmation message**, yet these two blank values block both claim readiness and NHCX eligibility. They are also admin-only while RCM staff hit the error. | `/rcm/settings` | P1 |
| K6 | NHCX state on a pre-auth page goes stale: after fixing the insurer code or settings, "Send via NHCX" still shows the old error until a full reload. | Pre-auth page | P2 |
| K7 | A pre-auth keeps a **frozen request snapshot**: adding the insurer's NHCX code afterwards does not apply to already-requested pre-auths, and there is no "refresh snapshot" action. The message ("no NHCX participant code") does not explain this. | PA-2026-000003 | P1 |
| K8 | NHCX send also requires "at least one coded diagnosis", which cannot be provided until licensed ICD-10 is loaded (I5). | PA-2026-000004 | P0 (WS11) |
| K9 | Telemedicine: after a reload the appointment row shows "Start telemedicine visit" again (no "session active"); the call screen has no chat, screen-share, chart panel or note capture; "Call ended" shows no duration or follow-up prompt (complete visit, write note, bill). | Home table; `/telemedicine/2` | P1 |
| K10 | ABHA Scan & Share cannot be demonstrated: inbound shares need a signed ABDM callback and there is no dev "simulate a share" tool. | Scan & Share page | P2 |
| K11 | Broadcast default audience is **all patients** (51) with no consent/opt-out check, no phone-number check and no "are you sure?" count warning. Delivery is simulated, so nothing is actually sent. | Broadcast review step | P1 |
| K12 | Workbook exports work (valid `.xlsx`), but the sheet is a trial-screening workbook (anonymous number, referral type), not a hospital report. | `/api/workbook/*` | P1 (J12) |
| K13 | Tariff service creation and rate versioning work well (scheduled future rates, preview of the effect). GST list includes the 40% slab. No package-inclusion lines, no min/max quantity per visit rules beyond "max per line". | Tariffs | keep |

### L. Insurance verification: current state and backlog

**Can we verify insurance today? Partly, and only in mock.**
- An NHCX **eligibility check** exists on the pre-auth page and on the patient's **Insurance** tab. In mock mode it returned "Policy in force · Sandbox mock - not real". It needs: the insurer or TPA to have an **NHCX participant code**, the hospital **HFR/ROHINI ID** set, and a **treating doctor** chosen.
- If the insurer is not on NHCX, the page only says "confirm cover through the insurer portal".
- The result is **not saved**: after a reload there is no "verified on/by", no cover amount, co-pay or room-rent limit returned, and nothing on registration, check-in, admission or billing.

**Backlog to add (nothing here is built yet):**

| # | Item | Pri |
|---|---|---|
| L1 | Save every eligibility result (who, when, source, insurer reference, status, sum insured available, co-pay %, room-rent limit, validity) and show it on the patient header and Insurance tab. | P0 |
| L2 | **Manual verification record** for insurers/TPAs not on NHCX: verified by, date, call/portal reference, screenshot or document upload, expiry of verification. | P0 |
| L3 | Check eligibility at **registration/policy add, OPD check-in and IPD admission**, with a "policy valid, verified N hours ago" badge and a block/warning when the policy is expired or inactive (valid-to date is stored but not enforced). | P0 |
| L4 | Pull **balance sum insured and sub-limits** (room rent, ICU, pre-existing waiting periods) into the charge rules and the estimate. | P1 |
| L5 | Live insurer connectivity: NHCX production onboarding, plus TPA-portal helpers (deep link and credentials vault) and PM-JAY / CGHS / ECHS beneficiary verification. | owner/legal |
| L6 | Policy card capture: OCR or QR on the insurance card, ID-proof link (the "do not upload national ID cards" guard stays). | P2 |
| L7 | ABHA mismatch guard (K3) and ABHA-linked policy discovery (insurer details from the patient's ABHA/HCX consent). | P1 |
| L8 | Pre-auth: pre-fill from the admission, default the treating doctor from the admission, refresh snapshot (K7), and auto-check eligibility before creating one. | P1 |
| L9 | Dashboard tiles for "policies expiring in 7 days", "eligibility not verified for today's admissions" and "claims blocked by missing identifiers". | P2 |

**More things that work well:** portal overview (next visit, follow-up due, forms waiting), discharge summary and receipt visible to the patient, sent forms appear in the portal automatically, two-way messaging.

**More things that work well (earlier passes):** GST bill of supply with GSTIN, place of supply and amount in words; finalise confirmation explains credit-note rule; billing charge rules (deposit, duplicate, pre-auth, procedure-after-consult); policy form (sum insured, co-pay, room limit, TPA); pre-auth lifecycle (draft → requested → query/approve/reject); collector must scan the tube ID; sample receipt by scan; coding screen (claim, accept, edit, query, mark coded).

## 4. Workstreams

Each workstream = spec section → plan → TDD build → role-gate harness rows → review. Dependencies noted.

### WS1: Hospital-first patient and doctor experience (P0, L) — fixes A1–A3, G1–G2, G4

1. Role-aware patient page: hide trial widgets unless the patient is enrolled; move screening into its own tab.
2. **Consultation workspace** (new page `/encounters/[id]`): header with allergies/alerts, vitals form (BP, pulse, temp, SpO₂, weight, height, BMI), history, diagnosis picker (ICD-10 from the existing code system) writing to the encounter, Rx builder, lab/imaging orders, procedure orders, advice, follow-up, referral, "Complete visit".
3. Doctor home "Start Encounter" opens the workspace and moves the visit to *In consultation*.
4. Patients list: default columns UHID, name, age/sex, phone, last visit, doctor, payer; trial column only when trials are enabled.
5. Hide Workbook / Pipeline Performance / Trials & Protocols / Client Forms, the trial broadcast filters, and the portal's trial wording from hospital deployments via a feature flag (`ENABLE_TRIALS`) (J12, J8).
6. Portal: show past visits from encounters (J2), a back-link and signed copy after a form (J6), enforce or correct the patient MFA claim (J1).

*Acceptance:* a doctor can see a checked-in patient, record vitals, diagnosis, Rx and orders, and complete the visit without leaving one page; completing prompts for missing diagnosis.

### WS2: Automatic charging and billing (P0, L) — fixes B1, B2, B4, A8, B5

1. On check-in, auto-create the consultation (and registration, first visit) charge from the tariff master for the doctor's department and the patient's payer.
2. Lab/imaging orders price from tariff at order time; show price and "payer covers" on the order.
3. Pharmacy: dispense creates a priced, GST-split bill line from the medication's MRP/batch; remove HCPCS `J3490`; diagnosis optional.
4. IPD: daily room-rent accrual from the room category tariff; nursing and service lines via Charge Capture.
5. Discharge gate: show running bill, advances, insurer share and dues; block or require an override reason if dues exist.
6. Investigate why 32 lines are uninvoiced; add an "invoice all ready lines" action.

*Acceptance:* a walk-in OPD visit with one lab test and one medicine produces a single GST invoice with the correct total and receipt without manual charge entry.

### WS3: IPD admission and bed management (P0, M) — fixes C1–C4, B4

1. Admission form: admission type (planned/emergency), provisional diagnosis, expected stay, attendant details, payer and pre-auth link, deposit.
2. Rules: ward gender check (female not in a male ward, with override reason), one active stay per patient, no OPD token for IPD, block a bed that is occupied or blocked.
3. Bed board: click an occupied bed → Transfer / Discharge / MAR / Charges; show bed tariff and days stayed.
4. Add nursing station views: today's medication round, vitals chart.

### WS4: Lab results and critical values (P0, M) — fixes E1, E2, A6, A7

1. Test definitions get analytes with units and age/sex reference ranges; result entry shows one row per analyte and auto-flags abnormal/critical.
2. Critical value workflow: banner, "notified doctor at <time> by <user>" log, acknowledgement by the doctor.
3. Expand the test and imaging catalogue (panels, ECG, echo, MRI, ultrasound variants) from the tariff master so there is one source.
4. Order dialog: priority, clinical notes, fasting note, and a "Book home collection" button when eligible.
5. Review the verify/release permissions so a lab user can complete the chain or see why not.

### WS5: Pharmacy flow (P1, M) — fixes D1–D3, B3, A5

1. Dispense pre-fills quantity from the prescription; show allergy and interaction warnings; choose batch (FEFO) with expiry; show price.
2. Stock: batches, expiry alerts, reorder levels, purchase/GRN receipt.
3. Prescription builder: multiple drugs, 1-0-1 style frequency, generic names, mandatory dose, print slip with registration number.
4. Success toast and a "Bill now" shortcut after dispensing.

### WS6: Scheduling and front-desk UX (P1, M) — fixes C5–C9

1. Doctor working hours and slot length in Providers settings; slot picker in booking.
2. "Register from this request" in Booking Requests (prefill name, DOB, phone), default date never in the past.
3. Check-in: filter doctors by department, show queue length; token slip shows doctor, room and estimated wait.
4. Assignments list shows patient name plus UHID.
5. Queue display: show setup state and PIN generation in Settings.

### WS7: Forms, notifications, documents (P1, M) — fixes F1, F3, F4, A4

1. Seed hospital forms: general consent, surgical/anaesthesia consent, admission form, discharge consent, MLC intimation, vaccination.
2. Notification service: real SMS/email/WhatsApp channels behind the existing interface, with DLT template ids for SMS, opt-out, delivery log; keep "log only" as a dev channel.
3. Rename "Fax" to "Document inbox"; keep fax as an optional source.
4. Re-authentication (password or OTP) before signing a clinical note.
5. Clean demo data (junk consent).

### WS8: Governance and safety (P1, S–M) — fixes F5, H4

1. Audit log: filters (user, role, patient, action, date), search, CSV export, pagination beyond 200.
2. Patient delete: soft-delete with reason, confirmation that types the UHID, admin-only, audit entry.
3. Add DPDP erasure/export request workflow and retention schedule (later).

### WS9: Wording and UI polish (P2, S) — fixes G3, G5, C10

1. Replace "anon #" / "Anonymous #" with "UHID or chart ID" everywhere.
2. Remove the remaining US-isms (`J3490`, "Wound VAC", Fax).
3. Registration form into steps with a progress bar; add patient photo and referral source.
4. Payers page: put "Add insurer" behind a button.
5. Role dashboards: tiles link to filtered lists; a "needs attention" strip for critical labs, overdue follow-ups, expiring staff credentials.

### WS11: Foundations the rest depends on (P0, M) — fixes I1, I3, I4, I5, I8–I11

Do this first or alongside WS1, since several workstreams cannot be verified without it.
1. **Real code sets:** import WHO ICD-10 (and SNOMED CT / LOINC where licensed) with `npm run codes:import`; remove SAMPLE codes from the pickers in production. Confirm licensing for ICD-10-PCS / HBP packages.
2. **File storage for Docker/self-hosted:** a local-disk (or S3-compatible) blob adapter so report release, card images and documents work without Vercel Blob; a specific error message when storage is unconfigured.
3. **Notification channels:** real SMS (with DLT template id), email and WhatsApp behind the existing `notify` interface; forms, video links and booking notices sent automatically; delivery status shown on the patient chart.
4. **Tariff mapping gate:** every orderable lab/imaging test must map to a tariff service; block activation of unmapped tests; one source of truth for doctor consultation fees (provider roster reads the tariff).
5. **Payments:** merge the demo virtual-card path into the Cash Desk ledger; add UPI QR / payment link and cash/card/UPI modes at every collection point; show paid/outstanding on the invoice list and a "Collect payment" button on the invoice.
6. **Retire legacy billing pages** (Insurance Collections, old statements) or redirect to RCM and the ledger.
7. **Make the Docker stack demo-able for India:** accept `ABDM_USE_MOCKS=true` as well as `1` (K1); allow mock mode in a clearly labelled "demo" image (or a `DEMO_FEATURES` gate) instead of requiring `NODE_ENV!=production`; add `INTEGRATION_PAYLOAD_KEY` to the Docker env template and make a missing secret say so (K2); decide whether the Docker demo should run with staff MFA on (K4).

### WS12: Insurance verification and pre-authorisation (P0, L) — fixes L1–L9, K3, K5–K8

1. Persist every eligibility result with who/when/source and the returned limits; show it on the patient header, Insurance tab, check-in and admission (L1, L3).
2. Manual verification record for insurers not on NHCX, with document upload and expiry (L2).
3. Enforce policy validity dates and warn on stale or missing verification at check-in and admission (L3).
4. ABHA link: compare name, DOB and gender and require an override reason on mismatch (K3, L7).
5. Pre-auth: default doctor and admission details, a refresh-snapshot action, clear messages for frozen snapshots, and an automatic eligibility check before creation (K7, L8).
6. RCM settings: confirmation message on save; show the missing identifier prominently to RCM staff with a link for the admin (K5).
7. Sum-insured balance and sub-limits flowing into charge rules and estimates (L4).
8. Dev tooling: a "simulate ABHA share" action in mock mode (K10).

### WS10: Not built yet (P2, XL, queue separately)

OT scheduling, blood bank, radiology/PACS, diet, CSSD, procurement, birth/death registers, MLC police-intimation workflow, DPDP principal-rights console, real LIS integration, real e-prescribing.

## 5. UI change list (design requests)

1. **Doctor workspace:** two-column layout, patient strip with allergies at the top, tabs for Vitals / Diagnosis / Rx / Orders / Notes, sticky "Complete visit".
2. **Patient list:** hospital columns; trial chip only when applicable; a quick-action menu (check-in, book, bill).
3. **Success feedback:** toast plus "next step" link after dispense, order, check-in, discharge.
4. **Check-in dialog:** payer, fee preview, "Collect now".
5. **Insurance badge** in the patient header linking to eligibility and pre-auth.
6. **Registration** in steps; inline validation messages; save-draft.
7. **Bed board:** card shows days stayed, bed tariff, doctor; panel actions for Transfer / Discharge / MAR.
8. **Lab result entry:** analyte table with auto-flags.
9. **Pharmacy dispense:** quantity prefilled, batch/expiry, price, allergy banner.
10. **Dashboards:** clickable tiles, "needs attention" strip.
11. **Payers:** list first, add form in a drawer.
12. **Settings:** queue-display card with PIN and preview link.

## 6. Suggested order

0. WS11 first (real code sets, file storage, notifications, tariff mapping, payments, a demo-able Docker stack): without it WS2, WS4, WS12 and the RCM/coding work cannot be verified for real. WS12 (insurance verification) follows closely, since it blocks the cashless flow end to end.
1. WS1 and WS2 together (they define the visit-to-invoice path), then WS3.
2. WS4 in parallel with WS3 (separate area).
3. WS5, WS6.
4. WS7, WS8.
5. WS9 can be done alongside any of the above.

## 7. Test plan additions

- A role-by-role end-to-end script (the walkthrough in section 1) turned into Playwright/Vitest scenarios, run against the Docker stack.
- New cases: ward-gender rule, one active stay, auto-charge on check-in, price at order, GST on dispense, discharge dues gate, analyte auto-flag, critical acknowledgement.
- Extend both RBAC harnesses for every new page and route.

## 8. Cleanup after this test session

Test records created in the local Docker database (all fictional):
- **QA Test Patient One** (RD-0051, UH000002013): completed OPD visit, discharged IPD stay with follow-up, ₹500 advance receipt `RCT/26-27/000009`, appointment on 26 Oct 2026 with Dr. Kavya Hegde (with a telemedicine session created), a Telehealth Consent form sent (not submitted), portal access enabled (sign-in done, consent gate not accepted).
- **Sarojamma K** (RD-0040): paracetamol prescription and dispense (15, not billed), CBC and Dengue NS1 orders, signed note, CBC result 7800 (verified, report release failed), home collection for 24 Oct collected by Ravi Kumar (sample `L261023-0002-6`).
- **Kavitha Reddy** platelet result verified.
- **Fathima Beevi** (RD-0020): policy `QA-POL-0001` (HDFC ERGO) and pre-auth `PA-2026-000003` (requested).
- **Abdul Rahman**: draft invoice #8 finalised as `INV/26-27/000012`.
- **Coding:** encounter 1 (Ramesh Gowda) claimed by the coder, in progress.
- **Settings:** queue-display PIN set to a test value.
- **Patient portal (RD-0051):** draft privacy notice and terms accepted for the test patient; Telehealth Consent form submitted; one message sent and a staff reply sent.
- **Forms:** the empty "Untitled Form" (id 8) was renamed "QA Test Admission Form" and archived.
- **Tariffs:** test service `QA_TEST_SVC` (id 35) with a ₹750 rate and a scheduled ₹800 rate from 24 Oct 2026; deactivate it when no longer needed.
- **Broadcast:** one simulated broadcast to 51 recipients appears in Broadcast History.
- **Telemedicine:** a session for the QA appointment was created and ended.
- **MFA/ABDM/NHCX tests (isolated copy on port 3002, now stopped and deleted):**
  - Throwaway staff user `qa.mfa@hims.local` (id 12): created for the MFA test, role changed during testing, and now **login disabled** (password and MFA cleared). It cannot be deleted because audit rows reference it; delete once those are cleared.
  - Mock ABHA `91-3024-4651-3468` linked to RD-0051 (marked "Sandbox mock - not real").
  - Policy `QA-POL-0001` is verified in mock only; pre-auths `PA-2026-000003` (requested) and `PA-2026-000004` (requested) exist for RD-0020.
  - The insurer NHCX participant code and the hospital ROHINI/HFR IDs set for the test were **reverted to empty**.
  - Mock consent rows (`abdm_consents`) and NHCX mock exchanges exist for the test.
- **Not touched:** `.env.local` (it contains real cloud credentials, which were not used), `.env.docker`, and the running Docker containers.

Reset with `SEED_RESET=1 npm run db:seed` if a clean demo is needed. The patient-portal password for RD-0051 was shown once and is not stored here.

## 9. Needs owner or legal input (not code)

ABDM/NHCX onboarding and credentials; DLT registration and templates for SMS; WhatsApp provider; legal review of consent wording; ICD-10-PCS/SNOMED licensing; a decision on whether trials stay in the product for this client.
