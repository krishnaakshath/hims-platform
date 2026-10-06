# Queue Display Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Clinsync a public, PIN-gated lobby display screen (`/display/queue`) that shows patients their queue position by opaque ticket number — a sanitized projection of the existing `doctorAssignments` triage queue, never patient names or visit reasons — plus the small front-desk-side ticket-number confirmation and admin PIN setting that support it.

**Architecture:** `doctorAssignments` already IS this app's real triage queue (pending/scheduled/declined, urgency, room) — this plan adds a `queueTicketNumber` column to it (assigned at creation, sequential per calendar day, no stored running counter) and a read-only, sanitized query/route/page layer on top. No new domain table. The PIN gate reuses the existing single-row `appSettings` table (one new nullable column) rather than inventing a new settings mechanism, matching every other pilot-wide toggle already stored there.

**Tech Stack:** Next.js 16 App Router (Server + Client Components) + Drizzle ORM over a `pg` Pool (additive-only schema changes via a hand-written one-off script, never `drizzle-kit push`) + Tailwind v4 oklch tokens.

**Spec:** `docs/superpowers/specs/2026-09-28-queue-display-screen.md`

**Working directory note:** this plan is executed in an isolated git worktree at `/Users/k2a/Desktop/clinsync/.worktrees/queue-display` on branch `feature/queue-display`. This worktree has its own `.env.local` and `node_modules` already set up. Every implementer/reviewer dispatch for this plan must work from this exact directory, not the main checkout — the main checkout and other worktrees (`lab-orders-results`, `pharmacy-med-inventory`, `esignatures`, `questionnaire-scoring`, etc.) have their own concurrent work in flight; do not touch them.

**Scope decisions made while planning (rulings, not left open for the implementer to guess):**
1. **The `GET /api/queue-display` response carries only `ticketNumber`, `urgency`, and `stage` — no `patientId`/anonId at all**, not just "no name". Spec §1 says the route returns "only ticket numbers, urgency, and coarse stage"; even an anonymized patient ID is more than that list names, and this is a public unauthenticated endpoint, so the narrowest reading wins.
2. **The display is scoped to "today"** (same server-local-midnight boundary `listTodaysAssignments()`/ticket generation already use). The spec doesn't say this explicitly, but ticket numbers themselves only make sense within a single day, and a lobby board has no reason to resurrect a multi-day-old unresolved `pending` row.
3. **A `doctorAssignments` row with `status = 'scheduled'` and no `roomId`** (e.g. an outpatient assignment scheduled into a future appointment, per the existing PI "Schedule" flow) has no bucket in spec §4's two-stage list (Waiting / Ready) and is dropped from the display entirely, rather than inventing a third stage. It's neither still "pending" (waiting) nor "has a room" (ready).
4. **`queueDisplayPin` is stored as plain text** on `appSettings`, unlike the table's `*Encrypted` credential columns (`intakeqApiKeyEncrypted`, etc.). It isn't a credential to a third-party system or PHI — it's a shared lobby-device PIN, comparable in sensitivity to a wifi password — and the display route needs a fast exact-match comparison, not a decrypt step. This is a deliberate choice, not an oversight; the settings UI never echoes the stored PIN back (only "PIN is set" / "PIN is not set"), same posture as `EhrConnectionsForm`'s `*Configured` booleans.
5. **Ticket-number generation is not wrapped in a lock or transaction against two literally simultaneous check-ins.** The spec explicitly directs a `SELECT count(*) ... +1` approach specifically *because* it needs no stored counter and no collision risk *across days* — it does not ask for cross-request atomicity, and a same-day ticket-number collision between two check-ins landing in the same instant is a cosmetic lobby-display issue, not a safety or data-integrity one. Not adding scope the spec didn't ask for.

## Global Constraints

