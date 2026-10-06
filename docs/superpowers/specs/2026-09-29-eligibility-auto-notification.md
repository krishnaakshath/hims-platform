# Eligibility Auto-Notification — Design Spec

**Status:** Draft for review — design spec, not yet implemented.
**Position in the larger initiative:** next item in the "complete the HIMS platform" backlog — a notification hook on top of the *existing* inclusion/exclusion screening system (`rule-engine.ts`, `patientTrialScreenings`, `screeningCriteriaResults`), not a change to that system's own logic.

## 1. What this is, and the boundary it works within

Today, a patient's trial eligibility verdict (`patientTrialScreenings.overallStatus`, one of `green`/`yellow`/`red`) is a **purely computed** value — `RefreshEligibilityButton` re-runs `regenerateScreeningCriteria` against the patient's current chart data, and `evaluateCriteria()` (`src/lib/rule-engine.ts`) derives `green` only when every criterion's own verdict is `green` (an empty evidence set defaults to `yellow`, never `green`, per that function's own "no guessing" rule). Nothing in the app today requires — or even offers — a human to explicitly review and confirm that verdict before it's treated as final. The Trial Detail page's "Passed" bucket and the Patient Detail page's `StatusChip` ("Meets") both just *display* the computed value.

**The one real design decision this spec makes:** the automatic patient-facing message does **not** fire the instant the rule engine computes `green`. It fires only when a staff member (PI, CRC, or admin — see §7) takes an explicit **"Confirm Eligibility"** action. This is the same "software surfaces a fact, a human decides" principle already established in this codebase — explicitly, by name, in `2026-09-28-questionnaire-auto-scoring.md`, `2026-09-28-care-plans.md`, and `2026-09-28-lab-orders-and-results.md` (all three call out "eligibility verdicts" by name as an existing example of the principle) and applied to a structurally identical risk in `2026-09-28-public-booking-widget.md` (an unreviewed write must not directly become a patient-facing fact). A computed `green` can be wrong — stale chart data, a missing document, a rule-engine edge case the PI would catch on read but the algorithm wouldn't — and auto-texting a patient "you've been selected" off an unreviewed computation is a real clinical and reputational risk this spec is designed to avoid. Since no such confirmation action exists today, this spec adds one.

This spec adds:
1. Two nullable columns on `patientTrialScreenings` — `selectionConfirmedAt` / `selectionConfirmedByName` (who confirmed, and when) and `selectionNotifiedAt` (the idempotency guard, §4).
2. A **"Confirm Eligibility"** action, `POST /api/patients/[anonId]/screening/confirm`, surfaced as a button on the Patient Detail page next to the existing `StatusChip`/`RefreshEligibilityButton` — visible only when `overallStatus === 'green'` and not yet confirmed.
3. A generated, non-staff-editable **automated message**, sent into the patient's existing message thread (`messages` table) the moment confirmation succeeds, interpolating the real trial's name and site.
4. A new `'system'` value on `messages.senderRole`, and a distinct visual treatment in `MessageThreadView` for messages sent this way — **the first automated/system-generated message this codebase's messaging system has ever had** (see §5).

**Explicitly out of scope:** the rule engine or criteria-evaluation logic itself — `evaluateCriteria()` and `regenerateScreeningCriteria()` are untouched; this spec only adds a hook that reads their output. SMS/email delivery outside this app's existing in-app patient-portal messaging — grepping this codebase for an existing outbound patient-notification channel turns up only the OTP-delivery path (real-time, single-purpose, login-only) and `broadcasts` (staff-composed, staff-triggered, simulated delivery, no event-triggered precedent). Neither is a real "notify a patient automatically when X happens" precedent, so this spec establishes that pattern for the first time entirely within the existing message thread — a future SMS/email echo of this same notification is a plausible extension (following the `broadcasts`/OTP "simulate the outcome, never claim a real transaction happened" discipline) but is not required here. Any change to the Tebra/IntakeQ patient data model.

## 2. Data model changes (additive only)

```ts
// Added to the existing patientTrialScreenings table
selectionConfirmedAt: timestamp('selection_confirmed_at'),
selectionConfirmedByName: text('selection_confirmed_by_name'), // snapshot of session.name, same reasoning as broadcasts.sentBy / reviews.sentBy elsewhere in this schema
selectionNotifiedAt: timestamp('selection_notified_at'), // set exactly once -- see §4
```

```ts
// messages.senderRole widens from ('provider' | 'patient') to add 'system'
senderRole: text('sender_role', { enum: ['provider', 'patient', 'system'] }).notNull(),
```

**Why these live on `patientTrialScreenings`, not a new table:** a confirmation and its resulting notification are one-to-one facts about a single screening's outcome, exactly the same shape as `identityVerifications.verified`/`verifiedBy`/`verifiedAt` on that table — no independent lifecycle of their own that would justify a side table (contrast with `labResults`, which genuinely has its own lifecycle and author, separate from `labOrders`).

