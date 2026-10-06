# Messaging Isolation Audit — Regression Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two test-coverage gaps identified by the messaging isolation audit — an API-layer test asserting a staff `GET` of one patient's thread never leaks another patient's message content, and a new page-level test proving the patient portal Messages page only ever renders the session's own patient's messages.

**Architecture:** No production code changes. The audit (§5) found the `messages` table, query layer, API route, and patient-portal page are already correctly isolated per-patient at every layer; this plan only adds the two regression tests the audit recommends, extending two existing test files' established conventions exactly (one new `it()` in `tests/api/messages.test.ts`; one new file, `tests/pages/patient-portal-messages.test.tsx`, mirroring `tests/pages/patient-portal-overview.test.tsx`).

**Tech Stack:** Vitest + `@testing-library/react`, against the same real shared Neon Postgres dev database the existing suite uses (`getDb()`, no test-DB isolation).

**Spec:** `docs/superpowers/specs/2026-09-29-messaging-isolation-audit.md`

**Working directory note:** this plan is executed in an isolated git worktree at `/Users/k2a/Desktop/clinsync/.worktrees/messaging-isolation` on branch `feature/messaging-isolation`. This worktree has its own `.env.local` and `node_modules`. Every implementer/reviewer dispatch for this plan must work from this exact directory, not the main checkout — other worktrees have their own concurrent work in flight; do not touch them.

## Global Constraints