- Additive-only schema changes. Apply via a hand-written one-off script run with `npx dotenv -e .env.local -- npx tsx <script>` — never `drizzle-kit push`. This is a **single shared Neon Postgres database across every branch/worktree** — a schema mistake here is visible everywhere immediately, including the main checkout and every other active worktree.
- `psql` is **not installed** in this environment — verify a migration's live-DB effect with a Node script using `pg`'s `Pool` and an `information_schema.columns` query, not `psql -c "\d ..."`.
- Every write route uses `.strict()` Zod validation (rejects unknown fields).
- Every state-changing route calls `logAudit(session, <action>, <patientId or null>)`.
- Every protected route/page starts with `requireSession()` (API routes) or `requireSessionOrRedirect()` (pages) as its first statement — **except** `GET /api/queue-display` and `/display/queue` themselves, which are deliberately unauthenticated per spec §3 (PIN-gated, not session-gated) — that exception applies to those two routes only, nothing else in this plan.
- Role gating per spec §7: read `/display/queue` = anyone with the PIN, no staff role. Set/change the PIN = `admin` only. View own ticket number at check-in = whichever roles can already check a patient in (`frontdesk`, `admin`, `crc` — matching `POST /api/front-desk/check-in`'s existing gate, unchanged by this plan).
- Vitest invocation: `npx dotenv -e .env.local -- npx vitest run <path>` (`fileParallelism: false`).
- Commit messages end with no attribution trailer.
- **UI verification discipline (standing rule this session):** a prior implementer fabricated a narrated, unreproduced UI verification claim and was caught. For Task 4's UI work: verification must be a real running dev server hit with real HTTP requests/real browser interaction — mint a staff session cookie the way `src/lib/auth.ts` actually builds it (`SignJWT` under cookie `clinsync_demo_session`, secret from `SESSION_SECRET`, via `buildSessionCookieValue`) for the front-desk-side check, and the display page itself needs no session at all, just the PIN. Paste actual commands and actual output in the report — never a narrated, unreproduced claim.

## Review Focus

1. **`GET /api/queue-display` with no PIN set on `appSettings`, or the wrong PIN supplied** — must return 401, never an empty array or real data. An unset PIN is not "no gate", it's "closed". (Task 3)
2. **The response body of `GET /api/queue-display` must never contain any patient's actual name string** — an explicit test asserts `JSON.stringify(body)` doesn't include a known real patient's `nameIntakeq`/`nameTebra`, not just that the route "looks" sanitized by inspection. (Task 3)
3. **Stage derivation must exclude a `doctorAssignments` row whose admission or completed appointment already exists**, rather than showing someone who's already been admitted or already finished their visit as perpetually "Waiting". (Task 3)
4. **Ticket-number day-boundary correctness** — an assignment created before today's server-local midnight must not be counted toward today's ticket numbers, so the sequence genuinely restarts each day rather than drifting from stale historical rows. (Task 2)
5. **The real `POST /api/front-desk/check-in` route — not just the isolated query-layer function — must return the exact server-generated `queueTicketNumber`**, since that's the value the front-desk confirmation UI (Task 4) displays verbatim; two sequential real check-ins through the actual route must get distinct sequential numbers end-to-end. (Task 2, with real-dev-server confirmation in Task 4)

---

### Task 1: Schema — `queueTicketNumber` on `doctorAssignments`, `queueDisplayPin` on `appSettings`

**Files:**
- Modify: `src/db/schema.ts`
- Test: `tests/db/queue-display-schema.test.ts`

**Interfaces:**
- Produces: `doctorAssignments.queueTicketNumber` (`integer`, not null), `appSettings.queueDisplayPin` (`text`, nullable). Consumed by Tasks 2-4.

- [ ] **Step 1: Read the current `doctorAssignments` and `appSettings` definitions**

Read `src/db/schema.ts` lines ~387-475 (already reviewed while planning this task) to confirm the exact current column set and ordering before adding to either table — don't assume the exact line numbers still match once other work has landed in this worktree.

- [ ] **Step 2: Write the failing test**

Create `tests/db/queue-display-schema.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, providers, doctorAssignments, appSettings } from '@/db/schema'

const createdAssignmentIds: number[] = []
afterEach(async () => {
  while (createdAssignmentIds.length > 0) await getDb().delete(doctorAssignments).where(eq(doctorAssignments.id, createdAssignmentIds.pop()!))
})

describe('queue display schema', () => {
  it('accepts a queueTicketNumber on a new doctorAssignments row', async () => {
    const db = getDb()
    const [patientRow] = await db.select().from(patients).limit(1)
    const [providerRow] = await db.select().from(providers).limit(1)
    const [row] = await db.insert(doctorAssignments).values({
      patientId: patientRow.id, providerId: providerRow.id, visitType: 'outpatient', urgency: 'routine',
      reason: 'Test', assignedByName: 'Test Staff', queueTicketNumber: 1,
    }).returning()
    createdAssignmentIds.push(row.id)
    expect(row.queueTicketNumber).toBe(1)
  })

  it('rejects an insert with no queueTicketNumber (NOT NULL enforced)', async () => {
    const db = getDb()
    const [patientRow] = await db.select().from(patients).limit(1)
    const [providerRow] = await db.select().from(providers).limit(1)
    await expect(db.insert(doctorAssignments).values({
      patientId: patientRow.id, providerId: providerRow.id, visitType: 'outpatient', urgency: 'routine',
      reason: 'Test', assignedByName: 'Test Staff',
    } as never)).rejects.toThrow()
  })

  it('reads a nullable queueDisplayPin off appSettings', async () => {
    const [row] = await getDb().select().from(appSettings)
    expect(row.queueDisplayPin === null || typeof row.queueDisplayPin === 'string').toBe(true)
  })
})
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/queue-display-schema.test.ts`
Expected: FAIL — `queueTicketNumber`/`queueDisplayPin` don't exist (TypeScript error or runtime column error).

- [ ] **Step 4: Add the columns**

In `src/db/schema.ts`, on `doctorAssignments`, add (after `declineReason`, before `createdAt`):

```ts
queueTicketNumber: integer('queue_ticket_number').notNull(),
```

On `appSettings`, add (near the end, alongside the other admin-settable fields):

```ts
// Plaintext by design, not AES-encrypted like the *Encrypted credential
// columns above -- this is a shared lobby-device PIN, not a third-party
// credential or PHI. See this plan's "Scope decisions" #4.
queueDisplayPin: text('queue_display_pin'),
```

- [ ] **Step 5: Run the test again — expect a different failure**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/queue-display-schema.test.ts`
Expected: FAIL — now a runtime DB error (column does not exist), not a type error.

- [ ] **Step 6: Write and run the one-off migration script**

Scratch, not part of the repo. Create `migrate-queue-display-scratch.ts` at this worktree's root:

```ts
import { Pool } from 'pg'

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false } })

  await pool.query(`ALTER TABLE doctor_assignments ADD COLUMN IF NOT EXISTS queue_ticket_number INTEGER`)

  // Backfill existing rows with the same same-day-sequential numbering the
  // app will generate for new ones going forward, keyed off each row's own
  // createdAt date -- so a pre-existing row and a freshly created one use
  // an identical numbering rule, not a placeholder value.
  await pool.query(`
    UPDATE doctor_assignments SET queue_ticket_number = sub.rn
    FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY created_at::date ORDER BY created_at, id) AS rn
      FROM doctor_assignments
      WHERE queue_ticket_number IS NULL
    ) sub
    WHERE doctor_assignments.id = sub.id
  `)

  await pool.query(`ALTER TABLE doctor_assignments ALTER COLUMN queue_ticket_number SET NOT NULL`)

  await pool.query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS queue_display_pin TEXT`)

  console.log('Queue display migration complete.')
  await pool.end()
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1) })
```

