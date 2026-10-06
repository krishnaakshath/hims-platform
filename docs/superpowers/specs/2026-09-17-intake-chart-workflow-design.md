# Intake + Chart Workflow Design

**Status:** approved for planning (design presented in chat, user confirmed "do what all is needed" plus a scoped skill directive — see Process Notes)

## 1. Purpose

Clinsync is not a thin read-only layer over live IntakeQ/Tebra APIs — that integration doesn't exist yet, and per the client's direction this is now explicitly **a standalone product that combines what IntakeQ and Tebra each do, purpose-built for trial pre-screening**, not a clone of either. This spec adds Clinsync's own:

- **Intake side** (IntakeQ-inspired): customizable, HIPAA-aware form templates; a send/receive workflow for referred patients to submit intake data; a Client Forms list, filterable by date and diagnosis.
- **Chart side** (Tebra-inspired): a fuller patient medical record — medications (already partially modeled), allergies (new), and identity verification via a government ID, which the client called out as a US healthcare requirement.
- **A home dashboard** replacing the current straight-to-`/patients` redirect, modeled on the "activity hub" pattern both real products use as their landing screen.
- **A classification workflow** that a CRC/Admin can run manually (a button) or configure to run automatically once both intake and chart data are complete for a patient — reusing the existing rule engine (`src/lib/rule-engine.ts`) and refresh endpoint, not rebuilding it.

This spec builds on, and does not replace, the existing screening workbook (Patients, Patient Detail, Identity Matching, Trials & Protocols, Audit Log, Settings) and its established security patterns (`requireSession`/`requireSessionOrRedirect`, shared query functions, Zod-validated writes, audit logging, the yellow-default safety rule).

## 2. Explicitly out of scope

Real Tebra and IntakeQ also do all of the following. None of it applies to a trial pre-screening tool, and porting it would be feature bloat, not polish:

- Billing, claims, insurance collections, patient statements, virtual card payments
- Scheduling/calendar, appointment booking
- Fax, patient broadcast/marketing campaigns, online-reputation/review management
- Provider-profile/practice-directory management, MIPS/quality-measure reporting

## 3. Data model changes

All new tables follow the existing schema's conventions (`serial` PK, `references()` for FK, `text`/`date`/`timestamp`/`jsonb` as appropriate). File: `src/db/schema.ts`.

### 3.1 `formTemplates` (new)

Customizable, reusable intake form definitions. A template is tagged with a diagnosis/condition so it can be filtered later and so a CRC sending a form picks one relevant to what the referral is for.

```typescript
export const formTemplates = pgTable('form_templates', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),                    // e.g. "MDD Intake Packet"
  diagnosisTag: text('diagnosis_tag').notNull(),    // e.g. "Major Depressive Disorder" — drives the Client Forms filter
  questions: jsonb('questions').$type<{
    id: string
    label: string
    type: 'text' | 'textarea' | 'date' | 'select' | 'checkbox'
    options?: string[]        // for 'select'
    hipaaSensitive: boolean   // flags fields carrying PHI, for the form-builder UI to visually mark
    required: boolean
  }[]>().notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})
```

### 3.2 `formSubmissions` ("Client Forms") (new)

A form sent to (or filled by) a specific patient/referral.

```typescript
export const formSubmissionStatusEnum = pgEnum('form_submission_status', ['sent', 'partial', 'completed'])

export const formSubmissions = pgTable('form_submissions', {
  id: serial('id').primaryKey(),
  templateId: integer('template_id').notNull().references(() => formTemplates.id),
  patientId: text('patient_id').notNull().references(() => patients.id),
  status: formSubmissionStatusEnum('status').default('sent').notNull(),
  sentDate: timestamp('sent_date').defaultNow().notNull(),
  completedDate: timestamp('completed_date'),
  answers: jsonb('answers').$type<Record<string, string>>().default({}),
})
```

### 3.3 `allergies` (new)

```typescript
export const allergies = pgTable('allergies', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  allergen: text('allergen').notNull(),
  reaction: text('reaction'),
  severity: text('severity', { enum: ['mild', 'moderate', 'severe'] }).notNull(),
})
```

### 3.4 `identityVerifications` (new)

One row per patient, capturing the US-healthcare identity-proofing step the client called out.

