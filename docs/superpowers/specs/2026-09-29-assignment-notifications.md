# Doctor-Assignment Notifications — Design Spec

**Status:** Draft for review — design spec, not yet implemented.
**Position in the larger initiative:** a notification layer on top of the *existing*, already-complete doctor-assignment state machine (`doctorAssignments`, `src/lib/queries/doctor-assignments.ts`, the front-desk check-in and schedule/decline routes) — not a change to that machine's own states or transitions. **Sequenced to start only after `2026-09-29-eligibility-auto-notification.md` has merged into `hims-platform`** — this spec assumes the `'system'` `messages.senderRole` value, the `'Clinsync (Automated)'` sender name, and the centered "AUTOMATED NOTICE" banner in `MessageThreadView` already exist, and it deliberately reuses that one mechanism rather than inventing a second, divergent automated-messaging path. If that spec is descoped or changes its sender-role shape, this spec's §5 must be re-read before implementation, not adapted silently.

## 1. What this is, and the boundary it works within

The workflow the user described already exists in code, end to end:

- Front desk registers/checks a patient in and assigns them to a doctor — `POST /api/front-desk/check-in` (`src/app/api/front-desk/check-in/route.ts:73`) calls `createDoctorAssignment` (`src/lib/queries/doctor-assignments.ts:18`), inserting a `doctorAssignments` row with `status: 'pending'`.
- The doctor confirms — `POST /api/front-desk/assignments/[id]/schedule` creates the `appointments` row and calls `scheduleAssignment` (`status: 'scheduled'`, `appointmentId` set).
- Or the doctor declines — `POST /api/front-desk/assignments/[id]/decline` calls `declineAssignment` (`status: 'declined'`, `declineReason` set), and the front desk reassigns by checking the patient in again.
- The doctor already sees their queue — `(dashboard)/doctor/page.tsx:44-53` reads `listPendingAssignmentsForProvider` and renders an "Assigned to you" panel with a schedule/decline modal per row.

`doctorAssignments` (`src/db/schema.ts:530-549`) is a complete three-state machine with `visitType`, `urgency`, `roomId`, `assignedByName` and `queueTicketNumber`. **Nothing about that machine is wrong and nothing about it changes here.**

**The single verified gap:** grepping `sendMessage|notify` across `src/lib/queries/doctor-assignments.ts`, `src/lib/queries/booking-requests.ts` and `src/lib/queries/appointments.ts` returns zero hits. No step of this workflow tells anybody anything. The doctor learns they have an assignment only by navigating to `/doctor` and noticing a panel that renders nothing at all when the list is empty; the patient is never told their visit was confirmed, at what time, or what to bring. This spec's entire job is wiring messages onto transitions that already happen.

This spec adds:

1. **A doctor-facing notification surface** — an unread-style count badge on the existing `/doctor` ("My Patients") nav item, driven directly by the count of `status = 'pending'` assignments for that provider, plus a hardened "Assigned to you" panel. No new table, no new state (§2, §4).
2. **An automated patient message on confirmation** — a `senderRole: 'system'` message into the patient's existing thread naming the confirmed day, time, doctor and reason, plus a fixed "what to bring" list (§5).
3. **A front-desk decline signal** — a count badge on the existing `/front-desk/assignments` nav item for declines nobody has acted on yet, plus the one nullable acknowledgement column needed to give that badge a clear-condition (§6).
4. **Two genuine correctness bugs found while reading the schedule/decline routes**, both of which the patient notification would otherwise amplify into patient-visible wrong information (§7).

**Explicitly out of scope:**

