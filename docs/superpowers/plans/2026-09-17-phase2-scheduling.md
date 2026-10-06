# Phase 2: Scheduling & Calendar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Clinsync a real Calendar subsystem — Day/Week/Month views with a mini-calendar and provider-filter sidebar, a New Event modal, and a Home Dashboard "Upcoming Appointments" widget — so a CRC can schedule and track a referred patient's visit against a real provider roster, adapted from Tebra's Scheduling module to what a trial pre-screening pilot actually needs (no billing codes, no telehealth links, no waiting-room check-in flow).

**Architecture:** Same stack and security patterns as the existing prototype and as Phase 1 (Next.js App Router Server Components + shared query functions, Drizzle/Neon, Upstash cache, `requireSession`/`requireSessionOrRedirect`, Zod-validated writes, audit logging). Two new tables — `providers` (a real, independently-seeded roster; see the Design Decision section below) and `appointments` (tying a `patientId` from the existing `patients` table to a `providerId`) — extend the existing schema. The Calendar page lives at `/calendar` inside the existing `(dashboard)` route group and is driven entirely by URL search params (`view`, `date`, `providerIds`) so Day/Week/Month navigation, "Today", and the mini-calendar are all plain server-rendered links; only the provider checklist, the New Event modal, and the inline appointment-status control need client-side interactivity. This plan assumes Phase 1 (`docs/superpowers/plans/2026-09-17-intake-chart-workflow.md`) is complete: `src/app/(dashboard)/page.tsx` (Home Dashboard), `formTemplates`/`formSubmissions`/`appSettings` tables, and `LeftNav.tsx`'s Form Templates/Client Forms entries already exist.

