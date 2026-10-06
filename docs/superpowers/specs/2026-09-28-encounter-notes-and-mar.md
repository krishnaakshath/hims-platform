# Encounter Notes + Nursing/MAR — Design Spec

**Status:** Draft for review — design spec, not yet implemented.
**Position in the larger initiative:** first sub-project of the "complete the HIMS platform" backlog (research: `docs/product-review-and-gap-analysis.md` flags "no note templates ... no structured visit-note table" as the single biggest real EMR gap; `docs/ehr-platform-architecture.md` §4 independently calls out the same missing `encounter_notes` table as a prerequisite before a real charting screen exists). Chosen first because it extends the inpatient ADT work just merged (admissions need documentation once a patient is actually on the unit) rather than starting a new area cold, and because every later clinical module (care plans, lab orders) will want to link back to a note.

## 1. What this is

Today, "notes" in Clinsync are all free text on someone else's record: `appointments.notes`, `admissions.dischargeSummaryNotes`, a handful of staff fields (`formNotes`, `reviewerNotes`, `piRecommendation`). None of it is a structured, authored, timestamped clinical note a provider can write, sign, and have show up as its own entry in a patient's chart — which is the actual definition of "charting" in every reference module list this session researched.

This spec adds:
1. A first-class **`encounterNotes`** table — SOAP-structured (Subjective/Objective/Assessment/Plan), authored, timestamped, optionally linked to an appointment or an inpatient admission, with a draft/signed lifecycle.
2. A **Notes section** on the Medical Record page, listing every note for that patient across both outpatient visits and inpatient stays, newest first, with a "New Note" action.
3. A first-class **`medicationAdministrations`** table (the MAR) — one row per scheduled-or-given dose during an inpatient admission, who gave it and when, status (scheduled/given/held/refused).
4. A **Medications** panel on the bed board's admission detail view (next to the existing Transfer/Discharge actions), listing that admission's MAR with a "Record administration" action.

**Explicitly out of scope:** AI-assisted note generation/macros (flagged `❌` in the gap analysis, needs real model integration — separate decision). A dedicated "nurse" role — the inpatient ADT spec already established the precedent that this app has no nurse role and treats the attending provider as care-team ownership; MAR write access follows the same precedent (admin/pi), not a new role. Outpatient medication administration (MAR is admission-scoped only — an outpatient visit's medication changes are already captured via `medicationEpisodes`, which this doesn't touch). Editing or amending a signed note (matches real clinical-documentation practice: a signed note is append-only via a new note, never mutated — same principle as the audit log itself).

## 2. Data model changes (additive only)

```ts
export const noteTypeEnum = pgEnum('note_type', ['progress', 'nursing', 'intake'])
export const noteStatusEnum = pgEnum('note_status', ['draft', 'signed'])

export const encounterNotes = pgTable('encounter_notes', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  appointmentId: integer('appointment_id').references(() => appointments.id), // null for an inpatient-only note
  admissionId: integer('admission_id').references(() => admissions.id), // null for an outpatient-visit note
  noteType: noteTypeEnum('note_type').default('progress').notNull(),
  authorName: text('author_name').notNull(),
  authorRole: roleEnum('author_role').notNull(),
  subjective: text('subjective'),
  objective: text('objective'),
  assessment: text('assessment'),
  plan: text('plan'),
  status: noteStatusEnum('status').default('draft').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  signedAt: timestamp('signed_at'),
})

export const marStatusEnum = pgEnum('mar_status', ['scheduled', 'given', 'held', 'refused'])

export const medicationAdministrations = pgTable('medication_administrations', {
  id: serial('id').primaryKey(),
  admissionId: integer('admission_id').notNull().references(() => admissions.id),
  medicationEpisodeId: integer('medication_episode_id').references(() => medicationEpisodes.id), // null for a PRN/ad-hoc order not on the reconciled med list
  medicationName: text('medication_name').notNull(),
  dose: text('dose').notNull(),
  scheduledFor: timestamp('scheduled_for').notNull(),
  status: marStatusEnum('status').default('scheduled').notNull(),
  administeredAt: timestamp('administered_at'),
  administeredByName: text('administered_by_name'),
  notes: text('notes'), // e.g. reason for "held" or "refused"
})
```

