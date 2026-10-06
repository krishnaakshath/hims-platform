# Inpatient Management (ADT) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the loop from "reception checks an inpatient in" to "that patient is discharged," with a live bed/ward status board, real transfers, and a structured discharge workflow — the piece of Clinsync's HIMS buildout the user asked for by name: "everything must be monitored until discharge."

**Architecture:** A new `admissions` table is the single source of truth for "this patient is currently an inpatient," created automatically by Front Desk's existing check-in route (one front door, no parallel entry point). The existing `rooms` table (from the Front Desk plan) widens from a 2-value status enum to 4 (`available`/`occupied`/`dirty`/`blocked`); transfers and discharges are the only things that move a room between them. A new `admissionTransfers` table is the append-only history of every room an admission has ever occupied, including its first-ever room assignment (a transfer with `fromRoomId: null`).

**Tech Stack:** Next.js 16 App Router (Server Components) + Drizzle ORM over the shared Neon Postgres DB (additive-only schema changes via a hand-written one-off script, never `drizzle-kit push`) + `@base-ui/react` Dialog primitive + Tailwind v4 oklch tokens.

**Spec:** `docs/superpowers/specs/2026-09-26-inpatient-adt.md`

## Global Constraints

- Additive-only schema changes. Apply the Task 1 migration via a hand-written one-off script run with `npx dotenv -e .env.local -- npx tsx <script>` — never `drizzle-kit push`. This is a **single shared Neon Postgres database across every branch/worktree** — a schema mistake here is visible everywhere immediately.
- Every write route uses `.strict()` Zod validation (rejects unknown fields).
- Every state-changing route calls `logAudit(session, <action>, <patientId or null>)`.
- Every protected route/page starts with `requireSession()` (API routes) or `requireSessionOrRedirect()` (pages) as its first statement.
- This sandbox has an intermittent/sometimes-sustained Neon HTTP-driver connectivity issue (the DB itself is always healthy — confirmed via `psql "$DATABASE_URL"` on TCP port 5432; only the `@neondatabase/serverless` HTTP fetch path on port 443 sometimes fails with `ETIMEDOUT`/`EHOSTUNREACH`). If a DB-touching vitest run fails this way: retry 2-3 times, then fall back to verifying the same logic via `psql -f <script>` (wrap read-only checks in `BEGIN...ROLLBACK`; use a real insert/delete only if genuinely needed, and clean it up). Document in every task report which path was used and why.
- No AI/Claude attribution trailer on any commit — this whole session's standing instruction from the user. Every commit message in this plan omits it regardless of any other instruction shown to an implementer.
- Vitest invocation: `npx dotenv -e .env.local -- npx vitest run <path>` (`fileParallelism: false`).
- Race-safe room mutations use the same conditional-UPDATE pattern as Front Desk's `assignRoomToPatient` (`src/lib/queries/rooms.ts`): the `WHERE` clause re-checks the expected current status at write time, and a `result.length === 0` return means "someone else already changed it" — surfaced to the caller as 409, never silently retried or overwritten.
- No multi-statement DB transactions — the neon-http driver doesn't support them (same accepted limitation as the Front Desk plan). Multi-step room/admission mutations run as sequential single statements in an order chosen so a failure partway through leaves the system in a safe, if incomplete, state (documented per task below).

## Review Focus

1. **Discharging or transferring an admission that isn't the caller's own attending assignment** — a PI must only act on admissions where they are `attendingProviderId`, not any admission by id (mirrors the exact ownership-boundary bug the Front Desk final review caught on `doctorAssignments`). (Tasks 4, 5)
2. **Double-discharge** — calling discharge twice on the same admission (already `status = 'discharged'`) must be rejected, not silently re-run (which would double-free a room already freed, or double-create a follow-up appointment). (Task 5)
3. **Race on the destination room during a transfer or discharge-with-transfer** — two concurrent requests targeting the same `available` room must not both succeed. (Tasks 4, 5)
4. **An incomplete "5 D's" discharge form** — the API must reject a discharge missing any of the five required fields, not silently accept a blank clinical summary. (Task 5)
5. **Double-admitting a patient already actively admitted** — re-checking in a patient who already has an active (`status = 'admitted'`) admission must not create a second one; the existing admission is what's still current. (Task 2)

---

### Task 1: Schema — widen room status, add `admissions` and `admission_transfers`

**Files:**
- Modify: `src/db/schema.ts:415-424` (widen `roomStatusEnum`, add `blockedReason` to `rooms`), and insert two new tables after `doctorAssignments` (currently ending at `src/db/schema.ts:443`)
- Test: `tests/db/inpatient-schema.test.ts`

**Interfaces:**
- Produces: `roomStatusEnum` now includes `'dirty'`/`'blocked'`; `rooms.blockedReason: string | null`; `admissionTypeEnum` (`'elective'|'emergency'|'transfer_in'`); `admissionStatusEnum` (`'admitted'|'discharged'`); `admissions` table with columns `id, patientId, currentRoomId, attendingProviderId, admissionType, status, admittedAt, dischargedAt, dischargeDiagnosis, dischargeDrugs, dischargeDevices, dischargeDiet, dischargeSummaryNotes, followUpAppointmentId, createdFromAssignmentId`; `admissionTransfers` table with columns `id, admissionId, fromRoomId, toRoomId, reason, transferredByName, transferredAt`. All consumed by Task 2 onward.

- [ ] **Step 1: Write the failing test**

Create `tests/db/inpatient-schema.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { rooms, providers, patients, admissions, admissionTransfers } from '@/db/schema'

const createdRoomIds: number[] = []
const createdAdmissionIds: number[] = []
const createdTransferIds: number[] = []

afterEach(async () => {
  while (createdTransferIds.length > 0) await getDb().delete(admissionTransfers).where(eq(admissionTransfers.id, createdTransferIds.pop()!))
  while (createdAdmissionIds.length > 0) await getDb().delete(admissions).where(eq(admissions.id, createdAdmissionIds.pop()!))
  while (createdRoomIds.length > 0) await getDb().delete(rooms).where(eq(rooms.id, createdRoomIds.pop()!))
})

describe('inpatient ADT schema', () => {
  it('supports the widened room_status values, blockedReason, and the admissions/admission_transfers tables', async () => {
    const db = getDb()
    const [room1] = await db.insert(rooms).values({ ward: 'Test Ward', roomNumber: 'T1', bedNumber: 'A' }).returning()
    createdRoomIds.push(room1.id)
    const [room2] = await db.insert(rooms).values({ ward: 'Test Ward', roomNumber: 'T2', bedNumber: 'A', status: 'dirty' }).returning()
    createdRoomIds.push(room2.id)
    expect(room2.status).toBe('dirty')

    const [room3] = await db.insert(rooms).values({ ward: 'Test Ward', roomNumber: 'T3', bedNumber: 'A', status: 'blocked', blockedReason: 'Under maintenance' }).returning()
    createdRoomIds.push(room3.id)
    expect(room3.status).toBe('blocked')
    expect(room3.blockedReason).toBe('Under maintenance')

    const [providerRow] = await db.select().from(providers).limit(1)
    const [patientRow] = await db.select().from(patients).limit(1)

    const [admission] = await db.insert(admissions).values({
      patientId: patientRow.id,
      currentRoomId: room1.id,
      attendingProviderId: providerRow.id,
      admissionType: 'emergency',
    }).returning()
    createdAdmissionIds.push(admission.id)
    expect(admission.status).toBe('admitted')
    expect(admission.admissionType).toBe('emergency')
    expect(admission.dischargedAt).toBeNull()
    expect(admission.dischargeDiagnosis).toBeNull()

    const [transfer] = await db.insert(admissionTransfers).values({
      admissionId: admission.id,
      fromRoomId: room1.id,
      toRoomId: room2.id,
      reason: 'Test transfer',
      transferredByName: 'Test Nurse',
    }).returning()
    createdTransferIds.push(transfer.id)
    expect(transfer.fromRoomId).toBe(room1.id)
    expect(transfer.toRoomId).toBe(room2.id)
  })

  it('allows a null fromRoomId on a transfer (first-ever room assignment for a boarding admission)', async () => {
    const db = getDb()
    const [room] = await db.insert(rooms).values({ ward: 'Test Ward', roomNumber: 'T4', bedNumber: 'A' }).returning()
    createdRoomIds.push(room.id)
    const [providerRow] = await db.select().from(providers).limit(1)
    const [patientRow] = await db.select().from(patients).limit(1)
    const [admission] = await db.insert(admissions).values({ patientId: patientRow.id, currentRoomId: null, attendingProviderId: providerRow.id }).returning()
    createdAdmissionIds.push(admission.id)
    expect(admission.currentRoomId).toBeNull()

    const [transfer] = await db.insert(admissionTransfers).values({ admissionId: admission.id, fromRoomId: null, toRoomId: room.id, reason: 'First room assignment', transferredByName: 'Test Nurse' }).returning()
    createdTransferIds.push(transfer.id)
    expect(transfer.fromRoomId).toBeNull()
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/inpatient-schema.test.ts`
Expected: FAIL — `admissions`/`admissionTransfers` are not exported from `@/db/schema` yet (import error), and `blockedReason` doesn't exist on `rooms`.

- [ ] **Step 3: Add the schema definitions**

In `src/db/schema.ts`, change line 415 from:

```ts
export const roomStatusEnum = pgEnum('room_status', ['available', 'occupied'])
```

to:

```ts
export const roomStatusEnum = pgEnum('room_status', ['available', 'occupied', 'dirty', 'blocked'])
```

And add `blockedReason` to the `rooms` table (currently lines 417-424), after `status`:

```ts
export const rooms = pgTable('rooms', {
  id: serial('id').primaryKey(),
  ward: text('ward').notNull(),
  roomNumber: text('room_number').notNull(),
  bedNumber: text('bed_number').notNull(),
  status: roomStatusEnum('status').default('available').notNull(),
  blockedReason: text('blocked_reason'),
  occupiedByPatientId: text('occupied_by_patient_id').references(() => patients.id),
})
```

Then, immediately after the `doctorAssignments` table closes (currently ending at line 443, right before `export const eligibilityStatusEnum = ...`), insert:

```ts
export const admissionTypeEnum = pgEnum('admission_type', ['elective', 'emergency', 'transfer_in'])
export const admissionStatusEnum = pgEnum('admission_status', ['admitted', 'discharged'])

export const admissions = pgTable('admissions', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  currentRoomId: integer('current_room_id').references(() => rooms.id),
  attendingProviderId: integer('attending_provider_id').notNull().references(() => providers.id),
  admissionType: admissionTypeEnum('admission_type').default('elective').notNull(),
  status: admissionStatusEnum('status').default('admitted').notNull(),
  admittedAt: timestamp('admitted_at').defaultNow().notNull(),
  dischargedAt: timestamp('discharged_at'),
  dischargeDiagnosis: text('discharge_diagnosis'),
  dischargeDrugs: text('discharge_drugs'),
  dischargeDevices: text('discharge_devices'),
  dischargeDiet: text('discharge_diet'),
  dischargeSummaryNotes: text('discharge_summary_notes'),
  followUpAppointmentId: integer('follow_up_appointment_id').references(() => appointments.id),
  createdFromAssignmentId: integer('created_from_assignment_id').references(() => doctorAssignments.id),
})

export const admissionTransfers = pgTable('admission_transfers', {
  id: serial('id').primaryKey(),
  admissionId: integer('admission_id').notNull().references(() => admissions.id),
  fromRoomId: integer('from_room_id').references(() => rooms.id),
  toRoomId: integer('to_room_id').notNull().references(() => rooms.id),
  reason: text('reason').notNull(),
  transferredByName: text('transferred_by_name').notNull(),
  transferredAt: timestamp('transferred_at').defaultNow().notNull(),
})
```

