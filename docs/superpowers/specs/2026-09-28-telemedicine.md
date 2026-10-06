# Telemedicine — Design Spec

**Status:** Draft for review — design spec, not yet implemented.
**Position in the larger initiative:** next item in the "complete the HIMS platform" backlog — video visit support, distinct from every prior module in this backlog because it's the first one where the "real" version of the feature (production-grade video: TURN relay for reliable NAT traversal, recording, transcription, dial-in fallback) needs a real vendor (Twilio Video, Daily.co, Zoom SDK), the same "needs a real business/regulatory step" boundary already established in this codebase for e-prescribing and real insurance clearinghouse connectivity.

## 1. What this is, and the boundary it works within

Unlike e-prescribing (which this codebase correctly declines to simulate at all, since a fake prescription is actively dangerous), a **basic 1:1 video call is genuinely buildable without a vendor** using the browser's native WebRTC APIs (`getUserMedia`, `RTCPeerConnection`) — this spec builds that: a real, working provider-to-patient video call, with a real signaling exchange (this app has no existing realtime/websocket infrastructure, so signaling uses short-polling against the database, not a new realtime service).

**What's genuinely real here:** the call itself — camera/mic capture, peer connection, audio/video actually flows between two real browser tabs. **What's honestly out of scope, and why:** a STUN-only WebRTC connection (this spec's approach) fails to connect for some fraction of real-world network topologies (symmetric NATs, some corporate firewalls) without a TURN relay server, which needs either a paid relay service or self-hosted `coturn` infrastructure — a real infra decision this spec doesn't make unilaterally. Recording, transcription, and dial-in-by-phone all need a real vendor. Screen-sharing, virtual waiting rooms with multiple simultaneous patients, and multi-party (group) calls are real, valuable extensions but their own scope — this spec is a working 1:1 call, not a video platform.

This spec adds:
1. A **`telemedicineSessions`** table — one row per scheduled video visit: linked appointment, status (scheduled/waiting/in_progress/completed/failed), join tokens for provider and patient, timestamps.
2. **Signaling API routes** — short-polling exchange of WebRTC offer/answer/ICE-candidate payloads, scoped to one session, authenticated separately for the provider (staff session) and patient (a single-use join token, not a full patient-portal login — see §3) sides.
3. A **provider-side call screen** (`/telemedicine/[sessionId]`, staff-authenticated) and a **patient-side join page** (`/telemedicine/join/[token]`, token-authenticated, no login required — a patient joining a video visit from a text/email link shouldn't need portal credentials).
4. A **"Start telemedicine visit"** action from an appointment, generating the session and the patient's join link.

**Explicitly out of scope:** TURN relay / guaranteed connectivity (see above — flagged as a real infra decision for the user, not a code gap). Recording/transcription (vendor). Waiting-room screen-sharing preview, virtual backgrounds, or any polish beyond a functional call. Multi-party calls. SMS/email delivery of the join link (this app already has a `broadcasts` mechanism for messaging patients — reuse it rather than building new delivery infrastructure, but the actual send action is left to staff copying the link, matching how this codebase already treats messaging as staff-initiated rather than auto-triggered).

## 2. Data model changes (additive only)

```ts
export const telemedicineSessionStatusEnum = pgEnum('telemedicine_session_status', [
  'scheduled', 'waiting', 'in_progress', 'completed', 'failed',
])

export const telemedicineSessions = pgTable('telemedicine_sessions', {
  id: serial('id').primaryKey(),
  appointmentId: integer('appointment_id').notNull().references(() => appointments.id).unique(),
  patientJoinToken: text('patient_join_token').notNull().unique(), // single-use-ish (see §3), long random token -- this IS the patient's authentication for this session, so it must be unguessable, not a short code
  status: telemedicineSessionStatusEnum('status').default('scheduled').notNull(),
  providerJoinedAt: timestamp('provider_joined_at'),
  patientJoinedAt: timestamp('patient_joined_at'),
  endedAt: timestamp('ended_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

// Signaling messages -- a short-lived exchange, not a chat log. One row per
// offer/answer/ICE-candidate message, polled and consumed by the other side.
export const telemedicineSignalTypeEnum = pgEnum('telemedicine_signal_type', ['offer', 'answer', 'ice_candidate'])
export const telemedicineSignalSenderEnum = pgEnum('telemedicine_signal_sender', ['provider', 'patient'])

export const telemedicineSignals = pgTable('telemedicine_signals', {
  id: serial('id').primaryKey(),
  sessionId: integer('session_id').notNull().references(() => telemedicineSessions.id),
  sender: telemedicineSignalSenderEnum('sender').notNull(),
  signalType: telemedicineSignalTypeEnum('signal_type').notNull(),
  payload: jsonb('payload').notNull(), // the actual SDP offer/answer string or ICE candidate object -- opaque to this app, just relayed
  createdAt: timestamp('created_at').defaultNow().notNull(),
})
```

**Why signaling is a real DB table polled over HTTP, not a new websocket/realtime service:** this app has zero existing realtime infrastructure (every "live" screen in this codebase — the bed board, the front-desk queue — already works via polling, not push), and WebRTC signaling only needs to exchange a handful of small messages once at call setup (offer, answer, a few ICE candidates) — polling at a short interval (1-2s) during the brief "connecting" phase is a legitimate, proportionate choice for that volume, not a corner cut. Once the peer connection is established, actual audio/video flows peer-to-peer, not through this app's server at all.

**Why the patient authenticates via a join token, not the patient portal:** a patient joining a scheduled video visit from a link in a text message is the realistic flow (matching how real telemedicine platforms work), and requiring a full patient-portal account+login first would be a real adoption barrier this spec shouldn't introduce. The token is long/random/unguessable (this IS the patient's credential for this one session) and scoped to exactly one `telemedicineSessions` row — it cannot be used to access anything else in the app, unlike a real patient-portal session.

## 3. Session and signaling lifecycle

`POST /api/appointments/[id]/telemedicine` — staff-initiated (admin/pi), creates a `telemedicineSessions` row with a fresh random token, status `scheduled`.

Provider side: `POST /api/telemedicine/[sessionId]/signal` (staff session, must be the session's own provider — matching this codebase's existing provider-ownership-check pattern from discharge/transfer routes) and `GET /api/telemedicine/[sessionId]/signal?since=<id>&for=patient` (polls for the patient's signals). Sets `providerJoinedAt` and transitions `scheduled → waiting` on first poll.

Patient side: `POST /api/telemedicine/join/[token]/signal` and `GET .../signal?since=<id>` (token-authenticated, no session cookie — the token in the URL path is the credential, matching this app's existing `formSubmissions.accessToken` token-in-URL pattern for unauthenticated patient-facing links). Sets `patientJoinedAt`, transitions `waiting → in_progress` once both sides have joined.

`POST /api/telemedicine/[sessionId]/end` (either side) sets `status: 'completed'`, `endedAt`. A session with `providerJoinedAt` set but no `patientJoinedAt` within a reasonable window is a `failed` connection, not silently left `waiting` forever — but this spec does not build automated timeout/cleanup (a cron-like background job is its own scope decision); staff can manually mark a stuck session `failed`.

## 4. UI

Provider call screen: local video preview, remote video once connected, mute/camera-off/end-call controls, a visible "Waiting for patient to join" state before the patient connects. Patient join page: a single "Join Video Visit" button (requests camera/mic permission on click, not on page load, matching browser permission-prompt best practice), same call UI once connected, no other app chrome (no nav, no unrelated links — this is a stripped-down, single-purpose page for a person who isn't a portal user).

## 5. Testing

`tests/lib/queries/telemedicine-sessions.test.ts` (session creation, status transitions, token uniqueness), `tests/api/telemedicine-signal.test.ts` (provider-side auth requires the session's own provider — a different provider's session is rejected; patient-side auth requires the correct token — a wrong/guessed token is rejected 404 not 403, to avoid confirming a token's existence; signals are correctly scoped per session — two sessions' signals never cross, matching this session's established review-focus pattern), `tests/api/telemedicine-join-token.test.ts` (an already-completed session's join link no longer connects a new call).

Real end-to-end video call quality (whether audio/video frames actually decode correctly) is not something an automated test suite can verify — the implementation task's real-dev-server verification step must open two actual browser tabs (or two real HTTP clients simulating the signaling exchange, with a documented note that visual/audio confirmation needs a human) and confirm the signaling handshake completes and both sides report a connected `RTCPeerConnection` state, which is the honest limit of automated verification for this feature.

## 6. Role gating summary

| Action | Allowed roles |
|---|---|
| Start a telemedicine session for an appointment | admin, pi (matches clinical-action precedent) |
| Provider joins a call | admin, pi, and specifically the session's own provider (not any pi) |
| Patient joins a call | Token-holder only, no role (not a staff session at all) |
| View telemedicine session history/status | admin, pi, crc, frontdesk (matches existing chart read-access precedent) |
