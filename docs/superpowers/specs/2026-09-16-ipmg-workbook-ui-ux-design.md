# IPMG Research Pre-Screening Workbook — UI/UX & Backend Design

## Document Information

| Field | Value |
|---|---|
| Project | Clinsync — Research Pre-Screening Automation (Symbiosys Technologies → IPMG) |
| Document Version | 1.0 (Draft) |
| Date | 2026-09-16 |
| Status | Draft — pending user review |

## Provenance

This design is grounded in three existing source documents (not invented from scratch):

- `Symbiosys_IPMG_Prescreening_Proposal.pdf` (v1.0, 16 Sep 2026) — the client-facing pilot proposal: scope, the 30-column workbook, HIPAA/BAA terms, and the delivery timeline.
- `ipmg_detailed_architecture.tex` (15 Sep 2026) — technical blueprint: AWS/Bedrock infrastructure, FHIR/SOAP integration detail, isolated Postgres persistence, quote-verification policy.
- `IPMG` (engineering notes, undated) — field-by-field API mapping for all 30 workbook columns, open questions, sprint plan, and a competing "zero-storage" persistence proposal.

Where the two technical documents disagreed (storage model) or left a question open (web app vs. Excel), this design records the decision the user made during brainstorming, not a default.

## 1. Purpose & Scope

Build the internal tool that lets IPMG's research team pre-screen depression-trial referrals without re-keying data by hand. The tool reads a referral from **IntakeQ**, finds the same patient in **Tebra**, assembles the chart facts the team's existing review workbook needs, and evaluates them against one clinical trial's criteria — with every automated value traceable to its source and every eligibility decision left to a human.

**In scope for this design:** the web application's UI/UX (all screens, roles, visual system) and the backend architecture that serves it (connectors, data model, rule engine, API surface).

**Out of scope** (unchanged from the client proposal — do not build): writing to Tebra or IntakeQ, contacting patients, making eligibility decisions, clinical advice, phone/text ingestion, billing/insurance access.

**Explicitly in scope for this iteration beyond the original pilot:** the data model and UI are generalized to a first-class **Trial/Protocol** concept from day one, so a second trial or site is a new configuration entry, not a rebuild. The pilot ships with the Redlands MDD trial (NCT06911112) configured first, but **IPMG runs trials across multiple psychiatric conditions (depression, ADHD, anxiety, and others)** — nothing in the screening logic, rating scales, diagnosis codes, or medication rules may be hardcoded to depression. Every condition-specific detail (which rating scale applies, which ICD-10 codes count, which medication class and washout period matter) is a property of the Trial/Protocol configuration, not of the application code.

## 2. Users & Roles

| Role | Who | Can do |
|---|---|---|
| **CRC (Research Coordinator)** | Primary daily user (~2–4 hrs/week per proposal) | View all fields, edit staff-owned columns, trigger refresh, resolve the Identity Matching queue, export to Excel |
| **PI (Principal Investigator)** | e.g. "Dr. Kunam" | Read-only on all system/IntakeQ/Tebra fields; can write their own recommendation field and record final eligibility sign-off |
| **Admin / IT** | IPMG IT contact + Symbiosys engineering | Manages Trials & Protocols configuration, Settings (connection health, user access), full Audit Log detail |

Role changes what **actions** are visible, not which pages exist — all three roles see the same navigation.

## 3. Information Architecture

Left navigation, present for all roles:

1. **Patients** (default landing page) — the workbook
2. **Identity Matching** — referrals needing human confirmation
3. **Trials & Protocols** — criteria configuration (Admin-editable; visible read-only to others)
4. **Audit Log** — access history
5. **Settings** — connections, users, compliance status

A persistent top banner (visible on every screen) shows: environment (Pilot / Production), the currently-selected Trial/Protocol filter (or "All Trials"), and IntakeQ/Tebra connection health (green/red dot each) — because "is this actually connected and read-only" is a recurring trust question the client proposal itself raises.

## 4. Screens

### 4.1 Patients (the Workbook)

The home screen. A dense, spreadsheet-style table of all 30 columns:

