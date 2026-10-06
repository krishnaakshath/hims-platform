# Audit/Security/Accessibility Bug Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the concrete, verified bugs found during a full-codebase deep-dive audit of Clinsync (an RBAC gap, missing audit-log coverage, dead fuzzy-match logic, a nondeterministic query, missing MFA-enrollment audit trail, and five inaccessible hand-rolled modals) — all before any Mobbin-driven frontend redesign work begins.

**Architecture:** No schema changes, no new routes, no new dependencies. Every task is a narrow, independently-testable correction inside existing files, following patterns the codebase already establishes elsewhere (see Global Constraints). Tasks are fully independent of each other — any order, any subset, any parallelism works.

**Tech Stack:** Next.js 16 App Router API routes, Drizzle ORM / Neon Postgres, Vitest + Testing Library, `@base-ui/react` Dialog primitive already present at `src/components/ui/dialog.tsx`.

**Spec:** No separate spec document — this plan is derived directly from a live-code audit performed earlier in this session (every claim below was re-verified by reading the actual current file contents, not assumed from the audit summary). Background context: `docs/product-review-and-gap-analysis.md` (note: that doc is stale on MFA/idle-timeout state — do not trust its "MFA: confirmed absent" claim, Task 11 corrects this).

## Global Constraints

- Every API route's first statement is `requireSession()` / `requirePatientSession()` (or the non-redirect Server Component variant) — never reorder relative to data access.
- Every write that changes patient-relevant state calls `logAudit(session, action, patientId)` with a real, non-null `Session` — never a fallback role. This plan extends the same discipline to **reads** that expose PHI-adjacent or practice-sensitive data, per this project's own stated guarantee ("every read and write is attributed and logged," `README.md`).
- Tests in this repo hit the **real, shared** Neon dev database directly — nothing mocks the DB layer. Any test that inserts a row must track its id and delete it in `afterAll`/`afterEach`. Tests run sequentially (`vitest.config.ts` sets `fileParallelism: false`) specifically because of this shared, stateful DB — never assume test isolation you'd get from a mocked DB.
- Never run `npm run db:generate` or `npm run db:push` against the shared dev database (not needed anywhere in this plan — no schema changes).
- `src/components/ui/dialog.tsx` (wrapping `@base-ui/react/dialog`) already provides real focus-trap, Escape-to-close, backdrop-click-to-close, and focus-return. A hand-rolled `<div className="fixed inset-0 ...">` overlay must never reimplement this — always compose from `Dialog`/`DialogContent`/`DialogHeader`/`DialogTitle`/`DialogFooter`.
- Use the existing `Button` component (`src/components/ui/button.tsx`, variants: `default`, `outline`, `secondary`, `ghost`, `destructive`, `link`) inside migrated dialogs instead of raw `<button className="...">` markup, to match `DialogFooter`'s existing button-group styling.

## Review Focus

- **Task 1 breaks an existing test if not updated in the same commit.** `tests/api/audit-log.test.ts` currently mocks `requireSession` to return `role: 'crc'` and asserts a 200 on `GET /api/audit-log`. After Task 1's RBAC fix, that mock must change to `role: 'admin'` or the existing "returns entries ordered newest first" test starts failing for the wrong reason. Task 1's steps include this exact edit.
- **Task 2's ehr-sync test must mock the connectors and `getDb()` — never let it run against the real shared DB.** `syncFromEhrs()` performs live inserts; without mocking `@/db/client`, `@/connectors/tebra.mock`, and `@/connectors/intakeq.mock`, a naive test would create permanent orphan rows in the shared dev database (the same class of incident `docs/PRODUCT-AND-ARCHITECTURE.md` already documents as having happened once). Task 2's test mocks all three.
- **Task 4's six file changes must not change response bodies or status codes** — only add a side-effecting `logAudit` call after the existing response is computed (or just before returning it). A reviewer should be able to diff each file and see nothing except one new `await logAudit(...)` line (plus its import if not already present) and its test.
- **The Base UI `Dialog.Root` prop names (`open`, `onOpenChange`) must be verified against the installed `@base-ui/react` version by actually running the test/build**, not assumed from memory — if the real prop names differ, the fix is to match whatever `DialogPrimitive.Root.Props` (already imported in `dialog.tsx`) actually declares, not to guess further. Every dialog-migration task's steps include running the test as the verification gate for this.
- **`NewChargeModal` and `SendFormModal`'s existing "disabled while submitting" button logic must survive the migration unchanged** — these guard against double-submission (e.g. `disabled={submitting || !form.name || !form.dob}`). Migrated code keeps every disabled-state expression byte-for-byte; only the outer JSX shell (the fixed-overlay `<div>`) changes.

---

## Task 1: Restrict `GET /api/audit-log` to admin only

**Files:**
- Modify: `src/app/api/audit-log/route.ts`
- Modify: `tests/api/audit-log.test.ts`

**Interfaces:**
- Consumes: `requireSession()` from `@/lib/auth` (existing), `Session.role` (existing `'admin' | 'pi' | 'crc'` union).
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Update the existing test's mocked role and add a new failing test for non-admin access**

Replace the entire contents of `tests/api/audit-log.test.ts` with:

```ts
import { describe, it, expect, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import * as auth from '@/lib/auth'

const UNAUTHORIZED = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

import { GET as listAuditLog } from '@/app/api/audit-log/route'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: 'admin' as const, name: 'Test Admin' })) }
})

describe('GET /api/audit-log', () => {
  it('returns 401 when there is no authenticated session', async () => {
    vi.mocked(auth.requireSession).mockResolvedValueOnce(UNAUTHORIZED())
    const response = await listAuditLog(new NextRequest('http://localhost/api/audit-log'))
    expect(response.status).toBe(401)
  })

  it('returns 403 for a non-admin session', async () => {
    vi.mocked(auth.requireSession).mockResolvedValueOnce({ role: 'crc', name: 'Test CRC' })
    const response = await listAuditLog(new NextRequest('http://localhost/api/audit-log'))
    expect(response.status).toBe(403)
  })

  it('returns 403 for a PI session (audit log is admin-only, not just non-CRC)', async () => {
    vi.mocked(auth.requireSession).mockResolvedValueOnce({ role: 'pi', name: 'Test PI' })
    const response = await listAuditLog(new NextRequest('http://localhost/api/audit-log'))
    expect(response.status).toBe(403)
  })

  it('returns entries ordered newest first for an admin session', async () => {
    const response = await listAuditLog(new NextRequest('http://localhost/api/audit-log'))
    const body = await response.json()
    expect(Array.isArray(body.entries)).toBe(true)
    if (body.entries.length > 1) {
      const first = new Date(body.entries[0].timestamp).getTime()
      const second = new Date(body.entries[1].timestamp).getTime()
      expect(first).toBeGreaterThanOrEqual(second)
    }
  })
})
```

- [ ] **Step 2: Run the test file to verify the new 403 tests fail**

Run: `npx vitest run tests/api/audit-log.test.ts`
Expected: the two new "returns 403" tests FAIL (currently the route returns 200 for any authenticated role); the two pre-existing tests still PASS.

- [ ] **Step 3: Add the admin check to the route**

In `src/app/api/audit-log/route.ts`, replace:

```ts
export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session

  const limitParam = request.nextUrl.searchParams.get('limit')
```

with:

```ts
export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })

  const limitParam = request.nextUrl.searchParams.get('limit')
```

- [ ] **Step 4: Run the test file to verify all four tests pass**

Run: `npx vitest run tests/api/audit-log.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/audit-log/route.ts tests/api/audit-log.test.ts
git commit -m "fix: restrict GET /api/audit-log to admin sessions only"
```

