# Inpatient Management (ADT) — Design Spec

**Status:** Draft for review — design spec, not yet implemented.
**Position in the larger initiative:** third sub-project of the HIMS expansion, after Front Desk / Reception (merged) and Authentication Hardening (in progress). This is the piece the user asked for directly: "everything must be monitored until discharge" — closing the loop from admission through transfers to a real discharge, so a patient's inpatient stay is actually tracked, not just their check-in moment.

## 1. What this is

Front Desk already lets reception assign an inpatient to a room at check-in (`doctorAssignments` + `rooms`, `visitType: 'inpatient'`). What's missing is everything AFTER that moment: the room only ever goes from `available` to `occupied` and back — there's no live bed-status board showing all rooms at once, no way to transfer a patient to a different room, and no discharge workflow at all. A room "frees" today only as an accidental side effect of deleting a patient's entire record, which is never what a real discharge is.

This spec adds:
1. A live **bed/ward status board** — every room, grouped by ward, color-coded by status, with a persistent legend (available/occupied/dirty/blocked).
2. A first-class **`admissions`** record — the actual "this patient is currently an inpatient" fact, created automatically when Front Desk checks someone in as inpatient, and closed by an explicit discharge.
3. **Transfers** — moving an admitted patient to a different room, with a real history trail.
4. **Discharge** — a structured workflow using the "5 D's" (Diagnosis, Duration, Drugs, Devices, Diet), which frees the room back to `dirty` (pending housekeeping), not straight back to `available`.
5. A **patient stay timeline** on the existing Patient Detail page — admission → transfers → discharge, in one place.

**Explicitly out of scope:** a dedicated "nurse" role or granular multi-person care-team assignment (this app has no nurse role today; adding one is a bigger scope decision than "complete the loop" calls for — attending-provider assignment, which already exists via `doctorAssignments`, stands in for care-team ownership for now). A separate `wards` table (ward stays a free-text field on `rooms`, same as Front Desk — still no capacity-reporting need that a `GROUP BY ward` can't answer). Automated bed-cleaning-status integration with a real housekeeping system (marking a room clean is a manual staff action here, not a device/IoT integration).

## 2. Data model changes (additive only)

```ts
export const roomStatusEnum = pgEnum('room_status', ['available', 'occupied', 'dirty', 'blocked'])
// Widens the existing enum from Front Desk (was: available/occupied only).
```

`rooms` also gains one additive column: `blockedReason: text('blocked_reason')` (nullable) — the free-text reason shown when a room's status is `blocked` (§4), cleared back to `null` whenever a room is unblocked.

```ts
export const admissionTypeEnum = pgEnum('admission_type', ['elective', 'emergency', 'transfer_in'])
export const admissionStatusEnum = pgEnum('admission_status', ['admitted', 'discharged'])

export const admissions = pgTable('admissions', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  currentRoomId: integer('current_room_id').references(() => rooms.id), // null once discharged
  attendingProviderId: integer('attending_provider_id').notNull().references(() => providers.id),
  admissionType: admissionTypeEnum('admission_type').default('elective').notNull(),
  status: admissionStatusEnum('status').default('admitted').notNull(),
  admittedAt: timestamp('admitted_at').defaultNow().notNull(),
  dischargedAt: timestamp('discharged_at'),
  dischargeDiagnosis: text('discharge_diagnosis'),
  dischargeDrugs: text('discharge_drugs'),
  dischargeDevices: text('discharge_devices'),
  dischargeDiet: text('discharge_diet'),
  dischargeSummaryNotes: text('discharge_summary_notes'),
  followUpAppointmentId: integer('follow_up_appointment_id').references(() => appointments.id),
  createdFromAssignmentId: integer('created_from_assignment_id').references(() => doctorAssignments.id),
})

export const admissionTransfers = pgTable('admission_transfers', {
  id: serial('id').primaryKey(),
  admissionId: integer('admission_id').notNull().references(() => admissions.id),
  fromRoomId: integer('from_room_id').references(() => rooms.id),
  toRoomId: integer('to_room_id').notNull().references(() => rooms.id),
  reason: text('reason').notNull(),
  transferredByName: text('transferred_by_name').notNull(),
  transferredAt: timestamp('transferred_at').defaultNow().notNull(),
})
```

**Why `dischargeDuration` isn't a stored column:** it's derived (`dischargedAt - admittedAt`), computed at read time wherever displayed — storing it would let it drift out of sync with the two timestamps it's derived from.

**Why room status widens rather than adds a new table:** `rooms` already exists from Front Desk with exactly the columns this needs (`ward`, `roomNumber`, `bedNumber`, `status`, `occupiedByPatientId`) — this spec only adds two more enum values (`dirty`, `blocked`) and the transfer/discharge logic that moves a room between them. `listAvailableRooms()` (Front Desk) is unaffected — it already filters on `status = 'available'`, which correctly excludes `dirty`/`blocked` rooms with zero changes needed.

## 3. Admission creation (hooks into Front Desk's check-in)

`POST /api/front-desk/check-in` (existing route) gets one addition: when `visitType === 'inpatient'`, it also inserts an `admissions` row (`patientId`, `currentRoomId: roomId ?? null`, `attendingProviderId: providerId`, `admissionType: 'elective'` by default, `createdFromAssignmentId: <the doctorAssignments row just created>`). This is the only place an `admissions` row is ever created — there's no separate "start an admission" screen; checking in an inpatient *is* starting their admission, by design (matches the spec's overall principle of one front door, not parallel entry points for the same fact).

