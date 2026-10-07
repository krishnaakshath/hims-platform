# SP3: Encounters, OPD/IPD & Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the hospital a visit record and a follow-up workflow:
- an **encounter** (OPD visit / IPD stay; `lab` reserved for SP5) opened at check-in, carrying an OPD token, department, doctor, status, and links to the appointment, admission and doctor assignment;
- a **follow-up order**: prescribed by a doctor, booked by the front desk, with a due date or interval, a window, a front-desk-visible reason, clinical plan notes, and a status (`planned → scheduled → completed / missed / cancelled`);
- a front-desk **recall worklist**, a "Visits & follow-up" tab on the patient page, a portal "Your follow-up" card, discharge integration, a log-only notifier, and the discharge-summary data shape.

The owner's words: "change a patient's follow-up; front desk must also have access; for lab patients: tests → home collection → report → patient comes back for check-up". SP3 builds the follow-up and the "comes back for check-up" visit. Home collection and report-triggered follow-ups are SP5; SP3 leaves the `originating_lab_order_id` column ready for them.

**Architecture:**
- Three new tables: `encounters`, `follow_up_orders`, `follow_up_contact_attempts`. `appointments` and `admissions` are **not altered**. The appointment stays the scheduling record. The encounter is created at check-in.
- All date and status logic is pure, client-safe code under `src/lib/follow-ups/` and `src/lib/encounters/`:
  - date windows and interval arithmetic in Asia/Kolkata
  - the derived status, including "missed" (computed, so no cron)
  - recall buckets, role redaction and the encounter state machine
- Writes go through query modules that run one `getDb().transaction` each. The audit row is written on the same `tx`, the SP1 `registerPatient` pattern. Routes are thin, and their unit tests mock the query modules. Query modules have DB tests against the local Postgres container.
- Notifications go through a narrow `FollowUpNotifier` interface. Its only implementation logs ids and is audited. SP5's `src/lib/notify` replaces it.

**Tech Stack:** Next.js 16 App Router (route `params` and page `searchParams` are `Promise`s; `src/proxy.ts`, not middleware), drizzle-orm 0.45 + node-postgres (real transactions), zod v4, vitest + jsdom + Testing Library, lucide-react.

**Spec:** `docs/superpowers/specs/2026-10-07-indian-hims-design.md` (sections 1–4, 6, 7 are binding; this plan implements sub-project 3, "Encounters, OPD/IPD & follow-up"). The discharge-summary **PDF** is deferred to the documents work (spec §3 "Documents"). SP3 ships only its data shape (Task 11).

**Depends on:** SP1 (merged on `main`): `departments`, `providers.department_id`, `india-time.ts`, `db-errors.ts`, `tests/db/migration-sql.ts`, the `logAudit(session, action, patientId, details, executor)` form, and `publicPatientColumns`. It has **no** dependency on SP2 (tariffs).

## Global Constraints

- Read `AGENTS.md`. Before writing any route or page, read the matching guide in `node_modules/next/dist/docs/`, because Next 16 differs from training data. Route context is `{ params: Promise<{ … }> }`. Page props are `{ params: Promise<…>; searchParams: Promise<…> }`.
- **Work in a fresh worktree** off `main` (`.worktrees/sp3`, branch `feature/sp3-encounters-followup`). Copy `.env.local` from the main checkout into it (it is git-ignored). **Never touch `.worktrees/sp2`.**
- **Time (spec §3 "default timezone Asia/Kolkata"):**
  - Calendar dates (encounter date, due date, window, "today") are `date` columns. They are computed only with `todayIsoIn(DEFAULT_TIMEZONE, now)` from `src/lib/india-time.ts` or `istDateOf(instant)` (Task 1).
  - New code never uses `new Date().toISOString().slice(0, 10)` or `setHours(0, 0, 0, 0)` for a business day.
  - Instants stay `timestamp` (without time zone), which is the existing drizzle convention: stored as UTC, round-tripped as `Date`.
  - Any client-sent appointment time in SP3 routes must carry an explicit offset. The UI composes `YYYY-MM-DDTHH:MM:00+05:30` with `istSlotString` (Task 1).
  - Display uses `formatIsoDate` / `formatDateTimeIn` (Task 1), never the browser's local zone.
- **IDs:** `serial` integer primary keys, as `appointments`/`admissions` use. Patient FKs are `text` (`patients.id`). No UUIDs.
- **PHI rules from SP1:**
  - Every read of `patients` selects named columns or `publicPatientColumns`; `tests/lib/no-credential-leak.test.ts` must stay green.
  - SP3 code never references `patientAadhaar`, `aadhaar*`, or `src/lib/crypto.ts`; `tests/lib/no-aadhaar-leak.test.ts` must stay green unchanged.
  - Audit `details` carry ids, dates and enum codes only. They never carry `reason`, `planNotes`, contact `note` or `cancelReason` text.
- **RBAC** (constants from Task 3, in `src/lib/role-policy.ts`):

  | Constant | Roles | Grants |
  |---|---|---|
  | `FOLLOW_UP_VIEW_ROLES` | admin, pi, crc, frontdesk | see follow-ups on the patient page |
  | `FOLLOW_UP_PLAN_ROLES` | admin, pi | create, change and cancel the clinical plan |
  | `FOLLOW_UP_BOOKING_ROLES` | admin, frontdesk | book, reschedule, unbook, log contact attempts |
  | `FOLLOW_UP_WORKLIST_ROLES` | admin, crc, frontdesk | the `/front-desk/follow-ups` page and nav entry |
  | `FOLLOW_UP_CLINICAL_NOTES_ROLES` | admin, crc, pi (= `CLINICAL_ROLES`) | may receive `planNotes` |
  | `CHECK_IN_ROLES` | frontdesk, admin, crc | the existing check-in gate, now named |
  | `ENCOUNTER_STATUS_ROLES` | admin, pi, frontdesk, crc | gate of the encounter status route; per-transition roles in Task 1 |
  | `DISCHARGE_ROLES` | admin, pi | the existing discharge gate, now named |

  - **API order:** every SP3 API calls `requireSession()` first, then runs the inline allowlist check and returns exactly `NextResponse.json({ error: 'Forbidden' }, { status: 403 })`. Only then is the body parsed. A body that is not JSON gives `400 { error: 'Invalid JSON' }`, never a 500.
  - **Page order:** every page calls `requireSessionOrRedirect()` as its first statement, then `redirect('/')` for a denied role, before any data load.
  - **Harnesses:**
    - Each new or changed route gets an `API_GATES` row and a deny-before-parse row in `tests/api/rbac-route-gates.test.ts`.
    - The new page gets a `PAGE_GATES` row in `tests/pages/page-gates-harness.ts`.
    - No row carries a `gap` tag. `LeftNav` roles equal the page gate.
- **Audit:** every write calls `logAudit(session, action, patientId, details, tx)` on the same transaction as the change. Use the exact action strings each task names. The notifier's audit row is written after commit (Task 3).
- **Notifications:** SP3 never imports `src/lib/sms.ts`, `src/lib/email.ts` or `sendMessage`. Patient notices go only through `notifyFollowUpSafely` (Task 3). It is log-only and states "not delivered".
- **Schema changes** are a `src/db/schema.ts` edit **plus** `scripts/migrations/2026-10-07-sp3-encounters-follow-up.sql`, in the SP1 style:
  - `BEGIN; … COMMIT;`, with `IF NOT EXISTS` everywhere
  - each `CREATE TYPE` in a `DO` block catching `duplicate_object`
  - each FK, unique and check constraint in a `DO` block testing `pg_constraint`, named exactly as drizzle names it
  - no `DROP`
  - **Apply only to the local container:** `/Users/k2a/.docker/bin/docker exec -i hims-local-pg psql -U postgres -d hims -v ON_ERROR_STOP=1 < scripts/migrations/2026-10-07-sp3-encounters-follow-up.sql`
  - Never `db:push` / `drizzle-kit push`. Never `scripts/apply-sql.mjs`, which forces TLS.
- **Tests:**
  - **Pure and mocked tests:** `npx vitest run <file>`.
  - **DB tests:** `npm test -- <file>`, which loads `.env.local` and its `DATABASE_URL` for the local container.
    - Wrap new DB tests in `describe.skipIf(!process.env.DATABASE_URL)('… (DB)', …)`.
    - Create fixtures prefixed `TEST-SP3-${RUN}`, and delete them in `afterEach`, children first: `follow_up_contact_attempts` → `follow_up_orders` → `encounters` → `admissions` → `doctor_assignments` → `appointments` → `patients`.
  - **Never run the whole suite or `tests/db/seed.test.ts` during task work**: it truncates and reseeds the shared local DB, which the SP2 worktree also uses.
- **Per-task verification:** the task's tests, plus `npx tsc --noEmit` and `npx eslint <changed files>`.
- **Branding:** no hard-coded product name. Use `brand` (server) or `useBrand()` (client).
- **Merging with SP2:** SP2 also edits `schema.ts`, `seed.ts`, `role-policy.ts`, `role-capabilities.ts`, `LeftNav.tsx`, `rbac-route-gates.test.ts` and `page-gates-harness.ts`. Keep SP3 additions in their own blocks commented `// SP3`, so a later merge keeps both sides.
- No secrets. The executor commits per task as written. Nothing is committed while planning.

## Review Focus

1. **The IST midnight boundary.**
   - A booking at 00:30 IST on 22 Oct is 21 Oct 19:00 UTC. It must count as 22 Oct for "is this appointment today" at check-in, for the missed rule and on screen.
   - OPD tokens restart at IST midnight, not UTC midnight.
   - Test: Task 1 `istDateOf puts 19:00Z on the next IST day`, Task 4 `restarts tokens on a new IST date`, Task 5 `409s an appointment on another IST date`.
2. **Month-end and year-end intervals.**
   - "1 month" from 31 Jan is 28/29 Feb, never 3 Mar.
   - A window that crosses a year boundary must stay ordered (start ≤ due ≤ end).
   - Test: Task 1 `addMonthsIso clamps to month end` and `window crosses the year boundary`.
3. **Two front-desk users booking the same doctor slot, or the same follow-up, at once.**
   - Exactly one succeeds. The other gets a 409. No orphan appointment is left behind.
   - Booking a completed or cancelled follow-up gives a 409.
   - Test: Task 7 `concurrent bookings of one slot: exactly one wins, one appointment row` and `refuses to book a cancelled follow-up`.
4. **Clinical text never reaches the front desk, the portal or the audit log.**
   - Front desk payloads have `planNotes: null`.
   - The portal payload has no `reason` or `planNotes` keys.
   - A front-desk `PATCH` to the plan is a 403 before parse.
   - Audit `details` never contain the reason or notes text.
   - Test: Task 6 `toFollowUpView nulls planNotes for frontdesk` and `audit details carry ids only`, Task 8 `frontdesk PATCH is 403 and never calls updateFollowUpPlan`, Task 14 `card shows no reason or notes`.