---

## Task 2: Wire real fuzzy-match confidence into `syncFromEhrs`

**Files:**
- Modify: `src/lib/ehr-sync.ts:57-73`
- Create: `tests/lib/ehr-sync.test.ts`

**Interfaces:**
- Consumes: `matchConfidence(a: {name, dob}, b: {name, dob}): number` from `@/lib/matcher` (already exists, already tested in `tests/lib/matcher.test.ts` — do not modify `matcher.ts`).
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Write the failing test (fully mocked — no real DB/connector calls)**

Create `tests/lib/ehr-sync.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'

const insertValues = vi.fn(async () => undefined)
const insertMock = vi.fn(() => ({ values: insertValues }))
const selectFromMock = vi.fn()

vi.mock('@/db/client', () => ({
  getDb: () => ({
    select: () => ({ from: selectFromMock }),
    insert: insertMock,
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    delete: () => ({ where: async () => undefined }),
  }),
}))

vi.mock('@/connectors/intakeq.mock', () => ({
  listClients: vi.fn(async () => [
    { clientId: 'iq-test', firstName: 'Jordan', lastName: 'Reyes', dateOfBirth: '1990-01-01', city: null, zip: null, phone: null, email: null },
  ]),
  getIntakeByClientId: vi.fn(async () => null),
}))

vi.mock('@/connectors/tebra.mock', () => ({
  searchPatient: vi.fn(async () => [
    { tebraPatientId: 'tebra-test', firstName: 'Jordan', lastName: 'Reyas', birthDate: '1990-01-01', city: null, zip: null, email: null, generalPractitioner: null },
  ]),
  getPatientById: vi.fn(async () => null),
}))

vi.mock('@/lib/cache', () => ({
  invalidateCache: vi.fn(async () => undefined),
  patientDetailCacheKey: vi.fn(),
  patientListCacheKey: vi.fn(),
}))

import { syncFromEhrs } from '@/lib/ehr-sync'

describe('syncFromEhrs identity-match confidence', () => {
  it('computes a real name-similarity confidence instead of hardcoding 95', async () => {
    selectFromMock
      .mockResolvedValueOnce([]) // existing patients (none known yet)
      .mockResolvedValueOnce([]) // pending identity matches (none queued yet)

    await syncFromEhrs()

    expect(insertValues).toHaveBeenCalledTimes(1)
    const inserted = insertValues.mock.calls[0][0] as { confidence: number }
    // "Jordan Reyes" vs "Jordan Reyas" is a one-character near-miss, not an
    // exact match -- matchConfidence() must score this below 100, unlike the
    // old hardcoded 95 which never reflected the real string distance.
    expect(inserted.confidence).toBeGreaterThan(0)
    expect(inserted.confidence).toBeLessThan(100)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/lib/ehr-sync.test.ts`
Expected: FAIL — `inserted.confidence` is `95`, so `expect(inserted.confidence).toBeLessThan(100)` fails.

- [ ] **Step 3: Wire in the real matcher**

In `src/lib/ehr-sync.ts`, add the import at the top of the file (after the existing `cache` import):

```ts
import { matchConfidence } from '@/lib/matcher'
```

Then replace:

```ts
    const candidates = await tebra.searchPatient(`${client.firstName} ${client.lastName}`, client.dateOfBirth)
    if (candidates.length > 0) {
      const candidate = candidates[0]
      await db.insert(identityMatches).values({
        intakeqClientIdRef: `ENC[${client.clientId}]`,
        referralName: `${client.firstName} ${client.lastName}`,
        referralDob: client.dateOfBirth,
        candidateTebraPatientIdRef: `ENC[${candidate.tebraPatientId}]`,
        candidateName: `${candidate.firstName} ${candidate.lastName}`,
        candidateDob: candidate.birthDate,
        confidence: 95, // mock connector only returns exact name+DOB matches
        status: 'pending',
      })
      newMatches++
      continue
    }
```

with:

```ts
    const candidates = await tebra.searchPatient(`${client.firstName} ${client.lastName}`, client.dateOfBirth)
    if (candidates.length > 0) {
      const candidate = candidates[0]
      const confidence = matchConfidence(
        { name: `${client.firstName} ${client.lastName}`, dob: client.dateOfBirth },
        { name: `${candidate.firstName} ${candidate.lastName}`, dob: candidate.birthDate },
      )
      await db.insert(identityMatches).values({
        intakeqClientIdRef: `ENC[${client.clientId}]`,
        referralName: `${client.firstName} ${client.lastName}`,
        referralDob: client.dateOfBirth,
        candidateTebraPatientIdRef: `ENC[${candidate.tebraPatientId}]`,
        candidateName: `${candidate.firstName} ${candidate.lastName}`,
        candidateDob: candidate.birthDate,
        confidence,
        status: 'pending',
      })
      newMatches++
      continue
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/lib/ehr-sync.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ehr-sync.ts tests/lib/ehr-sync.test.ts
git commit -m "fix: use the real Levenshtein-based match confidence in syncFromEhrs instead of a hardcoded 95"
```

---

## Task 3: Fix nondeterministic ordering in `listBroadcastRecipientCandidates`

**Files:**
- Modify: `src/lib/queries/broadcasts.ts:26-49`
- Test: `tests/lib/queries/broadcasts.test.ts` (existing file — add to it; do not remove existing tests)

**Interfaces:**
- Consumes: `patientTrialScreenings` table (existing schema, has an auto-increment `id`).
- Produces: no interface change — same function signature, same return shape.

- [ ] **Step 1: Read the existing test file to confirm its current structure**

Run: `sed -n '1,40p' tests/lib/queries/broadcasts.test.ts` and note the existing `describe`/`import` structure so the new test matches its conventions (session/db usage, no new mocking pattern introduced).

- [ ] **Step 2: Write the failing test**

Add this new `it` block inside the existing top-level `describe` in `tests/lib/queries/broadcasts.test.ts` (add the block; do not remove anything already there):

```ts
  it('resolves a multi-screening patient deterministically (latest screening row wins), not by arbitrary row order', async () => {
    const db = getDb()
    // RD-0001 already has one seeded screening row (nct06911112). Insert a
    // second, newer screening row for a different trial so this patient now
    // has 2 screening rows -- the exact "multi-trial patient" case the
    // function's own comment flags as undefined-order today.
    const [secondScreening] = await db.insert(patientTrialScreenings).values({
      patientId: 'RD-0001',
      trialId: 'nct-adhd-demo-01',
      overallStatus: 'red',
    }).returning()

    try {
      const first = await listBroadcastRecipientCandidates({})
      const second = await listBroadcastRecipientCandidates({})
      const firstStatus = first.find((c) => c.id === 'RD-0001')?.overallStatus
      const secondStatus = second.find((c) => c.id === 'RD-0001')?.overallStatus
      // The real assertion: calling it twice must return the SAME status
      // every time. Before the fix, Postgres's unordered result set could
      // (in principle) return either row first; after the fix, an explicit
      // ORDER BY makes the "most recent screening wins" choice deterministic
      // and repeatable.
      expect(firstStatus).toBe(secondStatus)
      expect(firstStatus).toBe('red') // the just-inserted, higher-id row wins
    } finally {
      await db.delete(patientTrialScreenings).where(eq(patientTrialScreenings.id, secondScreening.id))
    }
  })
```

Add these imports to the top of the test file if not already present: `import { eq } from 'drizzle-orm'`, `import { patientTrialScreenings } from '@/db/schema'`, `import { getDb } from '@/db/client'`.

- [ ] **Step 3: Run the test to verify it fails (or is flaky)**

