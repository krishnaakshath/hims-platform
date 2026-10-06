# Medical Record Page Redesign — Design Spec

**Status:** Draft for review — design spec, not yet implemented.
**Position in the larger initiative:** the second item in the "make HIMS the real product" wave, sequenced to start only after `2026-09-29-unified-patient-record.md` has merged into `hims-platform` — this spec assumes a single-sourced `patient.name`/`patient.dob`/etc. already exists, not the old Tebra/IntakeQ pairs.

## 1. What this is, and the boundary it works within

The current Medical Record page (`src/app/(dashboard)/patients/[anonId]/medical-record/page.tsx`) is a single long scrolling column: header, Dual-Sourced Fields table (removed by the unified-patient-record migration), Diagnoses, Medication History, Care Plan, Medications Dispensed, Screening Questionnaires, Allergies, Insurance, Notes, Lab Results — each its own full-width section, in whatever order tasks happened to append them over the course of this session. The user showed a reference product's patient-detail screen using a **categorized card grid** instead (a "Facesheet" tab with small cards — Medications, Appointments, Patient Portal, Messages, Documents, Clinical Notes, Charges, Orders and Results, Problems, Vitals, Allergies, Labs/Studies, Forms — each a compact summary with a link into the full detail), plus a left-hand sub-nav (Facesheet / History / Appointments / Problems / Medications / Allergies / Vitals / Labs / Forms) for jumping straight to one category instead of scrolling.

This spec keeps every clinical data section Clinsync already has — nothing is dropped — and reorganizes them into that categorized card layout, using the now-single-sourced patient fields, and adds the two genuinely new things the user asked for on this specific page: **inpatient/outpatient status**, and a visible **Export Record** / document / messaging surface consistent with the rest of the redesign.

**Explicitly out of scope:**
- The patient list/grid page (`/patients`) — the user explicitly said this page is already good as-is and should not change.
- Any new clinical data category not already tracked somewhere in Clinsync (e.g. no new Vitals-entry feature — if Clinsync doesn't track vitals today, the Vitals card says so plainly rather than inventing fake data entry).
- Consent-form embedding in the forms flow, or the Forms Hub's own redesign — separate specs (`2026-09-29-forms-hub-and-embedded-consents.md`).
- The Tebra/IntakeQ data-model collapse itself — a prerequisite, not this spec's job.

## 2. Data model changes

None. This is a pure presentation-layer reorganization of data every one of these sections already reads today. The one new query is read-only: "does this patient have a currently-open `admissions` row" (see §4), which is an existing table, not a new one.

## 3. Layout

Two-column layout under the existing patient header (avatar, name, DOB, current inpatient/outpatient status — see §4 — Export Record links):

**Left rail** (sub-nav, matches the reference's Facesheet/History/Appointments/etc. list): Facesheet (default view — the card grid below), Diagnoses, Medications, Care Plan, Allergies, Labs, Insurance, Notes, Forms, Documents. Clicking an item scrolls to (or filters to show only) that section — implementer's call on scroll-to-anchor vs. tab-swap, whichever fits this codebase's existing patient-detail page conventions better (check `src/app/(dashboard)/patients/[anonId]/page.tsx`'s existing tab pattern, since it already has a tabbed Overview/History-style structure and this page should feel consistent with it, not invent a third navigation convention).

**Facesheet (main card grid)**, each card a compact summary linking to the full section:
- **Inpatient/Outpatient status** (new, see §4) — its own small card or a banner in the header, not buried; this is the single most load-bearing piece of clinical context on the page.
- **Medications** — active `medicationEpisodes`, matching the existing Medication History section's "Currently Taking" grouping, condensed to a summary card (e.g. top 3-4 + "N more").
- **Care Plan** — the existing Care Plan section, condensed (current plan's title + active goal count).
- **Diagnoses** — condensed list.
- **Allergies** — condensed list, reusing the existing `AllergyBadge` component.
- **Insurance** — condensed (payer name + "card on file: yes/no"), full detail still available via the left rail.
- **Documents** — a condensed list of this patient's filed documents (see the separate Document Assignment spec for the underlying upload/file flow this card surfaces), with an upload-and-assign-to-this-patient action available directly from the card.
- **Forms** — this patient's Client Forms submissions (status + a real "View answers" link for admin/pi, matching the finding in `2026-09-29-form-answer-visibility.md` that this already works — this card just needs to exist and link there).
- **Messages** — the last message in this patient's private thread (see `2026-09-29-messaging-isolation-audit.md` for the isolation guarantee this card relies on) with a reply box, matching the reference's inline-reply card.
- **Charges** — condensed billing summary (owed balance, most recent charge), linking to the existing Charges detail.
- **Orders and Results** — the existing Lab Results section, condensed.
- **Screening Questionnaires** — condensed score summary.

Cards with no data render a real, honest empty state (e.g. "No allergies recorded" — matching this codebase's existing empty-state convention throughout, never a blank card with no explanation).

## 4. Inpatient/outpatient status (new)

Clinsync already tracks this — it is not new data, only a new place to surface it. A patient has an open `admissions` row (`status = 'admitted'`, `dischargedAt IS NULL`) or does not. Add a query, `getCurrentAdmission(patientId)`, returning the open admission (with its `currentRoomId` joined to `rooms` for ward/room/bed) or `null`. Display prominently in the page header: **"Inpatient — Ward B, Room 202"** (with a link to the full admission/discharge detail this codebase's existing Inpatient/Beds feature already has) or **"Outpatient"** when there's no open admission. This is read-only on this page — admitting/discharging a patient remains the existing Inpatient/Beds workflow's job, not duplicated here.

## 5. Testing

Component-level tests for the new card grid (matching this codebase's existing `@testing-library/react` conventions for dashboard/page components — see `tests/components/dashboards/AdminDashboard.test.tsx` for the pattern) asserting: every existing data section still renders its real data somewhere on the page (nothing silently dropped in the reorganization — this is the single most important regression risk in a page reshuffle like this one), the inpatient/outpatient banner shows the correct state for both an admitted and a non-admitted patient (real DB-backed fixture, not a mock), and every card's empty state renders correctly when that patient has no data in that category.

## 6. Role gating summary

No new role gates. Every section already has whatever role gate it had before (e.g. `canWriteInsurance`, `canOrderLabs`, `canWrite` for notes/care-plans) — this spec relocates sections into cards, it does not change who can see or edit what.
