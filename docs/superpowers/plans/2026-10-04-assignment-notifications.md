# Doctor-Assignment Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire in-app notifications onto the existing doctor-assignment state machine: a pending-count nav badge for the doctor, one automated "your visit is confirmed" message for the patient, and an unacknowledged-decline badge plus "Mark handled" action for the front desk. Also close two missing status checks in the schedule/decline routes.

**Architecture:** Nothing new is stored for the doctor or front-desk notifications. Both badges are counts derived from `doctor_assignments` and computed in `(dashboard)/layout.tsx` through one `getNavBadges(session)` helper, then passed to `LeftNav` as a `badges` prop. The patient message is a fixed, pure template (`src/lib/notification-templates.ts`) sent through the existing `'system'` sender path. One `db.transaction` claims `patient_notified_at` and inserts the message together, so the message goes out at most once and a failed send leaves the column null. The schema change is three nullable columns, added with a hand-written idempotent SQL file that a human runs.

**Tech Stack:** Next.js 16 App Router (read `node_modules/next/dist/docs/` before touching routing/layout APIs, per AGENTS.md), Drizzle ORM 0.45 on `drizzle-orm/node-postgres` (TCP pool, real transactions available), Postgres on a single shared Neon DB, zod, Vitest + Testing Library (jsdom), Tailwind.

**Spec:** `docs/superpowers/specs/2026-09-29-assignment-notifications.md`. The spec is the authority for intent. Where its citations no longer match the code, this plan uses the current code (see "Spec divergences" below).

## Global Constraints

