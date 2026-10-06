# Public Booking Widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Clinsync a genuinely public, unauthenticated appointment-request path — a `bookingRequests` table, a rate-limited public submission endpoint, a staff queue to confirm (creating a real `appointments` row) or decline each request, and a public `/book` widget page with no app chrome.

**Architecture:** `bookingRequests` is a standalone table with no FK to `patients` — an anonymous submitter isn't a patient yet (see spec §2), so it can never be confused with a real, clinically-trusted `appointments` row. The public submission route (`POST /api/public/booking-requests`) is the one write path in this app with genuinely no `requireSession()` call. Staff-side confirm/decline routes are ordinary authenticated, role-gated, conditional-UPDATE-guarded transitions, matching this codebase's established status-machine pattern (Front Desk assignments, MAR, lab orders). Confirming is the only place a `bookingRequests` row and a real `appointments` row ever touch, and it reuses the existing `appointments` conflict-check rather than inventing a second one.

**Tech Stack:** Next.js 16 App Router (Server Components) + Drizzle ORM over a `pg` Pool (additive-only schema changes via a hand-written one-off script, never `drizzle-kit push`) + `@base-ui/react` Dialog primitive + Tailwind v4 oklch tokens + `@upstash/ratelimit`.

**Spec:** `docs/superpowers/specs/2026-09-28-public-booking-widget.md`

**Working directory note:** this plan is executed in an isolated git worktree at `/Users/k2a/Desktop/clinsync/.worktrees/public-booking` on branch `feature/public-booking`. This worktree has its own `.env.local` and `node_modules` already set up. Every implementer/reviewer dispatch for this plan must work from this exact directory, not the main checkout — the main checkout and other worktrees (`.worktrees/lab-orders-results`, `.worktrees/pharmacy-med-inventory`, `.worktrees/queue-display`, etc.) have their own concurrent work in flight; do not touch them.

## Global Constraints

- Additive-only schema changes: this plan adds one brand-new table (`booking_requests`) and one new enum, and modifies zero existing tables/columns. Apply via a hand-written one-off script run with `npx dotenv -e .env.local -- npx tsx <script>` — never `drizzle-kit push`. This is a **single shared Neon Postgres database across every branch/worktree** — a schema mistake here is visible everywhere immediately, including the main checkout and every other active worktree. (This session already had a real incident where a `NOT NULL` column with no default was added to an *existing* shared table and broke every other worktree — this task carries none of that specific risk since it's a new table, but the discipline — verify before/after, never touch an existing table's columns — applies regardless.)
- `psql` is not installed in this environment — verify a migration's live-DB effect with a Node script using `pg`'s `Pool` and an `information_schema.columns` query.
- Every write route uses `.strict()` Zod validation — including the public route.
- Every state-changing *staff* route calls `logAudit(session, <action>, <patientId or null>)`. The public submission route has no session to attribute an audit entry to and does not call `logAudit` — `logAudit` requires a real, non-null `Session` by its own type signature (see `src/lib/audit.ts`), which is a deliberate compile-time guard against fabricating a role for an unauthenticated request.
- Every protected route/page starts with `requireSession()` (API routes) or `requireSessionOrRedirect()` (pages) as its first statement — **except** `POST /api/public/booking-requests` and the `/book` page, which must call neither. These are the only two surfaces in this app meant to be reached with no session at all.
- Role gating per spec §6: submit a request = anyone, unauthenticated. View the booking requests queue = admin, pi, crc, frontdesk. Confirm/decline (write) = admin, crc, frontdesk — **not pi**.
- Status transitions are conditional UPDATEs guarded by current status in the `WHERE` clause (`WHERE id = ? AND status = 'pending'`), never a read-then-write — matching this codebase's established conditional-transition-guard pattern (MAR's `administerMedication`, ADT admission/discharge, the lab-orders and pharmacy plans' transition functions).
- Commit messages end with no attribution trailer.
- UI verification discipline: verify via a real running dev server hit with real HTTP requests, with actual commands and actual output pasted in the report — never a narrated, unreproduced claim (this session has a standing rule against this after a prior implementer fabricated evidence). For the `/book` page and the public route specifically, verification must use **no session cookie at all** — that absence is the actual thing being tested. For the staff queue page/routes, mint a session cookie the way `src/lib/auth.ts` actually does it (`SignJWT` under cookie `clinsync_demo_session`, secret from `SESSION_SECRET`).
- Vitest invocation: `npx dotenv -e .env.local -- npx vitest run <path>` (`fileParallelism: false`).

## Review Focus

1. **Two concurrent confirm/decline calls (or a decline after a confirm) racing on the same booking request** — both `confirmBookingRequest` and `declineBookingRequest` must be single conditional UPDATEs keyed on `WHERE status = 'pending'`, so only one of two racing calls can resolve a request; the loser gets 409, not a duplicated appointment or an overwritten decline reason. (Task 3)
2. **A `pi` session viewing the queue (allowed, per spec §6) but calling confirm/decline directly (must be rejected)** — the read/write role split is asymmetric, and a test must confirm `pi` gets 403 from both write routes while succeeding on the read path, not one role list reused across GET and PATCH. (Task 3)
3. **Confirming a booking request into a provider/time slot that already has a real scheduled appointment** — the confirm route must run the same `hasSchedulingConflict` check `POST /api/appointments` and the assignment-schedule route already use, and reject with 409 rather than creating a double-booked `appointments` row. (Task 3)
4. **An anonymous public submission with a `preferredProviderId` that doesn't reference a real `providers` row** (a forged or stale integer — the one field on this form an anonymous caller controls that's a raw FK) — the public route must validate it before insert, not trust an anonymous integer straight into the table. (Task 2)
5. **The stored `bookingRequests` row containing only the spec's exact field list** — no accidental extra PHI or request metadata (IP, user-agent, etc.) ever gets persisted from the one write path in this app with no auth in front of it. (Task 2)