- **Real push notifications, SMS or email.** This app has no such integration. The only outbound-ish paths that exist are OTP delivery (real-time, login-only, single-purpose) and `broadcasts` (staff-composed free text with *simulated* delivery). Neither is an event-triggered notification channel, and adding a vendor integration speculatively is not this spec's job. The in-app `'system'` message and the in-app nav badges are the entire delivery mechanism.
- **Any change to the assignment state machine.** No new `doctorAssignmentStatusEnum` value, no change to what `scheduleAssignment`/`declineAssignment` write about status, no change to check-in's room/admission logic. The two fixes in §7 are guards that *reject invalid transitions the routes currently allow*; they add no state.
- **A general staff notification centre / `staffNotifications` table.** See §2 for why this is deliberately not built.
- **Appointment reminders** (a "your visit is tomorrow" nudge). That needs a scheduler this app does not have; confirmation-time is the only trigger point here.
- **Clinical pre-visit instructions** (fasting, medication holds, bowel prep). See §5.3 — these are per-patient clinical judgments and must never be auto-sent from a template.
- **Practice-timezone correctness.** `appSettings.practiceTimezone` exists (`src/db/schema.ts:409`) but is read by nothing in this codebase; every date/time surface formats in server-local time. This spec matches that existing behavior rather than becoming the one place that diverges (§8, Open Question 1).

## 2. The doctor-notification surface problem, and how it is resolved

The request says the doctor "should be sent a notification," and the obvious reading is "send it through the messages system." **That is not possible, and the reason is a hard one worth stating before the design.**

`messages` (`src/db/schema.ts:733-742`) is keyed on `patientId`. There is exactly one thread per patient, and the patient reads that same thread in the patient portal (`src/app/patient-portal/(authenticated)/messages/page.tsx`, via `listMessagesForPatient`). A row written into it is visible to the patient, by construction. So a message saying *"Dr. Kunam, you have a new urgent inpatient assignment for RD-0001 — please confirm or decline"* would be delivered straight to the patient's own inbox. There is no doctor-addressed thread to put it in.

The staff-side inbox (`(dashboard)/messages/page.tsx`) does not help either: it lists **every** patient thread to **every** staff role with no per-doctor scoping, and its own source comment says so explicitly. It is a shared practice inbox, not a per-doctor mailbox.

Three options were weighed:

- **(A) A new `staffNotifications` table** (recipient `providerId`, body, `readAt`) plus a bell menu. This is the "real" notification-centre answer, but it creates a second row that duplicates a fact `doctorAssignments` already holds perfectly — `status = 'pending' AND providerId = X` *is* "this doctor has an unhandled assignment." Two sources of truth that can disagree (a notification marked read while the assignment is still pending, a pending assignment with no notification row because an insert failed) is exactly the failure mode the eligibility spec rejected when it chose a third `senderRole` value over an `isAutomated` boolean beside `senderRole`. It is also a whole subsystem for one event type.
- **(B) Widen `messages` to support a staff recipient.** Requires a nullable `recipientProviderId`, a nullable `patientId`, and a rewrite of every read path's patient-scoping assumption — including the ones a separate messaging-isolation audit is currently hardening. Large, risky, and it makes the patient-thread invariant conditional.
- **(C, chosen) Derive the notification from the pending assignment itself.** `listPendingAssignmentsForProvider(providerId).length` is the doctor's unread count. Render it as a badge on the "My Patients" nav item so it is visible from every page in the dashboard, not only after navigating to `/doctor`.

**(C) is chosen** because it needs no new table and no new column, cannot drift from the underlying fact, and has a *better* clear-condition than a read receipt: the badge clears when the doctor actually schedules or declines, not when they glance at it. For a clinical work queue, "seen but not acted on" should keep nagging — a read-receipt-based notification would let an urgent assignment go quiet the moment the doctor opened a page. This is the same discipline `2026-09-28-queue-display-screen.md` §4 used when it derived display stage from existing fields instead of adding a status enum.

The honest limit of (C), stated plainly: **this is an in-app badge, not a push.** A doctor who is not logged in learns nothing until they log in. Given the out-of-scope ruling on SMS/push/email, that is the ceiling, and the spec does not pretend otherwise.

## 3. Data model changes (additive only)

