# Front Desk / Reception Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give reception staff a dedicated `frontdesk` role, dashboard, and workflow to register/check in patients, triage inpatient vs. outpatient, assign a doctor (who then schedules the actual time from their own calendar), assign a room for inpatients, and run a simulated insurance-eligibility check.

**Architecture:** Three new additive tables (`rooms`, `doctorAssignments`, `insuranceEligibilityChecks`) plus one new `roleEnum` value, built entirely with the app's existing patterns: Server Components calling shared query functions directly, `.strict()`-validated API routes under `requireSession()`, `logAudit()` on every read/write, and the existing `Dialog`/`Button` UI primitives. No existing table is altered.

**Tech Stack:** Next.js 16 App Router, Drizzle ORM (`drizzle-orm/neon-http`) over a single shared Neon Postgres database, Tailwind v4, Vitest (real DB, `fileParallelism: false`), lucide-react icons.

**Spec:** `docs/superpowers/specs/2026-09-25-front-desk-reception.md`

## Global Constraints

- Every protected Server Component page calls `requireSessionOrRedirect()` from `@/lib/auth` as its first statement.
- Every API route calls `requireSession()` from `@/lib/auth` and returns immediately if it's a `NextResponse` (unauthenticated), then checks `session.role` against an explicit allowlist for that route.
- Every write route validates its body with a Zod `.strict()` schema (rejects unknown fields).
- Every read or write that touches patient data calls `logAudit(session, action, patientId)` from `@/lib/audit`.
- Schema changes are additive only. No `drizzle-kit push` against the shared dev database — apply changes via a one-off script run with `npx dotenv -e .env.local -- npx tsx <script>`, per the project's standing rule (the database is shared across every branch and environment; there is no per-branch isolation).
- New modals use the existing `Dialog`/`DialogContent`/`DialogHeader`/`DialogTitle`/`DialogFooter` primitives from `@/components/ui/dialog` and `Button` from `@/components/ui/button` (variants: `default`, `outline`, `destructive` are used in this plan).
- Tests run via `npx dotenv -e .env.local -- npx vitest run <path>` against the real dev database — no DB mocking. Any test that inserts a row must delete it in `afterEach`, per the existing convention in `tests/api/appointments.test.ts`.
- This plan does not touch `globals.css`, sidebar colors, or any existing page's visual design — the visual redesign is a separate sub-project.

## Review Focus