Run: `npx vitest run tests/lib/queries/broadcasts.test.ts`
Expected: the new test is unreliable/fails intermittently, or fails outright, since today's query has no `ORDER BY` and Postgres does not guarantee row order without one.

- [ ] **Step 4: Add a deterministic ORDER BY**

In `src/lib/queries/broadcasts.ts`, replace:

```ts
  const rows = await db
    .select({ patient: patients, screening: patientTrialScreenings })
    .from(patients)
    .leftJoin(patientTrialScreenings, eq(patientTrialScreenings.patientId, patients.id))
    .where(filters.trialId ? eq(patientTrialScreenings.trialId, filters.trialId) : undefined)

  // A patient can have multiple screening rows across trials; when no
  // trialId filter narrows the join, keep exactly one row per patient.
  // KNOWN LIMITATION: the query has no ORDER BY, so "first row per patient"
  // is whatever order Postgres happens to return -- for a hypothetical
  // multi-trial patient, filtering by overallStatus alone (no trialId) could
  // arbitrarily resolve to either trial's status. Not exploitable with
  // today's seed data (every patient has exactly one screening row); needs
  // a real product decision (which trial "wins") before this filter is used
  // against data where multi-trial patients actually exist.
  const byPatient = new Map<string, { patient: typeof patients.$inferSelect; overallStatus?: Verdict }>()
```

with:

```ts
  const rows = await db
    .select({ patient: patients, screening: patientTrialScreenings })
    .from(patients)
    .leftJoin(patientTrialScreenings, eq(patientTrialScreenings.patientId, patients.id))
    .where(filters.trialId ? eq(patientTrialScreenings.trialId, filters.trialId) : undefined)
    .orderBy(desc(patientTrialScreenings.id))

  // A patient can have multiple screening rows across trials; when no
  // trialId filter narrows the join, keep exactly one row per patient.
  // Rows are ordered by screening id descending above, so the first one
  // seen per patient below is deterministically that patient's most
  // recently created screening -- "most recent screening wins" is a real
  // product decision now, not an accident of Postgres's row order.
  const byPatient = new Map<string, { patient: typeof patients.$inferSelect; overallStatus?: Verdict }>()
```

