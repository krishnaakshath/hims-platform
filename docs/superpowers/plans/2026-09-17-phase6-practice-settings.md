# Phase 6: Practice/Account Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Clinsync's Phase 1 Settings page (a flat page with a Compliance section and a "Signed in as" line) into a sectioned Practice/Account Settings hub — Practice Information, Provider Profiles, User Settings, My Account, plus the preserved Compliance and Classification sections — giving the pilot's admin a real place to see and lightly manage practice-level configuration (practice display name, Phase 2's provider roster) and giving every demo user a legible account/role summary, without inventing a public-facing provider directory, a real user-management CRUD system, or any field with no consumer anywhere in the app.

**Architecture:** Same stack and security patterns as every prior phase: Next.js App Router Server Components + shared query functions in `src/lib/queries/*.ts`, Drizzle/Neon, `requireSession`/`requireSessionOrRedirect`, `.strict()` Zod-validated writes, `logAudit()` on every write. No new database tables (per the architecture spec §4) — this phase either extends Phase 1's `appSettings` single-row table or reads/writes Phase 2's `providers` table; it decides which per field, not wholesale (see **Key Decisions** below). The Settings page gains a client-side sub-nav (`SettingsSubNav`, built on the existing `@base-ui/react/tabs`-backed `Tabs` primitive already vendored at `src/components/ui/tabs.tsx`) but every panel's data is fetched server-side in `src/app/(dashboard)/settings/page.tsx` and passed down as props — no panel re-fetches its own read data client-side, only writes go through `fetch()`, exactly matching the `AutoClassifyToggle` precedent from Phase 1 Task 8.