**Why both `appointmentId` and `admissionId` are nullable FKs on one table, not two tables:** a note is a note regardless of care setting — a shared `Notes` tab on Patient Detail needs one `ORDER BY createdAt` query across all of them, not a UNION of two tables. Exactly one of the two is expected to be set in practice (enforced at the route layer, not the schema — Postgres has no clean "exactly one of two nullable FKs" constraint, and the existing codebase doesn't reach for one elsewhere either, e.g. `admissions.currentRoomId` vs `followUpAppointmentId`).

**Why SOAP fields are four separate nullable text columns, not one `content` blob:** every reference EHR module list and the existing gap analysis specifically call out "no note templates" as the complaint — a structured field per section is what makes a note a *template* instead of a bigger free-text box, and lets a future feature (auto-scoring, AI charting) target one section without parsing prose. All four nullable so a `nursing` note (vitals/administration commentary) isn't forced to fill out Assessment/Plan sections meant for a provider's clinical reasoning.

**Why MAR rows are created ahead of administration (`status: 'scheduled'`), not only logged after the fact:** a real MAR's value is knowing what's *due*, not just a retroactive log — the Medications panel needs to show "due now / overdue" rows the same way the discharge workflow needed the 5 D's to be a real form, not an afterthought. Scheduled rows are created when an admission's provider adds a medication order (§4); recording administration is a status transition on an existing row, not a new insert.

## 3. Notes: creation and the Notes tab

`POST /api/patients/[anonId]/notes` — body `{ appointmentId?: number, admissionId?: number, noteType: 'progress'|'nursing'|'intake', subjective?, objective?, assessment?, plan? }`, `.strict()` Zod, exactly one of `appointmentId`/`admissionId` may be present (both omitted is valid — a general chart note tied to neither). Creates a `draft` row. `PUT /api/patients/[anonId]/notes/[id]/sign` — no body, flips `status: 'signed'`, `signedAt: now()`, only callable by the note's own author (`authorName` must match the session) or `admin`. Once signed, no further mutation endpoint exists for that row at all (§1's append-only rule enforced by simply not building an edit route, the same way `auditLog` has no update route).

New section on `src/app/(dashboard)/patients/[anonId]/medical-record/page.tsx` (which already renders the dual-sourced chart — diagnoses, medications, allergies, visit stats — as its own dedicated page, separate from the tabs on the main Patient Detail page): **Notes**, listing every `encounterNotes` row for the patient newest-first, each card showing type badge, author, timestamp, status pill (draft/signed — `StatusChip`, matching the redesign spec's status-pill convention, never color alone), and the four SOAP sections. A signed note is read-only; a draft shows a "Sign" button (author or admin only). "New Note" opens a form modal with a note-type selector and the four SOAP textareas.

`logAudit(session, 'created encounter note' | 'signed encounter note', patientId)` on both actions.

## 4. MAR: medication orders and administration

Medication orders are created as part of an **inpatient admission's** care, not a separate standalone screen: `POST /api/inpatient/admissions/[id]/medications` — body `{ medicationEpisodeId?: number, medicationName: string, dose: string, scheduledFor: string }` — inserts a `medicationAdministrations` row with `status: 'scheduled'`. Restricted to the admission's attending provider or admin (same gating precedent as discharge/transfer in the ADT spec).

`POST /api/inpatient/admissions/[id]/medications/[medId]/administer` — body `{ status: 'given'|'held'|'refused', notes?: string }` — the actual MAR action: sets `administeredAt: now()`, `administeredByName: session.name`, the given status, optional notes (required when status is `held`/`refused` — a held or refused dose without a reason is exactly the incomplete documentation this spec exists to prevent, same principle as discharge's required 5 D's). A row can only transition from `scheduled` once — re-administering an already-`given` row 409s (real MAR safety property: you cannot silently double-chart a dose).

**UI:** a "Medications" action alongside the existing Transfer/Discharge buttons on `InpatientHistoryPanel.tsx`'s admitted-admission card (not `BedBoard.tsx` — Transfer/Discharge already live here, on the Patient Detail page's Inpatient History tab, per the existing `transferFor`/`dischargeFor` state pattern), opening a `MedicationAdministrationPanel` modal: a table of that admission's MAR rows (medication, dose, scheduled time, status pill), "Add medication" (opens the order form), and each `scheduled` row gets Give/Hold/Refuse actions inline.

`logAudit(session, 'ordered medication' | 'recorded medication administration', patientId)`.

## 5. Testing

Following this project's existing pattern (every route has an API test, every query function has a unit test): `tests/api/patient-notes.test.ts`, `tests/api/inpatient-medications.test.ts`, `tests/lib/queries/encounter-notes.test.ts`, `tests/lib/queries/medication-administrations.test.ts`. Specifically covering: exactly-one-of-appointment/admission validation, sign-only-by-author-or-admin, append-only (no edit route exists), double-administration 409, held/refused requires notes.

## 6. Role gating summary

| Action | Allowed roles |
|---|---|
| View notes / MAR | admin, pi, crc, frontdesk (read access matches existing Patient Detail / bed board gating) |
| Create/sign a note | admin, pi (matches existing clinical-write gating elsewhere, e.g. discharge) |
| Order/administer medication | admin, pi (same attending-provider-or-admin precedent as transfer/discharge) |