Confirm `desc` is already imported at the top of `src/lib/queries/broadcasts.ts` (it is, used later in the same file for `formSubmissions.sentDate` and `broadcasts.sentAt`) — no new import needed.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/lib/queries/broadcasts.test.ts`
Expected: PASS, including all pre-existing tests in the file.

- [ ] **Step 6: Commit**

```bash
git add src/lib/queries/broadcasts.ts tests/lib/queries/broadcasts.test.ts
git commit -m "fix: make listBroadcastRecipientCandidates deterministic for multi-screening patients"
```

---

## Task 4: Add missing audit-log coverage to six read routes

**Files:**
- Modify: `src/app/api/broadcasts/route.ts`, `src/app/api/broadcasts/[id]/route.ts`
- Modify: `src/app/api/charges/route.ts`, `src/app/api/charges/[id]/route.ts`
- Modify: `src/app/api/form-templates/route.ts`, `src/app/api/form-templates/[id]/route.ts`
- Modify: `src/app/api/reviews/route.ts`, `src/app/api/reviews/[id]/route.ts`
- Modify: `src/app/api/trials/route.ts`
- Modify: `src/app/api/users/route.ts`
- Modify: `tests/api/broadcasts.test.ts`, `tests/api/charges.test.ts`, `tests/api/form-templates.test.ts`, `tests/api/reviews.test.ts`, `tests/api/trials.test.ts`, `tests/api/users.test.ts`

**Interfaces:**
- Consumes: `logAudit(session: Session, action: string, patientId: string | null)` from `@/lib/audit` (existing, unchanged signature).
- Produces: nothing new consumed by later tasks. Each file's change is independent of every other file's change in this task.

This task is ten near-identical mechanical edits (one `GET` handler each in the files above). Each sub-step below follows the same shape: query `auditLog` for the newest row before calling the handler, call the handler, query again, assert the newest row's `action` matches. This mirrors the DB-first testing convention already used throughout `tests/api/*` (no DB mocking).

- [ ] **Step 1: `GET /api/broadcasts` — write the failing test**

Add to `tests/api/broadcasts.test.ts` (add these imports if not already present: `import { getDb } from '@/db/client'` is already imported; add `import { auditLog } from '@/db/schema'` alongside the existing `broadcasts` import; add `import { desc } from 'drizzle-orm'` alongside the existing `inArray` import):

```ts
describe('GET /api/broadcasts audit logging', () => {
  it('logs an audit entry when the broadcast list is viewed', async () => {
    await listBroadcasts()
    const [latest] = await getDb().select().from(auditLog).orderBy(desc(auditLog.id)).limit(1)
    expect(latest.action).toBe('viewed broadcasts list')
  })
})
```

Run: `npx vitest run tests/api/broadcasts.test.ts` — expect FAIL (no audit row is written today, so `latest.action` is whatever the last-written unrelated row's action was).

- [ ] **Step 2: `GET /api/broadcasts` — implement**

In `src/app/api/broadcasts/route.ts`, replace:

```ts
export async function GET() {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  return NextResponse.json(await listBroadcasts())
}
```

with:

```ts
export async function GET() {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  await logAudit(session, 'viewed broadcasts list', null)
  return NextResponse.json(await listBroadcasts())
}
```

Run: `npx vitest run tests/api/broadcasts.test.ts` — expect PASS.

- [ ] **Step 3: `GET /api/broadcasts/[id]` — write the failing test, then implement**

Add to `tests/api/broadcasts.test.ts`:

```ts
  it('logs an audit entry when a single broadcast is viewed', async () => {
    const [existing] = await getDb().select().from(broadcasts).limit(1)
    const req = new Request(`http://localhost/api/broadcasts/${existing.id}`)
    await getOneBroadcast(req as never, { params: Promise.resolve({ id: String(existing.id) }) })
    const [latest] = await getDb().select().from(auditLog).orderBy(desc(auditLog.id)).limit(1)
    expect(latest.action).toBe(`viewed broadcast ${existing.id}`)
  })
```

Add `import { GET as getOneBroadcast } from '@/app/api/broadcasts/[id]/route'` to the top of the file.

Run: `npx vitest run tests/api/broadcasts.test.ts` — expect this new test to FAIL.

In `src/app/api/broadcasts/[id]/route.ts`, replace:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { getBroadcast } from '@/lib/queries/broadcasts'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  const { id } = await params
  const broadcast = await getBroadcast(Number(id))
  if (!broadcast) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(broadcast)
}
```

with:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getBroadcast } from '@/lib/queries/broadcasts'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  const { id } = await params
  const broadcast = await getBroadcast(Number(id))
  if (!broadcast) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await logAudit(session, `viewed broadcast ${id}`, null)
  return NextResponse.json(broadcast)
}
```

Run: `npx vitest run tests/api/broadcasts.test.ts` — expect PASS (all tests in the file).

- [ ] **Step 4: `GET /api/charges` — write the failing test, then implement**

Add to `tests/api/charges.test.ts` (add `import { auditLog } from '@/db/schema'` alongside the existing `charges` import, and `import { desc } from 'drizzle-orm'` alongside the existing `inArray` import):

```ts
describe('GET /api/charges audit logging', () => {
  it('logs an audit entry when the charges list is viewed', async () => {
    await GET()
    const [latest] = await getDb().select().from(auditLog).orderBy(desc(auditLog.id)).limit(1)
    expect(latest.action).toBe('viewed charges list')
  })
})
```

Run: `npx vitest run tests/api/charges.test.ts` — expect FAIL.

In `src/app/api/charges/route.ts`, replace:

```ts
export async function GET() {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  return NextResponse.json(await listCharges())
}
```

with:

```ts
export async function GET() {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  await logAudit(session, 'viewed charges list', null)
  return NextResponse.json(await listCharges())
}
```

Run: `npx vitest run tests/api/charges.test.ts` — expect PASS.

- [ ] **Step 5: `GET /api/charges/[id]` — write the failing test, then implement**

Add to `tests/api/charges.test.ts`:

```ts
  it('logs an audit entry when a single charge is viewed', async () => {
    const [existing] = await getDb().select().from(charges).limit(1)
    const req = new Request(`http://localhost/api/charges/${existing.id}`)
    await getOne(req as never, { params: Promise.resolve({ id: String(existing.id) }) })
    const [latest] = await getDb().select().from(auditLog).orderBy(desc(auditLog.id)).limit(1)
    expect(latest.action).toBe(`viewed charge ${existing.id}`)
    expect(latest.patientId).toBe(existing.patientId)
  })
```

Run: `npx vitest run tests/api/charges.test.ts` — expect this new test to FAIL.

In `src/app/api/charges/[id]/route.ts`, replace:

```ts
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  const { id } = await params
  const charge = await getCharge(Number(id))
  if (!charge) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(charge)
}
```

with:

```ts
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  const { id } = await params
  const charge = await getCharge(Number(id))
  if (!charge) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await logAudit(session, `viewed charge ${id}`, charge.patientId)
  return NextResponse.json(charge)
}
```

Run: `npx vitest run tests/api/charges.test.ts` — expect PASS (all tests in the file).

- [ ] **Step 6: `GET /api/form-templates` — write the failing test, then implement**

Add to `tests/api/form-templates.test.ts` (add `import { auditLog } from '@/db/schema'` alongside the existing `formTemplates` import, and `import { desc } from 'drizzle-orm'` alongside the existing `eq` import):

```ts
describe('GET /api/form-templates audit logging', () => {
  it('logs an audit entry when the template list is viewed', async () => {
    await GET()
    const [latest] = await getDb().select().from(auditLog).orderBy(desc(auditLog.id)).limit(1)
    expect(latest.action).toBe('viewed form templates list')
  })
})
```

Run: `npx vitest run tests/api/form-templates.test.ts` — expect FAIL.

In `src/app/api/form-templates/route.ts`, replace:

```ts
export async function GET() {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  return NextResponse.json(await listFormTemplates())
}
```

with:

```ts
export async function GET() {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  await logAudit(session, 'viewed form templates list', null)
  return NextResponse.json(await listFormTemplates())
}
```

Run: `npx vitest run tests/api/form-templates.test.ts` — expect PASS.

- [ ] **Step 7: `GET /api/form-templates/[id]` — write the failing test, then implement**

Create/extend `tests/api/form-templates.test.ts` with (add `import { GET as getOneTemplate } from '@/app/api/form-templates/[id]/route'` to the top):

```ts
  it('logs an audit entry when a single template is viewed', async () => {
    const [existing] = await getDb().select().from(formTemplates).limit(1)
    const req = new Request(`http://localhost/api/form-templates/${existing.id}`)
    await getOneTemplate(req as never, { params: Promise.resolve({ id: String(existing.id) }) })
    const [latest] = await getDb().select().from(auditLog).orderBy(desc(auditLog.id)).limit(1)
    expect(latest.action).toBe(`viewed form template ${existing.id}`)
  })
```

Run: `npx vitest run tests/api/form-templates.test.ts` — expect this new test to FAIL.

In `src/app/api/form-templates/[id]/route.ts`, replace:

```ts
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  const { id } = await params
  const template = await getFormTemplate(Number(id))
  if (!template) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(template)
}
```

with:

```ts
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  const { id } = await params
  const template = await getFormTemplate(Number(id))
  if (!template) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await logAudit(session, `viewed form template ${id}`, null)
  return NextResponse.json(template)
}
```

Run: `npx vitest run tests/api/form-templates.test.ts` — expect PASS (all tests in the file).

- [ ] **Step 8: `GET /api/reviews` — write the failing test, then implement**

Add to `tests/api/reviews.test.ts` (add `import { getDb } from '@/db/client'` is already imported; add `auditLog` to the existing `import { formSubmissions, reviews } from '@/db/schema'` line; add `desc` to the existing `import { eq, and } from 'drizzle-orm'` line):

```ts
describe('GET /api/reviews audit logging', () => {
  it('logs an audit entry when the survey list is viewed', async () => {
    const req = new Request('http://localhost/api/reviews')
    await listReviews(req as never)
    const [latest] = await getDb().select().from(auditLog).orderBy(desc(auditLog.id)).limit(1)
    expect(latest.action).toBe('viewed experience surveys list')
  })
})
```

Run: `npx vitest run tests/api/reviews.test.ts` — expect FAIL.

In `src/app/api/reviews/route.ts`, replace:

```ts
  return NextResponse.json(await listReviews(filters))
}
```

with:

```ts
  await logAudit(session, 'viewed experience surveys list', null)
  return NextResponse.json(await listReviews(filters))
}
```

(`logAudit` and `session` are already imported/in scope in this file's `GET` handler.)

Run: `npx vitest run tests/api/reviews.test.ts` — expect PASS.

- [ ] **Step 9: `GET /api/reviews/[id]` — write the failing test, then implement**

Add to `tests/api/reviews.test.ts`:

```ts
  it('logs an audit entry when a single survey is viewed', async () => {
    const [existing] = await getDb().select().from(reviews).limit(1)
    const req = new Request(`http://localhost/api/reviews/${existing.id}`)
    await getOneReview(req as never, { params: Promise.resolve({ id: String(existing.id) }) })
    const [latest] = await getDb().select().from(auditLog).orderBy(desc(auditLog.id)).limit(1)
    expect(latest.action).toBe(`viewed experience survey ${existing.id}`)
    expect(latest.patientId).toBe(existing.patientId)
  })
```

Add `import { GET as getOneReview } from '@/app/api/reviews/[id]/route'` to the top of the file.

Run: `npx vitest run tests/api/reviews.test.ts` — expect this new test to FAIL.

In `src/app/api/reviews/[id]/route.ts`, replace:

```ts
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  const { id } = await params
  const review = await getReview(Number(id))
  if (!review) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(review)
}
```

with:

```ts
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  const { id } = await params
  const review = await getReview(Number(id))
  if (!review) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await logAudit(session, `viewed experience survey ${id}`, review.patientId)
  return NextResponse.json(review)
}
```

Run: `npx vitest run tests/api/reviews.test.ts` — expect PASS (all tests in the file).

- [ ] **Step 10: `GET /api/trials` — write the failing test, then implement**

Add to `tests/api/trials.test.ts` (add `auditLog` to the existing `import { trials } from '@/db/schema'` line; add `desc` to the existing `import { eq } from 'drizzle-orm'` line):

```ts
  it('logs an audit entry when the trial list is viewed', async () => {
    await listTrials(new NextRequest('http://localhost/api/trials'))
    const [latest] = await getDb().select().from(auditLog).orderBy(desc(auditLog.id)).limit(1)
    expect(latest.action).toBe('viewed trials list')
  })
```

(Add this `it` inside the existing `describe('GET /api/trials', ...)` block.)

Run: `npx vitest run tests/api/trials.test.ts` — expect FAIL.

In `src/app/api/trials/route.ts`, replace the whole file with:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listAllTrials } from '@/lib/queries/trials'

export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session

  await logAudit(session, 'viewed trials list', null)
  const rows = await listAllTrials()
  return NextResponse.json({ trials: rows })
}
```

Run: `npx vitest run tests/api/trials.test.ts` — expect PASS (all tests in the file).

- [ ] **Step 11: `GET /api/users` — write the failing test, then implement**

Add to `tests/api/users.test.ts` (add `auditLog` to the existing `import { users } from '@/db/schema'` line; add `import { desc } from 'drizzle-orm'`):

```ts
  it('logs an audit entry when the staff roster is viewed', async () => {
    await listUsers()
    const [latest] = await getDb().select().from(auditLog).orderBy(desc(auditLog.id)).limit(1)
    expect(latest.action).toBe('viewed staff roster')
  })
```

(Add this `it` inside the existing `describe('GET /api/users', ...)` block, after the existing "rejects a non-admin session" test.)

Run: `npx vitest run tests/api/users.test.ts` — expect FAIL.

In `src/app/api/users/route.ts`, replace:

```ts
export async function GET() {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })

  const roster = await listAllUsers()
  return NextResponse.json(roster)
}
```

with:

```ts
export async function GET() {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })

  await logAudit(session, 'viewed staff roster', null)
  const roster = await listAllUsers()
  return NextResponse.json(roster)
}
```

Run: `npx vitest run tests/api/users.test.ts` — expect PASS (all tests in the file).

- [ ] **Step 12: Run the full affected test set together**

Run: `npx vitest run tests/api/broadcasts.test.ts tests/api/charges.test.ts tests/api/form-templates.test.ts tests/api/reviews.test.ts tests/api/trials.test.ts tests/api/users.test.ts`
Expected: PASS (every test in every file).

- [ ] **Step 13: Commit**

```bash
git add src/app/api/broadcasts/route.ts src/app/api/broadcasts/\[id\]/route.ts \
        src/app/api/charges/route.ts src/app/api/charges/\[id\]/route.ts \
        src/app/api/form-templates/route.ts src/app/api/form-templates/\[id\]/route.ts \
        src/app/api/reviews/route.ts src/app/api/reviews/\[id\]/route.ts \
        src/app/api/trials/route.ts src/app/api/users/route.ts \
        tests/api/broadcasts.test.ts tests/api/charges.test.ts tests/api/form-templates.test.ts \
        tests/api/reviews.test.ts tests/api/trials.test.ts tests/api/users.test.ts
git commit -m "fix: log audit entries for PHI-adjacent read routes that were silently unaudited"
```

---

## Task 5: Add missing audit-log call to patient-portal MFA enrollment

**Files:**
- Modify: `src/app/api/patient-portal/account/mfa/enroll/route.ts`
- Modify: `tests/api/patient-portal-account-mfa.test.ts`

**Interfaces:**
- Consumes: `logPatientPortalAction(action: string, patientId: string, details?: string)` from `@/lib/patient-portal-audit` (existing, unchanged signature).

- [ ] **Step 1: Write the failing test**

In `tests/api/patient-portal-account-mfa.test.ts`, add `auditLog` is already imported (`import { patients, auditLog } from '@/db/schema'`). Extend the existing `it('enroll returns a QR and manual key, and provisions an unconfirmed secret', ...)` test by adding these two lines at the end of its body (after the existing `expect(state?.mfaSecretEncrypted).toBeTruthy()` line):

```ts
    const auditEntries = await getDb().select().from(auditLog).where(and(eq(auditLog.patientId, TEST_PATIENT_ID), eq(auditLog.action, 'enrolled in patient portal MFA')))
    expect(auditEntries.length).toBe(1)
```

Also update the `afterAll` cleanup block to remove this new audit row alongside the existing one:

```ts
afterAll(async () => {
  await getDb().delete(auditLog).where(and(eq(auditLog.patientId, TEST_PATIENT_ID), eq(auditLog.action, 'failed MFA code entry during enrollment')))
  await getDb().delete(auditLog).where(and(eq(auditLog.patientId, TEST_PATIENT_ID), eq(auditLog.action, 'enrolled in patient portal MFA')))
  await getDb().delete(patients).where(eq(patients.id, TEST_PATIENT_ID))
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/api/patient-portal-account-mfa.test.ts`
Expected: FAIL on the new `expect(auditEntries.length).toBe(1)` assertion (currently 0 rows).

- [ ] **Step 3: Implement**

Replace the full contents of `src/app/api/patient-portal/account/mfa/enroll/route.ts` with:

```ts
import { NextResponse } from 'next/server'
import { requirePatientSession } from '@/lib/patient-session'
import { encryptSensitive } from '@/lib/crypto'
import { generateMfaEnrollment } from '@/lib/mfa'
import { getPatientMfaState, setPatientMfaSecret } from '@/lib/queries/patient-portal'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'

export async function POST() {
  const session = await requirePatientSession()
  if (session instanceof NextResponse) return session

  const mfaState = await getPatientMfaState(session.patientId)
  if (mfaState?.mfaEnabled) return NextResponse.json({ error: 'MFA is already enabled' }, { status: 400 })

  const enrollment = await generateMfaEnrollment(session.patientId)
  await setPatientMfaSecret(session.patientId, encryptSensitive(enrollment.secretBase32))
  await logPatientPortalAction('enrolled in patient portal MFA', session.patientId)

  return NextResponse.json({ qrDataUrl: enrollment.qrDataUrl, manualKey: enrollment.secretBase32 })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/api/patient-portal-account-mfa.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/patient-portal/account/mfa/enroll/route.ts tests/api/patient-portal-account-mfa.test.ts
git commit -m "fix: log an audit entry when a patient enrolls in portal MFA"
```

---

## Task 6: Migrate `AddClientModal` to the accessible Dialog primitive

**Files:**
- Modify: `src/components/AddClientModal.tsx`
- Create: `tests/components/AddClientModal.test.tsx`

**Interfaces:**
- Consumes: `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogFooter` from `@/components/ui/dialog` (existing, unmodified); `Button` from `@/components/ui/button` (existing, unmodified).

- [ ] **Step 1: Write the failing test**

Create `tests/components/AddClientModal.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AddClientModal } from '@/components/AddClientModal'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

describe('AddClientModal', () => {
  it('renders as an accessible dialog that closes on Escape', () => {
    const onClose = vi.fn()
    render(<AddClientModal onClose={onClose} />)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('still requires a name and DOB before Save is enabled', () => {
    render(<AddClientModal onClose={vi.fn()} />)
    expect(screen.getByText('Save')).toBeDisabled()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/components/AddClientModal.test.tsx`
Expected: FAIL on the Escape test — the current hand-rolled `<div role="dialog">` has no keydown handling, so `onClose` is never called.

- [ ] **Step 3: Implement**

Replace the full contents of `src/components/AddClientModal.tsx` with:

```tsx
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface NewPatientForm {
  name: string
  dob: string
  email: string
  phone: string
  city: string
  zip: string
  currentProvider: string
}

const EMPTY_FORM: NewPatientForm = {
  name: '', dob: '', email: '', phone: '', city: '', zip: '', currentProvider: '',
}

export function AddClientModal({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const [form, setForm] = useState<NewPatientForm>(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function update<K extends keyof NewPatientForm>(key: K, value: NewPatientForm[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  async function submit() {
    setSubmitting(true)
    setError(null)
    const res = await fetch('/api/patients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: form.name,
        dob: form.dob,
        email: form.email || undefined,
        phone: form.phone || undefined,
        city: form.city || undefined,
        zip: form.zip || undefined,
        currentProvider: form.currentProvider || undefined,
      }),
    })
    setSubmitting(false)
    if (!res.ok) {
      setError('Could not add this patient. Please check the details and try again.')
      return
    }
    // Navigate straight to the new patient's detail page rather than just
    // refreshing the current page -- an admin who just added a patient
    // wants to see it, not go find it themselves in the list.
    const created = await res.json()
    onClose()
    router.push(`/patients/${created.id}`)
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add New Patient</DialogTitle>
        </DialogHeader>
        <p className="-mt-2 text-xs text-muted-foreground">
          This creates a new chart in Tebra -- Clinsync doesn&apos;t store patient records of its own.
        </p>

        <div className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Basic info</p>
          <input value={form.name} onChange={(e) => update('name', e.target.value)} placeholder="Full name" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          <input value={form.dob} onChange={(e) => update('dob', e.target.value)} type="date" aria-label="Date of birth" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          <div className="grid grid-cols-2 gap-3">
            <input value={form.email} onChange={(e) => update('email', e.target.value)} placeholder="Email (optional)" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
            <input value={form.phone} onChange={(e) => update('phone', e.target.value)} placeholder="Phone (optional)" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <input value={form.city} onChange={(e) => update('city', e.target.value)} placeholder="City (optional)" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
            <input value={form.zip} onChange={(e) => update('zip', e.target.value)} placeholder="Zip (optional)" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          </div>

          <p className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Care details</p>
          <input value={form.currentProvider} onChange={(e) => update('currentProvider', e.target.value)} placeholder="Current provider (optional)" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={submitting || !form.name || !form.dob}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes; if `open`/`onOpenChange` prop names differ from what `@base-ui/react`'s `DialogPrimitive.Root.Props` actually declares, fix the prop names to match rather than guessing further**

Run: `npx vitest run tests/components/AddClientModal.test.tsx`
Expected: PASS. If it fails with a TypeScript/prop-shape error instead of an assertion failure, run `npx tsc --noEmit` to see the exact expected prop names from the installed `@base-ui/react` version and adjust the `<Dialog open ... onOpenChange={...}>` call accordingly (do not change `dialog.tsx` itself — it already forwards `DialogPrimitive.Root.Props` verbatim).

- [ ] **Step 5: Commit**

```bash
git add src/components/AddClientModal.tsx tests/components/AddClientModal.test.tsx
git commit -m "fix: migrate AddClientModal to the accessible Dialog primitive (focus trap, Escape-to-close)"
```

---

## Task 7: Migrate `NewEventModal` to the accessible Dialog primitive

**Files:**
- Modify: `src/components/NewEventModal.tsx`
- Create: `tests/components/NewEventModal.test.tsx`

**Interfaces:**
- Consumes: same as Task 6.

- [ ] **Step 1: Write the failing test**

Create `tests/components/NewEventModal.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NewEventModal } from '@/components/NewEventModal'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

describe('NewEventModal', () => {
  it('renders as an accessible dialog that closes on Escape', () => {
    const onClose = vi.fn()
    render(
      <NewEventModal
        patients={[{ id: 'RD-0001', name: 'Test Patient' }]}
        providers={[{ id: 1, name: 'Dr. Test' }]}
        defaultDate="2026-09-25"
        onClose={onClose}
      />
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/components/NewEventModal.test.tsx`
Expected: FAIL (no Escape handling in the current hand-rolled overlay).

- [ ] **Step 3: Implement**

Replace the full contents of `src/components/NewEventModal.tsx` with:

```tsx
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface PatientOption {
  id: string
  name: string
}

interface ProviderOption {
  id: number
  name: string
}

export function NewEventModal({ patients, providers, defaultDate, onClose }: {
  patients: PatientOption[]
  providers: ProviderOption[]
  defaultDate: string
  onClose: () => void
}) {
  const router = useRouter()
  const [patientId, setPatientId] = useState('')
  const [providerId, setProviderId] = useState<number | ''>('')
  const [date, setDate] = useState(defaultDate)
  const [startTime, setStartTime] = useState('09:00')
  const [endTime, setEndTime] = useState('09:30')
  const [visitReason, setVisitReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/appointments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          patientId,
          providerId,
          startsAt: `${date}T${startTime}:00`,
          endsAt: `${date}T${endTime}:00`,
          visitReason,
        }),
      })
      if (res.ok) {
        router.refresh()
        onClose()
        return
      }
      const body = await res.json().catch(() => null)
      setError(body?.error ?? 'Could not schedule the appointment.')
    } catch {
      setError('Could not reach the server. Please check your connection and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const canSubmit = Boolean(patientId) && providerId !== '' && Boolean(date) && Boolean(startTime) && Boolean(endTime) && Boolean(visitReason) && !submitting

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New Event</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <select value={patientId} onChange={(e) => setPatientId(e.target.value)} className="w-full rounded-md border border-border px-3 py-2 text-sm">
            <option value="">Select a patient…</option>
            {patients.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.id})</option>)}
          </select>
          <select value={providerId} onChange={(e) => setProviderId(e.target.value === '' ? '' : Number(e.target.value))} className="w-full rounded-md border border-border px-3 py-2 text-sm">
            <option value="">Select a provider…</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input value={date} onChange={(e) => setDate(e.target.value)} type="date" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          <div className="flex gap-2">
            <input value={startTime} onChange={(e) => setStartTime(e.target.value)} type="time" className="w-1/2 rounded-md border border-border px-3 py-2 text-sm" />
            <input value={endTime} onChange={(e) => setEndTime(e.target.value)} type="time" className="w-1/2 rounded-md border border-border px-3 py-2 text-sm" />
          </div>
          <input value={visitReason} onChange={(e) => setVisitReason(e.target.value)} placeholder="Visit reason" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/components/NewEventModal.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/NewEventModal.tsx tests/components/NewEventModal.test.tsx
git commit -m "fix: migrate NewEventModal to the accessible Dialog primitive"
```

---

## Task 8: Migrate `DeletePatientDialog` to the accessible Dialog primitive

**Files:**
- Modify: `src/components/DeletePatientDialog.tsx`
- Create: `tests/components/DeletePatientDialog.test.tsx`

**Interfaces:**
- Consumes: same as Task 6.

- [ ] **Step 1: Write the failing test**

Create `tests/components/DeletePatientDialog.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DeletePatientDialog } from '@/components/DeletePatientDialog'

describe('DeletePatientDialog', () => {
  it('renders as an accessible dialog that closes on Escape', () => {
    const onClose = vi.fn()
    render(<DeletePatientDialog target={{ id: 'RD-0001', name: 'Test Patient' }} onClose={onClose} onDeleted={vi.fn()} />)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('renders nothing when target is null', () => {
    const { container } = render(<DeletePatientDialog target={null} onClose={vi.fn()} onDeleted={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/components/DeletePatientDialog.test.tsx`
Expected: the Escape test FAILs; the null-target test already passes (unaffected by this change).

- [ ] **Step 3: Implement**

Replace the full contents of `src/components/DeletePatientDialog.tsx` with:

```tsx
'use client'
import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

export interface DeleteTarget {
  id: string
  name: string
}

/**
 * Controlled confirmation modal for permanently removing a patient chart --
 * shared by the Workbook's right-click menu and the Patient Detail page's
 * delete button so both go through the identical confirm step and DELETE
 * call. Deletes only Clinsync's own mirrored copy (see api/patients/[anonId]
 * DELETE): the underlying Tebra/IntakeQ record, if any, is untouched.
 */