```ts
// Added to the existing doctorAssignments table
patientNotifiedAt: timestamp('patient_notified_at'),            // set exactly once, on confirmation -- see §8
declineAcknowledgedAt: timestamp('decline_acknowledged_at'),    // front desk has seen/handled this decline -- see §6
declineAcknowledgedByName: text('decline_acknowledged_by_name'),// snapshot of session.name at acknowledge time
```

That is the complete schema change. All three are nullable, so every existing row is valid unchanged — important, since this repo shares one Neon database across branches and other branches insert `doctorAssignments` rows without knowing these columns exist (the same constraint already documented on `queueTicketNumber` at `src/db/schema.ts:543-548`).

**Why these live on `doctorAssignments` and not a side table:** each is a one-to-one fact about a single assignment's own lifecycle, with no independent lifecycle of its own — the same shape as `selectionConfirmedAt`/`selectionConfirmedByName`/`selectionNotifiedAt` on `patientTrialScreenings` in `2026-09-29-eligibility-auto-notification.md` §2, and of `identityVerifications.verified`/`verifiedBy`/`verifiedAt` before that. A side table would buy nothing and add a join to every read.

**Why `declineAcknowledgedAt` is not a state-machine change:** it adds no `doctorAssignmentStatusEnum` value and changes nothing about what `declineAssignment` writes. A declined assignment is still exactly `status: 'declined'` with a `declineReason`. The column records only whether a human on the front desk has since dealt with it, which is bookkeeping for the badge in §6, not a domain state.

**No change to `messages`.** The `'system'` `senderRole` value, `markReadByPatient`/`getUnreadCountForPatient` widening, and the `MessageThreadView` banner all arrive with the prerequisite eligibility spec. This spec consumes them and adds nothing.

## 4. Trigger 1 — the doctor is notified when the assignment is created

**No write happens at this step.** `createDoctorAssignment` is untouched: inserting the `pending` row *is* the notification. Three read-side changes make that notification actually reach the doctor.

**4.1 Nav badge.** `LeftNav` (`src/components/LeftNav.tsx:94`) currently takes only `{ role }` and its `ITEMS` list is static. It gains an optional `badges?: Partial<Record<string, number>>` prop keyed by `href`, and `NavLink` renders a count pill when the value is `> 0` — reusing the pill styling already used for `unreadByProviderCount` in `(dashboard)/messages/page.tsx` rather than inventing a second badge treatment. `(dashboard)/layout.tsx` is already an async server component that fetches the session, so it computes the counts there and passes them down:

- `'/doctor'` → `pendingCount`, computed only when `session.role === 'pi'`, via the same provider resolution `(dashboard)/doctor/page.tsx:50-52` already performs.
- `'/front-desk/assignments'` → `unacknowledgedDeclineCount` (§6), computed only for `frontdesk`/`admin`/`crc`.

Both are cheap counted queries on a small table, run once per dashboard navigation. Roles that do not see the nav item never run the query.

**4.2 Ordering.** `listPendingAssignmentsForProvider` currently has no `orderBy`, so the doctor's queue is in whatever order Postgres returns. It gains `ORDER BY` urgency (`emergency`, then `urgent`, then `routine`) then `createdAt` ascending — oldest first within a band. An `emergency` assignment must not sit below a `routine` one in the list a notification badge just pointed the doctor at. Because `doctorAssignmentUrgencyEnum` is declared in the order `['routine', 'urgent', 'emergency']`, a plain enum sort would be backwards; the query orders on an explicit `CASE` expression rather than on the enum's own collation.

**4.3 The silent-empty failure, and its fix.** `(dashboard)/doctor/page.tsx:50-52` resolves "this PI's own provider row" by matching the session's last name against `providers.name`, and if no provider matches it sets `pendingAssignments = []`. Today that renders as an absent panel, indistinguishable from "you have nothing assigned." Once a badge is making a positive promise about this number, a silent zero is a safety problem: a doctor whose account name does not match their provider row would be told, falsely, that nobody is waiting for them.