**Why `'system'` is a new enum value on the existing `messages` table, not a new table or a boolean flag:** the automated notice is a real message in the patient's real thread — it needs to show up in `listMessagesForPatient`, count toward unread badges, and render inline alongside human messages in the same `MessageThreadView`. A third `senderRole` value (rather than a `isAutomated: boolean` alongside `senderRole: 'provider'`) keeps "who/what sent this" as a single source of truth instead of two columns that could disagree, and it's a strictly additive change to an existing `text(..., { enum: [...] })` column — no migration of existing rows.

## 3. The confirm action

`POST /api/patients/[anonId]/screening/confirm`, no body. Looks up the patient's screening the same way `POST /api/patients/[anonId]/refresh` already does (`select from patientTrialScreenings where patientId = anonId`, taking the one row — this app's existing single-active-screening-per-patient simplification, not something this spec introduces).

- **404** if the patient has no screening at all.
- **409** (`"Cannot confirm — screening is not currently green"`) if `overallStatus !== 'green'`. A `yellow` or `red` screening can never be confirmed, by construction — this is the guard that keeps a computed non-pass from ever reaching a human "confirm" button in the first place.
- **409** (`"Already confirmed"`) if `selectionConfirmedAt` is already set — matches this codebase's own established convention for a re-submitted confirm (`2026-09-28-public-booking-widget.md` §5: "confirming an already-confirmed... request is rejected 409, not silently re-processed"). The button itself is also hidden client-side once confirmed (§6), so this is a defense-in-depth guard against a stale page/double-click/replay, not the primary UX path.
- On success: sets `selectionConfirmedAt = now()`, `selectionConfirmedByName = session.name`, builds and sends the automated message (§5), sets `selectionNotifiedAt = now()`, invalidates `patientDetailCacheKey(anonId)` (same as `refresh`/`identity`), and calls `logAudit(session, 'confirmed trial eligibility and notified patient', anonId)`.