**Tech Stack:** Next.js 16 (App Router, TypeScript), Drizzle ORM + Neon Postgres, Upstash Redis, Tailwind v4 + shadcn/ui, Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-17-full-platform-phases-design.md` (§4 schema ownership, §5 nav position, §3/§6 shared exclusions), `docs/superpowers/specs/2026-09-17-tebra-intakeq-screenshot-catalog.md` ("Scheduling" section under Tebra).

## Global Constraints

- Every API route calls `requireSession()` and returns its `NextResponse` result unchanged on failure (see `src/lib/auth.ts`, `src/app/api/trials/[trialId]/criteria/route.ts` for the exact pattern).
- Every Server Component page calls `requireSessionOrRedirect()` as its **first statement**, before any data fetch (see the comment in `src/app/(dashboard)/patients/page.tsx` — a prior review proved that relying on the layout's redirect alone leaks PHI into the response body on an unauthenticated request).
- Server Components call shared query functions in `src/lib/queries/*.ts` directly. **Never** `fetch()` the app's own API route from a Server Component (a prior real vulnerability: session-cookie exfiltration via a forged `Host` header).
- Every write validates its request body with a `.strict()` Zod schema (see `criteriaUpdateSchema` in `src/app/api/trials/[trialId]/criteria/route.ts`).
- Every write that changes patient-relevant state calls `logAudit(session, action, patientId)` (`src/lib/audit.ts`) — `session` must be the real, non-null session, never a fallback role.
- Zero decorative icons anywhere. Status/severity is always a colored dot (`<span className="h-2 w-2 rounded-full ...">`, `aria-hidden="true"`) plus a text label — see `src/components/StatusChip.tsx`.
- Design tokens only: `bg-primary`, `bg-accent`, `text-accent-foreground`, `bg-card`, `border-border`, `bg-muted`, `text-muted-foreground`, `bg-secondary`, `bg-chart-1`…`bg-chart-5` from `src/app/globals.css`. Never a hardcoded Tailwind color class (`bg-slate-*`, `text-green-700`, etc.).
- Section/column headers use the established convention: `text-xs font-semibold uppercase tracking-wide text-muted-foreground`.
- Zebra striping on every list/table: `i % 2 === 1 ? 'bg-muted/40' : ''`.
- At most one coral (`bg-accent`) primary-action button per screen (an exception already exists and is accepted: Identity Matching shows one per pending row; the Calendar page's own single `bg-accent` button is "New Event").
- No glassmorphism, gradient/shiny buttons, bento grids, or floating/breathing animations — subtle hover/transition-colors utilities only, consistent with what's already in the codebase.
- Empty states are plain, factual text in the interface's voice, never an illustration. For appointment lists specifically, use the catalog's own documented wording, **"No appointments to show."** (Tebra's Scheduling Dashboard/Calendar empty state); use "No records found." for any other empty list this plan touches.
- No enterprise-scale over-engineering: no virtualized rendering, no drag-to-resize/drag-to-reschedule events, no timezone handling beyond native `Date` (matches the project's existing date handling elsewhere), no recurring-appointment support. Clinsync has dozens of patients and a handful of providers, not hundreds of thousands.
- `npm test` and `npm run build` must be clean after every task. Nothing in this plan is pushed to git or deployed until the whole plan's Final QA pass (Task 8) is green — test locally throughout.

---

## Design Decision: `providers` is seeded independently, not backfilled from `patients.currentProvider`

**Decision: `providers` is a new, independently-seeded roster — it is not derived from the existing `patients.currentProvider` free-text values.**

**Reasoning:** Reading the current seed data (`src/db/seed.ts`) shows `currentProvider` has almost no diversity to backfill from: every hero and filler patient is seeded with `currentProvider: 'Dr. R. Kunam'`, with a single exception (`RD-0003`, whose value is the literal placeholder string `'Unmatched'`, meaning "no Tebra chart matched yet" — not a real provider name at all). Backfilling `providers` from `DISTINCT currentProvider` would therefore produce a one-row table (plus a garbage `'Unmatched'` row if not filtered out), which cannot demonstrate the provider-filter checklist ("Check All" against a real multi-provider list) or the mini-calendar/provider color-coding pattern the Tebra catalog documents — the exact features this phase exists to build. Structurally, `providers` also needs fields `currentProvider` never carried (`credentials`, `specialty`, a `colorTag` for calendar color-coding) that free text can't supply. Seeding `providers` independently with a small, realistic roster (5 providers spanning the specialties a psychiatric trial site's schedule actually needs) gives the Calendar page real data to filter and color-code from day one. `patients.currentProvider` is left untouched by this phase — it remains the informal, dual-sourced (Tebra-derived) field it already is, and nothing in this plan writes to it. A later phase (Phase 6, which owns the Provider Profiles management UI per the cross-phase spec) can decide whether to reconcile the two if that becomes valuable.

---

### Task 1: Schema + seed data

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/seed.ts`
- Modify: `tests/db/schema.test.ts`
- Modify: `tests/db/seed.test.ts`

**Interfaces:**
- Produces: `appointmentStatusEnum`, `providers`, `appointments` tables, all exported from `src/db/schema.ts`, consumed by every later task.

- [ ] **Step 1: Add the new tables to the schema**

Open `src/db/schema.ts` and add, after the existing `users` table (at the end of the file):

```typescript
export const appointmentStatusEnum = pgEnum('appointment_status', ['scheduled', 'completed', 'cancelled', 'no_show'])

// A real, structured provider roster for scheduling. Deliberately NOT
// backfilled from `patients.currentProvider` — see the Design Decision
// section in this phase's plan (docs/superpowers/plans/2026-09-17-phase2-scheduling.md)
// for the reasoning: that free-text field has almost no diversity to backfill
// from and lacks the structured fields (credentials, specialty, calendar
// color) a real scheduling feature needs. `colorTag` is always one of the
// design system's grayscale chart tokens ('chart-1'..'chart-5', defined in
// src/app/globals.css) — enforced at the application layer (see the seed
// roster and PROVIDER_DOT_CLASSNAME map in later tasks), not as a DB enum,
// since it's a display concern rather than a domain invariant.
export const providers = pgTable('providers', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  credentials: text('credentials'),
  specialty: text('specialty').notNull(),
  colorTag: text('color_tag').notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export const appointments = pgTable('appointments', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  providerId: integer('provider_id').notNull().references(() => providers.id),
  startsAt: timestamp('starts_at').notNull(),
  endsAt: timestamp('ends_at').notNull(),
  visitReason: text('visit_reason').notNull(),
  status: appointmentStatusEnum('status').default('scheduled').notNull(),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})
```

- [ ] **Step 2: Push the schema**

Run: `npm run db:push` (applies the 2 new tables + 1 new enum to the linked Neon database; confirm it reports success with no errors).

- [ ] **Step 3: Extend `clearExistingData()` in `src/db/seed.ts`**

Open `src/db/seed.ts`. Add `providers` and `appointments` to the import from `./schema`:

```typescript
import {
  trials,
  patients,
  diagnoses,
  medicationEpisodes,
  patientTrialScreenings,
  screeningCriteriaResults,
  identityMatches,
  providers,
  appointments,
  users,
} from './schema'
```

In `clearExistingData()`, add a delete for `appointments` **before** the existing `await db.delete(patients)` line (appointments references both `patients` and `providers`, so it must be deleted first — FK-safe order is children before parents), and add a delete for `providers` anywhere after that:

```typescript
async function clearExistingData() {
  const db = getDb()
  // Delete in FK-safe order (children before parents) so seed() is safely re-runnable
  // against the live database without unique-constraint violations.
  await db.delete(screeningCriteriaResults)
  await db.delete(patientTrialScreenings)
  await db.delete(medicationEpisodes)
  await db.delete(diagnoses)
  await db.delete(identityMatches)
  await db.delete(appointments)
  await db.delete(patients)
  await db.delete(providers)
  await db.delete(users)
  await db.delete(trials)
}
```

(If Phase 1 has already added its own tables' deletes to this function — e.g. `formSubmissions` — leave those exactly as they are; only insert the two lines above in FK-safe position relative to the tables they reference.)

- [ ] **Step 4: Seed the provider roster and appointments**

Add, near the top of `src/db/seed.ts` (alongside `MDD_TRIAL`/`ADHD_TRIAL`):

```typescript
// Independent provider roster — see the Design Decision section in this
// phase's plan for why this is not backfilled from patients.currentProvider.
// colorTag cycles through the design system's grayscale chart tokens so the
// calendar can color-code providers without ever using a hardcoded color.
const PROVIDER_ROSTER = [
  { name: 'Dr. Rajiv Kunam', credentials: 'MD', specialty: 'Psychiatry', colorTag: 'chart-1' },
  { name: 'Dr. Elena Bosch', credentials: 'MD', specialty: 'Psychiatry', colorTag: 'chart-2' },
  { name: 'Priya Sundaram', credentials: 'PMHNP', specialty: 'Psychiatric Nurse Practitioner', colorTag: 'chart-3' },
  { name: 'Dr. Michael Farr', credentials: 'DO', specialty: 'Psychiatry', colorTag: 'chart-4' },
  { name: 'Dana Whitfield', credentials: 'PMHNP', specialty: 'Psychiatric Nurse Practitioner', colorTag: 'chart-5' },
]
```

Add a new function, placed after `seedFillerPatients()`:

```typescript
async function seedProvidersAndAppointments() {
  const db = getDb()
  const insertedProviders = await db.insert(providers).values(PROVIDER_ROSTER).returning()
  const [kunam, bosch, sundaram, farr, whitfield] = insertedProviders

  // Appointments spread across past (completed/no-show/cancelled), today
  // (2026-09-17), and upcoming dates so Day/Week/Month views and the Home
  // Dashboard's Upcoming Appointments widget all have real demo data.
  await db.insert(appointments).values([
    { patientId: 'RD-0001', providerId: kunam.id, startsAt: new Date('2026-09-10T09:00:00'), endsAt: new Date('2026-09-10T09:30:00'), visitReason: 'Pre-screening follow-up', status: 'completed' },
    { patientId: 'RD-0006', providerId: kunam.id, startsAt: new Date('2026-09-12T14:00:00'), endsAt: new Date('2026-09-12T14:30:00'), visitReason: 'Medication review', status: 'no_show' },
    { patientId: 'RD-0005', providerId: whitfield.id, startsAt: new Date('2026-09-16T11:00:00'), endsAt: new Date('2026-09-16T11:30:00'), visitReason: 'Intake consult', status: 'cancelled' },
    { patientId: 'RD-0002', providerId: bosch.id, startsAt: new Date('2026-09-17T09:00:00'), endsAt: new Date('2026-09-17T09:30:00'), visitReason: 'PHQ-9 rescreen', status: 'scheduled' },
    { patientId: 'RD-0004', providerId: sundaram.id, startsAt: new Date('2026-09-17T10:30:00'), endsAt: new Date('2026-09-17T11:00:00'), visitReason: 'ASRS follow-up', status: 'scheduled' },
    { patientId: 'RD-0003', providerId: farr.id, startsAt: new Date('2026-09-18T13:00:00'), endsAt: new Date('2026-09-18T13:30:00'), visitReason: 'Identity verification appointment', status: 'scheduled' },
    { patientId: 'RD-0007', providerId: kunam.id, startsAt: new Date('2026-09-19T09:00:00'), endsAt: new Date('2026-09-19T09:30:00'), visitReason: 'New patient intake', status: 'scheduled' },
    { patientId: 'RD-0008', providerId: bosch.id, startsAt: new Date('2026-09-22T15:00:00'), endsAt: new Date('2026-09-22T15:30:00'), visitReason: 'Screening visit', status: 'scheduled' },
    { patientId: 'RD-0009', providerId: whitfield.id, startsAt: new Date('2026-09-24T10:00:00'), endsAt: new Date('2026-09-24T10:30:00'), visitReason: 'Consent review', status: 'scheduled' },
    { patientId: 'RD-0010', providerId: sundaram.id, startsAt: new Date('2026-09-25T09:30:00'), endsAt: new Date('2026-09-25T10:00:00'), visitReason: 'Baseline rating scale', status: 'scheduled' },
    { patientId: 'RD-0011', providerId: farr.id, startsAt: new Date('2026-09-29T13:30:00'), endsAt: new Date('2026-09-29T14:00:00'), visitReason: 'Follow-up visit', status: 'scheduled' },
    { patientId: 'RD-0012', providerId: kunam.id, startsAt: new Date('2026-09-30T11:00:00'), endsAt: new Date('2026-09-30T11:30:00'), visitReason: 'Randomization visit', status: 'scheduled' },
  ])
}
```

In the `seed()` function, add a call to it right after the existing `await seedFillerPatients()` line:

```typescript
  await seedFillerPatients()
  await seedProvidersAndAppointments()
```

(Patient IDs `RD-0001` through `RD-0012` are all created earlier in this same file, by `HERO_PATIENTS` and `seedFillerPatients()` — confirmed by reading the file above; no adjustment needed.)

- [ ] **Step 5: Re-seed and verify**

Run: `npm run db:seed`. Then run: `npx dotenv -e .env.local -- tsx -e "import { getDb } from './src/db/client'; import { providers, appointments } from './src/db/schema'; getDb().select().from(providers).then(r => console.log('providers:', r.length)); getDb().select().from(appointments).then(r => console.log('appointments:', r.length))"` and confirm `providers: 5` and `appointments: 12`.

- [ ] **Step 6: Extend tests**

In `tests/db/schema.test.ts`, add to the existing `it('exports all required tables', ...)` block:

```typescript
    expect(schema.providers).toBeDefined()
    expect(schema.appointments).toBeDefined()
```

In `tests/db/seed.test.ts`, add `providers, appointments` to the existing import from `@/db/schema`, and add two new test cases inside the `describe('seed', ...)` block:

```typescript
  it('creates the independent provider roster (not backfilled from currentProvider)', async () => {
    const rows = await getDb().select().from(providers)
    expect(rows.length).toBe(5)
    expect(new Set(rows.map((r) => r.colorTag)).size).toBe(5)
  })

  it('creates appointments spanning multiple statuses', async () => {
    const rows = await getDb().select().from(appointments)
    expect(rows.length).toBeGreaterThanOrEqual(10)
    const statuses = new Set(rows.map((r) => r.status))
    expect(statuses.has('scheduled')).toBe(true)
    expect(statuses.has('completed')).toBe(true)
    expect(statuses.has('cancelled')).toBe(true)
    expect(statuses.has('no_show')).toBe(true)
  })
```

- [ ] **Step 7: Run the suite and commit**

Run: `npm test` and `npm run build` — both must be clean.

```bash
git add src/db/schema.ts src/db/seed.ts tests/db/schema.test.ts tests/db/seed.test.ts
git commit -m "feat: add providers and appointments tables with an independently-seeded provider roster

"```

---

### Task 2: Shared query functions + calendar date helpers

**Files:**
- Create: `src/lib/calendar-dates.ts`
- Create: `src/lib/queries/providers.ts`
- Create: `src/lib/queries/appointments.ts`
- Modify: `src/lib/cache.ts`
- Test: `tests/lib/calendar-dates.test.ts`
- Test: `tests/lib/queries/providers.test.ts`
- Test: `tests/lib/queries/appointments.test.ts`

**Interfaces:**
- Consumes: `providers`, `appointments` tables (Task 1).
- Produces: `type CalendarView`, `parseDateParam`, `formatDateParam`, `startOfDay`, `endOfDay`, `addDays`, `startOfWeek`, `startOfMonth`, `getViewRange`, `getWeekDays`, `getMonthGridDays`, `isSameDay` (all from `src/lib/calendar-dates.ts`); `type AppointmentStatus`, `type AppointmentWithDetails`, `listAppointmentsInRange(start, end, providerIds?)`, `listUpcomingAppointments(limit)`, `getAppointment(id)` (from `src/lib/queries/appointments.ts`); `listActiveProviders()` (from `src/lib/queries/providers.ts`) — all consumed directly by Server Component pages and API routes in Tasks 3, 4, 6, 7 (never via `fetch()`).

- [ ] **Step 1: `src/lib/calendar-dates.ts` — pure date-range helpers**

```typescript
export type CalendarView = 'day' | 'week' | 'month'

export function startOfDay(date: Date): Date {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}

export function endOfDay(date: Date): Date {
  const d = new Date(date)
  d.setHours(23, 59, 59, 999)
  return d
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

// Sunday-start week, matching Tebra's Day/Week/Month calendar convention.
export function startOfWeek(date: Date): Date {
  const d = startOfDay(date)
  d.setDate(d.getDate() - d.getDay())
  return d
}

export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

export function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

export function parseDateParam(param: string | undefined): Date {
  if (!param) return startOfDay(new Date())
  const parsed = new Date(`${param}T00:00:00`)
  return isNaN(parsed.getTime()) ? startOfDay(new Date()) : parsed
}

export function formatDateParam(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function getWeekDays(anchor: Date): Date[] {
  const start = startOfWeek(anchor)
  return Array.from({ length: 7 }, (_, i) => addDays(start, i))
}

// A fixed 6-week (42-day) grid, matching the standard month-calendar layout —
// includes the leading/trailing days from adjacent months so those days'
// appointments (if any) still render, grayed out, at the grid's edges.
export function getMonthGridDays(anchor: Date): Date[] {
  const gridStart = startOfWeek(startOfMonth(anchor))
  return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i))
}

export function getViewRange(view: CalendarView, anchor: Date): { start: Date; end: Date } {
  if (view === 'day') return { start: startOfDay(anchor), end: endOfDay(anchor) }
  if (view === 'week') {
    const start = startOfWeek(anchor)
    return { start, end: endOfDay(addDays(start, 6)) }
  }
  const gridStart = startOfWeek(startOfMonth(anchor))
  return { start: gridStart, end: endOfDay(addDays(gridStart, 41)) }
}
```

- [ ] **Step 2: `src/lib/cache.ts` — add a cache key for the provider list**

Add alongside the existing key helpers:

```typescript
export function providersListCacheKey(): string {
  return 'providers:list'
}
```

- [ ] **Step 3: `src/lib/queries/providers.ts`**

```typescript
import { getDb } from '@/db/client'
import { providers } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { getOrSetCache, providersListCacheKey } from '@/lib/cache'

export async function listActiveProviders() {
  return getOrSetCache(providersListCacheKey(), 60, async () => {
    return getDb().select().from(providers).where(eq(providers.isActive, true))
  })
}
```

- [ ] **Step 4: `src/lib/queries/appointments.ts`**

```typescript
import { getDb } from '@/db/client'
import { appointments, patients, providers } from '@/db/schema'
import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm'

export type AppointmentStatus = 'scheduled' | 'completed' | 'cancelled' | 'no_show'

export interface AppointmentWithDetails {
  id: number
  patientId: string
  patientName: string
  providerId: number
  providerName: string
  providerColorTag: string
  startsAt: Date
  endsAt: Date
  visitReason: string
  status: AppointmentStatus
  notes: string | null
}

function mapAppointmentRow(r: { appointment: typeof appointments.$inferSelect; patient: typeof patients.$inferSelect; provider: typeof providers.$inferSelect }): AppointmentWithDetails {
  return {
    id: r.appointment.id,
    patientId: r.appointment.patientId,
    patientName: r.patient.nameTebra ?? r.patient.nameIntakeq,
    providerId: r.appointment.providerId,
    providerName: r.provider.name,
    providerColorTag: r.provider.colorTag,
    startsAt: r.appointment.startsAt,
    endsAt: r.appointment.endsAt,
    visitReason: r.appointment.visitReason,
    status: r.appointment.status,
    notes: r.appointment.notes,
  }
}

/**
 * `providerIds === undefined` means "no provider filter" (all providers).
 * `providerIds === []` means the caller explicitly deselected every
 * provider (the calendar's "Uncheck All") — that must return zero
 * appointments, not fall back to "no filter", so it's short-circuited
 * before the query is built.
 */