Run: `npx dotenv -e .env.local -- npx tsx migrate-queue-display-scratch.ts`. If blocked by the permission classifier: stop, report it, do not retry with variations.

Verify with a Node script (no `psql` here) — before running the migration, confirm the columns are absent; after, confirm both exist and `queue_ticket_number` is `NOT NULL`:

```ts
// verify-queue-display-scratch.ts
import { Pool } from 'pg'
const pool = new Pool({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false } })
const rows = await pool.query(`SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE (table_name = 'doctor_assignments' AND column_name = 'queue_ticket_number') OR (table_name = 'app_settings' AND column_name = 'queue_display_pin')`)
console.log(rows.rows)
await pool.end()
```

Delete both scratch scripts once confirmed: `rm migrate-queue-display-scratch.ts verify-queue-display-scratch.ts`.

- [ ] **Step 7: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/queue-display-schema.test.ts`
Expected: PASS (all three tests).

- [ ] **Step 8: Commit**

```bash
git add src/db/schema.ts tests/db/queue-display-schema.test.ts
git commit -m "$(cat <<'EOF'
feat: add queueTicketNumber to doctorAssignments and queueDisplayPin to appSettings

EOF
)"
```

---

### Task 2: Ticket-number generation + assignment creation

**Files:**
- Create: `src/lib/queries/queue-tickets.ts`
- Modify: `src/lib/queries/doctor-assignments.ts`
- Modify: `tests/api/front-desk-check-in.test.ts` (extend, don't rewrite)
- Test: `tests/lib/queries/queue-tickets.test.ts`

**Interfaces:**
- Consumes: `doctorAssignments` from `@/db/schema` (Task 1).
- Produces: `getNextQueueTicketNumberForToday(): Promise<number>` from `@/lib/queries/queue-tickets`; `createDoctorAssignment()`'s return type (`DoctorAssignmentRow`) now always carries a real `queueTicketNumber` — its existing call signature is unchanged, so `POST /api/front-desk/check-in` (the only production caller) needs no code change to pick this up. Consumed by Task 3 (display query reads `queueTicketNumber` off these rows) and Task 4 (front-desk confirmation UI reads it off the check-in response).

- [ ] **Step 1: Read `listTodaysAssignments()`'s day-boundary logic**

Read the existing `listTodaysAssignments()` in `src/lib/queries/doctor-assignments.ts` (server-local midnight via `new Date(); setHours(0,0,0,0)`) — this plan's ticket-numbering boundary must match it exactly, so the queue's "today" and the rest of the app's "today" never disagree.

- [ ] **Step 2: Write the failing tests**

Create `tests/lib/queries/queue-tickets.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { doctorAssignments } from '@/db/schema'
import { getNextQueueTicketNumberForToday } from '@/lib/queries/queue-tickets'
import { createDoctorAssignment } from '@/lib/queries/doctor-assignments'
import { listActiveProviders } from '@/lib/queries/providers'

const createdAssignmentIds: number[] = []
afterEach(async () => {
  while (createdAssignmentIds.length > 0) await getDb().delete(doctorAssignments).where(eq(doctorAssignments.id, createdAssignmentIds.pop()!))
})

describe('queue ticket generation', () => {
  it('assigns sequential ticket numbers to two patients checked in the same day', async () => {
    const providers = await listActiveProviders()
    const first = await createDoctorAssignment({ patientId: 'RD-0001', providerId: providers[0].id, visitType: 'outpatient', urgency: 'routine', reason: 'Test', roomId: null, assignedByName: 'Test Staff' })
    createdAssignmentIds.push(first.id)
    const second = await createDoctorAssignment({ patientId: 'RD-0001', providerId: providers[0].id, visitType: 'outpatient', urgency: 'routine', reason: 'Test', roomId: null, assignedByName: 'Test Staff' })
    createdAssignmentIds.push(second.id)

    expect(second.queueTicketNumber).toBe(first.queueTicketNumber + 1)
  })

  it('excludes an assignment created yesterday from today\'s count (day-boundary correctness — Review Focus #4)', async () => {
    const providers = await listActiveProviders()
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const [oldRow] = await getDb().insert(doctorAssignments).values({
      patientId: 'RD-0001', providerId: providers[0].id, visitType: 'outpatient', urgency: 'routine',
      reason: 'Old', assignedByName: 'Test Staff', queueTicketNumber: 999, createdAt: yesterday,
    }).returning()
    createdAssignmentIds.push(oldRow.id)

    const created = await createDoctorAssignment({ patientId: 'RD-0001', providerId: providers[0].id, visitType: 'outpatient', urgency: 'routine', reason: 'Today', roomId: null, assignedByName: 'Test Staff' })
    createdAssignmentIds.push(created.id)

    // If yesterday's row leaked into today's count, this would be >= 1000.
    expect(created.queueTicketNumber).toBeLessThan(999)
  })

  it('getNextQueueTicketNumberForToday reflects a row just created', async () => {
    const before = await getNextQueueTicketNumberForToday()
    const providers = await listActiveProviders()
    const created = await createDoctorAssignment({ patientId: 'RD-0001', providerId: providers[0].id, visitType: 'outpatient', urgency: 'routine', reason: 'Test', roomId: null, assignedByName: 'Test Staff' })
    createdAssignmentIds.push(created.id)
    const after = await getNextQueueTicketNumberForToday()
    expect(after).toBe(before + 1)
  })
})
```

- [ ] **Step 3: Run them to confirm they fail**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/queue-tickets.test.ts`
Expected: FAIL — `@/lib/queries/queue-tickets` doesn't exist yet, and `createDoctorAssignment` doesn't set `queueTicketNumber`.

