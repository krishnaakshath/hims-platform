# Front Desk / Reception Module — Design Spec

**Status:** Draft for review — design spec, not yet implemented.
**Position in the larger initiative:** this is sub-project 1 of turning Clinsync into a
full Hospital Information Management System (HIMS). It is deliberately scoped to
registration, check-in, doctor assignment, minimal room assignment, and insurance
verification only. The full inpatient bed/ward board, nursing/care-team assignment,
patient transfers, discharge workflow, pharmacy module, and the visual/navy redesign
are separate, later sub-projects — see §8 (Explicitly out of scope).

**Research this spec draws on** (already completed this session, not repeated here):
`docs/product-review-and-gap-analysis.md` (current schema + ER diagram),
`docs/ehr-platform-architecture.md` (ruling: build as a module inside Clinsync, reuse
existing schema/auth/design system, e-prescribing and real clearinghouse submission
are out of scope), `docs/us-healthcare-regulatory-landscape.md` (HIPAA specifics), plus
this session's Tebra/IntakeQ screenshot analysis and HIMS/competitor research (not
saved as separate docs; the relevant findings are folded into the design below).

---

## 1. What this is

Reception/front-desk staff currently have no dedicated role, dashboard, or workflow in
Clinsync — any staff member can add a patient (`AddClientModal`) or book an appointment
(`/calendar`'s `NewEventModal`), but there is no registration/check-in flow, no
inpatient-vs-outpatient triage, no doctor-assignment queue, and no structured insurance
verification. This spec adds all four, plus a new `frontdesk` staff role with its own
dashboard, so a real front desk operator has one place to do their job:

1. **Register** a new patient or look up a returning one (with duplicate detection).
2. **Check them in**, triaging inpatient vs. outpatient.
3. **Assign them to a doctor** — not a fully-timed appointment; a request that lands in
   that doctor's own queue for the doctor to schedule against their own availability.
4. For an inpatient, **assign a room** from a simple available-rooms list.
5. **Verify insurance eligibility** as a structured, simulated check (replacing the
   free-text "AETNA VERIFIED COPAY $30" memo-note pattern documented in the real Tebra
   walkthrough) and see whether a patient's balance is paid, using the billing data
   that already exists.
6. **See a patient's history** (past visits, diagnoses, medications) via the existing
   Medical Record page — reception gets a link into it, not a new chart view.

**Explicitly not in scope:** the full inpatient bed/ward status board and its workflow
(housekeeping states, transfers, discharge), pharmacy, real payer API integration, and
the app-wide visual redesign. See §8.

---

## 2. New role: `frontdesk`

- `roleEnum` (`src/db/schema.ts`) becomes `pgEnum('role', ['crc', 'pi', 'admin', 'frontdesk'])`.
  Additive change to an existing Postgres enum — `ALTER TYPE role ADD VALUE 'frontdesk'`
  via a hand-written script, per the project's standing rule (never `drizzle-kit push`
  against the shared dev database for a schema change; see `CLAUDE.md`/prior migration
  scripts for the pattern already used for other additive changes this session).
- `src/lib/auth.ts`'s `Role` type becomes `'crc' | 'pi' | 'admin' | 'frontdesk'`.
- New dashboard: `src/components/dashboards/FrontDeskDashboard.tsx`, wired into
  `src/app/(dashboard)/page.tsx`'s role router alongside Admin/Coordinator (frontdesk
  gets its own branch, not lumped into the `else` that currently means "crc").
- `LeftNav.tsx` gets a `frontdesk`-scoped item set: Home, Patients (existing, no
  `roles` restriction, stays visible), **Check-In** (new), **Assignments** (new,
  reception's own view of the queue it created), Calendar (existing), Billing (existing,
  extend the `showBilling` check from `role === 'admin' || role === 'crc'` to include
  `frontdesk`), Client Forms (existing, no restriction), Messages (existing, no
  restriction). Frontdesk does **not** get Workbook, Identity Matching, Form Templates,
  Reports, Documents, Broadcasts, Experience Surveys, Pipeline Dashboard, or Audit Log —
  those stay admin/crc-only exactly as today.
- Demo credentials: extend `src/db/seed.ts` with one `frontdesk` demo user (same pattern
  as Jamie Ruiz/Dr. Kunam — `hashPassword(...)`), e.g. `Taylor Nguyen`,
  `tnguyen.demo@example.com`, role `frontdesk`.

---

## 3. New data model (additive only)

Three new tables in `src/db/schema.ts`. No existing table is altered except the
`roleEnum` addition above. All three follow the project's established conventions
(serial PK, `text().references()` for patient FKs, explicit enum types, `createdAt`
defaults, no delete cascades — `deletePatient()` gets three more tables added to its
explicit cleanup list, same pattern as every other patient-owned table today).