export async function listAppointmentsInRange(start: Date, end: Date, providerIds?: number[]): Promise<AppointmentWithDetails[]> {
  if (providerIds && providerIds.length === 0) return []

  const conditions = [gte(appointments.startsAt, start), lte(appointments.startsAt, end)]
  if (providerIds && providerIds.length > 0) conditions.push(inArray(appointments.providerId, providerIds))

  const rows = await getDb()
    .select({ appointment: appointments, patient: patients, provider: providers })
    .from(appointments)
    .innerJoin(patients, eq(appointments.patientId, patients.id))
    .innerJoin(providers, eq(appointments.providerId, providers.id))
    .where(and(...conditions))
    .orderBy(asc(appointments.startsAt))

  return rows.map(mapAppointmentRow)
}

export async function listUpcomingAppointments(limit: number): Promise<AppointmentWithDetails[]> {
  const rows = await getDb()
    .select({ appointment: appointments, patient: patients, provider: providers })
    .from(appointments)
    .innerJoin(patients, eq(appointments.patientId, patients.id))
    .innerJoin(providers, eq(appointments.providerId, providers.id))
    .where(and(gte(appointments.startsAt, new Date()), eq(appointments.status, 'scheduled')))
    .orderBy(asc(appointments.startsAt))
    .limit(limit)

  return rows.map(mapAppointmentRow)
}

export async function getAppointment(id: number): Promise<AppointmentWithDetails | null> {
  const [row] = await getDb()
    .select({ appointment: appointments, patient: patients, provider: providers })
    .from(appointments)
    .innerJoin(patients, eq(appointments.patientId, patients.id))
    .innerJoin(providers, eq(appointments.providerId, providers.id))
    .where(eq(appointments.id, id))
  return row ? mapAppointmentRow(row) : null
}
```

- [ ] **Step 5: Tests**

`tests/lib/calendar-dates.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { addDays, formatDateParam, getMonthGridDays, getViewRange, getWeekDays, isSameDay, parseDateParam, startOfWeek } from '@/lib/calendar-dates'

describe('calendar-dates', () => {
  it('parseDateParam parses a YYYY-MM-DD string as local midnight', () => {
    const d = parseDateParam('2026-09-17')
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(8) // 0-indexed: September
    expect(d.getDate()).toBe(17)
    expect(d.getHours()).toBe(0)
  })

  it('parseDateParam falls back to today for an invalid or missing value', () => {
    const d = parseDateParam(undefined)
    expect(isSameDay(d, new Date())).toBe(true)
  })

  it('formatDateParam round-trips with parseDateParam', () => {
    const original = parseDateParam('2026-09-17')
    expect(formatDateParam(original)).toBe('2026-09-17')
  })

  it('startOfWeek returns the preceding (or same) Sunday', () => {
    const thursday = parseDateParam('2026-09-17') // a Thursday
    const sunday = startOfWeek(thursday)
    expect(sunday.getDay()).toBe(0)
    expect(formatDateParam(sunday)).toBe('2026-09-13')
  })

  it('getWeekDays returns exactly 7 consecutive days starting on Sunday', () => {
    const days = getWeekDays(parseDateParam('2026-09-17'))
    expect(days.length).toBe(7)
    expect(days[0].getDay()).toBe(0)
    expect(formatDateParam(days[6])).toBe(formatDateParam(addDays(days[0], 6)))
  })

  it('getMonthGridDays returns a fixed 42-day grid starting on a Sunday', () => {
    const days = getMonthGridDays(parseDateParam('2026-09-17'))
    expect(days.length).toBe(42)
    expect(days[0].getDay()).toBe(0)
  })

  it('getViewRange for "day" spans exactly one calendar day', () => {
    const { start, end } = getViewRange('day', parseDateParam('2026-09-17'))
    expect(isSameDay(start, end)).toBe(true)
    expect(start.getHours()).toBe(0)
    expect(end.getHours()).toBe(23)
  })

  it('getViewRange for "week" spans Sunday through Saturday', () => {
    const { start, end } = getViewRange('week', parseDateParam('2026-09-17'))
    expect(start.getDay()).toBe(0)
    expect(end.getDay()).toBe(6)
  })
})
```

`tests/lib/queries/providers.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { listActiveProviders } from '@/lib/queries/providers'

describe('listActiveProviders', () => {
  it('returns the seeded provider roster', async () => {
    const providers = await listActiveProviders()
    expect(providers.length).toBe(5)
    expect(providers.every((p) => p.isActive)).toBe(true)
  })
})
```

`tests/lib/queries/appointments.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { listAppointmentsInRange, listUpcomingAppointments } from '@/lib/queries/appointments'
import { listActiveProviders } from '@/lib/queries/providers'

describe('listAppointmentsInRange', () => {
  it('returns appointments within the given range, joined with patient and provider details', async () => {
    const results = await listAppointmentsInRange(new Date('2026-09-01T00:00:00'), new Date('2026-09-30T23:59:59'))
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]).toHaveProperty('patientName')
    expect(results[0]).toHaveProperty('providerName')
    expect(results[0]).toHaveProperty('providerColorTag')
  })

  it('filters to only the given provider IDs when provided', async () => {
    const providers = await listActiveProviders()
    const oneProvider = [providers[0].id]
    const results = await listAppointmentsInRange(new Date('2026-09-01T00:00:00'), new Date('2026-09-30T23:59:59'), oneProvider)
    expect(results.every((r) => r.providerId === oneProvider[0])).toBe(true)
  })

  it('returns zero results for an explicitly empty provider filter (Uncheck All)', async () => {
    const results = await listAppointmentsInRange(new Date('2026-09-01T00:00:00'), new Date('2026-09-30T23:59:59'), [])
    expect(results).toEqual([])
  })
})

