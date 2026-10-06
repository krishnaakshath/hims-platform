# Patient Messaging Isolation — Security Audit

**Status:** Audit complete — no code changes recommended beyond two additional regression tests.
**Position in the larger initiative:** a targeted security audit, not a feature. The request was: "the messaging between the patients and the doctor... should be separate for each and every patient... everyone's info is classified." This document verifies whether `messages` already enforces that separation, and specs only the hardening actually justified by what was found.

## 1. Scope and verdict

**Verdict: already correctly isolated per-patient, at every layer checked (schema, query, API, patient-portal, UI). No cross-patient leak exists or was reproducible.** The one open design question this audit surfaced — whether *every* staff role, not just an assigned provider, can read/send in any patient's thread — is a deliberate, already-documented, already-tested design decision that matches this app's existing authorization model elsewhere. It is not a leak between patients, which is what was asked about, so this audit does not spec a change to it (see §4). The only concrete recommendation is two additional regression tests to make the existing guarantees harder to regress silently (§5).

## 2. Patient-to-patient isolation — verified, with citations

**Schema.** `messages.patientId` is `text('patient_id').notNull().references(() => patients.id)` (`src/db/schema.ts:735`) — every row is mandatorily scoped to exactly one patient; there is no nullable or "unscoped" message state to fall through.

**Query layer** (`src/lib/queries/messages.ts`). Every function that can return message content filters by `patientId`:
- `listMessagesForPatient(patientId)` — `.where(eq(messages.patientId, patientId))` (line 14). This is the only function that returns message bodies for a single thread, and it takes no other filter path.
- `markReadByProvider` / `markReadByPatient` — both `and(eq(messages.patientId, patientId), ...)` (lines 27, 35): a call for patient A cannot touch patient B's rows.
- `getUnreadCountForPatient(patientId)` — scoped the same way (line 52).
- `getUnreadCountForProvider()` (line 43) and `listMessageThreads()` (line 70) are intentionally **not** patient-scoped — they are cross-patient aggregates/inbox views by design (a nav badge count and the staff inbox list), never exposed to the patient portal, and never used to answer "give me patient X's thread" (verified: `listMessageThreads` is imported only by the staff-facing `(dashboard)/messages/page.tsx`).

Existing test `tests/lib/queries/messages.test.ts` already proves no bleed at this layer with two real seeded patients (`PATIENT_A = 'RD-0001'`, `PATIENT_B = 'RD-0002'`): `listMessagesForPatient` returns only `PATIENT_A`'s rows even after seeding a `PATIENT_B` message (lines 36-47), and `markReadByProvider`/`markReadByPatient` are shown to leave `PATIENT_B`'s row untouched (lines 50-73).

**API route** (`src/app/api/messages/[patientId]/route.ts`). Both `GET` and `POST` take `patientId` from the URL's own `[patientId]` segment (`const { patientId } = await params`, lines 66, 85) and pass that same value into every query and into `sendMessage` — never a session-derived value that could disagree with the URL, and never a client body field (`sendMessageSchema` is `.strict()` with only `body` and `actingAs`, so a POST body cannot smuggle in a different `patientId` or `senderRole`, also covered by the existing mass-assignment test at line 111).

For the **patient side**, `resolveActor` (lines 42-59) requires `patientSession.patientId === patientId` (line 45) before treating the caller as that patient; a mismatch returns `403 Forbidden`, not a silent empty result or a 401 that could be confused with "not logged in" (lines 51-56). This is exercised by four existing tests: 403 on GET with a mismatched patient session (line 49), 403 on POST (line 99), and the `actingAs` hint being honored only when it still resolves to a real matching session (lines 138-176) — a forged `actingAs: 'patient'` for a non-matching session correctly falls through rather than being honored (line 165).

For the **staff side**, any authenticated staff session (`getSession()`, any role) can act on any `patientId` in the URL — this is the one point requiring judgment; see §4.

**Patient portal.** `src/app/patient-portal/(authenticated)/messages/page.tsx` has no `[patientId]` route segment or query param at all — `session.patientId` (from `requirePatientSessionOrRedirect()`, line 13, itself derived from a signed, `httpOnly` JWT cookie parsed in `src/lib/patient-session.ts`) is the *only* value ever passed to `listMessagesForPatient` (line 19) or rendered into `MessageComposer` (`identity.id`, line 31, itself resolved from the same session patientId via `getPatientPortalIdentity`). There is structurally no input a patient's browser controls that could select another patient's thread on this page — it isn't just runtime-checked, there is no parameter to tamper with. Even `MessageComposer`'s client-side `fetch('/api/messages/${patientId}')` (`src/components/MessageComposer.tsx:26`) uses this same server-supplied, non-editable prop, and even if a malicious client altered the URL by hand, the API route's `resolveActor` check above still blocks it server-side.

**UI.** The staff view (`(dashboard)/messages/page.tsx`) is a single-thread-at-a-time inbox: selecting a conversation shows exactly one patient's header (name + `Patient ID`, lines 87-91) above that one thread; there is no merged or ambiguous multi-patient view. The patient-portal view shows only "Messages with your care team" (line 26) with no patient-switching affordance. Neither surface could visually conflate two patients' threads.

## 3. Session-model separation (defense in depth)

