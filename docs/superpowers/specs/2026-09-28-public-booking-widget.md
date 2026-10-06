# Public Booking Widget — Design Spec

**Status:** Draft for review — design spec, not yet implemented.
**Position in the larger initiative:** next item in the "complete the HIMS platform" backlog — this is the first module in this backlog that's genuinely public-facing (no login, no token-in-a-staff-sent-link — a cold, unauthenticated visitor from the practice's public website), which changes the security posture: every other write path in this app assumes an authenticated staff member or a token a staff member generated and sent; this one doesn't.

## 1. What this is, and the boundary it works within

A public, embeddable widget (or standalone page) where a prospective or existing patient can request an appointment slot without calling the office. **The one real design decision this spec makes:** an unauthenticated public form must never directly create a firm, confirmed clinical appointment — it creates a **booking request** that a staff member reviews and either confirms (which creates the real `appointments` row) or declines. This is the same "software surfaces a fact, a human decides" principle already applied to eligibility verdicts and lab-result flags elsewhere in this codebase, applied here to the specific risk of letting anonymous internet traffic write directly into clinical scheduling data. A real appointment slot conflict, a bot submission, or a genuinely malicious actor probing for information all get caught by a human in the loop before anything clinical is created — a public form that directly writes a confirmed appointment has no such backstop.

This spec adds:
1. A **`bookingRequests`** table — name, DOB, contact info, requested provider/date range, reason (free text), status (pending/confirmed/declined), submitted anonymously.
2. `POST /api/public/booking-requests` — unauthenticated, rate-limited (reusing this app's existing `Ratelimit`/Upstash infrastructure, same posture as the existing login/OTP endpoints — a public write endpoint with no auth is exactly the kind of surface that already has a rate-limiting precedent in this codebase to follow), `.strict()` validated, no PHI beyond what's needed to identify and contact the requester.
3. A **staff-facing Booking Requests queue** (`/booking-requests`, matching the existing Front Desk assignment-queue UI pattern) where staff confirm (creating a real `appointments` row) or decline a request.
4. A **public-facing widget page** (`/book`, no app chrome, embeddable) — provider/date picker (reads real provider availability from existing `appointments`/`providers` data, read-only, no write until submission) and the request form.

**Explicitly out of scope:** a public CAPTCHA (needs a real vendor — reCAPTCHA/hCaptcha/Turnstile — the same vendor boundary already established elsewhere; rate-limiting is this spec's actual anti-abuse mechanism, not a replacement for a real CAPTCHA if abuse becomes a real problem later). Real-time slot locking (two people requesting the same slot simultaneously both submit successfully as pending requests — staff resolves the conflict at confirmation time, which is an acceptable outcome for a request-then-confirm model, unlike a direct-booking model where it would be a real double-book). Automatic existing-patient matching (a submitted name+DOB isn't automatically linked to an existing `patients` row — that's a real identity-matching decision this codebase already treats carefully elsewhere, via the existing Identity Matching screen; a booking request from an existing patient still goes through staff review, where staff can make that link manually).

## 2. Data model changes (additive only)

```ts
export const bookingRequestStatusEnum = pgEnum('booking_request_status', ['pending', 'confirmed', 'declined'])

export const bookingRequests = pgTable('booking_requests', {
  id: serial('id').primaryKey(),
  requesterName: text('requester_name').notNull(),
  requesterDob: date('requester_dob').notNull(),
  requesterEmail: text('requester_email'),
  requesterPhone: text('requester_phone'),
  preferredProviderId: integer('preferred_provider_id').references(() => providers.id), // nullable -- "no preference" is a valid request
  preferredDateRangeStart: date('preferred_date_range_start').notNull(),
  preferredDateRangeEnd: date('preferred_date_range_end').notNull(),
  reason: text('reason').notNull(),
  status: bookingRequestStatusEnum('status').default('pending').notNull(),
  submittedAt: timestamp('submitted_at').defaultNow().notNull(),
  reviewedByName: text('reviewed_by_name'),
  reviewedAt: timestamp('reviewed_at'),
  declineReason: text('decline_reason'),
  resultingAppointmentId: integer('resulting_appointment_id').references(() => appointments.id), // set only on confirm
})
```

**Why a whole new table rather than creating a `appointments` row with a `status: 'requested'` value added to the existing enum:** `appointments.patientId` is a required, non-null FK to a real `patients` row — an anonymous public submitter is not yet a patient in this system (see the identity-matching boundary above), so there is no valid `patientId` to put there. A `bookingRequests` row genuinely has different, weaker guarantees than a real appointment (no verified identity, no confirmed provider availability) and deserves its own table rather than forcing `appointments` to support a "maybe not even a real patient yet" state.

## 3. Rate limiting

New `checkBookingRequestRateLimit(ip: string)` in `src/lib/rate-limit.ts`, following the exact dual-bucket (per-IP + identity-independent global) pattern already established for every other public-ish endpoint in that file (`checkOtpSendRateLimit` is the closest precedent — same file, same shape) — a tighter window than login (this is a lower-frequency legitimate action; nobody submits multiple real booking requests per minute).

## 4. Confirmation flow

`PATCH /api/booking-requests/[id]/confirm` — staff-initiated (admin, crc, frontdesk — matches this app's existing registration-staff access tier, not pi, mirroring the payer-directory plan's precedent that front-desk/coordinator roles handle registration-adjacent work, not investigators), body requires an existing `patientId` (staff links the request to a real patient record — creating a brand-new patient from an unauthenticated public submission is also out of scope, matching the identity-matching boundary above; if the requester is genuinely new, staff registers them through the existing Add Client flow first, then confirms the booking against that new patient) plus a concrete `providerId`/`startsAt`/`endsAt`. Creates the real `appointments` row, sets `bookingRequests.status = 'confirmed'`, `resultingAppointmentId`.

`PATCH /api/booking-requests/[id]/decline` — same staff access tier, body `{ reason: string }`.

Every confirm/decline calls `logAudit(session, <action>, <patientId or null>)`.

## 5. Testing

`tests/lib/rate-limit.test.ts` extension (new `checkBookingRequestRateLimit` block, matching the file's existing per-function test-block convention), `tests/api/public-booking-requests.test.ts` (unauthenticated POST succeeds with valid data, `.strict()` rejects extra fields, rate limit enforced after N requests from one IP, no PHI beyond the spec's listed fields is ever accepted or stored — explicit assertion the row shape matches exactly), `tests/api/booking-requests-confirm.test.ts` (confirm creates a real appointment and links it, decline never creates one, a non-staff/wrong-role request is rejected, confirming an already-confirmed or already-declined request is rejected 409 not silently re-processed).

## 6. Role gating summary

| Action | Allowed |
|---|---|
| Submit a booking request | Anyone (unauthenticated, rate-limited) |
| View the booking requests queue | admin, pi, crc, frontdesk (matches existing read-access precedent) |
| Confirm/decline a request (write) | admin, crc, frontdesk (registration-staff tier, not pi — matches payer-directory's established precedent for registration-adjacent work) |