**Tech Stack:** Next.js 16 (App Router, TypeScript), Drizzle ORM + Neon Postgres, Tailwind v4 + shadcn/ui (`@base-ui/react` primitives), Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-17-full-platform-phases-design.md` (§4 schema ownership, §5 navigation), `docs/superpowers/specs/2026-09-17-tebra-intakeq-screenshot-catalog.md` ("Account/practice settings" section).

## Execution ordering — read this before starting

This plan must execute **last**, after Phases 1–5 are complete and merged. Three of its six tasks depend on artifacts those phases produce that did not exist in the codebase at the time this plan was written:

- Task 2 depends on Phase 1 Task 8's exact final shape of `src/app/(dashboard)/settings/page.tsx` (the Compliance + Classification sections, `getAppSettings`, `AutoClassifyToggle`).
- Task 3 depends on Phase 2's `providers` table existing in `src/db/schema.ts`.
- Task 6 depends on the literal, accumulated state of `src/components/LeftNav.tsx` after Phases 1–5 have each appended their own nav entries.

Each of those tasks says exactly what to verify against the live repo before applying its steps. See **Self-Review** at the end for the full list of assumptions this plan makes about Phase 1/2 file shapes and what to reconcile if reality has drifted.

## Key Decisions

**1. `appSettings` extension, not a new `practiceSettings` table.** The only genuinely new practice-level field this phase needs is a practice display name (see Task 1) — everything else Practice Information shows (provider roster, trial sites) is read from tables Phases 1/2 already own. One narrow text column with a sane default does not warrant a second single-row settings table alongside `appSettings`; it would only fragment "the pilot's settings" across two tables for no reader's benefit and complicate `getAppSettings()`'s callers into knowing which of two rows to join. If a later phase needs many more practice-wide fields, splitting them into `practiceSettings` at that point is the right call — for the field count this phase actually needs (one), it is not.

**2. `SettingsSubNav` (Tabs-based), not anchor links.** Six sections is enough to want a real "you are here" affordance (the anchor-link alternative gives no active-state indicator and dumps every panel's markup into one long scroll, which reads worse than Tebra's actual left sub-nav pattern this feature is modeled on). Rather than hand-rolling a new nav primitive, this plan reuses `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent` from `src/components/ui/tabs.tsx` (already vendored, unused elsewhere in the app) with `orientation="vertical"` — it already renders exactly as a left sub-nav with active-state styling, so no new interaction pattern or dependency is introduced.

**3. Provider name edits and the practice display name edit are admin-only.** Phase 1 Task 8 established the app's one precedent for a role-gated write (auto-classify toggle, admin-only). This plan extends that same precedent to the two new practice-level writes it introduces, rather than inventing a different gating rule per field. This is reflected in the User Settings panel's admin capability list (Task 4).

**4. My Account stays name + role, no "last signed in."** The demo session cookie (`src/lib/auth.ts`) stores only `{ role, name }` with no timestamp, and the `users` table has no `lastLogin` column. There is no real data source for "last signed in" anywhere in the codebase, and the login flow's demo names (`"Jamie Ruiz (Research Coordinator)"` in `src/app/login/page.tsx`) do not exactly match the seeded `users.name` value (`"Jamie Ruiz"`), so joining the session back to a `users` row by name would be a fragile, cosmetic-looking match on data that isn't actually the same record — not something to build. My Account shows the session's own name + role plus that role's capability summary (reusing the same copy as the User Settings panel); nothing else.

**5. LeftNav's Billing entry becomes a collapsible group, not six flat top-level links.** Per the architecture spec §5, Billing (Phase 3) is "itself expandable to Charges/Insurance Collections/Patient Collections/Statements/A-R Dashboard/Analytics." Six flat entries at the top level would roughly double the nav's visual length for one module; a single collapsible "Billing" parent with those six as children keeps the primary nav scannable and matches Tebra's own real IA (a single "Billing ($)" app-switcher entry fanning out, per the screenshot catalog). Every other module in the final order stays a flat, single-level link since none of them have Billing's fan-out.

---

## Global Constraints

- Every API route calls `requireSession()` and returns its `NextResponse` result unchanged on failure (see `src/lib/auth.ts`, `src/app/api/trials/[trialId]/criteria/route.ts` for the exact pattern).
- Every Server Component page calls `requireSessionOrRedirect()` as its **first statement**, before any data fetch (see the comment in `src/app/(dashboard)/patients/page.tsx` — a prior review proved that relying on the layout's redirect alone leaks PHI into the response body on an unauthenticated request).
- Server Components call shared query functions in `src/lib/queries/*.ts` directly. **Never** `fetch()` the app's own API route from a Server Component (a prior real vulnerability: session-cookie exfiltration via a forged `Host` header).
- Every write validates its request body with a `.strict()` Zod schema (see `criteriaUpdateSchema` in `src/app/api/trials/[trialId]/criteria/route.ts`).
- Every write that changes patient-relevant state calls `logAudit(session, action, patientId)` (`src/lib/audit.ts`) — `session` must be the real, non-null session, never a fallback role. This phase's writes are practice-level, not patient-level, so every `logAudit` call below passes `null` for `patientId`, matching the existing precedent in `src/app/api/settings/auto-classify/route.ts` and `src/app/api/trials/[trialId]/criteria/route.ts`.
- Zero decorative icons anywhere. Status/severity is always a colored dot (`<span className="h-2 w-2 rounded-full ...">`, `aria-hidden="true"`) plus a text label — see `src/components/StatusChip.tsx`.
- Design tokens only: `bg-primary`, `bg-accent`, `text-accent-foreground`, `bg-card`, `border-border`, `bg-muted`, `text-muted-foreground`, `bg-secondary` from `src/app/globals.css`. Never a hardcoded Tailwind color class (`bg-slate-*`, `text-green-700`, etc.).
- Section/column headers use the established convention: `text-xs font-semibold uppercase tracking-wide text-muted-foreground`.
- Zebra striping on every list/table: `i % 2 === 1 ? 'bg-muted/40' : ''`.
- At most one coral (`bg-accent`) primary-action button per screen.
- No glassmorphism, gradient/shiny buttons, bento grids, or floating/breathing animations — subtle hover/transition-colors utilities only, consistent with what's already in the codebase.
- Empty states are plain, factual text in the interface's voice ("No records found.", not an illustration).
- `npm test` and `npm run build` must be clean after every task. Nothing in this plan is pushed to git or deployed until the whole plan's Final QA pass (Task 6, Step 5) is green — test locally throughout.

---

### Task 1: Practice display name — schema, queries, API route, editor component

**Files:**
- Modify: `src/db/schema.ts` (extend `appSettings`, created by Phase 1 Task 1)
- Modify: `src/db/seed.ts` (extend the `appSettings` seed insert from Phase 1 Task 1)
- Modify: `src/lib/queries/settings.ts` (extend `getAppSettings`'s fallback, add `updatePracticeDisplayName`)
- Create: `src/app/api/settings/practice/route.ts` (PUT, admin-only)
- Create: `src/components/settings/PracticeNameEditor.tsx` (`'use client'`)
- Test: `tests/api/settings-practice.test.ts`

**Interfaces:**
- Consumes: `appSettings` (Phase 1 Task 1), `getAppSettings` (Phase 1 Task 2 Step 4).
- Produces: `appSettings.practiceDisplayName` column; `updatePracticeDisplayName(value: string)`; `PracticeNameEditor` (consumed by Task 5's Practice Information panel and by Task 2's layout wiring via `getAppSettings()`).

- [ ] **Step 1: Extend the `appSettings` table**

Before editing, confirm the live `src/db/schema.ts` has the `appSettings` table exactly as Phase 1 Task 1 defines it:

```typescript
export const appSettings = pgTable('app_settings', {
  id: serial('id').primaryKey(),
  autoClassifyOnComplete: boolean('auto_classify_on_complete').default(false).notNull(),
})
```

Add one column so it reads:

```typescript
export const appSettings = pgTable('app_settings', {
  id: serial('id').primaryKey(),
  autoClassifyOnComplete: boolean('auto_classify_on_complete').default(false).notNull(),
  // Practice-wide display name shown in TopBanner and the Practice
  // Information settings panel. Defaulted to the demo practice's real name
  // (see the screenshot catalog) so the field is never blank in the pilot.
  practiceDisplayName: text('practice_display_name').default('Inland Psychiatric Medical Group').notNull(),
})
```

- [ ] **Step 2: Push the schema**

Run: `npm run db:push` (confirm it reports the one new column with no errors — no new table, no new enum).

- [ ] **Step 3: Extend the seed script**

In `src/db/seed.ts`, find Phase 1 Task 1's seed line for `appSettings` (`await db.insert(appSettings).values({ autoClassifyOnComplete: false })`) and change it to:

```typescript
await db.insert(appSettings).values({ autoClassifyOnComplete: false, practiceDisplayName: 'Inland Psychiatric Medical Group' })
```

(This is the explicit value even though the column has a matching default — seed scripts in this codebase always pass every column they care about explicitly rather than relying on defaults silently agreeing with intent.)

- [ ] **Step 4: Extend `src/lib/queries/settings.ts`**

Confirm the live file matches Phase 1 Task 2 Step 4:

```typescript
import { getDb } from '@/db/client'
import { appSettings } from '@/db/schema'
import { eq } from 'drizzle-orm'

export async function getAppSettings() {
  const [row] = await getDb().select().from(appSettings)
  return row ?? { id: 1, autoClassifyOnComplete: false }
}

export async function updateAutoClassifySetting(value: boolean) {
  const current = await getAppSettings()
  await getDb().update(appSettings).set({ autoClassifyOnComplete: value }).where(eq(appSettings.id, current.id))
}
```

Change it to:

```typescript
import { getDb } from '@/db/client'
import { appSettings } from '@/db/schema'
import { eq } from 'drizzle-orm'

export async function getAppSettings() {
  const [row] = await getDb().select().from(appSettings)
  return row ?? { id: 1, autoClassifyOnComplete: false, practiceDisplayName: 'Inland Psychiatric Medical Group' }
}

export async function updateAutoClassifySetting(value: boolean) {
  const current = await getAppSettings()
  await getDb().update(appSettings).set({ autoClassifyOnComplete: value }).where(eq(appSettings.id, current.id))
}

export async function updatePracticeDisplayName(value: string) {
  const current = await getAppSettings()
  await getDb().update(appSettings).set({ practiceDisplayName: value }).where(eq(appSettings.id, current.id))
}
```

- [ ] **Step 5: `src/app/api/settings/practice/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { updatePracticeDisplayName } from '@/lib/queries/settings'

const practiceUpdateSchema = z.object({ practiceDisplayName: z.string().trim().min(1, 'Practice name is required').max(200) }).strict()

export async function PUT(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })

  const parsed = practiceUpdateSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 400 })

  await updatePracticeDisplayName(parsed.data.practiceDisplayName)
  await logAudit(session, `set practice display name to "${parsed.data.practiceDisplayName}"`, null)
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 6: `src/components/settings/PracticeNameEditor.tsx`**

Mirrors `AutoClassifyToggle`'s local-state-plus-fetch pattern exactly, but for a text field instead of a boolean.

```typescript
'use client'
import { useState } from 'react'

export function PracticeNameEditor({ initialName, isAdmin }: { initialName: string; isAdmin: boolean }) {
  const [name, setName] = useState(initialName)
  const [draft, setDraft] = useState(initialName)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    const trimmed = draft.trim()
    if (trimmed.length === 0) { setError('Practice name is required'); return }
    setSaving(true)
    setError(null)
    const res = await fetch('/api/settings/practice', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ practiceDisplayName: trimmed }),
    })
    setSaving(false)
    if (res.ok) {
      setName(trimmed)
      setEditing(false)
    } else {
      setError('Could not save — please try again')
    }
  }

  if (!editing) {
    return (
      <div className="flex items-center justify-between text-sm">
        <span className="text-foreground">{name}</span>
        {isAdmin && (
          <button onClick={() => { setDraft(name); setEditing(true) }} className="text-xs font-semibold text-primary hover:underline">
            Edit
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <button onClick={save} disabled={saving} className="rounded-md bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground disabled:opacity-50">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={() => setEditing(false)} disabled={saving} className="rounded-md bg-secondary px-3 py-1 text-xs font-semibold text-muted-foreground disabled:opacity-50">
          Cancel
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 7: Test**

`tests/api/settings-practice.test.ts`:

```typescript
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import * as auth from '@/lib/auth'
import { getAppSettings } from '@/lib/queries/settings'
import { updatePracticeDisplayName } from '@/lib/queries/settings'
import { PUT as putPractice } from '@/app/api/settings/practice/route'

const UNAUTHORIZED = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: 'admin' as const, name: 'Test Admin' })) }
})

let originalName = ''

beforeAll(async () => {
  originalName = (await getAppSettings()).practiceDisplayName
})

afterAll(async () => {
  await updatePracticeDisplayName(originalName)
})

describe('PUT /api/settings/practice', () => {
  it('returns 401 when there is no authenticated session', async () => {
    vi.mocked(auth.requireSession).mockResolvedValueOnce(UNAUTHORIZED())
    const req = new NextRequest('http://localhost/api/settings/practice', { method: 'PUT', body: JSON.stringify({ practiceDisplayName: 'X' }) })
    const res = await putPractice(req)
    expect(res.status).toBe(401)
  })

  it('returns 403 for a non-admin role', async () => {
    vi.mocked(auth.requireSession).mockResolvedValueOnce({ role: 'crc', name: 'Test CRC' })
    const req = new NextRequest('http://localhost/api/settings/practice', { method: 'PUT', body: JSON.stringify({ practiceDisplayName: 'X' }) })
    const res = await putPractice(req)
    expect(res.status).toBe(403)
  })

  it('rejects an empty name', async () => {
    const req = new NextRequest('http://localhost/api/settings/practice', { method: 'PUT', body: JSON.stringify({ practiceDisplayName: '  ' }) })
    const res = await putPractice(req)
    expect(res.status).toBe(400)
  })

  it('rejects an unknown field (.strict())', async () => {
    const req = new NextRequest('http://localhost/api/settings/practice', { method: 'PUT', body: JSON.stringify({ practiceDisplayName: 'X', extra: 1 }) })
    const res = await putPractice(req)
    expect(res.status).toBe(400)
  })

  it('updates the practice display name for an admin', async () => {
    const req = new NextRequest('http://localhost/api/settings/practice', { method: 'PUT', body: JSON.stringify({ practiceDisplayName: 'Redlands Test Practice' }) })
    const res = await putPractice(req)
    expect(res.status).toBe(200)
    expect((await getAppSettings()).practiceDisplayName).toBe('Redlands Test Practice')
  })
})
```

- [ ] **Step 8: Run the suite and commit**

Run: `npm test` and `npm run build` — both must be clean.

```bash
git add src/db/schema.ts src/db/seed.ts src/lib/queries/settings.ts src/app/api/settings/practice/route.ts src/components/settings/PracticeNameEditor.tsx tests/api/settings-practice.test.ts
git commit -m "feat: add practice display name to appSettings with admin-only editor"
```

---

### Task 2: Wire practice display name into TopBanner

**Files:**
- Modify: `src/components/TopBanner.tsx`
- Modify: `src/app/(dashboard)/layout.tsx`
- Modify: `tests/components/TopBanner.test.tsx`

**Interfaces:**
- Consumes: `getAppSettings()` (Task 1).
- Produces: `TopBanner` gains a required `practiceName: string` prop — the one other place that renders it (`layout.tsx`) is updated in the same task, so this is not a breaking change left dangling.

- [ ] **Step 1: `src/components/TopBanner.tsx`**

The current file:

```typescript
export function TopBanner({ environment, userName }: { environment: 'pilot' | 'production'; userName: string }) {
  return (
    <div className="border-b border-border bg-card">
      <div className="bg-amber-50 px-4 py-1 text-center text-xs font-semibold text-amber-800">
        {environment === 'pilot' ? 'PILOT / DEMO — NO REAL PATIENT DATA' : 'PRODUCTION'}
      </div>
      <div className="flex items-center justify-between px-6 py-3">
        <span className="text-base font-semibold tracking-tight text-foreground">Clinsync</span>
        <span className="text-sm font-medium text-foreground">{userName}</span>
      </div>
    </div>
  )
}
```

Change it to (product name "Clinsync" stays — that's the software, not the tenant; the practice name is shown alongside it, matching Tebra's own global header convention of showing both the product chrome and the logged-in practice's name per the screenshot catalog):

```typescript
export function TopBanner({ environment, userName, practiceName }: { environment: 'pilot' | 'production'; userName: string; practiceName: string }) {
  return (
    <div className="border-b border-border bg-card">
      <div className="bg-amber-50 px-4 py-1 text-center text-xs font-semibold text-amber-800">
        {environment === 'pilot' ? 'PILOT / DEMO — NO REAL PATIENT DATA' : 'PRODUCTION'}
      </div>
      <div className="flex items-center justify-between px-6 py-3">
        <div className="flex items-baseline gap-2">
          <span className="text-base font-semibold tracking-tight text-foreground">Clinsync</span>
          <span className="text-sm text-muted-foreground">{practiceName}</span>
        </div>
        <span className="text-sm font-medium text-foreground">{userName}</span>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: `src/app/(dashboard)/layout.tsx`**

The current file:

```typescript
import { getSession } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { TopBanner } from '@/components/TopBanner'
import { LeftNav } from '@/components/LeftNav'
import { SessionTimeoutWarning } from '@/components/SessionTimeoutWarning'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session) redirect('/login')

  return (
    <div className="flex min-h-screen flex-col">
      <SessionTimeoutWarning />
      <TopBanner environment="pilot" userName={session.name} />
      <div className="flex flex-1">
        <LeftNav />
        <main className="flex-1 overflow-auto p-6">{children}</main>
      </div>
    </div>
  )
}
```

Change it to:

```typescript
import { getSession } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { TopBanner } from '@/components/TopBanner'
import { LeftNav } from '@/components/LeftNav'
import { SessionTimeoutWarning } from '@/components/SessionTimeoutWarning'
import { getAppSettings } from '@/lib/queries/settings'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session) redirect('/login')

  const settings = await getAppSettings()

  return (
    <div className="flex min-h-screen flex-col">
      <SessionTimeoutWarning />
      <TopBanner environment="pilot" userName={session.name} practiceName={settings.practiceDisplayName} />
      <div className="flex flex-1">
        <LeftNav />
        <main className="flex-1 overflow-auto p-6">{children}</main>
      </div>
    </div>
  )
}
```

(This layout deliberately calls `getSession()`, not `requireSessionOrRedirect()` — that's the existing, unchanged behavior: the layout's own redirect isn't the security boundary, per the comment in `src/lib/auth.ts`; each page underneath independently calls `requireSessionOrRedirect()`. Nothing about that changes here.)

- [ ] **Step 3: Update the existing TopBanner test**

`tests/components/TopBanner.test.tsx` currently renders `<TopBanner environment="pilot" userName="Jamie Ruiz" />` with no `practiceName` — since the prop is now required, update both existing calls and add one assertion:

```typescript
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TopBanner } from '@/components/TopBanner'

describe('TopBanner', () => {
  it('always shows the pilot/demo watermark', () => {
    render(<TopBanner environment="pilot" userName="Jamie Ruiz" practiceName="Inland Psychiatric Medical Group" />)
    expect(screen.getByText(/PILOT.*DEMO.*NO REAL PATIENT DATA/i)).toBeInTheDocument()
  })
  it('shows the signed-in user name', () => {
    render(<TopBanner environment="pilot" userName="Jamie Ruiz" practiceName="Inland Psychiatric Medical Group" />)
    expect(screen.getByText('Jamie Ruiz')).toBeInTheDocument()
  })
  it('shows the practice display name', () => {
    render(<TopBanner environment="pilot" userName="Jamie Ruiz" practiceName="Inland Psychiatric Medical Group" />)
    expect(screen.getByText('Inland Psychiatric Medical Group')).toBeInTheDocument()
  })
})
```

- [ ] **Step 4: Run the suite and commit**

Run: `npm test` and `npm run build` — both must be clean.

```bash
git add src/components/TopBanner.tsx src/app/\(dashboard\)/layout.tsx tests/components/TopBanner.test.tsx
git commit -m "feat: show practice display name in TopBanner"
```

---

### Task 3: Provider Profiles data layer + API route

**Cross-phase dependency — read before starting:** This task assumes Phase 2's plan (`docs/superpowers/plans/2026-09-17-phase2-scheduling.md`) defines, at minimum:

```typescript
export const providers = pgTable('providers', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  // ...whatever other columns Phase 2 owns (specialty, NPI, active flag, etc.)
})
```

Before writing any code below, open the live `src/db/schema.ts` and confirm the actual `providers` table's primary key type and name column. If Phase 2 used a `text` primary key (e.g. a slug) instead of `serial`, change every `id: number` / `Number(id)` below to `id: string` and drop the `Number()` parse + its guard clause. Nothing else in this task touches any other Phase-2-owned column — the Provider Profiles feature only ever reads `id`/`name` and writes `name`.

**Files:**
- Create: `src/lib/queries/providers.ts`
- Create: `src/app/api/providers/[id]/route.ts` (PUT, admin-only, name only)
- Test: `tests/api/providers.test.ts`

**Interfaces:**
- Consumes: `providers` table (Phase 2).
- Produces: `listProviders()`, `updateProviderName(id, name)` (consumed by Task 5's Provider Profiles panel).

- [ ] **Step 1: `src/lib/queries/providers.ts`**

```typescript
import { getDb } from '@/db/client'
import { providers } from '@/db/schema'
import { eq } from 'drizzle-orm'

/**
 * Shared by the /api/providers/[id] route handler and the Settings >
 * Provider Profiles panel — see the comment on `listPatientsWithStatus` in
 * `src/lib/queries/patients.ts` for why Server Components must call this
 * directly rather than fetching the app's own API route.
 */