- [ ] **Step 4: Run the test again — expect a different failure**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/inpatient-schema.test.ts`
Expected: FAIL — now a runtime DB error (`relation "admissions" does not exist` or `column "blocked_reason" does not exist`), not an import error. This confirms the TypeScript side is correct and only the live database is missing the migration.

- [ ] **Step 5: Write and run the one-off migration script**

This script is **scratch, not part of the repo** — create it, run it once against the live shared database, then delete it. Do not `git add` it.

Create `migrate-inpatient-adt-scratch.ts` at the repo root:

```ts
import { neon } from '@neondatabase/serverless'

async function main() {
  const sql = neon(process.env.DATABASE_URL!)

  await sql`ALTER TYPE room_status ADD VALUE IF NOT EXISTS 'dirty'`
  await sql`ALTER TYPE room_status ADD VALUE IF NOT EXISTS 'blocked'`
  await sql`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS blocked_reason TEXT`

  await sql`
    DO $$ BEGIN
      CREATE TYPE admission_type AS ENUM ('elective', 'emergency', 'transfer_in');
    EXCEPTION WHEN duplicate_object THEN null; END $$;
  `
  await sql`
    DO $$ BEGIN
      CREATE TYPE admission_status AS ENUM ('admitted', 'discharged');
    EXCEPTION WHEN duplicate_object THEN null; END $$;
  `

  await sql`
    CREATE TABLE IF NOT EXISTS admissions (
      id SERIAL PRIMARY KEY,
      patient_id TEXT NOT NULL REFERENCES patients(id),
      current_room_id INTEGER REFERENCES rooms(id),
      attending_provider_id INTEGER NOT NULL REFERENCES providers(id),
      admission_type admission_type NOT NULL DEFAULT 'elective',
      status admission_status NOT NULL DEFAULT 'admitted',
      admitted_at TIMESTAMP NOT NULL DEFAULT now(),
      discharged_at TIMESTAMP,
      discharge_diagnosis TEXT,
      discharge_drugs TEXT,
      discharge_devices TEXT,
      discharge_diet TEXT,
      discharge_summary_notes TEXT,
      follow_up_appointment_id INTEGER REFERENCES appointments(id),
      created_from_assignment_id INTEGER REFERENCES doctor_assignments(id)
    )
  `

  await sql`
    CREATE TABLE IF NOT EXISTS admission_transfers (
      id SERIAL PRIMARY KEY,
      admission_id INTEGER NOT NULL REFERENCES admissions(id),
      from_room_id INTEGER REFERENCES rooms(id),
      to_room_id INTEGER NOT NULL REFERENCES rooms(id),
      reason TEXT NOT NULL,
      transferred_by_name TEXT NOT NULL,
      transferred_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `

  console.log('Inpatient ADT migration complete.')
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1) })
```

Run: `npx dotenv -e .env.local -- npx tsx migrate-inpatient-adt-scratch.ts`

If the Neon HTTP driver is down for this run: fall back to `psql "$DATABASE_URL" -f <the same SQL statements written to a .sql file>` — every statement above is plain SQL and works identically over `psql`. Verify success either way with `psql "$DATABASE_URL" -c "\d admissions"` and `-c "\d admission_transfers"` and `-c "SELECT enum_range(NULL::room_status)"`.

Once confirmed applied, delete the scratch script: `rm migrate-inpatient-adt-scratch.ts`.

- [ ] **Step 6: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/inpatient-schema.test.ts`
Expected: PASS (both tests). If vitest can't reach the DB over HTTP, verify the same assertions via a rolled-back `psql` transaction instead, and say so in the report.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts tests/db/inpatient-schema.test.ts
git commit -m "feat: add admissions/admission_transfers tables and widen room_status"
```

---

### Task 2: Admission creation, queries, and `deletePatient` cleanup

**Files:**
- Create: `src/lib/queries/admissions.ts`
- Modify: `src/app/api/front-desk/check-in/route.ts`
- Modify: `src/lib/queries/patients.ts` (`deletePatient`, currently lines 141-187)
- Test: `tests/lib/queries/admissions.test.ts`, and append to `tests/api/front-desk-check-in.test.ts`

**Interfaces:**
- Consumes: `admissions`, `admissionTransfers` from `@/db/schema` (Task 1).
- Produces: `createAdmission(input)`, `getActiveAdmissionForPatient(patientId)`, `getAdmissionById(id)`, `listAdmissionsForPatient(patientId)` from `@/lib/queries/admissions` — consumed by Tasks 3-6.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/queries/admissions.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { rooms, providers, patients, admissions } from '@/db/schema'
import { createAdmission, getActiveAdmissionForPatient, getAdmissionById } from '@/lib/queries/admissions'

const createdRoomIds: number[] = []
const createdAdmissionIds: number[] = []
afterEach(async () => {
  while (createdAdmissionIds.length > 0) await getDb().delete(admissions).where(eq(admissions.id, createdAdmissionIds.pop()!))
  while (createdRoomIds.length > 0) await getDb().delete(rooms).where(eq(rooms.id, createdRoomIds.pop()!))
})

describe('admissions queries', () => {
  it('creates an admission with a room and reads it back as the active one', async () => {
    const db = getDb()
    const [room] = await db.insert(rooms).values({ ward: 'Test Ward', roomNumber: 'Q1', bedNumber: 'A' }).returning()
    createdRoomIds.push(room.id)
    const [providerRow] = await db.select().from(providers).limit(1)
    const [patientRow] = await db.select().from(patients).limit(1)

    const created = await createAdmission({ patientId: patientRow.id, roomId: room.id, attendingProviderId: providerRow.id, admissionType: 'elective', createdFromAssignmentId: null })
    createdAdmissionIds.push(created.id)
    expect(created.currentRoomId).toBe(room.id)
    expect(created.status).toBe('admitted')

    const active = await getActiveAdmissionForPatient(patientRow.id)
    expect(active?.id).toBe(created.id)

    const byId = await getAdmissionById(created.id)
    expect(byId?.id).toBe(created.id)
  })

  it('creates a boarding admission with no room (roomId: null)', async () => {
    const db = getDb()
    const [providerRow] = await db.select().from(providers).limit(1)
    const [patientRow] = await db.select().from(patients).limit(1)
    const created = await createAdmission({ patientId: patientRow.id, roomId: null, attendingProviderId: providerRow.id, admissionType: 'emergency', createdFromAssignmentId: null })
    createdAdmissionIds.push(created.id)
    expect(created.currentRoomId).toBeNull()
  })

  it('returns null from getActiveAdmissionForPatient when the patient has no active admission', async () => {
    const db = getDb()
    const [patientRow] = await db.select().from(patients).limit(1)
    // Use a patient with a discharged-only history or none at all -- since
    // this test doesn't create any admission for this patient, "no active
    // admission" is trivially true here.
    const active = await getActiveAdmissionForPatient(patientRow.id + '-no-such-suffix')
    expect(active).toBeNull()
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/admissions.test.ts`
Expected: FAIL — `@/lib/queries/admissions` doesn't exist yet.

- [ ] **Step 3: Implement `src/lib/queries/admissions.ts`**

```ts
import { getDb } from '@/db/client'
import { admissions, admissionTransfers } from '@/db/schema'
import { and, desc, eq } from 'drizzle-orm'

export type Admission = typeof admissions.$inferSelect

export interface CreateAdmissionInput {
  patientId: string
  roomId: number | null
  attendingProviderId: number
  admissionType: 'elective' | 'emergency' | 'transfer_in'
  createdFromAssignmentId: number | null
}

export async function createAdmission(input: CreateAdmissionInput): Promise<Admission> {
  const [created] = await getDb().insert(admissions).values({
    patientId: input.patientId,
    currentRoomId: input.roomId,
    attendingProviderId: input.attendingProviderId,
    admissionType: input.admissionType,
    createdFromAssignmentId: input.createdFromAssignmentId,
  }).returning()
  return created
}

// Only one admission can be "active" for a patient at a time -- this is how
// the check-in route (below) avoids double-admitting a patient who's already
// an inpatient. Ordered by admittedAt desc as a defensive tie-breaker; in
// practice there should only ever be zero or one matching row.
export async function getActiveAdmissionForPatient(patientId: string): Promise<Admission | null> {
  const [row] = await getDb().select().from(admissions).where(and(eq(admissions.patientId, patientId), eq(admissions.status, 'admitted'))).orderBy(desc(admissions.admittedAt)).limit(1)
  return row ?? null
}

export async function getAdmissionById(id: number): Promise<Admission | null> {
  const [row] = await getDb().select().from(admissions).where(eq(admissions.id, id))
  return row ?? null
}

export interface AdmissionTransferRecord {
  id: number
  fromRoomId: number | null
  toRoomId: number
  reason: string
  transferredByName: string
  transferredAt: Date
}

export interface AdmissionWithTransfers extends Admission {
  transfers: AdmissionTransferRecord[]
}

// Newest admission first, each with its own transfer history (also newest
// first) -- exactly the shape the Patient Detail "Inpatient History" tab
// (Task 6) renders directly with no further reshaping.
export async function listAdmissionsForPatient(patientId: string): Promise<AdmissionWithTransfers[]> {
  const db = getDb()
  const admissionRows = await db.select().from(admissions).where(eq(admissions.patientId, patientId)).orderBy(desc(admissions.admittedAt))
  const result: AdmissionWithTransfers[] = []
  for (const admission of admissionRows) {
    const transfers = await db.select().from(admissionTransfers).where(eq(admissionTransfers.admissionId, admission.id)).orderBy(desc(admissionTransfers.transferredAt))
    result.push({ ...admission, transfers })
  }
  return result
}
```

- [ ] **Step 4: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/admissions.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 5: Hook admission creation into check-in — write the failing test first**

Append to `tests/api/front-desk-check-in.test.ts` (it already has a top-level static `import { POST } from '@/app/api/front-desk/check-in/route'` and a `vi.mock('@/lib/auth', ...)` with no per-test dynamic re-import, so no `vi.resetModules()` is needed here — this file makes real, unmocked DB calls beyond auth):

```ts
import { admissions } from '@/db/schema'

// ... alongside the existing afterEach's cleanup arrays, add:
const createdAdmissionIds: number[] = []
// and extend the existing afterEach to also run:
//   while (createdAdmissionIds.length > 0) await getDb().delete(admissions).where(eq(admissions.id, createdAdmissionIds.pop()!))

describe('POST /api/front-desk/check-in — admissions', () => {
  it('creates an admission record for an inpatient check-in', async () => {
    const providers = await listActiveProviders()
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001', visitType: 'inpatient', urgency: 'urgent', reason: 'Admission for observation', providerId: providers[0].id }) })
    const res = await POST(req as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    createdAssignmentIds.push(body.id)

    const [admission] = await getDb().select().from(admissions).where(eq(admissions.patientId, 'RD-0001')).orderBy(desc(admissions.admittedAt)).limit(1)
    createdAdmissionIds.push(admission.id)
    expect(admission.status).toBe('admitted')
    expect(admission.attendingProviderId).toBe(providers[0].id)
    expect(admission.createdFromAssignmentId).toBe(body.id)
  })

  it('does not create a second admission when the patient already has an active one', async () => {
    const providers = await listActiveProviders()
    const firstReq = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001', visitType: 'inpatient', urgency: 'urgent', reason: 'First admission', providerId: providers[0].id }) })
    const firstRes = await POST(firstReq as never)
    const firstBody = await firstRes.json()
    createdAssignmentIds.push(firstBody.id)

    const secondReq = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001', visitType: 'inpatient', urgency: 'routine', reason: 'Duplicate check-in attempt', providerId: providers[0].id }) })
    const secondRes = await POST(secondReq as never)
    const secondBody = await secondRes.json()
    createdAssignmentIds.push(secondBody.id)

    const activeAdmissions = await getDb().select().from(admissions).where(and(eq(admissions.patientId, 'RD-0001'), eq(admissions.status, 'admitted')))
    for (const a of activeAdmissions) createdAdmissionIds.push(a.id)
    expect(activeAdmissions.length).toBe(1)
  })
})
```

