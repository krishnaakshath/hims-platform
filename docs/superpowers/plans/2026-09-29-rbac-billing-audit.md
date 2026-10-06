# App-Wide RBAC Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the server enforce the role boundaries `LeftNav.tsx` already declares — 24 page routes and 14 handlers across the 11 API route files (the spec's "eleven routes") that today are reachable by any authenticated staff role by typing a URL — and make that class of gap structurally unable to recur.

**Architecture:** No new abstraction. Each of the 24 pages gets the house one-liner `if (!['admin','crc'].includes(session.role)) redirect('/')` as the statement immediately after `requireSessionOrRedirect()`, matching the six pages that already do it (`audit-log/page.tsx:20`, `labs/page.tsx:11`); each of the 14 API handlers gets the same allowlist as a `403`, immediately after the `requireSession()` `instanceof NextResponse` check, matching `booking-requests/[id]/confirm/route.ts:21`. Every role list is **copied verbatim from the `roles` array `LeftNav.tsx` already carries for that route** — this plan changes who the *server* lets in, never who the *nav* lets in. The routes are fixed in four risk-ordered groups (highest-severity PHI surface first), and then Task 5 exports `LeftNav`'s own nav tables and turns the page-gate test table into a **derivation** of them, so a future nav-only restriction cannot be added without the suite demanding a matching server-side gate.

**Tech Stack:** Next.js 16 App Router (Server Components) + Drizzle ORM over a `pg` Pool + Zod `.strict()` + `requireSession()` / `requireSessionOrRedirect()` (`src/lib/auth.ts`) + `logAudit()` (`src/lib/audit.ts`) + vitest (jsdom, `fileParallelism: false`, `testTimeout: 15000`).

**Spec:** `docs/superpowers/specs/2026-09-29-rbac-billing-audit.md`

**Working directory note:** this plan is executed in an isolated git worktree at `/Users/k2a/Desktop/clinsync/.worktrees/rbac-billing-audit` on branch `feature/rbac-billing-audit`, forked from `hims-platform` at `9f937a1`. **This worktree has `.env.local` but no `node_modules` yet** — Task 1 Step 1 installs them. Every implementer/reviewer dispatch must work from this exact directory: ~20 other worktrees hold concurrent work on the same shared database; do not touch them.

## Global Constraints

- **`hims-platform` branch only.** This branch forks from it and merges back to it. No other target.
- **This plan only ever makes code MORE restrictive**, to match nav intent that already exists. **Every new gate's role list must be traceable to `LeftNav.tsx`'s existing `roles` array for that route, cited by `file:line` in the code comment or the task text.** The two lists in play are:
  - `['admin', 'crc']` — `LeftNav.tsx:33,34,37` (`ITEMS`) and `:60-64` (`TRAILING_ITEMS`)
  - `['admin', 'crc', 'frontdesk']` — `LeftNav.tsx:98` (`showBilling`)
- **No new policy.** Whether `pi` *should* see Reports is a product question (spec §11.1) and is not settled here. Do not add, remove or reorder a role in any list relative to what `LeftNav.tsx` declares.
- **No role loses a capability it can actually reach through the UI today.** One place needs active work to honor this — `/patients/page.tsx:28` renders a "Download Verification Workbook" link to `/api/workbook/export` for *every* role; Task 1 hides that control for the roles it gates out rather than leaving them a button that 403s. Flagged again in Review Focus #3.
- Every protected route still starts with `requireSession()` (API) / `requireSessionOrRedirect()` (pages) as its **first** statement — already true in all 35 files; the role check goes immediately *after* it (and after the `instanceof NextResponse` line on API routes), **before** any `logAudit()` call or data fetch.
- **No `requireRole()` helper, no middleware role routing, no declarative route→role map** (spec §10). The inline one-liner is the idiom this codebase already uses and greps for.
- **Do not touch** `POST`/`PUT /api/form-templates*`, `PATCH /api/documents/[id]`, or `POST`/`PATCH`/`GET /api/charges*` — not even a comment. Verified still ungated on `hims-platform` at `9f937a1` and in this worktree as of 2026-09-29; owned by the forms-hub, document-assignment and pharmacy-dashboard plans respectively. If an executor finds one already fixed on merge, that is fine and still not this branch's work.
- **Do not fix the fuzzy provider match** (spec §5). Task 8 adds only the regression test, deliberately red.
- No schema changes. No new query functions. No new pages, routes or components.
- Vitest invocation: `npx dotenv -e .env.local -- npx vitest run <path>` (or `npm test` for the whole suite).
- Commit messages end with no attribution trailer.

## Review Focus

1. **A denied role must be turned away *before* the page loads PHI.** A gate placed after `logAudit()` or after the `Promise.all([...])` data fetch would still stream patient data into the response body — the exact failure the auth-hardening work already fixed once (`patients/page.tsx:10-16`). Task 1's harness blocks `@/db/client` and asserts `getDb` is never reached for a denied role.
2. **`GET /api/workbook/full` as `frontdesk` must 403 before the `.xlsx` is built**, not after — this is the headline finding of the spec and the one route where "gated but still does the work" would be indistinguishable from gated in a status-code-only test. (Task 1)
3. **A control that now 403s but is still rendered.** `/patients/page.tsx:28` links every role to `/api/workbook/export`. Gating that route without hiding the link converts a working button into a broken one for `pi` and `frontdesk`. (Task 1)
4. **A dynamic page must redirect a denied role, not 404 it.** `/forms/[templateId]`, `/broadcasts/[id]`, `/experience-surveys/[id]`, `/billing/charges/[chargeId]` each call `notFound()` on an unknown id; if the gate lands after that, a denied role learns whether a given id exists. (Tasks 2, 3, 4)
5. **A new nav section restricted in the nav only.** The coverage assertion must fail when a `roles`-carrying nav entry has *zero* gated page rows, not merely when a listed row disagrees — a prefix rule that quietly matches nothing is the way this whole class of bug gets reintroduced. (Task 5)

---

### Task 1: Worktree setup + the two highest-severity surfaces — Workbook and Identity Matching