**Boarding case (no room yet at check-in):** the existing check-in route already allows an inpatient check-in with no `roomId` (verified in `tests/api/front-desk-check-in.test.ts`: "allows an inpatient check-in with no roomId (room assigned once one frees up)") — a real and common hospital state (admitted, awaiting a bed). This spec's `admissions` row is created in that case too, with `currentRoomId: null`. Assigning that first room once one frees up reuses the *same* transfer endpoint in §5 rather than a separate "assign initial room" action: a transfer with `fromRoomId: null` (because `admission.currentRoomId` was already null) *is* the first room assignment — no new endpoint needed, and the `admissionTransfers` row still records it (with a null `fromRoomId`) as the one true history of every room this admission has ever occupied, from zero.

## 4. Bed/ward status board

New page, `/inpatient/beds` (accessible to `frontdesk`, `admin`, `crc`, `pi` — read access for everyone who currently sees rooms at all; the "mark clean"/transfer/discharge actions are more restricted, see §7):

- Rooms grouped by `ward`, each rendered as a colored cell (green=available, blue=occupied, amber=dirty, red=blocked), following the Deputy-style grouped-grid-with-persistent-legend pattern from this session's earlier design research — the legend is a fixed footer bar mapping each color to its label, so status is never color-only.
- Clicking an `occupied` room shows the admitted patient's name, attending provider, admission date, and Transfer/Discharge actions (role-gated, see §7).
- Clicking a `dirty` room shows a "Mark clean" button that flips it straight to `available` — no separate housekeeping system, just a manual staff acknowledgment.
- Clicking a `blocked` room shows who blocked it and why (a free-text reason field, settable by admin — e.g. maintenance) with an "Unblock" action.