export async function listProviders() {
  return getDb().select().from(providers)
}

/** Name-only update — Provider Profiles here is a lightweight roster editor, not a full Phase 2 provider-management form. */
export async function updateProviderName(id: number, name: string) {
  const [updated] = await getDb().update(providers).set({ name }).where(eq(providers.id, id)).returning()
  return updated ?? null
}
```

- [ ] **Step 2: `src/app/api/providers/[id]/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { updateProviderName } from '@/lib/queries/providers'

const providerUpdateSchema = z.object({ name: z.string().trim().min(1, 'Name is required').max(200) }).strict()

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })

  const { id } = await params
  const providerId = Number(id)
  if (!Number.isInteger(providerId)) return NextResponse.json({ error: 'Invalid provider id' }, { status: 400 })

  const parsed = providerUpdateSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 400 })

  const updated = await updateProviderName(providerId, parsed.data.name)
  if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await logAudit(session, `renamed provider ${providerId} to "${parsed.data.name}"`, null)
  return NextResponse.json({ provider: updated })
}
```

- [ ] **Step 3: Test**

This test is self-contained (inserts and cleans up its own provider row) so it does not depend on whatever Phase 2's seed script happens to populate:

`tests/api/providers.test.ts`:

```typescript
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import * as auth from '@/lib/auth'
import { getDb } from '@/db/client'
import { providers } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { PUT as putProvider } from '@/app/api/providers/[id]/route'