5. **An appointment cancelled or marked no-show from the calendar.** This bypasses the follow-up routes. The follow-up must fall back to planned (due/overdue) or show missed, and must never stay "Booked" forever. Test: Task 1 `scheduled with a cancelled appointment derives planned` and `no_show derives missed`, Task 7 `calendar cancel puts the order back in the due bucket`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/follow-ups/rules.ts` | IST date arithmetic, due/window resolution, derived status, recall buckets, labels (pure) |
| `src/lib/follow-ups/validation.ts` | zod schemas for every follow-up request (client-safe) |
| `src/lib/follow-ups/view.ts` | Joined row → `FollowUpView` with role redaction; portal projection (pure) |
| `src/lib/follow-ups/worklist.ts` | Worklist search-param parsing, filtering, sorting, bucket counts (pure) |
| `src/lib/follow-ups/notifier.ts` | `FollowUpNotifier` interface, log-only implementation, `notifyFollowUpSafely` |
| `src/lib/encounters/status.ts` | Encounter enums, state machine, per-transition roles, status-request schema (pure) |
| `src/lib/encounters/discharge-summary.ts` | `DischargeSummaryData` shape + pure builder |
| `src/lib/india-time.ts` | + `istDateOf`, `startOfIstDay`, `formatIsoDate`, `formatDateTimeIn` |
| `src/lib/queries/executor.ts` | `WriteExecutor` type (db or tx) |
| `src/lib/queries/encounters.ts` | Check-in transaction, token allocation, transitions, reads |
| `src/lib/queries/follow-ups.ts` | Create/update/cancel orders, patient and portal reads |
| `src/lib/queries/follow-up-recall.ts` | Book/reschedule/unbook, contact attempts, worklist read |
| `src/lib/queries/discharge-summary.ts` | Loader for the discharge-summary data |
| `src/app/api/follow-ups/**`, `src/app/api/encounters/[id]/status` | New routes |
| `src/app/(dashboard)/front-desk/follow-ups/page.tsx` | Recall worklist page |
| `src/components/follow-ups/*` | Panel, modals, worklist, portal card, client API helpers |
| `scripts/migrations/2026-10-07-sp3-encounters-follow-up.sql` | DDL |

---

### Task 1: Pure follow-up rules, validation, encounter state machine, IST helpers

**Files:**
- Create: `src/lib/follow-ups/rules.ts`, `src/lib/follow-ups/validation.ts`, `src/lib/encounters/status.ts`
- Modify: `src/lib/india-time.ts` (append; keep existing exports untouched)
- Test: `tests/lib/follow-ups/rules.test.ts`, `tests/lib/follow-ups/validation.test.ts`, `tests/lib/encounters/status.test.ts`, `tests/lib/india-time.test.ts` (append cases)

**Interfaces:**
- Consumes: `DEFAULT_TIMEZONE`, `todayIsoIn` (`src/lib/india-time.ts`); `visitReasonSchema` (`src/lib/visit-reason-schema.ts`); `normalizeVisitReason`, `VISIT_REASON_MAX_LENGTH` (`src/lib/notification-templates.ts`); `type Role` (`import type` only).
- Produces:
  - `india-time.ts`:
    - `istDateOf(instant: Date): string`, which is `todayIsoIn(DEFAULT_TIMEZONE, instant)`
    - `startOfIstDay(dateIso: string): Date`, which is `new Date(`${dateIso}T00:00:00+05:30`)`
    - `formatIsoDate(dateIso: string): string`: en-IN `{ day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }` on `${dateIso}T00:00:00Z` (gives "21 Oct 2026")
    - `formatDateTimeIn(instant: Date, tz: string = DEFAULT_TIMEZONE): string`: en-IN day/month short/year, `hour: 'numeric', minute: '2-digit', hour12: true`
  - `rules.ts` (no `node:` or DB imports):
    - Constants:
      - `FOLLOW_UP_STATUSES = ['planned', 'scheduled', 'completed', 'missed', 'cancelled'] as const`; `type FollowUpStatus`
      - `INTERVAL_UNITS = ['days', 'weeks', 'months'] as const`; `type IntervalUnit`; `interface FollowUpInterval { value: number; unit: IntervalUnit }`
      - `type FollowUpTiming = { kind: 'date'; dueDate: string } | { kind: 'interval'; interval: FollowUpInterval }`
      - `DEFAULT_WINDOW_DAYS_BEFORE = 3`, `DEFAULT_WINDOW_DAYS_AFTER = 7`, `MISSED_GRACE_DAYS = 14`, `UPCOMING_HORIZON_DAYS = 30`, `MAX_DUE_DAYS_AHEAD = 730`
    - Date helpers:
      - `addDaysIso(dateIso: string, days: number): string` (UTC date maths on `YYYY-MM-DD`)
      - `addMonthsIso(dateIso: string, months: number): string`, which clamps the day to the target month's last day
    - `resolveFollowUpDates(timing: FollowUpTiming, baseIso: string, windowDaysBefore = DEFAULT_WINDOW_DAYS_BEFORE, windowDaysAfter = DEFAULT_WINDOW_DAYS_AFTER): { dueDate: string; windowStart: string; windowEnd: string; interval: FollowUpInterval | null }`
      - For `weeks`, add `7 * value` days. For `months`, use `addMonthsIso`.
      - `interval` is null for `kind: 'date'`.
    - `dueDateProblem(dueIso: string, todayIso: string): string | null` returns:
      - `'The follow-up date cannot be in the past.'` when due < today
      - `'The follow-up date must be within 2 years.'` when due > today + `MAX_DUE_DAYS_AHEAD`
      - null otherwise
    - `type ApptStatus = 'scheduled' | 'completed' | 'cancelled' | 'no_show'`, declared locally. Do not import `src/lib/queries/appointments.ts`, because it imports the DB.
    - `interface FollowUpStatusInput { status: FollowUpStatus; windowEnd: string; appointment: { status: ApptStatus; startsAt: Date } | null }`
    - `deriveFollowUpStatus(input: FollowUpStatusInput, todayIso: string, graceDays = MISSED_GRACE_DAYS): FollowUpStatus`, with this exact precedence:
      1. A stored `cancelled` / `completed` / `missed` is returned as is.
      2. An appointment with status `completed` gives `completed`.
      3. An appointment with status `no_show` gives `missed`.
      4. An appointment with status `scheduled` gives `missed` if `todayIso > addDaysIso(max(istDateOf(startsAt), windowEnd), graceDays)`, else `scheduled`.
      5. Otherwise (no appointment, or a cancelled one) the result is `missed` if `todayIso > addDaysIso(windowEnd, graceDays)`, else `planned`.
    - `type RecallBucket = 'upcoming' | 'due' | 'overdue' | 'scheduled' | 'missed' | 'closed'`
    - `recallBucket(status: FollowUpStatus, windowStart: string, windowEnd: string, todayIso: string): RecallBucket`:
      - completed/cancelled → `closed`, missed → `missed`, scheduled → `scheduled`
      - planned → `upcoming` if today < windowStart, `overdue` if today > windowEnd, else `due`
    - `isOpenFollowUp(status: FollowUpStatus): boolean` (planned, scheduled or missed)
    - Labels:
      - `FOLLOW_UP_STATUS_LABEL: Record<FollowUpStatus, string>` = `{ planned: 'Not booked', scheduled: 'Booked', completed: 'Completed', missed: 'Missed', cancelled: 'Cancelled' }`
      - `PORTAL_FOLLOW_UP_LABEL: Record<FollowUpStatus, string>` = `{ planned: 'Due, please book', scheduled: 'Booked', completed: 'Done', missed: 'Missed, please contact us', cancelled: 'Cancelled' }`
    - `followUpVisitReason(reason: string): string`, which is `normalizeVisitReason(`Follow-up: ${reason}`)`
    - `istSlotString(dateIso: string, hhmm: string): string` returns `${dateIso}T${hhmm}:00+05:30`
  - `validation.ts`:
    - `isoDateSchema`: `YYYY-MM-DD` and a real calendar date
    - `offsetDateTimeSchema`: regex `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$` and parseable
    - `followUpIntervalSchema` (value int 1–365, unit in `INTERVAL_UNITS`, refine that the total days ≤ 731; `.strict()`)
    - `followUpTimingSchema`: `z.discriminatedUnion('kind', …)`, each branch `.strict()`
    - `followUpReasonSchema = visitReasonSchema`
    - `planNotesSchema = z.string().trim().max(2000)`
    - `followUpPlanFieldsSchema`, shared with Task 10: `{ timing, windowDaysBefore?: int 0–30, windowDaysAfter?: int 0–60, reason, planNotes?: planNotesSchema }`, `.strict()`
    - `createFollowUpSchema` = plan fields + `patientId: string min 1`, `prescribedByProviderId?: positive int`, `departmentId?: positive int`, `originatingEncounterId?: positive int`, `.strict()`. Type `CreateFollowUpRequest`.
    - `updateFollowUpPlanSchema`:
      - every plan field optional, with `planNotes` nullable to clear it
      - plus `prescribedByProviderId?: positive int` and `departmentId?: positive int | null`
      - `.strict()`, refined so at least one key is present
      - type `UpdateFollowUpPlanRequest`
    - `reasonOnlySchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict()`, used by cancel and unbook
    - `bookFollowUpSchema = { providerId: positive int, startsAt: offsetDateTimeSchema, endsAt: offsetDateTimeSchema }`, `.strict()`, refined so `endsAt > startsAt` and the duration is ≤ 240 min. Type `BookFollowUpRequest`.
    - `CONTACT_CHANNELS = ['phone', 'sms', 'whatsapp', 'email', 'in_person'] as const`
    - `CONTACT_OUTCOMES = ['reached_booked', 'reached_will_call_back', 'reached_declined', 'no_answer', 'wrong_number', 'message_left'] as const`
    - `contactAttemptSchema = { channel, outcome, note?: string trim max 500 }`, `.strict()`. Type `ContactAttemptRequest`.
  - `src/lib/encounters/status.ts`:
    - `ENCOUNTER_TYPES = ['opd', 'ipd', 'lab'] as const`, `ENCOUNTER_VISIT_TYPES = ['new', 'follow_up', 'review', 'emergency'] as const`, `ENCOUNTER_STATUSES = ['checked_in', 'in_consultation', 'completed', 'cancelled'] as const`, plus their types
    - `ENCOUNTER_TRANSITIONS: Record<EncounterStatus, readonly EncounterStatus[]>` = `{ checked_in: ['in_consultation', 'completed', 'cancelled'], in_consultation: ['completed'], completed: [], cancelled: [] }`
    - `canTransitionEncounter(from: EncounterStatus, to: EncounterStatus): boolean`
    - `ENCOUNTER_TRANSITION_ROLES: Record<'in_consultation' | 'completed' | 'cancelled', readonly Role[]>` = `{ in_consultation: ['admin', 'pi'], completed: ['admin', 'pi'], cancelled: ['admin', 'frontdesk', 'crc'] }`
    - `defaultEncounterVisitType(i: { urgency: 'routine' | 'urgent' | 'emergency'; followUpLinked: boolean }): EncounterVisitType`: `follow_up` if linked, else `emergency` if urgency is emergency, else `new`
    - `encounterStatusRequestSchema = z.object({ to: z.enum(['in_consultation', 'completed', 'cancelled']), cancelReason: z.string().trim().min(1).max(500).optional() }).strict()`, refined so that `to === 'cancelled'` requires `cancelReason`

- [ ] **Step 1: Write the failing tests**

```ts
// rules.test.ts
it('addMonthsIso clamps to month end', () => {
  expect(addMonthsIso('2026-01-31', 1)).toBe('2026-02-28'); expect(addMonthsIso('2028-01-31', 1)).toBe('2028-02-29')
  expect(addMonthsIso('2026-12-15', 2)).toBe('2027-02-15')
})
it('resolves an interval due date and default window', () => {
  expect(resolveFollowUpDates({ kind: 'interval', interval: { value: 2, unit: 'weeks' } }, '2026-10-07'))
    .toEqual({ dueDate: '2026-10-21', windowStart: '2026-10-18', windowEnd: '2026-10-28', interval: { value: 2, unit: 'weeks' } })
})
it('window crosses the year boundary', () => {
  const r = resolveFollowUpDates({ kind: 'date', dueDate: '2027-01-02' }, '2026-12-01', 5, 3)
  expect(r).toMatchObject({ windowStart: '2026-12-28', windowEnd: '2027-01-05', interval: null })
})
it('dueDateProblem rejects past and >2y dates', () => {
  expect(dueDateProblem('2026-10-06', '2026-10-07')).toMatch(/past/); expect(dueDateProblem('2026-10-07', '2026-10-07')).toBeNull()
  expect(dueDateProblem('2028-10-08', '2026-10-07')).toMatch(/2 years/)
})
const base = { status: 'scheduled' as const, windowEnd: '2026-10-28' }
it('scheduled with a cancelled appointment derives planned', () => {
  expect(deriveFollowUpStatus({ ...base, appointment: { status: 'cancelled', startsAt: new Date('2026-10-21T04:00:00Z') } }, '2026-10-22')).toBe('planned')
})
it('no_show derives missed; completed appointment derives completed', () => {
  expect(deriveFollowUpStatus({ ...base, appointment: { status: 'no_show', startsAt: new Date('2026-10-21T04:00:00Z') } }, '2026-10-21')).toBe('missed')
  expect(deriveFollowUpStatus({ ...base, appointment: { status: 'completed', startsAt: new Date('2026-10-21T04:00:00Z') } }, '2026-10-21')).toBe('completed')
})
it('planned turns missed only after window end + 14 days', () => {
  const p = { status: 'planned' as const, windowEnd: '2026-10-28', appointment: null }
  expect(deriveFollowUpStatus(p, '2026-11-11')).toBe('planned'); expect(deriveFollowUpStatus(p, '2026-11-12')).toBe('missed')
})
it('a stale scheduled appointment turns missed after max(apptDay, windowEnd) + grace', () => {
  const s = { ...base, appointment: { status: 'scheduled' as const, startsAt: new Date('2026-11-05T04:00:00Z') } }
  expect(deriveFollowUpStatus(s, '2026-11-19')).toBe('scheduled'); expect(deriveFollowUpStatus(s, '2026-11-20')).toBe('missed')
})
it('stored cancelled/completed win over the appointment', () => {
  expect(deriveFollowUpStatus({ status: 'cancelled', windowEnd: '2026-10-28', appointment: { status: 'completed', startsAt: new Date() } }, '2026-10-21')).toBe('cancelled')
})
it.each([['2026-10-17', 'upcoming'], ['2026-10-18', 'due'], ['2026-10-28', 'due'], ['2026-10-29', 'overdue']])('recallBucket planned on %s is %s', (today, b) => {
  expect(recallBucket('planned', '2026-10-18', '2026-10-28', today)).toBe(b)
})
it('followUpVisitReason caps at the visit-reason limit', () => { expect(followUpVisitReason('x'.repeat(300)).length).toBeLessThanOrEqual(VISIT_REASON_MAX_LENGTH) })
it('istSlotString carries +05:30', () => { expect(istSlotString('2026-10-21', '09:30')).toBe('2026-10-21T09:30:00+05:30') })
// india-time.test.ts (append)
it('istDateOf puts 19:00Z on the next IST day', () => { expect(istDateOf(new Date('2026-10-21T19:00:00Z'))).toBe('2026-10-22') })
it('startOfIstDay is 18:30Z the day before', () => { expect(startOfIstDay('2026-10-22').toISOString()).toBe('2026-10-21T18:30:00.000Z') })
it('formats dates and IST times', () => {
  expect(formatIsoDate('2026-10-21')).toMatch(/21 Oct 2026/)
  expect(formatDateTimeIn(new Date('2026-10-21T19:00:00Z'))).toMatch(/22 Oct 2026.*12:30/i)
})
// validation.test.ts
it('bookFollowUpSchema requires an explicit offset', () => {
  expect(bookFollowUpSchema.safeParse({ providerId: 1, startsAt: '2026-10-21T09:30:00', endsAt: '2026-10-21T09:45:00' }).success).toBe(false)
  expect(bookFollowUpSchema.safeParse({ providerId: 1, startsAt: '2026-10-21T09:30:00+05:30', endsAt: '2026-10-21T09:45:00+05:30' }).success).toBe(true)
  expect(bookFollowUpSchema.safeParse({ providerId: 1, startsAt: '2026-10-21T09:30:00+05:30', endsAt: '2026-10-21T09:30:00+05:30' }).success).toBe(false)
})
it('createFollowUpSchema is strict and validates timing', () => {
  const ok = { patientId: 'RD-0001', timing: { kind: 'interval', interval: { value: 2, unit: 'weeks' } }, reason: 'BP review' }
  expect(createFollowUpSchema.safeParse(ok).success).toBe(true)
  expect(createFollowUpSchema.safeParse({ ...ok, status: 'completed' }).success).toBe(false)
  expect(createFollowUpSchema.safeParse({ ...ok, timing: { kind: 'date', dueDate: '2026-02-30' } }).success).toBe(false)
  expect(createFollowUpSchema.safeParse({ ...ok, timing: { kind: 'interval', interval: { value: 30, unit: 'months' } } }).success).toBe(false)
})
it('updateFollowUpPlanSchema rejects an empty patch and unknown keys', () => {
  expect(updateFollowUpPlanSchema.safeParse({}).success).toBe(false)
  expect(updateFollowUpPlanSchema.safeParse({ appointmentId: 4 }).success).toBe(false)
  expect(updateFollowUpPlanSchema.safeParse({ planNotes: null }).success).toBe(true)
})
// status.test.ts
it('allows only the documented transitions', () => {
  expect(canTransitionEncounter('checked_in', 'in_consultation')).toBe(true); expect(canTransitionEncounter('in_consultation', 'cancelled')).toBe(false)
  expect(canTransitionEncounter('completed', 'checked_in')).toBe(false)
})
it('cancel needs a reason', () => {
  expect(encounterStatusRequestSchema.safeParse({ to: 'cancelled' }).success).toBe(false)
  expect(encounterStatusRequestSchema.safeParse({ to: 'cancelled', cancelReason: 'left' }).success).toBe(true)
})
it('defaults the visit type', () => {
  expect(defaultEncounterVisitType({ urgency: 'emergency', followUpLinked: true })).toBe('follow_up')
  expect(defaultEncounterVisitType({ urgency: 'emergency', followUpLinked: false })).toBe('emergency')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/follow-ups tests/lib/encounters tests/lib/india-time.test.ts`
Expected: FAIL with "Failed to resolve import" (the existing india-time cases still pass).

- [ ] **Step 3: Implement** the four modules with the signatures above. Use no `Date` local-time getters anywhere. Date maths is `Date.UTC` on the parsed parts, formatted back with `toISOString().slice(0, 10)` **of that UTC date only**.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/lib/follow-ups tests/lib/encounters tests/lib/india-time.test.ts`, then `npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/follow-ups src/lib/encounters src/lib/india-time.ts tests/lib/follow-ups tests/lib/encounters tests/lib/india-time.test.ts
git commit -m "feat(sp3): follow-up date rules, derived status, validation and encounter state machine"
```

---

### Task 2: Schema + migration for encounters, follow-up orders, contact attempts

**Files:**
- Modify: `src/db/schema.ts`. Add the `// SP3` block after `admissionTransfers`, and add `foreignKey` to the `drizzle-orm/pg-core` import.
- Create: `scripts/migrations/2026-10-07-sp3-encounters-follow-up.sql`
- Modify: `src/lib/queries/patients.ts` `deletePatient`. Delete `followUpOrders` (contact attempts cascade), then `encounters`, for the patient. Do this **before** the existing `admissions` delete (around line 485).
- Modify: `src/db/seed.ts` `clearExistingData`. Add `db.delete(followUpContactAttempts)`, `db.delete(followUpOrders)` and `db.delete(encounters)` before the first of the `admissions` / `doctorAssignments` / `appointments` deletes.
- Test: `tests/db/encounters-follow-up-schema.test.ts`

**Interfaces:**
- Consumes: Task 1's const arrays (the test asserts that the enum values equal them).
- Produces (exact):

```ts
// SP3 encounters & follow-up (scripts/migrations/2026-10-07-sp3-encounters-follow-up.sql)
export const encounterTypeEnum = pgEnum('encounter_type', ['opd', 'ipd', 'lab'])
export const encounterVisitTypeEnum = pgEnum('encounter_visit_type', ['new', 'follow_up', 'review', 'emergency'])
export const encounterStatusEnum = pgEnum('encounter_status', ['checked_in', 'in_consultation', 'completed', 'cancelled'])
export const followUpStatusEnum = pgEnum('follow_up_status', ['planned', 'scheduled', 'completed', 'missed', 'cancelled'])
export const followUpSourceEnum = pgEnum('follow_up_source', ['encounter', 'discharge', 'lab_report', 'manual'])
export const followUpIntervalUnitEnum = pgEnum('follow_up_interval_unit', ['days', 'weeks', 'months'])
export const followUpContactChannelEnum = pgEnum('follow_up_contact_channel', ['phone', 'sms', 'whatsapp', 'email', 'in_person'])
export const followUpContactOutcomeEnum = pgEnum('follow_up_contact_outcome', ['reached_booked', 'reached_will_call_back', 'reached_declined', 'no_answer', 'wrong_number', 'message_left'])
```

- **`encounters`:**
  - Columns, in order:
    - `id` serial PK
    - `patientId` text not null → patients
    - `encounterType` not null
    - `visitType` default `'new'` not null
    - `status` default `'checked_in'` not null
    - `encounterDate` date not null
    - `opdToken` integer
    - `departmentId` → departments
    - `providerId` not null → providers
    - `appointmentId` → appointments `{ onDelete: 'set null' }` `.unique()`
    - `admissionId` → admissions `{ onDelete: 'set null' }` `.unique()`
    - `doctorAssignmentId` → doctorAssignments `{ onDelete: 'set null' }` `.unique()`
    - `checkedInByName` text not null
    - `checkedInAt` timestamp defaultNow not null
    - `statusChangedAt` timestamp, `statusChangedByName` text, `completedAt` timestamp, `cancelReason` text
  - Extra config:
    - `uniqueIndex('encounters_date_token_unique').on(t.encounterDate, t.opdToken)`
    - `index('encounters_patient_id_idx').on(t.patientId)`
    - `check('encounters_token_positive', sql`${t.opdToken} IS NULL OR ${t.opdToken} > 0`)`
- **`followUpOrders`** (`'follow_up_orders'`):
  - Columns:
    - `id` serial PK
    - `patientId` not null → patients
    - `source` not null
    - `status` default `'planned'` not null
    - `prescribedByProviderId` not null → providers
    - `departmentId` → departments
    - `baseDate` date not null (the date the interval counts from)
    - `dueDate` date not null, `windowStart` date not null, `windowEnd` date not null
    - `intervalValue` integer, `intervalUnit`
    - `reason` text not null, `planNotes` text
    - Provenance links, all `{ onDelete: 'set null' }`:
      - `originatingEncounterId` → encounters
      - `originatingAdmissionId` → admissions
      - `originatingLabOrderId` → labOrders. This is the SP5 placeholder; SP3 never writes it.
      - `appointmentId` → appointments, `.unique()`
      - `completedEncounterId` → encounters
    - `createdByName` text not null, `createdByUserId` → users
    - `createdAt`, `updatedAt` defaultNow not null
    - `planUpdatedAt` timestamp, `planUpdatedByName` text
    - `scheduledAt` timestamp, `scheduledByName` text, `scheduledByUserId` → users
    - `completedAt` timestamp
    - `cancelledAt` timestamp, `cancelledByName` text, `cancelReason` text
  - Extra config:
    - `index('follow_up_orders_patient_id_idx')`
    - `index('follow_up_orders_status_window_idx').on(t.status, t.windowEnd)`
    - `check('follow_up_orders_window_order', window_start <= due_date AND due_date <= window_end)`
    - `check('follow_up_orders_interval_pair', (interval_value IS NULL) = (interval_unit IS NULL) AND (interval_value IS NULL OR interval_value > 0))`
    - `check('follow_up_orders_cancel_reason', status <> 'cancelled' OR cancel_reason IS NOT NULL)`
  - There is deliberately **no** "scheduled ⇒ appointment" check: deleting an appointment sets the link null, and `deriveFollowUpStatus` treats that as planned.
- **`followUpContactAttempts`** (`'follow_up_contact_attempts'`):
  - Columns:
    - `id` serial PK
    - `followUpOrderId` integer not null
    - `channel` not null, `outcome` not null
    - `note` text
    - `attemptedByName` text not null, `attemptedByUserId` → users
    - `attemptedAt` defaultNow not null
  - Extra config:
    - `foreignKey({ name: 'follow_up_contact_attempts_order_id_fk', columns: [t.followUpOrderId], foreignColumns: [followUpOrders.id] }).onDelete('cascade')`. Drizzle's default name would be 68 characters, over Postgres's 63-character limit.
    - `index('follow_up_contact_attempts_order_idx')`
    - `check('follow_up_contact_attempts_note_len', note IS NULL OR char_length(note) <= 500)`
- Types: `export type EncounterRow = typeof encounters.$inferSelect`, `export type FollowUpOrderRow = typeof followUpOrders.$inferSelect`, `export type FollowUpContactAttemptRow = typeof followUpContactAttempts.$inferSelect`.
- **Migration:**
  - Types come first. The three tables use `CREATE TABLE IF NOT EXISTS` with no inline FKs.
  - Every FK, unique constraint and check is in its own `pg_constraint`-guarded `DO` block. Each is named exactly what `getTableConfig(t).foreignKeys[i].getName()` / `.uniqueConstraints` / `.checks` give, e.g. `encounters_appointment_id_appointments_id_fk`, `encounters_appointment_id_unique`, and `ON DELETE SET NULL` / `CASCADE` as above.
  - Indexes use `CREATE [UNIQUE] INDEX IF NOT EXISTS`.
  - The header comment says it is additive, safe to re-run, requires the SP1 migrations, and gives the docker apply command.
  - A fresh `db:push` creates all of this too: there is no exclusion constraint.

- [ ] **Step 1: Write the failing tests** (`tests/db/encounters-follow-up-schema.test.ts`)

```ts
const MIGRATION = '2026-10-07-sp3-encounters-follow-up.sql'
it('migration is idempotent and non-destructive', () => { expect(idempotencyProblems(readMigration(MIGRATION))).toEqual([]) })
it.each([['encounters', encounters], ['follow_up_orders', followUpOrders], ['follow_up_contact_attempts', followUpContactAttempts]] as const)(
  'migration declares every %s column', (_n, t) => { expect(missingColumns(t, readMigration(MIGRATION))).toEqual([]) })
it('every FK, unique and check constraint name is in the SQL and fits 63 chars', () => {
  const sqlText = readMigration(MIGRATION)
  for (const t of [encounters, followUpOrders, followUpContactAttempts]) {
    const c = getTableConfig(t)
    const names = [...c.foreignKeys.map((f) => f.getName()), ...c.checks.map((k) => k.name), ...c.indexes.map((i) => i.config.name),
      ...c.columns.filter((col) => col.isUnique).map((col) => col.uniqueName!)]
    for (const n of names) { expect(n.length).toBeLessThanOrEqual(63); expect(sqlText).toContain(n) }
  }
})
it('enum values match the pure constants', () => {
  expect(encounterStatusEnum.enumValues).toEqual([...ENCOUNTER_STATUSES]); expect(encounterTypeEnum.enumValues).toEqual([...ENCOUNTER_TYPES])
  expect(encounterVisitTypeEnum.enumValues).toEqual([...ENCOUNTER_VISIT_TYPES]); expect(followUpStatusEnum.enumValues).toEqual([...FOLLOW_UP_STATUSES])
  expect(followUpContactChannelEnum.enumValues).toEqual([...CONTACT_CHANNELS]); expect(followUpContactOutcomeEnum.enumValues).toEqual([...CONTACT_OUTCOMES])
})
describe.skipIf(!process.env.DATABASE_URL)('SP3 schema (DB)', () => {
  // fixture: one TEST-SP3-<run> patient + first active provider; cleanup children-first
  it('rejects a second encounter with the same date and token, allows NULL tokens', async () => { /* insert two rows date '2099-01-01' token 1 → second throws isUniqueViolation(err, 'encounters_date_token_unique'); two NULL-token rows both insert */ })
  it('rejects a window that does not contain the due date', async () => { /* due 2099-01-10 window 2099-01-11..2099-01-20 → check violation 'follow_up_orders_window_order' */ })
  it('deleting an order cascades its contact attempts; deleting its appointment nulls the link', async () => { /* … expect attempts gone; order.appointmentId null */ })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/db/encounters-follow-up-schema.test.ts`
Expected: FAIL (the exports and the migration file do not exist).

- [ ] **Step 3: Implement** the schema block, the migration, and the `deletePatient` and seed edits.

- [ ] **Step 4: Apply to the local DB twice (idempotency), then verify**

Run: `/Users/k2a/.docker/bin/docker exec -i hims-local-pg psql -U postgres -d hims -v ON_ERROR_STOP=1 < scripts/migrations/2026-10-07-sp3-encounters-follow-up.sql`. Run it twice; both runs must end with `COMMIT`.
Then run: `npx vitest run tests/db/encounters-follow-up-schema.test.ts`, `npm test -- tests/db/encounters-follow-up-schema.test.ts`, `npm test -- tests/lib/queries/delete-patient-fk-guard.test.ts`, `npx vitest run tests/lib/no-credential-leak.test.ts tests/lib/no-aadhaar-leak.test.ts tests/db/schema.test.ts`
Expected: all PASS. The FK guard sees `encounters` and `follow_up_orders` handled.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts scripts/migrations/2026-10-07-sp3-encounters-follow-up.sql src/lib/queries/patients.ts src/db/seed.ts tests/db/encounters-follow-up-schema.test.ts
git commit -m "feat(sp3): encounters, follow-up orders and contact attempts schema + migration"
```