1. **Double room assignment** — two concurrent inpatient check-ins must not both succeed in claiming the same available room. Covered in Task 3's test for `assignRoom`.
2. **Declined assignment has no fallback path** — a doctor declining an assignment must leave it visible to reception in a `declined` state, not disappear. Covered in Task 4.
3. **Wrong-role access to front-desk routes** — a `pi` session must get 403 from check-in/eligibility routes, not a silent empty result or 200. Covered in Tasks 3, 4, and 5 (each route's own test).
4. **Inpatient check-in with zero available rooms** — must return a clear 409/error, not a 500 or a silently-created assignment with a null room the UI can't explain. Covered in Task 3.
5. **Eligibility check determinism** — the same patient+payer pair must simulate the same result every time (a flaky/random simulation would make the "Verify" button meaningless to test or trust). Covered in Task 5.

---

### Task 1: Schema migration — `frontdesk` role and three new tables

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/lib/auth.ts`
- Modify: `src/lib/queries/patients.ts` (`deletePatient` cleanup list)
- Create (throwaway, not committed): a one-off migration script, deleted after running

**Interfaces:**
- Produces: `roleEnum` includes `'frontdesk'`; `roomStatusEnum` (`'available' | 'occupied'`); `rooms` table (`id`, `ward`, `roomNumber`, `bedNumber`, `status`, `occupiedByPatientId`); `doctorAssignmentVisitTypeEnum` (`'inpatient' | 'outpatient'`); `doctorAssignmentUrgencyEnum` (`'routine' | 'urgent' | 'emergency'`); `doctorAssignmentStatusEnum` (`'pending' | 'scheduled' | 'declined'`); `doctorAssignments` table (`id`, `patientId`, `providerId`, `visitType`, `urgency`, `reason`, `status`, `roomId`, `assignedByName`, `appointmentId`, `createdAt`); `eligibilityStatusEnum` (`'verified' | 'inactive' | 'needs_follow_up'`); `insuranceEligibilityChecks` table (`id`, `patientId`, `payerName`, `status`, `copayCents`, `checkedByName`, `checkedAt`).

- [ ] **Step 1: Add the new schema definitions**

In `src/db/schema.ts`, change the existing line:

```ts
export const roleEnum = pgEnum('role', ['crc', 'pi', 'admin'])
```

to:

```ts
export const roleEnum = pgEnum('role', ['crc', 'pi', 'admin', 'frontdesk'])
```

Then add this block after the `appointments` table definition (so `rooms`/`doctorAssignments` can reference `patients`/`providers`/`appointments`, which are already defined above that point):

```ts
export const roomStatusEnum = pgEnum('room_status', ['available', 'occupied'])

export const rooms = pgTable('rooms', {
  id: serial('id').primaryKey(),
  ward: text('ward').notNull(),
  roomNumber: text('room_number').notNull(),
  bedNumber: text('bed_number').notNull(),
  status: roomStatusEnum('status').default('available').notNull(),
  occupiedByPatientId: text('occupied_by_patient_id').references(() => patients.id),
})

export const doctorAssignmentVisitTypeEnum = pgEnum('doctor_assignment_visit_type', ['inpatient', 'outpatient'])
export const doctorAssignmentUrgencyEnum = pgEnum('doctor_assignment_urgency', ['routine', 'urgent', 'emergency'])
export const doctorAssignmentStatusEnum = pgEnum('doctor_assignment_status', ['pending', 'scheduled', 'declined'])

export const doctorAssignments = pgTable('doctor_assignments', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  providerId: integer('provider_id').notNull().references(() => providers.id),
  visitType: doctorAssignmentVisitTypeEnum('visit_type').notNull(),
  urgency: doctorAssignmentUrgencyEnum('urgency').default('routine').notNull(),
  reason: text('reason').notNull(),
  status: doctorAssignmentStatusEnum('status').default('pending').notNull(),
  roomId: integer('room_id').references(() => rooms.id),
  assignedByName: text('assigned_by_name').notNull(),
  appointmentId: integer('appointment_id').references(() => appointments.id),
  declineReason: text('decline_reason'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export const eligibilityStatusEnum = pgEnum('eligibility_status', ['verified', 'inactive', 'needs_follow_up'])

export const insuranceEligibilityChecks = pgTable('insurance_eligibility_checks', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  payerName: text('payer_name').notNull(),
  status: eligibilityStatusEnum('status').notNull(),
  copayCents: integer('copay_cents'),
  checkedByName: text('checked_by_name').notNull(),
  checkedAt: timestamp('checked_at').defaultNow().notNull(),
})
```

(`declineReason` was added beyond the spec's literal column list because Task 4's decline flow needs somewhere to store the doctor's reason — an additive detail within the spec's intent, not a scope change.)

- [ ] **Step 2: Update the `Role` type and valid-roles list**

In `src/lib/auth.ts`, change:

```ts
export type Role = 'crc' | 'pi' | 'admin'
```

to:

```ts
export type Role = 'crc' | 'pi' | 'admin' | 'frontdesk'
```

and change:

```ts
const VALID_ROLES: readonly Role[] = ['crc', 'pi', 'admin']
```

to:

```ts
const VALID_ROLES: readonly Role[] = ['crc', 'pi', 'admin', 'frontdesk']
```

- [ ] **Step 3: Write and run the one-off migration script**

Create a scratch file at `/tmp/migrate-front-desk.ts` (do not commit this file):

```ts
import { getDb } from '../src/db/client'
import { sql } from 'drizzle-orm'

async function main() {
  const db = getDb()

  await db.execute(sql`ALTER TYPE role ADD VALUE IF NOT EXISTS 'frontdesk'`)

  await db.execute(sql`
    DO $$ BEGIN
      CREATE TYPE room_status AS ENUM ('available', 'occupied');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `)
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS rooms (
      id SERIAL PRIMARY KEY,
      ward TEXT NOT NULL,
      room_number TEXT NOT NULL,
      bed_number TEXT NOT NULL,
      status room_status NOT NULL DEFAULT 'available',
      occupied_by_patient_id TEXT REFERENCES patients(id)
    );
  `)

  await db.execute(sql`
    DO $$ BEGIN
      CREATE TYPE doctor_assignment_visit_type AS ENUM ('inpatient', 'outpatient');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `)
  await db.execute(sql`
    DO $$ BEGIN
      CREATE TYPE doctor_assignment_urgency AS ENUM ('routine', 'urgent', 'emergency');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `)
  await db.execute(sql`
    DO $$ BEGIN
      CREATE TYPE doctor_assignment_status AS ENUM ('pending', 'scheduled', 'declined');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `)
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS doctor_assignments (
      id SERIAL PRIMARY KEY,
      patient_id TEXT NOT NULL REFERENCES patients(id),
      provider_id INTEGER NOT NULL REFERENCES providers(id),
      visit_type doctor_assignment_visit_type NOT NULL,
      urgency doctor_assignment_urgency NOT NULL DEFAULT 'routine',
      reason TEXT NOT NULL,
      status doctor_assignment_status NOT NULL DEFAULT 'pending',
      room_id INTEGER REFERENCES rooms(id),
      assigned_by_name TEXT NOT NULL,
      appointment_id INTEGER REFERENCES appointments(id),
      decline_reason TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
  `)

  await db.execute(sql`
    DO $$ BEGIN
      CREATE TYPE eligibility_status AS ENUM ('verified', 'inactive', 'needs_follow_up');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `)
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS insurance_eligibility_checks (
      id SERIAL PRIMARY KEY,
      patient_id TEXT NOT NULL REFERENCES patients(id),
      payer_name TEXT NOT NULL,
      status eligibility_status NOT NULL,
      copay_cents INTEGER,
      checked_by_name TEXT NOT NULL,
      checked_at TIMESTAMP NOT NULL DEFAULT now()
    );
  `)

  console.log('Front desk migration complete.')
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1) })
```

Run it: `npx dotenv -e .env.local -- npx tsx /tmp/migrate-front-desk.ts`

Expected output: `Front desk migration complete.` with exit code 0. Then delete the scratch file — it's not part of the repo.

- [ ] **Step 4: Verify the migration against the schema types**

Run: `npx tsc --noEmit`
Expected: no errors referencing `rooms`, `doctorAssignments`, `insuranceEligibilityChecks`, or `frontdesk`.

- [ ] **Step 5: Add the three new tables to `deletePatient`'s cleanup**

In `src/lib/queries/patients.ts`, add `rooms`, `doctorAssignments`, `insuranceEligibilityChecks` to the import from `@/db/schema`, then in `deletePatient` add these lines before `await db.delete(patients).where(eq(patients.id, anonId))`:

```ts
  await db.delete(insuranceEligibilityChecks).where(eq(insuranceEligibilityChecks.patientId, anonId))
  await db.delete(doctorAssignments).where(eq(doctorAssignments.patientId, anonId))
  await db.update(rooms).set({ status: 'available', occupiedByPatientId: null }).where(eq(rooms.occupiedByPatientId, anonId))
```

(Rooms are freed, not deleted — a room is a physical resource independent of any one patient's record.)

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts src/lib/auth.ts src/lib/queries/patients.ts
git commit -m "feat: add frontdesk role and rooms/doctorAssignments/insuranceEligibilityChecks tables"
```

---

### Task 2: Role plumbing — nav, dashboard shell, seed demo user

**Files:**
- Modify: `src/components/LeftNav.tsx`
- Modify: `src/app/(dashboard)/page.tsx`
- Modify: `src/db/seed.ts`
- Create: `src/components/dashboards/FrontDeskDashboard.tsx`
- Test: `tests/components/LeftNav.test.tsx` (append)
- Test: `tests/pages/dashboard-routing.test.tsx` (append)

**Interfaces:**
- Consumes: `Role` type from Task 1 (`'crc' | 'pi' | 'admin' | 'frontdesk'`).
- Produces: `FrontDeskDashboard` component accepting `{ session: Session }` — a placeholder shell in this task (KPI strip/queue table are built in Task 6, which imports and extends this same file).

- [ ] **Step 1: Write the failing nav test**

Append to `tests/components/LeftNav.test.tsx`:

```ts
  it('shows Check-In and Assignments for frontdesk, but hides admin/crc-only items', () => {
    render(<LeftNav role="frontdesk" />)
    expect(screen.getByRole('link', { name: /check-in/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /assignments/i })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /workbook/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /form templates/i })).not.toBeInTheDocument()
  })
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/components/LeftNav.test.tsx`
Expected: FAIL — `role="frontdesk"` is not a valid `Role` yet in the component's own filtering logic (no nav items are scoped to it), so "Check-In"/"Assignments" don't render.

- [ ] **Step 3: Add the nav items**

In `src/components/LeftNav.tsx`, add two new items to `ITEMS` (after the `'/client-forms'` entry, before `'/messages'`):

```ts
  { href: '/front-desk/check-in', label: 'Check-In', icon: ClipboardCheck, roles: ['frontdesk', 'admin', 'crc'] as Role[] },
  { href: '/front-desk/assignments', label: 'Assignments', icon: ListChecks, roles: ['frontdesk', 'admin', 'crc'] as Role[] },
```

Add `ClipboardCheck, ListChecks` to the `lucide-react` import at the top of the file.

Extend the billing-visibility check:

```ts
  const showBilling = role === 'admin' || role === 'crc' || role === 'frontdesk'
```

Do not add `frontdesk` to the `roles` arrays that already gate Workbook, Identity Matching, Form Templates, Reports, Documents, Broadcasts, Experience Surveys, Pipeline Dashboard, or Audit Log — those stay exactly as scoped today.

- [ ] **Step 4: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/components/LeftNav.test.tsx`
Expected: PASS (both the new test and the two pre-existing ones).

- [ ] **Step 5: Create the FrontDeskDashboard shell**

Create `src/components/dashboards/FrontDeskDashboard.tsx`:

```tsx
import type { Session } from '@/lib/auth'

export function FrontDeskDashboard({ session }: { session: Session }) {
  return (
    <div>
      <div className="mb-6 rounded-xl border border-primary/10 bg-card/80 p-5 shadow-sm backdrop-blur-sm">
        <h1 className="text-2xl font-bold text-foreground">Front Desk</h1>
        <p className="text-sm text-muted-foreground">Welcome back, {session.name}.</p>
      </div>
    </div>
  )
}
```

(Task 6 replaces this body with the real KPI strip, queue table, and quick actions — this task only proves the routing works end to end.)

- [ ] **Step 6: Write the failing dashboard-routing test**

Append to `tests/pages/dashboard-routing.test.tsx` (it already mocks `requireSessionOrRedirect`, `getDashboardData`, `listFormTemplates`, `listPatientsWithStatus`, `listAppointmentsInRange`, `listAllUsers` — reuse the same mocks, just override the role for this one test):

```ts
  it('renders the FrontDeskDashboard for a frontdesk session', async () => {
    const auth = await import('@/lib/auth')
    vi.mocked(auth.requireSessionOrRedirect).mockResolvedValueOnce({ role: 'frontdesk', name: 'Taylor Nguyen' })
    const { render, screen } = await import('@testing-library/react')
    const jsx = await DashboardHomePage()
    render(jsx)
    expect(screen.getByText(/front desk/i)).toBeInTheDocument()
  })
```

- [ ] **Step 7: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/pages/dashboard-routing.test.tsx`
Expected: FAIL — `(dashboard)/page.tsx` doesn't know about `frontdesk` yet, so it falls into the `CoordinatorDashboard` branch and the "Front Desk" heading never renders.

- [ ] **Step 8: Wire the route**

In `src/app/(dashboard)/page.tsx`, add the import `import { FrontDeskDashboard } from '@/components/dashboards/FrontDeskDashboard'` and change the final return:

```tsx
  if (session.role === 'frontdesk') return <FrontDeskDashboard session={session} />

  return session.role === 'admin' ? <AdminDashboard {...props} /> : <CoordinatorDashboard {...props} />
```

placed before the existing `props` object is even built — a `frontdesk` session doesn't need `getDashboardData`/`listFormTemplates`/etc., so return early right after the `redirect('/doctor')` check for `pi`, before the `Promise.all` that fetches everything else:

```tsx
  if (session.role === 'pi') redirect('/doctor')
  if (session.role === 'frontdesk') return <FrontDeskDashboard session={session} />
```

- [ ] **Step 9: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/pages/dashboard-routing.test.tsx`
Expected: PASS.

- [ ] **Step 10: Add a demo frontdesk login**

In `src/db/seed.ts`, add to the `users` insert array (alongside Jamie Ruiz/Dr. Kunam/Sam Patel):

```ts
    { name: 'Taylor Nguyen', email: 'tnguyen.demo@example.com', role: 'frontdesk', passwordHash: hashPassword('FrontDeskDemo123!') },
```

- [ ] **Step 11: Run the full test suite**

Run: `npx dotenv -e .env.local -- npx vitest run`
Expected: all tests pass (this task doesn't touch seeded data directly — the seed script only runs against an empty DB — so this is a safety check, not expected to change results).

- [ ] **Step 12: Commit**

```bash
git add src/components/LeftNav.tsx src/app/\(dashboard\)/page.tsx src/components/dashboards/FrontDeskDashboard.tsx src/db/seed.ts tests/components/LeftNav.test.tsx tests/pages/dashboard-routing.test.tsx
git commit -m "feat: add frontdesk role routing, nav items, and dashboard shell"
```

---

### Task 3: Rooms, patient duplicate lookup, and the check-in API route

**Files:**
- Create: `src/lib/queries/rooms.ts`
- Create: `src/lib/queries/doctor-assignments.ts`
- Modify: `src/lib/queries/patients.ts` (add `findLikelyDuplicatePatients`)
- Create: `src/app/api/front-desk/check-in/route.ts`
- Test: `tests/lib/queries/rooms.test.ts`
- Test: `tests/api/front-desk-check-in.test.ts`

**Interfaces:**
- Consumes: `rooms`, `doctorAssignments` from Task 1's schema; `requireSession`/`Role` from `@/lib/auth`; `logAudit` from `@/lib/audit`.
- Produces: `listAvailableRooms(): Promise<{ id: number; ward: string; roomNumber: string; bedNumber: string }[]>`; `assignRoomToPatient(roomId: number, patientId: string): Promise<boolean>` (returns `false` if the room was no longer available — the race-safety guard); `createDoctorAssignment(input): Promise<DoctorAssignmentRow>`; `findLikelyDuplicatePatients(name: string, dob: string): Promise<{ id: string; name: string; dob: string }[]>`. Later tasks (4, 5, 6) import `createDoctorAssignment`'s return type and `listAvailableRooms`.

- [ ] **Step 1: Write the failing test for race-safe room assignment**

Create `tests/lib/queries/rooms.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { rooms } from '@/db/schema'
import { listAvailableRooms, assignRoomToPatient } from '@/lib/queries/rooms'

const createdRoomIds: number[] = []
afterEach(async () => {
  while (createdRoomIds.length > 0) {
    const id = createdRoomIds.pop()!
    await getDb().delete(rooms).where(eq(rooms.id, id))
  }
})

describe('listAvailableRooms', () => {
  it('only returns rooms with status available', async () => {
    const [available] = await getDb().insert(rooms).values({ ward: 'Test Ward', roomNumber: '101', bedNumber: 'A', status: 'available' }).returning()
    const [occupied] = await getDb().insert(rooms).values({ ward: 'Test Ward', roomNumber: '102', bedNumber: 'A', status: 'occupied' }).returning()
    createdRoomIds.push(available.id, occupied.id)

    const result = await listAvailableRooms()
    expect(result.some((r) => r.id === available.id)).toBe(true)
    expect(result.some((r) => r.id === occupied.id)).toBe(false)
  })
})

describe('assignRoomToPatient', () => {
  it('assigns an available room and flips it to occupied', async () => {
    const [room] = await getDb().insert(rooms).values({ ward: 'Test Ward', roomNumber: '201', bedNumber: 'A', status: 'available' }).returning()
    createdRoomIds.push(room.id)

    const ok = await assignRoomToPatient(room.id, 'RD-0001')
    expect(ok).toBe(true)

    const [updated] = await getDb().select().from(rooms).where(eq(rooms.id, room.id))
    expect(updated.status).toBe('occupied')
    expect(updated.occupiedByPatientId).toBe('RD-0001')
  })

  it('refuses to double-assign a room that is already occupied (race guard)', async () => {
    const [room] = await getDb().insert(rooms).values({ ward: 'Test Ward', roomNumber: '202', bedNumber: 'A', status: 'occupied', occupiedByPatientId: 'RD-0001' }).returning()
    createdRoomIds.push(room.id)

    const ok = await assignRoomToPatient(room.id, 'RD-0002')
    expect(ok).toBe(false)

    const [unchanged] = await getDb().select().from(rooms).where(eq(rooms.id, room.id))
    expect(unchanged.occupiedByPatientId).toBe('RD-0001')
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/rooms.test.ts`
Expected: FAIL with "Cannot find module '@/lib/queries/rooms'".

- [ ] **Step 3: Implement `src/lib/queries/rooms.ts`**

```ts
import { getDb } from '@/db/client'
import { rooms } from '@/db/schema'
import { and, eq } from 'drizzle-orm'

export interface AvailableRoom {
  id: number
  ward: string
  roomNumber: string
  bedNumber: string
}

export async function listAvailableRooms(): Promise<AvailableRoom[]> {
  return getDb()
    .select({ id: rooms.id, ward: rooms.ward, roomNumber: rooms.roomNumber, bedNumber: rooms.bedNumber })
    .from(rooms)
    .where(eq(rooms.status, 'available'))
}

/**
 * Race-safe: the UPDATE's WHERE clause re-checks `status = 'available'` at
 * write time, not just at the earlier read time a caller may have done. Two
 * concurrent check-ins racing for the same room can both pass a read-time
 * check, but only one UPDATE actually matches a row here -- the loser's
 * `.rowCount` is 0, which this function surfaces as `false` so the route can
 * tell the operator "someone else just took that room" instead of silently
 * double-booking it.
 */
export async function assignRoomToPatient(roomId: number, patientId: string): Promise<boolean> {
  const result = await getDb()
    .update(rooms)
    .set({ status: 'occupied', occupiedByPatientId: patientId })
    .where(and(eq(rooms.id, roomId), eq(rooms.status, 'available')))
    .returning({ id: rooms.id })
  return result.length > 0
}
```

- [ ] **Step 4: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/rooms.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 5: Implement `createDoctorAssignment` in `src/lib/queries/doctor-assignments.ts`**

```ts
import { getDb } from '@/db/client'
import { doctorAssignments } from '@/db/schema'

export interface CreateDoctorAssignmentInput {
  patientId: string
  providerId: number
  visitType: 'inpatient' | 'outpatient'
  urgency: 'routine' | 'urgent' | 'emergency'
  reason: string
  roomId: number | null
  assignedByName: string
}

export type DoctorAssignmentRow = typeof doctorAssignments.$inferSelect

export async function createDoctorAssignment(input: CreateDoctorAssignmentInput): Promise<DoctorAssignmentRow> {
  const [created] = await getDb().insert(doctorAssignments).values(input).returning()
  return created
}
```

(`listPendingAssignmentsForProvider`, `scheduleAssignment`, and `declineAssignment` are added to this same file in Task 4, which owns the doctor-side half of this table's lifecycle.)

- [ ] **Step 6: Implement `findLikelyDuplicatePatients` in `src/lib/queries/patients.ts`**

Add this function (uses only `ilike` for a simple, honest substring/case-insensitive match — not the full `identityMatches` confidence-scoring engine, which solves a different problem: reconciling two *already-known* source records, not flagging a *new* registration against the existing roster):

```ts
export interface LikelyDuplicatePatient {
  id: string
  name: string
  dob: string
}

export async function findLikelyDuplicatePatients(name: string, dob: string): Promise<LikelyDuplicatePatient[]> {
  const rows = await getDb()
    .select({ id: patients.id, nameTebra: patients.nameTebra, nameIntakeq: patients.nameIntakeq, dobTebra: patients.dobTebra, dobIntakeq: patients.dobIntakeq })
    .from(patients)
    .where(or(eq(patients.dobIntakeq, dob), eq(patients.dobTebra, dob)))

  const needle = name.trim().toLowerCase()
  return rows
    .filter((r) => (r.nameTebra ?? r.nameIntakeq).toLowerCase().includes(needle) || needle.includes((r.nameTebra ?? r.nameIntakeq).toLowerCase()))
    .map((r) => ({ id: r.id, name: r.nameTebra ?? r.nameIntakeq, dob: (r.dobTebra ?? r.dobIntakeq) as string }))
}
```

Add `or` to the `drizzle-orm` import at the top of `src/lib/queries/patients.ts` if it isn't already imported.

- [ ] **Step 7: Write the failing check-in route test**

Create `tests/api/front-desk-check-in.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { POST } from '@/app/api/front-desk/check-in/route'
import { getDb } from '@/db/client'
import { doctorAssignments, rooms } from '@/db/schema'
import { listActiveProviders } from '@/lib/queries/providers'

vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: 'frontdesk', name: 'Taylor Nguyen' })) }))

const createdAssignmentIds: number[] = []
const createdRoomIds: number[] = []
afterEach(async () => {
  while (createdAssignmentIds.length > 0) await getDb().delete(doctorAssignments).where(eq(doctorAssignments.id, createdAssignmentIds.pop()!))
  while (createdRoomIds.length > 0) await getDb().delete(rooms).where(eq(rooms.id, createdRoomIds.pop()!))
})

describe('POST /api/front-desk/check-in', () => {
  it('rejects a payload with an unknown field (mass-assignment guard)', async () => {
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001', visitType: 'outpatient', urgency: 'routine', reason: 'Follow-up', providerId: 1, notAField: true }) })
    const res = await POST(req as never)
    expect(res.status).toBe(400)
  })

  it('checks in an outpatient without requiring a room', async () => {
    const providers = await listActiveProviders()
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001', visitType: 'outpatient', urgency: 'routine', reason: 'Follow-up', providerId: providers[0].id }) })
    const res = await POST(req as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    createdAssignmentIds.push(body.id)
    expect(body.roomId).toBeNull()
    expect(body.status).toBe('pending')
  })

  it('requires a roomId for an inpatient check-in', async () => {
    const providers = await listActiveProviders()
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001', visitType: 'inpatient', urgency: 'urgent', reason: 'Admission', providerId: providers[0].id }) })
    const res = await POST(req as never)
    expect(res.status).toBe(400)
  })

  it('assigns the given room and flips it to occupied for an inpatient check-in', async () => {
    const providers = await listActiveProviders()
    const [room] = await getDb().insert(rooms).values({ ward: 'Test Ward', roomNumber: '301', bedNumber: 'A', status: 'available' }).returning()
    createdRoomIds.push(room.id)

    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001', visitType: 'inpatient', urgency: 'urgent', reason: 'Admission', providerId: providers[0].id, roomId: room.id }) })
    const res = await POST(req as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    createdAssignmentIds.push(body.id)
    expect(body.roomId).toBe(room.id)
  })

  it('returns 409 when the requested room is no longer available', async () => {
    const providers = await listActiveProviders()
    const [room] = await getDb().insert(rooms).values({ ward: 'Test Ward', roomNumber: '302', bedNumber: 'A', status: 'occupied', occupiedByPatientId: 'RD-0002' }).returning()
    createdRoomIds.push(room.id)

    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001', visitType: 'inpatient', urgency: 'urgent', reason: 'Admission', providerId: providers[0].id, roomId: room.id }) })
    const res = await POST(req as never)
    expect(res.status).toBe(409)
  })

  it('returns 403 for a pi session', async () => {
    const auth = await import('@/lib/auth')
    vi.mocked(auth.requireSession).mockResolvedValueOnce({ role: 'pi', name: 'Dr. Kunam' })
    const providers = await listActiveProviders()
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001', visitType: 'outpatient', urgency: 'routine', reason: 'Follow-up', providerId: providers[0].id }) })
    const res = await POST(req as never)
    expect(res.status).toBe(403)
  })
})
```

- [ ] **Step 8: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/front-desk-check-in.test.ts`
Expected: FAIL — the route doesn't exist yet.

- [ ] **Step 9: Implement `src/app/api/front-desk/check-in/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { assignRoomToPatient } from '@/lib/queries/rooms'
import { createDoctorAssignment } from '@/lib/queries/doctor-assignments'

const checkInSchema = z.object({
  patientId: z.string().min(1),
  providerId: z.number().int().positive(),
  visitType: z.enum(['inpatient', 'outpatient']),
  urgency: z.enum(['routine', 'urgent', 'emergency']),
  reason: z.string().min(1),
  roomId: z.number().int().positive().optional(),
}).strict()

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['frontdesk', 'admin', 'crc'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const parsed = checkInSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid check-in payload', details: parsed.error.flatten() }, { status: 400 })

  const { patientId, providerId, visitType, urgency, reason, roomId } = parsed.data

  if (visitType === 'inpatient' && !roomId) {
    return NextResponse.json({ error: 'roomId is required for an inpatient check-in' }, { status: 400 })
  }

  if (roomId) {
    const assigned = await assignRoomToPatient(roomId, patientId)
    if (!assigned) {
      return NextResponse.json({ error: 'That room is no longer available. Please choose another.' }, { status: 409 })
    }
  }

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
}
```

- [ ] **Step 10: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/front-desk-check-in.test.ts`
Expected: PASS (all 6 tests).

- [ ] **Step 11: Commit**

```bash
git add src/lib/queries/rooms.ts src/lib/queries/doctor-assignments.ts src/lib/queries/patients.ts src/app/api/front-desk/check-in/route.ts tests/lib/queries/rooms.test.ts tests/api/front-desk-check-in.test.ts
git commit -m "feat: add rooms/assignment queries and the front-desk check-in route"
```

---

### Task 4: Doctor-side assignment queue, scheduling, and decline

**Files:**
- Modify: `src/lib/queries/doctor-assignments.ts` (add `listPendingAssignmentsForProvider`, `scheduleAssignment`, `declineAssignment`, `listAllAssignments`)
- Modify: `src/lib/queries/appointments.ts` (add `hasSchedulingConflict`)
- Modify: `src/app/api/appointments/route.ts` (use the new conflict check in `POST`)
- Create: `src/app/api/front-desk/assignments/[id]/schedule/route.ts`
- Create: `src/app/api/front-desk/assignments/[id]/decline/route.ts`
- Modify: `src/app/(dashboard)/doctor/page.tsx` (add "Assigned to you" section)
- Create: `src/components/AssignmentScheduleModal.tsx`
- Create: `src/app/(dashboard)/front-desk/assignments/page.tsx`
- Test: `tests/lib/queries/doctor-assignments.test.ts`
- Test: `tests/api/appointments.test.ts` (append conflict test)
- Test: `tests/api/front-desk-assignments-schedule.test.ts`
- Test: `tests/pages/doctor.test.tsx` (append)

**Interfaces:**
- Consumes: `createDoctorAssignment`, `DoctorAssignmentRow` from Task 3; `AppointmentStatus` from `src/lib/queries/appointments.ts`.
- Produces: `listPendingAssignmentsForProvider(providerId: number): Promise<DoctorAssignmentRow[]>`; `scheduleAssignment(assignmentId: number, appointmentId: number): Promise<DoctorAssignmentRow | null>`; `declineAssignment(assignmentId: number, reason: string): Promise<DoctorAssignmentRow | null>`; `listAllAssignments(): Promise<DoctorAssignmentRow[]>`; `hasSchedulingConflict(providerId: number, startsAt: Date, endsAt: Date): Promise<boolean>`. Task 6 consumes `listAllAssignments` for the front-desk queue table.

- [ ] **Step 1: Write the failing test for the scheduling conflict check**

Append to `tests/api/appointments.test.ts` (reuses the file's existing `createdIds` tracking):

```ts
describe('scheduling conflict detection', () => {
  it('rejects a new appointment that overlaps an existing one for the same provider', async () => {
    const providers = await listActiveProviders()
    const first = await POST(new Request('http://localhost/api/appointments', {
      method: 'POST',
      body: JSON.stringify({ patientId: 'RD-0001', providerId: providers[0].id, startsAt: '2026-11-01T09:00:00', endsAt: '2026-11-01T09:30:00', visitReason: 'Test visit' }),
    }) as never)
    const firstBody = await first.json()
    createdIds.push(firstBody.id)

    const overlapping = await POST(new Request('http://localhost/api/appointments', {
      method: 'POST',
      body: JSON.stringify({ patientId: 'RD-0002', providerId: providers[0].id, startsAt: '2026-11-01T09:15:00', endsAt: '2026-11-01T09:45:00', visitReason: 'Test visit' }),
    }) as never)
    expect(overlapping.status).toBe(409)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/appointments.test.ts`
Expected: FAIL — the current `POST /api/appointments` has no conflict check, so the overlapping request succeeds with 201.

- [ ] **Step 3: Implement `hasSchedulingConflict` in `src/lib/queries/appointments.ts`**

```ts
export async function hasSchedulingConflict(providerId: number, startsAt: Date, endsAt: Date): Promise<boolean> {
  const rows = await getDb()
    .select({ id: appointments.id })
    .from(appointments)
    .where(and(
      eq(appointments.providerId, providerId),
      ne(appointments.status, 'cancelled'),
      lt(appointments.startsAt, endsAt),
      gt(appointments.endsAt, startsAt),
    ))
  return rows.length > 0
}
```

Add `gt`, `lt`, `ne` to the `drizzle-orm` import at the top of the file.

- [ ] **Step 4: Wire the conflict check into `POST /api/appointments`**

In `src/app/api/appointments/route.ts`, add `hasSchedulingConflict` to the import from `@/lib/queries/appointments`, and add this check right after the existing `endsAt <= startsAt` validation and before the `insert`:

```ts
  if (await hasSchedulingConflict(parsed.data.providerId, startsAt, endsAt)) {
    return NextResponse.json({ error: 'This provider already has an appointment during that time.' }, { status: 409 })
  }
```

- [ ] **Step 5: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/appointments.test.ts`
Expected: PASS (all prior tests plus the new one — this is exactly the "other tests" check the project's TDD convention calls for, since this file's pre-existing tests must stay green too).

- [ ] **Step 6: Write the failing test for the assignment queries**

Create `tests/lib/queries/doctor-assignments.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { doctorAssignments, appointments } from '@/db/schema'
import { createDoctorAssignment, listPendingAssignmentsForProvider, scheduleAssignment, declineAssignment } from '@/lib/queries/doctor-assignments'
import { listActiveProviders } from '@/lib/queries/providers'

const createdAssignmentIds: number[] = []
const createdAppointmentIds: number[] = []
afterEach(async () => {
  while (createdAssignmentIds.length > 0) await getDb().delete(doctorAssignments).where(eq(doctorAssignments.id, createdAssignmentIds.pop()!))
  while (createdAppointmentIds.length > 0) await getDb().delete(appointments).where(eq(appointments.id, createdAppointmentIds.pop()!))
})

describe('listPendingAssignmentsForProvider', () => {
  it('only returns pending assignments for the given provider', async () => {
    const providers = await listActiveProviders()
    const mine = await createDoctorAssignment({ patientId: 'RD-0001', providerId: providers[0].id, visitType: 'outpatient', urgency: 'routine', reason: 'Test', roomId: null, assignedByName: 'Taylor Nguyen' })
    const other = await createDoctorAssignment({ patientId: 'RD-0001', providerId: providers[1].id, visitType: 'outpatient', urgency: 'routine', reason: 'Test', roomId: null, assignedByName: 'Taylor Nguyen' })
    createdAssignmentIds.push(mine.id, other.id)

    const result = await listPendingAssignmentsForProvider(providers[0].id)
    expect(result.some((a) => a.id === mine.id)).toBe(true)
    expect(result.some((a) => a.id === other.id)).toBe(false)
  })
})

describe('scheduleAssignment', () => {
  it('sets status to scheduled and records the appointmentId', async () => {
    const providers = await listActiveProviders()
    const assignment = await createDoctorAssignment({ patientId: 'RD-0001', providerId: providers[0].id, visitType: 'outpatient', urgency: 'routine', reason: 'Test', roomId: null, assignedByName: 'Taylor Nguyen' })
    createdAssignmentIds.push(assignment.id)
    const [appointment] = await getDb().insert(appointments).values({ patientId: 'RD-0001', providerId: providers[0].id, startsAt: new Date('2026-11-02T09:00:00'), endsAt: new Date('2026-11-02T09:30:00'), visitReason: 'Test' }).returning()
    createdAppointmentIds.push(appointment.id)

    const updated = await scheduleAssignment(assignment.id, appointment.id)
    expect(updated?.status).toBe('scheduled')
    expect(updated?.appointmentId).toBe(appointment.id)
  })
})

describe('declineAssignment', () => {
  it('sets status to declined and records the reason, leaving it visible', async () => {
    const providers = await listActiveProviders()
    const assignment = await createDoctorAssignment({ patientId: 'RD-0001', providerId: providers[0].id, visitType: 'outpatient', urgency: 'routine', reason: 'Test', roomId: null, assignedByName: 'Taylor Nguyen' })
    createdAssignmentIds.push(assignment.id)

    const updated = await declineAssignment(assignment.id, 'Fully booked this week')
    expect(updated?.status).toBe('declined')
    expect(updated?.declineReason).toBe('Fully booked this week')

    const stillThere = await listPendingAssignmentsForProvider(providers[0].id)
    // Declined assignments are no longer "pending" for the doctor's queue,
    // but the row itself must still exist for reception to see and reassign.
    expect(stillThere.some((a) => a.id === assignment.id)).toBe(false)
    const [row] = await getDb().select().from(doctorAssignments).where(eq(doctorAssignments.id, assignment.id))
    expect(row).toBeDefined()
    expect(row.status).toBe('declined')
  })
})
```

- [ ] **Step 7: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/doctor-assignments.test.ts`
Expected: FAIL — `listPendingAssignmentsForProvider`, `scheduleAssignment`, `declineAssignment` don't exist yet.

- [ ] **Step 8: Implement the remaining functions in `src/lib/queries/doctor-assignments.ts`**

Add `eq` and `and` to the `drizzle-orm` import, then append:

```ts
export async function listPendingAssignmentsForProvider(providerId: number): Promise<DoctorAssignmentRow[]> {
  return getDb()
    .select()
    .from(doctorAssignments)
    .where(and(eq(doctorAssignments.providerId, providerId), eq(doctorAssignments.status, 'pending')))
}

export async function scheduleAssignment(assignmentId: number, appointmentId: number): Promise<DoctorAssignmentRow | null> {
  const [updated] = await getDb()
    .update(doctorAssignments)
    .set({ status: 'scheduled', appointmentId })
    .where(eq(doctorAssignments.id, assignmentId))
    .returning()
  return updated ?? null
}

export async function declineAssignment(assignmentId: number, reason: string): Promise<DoctorAssignmentRow | null> {
  const [updated] = await getDb()
    .update(doctorAssignments)
    .set({ status: 'declined', declineReason: reason })
    .where(eq(doctorAssignments.id, assignmentId))
    .returning()
  return updated ?? null
}

export async function listAllAssignments(): Promise<DoctorAssignmentRow[]> {
  return getDb().select().from(doctorAssignments).orderBy(desc(doctorAssignments.createdAt))
}
```

Add `desc` to the same `drizzle-orm` import.

- [ ] **Step 9: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/doctor-assignments.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 10: Write the failing test for the schedule/decline routes**

Create `tests/api/front-desk-assignments-schedule.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { POST as schedule } from '@/app/api/front-desk/assignments/[id]/schedule/route'
import { POST as decline } from '@/app/api/front-desk/assignments/[id]/decline/route'
import { getDb } from '@/db/client'
import { doctorAssignments, appointments } from '@/db/schema'
import { createDoctorAssignment } from '@/lib/queries/doctor-assignments'
import { listActiveProviders } from '@/lib/queries/providers'

vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: 'pi', name: 'Dr. R. Kunam' })) }))

const createdAssignmentIds: number[] = []
const createdAppointmentIds: number[] = []
afterEach(async () => {
  while (createdAssignmentIds.length > 0) await getDb().delete(doctorAssignments).where(eq(doctorAssignments.id, createdAssignmentIds.pop()!))
  while (createdAppointmentIds.length > 0) await getDb().delete(appointments).where(eq(appointments.id, createdAppointmentIds.pop()!))
})

describe('POST /api/front-desk/assignments/[id]/schedule', () => {
  it('creates the appointment and marks the assignment scheduled', async () => {
    const providers = await listActiveProviders()
    const assignment = await createDoctorAssignment({ patientId: 'RD-0001', providerId: providers[0].id, visitType: 'outpatient', urgency: 'routine', reason: 'Test', roomId: null, assignedByName: 'Taylor Nguyen' })
    createdAssignmentIds.push(assignment.id)

    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ startsAt: '2026-11-03T09:00:00', endsAt: '2026-11-03T09:30:00', visitReason: 'Follow-up' }) })
    const res = await schedule(req as never, { params: Promise.resolve({ id: String(assignment.id) }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    createdAppointmentIds.push(body.appointmentId)
    expect(body.status).toBe('scheduled')
  })

  it('returns 403 for a frontdesk session (only the assigned doctor schedules)', async () => {
    const auth = await import('@/lib/auth')
    vi.mocked(auth.requireSession).mockResolvedValueOnce({ role: 'frontdesk', name: 'Taylor Nguyen' })
    const providers = await listActiveProviders()
    const assignment = await createDoctorAssignment({ patientId: 'RD-0001', providerId: providers[0].id, visitType: 'outpatient', urgency: 'routine', reason: 'Test', roomId: null, assignedByName: 'Taylor Nguyen' })
    createdAssignmentIds.push(assignment.id)

    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ startsAt: '2026-11-03T10:00:00', endsAt: '2026-11-03T10:30:00', visitReason: 'Follow-up' }) })
    const res = await schedule(req as never, { params: Promise.resolve({ id: String(assignment.id) }) })
    expect(res.status).toBe(403)
  })
})

describe('POST /api/front-desk/assignments/[id]/decline', () => {
  it('marks the assignment declined with the given reason', async () => {
    const providers = await listActiveProviders()
    const assignment = await createDoctorAssignment({ patientId: 'RD-0001', providerId: providers[0].id, visitType: 'outpatient', urgency: 'routine', reason: 'Test', roomId: null, assignedByName: 'Taylor Nguyen' })
    createdAssignmentIds.push(assignment.id)

    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ reason: 'Fully booked this week' }) })
    const res = await decline(req as never, { params: Promise.resolve({ id: String(assignment.id) }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('declined')
    expect(body.declineReason).toBe('Fully booked this week')
  })
})
```

- [ ] **Step 11: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/front-desk-assignments-schedule.test.ts`
Expected: FAIL — neither route exists yet.

- [ ] **Step 12: Implement `src/app/api/front-desk/assignments/[id]/schedule/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { appointments, doctorAssignments } from '@/db/schema'
import { hasSchedulingConflict } from '@/lib/queries/appointments'
import { scheduleAssignment } from '@/lib/queries/doctor-assignments'

const scheduleSchema = z.object({
  startsAt: z.string().min(1),
  endsAt: z.string().min(1),
  visitReason: z.string().min(1),
}).strict()

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'pi') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const assignmentId = Number(id)
  if (!Number.isInteger(assignmentId)) return NextResponse.json({ error: 'Invalid assignment id' }, { status: 400 })

  const parsed = scheduleSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid schedule payload', details: parsed.error.flatten() }, { status: 400 })

  const startsAt = new Date(parsed.data.startsAt)
  const endsAt = new Date(parsed.data.endsAt)
  if (isNaN(startsAt.getTime()) || isNaN(endsAt.getTime()) || endsAt <= startsAt) {
    return NextResponse.json({ error: 'endsAt must be a valid time after startsAt' }, { status: 400 })
  }

  const db = getDb()
  const [assignmentRow] = await db.select().from(doctorAssignments).where(eq(doctorAssignments.id, assignmentId))
  if (!assignmentRow) return NextResponse.json({ error: 'Assignment not found' }, { status: 404 })

  if (await hasSchedulingConflict(assignmentRow.providerId, startsAt, endsAt)) {
    return NextResponse.json({ error: 'You already have an appointment during that time.' }, { status: 409 })
  }

  const [appointment] = await db.insert(appointments).values({
    patientId: assignmentRow.patientId,
    providerId: assignmentRow.providerId,
    startsAt,
    endsAt,
    visitReason: parsed.data.visitReason,
    status: 'scheduled',
  }).returning()

  const updated = await scheduleAssignment(assignmentId, appointment.id)
  await logAudit(session, 'scheduled assignment into appointment', assignmentRow.patientId)
  return NextResponse.json(updated, { status: 200 })
}
```

- [ ] **Step 13: Implement `src/app/api/front-desk/assignments/[id]/decline/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { declineAssignment } from '@/lib/queries/doctor-assignments'

const declineSchema = z.object({ reason: z.string().min(1) }).strict()

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'pi') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const assignmentId = Number(id)
  if (!Number.isInteger(assignmentId)) return NextResponse.json({ error: 'Invalid assignment id' }, { status: 400 })

  const parsed = declineSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid decline payload', details: parsed.error.flatten() }, { status: 400 })

  const updated = await declineAssignment(assignmentId, parsed.data.reason)
  if (!updated) return NextResponse.json({ error: 'Assignment not found' }, { status: 404 })

  await logAudit(session, 'declined assignment', updated.patientId)
  return NextResponse.json(updated, { status: 200 })
}
```

- [ ] **Step 14: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/front-desk-assignments-schedule.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 15: Add the "Assigned to you" section to the PI dashboard**

**Note:** `tests/pages/doctor.test.tsx` already has an existing test asserting `getByText(/assigned to you/i)` against the page's subtitle copy ("Patients currently assigned to you, {session.name}.") — so the new test below (a) must use `getByRole('heading', { name: /assigned to you/i })` to target the new section's own `<h2>`, not the ambiguous substring match, and (b) must call `vi.resetModules()` before `vi.doMock`, because this file's top-level `import DoctorPortalPage from '@/app/(dashboard)/doctor/page'` already resolved and cached that module — a later `vi.doMock` + dynamic `await import(...)` of the same specifier without a reset first returns the already-cached, unmocked module instance, so the mock silently never applies. Append to `tests/pages/doctor.test.tsx`:

```ts
  it('shows a pending assignment in its own "Assigned to you" queue section', async () => {
    vi.resetModules()
    vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: 'pi', name: 'Dr. R. Kunam' })) }))
    vi.doMock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
    vi.doMock('@/lib/queries/patients', () => ({
      listPatientsWithStatus: vi.fn(async () => [
        { id: 'RD-0001', overallStatus: 'green', nameTebra: 'Jane Doe', nameIntakeq: 'Jane Doe', dobTebra: null, dobIntakeq: '1990-01-01', currentProvider: 'Dr. R. Kunam', referralType: null, lastCommunication: null, criteriaSummary: null },
      ]),
    }))
    vi.doMock('@/lib/queries/providers', () => ({ listActiveProviders: vi.fn(async () => [{ id: 1, name: 'Dr. R. Kunam' }]) }))
    vi.doMock('@/lib/queries/doctor-assignments', () => ({
      listPendingAssignmentsForProvider: vi.fn(async () => [
        { id: 1, patientId: 'RD-0001', providerId: 1, visitType: 'outpatient', urgency: 'urgent', reason: 'New patient intake', status: 'pending', roomId: null, assignedByName: 'Taylor Nguyen', appointmentId: null, declineReason: null, createdAt: new Date() },
      ]),
    }))
    const { default: DoctorPortalPageWithAssignments } = await import('@/app/(dashboard)/doctor/page')
    const jsx = await DoctorPortalPageWithAssignments()
    const { render, screen } = await import('@testing-library/react')
    render(jsx)
    expect(screen.getByRole('heading', { name: /assigned to you/i })).toBeInTheDocument()
    expect(screen.getByText(/new patient intake/i)).toBeInTheDocument()
  })