describe('listUpcomingAppointments', () => {
  it('returns only scheduled, future appointments, ordered soonest-first', async () => {
    const results = await listUpcomingAppointments(5)
    expect(results.every((r) => r.status === 'scheduled')).toBe(true)
    for (let i = 1; i < results.length; i++) {
      expect(results[i].startsAt.getTime()).toBeGreaterThanOrEqual(results[i - 1].startsAt.getTime())
    }
  })
})
```

- [ ] **Step 6: Run the suite and commit**

Run: `npm test` and `npm run build` — both must be clean.

```bash
git add src/lib/calendar-dates.ts src/lib/queries/providers.ts src/lib/queries/appointments.ts src/lib/cache.ts tests/lib/calendar-dates.test.ts tests/lib/queries/providers.test.ts tests/lib/queries/appointments.test.ts
git commit -m "feat: add calendar date helpers and shared query functions for providers and appointments

"```

---

### Task 3: Appointments API routes

**Files:**
- Create: `src/app/api/appointments/route.ts` (GET list by date range, POST create = "New Event")
- Create: `src/app/api/appointments/[id]/route.ts` (PUT to update status/details)
- Test: `tests/api/appointments.test.ts`

**Interfaces:**
- Consumes: `listAppointmentsInRange`, `getAppointment` (Task 2).
- Produces: `POST /api/appointments` (used by `NewEventModal` in Task 5); `PUT /api/appointments/[id]` (used by `AppointmentStatusSelect` in Task 4).

- [ ] **Step 1: `src/app/api/appointments/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDb } from '@/db/client'
import { appointments } from '@/db/schema'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listAppointmentsInRange } from '@/lib/queries/appointments'

const createAppointmentSchema = z.object({
  patientId: z.string().min(1),
  providerId: z.number().int().positive(),
  startsAt: z.string().min(1),
  endsAt: z.string().min(1),
  visitReason: z.string().min(1),
  status: z.enum(['scheduled', 'completed', 'cancelled', 'no_show']).optional(),
}).strict()

export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session

  const url = new URL(request.url)
  const from = url.searchParams.get('from')
  const to = url.searchParams.get('to')
  if (!from || !to) return NextResponse.json({ error: 'from and to query parameters are required' }, { status: 400 })

  const providerIdsParam = url.searchParams.get('providerIds')
  const providerIds = providerIdsParam !== null
    ? (providerIdsParam === '' ? [] : providerIdsParam.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0))
    : undefined

  const results = await listAppointmentsInRange(new Date(from), new Date(to), providerIds)
  return NextResponse.json(results)
}

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session

  const parsed = createAppointmentSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid appointment payload', details: parsed.error.flatten() }, { status: 400 })

  const startsAt = new Date(parsed.data.startsAt)
  const endsAt = new Date(parsed.data.endsAt)
  if (isNaN(startsAt.getTime()) || isNaN(endsAt.getTime()) || endsAt <= startsAt) {
    return NextResponse.json({ error: 'endsAt must be a valid time after startsAt' }, { status: 400 })
  }

  const [created] = await getDb().insert(appointments).values({
    patientId: parsed.data.patientId,
    providerId: parsed.data.providerId,
    startsAt,
    endsAt,
    visitReason: parsed.data.visitReason,
    status: parsed.data.status ?? 'scheduled',
  }).returning()

  await logAudit(session, 'scheduled appointment', parsed.data.patientId)
  return NextResponse.json(created, { status: 201 })
}
```

- [ ] **Step 2: `src/app/api/appointments/[id]/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDb } from '@/db/client'
import { appointments } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getAppointment } from '@/lib/queries/appointments'

const updateAppointmentSchema = z.object({
  status: z.enum(['scheduled', 'completed', 'cancelled', 'no_show']).optional(),
  visitReason: z.string().min(1).optional(),
  startsAt: z.string().min(1).optional(),
  endsAt: z.string().min(1).optional(),
  notes: z.string().optional(),
}).strict()

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  const { id } = await params

  const parsed = updateAppointmentSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid appointment update', details: parsed.error.flatten() }, { status: 400 })

  const existing = await getAppointment(Number(id))
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const patch: Record<string, unknown> = { ...parsed.data }
  if (parsed.data.startsAt) patch.startsAt = new Date(parsed.data.startsAt)
  if (parsed.data.endsAt) patch.endsAt = new Date(parsed.data.endsAt)

  await getDb().update(appointments).set(patch).where(eq(appointments.id, Number(id)))

  const action = parsed.data.status ? `marked appointment ${id} as ${parsed.data.status}` : `updated appointment ${id}`
  await logAudit(session, action, existing.patientId)

  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 3: Test**

`tests/api/appointments.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { GET, POST } from '@/app/api/appointments/route'
import { PUT } from '@/app/api/appointments/[id]/route'
import { listActiveProviders } from '@/lib/queries/providers'

vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: 'crc', name: 'Jamie Ruiz' })) }))

describe('GET /api/appointments', () => {
  it('requires from and to query parameters', async () => {
    const req = new Request('http://localhost/api/appointments')
    const res = await GET(req as never)
    expect(res.status).toBe(400)
  })

  it('returns appointments within the given range', async () => {
    const req = new Request('http://localhost/api/appointments?from=2026-09-01&to=2026-09-30')
    const res = await GET(req as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.length).toBeGreaterThan(0)
  })
})

describe('POST /api/appointments', () => {
  it('rejects a payload missing required fields', async () => {
    const req = new Request('http://localhost/api/appointments', { method: 'POST', body: JSON.stringify({ patientId: 'RD-0001' }) })
    const res = await POST(req as never)
    expect(res.status).toBe(400)
  })

  it('rejects an end time that is not after the start time', async () => {
    const providers = await listActiveProviders()
    const req = new Request('http://localhost/api/appointments', {
      method: 'POST',
      body: JSON.stringify({ patientId: 'RD-0001', providerId: providers[0].id, startsAt: '2026-10-01T10:00:00', endsAt: '2026-10-01T09:00:00', visitReason: 'Test visit' }),
    })
    const res = await POST(req as never)
    expect(res.status).toBe(400)
  })

  it('creates a new scheduled appointment', async () => {
    const providers = await listActiveProviders()
    const req = new Request('http://localhost/api/appointments', {
      method: 'POST',
      body: JSON.stringify({ patientId: 'RD-0001', providerId: providers[0].id, startsAt: '2026-10-01T09:00:00', endsAt: '2026-10-01T09:30:00', visitReason: 'Test visit' }),
    })
    const res = await POST(req as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.status).toBe('scheduled')
  })
})

describe('PUT /api/appointments/[id]', () => {
  it('rejects a payload with a field outside the allowlist (mass-assignment guard)', async () => {
    const providers = await listActiveProviders()
    const createReq = new Request('http://localhost/api/appointments', {
      method: 'POST',
      body: JSON.stringify({ patientId: 'RD-0002', providerId: providers[0].id, startsAt: '2026-10-02T09:00:00', endsAt: '2026-10-02T09:30:00', visitReason: 'Test visit' }),
    })
    const created = await (await POST(createReq as never)).json()

    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ patientId: 'RD-9999' }) })
    const res = await PUT(req as never, { params: Promise.resolve({ id: String(created.id) }) })
    expect(res.status).toBe(400)
  })

  it('updates an appointment status to no_show', async () => {
    const providers = await listActiveProviders()
    const createReq = new Request('http://localhost/api/appointments', {
      method: 'POST',
      body: JSON.stringify({ patientId: 'RD-0003', providerId: providers[0].id, startsAt: '2026-10-03T09:00:00', endsAt: '2026-10-03T09:30:00', visitReason: 'Test visit' }),
    })
    const created = await (await POST(createReq as never)).json()

    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ status: 'no_show' }) })
    const res = await PUT(req as never, { params: Promise.resolve({ id: String(created.id) }) })
    expect(res.status).toBe(200)
  })

  it('returns 404 for a nonexistent appointment', async () => {
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ status: 'completed' }) })
    const res = await PUT(req as never, { params: Promise.resolve({ id: '999999' }) })
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 4: Run the suite and commit**

Run: `npm test` and `npm run build` — both must be clean.

```bash
git add src/app/api/appointments tests/api/appointments.test.ts
git commit -m "feat: add appointments API routes for scheduling and status updates

"```

---

### Task 4: Calendar building-block components

Modeled on Tebra's Scheduling sidebar (mini calendar + provider filter checklist with "Check All") and its colored-dot/text-label status convention already established by `StatusChip`.

**Files:**
- Create: `src/components/ProviderDot.tsx`
- Create: `src/components/AppointmentStatusChip.tsx`
- Create: `src/components/AppointmentStatusSelect.tsx` (`'use client'`)
- Create: `src/components/MiniCalendar.tsx`
- Create: `src/components/CalendarProviderFilter.tsx` (`'use client'`)
- Test: `tests/components/ProviderDot.test.tsx`
- Test: `tests/components/AppointmentStatusChip.test.tsx`

**Interfaces:**
- Consumes: `AppointmentStatus` type (Task 2), `getMonthGridDays`/`formatDateParam`/`isSameDay` (Task 2).
- Produces: `<ProviderDot colorTag>`, `<AppointmentStatusChip status>`, `<AppointmentStatusSelect appointmentId status>`, `<MiniCalendar anchor providerIdsParam?>`, `<CalendarProviderFilter providers selectedIds>` — all consumed by the Calendar page in Task 6, and `AppointmentStatusChip` also by the Home Dashboard widget in Task 7.