---

### Task 1: Schema — `booking_request_status`, `booking_requests`

**Files:**
- Modify: `src/db/schema.ts`
- Test: `tests/db/booking-requests-schema.test.ts`

**Interfaces:**
- Produces: `bookingRequestStatusEnum`, `bookingRequests` table (`id, requesterName, requesterDob, requesterEmail, requesterPhone, preferredProviderId, preferredDateRangeStart, preferredDateRangeEnd, reason, status, submittedAt, reviewedByName, reviewedAt, declineReason, resultingAppointmentId`). Consumed by Tasks 2-4.

- [ ] **Step 1: Write the failing test**

Create `tests/db/booking-requests-schema.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { providers, bookingRequests } from '@/db/schema'

const createdIds: number[] = []
afterEach(async () => {
  while (createdIds.length > 0) await getDb().delete(bookingRequests).where(eq(bookingRequests.id, createdIds.pop()!))
})

describe('booking requests schema', () => {
  it('inserts a request with no provider preference and sane defaults', async () => {
    const db = getDb()
    const [row] = await db.insert(bookingRequests).values({
      requesterName: 'Jordan Rivera',
      requesterDob: '1990-05-14',
      requesterEmail: 'jordan@example.com',
      requesterPhone: null,
      preferredProviderId: null,
      preferredDateRangeStart: '2026-10-01',
      preferredDateRangeEnd: '2026-10-15',
      reason: 'New patient intake',
    }).returning()
    createdIds.push(row.id)

    expect(row.status).toBe('pending')
    expect(row.submittedAt).toBeTruthy()
    expect(row.reviewedByName).toBeNull()
    expect(row.reviewedAt).toBeNull()
    expect(row.declineReason).toBeNull()
    expect(row.resultingAppointmentId).toBeNull()
  })

  it('stores a preferredProviderId referencing a real provider', async () => {
    const db = getDb()
    const [providerRow] = await db.select().from(providers).limit(1)
    const [row] = await db.insert(bookingRequests).values({
      requesterName: 'Sam Lee',
      requesterDob: '1985-02-20',
      requesterEmail: null,
      requesterPhone: '555-0100',
      preferredProviderId: providerRow.id,
      preferredDateRangeStart: '2026-10-01',
      preferredDateRangeEnd: '2026-10-15',
      reason: 'Follow-up',
    }).returning()
    createdIds.push(row.id)
    expect(row.preferredProviderId).toBe(providerRow.id)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/booking-requests-schema.test.ts`
Expected: FAIL — `bookingRequests` doesn't exist / not exported.

- [ ] **Step 3: Add the schema definitions**

In `src/db/schema.ts`, add after the `appointments` table definition (so `providers` and `appointments` are already in scope for the reader, even though Drizzle's `references(() => ...)` closures don't strictly require declaration order):

```ts
export const bookingRequestStatusEnum = pgEnum('booking_request_status', ['pending', 'confirmed', 'declined'])

export const bookingRequests = pgTable('booking_requests', {
  id: serial('id').primaryKey(),
  requesterName: text('requester_name').notNull(),
  requesterDob: date('requester_dob').notNull(),
  requesterEmail: text('requester_email'),
  requesterPhone: text('requester_phone'),
  preferredProviderId: integer('preferred_provider_id').references(() => providers.id),
  preferredDateRangeStart: date('preferred_date_range_start').notNull(),
  preferredDateRangeEnd: date('preferred_date_range_end').notNull(),
  reason: text('reason').notNull(),
  status: bookingRequestStatusEnum('status').default('pending').notNull(),
  submittedAt: timestamp('submitted_at').defaultNow().notNull(),
  reviewedByName: text('reviewed_by_name'),
  reviewedAt: timestamp('reviewed_at'),
  declineReason: text('decline_reason'),
  resultingAppointmentId: integer('resulting_appointment_id').references(() => appointments.id),
})
```