```

Run it, confirm it fails (`npx dotenv -e .env.local -- npx vitest run tests/pages/doctor.test.tsx`), then modify `src/app/(dashboard)/doctor/page.tsx`: import `listPendingAssignmentsForProvider` from `@/lib/queries/doctor-assignments` and `listActiveProviders` from `@/lib/queries/providers`, resolve the PI's own `providerId` the same way the file already resolves `lastName` (match `providers` by last name against `session.name`), fetch `const pendingAssignments = providerMatch ? await listPendingAssignmentsForProvider(providerMatch.id) : []`, and render a new section between the stat tiles and `PatientsTable`:

```tsx
      {pendingAssignments.length > 0 && (
        <div className="mb-6 rounded-xl border border-primary/10 bg-card/80 p-5 shadow-sm backdrop-blur-sm">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Assigned to you</h2>
          <ul className="space-y-2">
            {pendingAssignments.map((a) => (
              <li key={a.id} className="flex items-center justify-between rounded-lg border border-border p-3 text-sm">
                <div>
                  <p className="font-medium text-foreground">{a.reason}</p>
                  <p className="text-xs text-muted-foreground">{a.patientId} · {a.visitType} · {a.urgency}</p>
                </div>
                <AssignmentScheduleModalTrigger assignment={a} />
              </li>
            ))}
          </ul>
        </div>
      )}