The fix is small and does not touch the matching logic itself (which is a known pre-existing simplification documented in three places): when `providerMatch` is `null`, `/doctor` renders an explicit warning in place of the panel — *"We couldn't match your account to a provider record, so your assignment queue can't be shown. Ask an administrator to check your provider record."* — and the nav badge is suppressed rather than shown as `0`. Absence of information is displayed as absence, never as zero.

**4.4 Panel content.** The existing panel shows `a.reason` and `{a.patientId} · {a.visitType} · {a.urgency}`. It gains the patient's display name (resolved the same way `listMessageThreads` already resolves it, `nameTebra ?? nameIntakeq`), `assignedByName`, `createdAt`, the `queueTicketNumber`, and a small urgency chip. `AssignmentStatusChip` covers *status*, not urgency, so urgency needs its own chip — built to that component's stated convention (a colored dot plus a plain text label, never color alone) rather than as a bare colored pill. This is what turns a bare list row into something a doctor can triage from. The `AssignmentScheduleModalTrigger` action is unchanged.

## 5. Trigger 2 — the patient is notified when the doctor confirms

### 5.1 Where it fires

Inside `POST /api/front-desk/assignments/[id]/schedule`, after the `appointments` insert and the `scheduleAssignment` call both succeed, and after the §7.1 status guard has passed. The send itself lives in one exported function so the guard travels with it:

```ts
// src/lib/queries/doctor-assignments.ts
export async function notifyPatientOfScheduledAssignment(
  assignment: DoctorAssignmentRow,
  appointment: typeof appointments.$inferSelect,
  providerName: string,
): Promise<void>
```

It re-reads `patientNotifiedAt` for the assignment, returns immediately if it is already set, otherwise builds the body (§5.2), calls `sendMessage(assignment.patientId, 'system', 'Clinsync (Automated)', body)`, and sets `patientNotifiedAt = now()`. The route then calls `logAudit(session, 'scheduled assignment into appointment and notified patient', assignmentRow.patientId)` — an amended verb on the existing audit call, not a second entry.

`providerName` comes from the `providerMatch` row the route has already loaded for its ownership check, so no extra query is needed.

**Why the route and not `scheduleAssignment` itself:** every function in `src/lib/queries/` is thin data access today — `doctor-assignments.ts` and `messages.ts` both contain nothing but queries. Burying a message send inside `scheduleAssignment` would also fire it from `tests/lib/queries/doctor-assignments.test.ts` and `tests/api/front-desk-assignments-schedule.test.ts` fixtures that only want the state transition. Keeping the send as its own named, separately-callable function preserves that layering while keeping the idempotency guard inseparable from the send.

**Failure handling:** the message send is *not* wrapped in a try/catch that swallows errors. If `sendMessage` throws, the route returns 500 and `patientNotifiedAt` stays null. The appointment and the `scheduled` status are already committed at that point, so the visible outcome is a confirmed appointment with no message — which the front desk can see (the assignment reads `scheduled`, and the thread has no notice) and fix by messaging the patient manually. That is strictly better than silently marking the patient notified when they were not. There is no retry mechanism, and none is proposed: this app has no job queue.

### 5.2 The message

A fixed, code-resident template in a new `src/lib/notification-templates.ts` (flat `src/lib/` module, matching `audit.ts` / `format.ts` / `rule-engine.ts`), exporting pure functions that take primitives and return a string — unit-testable with no database.

> **Your visit is confirmed.**
>
> {providerName} will see you on {Weekday, Month D, YYYY} at {h:mm AM/PM}.
>
> Reason for visit: {visitReason}
>
> Please bring with you:
> • A photo ID
> • Your insurance card
> • A current list of everything you take — prescriptions, over-the-counter medicines, vitamins and supplements — with the dose for each
> • Any forms we sent you that you haven't finished yet
> • A payment method, in case there is a copay due at the visit
>
> If this time doesn't work, reply to this message and our front desk will help you change it.