- [ ] **Step 4: Run the test again — expect a different failure**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/booking-requests-schema.test.ts`
Expected: FAIL — now a runtime DB error (relation does not exist), not an import error.

- [ ] **Step 5: Write and run the one-off migration script**

Scratch, not part of the repo. Create `migrate-booking-requests-scratch.ts` at this worktree's root (`/Users/k2a/Desktop/clinsync/.worktrees/public-booking`):

```ts
import { Pool } from 'pg'

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false } })

  await pool.query(`DO $$ BEGIN CREATE TYPE booking_request_status AS ENUM ('pending', 'confirmed', 'declined'); EXCEPTION WHEN duplicate_object THEN null; END $$;`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS booking_requests (
      id SERIAL PRIMARY KEY,
      requester_name TEXT NOT NULL,
      requester_dob DATE NOT NULL,
      requester_email TEXT,
      requester_phone TEXT,
      preferred_provider_id INTEGER REFERENCES providers(id),
      preferred_date_range_start DATE NOT NULL,
      preferred_date_range_end DATE NOT NULL,
      reason TEXT NOT NULL,
      status booking_request_status NOT NULL DEFAULT 'pending',
      submitted_at TIMESTAMP NOT NULL DEFAULT now(),
      reviewed_by_name TEXT,
      reviewed_at TIMESTAMP,
      decline_reason TEXT,
      resulting_appointment_id INTEGER REFERENCES appointments(id)
    )
  `)

  console.log('Booking requests schema migration complete.')
  await pool.end()
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1) })
```

Run: `npx dotenv -e .env.local -- npx tsx migrate-booking-requests-scratch.ts`. If blocked by the permission classifier: stop, report it, do not retry with variations.

Verify with a Node script (no `psql` here): `SELECT column_name FROM information_schema.columns WHERE table_name = 'booking_requests'`.

Delete the scratch script once confirmed: `rm migrate-booking-requests-scratch.ts`.

- [ ] **Step 6: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/booking-requests-schema.test.ts`
Expected: PASS (both tests).

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts tests/db/booking-requests-schema.test.ts
git commit -m "$(cat <<'EOF'
feat: add booking_requests table and status enum

EOF
)"
```

---

### Task 2: Rate limiting + public submission route

**Files:**
- Modify: `src/lib/rate-limit.ts` (add `checkBookingRequestRateLimit`)
- Modify: `tests/lib/rate-limit.test.ts` (add its test block)
- Create: `src/lib/queries/booking-requests.ts` (`createBookingRequest`)
- Create: `src/app/api/public/booking-requests/route.ts` (POST — unauthenticated)
- Test: `tests/lib/queries/booking-requests.test.ts`, `tests/api/public-booking-requests.test.ts`

**Interfaces:**
- Consumes: `bookingRequests`, `bookingRequestStatusEnum`, `providers` from `@/db/schema` (Task 1); `getRedis` from `@/lib/cache` (existing, used by every other limiter in `rate-limit.ts`).
- Produces: `checkBookingRequestRateLimit(ip: string): Promise<{ allowed: boolean }>` from `@/lib/rate-limit`; `createBookingRequest(input: CreateBookingRequestInput): Promise<BookingRequestRow>` from `@/lib/queries/booking-requests` — consumed by Task 4 (the `/book` page's form posts to the route this task creates, not to this function directly, but Task 3's `listBookingRequests`/`confirmBookingRequest`/`declineBookingRequest` are added to this same file).

- [ ] **Step 1: Write the failing test — rate limiter**

Add a `describe('checkBookingRequestRateLimit', ...)` block to `tests/lib/rate-limit.test.ts`, importing `checkBookingRequestRateLimit` alongside the file's existing imports. Every other dual-bucket function in this file is keyed on `(ip, identity)`, with a fixed literal test IP reused across tests made safe only because it's always paired with a freshly-randomized identity (`Date.now()`/`Math.random()`) — see the existing blocks. `checkBookingRequestRateLimit` takes **only** `ip` (there is no persistent identity for an anonymous submitter before they submit), so its per-IP bucket has no identity to make each test's key fresh. To avoid a fixed test IP permanently exhausting its own bucket across repeated suite runs within the same window, generate a fresh, unique-looking IP string per test (e.g. `` `198.51.100.${Date.now() % 250}` `` or similar — it is only ever used as a Redis key, not a routable address, so this is safe) instead of reusing a literal constant IP the way the other blocks do:

```ts
describe('checkBookingRequestRateLimit', () => {
  it('allows the first few attempts for a fresh ip', async () => {
    const ip = `198.51.100.${Date.now() % 250}`
    const first = await checkBookingRequestRateLimit(ip)
    expect(first.allowed).toBe(true)
  })

  it('blocks after the per-IP window is exhausted for one ip', async () => {
    const ip = `198.51.101.${Date.now() % 250}`
    for (let i = 0; i < 3; i++) {
      const { allowed } = await checkBookingRequestRateLimit(ip)
      expect(allowed).toBe(true)
    }
    const fourth = await checkBookingRequestRateLimit(ip)
    expect(fourth.allowed).toBe(false)
  })

  it('eventually blocks under sustained submissions spread across many source IPs, via the identity-independent global bucket', async () => {
    // Unlike every other limiter in this file, there is no persistent
    // identity to peg a global bucket to for an anonymous submitter -- so
    // this global bucket is a genuinely flat, shared cap on total booking
    // submissions regardless of source IP, defending against a botnet
    // rotating (or spoofing) addresses to dodge the per-IP bucket above.
    // Because that flat key is real shared state that can carry a small
    // remainder across repeated test runs within the same window, this
    // asserts the deterministic property -- saturating it with more calls
    // than its cap can ever hold -- rather than a specific call index.
    const results: boolean[] = []
    for (let i = 0; i < 25; i++) {
      const { allowed } = await checkBookingRequestRateLimit(`203.0.${113 + (i % 5)}.${i}`)
      results.push(allowed)
    }
    expect(results.some((allowed) => allowed === false)).toBe(true)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/rate-limit.test.ts`
Expected: FAIL — `checkBookingRequestRateLimit` not exported.

- [ ] **Step 3: Implement `checkBookingRequestRateLimit` in `src/lib/rate-limit.ts`**

Follow the file's exact existing dual-bucket shape (`_xLimiter`/`getXLimiter()` lazy singletons, same `Ratelimit.slidingWindow` construction). Per-IP bucket: `Ratelimit.slidingWindow(3, '300 s')`, prefix `'ratelimit:booking-request'`, keyed on `ip` alone. Global bucket: `Ratelimit.slidingWindow(20, '600 s')`, prefix `'ratelimit:booking-request-global'`, keyed on a single fixed string (e.g. `'global'`) — tighter than login's 5-per-60s per the spec ("a lower-frequency legitimate action; nobody submits multiple real booking requests per minute"), reflecting that this endpoint has no credential-guessing identity to defend, only submission volume. Add a comment explaining this (why the global bucket has no per-identity key, unlike every other function in this file) matching the file's established comment density.

```ts
export async function checkBookingRequestRateLimit(ip: string): Promise<{ allowed: boolean }> {
  const [perIp, global] = await Promise.all([
    getBookingRequestLimiter().limit(ip),
    getBookingRequestGlobalLimiter().limit('global'),
  ])
  return { allowed: perIp.success && global.success }
}
```

- [ ] **Step 4: Run the rate-limit test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/rate-limit.test.ts`
Expected: PASS (including the new block).

- [ ] **Step 5: Commit**

```bash
git add src/lib/rate-limit.ts tests/lib/rate-limit.test.ts
git commit -m "$(cat <<'EOF'
feat: add checkBookingRequestRateLimit dual-bucket limiter

EOF
)"
```

- [ ] **Step 6: Write the failing test — query layer**

Create `tests/lib/queries/booking-requests.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { bookingRequests } from '@/db/schema'
import { createBookingRequest } from '@/lib/queries/booking-requests'