(Add `desc, and` to the file's existing `drizzle-orm` import if not already present, and add the `createdAdmissionIds` array plus its cleanup line to the existing `afterEach` rather than creating a second one.)

- [ ] **Step 6: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/front-desk-check-in.test.ts`
Expected: FAIL — no admission row is created yet (query returns nothing / duplicate-guard test finds 2 active admissions instead of 1).

- [ ] **Step 7: Wire the hook into the check-in route**

In `src/app/api/front-desk/check-in/route.ts`, add the import:

```ts
import { createAdmission, getActiveAdmissionForPatient } from '@/lib/queries/admissions'
```

And change the end of `POST` from:

```ts
  const created = await createDoctorAssignment({
    patientId,
    providerId,
    visitType,
    urgency,
    reason,
    roomId: roomId ?? null,
    assignedByName: session.name,
  })

  await logAudit(session, `checked in patient (${visitType})`, patientId)
  return NextResponse.json(created, { status: 201 })
```

to:

```ts
  const created = await createDoctorAssignment({
    patientId,
    providerId,
    visitType,
    urgency,
    reason,
    roomId: roomId ?? null,
    assignedByName: session.name,
  })

  // Checking in an inpatient IS starting their admission -- there's no
  // separate "start an admission" screen. Guard against double-admitting a
  // patient who's already an active inpatient (e.g. reception accidentally
  // re-checks someone in): the existing admission remains the current one.
  if (visitType === 'inpatient') {
    const existingActive = await getActiveAdmissionForPatient(patientId)
    if (!existingActive) {
      await createAdmission({
        patientId,
        roomId: roomId ?? null,
        attendingProviderId: providerId,
        admissionType: 'elective',
        createdFromAssignmentId: created.id,
      })
    }
  }

  await logAudit(session, `checked in patient (${visitType})`, patientId)
  return NextResponse.json(created, { status: 201 })
```

- [ ] **Step 8: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/front-desk-check-in.test.ts`
Expected: PASS (all tests in the file, including the pre-existing ones — this change must not break outpatient check-in, which is untouched).

- [ ] **Step 9: Add cleanup to `deletePatient` — write the failing test first**

Create `tests/lib/queries/delete-patient-admissions.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { rooms, providers, patients, admissions, admissionTransfers } from '@/db/schema'
import { deletePatient } from '@/lib/queries/patients'

describe('deletePatient — admissions cleanup', () => {
  it('deletes admissionTransfers and admissions for the patient, and does not leave an FK violation', async () => {
    const db = getDb()
    const [room1] = await db.insert(rooms).values({ ward: 'Test Ward', roomNumber: 'D1', bedNumber: 'A' }).returning()
    const [room2] = await db.insert(rooms).values({ ward: 'Test Ward', roomNumber: 'D2', bedNumber: 'A' }).returning()
    const [providerRow] = await db.select().from(providers).limit(1)

    const testPatientId = `TEST-DEL-${Date.now()}`
    await db.insert(patients).values({ id: testPatientId, nameTebra: 'Delete Test Patient', dobTebra: '2000-01-01', chartDataAsOf: new Date() })

    const [admission] = await db.insert(admissions).values({ patientId: testPatientId, currentRoomId: room1.id, attendingProviderId: providerRow.id }).returning()
    await db.insert(admissionTransfers).values({ admissionId: admission.id, fromRoomId: room1.id, toRoomId: room2.id, reason: 'Test', transferredByName: 'Test Nurse' })

    const deleted = await deletePatient(testPatientId)
    expect(deleted).toBe(true)

    const remainingAdmissions = await db.select().from(admissions).where(eq(admissions.patientId, testPatientId))
    expect(remainingAdmissions.length).toBe(0)

    await db.delete(rooms).where(eq(rooms.id, room1.id))
    await db.delete(rooms).where(eq(rooms.id, room2.id))
  })
})
```

- [ ] **Step 10: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/delete-patient-admissions.test.ts`
Expected: FAIL — `deletePatient` throws a foreign-key violation (`admissions_patient_id_fkey` or similar) because `admissions`/`admissionTransfers` rows for this patient are never deleted, so the final `DELETE FROM patients` fails.

- [ ] **Step 11: Update `deletePatient`**

In `src/lib/queries/patients.ts`, the `deletePatient` function currently has (around lines 160-167):

```ts
  // doctorAssignments must be deleted before appointments -- doctorAssignments.appointmentId
  // is a nullable FK to appointments(id) with no ON DELETE action, so Postgres would reject
  // the appointments delete below with a foreign-key violation once a doctor assignment
  // references an appointment (see the children-before-parents ordering already used above
  // for screeningCriteriaResults before patientTrialScreenings).
  await db.delete(insuranceEligibilityChecks).where(eq(insuranceEligibilityChecks.patientId, anonId))
  await db.delete(doctorAssignments).where(eq(doctorAssignments.patientId, anonId))
  await db.delete(appointments).where(eq(appointments.patientId, anonId))
```

Change it to:

```ts
  // doctorAssignments must be deleted before appointments -- doctorAssignments.appointmentId
  // is a nullable FK to appointments(id) with no ON DELETE action, so Postgres would reject
  // the appointments delete below with a foreign-key violation once a doctor assignment
  // references an appointment (see the children-before-parents ordering already used above
  // for screeningCriteriaResults before patientTrialScreenings).
  //
  // admissionTransfers -> admissions -> doctorAssignments -> appointments, in that order:
  // admissionTransfers.admissionId references admissions(id), and admissions itself
  // references both doctorAssignments(id) (createdFromAssignmentId) and appointments(id)
  // (followUpAppointmentId) -- the same FK-ordering discipline applied one level deeper.
  await db.delete(insuranceEligibilityChecks).where(eq(insuranceEligibilityChecks.patientId, anonId))
  const patientAdmissionIds = (await db.select({ id: admissions.id }).from(admissions).where(eq(admissions.patientId, anonId))).map((a) => a.id)
  if (patientAdmissionIds.length > 0) {
    await db.delete(admissionTransfers).where(inArray(admissionTransfers.admissionId, patientAdmissionIds))
  }
  await db.delete(admissions).where(eq(admissions.patientId, anonId))
  await db.delete(doctorAssignments).where(eq(doctorAssignments.patientId, anonId))
  await db.delete(appointments).where(eq(appointments.patientId, anonId))
```

Add `admissions, admissionTransfers` to this file's existing `@/db/schema` import (`inArray` is already imported — it's used above for `screeningCriteriaResults`).

- [ ] **Step 12: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/delete-patient-admissions.test.ts`
Expected: PASS.

- [ ] **Step 13: Run the full set of files this task touched**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/admissions.test.ts tests/api/front-desk-check-in.test.ts tests/lib/queries/delete-patient-admissions.test.ts tests/lib/queries/patients.test.ts`
Expected: all pass (retry through transient Neon errors; fall back to `psql` per the Global Constraints note for anything that stays red).

- [ ] **Step 14: Commit**

```bash
git add src/lib/queries/admissions.ts src/app/api/front-desk/check-in/route.ts src/lib/queries/patients.ts tests/lib/queries/admissions.test.ts tests/api/front-desk-check-in.test.ts tests/lib/queries/delete-patient-admissions.test.ts
git commit -m "feat: create an admission record when front desk checks in an inpatient"
```

---

### Task 3: Bed/ward status board — read view, mark-clean, block/unblock

**Files:**
- Modify: `src/lib/queries/rooms.ts` (add `listAllRoomsWithOccupant`, `markRoomClean`, `blockRoom`, `unblockRoom`)
- Create: `src/app/api/inpatient/rooms/[id]/mark-clean/route.ts`
- Create: `src/app/api/inpatient/rooms/[id]/block/route.ts`
- Create: `src/app/api/inpatient/rooms/[id]/unblock/route.ts`
- Create: `src/components/BedBoard.tsx`
- Create: `src/app/(dashboard)/inpatient/beds/page.tsx`
- Modify: `src/components/LeftNav.tsx`
- Modify: `src/lib/role-capabilities.ts`
- Test: `tests/lib/queries/rooms.test.ts` (extend if it exists, else create), `tests/api/inpatient-rooms-lifecycle.test.ts`

**Interfaces:**
- Consumes: `getActiveAdmissionForPatient` is NOT needed here — the board reads room+patient state directly, not admission state, since a room's occupant name should show even mid-transaction. `rooms`, `patients` from `@/db/schema`.
- Produces: `listAllRoomsWithOccupant()`, `markRoomClean(roomId)`, `blockRoom(roomId, reason)`, `unblockRoom(roomId)` from `@/lib/queries/rooms` — Tasks 4 and 5 read room state via the same file's existing `listAvailableRooms`/`assignRoomToPatient`, unchanged.

**UI reference (Mobbin, verified 2026-09-26):** [Deputy's grouped Schedule grid](https://mobbin.com/screens/42d9229d-2df6-4245-a3c1-0802e8c89350) — rows grouped by area, colored cells, persistent bottom legend mapping every color to a count and label. This task's board groups by `ward` instead of by employee row, and the legend maps to room status instead of shift status.

- [ ] **Step 1: Write the failing test**

Create `tests/api/inpatient-rooms-lifecycle.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { POST as markClean } from '@/app/api/inpatient/rooms/[id]/mark-clean/route'
import { POST as blockRoomRoute } from '@/app/api/inpatient/rooms/[id]/block/route'
import { POST as unblockRoomRoute } from '@/app/api/inpatient/rooms/[id]/unblock/route'
import { getDb } from '@/db/client'
import { rooms } from '@/db/schema'

let sessionRole = 'admin'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Test Admin' })) }))

const createdRoomIds: number[] = []
afterEach(async () => {
  sessionRole = 'admin'
  while (createdRoomIds.length > 0) await getDb().delete(rooms).where(eq(rooms.id, createdRoomIds.pop()!))
})

describe('inpatient room lifecycle routes', () => {
  it('marks a dirty room clean (available)', async () => {
    const [room] = await getDb().insert(rooms).values({ ward: 'Test Ward', roomNumber: 'L1', bedNumber: 'A', status: 'dirty' }).returning()
    createdRoomIds.push(room.id)
    const req = new Request('http://localhost', { method: 'POST' })
    const res = await markClean(req as never, { params: Promise.resolve({ id: String(room.id) }) })
    expect(res.status).toBe(200)
    const [updated] = await getDb().select().from(rooms).where(eq(rooms.id, room.id))
    expect(updated.status).toBe('available')
  })

  it('rejects mark-clean from a role with no facilities access', async () => {
    sessionRole = 'pi'
    const [room] = await getDb().insert(rooms).values({ ward: 'Test Ward', roomNumber: 'L2', bedNumber: 'A', status: 'dirty' }).returning()
    createdRoomIds.push(room.id)
    const req = new Request('http://localhost', { method: 'POST' })
    const res = await markClean(req as never, { params: Promise.resolve({ id: String(room.id) }) })
    expect(res.status).toBe(403)
  })

  it('blocks and then unblocks a room, clearing the reason on unblock', async () => {
    const [room] = await getDb().insert(rooms).values({ ward: 'Test Ward', roomNumber: 'L3', bedNumber: 'A' }).returning()
    createdRoomIds.push(room.id)
    const blockReq = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ reason: 'Plumbing repair' }) })
    const blockRes = await blockRoomRoute(blockReq as never, { params: Promise.resolve({ id: String(room.id) }) })
    expect(blockRes.status).toBe(200)
    const [blocked] = await getDb().select().from(rooms).where(eq(rooms.id, room.id))
    expect(blocked.status).toBe('blocked')
    expect(blocked.blockedReason).toBe('Plumbing repair')

    const unblockReq = new Request('http://localhost', { method: 'POST' })
    const unblockRes = await unblockRoomRoute(unblockReq as never, { params: Promise.resolve({ id: String(room.id) }) })
    expect(unblockRes.status).toBe(200)
    const [unblocked] = await getDb().select().from(rooms).where(eq(rooms.id, room.id))
    expect(unblocked.status).toBe('available')
    expect(unblocked.blockedReason).toBeNull()
  })

  it('rejects blocking a room from a non-admin role', async () => {
    sessionRole = 'frontdesk'
    const [room] = await getDb().insert(rooms).values({ ward: 'Test Ward', roomNumber: 'L4', bedNumber: 'A' }).returning()
    createdRoomIds.push(room.id)
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ reason: 'Test' }) })
    const res = await blockRoomRoute(req as never, { params: Promise.resolve({ id: String(room.id) }) })
    expect(res.status).toBe(403)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/inpatient-rooms-lifecycle.test.ts`
Expected: FAIL — none of the three routes exist yet.

- [ ] **Step 3: Add query functions to `src/lib/queries/rooms.ts`**

Append to the existing file (keep `listAvailableRooms` and `assignRoomToPatient` unchanged):

```ts
export interface RoomWithOccupant {
  id: number
  ward: string
  roomNumber: string
  bedNumber: string
  status: 'available' | 'occupied' | 'dirty' | 'blocked'
  blockedReason: string | null
  occupantName: string | null
}