When `assignment.visitType === 'inpatient'`, one additional bullet is appended to the list:

> • An overnight bag — a few days of comfortable clothes and toiletries, and your medicines in their original labelled containers

**Sender identity:** `senderRole: 'system'`, `senderName: 'Clinsync (Automated)'`, rendering through the shared `MessageThreadView` as the centered "AUTOMATED NOTICE" banner the prerequisite spec introduces. Both the patient portal and the staff inbox get that treatment from the one shared component, so the front desk sees the exact notice the patient received, in the same thread, without any extra surface.

**Unread accounting** needs nothing new here: the prerequisite spec already widens `markReadByPatient` and `getUnreadCountForPatient` to treat `'system'` like `'provider'`, so this notice counts toward the patient portal's unread badge (`src/lib/queries/patient-portal.ts:54`) and marks read normally.

The closing "reply to this message" line is a factually supportable promise, not boilerplate: a patient reply is a `senderRole: 'patient'` row, which already increments `unreadByProviderCount` in `listMessageThreads` and surfaces in the staff inbox. Nothing new is needed to honour it.

### 5.3 Why "what to bring" is a fixed template, and why it contains exactly these items

**There is no existing appointment-prep copy anywhere in this codebase to reuse.** A dedicated exhaustive search for *bring / carry / prepare / instructions / arrive early / photo ID / insurance card / fasting / checklist / before your visit / reminder* across `src/`, `src/db/seed.ts`, `docs/` and `public/` returned no patient-facing prep copy at all. The nearest things are all unrelated: `patientStatements.type = 'reminder'` (a billing statement), one seeded broadcast about an unfinished intake packet (`src/db/seed.ts:1110`), and the insurance-*card-upload* feature. `broadcasts` is 100% staff-typed free text with no template mechanism (`BroadcastWizard.tsx` is a bare textarea). The `appointments` table has no instructions column and no `visitType` column. Confirming a booking request (`/api/booking-requests/[id]/confirm`) sends the patient nothing today. So this content is net-new, and the choice is: fixed template, or a new staff-editable field.

**Fixed template, matching the eligibility precedent exactly.** That spec's reasoning applies verbatim here: this message goes out with no human re-reading it at send time — the doctor's act of confirming *is* the review step, and it is a review of the *scheduling decision*, not of message copy. Wording that nobody proofreads at send time must be pre-vetted code, not a text box. Concretely: no per-send customization, no staff-editable template stored in `appSettings`, and no patient-supplied input anywhere in the body. Every interpolated value (`providerName`, the date/time, `visitReason`, `visitType`) comes from a row the staff already created through a validated, `.strict()`-parsed route.

Each item earns its place by being **generic, non-clinical, and true of every visit at this practice** — and each is grounded in something the app actually does:

| Item | Why it is safe to assert unreviewed |
|---|---|
| Photo ID | Identity confirmation at the desk; the app already models identity verification (`identityVerifications`). Universal, non-clinical. |
| Insurance card | The app has an insurance-card capture feature (`InsuranceCardUpload.tsx`, `/api/patients/[anonId]/insurance-card`) and a `payers` directory — bringing the card is literally what that feature consumes. |
| Current medication list with doses | Medication reconciliation is a universal intake step, and the app tracks `medicationEpisodes`. Asking the patient to *list* what they take is a data-gathering request, never a clinical instruction. |
| Unfinished forms | `formSubmissions` / Client Forms is a real, active part of this app, and the seeded broadcast copy already nags patients about exactly this. |
| Payment method for a possible copay | `charges`, `patientStatements` and a payment surface all exist. Hedged as "in case there is a copay" because the app cannot compute the amount at confirmation time — the message never states a figure it cannot source. |

**Deliberately excluded, and why:**