const createdIds: number[] = []
afterEach(async () => {
  while (createdIds.length > 0) await getDb().delete(bookingRequests).where(eq(bookingRequests.id, createdIds.pop()!))
})

describe('createBookingRequest', () => {
  it('inserts a pending request with only the given fields set', async () => {
    const row = await createBookingRequest({
      requesterName: 'Alex Chen',
      requesterDob: '1992-08-01',
      requesterEmail: 'alex@example.com',
      requesterPhone: null,
      preferredProviderId: null,
      preferredDateRangeStart: '2026-11-01',
      preferredDateRangeEnd: '2026-11-10',
      reason: 'Initial consult',
    })
    createdIds.push(row.id)
    expect(row.status).toBe('pending')
    expect(row.reviewedByName).toBeNull()
    expect(row.resultingAppointmentId).toBeNull()
  })
})
```

- [ ] **Step 7: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/booking-requests.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 8: Implement `src/lib/queries/booking-requests.ts`**

```ts
import { getDb } from '@/db/client'
import { bookingRequests } from '@/db/schema'

export interface CreateBookingRequestInput {
  requesterName: string
  requesterDob: string
  requesterEmail: string | null
  requesterPhone: string | null
  preferredProviderId: number | null
  preferredDateRangeStart: string
  preferredDateRangeEnd: string
  reason: string
}

export async function createBookingRequest(input: CreateBookingRequestInput) {
  const [created] = await getDb().insert(bookingRequests).values(input).returning()
  return created
}
```

- [ ] **Step 9: Run the query test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/booking-requests.test.ts`
Expected: PASS.

- [ ] **Step 10: Write the failing test — public route**

Create `tests/api/public-booking-requests.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { POST as submitBookingRequest } from '@/app/api/public/booking-requests/route'
import { getDb } from '@/db/client'
import { providers, bookingRequests } from '@/db/schema'

const createdIds: number[] = []
afterEach(async () => {
  while (createdIds.length > 0) await getDb().delete(bookingRequests).where(eq(bookingRequests.id, createdIds.pop()!))
})

function req(body: unknown, ip = '192.0.2.1') {
  return new Request('http://localhost/api/public/booking-requests', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
  })
}

const validPayload = {
  requesterName: 'Taylor Morgan',
  requesterDob: '1988-03-12',
  requesterEmail: 'taylor@example.com',
  preferredDateRangeStart: '2026-11-01',
  preferredDateRangeEnd: '2026-11-15',
  reason: 'New patient intake',
}

describe('POST /api/public/booking-requests', () => {
  it('accepts a valid unauthenticated submission with no session', async () => {
    const res = await submitBookingRequest(req(validPayload, '192.0.2.10') as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    createdIds.push(body.id)
  })

  it('rejects extra fields via .strict()', async () => {
    const res = await submitBookingRequest(req({ ...validPayload, patientId: 'RD-0001' }, '192.0.2.11') as never)
    expect(res.status).toBe(400)
  })

  it('rejects a preferredProviderId that does not reference a real provider', async () => {
    const res = await submitBookingRequest(req({ ...validPayload, preferredProviderId: 999999999 }, '192.0.2.12') as never)
    expect(res.status).toBe(400)
  })

  it('stores only the spec-listed fields -- no extra PHI or request metadata persisted', async () => {
    const res = await submitBookingRequest(req(validPayload, '192.0.2.13') as never)
    const body = await res.json()
    createdIds.push(body.id)
    const [row] = await getDb().select().from(bookingRequests).where(eq(bookingRequests.id, body.id))
    expect(row.requesterName).toBe(validPayload.requesterName)
    expect(row.requesterPhone).toBeNull()
    expect(row.preferredProviderId).toBeNull()
    expect(row.status).toBe('pending')
    expect(row.reviewedByName).toBeNull()
    expect(row.reviewedAt).toBeNull()
    expect(row.declineReason).toBeNull()
    expect(row.resultingAppointmentId).toBeNull()
    expect(Object.keys(row).sort()).toEqual([
      'declineReason', 'id', 'preferredDateRangeEnd', 'preferredDateRangeStart', 'preferredProviderId',
      'reason', 'requesterDob', 'requesterEmail', 'requesterName', 'requesterPhone',
      'resultingAppointmentId', 'reviewedAt', 'reviewedByName', 'status', 'submittedAt',
    ].sort())
  })

  it('enforces the rate limit after enough requests from one IP', async () => {
    const ip = '192.0.2.20'
    let lastStatus = 0
    for (let i = 0; i < 4; i++) {
      const res = await submitBookingRequest(req({ ...validPayload, requesterEmail: `rl-${i}@example.com` }, ip) as never)
      lastStatus = res.status
      if (res.status === 201) createdIds.push((await res.json()).id)
    }
    expect(lastStatus).toBe(429)
  })
})
```