```ts
export const roomStatusEnum = pgEnum('room_status', ['available', 'occupied'])

export const rooms = pgTable('rooms', {
  id: serial('id').primaryKey(),
  ward: text('ward').notNull(), // e.g. "Ward A", "ICU" — free text, not a separate wards table (YAGNI until the Inpatient sub-project needs more)
  roomNumber: text('room_number').notNull(),
  bedNumber: text('bed_number').notNull(),
  status: roomStatusEnum('status').default('available').notNull(),
  occupiedByPatientId: text('occupied_by_patient_id').references(() => patients.id),
})

export const doctorAssignmentVisitTypeEnum = pgEnum('doctor_assignment_visit_type', ['inpatient', 'outpatient'])
export const doctorAssignmentUrgencyEnum = pgEnum('doctor_assignment_urgency', ['routine', 'urgent', 'emergency'])
export const doctorAssignmentStatusEnum = pgEnum('doctor_assignment_status', ['pending', 'scheduled', 'declined'])

export const doctorAssignments = pgTable('doctor_assignments', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  providerId: integer('provider_id').notNull().references(() => providers.id),
  visitType: doctorAssignmentVisitTypeEnum('visit_type').notNull(),
  urgency: doctorAssignmentUrgencyEnum('urgency').default('routine').notNull(),
  reason: text('reason').notNull(),
  status: doctorAssignmentStatusEnum('status').default('pending').notNull(),
  roomId: integer('room_id').references(() => rooms.id), // set only when visitType = 'inpatient'
  assignedByName: text('assigned_by_name').notNull(), // reception staff name, audit-style (see logAudit pattern)
  appointmentId: integer('appointment_id').references(() => appointments.id), // set once the doctor schedules it
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export const eligibilityStatusEnum = pgEnum('eligibility_status', ['verified', 'inactive', 'needs_follow_up'])

export const insuranceEligibilityChecks = pgTable('insurance_eligibility_checks', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  payerName: text('payer_name').notNull(),
  status: eligibilityStatusEnum('status').notNull(),
  copayCents: integer('copay_cents'),
  checkedByName: text('checked_by_name').notNull(),
  checkedAt: timestamp('checked_at').defaultNow().notNull(),
})
```

**Why `rooms` is this minimal:** it models exactly what reception needs at
triage — "is a room available, which one did I assign" — as a flat list with two
states. The Inpatient/ADT sub-project extends this same table (more statuses:
`dirty`/`blocked`/`reserved`; a `wards` table if ward-level capacity reporting is
needed; transfer history) rather than replacing it — reusing the table, not
forking it, is the explicit design intent here.

**Why `doctorAssignments` is separate from `appointments`:** an assignment is a
*request* ("Dr. Kunam, please see this patient") that may or may not yet have a time.
Once the doctor picks a slot, a real `appointments` row is created and
`doctorAssignments.appointmentId` is set — the assignment record persists as the
audit trail of "who referred this patient to this doctor and why," which
`appointments` alone doesn't capture today.

---

## 4. Registration & check-in flow

- **New patient:** reuses `AddClientModal`/`AddPatientButton` as the underlying
  create-patient action (no new patient-creation UI) — the front-desk dashboard's
  "New Patient" quick action opens the same modal already used elsewhere.
- **Returning patient lookup:** a new search component (`FrontDeskPatientSearch`,
  client component) queries by name/DOB/phone against the existing `patients` table
  (reuses `listPatientsWithStatus`-style querying, no new patient columns needed) and
  flags likely duplicates (same DOB + similar name) the way the existing
  `identityMatches` queue already flags Tebra/IntakeQ mismatches — same confidence-score
  pattern, applied to a new-registration context instead of a source-reconciliation one.
- **Check-in action:** `POST /api/front-desk/check-in` — body: `{ patientId, visitType:
  'inpatient' | 'outpatient', urgency, reason, providerId, roomId? }`. Validates with a
  `.strict()` Zod schema (visitType/urgency enums, roomId required iff visitType is
  'inpatient' and must reference a `room` with `status: 'available'`), creates the
  `doctorAssignments` row, and if inpatient, flips the chosen room to `status: 'occupied'`
  / sets `occupiedByPatientId` in the same transaction. Calls `logAudit(session, 'checked in patient (inpatient|outpatient)', patientId)`.