export async function listAllRoomsWithOccupant(): Promise<RoomWithOccupant[]> {
  const rows = await getDb()
    .select({
      id: rooms.id,
      ward: rooms.ward,
      roomNumber: rooms.roomNumber,
      bedNumber: rooms.bedNumber,
      status: rooms.status,
      blockedReason: rooms.blockedReason,
      occupantNameTebra: patients.nameTebra,
      occupantNameIntakeq: patients.nameIntakeq,
    })
    .from(rooms)
    .leftJoin(patients, eq(rooms.occupiedByPatientId, patients.id))
  return rows.map((r) => ({
    id: r.id,
    ward: r.ward,
    roomNumber: r.roomNumber,
    bedNumber: r.bedNumber,
    status: r.status,
    blockedReason: r.blockedReason,
    occupantName: r.occupantNameTebra ?? r.occupantNameIntakeq ?? null,
  }))
}

export async function markRoomClean(roomId: number): Promise<boolean> {
  const result = await getDb().update(rooms).set({ status: 'available' }).where(and(eq(rooms.id, roomId), eq(rooms.status, 'dirty'))).returning({ id: rooms.id })
  return result.length > 0
}

export async function blockRoom(roomId: number, reason: string): Promise<boolean> {
  const result = await getDb().update(rooms).set({ status: 'blocked', blockedReason: reason }).where(and(eq(rooms.id, roomId), eq(rooms.status, 'available'))).returning({ id: rooms.id })
  return result.length > 0
}

export async function unblockRoom(roomId: number): Promise<boolean> {
  const result = await getDb().update(rooms).set({ status: 'available', blockedReason: null }).where(and(eq(rooms.id, roomId), eq(rooms.status, 'blocked'))).returning({ id: rooms.id })
  return result.length > 0
}
```

Add `patients` to this file's `@/db/schema` import.

- [ ] **Step 4: Implement the three routes**

Create `src/app/api/inpatient/rooms/[id]/mark-clean/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { markRoomClean } from '@/lib/queries/rooms'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['frontdesk', 'admin', 'crc'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const roomId = Number(id)
  if (!Number.isInteger(roomId)) return NextResponse.json({ error: 'Invalid room id' }, { status: 400 })

  const ok = await markRoomClean(roomId)
  if (!ok) return NextResponse.json({ error: 'Room is not currently dirty, or does not exist' }, { status: 409 })

  await logAudit(session, `marked room ${roomId} clean`, null)
  return NextResponse.json({ ok: true })
}
```

Create `src/app/api/inpatient/rooms/[id]/block/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { blockRoom } from '@/lib/queries/rooms'

const blockSchema = z.object({ reason: z.string().min(1) }).strict()

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const roomId = Number(id)
  if (!Number.isInteger(roomId)) return NextResponse.json({ error: 'Invalid room id' }, { status: 400 })

  const parsed = blockSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 400 })

  const ok = await blockRoom(roomId, parsed.data.reason)
  if (!ok) return NextResponse.json({ error: 'Room is not currently available, or does not exist' }, { status: 409 })

  await logAudit(session, `blocked room ${roomId}: ${parsed.data.reason}`, null)
  return NextResponse.json({ ok: true })
}
```

Create `src/app/api/inpatient/rooms/[id]/unblock/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { unblockRoom } from '@/lib/queries/rooms'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const roomId = Number(id)
  if (!Number.isInteger(roomId)) return NextResponse.json({ error: 'Invalid room id' }, { status: 400 })

  const ok = await unblockRoom(roomId)
  if (!ok) return NextResponse.json({ error: 'Room is not currently blocked, or does not exist' }, { status: 409 })

  await logAudit(session, `unblocked room ${roomId}`, null)
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 5: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/inpatient-rooms-lifecycle.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 6: Build the `BedBoard` component**

Create `src/components/BedBoard.tsx`:

```tsx
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

export interface BoardRoom {
  id: number
  ward: string
  roomNumber: string
  bedNumber: string
  status: 'available' | 'occupied' | 'dirty' | 'blocked'
  blockedReason: string | null
  occupantName: string | null
}

const STATUS_STYLES: Record<BoardRoom['status'], string> = {
  available: 'border-emerald-600/30 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400',
  occupied: 'border-primary/30 bg-primary/10 text-primary',
  dirty: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  blocked: 'border-destructive/30 bg-destructive/10 text-destructive',
}

const STATUS_LABELS: Record<BoardRoom['status'], string> = {
  available: 'Available',
  occupied: 'Occupied',
  dirty: 'Needs cleaning',
  blocked: 'Blocked',
}

// Grouped-grid-with-persistent-legend layout, following Deputy's Schedule
// grid (https://mobbin.com/screens/42d9229d-2df6-4245-a3c1-0802e8c89350):
// rows grouped by area (here, ward) with color-coded cells, and a fixed
// bottom legend mapping every color to its label -- status is never shown
// by color alone.
export function BedBoard({ rooms, canManageFacilities, canBlock, canAdmit }: { rooms: BoardRoom[]; canManageFacilities: boolean; canBlock: boolean; canAdmit: boolean }) {
  const router = useRouter()
  const [selected, setSelected] = useState<BoardRoom | null>(null)
  const [blockReason, setBlockReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const wards = Array.from(new Set(rooms.map((r) => r.ward))).sort()

  async function callAction(path: string, body?: object) {
    setBusy(true)
    setError(null)
    const res = await fetch(path, { method: 'POST', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
    setBusy(false)
    if (!res.ok) {
      const b = await res.json().catch(() => null)
      setError(b?.error ?? 'Action failed.')
      return false
    }
    router.refresh()
    setSelected(null)
    return true
  }

  return (
    <div className="space-y-6">
      {wards.map((ward) => (
        <div key={ward}>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{ward}</h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
            {rooms.filter((r) => r.ward === ward).map((r) => (
              <button
                key={r.id}
                onClick={() => { setSelected(r); setBlockReason(''); setError(null) }}
                className={`rounded-lg border p-3 text-left text-xs transition-colors hover:opacity-80 ${STATUS_STYLES[r.status]}`}
              >
                <p className="font-semibold">Room {r.roomNumber} · Bed {r.bedNumber}</p>
                <p className="mt-1">{STATUS_LABELS[r.status]}</p>
                {r.occupantName && <p className="mt-1 truncate opacity-80">{r.occupantName}</p>}
              </button>
            ))}
          </div>
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-4 rounded-lg border border-border bg-secondary/40 p-3 text-xs">
        {(Object.keys(STATUS_LABELS) as BoardRoom['status'][]).map((s) => (
          <span key={s} className="flex items-center gap-1.5">
            <span className={`h-2.5 w-2.5 rounded-full border ${STATUS_STYLES[s]}`} aria-hidden="true" />
            {STATUS_LABELS[s]}
          </span>
        ))}
      </div>

      <Dialog open={selected !== null} onOpenChange={(open) => { if (!open) setSelected(null) }}>
        {selected && (
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Room {selected.roomNumber} · Bed {selected.bedNumber} — {selected.ward}</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 text-sm">
              <p className="text-muted-foreground">Status: <span className="font-medium text-foreground">{STATUS_LABELS[selected.status]}</span></p>
              {selected.occupantName && <p className="text-foreground">Occupant: {selected.occupantName}</p>}
              {selected.status === 'blocked' && selected.blockedReason && <p className="text-muted-foreground">Reason: {selected.blockedReason}</p>}

              {selected.status === 'dirty' && canManageFacilities && (
                <Button onClick={() => callAction(`/api/inpatient/rooms/${selected.id}/mark-clean`)} disabled={busy}>Mark clean</Button>
              )}

              {selected.status === 'available' && canBlock && (
                <div className="space-y-2">
                  <input value={blockReason} onChange={(e) => setBlockReason(e.target.value)} placeholder="Reason for blocking, e.g. Plumbing repair" aria-label="Block reason" className="w-full rounded-md border border-border px-2 py-1.5 text-sm" />
                  <Button variant="outline" onClick={() => callAction(`/api/inpatient/rooms/${selected.id}/block`, { reason: blockReason })} disabled={busy || !blockReason}>Block room</Button>
                </div>
              )}

              {selected.status === 'blocked' && canBlock && (
                <Button variant="outline" onClick={() => callAction(`/api/inpatient/rooms/${selected.id}/unblock`)} disabled={busy}>Unblock room</Button>
              )}

              {selected.status === 'occupied' && canAdmit && (
                <p className="text-xs text-muted-foreground">Transfer and discharge actions for this patient&apos;s admission are on their Patient Detail page.</p>
              )}

              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setSelected(null)}>Close</Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  )
}
```