- **Fasting, medication holds, bowel prep, "stop taking X before your visit."** These are per-patient clinical judgments that depend on the visit, the labs ordered and the patient's own medications. Auto-sending them from a template is precisely the "software surfaces a fact, a human decides" line this codebase draws by name in `2026-09-28-questionnaire-auto-scoring.md`, `2026-09-28-care-plans.md` and `2026-09-28-lab-orders-and-results.md`, and getting one wrong is a real clinical harm, not a cosmetic error.
- **"Arrive 15 minutes early."** The app stores no practice arrival policy. Picking a number would be inventing a policy fact and stating it to patients as if the practice had set it.
- **Address or directions.** `appSettings.practiceSite` is a nullable free-text label with no structured address behind it; interpolating it would risk rendering an empty or meaningless location line. Raised as Open Question 2 rather than guessed at.

## 6. Trigger 3 — the front desk is notified when the doctor declines

The user's workflow does not end at the doctor: *"he/she should confirm **or the frontdesk then reassigns them**."* The front desk cannot reassign a decline it never hears about. `/front-desk/assignments` already lists every assignment including declined ones, so the surface exists — what is missing is a signal and, more subtly, a clear-condition.

`declined` is a terminal state that nothing ever clears. A badge counting declined assignments would therefore count up forever and be ignored within a day. Hence `declineAcknowledgedAt` / `declineAcknowledgedByName` (§3):

- The `/front-desk/assignments` nav badge counts assignments where `status = 'declined' AND declineAcknowledgedAt IS NULL`.
- The assignments page (`(dashboard)/front-desk/assignments/page.tsx`) already renders the reason — `AssignmentStatusChip` takes `declineReason` and appends it to its "Declined — needs reassignment" label — so nothing changes about how a decline *reads*. What changes is placement and action: unacknowledged declines sort to the top of the table, and each gains a **"Mark handled"** action.
- `POST /api/front-desk/assignments/[id]/acknowledge-decline`, no body, `frontdesk`/`admin`/`crc` only (the same roles that can check a patient in, since acting on a decline means re-checking the patient in to another doctor). Returns **404** if the assignment does not exist, **409** if `status !== 'declined'`, **409** if `declineAcknowledgedAt` is already set. On success it sets both columns and calls `logAudit(session, 'acknowledged declined assignment', patientId)`.

**No message is sent to anyone at this step.** The patient must not be told "your doctor declined you" — that is alarming, clinically meaningless to them, and premature, since the front desk is about to reassign. They will receive exactly one message: the confirmation, once some doctor confirms (§5). And there is no staff thread to send a decline notice into, for the reasons in §2. The badge is the notification.

## 7. Two genuine bugs found while reading the schedule and decline routes

Both are pre-existing, both are directly load-bearing for this spec (each turns into wrong information reaching a patient once §5 is live), and both fixes reject an invalid transition rather than adding a state.

**7.1 `POST .../schedule` never checks the assignment's current status.** It loads the row, checks ownership, checks for a scheduling conflict, inserts an `appointments` row and calls `scheduleAssignment`. Nothing stops a second POST on an assignment that is already `scheduled` (or already `declined`). A re-submit at a *different* time clears `hasSchedulingConflict`, inserts a second appointment, and overwrites `doctorAssignments.appointmentId` — orphaning the first appointment, which stays `scheduled` on the calendar with nothing pointing at it. With §5 live, the patient would receive two contradictory confirmations for two different times.

**Fix:** immediately after the ownership check, `if (assignmentRow.status !== 'pending') return 409 { error: 'This assignment has already been scheduled or declined.' }`. This matches the codebase's own established convention for a re-submitted confirm, cited in `2026-09-29-eligibility-auto-notification.md` §3 and `2026-09-28-public-booking-widget.md` §5.

**7.2 `POST .../decline` never checks status either.** An already-`scheduled` assignment can be declined, leaving `status = 'declined'` and a `declineReason` while `appointmentId` still points at a live, scheduled appointment that nothing cancels. With §5 live, the patient has already been sent a confirmation for a visit the record now says was declined.

