# Telemedicine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Clinsync a real 1:1 provider-to-patient video visit: a `telemedicineSessions`/`telemedicineSignals` data model, polling-based WebRTC signaling routes authenticated separately for staff (session cookie) and patient (single-purpose join token in the URL), and a working provider call screen + chrome-free patient join page built on the browser's native `getUserMedia`/`RTCPeerConnection` APIs.

**Architecture:** `telemedicineSessions` is the lifecycle row (status machine, one per appointment, unique). `telemedicineSignals` is an append-only relay log — one row per offer/answer/ICE-candidate message, polled and consumed by the other side, never edited — the same "event log, not a chat log" posture this codebase already applies to append-only tables like `medicationDispenses`. Signaling is short HTTP polling against these tables, not a new realtime service, because this app has zero existing push infrastructure and the message volume (a handful of messages once at call setup) doesn't justify one. The patient authenticates with an unguessable, single-session-scoped bearer token in the URL path, the same shape as this codebase's existing `formSubmissions.accessToken` pattern, not a patient-portal login. Once signaling completes, audio/video flows peer-to-peer and never touches this app's server.

**Tech Stack:** Next.js 16 App Router (Server + Client Components) + Drizzle ORM over a `pg` Pool (additive-only schema changes via a hand-written one-off script, never `drizzle-kit push`) + native browser WebRTC (`getUserMedia`, `RTCPeerConnection`, STUN-only — no TURN relay) + Tailwind v4 oklch tokens.

**Spec:** `docs/superpowers/specs/2026-09-28-telemedicine.md`

**Working directory note:** this plan is executed in an isolated git worktree at `/Users/k2a/Desktop/clinsync/.worktrees/telemedicine` on branch `feature/telemedicine`, forked from `hims-platform`. This worktree has its own `.env.local` and `node_modules` already set up. Every implementer/reviewer dispatch for this plan must work from this exact directory, not the main checkout — the main checkout and every other active worktree (`.worktrees/lab-orders-results`, `.worktrees/pharmacy-med-inventory`, `.worktrees/queue-display`, etc.) have their own concurrent work in flight; do not touch them.

## Global Constraints