---

### Task 3: Role constants, capability bullets, log-only follow-up notifier

**Files:**
- Modify: `src/lib/role-policy.ts` (append an `// SP3` block), `src/lib/role-capabilities.ts`
- Create: `src/lib/follow-ups/notifier.ts`
- Test: `tests/lib/role-capabilities.test.ts` (append), `tests/lib/follow-ups/notifier.test.ts`

**Interfaces:**
- Consumes: `logAudit` (`src/lib/audit.ts`); `type Session`.
- Produces:
  - `role-policy.ts`: `FOLLOW_UP_VIEW_ROLES`, `FOLLOW_UP_PLAN_ROLES`, `FOLLOW_UP_BOOKING_ROLES`, `FOLLOW_UP_WORKLIST_ROLES`, `FOLLOW_UP_CLINICAL_NOTES_ROLES`, `CHECK_IN_ROLES`, `ENCOUNTER_STATUS_ROLES`, `DISCHARGE_ROLES`, with exactly the roles in Global Constraints. Each is `readonly Role[]`.
  - `notifier.ts`:
    - `type FollowUpNoticeKind = 'planned' | 'plan_changed' | 'booked' | 'rescheduled' | 'unbooked' | 'cancelled'`
    - `interface FollowUpNotice { kind: FollowUpNoticeKind; followUpOrderId: number; patientId: string; dueDate: string; appointmentStartsAt: Date | null }`
    - `interface FollowUpNotifyResult { channel: 'log'; delivered: false }`
    - `interface FollowUpNotifier { notify(notice: FollowUpNotice): Promise<FollowUpNotifyResult> }`
    - `createLogOnlyFollowUpNotifier(log: (line: string) => void = console.info): FollowUpNotifier` writes exactly one line: `[follow-up notice] kind=<kind> order=<id> patient=<patientId> due=<dueDate> appt=<ISO or none> channel=log delivered=false`. No name, phone, reason or notes.
    - `getFollowUpNotifier(): FollowUpNotifier` returns the log-only one. Add a comment saying SP5 swaps in `src/lib/notify`.
    - `notifyFollowUpSafely(session: Session, notice: FollowUpNotice, notifier: FollowUpNotifier = getFollowUpNotifier()): Promise<void>` runs `notify`, then `logAudit(session, 'follow-up notice (log only)', notice.patientId, `followUp=${id} kind=${kind} delivered=false`)`. Any throw is caught and `console.error('[follow-up notice] failed', err instanceof Error ? err.name : 'error')`. It never rethrows: a notice failure must not fail a committed change.
  - `role-capabilities.ts` bullets, verbatim. Do not touch any `summary`.
    - pi: `'Set and change a patient\'s follow-up plan (due date or interval, window, reason and plan notes), and start or complete a visit'`
    - admin: the pi bullet text, plus `'Book, reschedule or cancel follow-up appointments and log patient contact attempts from the follow-up recall list'`
    - frontdesk: `'View every follow-up and work the follow-up recall list: book, reschedule or cancel the follow-up appointment and log contact attempts (the clinical plan stays with the doctor)'` and `'Check a patient in against a booked follow-up appointment, which issues the OPD token'`
    - crc: `'View follow-ups and the follow-up recall list (read-only)'`

- [ ] **Step 1: Write the failing tests**