**Fix:** the same guard, same 409 shape. Note what the guard deliberately does *not* do: it does not cancel the appointment, because deciding whether a scheduled appointment should be cancelled is a real scheduling action with its own surface (`AppointmentStatusSelect`), not something a decline route should do implicitly. The guard simply makes the invalid transition impossible.

These two guards also give §8's idempotency its first layer.

## 8. Idempotency and formatting

**The risk:** the same "your visit is confirmed" message reaching a patient twice, or two such messages disagreeing about the time. Two layers, mirroring `2026-09-29-eligibility-auto-notification.md` §4:

1. **Route-level 409** (§7.1) — an already-`scheduled` assignment is rejected outright before anything runs. This is the normal path and catches a double-click or a replayed request.
2. **`patientNotifiedAt` as the actual send-guard**, checked inside `notifyPatientOfScheduledAssignment` immediately before the send, independent of the 409 above. Even if two concurrent requests both passed the route check before either committed, the second cannot re-send once the first has set the timestamp. The guard lives on the fact being guarded, not on a UI-level assumption that only one request arrives.

`patientNotifiedAt` is **never cleared**, by anything. If a confirmed visit is later cancelled or rescheduled, the patient really was notified once; that historical fact does not un-happen. (Notifying a patient about a *reschedule* is a separate trigger this spec does not add — see Open Question 3.)

**Date/time formatting.** `appointments.startsAt` is a Drizzle `timestamp` (no timezone), and every existing surface in this app formats it with local `Date` getters — the patient portal uses `toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })`. The message body must agree with what the patient sees on their own Appointments page, so it uses the same local-getter approach, following the documented helper pair at `src/lib/queries/reports.ts:22-37` — whose own comment spells out the trap (never mix `toISOString()`'s UTC day with `toLocaleTimeString()`'s local time, or an appointment near local midnight renders the wrong calendar day). The template module reuses that pattern rather than introducing a third ad-hoc one. `practiceTimezone` stays unread, as it is everywhere else today (Open Question 1).

## 9. Testing

Following this repo's real-DB-backed test conventions, matching the style of `tests/lib/queries/doctor-assignments.test.ts`, `tests/lib/queries/messages.test.ts` and `tests/api/front-desk-assignments-schedule.test.ts`.

