# Prescriptions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a clinician write, discontinue and print a prescription from the patient's Medical Record page, attributed to a real `providers` row resolved from their actual login rather than a last-name string match.

**Architecture:** Seven nullable columns land on the existing `medicationEpisodes` table rather than a parallel `prescriptions` table — `medicationDispenses`, `medicationAdministrations` and the FHIR `MedicationRequest` export already point at it, and `prescribedAt IS NOT NULL` becomes the single queryable discriminator between an imported history row and a prescription written here. The prescriber link needs **no new schema at all**: `staffMembers.userId` and `staffMembers.providerId` already exist and the seed already links them for the demo `pi`; the only missing piece is a `userId` claim on the staff session JWT, plus one `resolveSessionProvider()` helper that walks `users → staffMembers → providers` with no fuzzy fallback. Two API routes (write, discontinue), one extracted client section with a modal, and one chrome-free top-level print page sit on top of that.

**Tech Stack:** Next.js 16 App Router (Server Components) + Drizzle ORM over a `pg` Pool (additive-only schema changes via a hand-written one-off script, never `drizzle-kit push`) + Zod `.strict()` validation + `jose` HS256 session JWTs + vitest with real-DB-backed tests.

**Spec:** `docs/superpowers/specs/2026-09-29-prescriptions.md`

**Working directory note:** this plan is executed in an isolated git worktree at `/Users/k2a/Desktop/clinsync/.worktrees/prescriptions` on branch `feature/prescriptions` (base commit `8b514c5`). This worktree **has** its own `.env.local` (verified present, 4374 bytes, carrying `DATABASE_URL`, `KV_REST_API_URL`/`KV_REST_API_TOKEN`, `SESSION_SECRET`) but has **no `node_modules`** — `npm install` in this exact directory is Task 1's first step, before any test command. Every implementer/reviewer dispatch for this plan must work from this exact directory, never the main checkout and never a sibling worktree: `.worktrees/unified-patient-record`, `.worktrees/pharmacy-dashboard`, `.worktrees/eligibility-auto-notify` and a dozen others have concurrent work in flight against the same shared database.

## Global Constraints

- **Branch:** `feature/prescriptions`, off `hims-platform`. This work merges into `hims-platform` only. Do not merge, rebase onto, or cherry-pick from any other feature branch.
- **Additive-only schema.** This plan adds exactly seven **nullable, no-default** columns to `medication_episodes` and drops/renames/re-types nothing. Nullable is not a style preference: this is a **single shared Neon Postgres database across every branch and worktree**, and a `NOT NULL`-without-default column on an existing shared table has already broken every other worktree once in this project's history. An older worktree's `INSERT INTO medication_episodes` must keep working untouched.
- **Migrations are hand-written one-off scripts, never `drizzle-kit push`.** Write the script at this worktree's root, run it with `npx dotenv -e .env.local -- npx tsx <script>`, confirm its printed `information_schema` output, then `rm` it. This is the established convention (see `docs/superpowers/plans/2026-09-29-eligibility-auto-notification.md` Task 1 and `docs/superpowers/plans/2026-09-29-pharmacy-dashboard.md`). `ADD COLUMN IF NOT EXISTS` for every column so a re-run is a no-op.
- **`psql` is not installed** in this environment. Verify any live-DB fact with a Node script using `pg`'s `Pool` and an `information_schema.columns` query.
- **Every write route** starts with `requireSession()` as its first statement, validates its body with a `.strict()` Zod schema (mass-assignment guard), and calls `logAudit(session, <action>, <patientId>)`. Every protected page starts with `requireSessionOrRedirect()` as the first statement in its component body and uses *that* returned session (never a second `getSession()`).
- **Role gating is enforced in the route/page itself, in every task that adds one — never deferred:**

  | Action | Allowed roles |
  |---|---|
  | `POST /api/patients/[anonId]/prescriptions` | `admin`, `pi` |
  | `PATCH /api/patients/[anonId]/prescriptions/[id]` | `admin`, `pi` |
  | `GET /prescriptions/print` | `admin`, `pi`, `crc`, `frontdesk` |
  | View Medication History on the Medical Record page | unchanged — no read restriction added or removed |

  Every gate is an **allowlist**, so the `pharmacy` role (already present in the live `role` enum) is denied by default with no code — that is deliberate and must not be "fixed" into a denylist.
- **The session/auth change in Task 1 is security-sensitive.** It touches the signed cookie every staff member holds. The named, tested requirement — not an incidental detail — is that **a cookie carrying no `userId` claim must parse as a valid session with `userId: null`, never as a parse failure.** `parseSessionCookie` returns `null` on any validation failure and `getSession()`/`requireSession()` turn that into a logout/401; staff cookies live up to 8 hours (`SESSION_MAX_AGE_SECONDS`), so getting this wrong logs out every signed-in staff member at deploy. Task 1 owns this and tests it explicitly.
- **No fabricated clinical attribution.** No "fall back to the first active provider" (the lab-orders route does this; this plan deliberately does not). No backfilled prescriber on imported rows. No printable row without `prescribedAt`. `prescribedByProviderId`, `enteredByName`, `prescribedAt` and `status` are **server-set only** and never accepted from a client body.
- **The strings `Tebra` and `IntakeQ` must not appear in any new code** this plan writes (comments included). The patient-identity read in the print view goes through whatever `patients` identity columns the branch's `src/db/schema.ts` declares at implementation time — see the environment hazard below.
- **Do not run `npm run seed` (or any seed entrypoint) against this database.** The seed clears existing data; running it would destroy every other active worktree's state. Task 2 edits `src/db/seed.ts` and verifies the edit with `npx tsc --noEmit`, never by executing it.
- Vitest invocation: `npx dotenv -e .env.local -- npx vitest run <path>` (`fileParallelism: false`). Real-DB-backed tests clean up in `afterEach`/`afterAll` by tracked ids.
- Commit messages end with no attribution trailer.
- UI verification means a real running dev server hit with real HTTP requests, with the actual commands and actual output pasted into the task report. Mint a staff session cookie the way `src/lib/auth.ts` actually does it (`SignJWT` under cookie `clinsync_demo_session`, secret from `SESSION_SECRET`). Never a narrated, unreproduced claim.

### Known environment hazard — verified against the live DB on 2026-09-29, read before Task 5

A **separate, unrelated** migration (`unified-patient-record`, in `.worktrees/unified-patient-record`, **not yet merged into `hims-platform`**) has **already been applied to the shared live Neon database this session**. Verified by direct `information_schema` query:

- `patients.name_tebra`, `patients.name_intakeq`, `patients.dob_tebra`, `patients.dob_intakeq` **no longer exist**. They have been collapsed into `patients.name` (text, NOT NULL) and `patients.dob` (date, NOT NULL).
- This branch's `src/db/schema.ts:54-57` **still declares the old four columns**, and 41 files under `src/` still reference `nameTebra`. The branch and the live DB therefore disagree about `patients` **right now**, before this plan changes anything.

What this means for this plan:

1. **This plan's own schema changes are unaffected.** Verified: `medication_episodes` has exactly its original 8 columns, all seven new ones are absent, and nothing about the collapse touches that table. `providers`, `staff_members`, `users`, `medications`, `app_settings` (including `practice_name`/`practice_site`) are all present and match this branch's schema exactly. Tasks 1–4 and 6 read none of the affected `patients` columns.
2. **Task 5 (the print view) is the one place that reads patient identity.** Its implementer must, as its first step, re-run the live-column check and then read patient name/DOB through **whatever `patients` identity columns `src/db/schema.ts` declares on this branch at that moment**.
3. **If the branch's schema and the live DB still disagree when Task 5 runs: STOP and report it.** Do not edit the `patients` table definition, do not add a compatibility shim, and do not run the other worktree's migration. Reconciling `patients` belongs to the `unified-patient-record` spec; a prescriptions implementer silently "fixing" it would collide with in-flight work on a shared database. The correct output is a blocked-task report naming the divergence.

## Review Focus

1. **An old staff cookie with no `userId` claim must parse as a valid session with `userId: null`.** A strict `typeof payload.userId === 'number'` check makes `parseSessionCookie` return `null`, which `requireSession()` renders as a 401 — logging out every signed-in staff member for up to 8 hours after deploy. The claim being *absent* and the claim being *the wrong type* are different cases and must behave differently. (Task 1)
2. **A print URL whose `ids` span two patients.** `/prescriptions/print?ids=12,900` interleaving two charts onto one printed sheet is a PHI-disclosure bug, not a rendering quirk. Same-patient, all-exist and all-`prescribedAt`-set are three separate checks, and so are the malformed inputs the spec never names: empty `ids`, a non-numeric id, a repeated id, and an absurdly long list. (Task 5)
3. **A terminated staff member or a deactivated provider holding a still-valid 8-hour cookie must not be able to prescribe.** The cookie outlives the HR change, so `resolveSessionProvider` — not the login flow — is the only thing standing between a fired clinician and a new prescription in their name. Both `staffMembers.employmentStatus = 'active'` and `providers.isActive = true` are load-bearing filters. (Task 1)
4. **`onBehalfOfProviderId` naming a nonexistent or inactive provider, and `onBehalfOfProviderId` sent by a session that already resolves a provider.** The first must be a 400 with nothing written; the second must be *silently ignored* (never rejected, never honored) so that adding a field to a request body can never let one clinician prescribe under another's name. (Task 4)
5. **`prescribedAt` comes back from `getPatientDetail` as an ISO string, not a `Date`, on a Redis cache hit.** `getOrSetCache` JSON-serializes through Upstash (`src/lib/cache.ts:33-38`), so the same field is a `Date` on a miss and a `string` on a hit within the 30-second TTL. The `prescribedAt != null` gate survives that, but calling `.toLocaleDateString()` on the value directly throws on a cache hit — every render must go through `new Date(value)`. (Task 6)

