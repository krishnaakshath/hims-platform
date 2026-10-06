# Staff / HR Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Clinsync a staff directory with employment status and clinical-credential expiry tracking — who works here, are they currently active, and whose license/certification is about to lapse — without building payroll, benefits, or any other HR-vendor-scoped functionality.

**Architecture:** `staffMembers` is the employment roster row, optionally linked to `users` (system login) and/or `providers` (clinical scheduling roster) via nullable FKs, with its own denormalized `name` so a staff record reads correctly in history even after either link is removed — the same reasoning already used for `medicationDispenses.dispensedByName` and `admissionTransfers.transferredByName`. `staffCredentials` is a one-to-many side table (one staff member, many licenses/certifications, each with its own expiry), the same shape `allergies` already uses against `patients`.

**Tech Stack:** Next.js 16 App Router (Server Components) + Drizzle ORM over a `pg` Pool (additive-only schema changes via a hand-written one-off script, never `drizzle-kit push`) + Tailwind v4 oklch tokens.

**Spec:** `docs/superpowers/specs/2026-09-28-staff-hr-management.md`

**Working directory note:** this plan is executed in an isolated git worktree at `/Users/k2a/Desktop/clinsync/.worktrees/staff-hr` on branch `feature/staff-hr`, forked from `hims-platform`. This worktree has its own `.env.local` and `node_modules` already set up. Every implementer/reviewer dispatch for this plan must work from this exact directory, not the main checkout — the main checkout and other worktrees (`.worktrees/lab-orders-results`, `.worktrees/pharmacy-med-inventory`, etc.) have their own concurrent work in flight; do not touch them.

## Global Constraints

- Additive-only schema changes. Apply via a hand-written one-off script run with `npx dotenv -e .env.local -- npx tsx <script>` — never `drizzle-kit push`. This is a **single shared Neon Postgres database across every branch/worktree** — a schema mistake here is visible everywhere immediately, including the main checkout and every other active worktree.
- `psql` is not installed in this environment — verify a migration's live-DB effect with a Node script using `pg`'s `Pool` and an `information_schema.columns`/row-count query.
- Every write route uses `.strict()` Zod validation.
- Every state-changing route calls `logAudit(session, <action>, null)` — staff/HR records aren't patient-scoped, so the `patientId` argument is always `null` here (matching the pattern `logAudit(session, 'created a staff account', null)` already uses in `src/app/api/users/route.ts`).
- Every protected route/page starts with `requireSession()` (API routes) or `requireSessionOrRedirect()` (pages) as its first statement.
- Role gating per spec §6: read (staff directory, credential expiry summary) = admin, pi, crc, frontdesk. Write (add/edit a staff member or credential) = **admin only** — this is an administrative function, not this app's usual pi+admin clinical-write split, so do not reuse a `['admin','pi']` role list from a clinical plan.
- "Expiring soon" per spec §3 = `expiresOn` is non-null and within 60 days of today (fixed, not user-configurable). "Expired" = `expiresOn` is in the past. These are distinct statuses, never merged into one bucket, and every rendering of either uses an icon/text label alongside color — never color alone — matching every prior status-pill in this codebase.
- Seed data goes in `src/db/seed.ts`, idempotent (check-before-insert by name), matching the `seedMedications()`/`seedPayers()` convention already established in this file — read both before writing `seedStaff()`.
- Commit messages end with no attribution trailer.
- UI verification discipline: verify via a real running dev server hit with real HTTP requests (mint a session cookie the way `src/lib/auth.ts` actually builds it — `buildSessionCookieValue(role, name)` / `SignJWT` under cookie `clinsync_demo_session`, secret from `SESSION_SECRET`), with actual commands and actual output pasted in the report. Never a narrated, unreproduced claim — a prior implementer fabricated UI verification evidence earlier this session and was caught; this session has a standing rule against it.
- Vitest invocation: `npx dotenv -e .env.local -- npx vitest run <path>` (`fileParallelism: false`).

## Review Focus