```ts
// notifier.test.ts
it('logs ids only and reports not delivered', async () => {
  const lines: string[] = []
  const res = await createLogOnlyFollowUpNotifier((l) => lines.push(l)).notify({ kind: 'booked', followUpOrderId: 12, patientId: 'RD-0007', dueDate: '2026-10-21', appointmentStartsAt: new Date('2026-10-21T04:00:00Z') })
  expect(res).toEqual({ channel: 'log', delivered: false })
  expect(lines).toEqual(['[follow-up notice] kind=booked order=12 patient=RD-0007 due=2026-10-21 appt=2026-10-21T04:00:00.000Z channel=log delivered=false'])
})
it('notifyFollowUpSafely audits and swallows notifier errors', async () => {
  vi.mocked(logAudit).mockClear()
  await expect(notifyFollowUpSafely(SESSION, NOTICE, { notify: async () => { throw new Error('boom') } })).resolves.toBeUndefined()
  await notifyFollowUpSafely(SESSION, NOTICE, createLogOnlyFollowUpNotifier(() => {}))
  expect(logAudit).toHaveBeenCalledWith(SESSION, 'follow-up notice (log only)', 'RD-0007', 'followUp=12 kind=booked delivered=false')
})
// role-capabilities.test.ts (append)
it('states the SP3 follow-up capabilities the server grants', () => {
  expect(has('pi', /follow-up plan/i)).toBe(true); expect(has('admin', /follow-up plan/i)).toBe(true)
  expect(has('frontdesk', /recall list/i)).toBe(true); expect(has('frontdesk', /follow-up plan/i)).toBe(false)
  expect(has('crc', /recall list \(read-only\)/i)).toBe(true)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/follow-ups/notifier.test.ts tests/lib/role-capabilities.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the constants, the bullets and the notifier.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the same command, then `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/role-policy.ts src/lib/role-capabilities.ts src/lib/follow-ups/notifier.ts tests/lib/follow-ups/notifier.test.ts tests/lib/role-capabilities.test.ts