The full 30-column pre-screening workbook as a downloadable `.xlsx`, and patient identity merge/split. Both are `['admin','crc']` in the nav and open to everyone on the server today. This task also builds the two test harnesses every later gating task reuses.

**Files:**
- Modify: `src/app/(dashboard)/workbook/page.tsx:7`, `src/app/(dashboard)/identity-matching/page.tsx:8`
- Modify: `src/app/(dashboard)/patients/page.tsx:28` (hide the workbook-export link; do **not** gate the page)
- Modify: `src/app/api/workbook/full/route.ts:9`, `src/app/api/workbook/export/route.ts:13`, `src/app/api/identity-matches/route.ts:8`, `src/app/api/identity-matches/[id]/confirm/route.ts:12`, `src/app/api/identity-matches/[id]/reject/route.ts:16`
- Test: `tests/pages/nav-role-enforcement.test.tsx` (new — the page-gate harness)
- Test: `tests/api/rbac-route-gates.test.ts` (new — the API-gate harness)

**Interfaces:**
- Produces, for Tasks 2-5, in `tests/pages/nav-role-enforcement.test.tsx`:
  ```ts
  type PageGateCase = {
    route: string                        // the URL path, e.g. '/forms/[templateId]'
    load: () => Promise<{ default: (props?: never) => Promise<unknown> }>
    props?: unknown                      // { params: Promise<...>, searchParams: Promise<...> }
    allowed: Role[]                      // copied from LeftNav.tsx, cited in a comment
  }
  const PAGE_GATES: PageGateCase[]       // later tasks append rows; Task 5 asserts it covers LeftNav
  async function runPage(c: PageGateCase, role: Role): Promise<void>
  ```
- Produces, for Tasks 2 and 4, in `tests/api/rbac-route-gates.test.ts`: a module-scope mutable `sessionRole` + `vi.mock('@/lib/auth', …)` following `tests/api/patients.test.ts:27-29`, and `const ALL_ROLES: Role[] = ['admin','crc','pi','frontdesk']`.

- [ ] **Step 1: Set the worktree up and record a green baseline**

```bash
cd /Users/k2a/Desktop/clinsync/.worktrees/rbac-billing-audit
ls -la .env.local          # expected: present, ~4.3KB (copied in by the controller)
npm install
npx dotenv -e .env.local -- npx vitest run
```
Expected: `.env.local` exists; install completes; the full suite passes. If `.env.local` is missing or the baseline is red, **stop and report** — a red baseline makes every later "expected: PASS" meaningless.

Also re-check the spec's §2.2 precondition and §7.4 contingency, and record the answer in the commit message if it changed:
```bash
grep -n "roleEnum" src/db/schema.ts && grep -n "export type Role" src/lib/auth.ts
```
Expected: exactly four roles (`crc`, `pi`, `admin`, `frontdesk`). **If a fifth role (`pharmacy`) has landed, add it to no list in this plan** — it is denied everywhere here, which is what both pharmacy plans intend.