1. **A `POST /api/staff` payload with a `userId` or `providerId` that doesn't reference an existing `users`/`providers` row** — the create route must reject with 400 before insert, not let Postgres's FK constraint throw an unhandled 500 (same cross-entity-forgery class the Pharmacy plan's `medicationEpisodeId` check and the Lab-Orders plan's patient-scoping fix both found in this session's sibling plans). (Task 2)
2. **The 60-vs-61-day expiry boundary** — spec §3 fixes the warning window at 60 days; a credential expiring in exactly 60 days must appear in `listExpiringOrExpiredCredentials()`, one expiring in 61 days must not appear at all. (Task 2)
3. **An already-expired credential must never be folded into "expiring soon"** — it gets its own `status: 'expired'` distinct from `status: 'expiring_soon'`, both present together in the same sorted list per spec §3, and rendered with a distinct icon/text label (not color alone) everywhere it's shown. (Task 2 for the query; Task 3/Task 4 for the two UI renderings)
4. **Creating a staff member with neither `userId` nor `providerId` set must succeed** — spec §1 is explicit that not every staff member has either link (front-desk-only or housekeeping staff); it's easy to accidentally make one of these Zod fields required by habit, copying a pattern from a table where the FK is mandatory. (Task 2)
5. **A `pi`, `crc`, or `frontdesk` session calling a write route (`POST /api/staff`, `POST /api/staff/[id]/credentials`) must get 403 while still succeeding on the read routes** — this feature's write access is admin-only, unlike this app's usual pi+admin clinical-write split, so a role list copy-pasted from a clinical plan would wrongly grant `pi` write access here. (Task 2)

---

### Task 1: Schema — `staff_members`, `staff_credentials`, seed data

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/seed.ts`
- Test: `tests/db/staff-schema.test.ts`

**Interfaces:**
- Produces: `employmentStatusEnum`, `staffMembers` table (`id, userId, providerId, name, department, title, employmentStatus, hireDate, terminationDate`), `staffCredentials` table (`id, staffMemberId, credentialType, credentialNumber, expiresOn`). Consumed by Tasks 2-4.

- [ ] **Step 1: Read the existing `users` and `providers` table definitions**

Read `src/db/schema.ts`'s current `users` and `providers` tables (both `serial('id')` primary keys) before writing `staffMembers.userId`/`staffMembers.providerId` — confirm the FK column types match (`integer`, nullable, no `.notNull()`).

- [ ] **Step 2: Write the failing test**

Create `tests/db/staff-schema.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { staffMembers, staffCredentials } from '@/db/schema'

const createdStaffIds: number[] = []
afterEach(async () => {
  while (createdStaffIds.length > 0) {
    const id = createdStaffIds.pop()!
    await getDb().delete(staffCredentials).where(eq(staffCredentials.staffMemberId, id))
    await getDb().delete(staffMembers).where(eq(staffMembers.id, id))
  }
})

describe('staff schema', () => {
  it('creates a staff member with neither userId nor providerId set', async () => {
    const db = getDb()
    const [staff] = await db.insert(staffMembers).values({
      name: 'Test Receptionist', department: 'Front Desk', title: 'Receptionist', hireDate: '2024-01-01',
    }).returning()
    createdStaffIds.push(staff.id)
    expect(staff.userId).toBeNull()
    expect(staff.providerId).toBeNull()
    expect(staff.employmentStatus).toBe('active')
  })

  it('attaches a credential to a staff member', async () => {
    const db = getDb()
    const [staff] = await db.insert(staffMembers).values({
      name: 'Test Clinician', department: 'Clinical', title: 'Psychiatrist', hireDate: '2024-01-01',
    }).returning()
    createdStaffIds.push(staff.id)
    const [cred] = await db.insert(staffCredentials).values({
      staffMemberId: staff.id, credentialType: 'DEA Registration', expiresOn: '2027-01-01',
    }).returning()
    expect(cred.staffMemberId).toBe(staff.id)
    expect(cred.credentialNumber).toBeNull()
  })
})
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/staff-schema.test.ts`
Expected: FAIL — tables don't exist / not exported.

- [ ] **Step 4: Add the schema definitions**

In `src/db/schema.ts`, add near the other lifecycle/reference-adjacent tables:

```ts
export const employmentStatusEnum = pgEnum('employment_status', ['active', 'on_leave', 'terminated'])

export const staffMembers = pgTable('staff_members', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id),
  providerId: integer('provider_id').references(() => providers.id),
  name: text('name').notNull(),
  department: text('department').notNull(),
  title: text('title').notNull(),
  employmentStatus: employmentStatusEnum('employment_status').default('active').notNull(),
  hireDate: date('hire_date').notNull(),
  terminationDate: date('termination_date'),
})

export const staffCredentials = pgTable('staff_credentials', {
  id: serial('id').primaryKey(),
  staffMemberId: integer('staff_member_id').notNull().references(() => staffMembers.id),
  credentialType: text('credential_type').notNull(),
  credentialNumber: text('credential_number'),
  expiresOn: date('expires_on'),
})
```

- [ ] **Step 5: Run the test again — expect a different failure**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/staff-schema.test.ts`
Expected: FAIL — now a runtime DB error (relation does not exist), not an import error.

- [ ] **Step 6: Write and run the one-off migration script**

Scratch, not part of the repo. Create `migrate-staff-scratch.ts` at this worktree's root (`/Users/k2a/Desktop/clinsync/.worktrees/staff-hr`):

```ts
import { Pool } from 'pg'

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false } })

  await pool.query(`DO $$ BEGIN CREATE TYPE employment_status AS ENUM ('active', 'on_leave', 'terminated'); EXCEPTION WHEN duplicate_object THEN null; END $$;`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_members (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      provider_id INTEGER REFERENCES providers(id),
      name TEXT NOT NULL,
      department TEXT NOT NULL,
      title TEXT NOT NULL,
      employment_status employment_status NOT NULL DEFAULT 'active',
      hire_date DATE NOT NULL,
      termination_date DATE
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_credentials (
      id SERIAL PRIMARY KEY,
      staff_member_id INTEGER NOT NULL REFERENCES staff_members(id),
      credential_type TEXT NOT NULL,
      credential_number TEXT,
      expires_on DATE
    )
  `)

  console.log('Staff schema migration complete.')
  await pool.end()
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1) })
```

Run: `npx dotenv -e .env.local -- npx tsx migrate-staff-scratch.ts`. If blocked by the permission classifier: stop, report it, do not retry with variations.

Verify with a Node script (no `psql` here): `SELECT column_name FROM information_schema.columns WHERE table_name IN ('staff_members','staff_credentials')`.

Delete the scratch script once confirmed: `rm migrate-staff-scratch.ts`.

- [ ] **Step 7: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/staff-schema.test.ts`
Expected: PASS (both tests).

- [ ] **Step 8: Add idempotent seed data to `src/db/seed.ts`**