**Mobbin research (2026-09-26):** Mobbin's catalog has no hospital-vertical bed-board app indexed, so the closest verified real-world reference stays [Deputy's grouped Schedule grid](https://mobbin.com/screens/42d9229d-2df6-4245-a3c1-0802e8c89350) (staff-scheduling web app) — rows grouped by area with a colored-cell-per-slot layout and a persistent bottom legend mapping every color to a label (`0 empty · 9 published · 2 open shifts · 0 warnings · 0 unavailable`), which is exactly the "never color alone" pattern this board reuses per-ward instead of per-employee-row. For the multi-step discharge flow (§6), [Headspace's appointment-booking stepper](https://mobbin.com/screens/c9b2bbdc-2976-46da-ba9a-e23f662f3d7e) (`Check In → Verify Insurance → Schedule appointment`, with completed steps checked and the current step highlighted) is the reference for the Discharge modal's own three steps (5 D's form → optional follow-up scheduling → confirmation). For the post-action confirmation state (after a successful discharge or transfer), [Cal.com's "This meeting is scheduled" confirmation card](https://mobbin.com/screens/9d826d23-ed7e-4ec6-9f7f-c2b23f7d8f2a) (checkmark icon, plain-language confirmation line, then a clean What/When/Who detail list) is the reference for the Discharge modal's final panel, showing the freed room, the discharge time, and the created follow-up appointment's date/time if one was scheduled.

## 5. Transfer workflow

`POST /api/inpatient/admissions/[id]/transfer` — body `{ toRoomId: number, reason: string }`. Validates:
- The admission exists and `status = 'admitted'` (this is the only precondition on the *current* room — `currentRoomId` may already be a real room, or `null` for a boarding patient's first-ever room assignment, per §3).
- `toRoomId` refers to a room with `status = 'available'` (race-safe, same conditional-UPDATE pattern as Front Desk's `assignRoomToPatient` — the UPDATE's WHERE re-checks `status = 'available'` at write time, returning a 409 if someone else claimed it first).
- On success (one logical operation, sequential since this DB driver has no multi-statement transactions — same accepted limitation as Front Desk): free the old room if there was one (`status: 'dirty'`, `occupiedByPatientId: null` — skipped entirely when `currentRoomId` was already null), occupy the new room (`status: 'occupied'`, `occupiedByPatientId: patientId`), update `admissions.currentRoomId`, insert an `admissionTransfers` row recording the move (`fromRoomId: <the old currentRoomId, possibly null>`).
- `logAudit(session, 'transferred patient <patientId> from room X to room Y'` or `'assigned first room to patient <patientId>'` when `fromRoomId` was null, `patientId)`.

## 6. Discharge workflow

`POST /api/inpatient/admissions/[id]/discharge` — body `{ dischargeDiagnosis: string, dischargeDrugs: string, dischargeDevices: string, dischargeDiet: string, dischargeSummaryNotes: string, followUpDate?: string, followUpTime?: string }` (all five discharge fields required — a discharge with a blank "5 D's" field is exactly the kind of incomplete clinical documentation the research flagged as the norm to beat, not match). On success:
- `admissions.status = 'discharged'`, `dischargedAt = now()`, all five discharge-summary fields stored, `currentRoomId` cleared.
- The room the patient was occupying: `status: 'dirty'` (not `available` — matches §4's housekeeping-acknowledgment step; a discharged room needs cleaning before the next patient, exactly the real-world workflow the design research called out).
- If `followUpDate`/`followUpTime` were provided, creates a real `appointments` row for the attending provider (reusing the same overlap-checked scheduling path Front Desk's `schedule` route already uses) and records its id on `admissions.followUpAppointmentId` — this is the "automatic follow-up scheduling from the discharge order" behavior the HIMS research flagged as the thing most competitors leave manual.
- `logAudit(session, 'discharged patient', patientId)`.

**UI:** a Discharge modal on the bed board (and on the Patient Detail page, see §7), a 3-step flow per the Headspace stepper reference in §4 — Step 1 "Discharge summary" (the five required text fields), Step 2 "Follow-up" (optional date/time picker, skippable), Step 3 "Confirmation" (a Cal.com-style confirmation card: checkmark, "Patient discharged", then the freed room, discharge time, and the created follow-up appointment's date/time if one was scheduled) — submitting Step 1→2 calls the route above once, with all fields collected before the single API call, not once per step.

## 7. Patient stay timeline & role access

Patient Detail page (`/patients/[anonId]`) gets a new "Inpatient History" section: every `admissions` row for that patient (admitted date, attending provider, current/discharged status, and — if discharged — the stored 5 D's summary), with each admission's transfer history nested underneath (from room → to room, reason, timestamp).

**Role access** (extending the existing role model, no new roles added):
- View bed board + patient stay timeline: `frontdesk`, `admin`, `crc`, `pi` — same as who can already see the Front Desk assignments queue.
- Transfer a patient: `frontdesk`, `admin`, `crc` (a logistics action, same authority level as check-in itself) or `pi` (a clinical decision to move a patient, e.g. to ICU).
- Discharge a patient: `pi` only — a clinical decision, matching how only a PI can schedule/decline a `doctorAssignments` row today. `admin` can also discharge, for the same oversight reason `admin` already has full operational access everywhere else in this app.
- Mark a room clean / block-unblock a room: `frontdesk`, `admin`, `crc` — a facilities action, not clinical.

## 8. `deletePatient` cleanup

`admissions` and `admissionTransfers` are patient-owned data (transitively, via `admissions.patientId`) and must be added to `deletePatient`'s explicit cleanup chain, in children-before-parents order learned from the Front Desk plan's own reviewed bug: `admissionTransfers` (references `admissions`) before `admissions` (references `rooms`/`providers`/`appointments`/`doctorAssignments`, none of which get deleted, only referenced) before the existing `rooms` free-up step. Any room a deleted patient was occupying must also be freed (reuse the same `UPDATE rooms SET status='available', occupied_by_patient_id=NULL` pattern Front Desk's Task 1 fix already established — though per this spec, freeing to `dirty` would be more consistent with the discharge workflow's own convention; deleting a patient record entirely is an administrative correction, not a discharge, so freeing straight to `available` remains correct here, matching the existing Front Desk behavior exactly).

## 9. Testing focus (Review Focus)

1. **Race-safe transfer** — two concurrent transfer requests targeting the same destination room must not both succeed; the loser gets a 409, exactly like Front Desk's room-assignment race guard. (§5)
2. **Discharge with an incomplete "5 D's" form** — the API must reject a discharge missing any of the five required fields, not silently accept a blank clinical summary. (§6)
3. **Double-discharge** — discharging an already-discharged admission (`status = 'discharged'`) must be rejected (404/409), not silently re-run and double-free a room or double-create a follow-up appointment. (§6)
4. **Transfer or discharge on someone else's admission** — same ownership-boundary concern the Front Desk final review caught for `doctorAssignments`: a PI must only be able to discharge/transfer patients under their own attending assignment, not any admission by id. (§7)
5. **Room state consistency after discharge** — the discharged room must show as `dirty`, not `available` and not still `occupied`, and the bed board must reflect this immediately (no caching staleness that would let reception assign the discharging patient's old room to someone new before housekeeping is acknowledged). (§4, §6)

---

*Next step: user reviews this spec. On approval, this spec's implementation plan is written via the writing-plans skill — not before, though given this session's established "keep going" directive, the plan-writing proceeds without a separate approval round-trip, same as Authentication Hardening.*