- [ ] **Step 1: `src/components/ProviderDot.tsx`**

A colored dot for distinguishing providers at a glance — always rendered next to the provider's name text (never color alone), matching the mini-calendar/provider-checklist color-coding shown in the Tebra catalog.

```typescript
const PROVIDER_DOT_CLASSNAME: Record<string, string> = {
  'chart-1': 'bg-chart-1',
  'chart-2': 'bg-chart-2',
  'chart-3': 'bg-chart-3',
  'chart-4': 'bg-chart-4',
  'chart-5': 'bg-chart-5',
}

export function ProviderDot({ colorTag }: { colorTag: string }) {
  return <span className={`h-2 w-2 shrink-0 rounded-full ${PROVIDER_DOT_CLASSNAME[colorTag] ?? 'bg-muted-foreground'}`} aria-hidden="true" />
}
```

- [ ] **Step 2: `src/components/AppointmentStatusChip.tsx`**

```typescript
import type { AppointmentStatus } from '@/lib/queries/appointments'

const CONFIG: Record<AppointmentStatus, { label: string; dotClassName: string; textClassName: string }> = {
  scheduled: { label: 'Scheduled', dotClassName: 'bg-primary', textClassName: 'text-foreground' },
  completed: { label: 'Completed', dotClassName: 'bg-emerald-600', textClassName: 'text-emerald-800' },
  cancelled: { label: 'Cancelled', dotClassName: 'bg-muted-foreground', textClassName: 'text-muted-foreground' },
  no_show: { label: 'No-Show', dotClassName: 'bg-red-600', textClassName: 'text-red-800' },
}

export function AppointmentStatusChip({ status }: { status: AppointmentStatus }) {
  const { label, dotClassName, textClassName } = CONFIG[status]
  return (
    <span className={`inline-flex items-center gap-1.5 text-sm font-medium ${textClassName}`}>
      <span className={`h-2 w-2 rounded-full ${dotClassName}`} aria-hidden="true" />
      {label}
    </span>
  )
}
```

- [ ] **Step 3: `src/components/AppointmentStatusSelect.tsx`**

Lets a CRC mark an appointment completed/cancelled/no-show directly from the calendar — the interactive counterpart to the read-only `AppointmentStatusChip`.

```typescript
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { AppointmentStatus } from '@/lib/queries/appointments'

const STATUS_OPTIONS: AppointmentStatus[] = ['scheduled', 'completed', 'cancelled', 'no_show']

export function AppointmentStatusSelect({ appointmentId, status }: { appointmentId: number; status: AppointmentStatus }) {
  const router = useRouter()
  const [updating, setUpdating] = useState(false)

  async function updateStatus(next: string) {
    setUpdating(true)
    const res = await fetch(`/api/appointments/${appointmentId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: next }),
    })
    setUpdating(false)
    if (res.ok) router.refresh()
  }

  return (
    <select
      value={status}
      disabled={updating}
      onChange={(e) => updateStatus(e.target.value)}
      className="rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground disabled:opacity-50"
    >
      {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s.replace('_', '-')}</option>)}
    </select>
  )
}
```

- [ ] **Step 4: `src/components/MiniCalendar.tsx`**

A month-grid navigator, server-rendered as plain links (no client JS needed) — clicking a day jumps the main calendar to Day view for that date, matching Tebra's Scheduling sidebar mini-calendar.

```typescript
import Link from 'next/link'
import { formatDateParam, getMonthGridDays, isSameDay } from '@/lib/calendar-dates'

export function MiniCalendar({ anchor, providerIdsParam }: { anchor: Date; providerIdsParam: string | undefined }) {
  const days = getMonthGridDays(anchor)
  const monthLabel = anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  const currentMonth = anchor.getMonth()
  const today = new Date()

  function hrefFor(day: Date): string {
    const params = new URLSearchParams()
    params.set('view', 'day')
    params.set('date', formatDateParam(day))
    if (providerIdsParam !== undefined) params.set('providerIds', providerIdsParam)
    return `/calendar?${params.toString()}`
  }

  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{monthLabel}</p>
      <div className="grid grid-cols-7 gap-1 text-center text-xs">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
          <span key={i} className="text-muted-foreground">{d}</span>
        ))}
        {days.map((day) => {
          const inMonth = day.getMonth() === currentMonth
          const isToday = isSameDay(day, today)
          const isSelected = isSameDay(day, anchor)
          const stateClassName = isSelected
            ? 'bg-primary text-primary-foreground'
            : isToday
              ? 'bg-accent/20 text-foreground'
              : inMonth
                ? 'text-foreground hover:bg-secondary'
                : 'text-muted-foreground/50 hover:bg-secondary'
          return (
            <Link key={day.toISOString()} href={hrefFor(day)} className={`rounded-full py-1 transition-colors ${stateClassName}`}>
              {day.getDate()}
            </Link>
          )
        })}
      </div>
    </div>
  )
}
```

- [ ] **Step 5: `src/components/CalendarProviderFilter.tsx`**

The provider checklist with "Check All"/"Uncheck All", matching Tebra's Scheduling Dashboard/Calendar sidebar. Writes the selection into the URL's `providerIds` query param so the Server Component page re-fetches filtered data on every change.

```typescript
'use client'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ProviderDot } from './ProviderDot'

interface ProviderOption {
  id: number
  name: string
  colorTag: string
}

export function CalendarProviderFilter({ providers, selectedIds }: { providers: ProviderOption[]; selectedIds: number[] }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  // Always writes an explicit providerIds value, including an empty string
  // for "none selected" — the calendar page distinguishes "param absent"
  // (no filter, show all) from "param present but empty" (show none).
  function pushProviderIds(ids: number[]) {
    const params = new URLSearchParams(searchParams.toString())
    params.set('providerIds', ids.join(','))
    router.push(`${pathname}?${params.toString()}`)
  }

  function toggle(id: number) {
    const next = selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]
    pushProviderIds(next)
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Providers</h2>
        <div className="flex gap-2 text-xs">
          <button onClick={() => pushProviderIds(providers.map((p) => p.id))} className="font-medium text-primary hover:underline">Check All</button>
          <button onClick={() => pushProviderIds([])} className="font-medium text-primary hover:underline">Uncheck All</button>
        </div>
      </div>
      <ul className="space-y-1.5">
        {providers.map((p) => (
          <li key={p.id}>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input type="checkbox" checked={selectedIds.includes(p.id)} onChange={() => toggle(p.id)} />
              <ProviderDot colorTag={p.colorTag} />
              {p.name}
            </label>
          </li>
        ))}
      </ul>
    </div>
  )
}
```

- [ ] **Step 6: Tests**

`tests/components/ProviderDot.test.tsx`:

```typescript
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { ProviderDot } from '@/components/ProviderDot'

describe('ProviderDot', () => {
  it('maps each known colorTag to its own chart-token class', () => {
    const tags = ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5']
    const classNames = tags.map((tag) => {
      const { container } = render(<ProviderDot colorTag={tag} />)
      return container.querySelector('span')?.className
    })
    expect(new Set(classNames).size).toBe(5)
  })

  it('falls back to a neutral dot for an unrecognized colorTag', () => {
    const { container } = render(<ProviderDot colorTag="not-a-real-tag" />)
    expect(container.querySelector('span')?.className).toContain('bg-muted-foreground')
  })

  it('renders no svg icon glyph', () => {
    const { container } = render(<ProviderDot colorTag="chart-1" />)
    expect(container.querySelector('svg')).not.toBeInTheDocument()
  })
})
```

`tests/components/AppointmentStatusChip.test.tsx`:

```typescript
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AppointmentStatusChip } from '@/components/AppointmentStatusChip'

describe('AppointmentStatusChip', () => {
  it('renders the label text for every status', () => {
    const { rerender } = render(<AppointmentStatusChip status="scheduled" />)
    expect(screen.getByText(/scheduled/i)).toBeInTheDocument()
    rerender(<AppointmentStatusChip status="completed" />)
    expect(screen.getByText(/completed/i)).toBeInTheDocument()
    rerender(<AppointmentStatusChip status="cancelled" />)
    expect(screen.getByText(/cancelled/i)).toBeInTheDocument()
    rerender(<AppointmentStatusChip status="no_show" />)
    expect(screen.getByText(/no-show/i)).toBeInTheDocument()
  })

  it('pairs the label with a colored dot, never a Lucide icon glyph', () => {
    const { container } = render(<AppointmentStatusChip status="no_show" />)
    expect(container.querySelector('svg')).not.toBeInTheDocument()
    expect(container.querySelector('span[aria-hidden="true"]')).toBeInTheDocument()
  })
})
```

- [ ] **Step 7: Run the suite and commit**

Run: `npm test` and `npm run build` — both must be clean.

```bash
git add src/components/ProviderDot.tsx src/components/AppointmentStatusChip.tsx src/components/AppointmentStatusSelect.tsx src/components/MiniCalendar.tsx src/components/CalendarProviderFilter.tsx tests/components/ProviderDot.test.tsx tests/components/AppointmentStatusChip.test.tsx
git commit -m "feat: add calendar building-block components (provider dot, status chip/select, mini-calendar, provider filter)