- [ ] **Step 2: Write the failing page-gate test (harness + this task's two rows)**

Create `tests/pages/nav-role-enforcement.test.tsx`. The harness follows `tests/pages/audit-log.test.tsx`'s `vi.hoisted` + `vi.resetModules()` + per-case `vi.doMock` shape, with two deliberate changes, each worth a comment in the file:

- `mockRedirect` **throws** (`() => { throw new Error('NEXT_REDIRECT') }`), like the real `next/navigation` `redirect()`. That is what stops a denied role's page body from running on into the data fetch, and it is what makes Review Focus #1 observable.
- `@/db/client`'s `getDb` is mocked to throw `DB_BLOCKED`, so no page in the table needs its own query modules mocked. An allowed role gets past the gate and dies at the DB sentinel; the assertion is about `mockRedirect`, not about rendering.

```tsx
const { mockRedirect, mockGetDb } = vi.hoisted(() => ({
  mockRedirect: vi.fn(() => { throw new Error('NEXT_REDIRECT') }),
  mockGetDb: vi.fn(() => { throw new Error('DB_BLOCKED') }),
}))

const ALL_ROLES: Role[] = ['admin', 'crc', 'pi', 'frontdesk']

async function runPage(c: PageGateCase, role: Role) {
  vi.resetModules()
  mockRedirect.mockClear()
  mockGetDb.mockClear()
  vi.doMock('next/navigation', () => ({
    redirect: mockRedirect,
    notFound: () => { throw new Error('NEXT_NOT_FOUND') },
  }))
  vi.doMock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
  vi.doMock('@/db/client', () => ({ getDb: mockGetDb }))
  vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role, name: `Test ${role}` })) }))
  const mod = await c.load()
  try { await mod.default(c.props as never) } catch { /* DB_BLOCKED, NEXT_REDIRECT and render errors after the gate are all fine */ }
}

const PAGE_GATES: PageGateCase[] = [
  // LeftNav.tsx:33 — { href: '/workbook', roles: ['admin', 'crc'] }
  { route: '/workbook', load: () => import('@/app/(dashboard)/workbook/page'), allowed: ['admin', 'crc'] },
  // LeftNav.tsx:34 — { href: '/identity-matching', roles: ['admin', 'crc'] }
  { route: '/identity-matching', load: () => import('@/app/(dashboard)/identity-matching/page'), allowed: ['admin', 'crc'] },
]

describe.each(PAGE_GATES)('$route', (c) => {
  it('redirects every role the nav hides, and no role the nav shows', async () => {
    for (const role of ALL_ROLES) {
      await runPage(c, role)
      if (c.allowed.includes(role)) {
        expect(mockRedirect, `${c.route} must not redirect ${role}`).not.toHaveBeenCalled()
      } else {
        expect(mockRedirect, `${c.route} must redirect ${role}`).toHaveBeenCalledWith('/')
      }
    }
  })

  // Review Focus #1
  it('never touches the database for a role it denies', async () => {
    for (const role of ALL_ROLES.filter((r) => !c.allowed.includes(r))) {
      await runPage(c, role)
      expect(mockGetDb, `${c.route} loaded data before denying ${role}`).not.toHaveBeenCalled()
    }
  })
})
```

Every row carries `props: { params: Promise.resolve({ … }), searchParams: Promise.resolve({}) }` when the page's signature takes either; passing an unused extra prop is harmless.

- [ ] **Step 3: Write the failing API-gate test (harness + this task's five handlers)**

Create `tests/api/rbac-route-gates.test.ts`, using the `vi.mock('@/lib/auth', …)` + `importOriginal` pattern from `tests/api/patients.test.ts:27-29` with a mutable `sessionRole` (default `'crc'`) reset in `afterEach`.

For an **allowed** role, assert a **non-403** without mutating data: the two `GET`s return `200`, and both identity-match `POST`s use an id that does not exist so the gate passes and the route's own `404` proves it (`confirm/route.ts:19`, `reject/route.ts:20`).

```ts
describe('GET /api/workbook/full', () => {
  it('403s pi and frontdesk', async () => { /* each -> 403 */ })
  it('returns the xlsx for admin and crc', async () => { /* each -> 200 */ })

  // Review Focus #2 — the gate must precede the export, not follow it
  it('does not build the workbook for a denied role', async () => {
    sessionRole = 'frontdesk'
    const res = await GET()
    expect(res.status).toBe(403)
    expect(buildWorkbookSpy).not.toHaveBeenCalled()   // vi.mock the xlsx builder module this route imports
  })
})

describe('GET /api/workbook/export', () => { /* 403 pi, 403 frontdesk, 200 admin, 200 crc */ })
describe('GET /api/identity-matches', () => { /* 403 pi, 403 frontdesk, 200 admin */ })
describe('POST /api/identity-matches/[id]/confirm', () => {
  it('403s pi and frontdesk', async () => { /* id '999999' -> 403, not 404 */ })
  it('reaches the handler for admin', async () => { /* id '999999' -> 404 */ })
})
describe('POST /api/identity-matches/[id]/reject', () => { /* same shape */ })
```

- [ ] **Step 4: Run both to confirm they fail**

Run: `npx dotenv -e .env.local -- npx vitest run tests/pages/nav-role-enforcement.test.tsx tests/api/rbac-route-gates.test.ts`
Expected: FAIL — `pi`/`frontdesk` are not redirected and get `200`/`404` instead of `403`.

- [ ] **Step 5: Add the two page gates**

In both `src/app/(dashboard)/workbook/page.tsx` and `src/app/(dashboard)/identity-matching/page.tsx`, add `redirect` to the `next/navigation` import (neither file imports it today) and insert, as the statement immediately after `const session = await requireSessionOrRedirect()` and before `logAudit`:

```ts
  // LeftNav.tsx:33 hides this section from every role but admin/crc; that is
  // nav rendering, not enforcement. Same list, same redirect target as
  // audit-log/page.tsx:20.
  if (!['admin', 'crc'].includes(session.role)) redirect('/')
```

(Cite `LeftNav.tsx:34` in `identity-matching/page.tsx`.)

- [ ] **Step 6: Add the five API gates**

In each of the five route files, immediately after `if (session instanceof NextResponse) return session`:

```ts
  if (!['admin', 'crc'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
```

On `workbook/full/route.ts` and `workbook/export/route.ts` the comment records what the gate is actually protecting: the complete 30-column pre-screening workbook for every patient, the thing a `frontdesk` session could download today (spec §3.4.1). On the two identity-match `POST`s: confirming or rejecting a match **merges or splits two patient identity records**.

- [ ] **Step 7: Hide the now-gated export link on `/patients`** — Review Focus #3

`src/app/(dashboard)/patients/page.tsx:28` renders `<a href="/api/workbook/export">Download Verification Workbook</a>` for every role. `/patients` itself stays open to all roles (spec §6.1, §10 — do **not** gate the page). Wrap only the anchor:

```tsx
{['admin', 'crc'].includes(session.role) && (
  <a href="/api/workbook/export" …>Download Verification Workbook</a>
)}
```

This is the one control this plan removes from a role's screen. It is the same allowlist as the route it links to, and the alternative — leaving `pi` and `frontdesk` a button that now 403s — is worse. If the human partner would rather keep the export open to all roles, that is a one-word change to the route's list and to this line, made together.

- [ ] **Step 8: Run this task's tests, plus the routes' pre-existing tests**

Run: `npx dotenv -e .env.local -- npx vitest run tests/pages/nav-role-enforcement.test.tsx tests/api/rbac-route-gates.test.ts tests/api/identity-matches.test.ts`
Expected: PASS. `tests/api/identity-matches.test.ts:20` already mocks `role: 'crc'`, which is inside the new allowlist, so its existing cases must be unaffected — if any of them break, the gate is in the wrong place.

- [ ] **Step 9: Commit**

```bash
git add tests/pages/nav-role-enforcement.test.tsx tests/api/rbac-route-gates.test.ts src/app/api/workbook src/app/api/identity-matches "src/app/(dashboard)/workbook" "src/app/(dashboard)/identity-matching" "src/app/(dashboard)/patients/page.tsx"
git commit -m "$(cat <<'EOF'
fix: enforce admin/crc server-side on the workbook export and identity matching

EOF
)"
```

---

### Task 2: Billing — 8 pages + `POST /api/mock-payments`

The only group whose list is `['admin', 'crc', 'frontdesk']` (`LeftNav.tsx:98`). Seven pages are nav entries (`BILLING_ITEMS`, `:50-56`); `/billing/charges/[chargeId]` is the detail page behind Charges.

**Files:**
- Modify: `src/app/(dashboard)/billing/charges/page.tsx:8`, `billing/charges/[chargeId]/page.tsx:20`, `billing/insurance-collections/page.tsx:7`, `billing/patient-collections/page.tsx:7`, `billing/statements/page.tsx:7`, `billing/ar-dashboard/page.tsx:17`, `billing/analytics/page.tsx:17`, `billing/pay/page.tsx:12`
- Modify: `src/app/api/mock-payments/route.ts:26`
- Modify: `tests/pages/nav-role-enforcement.test.tsx` (8 rows), `tests/api/rbac-route-gates.test.ts` (1 describe)

**Interfaces:**
- Consumes: `PAGE_GATES`, `runPage`, `sessionRole` (Task 1).
- Produces: nothing new.

- [ ] **Step 1: Add the failing rows**

Eight rows to `PAGE_GATES`, all `allowed: ['admin', 'crc', 'frontdesk']`, each commented `LeftNav.tsx:98 — showBilling`. `/billing/charges/[chargeId]` takes `props: { params: Promise.resolve({ chargeId: '1' }) }`; `/billing/pay` takes `searchParams`.

One `describe('POST /api/mock-payments')` in `tests/api/rbac-route-gates.test.ts`: `pi` → `403`; `admin`, `crc`, `frontdesk` → **not** `403` (post an intentionally invalid body so the gate passes and the route's own Zod `400` at `:29` proves it, recording no payment).

- [ ] **Step 2: Run them to confirm they fail**

Run: `npx dotenv -e .env.local -- npx vitest run tests/pages/nav-role-enforcement.test.tsx tests/api/rbac-route-gates.test.ts`
Expected: FAIL — `pi` is not redirected from any billing page and gets `400`/`201` rather than `403` from mock-payments.

- [ ] **Step 3: Add the nine gates**

Each of the 8 pages: add `redirect` to its `next/navigation` import (only `billing/charges/[chargeId]/page.tsx` imports from that module today, for `notFound` — extend it), then immediately after `const session = await requireSessionOrRedirect()`:

```ts
  // LeftNav.tsx:98 — the Billing group is rendered for admin/crc/frontdesk only.
  if (!['admin', 'crc', 'frontdesk'].includes(session.role)) redirect('/')
```

On `[chargeId]/page.tsx` the gate must precede the `notFound()` path (Review Focus #4). In `src/app/api/mock-payments/route.ts`, the same list as a `403` after the `instanceof` check at `:26`.

- [ ] **Step 4: Run this task's tests plus the route's own**

Run: `npx dotenv -e .env.local -- npx vitest run tests/pages/nav-role-enforcement.test.tsx tests/api/rbac-route-gates.test.ts tests/api/mock-payments.test.ts`
Expected: PASS — `tests/api/mock-payments.test.ts:7` mocks `role: 'crc'`, inside the new list, so its cases are unaffected. `src/components/VirtualCardPaymentForm.tsx:29` is the only client caller of this route and it lives on `/billing/pay`, whose gate is now the same list.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/billing" src/app/api/mock-payments/route.ts tests/pages/nav-role-enforcement.test.tsx tests/api/rbac-route-gates.test.ts
git commit -m "$(cat <<'EOF'
fix: enforce admin/crc/frontdesk server-side across the 8 Billing pages and mock payments

EOF
)"
```

---

### Task 3: Reports, Documents, Pipeline Dashboard, Form Templates — 10 pages, no API changes

Ten `['admin','crc']` pages whose backing routes are either untouched by this plan or owned by another one. **`POST`/`PUT /api/form-templates*` stays untouched** (forms-hub's, verified still open) — gating the two Form Templates *pages* is not the same work and does not collide with it.

**Files:**
- Modify: `src/app/(dashboard)/reports/patients/page.tsx:8`, `reports/appointments/all/page.tsx:7`, `reports/claims/insurance-collections/page.tsx:7`, `reports/encounters/all/page.tsx:7`, `reports/notes/unsigned/page.tsx:7`
- Modify: `src/app/(dashboard)/documents/page.tsx:7`, `documents/fax-history/page.tsx:7`
- Modify: `src/app/(dashboard)/pipeline-dashboard/page.tsx:59`
- Modify: `src/app/(dashboard)/forms/page.tsx:8`, `forms/[templateId]/page.tsx:8`
- Modify: `tests/pages/nav-role-enforcement.test.tsx` (10 rows)

**Interfaces:**
- Consumes: `PAGE_GATES`, `runPage` (Task 1). Produces: nothing new.

- [ ] **Step 1: Add the ten failing rows**

All `allowed: ['admin', 'crc']`, each citing its nav line: `/reports/*` → `LeftNav.tsx:60`; `/documents*` → `:61`; `/pipeline-dashboard` → `:64`; `/forms*` → `:37`. `/forms/[templateId]` takes `props: { params: Promise.resolve({ templateId: '1' }) }`.

Do **not** add a row for `(dashboard)/reports/page.tsx` — it is a bare `redirect('/reports/patients')` with no session read, and once the five leaves are gated it grants nothing (spec §3.2). Record that as a comment next to the `/reports/patients` row, because it is the one nav href whose own `page.tsx` is intentionally left alone and Task 5's coverage rule will match it via the leaf.

- [ ] **Step 2: Run to confirm they fail**

Run: `npx dotenv -e .env.local -- npx vitest run tests/pages/nav-role-enforcement.test.tsx`
Expected: FAIL — 10 new cases; `pi` and `frontdesk` are not redirected.

- [ ] **Step 3: Add the ten gates**

The same one-liner and comment shape as Task 1 Step 5, with `['admin', 'crc']` and the nav line cited per file. `redirect` must be added to the `next/navigation` import in every one of the ten (only `forms/[templateId]/page.tsx` imports from it today, for `notFound` — and there the gate must come first, Review Focus #4). In `pipeline-dashboard/page.tsx` the session bind is at `:59`, well below the imports — the gate still goes immediately after it.

- [ ] **Step 4: Run to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/pages/nav-role-enforcement.test.tsx tests/api/form-templates.test.ts`
Expected: PASS. `tests/api/form-templates.test.ts` must be untouched and still green — proof this task did not wander into forms-hub's territory.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/reports" "src/app/(dashboard)/documents" "src/app/(dashboard)/pipeline-dashboard" "src/app/(dashboard)/forms" tests/pages/nav-role-enforcement.test.tsx
git commit -m "$(cat <<'EOF'
fix: enforce admin/crc server-side on Reports, Documents, Pipeline Dashboard and Form Templates

EOF
)"
```

---

### Task 4: Broadcasts and Experience Surveys — 4 pages + 8 API handlers across 5 route files

The last of the ungated surfaces, and the two with live client callers to check.

**Files:**
- Modify: `src/app/(dashboard)/broadcasts/page.tsx:9`, `broadcasts/[id]/page.tsx:8`, `experience-surveys/page.tsx:14`, `experience-surveys/[id]/page.tsx:11`
- Modify: `src/app/api/broadcasts/route.ts:30,37` (`GET` + `POST`), `src/app/api/broadcasts/[id]/route.ts:8`, `src/app/api/broadcasts/recipients/route.ts:7`, `src/app/api/reviews/route.ts:14,35` (`GET` + `POST`), `src/app/api/reviews/[id]/route.ts:21,31` (`GET` + `PUT`)
- Modify: `tests/pages/nav-role-enforcement.test.tsx` (4 rows), `tests/api/rbac-route-gates.test.ts` (8 handler cases)

**Interfaces:**
- Consumes: `PAGE_GATES`, `runPage`, `sessionRole` (Task 1). Produces: nothing new.

- [ ] **Step 1: Add the failing rows and route cases**

Four page rows, `allowed: ['admin', 'crc']`, citing `LeftNav.tsx:62` (Broadcasts) and `:63` (Experience Surveys); the two detail pages take `props: { params: Promise.resolve({ id: '1' }) }`.

Eight handler cases (across the five route files), all `['admin','crc']`, each asserting `403` for `pi` and `frontdesk` and a non-403 for `admin`. Non-mutating allowed-role probes: the three `GET`s → `200`; `POST /api/broadcasts` and `POST /api/reviews` with an invalid body → `400` (their Zod guards at `:40` and `:38`); `PUT /api/reviews/[id]` with an invalid body → `400` (`:35`). Nothing in this file may send a broadcast or record a survey response.

- [ ] **Step 2: Run to confirm they fail**

Run: `npx dotenv -e .env.local -- npx vitest run tests/pages/nav-role-enforcement.test.tsx tests/api/rbac-route-gates.test.ts`
Expected: FAIL on the 4 new page cases and the 8 new route cases.

- [ ] **Step 3: Add the twelve gates (4 pages, 8 handlers)**

Pages: the Task 1 one-liner with `['admin', 'crc']` (both detail pages already import `notFound` — extend that import with `redirect`, and put the gate before the `notFound()` path). Routes: the `403` one-liner after each handler's `instanceof` check — **each handler separately**, including both handlers in `broadcasts/route.ts`, `reviews/route.ts` and `reviews/[id]/route.ts`. The comment on `POST /api/broadcasts` records that it sends a (simulated) broadcast to a patient cohort; on `PUT /api/reviews/[id]`, that this is staff recording a survey response, not a patient endpoint (spec §7.2).

- [ ] **Step 4: Confirm no now-denied surface still calls these routes** — Review Focus #3

Run: `grep -rn "api/broadcasts\|api/reviews" src/components src/app | grep -v "^src/app/api/"`
Expected: exactly four hits — `SendSurveyButton.tsx:29`, `BroadcastWizard.tsx:88,100`, `RecordSurveyResponseForm.tsx:17` — and each must be rendered only from a page this task just gated to the same list (`experience-surveys/page.tsx`, `broadcasts/page.tsx`, `experience-surveys/[id]/page.tsx`). Any hit from an all-roles page is a broken control and must be reported, not silently gated.

- [ ] **Step 5: Run this task's tests plus the routes' own**

Run: `npx dotenv -e .env.local -- npx vitest run tests/pages/nav-role-enforcement.test.tsx tests/api/rbac-route-gates.test.ts tests/api/broadcasts.test.ts tests/api/reviews.test.ts`
Expected: PASS — both pre-existing files mock `role: 'crc'` (`broadcasts.test.ts:9`, `reviews.test.ts:8`), inside the new list, so every existing case must still pass.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(dashboard)/broadcasts" "src/app/(dashboard)/experience-surveys" src/app/api/broadcasts src/app/api/reviews tests/pages/nav-role-enforcement.test.tsx tests/api/rbac-route-gates.test.ts
git commit -m "$(cat <<'EOF'
fix: enforce admin/crc server-side on Broadcasts and Experience Surveys, pages and routes

EOF
)"
```

---

### Task 5: Derive the test table from `LeftNav.tsx` — make this class of gap unable to recur

All 24 pages are gated now. This task is the spec's single highest-value deliverable (§9.1): stop `PAGE_GATES` being a hand-copied list and make it something `LeftNav.tsx` must agree with. It runs last in the security sequence deliberately, so it asserts against the fixed state and lands green.

**Files:**
- Modify: `src/components/LeftNav.tsx:29,49,59,98` (export the three nav tables and the billing role list; no behavior change)
- Modify: `tests/pages/nav-role-enforcement.test.tsx` (add the 7 already-gated nav entries, the unrestricted-entry cases, and the derivation assertions)
- Modify: `tests/components/LeftNav.test.tsx` (add the `pi` case)

**Interfaces:**
- Consumes: `PAGE_GATES` with all 24 rows (Tasks 1-4).
- Produces, from `@/components/LeftNav`:
  ```ts
  export const NAV_ITEMS: { href: string; label: string; icon: Icon; roles?: Role[] }[]          // was ITEMS
  export const NAV_BILLING_ITEMS: { href: string; label: string; icon: Icon }[]                   // was BILLING_ITEMS
  export const NAV_TRAILING_ITEMS: { href: string; label: string; icon: Icon; roles?: Role[] }[]  // was TRAILING_ITEMS
  export const BILLING_ROLES: Role[]                                                              // ['admin','crc','frontdesk']
  ```

- [ ] **Step 1: Write the failing derivation assertions**

Add to `tests/pages/nav-role-enforcement.test.tsx`. A row *covers* a nav entry when `row.route === entry.href || row.route.startsWith(entry.href + '/')`.

```ts
function coveringRows(href: string) {
  return PAGE_GATES.filter((r) => r.route === href || r.route.startsWith(`${href}/`))
}

describe('every role-restricted nav entry has a matching server-side gate', () => {
  const restricted = [...NAV_ITEMS, ...NAV_TRAILING_ITEMS].filter((i) => i.roles)

  // Review Focus #5 — a prefix rule that matches nothing is how this
  // whole class of bug gets reintroduced, so assert the count first.
  it.each(restricted)('$href has at least one gated page', (entry) => {
    expect(coveringRows(entry.href).length, `${entry.href} is hidden from some roles in the nav but no page under it is gated`).toBeGreaterThan(0)
  })

  it.each(restricted)('$href is gated to exactly the roles the nav shows it to', (entry) => {
    for (const row of coveringRows(entry.href)) {
      expect(new Set(row.allowed), `${row.route} disagrees with LeftNav's roles for ${entry.href}`).toEqual(new Set(entry.roles))
    }
  })

  it.each(NAV_BILLING_ITEMS)('$href is gated to exactly BILLING_ROLES', (entry) => {
    const rows = coveringRows(entry.href)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(new Set(row.allowed)).toEqual(new Set(BILLING_ROLES))
  })

  it('does not gate a nav entry the nav shows to everyone', () => {
    for (const entry of [...NAV_ITEMS, ...NAV_TRAILING_ITEMS].filter((i) => !i.roles)) {
      expect(coveringRows(entry.href), `${entry.href} is visible to every role in the nav but a gate was added for it`).toEqual([])
    }
  })
})
```

Then add rows for the **seven nav entries that were already gated before this plan**, so the table is a complete picture of the nav rather than only of this branch's diff, and the six pre-existing gates get pinned too: `/doctor` → `['pi']` (`LeftNav.tsx:31`, gate at `doctor/page.tsx:38`); `/front-desk/check-in` and `/front-desk/assignments` → `['frontdesk','admin','crc']` (`:39,:40`); `/inpatient/beds`, `/labs`, `/booking-requests` → `['frontdesk','admin','crc','pi']` (`:41,:43,:45`); `/audit-log` → `['admin']` (`:65`). These must pass with no source change; if one fails, the pre-existing gate disagrees with the nav and that is a finding to report.

- [ ] **Step 2: Run to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/pages/nav-role-enforcement.test.tsx`
Expected: FAIL at import — `NAV_ITEMS`, `NAV_TRAILING_ITEMS`, `NAV_BILLING_ITEMS` and `BILLING_ROLES` are not exported from `@/components/LeftNav`.

- [ ] **Step 3: Export the nav tables**

In `src/components/LeftNav.tsx`, rename `ITEMS` → `NAV_ITEMS`, `BILLING_ITEMS` → `NAV_BILLING_ITEMS`, `TRAILING_ITEMS` → `NAV_TRAILING_ITEMS` and `export` all three (updating the three uses inside the component at `:96,:97,:135`). Add `export const BILLING_ROLES: Role[] = ['admin', 'crc', 'frontdesk']` and make `:98` read `const showBilling = BILLING_ROLES.includes(role)`. **Rendering must be byte-for-byte unchanged** — this is an export-and-extract refactor, nothing more.

Extend the file's header comment (`:17-28`) with one sentence recording the new contract: these tables are the source of truth that `tests/pages/nav-role-enforcement.test.tsx` derives from, so a `roles`-restricted entry added here without a matching server-side page gate fails the suite.

- [ ] **Step 4: Add the `pi` nav case**

In `tests/components/LeftNav.test.tsx`, mirroring the existing `frontdesk` case at `:22`:

```tsx
it('hides Billing, Workbook, Reports and Broadcasts from a pi', () => {
  render(<LeftNav role="pi" />)
  expect(screen.getByRole('link', { name: /my patients/i })).toBeInTheDocument()
  for (const hidden of [/workbook/i, /identity matching/i, /form templates/i, /reports/i, /documents/i, /broadcasts/i, /experience surveys/i, /pipeline dashboard/i]) {
    expect(screen.queryByRole('link', { name: hidden })).not.toBeInTheDocument()
  }
  expect(screen.queryByRole('button', { name: /billing/i })).not.toBeInTheDocument()
})
```

- [ ] **Step 5: Run to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/pages/nav-role-enforcement.test.tsx tests/components/LeftNav.test.tsx`
Expected: PASS — 31 page rows (24 newly gated + 7 pre-existing), the four derivation groups, and the nav cases.

- [ ] **Step 6: Commit**

```bash
git add src/components/LeftNav.tsx tests/pages/nav-role-enforcement.test.tsx tests/components/LeftNav.test.tsx
git commit -m "$(cat <<'EOF'
test: derive the page-gate table from LeftNav so a nav-only restriction fails the suite

EOF
)"
```

---

### Task 6: Regression pins for what already works — `pi` chart access and the charge lifecycle

Spec §6.1 and §6.2 found no gap in either. Following the posture of the two precedent audit specs (`form-answer-visibility`, `messaging-isolation-audit`), the deliverable is tests that stop a future change from breaking them — in particular, tests that stop *this* plan's successors from over-gating the chart, and that stop anyone "fixing" the draft-charge lifecycle.

**Files:**
- Test: `tests/pages/pi-chart-access.test.tsx` (new)
- Test: `tests/lib/queries/patient-collections.test.ts` (new)
- Modify: `tests/api/patients.test.ts`

**Interfaces:**
- Consumes: `listPatientCollections()` (`src/lib/queries/patient-collections.ts:7`), `getArDashboardData(now?)` (`src/lib/queries/ar-dashboard.ts:65`), `invalidateCache` + `patientCollectionsListCacheKey` + `arDashboardCacheKey` (`src/lib/cache.ts:41,94,98`). Produces: nothing.

- [ ] **Step 1: Write the `pi` chart-access test**

Create `tests/pages/pi-chart-access.test.tsx`, reusing Task 1's `runPage` shape (a throwing `mockRedirect`) but mocking the medical-record page's query modules with `vi.fn()`s instead of blocking `@/db/client`, so the assertion is what the page *asked for*, not merely that it did not redirect.

```tsx
describe('a pi reaches the whole chart', () => {
  it.each(['/patients', '/patients/[anonId]', '/patients/[anonId]/medical-record'])(
    '%s does not redirect a pi',
    async (route) => { /* run as 'pi'; expect(mockRedirect).not.toHaveBeenCalled() */ },
  )

  it('loads labs, medications, notes and care plans for a pi', async () => {
    // Run /patients/[anonId]/medical-record as 'pi' with getPatientDetail,
    // listNotesForPatient, listDispensesForPatient, listOrdersForPatient and
    // listLabTests mocked (see medical-record/page.tsx:85-95 for the exact
    // module paths), each returning []
    expect(listOrdersForPatient).toHaveBeenCalled()
    expect(listDispensesForPatient).toHaveBeenCalled()
    expect(listNotesForPatient).toHaveBeenCalled()
  })
})
```

In `tests/api/patients.test.ts`, add: `GET /api/patients/[anonId]` returns `200` for a `pi` session (`vi.mocked(auth.requireSession).mockResolvedValueOnce({ role: 'pi', name: 'Test PI' })`), pinning that this plan's sweep left the read path open.

- [ ] **Step 2: Write the charge-lifecycle test**

Create `tests/lib/queries/patient-collections.test.ts`. The database is shared and mutable, so assert on **deltas for one patient**, never absolute totals — the same discipline `tests/lib/queries/ar-dashboard.test.ts:13-20` records. Both queries cache for 30s, so `invalidateCache(patientCollectionsListCacheKey())` and `invalidateCache(arDashboardCacheKey())` before every read. `afterEach` deletes the created charges.

```ts
it('leaves a draft charge out of patient collections and A/R, and counts it once submitted', async () => {
  // 1. snapshot: this patient's balanceCents in listPatientCollections() (0 if absent), and outstandingArCents
  // 2. insert ONE charge for that patient with status 'draft', amountCents 12345
  // 3. invalidate both caches, re-read: both figures are unchanged
  //    -- a freshly created charge (including a pharmacy dispense charge) is
  //    correctly invisible to A/R until billing submits it. Auto-submitting
  //    it to make it appear sooner would be a regression, not a fix (spec §6.2).
  // 4. update that same charge to status 'submitted', invalidate, re-read
  // 5. the patient's balanceCents rose by exactly 12345, and so did outstandingArCents
})