const UNAUTHORIZED = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: 'admin' as const, name: 'Test Admin' })) }
})

let testProviderId: number

beforeAll(async () => {
  const [row] = await getDb().insert(providers).values({ name: 'Dr. Test Provider' }).returning()
  testProviderId = row.id
})

afterAll(async () => {
  await getDb().delete(providers).where(eq(providers.id, testProviderId))
})

describe('PUT /api/providers/[id]', () => {
  it('returns 401 when there is no authenticated session', async () => {
    vi.mocked(auth.requireSession).mockResolvedValueOnce(UNAUTHORIZED())
    const req = new NextRequest('http://localhost/api/providers/1', { method: 'PUT', body: JSON.stringify({ name: 'X' }) })
    const res = await putProvider(req, { params: Promise.resolve({ id: String(testProviderId) }) })
    expect(res.status).toBe(401)
  })

  it('returns 403 for a non-admin role', async () => {
    vi.mocked(auth.requireSession).mockResolvedValueOnce({ role: 'pi', name: 'Test PI' })
    const req = new NextRequest('http://localhost/api/providers/1', { method: 'PUT', body: JSON.stringify({ name: 'X' }) })
    const res = await putProvider(req, { params: Promise.resolve({ id: String(testProviderId) }) })
    expect(res.status).toBe(403)
  })

  it('returns 404 for an unknown provider id', async () => {
    const req = new NextRequest('http://localhost/api/providers/999999', { method: 'PUT', body: JSON.stringify({ name: 'X' }) })
    const res = await putProvider(req, { params: Promise.resolve({ id: '999999' }) })
    expect(res.status).toBe(404)
  })

  it('rejects an empty name', async () => {
    const req = new NextRequest('http://localhost/api/providers/1', { method: 'PUT', body: JSON.stringify({ name: '' }) })
    const res = await putProvider(req, { params: Promise.resolve({ id: String(testProviderId) }) })
    expect(res.status).toBe(400)
  })

  it('renames a provider for an admin', async () => {
    const req = new NextRequest('http://localhost/api/providers/1', { method: 'PUT', body: JSON.stringify({ name: 'Dr. Renamed Provider' }) })
    const res = await putProvider(req, { params: Promise.resolve({ id: String(testProviderId) }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.provider.name).toBe('Dr. Renamed Provider')
  })
})
```

- [ ] **Step 4: Run the suite and commit**

Run: `npm test` and `npm run build` — both must be clean.

```bash
git add src/lib/queries/providers.ts src/app/api/providers/\[id\]/route.ts tests/api/providers.test.ts
git commit -m "feat: add Provider Profiles data layer and admin-only rename API"
```

---

### Task 4: User Settings panel content + shared role-capability copy

**Files:**
- Create: `src/lib/role-capabilities.ts`
- Test: `tests/lib/role-capabilities.test.ts`

**Interfaces:**
- Consumes: `Role` type (`src/lib/auth.ts`).
- Produces: `ROLE_CAPABILITIES: Record<Role, { label: string; summary: string; bullets: string[] }>`, consumed by Task 5's User Settings and My Account panels.

This is a small, standalone task specifically so the capability copy has one canonical source both panels read from, rather than the same strings duplicated inline in two places.

- [ ] **Step 1: `src/lib/role-capabilities.ts`**

Sourced only from what's actually true in the codebase today: the three demo roles from `src/lib/auth.ts`'s `Role` type and `src/app/login/page.tsx`'s `DEMO_USERS`, and the role-gated behavior this plan and Phase 1 Task 8 actually introduce (auto-classify toggle, practice name edit, provider rename — all admin-only). Nothing here is aspirational or describes a permission that doesn't exist in the code.

```typescript
import type { Role } from '@/lib/auth'

export const ROLE_CAPABILITIES: Record<Role, { label: string; summary: string; bullets: string[] }> = {
  crc: {
    label: 'Clinical Research Coordinator',
    summary: 'Runs day-to-day pre-screening: reviews patients, resolves identity matches, and exports the workbook.',
    bullets: [
      'View and search the Patients workbook across all trials',
      'Review and confirm/reject Identity Matching Queue candidates',
      'View Trials & Protocols and their eligibility criteria',
      'Export the Excel pre-screening workbook',
      'View the Audit Log',
    ],
  },
  pi: {
    label: 'Principal Investigator',
    summary: 'Same operational access as a Research Coordinator today, used to make clinical eligibility calls from the evidence Clinsync surfaces.',
    bullets: [
      'View and search the Patients workbook across all trials',
      'Review and confirm/reject Identity Matching Queue candidates',
      'View Trials & Protocols and their eligibility criteria',
      'Export the Excel pre-screening workbook',
      'View the Audit Log',
    ],
  },
  admin: {
    label: 'Admin / IT',
    summary: 'Everything a Coordinator or Investigator can do, plus the practice-level settings only Admin can change.',
    bullets: [
      'Everything listed under Clinical Research Coordinator',
      'Toggle automatic classification on form completion (Settings > Classification)',
      'Edit the practice display name (Settings > Practice Information)',
      'Rename Provider Profiles (Settings > Provider Profiles)',
    ],
  },
}
```

- [ ] **Step 2: Test**

`tests/lib/role-capabilities.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { ROLE_CAPABILITIES } from '@/lib/role-capabilities'

describe('ROLE_CAPABILITIES', () => {
  it('covers exactly the three demo roles', () => {
    expect(Object.keys(ROLE_CAPABILITIES).sort()).toEqual(['admin', 'crc', 'pi'])
  })

  it('only admin lists the practice-settings and provider-rename capabilities', () => {
    expect(ROLE_CAPABILITIES.admin.bullets.some((b) => /practice display name/i.test(b))).toBe(true)
    expect(ROLE_CAPABILITIES.crc.bullets.some((b) => /practice display name/i.test(b))).toBe(false)
    expect(ROLE_CAPABILITIES.pi.bullets.some((b) => /practice display name/i.test(b))).toBe(false)
  })
})
```

- [ ] **Step 3: Run the suite and commit**

Run: `npm test` and `npm run build` — both must be clean.

```bash
git add src/lib/role-capabilities.ts tests/lib/role-capabilities.test.ts
git commit -m "feat: add shared role-capability summary for Settings"
```

---

### Task 5: Settings hub assembly — SettingsSubNav + rewritten Settings page

**Files:**
- Create: `src/components/settings/ProviderProfilesPanel.tsx` (`'use client'`)
- Create: `src/components/settings/SettingsSubNav.tsx` (`'use client'`)
- Modify: `src/app/(dashboard)/settings/page.tsx`
- Modify: `src/lib/queries/trials.ts` (add `listDistinctSites`)
- Test: `tests/lib/queries-trials-sites.test.ts`
- Test: `tests/app/settings-page.test.tsx`

**Interfaces:**
- Consumes: `getAppSettings` (Task 1), `PracticeNameEditor` (Task 1), `listProviders`/`updateProviderName`'s route (Task 3), `ROLE_CAPABILITIES` (Task 4), `listAllTrials`/`AutoClassifyToggle`/`getAppSettings` (Phase 1 Task 8).
- Produces: the assembled `/settings` page.

**Before starting:** confirm the live `src/app/(dashboard)/settings/page.tsx` matches Phase 1 Task 8's final shape (Compliance section, Classification section with `AutoClassifyToggle`, `getAppSettings()` fetched alongside `session`). If Phase 1 shipped something that differs cosmetically (different wrapper class names, slightly different copy), keep that page's actual Compliance/Classification content and classes verbatim when moving them into `SettingsSubNav` below — only their container changes (flat `<section>` stack → `TabsContent` panel), not their text or styling.

- [ ] **Step 1: `src/lib/queries/trials.ts` — add `listDistinctSites`**

The current file:

```typescript
import { getDb } from '@/db/client'
import { trials } from '@/db/schema'

export type Trial = typeof trials.$inferSelect

/** See the comment in `queries/patients.ts` — shared by the API route and Server Components alike. */
export async function listAllTrials(): Promise<Trial[]> {
  return getDb().select().from(trials)
}
```

Add, without touching `listAllTrials`:

```typescript
/** Distinct trial site values, for read-only display in the Practice Information settings panel. Derives from `listAllTrials()` rather than a separate query — `trials` is a small table and this avoids a second round-trip. */
export async function listDistinctSites(): Promise<string[]> {
  const all = await listAllTrials()
  return Array.from(new Set(all.map((t) => t.site))).sort()
}
```

- [ ] **Step 2: `src/components/settings/ProviderProfilesPanel.tsx`**

```typescript
'use client'
import { useState } from 'react'

type Provider = { id: number; name: string }

function ProviderEditRow({ provider, isAdmin, index }: { provider: Provider; isAdmin: boolean; index: number }) {
  const [name, setName] = useState(provider.name)
  const [draft, setDraft] = useState(provider.name)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    const trimmed = draft.trim()
    if (trimmed.length === 0) { setError('Name is required'); return }
    setSaving(true)
    setError(null)
    const res = await fetch(`/api/providers/${provider.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmed }),
    })
    setSaving(false)
    if (res.ok) {
      setName(trimmed)
      setEditing(false)
    } else {
      setError('Could not save — please try again')
    }
  }

  return (
    <tr className={`border-b border-border ${index % 2 === 1 ? 'bg-muted/40' : ''}`}>
      <td className="p-3 text-foreground">
        {editing ? (
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="h-8 w-full max-w-xs rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        ) : (
          name
        )}
        {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      </td>
      <td className="p-3 text-right">
        {!isAdmin ? null : editing ? (
          <div className="flex justify-end gap-2">
            <button onClick={save} disabled={saving} className="rounded-md bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground disabled:opacity-50">
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => { setEditing(false); setDraft(name); setError(null) }} disabled={saving} className="rounded-md bg-secondary px-3 py-1 text-xs font-semibold text-muted-foreground disabled:opacity-50">
              Cancel
            </button>
          </div>
        ) : (
          <button onClick={() => setEditing(true)} className="text-xs font-semibold text-primary hover:underline">
            Manage
          </button>
        )}
      </td>
    </tr>
  )
}

export function ProviderProfilesPanel({ providers, isAdmin }: { providers: Provider[]; isAdmin: boolean }) {
  if (providers.length === 0) {
    return <p className="text-sm text-muted-foreground">No providers on file.</p>
  }
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-border text-left">
          <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Name</th>
          <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground text-right">Action</th>
        </tr>
      </thead>
      <tbody>
        {providers.map((p, i) => <ProviderEditRow key={p.id} provider={p} isAdmin={isAdmin} index={i} />)}
      </tbody>
    </table>
  )
}
```

- [ ] **Step 3: `src/components/settings/SettingsSubNav.tsx`**

This is the top-level assembly component. It receives every panel's already-fetched data as props from the Server Component page (Step 4) and renders the vertical `Tabs` sub-nav plus all six panels. The Compliance and Classification panels' JSX/copy are moved here verbatim from the pre-Phase-6 `settings/page.tsx` — see the "before starting" note above if the live file's copy differs from what's shown below.

```typescript
'use client'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { AutoClassifyToggle } from '@/components/AutoClassifyToggle'
import { PracticeNameEditor } from '@/components/settings/PracticeNameEditor'
import { ProviderProfilesPanel } from '@/components/settings/ProviderProfilesPanel'
import { ROLE_CAPABILITIES } from '@/lib/role-capabilities'
import type { Role } from '@/lib/auth'

type Provider = { id: number; name: string }

export function SettingsSubNav({
  session,
  practiceDisplayName,
  sites,
  providers,
  autoClassifyOnComplete,
}: {
  session: { name: string; role: Role }
  practiceDisplayName: string
  sites: string[]
  providers: Provider[]
  autoClassifyOnComplete: boolean
}) {
  const isAdmin = session.role === 'admin'
  const own = ROLE_CAPABILITIES[session.role]

  return (
    <Tabs defaultValue="practice" orientation="vertical" className="flex-row items-start gap-6">
      <TabsList className="h-fit w-48 shrink-0 flex-col items-stretch bg-transparent p-0">
        <TabsTrigger value="practice" className="justify-start">Practice Information</TabsTrigger>
        <TabsTrigger value="providers" className="justify-start">Provider Profiles</TabsTrigger>
        <TabsTrigger value="users" className="justify-start">User Settings</TabsTrigger>
        <TabsTrigger value="account" className="justify-start">My Account</TabsTrigger>
        <TabsTrigger value="compliance" className="justify-start">Compliance</TabsTrigger>
        <TabsTrigger value="classification" className="justify-start">Classification</TabsTrigger>
      </TabsList>

      <div className="min-w-0 flex-1 space-y-6">
        <TabsContent value="practice">
          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Practice Name</h2>
            <PracticeNameEditor initialName={practiceDisplayName} isAdmin={isAdmin} />
          </section>
          <section className="mt-6 rounded-lg border border-border bg-card p-5">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Site(s) in Use</h2>
            {sites.length === 0 ? (
              <p className="text-sm text-muted-foreground">No trial sites on file.</p>
            ) : (
              <ul className="space-y-1 text-sm text-foreground">
                {sites.map((s) => <li key={s}>{s}</li>)}
              </ul>
            )}
          </section>
        </TabsContent>

        <TabsContent value="providers">
          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Provider Profiles</h2>
            <ProviderProfilesPanel providers={providers} isAdmin={isAdmin} />
          </section>
        </TabsContent>

        <TabsContent value="users">
          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="mb-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Roles &amp; Capabilities</h2>
            <div className="space-y-5">
              {(Object.keys(ROLE_CAPABILITIES) as Role[]).map((role) => {
                const cap = ROLE_CAPABILITIES[role]
                return (
                  <div key={role}>
                    <p className="text-sm font-semibold text-foreground">{cap.label}</p>
                    <p className="mb-2 text-sm text-muted-foreground">{cap.summary}</p>
                    <ul className="list-disc space-y-1 pl-5 text-sm text-foreground">
                      {cap.bullets.map((b) => <li key={b}>{b}</li>)}
                    </ul>
                  </div>
                )
              })}
            </div>
          </section>
        </TabsContent>

        <TabsContent value="account">
          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">My Account</h2>
            <p className="text-sm text-foreground">{session.name}</p>
            <p className="mb-3 text-sm text-muted-foreground">{own.label}</p>
            <p className="text-sm text-muted-foreground">{own.summary}</p>
          </section>
        </TabsContent>

        <TabsContent value="compliance">
          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Compliance</h2>
            <p className="text-sm">BAA status: <span className="font-medium text-amber-800">Pending signature (demo placeholder)</span></p>
            <p className="text-sm">Environment: Pilot / Demo</p>
          </section>
        </TabsContent>

        <TabsContent value="classification">
          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Classification</h2>
            <AutoClassifyToggle initialEnabled={autoClassifyOnComplete} isAdmin={isAdmin} />
          </section>
        </TabsContent>
      </div>
    </Tabs>
  )
}
```

- [ ] **Step 4: Rewrite `src/app/(dashboard)/settings/page.tsx`**

```typescript
import { requireSessionOrRedirect } from '@/lib/auth'
import { getAppSettings } from '@/lib/queries/settings'
import { listDistinctSites } from '@/lib/queries/trials'
import { listProviders } from '@/lib/queries/providers'
import { SettingsSubNav } from '@/components/settings/SettingsSubNav'

export default async function SettingsPage() {
  // Must be the first statement — see the comment in patients/page.tsx.
  const session = await requireSessionOrRedirect()

  const [settings, sites, providers] = await Promise.all([
    getAppSettings(),
    listDistinctSites(),
    listProviders(),
  ])

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-foreground">Settings</h1>
      <SettingsSubNav
        session={{ name: session.name, role: session.role }}
        practiceDisplayName={settings.practiceDisplayName}
        sites={sites}
        providers={providers}
        autoClassifyOnComplete={settings.autoClassifyOnComplete}
      />
    </div>
  )
}
```

- [ ] **Step 5: Test — `listDistinctSites`**

`tests/lib/queries-trials-sites.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { listDistinctSites } from '@/lib/queries/trials'

describe('listDistinctSites', () => {
  it('returns each seeded trial site exactly once', async () => {
    const sites = await listDistinctSites()
    expect(sites).toContain('Redlands')
    expect(new Set(sites).size).toBe(sites.length)
  })
})
```

- [ ] **Step 6: Test — Settings page renders without crashing for each role**

`tests/app/settings-page.test.tsx` follows the existing pattern in `tests/app/page.test.tsx` (rendering an async Server Component directly and awaiting the returned element).

```typescript
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import * as auth from '@/lib/auth'
import SettingsPage from '@/app/(dashboard)/settings/page'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSessionOrRedirect: vi.fn(async () => ({ role: 'admin' as const, name: 'Test Admin' })) }
})

describe('SettingsPage', () => {
  it('renders the sub-nav and all six section labels for an admin session', async () => {
    const element = await SettingsPage()
    render(element)
    expect(screen.getByText('Practice Information')).toBeInTheDocument()
    expect(screen.getByText('Provider Profiles')).toBeInTheDocument()
    expect(screen.getByText('User Settings')).toBeInTheDocument()
    expect(screen.getByText('My Account')).toBeInTheDocument()
    expect(screen.getByText('Compliance')).toBeInTheDocument()
    expect(screen.getByText('Classification')).toBeInTheDocument()
  })

  it('renders for a non-admin (crc) session without the admin-only edit controls surfacing an error', async () => {
    vi.mocked(auth.requireSessionOrRedirect).mockResolvedValueOnce({ role: 'crc', name: 'Test CRC' })
    const element = await SettingsPage()
    render(element)
    expect(screen.getByText('Practice Information')).toBeInTheDocument()
  })
})
```

- [ ] **Step 7: Run the suite and commit**

Run: `npm test` and `npm run build` — both must be clean.

```bash
git add src/components/settings/ProviderProfilesPanel.tsx src/components/settings/SettingsSubNav.tsx src/app/\(dashboard\)/settings/page.tsx src/lib/queries/trials.ts tests/lib/queries-trials-sites.test.ts tests/app/settings-page.test.tsx
git commit -m "feat: assemble sectioned Settings hub (Practice Information, Provider Profiles, User Settings, My Account, Compliance, Classification)"
```

---

### Task 6: Final LeftNav consolidation + Final QA

This is the one task in this plan that cannot be written as a fixed diff against known content — `src/components/LeftNav.tsx` grows across Phases 1–5, and this plan was written before any of those phases executed. Do not skip the read step below.

**Files:**
- Modify: `src/components/LeftNav.tsx`
- Test: `tests/components/leftnav.test.tsx` (new — the current codebase has no LeftNav test; if one now exists from an earlier phase, extend it instead of replacing it)

**Interfaces:**
- Consumes: whatever `src/components/LeftNav.tsx` looks like at execution time.
- Produces: the final, consolidated `ITEMS` structure described below — this is the last phase, so this is also the last time this file changes in the whole platform-phases effort.

- [ ] **Step 1: Read the current file**

Open `src/components/LeftNav.tsx` as it actually exists right now (after Phases 1–5). List every `href`/`label` pair it currently contains. Phases 1–5 were each instructed (architecture spec §5) to append their own entries in the position given below and not reorder anything else — but verify that held; if any phase's entry drifted from the order below, this task corrects it.

- [ ] **Step 2: Produce this final order**

Rebuild the nav to match this order exactly, using the **actual routes each phase's own plan created** (the hrefs below are this plan's best-known assumption per the phase map in the architecture spec — if a phase named its route differently than assumed here, use the real route and keep only the order/grouping):

1. Home — `/` (Phase 1's Home Dashboard; if Phase 1 mounted it at a different path than `/`, e.g. `/dashboard`, use that path)
2. Patients — `/patients` (existing)
3. Identity Matching — `/identity-matching` (existing)
4. Trials & Protocols — `/trials` (existing)
5. Calendar — `/calendar` (Phase 2)
6. Form Templates — `/form-templates` (Phase 1)
7. Client Forms — `/client-forms` (Phase 1)
8. Billing — collapsible group (Phase 3), children in this order:
   - Charges — `/billing/charges`
   - Insurance Collections — `/billing/insurance-collections`
   - Patient Collections — `/billing/patient-collections`
   - Statements — `/billing/statements`
   - A/R Dashboard — `/billing/ar-dashboard`
   - Analytics — `/billing/analytics`
9. Reports — `/reports` (Phase 4)
10. Documents — `/documents` (Phase 4)
11. Engagement — `/engagement` (Phase 5)
12. Audit Log — `/audit-log` (existing)
13. Settings — `/settings` (existing, expanded by this phase — stays a single flat link; the sub-nav lives inside the page itself per Task 5, not in `LeftNav`)

Implement Billing as a collapsible group (client-side expand/collapse state, no new dependency — `LeftNav` is already `'use client'`). Every other entry stays a flat, single-level link, consistent with Key Decision 5 above.

```typescript
'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'

type NavItem = { href: string; label: string } | { label: string; children: { href: string; label: string }[] }

const ITEMS: NavItem[] = [
  { href: '/', label: 'Home' },
  { href: '/patients', label: 'Patients' },
  { href: '/identity-matching', label: 'Identity Matching' },
  { href: '/trials', label: 'Trials & Protocols' },
  { href: '/calendar', label: 'Calendar' },
  { href: '/form-templates', label: 'Form Templates' },
  { href: '/client-forms', label: 'Client Forms' },
  {
    label: 'Billing',
    children: [
      { href: '/billing/charges', label: 'Charges' },
      { href: '/billing/insurance-collections', label: 'Insurance Collections' },
      { href: '/billing/patient-collections', label: 'Patient Collections' },
      { href: '/billing/statements', label: 'Statements' },
      { href: '/billing/ar-dashboard', label: 'A/R Dashboard' },
      { href: '/billing/analytics', label: 'Analytics' },
    ],
  },
  { href: '/reports', label: 'Reports' },
  { href: '/documents', label: 'Documents' },
  { href: '/engagement', label: 'Engagement' },
  { href: '/audit-log', label: 'Audit Log' },
  { href: '/settings', label: 'Settings' },
]

function isActive(pathname: string | null, href: string) {
  return pathname === href || (href !== '/' && (pathname?.startsWith(`${href}/`) ?? false))
}

function NavLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`block rounded-md border-l-2 py-2 pe-3 ps-2.5 text-sm font-medium transition-colors ${
        active
          ? 'border-sidebar-ring bg-sidebar-accent text-sidebar-accent-foreground'
          : 'border-transparent text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
      }`}
    >
      {label}
    </Link>
  )
}

export function LeftNav() {
  const pathname = usePathname()
  const [billingOpen, setBillingOpen] = useState(pathname?.startsWith('/billing') ?? false)

  return (
    <nav className="w-56 shrink-0 bg-sidebar p-4">
      <ul className="space-y-1">
        {ITEMS.map((item) => {
          if ('children' in item) {
            const groupActive = item.children.some((c) => isActive(pathname, c.href))
            return (
              <li key={item.label}>
                <button
                  type="button"
                  onClick={() => setBillingOpen((v) => !v)}
                  aria-expanded={billingOpen}
                  className={`flex w-full items-center justify-between rounded-md border-l-2 py-2 pe-3 ps-2.5 text-left text-sm font-medium transition-colors ${
                    groupActive
                      ? 'border-sidebar-ring bg-sidebar-accent text-sidebar-accent-foreground'
                      : 'border-transparent text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                  }`}
                >
                  <span>{item.label}</span>
                  <span aria-hidden="true">{billingOpen ? '−' : '+'}</span>
                </button>
                {billingOpen && (
                  <ul className="mt-1 space-y-1 ps-4">
                    {item.children.map((c) => (
                      <li key={c.href}><NavLink href={c.href} label={c.label} active={isActive(pathname, c.href)} /></li>
                    ))}
                  </ul>
                )}
              </li>
            )
          }
          return <li key={item.href}><NavLink href={item.href} label={item.label} active={isActive(pathname, item.href)} /></li>
        })}
      </ul>
    </nav>
  )
}
```

(The `+`/`−` disclosure marker is a plain text glyph, not an icon-library glyph, in keeping with "zero decorative icons" — it is also not purely decorative, since it's the only visible affordance that the row is expandable/collapsible, same justification `StatusChip`'s dot uses for being `aria-hidden` while the adjacent text carries the real meaning; here the button's `aria-expanded` carries the accessible state.)

- [ ] **Step 3: Test**

`tests/components/leftnav.test.tsx`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { LeftNav } from '@/components/LeftNav'

vi.mock('next/navigation', () => ({ usePathname: () => '/patients' }))

describe('LeftNav', () => {
  it('renders every top-level entry in the final consolidated order', () => {
    render(<LeftNav />)
    const labels = ['Home', 'Patients', 'Identity Matching', 'Trials & Protocols', 'Calendar', 'Form Templates', 'Client Forms', 'Billing', 'Reports', 'Documents', 'Engagement', 'Audit Log', 'Settings']
    for (const label of labels) expect(screen.getByText(label)).toBeInTheDocument()
  })

  it('Billing children are collapsed by default when not on a /billing route', () => {
    render(<LeftNav />)
    expect(screen.queryByText('Charges')).not.toBeInTheDocument()
  })

  it('expands Billing children on click', () => {
    render(<LeftNav />)
    fireEvent.click(screen.getByText('Billing'))
    expect(screen.getByText('Charges')).toBeInTheDocument()
    expect(screen.getByText('A/R Dashboard')).toBeInTheDocument()
  })
})
```