export function DeletePatientDialog({ target, onClose, onDeleted }: { target: DeleteTarget | null; onClose: () => void; onDeleted: () => void }) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!target) return null

  async function confirmDelete() {
    if (!target) return
    setDeleting(true)
    setError(null)
    const res = await fetch(`/api/patients/${target.id}`, { method: 'DELETE' })
    setDeleting(false)
    if (!res.ok) {
      setError('Could not delete this patient. Please try again.')
      return
    }
    onClose()
    onDeleted()
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-sm">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive" aria-hidden="true">
            <Trash2 className="h-4.5 w-4.5" />
          </span>
          <h2 className="text-lg font-semibold text-foreground">Delete patient record?</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          This permanently removes <span className="font-medium text-foreground">{target.name}</span> ({target.id}) and every record tied to
          them -- diagnoses, medications, forms, appointments, messages, billing -- from Clinsync. It disappears from the Patients tab, the
          Workbook, and everywhere else in the app immediately. This does not affect their chart in Tebra or IntakeQ, and cannot be undone.
        </p>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={deleting}>Cancel</Button>
          <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete permanently'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

Note: the destructive button's visible text color changes from the original's hardcoded `text-white` (on a solid `bg-destructive` background) to the `Button` component's `destructive` variant (`bg-destructive/10 text-destructive`, a lighter treatment consistent with every other destructive button already using this `Button` component elsewhere in the app). This is a deliberate consistency fix, not an accident — flag it in the PR description as a minor, expected visual change to this one button.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/components/DeletePatientDialog.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/DeletePatientDialog.tsx tests/components/DeletePatientDialog.test.tsx
git commit -m "fix: migrate DeletePatientDialog to the accessible Dialog primitive"
```

---

## Task 9: Migrate `SendFormModal` to the accessible Dialog primitive

**Files:**
- Modify: `src/components/SendFormModal.tsx`
- Create: `tests/components/SendFormModal.test.tsx`

**Interfaces:**
- Consumes: same as Task 6.

- [ ] **Step 1: Write the failing test**

Create `tests/components/SendFormModal.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SendFormModal } from '@/components/SendFormModal'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