git commit -m "feat(sp3): follow-up role allowlists, capability bullets and log-only notifier"
```

---

### Task 4: Encounter queries: check-in transaction, OPD token, transitions, reads

**Files:**
- Create: `src/lib/queries/executor.ts`, `src/lib/queries/encounters.ts`
- Test: `tests/lib/queries/encounters.test.ts` (DB)

**Interfaces:**
- Consumes:
  - Task 1: `istDateOf`, `startOfIstDay`, `defaultEncounterVisitType`, `canTransitionEncounter`, types
  - Task 2: tables
  - `todayIsoIn`, `DEFAULT_TIMEZONE`, `logAudit(…, executor)`, `type DoctorAssignmentRow`
- Produces:
  - `executor.ts`: `export type WriteExecutor = Pick<ReturnType<typeof getDb>, 'execute' | 'select' | 'insert' | 'update' | 'delete'>`
  - `encounters.ts`:
    - `export type Encounter = EncounterRow`
    - `allocateOpdToken(executor: WriteExecutor, encounterDate: string): Promise<number>`:
      - Must run inside a transaction.
      - Takes `pg_advisory_xact_lock(hashtext('encounters.opd_token:' || encounterDate))`.
      - Returns `greatest(coalesce(max(encounters.opd_token) for that date, 0), coalesce(max(doctor_assignments.queue_ticket_number) where created_at >= startOfIstDay(date) and created_at < startOfIstDay(date + 1), 0)) + 1`. The second term keeps lobby numbers unique on deploy day, when count-based tickets already exist.
    - `interface CheckInVisitInput { patientId: string; providerId: number; visitType: 'inpatient' | 'outpatient'; urgency: 'routine' | 'urgent' | 'emergency'; reason: string; roomId: number | null; appointmentId: number | null; createAdmission: boolean }`
    - `type CheckInVisitError = 'appointment_not_found' | 'appointment_mismatch' | 'appointment_not_scheduled' | 'appointment_not_today' | 'appointment_already_checked_in'`
    - `type CheckInVisitResult = { ok: true; assignment: DoctorAssignmentRow; encounter: Encounter; admissionId: number | null; completedFollowUpOrderId: number | null } | { ok: false; error: CheckInVisitError }`
    - `checkInVisit(input: CheckInVisitInput, session: Session, now: Date = new Date()): Promise<CheckInVisitResult>`. It is **one transaction**, in this order:
      1. Set `encounterDate = istDateOf(now)`.
      2. If `appointmentId` is set, run `select … for update` on the appointment, then validate:
         - missing → `appointment_not_found`
         - patient or provider differs → `appointment_mismatch`
         - status ≠ scheduled → `appointment_not_scheduled`
         - `istDateOf(startsAt) !== encounterDate` → `appointment_not_today`
         - an encounter already has this `appointmentId` → `appointment_already_checked_in`
         Return the error before any write.
      3. Allocate the token with `allocateOpdToken(tx, encounterDate)`.
      4. Insert `doctorAssignments` with `queueTicketNumber = token`, `assignedByName = session.name`, `status = appointmentId ? 'scheduled' : 'pending'`, and `appointmentId`.
      5. If `createAdmission`, insert the admission (`admissionType: 'elective'`, `createdFromAssignmentId`).
      6. Read the provider's `departmentId`.
      7. If `appointmentId` is set, find a `followUpOrders` row with that `appointmentId` and stored status `scheduled`.
      8. Insert the encounter:
         - `encounterType` is `ipd` for an inpatient check-in, else `opd`
         - `visitType = defaultEncounterVisitType({ urgency, followUpLinked: !!order })`
         - `opdToken = token`
         - `admissionId` is the newly created admission or null
      9. If an order was found, update it to `completed`, with `completedAt = now` and `completedEncounterId`.
      10. Audit on `tx`:
          - `checked in patient (${visitType})`, details `encounter=<id> token=<n>`. The action string is unchanged from today's route.
          - If an order was completed, also `completed follow-up at check-in`, details `followUp=<id> encounter=<id>`.
    - `transitionEncounter(id: number, to: 'in_consultation' | 'completed' | 'cancelled', session: Session, opts?: { cancelReason?: string }): Promise<{ ok: true; encounter: Encounter } | { ok: false; error: 'not_found' | 'invalid_transition' }>`:
      - One transaction, with `for update` on the row and the `canTransitionEncounter` check.
      - Sets `statusChangedAt` / `statusChangedByName`, `completedAt` (on completed) and `cancelReason` (on cancelled).
      - Audits `encounter status changed to ${to}`, details `encounter=<id>`.
    - `getEncounterById(id: number, executor?: WriteExecutor): Promise<Encounter | null>`
    - `interface EncounterListRow { id: number; encounterType: …; visitType: …; status: …; encounterDate: string; opdToken: number | null; providerId: number; providerName: string; departmentName: string | null; appointmentId: number | null; admissionId: number | null; checkedInAt: Date }`
    - `listEncountersForPatient(patientId: string, limit = 20): Promise<EncounterListRow[]>`, newest first
    - `completeAdmissionEncounter(executor: WriteExecutor, admissionId: number, byName: string): Promise<number | null>`. It sets the IPD encounter of that admission to `completed` if it is open, and returns its id or null. Task 10 uses it.

- [ ] **Step 1: Write the failing DB tests**

These tests use run-unique future dates via `now`, so the shared DB never collides. Example: `now = new Date('2099-03-01T10:00:00Z')`, which is IST `2099-03-01`.

```ts
describe.skipIf(!process.env.DATABASE_URL)('encounters (DB)', () => {
  it('allocates sequential tokens per IST date and mirrors them on the assignment', async () => {
    const a = await checkInVisit(input(), SESSION, NOW); const b = await checkInVisit(input(), SESSION, NOW)
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) { expect(b.encounter.opdToken).toBe(a.encounter.opdToken! + 1); expect(a.assignment.queueTicketNumber).toBe(a.encounter.opdToken) }
  })
  it('restarts tokens on a new IST date', async () => {
    const late = await checkInVisit(input(), SESSION, new Date('2099-03-05T18:29:00Z')) // 23:59 IST 5 Mar
    const early = await checkInVisit(input(), SESSION, new Date('2099-03-05T18:31:00Z')) // 00:01 IST 6 Mar
    expect(late.ok && late.encounter.encounterDate).toBe('2099-03-05'); expect(early.ok && early.encounter.encounterDate).toBe('2099-03-06')
    expect(early.ok && early.encounter.opdToken).toBe(1)
  })
  it('concurrent check-ins on one date never share a token', async () => {
    const rs = await Promise.all(Array.from({ length: 5 }, () => checkInVisit(input(), SESSION, NOW2)))
    const tokens = rs.map((r) => (r.ok ? r.encounter.opdToken : null)); expect(new Set(tokens).size).toBe(5)
  })
  it('check-in against a booked follow-up completes it and marks the visit follow_up', async () => {
    // fixture: appointment on IST NOW date + follow_up_orders row status 'scheduled' with that appointmentId
    const r = await checkInVisit(input({ appointmentId: appt.id }), SESSION, NOW)
    expect(r.ok && r.encounter.visitType).toBe('follow_up'); expect(r.ok && r.assignment.status).toBe('scheduled')
    const [o] = await getDb().select().from(followUpOrders).where(eq(followUpOrders.id, order.id))
    expect(o.status).toBe('completed'); expect(o.completedEncounterId).toBe(r.ok ? r.encounter.id : -1)
  })
  it.each([['appointment_not_today', { startsAt: '2099-03-02T04:00:00Z' }], ['appointment_mismatch', { providerId: OTHER_PROVIDER }]])('returns %s with no writes', async (error, over) => { /* … expect { ok: false, error }; no new encounter row for the patient */ })
  it('refuses a second check-in for the same appointment', async () => { /* second call → appointment_already_checked_in */ })
  it('inpatient check-in creates and links the admission', async () => { /* createAdmission: true → encounterType 'ipd', admissionId = admissions row createdFromAssignmentId = assignment.id */ })
  it('writes the check-in audit row on the same transaction', async () => { /* audit_log row userName = PROBE user with details `encounter=${id} token=${token}` */ })
  it('transitionEncounter enforces the state machine', async () => {
    /* checked_in → completed ok; completed → cancelled → { ok: false, error: 'invalid_transition' }; bogus id → not_found */
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/lib/queries/encounters.test.ts`
Expected: FAIL ("Failed to resolve import").

- [ ] **Step 3: Implement `executor.ts` and `encounters.ts`** with the signatures above. Use `tx.execute(sql\`select pg_advisory_xact_lock(hashtext(${'encounters.opd_token:' + date}))\`)`. Read rows as SP1's `nextUhid` does (`Array.isArray(res) ? res : res.rows`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/lib/queries/encounters.test.ts`, then `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/queries/executor.ts src/lib/queries/encounters.ts tests/lib/queries/encounters.test.ts
git commit -m "feat(sp3): encounter check-in transaction with IST OPD tokens and status transitions"
```

---

### Task 5: Check-in route opens the encounter; encounter status route; lobby board

**Files:**
- Modify: `src/app/api/front-desk/check-in/route.ts`, `src/lib/queries/queue-display.ts`
- Create: `src/app/api/encounters/[id]/status/route.ts`
- Modify tests:
  - `tests/api/front-desk-check-in.test.ts`: in `afterEach`, first delete `encounters` whose `doctorAssignmentId` is in `createdAssignmentIds` (or whose `patientId = 'RD-0001'` and `checkedInByName = 'Taylor Nguyen'`), and `follow_up_orders` fixtures, before the existing deletes
  - `tests/api/queue-display.test.ts` (append)
  - `tests/api/rbac-route-gates.test.ts`
- Create test: `tests/api/encounter-status.test.ts`, `tests/api/front-desk-check-in-encounter.test.ts` (mocked)

**Interfaces:**
- Consumes: `checkInVisit`, `transitionEncounter` (Task 4); `CHECK_IN_ROLES`, `ENCOUNTER_STATUS_ROLES` (Task 3); `encounterStatusRequestSchema`, `ENCOUNTER_TRANSITION_ROLES` (Task 1).
- Produces:
  - **Check-in route:**
    - The gate is `CHECK_IN_ROLES`.
    - `request.json()` failure gives a 400 `{ error: 'Invalid JSON' }`.
    - The schema gains `appointmentId: z.number().int().positive().optional()`. It is only valid with `visitType: 'outpatient'`; otherwise the route returns 400 `'appointmentId is only valid for an outpatient check-in'`.
    - The existing patient/provider 404s, the active-admission guard and the room claim keep their order.
    - The route then calls `checkInVisit({ …, roomId: roomId ?? null, appointmentId: appointmentId ?? null, createAdmission: visitType === 'inpatient' && !existingActive }, session)`.
    - `createDoctorAssignment` / `createAdmission` / the route's own `logAudit` are no longer called from here. The audit moved into the transaction.
    - Error mapping:
      - `appointment_not_found` → 404 `'Appointment not found'`
      - `appointment_mismatch` → 409 `'That appointment is for a different patient or doctor.'`
      - `appointment_not_scheduled` → 409 `'That appointment is not in a bookable state.'`
      - `appointment_not_today` → 409 `'That appointment is not today.'`
      - `appointment_already_checked_in` → 409 `'This appointment has already been checked in.'`
    - A 201 body is `{ ...result.assignment, encounterId: result.encounter.id, opdToken: result.encounter.opdToken }`. The existing `id`, `roomId` and `status` fields are unchanged.
  - **`POST /api/encounters/[id]/status`:**
    - Order: gate `ENCOUNTER_STATUS_ROLES` → parse (`Invalid JSON` → 400) → `encounterStatusRequestSchema` (400) → id integer (400) → `ENCOUNTER_TRANSITION_ROLES[to].includes(role)` else 403 `Forbidden` → `transitionEncounter`.
    - Error mapping: `not_found` → 404; `invalid_transition` → 409 `'This visit can no longer change to that status.'`
    - Success is 200 `{ encounter }`.
  - **`getQueueDisplayRows`:**
    - Left-join `encounters` on `encounters.doctorAssignmentId = doctorAssignments.id` and select `encounterStatus`.
    - Skip the row when `encounterStatus` is `completed` or `cancelled`.
    - A row with `status === 'scheduled'`, `roomId === null`, a non-null `appointmentId` and `encounterStatus === 'checked_in'` is pushed as `stage: 'waiting'`. That is a checked-in follow-up patient.
    - Every other rule is unchanged.
  - **Harness rows:**
    - `API_GATES` gets `POST /api/front-desk/check-in` (`[...CHECK_IN_ROLES]`) and `POST /api/encounters/[id]/status` (`[...ENCOUNTER_STATUS_ROLES]`), both through `settle()`.
    - Do **not** rename `SP1_WRITE_GATES`, because SP2 edits it too. Add `const SP3_WRITE_GATES` in the same shape, containing the same two routes with a `NOT_JSON` body. Change the existing `describe.each(SP1_WRITE_GATES)` to `describe.each([...SP1_WRITE_GATES, ...SP3_WRITE_GATES])`.

- [ ] **Step 1: Write the failing tests**

```ts
// front-desk-check-in-encounter.test.ts (mocks: auth, encounters, admissions.getActiveAdmissionForPatient, rooms.assignRoomToPatient, db select for patient/provider via vi.mock('@/db/client'))
it('passes appointmentId through and returns encounterId + opdToken', async () => {
  vi.mocked(checkInVisit).mockResolvedValue({ ok: true, assignment: { id: 5, roomId: null, status: 'scheduled' } as never, encounter: { id: 9, opdToken: 4 } as never, admissionId: null, completedFollowUpOrderId: 3 })
  const res = await POST(req({ ...valid, appointmentId: 77 }))
  expect(res.status).toBe(201); expect(await res.json()).toMatchObject({ id: 5, encounterId: 9, opdToken: 4 })
  expect(checkInVisit).toHaveBeenCalledWith(expect.objectContaining({ appointmentId: 77, createAdmission: false }), expect.anything())
})
it('409s an appointment on another IST date', async () => {
  vi.mocked(checkInVisit).mockResolvedValue({ ok: false, error: 'appointment_not_today' })
  expect((await POST(req({ ...valid, appointmentId: 77 }))).status).toBe(409)
})
it('rejects appointmentId on an inpatient check-in before any write', async () => {
  expect((await POST(req({ ...valid, visitType: 'inpatient', appointmentId: 77 }))).status).toBe(400); expect(checkInVisit).not.toHaveBeenCalled()
})
// encounter-status.test.ts (mock transitionEncounter)
it('frontdesk may cancel but not complete', async () => {
  role = 'frontdesk'
  expect((await POST(send({ to: 'completed' }), ctx('3'))).status).toBe(403)
  expect((await POST(send({ to: 'cancelled', cancelReason: 'left' }), ctx('3'))).status).toBe(200)
})
it('maps invalid_transition to 409 and not_found to 404', async () => { /* … */ })
// queue-display.test.ts (append, DB)
it('shows a checked-in follow-up (scheduled, no room, encounter checked_in) as waiting', async () => { /* use checkInVisit with appointmentId for today's IST date; GET → ticket with stage 'waiting' */ })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/api/front-desk-check-in-encounter.test.ts tests/api/encounter-status.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the route change, the new route, the queue-display rule and the harness rows. Read `node_modules/next/dist/docs` on route handlers first.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/api/front-desk-check-in-encounter.test.ts tests/api/encounter-status.test.ts`, then `npm test -- tests/api/front-desk-check-in.test.ts tests/api/queue-display.test.ts tests/api/rbac-route-gates.test.ts`, then `npx tsc --noEmit`
Expected: PASS. The existing check-in DB tests still pass unchanged apart from their cleanup.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/front-desk/check-in/route.ts src/app/api/encounters src/lib/queries/queue-display.ts tests/api/front-desk-check-in.test.ts tests/api/front-desk-check-in-encounter.test.ts tests/api/encounter-status.test.ts tests/api/queue-display.test.ts tests/api/rbac-route-gates.test.ts
git commit -m "feat(sp3): check-in opens an encounter with an OPD token; encounter status route"
```

---

### Task 6: Follow-up order queries + role-redacted views

**Files:**
- Create: `src/lib/follow-ups/view.ts`, `src/lib/queries/follow-ups.ts`
- Test: `tests/lib/follow-ups/view.test.ts` (pure), `tests/lib/queries/follow-ups.test.ts` (DB)

**Interfaces:**
- Consumes: Task 1 (`resolveFollowUpDates`, `dueDateProblem`, `deriveFollowUpStatus`, `recallBucket`, `type FollowUpTiming`); Task 2 tables; Task 3 `FOLLOW_UP_CLINICAL_NOTES_ROLES`; Task 4 `getEncounterById`, `WriteExecutor`; `logAudit`; `todayIsoIn`.
- Produces:
  - **`view.ts` (pure):**
    - `interface ContactAttemptView { id: number; channel: …; outcome: …; note: string | null; attemptedByName: string; attemptedAt: Date }`
    - `interface FollowUpJoinedRow`: the order columns, plus `prescriberName: string`, `departmentName: string | null`, `appointment: { id: number; startsAt: Date; endsAt: Date; status: ApptStatus; providerId: number; providerName: string } | null` and `contactAttempts: ContactAttemptView[]`
    - `interface FollowUpView { id; patientId; source; status: FollowUpStatus; bucket: RecallBucket; dueDate; windowStart; windowEnd; interval: FollowUpInterval | null; reason: string; planNotes: string | null; prescribedBy: { providerId: number; name: string }; department: { id: number; name: string } | null; appointment: FollowUpJoinedRow['appointment']; createdByName: string; createdAt: Date; scheduledByName: string | null; scheduledAt: Date | null; cancelReason: string | null; contactAttempts: ContactAttemptView[]; lastContact: ContactAttemptView | null }`
    - `toFollowUpView(row: FollowUpJoinedRow, todayIso: string, role: Role): FollowUpView`. `status` is `deriveFollowUpStatus` and `bucket` is `recallBucket`. `planNotes` is null unless `FOLLOW_UP_CLINICAL_NOTES_ROLES.includes(role)`. Contact attempts are newest first.
    - `interface PortalFollowUp { dueDate: string; windowStart: string; windowEnd: string; status: FollowUpStatus; appointmentStartsAt: Date | null; doctorName: string | null }`. These are exactly these keys.
    - `toPortalFollowUp(v: FollowUpView): PortalFollowUp`. `doctorName` is the appointment provider when booked, else the prescriber.
  - **`follow-ups.ts`:**
    - `export type FollowUpOrder = FollowUpOrderRow`
    - `interface CreateFollowUpOrderInput { patientId: string; source: 'encounter' | 'discharge' | 'manual'; prescribedByProviderId: number; departmentId: number | null; timing: FollowUpTiming; windowDaysBefore?: number; windowDaysAfter?: number; reason: string; planNotes: string | null; originatingEncounterId: number | null; originatingAdmissionId: number | null; appointmentId?: number | null }`
    - `type CreateFollowUpResult = { ok: true; order: FollowUpOrder } | { ok: false; error: 'patient_not_found' | 'provider_not_found' | 'encounter_not_found' | 'encounter_mismatch' | 'due_date_invalid'; message?: string }`
    - `createFollowUpOrder(input, session: Session, opts?: { executor?: WriteExecutor; today?: string }): Promise<CreateFollowUpResult>`:
      - It uses `opts.executor` when given (Task 10's discharge transaction). Otherwise it opens its own transaction.
      - `today = opts.today ?? todayIsoIn()`. The base date is the originating encounter's `encounterDate` when given (which must belong to the patient), else `today`.
      - `dueDateProblem(due, today)` maps to `due_date_invalid` with its message.
      - An inactive or missing provider gives `provider_not_found`.
      - `departmentId` defaults to the prescriber's `departmentId`.
      - With `appointmentId`, the order is inserted as `status: 'scheduled'`, `scheduledAt` now and `scheduledByName` = session.name.
      - `createdByUserId` = session.userId.
      - Audits on the same executor: `set follow-up plan`, details `followUp=<id> source=<source> due=<dueDate>`.
    - `type UpdateFollowUpPlanInput = UpdateFollowUpPlanRequest` (from Task 1)
    - `updateFollowUpPlan(id: number, patch: UpdateFollowUpPlanInput, session: Session, today = todayIsoIn()): Promise<{ ok: true; order: FollowUpOrder; changedFields: string[]; bookingOutsideWindow: boolean } | { ok: false; error: 'not_found' | 'not_editable' | 'provider_not_found' | 'due_date_invalid'; message?: string }>`:
      - It locks the row `for update` and derives the status with the linked appointment.
      - Only planned, scheduled or missed orders are editable.
      - A new timing is resolved from the stored `baseDate`. When only the window days change, the window is recomputed around the stored `dueDate`.
      - It never moves a booked appointment. `bookingOutsideWindow` is true when the booked appointment's IST date falls outside the new window.
      - It sets `planUpdatedAt` / `planUpdatedByName` / `updatedAt`.
      - Audits `changed follow-up plan`, details `followUp=<id> fields=<sorted comma list of changed keys>`.
    - `cancelFollowUpOrder(id: number, reason: string, session: Session): Promise<{ ok: true; order: FollowUpOrder; cancelledAppointmentId: number | null } | { ok: false; error: 'not_found' | 'not_cancellable' }>`:
      - Only open orders can be cancelled.
      - A linked `scheduled` appointment is set to `cancelled` in the same transaction.
      - Audits `cancelled follow-up`, details `followUp=<id>` plus ` appointment=<id>` when one was cancelled.
    - `getFollowUpById(id: number): Promise<FollowUpOrder | null>`
    - `listFollowUpsForPatient(patientId: string, role: Role, today = todayIsoIn()): Promise<FollowUpView[]>`: newest `createdAt` first, closed ones included, max 50. It uses joins plus one query for contact attempts (`inArray`), never N+1.
    - `getPortalFollowUps(patientId: string, today = todayIsoIn()): Promise<PortalFollowUp[]>`: open orders only (derived status planned, scheduled or missed), soonest `dueDate` first. It is built via `toFollowUpView(…, 'admin')` then `toPortalFollowUp`, so no clinical field can leak through the projection.

- [ ] **Step 1: Write the failing tests**

```ts
// view.test.ts
it('toFollowUpView nulls planNotes for frontdesk and keeps it for pi/crc', () => {
  expect(toFollowUpView(ROW, '2026-10-20', 'frontdesk').planNotes).toBeNull()
  expect(toFollowUpView(ROW, '2026-10-20', 'pi').planNotes).toBe('Titrate amlodipine')
  expect(toFollowUpView(ROW, '2026-10-20', 'crc').planNotes).toBe('Titrate amlodipine')
  expect(toFollowUpView(ROW, '2026-10-20', 'frontdesk').reason).toBe('BP review')
})
it('derives status and bucket', () => { expect(toFollowUpView(ROW, '2026-10-29', 'admin')).toMatchObject({ status: 'planned', bucket: 'overdue' }) })
it('portal projection has exactly the allowed keys', () => {
  expect(Object.keys(toPortalFollowUp(toFollowUpView(ROW, '2026-10-20', 'admin'))).sort())
    .toEqual(['appointmentStartsAt', 'doctorName', 'dueDate', 'status', 'windowEnd', 'windowStart'])
})
// follow-ups.test.ts (DB)
describe.skipIf(!process.env.DATABASE_URL)('follow-up orders (DB)', () => {
  it('creates from an interval relative to the originating encounter date', async () => { /* encounter date 2099-04-01, 2 weeks → due 2099-04-15, window 04-12..04-22, baseDate 2099-04-01, source 'encounter' */ })
  it('rejects an encounter belonging to another patient', async () => { /* encounter_mismatch, no row */ })
  it('rejects a past due date with due_date_invalid', async () => { /* today: '2099-05-10', dueDate 2099-05-01 */ })
  it('updateFollowUpPlan recomputes from baseDate, reports changed fields and never moves the booking', async () => { /* … changedFields ['reason','timing']; bookingOutsideWindow true; appointment startsAt unchanged */ })
  it('refuses to edit a cancelled order', async () => { /* not_editable */ })
  it('cancel cancels the linked scheduled appointment in the same transaction', async () => { /* appointment.status 'cancelled' */ })
  it('audit details carry ids only', async () => {
    /* create with reason 'BP review SECRETWORD' and planNotes 'notes SECRETWORD'; select audit_log rows for the patient → none contains 'SECRETWORD' */
  })
  it('getPortalFollowUps returns open orders without reason or notes', async () => { /* JSON.stringify(result) has no 'SECRETWORD' */ })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/follow-ups/view.test.ts` and `npm test -- tests/lib/queries/follow-ups.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `view.ts` and `follow-ups.ts`**.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the same commands, then `npx tsc --noEmit` and `npx vitest run tests/lib/no-credential-leak.test.ts tests/lib/no-aadhaar-leak.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/follow-ups/view.ts src/lib/queries/follow-ups.ts tests/lib/follow-ups/view.test.ts tests/lib/queries/follow-ups.test.ts
git commit -m "feat(sp3): follow-up order create/change/cancel with role-redacted and portal views"
```

---

### Task 7: Booking, contact attempts and the recall worklist query

**Files:**
- Modify: `src/lib/queries/appointments.ts`. `hasSchedulingConflict` gains a trailing `executor: Pick<ReturnType<typeof getDb>, 'select'> = getDb()` parameter; existing callers are unchanged.
- Create: `src/lib/follow-ups/worklist.ts` (pure), `src/lib/queries/follow-up-recall.ts`
- Test: `tests/lib/follow-ups/worklist.test.ts`, `tests/lib/queries/follow-up-recall.test.ts` (DB)

**Interfaces:**
- Consumes: Tasks 1, 2, 6 (`toFollowUpView`, `FollowUpView`, `getFollowUpById`); `followUpVisitReason`; `logAudit`.
- Produces:
  - **`worklist.ts`:**
    - `WORKLIST_BUCKETS = ['due', 'overdue', 'upcoming', 'scheduled', 'missed'] as const`; `type WorklistBucket`; `type WorklistBucketFilter = WorklistBucket | 'all_open'`
    - `interface WorklistFilters { bucket: WorklistBucketFilter; departmentId: number | null; providerId: number | null }`
    - `parseWorklistParams(sp: Record<string, string | string[] | undefined>): WorklistFilters`. An unknown bucket becomes `'due'`. Non-positive or non-integer ids become null.
    - `interface WorklistRow extends Pick<FollowUpView, 'id' | 'status' | 'bucket' | 'dueDate' | 'windowStart' | 'windowEnd' | 'reason' | 'appointment' | 'prescribedBy' | 'department' | 'lastContact'> { patientId: string; patientName: string; uhid: string | null; phone: string | null; contactAttemptCount: number }`
    - `filterAndSortWorklist(rows: WorklistRow[], f: WorklistFilters): WorklistRow[]`. Sort order:
      - overdue by windowEnd ascending
      - due by dueDate ascending
      - upcoming by windowStart ascending
      - scheduled by appointment startsAt ascending
      - missed by windowEnd descending
      - `all_open` in bucket order due → overdue → upcoming → scheduled → missed
    - `countWorklistBuckets(rows: WorklistRow[]): Record<WorklistBucket, number>`
  - **`follow-up-recall.ts`:**
    - `bookFollowUp(id: number, slot: { providerId: number; startsAt: Date; endsAt: Date }, session: Session, now: Date = new Date()): Promise<{ ok: true; order: FollowUpOrder; appointmentId: number; kind: 'booked' | 'rescheduled' } | { ok: false; error: 'not_found' | 'not_bookable' | 'provider_not_found' | 'slot_in_past' | 'conflict' }>`. One transaction, in this order:
      1. Lock the order `for update`.
      2. Derive the status. Only planned, scheduled or missed is bookable.
      3. The provider must exist and be active.
      4. `startsAt <= now` gives `slot_in_past`.
      5. Take `pg_advisory_xact_lock(hashtext('appointments.provider:' || providerId))`.
      6. `hasSchedulingConflict(providerId, startsAt, endsAt, existingScheduledApptId, tx)` gives `conflict`.
      7. If the order has a linked appointment still `scheduled`, UPDATE its provider and times (`rescheduled`). Otherwise INSERT `{ patientId, providerId, startsAt, endsAt, visitReason: followUpVisitReason(order.reason), status: 'scheduled' }` (`booked`).
      8. Update the order to `status 'scheduled'`, with `appointmentId`, `scheduledAt` / `scheduledByName` / `scheduledByUserId` and `updatedAt`.
      9. Audit `booked follow-up appointment` or `rescheduled follow-up appointment`, details `followUp=<id> appointment=<apptId>`.
    - `unbookFollowUp(id: number, reason: string, session: Session): Promise<{ ok: true; order: FollowUpOrder; cancelledAppointmentId: number } | { ok: false; error: 'not_found' | 'not_booked' }>`:
      - Requires a linked appointment with status `scheduled`.
      - Sets the appointment to `cancelled` with `notes = `Follow-up booking cancelled: ${reason}``. The order stays open, so its `cancelReason` is not used. The free-text reason never goes into the audit log.
      - The order goes to `planned` with `appointmentId`, `scheduledAt`, `scheduledByName` and `scheduledByUserId` set to null.
      - Audits `cancelled follow-up booking`, details `followUp=<id> appointment=<apptId>`.
    - `recordContactAttempt(id: number, input: ContactAttemptRequest, session: Session): Promise<{ ok: true; attempt: FollowUpContactAttemptRow } | { ok: false; error: 'not_found' | 'closed' }>`. A completed or cancelled order (derived) is `closed`. Audits `logged follow-up contact attempt`, details `followUp=<id> channel=<c> outcome=<o>`.
    - `listFollowUpWorklist(today = todayIsoIn()): Promise<WorklistRow[]>`:
      - Stored status in (`planned`, `scheduled`) and `windowStart <= addDaysIso(today, UPCOMING_HORIZON_DAYS)`.
      - Patients: named columns only (`id`, `name`, `uhid`, `phone`).
      - Contact attempts are counted, and the latest fetched, in one extra query each.
      - Rows whose derived status is `completed`/`cancelled` are dropped. The result is capped at 500 rows, ordered by `dueDate`.

- [ ] **Step 1: Write the failing tests**

```ts
// worklist.test.ts
it('parseWorklistParams defaults and sanitises', () => {
  expect(parseWorklistParams({ bucket: 'nope', departmentId: '-3', providerId: '7' })).toEqual({ bucket: 'due', departmentId: null, providerId: 7 })
})
it('filters by bucket/department/provider and counts buckets', () => { /* fixture rows across buckets; providerId filter uses prescribedBy.providerId */ })
it('sorts overdue oldest window end first', () => { /* … */ })
// follow-up-recall.test.ts (DB)
describe.skipIf(!process.env.DATABASE_URL)('follow-up booking (DB)', () => {
  it('books, then reschedules the same appointment row', async () => { /* first kind 'booked', second kind 'rescheduled', same appointmentId, times moved; visitReason starts 'Follow-up: ' */ })
  it('concurrent bookings of one slot: exactly one wins, one appointment row', async () => {
    const [a, b] = await Promise.all([bookFollowUp(o1.id, SLOT, S), bookFollowUp(o2.id, SLOT, S)])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    expect([a, b].find((r) => !r.ok)).toMatchObject({ error: 'conflict' })
    // exactly one appointments row for the provider in that slot
  })
  it('refuses to book a cancelled follow-up', async () => { /* not_bookable */ })
  it('rejects a slot in the past', async () => { /* slot_in_past */ })
  it('unbook cancels the appointment and returns the order to planned', async () => { /* … */ })
  it('calendar cancel puts the order back in the due bucket', async () => {
    /* book; then getDb().update(appointments).set({ status: 'cancelled' }) directly (as PUT /api/appointments does); listFollowUpWorklist(today within window) row has status 'planned', bucket 'due' */
  })
  it('records a contact attempt and refuses one on a completed order', async () => { /* closed */ })
  it('worklist rows never carry planNotes or Aadhaar fields', async () => { /* JSON.stringify(rows) lacks planNotes text; no key matching /aadhaar/i */ })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/follow-ups/worklist.test.ts` and `npm test -- tests/lib/queries/follow-up-recall.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `worklist.ts`, `follow-up-recall.ts` and the `hasSchedulingConflict` executor parameter.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the same commands, then `npm test -- tests/lib/queries/appointments.test.ts` and `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/follow-ups/worklist.ts src/lib/queries/follow-up-recall.ts src/lib/queries/appointments.ts tests/lib/follow-ups/worklist.test.ts tests/lib/queries/follow-up-recall.test.ts
git commit -m "feat(sp3): follow-up booking/reschedule/unbook, contact attempts and recall worklist query"
```

---

### Task 8: Clinical plan routes (create / change / cancel)

**Files:**
- Create: `src/app/api/follow-ups/route.ts` (POST), `src/app/api/follow-ups/[id]/route.ts` (PATCH), `src/app/api/follow-ups/[id]/cancel/route.ts` (POST)
- Modify: `tests/api/rbac-route-gates.test.ts` (three `API_GATES` rows + three `SP3_WRITE_GATES` rows, allowed `[...FOLLOW_UP_PLAN_ROLES]`)
- Test: `tests/api/follow-ups-plan.test.ts` (query module, notifier and `resolveDoctorQueueProvider` mocked)

**Interfaces:**
- Consumes:
  - Task 6: `createFollowUpOrder`, `updateFollowUpPlan`, `cancelFollowUpOrder`
  - Task 3: `notifyFollowUpSafely`, `FOLLOW_UP_PLAN_ROLES`
  - Task 1: `createFollowUpSchema`, `updateFollowUpPlanSchema`, `reasonOnlySchema`
  - `resolveDoctorQueueProvider` (`src/lib/doctor-queue-provider.ts`)
- Produces (contracts; every route follows gate → JSON parse → zod → id check):
  - **`POST /api/follow-ups`:**
    - **pi:** the prescriber is `resolveDoctorQueueProvider(session)`. If none, the route returns 409 `'Your login is not linked to a doctor profile, so you cannot prescribe a follow-up.'`. A body `prescribedByProviderId` that differs from it gives 400 `'Doctors always prescribe follow-ups as themselves.'`.
    - **admin:** `prescribedByProviderId` is required; without it the route returns 400.
    - `source = originatingEncounterId ? 'encounter' : 'manual'`.
    - Error mapping:
      - `patient_not_found` / `provider_not_found` / `encounter_not_found` → 404
      - `encounter_mismatch` → 409 `'That visit belongs to a different patient.'`
      - `due_date_invalid` → 400 `{ error: message }`
    - Success is 201 `{ order }`, then `notifyFollowUpSafely(session, { kind: 'planned', … })`.
  - **`PATCH /api/follow-ups/[id]`:**
    - A pi sending `prescribedByProviderId` gets 400 (only admin reassigns the prescriber).
    - Error mapping: `not_found` → 404; `not_editable` → 409 `'This follow-up is already completed or cancelled.'`; `due_date_invalid` → 400.
    - Success is 200 `{ order, bookingOutsideWindow }`.
    - If `changedFields` includes `timing`, notify `plan_changed`.
  - **`POST /api/follow-ups/[id]/cancel`:**
    - Body `reasonOnlySchema`.
    - Error mapping: `not_found` → 404; `not_cancellable` → 409.
    - Success is 200 `{ order, cancelledAppointmentId }`, then notify `cancelled`.

- [ ] **Step 1: Write the failing tests**

```ts
it.each(['frontdesk', 'crc', 'billing', 'labs', 'pharmacy'] as const)('%s PATCH is 403 and never calls updateFollowUpPlan', async (r) => {
  role = r; const res = await PATCH(send('PATCH', '/api/follow-ups/3', '{not json'), ctx({ id: '3' }))
  expect(res.status).toBe(403); expect(await res.json()).toEqual({ error: 'Forbidden' }); expect(updateFollowUpPlan).not.toHaveBeenCalled()
})
it('pi prescribes as self; a different prescribedByProviderId is 400', async () => {
  role = 'pi'; vi.mocked(resolveDoctorQueueProvider).mockResolvedValue({ id: 4, name: 'Dr. K' })
  await POST(send('POST', '/api/follow-ups', VALID)); expect(createFollowUpOrder).toHaveBeenCalledWith(expect.objectContaining({ prescribedByProviderId: 4, source: 'manual' }), expect.anything())
  expect((await POST(send('POST', '/api/follow-ups', { ...VALID, prescribedByProviderId: 9 }))).status).toBe(400)
})
it('pi with no linked provider gets 409', async () => { /* resolveDoctorQueueProvider → null */ })
it('admin must name the prescriber', async () => { role = 'admin'; expect((await POST(send('POST', '/api/follow-ups', VALID))).status).toBe(400) })
it('maps due_date_invalid to 400 with the message and notifies only on success', async () => { /* … notifyFollowUpSafely not called on 400 */ })
it('PATCH reports bookingOutsideWindow and notifies plan_changed only when timing changed', async () => { /* … */ })
it('unparseable JSON from an allowed role is 400 Invalid JSON', async () => { /* role pi */ })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/api/follow-ups-plan.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the three routes and the harness rows.**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/api/follow-ups-plan.test.ts`, then `npm test -- tests/api/rbac-route-gates.test.ts`, then `npx tsc --noEmit`
Expected: PASS, and `no API_GATES row still carries a gap tag` stays green.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/follow-ups tests/api/follow-ups-plan.test.ts tests/api/rbac-route-gates.test.ts
git commit -m "feat(sp3): follow-up plan routes for doctors and admin"
```

---

### Task 9: Front-desk routes (book / reschedule / unbook / contact attempts)

**Files:**
- Create: `src/app/api/follow-ups/[id]/booking/route.ts` (PUT), `src/app/api/follow-ups/[id]/unbook/route.ts` (POST), `src/app/api/follow-ups/[id]/contact-attempts/route.ts` (POST)
- Modify: `tests/api/rbac-route-gates.test.ts` (three rows each in `API_GATES` and `SP3_WRITE_GATES`, allowed `[...FOLLOW_UP_BOOKING_ROLES]`)
- Test: `tests/api/follow-ups-booking.test.ts`

**Interfaces:**
- Consumes: Task 7 (`bookFollowUp`, `unbookFollowUp`, `recordContactAttempt`); Task 1 (`bookFollowUpSchema`, `reasonOnlySchema`, `contactAttemptSchema`); Task 3 (`notifyFollowUpSafely`, `FOLLOW_UP_BOOKING_ROLES`).
- Produces:
  - **`PUT …/booking`:**
    - The body is `BookFollowUpRequest`; it is converted with `new Date(startsAt)`.
    - Error mapping:
      - `not_found` → 404 `'Follow-up not found'`
      - `not_bookable` → 409 `'This follow-up is already completed or cancelled.'`
      - `provider_not_found` → 404 `'Doctor not found or inactive'`
      - `slot_in_past` → 400 `'Pick a time later than now.'`
      - `conflict` → 409 `'This doctor already has an appointment during that time.'`
    - Success is 200 `{ order, appointmentId, kind }`, then notify `booked` / `rescheduled` with `appointmentStartsAt`.
  - **`POST …/unbook`:** `reasonOnlySchema`. `not_found` → 404; `not_booked` → 409 `'This follow-up has no booked appointment to cancel.'`. Success is 200, then notify `unbooked`.
  - **`POST …/contact-attempts`:** `contactAttemptSchema`. `not_found` → 404; `closed` → 409. Success is 201 `{ attempt }`. There is no notice.

- [ ] **Step 1: Write the failing tests**

```ts
it.each(['pi', 'crc', 'billing'] as const)('%s cannot book (403, query not called)', async (r) => { /* … */ })
it('rejects a slot without an explicit offset with 400 before calling bookFollowUp', async () => {
  role = 'frontdesk'; const res = await PUT(send('PUT', '/api/follow-ups/3/booking', { providerId: 1, startsAt: '2026-10-21T09:30:00', endsAt: '2026-10-21T09:45:00' }), ctx({ id: '3' }))
  expect(res.status).toBe(400); expect(bookFollowUp).not.toHaveBeenCalled()
})
it('passes the IST slot through as the exact instant', async () => {
  await PUT(send('PUT', '/api/follow-ups/3/booking', { providerId: 1, startsAt: '2026-10-22T00:30:00+05:30', endsAt: '2026-10-22T00:45:00+05:30' }), ctx({ id: '3' }))
  expect(vi.mocked(bookFollowUp).mock.calls[0][1].startsAt.toISOString()).toBe('2026-10-21T19:00:00.000Z')
})
it.each([['conflict', 409], ['slot_in_past', 400], ['not_bookable', 409], ['not_found', 404]] as const)('maps %s to %i', async (error, status) => { /* … */ })
it('notifies booked vs rescheduled with the appointment time', async () => { /* … */ })
it('contact attempt 409s on a closed follow-up and is 201 otherwise', async () => { /* … */ })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/api/follow-ups-booking.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the routes and the harness rows.**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/api/follow-ups-booking.test.ts`, then `npm test -- tests/api/rbac-route-gates.test.ts`, then `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/follow-ups tests/api/follow-ups-booking.test.ts tests/api/rbac-route-gates.test.ts
git commit -m "feat(sp3): front-desk follow-up booking, unbooking and contact-attempt routes"
```

---

### Task 10: Discharge creates the follow-up order (one transaction)

**Files:**
- Modify: `src/lib/queries/admissions.ts` (`dischargeAdmission`), `src/app/api/inpatient/admissions/[id]/discharge/route.ts`, `src/components/DischargeAdmissionModal.tsx`
- Modify tests:
  - `tests/lib/queries/admissions.test.ts`: pass a session, and delete `follow_up_orders` by `originatingAdmissionId` in cleanup
  - `tests/api/inpatient-admissions-discharge.test.ts`: same cleanup, plus new cases
  - `tests/api/rbac-route-gates.test.ts`: `POST /api/inpatient/admissions/[id]/discharge` in `API_GATES` and `SP3_WRITE_GATES`, allowed `[...DISCHARGE_ROLES]`
- Test: `tests/components/DischargeAdmissionModal.test.tsx` (create)

**Interfaces:**
- Consumes: Task 6 `createFollowUpOrder(…, { executor: tx, today })`; Task 4 `completeAdmissionEncounter` (and a plain `tx.select({ id: encounters.id }).from(encounters).where(eq(encounters.admissionId, admissionId))` for the originating encounter); Task 7 `hasSchedulingConflict(…, tx)`; Task 1 `followUpPlanFieldsSchema`, `istDateOf`, `istSlotString`; Task 3 `DISCHARGE_ROLES`, `notifyFollowUpSafely`.
- Produces:
  - **Inputs:**
    - `DischargeInput` gains `followUpPlan: { timing: FollowUpTiming; windowDaysBefore?: number; windowDaysAfter?: number; reason: string; planNotes: string | null } | null`. The existing `followUp: { startsAt; endsAt } | null` slot is kept.
    - `DischargeResult` gains `followUpOrderId?: number` and an error code `'conflict'`.
  - **`dischargeAdmission(admissionId: number, input: DischargeInput, session: Session): Promise<DischargeResult>`** is now **one transaction**:
    1. Lock the admission `for update` and check its status.
    2. Update the five Ds and the discharge fields, then free the room to `dirty`.
    3. If a slot was given:
       - take the provider advisory lock (same key as Task 7) and run the conflict check with `tx`; a conflict returns `{ ok: false, error: 'conflict' }`, rolling back
       - insert the appointment, keeping `visitReason 'Post-discharge follow-up'`
       - set `followUpAppointmentId`
    4. If a plan **or** a slot was given, call `createFollowUpOrder` with:
       - `source: 'discharge'`, `prescribedByProviderId = attendingProviderId`
       - `originatingAdmissionId`, and `originatingEncounterId` = the admission's encounter id or null
       - `timing` = the plan's timing, or `{ kind: 'date', dueDate: istDateOf(slot.startsAt) }` when there is only a slot
       - `reason` = the plan's reason, or `'Post-discharge follow-up'`
       - `appointmentId` = the new appointment id or null
       - `today = istDateOf(new Date())`
       A `due_date_invalid` result throws, rolling back, and the route maps it to 400.
    5. Run `completeAdmissionEncounter(tx, admissionId, session.name)`.
    6. `logAudit(session, 'discharged patient', patientId, `admission=<id>`, tx)`. The route's own post-hoc `'discharged patient'` audit is removed.
  - **Route:**
    - The gate is `DISCHARGE_ROLES`, and a parse failure gives 400 `Invalid JSON`.
    - The schema gains `followUp: followUpPlanFieldsSchema.optional()`. It is separate from `followUpStartsAt` / `followUpEndsAt`; both may be sent, and a slot then must carry an offset (`offsetDateTimeSchema`).
    - The pre-transaction conflict check is removed; the transaction does it.
    - Error mapping: `conflict` → 409 (existing message); `due_date_invalid` → 400.
    - The response adds `followUpOrderId: number | null`.
    - After the signature step, the route calls `notifyFollowUpSafely` (`planned` or `booked`) when an order was created.
  - **Modal:**
    - Adds a "Follow-up plan" fieldset: a number, a unit select (days/weeks/months) **or** an "on date" input, plus a reason. These are sent as `followUp` only when a reason is entered.
    - The existing date/time slot sends `followUpStartsAt = istSlotString(date, time)` and `followUpEndsAt = istSlotString(date, time + 30 min)`. Add the minutes on the `HH:MM` string, and reject a slot that would cross midnight in the form. It no longer uses the browser-local `new Date(...)`.

- [ ] **Step 1: Write the failing tests**

```ts
// admissions.test.ts (DB, extend 'dischargeAdmission')
it('a plan without a slot creates a planned discharge order linked to the admission', async () => {
  const r = await dischargeAdmission(adm.id, { ...FIVE_DS, followUp: null, followUpPlan: { timing: { kind: 'interval', interval: { value: 1, unit: 'weeks' } }, reason: 'Wound check', planNotes: null } }, SESSION)
  const [o] = await db.select().from(followUpOrders).where(eq(followUpOrders.id, r.followUpOrderId!))
  expect(o).toMatchObject({ source: 'discharge', status: 'planned', originatingAdmissionId: adm.id, prescribedByProviderId: adm.attendingProviderId })
})
it('a slot creates a scheduled order pointing at the follow-up appointment', async () => { /* status 'scheduled', appointmentId === admissions.followUpAppointmentId */ })
it('a slot conflict rolls the whole discharge back', async () => { /* pre-insert overlapping appointment; result { ok: false, error: 'conflict' }; admission still 'admitted'; room still occupied */ })
it('completes the admission encounter', async () => { /* encounter via checkInVisit createAdmission → after discharge status 'completed' */ })
// inpatient-admissions-discharge.test.ts (append)
it('returns followUpOrderId and 400s a past plan date', async () => { /* … */ })
// DischargeAdmissionModal.test.tsx
it('sends followUp only when a reason is entered and builds an IST slot', async () => { /* fetch mock body: followUpStartsAt === '2026-10-21T10:00:00+05:30' */ })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/lib/queries/admissions.test.ts tests/api/inpatient-admissions-discharge.test.ts` and `npx vitest run tests/components/DischargeAdmissionModal.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement.** Update the stale "sequential, not transactional" comment on `dischargeAdmission`: the node-postgres client supports transactions now.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the same commands, then `npm test -- tests/api/rbac-route-gates.test.ts` and `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/queries/admissions.ts src/app/api/inpatient/admissions/[id]/discharge/route.ts src/components/DischargeAdmissionModal.tsx tests/lib/queries/admissions.test.ts tests/api/inpatient-admissions-discharge.test.ts tests/components/DischargeAdmissionModal.test.tsx tests/api/rbac-route-gates.test.ts
git commit -m "feat(sp3): discharge records the follow-up order and closes the IPD encounter in one transaction"
```

---

### Task 11: Discharge-summary data shape (no PDF)

**Files:**
- Create: `src/lib/encounters/discharge-summary.ts` (pure), `src/lib/queries/discharge-summary.ts`
- Test: `tests/lib/encounters/discharge-summary.test.ts`, `tests/lib/queries/discharge-summary.test.ts` (DB)

**Interfaces:**
- Consumes: `brand` (`src/lib/brand.ts`); `formatAbhaNumber`, `stateName`; `ageOnDate`, `istDateOf`; Task 6 `toFollowUpView` / `FollowUpView`; `getLatestSignatureForSignable`.
- Produces:
  - **`DischargeSummaryData`:**
    ```ts
    export interface DischargeSummaryData {
      hospitalName: string
      timezone: 'Asia/Kolkata'
      generatedAt: string                   // ISO instant
      patient: { id: string; uhid: string | null; name: string; ageYears: number; gender: string | null; abhaNumber: string | null; abhaAddress: string | null; address: string | null; isMlc: boolean; mlcNumber: string | null }
      admission: { id: number; admissionType: 'elective' | 'emergency' | 'transfer_in'; admittedOn: string; dischargedOn: string; lengthOfStayDays: number; lastWard: string | null }
      attending: { providerId: number; name: string; registration: string | null; departmentName: string | null }
      clinical: { diagnosis: string; drugs: string; devices: string; diet: string; notes: string }
      followUp: { dueDate: string; windowStart: string; windowEnd: string; reason: string; status: FollowUpStatus; appointmentStartsAt: string | null } | null
      signature: { signerTypedName: string; signedAt: string } | null
    }
    ```
  - **Field rules:**
    - `admittedOn` / `dischargedOn` are IST dates.
    - `lengthOfStayDays` is the IST calendar-day difference, minimum 1.
    - `registration` is `'NMC <number>'` or `'SMC <state> <number>'`, or null.
    - `abhaNumber` is `formatAbhaNumber` output: the full number, since this is a staff clinical document.
    - There is **no Aadhaar field of any kind**.
  - **Functions:**
    - `interface DischargeSummarySource`, the raw inputs (the patient's named columns, the admission row, provider and department, the last transfer ward, the discharge follow-up view, the signature)
    - `buildDischargeSummary(src: DischargeSummarySource, now: Date): DischargeSummaryData` (pure)
    - `getDischargeSummaryData(admissionId: number, now = new Date()): Promise<DischargeSummaryData | null>`. It returns null unless the admission is `discharged`. The follow-up is the order with `originatingAdmissionId = admissionId` and `source = 'discharge'`, newest first. Patients columns are named explicitly.

- [ ] **Step 1: Write the failing tests**

```ts
it('builds the shape with IST dates and length of stay', () => {
  const d = buildDischargeSummary(SRC /* admittedAt 2026-10-01T20:00:00Z (IST 2 Oct), dischargedAt 2026-10-05T05:00:00Z */, NOW)
  expect(d.admission).toMatchObject({ admittedOn: '2026-10-02', dischargedOn: '2026-10-05', lengthOfStayDays: 3 })
  expect(d.attending.registration).toBe('SMC IN-MH 12345'); expect(d.timezone).toBe('Asia/Kolkata')
})
it('has no Aadhaar anywhere in the shape', () => { expect(JSON.stringify(buildDischargeSummary(SRC, NOW))).not.toMatch(/aadhaar/i) })
it('same-day discharge counts as 1 day', () => { /* … */ })
// DB
it('returns null for an admission still admitted and the shape after discharge', async () => { /* … */ })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/encounters/discharge-summary.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** both modules.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/lib/encounters/discharge-summary.test.ts`, `npm test -- tests/lib/queries/discharge-summary.test.ts`, `npx vitest run tests/lib/no-aadhaar-leak.test.ts tests/lib/no-credential-leak.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/encounters/discharge-summary.ts src/lib/queries/discharge-summary.ts tests/lib/encounters/discharge-summary.test.ts tests/lib/queries/discharge-summary.test.ts
git commit -m "feat(sp3): discharge-summary data shape and loader (PDF deferred)"
```

---

### Task 12: Patient page "Visits & follow-up" tab

**Files:**
- Create in `src/components/follow-ups/`:
  - `api.ts`
  - `FollowUpStatusChip.tsx`
  - `FollowUpPanel.tsx`
  - `FollowUpPlanModal.tsx`
  - `BookFollowUpModal.tsx`
  - `ContactAttemptModal.tsx`
  - `ReasonDialog.tsx`
  - `EncounterList.tsx`
- Modify: `src/app/(dashboard)/patients/[anonId]/page.tsx`
- Modify the tests that render this page, adding `vi.doMock` / `vi.mock` for `@/lib/queries/follow-ups` (`listFollowUpsForPatient: async () => []`), `@/lib/queries/encounters` (`listEncountersForPatient: async () => []`), `@/lib/queries/providers` (`listActiveProviders: async () => []`) and `@/lib/queries/departments` (`listDepartments: async () => []`):
  - `tests/pages/patient-detail-inpatient-tab.test.tsx`
  - `tests/pages/patient-detail-profile-tab.test.tsx`
  - `tests/pages/patients-frontdesk-view.test.tsx`
  - `tests/pages/pi-chart-access.test.tsx`
- Test: `tests/components/follow-ups/FollowUpPanel.test.tsx`, `tests/components/follow-ups/BookFollowUpModal.test.tsx`, `tests/pages/patient-detail-follow-up-tab.test.tsx`

**Interfaces:**
- Consumes: Tasks 1, 3, 4 (`listEncountersForPatient`, `EncounterListRow`), 6 (`listFollowUpsForPatient`, `FollowUpView`), and the routes from Tasks 5, 8, 9; `listActiveProviders`, `listDepartments({ activeOnly: true })`.
- Produces:
  - **`api.ts`** (client fetch helpers). Each returns `Promise<{ ok: true; data: T } | { ok: false; error: string }>`, where `error` is the JSON `error` or `'Could not reach the server. Please try again.'`:
    - `createFollowUp(body: CreateFollowUpRequest)`
    - `updateFollowUp(id: number, body: UpdateFollowUpPlanRequest)`
    - `cancelFollowUp(id: number, reason: string)`
    - `bookFollowUpSlot(id: number, body: BookFollowUpRequest)`
    - `unbookFollowUpSlot(id: number, reason: string)`
    - `logContactAttempt(id: number, body: ContactAttemptRequest)`
    - `changeEncounterStatus(id: number, body: { to: …; cancelReason?: string })`
    - `checkInForAppointment(body: { patientId: string; providerId: number; appointmentId: number; reason: string })`, which posts `visitType: 'outpatient'` and `urgency: 'routine'`
  - **`FollowUpPanel`** props: `{ patientId: string; followUps: FollowUpView[]; encounters: EncounterListRow[]; providers: { id: number; name: string }[]; departments: { id: number; name: string }[]; todayIso: string; can: { plan: boolean; book: boolean; checkIn: boolean; startOrComplete: boolean; cancelVisit: boolean }; isPi: boolean }`
    - It renders "Follow-ups" (open first, then closed) and "Visits" (`EncounterList`).
    - Each follow-up row shows: due date with `formatIsoDate`, the window, the status chip, the reason, `planNotes` only when non-null, prescriber, department, the booking with `formatDateTimeIn`, and the last contact.
    - Buttons:
      - `can.plan`: "Set follow-up" and, per row, "Change plan" / "Cancel follow-up"
      - `can.book`: "Book" / "Reschedule" / "Cancel booking" / "Log contact"
      - `can.checkIn`: "Check in" when the booked appointment's IST date equals `todayIso` and its status is scheduled
    - `router.refresh()` runs after each success.
  - **`FollowUpPlanModal`** props: `{ mode: 'create' | 'edit'; patientId: string; initial?: FollowUpView; providers; departments; encounters: EncounterListRow[]; isPi: boolean; onClose(): void }`. The prescriber select is shown only when `!isPi`. There is an optional "From visit" select of the encounters. The timing radio is "in N days/weeks/months" vs "on date".
  - **`BookFollowUpModal`** props: `{ followUp: Pick<FollowUpView, 'id' | 'dueDate' | 'windowStart' | 'windowEnd' | 'prescribedBy' | 'appointment'>; providers; todayIso: string; onClose(): void }`. It is also used by Task 13.
    - The provider defaults to the prescriber.
    - The date defaults to the max of `dueDate` and `todayIso`.
    - The time defaults to 09:00, and the duration select is 10/15/20/30 minutes (default 15).
    - It sends `istSlotString(...)` for start and end.
    - It warns, without blocking, when the date is outside `[windowStart, windowEnd]`.
  - **Page:**
    - Load `listFollowUpsForPatient(anonId, session.role)`, `listEncountersForPatient(anonId)`, `listActiveProviders()` and `listDepartments({ activeOnly: true })` inside the existing `Promise.all`.
    - `todayIso = todayIsoIn()`.
    - Add the tab `{ id: 'follow-up', label: 'Visits & follow-up', content: <FollowUpPanel …/> }` for every viewer of the page, the front desk included, after "Verification".
    - Compute `can` from `FOLLOW_UP_PLAN_ROLES`, `FOLLOW_UP_BOOKING_ROLES`, `CHECK_IN_ROLES`, and `ENCOUNTER_TRANSITION_ROLES.completed` / `.cancelled`.

- [ ] **Step 1: Write the failing tests**

```ts
// FollowUpPanel.test.tsx
it('frontdesk sees reason and booking actions but no plan actions or notes', () => {
  render(<FollowUpPanel {...PROPS} followUps={[{ ...FU, planNotes: null }]} can={{ plan: false, book: true, checkIn: true, startOrComplete: false, cancelVisit: true }} isPi={false} />)
  expect(screen.getByText('BP review')).toBeInTheDocument(); expect(screen.queryByRole('button', { name: /set follow-up|change plan/i })).toBeNull()
  expect(screen.getByRole('button', { name: /book/i })).toBeInTheDocument()
})
it('pi sees plan actions and notes, no booking actions', () => { /* … */ })
it('crc is read-only', () => { /* no buttons in the follow-up section */ })
it('shows Check in only for a booking on today\'s IST date', () => { /* todayIso '2026-10-22', appointment startsAt 2026-10-21T19:00:00Z → button present; startsAt 2026-10-21T10:00:00Z → absent */ })
// BookFollowUpModal.test.tsx
it('defaults to the later of due date and today and sends +05:30 times', async () => { /* fetch spy body startsAt '2026-10-21T09:00:00+05:30', endsAt '2026-10-21T09:15:00+05:30' */ })
it('warns when the chosen date is outside the window', async () => { /* role=alert text /outside the follow-up window/i */ })
// patient-detail-follow-up-tab.test.tsx
it('renders the Visits & follow-up tab for frontdesk with planNotes absent from the rendered page', async () => { /* listFollowUpsForPatient called with ('RD-0001', 'frontdesk') */ })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/components/follow-ups tests/pages/patient-detail-follow-up-tab.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** the components and the page change, and update the four existing page tests' mocks.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/components/follow-ups tests/pages/patient-detail-follow-up-tab.test.tsx tests/pages/patient-detail-inpatient-tab.test.tsx tests/pages/patient-detail-profile-tab.test.tsx tests/pages/patients-frontdesk-view.test.tsx tests/pages/pi-chart-access.test.tsx tests/pages/nav-role-enforcement.test.tsx`, then `npx tsc --noEmit` and `npx eslint src/components/follow-ups "src/app/(dashboard)/patients/[anonId]/page.tsx"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/follow-ups "src/app/(dashboard)/patients/[anonId]/page.tsx" tests/components/follow-ups tests/pages
git commit -m "feat(sp3): Visits & follow-up tab on the patient page with role-scoped actions"
```

---

### Task 13: Recall worklist page + nav entry

**Files:**
- Create: `src/app/(dashboard)/front-desk/follow-ups/page.tsx`, `src/components/follow-ups/FollowUpWorklist.tsx`
- Modify: `src/components/LeftNav.tsx`. Add `{ href: '/front-desk/follow-ups', label: 'Follow-ups', icon: CalendarSync, roles: ['frontdesk', 'admin', 'crc'] as Role[] }` directly after the Assignments item, importing `CalendarSync` from `lucide-react` (`node_modules/lucide-react/dist/esm/icons/calendar-sync.mjs` exists).
- Modify: `tests/pages/page-gates-harness.ts`. Add the row `{ route: '/front-desk/follow-ups', load: () => import('@/app/(dashboard)/front-desk/follow-ups/page'), props: { searchParams: Promise.resolve({}) }, allowed: ['frontdesk', 'admin', 'crc'] }` with a `// LeftNav.tsx` comment.
- Test: `tests/pages/follow-up-worklist.test.tsx`, `tests/components/follow-ups/FollowUpWorklist.test.tsx`

**Interfaces:**
- Consumes: Task 7 (`listFollowUpWorklist`, `parseWorklistParams`, `filterAndSortWorklist`, `countWorklistBuckets`, `WorklistRow`); Task 12 (`BookFollowUpModal`, `ContactAttemptModal`, `ReasonDialog`, `api.ts`); `FOLLOW_UP_WORKLIST_ROLES`, `FOLLOW_UP_BOOKING_ROLES`; `listActiveProviders`, `listDepartments`.
- Produces:
  - **Page** `FollowUpWorklistPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> })`:
    - The first statement is `requireSessionOrRedirect()`, then `if (!FOLLOW_UP_WORKLIST_ROLES.includes(session.role)) redirect('/')`.
    - Then: `parseWorklistParams(await searchParams)` → `listFollowUpWorklist()` → filter by department/provider → `countWorklistBuckets` (on the department/provider-filtered rows) and `filterAndSortWorklist`.
    - Audit `viewed follow-up worklist` (patientId null).
    - Render `<FollowUpWorklist rows counts filters providers departments todayIso canAct={FOLLOW_UP_BOOKING_ROLES.includes(role)} />`.
  - **`FollowUpWorklist` (client):**
    - Bucket tabs are links (`?bucket=…&departmentId=…&providerId=…`) labelled `Due (n)`, `Overdue (n)`, `Upcoming (n)`, `Booked (n)`, `Missed (n)`. Department and doctor `<select>`s navigate with `router.push`.
    - The table columns are: Patient (link to `/patients/[id]`, plus the UHID), Phone (`tel:` link), Due / window, Doctor, Department, Status, Last contact (outcome + `formatDateTimeIn`, attempt count), Actions.
    - Actions (only when `canAct`): "Book" / "Reschedule", "Log contact", "Cancel booking".
    - The empty state is `'No follow-ups in this list.'`.

- [ ] **Step 1: Write the failing tests**

```ts
// follow-up-worklist.test.tsx (page; mock auth/audit/queries)
it('frontdesk sees bucket counts and action buttons', async () => { /* counts text 'Overdue (1)'; Book button present */ })
it('crc sees the list without action buttons', async () => { /* no Book/Log contact */ })
it('passes filters from searchParams', async () => { /* searchParams { bucket: 'overdue', providerId: '7' } → only matching rows rendered */ })
// FollowUpWorklist.test.tsx
it('tab links keep the department and doctor filters', () => { /* href contains departmentId=2&providerId=7 */ })
```

The existing `tests/pages/nav-role-enforcement.test.tsx` must pass unchanged. It checks that the new row admits frontdesk/admin/crc, redirects the others before any DB call, that the nav roles equal the gate, and that every `(dashboard)` page has a row.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/pages/follow-up-worklist.test.tsx tests/components/follow-ups/FollowUpWorklist.test.tsx tests/pages/nav-role-enforcement.test.tsx`
Expected: FAIL (the new tests; nav enforcement fails on the missing page).

- [ ] **Step 3: Implement** the page, the component, the nav item and the harness row.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the same command, then `npx vitest run tests/components/LeftNav.test.tsx` and `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/front-desk/follow-ups" src/components/follow-ups/FollowUpWorklist.tsx src/components/LeftNav.tsx tests/pages/page-gates-harness.ts tests/pages/follow-up-worklist.test.tsx tests/components/follow-ups/FollowUpWorklist.test.tsx
git commit -m "feat(sp3): follow-up recall worklist for front desk with bucket and doctor/department filters"
```

---

### Task 14: Portal "Your follow-up" card

**Files:**
- Create: `src/components/follow-ups/PortalFollowUpCard.tsx` (server-safe, no `'use client'`)
- Modify: `src/app/patient-portal/(authenticated)/page.tsx`
- Modify: `tests/pages/patient-portal-overview.test.tsx`. Add `vi.mock('@/lib/queries/follow-ups', () => ({ getPortalFollowUps: vi.fn(async () => []) }))`.
- Test: `tests/components/follow-ups/PortalFollowUpCard.test.tsx`, plus cases appended to `tests/pages/patient-portal-overview.test.tsx`

**Interfaces:**
- Consumes: Task 6 `getPortalFollowUps`, `PortalFollowUp`; Task 1 `PORTAL_FOLLOW_UP_LABEL`; `formatIsoDate`, `formatDateTimeIn`.
- Produces:
  - **`PortalFollowUpCard({ followUp }: { followUp: PortalFollowUp })`:**
    - The heading is "Your follow-up".
    - Line 1 is `PORTAL_FOLLOW_UP_LABEL[status]`.
    - Line 2:
      - when booked: `` `${formatDateTimeIn(appointmentStartsAt)} with ${doctorName}` ``
      - otherwise: `` `Please visit between ${formatIsoDate(windowStart)} and ${formatIsoDate(windowEnd)}` ``
    - When missed it adds "Please call the hospital to rebook."
    - It never renders a reason or notes. The type has none.
  - **Page:**
    - `const followUps = await getPortalFollowUps(session.patientId)`.
    - Render `<PortalFollowUpCard followUp={followUps[0]} />` inside `data-testid="patient-action-items"` when there is at least one; `hasActionItems` accounts for it.
    - The existing portal overview audit (`viewed patient portal overview`) is unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
it('shows the window when not booked and the IST time when booked', () => {
  render(<PortalFollowUpCard followUp={{ dueDate: '2026-10-21', windowStart: '2026-10-18', windowEnd: '2026-10-28', status: 'planned', appointmentStartsAt: null, doctorName: 'Dr. K' }} />)
  expect(screen.getByText(/Due, please book/)).toBeInTheDocument(); expect(screen.getByText(/18 Oct 2026.*28 Oct 2026/)).toBeInTheDocument()
})
it('card shows no reason or notes', () => {
  const { container } = render(<PortalFollowUpCard followUp={{ ...BOOKED, ...({ reason: 'SECRET', planNotes: 'SECRET' } as object) } as PortalFollowUp} />)
  expect(container.textContent).not.toContain('SECRET')
})
// overview (append)
it('renders Your follow-up among the action items when one is open', async () => { /* mock getPortalFollowUps → [BOOKED]; heading present inside patient-action-items */ })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/components/follow-ups/PortalFollowUpCard.test.tsx tests/pages/patient-portal-overview.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the tests to verify they pass**

Run: the same command, then `npx tsc --noEmit`. Then do a final sweep **of the SP3-touched files only**: `npx vitest run tests/lib/follow-ups tests/lib/encounters tests/components/follow-ups tests/pages tests/lib/no-aadhaar-leak.test.ts tests/lib/no-credential-leak.test.ts`, `npm test -- tests/api/rbac-route-gates.test.ts tests/lib/queries/encounters.test.ts tests/lib/queries/follow-ups.test.ts tests/lib/queries/follow-up-recall.test.ts`, and `npm run build`.
Expected: PASS, and the build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/components/follow-ups/PortalFollowUpCard.tsx "src/app/patient-portal/(authenticated)/page.tsx" tests/components/follow-ups/PortalFollowUpCard.test.tsx tests/pages/patient-portal-overview.test.tsx
git commit -m "feat(sp3): portal 'Your follow-up' card showing date and status only"
```

---

## Execution notes

**Model tier per task:**

| Task | Tier | Local DB needed |
|---|---|---|
| 1 Pure rules / validation / state machine | standard (the date maths and the derive precedence are the contract) | no |
| 2 Schema + migration | standard | **yes** (apply twice; DB schema tests; FK guard) |
| 3 Roles, bullets, notifier | cheap | no |
| 4 Encounter queries (token, check-in tx) | most capable (advisory lock, `for update`, legacy ticket max, IST boundaries) | **yes** |
| 5 Check-in route, status route, lobby board | standard | **yes** (existing check-in and queue-display DB tests, RBAC harness) |
| 6 Follow-up order queries + views | most capable (redaction, base-date recompute, audit discipline) | **yes** |
| 7 Booking, contacts, worklist query | most capable (concurrency, derived buckets) | **yes** |
| 8 Plan routes | standard | harness file only (`npm test -- tests/api/rbac-route-gates.test.ts`) |
| 9 Front-desk routes | standard | harness file only |
| 10 Discharge integration | most capable (rewriting a live flow into one transaction) | **yes** |
| 11 Discharge-summary shape | cheap | loader test only |
| 12 Patient tab UI | standard | no |
| 13 Worklist page + nav | standard | no |
| 14 Portal card | cheap | no |

Order: 1 → 2 → 3, then 4 → 5, then 6 → 7 → 8 → 9, then 10 → 11, then 12 → 13 → 14. Tasks 8/9 and 12/13/14 only touch disjoint files besides the two harness files, so they may run in parallel if the harness edits are serialized.

**Rulings made in this plan:**

1. **How encounters and appointments coexist.**
   - The appointment remains the scheduling record. The calendar, booking requests and telemedicine are untouched.
   - An encounter is created only at check-in, by `checkInVisit`, which is the existing front-desk check-in, and for IPD at inpatient check-in.
   - Existing appointments and admissions are **not backfilled**. `encounters.appointment_id` / `admission_id` are nullable and unique, and `appointments` / `admissions` get no new columns.
   - A follow-up links to its appointment through `follow_up_orders.appointment_id`. Checking in against that appointment closes the follow-up (`completed`, `completed_encounter_id`).
2. **IDs** are `serial` integers, matching `appointments`/`admissions`. Patient FKs stay `text`. Provenance links use `ON DELETE SET NULL`, and contact attempts cascade with their order. This means the existing test cleanups and `deletePatient`, which delete appointments/admissions/assignments, never trip on SP3 rows. Patient FKs stay no-action, and `deletePatient` is extended.
3. **Time zone.**
   - Business dates are Asia/Kolkata `date` values (`istDateOf` / `todayIsoIn`).
   - Instants stay UTC `timestamp`.
   - SP3 APIs require an explicit offset on appointment times, and the UI always sends `+05:30`. The existing calendar `NewEventModal` keeps its server-local behaviour (out of scope; flagged).
   - The OPD token is per IST date: advisory-locked `max + 1`, with a unique `(encounter_date, opd_token)`. It is written into `doctor_assignments.queue_ticket_number`, so the lobby board shows the same number. On deploy day it also exceeds that day's legacy count-based tickets.
4. **"Missed".**
   - It is computed by `deriveFollowUpStatus`, with no cron and no write.
   - A follow-up is missed when the linked appointment is `no_show`, or when today (IST) is past `window_end + 14 days` (`MISSED_GRACE_DAYS`) with no completed visit. For a stale booked appointment the cutoff is `max(appointment IST date, window_end) + 14 days`.
   - The default window is due −3 / +7 days. Overdue means past `window_end` but not yet missed.
   - The enum keeps a stored `missed` value for SP5's notifier/cron; SP3 never writes it.
5. **Who does what.**
   - pi and admin set, change and cancel the clinical plan. A pi always prescribes as their linked provider. Admin names the prescriber, and any pi may edit any plan (cross-cover), with an audit trail.
   - frontdesk and admin book, reschedule, unbook and log contact attempts.
   - crc views. pi does not book.
   - frontdesk sees `reason` (≤140 chars, also the appointment's visit reason) but never `planNotes`. The portal sees neither.
6. **Plan changes never move a booking.** The API reports `bookingOutsideWindow`, and the UI warns. An appointment cancelled or no-showed from the calendar is picked up by the derived status, so no calendar route changes.
7. **A check-in against a booked appointment** creates the doctor assignment already `scheduled` (no second appointment from the doctor's queue). The lobby board shows it as "waiting" while the encounter is `checked_in`.
8. **Discharge** now runs in one transaction. The node-postgres driver supports it, and the old comment predates it. A plan-only discharge creates a `planned` order. A slot creates a `scheduled` one. Both are `source 'discharge'`, and the IPD encounter is completed.
9. **Notifier.** `FollowUpNotifier` has one log-only implementation. It writes an ids-only line and an audit row saying "not delivered", runs after commit, and never fails the request. SP5 swaps the implementation.
10. **Lab placeholder.** `originating_lab_order_id` and the `lab_report` source value exist for SP5. Nothing in SP3 writes them. The encounter type `lab` is reserved as well.
11. **No seed data** for follow-ups or encounters. The tests create their own `TEST-SP3-` fixtures.

**Ambiguities flagged for the owner:**
- **pi on the recall worklist.** Doctors are left out of the recall worklist page and nav (owner said front desk/crc). They see follow-ups on the patient page. A "my patients' follow-ups" view for doctors is easy to add later.
- **Unbook reason storage.** The front desk's unbook reason is stored in `appointments.notes`, not in a dedicated column or the audit log, because the audit log carries no free text.
- **Portal detail level.** The portal shows the booked time and the doctor's name. If "date/status only" is meant literally, drop `doctorName` from `PortalFollowUp`.
- **Pre-existing hazards left as-is.**
  - A room claimed at inpatient check-in is not released if the later transaction throws.
  - `POST /api/appointments` (calendar) is not serialized against follow-up bookings by the provider advisory lock, so a calendar booking racing a follow-up booking can still double-book.
  - The calendar's `NewEventModal` sends zone-less times.