- No production code changes — this plan is test-only, per spec §5 ("No other changes are recommended").
- Match each target file's existing conventions exactly rather than introducing a new test style: `tests/api/messages.test.ts` already mocks `@/lib/auth` and `@/lib/patient-session` but calls the real (unmocked) `@/lib/queries/messages` against the shared dev DB; `tests/pages/patient-portal-overview.test.tsx` fully mocks the page's data dependencies and renders with `@testing-library/react`.
- Both target patients already exist as seeded data: `RD-0001` (`STAFF_PATIENT_ID` / `PATIENT_A`, Maria Alvarez) and `RD-0002` (`OTHER_PATIENT_ID` / `PATIENT_B`) — reuse these ids, don't invent new ones.
- Any message row a test inserts via `sendMessage` into the shared dev DB must be tracked and deleted in `afterEach`, matching the existing `createdIds` pattern already in `tests/api/messages.test.ts`.
- A patient-portal page test that renders `MessageComposer` (a client component calling `useRouter()`) must mock `next/navigation`'s `useRouter`, matching `tests/components/CheckInModal.test.tsx`'s pattern — otherwise rendering throws for lack of a router context.
- To mock a *different* return value per test case from the same module (needed for the portal page's second, isolation-focused test case), use `vi.resetModules()` + `vi.doMock()` + a dynamic `await import(...)` inside that `it()`, matching the established pattern in `tests/pages/dashboard-routing.test.tsx`'s second test — not a second static `vi.mock()` at module top level, which cannot vary per test.
- Vitest invocation: `npx dotenv -e .env.local -- npx vitest run <path>` (`fileParallelism: false`, real DB round trips — don't shorten `testTimeout`).
- Commit messages end with no attribution trailer.

## Review Focus

1. **The new API test must assert on response *content* (message ids/body text), not just status code** — spec §5 item 1 explicitly calls out that today's staff-side tests only check status codes against a single patient; a test that re-checks `res.status === 200` without inspecting the body would not actually close the gap. (Task 1)
2. **The new API test must seed a real `OTHER_PATIENT_ID` message with distinctive body text and assert its exact id and body string are both absent from the JSON response** — asserting only "the array length is 1" would pass even if the route's `WHERE` clause were accidentally dropped, since this test file's `afterEach` cleans up between tests; the assertion must name what must *not* appear, not just count what does. (Task 1)
3. **The portal-page test's fixture data for the two patients must use distinct, greppable body strings** ("Patient A only message body" / "Patient B only message body") rather than generic placeholder text, so a regression that swapped which patient's data the page fetched would produce a visible, unambiguous test failure rather than an accidental pass on lookalike fixtures. (Task 2)
4. **The portal page's second test case must prove the page has no way to *request* another patient's thread**, not merely that it doesn't render one when given its own — done by asserting the mocked `listMessagesForPatient` was called with exactly the session's own `patientId` (`RD-0002`), confirming the page always forwards `session.patientId` and never a hardcoded or attacker-influenced value. (Task 2)
5. **Neither new test may leave orphaned rows in the shared dev database** — the API test's seeded messages must be deleted in `afterEach` via the existing `createdIds` array even if an assertion in the test throws first, and the page test (which only mocks the query layer, never hits the real DB) must not accidentally call the *real* `@/lib/queries/messages` module. (Task 1, Task 2)

---

### Task 1: API-layer isolation test — `tests/api/messages.test.ts`

**Files:**
- Modify: `tests/api/messages.test.ts`

**Interfaces:**
- Consumes: `GET` from `@/app/api/messages/[patientId]/route` (existing, unchanged); `sendMessage(patientId: string, senderRole: 'provider'|'patient', senderName: string, body: string)` from `@/lib/queries/messages` (existing, unchanged, not currently imported in this file); the file's existing `STAFF_PATIENT_ID` (`'RD-0001'`), `OTHER_PATIENT_ID` (`'RD-0002'`), `req()` helper, and `createdIds` cleanup array.
- Produces: nothing consumed by later tasks — this task is self-contained.

- [ ] **Step 1: Add the `sendMessage` import**

In `tests/api/messages.test.ts`, add to the existing import block:

```ts
import { sendMessage } from '@/lib/queries/messages'
```

- [ ] **Step 2: Write the failing test**

Add this `it()` inside the existing `describe('GET /api/messages/[patientId]')` block (after the `'prefers a staff session...'` test, before the `'marks provider-authored messages read...'` test):

```ts
it('excludes another patient\'s message content from a staff GET of this patient\'s thread', async () => {
  const ownMessage = await sendMessage(STAFF_PATIENT_ID, 'patient', 'Maria Alvarez', 'Only for my thread, patient A')
  createdIds.push(ownMessage.id)
  const otherMessage = await sendMessage(OTHER_PATIENT_ID, 'patient', 'Test Patient B', 'Should never appear in patient A\'s thread')
  createdIds.push(otherMessage.id)

  vi.mocked(auth.getSession).mockResolvedValue({ role: 'crc', name: 'Jamie Ruiz' })
  const res = await GET(req() as never, { params: Promise.resolve({ patientId: STAFF_PATIENT_ID }) })
  const body = await res.json()
  const bodyText = JSON.stringify(body)

  expect(res.status).toBe(200)
  expect(body.some((m: { id: number }) => m.id === ownMessage.id)).toBe(true)
  expect(bodyText).toContain('Only for my thread, patient A')
  expect(body.some((m: { id: number }) => m.id === otherMessage.id)).toBe(false)
  expect(bodyText).not.toContain('Should never appear in patient A\'s thread')
})
```

- [ ] **Step 3: Run it to confirm the test file still parses and the new test passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/messages.test.ts`
Expected: PASS, including the new test — this is a regression test for already-correct behavior (per the audit's verdict), so it is expected to pass on first run, not fail-then-fix. Confirm it actually exercises the assertions by temporarily reading the diff, not just trusting a green run: the two `.not`/`false` assertions are the ones that would have caught a real leak.

- [ ] **Step 4: Run the full file once more to confirm no other test in it regressed**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/messages.test.ts`
Expected: PASS, all tests in the file (including the pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add tests/api/messages.test.ts
git commit -m "$(cat <<'EOF'
test: assert staff GET of a patient's message thread excludes another patient's content

EOF
)"
```

---

### Task 2: Patient-portal page isolation test — `tests/pages/patient-portal-messages.test.tsx`

**Files:**
- Create: `tests/pages/patient-portal-messages.test.tsx`

**Interfaces:**
- Consumes: `PatientPortalMessagesPage` (default export) from `@/app/patient-portal/(authenticated)/messages/page`; that page's own dependencies — `requirePatientSessionOrRedirect` (`@/lib/patient-session`), `getPatientPortalIdentity` (`@/lib/queries/patient-portal`), `listMessagesForPatient`/`markReadByPatient` (`@/lib/queries/messages`), `logPatientPortalAction` (`@/lib/patient-portal-audit`) — all mocked, none hitting the real DB.
- Produces: nothing consumed by later tasks — this task is self-contained.

- [ ] **Step 1: Read the page under test once more to confirm the exact prop/return shapes to mock**

`src/app/patient-portal/(authenticated)/messages/page.tsx` calls, in order: `requirePatientSessionOrRedirect()` → `{ patientId }`; `getPatientPortalIdentity(session.patientId)` → `{ id, name, dob } | null` (a `null` triggers `notFound()`, so the mock must return a truthy object); `logPatientPortalAction(...)`; `listMessagesForPatient(session.patientId)` → array of `MessageRow` (`{ id, senderRole, senderName, body, createdAt }`, from `src/components/MessageThreadView.tsx`); `markReadByPatient(session.patientId)`. It renders `MessageThreadView` (message bodies as plain text) and `MessageComposer` (a client component using `useRouter()`).

- [ ] **Step 2: Write the failing test — first case (own patient's messages only)**

Create `tests/pages/patient-portal-messages.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import PatientPortalMessagesPage from '@/app/patient-portal/(authenticated)/messages/page'
import { render, screen } from '@testing-library/react'

const PATIENT_A_MESSAGE = { id: 1, senderRole: 'provider' as const, senderName: 'Dr. R. Kunam', body: 'Patient A only message body', createdAt: new Date().toISOString() }
const PATIENT_B_MESSAGE = { id: 2, senderRole: 'provider' as const, senderName: 'Dr. R. Kunam', body: 'Patient B only message body', createdAt: new Date().toISOString() }

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock('@/lib/patient-session', () => ({ requirePatientSessionOrRedirect: vi.fn(async () => ({ patientId: 'RD-0001' })) }))
vi.mock('@/lib/patient-portal-audit', () => ({ logPatientPortalAction: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/patient-portal', () => ({ getPatientPortalIdentity: vi.fn(async () => ({ id: 'RD-0001', name: 'Maria Alvarez', dob: '1990-01-01' })) }))
vi.mock('@/lib/queries/messages', () => ({
  listMessagesForPatient: vi.fn(async (patientId: string) => (patientId === 'RD-0001' ? [PATIENT_A_MESSAGE] : [PATIENT_B_MESSAGE])),
  markReadByPatient: vi.fn(async () => undefined),
}))

describe('Patient portal messages page (isolation)', () => {
  it('renders only the session\'s own patient\'s message bodies', async () => {
    const jsx = await PatientPortalMessagesPage()
    render(jsx)
    expect(screen.getByText('Patient A only message body')).toBeInTheDocument()
    expect(screen.queryByText('Patient B only message body')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Run it to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/pages/patient-portal-messages.test.tsx`
Expected: PASS.

- [ ] **Step 4: Add the second test case — a different session patientId has no way to reach another patient's thread**

Append inside the same `describe` block, after the first `it()`:

```tsx
  it('has no prop/param to request another patient\'s thread -- a different session patientId only ever fetches that session\'s own messages', async () => {
    vi.resetModules()
    vi.doMock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
    vi.doMock('@/lib/patient-session', () => ({ requirePatientSessionOrRedirect: vi.fn(async () => ({ patientId: 'RD-0002' })) }))
    vi.doMock('@/lib/patient-portal-audit', () => ({ logPatientPortalAction: vi.fn(async () => undefined) }))
    vi.doMock('@/lib/queries/patient-portal', () => ({ getPatientPortalIdentity: vi.fn(async () => ({ id: 'RD-0002', name: 'Someone Else', dob: '1985-05-05' })) }))
    const mockListMessagesForPatient = vi.fn(async (patientId: string) => (patientId === 'RD-0001' ? [PATIENT_A_MESSAGE] : [PATIENT_B_MESSAGE]))
    vi.doMock('@/lib/queries/messages', () => ({ listMessagesForPatient: mockListMessagesForPatient, markReadByPatient: vi.fn(async () => undefined) }))

    const { default: PatientPortalMessagesPageForB } = await import('@/app/patient-portal/(authenticated)/messages/page')
    const { render: renderB, screen: screenB } = await import('@testing-library/react')
    const jsx = await PatientPortalMessagesPageForB()
    renderB(jsx)

    expect(mockListMessagesForPatient).toHaveBeenCalledWith('RD-0002')
    expect(screenB.getByText('Patient B only message body')).toBeInTheDocument()
    expect(screenB.queryByText('Patient A only message body')).not.toBeInTheDocument()
  })
```

- [ ] **Step 5: Run the full file to confirm both cases pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/pages/patient-portal-messages.test.tsx`
Expected: PASS, both tests.

- [ ] **Step 6: Run the whole suite once to confirm no collateral breakage**

Run: `npx dotenv -e .env.local -- npx vitest run`
Expected: all pass (this task adds a new file and does not touch production code, so no other file should be affected).

- [ ] **Step 7: Commit**

```bash
git add tests/pages/patient-portal-messages.test.tsx
git commit -m "$(cat <<'EOF'
test: add patient-portal messages page isolation test

EOF
)"
```