- Requires `requireSessionOrRedirect()` first, same as every existing page; the route
  itself uses `requireSession()` and is reachable by `frontdesk`, `admin`, and `crc`
  (not `pi` — a PI doesn't do registration/check-in).

---

## 5. Doctor-side: the assignment queue

- PI dashboard (`src/app/(dashboard)/doctor/page.tsx`) gets a new section, **"Assigned
  to you"**, listing `doctorAssignments` where `providerId` matches the logged-in PI's
  provider record and `status = 'pending'`, sorted by urgency then creation time.
- Clicking a pending assignment opens a scheduling flow that reuses the existing
  `NewEventModal`/calendar-slot-picking code, pre-filled with the patient and provider —
  the doctor picks a real start/end time from their own calendar. On submit:
  `POST /api/front-desk/assignments/[id]/schedule` creates the `appointments` row (same
  validation `NewEventModal`'s existing endpoint already does, including the
  double-booking check flagged as a gap in `docs/ehr-platform-architecture.md` §6 — this
  spec adds that overlap check now, since it's a real correctness bug otherwise), sets
  `doctorAssignments.appointmentId` and `status: 'scheduled'`.
- A doctor can also **decline** an assignment (`status: 'declined'`, with a required
  reason) — surfaces back to the reception "Assignments" nav item so front desk can
  reassign to a different provider. This closes the loop the user's description implied
  ("the doctor will look into their portal and check the patient details") without
  silently losing a triaged patient if a doctor can't take them.

---

## 6. Insurance verification

- `POST /api/front-desk/eligibility-check` — body: `{ patientId, payerName }`. Since
  there is no real payer/clearinghouse contract (same honest-simulation constraint as
  `tebra.mock.ts`/`intakeq.mock.ts`/`mockPayments`), the result is **deterministically
  simulated**: a pure function (`simulateEligibilityCheck(patientId, payerName)` in
  `src/lib/queries/insurance-eligibility.ts`) hashes the input to produce a stable
  status/copay for the same patient+payer pair every time (mirrors
  `src/lib/queries/broadcasts.ts`'s `simulateBroadcastDelivery` pattern exactly — same
  technique, new domain). Result is stored in `insuranceEligibilityChecks`, never
  presented as a real payer response.
- Front-desk dashboard and the check-in flow both show the patient's most recent
  eligibility check (status + copay) inline, plus a "Verify" button to run a fresh one.
- Payment-status visibility reuses existing data: a small read-only card showing the
  patient's latest `patientStatements` delivery status and any `mockPayments` result —
  no new billing UI, just surfacing what already exists in the reception context.

---

## 7. Front-desk dashboard

Command-center layout (per this session's design research — Zendesk/Gorgias-style KPI
strip + urgency-grouped queue + quick actions), built with the app's **current** design
tokens (this spec does not touch `globals.css` — the navy/visual redesign is a separate
sub-project):

- **KPI strip:** patients checked in today, pending assignments (unscheduled), rooms
  available / occupied, eligibility checks needing follow-up.
- **Queue table:** today's `doctorAssignments`, grouped/sortable by urgency, each row
  showing patient name, visit type, assigned doctor, status, room (if inpatient).
- **Quick actions:** New Patient, Check-In, Verify Insurance — each opens the relevant
  modal/flow described above.
- **Patient history access:** every patient row/search result links to the existing
  Patient Detail / Medical Record pages — read-only from reception's side, no new chart
  UI.

---

## 8. Explicitly out of scope (later sub-projects)

- Full inpatient bed/ward status board: dirty/blocked/reserved states, housekeeping
  handoff, live census by unit, bed-turnaround metrics.
- Nursing/care-team assignment, shift handoff, inpatient charting (vitals/I&O,
  MAR), transfers, discharge workflow (the "5 D's").
- Pharmacy module (medication order → verify → dispense, reconciliation at care
  transitions).
- Real payer/clearinghouse API integration (270/271 eligibility, 837/835 claims) — stays
  simulated everywhere, including this spec's eligibility check.
- The app-wide visual/navy redesign — this spec's new screens use today's existing
  design tokens and components as-is.
- Public/patient-facing self-service booking ("patients can pick appointment to what
  doctor they want" from the original request) — today, and after this spec, all
  booking still originates from staff (reception or the doctor's own scheduling step),
  not a patient-facing booking widget. Flagged here so it isn't assumed solved.

---

## 9. Testing focus (Review Focus, per writing-plans convention)

The five conditions most likely to break this feature that a naive implementation
might miss:

1. **Double room assignment** — two concurrent check-ins racing for the same
   `available` room must not both succeed (route-level check-then-set needs a
   transaction/row lock, not a read-then-write with a gap).
2. **Declined assignment with no fallback** — a doctor declining an assignment must
   never silently disappear; it must remain visible (in a "declined, needs
   reassignment" state) to reception.
3. **Non-frontdesk/non-admin/non-crc role hitting check-in/eligibility routes** — a
   `pi` session must get 403, not a silent empty result.
4. **Inpatient check-in with no rooms available** — the flow must surface this clearly
   (not a generic 500) and let reception complete the assignment without a room,
   flagged for follow-up once one frees up.
5. **Eligibility check simulation determinism** — the same patient+payer pair must
   always simulate the same result (a flaky/random simulation would make the "Verify"
   button meaningless and untestable).

---

*Next step: user reviews this spec. On approval, this spec's implementation plan is
written via the writing-plans skill — not before.*