it('consolidates several submitted charges for one patient into a single row', async () => {
  // two submitted charges, 10000 and 20000, for the same patient -> exactly one
  // row for that patient, balance delta 30000. Pins that a pharmacy charge is
  // just a charge: nothing in the read path filters on where a charge came from.
})
```

- [ ] **Step 3: Run them**

Run: `npx dotenv -e .env.local -- npx vitest run tests/pages/pi-chart-access.test.tsx tests/lib/queries/patient-collections.test.ts tests/api/patients.test.ts`
Expected: PASS on the first run — these pin behavior that already works. A failure here is a real finding: either this branch over-gated something, or §6.1/§6.2 is wrong. Report it rather than adjusting the assertion to match.

- [ ] **Step 4: Commit**

```bash
git add tests/pages/pi-chart-access.test.tsx tests/lib/queries/patient-collections.test.ts tests/api/patients.test.ts
git commit -m "$(cat <<'EOF'
test: pin pi full-chart access and the draft-to-submitted charge lifecycle

EOF
)"
```

---

### Task 7: `role-capabilities.ts` — close the drift between what the app tells a user and what it enforces

Documentation-only; no behavior changes, no route touched. `settings/page.tsx:31` renders this to the signed-in user as the statement of what their role can do, and its own header comment promises it describes only enforcement. Every bullet below was re-verified against its gate while writing this plan (line numbers are this worktree's).

**Files:**
- Modify: `src/lib/role-capabilities.ts:34` (remove the false qualifier), `:28-39` (`pi`), `:44-55` (`admin`), `:14-23` (`crc`), `:60-69` (`frontdesk`)
- Modify: `tests/lib/role-capabilities.test.ts`

**Interfaces:** none — `ROLE_CAPABILITIES`'s shape is unchanged.

- [ ] **Step 1: Write the failing assertions**

Add to `tests/lib/role-capabilities.test.ts`. Match on substrings, not exact prose, so a wording tweak does not break the suite but a deletion does.

```ts
const has = (role: Role, re: RegExp) => ROLE_CAPABILITIES[role].bullets.some((b) => re.test(b))