(Task 4's Transfer action and Task 5's Discharge action are surfaced from the Patient Detail page's new Inpatient History tab, built in Task 6 — not from this board's popover — because both need the admission's own id, which the board's room-centric query doesn't carry. This keeps the board itself purely about room/facility state, and clinical actions on the patient's own record page, matching this codebase's existing separation between `front-desk/assignments` — where reception acts — and `doctor/page.tsx` — where a PI acts on their own patients.)

- [ ] **Step 7: Build the page**

Create `src/app/(dashboard)/inpatient/beds/page.tsx`:

```tsx
import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listAllRoomsWithOccupant } from '@/lib/queries/rooms'
import { BedBoard } from '@/components/BedBoard'

export default async function InpatientBedsPage() {
  const session = await requireSessionOrRedirect()
  if (!['frontdesk', 'admin', 'crc', 'pi'].includes(session.role)) redirect('/')

  const rooms = await listAllRoomsWithOccupant()
  await logAudit(session, 'viewed bed board', null)

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-foreground">Beds</h1>
      <BedBoard
        rooms={rooms}
        canManageFacilities={['frontdesk', 'admin', 'crc'].includes(session.role)}
        canBlock={session.role === 'admin'}
        canAdmit={session.role === 'pi'}
      />
    </div>
  )
}
```

- [ ] **Step 8: Add the nav link**

In `src/components/LeftNav.tsx`, add `BedDouble` to the `lucide-react` import list, and add this item to `ITEMS` right after the `'/front-desk/assignments'` entry:

```ts
  { href: '/inpatient/beds', label: 'Beds', icon: BedDouble, roles: ['frontdesk', 'admin', 'crc', 'pi'] as Role[] },
```

- [ ] **Step 9: Update role capabilities**

In `src/lib/role-capabilities.ts`, add a bullet to `frontdesk.bullets`: `'View and manage the live bed/ward status board'`, and add a bullet to `pi.bullets`: `'View the live bed/ward status board for their admitted patients'`.

- [ ] **Step 10: Run `npx tsc --noEmit` and `npx eslint`**

Expected: clean.

- [ ] **Step 11: Run the full set of files this task touched**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/inpatient-rooms-lifecycle.test.ts`
Expected: pass (retry/psql-fallback per Global Constraints).

- [ ] **Step 12: Commit**

```bash
git add src/lib/queries/rooms.ts src/app/api/inpatient/rooms src/components/BedBoard.tsx "src/app/(dashboard)/inpatient/beds/page.tsx" src/components/LeftNav.tsx src/lib/role-capabilities.ts tests/api/inpatient-rooms-lifecycle.test.ts
git commit -m "feat: add live bed/ward status board with mark-clean and block/unblock"
```

---

### Task 4: Transfer workflow

**Files:**
- Modify: `src/lib/queries/admissions.ts` (add `transferAdmission`)
- Create: `src/app/api/inpatient/admissions/[id]/transfer/route.ts`
- Create: `src/components/TransferAdmissionModal.tsx`
- Test: `tests/lib/queries/admissions.test.ts` (extend), `tests/api/inpatient-admissions-transfer.test.ts`

**Interfaces:**
- Consumes: `getAdmissionById`, `Admission` from `@/lib/queries/admissions` (Task 2); `listAvailableRooms` from `@/lib/queries/rooms` (existing, unchanged); `hasSchedulingConflict`-style ownership pattern from `src/app/api/front-desk/assignments/[id]/schedule/route.ts` (PI-owns-this-provider check).
- Produces: `transferAdmission(admissionId, toRoomId, reason, transferredByName)` — consumed by Task 5's discharge route is NOT needed (discharge doesn't transfer), but Task 6's timeline reads the `admissionTransfers` rows this creates via `listAdmissionsForPatient` (already built in Task 2).

- [ ] **Step 1: Write the failing test**

Append to `tests/lib/queries/admissions.test.ts`:

```ts
import { transferAdmission } from '@/lib/queries/admissions'

// ... inside the existing describe block, or a new one:
describe('transferAdmission', () => {
  it('moves the admission to a new room, frees the old one to dirty, and records the transfer', async () => {
    const db = getDb()
    const [oldRoom] = await db.insert(rooms).values({ ward: 'Test Ward', roomNumber: 'X1', bedNumber: 'A', status: 'occupied' }).returning()
    const [newRoom] = await db.insert(rooms).values({ ward: 'Test Ward', roomNumber: 'X2', bedNumber: 'A' }).returning()
    const [providerRow] = await db.select().from(providers).limit(1)
    const [patientRow] = await db.select().from(patients).limit(1)
    await db.update(rooms).set({ occupiedByPatientId: patientRow.id }).where(eq(rooms.id, oldRoom.id))
    const admission = await createAdmission({ patientId: patientRow.id, roomId: oldRoom.id, attendingProviderId: providerRow.id, admissionType: 'elective', createdFromAssignmentId: null })

    const result = await transferAdmission(admission.id, newRoom.id, 'Needs ICU-level care', 'Test Nurse')
    expect(result.ok).toBe(true)

    const updatedAdmission = await getAdmissionById(admission.id)
    expect(updatedAdmission?.currentRoomId).toBe(newRoom.id)

    const [oldRoomAfter] = await db.select().from(rooms).where(eq(rooms.id, oldRoom.id))
    expect(oldRoomAfter.status).toBe('dirty')
    const [newRoomAfter] = await db.select().from(rooms).where(eq(rooms.id, newRoom.id))
    expect(newRoomAfter.status).toBe('occupied')

    await db.delete(admissionTransfers).where(eq(admissionTransfers.admissionId, admission.id))
    await db.delete(admissions).where(eq(admissions.id, admission.id))
    await db.delete(rooms).where(eq(rooms.id, oldRoom.id))
    await db.delete(rooms).where(eq(rooms.id, newRoom.id))
  })

  it('fails with a clear error when the destination room is not available', async () => {
    const db = getDb()
    const [takenRoom] = await db.insert(rooms).values({ ward: 'Test Ward', roomNumber: 'X3', bedNumber: 'A', status: 'occupied' }).returning()
    const [providerRow] = await db.select().from(providers).limit(1)
    const [patientRow] = await db.select().from(patients).limit(1)
    const admission = await createAdmission({ patientId: patientRow.id, roomId: null, attendingProviderId: providerRow.id, admissionType: 'elective', createdFromAssignmentId: null })

    const result = await transferAdmission(admission.id, takenRoom.id, 'Test', 'Test Nurse')
    expect(result.ok).toBe(false)

    await db.delete(admissions).where(eq(admissions.id, admission.id))
    await db.delete(rooms).where(eq(rooms.id, takenRoom.id))
  })

  it('supports a null fromRoomId as the first room assignment for a boarding admission', async () => {
    const db = getDb()
    const [room] = await db.insert(rooms).values({ ward: 'Test Ward', roomNumber: 'X4', bedNumber: 'A' }).returning()
    const [providerRow] = await db.select().from(providers).limit(1)
    const [patientRow] = await db.select().from(patients).limit(1)
    const admission = await createAdmission({ patientId: patientRow.id, roomId: null, attendingProviderId: providerRow.id, admissionType: 'elective', createdFromAssignmentId: null })

    const result = await transferAdmission(admission.id, room.id, 'First bed assignment', 'Test Nurse')
    expect(result.ok).toBe(true)
    const [transferRow] = await db.select().from(admissionTransfers).where(eq(admissionTransfers.admissionId, admission.id))
    expect(transferRow.fromRoomId).toBeNull()

    await db.delete(admissionTransfers).where(eq(admissionTransfers.admissionId, admission.id))
    await db.delete(admissions).where(eq(admissions.id, admission.id))
    await db.delete(rooms).where(eq(rooms.id, room.id))
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/admissions.test.ts`
Expected: FAIL — `transferAdmission` doesn't exist yet.

- [ ] **Step 3: Implement `transferAdmission`**

In `src/lib/queries/admissions.ts`, add `rooms` to the existing top-of-file `import { admissions, admissionTransfers } from '@/db/schema'` line (making it `import { admissions, admissionTransfers, rooms } from '@/db/schema'`) — do not add a second, separate `import` statement for the same module; this repo's ESLint config flags duplicate imports from one module. Then append to the file:

```ts
export interface TransferResult {
  ok: boolean
  error?: string
}

// Sequential, not transactional (the neon-http driver doesn't support
// multi-statement transactions -- same accepted limitation as Front Desk).
// Order matters for safety: claim the destination room FIRST (race-safe,
// conditional on it still being available), and only free the old room and
// update the admission after that succeeds. If the process died between
// steps, the failure mode is "new room occupied, old room still occupied
// too" -- an inconsistency a human can see and fix -- never "old room freed
// but nobody actually holds the new one."
export async function transferAdmission(admissionId: number, toRoomId: number, reason: string, transferredByName: string): Promise<TransferResult> {
  const db = getDb()
  const admission = await getAdmissionById(admissionId)
  if (!admission) return { ok: false, error: 'Admission not found' }
  if (admission.status !== 'admitted') return { ok: false, error: 'This admission has already been discharged' }

  const claimed = await db.update(rooms).set({ status: 'occupied', occupiedByPatientId: admission.patientId }).where(and(eq(rooms.id, toRoomId), eq(rooms.status, 'available'))).returning({ id: rooms.id })
  if (claimed.length === 0) return { ok: false, error: 'That room is no longer available. Please choose another.' }

  const fromRoomId = admission.currentRoomId
  if (fromRoomId !== null) {
    await db.update(rooms).set({ status: 'dirty', occupiedByPatientId: null }).where(eq(rooms.id, fromRoomId))
  }

  await db.update(admissions).set({ currentRoomId: toRoomId }).where(eq(admissions.id, admissionId))
  await db.insert(admissionTransfers).values({ admissionId, fromRoomId, toRoomId, reason, transferredByName })

  return { ok: true }
}
```

- [ ] **Step 4: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/admissions.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Write the failing route test**

Create `tests/api/inpatient-admissions-transfer.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { POST } from '@/app/api/inpatient/admissions/[id]/transfer/route'
import { getDb } from '@/db/client'
import { rooms, admissions, admissionTransfers, providers, patients } from '@/db/schema'
import { createAdmission } from '@/lib/queries/admissions'
import { listActiveProviders } from '@/lib/queries/providers'

let sessionName = 'Test Admin'
let sessionRole: 'admin' | 'pi' | 'frontdesk' | 'crc' = 'admin'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: sessionName })) }))

const createdRoomIds: number[] = []
const createdAdmissionIds: number[] = []
afterEach(async () => {
  sessionRole = 'admin'
  sessionName = 'Test Admin'
  while (createdAdmissionIds.length > 0) {
    const id = createdAdmissionIds.pop()!
    await getDb().delete(admissionTransfers).where(eq(admissionTransfers.admissionId, id))
    await getDb().delete(admissions).where(eq(admissions.id, id))
  }
  while (createdRoomIds.length > 0) await getDb().delete(rooms).where(eq(rooms.id, createdRoomIds.pop()!))
})

describe('POST /api/inpatient/admissions/[id]/transfer', () => {
  it('transfers as admin', async () => {
    const [providerRow] = await getDb().select().from(providers).limit(1)
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const [newRoom] = await getDb().insert(rooms).values({ ward: 'Test Ward', roomNumber: 'Y1', bedNumber: 'A' }).returning()
    createdRoomIds.push(newRoom.id)
    const admission = await createAdmission({ patientId: patientRow.id, roomId: null, attendingProviderId: providerRow.id, admissionType: 'elective', createdFromAssignmentId: null })
    createdAdmissionIds.push(admission.id)

    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ toRoomId: newRoom.id, reason: 'ICU-level care' }) })
    const res = await POST(req as never, { params: Promise.resolve({ id: String(admission.id) }) })
    expect(res.status).toBe(200)
  })

  it('rejects a PI transferring an admission they are not the attending provider for', async () => {
    sessionRole = 'pi'
    const providersList = await listActiveProviders()
    const otherProvider = providersList.find((p) => !sessionName.toLowerCase().includes(p.name.toLowerCase().split(' ').pop()!)) ?? providersList[0]
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const [newRoom] = await getDb().insert(rooms).values({ ward: 'Test Ward', roomNumber: 'Y2', bedNumber: 'A' }).returning()
    createdRoomIds.push(newRoom.id)
    const admission = await createAdmission({ patientId: patientRow.id, roomId: null, attendingProviderId: otherProvider.id, admissionType: 'elective', createdFromAssignmentId: null })
    createdAdmissionIds.push(admission.id)

    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ toRoomId: newRoom.id, reason: 'Test' }) })
    const res = await POST(req as never, { params: Promise.resolve({ id: String(admission.id) }) })
    expect(res.status).toBe(403)
  })

  it('rejects an unknown field in the payload', async () => {
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ toRoomId: 1, reason: 'Test', extra: true }) })
    const res = await POST(req as never, { params: Promise.resolve({ id: '1' }) })
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 6: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/inpatient-admissions-transfer.test.ts`
Expected: FAIL — the route doesn't exist yet.

- [ ] **Step 7: Implement the route**

Create `src/app/api/inpatient/admissions/[id]/transfer/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getAdmissionById, transferAdmission } from '@/lib/queries/admissions'
import { listActiveProviders } from '@/lib/queries/providers'