- [ ] **Step 11: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/public-booking-requests.test.ts`
Expected: FAIL — route doesn't exist.

- [ ] **Step 12: Implement `src/app/api/public/booking-requests/route.ts`**

No `requireSession()` call anywhere in this file — that absence is the point. Define its own local `getClientIp(request)` copy, matching the exact duplicated-per-file convention already used in `src/app/api/login/route.ts` and every other route that needs it (this codebase does not share a single `getClientIp` helper across routes; don't introduce one here either).

```ts
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDb } from '@/db/client'
import { providers } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { checkBookingRequestRateLimit } from '@/lib/rate-limit'
import { createBookingRequest } from '@/lib/queries/booking-requests'

function getClientIp(request: NextRequest): string {
  const forwardedFor = request.headers.get('x-forwarded-for')
  if (forwardedFor) return forwardedFor.split(',')[0].trim()
  return request.headers.get('x-real-ip') ?? 'unknown'
}

const bookingRequestSchema = z.object({
  requesterName: z.string().min(1),
  requesterDob: z.string().min(1),
  requesterEmail: z.string().email().optional(),
  requesterPhone: z.string().min(1).optional(),
  preferredProviderId: z.number().int().positive().optional(),
  preferredDateRangeStart: z.string().min(1),
  preferredDateRangeEnd: z.string().min(1),
  reason: z.string().min(1),
}).strict()

export async function POST(request: NextRequest) {
  const ip = getClientIp(request)
  const { allowed } = await checkBookingRequestRateLimit(ip)
  if (!allowed) return NextResponse.json({ error: 'Too many requests. Please try again later.' }, { status: 429 })

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const parsed = bookingRequestSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid booking request payload', details: parsed.error.flatten() }, { status: 400 })

  const start = new Date(parsed.data.preferredDateRangeStart)
  const end = new Date(parsed.data.preferredDateRangeEnd)
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) {
    return NextResponse.json({ error: 'preferredDateRangeEnd must be on or after preferredDateRangeStart' }, { status: 400 })
  }

  if (parsed.data.preferredProviderId !== undefined) {
    const [providerRow] = await getDb().select().from(providers).where(eq(providers.id, parsed.data.preferredProviderId))
    if (!providerRow) return NextResponse.json({ error: 'preferredProviderId does not reference a real provider' }, { status: 400 })
  }

  const created = await createBookingRequest({
    requesterName: parsed.data.requesterName,
    requesterDob: parsed.data.requesterDob,
    requesterEmail: parsed.data.requesterEmail ?? null,
    requesterPhone: parsed.data.requesterPhone ?? null,
    preferredProviderId: parsed.data.preferredProviderId ?? null,
    preferredDateRangeStart: parsed.data.preferredDateRangeStart,
    preferredDateRangeEnd: parsed.data.preferredDateRangeEnd,
    reason: parsed.data.reason,
  })

  return NextResponse.json({ id: created.id }, { status: 201 })
}
```

- [ ] **Step 13: Run all this task's tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/rate-limit.test.ts tests/lib/queries/booking-requests.test.ts tests/api/public-booking-requests.test.ts`
Expected: PASS.

- [ ] **Step 14: Commit**

```bash
git add src/lib/queries/booking-requests.ts src/app/api/public tests/lib/queries/booking-requests.test.ts tests/api/public-booking-requests.test.ts
git commit -m "$(cat <<'EOF'
feat: add unauthenticated public booking request submission route

EOF
)"
```

---

### Task 3: Staff confirm/decline routes + queue UI