- **A Trial filter/switcher at the top of the table** — a patient may be referred to, and screened against, more than one trial (e.g. an ADHD trial and a depression trial), so the workbook is always scoped to "patients for Trial X," with an "All Trials" view for coordinators managing several at once. This replaces a single fixed "active trial" in the top banner with an actual selector.
- Virtualized/scrollable for performance; column show/hide; saved views (e.g. "Needs Review," "All Green")
- Leading column shows the 🟢/🟡/🔴 screening status **with icon + label**, never color alone
- Each system/IntakeQ/Tebra-sourced cell shows a small source tag on hover and a "chart data as of [timestamp]" tooltip, per the column-ownership rule in the proposal (system never overwrites staff columns; staff columns are 12, 17–20, 23, 24, 28)
- Staff-owned cells are inline-editable; sourced cells are visually locked (read-only lock icon)
- Row-level "Refresh from Tebra/IntakeQ" action, plus a bulk refresh
- "Export to Excel" action (generates `.xlsx` matching the client's current layout via `openpyxl`)

### 4.2 Patient Detail

A full page at its own route (e.g. `/patients/RD-0001`) — not a slide-over — so it's linkable and referenceable from the Audit Log.

- **Field order matches the original 30-column numbering exactly** (Anonymous Number → ... → Research Depression Prescreening Sent Date). No re-grouping into invented buckets — staff should find a field exactly where the existing workbook has it.
- **Dual-sourced fields** (Name, DOB, City, Zip, Email, etc.) render as a 3-column comparison strip: IntakeQ value / Tebra value / merged value actually used in the workbook. A mismatch between the two sources is highlighted in amber automatically — no extra click needed to notice it.
- **Screening Evidence panel**, positioned above the field list as the visual centerpiece of the page: one card per trial criterion, with a large 🟢/🟡/🔴 chip, the criterion text, and the **exact quoted chart line** in a distinct evidence-quote style (monospace, quote treatment) with its source document and date underneath. This is the single most trust-critical element in the product — it must read as a citation/footnote, not a form field, because the entire pitch to IPMG is "never an unsourced answer."
- Direct "Open in Tebra" deep link (field 25 in the original workbook).

### 4.3 Identity Matching Queue

A worklist for referrals that didn't auto-match with confidence (the proposal's "Needs identity confirmation" flag). Each item is a side-by-side card: IntakeQ referral facts vs. one or more candidate Tebra charts, with a **Confirm** or **Reject** action per candidate. The system never auto-selects — a human always confirms the link before any chart data is pulled into that patient's row.

### 4.4 Trials & Protocols (Admin)

A list of configured trials across whatever conditions IPMG is actively recruiting for — the pilot launches with the Redlands MDD trial, but the screen and its data model make no assumption about condition type. Each trial's detail page holds its criteria as structured, editable rules:

- **Condition / therapeutic area** (e.g. Major Depressive Disorder, ADHD, Generalized Anxiety) — drives which of the fields below are relevant, not a fixed set baked into the app
- **Diagnosis codes** (ICD-10) that count toward eligibility for this trial specifically — not a single hardcoded depression code list
- **Rating scale(s) used** for this trial (e.g. PHQ-9/GAD-7 for a depression trial, ASRS/Conners for an ADHD trial) — the workbook's "Rating Scales" column (field 5) reads whichever scale is configured for that patient's trial, not a fixed scale
- **Medication class(es) of interest and washout/duration rules** (e.g. "on current antidepressant dose ≥ 8 weeks" for the MDD trial; a different class and duration for a stimulant trial)
- Age range, site, study drug, NCT number

This is what makes "designed to grow across conditions" real: adding a second trial for a different condition is filling out this form with that condition's own rules, never shipping new code or new hardcoded logic.

### 4.5 Audit Log

Chronological, filterable by user / patient / date range, read-only, exportable. Every PHI-visible screen logs a view event here automatically — this screen is the proof of that logging for compliance review, not a warning shown to staff during normal use.

### 4.6 Settings

- IntakeQ and Tebra connection status with a "Test Connection" action (never displays the raw API key/secret)
- BAA / compliance status indicator
- User list with role assignment
- Deployment-mode badge (Pilot / Production), consistent with the badge pattern IPMG's own Tebra/IntakeQ instances already use

## 5. Visual Design System

This is a clinical research compliance tool, not a consumer or marketing product — the design deliberately avoids glassmorphism, bento grids, shiny-button gradients, or decorative motion, since those work against the scanability and trust this tool depends on. Instead:

