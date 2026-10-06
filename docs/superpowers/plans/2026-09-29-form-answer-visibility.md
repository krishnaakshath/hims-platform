# Form Answer Visibility (Admin & Doctors) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin, with a regression test, the capability the spec confirms already exists — that `admin` and `pi` staff sessions can call `GET /api/form-submissions/[id]` and get back a patient's real submitted `answers` (not just a status field) — so a future refactor can't silently narrow this without any test failing.

**Architecture:** No production code changes. The spec (§1) found no gap: `GET /api/form-submissions/[id]` already calls `requireSession()` with no role restriction and returns the full submission, including `answers`, from `getFormSubmission()`. This plan adds exactly one new test file that exercises the real route against a real database fixture, asserting the actual answer value comes back for both `admin` and `pi`.

**Tech Stack:** Vitest, real Neon Postgres dev database (no mocking of the DB layer), Drizzle ORM, `vi.mock`/`vi.mocked` for session-role overrides.

**Spec:** `docs/superpowers/specs/2026-09-29-form-answer-visibility.md`

**Working directory note:** this plan is executed in an isolated git worktree at `/Users/k2a/Desktop/clinsync/.worktrees/form-answer-visibility` on branch `feature/form-answer-visibility`. This worktree is missing `.env.local` (present in the main checkout and other worktrees) — before running any test in Task 1, copy it from the main checkout: `cp /Users/k2a/Desktop/clinsync/.env.local /Users/k2a/Desktop/clinsync/.worktrees/form-answer-visibility/.env.local`. This is a **single shared Neon Postgres database across every branch/worktree** — the fixture this plan inserts must be cleaned up in `afterEach`, same as every other real-DB test in this suite.

## Global Constraints

- No implementation/production code changes — this plan is test-only, per the spec's own recommendation (§1: "close this as no work needed... §2 adds that regression test; nothing else in this spec").
- Do not add or change any role gate on `GET /api/form-submissions/[id]` or anywhere else — the spec explicitly rules this out (§3: "Adding or changing any role gate — none is needed").
- The new test asserts the actual `answers.q1` value, not merely the presence of a `status` field or a 200 response — the spec (§2) is explicit that presence-only assertions are what let a future narrowing regress silently.
- Do not assert anything about `crc`/`frontdesk` visibility in this test — out of scope per spec §2 ("without asserting anything about `crc`/`frontdesk`... out of scope to enumerate further").
- Vitest invocation: `npx dotenv -e .env.local -- npx vitest run <path>` (`fileParallelism: false`, shared live DB — see `vitest.config.ts`).
- Commit messages end with no attribution trailer.

## Review Focus

1. **The test must assert the real answer value (`body.answers.q1 === 'yes'`), not just `res.status === 200`** — a test that only checks status would pass even if a future change stripped `answers` from the response entirely, defeating the whole purpose of this plan (spec §2).
2. **Both `admin` and `pi` must be exercised as separate cases in the same test file**, each with its own `mockResolvedValueOnce` override — a single shared/default mock covering only one role would leave the other role's visibility completely unpinned.
3. **The fixture must be a real inserted `formTemplates`/`formSubmissions` row against a real seeded patient (`RD-0001`), cleaned up in `afterEach`**, not a mocked query layer — mocking `getFormSubmission()` would test the mock, not the real route + real query + real DB round trip the spec is concerned about.
4. **The submission's `category` must not be `'Consent Forms'`** — `GET` itself has no gate, but reusing a consent-category fixture invites confusion with the unrelated signature-gate tests in `form-submission-complete-signature-gate.test.ts`; a neutral category (e.g. `'Screening Questionnaires'`) keeps this test legible as pure visibility coverage.
5. **`vi.mock('@/lib/auth', ...)` must use `vi.importActual` and only override `requireSession`**, matching `tests/api/patients.test.ts`'s pattern — a naive `vi.mock('@/lib/auth', () => ({ requireSession: ... }))` (the simpler form used in `form-submission-complete-signature-gate.test.ts`) would strip every other named export of `@/lib/auth` that this file might transitively need, and would prevent per-test `mockResolvedValueOnce` role overrides across two separate `it()` blocks from being independently reliable within one file.