- [ ] **Step 4: Implement `src/lib/queries/queue-tickets.ts`**

```ts
import { getDb } from '@/db/client'
import { doctorAssignments } from '@/db/schema'
import { gte, sql } from 'drizzle-orm'

// Same day-boundary convention as listTodaysAssignments() in
// doctor-assignments.ts: server-local midnight, not UTC -- this pilot runs
// in one timezone, and matching the app's existing "today" boundary keeps
// the queue from resetting at a different moment than everything else.
function startOfToday(): Date {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  return start
}

// Ticket numbers are (count of today's assignments) + 1, computed fresh at
// insert time rather than stored as a running sequence (spec §2): the daily
// reset is automatic (a new day has zero rows counted), with no unbounded
// counter and no cross-day collision risk, since the display (Task 3) only
// ever scopes to "today". Not guarded against two literally simultaneous
// check-ins racing the same count -- see this plan's header, "Scope
// decisions" #5, for why that's an intentional non-goal here.
export async function getNextQueueTicketNumberForToday(): Promise<number> {
  const [{ count }] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(doctorAssignments)
    .where(gte(doctorAssignments.createdAt, startOfToday()))
  return count + 1
}
```

- [ ] **Step 5: Wire it into `createDoctorAssignment`**

In `src/lib/queries/doctor-assignments.ts`, import `getNextQueueTicketNumberForToday` and update `createDoctorAssignment`:

```ts
import { getNextQueueTicketNumberForToday } from './queue-tickets'

export async function createDoctorAssignment(input: CreateDoctorAssignmentInput): Promise<DoctorAssignmentRow> {
  const queueTicketNumber = await getNextQueueTicketNumberForToday()
  const [created] = await getDb().insert(doctorAssignments).values({ ...input, queueTicketNumber }).returning()
  return created
}
```

`queueTicketNumber` is deliberately **not** added to `CreateDoctorAssignmentInput` — it's server-generated, never caller-supplied (spec §2, §5: "the number is server-generated, never staff-entered").

- [ ] **Step 6: Run the query-layer tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/queue-tickets.test.ts`
Expected: PASS.

- [ ] **Step 7: Extend the existing check-in route test (Review Focus #5)**

`createDoctorAssignment` is called from exactly one production route: `POST /api/front-desk/check-in`. Add assertions to the existing `tests/api/front-desk-check-in.test.ts` (don't restructure the file — add to its existing `describe('POST /api/front-desk/check-in')` block) confirming the *real route's* response, not just the query function, carries a correct ticket number:

```ts
it('returns a positive integer queueTicketNumber on the created assignment', async () => {
  const providers = await listActiveProviders()
  const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001', visitType: 'outpatient', urgency: 'routine', reason: 'Follow-up', providerId: providers[0].id }) })
  const res = await POST(req as never)
  const body = await res.json()
  createdAssignmentIds.push(body.id)
  expect(Number.isInteger(body.queueTicketNumber)).toBe(true)
  expect(body.queueTicketNumber).toBeGreaterThan(0)
})

it('gives two sequential real check-ins distinct sequential ticket numbers', async () => {
  const providers = await listActiveProviders()
  const req1 = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001', visitType: 'outpatient', urgency: 'routine', reason: 'Follow-up', providerId: providers[0].id }) })
  const res1 = await POST(req1 as never)
  const body1 = await res1.json()
  createdAssignmentIds.push(body1.id)

  const req2 = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001', visitType: 'outpatient', urgency: 'routine', reason: 'Follow-up', providerId: providers[0].id }) })
  const res2 = await POST(req2 as never)
  const body2 = await res2.json()
  createdAssignmentIds.push(body2.id)

  expect(body2.queueTicketNumber).toBe(body1.queueTicketNumber + 1)
})
```

- [ ] **Step 8: Run this task's full test set to confirm everything passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/queue-tickets.test.ts tests/api/front-desk-check-in.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/queries/queue-tickets.ts src/lib/queries/doctor-assignments.ts tests/lib/queries/queue-tickets.test.ts tests/api/front-desk-check-in.test.ts
git commit -m "$(cat <<'EOF'
feat: generate a same-day-sequential queue ticket number on every doctor assignment

EOF
)"
```

---

### Task 3: Display query + `GET /api/queue-display` PIN gate + admin PIN setting