---

### Task 1: Session `userId` claim + `resolveSessionProvider` — SECURITY-SENSITIVE

**Files:**
- Modify: `src/lib/auth.ts:7` (`Session`), `:37-43` (`buildSessionCookieValue`), `:45-62` (`parseSessionCookie`), `:70-80` (`setSessionCookie`)
- Modify: `src/app/api/login/route.ts:66,72,83-86` (`completeLoginWithoutMfa`), `src/app/api/login/mfa/route.ts:64-65`, `src/app/api/auth/google/callback/route.ts:64-65,92-93`
- Create: `src/lib/provider-identity.ts`
- Modify: `src/lib/queries/staff-members.ts` (add `getProviderForUserId`)
- Modify: `src/app/(dashboard)/doctor/page.tsx:44-53`
- Modify (call-site churn only): `tests/lib/auth.test.ts:17`, `tests/api/account-mfa-reset.test.ts:102`, `tests/api/account-mfa-method.test.ts:60`, `tests/api/reset-mfa-admin.test.ts:68`
- Test: `tests/lib/auth.test.ts` (extend), `tests/lib/provider-identity.test.ts` (create)

**Interfaces:**
- Consumes: nothing from other tasks. This is the root of the dependency graph.
- Produces:

```ts
// src/lib/auth.ts
export interface Session { role: Role; name: string; userId: number | null }
export async function buildSessionCookieValue(role: Role, name: string, userId: number | null): Promise<string>
export async function setSessionCookie(role: Role, name: string, userId: number | null): Promise<void>

// src/lib/provider-identity.ts
export interface SessionProvider { id: number; name: string; credentials: string | null; specialty: string }
export async function resolveSessionProvider(session: Session): Promise<SessionProvider | null>

// src/lib/queries/staff-members.ts
export async function getProviderForUserId(userId: number): Promise<SessionProvider | null>
```

  `resolveSessionProvider` is consumed by Tasks 4 and 6. `SessionProvider` is the shape Task 5's print header and Task 6's prescriber line both render. `getProviderForUserId` declares its return type with a **type-only** import of `SessionProvider` from `@/lib/provider-identity` (`import type { … }`) — that erases at compile time, so the two modules do not form a runtime cycle.

- [ ] **Step 1: Install dependencies and run the environment preflight**

Run, from `/Users/k2a/Desktop/clinsync/.worktrees/prescriptions`:

```bash
npm install
```

Then write a throwaway `preflight-scratch.ts` at this worktree's root that opens a `pg` `Pool` on `process.env.DATABASE_URL` (`ssl: { rejectUnauthorized: false }`) and prints, from `information_schema.columns`, the column list of `medication_episodes` and of `patients`. Run it with `npx dotenv -e .env.local -- npx tsx preflight-scratch.ts`, then `rm` it.

Record in the task report: (a) that `medication_episodes` still has exactly its 8 original columns, and (b) whether `patients` has `name`/`dob` or `name_tebra`/`name_intakeq`/`dob_tebra`/`dob_intakeq`. Do **not** act on (b) — it is a note for Task 5 (see the environment hazard in Global Constraints). If (a) is not true, stop and report.

- [ ] **Step 2: Write the failing auth tests**

In `tests/lib/auth.test.ts` (keep the existing `// @vitest-environment node` directive and its comment block; keep all 7 existing tests), update the existing round-trip assertion and add three new tests:

```ts
  it('round-trips role, name and userId through the cookie value', async () => {
    const value = await buildSessionCookieValue('pi', 'Dr. R. Kunam', 42)
    expect(await parseSessionCookie(value)).toEqual({ role: 'pi', name: 'Dr. R. Kunam', userId: 42 })
  })

  it('round-trips a null userId for the env-admin account, which has no users row', async () => {
    const value = await buildSessionCookieValue('admin', 'Sam Patel', null)
    expect(await parseSessionCookie(value)).toEqual({ role: 'admin', name: 'Sam Patel', userId: null })
  })

  // DEPLOY-COMPATIBILITY REGRESSION. Staff cookies live up to 8 hours, so
  // cookies minted before the userId claim existed are still presented
  // after this ships. parseSessionCookie returning null for them would not
  // merely drop the claim -- getSession(), requireSession() and proxy.ts
  // all read null as "no session", so every signed-in staff member would
  // be logged out at deploy. An ABSENT claim is a valid old cookie.
  it('parses a pre-existing cookie that carries no userId claim as a valid session with userId: null', async () => {
    const { SignJWT } = await import('jose')
    const secret = new TextEncoder().encode(process.env.SESSION_SECRET)
    const oldCookie = await new SignJWT({ kind: 'staff', role: 'pi', name: 'Dr. R. Kunam' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('8h')
      .sign(secret)
    expect(await parseSessionCookie(oldCookie)).toEqual({ role: 'pi', name: 'Dr. R. Kunam', userId: null })
  })

  // A claim that is PRESENT but not a number is a malformed or tampered
  // token, not an old one -- that case still rejects.
  it('rejects a validly-signed token whose userId claim is present but not a number', async () => {
    const { SignJWT } = await import('jose')
    const secret = new TextEncoder().encode(process.env.SESSION_SECRET)
    const bad = await new SignJWT({ kind: 'staff', role: 'admin', name: 'x', userId: 'not-a-number' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(secret)
    expect(await parseSessionCookie(bad)).toBeNull()
  })
```

- [ ] **Step 3: Run them to confirm they fail**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/auth.test.ts`
Expected: FAIL — `buildSessionCookieValue` takes two arguments, and every parsed result is missing `userId`.

- [ ] **Step 4: Implement the `userId` claim in `src/lib/auth.ts`**

Widen `Session` to `{ role: Role; name: string; userId: number | null }`. Add a required third parameter `userId: number | null` to `buildSessionCookieValue` (putting `userId` into the `SignJWT` payload alongside `kind: 'staff'`, `role`, `name`) and to `setSessionCookie` (threaded straight through). Leave the existing SECURITY comment block above `buildSessionCookieValue` in place and append a sentence explaining what `userId` is for and that `null` is the honest value for the env-admin account, which has no `users` row.

In `parseSessionCookie`, keep the existing `kind`/`name`/`role` checks exactly as they are and add the claim handling. The absent-vs-wrong-type distinction is the whole of Review Focus #1 and is not determined by the signature, so implement it as written:

```ts
      // `userId` is a LATER ADDITION to this claim set. A cookie minted
      // before it existed is still a valid staff session for up to
      // SESSION_MAX_AGE_SECONDS (8h) after this deploys, and returning null
      // here would log every one of those users out -- getSession(),
      // requireSession() and proxy.ts all read null as "no session".
      // So: claim ABSENT (or explicitly null) => userId: null, valid
      // session. Claim PRESENT but not a number => reject, because that is
      // a malformed or tampered token rather than an old one.
      const rawUserId = payload.userId
      if (rawUserId !== undefined && rawUserId !== null && typeof rawUserId !== 'number') return null
      return { role: payload.role as Role, name: payload.name, userId: typeof rawUserId === 'number' ? rawUserId : null }
```

- [ ] **Step 5: Thread `userId` through every call site**

Four `setSessionCookie` call sites, all of which already have the value in hand — no new lookups:

| Call site | Value to pass |
|---|---|
| `src/app/api/login/mfa/route.ts:64` | `pending.userId` (already `number \| null` on `PendingStaffMfaSession`) |
| `src/app/api/login/route.ts:84`, inside `completeLoginWithoutMfa` | a new third parameter on that helper — pass `null` at the env-admin call (`:66`) and `user.id` at the DB-user call (`:72`) |
| `src/app/api/auth/google/callback/route.ts:64` | `null` (env admin) |
| `src/app/api/auth/google/callback/route.ts:92` | `user.id` |

Six `logAudit({ role, name }, …)` object literals become type errors once `Session.userId` is required. Add the real value to each rather than widening the interface: `src/app/api/auth/google/callback/route.ts:65` (`userId: null`) and `:93` (`userId: user.id`); `src/app/api/login/mfa/route.ts:44,53,65` (`userId: pending.userId`); `src/app/api/login/route.ts:85` (the helper's new `userId` parameter).

Three existing test files call `buildSessionCookieValue` with two arguments and must gain a third: `tests/api/account-mfa-reset.test.ts:102`, `tests/api/account-mfa-method.test.ts:60`, `tests/api/reset-mfa-admin.test.ts:68`. Pass `null` in each — those suites are about MFA state, not provider identity.

Then run `npx tsc --noEmit` and fix any remaining call site it names. Do **not** silence an error by making `userId` optional on `Session`.

- [ ] **Step 6: Run the auth and login suites to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/auth.test.ts tests/api/login.test.ts tests/api/login-mfa.test.ts tests/api/auth-google.test.ts tests/api/account-mfa-reset.test.ts tests/api/account-mfa-method.test.ts tests/api/reset-mfa-admin.test.ts`
Expected: PASS.