- [ ] **Step 4: Run the suite and commit**

Run: `npm test` and `npm run build` — both must be clean.

```bash
git add src/components/LeftNav.tsx tests/components/leftnav.test.tsx
git commit -m "feat: final LeftNav consolidation across all six phases"
```

- [ ] **Step 5: Final QA pass (whole plan)**

With Tasks 1–6 committed, run the full suite once more end-to-end and do a manual pass through the app as each of the three demo roles (crc / pi / admin) confirming:

- `/settings` shows all six sub-nav sections for every role; Practice Information's Edit and Provider Profiles' Manage controls only render for `admin`.
- Editing the practice name updates the name shown in `TopBanner` on the next page load.
- Renaming a provider persists and shows up in the Audit Log.
- `LeftNav`'s order matches Task 6 Step 2 exactly on every page, and Billing expands/collapses correctly.
- No console errors, no hydration warnings.

```bash
npm test
npm run build
```

No new commit is required for this step alone if it surfaces no fixes — it is a verification gate, not a code change. If it does surface a fix, make that fix as its own small commit before considering the plan done.

---

## Self-Review

**Placeholder scan:** every code block in this plan is complete — no `// TODO`, no `...`, no `<placeholder>` left in any file's contents. The one place this plan intentionally does not give a fixed diff is Task 6 Step 1–2 (LeftNav), which is explicitly instructed as "read current state, then produce this order" per the assignment's own requirement, not a placeholder.