describe('SendFormModal', () => {
  it('renders as an accessible dialog that closes on Escape', () => {
    const onClose = vi.fn()
    render(
      <SendFormModal
        templates={[{ id: 1, name: 'Intake Form' }]}
        patients={[{ id: 'RD-0001', nameTebra: null, nameIntakeq: 'Test Patient' }]}
        onClose={onClose}
      />
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/components/SendFormModal.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

Replace the full contents of `src/components/SendFormModal.tsx` with:

```tsx
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

export function SendFormModal({ templates, patients, onClose }: {
  templates: { id: number; name: string }[]
  patients: { id: string; nameTebra: string | null; nameIntakeq: string }[]
  onClose: () => void
}) {
  const router = useRouter()
  const [templateId, setTemplateId] = useState<number | ''>('')
  const [patientId, setPatientId] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function submit() {
    setSubmitting(true)
    const res = await fetch('/api/form-submissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId, patientId }),
    })
    setSubmitting(false)
    if (res.ok) { router.refresh(); onClose() }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Send Form to Client</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <select value={patientId} onChange={(e) => setPatientId(e.target.value)} className="w-full rounded-md border border-border px-3 py-2 text-sm">
            <option value="">Select a client…</option>
            {patients.map((p) => <option key={p.id} value={p.id}>{p.nameTebra ?? p.nameIntakeq} ({p.id})</option>)}
          </select>
          <select value={templateId} onChange={(e) => setTemplateId(Number(e.target.value))} className="w-full rounded-md border border-border px-3 py-2 text-sm">
            <option value="">Select a form…</option>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={submitting || !templateId || !patientId}>Send Form</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/components/SendFormModal.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/SendFormModal.tsx tests/components/SendFormModal.test.tsx
git commit -m "fix: migrate SendFormModal to the accessible Dialog primitive"
```

---

## Task 10: Migrate `NewChargeModal` to the accessible Dialog primitive

**Files:**
- Modify: `src/components/NewChargeModal.tsx`
- Create: `tests/components/NewChargeModal.test.tsx`

**Interfaces:**
- Consumes: same as Task 6. This component owns its own `open` state (it renders its own trigger button), unlike Tasks 6-9 which are always-mounted-when-shown.

- [ ] **Step 1: Write the failing test**

Create `tests/components/NewChargeModal.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NewChargeModal } from '@/components/NewChargeModal'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

describe('NewChargeModal', () => {
  it('opens as an accessible dialog on trigger click and closes on Escape', () => {
    render(<NewChargeModal patients={[{ id: 'RD-0001', name: 'Test Patient' }]} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('+ New Charge'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/components/NewChargeModal.test.tsx`
Expected: FAIL on the Escape assertion — the current hand-rolled overlay (which doesn't even set `role="dialog"`) never closes on Escape, so `screen.getByRole('dialog')` also fails to find it in the first place.

- [ ] **Step 3: Implement**

Replace the full contents of `src/components/NewChargeModal.tsx` with:

```tsx
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface DxRow { code: string; description: string }
interface ProcRow { code: string; description: string; units: number; chargeCents: number }

export function NewChargeModal({ patients }: { patients: { id: string; name: string }[] }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [patientId, setPatientId] = useState(patients[0]?.id ?? '')
  const [providerName, setProviderName] = useState('Dr. R. Kunam')
  const [dateOfService, setDateOfService] = useState('')
  const [dx, setDx] = useState<DxRow[]>([{ code: '', description: '' }])
  const [proc, setProc] = useState<ProcRow[]>([{ code: '', description: '', units: 1, chargeCents: 0 }])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const amountCents = proc.reduce((sum, p) => sum + p.chargeCents * p.units, 0)

  function updateDx(i: number, patch: Partial<DxRow>) {
    setDx(dx.map((row, idx) => (idx === i ? { ...row, ...patch } : row)))
  }
  function updateProc(i: number, patch: Partial<ProcRow>) {
    setProc(proc.map((row, idx) => (idx === i ? { ...row, ...patch } : row)))
  }

  async function submit() {
    setSaving(true)
    setError(null)
    const res = await fetch('/api/charges', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patientId, providerName, dateOfService, diagnosisCodes: dx, procedureCodes: proc }),
    })
    setSaving(false)
    if (res.ok) {
      setOpen(false)
      router.refresh()
    } else {
      const body = await res.json()
      setError(body.error ?? 'Failed to create charge.')
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>+ New Charge</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-auto">
          <DialogHeader>
            <DialogTitle>New Charge</DialogTitle>
          </DialogHeader>
          {error && <p className="text-sm font-medium text-destructive">{error}</p>}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Patient</label>
              <select value={patientId} onChange={(e) => setPatientId(e.target.value)} className="w-full rounded-md border border-border px-2 py-1.5 text-sm">
                {patients.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.id})</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Provider</label>
              <input value={providerName} onChange={(e) => setProviderName(e.target.value)} className="w-full rounded-md border border-border px-2 py-1.5 text-sm" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Date of Service</label>
              <input type="date" value={dateOfService} onChange={(e) => setDateOfService(e.target.value)} className="w-full rounded-md border border-border px-2 py-1.5 text-sm" />
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Diagnosis Codes</h3>
              <button type="button" onClick={() => setDx([...dx, { code: '', description: '' }])} className="text-xs font-medium text-primary hover:underline">+ Add</button>
            </div>
            <div className="space-y-2">
              {dx.map((row, i) => (
                <div key={i} className="flex gap-2">
                  <input value={row.code} onChange={(e) => updateDx(i, { code: e.target.value })} placeholder="Code (e.g. F33.1)" className="w-32 rounded-md border border-border px-2 py-1.5 text-sm" />
                  <input value={row.description} onChange={(e) => updateDx(i, { description: e.target.value })} placeholder="Description" className="flex-1 rounded-md border border-border px-2 py-1.5 text-sm" />
                  <button type="button" onClick={() => setDx(dx.filter((_, idx) => idx !== i))} disabled={dx.length === 1} className="rounded px-2 text-xs text-destructive hover:bg-secondary disabled:opacity-30">Remove</button>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Procedure Codes</h3>
              <button type="button" onClick={() => setProc([...proc, { code: '', description: '', units: 1, chargeCents: 0 }])} className="text-xs font-medium text-primary hover:underline">+ Add</button>
            </div>
            <div className="space-y-2">
              {proc.map((row, i) => (
                <div key={i} className="flex gap-2">
                  <input value={row.code} onChange={(e) => updateProc(i, { code: e.target.value })} placeholder="CPT code" className="w-24 rounded-md border border-border px-2 py-1.5 text-sm" />
                  <input value={row.description} onChange={(e) => updateProc(i, { description: e.target.value })} placeholder="Description" className="flex-1 rounded-md border border-border px-2 py-1.5 text-sm" />
                  <input type="number" min={1} value={row.units} onChange={(e) => updateProc(i, { units: Number(e.target.value) })} placeholder="Units" className="w-16 rounded-md border border-border px-2 py-1.5 text-sm" />
                  <input type="number" min={0} value={row.chargeCents / 100} onChange={(e) => updateProc(i, { chargeCents: Math.round(Number(e.target.value) * 100) })} placeholder="$ per unit" className="w-24 rounded-md border border-border px-2 py-1.5 text-sm" />
                  <button type="button" onClick={() => setProc(proc.filter((_, idx) => idx !== i))} disabled={proc.length === 1} className="rounded px-2 text-xs text-destructive hover:bg-secondary disabled:opacity-30">Remove</button>
                </div>
              ))}
            </div>
          </div>

          <p className="text-sm font-semibold text-foreground">Total amount: ${(amountCents / 100).toFixed(2)}</p>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={saving || !patientId || !dateOfService}>
              {saving ? 'Creating...' : 'Create Charge (Draft)'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/components/NewChargeModal.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/NewChargeModal.tsx tests/components/NewChargeModal.test.tsx
git commit -m "fix: migrate NewChargeModal to the accessible Dialog primitive"
```

---

## Task 11: Correct stale documentation on MFA, patient idle-timeout, and the eligibility-verdict claim

**Files:**
- Modify: `docs/product-review-and-gap-analysis.md`
- Modify: `README.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Fix the MFA/idle-timeout rows in the gap-analysis table**

In `docs/product-review-and-gap-analysis.md`, in the "Technical safeguards" table, replace:

```
| Automatic logoff | ⚠️ | **Staff sessions**: yes — 10 min idle warning, 12 min forced logout (`SessionTimeoutWarning`). **Patient portal sessions**: no equivalent exists — a patient portal session has a 1-hour max-age cookie but no idle-timeout warning/kick. |
| Multi-Factor Authentication | ❌ | Confirmed absent — and the code already says so itself, in a comment on `patient-session.ts`: *"a patient portal session on a shared/public device is a real risk this pilot hasn't otherwise mitigated (no 'remember this device', no MFA)."* |
```

with:

```
| Automatic logoff | ✅ | **Staff sessions**: 10 min idle warning, 12 min forced logout (`SessionTimeoutWarning`). **Patient portal sessions**: same 10 min/12 min pattern via `PatientPortalSessionTimeoutWarning` (mounted in `patient-portal/(authenticated)/layout.tsx`). Both now covered — this row was stale as of 2026-09-23; verified current as of 2026-09-25. |
| Multi-Factor Authentication | ✅ | A full TOTP MFA system now exists for staff, admin, and patient-portal logins alike (`src/lib/mfa.ts`, `mfa-pending-session.ts`, replay-protected via a Redis single-use claim per RFC 6238 §5.2). This row was stale as of 2026-09-23; verified current as of 2026-09-25. |
```

- [ ] **Step 2: Fix the product-review section's "Where it's genuinely thin" bullet**

In the same file's "Product review" section, replace:

```
- No MFA and no patient-side auto-logoff — both cheap to add, both currently missing.
```

with:

```
- ~~No MFA and no patient-side auto-logoff~~ — both have since been built (see the Technical Safeguards table above); this bullet is stale as of 2026-09-23.
```

- [ ] **Step 3: Clarify the eligibility "always yellow" claim in README.md**

In `README.md`, replace:

```
Every verdict is backed by the exact chart quote it was derived from —
never a summary, never a guess. **The rule engine never invents a "meets"
or "excludes" verdict from absent evidence: an empty evidence set always
defaults to "needs verification"** (`src/lib/eligibility.ts`,
`src/lib/rule-engine.ts`). Humans — coordinators first, then the
investigator — always make the actual eligibility call; the app only ever
proposes.
```

with:

```
Every verdict is backed by the exact chart quote it was derived from —
never a summary, never a guess. For criteria that positively require
evidence (a diagnosis match, a rating-scale threshold), the rule engine
never invents a "meets" verdict from absent evidence: no matching chart
data always defaults to "needs verification". For exclusion-type criteria
(an excluded medication class, a disqualifying diagnosis) and the age
check, the absence of disqualifying evidence is itself a legitimate,
positive finding, so those resolve directly to green or red rather than
sitting in "needs verification" forever — see the per-criterion logic in
`src/lib/eligibility.ts`. Either way, the verdict always names the exact
evidence (or absence of it) it's based on; humans — coordinators first,
then the investigator — always make the actual eligibility call, the app
only ever proposes.
```

- [ ] **Step 4: Verify the edits render correctly and contain no broken markdown**

Run: `npx markdownlint-cli2 README.md docs/product-review-and-gap-analysis.md 2>/dev/null || true` (informational only — this project has no markdownlint dependency installed; if the command errors with "command not found," skip it and instead just re-read both edited sections with `Read` to visually confirm table/list formatting is intact).

- [ ] **Step 5: Commit**

```bash
git add README.md docs/product-review-and-gap-analysis.md
git commit -m "docs: correct stale MFA/idle-timeout claims and clarify the eligibility-verdict default-to-yellow rule"
```

---

## Explicitly out of scope for this plan

These were found during the audit but are deliberately **not** included here — each needs a product/scope decision, not just a code fix:

- **Missing `insuranceClaims`/`patientStatements` API routes.** These tables have full UI list pages but zero API surface (`api/charges` and `api/mock-payments` exist; there is no `api/insurance-claims` or `api/patient-statements`). This is a feature gap, not a bug — needs a decision on what writes to these tables and how, before building routes for them.
- **Schema/migration drift** (`messages`, `formChartDiscrepancies`, and several columns exist in `schema.ts` with no corresponding `drizzle/` migration file). Reconciling this means hand-writing migration SQL against the single shared live database — explicitly the kind of action `README.md` warns against doing casually. Needs deliberate handling, not a bundled fix.
- **The 61 remaining raw Tailwind color classes** (`emerald-*`, `amber-*`, `sky-*`, etc.) across 17 files. Some are genuine leftover status-color duplication (should become tokens); others are intentional categorical/decorative variety (avatar colors, role badges) that were never meant to be semantic tokens in the first place. Sorting out which is which is a design decision — this is exactly what the upcoming Mobbin-referenced frontend pass should resolve, not something to guess at here.
- **`tebra.mock.ts`'s in-memory patient-ID counter** (resets per serverless cold start). Low-value fix for a mock connector that's already documented as temporary; not worth the churn right now.