- [ ] **Step 7: Write the failing provider-identity tests**

Create `tests/lib/provider-identity.test.ts`. Real-DB-backed against seeded rows; resolve ids in `beforeAll` (`users` row for `rkunam.demo@example.com`, its `staffMembers` row, that row's `providerId`; the `users` row for `jruiz.demo@example.com`, whose staff row has `providerId: null`). Snapshot and restore in `afterEach` every field any test mutates (`staffMembers.employmentStatus`, `providers.isActive`).

Tests:

- **resolves the seeded `pi` across the name divergence**: `resolveSessionProvider({ role: 'pi', name: 'Dr. R. Kunam', userId: <kunam users.id> })` returns `{ id: <provider id>, name: 'Dr. Rajiv Kunam', credentials: 'MD', specialty: 'Psychiatry' }` — the point being that the session's `name` (`Dr. R. Kunam`) never appears in the lookup and no longer matters.
- **returns null for `userId: null`** (the env-admin account).
- **returns null when `userId` is absent entirely**: call it with `{ role: 'admin', name: 'Sam Patel' } as never` — the shape a `vi.mock('@/lib/auth')` factory in the existing route tests returns. Must be `null`, not a throw and not a query on `undefined`.
- **returns null for a `userId` with no `staff_members` row at all**: use `userId: 9_999_999`.
- **returns null for a staff member whose `providerId` is null**: the seeded `crc` Jamie Ruiz.
- **returns null when the staff member is `terminated`** (Review Focus #3): set Kunam's `staffMembers.employmentStatus` to `'terminated'`, assert null, restore. Also assert `'on_leave'` resolves to null for the same reason.
- **returns null when the provider row is `isActive: false`** (Review Focus #3): set Kunam's `providers.isActive` to `false`, assert null, restore.

- [ ] **Step 8: Run them to confirm they fail**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/provider-identity.test.ts`
Expected: FAIL — `@/lib/provider-identity` does not exist.

- [ ] **Step 9: Implement `getProviderForUserId` and `resolveSessionProvider`**

In `src/lib/queries/staff-members.ts`, add `getProviderForUserId(userId: number): Promise<SessionProvider | null>`: a single `innerJoin` of `staffMembers → providers` on `staffMembers.providerId = providers.id`, filtered by `eq(staffMembers.userId, userId)`, `eq(staffMembers.employmentStatus, 'active')` and `eq(providers.isActive, true)`, selecting `{ id, name, credentials, specialty }` from `providers`; return the first row or `null`. Comment why both status filters are there: an 8-hour cookie outlives an HR change, so a terminated clinician must not be able to prescribe and a deactivated provider must not be attributed a new prescription.

Create `src/lib/provider-identity.ts` exporting `SessionProvider` and:

```ts
/** Resolves the `providers` row this session *is*, via the real
 *  users -> staffMembers -> providers link. Returns null when the session
 *  has no userId (env admin), no staff_members row, no providerId on it,
 *  the staff member is not `active`, or the provider row is not `isActive`.
 *  There is deliberately NO fuzzy-name fallback here: it returns the real
 *  link or nothing, so a caller that wants best-effort behavior makes that
 *  fail-open choice visibly, at its own call site. */
export async function resolveSessionProvider(session: Session): Promise<SessionProvider | null> {
  // `== null` deliberately catches `undefined` too: a Session object built
  // before this claim existed -- including the `{ role, name }` literals
  // that several route tests' vi.mock factories return -- has no userId
  // property at all, and must resolve to "no provider" rather than throw.
  if (session.userId == null) return null
  return getProviderForUserId(session.userId)
}
```

- [ ] **Step 10: Run the provider-identity tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/provider-identity.test.ts`
Expected: PASS.

- [ ] **Step 11: Adopt the resolver in the PI dashboard (spec §3.4, call site 2 of 2)**

In `src/app/(dashboard)/doctor/page.tsx:44-53`, call `await resolveSessionProvider(session)` first and use its `id` when it returns a provider. When it returns `null`, the existing last-name `listActiveProviders()` match runs **unchanged** as a fallback. Update the existing comment to say it is now a fallback rather than the only mechanism, and why this page fails open: it scopes a read-only dashboard, not an attribution write, and three of the five seeded providers have no linked login at all, so failing closed would regress the demo for a display concern. Leave the `myPatients` last-name filter above it alone — `patients.currentProvider` is free text with no provider FK, so the resolver cannot help there.

The other six fuzzy-match call sites named in spec §1 stay untouched.

- [ ] **Step 12: Run the affected suites**

Run: `npx dotenv -e .env.local -- npx vitest run tests/pages/doctor.test.tsx tests/lib/provider-identity.test.ts tests/lib/auth.test.ts tests/lib/queries/staff-members.test.ts tests/api/staff-directory.test.ts`
Expected: PASS. Then `npx tsc --noEmit` — expected: clean.

- [ ] **Step 13: Commit**

```bash
git add src/lib/auth.ts src/lib/provider-identity.ts src/lib/queries/staff-members.ts \
  src/app/api/login/route.ts src/app/api/login/mfa/route.ts src/app/api/auth/google/callback/route.ts \
  "src/app/(dashboard)/doctor/page.tsx" \
  tests/lib/auth.test.ts tests/lib/provider-identity.test.ts \
  tests/api/account-mfa-reset.test.ts tests/api/account-mfa-method.test.ts tests/api/reset-mfa-admin.test.ts
git commit -m "$(cat <<'EOF'
feat: carry userId on the staff session and resolve the real provider link

EOF
)"
```

---

### Task 2: Schema — seven nullable prescription columns on `medication_episodes`

**Files:**
- Modify: `src/db/schema.ts:121-130` (`medicationEpisodes`)
- Modify: `src/db/seed.ts` (near the hero-patient medication insert at `:946`)
- Test: `tests/db/prescriptions-schema.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (independent), but sequenced after it because Tasks 3–6 need both.
- Produces: `medicationEpisodes` gains `medicationId: number | null`, `frequencyPerDay: number | null`, `durationDays: number | null`, `instructions: string | null`, `prescribedByProviderId: number | null`, `enteredByName: string | null`, `prescribedAt: Date | null`. Every consumer (Tasks 3–6) reads them off `typeof medicationEpisodes.$inferSelect`.

- [ ] **Step 1: Write the failing test**

Create `tests/db/prescriptions-schema.test.ts`. It inserts its own episode rows against a seeded patient and a seeded provider (both resolved with `db.select().from(x).limit(1)`), tracks their ids, and deletes them in `afterEach` — it must not mutate any pre-existing row. Tests:

- **the seven columns default to null on a row inserted the old way**: insert with only `{ patientId, name, medicationClass, startDate, status: 'active' }` and assert all seven new fields are `null`. This is the additive-only guarantee: another worktree's insert still works.
- **all seven round-trip**: insert with every new field set (`medicationId` from a real `medications` row, `frequencyPerDay: 2`, `durationDays: 30`, `instructions: 'Take with food'`, `prescribedByProviderId` from a real `providers` row, `enteredByName: 'Sam Patel'`, `prescribedAt: new Date()`) and assert each reads back, with `prescribedAt` an instance of `Date`.
- **`prescribedAt IS NOT NULL` is a usable discriminator**: query the table for `isNotNull(medicationEpisodes.prescribedAt)` and assert the prescribed row is returned and the plain row is not.

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/prescriptions-schema.test.ts`
Expected: FAIL — these are not properties of the schema object.

- [ ] **Step 3: Add the seven columns to `src/db/schema.ts`**

Append to the existing `medicationEpisodes` definition, after `status`, with a comment recording that this table now holds two kinds of row (imported history with no prescriber, and prescriptions written here) and that `prescribedAt IS NOT NULL` is the discriminator:

```ts
  medicationId: integer('medication_id').references(() => medications.id),
  frequencyPerDay: integer('frequency_per_day'),
  durationDays: integer('duration_days'),
  instructions: text('instructions'),
  prescribedByProviderId: integer('prescribed_by_provider_id').references(() => providers.id),
  enteredByName: text('entered_by_name'),
  prescribedAt: timestamp('prescribed_at'),
```

`medicationEpisodes` sits above both `providers` (`:445`) and `medications` (`:625`); Drizzle's `references()` takes a lazily-resolved thunk and this file already forward-references that way (`patients.primaryPayerId`/`secondaryPayerId` → `payers`). Do not move any table.

- [ ] **Step 4: Run the test again — expect a different failure**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/prescriptions-schema.test.ts`
Expected: FAIL, now with a runtime Postgres error (`column "medication_id" of relation "medication_episodes" does not exist`), not a TypeScript property error.

- [ ] **Step 5: Write, run and verify the one-off migration script**

Scratch, not part of the repo. Create `migrate-prescriptions-scratch.ts` at this worktree's root. It opens a `pg` `Pool` on `DATABASE_URL` and runs, in order:

```sql
ALTER TABLE medication_episodes ADD COLUMN IF NOT EXISTS medication_id INTEGER REFERENCES medications(id);
ALTER TABLE medication_episodes ADD COLUMN IF NOT EXISTS frequency_per_day INTEGER;
ALTER TABLE medication_episodes ADD COLUMN IF NOT EXISTS duration_days INTEGER;
ALTER TABLE medication_episodes ADD COLUMN IF NOT EXISTS instructions TEXT;
ALTER TABLE medication_episodes ADD COLUMN IF NOT EXISTS prescribed_by_provider_id INTEGER REFERENCES providers(id);
ALTER TABLE medication_episodes ADD COLUMN IF NOT EXISTS entered_by_name TEXT;
ALTER TABLE medication_episodes ADD COLUMN IF NOT EXISTS prescribed_at TIMESTAMP;
```

then prints `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'medication_episodes' ORDER BY ordinal_position`.

Run: `npx dotenv -e .env.local -- npx tsx migrate-prescriptions-scratch.ts`. If blocked by the permission classifier: stop, report it, do not retry with variations.

Confirm from the printed output that the table now has 15 columns and that **all seven new ones are `is_nullable = YES`** with no default. Paste that output into the task report. Then `rm migrate-prescriptions-scratch.ts`.

No backfill. Every existing row keeps exactly the meaning it has today: a medication the patient is on, with no claim about who prescribed it. Fabricating a retroactive prescriber is the precise failure this feature exists to prevent.

- [ ] **Step 6: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/prescriptions-schema.test.ts`
Expected: PASS (all three tests).

- [ ] **Step 7: Add demonstrable prescribed episodes to the seed**

In `src/db/seed.ts`, in the hero-patient loop that already inserts one episode at `:946`, add two more rows for the **first** hero patient only, with the new columns populated so the print view and the prescriber attribution are demonstrable without writing one by hand: `frequencyPerDay: 2` / `durationDays: 30` / `instructions: 'Take with food.'` and `frequencyPerDay: 1` / `durationDays: 90` / `instructions: null`, both with `status: 'active'`, `prescribedAt: new Date()`, `enteredByName: 'Dr. Rajiv Kunam'`, and `prescribedByProviderId` looked up by name `'Dr. Rajiv Kunam'` from the `insertedProviders` array returned at `:702`. Leave every existing imported-history episode exactly as it is — a null-prescriber row still rendering correctly is itself the regression check.

**Do not run the seed.** Per Global Constraints, `npm run db:seed` clears existing data on the shared database and would destroy every other active worktree's state. Verify this edit with `npx tsc --noEmit` only.

- [ ] **Step 8: Verify and commit**

Run: `npx tsc --noEmit` — expected: clean.
Run: `npx dotenv -e .env.local -- npx vitest run tests/db/prescriptions-schema.test.ts tests/db/schema.test.ts tests/db/pharmacy-schema.test.ts tests/api/pharmacy-dispense.test.ts tests/lib/queries/medication-administrations.test.ts tests/lib/queries/medication-dispenses.test.ts`
Expected: PASS — the existing medication paths are the regression check that every new column is genuinely optional.

```bash
git add src/db/schema.ts src/db/seed.ts tests/db/prescriptions-schema.test.ts
git commit -m "$(cat <<'EOF'
feat: add nullable prescription columns to medication_episodes

EOF
)"
```

---

### Task 3: Prescriptions query layer + FHIR `MedicationRequest` accuracy

**Files:**
- Create: `src/lib/queries/prescriptions.ts`
- Modify: `src/lib/fhir/medication-request.ts`
- Test: `tests/lib/queries/prescriptions.test.ts` (create), `tests/lib/fhir/medication-request-mapping.test.ts` (extend — note this is the real filename; spec §9 calls it `medication-request.test.ts`)

**Interfaces:**
- Consumes: Task 2's seven columns; `SessionProvider` from `@/lib/provider-identity` (Task 1) as the prescriber shape.
- Produces, from `@/lib/queries/prescriptions`:

```ts
export interface CreatePrescriptionInput {
  patientId: string
  medicationId: number | null
  name: string
  medicationClass: string
  dose: string | null
  frequencyPerDay: number
  durationDays: number
  startDate: string          // 'YYYY-MM-DD'
  instructions: string | null
  prescribedByProviderId: number
  enteredByName: string
}
export async function createPrescription(input: CreatePrescriptionInput): Promise<typeof medicationEpisodes.$inferSelect>

export type StopPrescriptionResult =
  | { ok: true; episode: typeof medicationEpisodes.$inferSelect }
  | { ok: false; reason: 'not_found' | 'already_inactive' }
export async function stopPrescription(patientId: string, episodeId: number, stopDate: string): Promise<StopPrescriptionResult>

export interface PrintablePrescription {
  id: number
  patientId: string
  name: string
  medicationClass: string
  dose: string | null
  frequencyPerDay: number | null
  durationDays: number | null
  instructions: string | null
  prescribedAt: Date
  enteredByName: string | null
  prescriber: SessionProvider
}
/** Null unless EVERY id exists, they all belong to ONE patient, and each
 *  has both `prescribedAt` and a resolvable `prescribedByProviderId`. */
export async function getPrintablePrescriptions(ids: number[]): Promise<PrintablePrescription[] | null>
```

  `createPrescription`/`stopPrescription` are consumed by Task 4; `getPrintablePrescriptions` by Task 5.

  **Deliberately not built:** spec §9 also names a `listEpisodesForPatient` that joins prescriber details. There is no such function here because `getPatientDetail` already does `select().from(medicationEpisodes)` (`src/lib/queries/patients.ts:105`), so Task 2's columns arrive on `patient.medications` with no query change, and Task 6 resolves prescriber details from a `prescriberById` map built once per page render. Adding a second read path for the same rows would put a cached projection and an uncached one side by side on the same screen.

- [ ] **Step 1: Write the failing query-layer tests**

Create `tests/lib/queries/prescriptions.test.ts`, following `tests/api/lab-orders.test.ts`'s query-layer shape: a module-scope `const createdEpisodeIds: number[] = []`, an `afterEach` that pops and deletes them, and a `beforeAll` that resolves two distinct seeded patient ids and one seeded provider id via `db.select().from(x).limit(1)`. Tests:

- **`createPrescription` writes every new column and forces `status: 'active'` and a non-null `prescribedAt`**: assert the returned row's `frequencyPerDay`, `durationDays`, `instructions`, `medicationId`, `prescribedByProviderId`, `enteredByName` match the input, `status === 'active'`, and `prescribedAt` is a `Date`. `status` and `prescribedAt` are not in `CreatePrescriptionInput` — the function sets both.
- **`createPrescription` accepts `medicationId: null` and `dose: null`** (the off-catalog path) and still writes a row.
- **`stopPrescription` sets `inactive` and the given `stopDate`** and returns `{ ok: true }`.
- **a second `stopPrescription` on the same row returns `{ ok: false, reason: 'already_inactive' }`** and does **not** overwrite the first `stopDate`.
- **`stopPrescription` with a `patientId` that does not own the episode returns `{ ok: false, reason: 'not_found' }`** and leaves the row `active` — create the episode under patient A, call with patient B.
- **`stopPrescription` on an unknown id returns `{ ok: false, reason: 'not_found' }`**.
- **`stopPrescription` works on an imported episode too** (spec §5, §12.6): insert a row with `prescribedAt: null` and stop it successfully — discontinuing a drug is a real clinical event regardless of where the row came from.
- **`getPrintablePrescriptions` returns rows with the prescriber joined** for a single valid id, including `credentials` and `specialty`.
- **`getPrintablePrescriptions` returns null when the ids span two patients** (Review Focus #2): one episode on patient A, one on patient B, both prescribed.
- **`getPrintablePrescriptions` returns null when any id has `prescribedAt: null`**.
- **`getPrintablePrescriptions` returns null when any id does not exist**, and **null for an empty array**.

- [ ] **Step 2: Run them to confirm they fail**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/prescriptions.test.ts`
Expected: FAIL — `@/lib/queries/prescriptions` does not exist.

- [ ] **Step 3: Implement `src/lib/queries/prescriptions.ts`**

Signatures exactly as in this task's Interfaces block.

`createPrescription`: one `insert(medicationEpisodes).values({ ...input, status: 'active', prescribedAt: new Date() }).returning()`.

`stopPrescription`: a single conditional UPDATE with the guard in the `WHERE` clause, matching `src/lib/queries/lab-orders.ts`'s lifecycle functions and the codebase-wide conditional-transition convention — `eq(id)`, `eq(patientId)`, `eq(status, 'active')` — then `.returning()`. Distinguish the two failure reasons with one follow-up existence query keyed on `id` **and** `patientId`: a row that exists and belongs to this patient means `already_inactive`; anything else means `not_found`. Never read-then-write.

`getPrintablePrescriptions`: return `null` immediately for an empty array. One query with `inArray(medicationEpisodes.id, ids)` `innerJoin`ed to `providers` on `prescribedByProviderId`, filtered `isNotNull(medicationEpisodes.prescribedAt)`. Then, before returning: `null` unless the result length equals the count of **distinct** requested ids, and `null` unless every row shares one `patientId`. The inner join plus the `isNotNull` filter make "missing id", "not prescribed" and "no prescriber" all collapse into a short result set, and the length check is what turns that into a `null`.

- [ ] **Step 4: Run the query tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/prescriptions.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing FHIR tests**

In `tests/lib/fhir/medication-request-mapping.test.ts`, add:

- **a prescribed row composes the full sig into `dosageInstruction[0].text`**: for `{ dose: '50mg', frequencyPerDay: 2, durationDays: 30, instructions: 'Take with food.' }`, assert the text contains `50mg`, `2 times daily`, `30 days` and `Take with food.`
- **a prescribed row's `authoredOn` is `prescribedAt`'s date, not `startDate`**: set `prescribedAt: new Date('2026-09-29T17:04:00Z')` and `startDate: '2026-06-01'`; assert `authoredOn === '2026-09-29'`.
- **an imported row's output is unchanged, byte for byte**: a row with all seven new columns `null` and `dose: '10mg'` still produces `dosageInstruction: [{ text: '10mg' }]` and `authoredOn === startDate`; a row with `dose: null` and all seven null still produces **no** `dosageInstruction` key at all (`expect('dosageInstruction' in resource).toBe(false)`).

- [ ] **Step 6: Run them to confirm they fail**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/fhir/medication-request-mapping.test.ts`
Expected: FAIL on the two new-behavior tests; the unchanged-output tests should already pass.

- [ ] **Step 7: Implement the two mechanical improvements**

In `src/lib/fhir/medication-request.ts`, compose the dosage text from the parts that are present, in the order dose → frequency → duration → instructions, joined with `' · '`, and emit the `dosageInstruction` key only when at least one part exists (so a fully-null imported row still omits it). Set `authoredOn` to `episode.prescribedAt.toISOString().slice(0, 10)` when `prescribedAt` is set, else `episode.startDate`. Keep `status`, the `active`-only filter, and the deliberate absence of RxNorm `coding` unchanged, and do **not** add a `requester` reference — a FHIR `Practitioner` resource does not exist in this export.

- [ ] **Step 8: Run the FHIR and export suites to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/fhir/ tests/api/fhir-export-routes.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/queries/prescriptions.ts src/lib/fhir/medication-request.ts tests/lib/queries/prescriptions.test.ts tests/lib/fhir/medication-request-mapping.test.ts
git commit -m "$(cat <<'EOF'
feat: add prescriptions query layer and sharpen FHIR MedicationRequest

EOF
)"
```

---

### Task 4: Write API — prescribe route, discontinue route, and the on-behalf-of admin path

**Files:**
- Create: `src/app/api/patients/[anonId]/prescriptions/route.ts` (POST)
- Create: `src/app/api/patients/[anonId]/prescriptions/[id]/route.ts` (PATCH)
- Test: `tests/api/patients-prescriptions.test.ts`

**Interfaces:**
- Consumes: `resolveSessionProvider` from `@/lib/provider-identity` (Task 1); `createPrescription`, `stopPrescription`, `CreatePrescriptionInput`, `StopPrescriptionResult` from `@/lib/queries/prescriptions` (Task 3); `requireSession` from `@/lib/auth`, `logAudit` from `@/lib/audit`, `invalidateCache`/`patientDetailCacheKey` from `@/lib/cache`, `listActiveProviders` from `@/lib/queries/providers` (all existing).
- Produces: `POST /api/patients/[anonId]/prescriptions` → `201` with the raw created `medicationEpisodes` row (no envelope, matching the lab-orders route). `PATCH /api/patients/[anonId]/prescriptions/[id]` → `200` with the updated row. Both consumed by Task 6's client components by URL.

- [ ] **Step 1: Write the failing tests**

Create `tests/api/patients-prescriptions.test.ts`, following `tests/api/lab-orders-routes.test.ts` exactly: hoisted `vi.mock('@/lib/auth', …)` closing over mutable module-scope `let sessionRole`, `let sessionName`, **and `let sessionUserId: number | null`** — the mock factory must return `{ role: sessionRole, name: sessionName, userId: sessionUserId }`, because this is the first route test in the repo whose route reads `session.userId`. Route imports come after the mocks, aliased per verb as `POST as createPrescriptionRoute` and `PATCH as stopPrescriptionRoute` — deliberately **not** `createPrescription`/`stopPrescription`, which are Task 3's query-layer function names and would read as the wrong layer. `beforeAll` resolves the real seeded ids: two distinct patients, the `users.id` for `rkunam.demo@example.com`, that user's linked `providers.id`, and one `medications.id`. `afterEach` resets the three session `let`s to an admin default and deletes every tracked episode id. Requests are plain WHATWG `Request` objects cast `as never`, with `{ params: Promise.resolve({ anonId }) }` / `{ params: Promise.resolve({ anonId, id: String(episodeId) }) }`.

`describe('POST /api/patients/[anonId]/prescriptions')`:

- **`pi` with a linked provider gets 201 attributed to that provider**: `sessionRole = 'pi'`, `sessionName = 'Dr. R. Kunam'`, `sessionUserId = <kunam users.id>`; assert `201`, `body.prescribedByProviderId === <kunam providers.id>`, `body.status === 'active'`, `body.prescribedAt` truthy, `body.enteredByName === 'Dr. R. Kunam'`.
- **`pi` with no resolvable provider gets 403 and writes nothing**: `sessionUserId = null`; assert `403`, the error text is exactly `Could not resolve your provider identity. Ask an admin to link your account to a provider in the Staff Directory.`, and a `select` for that patient's episodes returns the same count as before the call.
- **`admin` with no resolvable provider and no `onBehalfOfProviderId` gets 400** and writes nothing.
- **`admin` with a valid `onBehalfOfProviderId` gets 201** with `prescribedByProviderId` set to the chosen provider and `enteredByName` set to the admin's session name — the two different people the record has to stay honest about.
- **`admin` with an `onBehalfOfProviderId` naming a nonexistent provider gets 400** and writes nothing (Review Focus #4) — use `9_999_999`.
- **`admin` with an `onBehalfOfProviderId` naming an *inactive* provider gets 400** (Review Focus #4): flip a seeded provider's `isActive` to `false` in the test, assert 400, restore it in `afterEach`.
- **`onBehalfOfProviderId` is silently ignored when the session already resolves a provider** (Review Focus #4): `pi` with `sessionUserId = <kunam>` **plus** `onBehalfOfProviderId: <a different provider's id>`; assert `201` and `prescribedByProviderId === <kunam providers.id>`. Neither honored nor rejected.
- **`crc` gets 403** and **`frontdesk` gets 403**.
- **no session gets 401**: make the mock return a 401 `NextResponse` for one test.
- **an unknown field is rejected** (mass-assignment guard): body with `{ …valid, nickname: 'x' }` → `400`.
- **a client-supplied `prescribedByProviderId` is rejected by `.strict()`** → `400`, and likewise `prescribedAt`, `enteredByName` and `status`.
- **`frequencyPerDay: 0`, `frequencyPerDay: 7`, `durationDays: 0`, `durationDays: 400` each → 400**.
- **`startDate: '09/29/2026'` → 400** (regex), and **`instructions` of 501 characters → 400**.
- **the off-catalog path works**: `medicationId` omitted entirely, `name` and `medicationClass` free text → `201` with `medicationId === null`.

`describe('PATCH /api/patients/[anonId]/prescriptions/[id]')`:

- **`pi` stops an active prescription**: `200`, `status === 'inactive'`, `stopDate` set.
- **no request body at all still succeeds and defaults `stopDate` to today** — the Stop button in Task 6 sends none.
- **a second PATCH on the same row → 409**.
- **PATCH on an episode belonging to another patient → 404** (create under patient A, call with patient B in the path).
- **PATCH on an unknown id → 404**, and **a non-numeric `id` path segment → 404**.
- **`crc` and `frontdesk` → 403**; **an unknown body field → 400**.

- [ ] **Step 2: Run them to confirm they fail**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/patients-prescriptions.test.ts`
Expected: FAIL — neither route module exists.

- [ ] **Step 3: Implement the prescribe route**

Create `src/app/api/patients/[anonId]/prescriptions/route.ts`, modelled on `src/app/api/patients/[anonId]/lab-orders/route.ts`. `requireSession()` first, then the gate `if (!['admin', 'pi'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })` with a comment naming why (spec §10: ordering and prescribing are the clinical tier; `crc` and `frontdesk` are coordination and registration roles). Then the schema, verbatim from spec §5:

```ts
const createPrescriptionSchema = z.object({
  medicationId: z.number().int().positive().nullable().optional(),
  name: z.string().trim().min(1).max(200),
  medicationClass: z.string().trim().min(1).max(100),
  dose: z.string().trim().min(1).max(100).nullable().optional(),
  frequencyPerDay: z.number().int().min(1).max(6),
  durationDays: z.number().int().min(1).max(365),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  instructions: z.string().trim().max(500).nullable().optional(),
  onBehalfOfProviderId: z.number().int().positive().optional(),
}).strict()
```

Add a comment that the `≤ 6` and `≤ 365` bounds are structural sanity bounds on an integer field — explicitly **not** dosing-safety validation, which is out of scope (spec §1) — so a typo'd `300` times daily is rejected as malformed input without the app claiming it validated a regimen. 400 on parse failure with `{ error: 'Invalid prescription payload', details: parsed.error.flatten() }`.

Prescriber resolution, in exactly this order (this ladder is the whole of Review Focus #4):

```ts
const resolved = await resolveSessionProvider(session)
let prescribedByProviderId: number
if (resolved) {
  // The resolved identity always wins. onBehalfOfProviderId is IGNORED
  // here rather than rejected -- a doctor must not be able to prescribe
  // under someone else's name just by adding a field to the body.
  prescribedByProviderId = resolved.id
} else if (session.role === 'admin') {
  // Deliberately NOT "fall back to the first active provider" the way
  // lab-orders does: silently attributing a prescription to whoever sorts
  // first is a fabricated clinical fact on the one field where that is
  // least acceptable. An explicit picker records what actually happened.
  const onBehalfOf = parsed.data.onBehalfOfProviderId
  if (onBehalfOf === undefined) return NextResponse.json({ error: 'Select the provider you are prescribing on behalf of.' }, { status: 400 })
  const match = (await listActiveProviders()).find((p) => p.id === onBehalfOf)
  if (!match) return NextResponse.json({ error: 'That provider is not on the active roster.' }, { status: 400 })
  prescribedByProviderId = match.id
} else {
  return NextResponse.json({ error: 'Could not resolve your provider identity. Ask an admin to link your account to a provider in the Staff Directory.' }, { status: 403 })
}
```

The 403 message is actionable because the remedy — linking a `users` row to a `providers` row in the Staff Directory — is an existing admin capability, not something to build.

Call `createPrescription` with `enteredByName: session.name` and `medicationId`/`dose`/`instructions` normalized from `undefined` to `null`. Then `await invalidateCache(patientDetailCacheKey(anonId))` — **required**, unlike the lab-orders route, because `getPatientDetail` caches `medications` for 30 seconds and a freshly written prescription would otherwise be invisible on the very page that wrote it. Then `await logAudit(session, \`prescribed ${parsed.data.name}\`, anonId)`. Return `NextResponse.json(created, { status: 201 })`.

- [ ] **Step 4: Implement the discontinue route**

Create `src/app/api/patients/[anonId]/prescriptions/[id]/route.ts` with `PATCH(request, { params }: { params: Promise<{ anonId: string; id: string }> })`. Same `requireSession()` + `['admin', 'pi']` gate. Schema:

```ts
const stopPrescriptionSchema = z.object({
  stopDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict()
```

Read the body as `await request.json().catch(() => ({}))` — every field is optional and the Stop button sends no body at all, so a bare `request.json()` would throw on an empty payload. Parse the `id` segment with `Number(id)`; a `NaN` or non-positive value is a `404`, not a 400 — an unparseable id addresses no row. Default `stopDate` to today in `YYYY-MM-DD`.

Map `stopPrescription(anonId, episodeId, stopDate)`'s result:

| result | response |
|---|---|
| `reason: 'not_found'` | 404 `{ error: 'Not found' }` |
| `reason: 'already_inactive'` | 409 `{ error: 'This prescription has already been stopped.' }` |
| `ok: true` | 200 with the updated row |

Same `invalidateCache(patientDetailCacheKey(anonId))` and `logAudit(session, \`stopped prescription ${episodeId}\`, anonId)` on success only. Add a comment that this is the only mutation offered — there is no edit-the-drug-or-dose path, because changing a written prescription in place would rewrite a record another party may already be holding on paper; the correct action is to stop it and write a new one.

- [ ] **Step 5: Run the route tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/patients-prescriptions.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add "src/app/api/patients/[anonId]/prescriptions" tests/api/patients-prescriptions.test.ts
git commit -m "$(cat <<'EOF'
feat: add prescribe and discontinue routes with real prescriber attribution

EOF
)"
```

---

### Task 5: The printable prescription page

**Files:**
- Create: `src/app/prescriptions/print/page.tsx`
- Create: `src/components/PrintButton.tsx`
- Modify: `src/app/globals.css` (append the codebase's first `@media print` block)
- Test: `tests/pages/prescriptions-print.test.tsx` — note the location: spec §9 calls this `tests/api/prescriptions-print.test.ts`, but the thing under test is a page component, and `tests/pages/*.test.tsx` is where this repo renders page components (`tests/api/` holds route-handler and query-layer tests). Same tests, conventional home.

**Interfaces:**
- Consumes: `getPrintablePrescriptions`, `PrintablePrescription` from `@/lib/queries/prescriptions` (Task 3); `requireSessionOrRedirect` from `@/lib/auth`, `logAudit` from `@/lib/audit`, `getAppSettings` from `@/lib/queries/settings`, `getPatientDetail` from `@/lib/queries/patients` (all existing).
- Produces: the route `GET /prescriptions/print?ids=<n>[,<n>…]`, linked from Task 6's per-row Print link and post-save confirmation. The `.no-print` class contract is established here and used by Task 6 nowhere else.

- [ ] **Step 1: Re-run the patients-column check before writing anything**

Per the environment hazard in Global Constraints, this is the one task that reads patient identity. Write and run the same throwaway `pg` + `information_schema` script Task 1 Step 1 used, printing the `patients` column list, and compare it against what `src/db/schema.ts` declares for `patients` on this branch **right now**.

- If they agree: proceed, reading name and DOB through the columns the schema declares.
- If they disagree (the live DB has `name`/`dob` while the branch still declares `name_tebra`/`name_intakeq`/`dob_tebra`/`dob_intakeq`): **STOP and report a blocked task.** Do not edit the `patients` table definition, do not add a compatibility shim, and do not run another worktree's migration. Reconciling `patients` belongs to the `unified-patient-record` spec.

Record the outcome in the task report either way.

- [ ] **Step 2: Write the failing test**

Create `tests/pages/prescriptions-print.test.tsx`, following `tests/pages/doctor.test.tsx`'s shape (invoke the async page component directly, then `render()` the returned JSX with `@testing-library/react`). Mock `@/lib/auth` (`requireSessionOrRedirect` returning a mutable module-scope session), `@/lib/audit` (`logAudit` as a `vi.fn()` the tests assert on), and `next/navigation` so `notFound` throws a recognizable sentinel:

```ts
class NotFound extends Error {}
vi.mock('next/navigation', () => ({ notFound: () => { throw new NotFound() } }))
```

Seed real rows directly via `getDb()` in `beforeAll` — two prescribed episodes on patient A, one prescribed episode on patient B, and one imported (`prescribedAt: null`) episode on patient A — and delete them in `afterAll`. Call the page as `await PrescriptionPrintPage({ searchParams: Promise.resolve({ ids: '…' }) })`. Tests:

- **a valid single id renders the slip**: assert the patient's name, the drug name, `2 times daily`, `for 30 days`, the instructions text, the prescriber's name + credentials + specialty, and the exact footer `This printout is a record of a prescription entered in Clinsync. It was not transmitted electronically to a pharmacy.` are all present.
- **it writes an audit row**: `expect(logAudit).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('printed prescription'), 'RD-…')` with the patient's id.
- **two ids on the same patient render one slip with two Rx blocks**.
- **mixed-patient ids call `notFound()`** (Review Focus #2): `await expect(page({ searchParams: Promise.resolve({ ids: `${aId},${bId}` }) })).rejects.toThrow(NotFound)`, and assert `logAudit` was **not** called.
- **an id whose `prescribedAt` is null calls `notFound()`** — the chart must not offer to print, as a prescription from this clinic, a medication whose origin was an EHR import.
- **an unknown id calls `notFound()`**.
- **malformed `ids` each call `notFound()`** (Review Focus #2): missing `ids` entirely, `ids=''`, `ids='abc'`, `ids='1,'`, `ids='-1'`, and a 300-element list.
- **a repeated id is accepted and renders one block, not two**: `ids=<n>,<n>`.
- **`crc` and `frontdesk` sessions render successfully** (spec §10 — printing is a read of data all four roles already see, and it is audited on every render).
- **no role outside the four renders**: set the session role to `'pharmacy' as never` and assert `notFound()`.
- **there is no auto-print**: assert the rendered markup contains no `window.print` call wired to mount — the Print button is an explicit click. Assert the button exists and carries the `no-print` contract (`screen.getByRole('button', { name: /print/i })` is inside an element with class `no-print`).

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/pages/prescriptions-print.test.tsx`
Expected: FAIL — the page module does not exist.

- [ ] **Step 4: Implement the print page**

Create `src/app/prescriptions/print/page.tsx` as a Server Component:

```tsx
export default async function PrescriptionPrintPage({ searchParams }: { searchParams: Promise<{ ids?: string }> })
```

It is deliberately a **top-level** route, outside the `(dashboard)` route group: that group's layout wraps everything in `h-screen overflow-hidden` with a fixed top banner and left nav, which is actively wrong for a printed page. A top-level route inherits only the root layout, the same chrome-free arrangement `src/app/display/queue/page.tsx` uses. **Do not touch `src/proxy.ts`** — its matcher already covers `/prescriptions/print`, so an unauthenticated request is redirected to `/login`, which is exactly right for an authenticated PHI page. Adding it to the matcher's exclusion list would make a patient's medication list publicly reachable.

Order of operations, load-bearing:

1. `const session = await requireSessionOrRedirect()` as the **first statement** in the component body, per that helper's own documented requirement.
2. Role gate: `if (!['admin', 'pi', 'crc', 'frontdesk'].includes(session.role)) notFound()`.
3. Parse `ids`: split on `,`, require every token to match `/^\d+$/`, map to `Number`, de-duplicate, and `notFound()` unless the result has between 1 and 20 entries. The 20 cap is a bound on a URL-supplied fan-out, not a product limit.
4. `const rows = await getPrintablePrescriptions(ids)`; `if (!rows) notFound()`. All three substantive checks — every id exists, they share one patient, every one has `prescribedAt` and a resolvable prescriber — live in that one function (Task 3).
5. Load the patient via `getPatientDetail(rows[0].patientId)` and the clinic identity via `getAppSettings()`.
6. `await logAudit(session, \`printed prescription(s) ${ids.join(',')}\`, rows[0].patientId)` — after validation, so a rejected URL writes no audit row, and on every successful render, so every print is an audited PHI access.

What it renders, in this order:

| Block | Source |
|---|---|
| Clinic identity | `practiceName` / `practiceSite` from `getAppSettings()`, each falling back to `Clinsync` / omitted when null — both columns are nullable |
| Patient identity | name, patient id (e.g. `RD-0001`), DOB — read through whatever identity columns the branch's schema declares (Step 1) |
| Date written | `rows[0].prescribedAt`, formatted long |
| Rx body, one block per row | drug name and `medicationClass`; `dose`; `{frequencyPerDay} times daily`; `for {durationDays} days`; `instructions` when present |
| Prescriber | `prescriber.name`, `credentials`, `specialty`, with a ruled signature line beneath |
| Entered by | `enteredByName`, **only when it differs from** `prescriber.name` |
| Footer | exactly `This printout is a record of a prescription entered in Clinsync. It was not transmitted electronically to a pharmacy.` |

The footer is not boilerplate — it is the visible edge of the out-of-scope boundary, on the one artifact that leaves the building. It must render verbatim.

Wrap the on-screen-only controls in `<div className="no-print">`: a `<BackLink href={`/patients/${patientId}/medical-record`} label="Back to Medical Record" />` and `<PrintButton />`.

- [ ] **Step 5: Implement `PrintButton` and the print stylesheet**

Create `src/components/PrintButton.tsx`: `'use client'`, a single `<Button onClick={() => window.print()}>Print</Button>`. **No `useEffect` and no auto-`window.print()` on mount** — an authenticated PHI page that fires a print dialog before the reader has confirmed it is the right patient is a mis-print waiting to happen. Add that sentence as the component's comment so a later "improvement" does not add it back.

Append to `src/app/globals.css` — the first `@media print` block in the codebase, so this establishes the pattern rather than following one:

```css
/* First print styling in this codebase (spec §6). Forces light-on-white
   regardless of the active theme: this page's one job is to come out of a
   printer legibly, and .dark's oklch background would otherwise print as
   a grey slab. `.no-print` is the on-screen-controls contract used by
   src/app/prescriptions/print/page.tsx. */
@media print {
  .no-print { display: none !important; }
  html, body { background: #fff !important; color: #000 !important; }
  @page { margin: 18mm; }
}
```

- [ ] **Step 6: Run the test to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/pages/prescriptions-print.test.tsx`
Expected: PASS.

- [ ] **Step 7: Verify against a real running dev server**

Start the dev server on a free port, backgrounded. Mint a `clinsync_demo_session` cookie for a `pi` session per Global Constraints. Create one prescription through Task 4's real route with that cookie (`POST /api/patients/<anonId>/prescriptions`) and note the returned id. Then:

- Real `GET` of `/prescriptions/print?ids=<id>` with the cookie → confirm `200` and that the response HTML contains the patient name, the sig, the prescriber block and the exact footer.
- Real `GET` of `/prescriptions/print?ids=<id>,<an id from a different patient>` → confirm `404`.
- Real `GET` of `/prescriptions/print?ids=<id>` with **no** cookie → confirm the proxy redirects to `/login`.
- Real `GET` with a `crc` cookie → confirm `200`; with a `frontdesk` cookie → confirm `200`.

Paste every actual command and its actual output. Stop the dev server and delete the episode you created.

- [ ] **Step 8: Commit**

```bash
git add src/app/prescriptions src/components/PrintButton.tsx src/app/globals.css tests/pages/prescriptions-print.test.tsx
git commit -m "$(cat <<'EOF'
feat: add printable prescription page with same-patient id validation

EOF
)"
```

---

### Task 6: Medication History section extraction + Add Prescription form

**Files:**
- Create: `src/components/MedicationHistorySection.tsx`
- Create: `src/components/AddPrescriptionModal.tsx`
- Modify: `src/app/(dashboard)/patients/[anonId]/medical-record/page.tsx:80-101` (data loading and role booleans) and `:153-186` (replace the inline Medication History block)
- Test: `tests/components/MedicationHistorySection.test.tsx`

**Interfaces:**
- Consumes: Task 2's columns as they arrive on `patient.medications` from `getPatientDetail` (which does `select().from(medicationEpisodes)`, so the new columns flow through with no query change); `POST`/`PATCH` from Task 4 by URL; `/prescriptions/print?ids=` from Task 5 by URL; `resolveSessionProvider` from Task 1; `listAllProviders` from `@/lib/queries/providers` and `listMedicationsWithInventory` from `@/lib/queries/medications` (both existing, the latter already loaded by this page at `:92`).
- Produces:

```tsx
export interface PrescriberInfo { name: string; credentials: string | null; specialty: string }

export function MedicationHistorySection(props: {
  patientId: string
  episodes: (typeof medicationEpisodes.$inferSelect)[]
  prescriberById: Record<number, PrescriberInfo>
  catalog: MedicationWithInventory[]
  specialties: string[]
  activeProviders: { id: number; name: string; specialty: string }[]
  needsOnBehalfOf: boolean
  canPrescribe: boolean
}): JSX.Element
```

  `activeProviders` and `needsOnBehalfOf` are additions to spec §4's illustrative prop list: §4's field table requires the "Prescribing as" select to render **only for an `admin` whose session has no resolvable provider**, and the component cannot determine that from `specialties` alone. `prescriberById` is a plain `Record`, not a `Map`, so it crosses the Server→Client boundary without any serialization question.

- [ ] **Step 1: Write the failing component test**

Create `tests/components/MedicationHistorySection.test.tsx`, following `tests/components/NewChargeModal.test.tsx`: `vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))`, then `render()` + `screen` assertions. Build episode fixtures as plain objects, not DB rows. Tests:

- **an imported row renders exactly as it does today**: `{ dose: '10mg', startDate: '2026-03-12', status: 'active' }` with all seven new fields null → the line reads `10mg · started 12 Mar 2026`, and there is **no** prescriber line and **no** Print link for it.
- **an imported row with a null dose still reads `Dose not recorded · started …`**.
- **a prescribed row renders the composed sig**: `{ dose: '50mg', frequencyPerDay: 2, durationDays: 30 }` → `50mg · 2 times daily · 30 days · started …`.
- **a prescribed row renders `instructions` on its own line**.
- **a prescribed row renders the prescriber line**: `Prescribed by Dr. Rajiv Kunam, MD · Psychiatry · 29 Sep 2026`, resolved through `prescriberById`.
- **`Entered by …` appears only when `enteredByName` differs from the prescriber's name**: two fixtures, one matching and one differing.
- **a prescribed row renders a Print link to `/prescriptions/print?ids=<id>`** (assert the `href` exactly).
- **Review Focus #5 — a `prescribedAt` that is an ISO *string* renders the same date as one that is a `Date`**: two otherwise identical fixtures, one with `new Date('2026-09-29T17:04:00Z')` and one with `'2026-09-29T17:04:00.000Z'`, produce the same rendered date text and neither throws. This is the Redis-cache-hit shape.
- **`canPrescribe: false` renders no "Add prescription" button and no "Stop" action**.
- **`canPrescribe: true` renders both**, and Stop renders only on `active` rows.
- **the specialty facet renders only when prescribed rows span more than one specialty**: one fixture set with a single specialty (no facet control present), one with two (facet present, and selecting one hides the other's row).
- **the existing "Currently Taking" / "Past Medications" grouping is preserved** and an empty `episodes` array renders `No medications recorded.`

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/components/MedicationHistorySection.test.tsx`
Expected: FAIL — the component does not exist.

- [ ] **Step 3: Extract the section into a client component**

Create `src/components/MedicationHistorySection.tsx` (`'use client'`), props exactly as in this task's Interfaces block. Move the existing markup from `medical-record/page.tsx:153-186` across **unchanged** — the `active`/`inactive` grouping, the `Currently Taking` / `Past Medications` labels and their `text-emerald-700` / `text-muted-foreground` treatment, the `Pill` icon, the `rounded-lg border border-border bg-secondary/30 px-3 py-2 text-sm` list item, and the empty state. Copy the page's local `formatDate(value: string | Date | null)` helper (`page.tsx:25`) into this file; it already tolerates both a `Date` and a string, which is what Review Focus #5 needs.

Heading row follows `LabResultsSection`'s pattern verbatim:

```tsx
<div className="mb-3 flex items-center justify-between">
  <h2 className={SECTION_HEADING}>Medication History</h2>
  {canPrescribe && <Button size="sm" onClick={() => setAdding(true)}>Add prescription</Button>}
</div>
```

using a file-local `SECTION_HEADING` const, the way `CarePlanSection.tsx:14` deliberately duplicates it. The button is **not rendered** rather than disabled, matching this page's established convention.

Per-row additions, each gated as stated:

- **Sig line.** Keep today's line and insert the new segments between the dose and `started`: `{dose ?? 'Dose not recorded'}` `[· {frequencyPerDay} times daily]` `[· {durationDays} days]` `· started {formatDate(startDate)}` `[· stopped {formatDate(stopDate)}]`. Omitting whatever is null is what makes an imported row byte-identical to today's output.
- **`instructions`** on its own `text-xs text-muted-foreground` line when set.
- **Prescriber line, only when `prescribedAt` is set** — never gated on `prescribedByProviderId` instead: `Prescribed by {name}{credentials ? \`, ${credentials}\` : ''} · {specialty} · {formatDate(prescribedAt)}`, with `· Entered by {enteredByName}` appended when `enteredByName` is set and differs from the prescriber's name. Look the prescriber up in `prescriberById`; render the line without the name/specialty parts if the lookup misses rather than crashing.
- **Print link, only when `prescribedAt` is set**: `<a href={\`/prescriptions/print?ids=${m.id}\`} target="_blank" rel="noopener noreferrer">Print</a>`. An imported history row gets none — the chart must not offer to print, as a prescription from this clinic, a medication whose origin was an EHR import.
- **Stop action** on `active` rows when `canPrescribe`: `PATCH` to `/api/patients/${patientId}/prescriptions/${m.id}` with no body, then `router.refresh()` (**not** `window.location.reload()` — `router.refresh()` is what ~30 components in this codebase use). Surface the route's own `error` string on failure, falling back to `Could not stop this prescription.` Stop is offered on imported active episodes too (spec §5): discontinuing a drug is a real clinical event regardless of where the row came from.
- **Specialty facet**, rendered only when the prescribed rows resolve to more than one distinct specialty. A native `<select>` with an `aria-label` and an "All specialties" option, filtering the list; imported rows (no specialty) are always shown. Options come from `specialties`, which the page derives as `SELECT DISTINCT specialty FROM providers WHERE is_active` — never a hardcoded enum, so adding a neurologist to the roster makes Neurology appear with no code change.

- [ ] **Step 4: Build the Add Prescription modal**

Create `src/components/AddPrescriptionModal.tsx`, modelled on `src/components/OrderLabTestModal.tsx`: `'use client'`, open state owned by the parent, `<Dialog open onOpenChange={(open) => { if (!open) onClose() }}>`, `<DialogContent className="max-w-md">` → `<DialogHeader><DialogTitle>New Prescription</DialogTitle></DialogHeader>` → a `<div className="max-h-[60vh] space-y-3 overflow-y-auto">` of fields → `<DialogFooter>` with a Cancel and a submit `<Button>`. Bare `<input>`/`<select>` with `aria-label` and `className="w-full rounded-md border border-border px-3 py-2 text-sm"`.

Signature: `{ patientId, catalog, activeProviders, needsOnBehalfOf, onClose }`.

| Field | Control | Notes |
|---|---|---|
| Medication | `<select>` over `catalog` | selecting a row sets `medicationId`, `name`, `medicationClass`, and prefills `dose` from `commonDose` |
| — *or* — | "Not in our catalog" checkbox | reveals free-text `name` + `medicationClass`; `medicationId` stays `null` |
| Dose | text | prefilled, editable, optional |
| Times per day | number, `min=1 max=6` | required |
| Duration (days) | number, `min=1 max=365` | required |
| Start date | date, defaults to today | required |
| Instructions | textarea, `maxLength={500}` | optional |
| Prescribing as | `<select>` over `activeProviders` | rendered **only when `needsOnBehalfOf`**, and then required; sends `onBehalfOfProviderId` |

Note in a comment that `catalog` comes from `listMedicationsWithInventory()`, which inner-joins inventory — a catalog drug with no inventory row is not listed, and the off-catalog path is the escape hatch for it as well as for a genuinely unstocked drug.

Submit follows `OrderLabTestModal.submit()` exactly: `POST` JSON to `/api/patients/${patientId}/prescriptions`, `setSubmitting` around it, on failure `setError(body?.error ?? 'Could not save this prescription.')`. On success, do **not** close immediately: keep the dialog open and swap its body for a confirmation carrying a **Print prescription** link to `/prescriptions/print?ids=${created.id}` (new tab) plus a Done button that calls `router.refresh()` then `onClose()`. Closing without printing is fine — the Print link is permanently available on the row.

- [ ] **Step 5: Wire the section into the Medical Record page**

In `src/app/(dashboard)/patients/[anonId]/medical-record/page.tsx`:

- Alongside the existing `listMedicationsWithInventory()` call at `:92`, add `const allProviders = await listAllProviders()` and `const sessionProvider = await resolveSessionProvider(session)`.
- Derive, next to the existing `canWriteInsurance` / `canOrderLabs` booleans at `:99-101`:

```ts
const canPrescribe = ['admin', 'pi'].includes(session.role)
// admin needs the explicit on-behalf-of picker only when its own session
// has no provider row behind it (spec §5).
const needsOnBehalfOf = session.role === 'admin' && sessionProvider === null
const prescriberById = Object.fromEntries(allProviders.map((p) => [p.id, { name: p.name, credentials: p.credentials, specialty: p.specialty }]))
const specialties = [...new Set(allProviders.filter((p) => p.isActive).map((p) => p.specialty))].sort()
const activeProviders = allProviders.filter((p) => p.isActive).map((p) => ({ id: p.id, name: p.name, specialty: p.specialty }))
```

  `prescriberById` is built from the **full** roster (`listAllProviders`) so a prescription written by a since-deactivated provider still shows its prescriber; `specialties` and `activeProviders` come from the active subset only.
- Replace lines `153-186` with `<section className={SECTION}><MedicationHistorySection … /></section>`, with no page-level `<h2>` — the client component owns its own heading row, exactly as `LabResultsSection` and `CarePlanSection` do on this page.
- Add no read restriction: every role that can see this section today still can.

- [ ] **Step 6: Run the component test and the page's suites**

Run: `npx dotenv -e .env.local -- npx vitest run tests/components/MedicationHistorySection.test.tsx tests/pages/ tests/api/patients-prescriptions.test.ts`
Expected: PASS. Then `npx tsc --noEmit` and `npx eslint src/components/MedicationHistorySection.tsx src/components/AddPrescriptionModal.tsx "src/app/(dashboard)/patients/[anonId]/medical-record/page.tsx"` — expected: clean.

- [ ] **Step 7: Verify the whole flow against a real running dev server**

Start the dev server on a free port, backgrounded. Then, with real HTTP requests and real cookies minted per Global Constraints:

- **`pi` happy path:** `GET /patients/<anonId>/medical-record` with a `pi` cookie whose `userId` is the seeded Kunam user → confirm the HTML contains `Add prescription`. `POST` a prescription through the route, then `GET` the page again → confirm the new row, its composed sig, its prescriber line (`Dr. Rajiv Kunam, MD · Psychiatry`) and its Print link `href` all render, and that an existing imported row on the same patient renders with **no** prescriber line and **no** Print link.
- **Print:** `GET` the Print link's `href` with the same cookie → confirm the slip renders with the footer.
- **Stop:** `PATCH` the new prescription, then `GET` the page → confirm it has moved to "Past Medications" with a stopped date.
- **`crc` negative:** `GET` the page with a `crc` cookie → confirm no `Add prescription` button. `POST` the route with it → confirm 403 and that nothing was written.
- **`admin` on-behalf-of:** with an env-admin cookie (`userId: null`) → confirm the page renders the "Prescribing as" select, and that a `POST` without `onBehalfOfProviderId` is 400 while one with a valid id is 201 with `enteredByName` set to the admin's name.

Paste every actual command and its actual output. Stop the dev server and delete every episode you created.

- [ ] **Step 8: Run the full suite once**

Run: `npx dotenv -e .env.local -- npx vitest run`
Expected: all pass. Any pre-existing failure caused by the `patients` divergence described in Global Constraints must be reported as such, with evidence that it also fails on `git stash`-free base commit `8b514c5`, and not "fixed" inside this task.

- [ ] **Step 9: Commit**

```bash
git add src/components/MedicationHistorySection.tsx src/components/AddPrescriptionModal.tsx \
  "src/app/(dashboard)/patients/[anonId]/medical-record/page.tsx" \
  tests/components/MedicationHistorySection.test.tsx
git commit -m "$(cat <<'EOF'
feat: add prescribing UI to the Medical Record medication section

EOF
)"
```

---

## Out of scope for this plan

Spec §12's six open questions are **not** this plan's to resolve, and no task above adds work for them. Each carries the spec's own current answer, which every task implements as written: `frequencyPerDay` stays an integer with `instructions` as the narrative escape hatch; `admin` stays in the prescribe gate with explicit on-behalf-of attribution; `medicationId` stays nullable; the pharmacy dashboard's name-match is untouched (whichever branch merges second owns preferring the new FK); the other six fuzzy-match call sites keep their current behavior; and an imported episode remains stoppable. A reviewer who wants a different answer to any of them is raising a spec question, not a plan defect.

Also untouched, per spec §1: real e-prescribing or any transmission, controlled-substance/DEA/EPCS handling, drug-interaction or dosing-safety checking, refill workflows, the pharmacy dispense flow (`dispenseMedication`, `POST /api/pharmacy/dispense`, `DispenseMedicationModal`), and the parallel RBAC audit of whether `pi` can reach the Medical Record page at all.