Read `seedMedications()` and `seedPayers()` in this file first for the exact check-before-insert-by-name convention, and read the full body of `seed()` (the function starting `export async function seed()`) to find exactly where the demo `users` rows and `seedProvidersAndAppointments()` are inserted, and where the "patients already seeded" top-up branch is — `seedStaff()` needs both `users` and `providers` rows to already exist (it links to them by name), so it must run *after* both, in both code paths.

Add near the medication seed data:

```ts
// Staff roster -- deliberately mixes three linkage shapes per spec §1: some
// staff are both a system user AND a clinical provider, some are only one,
// and some (front-desk/facilities roles) are neither. Matched by name
// against the demo `users` rows and `PROVIDER_ROSTER` providers already
// seeded above, rather than hardcoded ids, since insertion order can vary.
const STAFF_SEED: {
  name: string
  linkUserEmail: string | null
  linkProviderName: string | null
  department: string
  title: string
  employmentStatus: 'active' | 'on_leave' | 'terminated'
  hireDate: string
  terminationDate: string | null
}[] = [
  { name: 'Dr. Rajiv Kunam', linkUserEmail: 'rkunam.demo@example.com', linkProviderName: 'Dr. Rajiv Kunam', department: 'Clinical', title: 'Psychiatrist', employmentStatus: 'active', hireDate: '2021-03-01', terminationDate: null },
  { name: 'Dr. Elena Bosch', linkUserEmail: null, linkProviderName: 'Dr. Elena Bosch', department: 'Clinical', title: 'Psychiatrist', employmentStatus: 'active', hireDate: '2022-06-15', terminationDate: null },
  { name: 'Priya Sundaram', linkUserEmail: null, linkProviderName: 'Priya Sundaram', department: 'Clinical', title: 'Psychiatric Nurse Practitioner', employmentStatus: 'active', hireDate: '2023-01-10', terminationDate: null },
  { name: 'Jamie Ruiz', linkUserEmail: 'jruiz.demo@example.com', linkProviderName: null, department: 'Research', title: 'Clinical Research Coordinator', employmentStatus: 'active', hireDate: '2022-09-01', terminationDate: null },
  { name: 'Sam Patel', linkUserEmail: 'spatel.demo@example.com', linkProviderName: null, department: 'Administration', title: 'Practice Administrator', employmentStatus: 'active', hireDate: '2020-11-01', terminationDate: null },
  { name: 'Taylor Nguyen', linkUserEmail: 'tnguyen.demo@example.com', linkProviderName: null, department: 'Front Desk', title: 'Front Desk Coordinator', employmentStatus: 'active', hireDate: '2023-04-20', terminationDate: null },
  { name: 'Morgan Reyes', linkUserEmail: null, linkProviderName: null, department: 'Front Desk', title: 'Receptionist', employmentStatus: 'active', hireDate: '2024-02-01', terminationDate: null },
  { name: 'Casey Boone', linkUserEmail: null, linkProviderName: null, department: 'Facilities', title: 'Housekeeping', employmentStatus: 'on_leave', hireDate: '2021-08-15', terminationDate: null },
  { name: 'Riley Foster', linkUserEmail: null, linkProviderName: null, department: 'Administration', title: 'Billing Specialist', employmentStatus: 'terminated', hireDate: '2019-05-01', terminationDate: '2026-06-30' },
]

// Credential dates are computed relative to seed time, not hardcoded, so the
// 60-day warning window and the "already expired" state always have real
// demo data to show regardless of when this seed script actually runs.
function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

const STAFF_CREDENTIALS_SEED: { staffName: string; credentialType: string; credentialNumber: string | null; expiresOn: string | null }[] = [
  { staffName: 'Dr. Rajiv Kunam', credentialType: 'State Medical License', credentialNumber: 'CA-MD-48213', expiresOn: daysFromNow(400) },
  { staffName: 'Dr. Rajiv Kunam', credentialType: 'DEA Registration', credentialNumber: 'BK1234563', expiresOn: daysFromNow(30) }, // inside the 60-day warning window
  { staffName: 'Dr. Elena Bosch', credentialType: 'State Medical License', credentialNumber: 'CA-MD-51902', expiresOn: daysFromNow(-15) }, // already expired
  { staffName: 'Dr. Elena Bosch', credentialType: 'Board Certification', credentialNumber: 'ABPN-88213', expiresOn: daysFromNow(500) },
  { staffName: 'Priya Sundaram', credentialType: 'State NP License', credentialNumber: 'CA-NP-33012', expiresOn: daysFromNow(200) },
  { staffName: 'Priya Sundaram', credentialType: 'DEA Registration', credentialNumber: 'MS9988771', expiresOn: daysFromNow(55) }, // inside the 60-day warning window
]

async function seedStaff() {
  const db = getDb()
  const existingStaff = await db.select({ name: staffMembers.name }).from(staffMembers)
  const existingNames = new Set(existingStaff.map((s) => s.name))
  const toInsert = STAFF_SEED.filter((s) => !existingNames.has(s.name))
  if (toInsert.length === 0) return

  const allUsers = await db.select({ id: users.id, email: users.email }).from(users)
  const userByEmail = new Map(allUsers.map((u) => [u.email, u.id]))
  const allProviders = await db.select({ id: providers.id, name: providers.name }).from(providers)
  const providerByName = new Map(allProviders.map((p) => [p.name, p.id]))

  const inserted = await db.insert(staffMembers).values(toInsert.map((s) => ({
    name: s.name,
    userId: s.linkUserEmail ? (userByEmail.get(s.linkUserEmail) ?? null) : null,
    providerId: s.linkProviderName ? (providerByName.get(s.linkProviderName) ?? null) : null,
    department: s.department,
    title: s.title,
    employmentStatus: s.employmentStatus,
    hireDate: s.hireDate,
    terminationDate: s.terminationDate,
  }))).returning()

  const staffIdByName = new Map(inserted.map((s) => [s.name, s.id]))
  const credentialRows = STAFF_CREDENTIALS_SEED
    .filter((c) => staffIdByName.has(c.staffName))
    .map((c) => ({ staffMemberId: staffIdByName.get(c.staffName)!, credentialType: c.credentialType, credentialNumber: c.credentialNumber, expiresOn: c.expiresOn }))
  if (credentialRows.length > 0) await db.insert(staffCredentials).values(credentialRows)
}
```