"```

---

### Task 5: New Event modal

Matches Tebra's Calendar "New Event" action, adapted to a trial pre-screening pilot's actual scheduling need — a patient, a provider, a time, and a visit reason, no billing/telehealth fields.

**Files:**
- Create: `src/components/NewEventModal.tsx` (`'use client'`)
- Create: `src/components/CalendarNewEventButton.tsx` (`'use client'`)

**Interfaces:**
- Consumes: `POST /api/appointments` (Task 3).
- Produces: `<CalendarNewEventButton patients providers defaultDate>`, consumed by the Calendar page in Task 6.

- [ ] **Step 1: `src/components/NewEventModal.tsx`**

```typescript
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

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
    setSubmitting(false)
    if (res.ok) {
      router.refresh()
      onClose()
    } else {
      const body = await res.json()
      setError(body.error ?? 'Could not schedule the appointment.')
    }
  }

  const canSubmit = Boolean(patientId) && providerId !== '' && Boolean(date) && Boolean(startTime) && Boolean(endTime) && Boolean(visitReason) && !submitting

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-lg bg-card p-6 shadow-lg">
        <h2 className="mb-4 text-lg font-semibold text-foreground">New Event</h2>
        <div className="space-y-3">
          <select value={patientId} onChange={(e) => setPatientId(e.target.value)} className="w-full rounded-md border border-border px-3 py-2 text-sm">
            <option value="">Select a patient…</option>
            {patients.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.id})</option>)}
          </select>
          <select value={providerId} onChange={(e) => setProviderId(Number(e.target.value))} className="w-full rounded-md border border-border px-3 py-2 text-sm">
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
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md border border-border px-4 py-1.5 text-sm font-medium text-foreground hover:bg-secondary">Cancel</button>
          <button onClick={submit} disabled={!canSubmit} className="rounded-md bg-accent px-4 py-1.5 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50">Save</button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: `src/components/CalendarNewEventButton.tsx`**

Kept separate from `NewEventModal` (mirrors `DashboardHomeClient`'s pattern from Phase 1) so the modal's own open/close state doesn't force the entire Calendar page into a Client Component.

```typescript
'use client'
import { useState } from 'react'
import { NewEventModal } from './NewEventModal'

export function CalendarNewEventButton({ patients, providers, defaultDate }: {
  patients: { id: string; name: string }[]
  providers: { id: number; name: string }[]
  defaultDate: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)} className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90">New Event</button>
      {open && <NewEventModal patients={patients} providers={providers} defaultDate={defaultDate} onClose={() => setOpen(false)} />}
    </>
  )
}
```

- [ ] **Step 3: Run the suite and commit**

Run: `npm test` and `npm run build` — both must be clean. (No dedicated component test for the two modal components — matches Phase 1's precedent for `AddClientModal`/`SendFormModal`, which are exercised through the API-route tests plus manual verification in the assembly task below.)

```bash
git add src/components/NewEventModal.tsx src/components/CalendarNewEventButton.tsx
git commit -m "feat: add New Event modal for scheduling appointments from the calendar

"```

---

### Task 6: Calendar page (`/calendar`) — Day/Week/Month assembly

Assembles Tasks 2–5 into the full Calendar page: Day/Week/Month toggle, Previous/Today/Next navigation, the mini-calendar + provider-filter sidebar, and the New Event button — matching the Tebra Scheduling Dashboard/Calendar screens read in the catalog.

**Files:**
- Create: `src/app/(dashboard)/calendar/page.tsx`
- Test: `tests/pages/calendar.test.tsx`

**Interfaces:**
- Consumes: `listActiveProviders` (Task 2), `listAppointmentsInRange` (Task 2), `listPatientsWithStatus` (existing, `src/lib/queries/patients.ts`), `getViewRange`/`getWeekDays`/`getMonthGridDays`/`parseDateParam`/`formatDateParam`/`addDays`/`isSameDay`/`type CalendarView` (Task 2), `<MiniCalendar>`/`<CalendarProviderFilter>`/`<AppointmentStatusSelect>`/`<ProviderDot>` (Task 4), `<CalendarNewEventButton>` (Task 5).

- [ ] **Step 1: `src/app/(dashboard)/calendar/page.tsx`**

```typescript
import Link from 'next/link'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listActiveProviders } from '@/lib/queries/providers'
import { listAppointmentsInRange, type AppointmentWithDetails } from '@/lib/queries/appointments'
import { listPatientsWithStatus } from '@/lib/queries/patients'
import { addDays, formatDateParam, getMonthGridDays, getViewRange, getWeekDays, isSameDay, parseDateParam, type CalendarView } from '@/lib/calendar-dates'
import { MiniCalendar } from '@/components/MiniCalendar'
import { CalendarProviderFilter } from '@/components/CalendarProviderFilter'
import { CalendarNewEventButton } from '@/components/CalendarNewEventButton'
import { AppointmentStatusSelect } from '@/components/AppointmentStatusSelect'
import { ProviderDot } from '@/components/ProviderDot'

function parseView(param: string | undefined): CalendarView {
  return param === 'day' || param === 'week' || param === 'month' ? param : 'week'
}

function parseProviderIdsParam(param: string | undefined): number[] | undefined {
  if (param === undefined) return undefined
  if (param === '') return []
  return param.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0)
}

function buildCalendarHref(view: CalendarView, date: Date, providerIdsParam: string | undefined): string {
  const params = new URLSearchParams()
  params.set('view', view)
  params.set('date', formatDateParam(date))
  if (providerIdsParam !== undefined) params.set('providerIds', providerIdsParam)
  return `/calendar?${params.toString()}`
}

function formatTime(date: Date): string {
  return new Date(date).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ view?: string; date?: string; providerIds?: string }> }) {
  // Must be the first statement — see the comment in patients/page.tsx.
  const session = await requireSessionOrRedirect()

  const { view: viewParam, date: dateParam, providerIds: providerIdsParam } = await searchParams
  const view = parseView(viewParam)
  const anchor = parseDateParam(dateParam)
  const explicitProviderIds = parseProviderIdsParam(providerIdsParam)

  const [allProviders, allPatients] = await Promise.all([listActiveProviders(), listPatientsWithStatus(null)])
  const selectedProviderIds = explicitProviderIds ?? allProviders.map((p) => p.id)

  const { start, end } = getViewRange(view, anchor)
  const appointmentsInRange = await listAppointmentsInRange(start, end, explicitProviderIds)

  await logAudit(session, 'viewed calendar', null)

  const patientOptions = allPatients.map((p) => ({ id: p.id, name: p.nameTebra ?? p.nameIntakeq }))
  const providerOptions = allProviders.map((p) => ({ id: p.id, name: p.name, colorTag: p.colorTag }))

  const today = new Date()
  const prevAnchor = view === 'day' ? addDays(anchor, -1) : view === 'week' ? addDays(anchor, -7) : new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1)
  const nextAnchor = view === 'day' ? addDays(anchor, 1) : view === 'week' ? addDays(anchor, 7) : new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1)

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">Calendar</h1>
        <CalendarNewEventButton patients={patientOptions} providers={providerOptions} defaultDate={formatDateParam(anchor)} />
      </div>

      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Link href={buildCalendarHref(view, prevAnchor, providerIdsParam)} className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-secondary">Previous</Link>
          <Link href={buildCalendarHref(view, today, providerIdsParam)} className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-secondary">Today</Link>
          <Link href={buildCalendarHref(view, nextAnchor, providerIdsParam)} className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-secondary">Next</Link>
          <span className="ml-2 text-sm font-medium text-foreground">
            {view === 'month' ? anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : `${start.toLocaleDateString()} – ${end.toLocaleDateString()}`}
          </span>
        </div>
        <div className="flex gap-1 rounded-lg bg-secondary p-1 text-sm">
          {(['day', 'week', 'month'] as const).map((v) => (
            <Link key={v} href={buildCalendarHref(v, anchor, providerIdsParam)} className={`rounded-md px-3 py-1.5 font-medium capitalize transition-colors ${view === v ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>{v}</Link>
          ))}
        </div>
      </div>

      <div className="flex gap-6">
        <aside className="w-56 shrink-0 space-y-6">
          <MiniCalendar anchor={anchor} providerIdsParam={providerIdsParam} />
          <CalendarProviderFilter providers={providerOptions} selectedIds={selectedProviderIds} />
        </aside>

        <div className="flex-1">
          {view === 'day' && <DayView date={anchor} appointments={appointmentsInRange} />}
          {view === 'week' && <WeekView anchor={anchor} appointments={appointmentsInRange} providerIdsParam={providerIdsParam} />}
          {view === 'month' && <MonthView anchor={anchor} appointments={appointmentsInRange} providerIdsParam={providerIdsParam} />}
        </div>
      </div>
    </div>
  )
}