**Files:**
- Modify: `src/lib/queries/booking-requests.ts` (add `listBookingRequests`, `confirmBookingRequest`, `declineBookingRequest`)
- Create: `src/app/api/booking-requests/[id]/confirm/route.ts` (PATCH)
- Create: `src/app/api/booking-requests/[id]/decline/route.ts` (PATCH)
- Create: `src/components/BookingRequestsQueue.tsx`
- Create: `src/components/ConfirmBookingRequestModal.tsx`
- Create: `src/components/DeclineBookingRequestModal.tsx`
- Create: `src/app/(dashboard)/booking-requests/page.tsx`
- Modify: `src/components/LeftNav.tsx` (add a nav entry)
- Modify: `src/lib/role-capabilities.ts`
- Test: `tests/api/booking-requests-confirm.test.ts` (route-level tests only; UI verified per Global Constraints' UI verification discipline)

**Interfaces:**
- Consumes: `bookingRequests`, `appointments` from `@/db/schema` (Task 1, existing); `hasSchedulingConflict` from `@/lib/queries/appointments` (existing — see `src/app/api/appointments/route.ts`); `createBookingRequest` (Task 2, unused by this task but shares the file).
- Produces: `listBookingRequests()`, `confirmBookingRequest(id, input)`, `declineBookingRequest(id, input)` from `@/lib/queries/booking-requests` — consumed by the queue page and the two PATCH routes below.

- [ ] **Step 1: Read the existing appointment-creation and queue-UI precedents**

Read `src/app/api/appointments/route.ts` (already read for this plan — `hasSchedulingConflict` guards a 409 before the `appointments` insert, and the insert shape is `{ patientId, providerId, startsAt, endsAt, visitReason, status: 'scheduled' }`) and `src/app/(dashboard)/front-desk/assignments/page.tsx` plus `src/components/AssignmentStatusChip.tsx` (the table-with-status-chip queue pattern this task's `/booking-requests` page follows). Match both exactly rather than inventing new shapes.

- [ ] **Step 2: Write the failing tests — query layer + routes**

Add to `tests/lib/queries/booking-requests.test.ts` (same file as Task 2's test, same `createdIds` cleanup array — also track any `appointments` rows created and delete them in `afterEach`):

- `confirmBookingRequest` on a `pending` request with a conflict-free `providerId`/`startsAt`/`endsAt` and a real `patientId`: returns `{ ok: true, appointmentId }`, creates a real `appointments` row with that `patientId`/`providerId`/`startsAt`/`endsAt`, and sets the booking request's `status` to `'confirmed'` and `resultingAppointmentId` to the new appointment's id (Review Focus item this task owns via the assertion, not a separate test).
- `confirmBookingRequest` called twice in sequence on the same request: the second call returns `{ ok: false }` and does not create a second `appointments` row (Review Focus #1).
- `confirmBookingRequest` when the provider already has a conflicting `appointments` row for that exact window: returns `{ ok: false }` and does not mutate the booking request's status (Review Focus #3).
- `declineBookingRequest` on a `pending` request: returns `{ ok: true }`, sets `status` to `'declined'` and `declineReason`, and never creates an `appointments` row.
- `declineBookingRequest` on an already-`confirmed` or already-`declined` request: returns `{ ok: false }` (Review Focus #1).

Create `tests/api/booking-requests-confirm.test.ts` covering the route level, using the `vi.mock('@/lib/auth', ...)` pattern already established in `tests/api/pharmacy-dispense.test.ts` (sibling Pharmacy plan) for mocking `requireSession()`:
- `admin`/`crc`/`frontdesk` sessions can call both `PATCH .../confirm` and `PATCH .../decline` successfully.
- a `pi` session gets 403 from both routes (Review Focus #2).
- confirming (or declining) an already-resolved (`confirmed` or `declined`) request returns 409, not a silent no-op or a second write (Review Focus #1).

- [ ] **Step 3: Run them to confirm they fail**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/booking-requests.test.ts tests/api/booking-requests-confirm.test.ts`
Expected: FAIL — new functions/routes don't exist.

- [ ] **Step 4: Implement the query-layer additions in `src/lib/queries/booking-requests.ts`**

```ts
import { getDb } from '@/db/client'
import { bookingRequests, appointments } from '@/db/schema'
import { and, desc, eq } from 'drizzle-orm'
import { hasSchedulingConflict } from '@/lib/queries/appointments'

export async function listBookingRequests() {
  return getDb().select().from(bookingRequests).orderBy(desc(bookingRequests.submittedAt))
}

export interface ConfirmBookingRequestInput {
  patientId: string
  providerId: number
  startsAt: Date
  endsAt: Date
  visitReason: string
  reviewedByName: string
}

export interface BookingRequestActionResult {
  ok: boolean
  error?: string
  appointmentId?: number
}

// Order matters and is deliberate: check the real scheduling conflict
// first (no DB write either way), then the conditional UPDATE guarding the
// pending->confirmed transition (WHERE status = 'pending' -- only one of
// two racing calls can win it), and only create the real appointments row
// -- and point resultingAppointmentId at it -- after that UPDATE actually
// succeeded. This codebase has no established db.transaction() convention
// (see the lab-orders and pharmacy plans' own UPDATE-then-insert ordering),
// so ordering the writes this way, rather than wrapping them, is what keeps
// a losing/racing caller from ever creating an orphaned appointment.
export async function confirmBookingRequest(id: number, input: ConfirmBookingRequestInput): Promise<BookingRequestActionResult> {
  const db = getDb()

  if (await hasSchedulingConflict(input.providerId, input.startsAt, input.endsAt)) {
    return { ok: false, error: 'This provider already has an appointment during that time.' }
  }

  const updated = await db.update(bookingRequests)
    .set({ status: 'confirmed', reviewedByName: input.reviewedByName, reviewedAt: new Date() })
    .where(and(eq(bookingRequests.id, id), eq(bookingRequests.status, 'pending')))
    .returning({ id: bookingRequests.id })
  if (updated.length === 0) return { ok: false, error: 'This request has already been resolved.' }

  const [appointment] = await db.insert(appointments).values({
    patientId: input.patientId,
    providerId: input.providerId,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    visitReason: input.visitReason,
    status: 'scheduled',
  }).returning()

  await db.update(bookingRequests).set({ resultingAppointmentId: appointment.id }).where(eq(bookingRequests.id, id))

  return { ok: true, appointmentId: appointment.id }
}

export async function declineBookingRequest(id: number, input: { reason: string; reviewedByName: string }): Promise<BookingRequestActionResult> {
  const updated = await getDb().update(bookingRequests)
    .set({ status: 'declined', declineReason: input.reason, reviewedByName: input.reviewedByName, reviewedAt: new Date() })
    .where(and(eq(bookingRequests.id, id), eq(bookingRequests.status, 'pending')))
    .returning({ id: bookingRequests.id })
  if (updated.length === 0) return { ok: false, error: 'This request has already been resolved.' }
  return { ok: true }
}
```

- [ ] **Step 5: Run the query-layer tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/booking-requests.test.ts`
Expected: PASS.

- [ ] **Step 6: Implement the two PATCH routes**

`src/app/api/booking-requests/[id]/confirm/route.ts` — role gate `['admin', 'crc', 'frontdesk']` (not `pi`), body `.strict()` Zod: `{ patientId: z.string().min(1), providerId: z.number().int().positive(), startsAt: z.string().min(1), endsAt: z.string().min(1), visitReason: z.string().min(1) }`. Parse and validate `startsAt`/`endsAt` the same way `POST /api/appointments` does (valid dates, `endsAt` after `startsAt`, 400 otherwise). Call `confirmBookingRequest(id, { ...parsed.data, startsAt, endsAt, reviewedByName: session.name })`. On `{ ok: false }`, return 409. On success, `logAudit(session, 'confirmed booking request', parsed.data.patientId)`, return 200 with the result.

`src/app/api/booking-requests/[id]/decline/route.ts` — same role gate, body `.strict()` Zod `{ reason: z.string().min(1) }`. Call `declineBookingRequest(id, { reason: parsed.data.reason, reviewedByName: session.name })`. On `{ ok: false }`, return 409. On success, `logAudit(session, 'declined booking request', null)` (no patient is linked to a declined request), return 200.

Both routes: parse `id` from `params` as `Number(id)`, return 400 if not an integer; return 404 first if `listBookingRequests()`/a direct lookup shows no row with that id (implementer's call whether to add a small `getBookingRequestById` helper or reuse `listBookingRequests` — either is fine, just don't skip the 404 case).

- [ ] **Step 7: Run all this task's tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/booking-requests.test.ts tests/api/booking-requests-confirm.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit the routes and query layer**

```bash
git add src/lib/queries/booking-requests.ts src/app/api/booking-requests tests/lib/queries/booking-requests.test.ts tests/api/booking-requests-confirm.test.ts
git commit -m "$(cat <<'EOF'
feat: add staff confirm/decline routes for booking requests

EOF
)"
```

- [ ] **Step 9: Build the queue page and list component**

Create `src/app/(dashboard)/booking-requests/page.tsx` as a Server Component: `requireSessionOrRedirect()` first, redirect to `/` if `session.role` isn't one of `['admin', 'pi', 'crc', 'frontdesk']` (the read tier — wider than the write tier), fetch `listBookingRequests()` and `listActiveProviders()` directly (Server Components call the query layer directly, never their own API routes), `logAudit(session, 'viewed booking requests', null)`, render `<BookingRequestsQueue requests={...} providers={...} canResolve={['admin','crc','frontdesk'].includes(session.role)} />`.

Create `src/components/BookingRequestsQueue.tsx` (`'use client'`): a table matching the Front Desk assignments page's shape (requester name/DOB, preferred provider or "No preference", preferred date range, reason, a status chip, submitted date) with "Confirm"/"Decline" actions per `pending` row, rendered only when `canResolve` — opening `ConfirmBookingRequestModal`/`DeclineBookingRequestModal`. Resolved rows (`confirmed`/`declined`) show their outcome (decline reason, or a link/reference to the resulting appointment) and no action buttons, matching this codebase's "never color alone" status-pill convention.

- [ ] **Step 10: Build the two action modals**

Create `src/components/ConfirmBookingRequestModal.tsx` (`'use client'`), following the `TransferAdmissionModal.tsx` Dialog-modal-with-fetch shape: a `patientId` text input (matches the simple text-input pattern `EligibilityCheckModal.tsx`/`DispenseMedicationModal.tsx` already use for patient lookup — no patient-autocomplete component exists in this codebase, don't invent one; this is also where the spec's "staff registers a genuinely new patient through the existing Add Client flow first, then confirms against the new patient" boundary lives — a short inline note in the modal that a new requester needs to be added as a client first before their `patientId` exists, not a link to build), a provider `<select>` (pre-filled from the request's `preferredProviderId` if set, editable), `startsAt`/`endsAt` datetime inputs, a `visitReason` input (pre-filled from the request's `reason`, editable) — `PATCH /api/booking-requests/[id]/confirm`, `router.refresh()` on success, inline error display (surface the 409 conflict message from the route directly).

Create `src/components/DeclineBookingRequestModal.tsx` (`'use client'`): a `reason` text input — `PATCH /api/booking-requests/[id]/decline`, `router.refresh()` on success, inline error display.

- [ ] **Step 11: Wire the nav entry and role capabilities**

In `src/components/LeftNav.tsx`, add `{ href: '/booking-requests', label: 'Booking Requests', icon: CalendarClock, roles: ['frontdesk', 'admin', 'crc', 'pi'] as Role[] }` to `ITEMS` (import `CalendarClock` from `lucide-react` alongside the file's other icon imports), matching how `/pharmacy` and `/labs` were added by the sibling plans.

In `src/lib/role-capabilities.ts`, add a bullet to `admin`, `crc`, and `frontdesk`'s `bullets` array: `'Confirm or decline public booking requests into real appointments'`. Add a bullet to `pi`'s `bullets` array: `'View the public booking requests queue (read-only -- confirming/declining is a registration-staff action)'`.

- [ ] **Step 12: Verify via a real running dev server, not narration**

Start the dev server on a free port (e.g. `npx next dev -p <port>`, backgrounded). Mint a staff session cookie the way `src/lib/auth.ts` actually does it. Real GET of `/booking-requests`, confirm the queue renders. Real confirm of a `pending` request (created via a direct `curl` to `POST /api/public/booking-requests` first, or via the query layer), confirm a real `appointments` row now exists and the queue reflects `confirmed`. Real decline of a different pending request, confirm no `appointments` row was created for it. Paste actual commands and actual output. Stop the dev server when done.

- [ ] **Step 13: Commit**

```bash
git add src/components/BookingRequestsQueue.tsx src/components/ConfirmBookingRequestModal.tsx src/components/DeclineBookingRequestModal.tsx "src/app/(dashboard)/booking-requests/page.tsx" src/components/LeftNav.tsx src/lib/role-capabilities.ts
git commit -m "$(cat <<'EOF'
feat: add staff Booking Requests queue with confirm/decline actions

EOF
)"
```

---

### Task 4: Public widget page (`/book`)

**Files:**
- Create: `src/app/book/page.tsx` (Server Component — deliberately outside the `(dashboard)` route group, so it never inherits that group's `layout.tsx`, which itself checks `getSession()` and redirects to `/login`)
- Create: `src/components/PublicBookingForm.tsx`
- Test: none new — verified per Global Constraints' UI verification discipline.

**Interfaces:**
- Consumes: `listActiveProviders()` from `@/lib/queries/providers` (existing), `listAppointmentsInRange()` from `@/lib/queries/appointments` (existing), `POST /api/public/booking-requests` (Task 2, called by URL from the client component, exactly like every other action modal in this codebase).

- [ ] **Step 1: Confirm the route-group boundary**

Read `src/app/layout.tsx` (root layout — no session check, no chrome) and `src/app/(dashboard)/layout.tsx` (checks `getSession()`, redirects to `/login`, renders `TopBanner`/`LeftNav`). Placing this page at `src/app/book/page.tsx` (not under `(dashboard)`) means it only ever inherits the root layout — no session check, no app chrome. Do not add a `requireSession()`/`requireSessionOrRedirect()` call anywhere in this page.

- [ ] **Step 2: Build the page**

Create `src/app/book/page.tsx` as an async Server Component with no session check: fetch `listActiveProviders()` and, for a reasonable display window (e.g. the next 90 days from today), `listAppointmentsInRange(start, end)` directly (Server Components call the query layer directly, per this codebase's established rule) to give the picker a read-only sense of which providers already have appointments on which days in that window. Render `<PublicBookingForm providers={...} existingAppointments={...} />`. No `LeftNav`, no `TopBanner` — a bare page.

- [ ] **Step 3: Build the form component**

Create `src/components/PublicBookingForm.tsx` (`'use client'`): fields for `requesterName`, `requesterDob`, `requesterEmail` (optional), `requesterPhone` (optional), a provider `<select>` (populated from the `providers` prop, plus a "No preference" option mapping to `undefined`), `preferredDateRangeStart`/`preferredDateRangeEnd` date inputs, a `reason` textarea. Use the `existingAppointments` prop only to show a light, read-only hint next to the selected provider (e.g. "N appointments already booked in your selected range") — no exact slot grid; per spec §1, this widget is read-only until submission and never claims to guarantee a slot. On submit, `POST /api/public/booking-requests` with `fetch` (same `.strict()`-shaped body as Task 2's route), handle: `201` → replace the form with a confirmation message ("Your request has been submitted. Our team will contact you to confirm."); `400` → inline field-level error text; `429` → "Too many requests, please try again later." Follow the fetch-and-inline-error shape already established by this codebase's other form components (e.g. `DispenseMedicationModal.tsx`), adapted from a modal to a standalone page.

- [ ] **Step 4: Verify via a real running dev server hit as a genuinely unauthenticated client**

Start the dev server on a free port (e.g. `npx next dev -p <port>`, backgrounded). With `curl`, issue a `GET` to `/book` using **no `Cookie` header at all** and confirm a `200` (not a redirect to `/login`) and that the response body contains the form, not `LeftNav`/`TopBanner` markup. Then issue a real `POST` to `/api/public/booking-requests` with **no `Cookie` header**, a valid JSON body, and confirm `201`. Query the database directly to confirm the row exists. Paste every actual command and actual output — this is the one page in this app where "no auth cookie" is the actual thing under test, not an oversight to fix. Stop the dev server when done.

- [ ] **Step 5: Run the full suite once**

Run: `npx dotenv -e .env.local -- npx vitest run`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/app/book src/components/PublicBookingForm.tsx
git commit -m "$(cat <<'EOF'
feat: add public /book widget page with no app chrome or auth

EOF
)"
```