**What happens if the verdict later changes:** `regenerateScreeningCriteria()` (called by the existing `refresh` route) gains one new behavior — if a screening that was previously confirmed re-evaluates to anything other than `green`, it clears `selectionConfirmedAt`/`selectionConfirmedByName` (but **not** `selectionNotifiedAt` — the patient really was notified once; that historical fact doesn't un-happen). A confirmation was a human's judgment about the evidence *at that moment*; once the underlying chart data changes enough to flip the computed verdict away from `green`, that judgment no longer has a factual basis and must be re-made, not silently preserved. If the patient is later reconfirmed after re-reaching `green`, this is treated as a genuinely new confirmation and sends a new notification (§4) — the earlier notification's premise no longer strictly held, so this is not a duplicate in the sense §4's guard is protecting against.

## 4. Idempotency

The risk being guarded against: the same "you're selected" message reaching a patient twice for the same confirmation. Two layers:

1. **Route-level 409** (§3) on an already-confirmed screening — the normal path, catches a double-click or a replayed request outright before anything else runs.
2. **`selectionNotifiedAt` as the actual send-guard**, checked immediately before the message-send step, independent of the 409 above: the confirm function only calls `sendMessage(...)` and sets `selectionNotifiedAt` inside the same code path that already checked `selectionNotifiedAt IS NULL`, so even in a theoretical race (two concurrent confirm requests both passing the route-level check before either commits), the second write can't re-trigger a send once the first has set the timestamp. This mirrors the reasoning already given for `messages.senderName` being captured at send time rather than resolved later: the guard lives on the fact being guarded, not on a UI-level assumption that only one request will ever arrive.

## 5. The automated message

**Content — a fixed template, not staff-editable free text**, interpolating the real trial the patient was screened against (resolved via `screening.trialId → trials.name` / `trials.site`, the same join `workbook/export`'s route already performs for its own trial-name lookup):

> "Great news — based on your recent screening, you've been selected to move forward with **{trial.name}** at {trial.site}. A member of our care team will reach out soon to schedule your next steps."

This is deliberately **not** an editable field on the confirm action (no free-text box, no per-send customization) — unlike a staff-authored message or a `broadcasts` send, this message goes out with no human re-reading it at send time (confirming *is* the review step; the copy itself must already be safe and correct before that moment), so the wording is fixed, pre-vetted template code, not user input.

**Sender identity:** stored as `senderRole: 'system'`, `senderName: 'Clinsync (Automated)'`. `MessageThreadView` (shared by both the staff inbox and the patient portal — one component, one behavior change reaches both surfaces) renders a `senderRole === 'system'` message as a centered, full-width banner rather than a left/right chat bubble, labeled **"AUTOMATED NOTICE"** in the same small-caps treatment already used for sender names, with a fixed italic line beneath the body: *"This is an automated note, not a reply from your care team."* — matching the visual/copy convention described in the reference screenshot, established here for the first time in this codebase's own messaging UI (see §1's grep finding — nothing to reuse).

**Read/unread accounting:** `markReadByPatient` and `getUnreadCountForPatient` currently key off `senderRole = 'provider'`; both are widened to treat `'system'` the same as `'provider'` (an automated notice is, from the patient's side, a message from the practice they need to see — it must count toward their unread badge and get marked read the same way a provider message does). `markReadByProvider`/`getUnreadCountForProvider` (patient → staff direction) are untouched — a system message isn't something staff need to "read," it already appears in their inbox thread view as a record that it was sent.

## 6. UI

Patient Detail page, in the header row that already holds `StatusChip` and `RefreshEligibilityButton` (`src/app/(dashboard)/patients/[anonId]/page.tsx`):
- `overallStatus === 'green'` and `selectionConfirmedAt` unset → a **"Confirm Eligibility & Notify Patient"** button (same visual weight as `RefreshEligibilityButton`), posting to the new route and reloading on success (same `window.location.reload()` pattern `RefreshEligibilityButton` already uses, for the same cache-consistency reason documented on that component).
- `selectionConfirmedAt` set → the button is replaced with a small confirmed-state line: "Eligibility confirmed by {selectionConfirmedByName} on {date} — patient notified {selectionNotifiedAt's date}."
- `overallStatus !== 'green'` → nothing renders here (matches the existing pattern where `RefreshEligibilityButton` itself only renders when `patient.overallStatus` is set at all).

No change to the Trial Detail page's "Passed" list beyond what already displays (`StatusChip`) — that page is a trial-wide roster view, not where a PI/CRC reviews a specific patient's evidence before confirming; the confirm action stays on the per-patient page where the actual `EvidenceCard` evidence already lives.

## 7. Testing

Following this codebase's real-DB-backed test conventions (matching `tests/lib/queries/trial-screenings.test.ts` and `tests/api/messages.test.ts`'s existing style):

- `tests/lib/queries/eligibility.test.ts` (extended): confirming a `green` screening sets `selectionConfirmedAt`/`selectionConfirmedByName`/`selectionNotifiedAt` and inserts exactly one `'system'` message with the interpolated trial name/site; confirming a `yellow` or `red` screening is rejected and writes nothing; re-running `regenerateScreeningCriteria` on a confirmed screening that flips away from `green` clears the confirmation fields but leaves `selectionNotifiedAt` untouched; re-confirming after a later return to `green` sends a second, independent notification.
- `tests/api/patients-screening-confirm.test.ts`: 404 for a patient with no screening; 409 for a non-green screening; 409 for an already-confirmed screening (and, explicitly, that this second call never results in a second message row); 403 for a `frontdesk` session; success path asserts the response, the DB row, and that exactly one message exists in `messages` for that patient afterward.
- `tests/lib/queries/messages.test.ts` (extended): `getUnreadCountForPatient`/`markReadByPatient` treat a `'system'` message the same as a `'provider'` message; `getUnreadCountForProvider` is unaffected by a `'system'` message.

## 8. Self-review

- **Placeholder scan:** no `TODO`/`TBD`/bracketed placeholders left in the spec; the message template, sender name, and route path are all stated concretely.
- **Internal consistency:** the confirm route's guards (§3), the idempotency mechanism (§4), and the verdict-changes-later behavior (§3) don't contradict each other — `selectionNotifiedAt` is the one field that is deliberately never cleared, everywhere it's mentioned.
- **Scope check:** no change to `rule-engine.ts`/`evaluateCriteria`, no new external delivery channel, no Tebra/IntakeQ schema touched — matches the stated out-of-scope list in §1.
- **Ambiguity check:** trigger point is a single named action (not "fires when reviewed," which route/who/when was left undefined in the original request); role gating is a concrete list (§9); the double-confirm and verdict-regression behaviors are each given one explicit, stated outcome rather than left as an open question.

## 9. Role gating summary

| Action | Allowed roles |
|---|---|
| View a patient's screening evidence (existing) | admin, pi, crc, frontdesk (existing read-access precedent — unchanged) |
| Confirm eligibility & trigger the notification (write) | admin, pi, crc — matches this codebase's own framing of who runs inclusion/exclusion screening (the PI and the CRC), the same clinical-judgment tier already used for lab-result interpretation and note-signing (`2026-09-28-lab-orders-and-results.md` §8); **frontdesk excluded** — a logistics/registration role, not the tier that owns a trial-eligibility judgment (same distinction that spec already draws for "who can order/interpret" vs. "who can log a logistics event") |
| View the resulting automated message (existing thread) | Same as existing per-patient message thread access (any staff role, plus the patient themself in their own thread) |