- **Dense, high-contrast, functional** — closer to an EHR or financial-compliance dashboard. Generous but non-decorative whitespace.
- **Status color system**: green / amber / red for 🟢 / 🟡 / 🔴, always paired with an icon and label — colorblind-safe by construction, matching the client proposal's own convention.
- **Typography**: a clean sans for UI text; monospace for identifiers, timestamps, and evidence quotes, so a verbatim source citation is visually distinguishable from our own prose at a glance.
- **Light theme by default** (a coordinator's daytime desk tool, not a long-session dark-mode production tool), with a working dark toggle.
- Minimum 4.5:1 contrast, visible keyboard focus states throughout, responsive down to a standard laptop width (not designed mobile-first).

## 6. HIPAA-Driven UI Patterns

- Persistent compliance/environment banner (§3) is always visible, never buried in Settings.
- Session timeout with an explicit warning modal before auto-logout — PHI should not linger on an unattended screen.
- Routes and browser history use the **anonymous ID** (e.g. `RD-0001`) only — never name or DOB in a URL.
- Every IntakeQ/Tebra-sourced field carries a read-only lock icon, reinforcing "we cannot write here" directly in the UI, not only in a contract.
- Every PHI-visible page view is logged automatically to the Audit Log (§4.5) — a trust feature demonstrable to a compliance reviewer, not a friction point for staff.

## 7. Backend Architecture

Persistence model: **isolated Postgres persistence** (per the architecture blueprint, chosen over the competing "zero-storage" proposal during brainstorming). Extracted data is normalized and stored in Symbiosys's own encrypted database, refreshed on demand — the UI shows instant, always-available views with an explicit "Refresh from Tebra" action rather than a live-fetch-on-every-page-load pattern.

### 7.1 Connectors

- `connectors/intakeq.py` — REST, `X-Auth-Key` header auth, webhook receiver for `Intake Submitted` events, token-bucket rate limiter respecting the 10 requests/minute, 500/day plan limit.
- `connectors/tebra_fhir.py` — OAuth2 client-credentials flow; reads `Patient`, `MedicationRequest` (active + inactive), `Condition`, `DocumentReference`, `Procedure`.
- `connectors/tebra_soap.py` — fallback using the legacy Kareo SOAP API (`GetPatients`, `GetAppointments`) for demographics/appointments if FHIR activation is delayed or denied.

### 7.2 Patient Matcher

`identity/matcher.py`: exact match via `ExternalClientId` if IntakeQ already stores the linked Tebra ID; otherwise fuzzy match on last name + first name + DOB (similarity threshold ≥ 85%). Every fuzzy match requires human confirmation via the Identity Matching Queue (§4.3) — never an automatic guess.

### 7.3 Data Model (Postgres)

| Table | Holds |
|---|---|
| `patients` | Anonymous ID ↔ encrypted IntakeQ client ID + Tebra patient ID mapping |
| `trials` | Trial/protocol definitions: condition/therapeutic area, site, drug, NCT number, and its own diagnosis-code set, rating scale(s), and medication-class/washout rules — generalized so a second trial for a *different condition* is a new row with its own rule set, not new code |
| `patient_trial_screenings` | Join between a patient and a trial they've been referred to — a patient may be screened against more than one trial concurrently |
| `medication_episodes` | Stitched active/inactive medication history with start/stop dates, built from `MedicationRequest` + note-derived dose changes; tagged by medication class so any trial's washout rule can query the relevant class |
| `evidence` | Exact quote, source `DocumentReference` id, document date — the citation backing every automated statement |
| `screening_results` | 🟢/🟡/🔴 verdict per `patient_trial_screening` per criterion, linked to its `evidence` row |
| `audit_log` | User, timestamp, patient (by anonymous ID), action — write-only, retained |

Manual/staff-owned fields (12, 17–20, 23, 24, 28 in the original 30-column map) are stored keyed to the anonymous ID only, never alongside PHI.

### 7.4 Rule Engine & LLM Extraction

- **Rule engine** (deterministic Python): evaluates structured facts (medications, diagnoses, dates) against a trial's configured criteria. This component decides the 🟢/🟡/🔴 verdict — never the LLM directly.
- **LLM extraction layer** (Claude via AWS Bedrock, per the architecture blueprint — chosen specifically for HIPAA eligibility, zero data retention, and VPC-only network isolation; consumer AI APIs are never used with patient data): extracts a fact from an unstructured clinical note along with an `exact_quote`. A deterministic string-match step then verifies that quote exists verbatim in the source document. If it doesn't match character-for-character, the fact is discarded and the field defaults to 🟡 Needs Verification — this is the "zero hallucination policy" the evidence panel (§4.2) is built to display.

### 7.5 API Layer

REST endpoints mirroring the screens: `GET /patients`, `GET /patients/{id}`, `POST /patients/{id}/refresh`, `GET /identity-matches`, `POST /identity-matches/{id}/confirm`, `GET /trials`, `POST /trials/{id}/criteria`, `GET /audit-log`, `GET /workbook/export`.

### 7.6 Infrastructure & Security

VPC-isolated deployment, VPN or Zero-Trust proxy for all staff/developer access, encryption at rest and in transit, a NAT Gateway with a static IP for outbound calls to Tebra/IntakeQ (so IPMG's vendors can allow-list the application), and a hardened WAF-fronted webhook endpoint as the only public-facing path — matching the architecture blueprint's security section.

## 8. Deliverable: Clickable Prototype with Mock Data

To let Symbiosys show IPMG what the finished tool looks like before real API access exists, build a **standalone interactive prototype** (no real backend calls) covering:

- Patients workbook table with ~15–20 realistic-but-fictional mock patients across a spread of 🟢/🟡/🔴 statuses, **split across at least two trials for two different conditions** (e.g. the Redlands MDD trial and a mock ADHD trial) so the Trial filter/switcher and per-trial rule differences are actually visible in the demo, not just described
- One fully fleshed-out Patient Detail page demonstrating the evidence panel and the dual-source comparison strip, shown for a patient in each of the two demo trials so the differing rating scale/medication rule per trial is visible
- The Identity Matching Queue with 2–3 example ambiguous-match cases
- Trials & Protocols showing both configured trials, each with its own diagnosis codes, rating scale, and medication/washout rule filled in
- Audit Log with plausible sample entries
- Settings showing both connections as "Connected" (mock) with the compliance banner

All mock data must be clearly fictional (no real patient names/dates, synthetic NCT/study details reused from the public trial listing only) and the prototype must carry a visible "PILOT / DEMO — NO REAL PATIENT DATA" watermark or banner so it can never be mistaken for production, or shared further, without that caveat.

## 9. Open Questions Carried Forward

These come from the existing engineering notes and remain unresolved — they affect implementation but not this UI/UX design:

- Which IntakeQ form template ID is the "Redlands Adult Depression" referral (`QuestionnaireId`)?
- Is IPMG's Tebra plan tier one that includes FHIR API access, or does the pilot need to start on the SOAP-only fallback?
- Does IntakeQ's `ExternalClientId` already store a linked Tebra patient ID, or does every patient need fuzzy matching?
- Does IPMG use Microsoft Entra ID / M365 SSO for staff login (affects the Settings SSO configuration)?
- Fields 17–18 reference "SJC iPhone" texts and "Care Ext Notes" — confirm these are staff-manual-entry only, not a system to integrate.
- Signed BAA, Tebra FHIR activation, and IntakeQ API key are all still pending per the proposal — blocking for real data, not for this design or the mock prototype.

## 10. Self-Review Notes

- No unresolved placeholders remain outside §9 (which is explicitly a tracked open-questions list, not a gap in this design).
- Storage model, UI form factor, and structural approach reflect explicit user decisions made during brainstorming (isolated Postgres, web app, single-app tab nav), not defaults.
- Patient Detail section reflects the four explicit revisions requested (full page, evidence prominence, original field order, side-by-side source comparison).
- Scope is deliberately scoped to one trial today, generalized via the `trials` table for future growth, per the user's "both — pilot now, designed to grow" answer.
- Multi-condition support (depression, ADHD, anxiety, and others at IPMG) is treated as a day-one requirement, not a future nice-to-have: rating scales, diagnosis codes, and medication/washout rules are all per-trial configuration (§4.4, §7.3), and the demo prototype (§8) proves this by including two trials for two different conditions rather than one.
