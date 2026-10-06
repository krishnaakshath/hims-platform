# FHIR / C-CDA Export API — Design Spec

**Status:** Draft for review — design spec, not yet implemented.
**Position in the larger initiative:** last item in the current "complete the HIMS platform" backlog wave — interoperability export, so a patient's record can leave this system in a standards-based format another EHR or a patient's personal health app can actually read.

## 1. What this is, and the boundary it works within

Full FHIR (HL7 FHIR R4) is a huge specification — hundreds of resource types, a query/search API, SMART-on-FHIR OAuth for third-party app access, bulk data export, subscriptions. Building a "real" FHIR server is not a bounded scope for one spec, and claiming this app "supports FHIR" without saying exactly what that means would be dishonest — the same discipline this codebase already applies to e-prescribing (declining to simulate it at all rather than build something that looks real but isn't).

This spec is honest about being **read-only, single-patient, staff-authenticated export of a fixed set of the most clinically load-bearing FHIR resources**, covering the data classes in ONC's USCDI (the actual U.S. regulatory baseline for what "basic interoperability" means) that this app already has real structured data for: Patient, AllergyIntolerance, Condition (from diagnoses), MedicationRequest (from `medicationEpisodes`), MedicationDispense (from the Pharmacy module), Observation (from Lab Results), and DocumentReference-style narrative (encounter notes). Every resource is generated fresh from this app's existing data at request time — not a separately-maintained shadow copy that can drift.

This spec also adds a **C-CDA export** (a "Continuity of Care Document," the XML document format real EHRs exchange for a patient transfer or referral) — a single, real, standards-shaped XML document per patient, built from the same underlying data as the FHIR resources.

**Explicitly out of scope:** FHIR *write* operations (accepting external data into this app) — export only, one direction. A generic FHIR search API (`GET /fhir/Patient?name=...`) — every route in this spec is scoped to one already-known, already-authorized patient, not a general query surface (a general search API is a real access-control surface with its own scope). SMART-on-FHIR OAuth for third-party app authorization — export routes use this app's existing staff session auth, the same as every other route in this codebase; a patient authorizing a third-party app to pull their own FHIR data is a real, valuable, and genuinely large feature (this is most of what "real" FHIR interoperability is for) but is its own spec, not assumed here. Bulk/multi-patient export (`$export` operation) — one patient at a time, matching every other export/print-style feature already in this app.

This spec adds:
1. `GET /api/patients/[anonId]/fhir/Patient`, `.../AllergyIntolerance`, `.../Condition`, `.../MedicationRequest`, `.../MedicationDispense`, `.../Observation` — each returns a valid FHIR R4 `Bundle` (or single resource for Patient) as JSON, mapped from this app's existing tables.
2. `GET /api/patients/[anonId]/fhir/Bundle` — all of the above resources combined into one `Bundle` (a "everything about this patient" export), the practical single-click export a staff member would actually use.
3. `GET /api/patients/[anonId]/ccda` — a C-CDA XML document (Continuity of Care Document template) covering the same data.
4. An **"Export Record"** action on the Medical Record page offering both formats as downloads.

## 2. Data model changes

None. This is a pure read/transform layer over existing tables — no new schema.

## 3. FHIR resource mapping (the real design work)

Each mapping is a pure function, `patient → FHIR resource(s)`, in `src/lib/fhir/`, one file per resource type, each independently testable against a fixed patient fixture with known expected output (not snapshot-testing the whole bundle — testing each field mapping explicitly, so a future data-model change that silently breaks one field is caught precisely).

- **Patient**: `patients` table → FHIR `Patient` (name, birthDate [use `dobTebra` if present else `dobIntakeq`, matching this app's existing Dual-Sourced Fields precedence convention elsewhere], gender if tracked, identifier using the anonymized `RD-####` id as the FHIR resource id — never a raw SSN or other real-world identifier this app doesn't even store).
- **AllergyIntolerance**: `allergies` table, one FHIR resource per row (allergen as `code.text` free text — this app doesn't store a coded RxNorm/SNOMED allergen, so honestly export as text rather than fabricate a code system mapping that isn't real).
- **Condition**: sourced from wherever this app's diagnosis data actually lives (read the codebase first — likely `patients.diagnosisTebra`/`diagnosisIntakeq` or a dedicated field; do not assume a table name).
- **MedicationRequest**: `medicationEpisodes` (the patient's reconciled med list) — one resource per active episode.
- **MedicationDispense**: `medicationDispenses` (from the Pharmacy module) — one resource per dispense event, referencing the medication by name (this app's `medications` catalog has no RxNorm code either — same honest-text-not-fabricated-code approach as allergies).
- **Observation**: `labResults` (from the Lab Orders module) — one resource per resulted lab, value/unit/referenceRange/flag mapped to FHIR's `valueQuantity`/`referenceRange`/`interpretation`.

**Why free-text `code.text` instead of a real coding system (RxNorm/SNOMED/LOINC) almost everywhere:** a FHIR resource claiming a coded `system`+`code` when the underlying data was never actually coded against that terminology is worse than honest free text — a receiving system would treat a fabricated code as authoritative and could act on it incorrectly. The one exception: lab tests already carry a `code` field in this app's `labTests` catalog (seeded as LOINC-style codes, but explicitly documented in that module's own spec as "reference data only, not verified against the real LOINC database") — so Observation resources include that code but the mapping function's own tests and the code's own schema comment must carry that same caveat forward, not silently upgrade its confidence level by putting it in a FHIR resource.

## 4. C-CDA export

A single XML document per patient following the CCD (Continuity of Care Document) template structure — header (patient demographics, document metadata) plus the standard CCD sections this app has real data for: Allergies, Medications, Results (labs), Problems (conditions). Built from the same mapping functions as §3 (a `toCcdaXml(patient)` function composes the same underlying data, not a separate parallel implementation that could drift from the FHIR mapping) using a template/string-building approach (no new XML library dependency needed for a fixed, known document shape — read `package.json` first to confirm nothing suitable is already a dependency before adding one).

## 5. Access & display

Both export routes require an authenticated staff session (this app's normal `requireSession()`) scoped to the same patient-detail read access every other patient-data route already has — no new role tier. The Medical Record page's "Export Record" action offers "Download as FHIR (JSON)" and "Download as C-CDA (XML)", each a plain authenticated `GET` returning a file download (`Content-Disposition: attachment`), matching how any other document download in this app already works (read the existing Documents feature's download route for the exact convention before inventing a new one).

Every export call is audit-logged (`logAudit(session, <action>, patientId)`) — an export is a genuine data-egress event and belongs in the audit trail like every other patient-data access in this app. Rather than one shared literal across all 7 FHIR routes, the implementation logs its own specific, more descriptive action string per route, which is more useful for reading the audit trail (e.g. distinguishing a full-Bundle export from a single-resource-type export at a glance without inspecting the request path): `'exported full FHIR Bundle'` (`/fhir/Bundle`), `'exported FHIR Patient resource'` (`/fhir/Patient`), `'exported FHIR AllergyIntolerance bundle'` (`/fhir/AllergyIntolerance`), `'exported FHIR Condition bundle'` (`/fhir/Condition`), `'exported FHIR MedicationRequest bundle'` (`/fhir/MedicationRequest`), `'exported FHIR MedicationDispense bundle'` (`/fhir/MedicationDispense`), `'exported FHIR Observation bundle'` (`/fhir/Observation`), and `'exported C-CDA document'` (`/ccda`).

## 6. Testing

`tests/lib/fhir/patient-mapping.test.ts`, `.../allergy-mapping.test.ts`, `.../condition-mapping.test.ts`, `.../medication-request-mapping.test.ts`, `.../medication-dispense-mapping.test.ts`, `.../observation-mapping.test.ts` — each tests its one mapping function against a real DB-backed fixture patient with known field values, asserting exact FHIR field-by-field correctness (resourceType, id, the specific clinical fields) — not just "no error thrown." `tests/lib/fhir/ccda-export.test.ts` (the composed XML document is well-formed XML — parse it back and confirm — and contains the same underlying facts as the FHIR bundle for the same patient, proving the two don't drift). `tests/api/fhir-export-routes.test.ts` (role/session gating, two patients' exports never cross — matching this session's established review-focus pattern, a patient with zero allergies/conditions/meds/labs still produces a valid empty-but-well-formed Bundle rather than an error).

## 7. Role gating summary

| Action | Allowed roles |
|---|---|
| Export a patient's FHIR bundle or C-CDA document | admin, pi, crc, frontdesk (matches existing chart read-access precedent — export is a read operation on data these roles can already view) |