it('states the pi/admin clinical write capabilities the server actually grants', () => {
  for (const role of ['pi', 'admin'] as Role[]) {
    expect(has(role, /encounter note/i)).toBe(true)      // notes/route.ts:22, notes/[id]/sign/route.ts:9
    expect(has(role, /care plan/i)).toBe(true)           // care-plans/route.ts:19, care-plan-goals/[id]/route.ts:14
    expect(has(role, /discharge/i)).toBe(true)           // discharge/route.ts:26
    expect(has(role, /transfer/i)).toBe(true)            // transfer/route.ts:13
    expect(has(role, /inpatient medication|MAR/i)).toBe(true)  // medications/route.ts:37, administer/route.ts:16
  }
})

it('states patient registration for the three roles that can do it', () => {
  for (const role of ['crc', 'frontdesk', 'admin'] as Role[]) {
    expect(has(role, /register a new patient/i)).toBe(true)     // patients/route.ts:53
  }
  expect(has('pi', /register a new patient/i)).toBe(false)
})

it('states room transfer for crc and frontdesk too', () => {
  // transfer/route.ts:13 admits all four roles; the action lives on
  // patients/[anonId]/page.tsx:153, not on the bed board, so neither role's
  // existing bed-board bullet covers it
  expect(has('crc', /transfer/i)).toBe(true)
  expect(has('frontdesk', /transfer/i)).toBe(true)
})