**Type/interface consistency check:**
- `getAppSettings()`'s fallback object (Task 1 Step 4) includes `practiceDisplayName` so its return type stays a single consistent shape whether or not a row exists yet — nothing downstream (`layout.tsx`, `SettingsSubNav`) needs an optional-chaining branch for a field that might be missing.
- `ProviderProfilesPanel`'s `Provider` type (`{ id: number; name: string }`) matches `updateProviderName`'s signature in `src/lib/queries/providers.ts` and the route's `Number(id)` parsing — all three assume Phase 2's `providers.id` is a `serial` integer. This is the one type assumption flagged for reconciliation below.
- `SettingsSubNav`'s props are all plain serializable data (`string`, `string[]`, `{id:number,name:string}[]`, `boolean`, `{name:string,role:Role}`) — nothing crosses the Server→Client boundary that Next.js can't serialize.
- `ROLE_CAPABILITIES` is keyed by the exact `Role` union (`'crc' | 'pi' | 'admin'`) from `src/lib/auth.ts`, and Task 4's test asserts the key set matches exactly — if a future phase ever adds a fourth role, that test fails loudly rather than silently rendering an incomplete panel.

**Spec coverage check against the assignment:**
- Practice Information panel: practice name (editable, admin-only) ✓, trial site(s) surfaced for context (read-only) ✓, no padded fields (Key Decision 1 explains why the field count stops at one) ✓.
- Provider Profiles panel: lists Phase 2's `providers`, Manage/Edit is name-only, no "Unpublished" status ✓.
- User Settings panel: read-only, sourced from the real `Role` type and real role-gated behavior, not a CRUD system ✓.
- My Account panel: name + role, expanded with the role's capability summary; "last signed in" explicitly considered and rejected for lack of a real data source (Key Decision 4) ✓.
- Compliance and Classification sections preserved, not rebuilt (moved verbatim into `TabsContent` panels) ✓.
- LeftNav final consolidation done as the last task, per architecture spec §5, with Billing grouped as a collapsible section and a stated justification ✓.
- `practiceSettings`-vs-`appSettings` decision made and justified (Key Decision 1) ✓.
- No new tables — confirmed: this plan's only schema change is one new column on the existing `appSettings` table ✓.