```typescript
export const identityVerifications = pgTable('identity_verifications', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id).unique(),
  idType: text('id_type', { enum: ['drivers_license', 'state_id', 'passport'] }).notNull(),
  idNumberEncrypted: text('id_number_encrypted').notNull(),  // never store plaintext — matches the existing *Encrypted column convention
  verified: boolean('verified').default(false).notNull(),
  verifiedBy: text('verified_by'),
  verifiedAt: timestamp('verified_at'),
})
```

### 3.5 Reused, not duplicated

- **Medications** — `medicationEpisodes` already has `startDate`, `dose`, `status`; no new table needed. Patient Detail gains a rendered Medications section if it doesn't already have one.
- **"Latest Account Events"** dashboard widget — reads from the existing `auditLog` table filtered to a small set of event-worthy actions (form sent, form completed, identity verified, classification run), not a new events table.
- **Classification** — reuses `src/lib/rule-engine.ts` (`evaluateCriteria`) and the existing `POST /api/patients/[anonId]/refresh` route. No new scoring logic.

### 3.6 Settings addition

Add one row to the existing settings concept (a simple key-value or a dedicated `appSettings` table — implementer's choice, single-row is fine for a pilot) for: `autoClassifyOnComplete: boolean` (default `false`). When true, completing both an intake form and having chart data present (medications + at least one diagnosis) for a patient automatically triggers a classification run instead of waiting for a manual "Run Classification" click.

## 4. New pages

All pages follow the existing security pattern: `requireSessionOrRedirect()` on Server Components, `requireSession()` on API routes, shared query functions in `src/lib/queries/*.ts` — **never** a Server Component `fetch()` of the app's own API.

### 4.1 Home Dashboard (`/`)

Replaces the current unconditional redirect to `/patients`. Layout, adapted from IntakeQ's Home:

- Three primary-action tiles: **Send Form to Client**, **Add New Client**, **Run Classification** (each opens the relevant modal/flow).
- **Latest Forms Received** — most recent `formSubmissions` with status `completed`, patient + form name + completed date.
- **Pending Forms** — `formSubmissions` with status `sent` or `partial`, patient + form name + sent date, flagged if older than a threshold (e.g. 7 days).
- **Pending Classifications** — patients whose intake + chart data are both present but who have no `patientTrialScreenings` row yet, or whose data changed since the last screening. (Replaces "Upcoming Appointments," which doesn't apply — Clinsync doesn't schedule visits.)
- **Latest Account Events** — last ~10 `auditLog` rows for form-sent/form-completed/identity-verified/classification-run actions, each with a colored dot matching the event type (no icons — colored dot + text label, consistent with the rest of the app).

### 4.2 Form Templates library (`/forms`)

Grid of template cards (name, diagnosis tag, question count, active/inactive state). Actions: Create New, Edit, Duplicate, Deactivate. No folders/nesting needed at this scale (IPMG has a handful of trial conditions, not IntakeQ's hundreds of templates).

### 4.3 Form Builder (`/forms/[templateId]`)

Edit a template's question list: add/remove/reorder questions, set type (text/textarea/date/select/checkbox), mark `hipaaSensitive`, mark `required`. Diagnosis tag and name editable at the top.

### 4.4 Client Forms (`/client-forms`)

List of `formSubmissions`, filterable by date range and diagnosis tag (via the template's tag), plus status filter (Sent/Partial/Completed). Columns: Patient, Form (template name), Diagnosis Tag, Status, Sent Date, Completed Date. Links to a submission detail view showing the raw answers.

### 4.5 Send Form to Client / Add New Client (modals)

- **Send Form to Client**: pick a patient (existing or a new bare referral record), pick a template, send — creates a `formSubmissions` row with status `sent`.
- **Add New Client**: name, DOB, contact info, referral source — creates a minimal `patients` row (the rest of the 30-column workbook fills in as chart/intake data arrives, consistent with the existing "needs verification until evidence exists" model).

### 4.6 Patient Detail additions

- **Medications** section (if not already rendered) — from `medicationEpisodes`, with start date and status.
- **Allergies** section — from `allergies`, with severity indicated by the same StatusChip-style dot + text convention (severe = red dot, moderate = amber, mild = gray — no medical-alert icon, per the existing zero-icon rule).
- **Identity Verification** badge — "Identity Verified" (green dot + verifier name/date) or "Verification Pending" (amber dot), from `identityVerifications`.

### 4.7 Settings addition

One new toggle in the existing Settings page: "Automatically classify patients once intake and chart data are complete" (on/off), wired to the `autoClassifyOnComplete` setting from §3.6.

## 5. Design system guidance for this work

Continues the palette/token system established in the visual-redesign plan (`docs/superpowers/plans/2026-09-17-visual-redesign.md`) and the conventions independently confirmed against real Tebra/IntakeQ screenshots: teal/coral tokens, zero decorative icons (status = colored dot + text label only), zebra-striped tables, one coral primary action per screen.

Additional principles for this round, to keep the "not AI slop" bar (per `frontend-design`'s quality floor, applied selectively — see below):
- No glassmorphism, gradient/shiny buttons, bento grids, or floating/breathing animations. Those read as consumer-SaaS marketing chrome, not clinical software, and would undo the realism this redesign is going for.
- Dashboard widgets are dense, information-first cards — not KPI-tile eye-candy. Real Tebra/IntakeQ dashboards favor plain numbers and short labels over illustration.
- Empty states use the plain-text pattern seen in both real products ("No records found.", "You have no upcoming appointments.") — short, factual, in the interface's voice, no illustrations needed at this scale.
- Motion: none beyond existing hover/transition-colors utility classes already in use. No page-load reveal sequences.
- Accessibility floor carried over from the prior redesign's fixes: every status/severity indicator pairs color with a text label; keyboard focus remains visible; new interactive elements (form builder drag-reorder, filters) get real `aria-*` attributes, not just visual styling.

**Explicitly not applying** `ui-ux-pro-max-skill`'s glassmorphism/shiny-button/bento-grid/beam-effect guidance — it targets consumer SaaS marketing pages and directly conflicts with matching real clinical-EHR conventions, which is the client's actual, repeated request.

## 6. Security & HIPAA considerations

- `idNumberEncrypted` follows the existing `*Encrypted` column convention (never store or render plaintext ID numbers; mask to last 4 digits in any UI display).
- Form template `hipaaSensitive` field flags exist so the form-builder UI can visually mark which questions collect PHI — informational for whoever configures templates, not an enforcement mechanism in this pilot.
- All new API routes get `requireSession()` and Zod-validated bodies, matching the existing pattern (see `PUT /api/trials/[trialId]/criteria` for the allowlist-schema precedent).
- All new writes (form sent, form completed, identity verified, classification run, template created/edited) go through `src/lib/audit.ts`, extending the existing non-null-session audit pattern.
- The `autoClassifyOnComplete` setting write is Admin-only (aligns with the existing unresolved finding — noted, not newly introduced — that trial-criteria writes currently lack role checks; this spec does not fix that broader gap, but does not add to it either by gating the new setting).

## 7. Testing & delivery

- Extend `src/db/seed.ts` with realistic mock data for every new table: several form templates (one per trial condition), a mix of sent/partial/completed submissions, allergies for a subset of patients, identity-verification rows in both verified and pending states — enough to make every new screen demonstrable, not empty, for a client walkthrough.
- Unit/integration tests for: rule-engine reuse in the classification trigger, Zod validation on new routes, the auto-classify setting's trigger condition (both intake + chart data present), audit logging on each new action.
- `npm test` and `npm run build` must be clean, verified **locally** before anything is pushed to git (explicit client instruction — no push until a full local pass, including a manual browser walkthrough of every new screen).
- The "PILOT / DEMO — NO REAL PATIENT DATA" banner text is removed from every screen it currently appears on (`TopBanner.tsx`, `login/page.tsx`) per explicit, twice-repeated client instruction. The underlying data remains fictional/seeded — only the on-screen label is removed, not the underlying non-production nature of the build.

## 8. Process notes

This spec was developed via the brainstorming skill's architectural path, compressed: design presented directly in chat (informed by a full screenshot catalog of 78 real Tebra/IntakeQ screens plus public marketing-page fact-checks on HIPAA/BAA claims), with the client responding via direct instruction ("do what all is needed") plus a scoped skill directive (§5) rather than a section-by-section written approval. Proceeding to `writing-plans` next.