it('does not claim the pi bed board is scoped to their own patients', () => {
  // inpatient/beds/page.tsx:9-21 passes the entire board to BedBoard for all
  // four admitted roles; nothing filters by provider
  expect(ROLE_CAPABILITIES.pi.bullets.some((b) => /for their admitted patients/i.test(b))).toBe(false)
})

it('leaves both summary paragraphs untouched -- the new gates make them true as written', () => {
  expect(ROLE_CAPABILITIES.pi.summary).toMatch(/not shown here/)
  expect(ROLE_CAPABILITIES.frontdesk.summary).toMatch(/not the clinical evidence-review or practice-administration tools/)
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/role-capabilities.test.ts`
Expected: FAIL — the five clinical bullets and the registration bullets are absent; the bed-board qualifier is present.

- [ ] **Step 3: Make the edits**

1. `:34` — `'View the live bed/ward status board for their admitted patients'` → `'View the live bed/ward status board'`. Drop the qualifier; do **not** implement it (spec §4.2 — it would need the provider link §5 shows is unreliable, and nobody asked for the board to be narrowed).
2. Add to `pi` and to `admin`, phrased to the verb the gate grants:
   - `'Write and sign encounter notes (SOAP) on a patient\'s chart'`
   - `'Create and manage care plans and care-plan goals'`
   - `'Order inpatient medications and record administrations on the MAR'`
   - `'Transfer an admitted patient between rooms'`
   - `'Discharge an admitted patient and sign the discharge summary'`
   `admin`'s list opens with "Everything a Research Coordinator can do", but `crc` has none of these either, so inheritance does not cover them — state them.
3. Add to `crc` and `frontdesk`: `'Register a new patient'` and `'Transfer an admitted patient between rooms'`. Add `'Register a new patient'` to `admin` as well (`patients/route.ts:53` admits it).
4. Change nothing else. Both summary paragraphs stay exactly as written — Tasks 1-4 are what make them true (spec §4.3), and rewording them would document the gap instead of closing it.

- [ ] **Step 4: Run to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/role-capabilities.test.ts`
Expected: PASS, including the two pre-existing cases.

- [ ] **Step 5: Commit**

```bash
git add src/lib/role-capabilities.ts tests/lib/role-capabilities.test.ts
git commit -m "$(cat <<'EOF'
docs: correct role-capabilities drift -- add 5 clinical writes, registration, drop false bed-board scoping

EOF
)"
```

---

### Task 8: The fuzzy-provider-match regression test (deliberately red, handed to the prescriptions plan) + whole-branch verification

**This task does not fix anything.** Spec §5 confirmed that the substring last-name match is the *authorization* decision at four sites, so one `pi` can join, signal on, and end another `pi`'s live telemedicine visit and act on their assignments. The real fix is a session→provider foreign key, which is the **prescriptions** spec/plan's deliverable (`/Users/k2a/Desktop/clinsync/.worktrees/prescriptions`, not yet planned into tasks); two branches writing that schema change would collide. This task writes only the reproduction the spec specified, marked `it.fails` so it records the bug without leaving the suite red — **the prescriptions plan removes `.fails` when it lands the FK, and the test flips to a normal green assertion.** Do not attempt the fix here.

**Files:**
- Test: `tests/api/telemedicine-provider-ownership.test.ts` (new)
- No source file is modified by this task.

**Interfaces:** none.

- [ ] **Step 1: Write the collision reproduction**

Create `tests/api/telemedicine-provider-ownership.test.ts`, following `tests/api/telemedicine-signal.test.ts:14-22` — which already mocks `@/lib/queries/providers`' `listActiveProviders`, so the roster is fully controllable and no provider rows need seeding. Mock a **two**-provider roster with `'Dr. Bill Leeson'` first and `'Dr. Ann Lee'` second (ordering is the point: `.find()` returns the first substring match), both mapped to real seeded provider ids, and create a real telemedicine session on an appointment owned by Leeson's id.

```ts
// EXPECTED RED. Spec §5/§9.3: `session.name.split(/\s+/).pop()` -> a
// `.includes()` substring match resolved with `.find()` means a pi named
// "Dr. Ann Lee" resolves to "Dr. Bill Leeson" whenever Leeson sorts first, and
// so passes the ownership check on Leeson's live patient video visit. The fix
// is a real session->provider foreign key, owned by the prescriptions plan
// (docs/superpowers/specs/.../prescriptions). `it.fails` keeps this branch's
// suite green while pinning the bug; when that FK lands, drop `.fails` and
// this becomes an ordinary regression test.
it.fails('denies Dr. Ann Lee the signalling channel of Dr. Bill Leeson\'s session', async () => {
  sessionName = 'Dr. Ann Lee'
  const res = await signalPost(req({ /* a valid offer payload */ }) as never, ctx(leesonSessionId))
  expect(res.status).toBe(403)
})

it.fails('denies Dr. Ann Lee the signal GET on that session', async () => { /* expect 403 */ })

it('still allows Dr. Bill Leeson on his own session', async () => {
  sessionName = 'Dr. Bill Leeson'
  // expect 200 -- passes today; pins that the eventual fix must not
  // over-correct into locking the real owner out (spec §5's under-exposure half)
})

it.fails('denies Dr. Ann Lee declining an assignment owned by Dr. Bill Leeson', async () => {
  // POST /api/front-desk/assignments/[id]/decline (decline/route.ts:31-35) -> expect 403
})
```

- [ ] **Step 2: Run it**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/telemedicine-provider-ownership.test.ts`
Expected: PASS as a file — the three `it.fails` cases pass *because their assertions fail* (vitest inverts them), and the owner case passes normally. If an `it.fails` case reports "expected test to fail", the underlying bug is already fixed elsewhere: drop `.fails` from that case and say so in the report.

- [ ] **Step 3: Whole-branch verification**

```bash
npx dotenv -e .env.local -- npx vitest run
npx tsc --noEmit
npm run lint
```
Expected: the full suite green, `tsc` clean, lint clean. Then confirm the diff stayed inside its lane:

```bash
git diff --stat hims-platform...HEAD
```
Expected: exactly 24 page files, 14 API handlers across 11 route files, `LeftNav.tsx`, `role-capabilities.ts`, `patients/page.tsx`, and the test files — and **no** diff in `src/app/api/form-templates/`, `src/app/api/documents/[id]/route.ts` or `src/app/api/charges/`. Report any stray file rather than committing it.

- [ ] **Step 4: Commit**

```bash
git add tests/api/telemedicine-provider-ownership.test.ts
git commit -m "$(cat <<'EOF'
test: reproduce the fuzzy provider-name collision on telemedicine and assignments (expected red)

Marked it.fails -- the session->provider foreign key that fixes this is the
prescriptions plan's deliverable, not this branch's.

EOF
)"
```