Staff sessions (`lib/auth.ts`) and patient sessions (`lib/patient-session.ts`) are two entirely separate signed-JWT mechanisms with different cookie names and a `kind: 'staff'` / `kind: 'patient'` claim baked into the token itself, so a token minted for one kind can never be reinterpreted as the other even though both use the same `SESSION_SECRET` (`patient-session.ts:6-12`). This means the identity a patient session carries (`patientId`) is not just "whatever the client says" — it's cryptographically bound at login time and cannot be forged or edited client-side. The route's own comment (`route.ts:24-41`) documents a real bug that *was* found and fixed this session (a browser holding both a staff and patient cookie used to always prefer staff, so a patient's own composer could silently send as staff) — that fix (`actingAs`) is in place and tested (§2).

## 4. Staff role breadth — deliberate, documented, not a patient-isolation gap

Any staff role (`crc`, `pi`, `admin`, `frontdesk` — the full `Role` enum, `lib/auth.ts:6`) can read and send in **any** patient's thread; there is no provider-assignment scoping analogous to the `pi`-only "My Patients" filter in `(dashboard)/doctor/page.tsx` (which matches on `currentProvider` free text, since there's no real doctor-assignment table — see that file's own comments). This is not an oversight:
- It's explicitly called out in two places: `schema.ts:730-732` ("Any staff role ... may send as the provider side ... same reasoning as `broadcasts.sentBy`") and `(dashboard)/messages/page.tsx:13-16` ("No role restriction here, unlike `(dashboard)/doctor` which is `pi`-only").
- It's explicitly tested as intended behavior, not merely untested: `tests/api/messages.test.ts:62-66` and `:117-125` assert a `crc`/`admin` session can read/send in a patient's thread.
- It matches this app's general authorization model, not just messaging: `(dashboard)/patients/page.tsx` (the full patient chart list) has **no** role restriction either. Across all `(dashboard)/*` pages, only three narrow it (`doctor` — `pi`-only personalized view, `audit-log`, `telemedicine/[sessionId]` — session-specific). Broad staff access to shared clinical data, with a couple of specific narrower views layered on top, is this app's norm, not an exception messaging introduced.

The user's stated concern was patient-to-patient separation ("classified" info bleeding between patients), which is fully addressed (§2). Whether any-staff-can-message-any-patient is *also* too broad is a separate, legitimate product question, but changing it would be a scope-expanding feature decision (it would need the same free-text `currentProvider` matching hack `doctor/page.tsx` already flags as a known limitation, and it would take away the CRC-coordinates-on-the-doctor's-behalf workflow the code explicitly designed for). Absent a specific product ask to narrow it, this audit does not spec that change.

## 5. Test coverage — what exists, two gaps to close

Existing coverage is already substantial and already includes real two-patient isolation tests:
- Query layer: `tests/lib/queries/messages.test.ts` — two real patients, asserts no bleed (§2).
- API layer, patient side: `tests/api/messages.test.ts` — 403 on cross-patient GET/POST via a mismatched patient session, and the `actingAs` forgery case.
- API layer, staff side: role-breadth is tested, but no existing test seeds two patients' messages and asserts a staff `GET` for patient A's thread excludes patient B's content (today's staff-side tests only check status codes, not response content, against a single patient).
- Patient-portal page: no page-level test exists at all for `patient-portal/(authenticated)/messages/page.tsx` (there is a sibling convention for this, `tests/pages/patient-portal-overview.test.tsx`, but no equivalent for messages).

Recommend adding, matching existing file/naming conventions exactly:

1. **`tests/api/messages.test.ts`** — add a test under `describe('GET /api/messages/[patientId]')`: seed one message each for `STAFF_PATIENT_ID` and `OTHER_PATIENT_ID` directly via `sendMessage`, have a staff session `GET` `STAFF_PATIENT_ID`'s thread, and assert the JSON body contains the `STAFF_PATIENT_ID` message and does **not** contain the `OTHER_PATIENT_ID` message's id or body text. This closes the one layer (API response content, not just query-function output) that isn't yet directly asserted.
2. **`tests/pages/patient-portal-messages.test.tsx`** (new file, same shape as `tests/pages/patient-portal-overview.test.tsx`): mock `requirePatientSessionOrRedirect` to return one patient's session, mock `listMessagesForPatient` to return a fixture thread, render `PatientPortalMessagesPage`, and assert only that patient's message bodies appear — plus a second case mocking a *different* session patientId to confirm the page has no way to request another patient's thread (there is no prop/param it could take), documenting in test form what §2 verified by reading.

No other changes are recommended.

## 6. Self-review

- No placeholders remain (no "TBD", no invented API/table names — `messages`, `listMessagesForPatient`, `resolveActor`, etc. are all real, read from source with line citations above).
- Internally consistent: §2's verdict ("already isolated") is not contradicted by §4 (a separate, intentionally-out-of-scope question) or §5 (test-coverage hardening, not a fix for a leak).
- Scope check: no changes proposed to Broadcasts, Tebra/IntakeQ, or patient demographics; no UI redesign proposed. Only two new tests are recommended, matching the "keep it short if already secure" instruction.
- Ambiguity check: §4 explicitly states this audit does *not* recommend narrowing staff role access, and why, so a future reader can't mistake it for an open TODO.