function DayView({ date, appointments }: { date: Date; appointments: AppointmentWithDetails[] }) {
  const dayAppointments = appointments
    .filter((a) => isSameDay(new Date(a.startsAt), date))
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())

  if (dayAppointments.length === 0) {
    return <p className="text-sm text-muted-foreground">No appointments to show.</p>
  }

  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-border text-left">
          <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Time</th>
          <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Patient</th>
          <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Provider</th>
          <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Visit Reason</th>
          <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</th>
        </tr>
      </thead>
      <tbody>
        {dayAppointments.map((a, i) => (
          <tr key={a.id} className={`border-b border-border ${i % 2 === 1 ? 'bg-muted/40' : ''}`}>
            <td className="p-3 text-foreground">{formatTime(a.startsAt)} – {formatTime(a.endsAt)}</td>
            <td className="p-3"><Link href={`/patients/${a.patientId}`} className="font-medium text-primary hover:underline">{a.patientName}</Link></td>
            <td className="p-3 text-foreground"><span className="inline-flex items-center gap-2"><ProviderDot colorTag={a.providerColorTag} />{a.providerName}</span></td>
            <td className="p-3 text-foreground">{a.visitReason}</td>
            <td className="p-3"><AppointmentStatusSelect appointmentId={a.id} status={a.status} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function WeekView({ anchor, appointments, providerIdsParam }: { anchor: Date; appointments: AppointmentWithDetails[]; providerIdsParam: string | undefined }) {
  const days = getWeekDays(anchor)
  return (
    <div className="grid grid-cols-7 gap-3">
      {days.map((day) => {
        const dayAppointments = appointments
          .filter((a) => isSameDay(new Date(a.startsAt), day))
          .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())
        return (
          <div key={day.toISOString()} className="rounded-lg border border-border bg-card p-2">
            <Link href={buildCalendarHref('day', day, providerIdsParam)} className="mb-2 block text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-primary">
              {day.toLocaleDateString(undefined, { weekday: 'short' })} {day.getDate()}
            </Link>
            {dayAppointments.length === 0 ? (
              <p className="text-xs text-muted-foreground">No appointments to show.</p>
            ) : (
              <ul className="space-y-1.5">
                {dayAppointments.map((a) => (
                  <li key={a.id} className="rounded-md border border-border p-1.5 text-xs">
                    <div className="font-medium text-foreground">{formatTime(a.startsAt)}</div>
                    <Link href={`/patients/${a.patientId}`} className="text-primary hover:underline">{a.patientName}</Link>
                    <div className="flex items-center gap-1 text-muted-foreground"><ProviderDot colorTag={a.providerColorTag} />{a.providerName}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      })}
    </div>
  )
}

function MonthView({ anchor, appointments, providerIdsParam }: { anchor: Date; appointments: AppointmentWithDetails[]; providerIdsParam: string | undefined }) {
  const days = getMonthGridDays(anchor)
  const currentMonth = anchor.getMonth()
  const MAX_VISIBLE = 3

  return (
    <div className="grid grid-cols-7 gap-1">
      {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
        <div key={d} className="p-1 text-center text-xs font-semibold uppercase tracking-wide text-muted-foreground">{d}</div>
      ))}
      {days.map((day) => {
        const inMonth = day.getMonth() === currentMonth
        const dayAppointments = appointments
          .filter((a) => isSameDay(new Date(a.startsAt), day))
          .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())
        const visible = dayAppointments.slice(0, MAX_VISIBLE)
        const overflow = dayAppointments.length - visible.length

        return (
          <Link
            key={day.toISOString()}
            href={buildCalendarHref('day', day, providerIdsParam)}
            className={`min-h-24 rounded-md border border-border p-1.5 text-xs transition-colors hover:border-primary ${inMonth ? 'bg-card' : 'bg-muted/40 text-muted-foreground'}`}
          >
            <div className="mb-1 font-medium">{day.getDate()}</div>
            <ul className="space-y-0.5">
              {visible.map((a) => (
                <li key={a.id} className="flex items-center gap-1 truncate">
                  <ProviderDot colorTag={a.providerColorTag} />
                  <span className="truncate">{formatTime(a.startsAt)} {a.patientName}</span>
                </li>
              ))}
            </ul>
            {overflow > 0 && <div className="text-muted-foreground">+{overflow} more</div>}
          </Link>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: Test**

`tests/pages/calendar.test.tsx` — a lightweight smoke test confirming the page module imports cleanly (full RSC rendering tests aren't practical without a running Next.js server, matching the established pattern from Phase 1's `dashboard-home.test.tsx` note; data-shape coverage for the underlying queries already lives in `tests/lib/queries/appointments.test.ts` and `tests/lib/calendar-dates.test.ts`):

```typescript
import { describe, it, expect } from 'vitest'

describe('/calendar page module', () => {
  it('imports without throwing', async () => {
    const mod = await import('@/app/(dashboard)/calendar/page')
    expect(typeof mod.default).toBe('function')
  })
})
```

- [ ] **Step 3: Run the suite, manually verify, and commit**

Run: `npm test` and `npm run build`. Then `npm run dev` and manually confirm:
- `/calendar` loads with the Week view by default, showing seeded appointments across the current week's columns.
- Clicking Day/Week/Month switches views; Previous/Today/Next navigate correctly for each view.
- The mini-calendar's day links jump straight to that day's Day view.
- Unchecking a provider in the sidebar filters that provider's appointments out of the visible view; "Uncheck All" shows zero appointments; re-checking restores them.
- Clicking "New Event", filling in patient/provider/date/time/visit reason, and saving creates a new appointment that appears after `router.refresh()`.
- On the Day view, changing an appointment's status dropdown persists after a page refresh.

```bash
git add "src/app/(dashboard)/calendar" tests/pages/calendar.test.tsx
git commit -m "feat: add /calendar page with Day/Week/Month views, mini-calendar, and provider filter sidebar

"```

---

### Task 7: Home Dashboard — "Upcoming Appointments" widget

Adds a fifth widget to the Home Dashboard built in Phase 1 (`docs/superpowers/plans/2026-09-17-intake-chart-workflow.md`, Task 6), so scheduling has a visible presence outside the Calendar page itself.

**Files:**
- Modify: `src/app/(dashboard)/page.tsx`

**Interfaces:**
- Consumes: `listUpcomingAppointments` (Task 2), `<AppointmentStatusChip>` (Task 4).

- [ ] **Step 1: Read the current file**

Read `src/app/(dashboard)/page.tsx` in full first. By the time this task runs, it must match the shape Phase 1's Task 6 produced (imports of `getDashboardData`, `listFormTemplates`, `listPatientsWithStatus`, `DashboardHomeClient`; a `Promise.all` fetching `[data, templates, patients]`; a `grid grid-cols-2 gap-4` containing 4 `<section>` widgets: Latest Forms Received, Pending Forms, Pending Classifications, Latest Account Events). If it differs, apply the same intent (add the import, add the query call to the existing `Promise.all`, add the widget `<section>` inside the existing grid) adapted to whatever the actual current structure is — do not restructure anything else on the page.

- [ ] **Step 2: Add the two new imports**

Find:

```typescript
import { listPatientsWithStatus } from '@/lib/queries/patients'
import { DashboardHomeClient } from '@/components/DashboardHomeClient'
```

Replace with:

```typescript
import { listPatientsWithStatus } from '@/lib/queries/patients'
import { listUpcomingAppointments } from '@/lib/queries/appointments'
import { DashboardHomeClient } from '@/components/DashboardHomeClient'
import { AppointmentStatusChip } from '@/components/AppointmentStatusChip'
```

- [ ] **Step 3: Fetch upcoming appointments alongside the existing dashboard data**

Find:

```typescript
  const [data, templates, patients] = await Promise.all([getDashboardData(), listFormTemplates(), listPatientsWithStatus(null)])
```

Replace with:

```typescript
  const [data, templates, patients, upcomingAppointments] = await Promise.all([getDashboardData(), listFormTemplates(), listPatientsWithStatus(null), listUpcomingAppointments(5)])
```

- [ ] **Step 4: Add the widget section**

Find the closing of the "Latest Account Events" `<section>` — the last of the 4 widgets, immediately followed by the closing `</div>` of the `grid grid-cols-2 gap-4` container:

```typescript
        <section className="rounded-lg border border-border bg-card p-5">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Latest Account Events</h2>
          {data.recentEvents.length === 0 ? <p className="text-sm text-muted-foreground">No records found.</p> : (
            <ul className="space-y-2">
              {data.recentEvents.map((e) => (
                <li key={e.id} className="flex items-center gap-2 text-sm">
                  <span className={`h-2 w-2 rounded-full ${EVENT_DOT[e.action] ?? 'bg-muted-foreground'}`} aria-hidden="true" />
                  <span className="text-foreground">{e.action}</span>
                  <span className="text-xs text-muted-foreground">{new Date(e.timestamp).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
```

Replace with (adds the new `<section>` before the grid's closing `</div>`, spanning both columns):

```typescript
        <section className="rounded-lg border border-border bg-card p-5">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Latest Account Events</h2>
          {data.recentEvents.length === 0 ? <p className="text-sm text-muted-foreground">No records found.</p> : (
            <ul className="space-y-2">
              {data.recentEvents.map((e) => (
                <li key={e.id} className="flex items-center gap-2 text-sm">
                  <span className={`h-2 w-2 rounded-full ${EVENT_DOT[e.action] ?? 'bg-muted-foreground'}`} aria-hidden="true" />
                  <span className="text-foreground">{e.action}</span>
                  <span className="text-xs text-muted-foreground">{new Date(e.timestamp).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="col-span-2 rounded-lg border border-border bg-card p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Upcoming Appointments</h2>
            <Link href="/calendar" className="text-xs font-medium text-primary hover:underline">View Calendar</Link>
          </div>
          {upcomingAppointments.length === 0 ? <p className="text-sm text-muted-foreground">No appointments to show.</p> : (
            <ul className="space-y-2">
              {upcomingAppointments.map((a) => (
                <li key={a.id} className="flex items-center justify-between text-sm">
                  <div>
                    <Link href={`/patients/${a.patientId}`} className="font-medium text-primary hover:underline">{a.patientName}</Link>
                    <span className="text-muted-foreground"> — {a.visitReason} with {a.providerName}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground">{new Date(a.startsAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span>
                    <AppointmentStatusChip status={a.status} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
```

(`Link` from `next/link` is already imported at the top of this file per Phase 1's Task 6 — no new import needed for it.)

- [ ] **Step 5: Run the suite, manually verify, and commit**

Run: `npm test` and `npm run build`. Then `npm run dev` and manually confirm `/` shows a 5th "Upcoming Appointments" widget spanning the full width below the existing 2×2 grid, listing the seeded scheduled appointments soonest-first, each with a working "View Calendar" link to `/calendar` and a link to the patient's detail page.

```bash
git add "src/app/(dashboard)/page.tsx"
git commit -m "feat: add Upcoming Appointments widget to the Home Dashboard

"```

---

### Task 8: Nav entry + Final QA pass

**Files:**
- Modify: `src/components/LeftNav.tsx`

**Interfaces:**
- Consumes: `/calendar` route (Task 6).

- [ ] **Step 1: Add the Calendar nav entry in the position the cross-phase spec assigns it**

Open `src/components/LeftNav.tsx`. Per `docs/superpowers/specs/2026-09-17-full-platform-phases-design.md` §5, the final nav order is: Home, Patients, Identity Matching, Trials & Protocols, **Calendar (Phase 2)**, Form Templates (Phase 1), Client Forms (Phase 1), … — so Calendar must be inserted immediately after the `Trials & Protocols` entry. Find:

```typescript
  { href: '/trials', label: 'Trials & Protocols' },
```

Add immediately after it:

```typescript
  { href: '/trials', label: 'Trials & Protocols' },
  { href: '/calendar', label: 'Calendar' },
```

(If Phase 1 has already inserted its own `Form Templates`/`Client Forms` entries after `Trials & Protocols`, leave them exactly where they are — `Calendar` goes between `Trials & Protocols` and whatever Phase 1 added, not at the end of the array. Do not reorder or touch any entry this phase doesn't own, per the cross-phase spec's rule that each phase's plan adds only its own nav entries.)

- [ ] **Step 2: Run the suite and commit**

Run: `npm test` and `npm run build` — both must be clean.

```bash
git add src/components/LeftNav.tsx
git commit -m "feat: add Calendar entry to the left nav

"```

- [ ] **Step 3: Final QA pass**

Run `npm test` and `npm run build` one more time from a clean state to confirm the whole phase is green together (not just task-by-task). Then `npm run dev` and walk through the full feature end to end:

1. Left nav shows "Calendar" between "Trials & Protocols" and "Form Templates".
2. `/calendar` defaults to Week view for the current week, with seeded appointments visible.
3. Day view: appointments for a single day, sorted by time, with a working inline status dropdown.
4. Week view: 7 day-columns, each showing that day's appointments or "No appointments to show."
5. Month view: a 6-week grid, each day cell showing up to 3 appointment chips plus a "+N more" overflow indicator, clicking a day jumps to its Day view.
6. Mini-calendar day clicks jump to Day view for that date.
7. Provider checklist: unchecking a provider filters them out of all three views; "Check All"/"Uncheck All" both work.
8. "New Event" modal creates a real appointment visible immediately after the page refreshes.
9. Home Dashboard (`/`) shows the "Upcoming Appointments" widget with a working "View Calendar" link.
10. No hardcoded Tailwind color classes were introduced anywhere in this phase's new files (grep the new files for `bg-slate`, `bg-green-`, `text-red-` etc., outside of the pre-existing severity/status green/amber/red pattern already used by `StatusChip`/`AllergyBadge` elsewhere in the codebase).

This is the point at which the phase is ready for the user's review — nothing from this plan is pushed to git until that review happens, per the Global Constraints.

---

## Self-Review

**Placeholder scan:** Searched every task for "TBD", "TODO", "implement later", "add appropriate error handling", "similar to Task N", and bare prose describing code without showing it. None found — every step above contains complete, runnable code (schema, seed data, query functions, Zod-validated routes, full component/page JSX, and full test files).

**Type/interface consistency across tasks:**
- `AppointmentStatus` is defined once, in `src/lib/queries/appointments.ts` (Task 2), and imported (not redefined) by `AppointmentStatusChip.tsx` and `AppointmentStatusSelect.tsx` (Task 4) and used identically in the Zod enum in both API routes (Task 3).
- `AppointmentWithDetails` (Task 2) field names (`id`, `patientId`, `patientName`, `providerId`, `providerName`, `providerColorTag`, `startsAt`, `endsAt`, `visitReason`, `status`, `notes`) are used with matching names in the Calendar page's `DayView`/`WeekView`/`MonthView` (Task 6) and the Home Dashboard widget (Task 7) — no field is renamed between where it's produced and where it's consumed.
- `listAppointmentsInRange`'s `providerIds?: number[]` tri-state (`undefined` = no filter, `[]` = explicitly none, non-empty = filter) is threaded consistently: `CalendarProviderFilter` (Task 4) always writes an explicit array (possibly empty) to the URL; the Calendar page (Task 6) and the `GET /api/appointments` route (Task 3) both parse "param absent → `undefined`, param `''` → `[]`, else split-and-parse" identically; `listAppointmentsInRange` (Task 2) short-circuits on the empty-array case before building the query. This exact bug (conflating "no filter" with "filter to nothing") was caught and fixed during planning — the empty-array short-circuit is the load-bearing line.
- `colorTag` values are constrained to `'chart-1'`..`'chart-5'` at the single point they're produced (the `PROVIDER_ROSTER` seed data, Task 1) and consumed via one literal lookup table (`PROVIDER_DOT_CLASSNAME` in `ProviderDot.tsx`, Task 4) rather than dynamic Tailwind class construction — avoids the Tailwind v4 JIT-scanning pitfall where a template-interpolated class name (`` `bg-${colorTag}` ``) wouldn't be found by the build's static scan.
- `providers` table's `id` (serial/number) is used consistently as `number` everywhere (Zod `z.number().int().positive()` in the create schema, `providerId: number` in `AppointmentWithDetails`, `id: number` in `ProviderOption` for `CalendarProviderFilter`/`NewEventModal`).
- Every new Server Component page (`/calendar`) calls `requireSessionOrRedirect()` as its first statement; every new API route calls `requireSession()` and returns the `NextResponse` unchanged on failure; every write (`POST`/`PUT` in Task 3) calls `logAudit`.

**Spec coverage against the catalog's "Scheduling" section:**
- *"Dashboard — mini calendar, Providers filter checklist (Check All)"* → `MiniCalendar` + `CalendarProviderFilter` (Task 4), assembled into the Calendar page's sidebar (Task 6). (Tebra's separate "Dashboard" screen with counters/Outstanding Items is Home Dashboard territory, already covered by Phase 1's Home Dashboard plus this phase's own Upcoming Appointments widget addition — Task 7 — rather than a second, redundant scheduling-specific dashboard, consistent with "adapt, don't clone every screen 1:1" and the "no enterprise-scale over-engineering" constraint.)
- *"Calendar (Day/Week/Month)"* → the view toggle and three render modes in Task 6.
- *"Same provider-filter sidebar"* on the Calendar screen → reused verbatim (`CalendarProviderFilter` + `MiniCalendar` in the sidebar of Task 6's page), matching the catalog's note that the Dashboard and Calendar share the same sidebar.
- *"New Event"* action → `NewEventModal`/`CalendarNewEventButton` (Task 5), wired into the page header (Task 6).
- Deliberately **not** built, per this plan's own scope and the phase brief: "Show cancelled/rescheduled/no-show" toggle (status filtering is out of scope beyond the status field itself — a CRC can already see status per-row and change it inline), zoom controls, a settings gear, "Check Eligibility For All"/"Find Available Appointment" (billing/eligibility-adjacent, out of scope for a pre-screening pilot), and Outstanding Items/daily counters (Home Dashboard's existing widgets already cover the "what needs attention" role Phase 1 built). Each of these is a real Tebra feature that would be either meaningless (no billing integration exists) or duplicative (Home Dashboard already serves the "what's pending" purpose) in Clinsync, consistent with §3 of the cross-phase spec.
- The provider-backfill-vs-independent-seed decision the cross-phase spec (§4) explicitly required this plan to make and document: resolved in the "Design Decision" section above, with concrete reasoning tied to the actual seed data read during planning.