---

### Task 1: Add `tests/api/form-submission-answer-visibility.test.ts`

**Files:**
- Test: `tests/api/form-submission-answer-visibility.test.ts` (new)

**Interfaces:**
- Consumes: `GET` from `@/app/api/form-submissions/[id]/route` (existing, unchanged — signature `GET(request: NextRequest, { params }: { params: Promise<{ id: string }> })`); `requireSession` from `@/lib/auth` (existing, unchanged); `formTemplates`, `formSubmissions` from `@/db/schema` (existing, unchanged).
- Produces: nothing consumed by later tasks — this is the only task in this plan.

- [ ] **Step 1: Write the failing test**

Create `tests/api/form-submission-answer-visibility.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import * as auth from '@/lib/auth'
import { GET } from '@/app/api/form-submissions/[id]/route'
import { getDb } from '@/db/client'
import { formTemplates, formSubmissions } from '@/db/schema'

// Per-test role override pattern from tests/api/patients.test.ts: import the
// real module via vi.importActual and override only requireSession, so each
// it() below can set its own role with mockResolvedValueOnce without
// stripping any other export of @/lib/auth.
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: 'crc' as const, name: 'Test CRC' })) }
})

const PATIENT_ID = 'RD-0001' // seeded real patient

const createdTemplateIds: number[] = []
const createdSubmissionIds: number[] = []
afterEach(async () => {
  while (createdSubmissionIds.length > 0) await getDb().delete(formSubmissions).where(eq(formSubmissions.id, createdSubmissionIds.pop()!))
  while (createdTemplateIds.length > 0) await getDb().delete(formTemplates).where(eq(formTemplates.id, createdTemplateIds.pop()!))
})

async function makeSubmission() {
  const db = getDb()
  const [template] = await db.insert(formTemplates).values({
    name: `Test Answer Visibility ${Date.now()}`, category: 'Screening Questionnaires', diagnosisTag: 'test', questions: [],
  }).returning()
  createdTemplateIds.push(template.id)
  const [submission] = await db.insert(formSubmissions).values({
    templateId: template.id, patientId: PATIENT_ID, status: 'completed', answers: { q1: 'yes' },
  }).returning()
  createdSubmissionIds.push(submission.id)
  return submission
}

describe('GET /api/form-submissions/[id] -- answer visibility for admin and pi', () => {
  it('returns the real submitted answer to an admin session', async () => {
    const submission = await makeSubmission()
    vi.mocked(auth.requireSession).mockResolvedValueOnce({ role: 'admin', name: 'Test Admin' })
    const res = await GET(new Request(`http://localhost/api/form-submissions/${submission.id}`) as never, { params: Promise.resolve({ id: String(submission.id) }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.answers.q1).toBe('yes')
  })

  it('returns the real submitted answer to a pi session', async () => {
    const submission = await makeSubmission()
    vi.mocked(auth.requireSession).mockResolvedValueOnce({ role: 'pi', name: 'Test PI' })
    const res = await GET(new Request(`http://localhost/api/form-submissions/${submission.id}`) as never, { params: Promise.resolve({ id: String(submission.id) }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.answers.q1).toBe('yes')
  })
})
```

- [ ] **Step 2: Run it to confirm it currently passes (this is a regression test for existing behavior, not a new feature — there is no red-then-green cycle here since the spec found no gap to close)**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/form-submission-answer-visibility.test.ts`
Expected: PASS, both tests. If either fails, stop — that would mean the spec's finding (§1) was wrong and there is a real gap after all; do not proceed to commit until that's understood, since this plan is test-only and adds no route/query changes to fix a gap.

- [ ] **Step 3: Run the full suite once to confirm nothing else regressed**

Run: `npx dotenv -e .env.local -- npx vitest run`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add tests/api/form-submission-answer-visibility.test.ts
git commit -m "$(cat <<'EOF'
test: pin that admin and pi see real form submission answers, not just status

EOF
)"
```