- **`tests/lib/notification-templates.test.ts`** (new, pure — no DB): the confirmation body contains the provider name, the formatted local day and time, and the visit reason; every one of the five base "what to bring" bullets is present; `visitType: 'inpatient'` adds the overnight-bag bullet and `'outpatient'` does not; an appointment at 23:30 local renders the same calendar day the patient portal's own formatter renders (the `reports.ts` midnight trap, asserted directly).
- **`tests/api/front-desk-assignments-schedule.test.ts`** (extended): the success path inserts exactly one `'system'` message for that patient and sets `patientNotifiedAt`; a second POST on the now-`scheduled` assignment returns 409, creates no second `appointments` row, and — asserted explicitly — leaves the message count at exactly one; a POST on a `declined` assignment returns 409; the message is addressed to the assignment's patient and no other patient's thread gains a row.
- **`tests/api/front-desk-assignments-decline.test.ts`** (new — the decline route has no test file today; only `front-desk-assignments-schedule.test.ts` exists): declining an already-`scheduled` assignment returns 409 and leaves `status`/`appointmentId` untouched; a normal decline still writes `declineReason` and sends no message at all (asserted: the patient's message count is unchanged).
- **`tests/api/front-desk-assignments-acknowledge-decline.test.ts`** (new): 404 for an unknown id; 409 for a `pending` or `scheduled` assignment; 409 for an already-acknowledged decline; 403 for a `pi` session; success sets both columns and removes the row from the unacknowledged count.
- **`tests/lib/queries/doctor-assignments.test.ts`** (extended): `listPendingAssignmentsForProvider` returns `emergency` before `urgent` before `routine`, and oldest-first within a band; `notifyPatientOfScheduledAssignment` called twice sends exactly one message.

## 10. Self-review

- **Placeholder scan:** no TODO/TBD/bracketed placeholders. The message body, sender name, column names, route path, and template module path are all stated concretely.
- **Internal consistency:** `patientNotifiedAt` is described as never-cleared in both §3 and §8, and nothing elsewhere clears it. §6 says no message is sent on decline, and §9's decline test asserts exactly that. §2 rules out a `staffNotifications` table and §3's schema change adds none. §7's guards are the same 409 shape in both routes and are the stated first layer of §8.
- **Scope check:** one implementation plan's worth — three additive nullable columns, one new route, one new pure template module, one shared-component prop, two one-line route guards, one query ordering change. No new subsystem. The prerequisite sequencing keeps the `'system'` sender-role work out of this plan entirely.
- **Ambiguity check:** the doctor-notification surface is one named mechanism (a derived nav badge), not "notify the doctor somehow"; "what to bring" is an enumerated, fixed list with an explicit exclusion list rather than "include appropriate prep instructions"; the double-schedule, double-decline and double-acknowledge behaviors each have one stated outcome; the send-failure behavior is stated (500, no retry, `patientNotifiedAt` left null) rather than left implicit.
- **Boundary check:** no `doctorAssignmentStatusEnum` value added, no change to what `scheduleAssignment`/`declineAssignment` write, no change to check-in's room or admission logic, no vendor integration. The §7 fixes reject invalid transitions and add no state.

## 11. Role gating summary

| Action | Allowed |
|---|---|
| Create an assignment (existing check-in) | frontdesk, admin, crc — unchanged |
| See the pending-assignment badge and queue | pi only, scoped to their own matched provider row — unchanged scoping, now with an explicit warning when the match fails (§4.3) |
| Confirm (schedule) an assignment, triggering the patient message | pi only, and only for an assignment routed to their own provider row — unchanged ownership check, now with a status guard (§7.1) |
| Decline an assignment | pi only, same ownership check, now with a status guard (§7.2) |
| See the unacknowledged-decline badge and queue | frontdesk, admin, crc — the roles that can act on it by re-checking the patient in |
| Acknowledge a decline | frontdesk, admin, crc — **pi excluded**: the declining doctor is not the one who reassigns |
| Read the resulting automated message | Existing per-patient thread access — any staff role, plus the patient themself in their own thread |
| Edit the "what to bring" copy | Nobody at runtime. It is code, deployed, not a setting (§5.3) |

## 12. Open questions

1. **Practice timezone.** `appSettings.practiceTimezone` is stored and read by nothing; this spec formats in server-local time to stay consistent with every other surface. A confirmation message is arguably the highest-stakes place to get a time wrong, since it is frozen as text the moment it is sent and cannot be re-rendered later. Is fixing `practiceTimezone` app-wide a separate spec that should be sequenced *before* this one?
2. **Location line.** Should the confirmation name where to go? `appSettings.practiceSite` is nullable free text with no structured address, and `rooms` (ward / room / bed) is only meaningful for inpatient. Adding a conditional location line is small but needs a decision about what to print when the data is absent.
3. **Reschedule and cancellation notices.** If a confirmed appointment's time later changes via `AppointmentStatusSelect` or the calendar, the patient holds a message stating the old time and `patientNotifiedAt` deliberately does not reset. A "your visit has moved" notice is the natural follow-on but is a different trigger on a different table (`appointments`), so it is left out here.
4. **Decline-count badge decay.** If the front desk never clicks "Mark handled," the badge persists indefinitely. That is intentional (an unhandled decline means a patient with no doctor), but it may warrant an auto-acknowledge when a *new* pending assignment is created for the same patient — i.e. treating a re-check-in as implicit handling. Deliberately not specified, because inferring intent from a later unrelated action is exactly the kind of implicit behavior this codebase's specs have consistently avoided.