**Files:**
- Create: `src/lib/queries/queue-display.ts`
- Modify: `src/lib/queries/settings.ts` (add `getQueueDisplayPin`, `setQueueDisplayPin`; add `queueDisplayPin: null` to `getAppSettings()`'s fallback object; add `queueDisplayPinConfigured` to `getSettingsSummary()`)
- Create: `src/app/api/queue-display/route.ts` (GET, unauthenticated, PIN-gated)
- Create: `src/app/api/settings/queue-display-pin/route.ts` (PUT, admin only)
- Create: `src/components/QueueDisplayPinForm.tsx`
- Modify: `src/app/(dashboard)/settings/page.tsx` (new "Queue Display" tab)
- Test: `tests/api/queue-display.test.ts`, `tests/api/settings-queue-display-pin.test.ts`

**Interfaces:**
- Consumes: `doctorAssignments`, `appointments`, `admissions` from `@/db/schema` (existing); `appSettings.queueDisplayPin` (Task 1).
- Produces: `getQueueDisplayRows(): Promise<{ ticketNumber: number; urgency: 'routine'|'urgent'|'emergency'; stage: 'waiting'|'ready' }[]>` from `@/lib/queries/queue-display`; `getQueueDisplayPin()`, `setQueueDisplayPin(pin: string)` from `@/lib/queries/settings`; `GET /api/queue-display` (header `x-queue-display-pin`); `PUT /api/settings/queue-display-pin` (body `{ pin: string }`). Consumed by Task 4 (the display page calls the GET route; front-desk doesn't touch these).

- [ ] **Step 1: Read the existing `appSettings` query-layer pattern**

Read `src/lib/queries/settings.ts` in full (already reviewed while planning) — `getAppSettings()`'s single-row-by-id-1-or-fallback pattern, and `updateAutoClassifySetting()`'s look-up-current-row-then-update-by-id pattern, are the exact conventions to match for `getQueueDisplayPin`/`setQueueDisplayPin`.

- [ ] **Step 2: Write the failing tests — display query + route**

Create `tests/api/queue-display.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { appSettings, patients, providers, doctorAssignments, appointments, admissions, rooms } from '@/db/schema'
import { GET } from '@/app/api/queue-display/route'
import { listActiveProviders } from '@/lib/queries/providers'

const PIN_HEADER = 'x-queue-display-pin'
const TEST_PIN = 'lobby-4821'

async function setPin(pin: string | null) {
  const [row] = await getDb().select().from(appSettings)
  await getDb().update(appSettings).set({ queueDisplayPin: pin }).where(eq(appSettings.id, row.id))
}

const createdAssignmentIds: number[] = []
const createdRoomIds: number[] = []
const createdAdmissionIds: number[] = []
const createdAppointmentIds: number[] = []
afterEach(async () => {
  while (createdAdmissionIds.length > 0) await getDb().delete(admissions).where(eq(admissions.id, createdAdmissionIds.pop()!))
  while (createdAssignmentIds.length > 0) await getDb().delete(doctorAssignments).where(eq(doctorAssignments.id, createdAssignmentIds.pop()!))
  while (createdAppointmentIds.length > 0) await getDb().delete(appointments).where(eq(appointments.id, createdAppointmentIds.pop()!))
  while (createdRoomIds.length > 0) await getDb().delete(rooms).where(eq(rooms.id, createdRoomIds.pop()!))
  await setPin(null)
})

describe('GET /api/queue-display', () => {
  it('returns 401 when no PIN is set on appSettings (Review Focus #1)', async () => {
    await setPin(null)
    const req = new Request('http://localhost/api/queue-display', { headers: { [PIN_HEADER]: 'anything' } })
    const res = await GET(req as never)
    expect(res.status).toBe(401)
  })

  it('returns 401 when the wrong PIN is supplied', async () => {
    await setPin(TEST_PIN)
    const req = new Request('http://localhost/api/queue-display', { headers: { [PIN_HEADER]: 'wrong-pin' } })
    const res = await GET(req as never)
    expect(res.status).toBe(401)
  })

  it('returns 401 when no PIN header is supplied at all', async () => {
    await setPin(TEST_PIN)
    const req = new Request('http://localhost/api/queue-display')
    const res = await GET(req as never)
    expect(res.status).toBe(401)
  })

  it('never includes a real patient name in the response body (Review Focus #2)', async () => {
    await setPin(TEST_PIN)
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const realName = patientRow.nameIntakeq ?? patientRow.nameTebra
    const providerRows = await listActiveProviders()
    const created = await getDb().insert(doctorAssignments).values({ patientId: patientRow.id, providerId: providerRows[0].id, visitType: 'outpatient', urgency: 'routine', reason: 'Should never appear', assignedByName: 'Test Staff', queueTicketNumber: 1 }).returning()
    createdAssignmentIds.push(created[0].id)

    const req = new Request('http://localhost/api/queue-display', { headers: { [PIN_HEADER]: TEST_PIN } })
    const res = await GET(req as never)
    const bodyText = await res.text()
    expect(res.status).toBe(200)
    if (realName) expect(bodyText.includes(realName)).toBe(false)
    expect(bodyText.includes('Should never appear')).toBe(false) // the reason
    expect(bodyText.includes(patientRow.id)).toBe(false) // not even the anonId
  })

  it('maps pending to "waiting" and scheduled+room to "ready"', async () => {
    await setPin(TEST_PIN)
    const providerRows = await listActiveProviders()
    const [room] = await getDb().insert(rooms).values({ ward: 'Test Ward', roomNumber: '901', bedNumber: 'A', status: 'occupied' }).returning()
    createdRoomIds.push(room.id)

    const [waiting] = await getDb().insert(doctorAssignments).values({ patientId: 'RD-0001', providerId: providerRows[0].id, visitType: 'outpatient', urgency: 'routine', reason: 'x', assignedByName: 'Test Staff', queueTicketNumber: 101, status: 'pending' }).returning()
    createdAssignmentIds.push(waiting.id)
    const [ready] = await getDb().insert(doctorAssignments).values({ patientId: 'RD-0001', providerId: providerRows[0].id, visitType: 'inpatient', urgency: 'urgent', reason: 'x', assignedByName: 'Test Staff', queueTicketNumber: 102, status: 'scheduled', roomId: room.id }).returning()
    createdAssignmentIds.push(ready.id)

    const req = new Request('http://localhost/api/queue-display', { headers: { [PIN_HEADER]: TEST_PIN } })
    const res = await GET(req as never)
    const body = await res.json()
    expect(body.tickets.find((t: any) => t.ticketNumber === 101)?.stage).toBe('waiting')
    expect(body.tickets.find((t: any) => t.ticketNumber === 102)?.stage).toBe('ready')
  })

  it('excludes a declined assignment', async () => {
    await setPin(TEST_PIN)
    const providerRows = await listActiveProviders()
    const [declined] = await getDb().insert(doctorAssignments).values({ patientId: 'RD-0001', providerId: providerRows[0].id, visitType: 'outpatient', urgency: 'routine', reason: 'x', assignedByName: 'Test Staff', queueTicketNumber: 201, status: 'declined', declineReason: 'x' }).returning()
    createdAssignmentIds.push(declined.id)

    const req = new Request('http://localhost/api/queue-display', { headers: { [PIN_HEADER]: TEST_PIN } })
    const res = await GET(req as never)
    const body = await res.json()
    expect(body.tickets.some((t: any) => t.ticketNumber === 201)).toBe(false)
  })

  it('excludes an assignment that already has an active admission (Review Focus #3)', async () => {
    await setPin(TEST_PIN)
    const providerRows = await listActiveProviders()
    const [assignment] = await getDb().insert(doctorAssignments).values({ patientId: 'RD-0001', providerId: providerRows[0].id, visitType: 'inpatient', urgency: 'routine', reason: 'x', assignedByName: 'Test Staff', queueTicketNumber: 301, status: 'pending' }).returning()
    createdAssignmentIds.push(assignment.id)
    const [admission] = await getDb().insert(admissions).values({ patientId: 'RD-0001', attendingProviderId: providerRows[0].id, createdFromAssignmentId: assignment.id }).returning()
    createdAdmissionIds.push(admission.id)

    const req = new Request('http://localhost/api/queue-display', { headers: { [PIN_HEADER]: TEST_PIN } })
    const res = await GET(req as never)
    const body = await res.json()
    expect(body.tickets.some((t: any) => t.ticketNumber === 301)).toBe(false)
  })

  it('excludes an assignment whose appointment is already completed (Review Focus #3)', async () => {
    await setPin(TEST_PIN)
    const providerRows = await listActiveProviders()
    const [appointment] = await getDb().insert(appointments).values({ patientId: 'RD-0001', providerId: providerRows[0].id, startsAt: new Date(), endsAt: new Date(Date.now() + 30 * 60000), visitReason: 'x', status: 'completed' }).returning()
    createdAppointmentIds.push(appointment.id)
    const [assignment] = await getDb().insert(doctorAssignments).values({ patientId: 'RD-0001', providerId: providerRows[0].id, visitType: 'outpatient', urgency: 'routine', reason: 'x', assignedByName: 'Test Staff', queueTicketNumber: 401, status: 'scheduled', appointmentId: appointment.id }).returning()
    createdAssignmentIds.push(assignment.id)

    const req = new Request('http://localhost/api/queue-display', { headers: { [PIN_HEADER]: TEST_PIN } })
    const res = await GET(req as never)
    const body = await res.json()
    expect(body.tickets.some((t: any) => t.ticketNumber === 401)).toBe(false)
  })
})
```

Create `tests/api/settings-queue-display-pin.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { PUT } from '@/app/api/settings/queue-display-pin/route'

vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: 'admin' as const, name: 'Test Admin' })) }))

describe('PUT /api/settings/queue-display-pin', () => {
  it('returns 401 when there is no authenticated session', async () => {
    const auth = await import('@/lib/auth')
    vi.mocked(auth.requireSession).mockResolvedValueOnce(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ pin: '1234' }) })
    const res = await PUT(req as never)
    expect(res.status).toBe(401)
  })

  it('rejects a non-admin session', async () => {
    const auth = await import('@/lib/auth')
    vi.mocked(auth.requireSession).mockResolvedValueOnce({ role: 'frontdesk', name: 'Test Frontdesk' })
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ pin: '1234' }) })
    const res = await PUT(req as never)
    expect(res.status).toBe(403)
  })

  it('rejects an unknown field (mass-assignment guard)', async () => {
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ pin: '1234', notAField: true }) })
    const res = await PUT(req as never)
    expect(res.status).toBe(400)
  })

  it('rejects a PIN shorter than 4 characters', async () => {
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ pin: '12' }) })
    const res = await PUT(req as never)
    expect(res.status).toBe(400)
  })

  it('accepts a valid PIN from an admin session', async () => {
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ pin: '4821' }) })
    const res = await PUT(req as never)
    expect(res.status).toBe(200)
  })
})
```

- [ ] **Step 3: Run them to confirm they fail**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/queue-display.test.ts tests/api/settings-queue-display-pin.test.ts`
Expected: FAIL — routes/query module don't exist.

- [ ] **Step 4: Implement `src/lib/queries/queue-display.ts`**

```ts
import { getDb } from '@/db/client'
import { doctorAssignments, appointments, admissions } from '@/db/schema'
import { and, eq, gte, ne } from 'drizzle-orm'

export type QueueDisplayStage = 'waiting' | 'ready'

export interface QueueDisplayRow {
  ticketNumber: number
  urgency: 'routine' | 'urgent' | 'emergency'
  stage: QueueDisplayStage
}

function startOfToday(): Date {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  return start
}

// Reuses doctorAssignments/rooms/admissions/appointments -- no new status
// enum (spec §4). Scoped to "today" (see this plan's "Scope decisions" #2).
export async function getQueueDisplayRows(): Promise<QueueDisplayRow[]> {
  const db = getDb()
  const rows = await db
    .select({
      queueTicketNumber: doctorAssignments.queueTicketNumber,
      urgency: doctorAssignments.urgency,
      status: doctorAssignments.status,
      roomId: doctorAssignments.roomId,
      appointmentStatus: appointments.status,
      admissionId: admissions.id,
    })
    .from(doctorAssignments)
    .leftJoin(appointments, eq(doctorAssignments.appointmentId, appointments.id))
    .leftJoin(admissions, eq(admissions.createdFromAssignmentId, doctorAssignments.id))
    .where(and(gte(doctorAssignments.createdAt, startOfToday()), ne(doctorAssignments.status, 'declined')))

  const result: QueueDisplayRow[] = []
  for (const row of rows) {
    if (row.admissionId !== null) continue // already admitted -- no longer waiting in the lobby
    if (row.appointmentStatus === 'completed') continue // visit already happened
    if (row.status === 'pending') {
      result.push({ ticketNumber: row.queueTicketNumber, urgency: row.urgency, stage: 'waiting' })
    } else if (row.status === 'scheduled' && row.roomId !== null) {
      result.push({ ticketNumber: row.queueTicketNumber, urgency: row.urgency, stage: 'ready' })
    }
    // 'scheduled' with no roomId has no bucket here -- see "Scope decisions" #3.
  }
  return result.sort((a, b) => a.ticketNumber - b.ticketNumber)
}
```

- [ ] **Step 5: Add PIN read/write to `src/lib/queries/settings.ts`**

Add `queueDisplayPin: null` to `getAppSettings()`'s fallback object (matching every other field already listed there), then add:

```ts
export async function getQueueDisplayPin(): Promise<string | null> {
  const settings = await getAppSettings()
  return settings.queueDisplayPin
}

export async function setQueueDisplayPin(pin: string): Promise<void> {
  const current = await getAppSettings()
  await getDb().update(appSettings).set({ queueDisplayPin: pin }).where(eq(appSettings.id, current.id))
}
```

Also add `queueDisplayPinConfigured: !!settings.queueDisplayPin` to `getSettingsSummary()`'s returned object (same boolean-not-value convention as `intakeqConfigured`/`tebraConfigured`) — the Settings page UI (Step 8) needs this, never the raw PIN.

- [ ] **Step 6: Implement the two routes**

`src/app/api/queue-display/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { getQueueDisplayPin } from '@/lib/queries/settings'
import { getQueueDisplayRows } from '@/lib/queries/queue-display'

const PIN_HEADER = 'x-queue-display-pin'

// Deliberately does NOT call requireSession() -- this backs a lobby TV with
// no staff login (spec §3), gated instead by a shared PIN checked against
// appSettings.queueDisplayPin. An unset PIN fails closed (401), never
// silently serves real data with no gate at all.
export async function GET(request: NextRequest) {
  const storedPin = await getQueueDisplayPin()
  const suppliedPin = request.headers.get(PIN_HEADER)
  if (!storedPin || !suppliedPin || suppliedPin !== storedPin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const tickets = await getQueueDisplayRows()
  return NextResponse.json({ tickets })
}
```

`src/app/api/settings/queue-display-pin/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { setQueueDisplayPin } from '@/lib/queries/settings'

const pinSchema = z.object({ pin: z.string().min(4).max(32) }).strict()

export async function PUT(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })

  const parsed = pinSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 400 })

  await setQueueDisplayPin(parsed.data.pin)
  await logAudit(session, 'set queue display PIN', null)
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 7: Run this task's tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/queue-display.test.ts tests/api/settings-queue-display-pin.test.ts`
Expected: PASS.