- Additive-only schema changes. Apply via a hand-written one-off script run with `npx dotenv -e .env.local -- npx tsx <script>` — never `drizzle-kit push`. This is a **single shared Neon Postgres database across every branch/worktree** — a schema mistake here is visible everywhere immediately, including the main checkout and every other active worktree.
- **Lesson learned this session:** a NOT NULL column added without a database-level `DEFAULT` to an *existing* shared table broke every other worktree's tests, because rows already in that table had no value to satisfy the new constraint. Task 1 below only creates two brand-new tables — it does not add any column to `appointments` or any other existing table, so that specific failure mode does not apply here. If any later step in this plan is found to need a column added to an existing table, flag it prominently before writing it, and give any new NOT NULL column a `DEFAULT` at the SQL level so existing rows remain valid.
- `psql` is not installed in this environment — verify a migration's live-DB effect with a Node script using `pg`'s `Pool` and an `information_schema.columns` query.
- Every write route uses `.strict()` Zod validation.
- Every state-changing route calls `logAudit(session, <action>, <patientId>)`. Token-authenticated patient routes have no `Session` to pass — see Task 3, which does not call `logAudit` for that reason (no precedent route that's token-authenticated calls it either — `src/app/api/intake/[token]/route.ts` uses a separate `logPatientPortalAction` helper instead, and telemedicine has no equivalent helper; Task 3 does not invent one, since the spec doesn't ask for patient-side audit logging and status transitions are already durably recorded in `telemedicineSessions` itself).
- Every protected route/page starts with `requireSession()` (API routes) or `requireSessionOrRedirect()` (pages) as its first statement — except the token-authenticated patient routes/page in Task 3/4, which are deliberately unauthenticated by session cookie (possession of the token is the credential), matching `src/app/api/intake/[token]/route.ts`'s exact precedent and its exact comment convention.
- Role gating per spec §6: start a session (write) = admin, pi. Provider joins/signals/ends a call (write) = admin, pi, and specifically the session's own provider (not any pi — admin is exempt from the ownership check, matching this codebase's existing discharge/transfer ownership-check precedent). Patient joins a call = token-holder only, no staff role. View telemedicine session history/status = admin, pi, crc, frontdesk (not built as a dedicated screen by this plan — no spec section describes one beyond the two call screens — but the query layer's read functions are role-agnostic and available for a future read view).
- Provider-ownership check: mirror `src/app/api/inpatient/admissions/[id]/discharge/route.ts` exactly — role-gate `['admin', 'pi']` first; then, only when `session.role === 'pi'`, resolve the calling provider by matching `session.name`'s last word against `listActiveProviders()` names (case-insensitive `includes`), and reject with 403 if no match or the matched provider's id isn't the session's own provider. `admin` never needs this match.
- Token-in-URL check: mirror `src/app/api/intake/[token]/route.ts` exactly — no `requireSession()` call at all; an invalid, expired, or no-longer-usable token returns **404** ("This link is no longer valid."), never 403, so a wrong/guessed token can't be distinguished from a used-up one.
- Status transitions are conditional UPDATEs guarded by current status in the `WHERE` clause — never a read-then-write — matching this codebase's established conditional-transition-guard pattern (MAR's `administerMedication`, ADT admission/discharge, the sibling Lab Orders and Pharmacy plans' transition functions).
- WebRTC is STUN-only (`stun:stun.l.google.com:19302` or equivalent public STUN server — no TURN relay is configured or purchased by this plan). This is a named, deliberate limitation, not a corner cut: per the spec, STUN-only WebRTC fails to connect across some real-world network topologies (symmetric NATs, some corporate firewalls), and adding TURN is a real infrastructure/vendor decision outside this plan's scope.
- Commit messages end with no attribution trailer.
- UI verification discipline: verify via a real running dev server hit with real HTTP requests (mint a session cookie the way `src/lib/auth.ts` actually does it — `SignJWT` under cookie `clinsync_demo_session`, secret from `SESSION_SECRET`), with actual commands and actual output pasted in the report. Never a narrated, unreproduced claim. **Exception, stated explicitly rather than worked around:** whether two real browser tabs' `RTCPeerConnection`s actually decode audio/video frames is not something an agentic implementer can self-certify from a terminal — no browser-automation tooling (Playwright/Puppeteer) is installed in this repo. Task 4's verification step proves the signaling handshake completes end-to-end over real HTTP against the real running dev server; it explicitly does not claim to have watched a picture move, and the plan says so instead of pretending otherwise.
- Vitest invocation: `npx dotenv -e .env.local -- npx vitest run <path>` (`fileParallelism: false`).

## Review Focus

1. **A `pi` session calling the provider-side signal/end routes for a session that belongs to a *different* provider's appointment** — must be rejected 403, exactly like the discharge route rejects a `pi` who isn't the admitting attending; an `admin` session must succeed on the same session regardless of name match. (Task 2)
2. **A wrong or guessed patient join token** — must return 404, never 403 or any response shape that reveals whether *some* session exists at that token, matching the spec's explicit reasoning (§5) and the `formSubmissions`/intake-portal precedent. (Task 3)
3. **An already-completed session's join token used again** — must not connect a "new" call; the token must keep returning 404 once the session is `completed` or `failed`, not silently resurrect `providerJoinedAt`/`patientJoinedAt`/status. (Task 3)
4. **Two sessions' signals crossing** — `GET` polling for one session must never return another session's offer/answer/ICE rows, even when both sessions are active at once and interleaved by id. (Task 2)
5. **Double-clicking "Start telemedicine visit" for the same appointment** — the create route must reject a second session for an appointment that already has one with a clean 409, not a raw Postgres unique-constraint crash (the schema's `appointmentId` unique constraint is real per §2, but the API has to surface that cleanly). (Task 2)

---

### Task 1: Schema — `telemedicine_sessions`, `telemedicine_signals`

**Files:**
- Modify: `src/db/schema.ts`
- Test: `tests/db/telemedicine-schema.test.ts`

**Interfaces:**
- Produces: `telemedicineSessionStatusEnum`, `telemedicineSignalTypeEnum`, `telemedicineSignalSenderEnum`, `telemedicineSessions` table (`id, appointmentId, patientJoinToken, status, providerJoinedAt, patientJoinedAt, endedAt, createdAt`), `telemedicineSignals` table (`id, sessionId, sender, signalType, payload, createdAt`). Consumed by Tasks 2-4.

- [ ] **Step 1: Write the failing test**

Create `tests/db/telemedicine-schema.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, providers, appointments, telemedicineSessions, telemedicineSignals } from '@/db/schema'

const createdSessionIds: number[] = []
const createdAppointmentIds: number[] = []
afterEach(async () => {
  while (createdSessionIds.length > 0) {
    const id = createdSessionIds.pop()!
    await getDb().delete(telemedicineSignals).where(eq(telemedicineSignals.sessionId, id))
    await getDb().delete(telemedicineSessions).where(eq(telemedicineSessions.id, id))
  }
  while (createdAppointmentIds.length > 0) await getDb().delete(appointments).where(eq(appointments.id, createdAppointmentIds.pop()!))
})

async function makeAppointment() {
  const db = getDb()
  const [patientRow] = await db.select().from(patients).limit(1)
  const [providerRow] = await db.select().from(providers).limit(1)
  const [appt] = await db.insert(appointments).values({
    patientId: patientRow.id, providerId: providerRow.id,
    startsAt: new Date(), endsAt: new Date(Date.now() + 30 * 60000), visitReason: 'Telemedicine test',
  }).returning()
  createdAppointmentIds.push(appt.id)
  return appt
}

describe('telemedicine schema', () => {
  it('creates a session with defaults and attaches a signal', async () => {
    const appt = await makeAppointment()
    const [session] = await getDb().insert(telemedicineSessions).values({ appointmentId: appt.id, patientJoinToken: `tok-${Date.now()}` }).returning()
    createdSessionIds.push(session.id)
    expect(session.status).toBe('scheduled')
    expect(session.providerJoinedAt).toBeNull()

    const [signal] = await getDb().insert(telemedicineSignals).values({
      sessionId: session.id, sender: 'provider', signalType: 'offer', payload: { sdp: 'v=0...' },
    }).returning()
    expect(signal.signalType).toBe('offer')
  })

  it('enforces one session per appointment via the unique constraint', async () => {
    const appt = await makeAppointment()
    await getDb().insert(telemedicineSessions).values({ appointmentId: appt.id, patientJoinToken: `tok-a-${Date.now()}` }).then(async () => {
      const [row] = await getDb().select().from(telemedicineSessions).where(eq(telemedicineSessions.appointmentId, appt.id))
      createdSessionIds.push(row.id)
    })
    await expect(getDb().insert(telemedicineSessions).values({ appointmentId: appt.id, patientJoinToken: `tok-b-${Date.now()}` })).rejects.toThrow()
  })

  it('enforces token uniqueness across sessions', async () => {
    const apptA = await makeAppointment()
    const apptB = await makeAppointment()
    const sharedToken = `tok-shared-${Date.now()}`
    const [sessionA] = await getDb().insert(telemedicineSessions).values({ appointmentId: apptA.id, patientJoinToken: sharedToken }).returning()
    createdSessionIds.push(sessionA.id)
    await expect(getDb().insert(telemedicineSessions).values({ appointmentId: apptB.id, patientJoinToken: sharedToken })).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/telemedicine-schema.test.ts`
Expected: FAIL — tables don't exist / not exported.

- [ ] **Step 3: Add the schema definitions**

In `src/db/schema.ts`, add near the `appointments` table definition, using exactly the shape from spec §2:

```ts
export const telemedicineSessionStatusEnum = pgEnum('telemedicine_session_status', [
  'scheduled', 'waiting', 'in_progress', 'completed', 'failed',
])

export const telemedicineSessions = pgTable('telemedicine_sessions', {
  id: serial('id').primaryKey(),
  appointmentId: integer('appointment_id').notNull().references(() => appointments.id).unique(),
  patientJoinToken: text('patient_join_token').notNull().unique(),
  status: telemedicineSessionStatusEnum('status').default('scheduled').notNull(),
  providerJoinedAt: timestamp('provider_joined_at'),
  patientJoinedAt: timestamp('patient_joined_at'),
  endedAt: timestamp('ended_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export const telemedicineSignalTypeEnum = pgEnum('telemedicine_signal_type', ['offer', 'answer', 'ice_candidate'])
export const telemedicineSignalSenderEnum = pgEnum('telemedicine_signal_sender', ['provider', 'patient'])

export const telemedicineSignals = pgTable('telemedicine_signals', {
  id: serial('id').primaryKey(),
  sessionId: integer('session_id').notNull().references(() => telemedicineSessions.id),
  sender: telemedicineSignalSenderEnum('sender').notNull(),
  signalType: telemedicineSignalTypeEnum('signal_type').notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})
```

(`appointments` is already defined earlier in this file — add these definitions after it.)

- [ ] **Step 4: Run the test again — expect a different failure**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/telemedicine-schema.test.ts`
Expected: FAIL — now a runtime DB error (relation does not exist), not an import error.

- [ ] **Step 5: Write and run the one-off migration script**

Scratch, not part of the repo. Create `migrate-telemedicine-scratch.ts` at this worktree's root (`/Users/k2a/Desktop/clinsync/.worktrees/telemedicine`):

```ts
import { Pool } from 'pg'

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false } })

  await pool.query(`DO $$ BEGIN CREATE TYPE telemedicine_session_status AS ENUM ('scheduled', 'waiting', 'in_progress', 'completed', 'failed'); EXCEPTION WHEN duplicate_object THEN null; END $$;`)
  await pool.query(`DO $$ BEGIN CREATE TYPE telemedicine_signal_type AS ENUM ('offer', 'answer', 'ice_candidate'); EXCEPTION WHEN duplicate_object THEN null; END $$;`)
  await pool.query(`DO $$ BEGIN CREATE TYPE telemedicine_signal_sender AS ENUM ('provider', 'patient'); EXCEPTION WHEN duplicate_object THEN null; END $$;`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS telemedicine_sessions (
      id SERIAL PRIMARY KEY,
      appointment_id INTEGER NOT NULL UNIQUE REFERENCES appointments(id),
      patient_join_token TEXT NOT NULL UNIQUE,
      status telemedicine_session_status NOT NULL DEFAULT 'scheduled',
      provider_joined_at TIMESTAMP,
      patient_joined_at TIMESTAMP,
      ended_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS telemedicine_signals (
      id SERIAL PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES telemedicine_sessions(id),
      sender telemedicine_signal_sender NOT NULL,
      signal_type telemedicine_signal_type NOT NULL,
      payload JSONB NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `)

  console.log('Telemedicine schema migration complete.')
  await pool.end()
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1) })
```

Run: `npx dotenv -e .env.local -- npx tsx migrate-telemedicine-scratch.ts`. If blocked by the permission classifier: stop, report it, do not retry with variations.

Verify with a Node script (no `psql` here): `SELECT column_name FROM information_schema.columns WHERE table_name IN ('telemedicine_sessions','telemedicine_signals')`.

Delete the scratch script once confirmed: `rm migrate-telemedicine-scratch.ts`.

- [ ] **Step 6: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/telemedicine-schema.test.ts`
Expected: PASS (all three tests).

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts tests/db/telemedicine-schema.test.ts
git commit -m "$(cat <<'EOF'
feat: add telemedicine sessions and signals tables

EOF
)"
```

---

### Task 2: Query layer + provider-side signaling routes

**Files:**
- Create: `src/lib/queries/telemedicine-sessions.ts`
- Create: `src/lib/queries/telemedicine-signals.ts`
- Create: `src/app/api/appointments/[id]/telemedicine/route.ts` (POST — create session)
- Create: `src/app/api/telemedicine/[sessionId]/signal/route.ts` (POST, GET)
- Create: `src/app/api/telemedicine/[sessionId]/end/route.ts` (POST)
- Test: `tests/lib/queries/telemedicine-sessions.test.ts`, `tests/api/telemedicine-signal.test.ts`

**Interfaces:**
- Consumes: `telemedicineSessions`, `telemedicineSignals` from `@/db/schema` (Task 1); `appointments` from `@/db/schema` and `getAppointment(id)` from `@/lib/queries/appointments` (existing); `listActiveProviders()` from `@/lib/queries/providers` (existing); `requireSession`, `Session` from `@/lib/auth`; `logAudit` from `@/lib/audit`.
- Produces:
  - `TelemedicineSessionRow` type: `{ id: number, appointmentId: number, appointmentProviderId: number, appointmentPatientId: string, patientJoinToken: string, status: 'scheduled'|'waiting'|'in_progress'|'completed'|'failed', providerJoinedAt: Date|null, patientJoinedAt: Date|null, endedAt: Date|null, createdAt: Date }`.
  - `createTelemedicineSession(appointmentId: number): Promise<{ ok: boolean; error?: string; session?: TelemedicineSessionRow }>`, `getSessionById(id: number): Promise<TelemedicineSessionRow | null>`, `getSessionByToken(token: string): Promise<TelemedicineSessionRow | null>`, `markProviderJoined(sessionId: number): Promise<void>`, `markPatientJoined(sessionId: number): Promise<void>`, `endSession(sessionId: number): Promise<{ ok: boolean; error?: string }>` — all from `@/lib/queries/telemedicine-sessions`. Consumed by Tasks 3, 4.
  - `TelemedicineSignalRow` type: `{ id: number, sessionId: number, sender: 'provider'|'patient', signalType: 'offer'|'answer'|'ice_candidate', payload: unknown, createdAt: Date }`.
  - `createSignal(sessionId: number, sender: 'provider'|'patient', signalType: 'offer'|'answer'|'ice_candidate', payload: unknown): Promise<{ id: number }>`, `listSignalsSince(sessionId: number, sinceId: number, sender: 'provider'|'patient'): Promise<TelemedicineSignalRow[]>` (returns rows *from* `sender`, ordered by id ascending — a caller polling for the other side's messages passes the other side's sender value) — both from `@/lib/queries/telemedicine-signals`. Consumed by Task 3.

- [ ] **Step 1: Read the provider-ownership precedent**

Read `src/app/api/inpatient/admissions/[id]/discharge/route.ts` in full (already summarized in Global Constraints above) to confirm the exact ownership-check shape before writing it into the signal/end routes below: role-gate `['admin', 'pi']` first, then for `pi` only, match `session.name`'s last word against `listActiveProviders()` and compare to the session's own provider id.

- [ ] **Step 2: Write the failing tests — query layer**

Create `tests/lib/queries/telemedicine-sessions.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, providers, appointments, telemedicineSessions, telemedicineSignals } from '@/db/schema'
import { createTelemedicineSession, getSessionById, getSessionByToken, markProviderJoined, markPatientJoined, endSession } from '@/lib/queries/telemedicine-sessions'

const createdAppointmentIds: number[] = []
afterEach(async () => {
  while (createdAppointmentIds.length > 0) {
    const id = createdAppointmentIds.pop()!
    const [session] = await getDb().select().from(telemedicineSessions).where(eq(telemedicineSessions.appointmentId, id))
    if (session) {
      await getDb().delete(telemedicineSignals).where(eq(telemedicineSignals.sessionId, session.id))
      await getDb().delete(telemedicineSessions).where(eq(telemedicineSessions.id, session.id))
    }
    await getDb().delete(appointments).where(eq(appointments.id, id))
  }
})

async function makeAppointment() {
  const db = getDb()
  const [patientRow] = await db.select().from(patients).limit(1)
  const [providerRow] = await db.select().from(providers).limit(1)
  const [appt] = await db.insert(appointments).values({
    patientId: patientRow.id, providerId: providerRow.id,
    startsAt: new Date(), endsAt: new Date(Date.now() + 30 * 60000), visitReason: 'Telemedicine test',
  }).returning()
  createdAppointmentIds.push(appt.id)
  return { appt, providerId: providerRow.id, patientId: patientRow.id }
}

describe('telemedicine session lifecycle', () => {
  it('creates a session with a unique token and scheduled status', async () => {
    const { appt, providerId, patientId } = await makeAppointment()
    const result = await createTelemedicineSession(appt.id)
    expect(result.ok).toBe(true)
    expect(result.session!.status).toBe('scheduled')
    expect(result.session!.appointmentProviderId).toBe(providerId)
    expect(result.session!.appointmentPatientId).toBe(patientId)
    expect(result.session!.patientJoinToken.length).toBeGreaterThan(20)
  })

  it('rejects creating a second session for the same appointment (token uniqueness / Review Focus #5)', async () => {
    const { appt } = await makeAppointment()
    const first = await createTelemedicineSession(appt.id)
    expect(first.ok).toBe(true)
    const second = await createTelemedicineSession(appt.id)
    expect(second.ok).toBe(false)
  })

  it('transitions scheduled -> waiting -> in_progress as each side joins, then completed on end', async () => {
    const { appt } = await makeAppointment()
    const { session } = await createTelemedicineSession(appt.id)

    await markProviderJoined(session!.id)
    let current = await getSessionById(session!.id)
    expect(current!.status).toBe('waiting')
    expect(current!.providerJoinedAt).not.toBeNull()

    await markPatientJoined(session!.id)
    current = await getSessionById(session!.id)
    expect(current!.status).toBe('in_progress')
    expect(current!.patientJoinedAt).not.toBeNull()

    const ended = await endSession(session!.id)
    expect(ended.ok).toBe(true)
    current = await getSessionById(session!.id)
    expect(current!.status).toBe('completed')
    expect(current!.endedAt).not.toBeNull()
  })

  it('rejects ending an already-completed session', async () => {
    const { appt } = await makeAppointment()
    const { session } = await createTelemedicineSession(appt.id)
    await endSession(session!.id)
    const second = await endSession(session!.id)
    expect(second.ok).toBe(false)
  })

  it('a join call on an already-ended session does not resurrect it (Review Focus #3)', async () => {
    const { appt } = await makeAppointment()
    const { session } = await createTelemedicineSession(appt.id)
    await endSession(session!.id)
    await markPatientJoined(session!.id)
    const current = await getSessionById(session!.id)
    expect(current!.status).toBe('completed')
    expect(current!.patientJoinedAt).toBeNull()
  })

  it('getSessionByToken finds the session created above', async () => {
    const { appt } = await makeAppointment()
    const { session } = await createTelemedicineSession(appt.id)
    const found = await getSessionByToken(session!.patientJoinToken)
    expect(found!.id).toBe(session!.id)
  })
})
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/telemedicine-sessions.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 4: Implement `src/lib/queries/telemedicine-sessions.ts`**

`getSessionById`/`getSessionByToken` both select from `telemedicineSessions` inner-joined to `appointments` (to expose `appointmentProviderId`/`appointmentPatientId` for the ownership check and audit logging), returning `null` when no row matches.

`createTelemedicineSession(appointmentId)` generates the token with `randomBytes(32).toString('base64url')` (same call as `src/app/api/form-submissions/route.ts`'s `accessToken`), pre-checks for an existing session on that `appointmentId` via a `SELECT`, and returns `{ ok: false, error: 'A telemedicine session already exists for this appointment' }` if found — otherwise inserts and returns `{ ok: true, session }` (re-fetch via `getSessionById` after insert so the returned row has the same joined shape as every other function in this module).

`markProviderJoined`/`markPatientJoined` are each a single conditional UPDATE — idempotent (safe to call on every poll) and guarded so a `completed`/`failed` session is never touched:

```ts
import { sql } from 'drizzle-orm'
// ...
export async function markProviderJoined(sessionId: number): Promise<void> {
  await getDb().update(telemedicineSessions)
    .set({
      providerJoinedAt: sql`COALESCE(${telemedicineSessions.providerJoinedAt}, now())`,
      status: sql`CASE WHEN ${telemedicineSessions.status} = 'scheduled' THEN 'waiting'::telemedicine_session_status ELSE ${telemedicineSessions.status} END`,
    })
    .where(and(eq(telemedicineSessions.id, sessionId), notInArray(telemedicineSessions.status, ['completed', 'failed'])))
}
```

`markPatientJoined` is the same shape, setting `patientJoinedAt` via `COALESCE`, and its `status` CASE reads: `WHEN status = 'waiting' AND provider_joined_at IS NOT NULL THEN 'in_progress' ELSE status` (matching spec §3's exact wording — "transitions waiting → in_progress once both sides have joined"), under the same `notInArray(status, ['completed', 'failed'])` guard.

`endSession(sessionId)` is a single conditional UPDATE (`WHERE id = ? AND status != 'completed'`) setting `status: 'completed', endedAt: new Date()`; returns `{ ok: false, error: 'Session already ended' }` if the UPDATE affects 0 rows.

- [ ] **Step 5: Run the session-lifecycle tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/telemedicine-sessions.test.ts`
Expected: PASS.

- [ ] **Step 6: Implement `src/lib/queries/telemedicine-signals.ts`**

```ts
export async function createSignal(sessionId: number, sender: 'provider' | 'patient', signalType: 'offer' | 'answer' | 'ice_candidate', payload: unknown) {
  const [row] = await getDb().insert(telemedicineSignals).values({ sessionId, sender, signalType, payload }).returning({ id: telemedicineSignals.id })
  return row
}

export async function listSignalsSince(sessionId: number, sinceId: number, sender: 'provider' | 'patient') {
  return getDb().select().from(telemedicineSignals)
    .where(and(eq(telemedicineSignals.sessionId, sessionId), eq(telemedicineSignals.sender, sender), gt(telemedicineSignals.id, sinceId)))
    .orderBy(asc(telemedicineSignals.id))
}
```

- [ ] **Step 7: Write the failing test — route-level ownership and cross-session isolation**

Create `tests/api/telemedicine-signal.test.ts`. Follow the `vi.mock('@/lib/auth', ...)` pattern from `tests/api/pharmacy-dispense.test.ts`, mocking `requireSession` to return a session whose `role`/`name` the test controls. Cover, using real appointments/sessions inserted via the query layer:

- A `pi` session whose `name` matches the appointment's actual provider succeeds (200/201) calling `POST .../signal` and `GET .../signal?for=patient`.
- A `pi` session whose `name` does **not** match the appointment's provider gets 403 on both the POST and the GET (Review Focus #1).
- An `admin` session succeeds regardless of name match, on the same non-matching-provider session.
- `POST .../end` follows the identical ownership rule (matching `pi` succeeds, non-matching `pi` gets 403, `admin` always succeeds).
- Cross-session isolation (Review Focus #4): create two sessions (two appointments, real or mismatched providers), `POST` a `provider` `offer` signal to session A and a different `provider` `offer` signal to session B, then `GET session A's .../signal?for=provider` as if polling from session B's own accessor (or directly assert via `listSignalsSince`) and confirm session A's results never include session B's signal id, and vice versa.
- The `POST /api/appointments/[id]/telemedicine` route rejects a second call for the same appointment with 409 (Review Focus #5, route-level — the query-layer version is already covered in Step 2's test).

- [ ] **Step 8: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/telemedicine-signal.test.ts`
Expected: FAIL — routes don't exist.

- [ ] **Step 9: Implement the three routes**

`POST /api/appointments/[id]/telemedicine` — `requireSession()`, role gate `['admin', 'pi']`, parse `id`, call `getAppointment(id)` and 404 if missing, call `createTelemedicineSession(appointmentId)` and return 409 with `result.error` if `!result.ok`, else `logAudit(session, 'started telemedicine session', appointment.patientId)` and return 201 with `{ id: result.session!.id, patientJoinToken: result.session!.patientJoinToken }`.

`src/app/api/telemedicine/[sessionId]/signal/route.ts` — shared helper (module-scope function in this file is fine) resolving `{ session, telemedicineSession }` and enforcing the Step 1 ownership rule, returning a ready `NextResponse` on any failure (404 if the session id doesn't resolve via `getSessionById`, 403 on ownership mismatch) so both `POST` and `GET` can reuse it.

`POST`: body schema `z.object({ signalType: z.enum(['offer', 'answer', 'ice_candidate']), payload: z.unknown() }).strict()`, call `createSignal(sessionId, 'provider', signalType, payload)`, return 201 `{ id }`.

`GET`: read `since` (`Number(url.searchParams.get('since')) || 0`) and `for` (must equal `'patient'`, else 400 — this route only ever polls for the patient's signals per spec §3), call `markProviderJoined(sessionId)` (idempotent, called on every poll — spec §3: "transitions scheduled → waiting on first poll"), then `listSignalsSince(sessionId, since, 'patient')`, return 200 `{ signals, sessionStatus: telemedicineSession.status }` (re-fetch status after `markProviderJoined` so a first-ever poll reports `'waiting'`, not the stale `'scheduled'`).

`POST /api/telemedicine/[sessionId]/end` — same ownership resolution as the signal route, calls `endSession(sessionId)`, 409 with `result.error` if `!result.ok`, else `logAudit(session, 'ended telemedicine session', telemedicineSession.appointmentPatientId)` and return 200 `{ ok: true }`.

- [ ] **Step 10: Run all this task's tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/telemedicine-sessions.test.ts tests/api/telemedicine-signal.test.ts`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/lib/queries/telemedicine-sessions.ts src/lib/queries/telemedicine-signals.ts src/app/api/appointments/[id]/telemedicine src/app/api/telemedicine/[sessionId] tests/lib/queries/telemedicine-sessions.test.ts tests/api/telemedicine-signal.test.ts
git commit -m "$(cat <<'EOF'
feat: add telemedicine session creation and provider-side signaling routes

EOF
)"
```

---

### Task 3: Patient-side token routes

**Files:**
- Create: `src/app/api/telemedicine/join/[token]/signal/route.ts` (POST, GET)
- Test: `tests/api/telemedicine-join-signal.test.ts`, `tests/api/telemedicine-join-token.test.ts`

**Interfaces:**
- Consumes: `getSessionByToken`, `markPatientJoined` from `@/lib/queries/telemedicine-sessions` (Task 2); `createSignal`, `listSignalsSince` from `@/lib/queries/telemedicine-signals` (Task 2).

- [ ] **Step 1: Read the token-in-URL precedent**

Read `src/app/api/intake/[token]/route.ts` in full (already summarized in Global Constraints above) — no `requireSession()`, a not-found-or-no-longer-usable token returns 404 with a fixed message, and the comment explaining why this route is deliberately unauthenticated. Match this shape exactly, including the comment.

- [ ] **Step 2: Write the failing test — wrong/guessed token (Review Focus #2)**

Create `tests/api/telemedicine-join-token.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, providers, appointments, telemedicineSessions, telemedicineSignals } from '@/db/schema'
import { createTelemedicineSession, endSession } from '@/lib/queries/telemedicine-sessions'
import { POST as joinSignalPost, GET as joinSignalGet } from '@/app/api/telemedicine/join/[token]/signal/route'

const createdAppointmentIds: number[] = []
afterEach(async () => {
  while (createdAppointmentIds.length > 0) {
    const id = createdAppointmentIds.pop()!
    const [session] = await getDb().select().from(telemedicineSessions).where(eq(telemedicineSessions.appointmentId, id))
    if (session) {
      await getDb().delete(telemedicineSignals).where(eq(telemedicineSignals.sessionId, session.id))
      await getDb().delete(telemedicineSessions).where(eq(telemedicineSessions.id, session.id))
    }
    await getDb().delete(appointments).where(eq(appointments.id, id))
  }
})

async function makeSession() {
  const db = getDb()
  const [patientRow] = await db.select().from(patients).limit(1)
  const [providerRow] = await db.select().from(providers).limit(1)
  const [appt] = await db.insert(appointments).values({
    patientId: patientRow.id, providerId: providerRow.id,
    startsAt: new Date(), endsAt: new Date(Date.now() + 30 * 60000), visitReason: 'Telemedicine test',
  }).returning()
  createdAppointmentIds.push(appt.id)
  const { session } = await createTelemedicineSession(appt.id)
  return session!
}

function req(url: string, body?: unknown) {
  return body === undefined
    ? new Request(url)
    : new Request(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
}

describe('GET/POST /api/telemedicine/join/[token]/signal', () => {
  it('a wrong/guessed token returns 404, not 403', async () => {
    const params = Promise.resolve({ token: 'not-a-real-token-at-all' })
    const postRes = await joinSignalPost(req('http://localhost', { signalType: 'offer', payload: {} }) as never, { params })
    expect(postRes.status).toBe(404)
    const getRes = await joinSignalGet(req('http://localhost?since=0') as never, { params })
    expect(getRes.status).toBe(404)
  })

  it('an already-completed session\'s token no longer connects a new call (Review Focus #3)', async () => {
    const session = await makeSession()
    await endSession(session.id)
    const params = Promise.resolve({ token: session.patientJoinToken })
    const getRes = await joinSignalGet(req(`http://localhost?since=0`) as never, { params })
    expect(getRes.status).toBe(404)
  })

  it('the correct token on a live session succeeds', async () => {
    const session = await makeSession()
    const params = Promise.resolve({ token: session.patientJoinToken })
    const postRes = await joinSignalPost(req('http://localhost', { signalType: 'answer', payload: { sdp: 'v=0...' } }) as never, { params })
    expect(postRes.status).toBe(201)
  })
})
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/telemedicine-join-token.test.ts`
Expected: FAIL — route doesn't exist.

- [ ] **Step 4: Write the failing test — patient join transitions and signal exchange**

Create `tests/api/telemedicine-join-signal.test.ts`: using the same `makeSession()` helper shape as Step 2, assert that `GET .../signal?since=0` on a fresh `scheduled` session (a) returns 200 with `sessionStatus` reflecting the current status and an empty `signals` array, and (b) after the provider side has already called `markProviderJoined` (call it directly from `@/lib/queries/telemedicine-sessions`, simulating Task 2's GET route having already polled once) so the session is `waiting`, the patient's first `GET` transitions it to `in_progress` and a second call to `getSessionById` confirms `patientJoinedAt` is set. Also assert `listSignalsSince`-equivalent behavior end-to-end: `POST` a `patient` `answer` signal via the route, then a *provider*-side `GET` (call `listSignalsSince(session.id, 0, 'patient')` directly, since Task 2's provider route is already tested in `tests/api/telemedicine-signal.test.ts`) sees it.

- [ ] **Step 5: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/telemedicine-join-signal.test.ts`
Expected: FAIL — route doesn't exist.

- [ ] **Step 6: Implement `src/app/api/telemedicine/join/[token]/signal/route.ts`**

No `requireSession()` — same deliberate-absence comment as `src/app/api/intake/[token]/route.ts`. Both handlers start by resolving `const session = await getSessionByToken(token)` and returning `NextResponse.json({ error: 'This link is no longer valid.' }, { status: 404 })` when `!session || session.status === 'completed' || session.status === 'failed'` (this single check is what makes both Review Focus #2 and #3 pass with the same code path — a token that never existed and a token whose session has ended are indistinguishable to the caller, by design).

`POST`: body schema `z.object({ signalType: z.enum(['offer', 'answer', 'ice_candidate']), payload: z.unknown() }).strict()`, `createSignal(session.id, 'patient', signalType, payload)`, return 201 `{ id }`.

`GET`: read `since` (default 0), call `markPatientJoined(session.id)` (idempotent, called on every poll — spec §3: "Sets patientJoinedAt, transitions waiting → in_progress once both sides have joined" — happens here, on the poll, mirroring the provider route's "on first poll" wording), re-fetch the session for its current `status`, call `listSignalsSince(session.id, since, 'provider')` (the patient always polls for the provider's signals — no `for` query param needed, unlike the provider route), return 200 `{ signals, sessionStatus }`.

- [ ] **Step 7: Run this task's tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/telemedicine-join-token.test.ts tests/api/telemedicine-join-signal.test.ts`
Expected: PASS.

- [ ] **Step 8: Run the full suite once**

Run: `npx dotenv -e .env.local -- npx vitest run`
Expected: all pass (Tasks 1-3's tests together).

- [ ] **Step 9: Commit**

```bash
git add src/app/api/telemedicine/join tests/api/telemedicine-join-signal.test.ts tests/api/telemedicine-join-token.test.ts
git commit -m "$(cat <<'EOF'
feat: add token-authenticated patient-side telemedicine signaling routes

EOF
)"
```

---

### Task 4: Provider call screen, patient join page, and the "Start telemedicine visit" action

**Files:**
- Create: `src/components/TelemedicineCallScreen.tsx`
- Create: `src/app/(dashboard)/telemedicine/[sessionId]/page.tsx`
- Create: `src/app/telemedicine/join/[token]/page.tsx`
- Create: `src/components/StartTelemedicineButton.tsx`
- Modify: `src/components/DashboardAppointmentsTable.tsx` (add an Actions column)
- Modify: `src/components/dashboards/AdminDashboard.tsx`, `src/components/dashboards/CoordinatorDashboard.tsx` (pass a `canStartTelemedicine` prop through, mirroring `PharmacyDashboard`'s `canDispense` prop)
- Test: none new (client-side WebRTC has no meaningful unit test — see the verification note below) — verify per this task's honest verification discipline (Global Constraints).

**Interfaces:**
- Consumes: `POST /api/appointments/[id]/telemedicine` (Task 2), `POST /api/telemedicine/[sessionId]/signal` + `GET .../signal?since=&for=patient` + `POST .../end` (Task 2), `POST/GET /api/telemedicine/join/[token]/signal` (Task 3) — all called by URL from client components, never imported.

- [ ] **Step 1: Read the two nearest UI precedents**

Read `src/app/intake/[token]/page.tsx` (the exact chrome-free, token-only patient page shape this plan's patient join page must match: a centered card, `ClinsyncLogo`, no nav, one state per not-found/expired/already-used outcome) and `src/components/PharmacyDashboard.tsx`'s `canDispense`-gated action-button pattern (the exact shape for gating the new "Start telemedicine visit" button by role).

- [ ] **Step 2: Build `TelemedicineCallScreen.tsx` — the shared WebRTC client component**

`'use client'`. Props: `{ role: 'provider' | 'patient', pollUrl: string, initialStatus: TelemedicineSessionStatus, onEnd?: () => void }`, where `pollUrl` is the full base URL each side polls/posts against (`/api/telemedicine/${sessionId}/signal` for the provider, `/api/telemedicine/join/${token}/signal` for the patient — the caller supplies the right one, this component doesn't know about sessions vs. tokens).

Behavior:
- On mount, request `getUserMedia({ video: true, audio: true })`, attach the resulting stream to a local `<video muted playsInline>` element.
- Construct `new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })` (STUN-only, per Global Constraints), add every local track to it, and attach the first remote track received (`pc.ontrack`) to a remote `<video playsInline>` element.
- `role === 'provider'` is the offerer: create an offer, `setLocalDescription`, `POST` it as `{ signalType: 'offer', payload: offer }`. `role === 'patient'` is the answerer: wait for an `offer` signal from its poll loop, `setRemoteDescription`, create an answer, `setLocalDescription`, `POST` it as `{ signalType: 'answer', payload: answer }`.
- `pc.onicecandidate`: for every non-null candidate, `POST { signalType: 'ice_candidate', payload: candidate }`.
- A polling loop (`setInterval`, 1500ms, per spec §2's "1-2s" — cleared on unmount) hits `GET ${pollUrl}?since=${lastSeenId}${role === 'provider' ? '&for=patient' : ''}`, and for each returned signal: an `offer` (patient only) → `setRemoteDescription` + answer as above; an `answer` (provider only) → `setRemoteDescription`; an `ice_candidate` → `pc.addIceCandidate(candidate)`. Track `lastSeenId` as the max `id` seen so far so the next poll's `since` only asks for new rows. Also read the response's `sessionStatus` on every poll and reflect it in a visible state indicator.
- Render mute/camera-off toggles (`track.enabled = !track.enabled` on the relevant local track) and an "End call" button. For the provider, "End call" calls `POST /api/telemedicine/[sessionId]/end`; the patient side has no `end` route (Task 3 doesn't build one — ending is provider-initiated per the routes this plan actually built, matching Global Constraints' explicit note on this route split) and instead just tears down its own `RTCPeerConnection`/stream and shows a "Call ended" state once the poll's `sessionStatus` comes back `completed`.
- Render a visible status line driven by `pc.connectionState` (`'new'|'connecting'` → "Connecting…", `'connected'` → "Connected", `'failed'|'disconnected'|'closed'` → "Connection lost") plus a separate "Waiting for patient to join" state (provider only, shown while `sessionStatus === 'waiting'` and no remote track has arrived yet) — this satisfies spec §4's explicit UI requirements for both screens.
- Clean up on unmount: stop all local tracks, clear the poll interval, close the `RTCPeerConnection`.

- [ ] **Step 3: Build the provider call screen**

Create `src/app/(dashboard)/telemedicine/[sessionId]/page.tsx` as a Server Component: `requireSessionOrRedirect()` first, parse `sessionId`, call `getSessionById(sessionId)` directly (Server Components call the query layer directly, never their own API routes — this codebase's established rule), redirect or render a simple not-found state if missing, then render `<TelemedicineCallScreen role="provider" pollUrl={`/api/telemedicine/${sessionId}/signal`} initialStatus={session.status} />`.

- [ ] **Step 4: Build the patient join page**

Create `src/app/telemedicine/join/[token]/page.tsx`, matching `src/app/intake/[token]/page.tsx`'s exact chrome-free layout. This route lives outside the `(dashboard)` group — no nav, no unrelated links, per spec §4. It calls `getSessionByToken(token)` (a Server Component may call the query layer directly, same as the intake page calling `getIntakePortalData`); if not found or the session's status is `completed`/`failed`, render a "This link is no longer valid" message state (matching `IntakePortalPage`'s `PortalMessage` component shape). Otherwise render a single "Join Video Visit" button (a small client component) that, only on click — not on page load, per spec §4's explicit permission-prompt-timing requirement — mounts `<TelemedicineCallScreen role="patient" pollUrl={`/api/telemedicine/join/${token}/signal`} initialStatus={session.status} />` (which is what actually triggers `getUserMedia`).

- [ ] **Step 5: Build the "Start telemedicine visit" action**

Create `src/components/StartTelemedicineButton.tsx` (`'use client'`): accepts `{ appointmentId: number }`, `POST /api/appointments/[id]/telemedicine` on click, and on success either `router.push` the staff user straight to `/telemedicine/[sessionId]` (the provider call screen from Step 3) or show the returned `patientJoinToken` as a copyable `/telemedicine/join/[token]` link for staff to send however they choose (per spec §1's "the actual send action is left to staff copying the link" — this plan does not wire any broadcast/SMS/email delivery). On a 409 (session already exists for this appointment), show an inline error rather than crashing.

Add an "Actions" column to `DashboardAppointmentsTable.tsx` rendering `<StartTelemedicineButton appointmentId={a.id} />` only when a new `canStartTelemedicine` prop is `true` and the row's `status === 'scheduled'`. Thread `canStartTelemedicine={['admin', 'pi'].includes(session.role)}` down from `AdminDashboard.tsx` and `CoordinatorDashboard.tsx` (which will compute `false` for a `crc` session, matching spec §6's role table — only `admin`/`pi` start a session).

- [ ] **Step 6: Verify via a real running dev server — the honest limit of automated verification**

Start the dev server. Using real HTTP requests (mint a staff session cookie per Global Constraints; use `curl` or a small Node script — two real clients, one acting as "provider", one as "patient"), walk the full signaling handshake against the real running routes end-to-end: `POST /api/appointments/[id]/telemedicine` for a real appointment, then as the "provider" client `POST` an `offer` and `GET` poll, and as the "patient" client hit the real join-token URL, `GET` poll to receive the offer, `POST` an `answer`, exchange at least one `ice_candidate` signal each way, and confirm both sides' polls report `sessionStatus: 'in_progress'` after both have polled once. Paste the actual commands and actual output.

This proves the signaling protocol this plan built is real and works end-to-end against the real server. It does **not** prove that two real browsers' `RTCPeerConnection`s decode actual audio/video, because no browser-automation tooling (Playwright/Puppeteer) is installed in this repo (confirmed in this plan's research) to drive real `getUserMedia`/`RTCPeerConnection` instances from a terminal. State this limitation explicitly in the report rather than claiming a visual/audio check that wasn't actually performed — confirming that a person can see and hear the other side on `/telemedicine/[sessionId]` and `/telemedicine/join/[token]` in two real browser tabs is a genuine, separate, human verification step this plan flags but cannot itself complete.

- [ ] **Step 7: Run the full suite once**

Run: `npx dotenv -e .env.local -- npx vitest run`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/components/TelemedicineCallScreen.tsx "src/app/(dashboard)/telemedicine" src/app/telemedicine src/components/StartTelemedicineButton.tsx src/components/DashboardAppointmentsTable.tsx src/components/dashboards/AdminDashboard.tsx src/components/dashboards/CoordinatorDashboard.tsx
git commit -m "$(cat <<'EOF'
feat: add provider call screen, patient join page, and start-visit action

EOF
)"
```
