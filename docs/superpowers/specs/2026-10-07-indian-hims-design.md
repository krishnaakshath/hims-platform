# Indian-hospital HIMS: design spec

**Date:** 2026-10-07 · **Status:** draft for owner review · **Repo:** hims-platform (public)

## 1. Understanding (what was asked, what is assumed)

The owner wants the HIMS to work for an **Indian hospital**. Their requirements, in their words, condensed:

1. **Follow-up:** change a patient's follow-up; front desk must also have access.
2. **Labs:** for local patients, notify them to do tests → **home collection** of samples → reports → they come back for a check-up.
3. **National health stack:** ABHA and Aadhaar fields mandatory; **NHCX** (National Health Claims Exchange).
4. **Revenue-cycle management (accounts dept):** claim insurance bills; one copy kept with RCM, one sent to the insurer; the insurer keeps its copy and updates status in its portal.
5. **Tariff fixation:** by room, ward and department.
6. **Valid intake charge** against procedural requirements.
7. **"L5" clinical and coding.**
8. Many fields are missing in general; audit and fill them.

**Assumptions (correct me):** "L5 clinical and coding" means a clinical-coding tier (ICD-10 diagnosis and procedure/package coding with a coder role and worklist). "Valid intake charge against procedural requirements" means charge capture is checked against rules (service master, prerequisites, deposits, pre-auth). The product is for a single hospital per deployment (white-label, one DB per client). Currency INR, timezone Asia/Kolkata.

## 2. Findings that shape the design (from a code audit)

The repo is a US-flavoured practice app: US payer enums, USD cents, `America/Los_Angeles`, drivers-licence/green-card ID types, free-text `diagnoses.code`, no service or tariff master, claims are seed-only (no API creates or updates a claim), notifications are simulated except OTP SMS, no PDF generation. It has a usable base: appointments, admissions/rooms, lab orders, charges workflow, a patient portal, AES-256-GCM field encryption, FHIR export, audit log, role gates.

## 3. Cross-cutting decisions

- **Money:** integer **paise** everywhere, `currency='INR'`; migrate existing cents columns' meaning (they are demo data). GST per line (HSN/SAC, rate, CGST/SGST/IGST split).
- **Time:** default timezone Asia/Kolkata, wired into display (the setting exists but is unused).
- **Aadhaar:** collected with explicit consent, **encrypted at rest** (existing AES-GCM helper), only the **last 4 shown** in UI, **never logged or placed in URLs/exports/FHIR**; Verhoeff checksum validated. "Mandatory" is enforced at registration with a documented override reason for patients who decline (law forbids denying care for lack of Aadhaar), recorded in audit.
- **ABHA:** 14-digit ABHA number + ABHA address stored; verification/linking goes through the ABDM gateway behind an interface with a **sandbox/mock implementation by default**; real credentials (NHA client id/secret, HIP/HIU registration) are supplied per deployment. Without them the UI states "not connected".
- **NHCX:** FHIR R4 Claim / CoverageEligibilityRequest / Claim(preauth) bundles generated per the NHCX profiles, behind a gateway interface with a mock; real submission needs NHA onboarding.
- **Notifications:** one service (`src/lib/notify`) with SMS / email / WhatsApp / in-app channels, templates, delivery log and opt-out; replaces the simulated senders. Provider credentials per deployment; a dev "log only" channel.
- **Documents:** server-side PDF generation (discharge summary, lab report, invoice/receipt, claim copy), stored via the existing blob store.
- **RBAC:** new roles `coder` and `rcm` (insurance desk); every new page and API gets an inline role gate and a row in both RBAC harnesses (no gap tags).
- **No fake data in production,** same rule as the EHR connectors: gateways return "not configured" unless a real credential exists; mocks only behind an explicit env flag.

## 4. Sub-projects (each: spec section → plan → build → review). Order and dependencies

1. **Indian patient master & identity** (foundation; none). Demographics (gender, marital status, blood group, occupation, nationality, religion, language, photo), structured address (line, state, district, PIN), NOK/guardian/emergency contact, UHID generator, Aadhaar (encrypted/masked), ABHA number/address, KYC doc type, MLC flag, **department/specialty master**, doctor **NMC/SMC registration** and consultation fee. Registration form + patient profile + portal view.
2. **Service/charge master & tariffs** (needs 1). Service catalogue (code, name, department, HSN/SAC, GST), **room-category and ward tariffs**, **department price lists**, **per-payer/TPA tariffs**, packages, effective-dated versions. Admin screens; lookup API used by billing.
3. **Encounters, OPD/IPD & follow-up** (needs 1). Encounter entity (OPD token, IPD admission link), **follow-up order** (prescribed-by vs scheduled-by, date, plan, status, linked to originating encounter/lab report), recall worklist, **front desk can view and reschedule**, doctor/admin can set the plan; discharge-summary PDF.
4. **Charge capture & validation** (needs 2, 3). Auto-price from the master; rule engine (service exists and active, department match, consultation-before-procedure, admission deposit/advance, pre-auth required for package/payer, duplicate-charge guard); GST invoice and receipt numbering, advances, refunds, credit notes.
5. **Lab LIS extension & home collection** (needs 3; pricing via 2). Status machine `ordered → scheduled → collected → received → resulted → verified → reported`; sample IDs/barcodes; **home-collection** booking (address, slot, collector assignment, route list, collector role/page); patient notification to do tests; PDF report to portal; result triggers follow-up booking; for local patients only (service-area PIN list).
6. **Clinical coding "L5"** (needs 3, 2). ICD-10 (diagnosis, with primary/secondary/provisional type and encounter link), procedure/package coding (ICD-10-PCS/HBP packages), SNOMED CT/LOINC bindings on FHIR, **coder role + coding worklist**, audit of changes; code sets loaded from versioned import files.
7. **RCM, insurer/TPA & claims** (needs 2, 4, 6). Insurer and TPA masters, patient policy/card details, **pre-authorisation**, **claim state machine** (draft → submitted → queried → approved/rejected → settled), **claim copies/versions (RCM keeps a copy, insurer copy generated and tracked)**, insurer-portal status updates logged by RCM, query/response log, denial management, settlement/TDS, statements; RCM dashboard and `rcm` role.
8. **ABDM / NHCX integration** (needs 1, 6, 7). ABHA verify/link/consent artefacts, NHCX FHIR bundles and gateway submission/status callbacks (mock + real adapter).

Parallelism: 1 ‖ 2 first; 3; then 5 ‖ 6; then 4; 7; 8.

## 5. Out of scope for this spec (flag, don't build yet)
OT scheduling, blood bank, radiology/PACS, diet, CSSD, procurement, birth/death registers, MLC police intimation workflow, DPDP data-principal-rights console. Listed so the owner can queue them.

## 6. Testing & delivery
Each sub-project: TDD, unit + DB tests per task, role-gate harness rows, a final whole-branch review, then merged to `main` of hims-platform. No DB is attached to this repo yet: DB-backed tests run once the owner connects the HIMS Neon database; until then work is verified with unit tests, `tsc`, lint, and build.

## 7. Risks
Real ABDM/NHCX onboarding needs NHA registration (owner/legal); code-set licensing (ICD-10-PCS/SNOMED) must be confirmed; schema changes need a migration path (`db:push` only on a fresh DB, per `docs/DEPLOYING.md`) so each sub-project ships a reviewed SQL migration.