- **Additive-only schema:** exactly three nullable columns on `doctor_assignments`: `patient_notified_at timestamp`, `decline_acknowledged_at timestamp`, `decline_acknowledged_by_name text`. No enum value, no new table, no change to `messages`.
- **Single shared Neon DB.** Do NOT use `drizzle-kit push` / `npm run db:push`, because it mis-detects renames on this shared DB. Do NOT use `drizzle-kit generate` or the `drizzle/` journal either, because the journal is stale. The migration is the hand-written idempotent file `scripts/migrations/2026-10-04-assignment-notifications.sql` (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`), applied by `scripts/apply-sql.mjs`, a Node `pg` script. `psql` is not installed.
- **Agents never write DDL to the shared DB.** An automatic permission classifier blocks it. At Task 3 the executing agent STOPS and hands the human the exact command:
  `! node --env-file=/Users/k2a/Desktop/clinsync/.worktrees/assignment-notifications-v2/.env.local /Users/k2a/Desktop/clinsync/.worktrees/assignment-notifications-v2/scripts/apply-sql.mjs /Users/k2a/Desktop/clinsync/.worktrees/assignment-notifications-v2/scripts/migrations/2026-10-04-assignment-notifications.sql`
  Test steps marked **[REQUIRES MIGRATION]** may not be claimed as passing until the human confirms the migration ran. After Task 3 changes the Drizzle schema, every `select().from(doctorAssignments)` names the new columns, so those reads fail until the migration has run.
- **Work only in** `/Users/k2a/Desktop/clinsync/.worktrees/assignment-notifications-v2` (branch `feature/assignment-notifications-v2`). Never touch `/Users/k2a/Desktop/clinsync` (main checkout) or other worktrees. You may only *read* `/Users/k2a/Desktop/clinsync/.env.local` to copy it.
- **Test hygiene:** each test creates its own rows and deletes them by explicit id in `afterEach`. Delete `messages` first, then `doctor_assignments`, then `appointments`, because of the `appointment_id` FK. Never run the full suite (`npm test`), because it hangs on the shared DB. Run one file at a time: `npx dotenv -e .env.local -- npx vitest run <path>`.
- **Route gates:** the role check goes inline, immediately after `const session = await requireSession(); if (session instanceof NextResponse) return session`. Audit with `logAudit(session, action, patientId)`.
- **Naming:** no `Tebra` or `IntakeQ` in any new code, copy or identifier. Patient display name is `patients.name`.
- **Sender identity:** `senderRole: 'system'`, `senderName` = the existing `SYSTEM_SENDER_NAME` constant exported from `src/lib/queries/eligibility.ts:67` (`'Clinsync (Automated)'`). Import it; do not re-declare the string.
- **Message copy is fixed code.** Every interpolation and every bullet comes verbatim from spec §5.2. Nothing is customized per send, nothing is stored in settings, and no patient-supplied text enters the message.
- **Date/time:** local getters/formatters only (the spec §8 / `src/lib/queries/reports.ts:24-38` rule). Never mix `toISOString()` with a local formatter. `practiceTimezone` stays unread.
- **UI verification:** every UI change is checked with real HTTP against `next dev` on port 3107 in this worktree, using staff cookies minted with `buildSessionCookieValue(role, name, userId)`. Paste the actual curl output into the task report.
- Status display convention: a colored dot plus a plain text label, never color alone (`src/components/AssignmentStatusChip.tsx:10-11`).

## Review Focus

1. **Unmatched provider.** A `pi` whose session resolves to no provider row sees the explicit warning on `/doctor`, gets no nav badge, and never sees "Queue clear." or a `0` count. Tests: Task 9 (`doctor.test.tsx` unmatched case) and Task 10 (`nav-badges.test.ts` "pi unmatched → no /doctor key").
2. **Emergency sorts above routine.** Ordering uses an explicit `CASE`, not enum collation. The enum is declared `['routine','urgent','emergency']`, so a plain sort would be backwards. Test: Task 4 `orders emergency > urgent > routine, oldest first within a band`.
3. **Double schedule POST.** The second POST returns 409, creates no second `appointments` row, and leaves exactly one patient message. Test: Task 6.
4. **Declining an already-scheduled assignment** returns 409 and leaves `status` and `appointmentId` unchanged. Test: Task 7.
5. **Message idempotency rests on `patientNotifiedAt`.** Two direct calls to `notifyPatientOfScheduledAssignment`, sequential or concurrent, send exactly one message. Test: Task 5.
6. **Inpatient visits get the "overnight bag" bullet** and outpatient visits do not. Tests: Task 1 (pure) and Task 5 (DB message body).
7. **Dates near local midnight.** 23:30 and 00:15 local render the local calendar day and time. Test: Task 1, also run under `TZ=Pacific/Kiritimati`.
8. **A failed notification leaves `patientNotifiedAt` null.** If `sendMessage` throws, the route returns 500, the column stays null, no message exists, and the assignment is still `scheduled`. Test: Task 6.

## Spec divergences (current code vs. spec; spec stays authority for intent)

| # | Spec says | Current code | Plan resolution |
|---|---|---|---|
| D1 | Patient name via `nameTebra ?? nameIntakeq` (§4.4) | `patients.name` (unified record; `listMessageThreads` now reads `patients.name`, `src/lib/queries/messages.ts:96`) | Join `patients.name` in `listPendingAssignmentsForProvider` (Task 4). |
| D2 | `/doctor` provider match at `doctor/page.tsx:50-52`, last-name match only; panel "Assigned to you" at 44-53 that renders nothing when empty | Lines 24-29. Uses `resolveSessionProvider(session)` (real `users→staff_members→providers` link, `src/lib/provider-identity.ts`) **with** the fuzzy last-name fallback. Panel is titled "Triage Queue" (97-128) and renders "Queue clear." plus a `0` pill when the list is empty, which is exactly the false zero the spec forbids | Extract the page's exact resolution into `resolveDoctorQueueProvider(session)` (new `src/lib/doctor-queue-provider.ts`; `provider-identity.ts` stays fallback-free per its own doc comment) and use it in both the page and the badge (Tasks 9, 10). Unmatched → warning, no pill, no "Queue clear." |
| D3 | Schedule/decline ownership uses "the same provider resolution" as the page | Routes still use **only** the fuzzy last-name match (`schedule/route.ts:44-49`, `decline/route.ts:31-36`) | Unchanged (out of spec scope). `providerName` for the message comes from the route's `providerMatch.name`, as the spec says. Flagged for human decision. |
| D4 | `LeftNav` at `:94`, static `ITEMS`, props `{ role }` | `NAV_ITEMS` with per-item `roles` (line 30), `NavLink` at 119, `LeftNav({ role })` at 138 | Add an optional `badges` prop and a `badge` prop on `NavLink` (Task 2). |
| D5 | Schema citations `schema.ts:530-549` (doctorAssignments), `:733-742` (messages), `:409` (practiceTimezone) | 569-588, 828-843, 458 | Line numbers updated in tasks. |
| D6 | Reuse the date helper pair at `reports.ts:22-37` | Helpers are private (`formatDate`/`formatTime`, 24-38). `formatDate` yields `YYYY-MM-DD`, which is not the message format | New local-getter formatters in `notification-templates.ts` follow the same rule. `reports.ts` is untouched. |
| D7 | Idempotency: re-read `patientNotifiedAt`, return if set, send, then set (§5.1) | The merged eligibility precedent (`eligibility.ts:73-117`) claims the timestamp *before* sending and never un-claims it, which would leave it set when the send fails | One `db.transaction`: conditional `UPDATE … SET patient_notified_at = now() WHERE id = $1 AND patient_notified_at IS NULL RETURNING id`, then the message insert on the same `tx`. Concurrent callers serialize on the row lock, so only one sends. A failed insert rolls back the claim, so the column stays null (§5.1 failure rule). `sendMessage` gains an optional trailing executor param, matching the `DbExecutor` precedent in `src/lib/queries/form-submission-consents.ts:34-36`. Signature stays `Promise<void>`. |
| D8 | "If `sendMessage` throws, the route returns 500" | An uncaught throw in a route handler surfaces as a rejected promise in direct-call tests | The route catches *only* the notify call. It audits `'scheduled assignment into appointment; patient notification FAILED'` (the appointment really was committed) and returns 500 `{ error: 'The appointment was scheduled, but the confirmation message to the patient could not be sent. Please message the patient manually.' }`. Nothing is swallowed. |
| D9 | Decline route "has no test file today" | Decline cases exist inside `tests/api/front-desk-assignments-schedule.test.ts:75-101` | New `tests/api/front-desk-assignments-decline.test.ts` per spec. Existing cases stay where they are. |
| D10 | Prerequisite eligibility work assumed | Confirmed merged: `messages.senderRole` enum includes `'system'` (`schema.ts:831`); `SYSTEM_SENDER_NAME` (`eligibility.ts:67`); "AUTOMATED NOTICE" banner (`MessageThreadView.tsx:29-37`, `whitespace-pre-wrap` body); `markReadByPatient`/`getUnreadCountForPatient` treat `'system'` like `'provider'` (`messages.ts:47-75`); portal unread at `patient-portal.ts:56` (spec says 54) | Consumed as is. |
| D11 | (implicit) worktree ready to run | The worktree has no `node_modules` and no `.env.local`. The DB client is `node-postgres`, not Neon HTTP | Task 1 Step 0 sets these up. |
| D12 | Check-in `route.ts:73`, `createDoctorAssignment` `:18`, `AssignmentStatusChip` takes `declineReason` | Confirmed accurate | Untouched. |

---

## File Structure

| File | Responsibility |
|---|---|
| Create `src/lib/notification-templates.ts` | Pure: confirmation body plus local date/time formatting. |
| Create `src/components/AssignmentUrgencyChip.tsx` | Dot plus label for `urgency`. |
| Modify `src/components/LeftNav.tsx` | `badges` prop, count pill on `NavLink`. |
| Create `scripts/migrations/2026-10-04-assignment-notifications.sql`, `scripts/apply-sql.mjs` | Idempotent DDL plus a human-run applier. |
| Modify `src/db/schema.ts:569-588` | Three nullable columns. |
| Modify `src/lib/queries/doctor-assignments.ts` | Ordering, counts, acknowledge, notify. |
| Modify `src/lib/queries/messages.ts:28-31` | Optional executor on `sendMessage`. |
| Modify `src/app/api/front-desk/assignments/[id]/schedule/route.ts`, `.../decline/route.ts` | Status guards; notify. |
| Create `src/app/api/front-desk/assignments/[id]/acknowledge-decline/route.ts` | Acknowledge endpoint. |
| Create `src/lib/doctor-queue-provider.ts` | The `/doctor` provider resolution, shared by page and badge. |
| Create `src/lib/nav-badges.ts` | Role-gated badge counts. |
| Modify `src/app/(dashboard)/layout.tsx`, `(dashboard)/doctor/page.tsx`, `(dashboard)/front-desk/assignments/page.tsx` | Wire-up. |
| Create `src/components/AcknowledgeDeclineButton.tsx` | "Mark handled" client action. |

---

### Task 1: Pure confirmation-message template

**Files:**
- Create: `src/lib/notification-templates.ts`
- Test: `tests/lib/notification-templates.test.ts`

**Interfaces:**
- Produces:
  - `export interface VisitConfirmationInput { providerName: string; startsAt: Date; visitReason: string; visitType: 'inpatient' | 'outpatient' }`
  - `export function formatVisitDate(d: Date): string`, e.g. `"Tuesday, November 3, 2026"`
  - `export function formatVisitTime(d: Date): string`, e.g. `"9:00 AM"` (plain ASCII space)
  - `export const WHAT_TO_BRING: readonly string[]` (the 5 base bullets, in order)
  - `export const INPATIENT_OVERNIGHT_BAG: string`
  - `export function buildVisitConfirmationBody(input: VisitConfirmationInput): string`

- [ ] **Step 0: Worktree setup (no DB writes)**

```bash
cd /Users/k2a/Desktop/clinsync/.worktrees/assignment-notifications-v2
cp /Users/k2a/Desktop/clinsync/.env.local .env.local   # gitignored (.env*)
npm ci
git status --short   # expect: clean (no .env.local listed)
```

- [ ] **Step 1: Write the failing test** `tests/lib/notification-templates.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { buildVisitConfirmationBody, formatVisitDate, formatVisitTime, WHAT_TO_BRING, INPATIENT_OVERNIGHT_BAG } from '@/lib/notification-templates'

const base = { providerName: 'Dr. Rajiv Kunam', startsAt: new Date(2026, 10, 3, 9, 0), visitReason: 'Follow-up', visitType: 'outpatient' as const }

describe('buildVisitConfirmationBody', () => {
  it('names provider, local day, local time and reason', () => {
    const body = buildVisitConfirmationBody(base)
    expect(body.startsWith('Your visit is confirmed.')).toBe(true)
    expect(body).toContain('Dr. Rajiv Kunam will see you on Tuesday, November 3, 2026 at 9:00 AM.')
    expect(body).toContain('Reason for visit: Follow-up')
    expect(body).toContain("If this time doesn't work, reply to this message and our front desk will help you change it.")
  })
  it('lists all five base bullets in order', () => {
    expect(WHAT_TO_BRING).toEqual([
      'A photo ID',
      'Your insurance card',
      'A current list of everything you take — prescriptions, over-the-counter medicines, vitamins and supplements — with the dose for each',
      "Any forms we sent you that you haven't finished yet",
      'A payment method, in case there is a copay due at the visit',
    ])
    const body = buildVisitConfirmationBody(base)
    for (const item of WHAT_TO_BRING) expect(body).toContain(`• ${item}`)
  })
  it('adds the overnight-bag bullet only for inpatient', () => {
    expect(INPATIENT_OVERNIGHT_BAG).toBe('An overnight bag — a few days of comfortable clothes and toiletries, and your medicines in their original labelled containers')
    expect(buildVisitConfirmationBody({ ...base, visitType: 'inpatient' })).toContain(`• ${INPATIENT_OVERNIGHT_BAG}`)
    expect(buildVisitConfirmationBody(base)).not.toContain('overnight bag')
  })
  it('renders 23:30 and 00:15 local on the local calendar day (reports.ts midnight trap)', () => {
    const late = new Date(2026, 10, 3, 23, 30)
    expect(formatVisitDate(late)).toBe('Tuesday, November 3, 2026')
    expect(formatVisitTime(late)).toBe('11:30 PM')
    const early = new Date(2026, 10, 4, 0, 15)
    expect(formatVisitDate(early)).toBe('Wednesday, November 4, 2026')
    expect(formatVisitTime(early)).toBe('12:15 AM')
    // Same day the patient portal's own formatter shows (local getters).
    expect(formatVisitDate(late)).toContain(String(late.getDate()))
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**
Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/notification-templates.test.ts`
Expected: FAIL, because the module `@/lib/notification-templates` does not exist yet.

- [ ] **Step 3: Implement `src/lib/notification-templates.ts`**
  - `formatVisitDate`: `d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })`.
  - `formatVisitTime`: `d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })`.
  - Both are local formatters with no `toISOString`. Normalize ` ` and ` ` to `' '`, because Node's ICU emits a narrow no-break space before AM/PM.
  - Add a header comment citing the `reports.ts:24-29` rule.
  - The body is lines joined with `'\n'`, laid out exactly like this:
    ```
    Your visit is confirmed.
    <blank>
    {providerName} will see you on {date} at {time}.
    <blank>
    Reason for visit: {visitReason}
    <blank>
    Please bring with you:
    • item  (one per WHAT_TO_BRING, then INPATIENT_OVERNIGHT_BAG iff inpatient)
    <blank>
    If this time doesn't work, reply to this message and our front desk will help you change it.
    ```

- [ ] **Step 4: Run it and confirm it passes, in two timezones**
  - Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/notification-templates.test.ts`
  - Run: `TZ=Pacific/Kiritimati npx dotenv -e .env.local -- npx vitest run tests/lib/notification-templates.test.ts`
  - Expected: both runs PASS (4 tests).

- [ ] **Step 5: Commit**
`git add src/lib/notification-templates.ts tests/lib/notification-templates.test.ts && git commit -m "feat: add fixed visit-confirmation message template"`

---

### Task 2: Urgency chip and LeftNav count badges (pure UI)

**Files:**
- Create: `src/components/AssignmentUrgencyChip.tsx`
- Modify: `src/components/LeftNav.tsx:119-134` (`NavLink`), `:138` (`LeftNav`), and the three `NavLink` call sites (170, 200, 214)
- Test: `tests/components/AssignmentUrgencyChip.test.tsx`, `tests/components/LeftNav.test.tsx` (extend)

**Interfaces:**
- Produces:
  - `export function AssignmentUrgencyChip({ urgency }: { urgency: 'routine' | 'urgent' | 'emergency' }): JSX.Element`. Labels: `Routine` / `Urgent` / `Emergency`. Dot classes: `bg-muted-foreground` / `bg-warning` / `bg-destructive`, with matching `text-*`. The dot is `aria-hidden="true"`.
  - `export type NavBadges = Partial<Record<string, number>>` (exported from `LeftNav.tsx`)
  - `LeftNav({ role, badges }: { role: Role; badges?: NavBadges })`

- [ ] **Step 1: Write the failing tests**

`AssignmentUrgencyChip.test.tsx`: for each urgency, `render(<AssignmentUrgencyChip urgency="emergency" />)`, then `getByText('Emergency')`. The dot `span` has `aria-hidden="true"` and class `bg-destructive`. Run the same check for `urgent → bg-warning` and `routine → bg-muted-foreground`.

Append to `LeftNav.test.tsx`:
```ts
it('shows a count pill on My Patients when badges["/doctor"] > 0', () => {
  render(<LeftNav role="pi" badges={{ '/doctor': 3 }} />)
  expect(within(screen.getByRole('link', { name: /my patients/i })).getByText('3')).toBeInTheDocument()
})
it('renders no pill for a 0 or missing badge', () => {
  render(<LeftNav role="pi" badges={{ '/doctor': 0 }} />)
  expect(screen.getByRole('link', { name: /my patients/i }).textContent).toBe('My Patients')
})
it('shows the decline pill on Assignments for frontdesk', () => {
  render(<LeftNav role="frontdesk" badges={{ '/front-desk/assignments': 2 }} />)
  expect(within(screen.getByRole('link', { name: /assignments/i })).getByText('2')).toBeInTheDocument()
})
```
Add `within` to the `@testing-library/react` import.

- [ ] **Step 2: Run them and confirm they fail**
Run: `npx dotenv -e .env.local -- npx vitest run tests/components/AssignmentUrgencyChip.test.tsx tests/components/LeftNav.test.tsx`
Expected: FAIL. The module is missing and the pill text is not found.

- [ ] **Step 3: Implement**
  - `NavLink` gains `badge?: number`. When `badge > 0`, render `<span className="ml-auto flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-accent px-1 text-[11px] font-semibold text-accent-foreground">{badge}</span>`. These classes are copied from `(dashboard)/messages/page.tsx:66`.
  - Every `NavLink` call site passes `badge={badges?.[item.href]}`.

- [ ] **Step 4: Run them and confirm they pass**
Same command. Expected: all tests PASS, including the 4 pre-existing LeftNav tests.

- [ ] **Step 5: Commit**
`git commit -m "feat: add urgency chip and LeftNav count badges"` (git add the 4 files)

---

### Task 3: Schema columns and migration (HUMAN GATE)

**Files:**
- Create: `scripts/migrations/2026-10-04-assignment-notifications.sql`
- Create: `scripts/apply-sql.mjs`
- Modify: `src/db/schema.ts:569-588` (`doctorAssignments`)

**Interfaces:**
- Produces, on `DoctorAssignmentRow`: `patientNotifiedAt: Date | null`, `declineAcknowledgedAt: Date | null`, `declineAcknowledgedByName: string | null`.

- [ ] **Step 1: Write the SQL file (exact contents)**

```sql
-- 2026-10-04 doctor-assignment notifications (spec 2026-09-29-assignment-notifications.md §3).
-- Additive, nullable, idempotent. Safe to re-run. Shared Neon DB: other branches
-- insert doctor_assignments rows without knowing these columns exist.
BEGIN;
ALTER TABLE doctor_assignments ADD COLUMN IF NOT EXISTS patient_notified_at timestamp;
ALTER TABLE doctor_assignments ADD COLUMN IF NOT EXISTS decline_acknowledged_at timestamp;
ALTER TABLE doctor_assignments ADD COLUMN IF NOT EXISTS decline_acknowledged_by_name text;
COMMIT;
```

- [ ] **Step 2: Write `scripts/apply-sql.mjs`**
  - ESM, ~25 lines.
  - Runs `dns.setDefaultResultOrder('ipv4first')`. IPv6 egress is dead here; see the `src/db/client.ts:21-29` comment.
  - Reads `process.argv[2]`, then `new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })` and `client.query(sqlText)`.
  - Then prints `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'doctor_assignments' AND column_name IN ('patient_notified_at','decline_acknowledged_at','decline_acknowledged_by_name') ORDER BY column_name`.
  - Exits non-zero on error.
  - The agent writes this file. It does **not** run it.

- [ ] **Step 3: Add the columns to `doctorAssignments` after `queueTicketNumber`**
Add `patientNotifiedAt: timestamp('patient_notified_at')`, `declineAcknowledgedAt: timestamp('decline_acknowledged_at')`, `declineAcknowledgedByName: text('decline_acknowledged_by_name')`, with a comment pointing to the SQL file and the "never cleared" rule for `patientNotifiedAt` (spec §8).

- [ ] **Step 4: Typecheck**
Run: `npx tsc --noEmit`
Expected: no errors. Fix any object literal typed as `DoctorAssignmentRow` that is now missing fields, for example in tests.

- [ ] **Step 5: Commit**
`git add scripts/ src/db/schema.ts && git commit -m "feat: add nullable notification columns to doctor_assignments"`

- [ ] **Step 6: STOP and hand off to the human.** Report this message verbatim:
  > Please apply the additive migration (3 nullable `ADD COLUMN IF NOT EXISTS`, idempotent) by running:
  > `! node --env-file=/Users/k2a/Desktop/clinsync/.worktrees/assignment-notifications-v2/.env.local /Users/k2a/Desktop/clinsync/.worktrees/assignment-notifications-v2/scripts/apply-sql.mjs /Users/k2a/Desktop/clinsync/.worktrees/assignment-notifications-v2/scripts/migrations/2026-10-04-assignment-notifications.sql`
  > Expected output: 3 rows (`decline_acknowledged_at | timestamp without time zone | YES`, `decline_acknowledged_by_name | text | YES`, `patient_notified_at | timestamp without time zone | YES`).

  While waiting, you may write code and tests for Tasks 4–10 and run `npx tsc --noEmit` and the non-DB tests (Tasks 9 and 10 page/unit tests are mocked). Do not claim any **[REQUIRES MIGRATION]** test passes until the human confirms.

---

### Task 4: Query layer (ordering, counts, acknowledge)

**Files:**
- Modify: `src/lib/queries/doctor-assignments.ts:24-29` (`listPendingAssignmentsForProvider`), `:49-51` (`listAllAssignments`); append new functions
- Test: `tests/lib/queries/doctor-assignments.test.ts` (extend) **[REQUIRES MIGRATION]**

**Interfaces:**
- Consumes: the Task 3 columns.
- Produces:
  - `export type PendingAssignmentRow = DoctorAssignmentRow & { patientName: string }`
  - `listPendingAssignmentsForProvider(providerId: number): Promise<PendingAssignmentRow[]>`. Inner join on `patients` (`patients.name`). Ordered emergency → urgent → routine, then `createdAt` ascending, then `id` ascending.
  - `countPendingAssignmentsForProvider(providerId: number): Promise<number>`
  - `countUnacknowledgedDeclines(): Promise<number>`, counting `status = 'declined' AND decline_acknowledged_at IS NULL`
  - `acknowledgeDecline(assignmentId: number, acknowledgedByName: string): Promise<DoctorAssignmentRow | null>`. A conditional update `WHERE id = $1 AND status = 'declined' AND decline_acknowledged_at IS NULL` that sets both columns. Returns `null` when no row matched.
  - `listAllAssignments()`: unacknowledged declines first, then `createdAt` descending.

- [ ] **Step 1: Write the failing tests** (create rows, then push their ids to `createdAssignmentIds`)
  - `orders emergency > urgent > routine, oldest first within a band`: on one provider, create in this order: routine R1, emergency E, routine R2, urgent U. Filter the result to these 4 ids. Expect `[E, U, R1, R2]`.
  - `returns patientName from patients.name`: the created assignment for `RD-0001` has `patientName` equal to `(select name from patients where id='RD-0001')`.
  - `countPendingAssignmentsForProvider counts only that provider's pending rows`: count before, create 2 pending plus 1 that is then declined, count after = before + 2.
  - `countUnacknowledgedDeclines`: before, then decline one created row → before + 1, then `acknowledgeDecline(id, 'Taylor Nguyen')` → before. The returned row has `declineAcknowledgedByName === 'Taylor Nguyen'` and a non-null `declineAcknowledgedAt`.
  - `acknowledgeDecline returns null for pending or already-acknowledged rows`.
  - `listAllAssignments puts an unacknowledged decline before a newer pending row`: create D (then decline it), then P. Expect `indexOf(D) < indexOf(P)`.

- [ ] **Step 2: Run and confirm failure**
`npx dotenv -e .env.local -- npx vitest run tests/lib/queries/doctor-assignments.test.ts`. Expected: FAIL (functions are missing and the order is wrong).

- [ ] **Step 3: Implement.** The spec pins the ordering expression. Use exactly:
```ts
.orderBy(
  sql`CASE ${doctorAssignments.urgency} WHEN 'emergency' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END`,
  asc(doctorAssignments.createdAt), asc(doctorAssignments.id),
)
```
For `listAllAssignments`, use `sql\`CASE WHEN ${doctorAssignments.status} = 'declined' AND ${doctorAssignments.declineAcknowledgedAt} IS NULL THEN 0 ELSE 1 END\``, then `desc(createdAt)`. Counts use `sql<number>\`count(*)::int\``, as `messages.ts:57` does.

- [ ] **Step 4: Run and confirm pass** (same command, all tests PASS) **[REQUIRES MIGRATION]**; then `npx tsc --noEmit`.

- [ ] **Step 5: Commit** `git commit -m "feat: urgency-ordered doctor queue, badge counts, decline acknowledgement query"`

---

### Task 5: `notifyPatientOfScheduledAssignment`

**Files:**
- Modify: `src/lib/queries/messages.ts:28-31` (`sendMessage`)
- Modify: `src/lib/queries/doctor-assignments.ts` (append)
- Test: `tests/lib/queries/doctor-assignments.test.ts` (extend) **[REQUIRES MIGRATION]**

**Interfaces:**
- Consumes: `buildVisitConfirmationBody` (Task 1), `SYSTEM_SENDER_NAME` from `@/lib/queries/eligibility`.
- Produces:
  - `sendMessage(patientId: string, senderRole: SenderRole, senderName: string, body: string, internal = false, db: Pick<ReturnType<typeof getDb>, 'insert'> = getDb())`. Existing callers are unchanged.
  - `export async function notifyPatientOfScheduledAssignment(assignment: DoctorAssignmentRow, appointment: typeof appointments.$inferSelect, providerName: string): Promise<void>`

- [ ] **Step 1: Write the failing tests.** Track message ids and delete them by `inArray(messages.id, ids)` before deleting assignments.
  - `sends exactly one system message when called twice`: create an assignment and an appointment, then `await notify(...)` twice. Then `select from messages where patientId = 'RD-0001' and senderRole = 'system' and createdAt >= testStart and body like '%Your visit is confirmed.%'` has length 1. Its `senderName` is `'Clinsync (Automated)'`. The assignment row's `patientNotifiedAt` is not null.
  - `concurrent calls send exactly one message`: `await Promise.all([notify(...), notify(...)])` leaves the same query with length 1.
  - `inpatient assignment message includes the overnight bag bullet`: with `visitType: 'inpatient'`, the body contains `'• An overnight bag'`.

- [ ] **Step 2: Run and confirm failure.** Same per-file command. Expected: FAIL (`notifyPatientOfScheduledAssignment` is not exported).

- [ ] **Step 3: Implement.**
  - Wrap the work in `getDb().transaction(async (tx) => { … })`.
  - Claim inside it: `tx.update(doctorAssignments).set({ patientNotifiedAt: new Date() }).where(and(eq(doctorAssignments.id, assignment.id), isNull(doctorAssignments.patientNotifiedAt))).returning({ id: doctorAssignments.id })`. If nothing comes back, return.
  - Otherwise call `sendMessage(assignment.patientId, 'system', SYSTEM_SENDER_NAME, buildVisitConfirmationBody({ providerName, startsAt: appointment.startsAt, visitReason: appointment.visitReason, visitType: assignment.visitType }), false, tx)`.
  - Do not catch errors. A throw rolls back the claim.
  - Add a comment explaining divergence D7: why a transaction rather than the eligibility claim-first pattern.

- [ ] **Step 4: Run and confirm pass** **[REQUIRES MIGRATION]**. Also rerun `tests/lib/queries/messages.test.ts` (no regressions) and `npx tsc --noEmit`.

- [ ] **Step 5: Commit** `git commit -m "feat: idempotent automated patient confirmation on assignment scheduling"`

---

### Task 6: Schedule route (status guard, notify, failure path)

**Files:**
- Modify: `src/app/api/front-desk/assignments/[id]/schedule/route.ts:47-66`
- Test: `tests/api/front-desk-assignments-schedule.test.ts` (extend) **[REQUIRES MIGRATION]**

**Interfaces:**
- Consumes: `notifyPatientOfScheduledAssignment` (Task 5).

- [ ] **Step 1: Write the failing tests.**
  - Add a passthrough mock at the top: `vi.mock('@/lib/queries/messages', async () => { const a = await vi.importActual<typeof import('@/lib/queries/messages')>('@/lib/queries/messages'); return { ...a, sendMessage: vi.fn(a.sendMessage) } })`.
  - Extend `afterEach` to delete tracked message ids first.
  - Helper `systemMsgs(patientId, since)`: selects `'system'` messages with `createdAt >= since`.
  - `success inserts exactly one system message for that patient and sets patientNotifiedAt`. Also assert that `systemMsgs('RD-0002', since)` stays length 0.
  - `second POST on a scheduled assignment → 409, no second appointment, still one message`. The 2nd POST uses a *different* time (`10:00–10:30`). Assert status 409 and body `{ error: 'This assignment has already been scheduled or declined.' }`. Assert no `appointments` row exists for that provider at the second `startsAt`. Assert `systemMsgs` length is still 1 and `doctorAssignments.appointmentId` is unchanged.
  - `POST on a declined assignment → 409`: decline via `declineAssignment` first.
  - `send failure → 500, patientNotifiedAt null, still scheduled, no message`: set `vi.mocked(sendMessage).mockRejectedValueOnce(new Error('boom'))`, then expect `res.status === 500`. The row shows `status === 'scheduled'` and `patientNotifiedAt === null`, and `systemMsgs` length is 0. Push `row.appointmentId` for cleanup.
  - Existing cases must still pass. Their message rows must also be cleaned up: push them from `systemMsgs` after each success.

- [ ] **Step 2: Run and confirm failure.** `npx dotenv -e .env.local -- npx vitest run tests/api/front-desk-assignments-schedule.test.ts`. Expected: the new cases FAIL (no 409, no message).

- [ ] **Step 3: Implement.**
  - Right after the ownership check (line 49) and before `hasSchedulingConflict`: `if (assignmentRow.status !== 'pending') return NextResponse.json({ error: 'This assignment has already been scheduled or declined.' }, { status: 409 })`.
  - After `scheduleAssignment`, wrap `notifyPatientOfScheduledAssignment(updated ?? assignmentRow, appointment, providerMatch.name)` in try/catch.
    - On success, `logAudit(session, 'scheduled assignment into appointment and notified patient', assignmentRow.patientId)`.
    - On failure, `console.error`, then `logAudit(session, 'scheduled assignment into appointment; patient notification FAILED', assignmentRow.patientId)`, then 500 with the D8 copy.
  - Remove the old single audit line.

- [ ] **Step 4: Run and confirm pass** **[REQUIRES MIGRATION]**. Then run `npx tsc --noEmit`.

- [ ] **Step 5: Commit** `git commit -m "fix: reject re-scheduling a non-pending assignment; notify patient on confirmation"`

---

### Task 7: Decline route status guard

**Files:**
- Modify: `src/app/api/front-desk/assignments/[id]/decline/route.ts:36-38`
- Test: create `tests/api/front-desk-assignments-decline.test.ts` **[REQUIRES MIGRATION]**

- [ ] **Step 1: Write the failing tests.** Use the same `vi.mock('@/lib/auth', …pi 'Dr. R. Kunam'…)` and `kunamProviderId()` helper as the schedule test, plus id-tracked cleanup.
  - `declining a scheduled assignment → 409 and leaves status/appointmentId untouched`: create an assignment and an appointment, then `scheduleAssignment`. POST decline. Expect 409 with body `{ error: 'This assignment has already been scheduled or declined.' }`. The row still has `status === 'scheduled'`, the same `appointmentId`, and `declineReason === null`.
  - `normal decline writes declineReason and sends no message`: count all `messages` for `RD-0001` before, POST, expect 200 and `declineReason`, then the count is unchanged.

- [ ] **Step 2: Run and confirm failure.** `npx dotenv -e .env.local -- npx vitest run tests/api/front-desk-assignments-decline.test.ts`. The first case FAILS (200).

- [ ] **Step 3: Implement.** Add the same guard and copy as Task 6, immediately after the ownership check.

- [ ] **Step 4: Run and confirm pass** **[REQUIRES MIGRATION]**. Also rerun `tests/api/front-desk-assignments-schedule.test.ts`.

- [ ] **Step 5: Commit** `git commit -m "fix: reject declining an assignment that is no longer pending"`

---

### Task 8: `POST /api/front-desk/assignments/[id]/acknowledge-decline`

**Files:**
- Create: `src/app/api/front-desk/assignments/[id]/acknowledge-decline/route.ts`
- Test: create `tests/api/front-desk-assignments-acknowledge-decline.test.ts` **[REQUIRES MIGRATION]**

**Interfaces:**
- Consumes: `acknowledgeDecline`, `countUnacknowledgedDeclines` (Task 4).
- Produces: `POST(request: NextRequest, { params }: { params: Promise<{ id: string }> })`. No body. Behavior:
  - 401 when there is no session.
  - 403 unless the role is in `['frontdesk','admin','crc']`.
  - 400 for a non-integer id.
  - 404 when the assignment is unknown.
  - 409 `{ error: 'Only a declined assignment can be marked handled.' }` when `status !== 'declined'`.
  - 409 `{ error: 'This decline has already been marked handled.' }` when it is already acknowledged, or when `acknowledgeDecline` returns null (race).
  - 200 with the updated row on success, after `logAudit(session, 'acknowledged declined assignment', row.patientId)`.

- [ ] **Step 1: Write the failing tests.** Mock auth with a module-scope mutable role/name (the `tests/api/rbac-route-gates.test.ts:15-20` pattern), defaulting to `{ role: 'frontdesk', name: 'Taylor Nguyen', userId: null }`.
  - `404 for unknown id` (use `2147483000`).
  - `409 for pending` and `409 for scheduled`. For scheduled, set it with `scheduleAssignment` on a created appointment.
  - `409 for an already-acknowledged decline`.
  - `403 for pi`, and the row stays unacknowledged.
  - `success sets both columns and drops the unacknowledged count by 1`: decline, then `before = countUnacknowledgedDeclines()`, then POST, then expect 200, `declineAcknowledgedByName === 'Taylor Nguyen'`, `declineAcknowledgedAt` not null, and the count equals `before - 1`.
  - `admin and crc are allowed`.

- [ ] **Step 2: Run and confirm failure.** `npx dotenv -e .env.local -- npx vitest run tests/api/front-desk-assignments-acknowledge-decline.test.ts`. Expected: FAIL (the module does not exist).

- [ ] **Step 3: Implement.** Follow the shape of the decline route: inline role gate after `requireSession`, then load the row, then the guards, then `acknowledgeDecline(id, session.name)`.

- [ ] **Step 4: Run and confirm pass** **[REQUIRES MIGRATION]**. Then run `npx tsc --noEmit`.

- [ ] **Step 5: Commit** `git commit -m "feat: acknowledge-decline endpoint for front desk"`

---

### Task 9: `/doctor` panel (shared resolution, unmatched warning, richer rows)

**Files:**
- Create: `src/lib/doctor-queue-provider.ts`
- Modify: `src/app/(dashboard)/doctor/page.tsx:5, 27-29, 96-128`
- Test: create `tests/lib/doctor-queue-provider.test.ts` (DB read-only on `providers`/`staff_members`; does not need the migration). Extend `tests/pages/doctor.test.tsx` (mocked; does not need the migration).

**Interfaces:**
- Consumes: `resolveSessionProvider` (`src/lib/provider-identity.ts:13`), `listActiveProviders`, `PendingAssignmentRow` (Task 4), `AssignmentUrgencyChip` (Task 2).
- Produces: `export async function resolveDoctorQueueProvider(session: Session): Promise<{ id: number; name: string } | null>`. It returns `resolveSessionProvider(session)` or, failing that, the first active provider whose `name` includes the session's last name, case-insensitive. This is the page's exact current logic, moved. Its doc comment states that this is the deliberate fail-open choice that `provider-identity.ts:10-12` says belongs at the call site.

- [ ] **Step 1: Write the failing tests.**
  - `doctor-queue-provider.test.ts`:
    - `{ role:'pi', name:'Dr. R. Kunam', userId:null }` resolves to a row whose `name` contains `'Kunam'`.
    - `{ role:'pi', name:'Dr. Nobody Matchington', userId:null }` resolves to `null`.
  - `doctor.test.tsx`:
    - In every `vi.mock`/`vi.doMock` of `@/lib/provider-identity`, replace it with a mock of `@/lib/doctor-queue-provider` (`resolveDoctorQueueProvider`).
    - Add `patientName: 'Jane Doe'`, `queueTicketNumber: 7`, `patientNotifiedAt: null`, `declineAcknowledgedAt: null`, `declineAcknowledgedByName: null` to the mocked rows.
    - New `unmatched provider shows the explicit warning, not an empty queue`: the resolver returns `null`. Expect `getByText("We couldn't match your account to a provider record, so your assignment queue can't be shown. Ask an administrator to check your provider record.")`. Expect `queryByText(/queue clear/i)` to be null. Expect the Triage Queue header to have no `0` pill. Expect `listPendingAssignmentsForProvider` not to have been called.
    - New `row shows patient name, ticket, assigned-by and an urgency chip`: the resolver returns `{ id: 1, name: 'Dr. R. Kunam' }`. Expect `Jane Doe`, `#7`, `/Taylor Nguyen/`, and `Urgent` (chip label).

- [ ] **Step 2: Run and confirm failure.** `npx dotenv -e .env.local -- npx vitest run tests/lib/doctor-queue-provider.test.ts tests/pages/doctor.test.tsx`

- [ ] **Step 3: Implement.**
  - The page uses `resolveDoctorQueueProvider(session)`. Keep `lastName` for `myPatients` and the header.
  - When `providerMatch` is null, the Triage Queue card body renders `<p role="alert">` with the exact warning copy above, and the header count pill is omitted.
  - Otherwise each row shows, in this order:
    - `patientName` (bold), then `patientId`, muted
    - `#{queueTicketNumber}` only when it is `> 0` (0 is the DEFAULT placeholder, per `schema.ts:580-585`)
    - `<AssignmentUrgencyChip>`, replacing the bare pill at 114-116
    - `reason`
    - `visitType` · `Assigned by {assignedByName}` · `createdAt.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })`
    - The unchanged `AssignmentScheduleModalTrigger`.

- [ ] **Step 4: Run and confirm pass** (same command). Then run `npx tsc --noEmit`, and `npx dotenv -e .env.local -- npx vitest run tests/pages/nav-role-enforcement.test.tsx` (gates unchanged).

- [ ] **Step 5: Commit** `git commit -m "feat: explicit unmatched-provider warning and triage-ready doctor queue rows"`

---

### Task 10: Nav badges in layout, front-desk "Mark handled", and end-to-end HTTP verification

**Files:**
- Create: `src/lib/nav-badges.ts`, `src/components/AcknowledgeDeclineButton.tsx`
- Modify: `src/app/(dashboard)/layout.tsx:7-26`, `src/app/(dashboard)/front-desk/assignments/page.tsx:28-50`
- Test: create `tests/lib/nav-badges.test.ts` (mocked) and `tests/components/AcknowledgeDeclineButton.test.tsx` (fetch mocked)

**Interfaces:**
- Consumes: `resolveDoctorQueueProvider` (Task 9), `countPendingAssignmentsForProvider` and `countUnacknowledgedDeclines` (Task 4), `NavBadges` (Task 2).
- Produces:
  - `export async function getNavBadges(session: Session): Promise<NavBadges>`. For `pi` with a resolved provider: `{ '/doctor': count }`. For `pi` with no resolved provider: no `/doctor` key, so the badge is suppressed rather than shown as 0. For `frontdesk`/`admin`/`crc`: `{ '/front-desk/assignments': count }`. Other roles get `{}` and run no query.
  - `export function AcknowledgeDeclineButton({ assignmentId }: { assignmentId: number })`: a `'use client'` button labelled "Mark handled". It POSTs to `/api/front-desk/assignments/${assignmentId}/acknowledge-decline`. On `ok` it calls `router.refresh()`. Otherwise it shows `body.error ?? 'Could not mark this decline handled.'` in `role="alert"`.

- [ ] **Step 1: Write the failing tests.**
  - `nav-badges.test.ts` mocks `@/lib/doctor-queue-provider` and `@/lib/queries/doctor-assignments`. Cases:
    - pi matched with count 2 → `{ '/doctor': 2 }`.
    - pi unmatched → `{}`, and `countPendingAssignmentsForProvider` was not called.
    - frontdesk with 3 → `{ '/front-desk/assignments': 3 }`.
    - billing → `{}`, and neither count was called.
  - `AcknowledgeDeclineButton.test.tsx` mocks `next/navigation` (`useRouter → { refresh }`). Cases:
    - Click → `fetch` called with `('/api/front-desk/assignments/42/acknowledge-decline', { method: 'POST' })`, and `refresh` called on 200.
    - On 409 `{ error: 'This decline has already been marked handled.' }`, that text appears.

- [ ] **Step 2: Run and confirm failure.** `npx dotenv -e .env.local -- npx vitest run tests/lib/nav-badges.test.ts tests/components/AcknowledgeDeclineButton.test.tsx`

- [ ] **Step 3: Implement.**
  - The layout does `const badges = await getNavBadges(session)`, then `<LeftNav role={session.role} badges={badges} />`.
  - The assignments page adds an "Action" column. A row with `status === 'declined' && !declineAcknowledgedAt` gets `<AcknowledgeDeclineButton assignmentId={a.id} />`. A declined, acknowledged row shows muted `Handled by {declineAcknowledgedByName}`. Other rows show nothing.
  - Ordering comes from `listAllAssignments` (Task 4).

- [ ] **Step 4: Run and confirm pass.** Run the same command, then `npx tsc --noEmit`, then `npx eslint src/lib src/components src/app/(dashboard) src/app/api/front-desk`.

- [ ] **Step 5: HTTP verification against a real dev server** **[REQUIRES MIGRATION]**. Paste the actual output of every command into the report.

  **5a. Start the dev server** (background): `npx dotenv -e .env.local -- npx next dev -p 3107`. Wait until `curl -s -o /dev/null -w '%{http_code}' localhost:3107/login` prints `200`.

  **5b. Mint cookies:**
  ```bash
  mint() { npx dotenv -e .env.local -- npx tsx -e "import('./src/lib/auth').then(m=>m.buildSessionCookieValue('$1','$2',null)).then(v=>process.stdout.write(v))"; }
  PI=$(mint pi 'Dr. R. Kunam'); PI_NOMATCH=$(mint pi 'Dr. Nobody Matchington'); FD=$(mint frontdesk 'Taylor Nguyen'); ADM=$(mint admin 'Admin Verify')
  ```
  Get Kunam's provider id read-only with `npx dotenv -e .env.local -- npx tsx -e "…select id from providers where name like '%Kunam%'…"`.

  **5c. Check-in creates assignment A.** POST `/api/front-desk/check-in` with cookie `clinsync_demo_session=$FD` and body `{"patientId":"RD-0001","providerId":<id>,"visitType":"outpatient","urgency":"emergency","reason":"HTTP verify A"}`. Expect 201. Record A's id.

  **5d. Doctor badge and panel.** `curl -s -b "clinsync_demo_session=$PI" localhost:3107/doctor`, piped to `grep -o` for:
  - the My Patients pill number
  - `HTTP verify A`
  - the patient name
  - `Emergency`

  `curl … $PI_NOMATCH … /doctor | grep -c "couldn't match your account"` → `1`, and grep shows no pill on My Patients.

  **5e. Schedule twice.** POST `/api/front-desk/assignments/A/schedule` with `$PI` and body `{"startsAt":"2026-11-03T23:30:00","endsAt":"2026-11-03T23:59:00","visitReason":"HTTP verify"}` → 200. The same POST at `10:00` → 409.

  **5f. Exactly one notice.** `curl -s -b "clinsync_demo_session=$ADM" localhost:3107/messages/RD-0001 | grep -o "Your visit is confirmed\.[^<]*" | wc -l` → `1`. Grep also shows `AUTOMATED NOTICE` and `Tuesday, November 3, 2026 at 11:30 PM`, which is the midnight-adjacent day check.

  **5g. Declining scheduled A.** POST `/decline` on A with `$PI` and `{"reason":"x"}` → 409.

  **5h. Decline flow.** Check in assignment B (routine). Decline B with `$PI` → 200. Then `curl … $FD … /front-desk/assignments` should show the Assignments nav pill, B's row first, and `Mark handled`. POST `/acknowledge-decline` on B → 200, a second POST → 409, then re-GET shows `Handled by Taylor Nguyen` and no Assignments pill.

  **5i. Cleanup by explicit id** with a scratchpad tsx script:
  - Select the ids of `messages` where `patient_id = 'RD-0001' AND sender_role = 'system' AND body LIKE 'Your visit is confirmed.%' AND created_at >= <run start>`, print them, then delete exactly those ids.
  - Delete `doctor_assignments` A and B by id.
  - Delete the appointment by the id recorded from A's `appointmentId`.
  - Print the deleted counts. `audit_log` rows stay; that table is append-only.
  - Stop the dev server.

- [ ] **Step 6: Commit** `git add src/lib/nav-badges.ts src/components/AcknowledgeDeclineButton.tsx "src/app/(dashboard)/layout.tsx" "src/app/(dashboard)/front-desk/assignments/page.tsx" tests/lib/nav-badges.test.ts tests/components/AcknowledgeDeclineButton.test.tsx && git commit -m "feat: dashboard nav badges and front-desk Mark handled for declined assignments"`

---

## Final checks (after Task 10)

Run each of these files individually with `npx dotenv -e .env.local -- npx vitest run <file>`. Never run the full suite.
- `tests/lib/notification-templates.test.ts`
- `tests/components/AssignmentUrgencyChip.test.tsx`
- `tests/components/LeftNav.test.tsx`
- `tests/lib/queries/doctor-assignments.test.ts`
- `tests/lib/queries/messages.test.ts`
- `tests/api/front-desk-assignments-schedule.test.ts`
- `tests/api/front-desk-assignments-decline.test.ts`
- `tests/api/front-desk-assignments-acknowledge-decline.test.ts`
- `tests/api/front-desk-check-in.test.ts`
- `tests/lib/doctor-queue-provider.test.ts`
- `tests/pages/doctor.test.tsx`
- `tests/pages/nav-role-enforcement.test.tsx`
- `tests/lib/nav-badges.test.ts`
- `tests/components/AcknowledgeDeclineButton.test.tsx`
- `tests/lib/eligibility.test.ts`

Then run `npx tsc --noEmit`, and `git grep -nE "Tebra|IntakeQ" -- $(git diff --name-only hims-platform...HEAD)`, which must return nothing in new code.

## Self-review

- **Spec coverage:**

  | Spec section | Task |
  |---|---|
  | §3 columns | 3 |
  | §4.1 badges | 2, 10 |
  | §4.2 CASE ordering | 4 |
  | §4.3 warning and suppressed badge | 9, 10 |
  | §4.4 panel content and urgency chip | 2, 9 |
  | §5.1 trigger, idempotency, audit verb, failure | 5, 6 |
  | §5.2 copy and inpatient bullet | 1 |
  | §6 decline badge, ordering, Mark handled, acknowledge route | 4, 8, 10 |
  | §7.1 and §7.2 guards | 6, 7 |
  | §8 local formatting | 1 |
  | §9 tests | 1, 4–8 |
  | §11 roles | 6, 7, 8, 10 |

  Out of scope, as the spec says: push/SMS, reminders, timezone, reschedule notices.
- **Type consistency:** `PendingAssignmentRow`, `NavBadges`, `resolveDoctorQueueProvider`, `countPendingAssignmentsForProvider`, `countUnacknowledgedDeclines`, `acknowledgeDecline` and `notifyPatientOfScheduledAssignment` are used with the same names and signatures in Tasks 4–10.
- **Known residual (spec-accepted):** two truly concurrent first schedule POSTs can both pass the read-then-check 409 and insert two appointments. The patient still gets one message, through the `patientNotifiedAt` claim. Closing this would require changing `scheduleAssignment`'s write condition, which spec §1 puts out of scope.