const transferSchema = z.object({ toRoomId: z.number().int().positive(), reason: z.string().min(1) }).strict()

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['frontdesk', 'admin', 'crc', 'pi'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const admissionId = Number(id)
  if (!Number.isInteger(admissionId)) return NextResponse.json({ error: 'Invalid admission id' }, { status: 400 })

  const parsed = transferSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid transfer payload', details: parsed.error.flatten() }, { status: 400 })

  const admission = await getAdmissionById(admissionId)
  if (!admission) return NextResponse.json({ error: 'Admission not found' }, { status: 404 })

  // A PI may only transfer their own attending patients -- same ownership
  // check as the Front Desk schedule/decline routes (best-effort last-name
  // match against listActiveProviders, since there's no real session<->
  // provider-row link yet).
  if (session.role === 'pi') {
    const lastName = session.name.trim().split(/\s+/).pop() ?? session.name
    const providersList = await listActiveProviders()
    const providerMatch = providersList.find((p) => p.name.toLowerCase().includes(lastName.toLowerCase()))
    if (!providerMatch || admission.attendingProviderId !== providerMatch.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  const result = await transferAdmission(admissionId, parsed.data.toRoomId, parsed.data.reason, session.name)
  if (!result.ok) {
    const status = result.error === 'Admission not found' ? 404 : result.error === 'This admission has already been discharged' ? 409 : 409
    return NextResponse.json({ error: result.error }, { status })
  }

  await logAudit(session, `transferred patient's admission ${admissionId} to room ${parsed.data.toRoomId}`, admission.patientId)
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 8: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/inpatient-admissions-transfer.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 9: Build the `TransferAdmissionModal` component**

Create `src/components/TransferAdmissionModal.tsx`:

```tsx
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface RoomOption { id: number; ward: string; roomNumber: string; bedNumber: string }

export function TransferAdmissionModal({ admissionId, availableRooms, onClose }: { admissionId: number; availableRooms: RoomOption[]; onClose: () => void }) {
  const router = useRouter()
  const [toRoomId, setToRoomId] = useState<number | ''>('')
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setSubmitting(true)
    setError(null)
    const res = await fetch(`/api/inpatient/admissions/${admissionId}/transfer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toRoomId, reason }),
    })
    setSubmitting(false)
    if (res.ok) { router.refresh(); onClose(); return }
    const body = await res.json().catch(() => null)
    setError(body?.error ?? 'Could not transfer this patient.')
  }

  const canSubmit = toRoomId !== '' && Boolean(reason) && !submitting

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Transfer Patient</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <select value={toRoomId} onChange={(e) => setToRoomId(e.target.value === '' ? '' : Number(e.target.value))} aria-label="New room" className="w-full rounded-md border border-border px-3 py-2 text-sm">
            <option value="">Select a new room…</option>
            {availableRooms.map((r) => <option key={r.id} value={r.id}>{r.ward} — Room {r.roomNumber}, Bed {r.bedNumber}</option>)}
          </select>
          {availableRooms.length === 0 && <p className="text-sm text-warning">No rooms are currently available.</p>}
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for transfer" aria-label="Reason" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>Transfer</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