**Cross-phase assumptions and dependencies to reconcile before executing this plan:**

1. **Execution order.** This plan must run after Phases 1–5 are merged. It was written without seeing any of their actual code.
2. **Phase 1 Task 8's exact `settings/page.tsx` shape** (Task 2 and Task 5 assume the Compliance section's copy/classes and the Classification section's `AutoClassifyToggle` wiring match Phase 1 Task 8's plan text verbatim). If Phase 1 shipped something different, re-verify the "before starting" note in Task 5 and adjust the moved JSX to match reality, not this plan's assumption.
3. **Phase 2's `providers` table shape** (Task 3): assumed `id: serial` primary key + `name: text` column. If Phase 2 used a different id type (e.g. a text slug) or a different column name for the display name, Task 3's route/query and Task 5's `ProviderProfilesPanel`/`SettingsSubNav` prop types all need that one type changed consistently (flagged explicitly in Task 3's header).
4. **Phase 2's actual route names** for Calendar, and Phase 3/4/5's actual route names for Billing's sub-pages, Reports, Documents, and Engagement (Task 6): this plan's hrefs are best-guess based on the architecture spec's phase map, not confirmed against any of those phases' actual plans (none existed yet when this plan was written). Task 6 Step 2 explicitly calls this out and instructs using the real routes.
5. **Phase 1's Home Dashboard route** (Task 6): assumed to be mounted at `/`, replacing the current `redirect('/patients')` in `src/app/page.tsx`. If Phase 1 instead mounted it at a distinct path (e.g. `/dashboard`) and kept `/` as a redirect, Task 6's "Home" entry href needs that real path.
6. **Phase 3's `DataGridToolbar.tsx`** (architecture spec §6) is not used anywhere in this plan — Provider Profiles' list is small and simple enough (per the assignment's explicit "no public-listing status" scope-down) that pulling in the shared enterprise toolbar would be over-building for a one-column, name-only list. If Phase 2 ends up giving providers enough columns/scale to warrant it, that's a reasonable follow-up, not part of this plan's scope.