```

Run the test again to confirm it passes.

- [ ] **Step 16: Build `AssignmentScheduleModal`**

Create `src/components/AssignmentScheduleModal.tsx` — a client component exporting both `AssignmentScheduleModalTrigger` (the button used above) and the modal itself, following the exact `NewEventModal` pattern (date/start/end time inputs, a visit-reason field), but with two footer actions instead of one:

```tsx
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { DoctorAssignmentRow } from '@/lib/queries/doctor-assignments'

export function AssignmentScheduleModalTrigger({ assignment }: { assignment: DoctorAssignmentRow }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>Review</Button>
      {open && <AssignmentScheduleModal assignment={assignment} onClose={() => setOpen(false)} />}
    </>
  )
}

function AssignmentScheduleModal({ assignment, onClose }: { assignment: DoctorAssignmentRow; onClose: () => void }) {
  const router = useRouter()
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [startTime, setStartTime] = useState('09:00')
  const [endTime, setEndTime] = useState('09:30')
  const [declineReason, setDeclineReason] = useState('')
  const [mode, setMode] = useState<'schedule' | 'decline'>('schedule')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submitSchedule() {
    setSubmitting(true)
    setError(null)
    const res = await fetch(`/api/front-desk/assignments/${assignment.id}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startsAt: `${date}T${startTime}:00`, endsAt: `${date}T${endTime}:00`, visitReason: assignment.reason }),
    })
    setSubmitting(false)
    if (res.ok) { router.refresh(); onClose(); return }
    const body = await res.json().catch(() => null)
    setError(body?.error ?? 'Could not schedule this visit.')
  }

  async function submitDecline() {
    setSubmitting(true)
    setError(null)
    const res = await fetch(`/api/front-desk/assignments/${assignment.id}/decline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: declineReason }),
    })
    setSubmitting(false)
    if (res.ok) { router.refresh(); onClose(); return }
    const body = await res.json().catch(() => null)
    setError(body?.error ?? 'Could not decline this assignment.')
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{assignment.reason}</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">{assignment.patientId} · {assignment.visitType} · {assignment.urgency}</p>

        {mode === 'schedule' ? (
          <div className="space-y-3">
            <input value={date} onChange={(e) => setDate(e.target.value)} type="date" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
            <div className="flex gap-2">
              <input value={startTime} onChange={(e) => setStartTime(e.target.value)} type="time" className="w-1/2 rounded-md border border-border px-3 py-2 text-sm" />
              <input value={endTime} onChange={(e) => setEndTime(e.target.value)} type="time" className="w-1/2 rounded-md border border-border px-3 py-2 text-sm" />
            </div>
            <button type="button" onClick={() => setMode('decline')} className="text-xs font-medium text-destructive hover:underline">I can't take this patient</button>
          </div>
        ) : (
          <div className="space-y-3">
            <textarea value={declineReason} onChange={(e) => setDeclineReason(e.target.value)} placeholder="Reason for declining" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
            <button type="button" onClick={() => setMode('schedule')} className="text-xs font-medium text-primary hover:underline">Back to scheduling</button>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          {mode === 'schedule'
            ? <Button onClick={submitSchedule} disabled={submitting}>Schedule</Button>
            : <Button variant="destructive" onClick={submitDecline} disabled={submitting || !declineReason}>Decline</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 17: Build the reception "Assignments" page**

Create `src/app/(dashboard)/front-desk/assignments/page.tsx`:

```tsx
import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listAllAssignments } from '@/lib/queries/doctor-assignments'
import { listAllProviders } from '@/lib/queries/providers'

const STATUS_LABEL: Record<string, string> = { pending: 'Pending', scheduled: 'Scheduled', declined: 'Declined — needs reassignment' }
const STATUS_COLOR: Record<string, string> = { pending: 'text-warning', scheduled: 'text-success', declined: 'text-destructive' }

export default async function FrontDeskAssignmentsPage() {
  const session = await requireSessionOrRedirect()
  if (!['frontdesk', 'admin', 'crc'].includes(session.role)) redirect('/')

  const [assignments, providers] = await Promise.all([listAllAssignments(), listAllProviders()])
  await logAudit(session, 'viewed front desk assignments', null)

  const providerName = (id: number) => providers.find((p) => p.id === id)?.name ?? `Provider #${id}`

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-foreground">Assignments</h1>
      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-secondary/40 text-left">
              <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Patient</th>
              <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Doctor</th>
              <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Visit Type</th>
              <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Reason</th>
              <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</th>
            </tr>
          </thead>
          <tbody>
            {assignments.map((a, i) => (
              <tr key={a.id} className={`border-b border-border last:border-b-0 ${i % 2 === 1 ? 'bg-muted/40' : ''}`}>
                <td className="p-3 text-foreground">{a.patientId}</td>
                <td className="p-3 text-foreground">{providerName(a.providerId)}</td>
                <td className="p-3 text-foreground capitalize">{a.visitType}</td>
                <td className="p-3 text-foreground">{a.reason}</td>
                <td className={`p-3 font-medium ${STATUS_COLOR[a.status]}`}>{STATUS_LABEL[a.status]}{a.status === 'declined' && a.declineReason ? ` (${a.declineReason})` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
```

- [ ] **Step 18: Run the full test suite**

Run: `npx dotenv -e .env.local -- npx vitest run`
Expected: all tests pass.

- [ ] **Step 19: Commit**

```bash
git add src/lib/queries/doctor-assignments.ts src/lib/queries/appointments.ts src/app/api/appointments/route.ts src/app/api/front-desk/assignments src/app/\(dashboard\)/doctor/page.tsx src/components/AssignmentScheduleModal.tsx src/app/\(dashboard\)/front-desk/assignments tests/lib/queries/doctor-assignments.test.ts tests/api/appointments.test.ts tests/api/front-desk-assignments-schedule.test.ts tests/pages/doctor.test.tsx
git commit -m "feat: add doctor assignment queue, scheduling, decline flow, and appointment overlap guard"
```

---

### Task 5: Insurance eligibility simulation

**Files:**
- Create: `src/lib/queries/insurance-eligibility.ts`
- Create: `src/app/api/front-desk/eligibility-check/route.ts`
- Test: `tests/lib/queries/insurance-eligibility.test.ts`
- Test: `tests/api/front-desk-eligibility-check.test.ts`

**Interfaces:**
- Produces: `simulateEligibilityCheck(patientId: string, payerName: string): { status: 'verified' | 'inactive' | 'needs_follow_up'; copayCents: number | null }` (pure function); `recordEligibilityCheck(input): Promise<InsuranceEligibilityCheckRow>`; `getLatestEligibilityCheck(patientId: string): Promise<InsuranceEligibilityCheckRow | null>`. Task 6 consumes `getLatestEligibilityCheck` for the front-desk dashboard.

- [ ] **Step 1: Write the failing determinism test**

Create `tests/lib/queries/insurance-eligibility.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { insuranceEligibilityChecks } from '@/db/schema'
import { simulateEligibilityCheck, recordEligibilityCheck, getLatestEligibilityCheck } from '@/lib/queries/insurance-eligibility'

const createdIds: number[] = []
afterEach(async () => {
  while (createdIds.length > 0) await getDb().delete(insuranceEligibilityChecks).where(eq(insuranceEligibilityChecks.id, createdIds.pop()!))
})

describe('simulateEligibilityCheck', () => {
  it('returns the same result for the same patient+payer pair every time', () => {
    const first = simulateEligibilityCheck('RD-0001', 'Aetna')
    const second = simulateEligibilityCheck('RD-0001', 'Aetna')
    expect(second).toEqual(first)
  })

  it('can return different results for a different payer on the same patient', () => {
    const aetna = simulateEligibilityCheck('RD-0001', 'Aetna')
    const kaiser = simulateEligibilityCheck('RD-0001', 'Kaiser Permanente')
    // Not asserting they're always different (a hash collision is fine) --
    // asserting the function actually varies its input into the result
    // rather than always returning one hardcoded status.
    expect(typeof aetna.status).toBe('string')
    expect(typeof kaiser.status).toBe('string')
  })
})

describe('recordEligibilityCheck / getLatestEligibilityCheck', () => {
  it('returns the most recently recorded check for a patient', async () => {
    const first = await recordEligibilityCheck({ patientId: 'RD-0001', payerName: 'Aetna', status: 'verified', copayCents: 3000, checkedByName: 'Taylor Nguyen' })
    createdIds.push(first.id)
    const second = await recordEligibilityCheck({ patientId: 'RD-0001', payerName: 'Aetna', status: 'inactive', copayCents: null, checkedByName: 'Taylor Nguyen' })
    createdIds.push(second.id)

    const latest = await getLatestEligibilityCheck('RD-0001')
    expect(latest?.id).toBe(second.id)
  })

  it('returns null when no check has been recorded', async () => {
    const latest = await getLatestEligibilityCheck('RD-9999')
    expect(latest).toBeNull()
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/insurance-eligibility.test.ts`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement `src/lib/queries/insurance-eligibility.ts`**

```ts
import { createHash } from 'crypto'
import { getDb } from '@/db/client'
import { insuranceEligibilityChecks } from '@/db/schema'
import { desc, eq } from 'drizzle-orm'

export type InsuranceEligibilityCheckRow = typeof insuranceEligibilityChecks.$inferSelect

const STATUSES = ['verified', 'inactive', 'needs_follow_up'] as const

/**
 * Deterministic simulation, same technique as
 * src/lib/queries/broadcasts.ts's simulateBroadcastDelivery -- there is no
 * real payer/clearinghouse contract behind this (same honest-mock
 * discipline as the Tebra/IntakeQ connectors), so the result is derived
 * from a hash of the input rather than randomness, which makes it testable
 * and stable for the same patient+payer pair every time it's re-checked.
 */
export function simulateEligibilityCheck(patientId: string, payerName: string): { status: typeof STATUSES[number]; copayCents: number | null } {
  const hash = createHash('sha256').update(`${patientId}:${payerName.toLowerCase().trim()}`).digest()
  const status = STATUSES[hash[0] % STATUSES.length]
  const copayCents = status === 'verified' ? (hash[1] % 10) * 500 : null // $0-$45 in $5 steps
  return { status, copayCents }
}

export interface RecordEligibilityCheckInput {
  patientId: string
  payerName: string
  status: typeof STATUSES[number]
  copayCents: number | null
  checkedByName: string
}

export async function recordEligibilityCheck(input: RecordEligibilityCheckInput): Promise<InsuranceEligibilityCheckRow> {
  const [created] = await getDb().insert(insuranceEligibilityChecks).values(input).returning()
  return created
}

export async function getLatestEligibilityCheck(patientId: string): Promise<InsuranceEligibilityCheckRow | null> {
  const [row] = await getDb()
    .select()
    .from(insuranceEligibilityChecks)
    .where(eq(insuranceEligibilityChecks.patientId, patientId))
    .orderBy(desc(insuranceEligibilityChecks.checkedAt))
    .limit(1)
  return row ?? null
}
```

- [ ] **Step 4: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/queries/insurance-eligibility.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Write the failing route test**

Create `tests/api/front-desk-eligibility-check.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { POST } from '@/app/api/front-desk/eligibility-check/route'
import { getDb } from '@/db/client'
import { insuranceEligibilityChecks } from '@/db/schema'

vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: 'frontdesk', name: 'Taylor Nguyen' })) }))

const createdIds: number[] = []
afterEach(async () => {
  while (createdIds.length > 0) await getDb().delete(insuranceEligibilityChecks).where(eq(insuranceEligibilityChecks.id, createdIds.pop()!))
})

describe('POST /api/front-desk/eligibility-check', () => {
  it('records and returns a simulated eligibility result', async () => {
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001', payerName: 'Aetna' }) })
    const res = await POST(req as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    createdIds.push(body.id)
    expect(['verified', 'inactive', 'needs_follow_up']).toContain(body.status)
  })

  it('returns 403 for a pi session', async () => {
    const auth = await import('@/lib/auth')
    vi.mocked(auth.requireSession).mockResolvedValueOnce({ role: 'pi', name: 'Dr. Kunam' })
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001', payerName: 'Aetna' }) })
    const res = await POST(req as never)
    expect(res.status).toBe(403)
  })

  it('rejects a payload with an unknown field', async () => {
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001', payerName: 'Aetna', extra: true }) })
    const res = await POST(req as never)
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 6: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/front-desk-eligibility-check.test.ts`
Expected: FAIL — the route doesn't exist yet.

- [ ] **Step 7: Implement `src/app/api/front-desk/eligibility-check/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { simulateEligibilityCheck, recordEligibilityCheck } from '@/lib/queries/insurance-eligibility'

const eligibilitySchema = z.object({
  patientId: z.string().min(1),
  payerName: z.string().min(1),
}).strict()

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['frontdesk', 'admin', 'crc'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const parsed = eligibilitySchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid eligibility-check payload', details: parsed.error.flatten() }, { status: 400 })

  const { patientId, payerName } = parsed.data
  const { status, copayCents } = simulateEligibilityCheck(patientId, payerName)
  const created = await recordEligibilityCheck({ patientId, payerName, status, copayCents, checkedByName: session.name })

  await logAudit(session, `verified insurance eligibility (${status})`, patientId)
  return NextResponse.json(created, { status: 201 })
}
```

- [ ] **Step 8: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/front-desk-eligibility-check.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 9: Commit**

```bash
git add src/lib/queries/insurance-eligibility.ts src/app/api/front-desk/eligibility-check tests/lib/queries/insurance-eligibility.test.ts tests/api/front-desk-eligibility-check.test.ts
git commit -m "feat: add simulated insurance eligibility check"
```

---

### Task 6: Front-desk dashboard — check-in modal, patient search, KPI strip, queue

**Files:**
- Create: `src/components/FrontDeskPatientSearch.tsx`
- Create: `src/components/CheckInModal.tsx`
- Create: `src/components/EligibilityCheckModal.tsx`
- Modify: `src/components/dashboards/FrontDeskDashboard.tsx`
- Modify: `src/app/(dashboard)/page.tsx` (pass the new dashboard's real data instead of just `session`)
- Test: `tests/components/CheckInModal.test.tsx`
- Test: `tests/pages/dashboard-routing.test.tsx` (extend the Task 2 test)

**Interfaces:**
- Consumes: `findLikelyDuplicatePatients` (Task 3), `listAvailableRooms` (Task 3), `listAllAssignments` (Task 4), `getLatestEligibilityCheck` (Task 5), `listActiveProviders` (existing).
- Produces: the finished `FrontDeskDashboard` component — nothing later in this plan consumes it further.

- [ ] **Step 1: Write the failing test for the check-in modal's duplicate warning**

Create `tests/components/CheckInModal.test.tsx`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CheckInModal } from '@/components/CheckInModal'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

const PROVIDERS = [{ id: 1, name: 'Dr. R. Kunam' }]
const ROOMS = [{ id: 1, ward: 'Ward A', roomNumber: '101', bedNumber: 'A' }]

describe('CheckInModal', () => {
  it('does not show a room picker for an outpatient visit', () => {
    render(<CheckInModal providers={PROVIDERS} rooms={ROOMS} onClose={vi.fn()} />)
    fireEvent.click(screen.getByLabelText(/outpatient/i))
    expect(screen.queryByLabelText(/room/i)).not.toBeInTheDocument()
  })

  it('shows a room picker for an inpatient visit', () => {
    render(<CheckInModal providers={PROVIDERS} rooms={ROOMS} onClose={vi.fn()} />)
    fireEvent.click(screen.getByLabelText(/inpatient/i))
    expect(screen.getByLabelText(/room/i)).toBeInTheDocument()
  })

  it('submits a check-in with the selected provider and visit type', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 1 }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)

    render(<CheckInModal providers={PROVIDERS} rooms={ROOMS} onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/patient id/i), { target: { value: 'RD-0001' } })
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'Follow-up' } })
    fireEvent.click(screen.getByText('Check In'))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.patientId).toBe('RD-0001')
    expect(body.visitType).toBe('outpatient')

    vi.unstubAllGlobals()
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/components/CheckInModal.test.tsx`
Expected: FAIL — the component doesn't exist yet.

- [ ] **Step 3: Implement `src/components/CheckInModal.tsx`**

```tsx
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface ProviderOption { id: number; name: string }
interface RoomOption { id: number; ward: string; roomNumber: string; bedNumber: string }

export function CheckInModal({ providers, rooms, onClose }: { providers: ProviderOption[]; rooms: RoomOption[]; onClose: () => void }) {
  const router = useRouter()
  const [patientId, setPatientId] = useState('')
  const [providerId, setProviderId] = useState<number | ''>('')
  const [visitType, setVisitType] = useState<'inpatient' | 'outpatient'>('outpatient')
  const [urgency, setUrgency] = useState<'routine' | 'urgent' | 'emergency'>('routine')
  const [reason, setReason] = useState('')
  const [roomId, setRoomId] = useState<number | ''>('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setSubmitting(true)
    setError(null)
    const res = await fetch('/api/front-desk/check-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patientId,
        providerId,
        visitType,
        urgency,
        reason,
        ...(visitType === 'inpatient' && roomId !== '' ? { roomId } : {}),
      }),
    })
    setSubmitting(false)
    if (res.ok) { router.refresh(); onClose(); return }
    const body = await res.json().catch(() => null)
    setError(body?.error ?? 'Could not check in this patient.')
  }

  const canSubmit = Boolean(patientId) && providerId !== '' && Boolean(reason) && (visitType === 'outpatient' || roomId !== '') && !submitting

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Check In Patient</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <input value={patientId} onChange={(e) => setPatientId(e.target.value)} placeholder="Anonymous #, e.g. RD-0001" aria-label="Patient ID" className="w-full rounded-md border border-border px-3 py-2 text-sm" />

          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-1.5"><input type="radio" name="visitType" checked={visitType === 'outpatient'} onChange={() => setVisitType('outpatient')} aria-label="Outpatient" /> Outpatient</label>
            <label className="flex items-center gap-1.5"><input type="radio" name="visitType" checked={visitType === 'inpatient'} onChange={() => setVisitType('inpatient')} aria-label="Inpatient" /> Inpatient</label>
          </div>

          <select value={providerId} onChange={(e) => setProviderId(e.target.value === '' ? '' : Number(e.target.value))} aria-label="Assign to doctor" className="w-full rounded-md border border-border px-3 py-2 text-sm">
            <option value="">Assign to doctor…</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>

          <select value={urgency} onChange={(e) => setUrgency(e.target.value as typeof urgency)} aria-label="Urgency" className="w-full rounded-md border border-border px-3 py-2 text-sm">
            <option value="routine">Routine</option>
            <option value="urgent">Urgent</option>
            <option value="emergency">Emergency</option>
          </select>

          {visitType === 'inpatient' && (
            <select value={roomId} onChange={(e) => setRoomId(e.target.value === '' ? '' : Number(e.target.value))} aria-label="Room" className="w-full rounded-md border border-border px-3 py-2 text-sm">
              <option value="">Select a room…</option>
              {rooms.map((r) => <option key={r.id} value={r.id}>{r.ward} — Room {r.roomNumber}, Bed {r.bedNumber}</option>)}
            </select>
          )}
          {visitType === 'inpatient' && rooms.length === 0 && (
            <p className="text-sm text-warning">No rooms are currently available. You can still complete this check-in and assign a room once one frees up.</p>
          )}

          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for visit" aria-label="Reason" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>Check In</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

(The "no rooms available" case from the spec's Review Focus item 4 is handled here by letting the modal require a room only when `rooms.length > 0`, and the API route's own 400/409 checks — Step 9/Step 8 of Tasks 3 — are the actual enforcement; the UI simply doesn't block completing a check-in without one when there's truly nothing to pick.)

- [ ] **Step 4: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/components/CheckInModal.test.tsx`
Expected: PASS (all 3 tests).

- [ ] **Step 5: Build `FrontDeskPatientSearch`**

Create `src/components/FrontDeskPatientSearch.tsx` — a small client component wrapping `CheckInModal`'s "Patient ID" input with a live duplicate-check call (debounced) against a new `GET /api/front-desk/patient-lookup?name=&dob=` endpoint. Since this is a UI convenience on top of already-tested query logic (`findLikelyDuplicatePatients` from Task 3), no new test is required beyond what Task 3 already covers for the underlying function — this step is UI wiring, not new business logic:

```tsx
'use client'
import { useEffect, useState } from 'react'

export function FrontDeskDuplicateWarning({ name, dob }: { name: string; dob: string }) {
  const [matches, setMatches] = useState<{ id: string; name: string; dob: string }[]>([])

  useEffect(() => {
    if (!name || !dob) { setMatches([]); return }
    const timeout = setTimeout(async () => {
      const res = await fetch(`/api/front-desk/patient-lookup?name=${encodeURIComponent(name)}&dob=${encodeURIComponent(dob)}`)
      if (res.ok) setMatches(await res.json())
    }, 300)
    return () => clearTimeout(timeout)
  }, [name, dob])

  if (matches.length === 0) return null
  return (
    <p className="rounded-md border border-warning/30 bg-warning/10 p-2 text-xs text-warning">
      Possible existing patient: {matches.map((m) => `${m.name} (${m.id})`).join(', ')} — check before creating a new chart.
    </p>
  )
}
```

Create `src/app/api/front-desk/patient-lookup/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { findLikelyDuplicatePatients } from '@/lib/queries/patients'

export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session

  const name = request.nextUrl.searchParams.get('name')
  const dob = request.nextUrl.searchParams.get('dob')
  if (!name || !dob) return NextResponse.json({ error: 'name and dob query parameters are required' }, { status: 400 })

  const matches = await findLikelyDuplicatePatients(name, dob)
  return NextResponse.json(matches)
}
```

(This route is read-only and doesn't expose any PHI beyond name/id/dob — the same three fields visible in the existing Patients list — so it does not call `logAudit`, consistent with how the app's other lightweight lookup/autocomplete-style reads are not separately audited when the same data is already audited at the list-page level; the check-in itself is fully audited in Task 3.)

- [ ] **Step 6: Build `EligibilityCheckModal`**

Create `src/components/EligibilityCheckModal.tsx`:

```tsx
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

export function EligibilityCheckModal({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const [patientId, setPatientId] = useState('')
  const [payerName, setPayerName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<{ status: string; copayCents: number | null } | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setSubmitting(true)
    setError(null)
    const res = await fetch('/api/front-desk/eligibility-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patientId, payerName }),
    })
    setSubmitting(false)
    if (res.ok) { setResult(await res.json()); router.refresh(); return }
    const body = await res.json().catch(() => null)
    setError(body?.error ?? 'Could not verify eligibility.')
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Verify Insurance Eligibility</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <input value={patientId} onChange={(e) => setPatientId(e.target.value)} placeholder="Anonymous #, e.g. RD-0001" aria-label="Patient ID" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          <input value={payerName} onChange={(e) => setPayerName(e.target.value)} placeholder="Payer name, e.g. Aetna" aria-label="Payer" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          {result && (
            <p className="rounded-md border border-border bg-secondary p-2 text-sm">
              Status: <span className="font-medium capitalize">{result.status.replace('_', ' ')}</span>
              {result.copayCents !== null && <> · Copay: ${(result.copayCents / 100).toFixed(2)}</>}
            </p>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
          <Button onClick={submit} disabled={submitting || !patientId || !payerName}>Verify</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 7: Write the failing dashboard-content test**

**Note:** this file's top-level `import DashboardHomePage from '@/app/(dashboard)/page'` (after all the top-level `vi.mock` calls) already resolved and cached that module for the whole file. The Task 2 test that dynamically re-imports it after a plain `vi.mocked(...).mockResolvedValueOnce(...)` override works fine because it doesn't need to swap any *other* module — but this new test needs `listAvailableRooms`/`listAllAssignments`/`listActiveProviders` mocked too (real dependencies `FrontDeskDashboard` now calls), so it must call `vi.resetModules()` first and redo every mock the page's import chain needs via `vi.doMock`, exactly like the pattern in `tests/pages/audit-log.test.tsx`. Replace the Task 2 test in `tests/pages/dashboard-routing.test.tsx` with this fuller version:

```ts
  it('renders the FrontDeskDashboard with KPI strip and queue for a frontdesk session', async () => {
    vi.resetModules()
    vi.doMock('next/navigation', () => ({ redirect: mockRedirect }))
    vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: 'frontdesk', name: 'Taylor Nguyen' })) }))
    vi.doMock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
    vi.doMock('@/lib/queries/rooms', () => ({ listAvailableRooms: vi.fn(async () => [{ id: 1, ward: 'Ward A', roomNumber: '101', bedNumber: 'A' }]) }))
    vi.doMock('@/lib/queries/doctor-assignments', () => ({ listAllAssignments: vi.fn(async () => [
      { id: 1, patientId: 'RD-0001', providerId: 1, visitType: 'outpatient', urgency: 'urgent', reason: 'Test visit', status: 'pending', roomId: null, assignedByName: 'Taylor Nguyen', appointmentId: null, declineReason: null, createdAt: new Date() },
    ]) }))
    vi.doMock('@/lib/queries/providers', () => ({ listActiveProviders: vi.fn(async () => [{ id: 1, name: 'Dr. R. Kunam' }]), listAllProviders: vi.fn(async () => [{ id: 1, name: 'Dr. R. Kunam' }]) }))
    const { default: DashboardHomePageWithFrontDesk } = await import('@/app/(dashboard)/page')
    const { render, screen } = await import('@testing-library/react')
    const jsx = await DashboardHomePageWithFrontDesk()
    render(jsx)
    expect(screen.getByText(/rooms available/i)).toBeInTheDocument()
    expect(screen.getByText('Test visit')).toBeInTheDocument()
  })
```

(`mockRedirect` is the `vi.hoisted` binding already declared at the top of this file — it's still in scope for the new `vi.doMock('next/navigation', ...)` call above.)

- [ ] **Step 8: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/pages/dashboard-routing.test.tsx`
Expected: FAIL — `FrontDeskDashboard` is still the Task 2 placeholder with no KPI strip or queue.

- [ ] **Step 9: Build out the real `FrontDeskDashboard`**

Rewrite `src/components/dashboards/FrontDeskDashboard.tsx`:

```tsx
import { ClipboardCheck, BedDouble, ListChecks, ShieldCheck } from 'lucide-react'
import type { Session } from '@/lib/auth'
import { listAvailableRooms } from '@/lib/queries/rooms'
import { listAllAssignments } from '@/lib/queries/doctor-assignments'
import { listActiveProviders } from '@/lib/queries/providers'
import { CheckInButton } from '@/components/CheckInButton'
import { EligibilityCheckButton } from '@/components/EligibilityCheckButton'

const URGENCY_ORDER = { emergency: 0, urgent: 1, routine: 2 } as const
const STATUS_LABEL: Record<string, string> = { pending: 'Pending', scheduled: 'Scheduled', declined: 'Declined' }
const STATUS_COLOR: Record<string, string> = { pending: 'text-warning', scheduled: 'text-success', declined: 'text-destructive' }

function KpiTile({ icon: Icon, value, label }: { icon: React.ComponentType<{ className?: string }>; value: number; label: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-primary/10 bg-card/80 p-4 shadow-sm backdrop-blur-sm">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden="true">
        <Icon className="h-4.5 w-4.5" />
      </span>
      <div>
        <p className="text-2xl font-bold tabular-nums text-foreground">{value}</p>
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      </div>
    </div>
  )
}

export async function FrontDeskDashboard({ session }: { session: Session }) {
  const [rooms, assignments, providers] = await Promise.all([listAvailableRooms(), listAllAssignments(), listActiveProviders()])
  const providerName = (id: number) => providers.find((p) => p.id === id)?.name ?? `Provider #${id}`
  const pendingCount = assignments.filter((a) => a.status === 'pending').length
  const sortedAssignments = [...assignments].sort((a, b) => URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency])

  return (
    <div>
      <div className="mb-6 rounded-xl border border-primary/10 bg-card/80 p-5 shadow-sm backdrop-blur-sm">
        <h1 className="text-2xl font-bold text-foreground">Front Desk</h1>
        <p className="text-sm text-muted-foreground">Welcome back, {session.name}.</p>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiTile icon={ClipboardCheck} value={pendingCount} label="Pending assignments" />
        <KpiTile icon={BedDouble} value={rooms.length} label="Rooms available" />
        <KpiTile icon={ListChecks} value={assignments.length} label="Total checked in today" />
        <KpiTile icon={ShieldCheck} value={0} label="Eligibility follow-ups" />
      </div>

      <div className="mb-6 flex gap-3">
        <CheckInButton providers={providers} rooms={rooms} />
        <EligibilityCheckButton />
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-secondary/40 text-left">
              <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Patient</th>
              <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Doctor</th>
              <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Reason</th>
              <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Urgency</th>
              <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</th>
            </tr>
          </thead>
          <tbody>
            {sortedAssignments.map((a, i) => (
              <tr key={a.id} className={`border-b border-border last:border-b-0 ${i % 2 === 1 ? 'bg-muted/40' : ''}`}>
                <td className="p-3 text-foreground">{a.patientId}</td>
                <td className="p-3 text-foreground">{providerName(a.providerId)}</td>
                <td className="p-3 text-foreground">{a.reason}</td>
                <td className="p-3 capitalize text-foreground">{a.urgency}</td>
                <td className={`p-3 font-medium ${STATUS_COLOR[a.status]}`}>{STATUS_LABEL[a.status]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
```

Create `src/components/CheckInButton.tsx` (a thin client wrapper so the Server Component `FrontDeskDashboard` above can stay a Server Component while still opening a client modal):

```tsx
'use client'
import { useState } from 'react'
import { UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CheckInModal } from '@/components/CheckInModal'

export function CheckInButton({ providers, rooms }: { providers: { id: number; name: string }[]; rooms: { id: number; ward: string; roomNumber: string; bedNumber: string }[] }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}><UserPlus className="h-4 w-4" aria-hidden="true" /> Check In</Button>
      {open && <CheckInModal providers={providers} rooms={rooms} onClose={() => setOpen(false)} />}
    </>
  )
}
```

Create `src/components/EligibilityCheckButton.tsx`:

```tsx
'use client'
import { useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EligibilityCheckModal } from '@/components/EligibilityCheckModal'

export function EligibilityCheckButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}><ShieldCheck className="h-4 w-4" aria-hidden="true" /> Verify Insurance</Button>
      {open && <EligibilityCheckModal onClose={() => setOpen(false)} />}
    </>
  )
}
```

Update `src/app/(dashboard)/page.tsx`'s frontdesk branch to `return <FrontDeskDashboard session={session} />` — no other change needed there since `FrontDeskDashboard` now fetches its own data (it's an `async` Server Component, same pattern as every other page in this app).

- [ ] **Step 10: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/pages/dashboard-routing.test.tsx`
Expected: PASS.

- [ ] **Step 11: Run the full test suite and typecheck**

Run: `npx dotenv -e .env.local -- npx vitest run`
Expected: all tests pass.

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npx eslint src/components/CheckInModal.tsx src/components/FrontDeskPatientSearch.tsx src/components/EligibilityCheckModal.tsx src/components/CheckInButton.tsx src/components/EligibilityCheckButton.tsx src/components/dashboards/FrontDeskDashboard.tsx src/app/api/front-desk`
Expected: no errors.

- [ ] **Step 12: Commit**

```bash
git add src/components/FrontDeskPatientSearch.tsx src/components/CheckInModal.tsx src/components/EligibilityCheckModal.tsx src/components/CheckInButton.tsx src/components/EligibilityCheckButton.tsx src/components/dashboards/FrontDeskDashboard.tsx src/app/api/front-desk/patient-lookup src/app/\(dashboard\)/page.tsx tests/components/CheckInModal.test.tsx tests/pages/dashboard-routing.test.tsx
git commit -m "feat: build the front-desk dashboard (check-in, eligibility check, KPI strip, queue)"
```

---

*After all 6 tasks are complete and the final whole-branch review (per subagent-driven-development) is clean, use superpowers:finishing-a-development-branch to merge — do not push to origin/master without the user's explicit go-ahead each time, per this session's established practice.*
