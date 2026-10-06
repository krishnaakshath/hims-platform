# Queue Display Screen — Design Spec

**Status:** Draft for review — design spec, not yet implemented.
**Position in the larger initiative:** next item in the "complete the HIMS platform" backlog — a lobby/waiting-room status board, distinct from the authenticated staff dashboards this app already has.

## 1. What this is, and the boundary it works within

A read-only digital-signage view, meant to run on a TV or tablet in the physical waiting room, showing patients their queue position without a staff member calling out names. This is **not** a new domain model — it's a sanitized, public-facing projection of data this app already tracks: `doctorAssignments` (pending/scheduled/declined, urgency, room) is already this app's real triage queue, and `rooms` already tracks occupancy. This spec adds a display layer on top, not new queue logic.

**The one real design decision this spec makes, and why:** a public screen in a psychiatric practice's waiting room must not display any information that outs a person as a patient there beyond what physical presence already does — no names, no visit reasons, no diagnoses. Real clinics solve this with an opaque ticket number the patient is given at check-in, and this spec follows that convention rather than inventing a "first name + last initial" compromise, which several real practices avoid for exactly this population.

This spec adds:
1. A **`queueTicketNumber`** column on `doctorAssignments` — a short, sequential, per-day, publicly-displayable number, generated when the assignment is created (at check-in), unrelated to `patients.id`.
2. A **`GET /api/queue-display`** route — unauthenticated (PIN-protected, see §3), returns only ticket numbers, urgency, and coarse stage (Waiting / With Nurse / Ready — derived from `doctorAssignments.status` + `rooms.status`), never patient names or reasons.
3. A **`/display/queue`** page — full-screen, auto-refreshing (polling, no new realtime infra), large-type layout suitable for a TV, grouped by stage.
4. A small **"Your ticket number"** display added to the front-desk check-in flow (wherever a `doctorAssignment` is created) so staff can hand the number to the patient.

**Explicitly out of scope:** patient self-service check-in kiosks (a real separate device/flow). Audio call-outs (needs real hardware/speaker integration). Estimated wait-time prediction (needs historical throughput data this app doesn't track yet — showing a fake number would be actively misleading in a clinical setting).

## 2. Data model changes (additive only)

```ts
// Added to the existing doctorAssignments table
queueTicketNumber: integer('queue_ticket_number').notNull(),
```

Generated at creation time as `(count of today's assignments) + 1`, reset daily by virtue of being derived from `createdAt`'s date rather than stored as a running total — computed in the query layer at insert time (`SELECT count(*) FROM doctor_assignments WHERE createdAt::date = current_date`), not a sequence, since ticket numbers resetting at midnight is the whole point (no unbounded growth, no collision risk across days since the display always scopes to "today").

No new table: the display's PIN lives in `appSettings` (already the single-row pilot-wide settings table) as a new nullable `queueDisplayPin` text column, admin-settable, defaulting to unset (display route returns 401 until an admin sets one — never silently public by default).

## 3. Display access model

The `/display/queue` page is a real route with no staff session cookie requirement (a lobby TV isn't logged in as a staff member), but it is not simply public: on load it prompts for the PIN stored in `appSettings.queueDisplayPin`, stores it in `sessionStorage` (survives a refresh, not a new browser session) once entered, and every subsequent `GET /api/queue-display` call sends it as a header, checked server-side against the stored PIN. This is a deliberately lightweight gate (a shared lobby device, not a per-staff-member login) matching the real physical-security model of a waiting-room screen, not this app's normal per-user auth.

## 4. Stage derivation (no new status enum)

Computed from existing fields, not a new state machine:
- **Waiting:** `doctorAssignments.status = 'pending'`
- **With Nurse / Ready for Provider:** `status = 'scheduled'` and `roomId` is set — displayed as "Ready" (the spec deliberately doesn't try to distinguish nurse-prep from provider-ready, since nothing in the current data model tracks that distinction, and inventing a new one is out of scope)
- Declined/removed assignments and assignments whose `admissions`/`appointments` already exist (a same-day admission or a completed visit) are excluded from the display entirely — this reuses `admissionTransfers`/`admissions` presence as the natural "no longer waiting" signal.

## 5. Front desk integration

The existing Front Desk assignment-creation flow (wherever `doctorAssignments` are created today) gains a small, non-blocking confirmation showing the new ticket number after creation — read-only display, not a new form field (the number is server-generated, never staff-entered).

## 6. Testing

`tests/lib/queries/queue-tickets.test.ts` (ticket number generation resets per day, is sequential within a day, two patients checked in same day get sequential distinct numbers), `tests/api/queue-display.test.ts` (PIN required and enforced, unset PIN returns 401 not empty-array, correct stage derivation for pending vs scheduled-with-room vs declined vs already-admitted, no patient name/reason ever appears in the response body — explicit assertion that the JSON never contains any patient's actual name string).

## 7. Role gating summary

| Action | Allowed |
|---|---|
| View `/display/queue` | Anyone with the PIN (lobby device, not a staff role) |
| Set/change the PIN | admin only (`appSettings` write, matching existing settings-page convention) |
| View own ticket number at check-in | Front desk staff (admin/crc/frontdesk, matching existing check-in access) |