Add `staffMembers, staffCredentials` to this file's schema import list.

Call `await seedStaff()`:
- Once inside the "patients already seeded" top-up branch, guarded by a `staffMembers` count check (same shape as this branch's existing `documentCount`/`chargeCount` top-ups) — since a shared dev DB seeded before this branch's schema existed won't have staff rows yet.
- Once in the fresh-seed path, after the demo `users` insert and after `seedProvidersAndAppointments()` both run (`seedStaff()`'s own per-name check-before-insert makes it safe to call unconditionally there too).

- [ ] **Step 9: Confirm seeding logic is idempotent by inspection**

Same discipline as the sibling Pharmacy and Lab-Orders plans: do NOT run `npm run db:seed` against the live shared dev database as part of this task. Read `seedStaff()` carefully to confirm the check-before-insert-by-name logic is correct instead.

- [ ] **Step 10: Commit**

```bash
git add src/db/schema.ts src/db/seed.ts tests/db/staff-schema.test.ts
git commit -m "feat: add staff members and staff credentials tables with seed data

"```

---

### Task 2: Query layer + API routes

**Files:**
- Create: `src/lib/queries/staff-members.ts`
- Create: `src/lib/queries/staff-credentials.ts`
- Create: `src/app/api/staff/route.ts` (GET — list, POST — create)
- Create: `src/app/api/staff/[id]/route.ts` (GET — detail with credentials)
- Create: `src/app/api/staff/[id]/credentials/route.ts` (POST — add credential)
- Test: `tests/lib/queries/staff-members.test.ts`, `tests/lib/queries/staff-credentials.test.ts`, `tests/api/staff-directory.test.ts`

**Interfaces:**
- Consumes: `staffMembers`, `staffCredentials` from `@/db/schema` (Task 1); `users`, `providers` from `@/db/schema` (existing).
- Produces: `listStaffMembers()`, `getStaffMemberDetail(id: number)`, `createStaffMember(input)` from `@/lib/queries/staff-members`; `addCredential(input)`, `listExpiringOrExpiredCredentials()` from `@/lib/queries/staff-credentials` — consumed by Tasks 3, 4.

- [ ] **Step 1: Write the failing tests — query layer**

Create `tests/lib/queries/staff-members.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { staffMembers, users, providers } from '@/db/schema'
import { listStaffMembers, getStaffMemberDetail, createStaffMember } from '@/lib/queries/staff-members'

const createdStaffIds: number[] = []
afterEach(async () => {
  while (createdStaffIds.length > 0) await getDb().delete(staffMembers).where(eq(staffMembers.id, createdStaffIds.pop()!))
})

describe('staff members queries', () => {
  it('creates a staff member with no userId/providerId, then lists and gets it', async () => {
    const result = await createStaffMember({ userId: null, providerId: null, name: 'Test Staff A', department: 'Front Desk', title: 'Receptionist', hireDate: '2024-01-01' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    createdStaffIds.push(result.staffMember.id)

    const all = await listStaffMembers()
    expect(all.some((s) => s.id === result.staffMember.id)).toBe(true)

    const detail = await getStaffMemberDetail(result.staffMember.id)
    expect(detail?.name).toBe('Test Staff A')
    expect(detail?.credentials).toEqual([])
  })

  it('creates a staff member linked to a real user and a real provider', async () => {
    const db = getDb()
    const [userRow] = await db.select().from(users).limit(1)
    const [providerRow] = await db.select().from(providers).limit(1)
    const result = await createStaffMember({ userId: userRow.id, providerId: providerRow.id, name: 'Test Staff B', department: 'Clinical', title: 'Psychiatrist', hireDate: '2024-01-01' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    createdStaffIds.push(result.staffMember.id)
    expect(result.staffMember.userId).toBe(userRow.id)
    expect(result.staffMember.providerId).toBe(providerRow.id)
  })

  it('rejects a userId that does not exist', async () => {
    const result = await createStaffMember({ userId: 999999, providerId: null, name: 'Test Staff C', department: 'Clinical', title: 'Nurse', hireDate: '2024-01-01' })
    expect(result.ok).toBe(false)
  })

  it('rejects a providerId that does not exist', async () => {
    const result = await createStaffMember({ userId: null, providerId: 999999, name: 'Test Staff D', department: 'Clinical', title: 'Nurse', hireDate: '2024-01-01' })
    expect(result.ok).toBe(false)
  })
})
```

Create `tests/lib/queries/staff-credentials.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { staffMembers, staffCredentials } from '@/db/schema'
import { addCredential, listExpiringOrExpiredCredentials } from '@/lib/queries/staff-credentials'

const createdStaffIds: number[] = []
afterEach(async () => {
  while (createdStaffIds.length > 0) {
    const id = createdStaffIds.pop()!
    await getDb().delete(staffCredentials).where(eq(staffCredentials.staffMemberId, id))
    await getDb().delete(staffMembers).where(eq(staffMembers.id, id))
  }
})

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

async function makeStaff(name: string) {
  const [s] = await getDb().insert(staffMembers).values({ name, department: 'Clinical', title: 'Test', hireDate: '2024-01-01' }).returning()
  createdStaffIds.push(s.id)
  return s
}

describe('staff credentials queries', () => {
  it('adds a credential to a staff member', async () => {
    const staff = await makeStaff('Boundary Test Staff 1')
    const result = await addCredential({ staffMemberId: staff.id, credentialType: 'DEA Registration', credentialNumber: 'X123', expiresOn: daysFromNow(100) })
    expect(result.ok).toBe(true)
  })

  it('a credential expiring in exactly 60 days appears in the expiring-soon list, one expiring in 61 days does not', async () => {
    const staffAt60 = await makeStaff('Boundary Test Staff 60')
    const staffAt61 = await makeStaff('Boundary Test Staff 61')
    await addCredential({ staffMemberId: staffAt60.id, credentialType: 'State License', credentialNumber: null, expiresOn: daysFromNow(60) })
    await addCredential({ staffMemberId: staffAt61.id, credentialType: 'State License', credentialNumber: null, expiresOn: daysFromNow(61) })

    const results = await listExpiringOrExpiredCredentials()
    expect(results.some((r) => r.staffMemberId === staffAt60.id)).toBe(true)
    expect(results.some((r) => r.staffMemberId === staffAt61.id)).toBe(false)
  })

  it('an already-expired credential gets its own status, distinct from expiring-soon', async () => {
    const expiredStaff = await makeStaff('Boundary Test Staff Expired')
    const soonStaff = await makeStaff('Boundary Test Staff Soon')
    await addCredential({ staffMemberId: expiredStaff.id, credentialType: 'DEA Registration', credentialNumber: null, expiresOn: daysFromNow(-5) })
    await addCredential({ staffMemberId: soonStaff.id, credentialType: 'DEA Registration', credentialNumber: null, expiresOn: daysFromNow(10) })

    const results = await listExpiringOrExpiredCredentials()
    const expiredRow = results.find((r) => r.staffMemberId === expiredStaff.id)
    const soonRow = results.find((r) => r.staffMemberId === soonStaff.id)
    expect(expiredRow?.status).toBe('expired')
    expect(soonRow?.status).toBe('expiring_soon')
  })
})
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/staff-members.test.ts tests/lib/queries/staff-credentials.test.ts`
Expected: FAIL — modules don't exist.

- [ ] **Step 3: Implement `src/lib/queries/staff-members.ts`**

```ts
import { getDb } from '@/db/client'
import { staffMembers, staffCredentials, users, providers } from '@/db/schema'
import { asc, eq } from 'drizzle-orm'

export interface CreateStaffMemberInput {
  userId: number | null
  providerId: number | null
  name: string
  department: string
  title: string
  employmentStatus?: 'active' | 'on_leave' | 'terminated'
  hireDate: string
  terminationDate?: string | null
}

export type CreateStaffMemberResult =
  | { ok: true; staffMember: typeof staffMembers.$inferSelect }
  | { ok: false; error: string }

export async function listStaffMembers() {
  return getDb().select().from(staffMembers).orderBy(asc(staffMembers.name))
}

export async function getStaffMemberDetail(id: number) {
  const [staffMember] = await getDb().select().from(staffMembers).where(eq(staffMembers.id, id))
  if (!staffMember) return null
  const credentials = await getDb().select().from(staffCredentials).where(eq(staffCredentials.staffMemberId, id))
  return { ...staffMember, credentials }
}

// Verifies userId/providerId reference real rows before insert (Review
// Focus #1) -- a dangling FK here would otherwise either throw an unhandled
// Postgres constraint error, or (if the columns were made nullable-without-
// checking) silently store a reference to nothing.
export async function createStaffMember(input: CreateStaffMemberInput): Promise<CreateStaffMemberResult> {
  const db = getDb()
  if (input.userId !== null) {
    const [userRow] = await db.select({ id: users.id }).from(users).where(eq(users.id, input.userId))
    if (!userRow) return { ok: false, error: 'userId does not reference an existing user' }
  }
  if (input.providerId !== null) {
    const [providerRow] = await db.select({ id: providers.id }).from(providers).where(eq(providers.id, input.providerId))
    if (!providerRow) return { ok: false, error: 'providerId does not reference an existing provider' }
  }

  const [staffMember] = await db.insert(staffMembers).values({
    userId: input.userId,
    providerId: input.providerId,
    name: input.name,
    department: input.department,
    title: input.title,
    employmentStatus: input.employmentStatus ?? 'active',
    hireDate: input.hireDate,
    terminationDate: input.terminationDate ?? null,
  }).returning()

  return { ok: true, staffMember }
}
```

- [ ] **Step 4: Implement `src/lib/queries/staff-credentials.ts`**

```ts
import { getDb } from '@/db/client'
import { staffCredentials, staffMembers } from '@/db/schema'
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm'

export interface AddCredentialInput {
  staffMemberId: number
  credentialType: string
  credentialNumber?: string | null
  expiresOn?: string | null
}

export type AddCredentialResult =
  | { ok: true; credential: typeof staffCredentials.$inferSelect }
  | { ok: false; error: string }

export async function addCredential(input: AddCredentialInput): Promise<AddCredentialResult> {
  const db = getDb()
  const [staffMember] = await db.select({ id: staffMembers.id }).from(staffMembers).where(eq(staffMembers.id, input.staffMemberId))
  if (!staffMember) return { ok: false, error: 'staffMemberId does not reference an existing staff member' }

  const [credential] = await db.insert(staffCredentials).values({
    staffMemberId: input.staffMemberId,
    credentialType: input.credentialType,
    credentialNumber: input.credentialNumber ?? null,
    expiresOn: input.expiresOn ?? null,
  }).returning()

  return { ok: true, credential }
}

export interface ExpiringCredential {
  id: number
  staffMemberId: number
  staffMemberName: string
  credentialType: string
  expiresOn: string
  daysUntilExpiry: number // negative once expired
  status: 'expiring_soon' | 'expired'
}

// "Expiring soon" / "expired" per spec §3: expiresOn non-null and no more
// than 60 days out is expiring_soon; expiresOn in the past is expired; both
// come back together, soonest first. The 60-day cutoff is computed once in
// JS (not a DB-side `+ INTERVAL`), matching this codebase's existing
// plain-date-math convention (see src/lib/queries/ar-dashboard.ts), so the
// exact 60-vs-61-day boundary in Review Focus #2 is unambiguous: a credential
// expiring exactly `cutoff` days out is included, `cutoff + 1` is not.
export async function listExpiringOrExpiredCredentials(): Promise<ExpiringCredential[]> {
  const db = getDb()
  const todayStr = new Date().toISOString().slice(0, 10)
  const cutoffStr = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  const rows = await db
    .select({
      id: staffCredentials.id,
      staffMemberId: staffCredentials.staffMemberId,
      staffMemberName: staffMembers.name,
      credentialType: staffCredentials.credentialType,
      expiresOn: staffCredentials.expiresOn,
    })
    .from(staffCredentials)
    .innerJoin(staffMembers, eq(staffMembers.id, staffCredentials.staffMemberId))
    .where(and(isNotNull(staffCredentials.expiresOn), sql`${staffCredentials.expiresOn} <= ${cutoffStr}`))
    .orderBy(asc(staffCredentials.expiresOn))

  return rows.map((r) => {
    const expiresOn = r.expiresOn as string
    const daysUntilExpiry = Math.round((Date.parse(expiresOn) - Date.parse(todayStr)) / (24 * 60 * 60 * 1000))
    return { ...r, expiresOn, daysUntilExpiry, status: expiresOn < todayStr ? 'expired' as const : 'expiring_soon' as const }
  })
}
```

- [ ] **Step 5: Run the query-layer tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/staff-members.test.ts tests/lib/queries/staff-credentials.test.ts`
Expected: PASS (7 tests total).

- [ ] **Step 6: Write the failing test — API routes and role gating**

Create `tests/api/staff-directory.test.ts` covering (using the `vi.mock('@/lib/auth', ...)` pattern already established in `tests/api/pharmacy-dispense.test.ts`):
- `GET /api/staff` succeeds (200) for each of `admin`, `pi`, `crc`, `frontdesk`.
- `POST /api/staff` succeeds (201) as `admin`, and creating with no `userId`/`providerId` in the body succeeds (Review Focus #4).
- `POST /api/staff` returns 403 for `pi`, `crc`, and `frontdesk` (Review Focus #5).
- `POST /api/staff` with a `userId` that doesn't exist returns 400 (Review Focus #1).
- `GET /api/staff/[id]` returns the created staff member's detail including an empty `credentials` array, and 404 for a nonexistent id.
- `POST /api/staff/[id]/credentials` succeeds (201) as `admin` and returns 403 for `pi`/`crc`/`frontdesk`.

- [ ] **Step 7: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/staff-directory.test.ts`
Expected: FAIL — routes don't exist.

- [ ] **Step 8: Implement `src/app/api/staff/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listStaffMembers, createStaffMember } from '@/lib/queries/staff-members'

const READ_ROLES = ['admin', 'pi', 'crc', 'frontdesk']

const createStaffSchema = z.object({
  userId: z.number().int().nullable().optional(),
  providerId: z.number().int().nullable().optional(),
  name: z.string().trim().min(1),
  department: z.string().trim().min(1),
  title: z.string().trim().min(1),
  employmentStatus: z.enum(['active', 'on_leave', 'terminated']).optional(),
  hireDate: z.string().min(1),
  terminationDate: z.string().nullable().optional(),
}).strict()

export async function GET() {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!READ_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  await logAudit(session, 'viewed staff directory', null)
  return NextResponse.json(await listStaffMembers())
}

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })

  const parsed = createStaffSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 400 })

  const result = await createStaffMember({
    userId: parsed.data.userId ?? null,
    providerId: parsed.data.providerId ?? null,
    name: parsed.data.name,
    department: parsed.data.department,
    title: parsed.data.title,
    employmentStatus: parsed.data.employmentStatus,
    hireDate: parsed.data.hireDate,
    terminationDate: parsed.data.terminationDate ?? null,
  })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })

  await logAudit(session, 'added a staff member', null)
  return NextResponse.json(result.staffMember, { status: 201 })
}
```

- [ ] **Step 9: Implement `src/app/api/staff/[id]/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getStaffMemberDetail } from '@/lib/queries/staff-members'

const READ_ROLES = ['admin', 'pi', 'crc', 'frontdesk']

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!READ_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const staffId = Number(id)
  if (!Number.isInteger(staffId)) return NextResponse.json({ error: 'Invalid staff id' }, { status: 400 })

  const detail = await getStaffMemberDetail(staffId)
  if (!detail) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await logAudit(session, 'viewed staff member detail', null)
  return NextResponse.json(detail)
}
```

- [ ] **Step 10: Implement `src/app/api/staff/[id]/credentials/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { addCredential } from '@/lib/queries/staff-credentials'

const addCredentialSchema = z.object({
  credentialType: z.string().trim().min(1),
  credentialNumber: z.string().trim().min(1).nullable().optional(),
  expiresOn: z.string().nullable().optional(),
}).strict()

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })

  const { id } = await params
  const staffId = Number(id)
  if (!Number.isInteger(staffId)) return NextResponse.json({ error: 'Invalid staff id' }, { status: 400 })

  const parsed = addCredentialSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 400 })

  const result = await addCredential({
    staffMemberId: staffId,
    credentialType: parsed.data.credentialType,
    credentialNumber: parsed.data.credentialNumber ?? null,
    expiresOn: parsed.data.expiresOn ?? null,
  })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 404 })

  await logAudit(session, 'added a staff credential', null)
  return NextResponse.json(result.credential, { status: 201 })
}
```

- [ ] **Step 11: Run all this task's tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/staff-members.test.ts tests/lib/queries/staff-credentials.test.ts tests/api/staff-directory.test.ts`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add src/lib/queries/staff-members.ts src/lib/queries/staff-credentials.ts src/app/api/staff tests/lib/queries/staff-members.test.ts tests/lib/queries/staff-credentials.test.ts tests/api/staff-directory.test.ts
git commit -m "feat: add staff directory query layer and admin-write CRUD routes

"```

---

### Task 3: Staff Directory UI

**Files:**
- Create: `src/components/StaffDirectoryList.tsx`
- Create: `src/components/StaffMemberDetail.tsx`
- Create: `src/components/AddStaffMemberModal.tsx`
- Create: `src/components/AddCredentialModal.tsx`
- Create: `src/app/(dashboard)/staff/page.tsx`
- Create: `src/app/(dashboard)/staff/[id]/page.tsx`
- Modify: `src/components/LeftNav.tsx` (add a nav entry)
- Modify: `src/lib/role-capabilities.ts` (update role summaries — read/write descriptions for each role)
- Test: none new (UI wiring over already-tested routes) — verify per this plan's UI verification discipline.

**Interfaces:**
- Consumes: `listStaffMembers()`, `getStaffMemberDetail(id)` (Task 2, called directly from Server Components); `listExpiringOrExpiredCredentials()` (Task 2, for the per-row soonest-expiring indicator); `POST /api/staff`, `POST /api/staff/[id]/credentials` (Task 2, called by URL from client components).

- [ ] **Step 1: Read the existing nav/role-capability pattern and an existing status-pill component**

Read `src/components/LeftNav.tsx` and `src/lib/role-capabilities.ts` in full — `/pharmacy` in `LeftNav.tsx`'s `ITEMS` array has no `roles` restriction (visible to all four roles), which matches this feature's read access (spec §6: admin, pi, crc, frontdesk); `/staff` should be added the same way. Also read one existing status-pill implementation elsewhere in this codebase (e.g. the room-status pill on the Beds board, or the appointment-status badge on the Home dashboard) to match this codebase's "never color alone" convention — icon or text label alongside color, not color alone — before building the employment-status and credential-expiry pills below.

- [ ] **Step 2: Build the list page and directory list component**

Create `src/app/(dashboard)/staff/page.tsx` as a Server Component: `requireSessionOrRedirect()` first, fetch `listStaffMembers()` and `listExpiringOrExpiredCredentials()` directly (Server Components call the query layer directly, never their own API routes — this codebase's own established rule), pass to `<StaffDirectoryList staffMembers={...} expiringCredentials={...} canWrite={session.role === 'admin'} />`.

Create `src/components/StaffDirectoryList.tsx` (`'use client'`): a table/list of staff members — name, department, title, an employment-status pill (`active`/`on_leave`/`terminated`, icon or text label alongside color), and a soonest-expiring-credential indicator per row (look up that staff member's earliest entry in `expiringCredentials` by `staffMemberId`; if none, show nothing). Each row links to `/staff/[id]`. An "Add staff member" button (rendered only when `canWrite`) opens `AddStaffMemberModal`.

- [ ] **Step 3: Build the detail page and detail component**

Create `src/app/(dashboard)/staff/[id]/page.tsx` as a Server Component: `requireSessionOrRedirect()` first, `params` gives the staff id, fetch `getStaffMemberDetail(id)` directly; if null, render a not-found state (match this codebase's existing not-found pattern, e.g. `patients/[anonId]/page.tsx`). Pass to `<StaffMemberDetail staffMember={...} canWrite={session.role === 'admin'} />`.

Create `src/components/StaffMemberDetail.tsx` (`'use client'`): full employment info (name, department, title, employment status pill, hire date, termination date if set, linked user/provider if either is set — otherwise omit those rows rather than showing "None"), and every credential row (credential type, number, expiry date with an "expiring soon"/"expired" pill distinct from a normal/current credential — three visually distinct states total, never color alone). An "Add credential" button (rendered only when `canWrite`) opens `AddCredentialModal` scoped to this staff member.

- [ ] **Step 4: Build the two write modals**

Create `src/components/AddStaffMemberModal.tsx` (`'use client'`), following the Dialog-modal-with-fetch pattern already established by this codebase's other action modals (e.g. `DispenseMedicationModal.tsx` or `TransferAdmissionModal.tsx` — read one for the exact shape): name, department, title, employment status `<select>` (default `active`), hire date, and optional user/provider linkage — since this app doesn't have an existing autocomplete component, use simple `<select>`s populated from a small props-passed list of users/providers (fetched by the page, passed down), each with an explicit "None" option. `POST /api/staff` on submit, `router.refresh()` on success, inline error display (surface the 400 "does not reference an existing" error text directly, matching this codebase's existing inline-error convention).

Create `src/components/AddCredentialModal.tsx` (`'use client'`): credential type (free text, matching spec §2's explicit choice not to enumerate it), credential number (optional), expiry date (optional). `POST /api/staff/[id]/credentials` on submit, `router.refresh()` on success, inline error display. Accepts `staffMemberId` as a prop.

- [ ] **Step 5: Add the nav entry and update role capabilities**

In `src/components/LeftNav.tsx`'s `ITEMS` array, add `{ href: '/staff', label: 'Staff', icon: <pick an unused lucide-react icon, e.g. `IdCard` or `UserSquare`>  }` with no `roles` restriction (matching `/pharmacy`).

In `src/lib/role-capabilities.ts`, add one bullet to each of the four roles' `bullets` arrays: for `admin`, "Add and edit staff members and credentials in the Staff Directory"; for `crc`, `pi`, and `frontdesk`, "View the Staff Directory and credential expiry status" (read-only, matching each role's existing read-only bullets for similarly-scoped features).

- [ ] **Step 6: Verify via a real running dev server, not narration**

Real login, real GET of `/staff`, confirm the list renders with employment-status pills and the soonest-expiring-credential indicator on the two seeded staff rows that have one. Real click into a staff detail page, confirm every seeded credential row renders with the correct expiring/expired distinction. Real "Add staff member" as admin with neither user nor provider linked, confirm it succeeds and appears in the list. Real "Add credential" on that new staff member. Paste actual commands and actual output.

- [ ] **Step 7: Commit**

```bash
git add src/components/StaffDirectoryList.tsx src/components/StaffMemberDetail.tsx src/components/AddStaffMemberModal.tsx src/components/AddCredentialModal.tsx "src/app/(dashboard)/staff" src/components/LeftNav.tsx src/lib/role-capabilities.ts
git commit -m "feat: add Staff Directory screen with add staff/credential workflows

"```

---

### Task 4: Admin dashboard credential-expiry summary

**Files:**
- Modify: `src/app/(dashboard)/page.tsx`
- Modify: `src/components/dashboards/AdminDashboard.tsx`
- Test: none new — verify per this plan's UI verification discipline.

**Interfaces:**
- Consumes: `listExpiringOrExpiredCredentials()` (Task 2).

- [ ] **Step 1: Read the current state of the admin dashboard**

This codebase's admin-facing summary landing page is `src/app/(dashboard)/page.tsx` (the `DashboardHomePage` Server Component), which renders `AdminDashboard` (`src/components/dashboards/AdminDashboard.tsx`) specifically for `session.role === 'admin'` — this is "the admin dashboard" spec §4 refers to; `CoordinatorDashboard` and `FrontDeskDashboard` are the other roles' landing pages and are out of scope for this task. Read both files' current full state before editing (already read during planning; re-read for any drift).

- [ ] **Step 2: Fetch and pass the expiring-credentials list**

In `src/app/(dashboard)/page.tsx`, add `listExpiringOrExpiredCredentials()` to the `Promise.all([...])` block that already fetches `data`, `templates`, `patients`, `appointmentsInRange`, `allStaff` for the admin/coordinator branch, and pass the result as a new `expiringCredentials` prop into `<AdminDashboard {...props} />` (only `AdminDashboard` needs it — `CoordinatorDashboard` is unaffected; do not add this fetch to the `frontdesk` early-return branch above it).

In `src/components/dashboards/AdminDashboard.tsx`, import the `ExpiringCredential` type from `@/lib/queries/staff-credentials` and add `expiringCredentials: ExpiringCredential[]` to the `DashboardPageProps` interface.

- [ ] **Step 3: Render the summary section**

Add a new `<section className={CARD_SURFACE + ' p-5'}>` (matching this file's existing section styling, e.g. the "Latest Account Events" section) titled "Credential Expiry", placed in the existing two-column grid alongside "Latest Forms Received" etc. List each entry: staff member name, credential type, and days until/since expiry (e.g. "expires in 12 days" / "expired 5 days ago", derived from `daysUntilExpiry`), sorted soonest-first (the query already returns them in that order) — an expired entry gets a distinct icon/label from an expiring-soon one (never color alone, same convention as Task 3). Reuse `EmptyRow` for the empty state ("No credentials expiring soon.").

- [ ] **Step 4: Verify via a real running dev server, not narration**

Real login as `admin`, real GET of `/`, confirm the Credential Expiry section lists the seeded expiring/expired credentials from Task 1's seed data, sorted soonest-first, with the expired one visually distinct. Paste actual commands and actual output.

- [ ] **Step 5: Run the full suite once**

Run: `npx dotenv -e .env.local -- npx vitest run`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(dashboard)/page.tsx" src/components/dashboards/AdminDashboard.tsx
git commit -m "feat: add credential-expiry summary to the admin dashboard

"```