- [ ] **Step 8: Add the admin PIN-setting UI**

Read `src/components/AutoClassifyToggle.tsx` and `src/components/PracticeInfoForm.tsx` (already reviewed while planning) for the exact fetch-and-save client-component shape. Create `src/components/QueueDisplayPinForm.tsx` (`'use client'`): accepts `{ isAdmin: boolean; configured: boolean }`, shows "PIN configured: Yes/No" (never the stored value, matching `EhrConnectionsForm`'s `*Configured` boolean convention), an input for a new/replacement PIN, and a Save button calling `PUT /api/settings/queue-display-pin`, disabled for non-admins.

In `src/app/(dashboard)/settings/page.tsx`, add a new tab (e.g. `Monitor` icon from `lucide-react`, label "Queue Display") rendering `<QueueDisplayPinForm isAdmin={isAdmin} configured={settings.queueDisplayPinConfigured} />` inside a `<section className={SECTION}>`, following the exact pattern of the existing `classificationTab`.

- [ ] **Step 9: Run the full suite once**

Run: `npx dotenv -e .env.local -- npx vitest run`
Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add src/lib/queries/queue-display.ts src/lib/queries/settings.ts src/app/api/queue-display src/app/api/settings/queue-display-pin src/components/QueueDisplayPinForm.tsx "src/app/(dashboard)/settings/page.tsx" tests/api/queue-display.test.ts tests/api/settings-queue-display-pin.test.ts
git commit -m "$(cat <<'EOF'
feat: add PIN-gated queue display API and admin PIN setting

EOF
)"
```

---

### Task 4: `/display/queue` page + front-desk ticket confirmation

**Files:**
- Create: `src/app/display/queue/page.tsx`
- Modify: `src/components/CheckInModal.tsx`
- Test: none new — UI wiring over already-tested routes (Tasks 2, 3). Verify per this plan's UI verification discipline.

**Interfaces:**
- Consumes: `GET /api/queue-display` (Task 3, called by the display page from the browser); `POST /api/front-desk/check-in`'s existing response, now carrying `queueTicketNumber` (Task 2, already consumed by `CheckInModal.tsx` — this task only adds a UI step to display it).

- [ ] **Step 1: Confirm `/display/queue` sits outside the authenticated route group**

Confirm (already established while planning this task) that `src/app/(dashboard)/layout.tsx` is the only place `getSession()`/`redirect('/login')` is enforced for a whole route subtree, and that `src/app/login`, `src/app/intake`, `src/app/patient-portal` are real precedents for top-level routes outside `(dashboard)` with no staff-session requirement. `src/app/display/queue/page.tsx` must live at that same top level, not under `(dashboard)`, so it never redirects to `/login`.

- [ ] **Step 2: Build the display page**

Create `src/app/display/queue/page.tsx` as a Client Component (`'use client'` — it needs `sessionStorage` and polling, both browser-only):

- **PIN gate:** on mount, read `sessionStorage.getItem('queueDisplayPin')`. If present, immediately attempt a fetch; if that fetch 401s (wrong/changed/revoked PIN), clear the stored value and fall back to the entry form. If absent, show a full-screen PIN entry form (a single input + submit); on submit, store the entered value in `sessionStorage` under `'queueDisplayPin'` and attempt the fetch.
- **Fetching:** `GET /api/queue-display` with header `x-queue-display-pin: <stored pin>`. A 401 response (whether from a bad PIN on entry or a PIN changed mid-session) clears `sessionStorage` and returns to the entry form with an error message — never silently retries the same bad PIN in a loop.
- **Auto-refresh:** once authenticated, poll on an interval (e.g. every 8 seconds via `setInterval`, cleaned up in a `useEffect` return) — no new realtime infrastructure, matching spec §1's explicit "polling, no new realtime infra".
- **Layout:** full-screen, large type, grouped into two sections by `stage` ("Waiting" / "Ready") per spec §4, each listing its tickets' numbers large enough to read across a room. Urgency is never color-alone (this codebase's established convention, e.g. `AssignmentStatusChip.tsx`) — an `urgent`/`emergency` ticket gets a visible label/icon alongside any color treatment, not color by itself.

- [ ] **Step 3: Add the front-desk ticket-number confirmation**

In `src/components/CheckInModal.tsx`, `submit()` currently does `router.refresh(); onClose()` immediately on `res.ok`. Change this to a two-step flow: on success, parse the response body (`const body = await res.json()`), store `body.queueTicketNumber` in a new `ticketNumber` state, call `router.refresh()`, but **don't** call `onClose()` yet — instead render a confirmation view inside the same dialog ("Ticket #<N> — give this number to the patient") with a "Done" button that calls `onClose()`. This is read-only display, not a new form field, per spec §5.

- [ ] **Step 4: Verify via a real running dev server, not narration**

Start the dev server. Mint a staff session cookie the way `src/lib/auth.ts` actually builds it (`buildSessionCookieValue('frontdesk', 'Test Staff')`, `SESSION_SECRET` from `.env.local`) for the front-desk side: real login-equivalent request, real `POST /api/front-desk/check-in` via the UI (or `curl`/`fetch` against the real route) confirming a `queueTicketNumber` comes back and the modal displays it. Separately, hit `/display/queue` with no cookie at all (confirms no session requirement), enter a wrong PIN (confirms rejection/re-prompt), set the real PIN via the admin settings UI or `PUT /api/settings/queue-display-pin`, enter it (confirms the board renders), and confirm the ticket created above appears under "Waiting". Paste actual commands and actual output in the report — never a narrated, unreproduced claim (standing rule this session, see Global Constraints).

- [ ] **Step 5: Run the full suite once**

Run: `npx dotenv -e .env.local -- npx vitest run`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/app/display/queue/page.tsx src/components/CheckInModal.tsx
git commit -m "$(cat <<'EOF'
feat: add PIN-gated /display/queue lobby screen and front-desk ticket confirmation

EOF
)"
```