(This component is wired into the Patient Detail page's Inpatient History tab in Task 6, which is where it gets `admissionId` and the current `availableRooms` list from the server.)

- [ ] **Step 10: Run `npx tsc --noEmit` and `npx eslint`**

Expected: clean.

- [ ] **Step 11: Commit**

```bash
git add src/lib/queries/admissions.ts src/app/api/inpatient/admissions src/components/TransferAdmissionModal.tsx tests/lib/queries/admissions.test.ts tests/api/inpatient-admissions-transfer.test.ts
git commit -m "feat: add inpatient transfer workflow"
```

---

### Task 5: Discharge workflow (the "5 D's")

**Files:**
- Modify: `src/lib/queries/admissions.ts` (add `dischargeAdmission`)
- Create: `src/app/api/inpatient/admissions/[id]/discharge/route.ts`
- Create: `src/components/DischargeAdmissionModal.tsx`
- Test: `tests/lib/queries/admissions.test.ts` (extend), `tests/api/inpatient-admissions-discharge.test.ts`

**Interfaces:**
- Consumes: `getAdmissionById` from `@/lib/queries/admissions` (Task 2); `hasSchedulingConflict` from `@/lib/queries/appointments` (existing, unchanged, same conflict check Front Desk's own schedule route uses).
- Produces: `dischargeAdmission(admissionId, input)` — the terminal state Task 6's timeline renders as "Discharged" with the stored summary.

**UI reference (Mobbin, verified 2026-09-26):** [Headspace's appointment stepper](https://mobbin.com/screens/c9b2bbdc-2976-46da-ba9a-e23f662f3d7e) (`Check In → Verify Insurance → Schedule appointment`) for the modal's 3 steps; [Cal.com's "This meeting is scheduled" confirmation card](https://mobbin.com/screens/9d826d23-ed7e-4ec6-9f7f-c2b23f7d8f2a) for the final confirmation panel.

- [ ] **Step 1: Write the failing test**

Add `appointments` to this test file's existing `import { rooms, providers, patients, admissions, admissionTransfers } from '@/db/schema'` line (do not add a second import statement for the same module). Then append to `tests/lib/queries/admissions.test.ts`:

```ts
import { dischargeAdmission } from '@/lib/queries/admissions'

describe('dischargeAdmission', () => {
  it('discharges, frees the room to dirty, and stores the 5 Ds', async () => {
    const db = getDb()
    const [room] = await db.insert(rooms).values({ ward: 'Test Ward', roomNumber: 'Z1', bedNumber: 'A', status: 'occupied' }).returning()
    const [providerRow] = await db.select().from(providers).limit(1)
    const [patientRow] = await db.select().from(patients).limit(1)
    await db.update(rooms).set({ occupiedByPatientId: patientRow.id }).where(eq(rooms.id, room.id))
    const admission = await createAdmission({ patientId: patientRow.id, roomId: room.id, attendingProviderId: providerRow.id, admissionType: 'elective', createdFromAssignmentId: null })

    const result = await dischargeAdmission(admission.id, {
      dischargeDiagnosis: 'Resolved pneumonia',
      dischargeDrugs: 'Amoxicillin 500mg TID x7 days',
      dischargeDevices: 'None',
      dischargeDiet: 'Regular',
      dischargeSummaryNotes: 'Patient tolerated treatment well.',
      followUp: null,
    })
    expect(result.ok).toBe(true)

    const updated = await getAdmissionById(admission.id)
    expect(updated?.status).toBe('discharged')
    expect(updated?.currentRoomId).toBeNull()
    expect(updated?.dischargeDiagnosis).toBe('Resolved pneumonia')
    expect(updated?.dischargedAt).not.toBeNull()

    const [roomAfter] = await db.select().from(rooms).where(eq(rooms.id, room.id))
    expect(roomAfter.status).toBe('dirty')

    await db.delete(admissions).where(eq(admissions.id, admission.id))
    await db.delete(rooms).where(eq(rooms.id, room.id))
  })

  it('creates a follow-up appointment when one is requested', async () => {
    const db = getDb()
    const [providerRow] = await db.select().from(providers).limit(1)
    const [patientRow] = await db.select().from(patients).limit(1)
    const admission = await createAdmission({ patientId: patientRow.id, roomId: null, attendingProviderId: providerRow.id, admissionType: 'elective', createdFromAssignmentId: null })

    const startsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    const endsAt = new Date(startsAt.getTime() + 30 * 60 * 1000)
    const result = await dischargeAdmission(admission.id, {
      dischargeDiagnosis: 'Test', dischargeDrugs: 'Test', dischargeDevices: 'Test', dischargeDiet: 'Test', dischargeSummaryNotes: 'Test',
      followUp: { startsAt, endsAt },
    })
    expect(result.ok).toBe(true)

    const updated = await getAdmissionById(admission.id)
    expect(updated?.followUpAppointmentId).not.toBeNull()
    const [appt] = await db.select().from(appointments).where(eq(appointments.id, updated!.followUpAppointmentId!))
    expect(appt.patientId).toBe(patientRow.id)

    await db.delete(admissions).where(eq(admissions.id, admission.id))
    await db.delete(appointments).where(eq(appointments.id, appt.id))
  })

  it('rejects discharging an admission that is already discharged', async () => {
    const db = getDb()
    const [providerRow] = await db.select().from(providers).limit(1)
    const [patientRow] = await db.select().from(patients).limit(1)
    const admission = await createAdmission({ patientId: patientRow.id, roomId: null, attendingProviderId: providerRow.id, admissionType: 'elective', createdFromAssignmentId: null })
    await dischargeAdmission(admission.id, { dischargeDiagnosis: 'A', dischargeDrugs: 'B', dischargeDevices: 'C', dischargeDiet: 'D', dischargeSummaryNotes: 'E', followUp: null })

    const secondResult = await dischargeAdmission(admission.id, { dischargeDiagnosis: 'A', dischargeDrugs: 'B', dischargeDevices: 'C', dischargeDiet: 'D', dischargeSummaryNotes: 'E', followUp: null })
    expect(secondResult.ok).toBe(false)

    await db.delete(admissions).where(eq(admissions.id, admission.id))
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/admissions.test.ts`
Expected: FAIL — `dischargeAdmission` doesn't exist yet.

- [ ] **Step 3: Implement `dischargeAdmission`**

In `src/lib/queries/admissions.ts`, add `appointments` to the top-of-file `@/db/schema` import (by now it should read `import { admissions, admissionTransfers, rooms, appointments } from '@/db/schema'` — do not add a second import statement for the same module). Then append to the file:

```ts
export interface DischargeInput {
  dischargeDiagnosis: string
  dischargeDrugs: string
  dischargeDevices: string
  dischargeDiet: string
  dischargeSummaryNotes: string
  followUp: { startsAt: Date; endsAt: Date } | null
}

export interface DischargeResult {
  ok: boolean
  error?: string
  followUpAppointmentId?: number
}

// Sequential, not transactional -- same driver limitation noted on
// transferAdmission. Order: mark the admission discharged FIRST (the
// single authoritative state change), then free the room, then create the
// optional follow-up appointment. If the process dies after the first step,
// the admission is correctly discharged and only the room-freeing or
// appointment-creation is left incomplete -- a visible, fixable state, never
// a room silently left occupied by a patient the record says already left,
// or a "successful" discharge that silently kept the room occupied.
export async function dischargeAdmission(admissionId: number, input: DischargeInput): Promise<DischargeResult> {
  const db = getDb()
  const admission = await getAdmissionById(admissionId)
  if (!admission) return { ok: false, error: 'Admission not found' }
  if (admission.status !== 'admitted') return { ok: false, error: 'This admission has already been discharged' }

  await db.update(admissions).set({
    status: 'discharged',
    dischargedAt: new Date(),
    currentRoomId: null,
    dischargeDiagnosis: input.dischargeDiagnosis,
    dischargeDrugs: input.dischargeDrugs,
    dischargeDevices: input.dischargeDevices,
    dischargeDiet: input.dischargeDiet,
    dischargeSummaryNotes: input.dischargeSummaryNotes,
  }).where(eq(admissions.id, admissionId))

  if (admission.currentRoomId !== null) {
    await db.update(rooms).set({ status: 'dirty', occupiedByPatientId: null }).where(eq(rooms.id, admission.currentRoomId))
  }

  let followUpAppointmentId: number | undefined
  if (input.followUp) {
    const [appt] = await db.insert(appointments).values({
      patientId: admission.patientId,
      providerId: admission.attendingProviderId,
      startsAt: input.followUp.startsAt,
      endsAt: input.followUp.endsAt,
      visitReason: 'Post-discharge follow-up',
      status: 'scheduled',
    }).returning()
    followUpAppointmentId = appt.id
    await db.update(admissions).set({ followUpAppointmentId: appt.id }).where(eq(admissions.id, admissionId))
  }

  return { ok: true, followUpAppointmentId }
}
```

- [ ] **Step 4: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/admissions.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Write the failing route test**

Create `tests/api/inpatient-admissions-discharge.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { POST } from '@/app/api/inpatient/admissions/[id]/discharge/route'
import { getDb } from '@/db/client'
import { admissions, providers, patients, appointments } from '@/db/schema'
import { createAdmission } from '@/lib/queries/admissions'
import { hasSchedulingConflict } from '@/lib/queries/appointments'

let sessionRole: 'admin' | 'pi' | 'frontdesk' = 'pi'
let sessionName = 'Dr. Chen'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: sessionName })) }))
vi.mock('@/lib/queries/providers', () => ({ listActiveProviders: vi.fn(async () => [{ id: 1, name: 'Dr. Chen', credentials: null, specialty: 'Internal Medicine', colorTag: '#000', isActive: true }]) }))

const createdAdmissionIds: number[] = []
const createdAppointmentIds: number[] = []
afterEach(async () => {
  sessionRole = 'pi'
  sessionName = 'Dr. Chen'
  while (createdAppointmentIds.length > 0) await getDb().delete(appointments).where(eq(appointments.id, createdAppointmentIds.pop()!))
  while (createdAdmissionIds.length > 0) await getDb().delete(admissions).where(eq(admissions.id, createdAdmissionIds.pop()!))
})

describe('POST /api/inpatient/admissions/[id]/discharge', () => {
  it('rejects a discharge missing a required field', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const admission = await createAdmission({ patientId: patientRow.id, roomId: null, attendingProviderId: 1, admissionType: 'elective', createdFromAssignmentId: null })
    createdAdmissionIds.push(admission.id)

    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ dischargeDiagnosis: 'A', dischargeDrugs: 'B', dischargeDevices: 'C', dischargeDiet: '', dischargeSummaryNotes: 'E' }) })
    const res = await POST(req as never, { params: Promise.resolve({ id: String(admission.id) }) })
    expect(res.status).toBe(400)
  })

  it('discharges successfully with all five fields present, no follow-up', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const admission = await createAdmission({ patientId: patientRow.id, roomId: null, attendingProviderId: 1, admissionType: 'elective', createdFromAssignmentId: null })
    createdAdmissionIds.push(admission.id)

    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ dischargeDiagnosis: 'A', dischargeDrugs: 'B', dischargeDevices: 'C', dischargeDiet: 'D', dischargeSummaryNotes: 'E' }) })
    const res = await POST(req as never, { params: Promise.resolve({ id: String(admission.id) }) })
    expect(res.status).toBe(200)
  })

  it('rejects a PI discharging an admission they are not the attending provider for', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const admission = await createAdmission({ patientId: patientRow.id, roomId: null, attendingProviderId: 999, admissionType: 'elective', createdFromAssignmentId: null })
    createdAdmissionIds.push(admission.id)

    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ dischargeDiagnosis: 'A', dischargeDrugs: 'B', dischargeDevices: 'C', dischargeDiet: 'D', dischargeSummaryNotes: 'E' }) })
    const res = await POST(req as never, { params: Promise.resolve({ id: String(admission.id) }) })
    expect(res.status).toBe(403)
  })

  it('rejects discharging an already-discharged admission', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const admission = await createAdmission({ patientId: patientRow.id, roomId: null, attendingProviderId: 1, admissionType: 'elective', createdFromAssignmentId: null })
    createdAdmissionIds.push(admission.id)
    const body = JSON.stringify({ dischargeDiagnosis: 'A', dischargeDrugs: 'B', dischargeDevices: 'C', dischargeDiet: 'D', dischargeSummaryNotes: 'E' })
    await POST(new Request('http://localhost', { method: 'POST', body }) as never, { params: Promise.resolve({ id: String(admission.id) }) })

    const res = await POST(new Request('http://localhost', { method: 'POST', body }) as never, { params: Promise.resolve({ id: String(admission.id) }) })
    expect(res.status).toBe(409)
  })
})
```

- [ ] **Step 6: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/inpatient-admissions-discharge.test.ts`
Expected: FAIL — the route doesn't exist yet.

- [ ] **Step 7: Implement the route**

Create `src/app/api/inpatient/admissions/[id]/discharge/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getAdmissionById, dischargeAdmission } from '@/lib/queries/admissions'
import { listActiveProviders } from '@/lib/queries/providers'
import { hasSchedulingConflict } from '@/lib/queries/appointments'

const dischargeSchema = z.object({
  dischargeDiagnosis: z.string().min(1),
  dischargeDrugs: z.string().min(1),
  dischargeDevices: z.string().min(1),
  dischargeDiet: z.string().min(1),
  dischargeSummaryNotes: z.string().min(1),
  followUpStartsAt: z.string().min(1).optional(),
  followUpEndsAt: z.string().min(1).optional(),
}).strict()

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['pi', 'admin'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const admissionId = Number(id)
  if (!Number.isInteger(admissionId)) return NextResponse.json({ error: 'Invalid admission id' }, { status: 400 })

  const parsed = dischargeSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid discharge payload', details: parsed.error.flatten() }, { status: 400 })

  const admission = await getAdmissionById(admissionId)
  if (!admission) return NextResponse.json({ error: 'Admission not found' }, { status: 404 })

  if (session.role === 'pi') {
    const lastName = session.name.trim().split(/\s+/).pop() ?? session.name
    const providersList = await listActiveProviders()
    const providerMatch = providersList.find((p) => p.name.toLowerCase().includes(lastName.toLowerCase()))
    if (!providerMatch || admission.attendingProviderId !== providerMatch.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  let followUp: { startsAt: Date; endsAt: Date } | null = null
  if (parsed.data.followUpStartsAt && parsed.data.followUpEndsAt) {
    const startsAt = new Date(parsed.data.followUpStartsAt)
    const endsAt = new Date(parsed.data.followUpEndsAt)
    if (isNaN(startsAt.getTime()) || isNaN(endsAt.getTime()) || endsAt <= startsAt) {
      return NextResponse.json({ error: 'followUpEndsAt must be a valid time after followUpStartsAt' }, { status: 400 })
    }
    if (await hasSchedulingConflict(admission.attendingProviderId, startsAt, endsAt)) {
      return NextResponse.json({ error: 'The attending provider already has an appointment during that time.' }, { status: 409 })
    }
    followUp = { startsAt, endsAt }
  }

  const result = await dischargeAdmission(admissionId, {
    dischargeDiagnosis: parsed.data.dischargeDiagnosis,
    dischargeDrugs: parsed.data.dischargeDrugs,
    dischargeDevices: parsed.data.dischargeDevices,
    dischargeDiet: parsed.data.dischargeDiet,
    dischargeSummaryNotes: parsed.data.dischargeSummaryNotes,
    followUp,
  })
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.error === 'Admission not found' ? 404 : 409 })
  }

  await logAudit(session, 'discharged patient', admission.patientId)
  return NextResponse.json({ ok: true, followUpAppointmentId: result.followUpAppointmentId ?? null })
}
```

- [ ] **Step 8: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/inpatient-admissions-discharge.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 9: Build the `DischargeAdmissionModal` component**

Create `src/components/DischargeAdmissionModal.tsx`:

```tsx
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

type Step = 'summary' | 'followup' | 'confirmation'

// 3-step flow following Headspace's appointment stepper
// (https://mobbin.com/screens/c9b2bbdc-2976-46da-ba9a-e23f662f3d7e) for
// steps 1-2, and Cal.com's confirmation card
// (https://mobbin.com/screens/9d826d23-ed7e-4ec6-9f7f-c2b23f7d8f2a) for
// step 3. All fields are collected across steps 1-2 and sent in a single
// API call when leaving step 2 -- never once per step.
export function DischargeAdmissionModal({ admissionId, onClose }: { admissionId: number; onClose: () => void }) {
  const router = useRouter()
  const [step, setStep] = useState<Step>('summary')
  const [dischargeDiagnosis, setDischargeDiagnosis] = useState('')
  const [dischargeDrugs, setDischargeDrugs] = useState('')
  const [dischargeDevices, setDischargeDevices] = useState('')
  const [dischargeDiet, setDischargeDiet] = useState('')
  const [dischargeSummaryNotes, setDischargeSummaryNotes] = useState('')
  const [followUpDate, setFollowUpDate] = useState('')
  const [followUpTime, setFollowUpTime] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [followUpCreated, setFollowUpCreated] = useState(false)

  const summaryComplete = Boolean(dischargeDiagnosis && dischargeDrugs && dischargeDevices && dischargeDiet && dischargeSummaryNotes)

  async function submit() {
    setSubmitting(true)
    setError(null)
    let followUpStartsAt: string | undefined
    let followUpEndsAt: string | undefined
    if (followUpDate && followUpTime) {
      const start = new Date(`${followUpDate}T${followUpTime}`)
      followUpStartsAt = start.toISOString()
      followUpEndsAt = new Date(start.getTime() + 30 * 60 * 1000).toISOString()
    }
    const res = await fetch(`/api/inpatient/admissions/${admissionId}/discharge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dischargeDiagnosis, dischargeDrugs, dischargeDevices, dischargeDiet, dischargeSummaryNotes, ...(followUpStartsAt ? { followUpStartsAt, followUpEndsAt } : {}) }),
    })
    setSubmitting(false)
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      setError(body?.error ?? 'Could not discharge this patient.')
      return
    }
    const body = await res.json()
    setFollowUpCreated(Boolean(body.followUpAppointmentId))
    setStep('confirmation')
    router.refresh()
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Discharge Patient</DialogTitle>
        </DialogHeader>

        <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
          <span className={step === 'summary' ? 'font-semibold text-foreground' : ''}>1. Discharge summary</span>
          <span>→</span>
          <span className={step === 'followup' ? 'font-semibold text-foreground' : ''}>2. Follow-up</span>
          <span>→</span>
          <span className={step === 'confirmation' ? 'font-semibold text-foreground' : ''}>3. Confirmation</span>
        </div>

        {step === 'summary' && (
          <div className="space-y-2">
            <input value={dischargeDiagnosis} onChange={(e) => setDischargeDiagnosis(e.target.value)} placeholder="Diagnosis" aria-label="Diagnosis" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
            <input value={dischargeDrugs} onChange={(e) => setDischargeDrugs(e.target.value)} placeholder="Drugs (discharge medications)" aria-label="Drugs" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
            <input value={dischargeDevices} onChange={(e) => setDischargeDevices(e.target.value)} placeholder="Devices (e.g. None, or Wound VAC)" aria-label="Devices" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
            <input value={dischargeDiet} onChange={(e) => setDischargeDiet(e.target.value)} placeholder="Diet" aria-label="Diet" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
            <textarea value={dischargeSummaryNotes} onChange={(e) => setDischargeSummaryNotes(e.target.value)} placeholder="Discharge summary notes" aria-label="Discharge summary notes" className="w-full rounded-md border border-border px-3 py-2 text-sm" rows={3} />
          </div>
        )}

        {step === 'followup' && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">Optional — schedule a follow-up with the attending provider.</p>
            <input type="date" value={followUpDate} onChange={(e) => setFollowUpDate(e.target.value)} aria-label="Follow-up date" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
            <input type="time" value={followUpTime} onChange={(e) => setFollowUpTime(e.target.value)} aria-label="Follow-up time" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          </div>
        )}

        {step === 'confirmation' && (
          <div className="space-y-2 text-sm">
            <p className="flex items-center gap-2 font-semibold text-success"><span className="flex h-6 w-6 items-center justify-center rounded-full bg-success/15">✓</span> Patient discharged</p>
            <p className="text-muted-foreground">The room has been freed and marked for cleaning.</p>
            {followUpCreated && <p className="text-muted-foreground">A follow-up appointment was scheduled with the attending provider.</p>}
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          {step === 'summary' && (<>
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={() => setStep('followup')} disabled={!summaryComplete}>Next</Button>
          </>)}
          {step === 'followup' && (<>
            <Button variant="outline" onClick={() => setStep('summary')}>Back</Button>
            <Button onClick={submit} disabled={submitting}>Discharge</Button>
          </>)}
          {step === 'confirmation' && <Button onClick={onClose}>Done</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 10: Run `npx tsc --noEmit` and `npx eslint`**

Expected: clean.

- [ ] **Step 11: Commit**

```bash
git add src/lib/queries/admissions.ts src/app/api/inpatient/admissions/\[id\]/discharge src/components/DischargeAdmissionModal.tsx tests/lib/queries/admissions.test.ts tests/api/inpatient-admissions-discharge.test.ts
git commit -m "feat: add inpatient discharge workflow with the 5 D's and optional follow-up"
```

---

### Task 6: Patient stay timeline

**Files:**
- Modify: `src/app/(dashboard)/patients/[anonId]/page.tsx`
- Test: manual verification (Server Component page composition; the underlying `listAdmissionsForPatient` query is already tested in Task 2) plus one new test asserting the page includes the tab.

**Interfaces:**
- Consumes: `listAdmissionsForPatient` from `@/lib/queries/admissions` (Task 2); `listAvailableRooms` from `@/lib/queries/rooms` (existing); `TransferAdmissionModal` (Task 4), `DischargeAdmissionModal` (Task 5).

- [ ] **Step 1: Write the failing test**

Create `tests/app/patient-detail-inpatient-tab.test.tsx` (uses `@testing-library/react` the same way other page-composition tests in this codebase do — check `tests/app/` for the existing convention and mirror it exactly; if no such convention exists yet in `tests/app/`, write this as a plain assertion against the rendered HTML string via React's server-render, matching whatever pattern the codebase already uses elsewhere for Server Component pages — if truly no precedent exists, skip the automated test for the tab's presence and note this explicitly in the report, relying on the manual verification in Step 5 instead, since inventing a new testing convention for a single page-composition check is out of scope for this task):

```ts
// If a Server Component page-rendering test precedent exists in this
// codebase's tests/app/ (or equivalent) directory, mirror it here to assert
// that PatientDetailPage's tab list includes an "Inpatient" tab when the
// patient has at least one admission. If no such precedent exists, skip
// this file and rely on Step 5's manual verification instead -- do not
// invent a new page-testing pattern for one check.
```

- [ ] **Step 2: Check for a Server Component page-test precedent, then implement**

Run: `ls tests/app/ 2>/dev/null || echo "no tests/app directory"` to check for precedent before deciding whether Step 1's test file is written for real or skipped per its own note.

In `src/app/(dashboard)/patients/[anonId]/page.tsx`:

Add these imports:

```ts
import { BedDouble } from 'lucide-react'
import { listAdmissionsForPatient } from '@/lib/queries/admissions'
import { listAvailableRooms } from '@/lib/queries/rooms'
import { InpatientHistoryPanel } from '@/components/InpatientHistoryPanel'
```

After the line `const patient = await getPatientDetail(anonId)` and its `if (!patient) notFound()` check, add:

```ts
  const [admissionHistory, availableRooms] = await Promise.all([listAdmissionsForPatient(anonId), listAvailableRooms()])
```

Add a new tab content block, right after `identityAndPortalTab`'s closing `)`:

```tsx
  const inpatientTab = (
    <InpatientHistoryPanel
      admissions={admissionHistory.map((a) => ({
        id: a.id,
        status: a.status,
        admissionType: a.admissionType,
        admittedAt: a.admittedAt.toString(),
        dischargedAt: a.dischargedAt?.toString() ?? null,
        dischargeDiagnosis: a.dischargeDiagnosis,
        dischargeDrugs: a.dischargeDrugs,
        dischargeDevices: a.dischargeDevices,
        dischargeDiet: a.dischargeDiet,
        dischargeSummaryNotes: a.dischargeSummaryNotes,
        transfers: a.transfers.map((t) => ({ id: t.id, fromRoomId: t.fromRoomId, toRoomId: t.toRoomId, reason: t.reason, transferredByName: t.transferredByName, transferredAt: t.transferredAt.toString() })),
      }))}
      availableRooms={availableRooms}
      canTransfer={['frontdesk', 'admin', 'crc', 'pi'].includes(session.role)}
      canDischarge={['pi', 'admin'].includes(session.role)}
    />
  )
```

And add the tab to the `Tabs` list (only when there's history, so patients with no inpatient stays don't show an empty tab):

```tsx
      <Tabs tabs={[
        { id: 'overview', label: 'Overview', content: overviewTab },
        { id: 'screening', label: 'Screening', content: screeningTab },
        { id: 'identity', label: 'Verification', content: identityAndPortalTab },
        ...(admissionHistory.length > 0 ? [{ id: 'inpatient', label: 'Inpatient History', content: inpatientTab }] : []),
      ]} />
```

- [ ] **Step 3: Build the `InpatientHistoryPanel` component**

Create `src/components/InpatientHistoryPanel.tsx`:

```tsx
'use client'
import { useState } from 'react'
import { TransferAdmissionModal } from '@/components/TransferAdmissionModal'
import { DischargeAdmissionModal } from '@/components/DischargeAdmissionModal'
import { Button } from '@/components/ui/button'

interface TransferRecord { id: number; fromRoomId: number | null; toRoomId: number; reason: string; transferredByName: string; transferredAt: string }
interface AdmissionRecord {
  id: number
  status: 'admitted' | 'discharged'
  admissionType: string
  admittedAt: string
  dischargedAt: string | null
  dischargeDiagnosis: string | null
  dischargeDrugs: string | null
  dischargeDevices: string | null
  dischargeDiet: string | null
  dischargeSummaryNotes: string | null
  transfers: TransferRecord[]
}
interface RoomOption { id: number; ward: string; roomNumber: string; bedNumber: string }

export function InpatientHistoryPanel({ admissions, availableRooms, canTransfer, canDischarge }: { admissions: AdmissionRecord[]; availableRooms: RoomOption[]; canTransfer: boolean; canDischarge: boolean }) {
  const [transferFor, setTransferFor] = useState<number | null>(null)
  const [dischargeFor, setDischargeFor] = useState<number | null>(null)

  return (
    <div className="space-y-4">
      {admissions.map((a) => (
        <section key={a.id} className="rounded-xl border border-primary/10 bg-card/80 p-5 shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-semibold text-foreground">
              {a.status === 'admitted' ? 'Currently admitted' : 'Discharged'} — admitted {new Date(a.admittedAt).toLocaleDateString()}
              {a.dischargedAt && ` · discharged ${new Date(a.dischargedAt).toLocaleDateString()}`}
            </p>
            <span className="rounded-full bg-secondary px-2 py-0.5 text-xs capitalize text-muted-foreground">{a.admissionType.replace('_', ' ')}</span>
          </div>

          {a.status === 'admitted' && (canTransfer || canDischarge) && (
            <div className="mb-3 flex gap-2">
              {canTransfer && <Button size="sm" variant="outline" onClick={() => setTransferFor(a.id)}>Transfer</Button>}
              {canDischarge && <Button size="sm" onClick={() => setDischargeFor(a.id)}>Discharge</Button>}
            </div>
          )}

          {a.status === 'discharged' && (
            <div className="mb-3 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
              <p><span className="font-semibold text-foreground">Diagnosis:</span> {a.dischargeDiagnosis}</p>
              <p><span className="font-semibold text-foreground">Drugs:</span> {a.dischargeDrugs}</p>
              <p><span className="font-semibold text-foreground">Devices:</span> {a.dischargeDevices}</p>
              <p><span className="font-semibold text-foreground">Diet:</span> {a.dischargeDiet}</p>
              {a.dischargeSummaryNotes && <p className="col-span-2"><span className="font-semibold text-foreground">Notes:</span> {a.dischargeSummaryNotes}</p>}
            </div>
          )}

          {a.transfers.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Room history</p>
              <ul className="space-y-1 text-xs text-muted-foreground">
                {a.transfers.map((t) => (
                  <li key={t.id}>{new Date(t.transferredAt).toLocaleString()} — {t.fromRoomId ? `Room #${t.fromRoomId}` : 'Boarding'} → Room #{t.toRoomId} ({t.reason}, by {t.transferredByName})</li>
                ))}
              </ul>
            </div>
          )}

          {transferFor === a.id && <TransferAdmissionModal admissionId={a.id} availableRooms={availableRooms} onClose={() => setTransferFor(null)} />}
          {dischargeFor === a.id && <DischargeAdmissionModal admissionId={a.id} onClose={() => setDischargeFor(null)} />}
        </section>
      ))}
    </div>
  )
}
```

- [ ] **Step 4: Run `npx tsc --noEmit` and `npx eslint`**

Expected: clean.

- [ ] **Step 5: Manual verification**

Start the dev server (`npm run dev`, or reuse the one already running in this session), and as an `admin` or `pi` session, open a Patient Detail page for a patient with at least one admission created via Task 2's check-in flow. Confirm: the "Inpatient History" tab appears; Transfer and Discharge buttons are visible/hidden per role; completing a transfer or discharge actually updates the bed board at `/inpatient/beds`; a patient with zero admissions shows no "Inpatient History" tab at all.

- [ ] **Step 6: Run the full test suite for files this whole plan touched**

Run: `npx dotenv -e .env.local -- npx vitest run tests/db/inpatient-schema.test.ts tests/lib/queries/admissions.test.ts tests/api/front-desk-check-in.test.ts tests/lib/queries/delete-patient-admissions.test.ts tests/api/inpatient-rooms-lifecycle.test.ts tests/api/inpatient-admissions-transfer.test.ts tests/api/inpatient-admissions-discharge.test.ts`
Expected: all pass (retry/psql-fallback per Global Constraints for anything that stays red).

- [ ] **Step 7: Commit**

```bash
git add "src/app/(dashboard)/patients/[anonId]/page.tsx" src/components/InpatientHistoryPanel.tsx
git commit -m "feat: add patient stay timeline with transfer/discharge actions"
```

---

*After all 6 tasks are complete and the final whole-branch review is clean, use superpowers:finishing-a-development-branch to merge locally — do not push to origin/master without the user's explicit go-ahead each time, per this session's established practice. Next up after this plan (per the user's explicit instruction, ahead of the Pharmacy sub-project): a dedicated Mobbin-driven UI redesign pass across every existing dashboard, not just newly built screens.*
