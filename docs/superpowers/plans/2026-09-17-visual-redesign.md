# Visual Redesign — Tebra/IntakeQ-Inspired Professional UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current default-shadcn/gray "AI-generated" look with a professional clinical-SaaS aesthetic modeled directly on the real Tebra and IntakeQ product UI (verified against real screenshots of the actual IPMG account, not marketing pages) — deep teal chrome, coral primary actions, zebra-striped tables, and drastically fewer decorative icons.

**Architecture:** Pure presentation-layer change. No new routes, no new data, no schema/API changes — every task edits `globals.css` design tokens and rewrites existing component markup/className strings in place. Behavior (auth checks, data fetching, audit logging) must not change; only visual output.

**Tech Stack:** Same as the rest of the app — Tailwind v4 CSS custom properties, shadcn/ui conventions, no new dependencies.

**Spec:** This plan supersedes the visual-system section of `docs/superpowers/specs/2026-09-16-ipmg-workbook-ui-ux-design.md` §5 (Visual Design System) — the new palette/typography rules below are the authoritative version going forward; the rest of that spec (screens, data model, HIPAA patterns) is unchanged.

## Reference (verified against real screenshots, not memory)

Observed directly from real Tebra (`app.kareo.com`, the actual product, IPMG's live account) and IntakeQ screenshots:

- Header/chrome: deep teal `#1F4E5F`-ish, white icon-only main nav (5 icons total in the whole app), practice/user name as plain text, no icon clutter elsewhere.
- Primary buttons: coral/orange (`#E8734A`-ish), rounded, used **only** for the single primary action per screen ("New Patient", "Find Available Appointment").
- Status is shown as **plain colored text or a small solid dot**, never an icon badge — e.g. "Failed" in red text, "Sent" in plain black text, no icon glyph attached.
- Tables: zebra-striped rows (subtle warm off-white alternating with white), ALL-CAPS gray column headers, teal/link-blue clickable row values, thin borders instead of card shadows, no per-cell icons.
- Page titles: large, bold, **black** (never colored) — color is reserved for data (KPI numbers in teal) and links, not headings.
- Background: warm off-white, not stark white; cards are white with a thin light border, not heavy shadow.

## Global Constraints

- No icon may appear more than once per semantic concept — status is color+text only (a solid dot is acceptable, a Lucide icon glyph is not); source attribution is a text label only, no lock icon.
- Every status indicator must still pair color with a text label (never color alone) — this is unchanged from the original spec, only the *icon* requirement is dropped, not the label requirement.
- Primary action buttons use the coral accent color; there is at most one coral button per screen. Every other button is either a plain teal text link or a white/bordered secondary button.
- No visual change may alter existing `data-testid`-free component APIs in a way that breaks existing tests — run `npm test` after every task.
- The PILOT/DEMO banner's amber warning treatment is unchanged (it is a safety warning, not brand chrome — do not restyle it to teal or coral).

---

## Task 1: Design tokens + StatusChip + SourceTag

**Files:**
- Modify: `src/app/globals.css`
- Modify: `src/components/StatusChip.tsx`
- Modify: `src/components/SourceTag.tsx`
- Modify: `tests/components/StatusChip.test.tsx` (icon assertion no longer applies)

**Interfaces:**
- `StatusChip`/`SourceTag` keep their existing prop signatures (`{ status: Verdict }`, `{ source: 'system' | 'intakeq' | 'tebra' | 'staff' }`) — only internal markup changes. Every later task's usage of these components is unaffected.

- [ ] **Step 1: Update design tokens**

Replace the `:root` block in `src/app/globals.css` (keep the `.dark` block and `@theme inline` block unchanged, only `:root` changes):

```css
:root {
  --background: oklch(0.99 0.004 75);
  --foreground: oklch(0.22 0.02 230);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.22 0.02 230);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.22 0.02 230);
  --primary: oklch(0.37 0.045 220);
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.96 0.006 75);
  --secondary-foreground: oklch(0.37 0.045 220);
  --muted: oklch(0.965 0.008 70);
  --muted-foreground: oklch(0.5 0.02 230);
  --accent: oklch(0.65 0.16 40);
  --accent-foreground: oklch(0.99 0 0);
  --destructive: oklch(0.577 0.245 27.325);
  --border: oklch(0.9 0.006 70);
  --input: oklch(0.9 0.006 70);
  --ring: oklch(0.37 0.045 220);
  --chart-1: oklch(0.87 0 0);
  --chart-2: oklch(0.556 0 0);
  --chart-3: oklch(0.439 0 0);
  --chart-4: oklch(0.371 0 0);
  --chart-5: oklch(0.269 0 0);
  --radius: 0.5rem;
  --sidebar: oklch(0.37 0.045 220);
  --sidebar-foreground: oklch(0.985 0 0);
  --sidebar-primary: oklch(0.985 0 0);
  --sidebar-primary-foreground: oklch(0.37 0.045 220);
  --sidebar-accent: oklch(0.32 0.04 220);
  --sidebar-accent-foreground: oklch(0.985 0 0);
  --sidebar-border: oklch(0.32 0.04 220);
  --sidebar-ring: oklch(0.65 0.16 40);
}
```

`--primary` is the deep teal (`~#1F4E5F`), `--accent` is the coral (`~#E8734A`) reserved for primary-action buttons, `--sidebar*` tokens give the left nav its own teal chrome (matching Tebra's dark nav rail) distinct from the white main content area. `--muted` is the warm zebra-stripe color used by every table in later tasks.

- [ ] **Step 2: Manual verification**

Run `npm run dev`, sign in, confirm the page background reads as a warm off-white (not stark white) and no existing screen visually breaks (this step only changes CSS variables — shadcn components already reference them via `bg-background`, `text-foreground`, etc.).

- [ ] **Step 3: Write the failing test for StatusChip (icon removed)**

Replace `tests/components/StatusChip.test.tsx`:

```typescript
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StatusChip } from '@/components/StatusChip'

describe('StatusChip', () => {
  it('renders the label text for every verdict', () => {
    const { rerender } = render(<StatusChip status="green" />)
    expect(screen.getByText(/meets/i)).toBeInTheDocument()
    rerender(<StatusChip status="yellow" />)
    expect(screen.getByText(/needs verification/i)).toBeInTheDocument()
    rerender(<StatusChip status="red" />)
    expect(screen.getByText(/potential exclusion/i)).toBeInTheDocument()
  })

  it('pairs the label with a colored dot, never color alone, and never a Lucide icon glyph', () => {
    const { container } = render(<StatusChip status="red" />)
    // A solid color dot (a plain <span>, not an <svg> icon glyph) is the
    // only visual marker alongside the text label -- confirms no icon
    // library glyph is rendered per the redesign's "remove icons" rule.
    expect(container.querySelector('svg')).not.toBeInTheDocument()
    const dot = container.querySelector('span[aria-hidden="true"]')
    expect(dot).toBeInTheDocument()
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run tests/components/StatusChip.test.tsx`
Expected: FAIL — current implementation renders a Lucide `<svg>` icon, contradicting the second test.

- [ ] **Step 5: Rewrite StatusChip without icons**

Replace `src/components/StatusChip.tsx`:

```typescript
import type { Verdict } from '@/lib/rule-engine'

// Matches the real Tebra/IntakeQ convention observed directly in the
// product: status is a colored dot + plain text label, never an icon
// glyph. The dot is decorative (aria-hidden) -- the text label alone
// satisfies "never color alone" on its own.
const CONFIG: Record<Verdict, { label: string; dotClassName: string; textClassName: string }> = {
  green: { label: 'Meets', dotClassName: 'bg-emerald-600', textClassName: 'text-emerald-800' },
  yellow: { label: 'Needs Verification', dotClassName: 'bg-amber-500', textClassName: 'text-amber-800' },
  red: { label: 'Potential Exclusion', dotClassName: 'bg-red-600', textClassName: 'text-red-800' },
}

export function StatusChip({ status }: { status: Verdict }) {
  const { label, dotClassName, textClassName } = CONFIG[status]
  return (
    <span className={`inline-flex items-center gap-1.5 text-sm font-medium ${textClassName}`}>
      <span className={`h-2 w-2 rounded-full ${dotClassName}`} aria-hidden="true" />
      {label}
    </span>
  )
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/components/StatusChip.test.tsx`
Expected: PASS

- [ ] **Step 7: Rewrite SourceTag without the lock icon**

Replace `src/components/SourceTag.tsx`:

```typescript
const COLORS: Record<string, string> = {
  system: 'text-slate-500',
  intakeq: 'text-sky-700',
  tebra: 'text-teal-700',
  staff: 'text-emerald-700',
}

// The column header text itself ("Name", "DOB", etc.) already sits next
// to this tag, and the tag's own text ("tebra", "intakeq", "staff")
// states the source directly -- a lock glyph added no information a
// screen reader or sighted user didn't already have, and reads as
// decorative icon clutter against the real IntakeQ/Tebra reference,
// where status/source is communicated by text and color only.
export function SourceTag({ source }: { source: 'system' | 'intakeq' | 'tebra' | 'staff' }) {
  return <span className={`text-[10px] font-semibold uppercase tracking-wide ${COLORS[source]}`}>{source}</span>
}
```

- [ ] **Step 8: Run the full suite and build**

Run: `npm test` — expect all tests pass (StatusChip's new test suite, plus every other file unaffected since `SourceTag`/`StatusChip` prop APIs didn't change).
Run: `npm run build` — expect a clean build.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "redesign: teal/coral design tokens, remove icons from StatusChip/SourceTag"
```

---

## Task 2: App shell (TopBanner, LeftNav) + login page

**Files:**
- Modify: `src/components/TopBanner.tsx`
- Modify: `src/components/LeftNav.tsx`
- Modify: `src/app/login/page.tsx`
- Modify: `tests/components/TopBanner.test.tsx` (if any assertion depends on removed markup — check before editing)

**Interfaces:**
- No prop signature changes to `TopBanner`, `LeftNav`. `LoginPage` has no props.

- [ ] **Step 1: Restyle TopBanner**

Replace `src/components/TopBanner.tsx`:

```typescript
function ConnectionDot({ label, connected }: { label: string; connected: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-slate-600">
      <span className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-600' : 'bg-red-600'}`} aria-hidden="true" />
      <span>{label}</span> {connected ? 'Connected' : 'Disconnected'}
    </span>
  )
}

export function TopBanner({ environment, intakeqConnected, tebraConnected, userName }: { environment: 'pilot' | 'production'; intakeqConnected: boolean; tebraConnected: boolean; userName: string }) {
  return (
    <div className="border-b border-border bg-card">
      <div className="bg-amber-50 px-4 py-1 text-center text-xs font-semibold text-amber-800">
        {environment === 'pilot' ? 'PILOT / DEMO — NO REAL PATIENT DATA' : 'PRODUCTION'}
      </div>
      <div className="flex items-center justify-between px-6 py-3">
        <div className="flex items-center gap-5">
          <ConnectionDot label="IntakeQ" connected={intakeqConnected} />
          <ConnectionDot label="Tebra" connected={tebraConnected} />
        </div>
        <span className="text-sm font-medium text-foreground">{userName}</span>
      </div>
    </div>
  )
}
```

(Only the border/background classes changed to reference the new tokens — `border-border`/`bg-card` instead of hardcoded `border-b bg-white` — and the connection dot colors moved from `bg-green-500`/`bg-red-500` to the same emerald/red used by `StatusChip` for palette consistency. The pilot/demo amber banner is untouched, per Global Constraints.)

- [ ] **Step 2: Restyle LeftNav as a dark teal rail (matches Tebra's nav chrome)**

Replace `src/components/LeftNav.tsx`:

```typescript
'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

const ITEMS = [
  { href: '/patients', label: 'Patients' },
  { href: '/identity-matching', label: 'Identity Matching' },
  { href: '/trials', label: 'Trials & Protocols' },
  { href: '/audit-log', label: 'Audit Log' },
  { href: '/settings', label: 'Settings' },
]

export function LeftNav() {
  const pathname = usePathname()
  return (
    <nav className="w-56 shrink-0 bg-sidebar p-4">
      <ul className="space-y-1">
        {ITEMS.map((item) => {
          const active = pathname === item.href || pathname?.startsWith(`${item.href}/`)
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                className={`block rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  active
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                }`}
              >
                {item.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
```

This is now a Client Component (`usePathname` requires it) so the active nav item is actually highlighted — the original had no active-state logic at all. `src/app/(dashboard)/layout.tsx` already renders `<LeftNav />` inside a Server Component; a Client Component child of a Server Component is standard Next.js and needs no changes there.

- [ ] **Step 3: Restyle the login page's primary button and card**

In `src/app/login/page.tsx`, replace the button's className (find `className="w-full rounded-md border px-4 py-2 text-left text-sm hover:bg-slate-50"`) with:

```typescript
className="w-full rounded-md border border-border px-4 py-2 text-left text-sm font-medium text-foreground transition-colors hover:border-primary hover:bg-secondary"
```

And replace the outer card's className (find `className="w-full max-w-sm rounded-lg border bg-white p-8 shadow-sm"`) with:

```typescript
className="w-full max-w-sm rounded-lg border border-border bg-card p-8 shadow-sm"
```

- [ ] **Step 4: Check for any test assertions on removed markup**

Read `tests/components/TopBanner.test.tsx` — it asserts on text content (`IntakeQ`, `Tebra`, the pilot banner text) only, not on specific class names, so it should still pass unmodified. Run it to confirm: `npx vitest run tests/components/TopBanner.test.tsx`.

- [ ] **Step 5: Manual verification**

Run `npm run dev`, visit `/login` (confirm the card/button read cleanly against the new warm background), sign in, confirm the left nav now renders as a dark teal rail with the current page highlighted.

- [ ] **Step 6: Run the full suite and build**

Run: `npm test` and `npm run build` — both must be clean.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "redesign: teal nav rail with active-state highlighting, restyled login page"
```

---

## Task 3: Patients workbook table + Trials screens

**Files:**
- Modify: `src/app/(dashboard)/patients/page.tsx`
- Modify: `src/app/(dashboard)/trials/page.tsx`
- Modify: `src/app/(dashboard)/trials/[trialId]/page.tsx`

**Interfaces:**
- No changes to data fetching (`listPatientsWithStatus`, `listAllTrials`, `getSession`, `logAudit`) — this task is markup/className only.

- [ ] **Step 1: Restyle the Patients table with zebra striping and the Tebra table pattern**

In `src/app/(dashboard)/patients/page.tsx`, replace the trial-filter links section and the `<table>` block. The filter links (find the `<div className="flex gap-2 text-sm">...</div>` block) become pill-tabs matching Tebra's "Priority / Open Notes / Referrals" tab pattern instead of plain bordered boxes:

```typescript
<div className="flex items-center gap-4">
  <div className="flex gap-1 rounded-lg bg-secondary p-1 text-sm">
    <Link href="/patients" className={`rounded-md px-3 py-1.5 font-medium transition-colors ${!trialId ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>All Trials</Link>
    {trials.map((t) => (
      <Link key={t.id} href={`/patients?trialId=${t.id}`} className={`rounded-md px-3 py-1.5 font-medium transition-colors ${trialId === t.id ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>{t.condition}</Link>
    ))}
  </div>
  <a href="/api/workbook/export" className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground shadow-sm transition-opacity hover:opacity-90">Export to Excel</a>
</div>
```

Replace the `<table>` block entirely:

```typescript
<table className="w-full border-collapse text-sm">
  <thead>
    <tr className="border-b border-border text-left">
      <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</th>
      <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Anon #</th>
      <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Name <SourceTag source="tebra" /></th>
      <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">DOB <SourceTag source="tebra" /></th>
      <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Provider <SourceTag source="tebra" /></th>
      <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Referral Type <SourceTag source="intakeq" /></th>
      <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Last Communication <SourceTag source="staff" /></th>
    </tr>
  </thead>
  <tbody>
    {patients.map((p, i) => (
      <tr key={p.id} className={`border-b border-border ${i % 2 === 1 ? 'bg-muted/40' : ''} hover:bg-secondary`}>
        <td className="p-3"><StatusChip status={p.overallStatus ?? 'yellow'} /></td>
        <td className="p-3"><Link href={`/patients/${p.id}`} className="font-medium text-primary hover:underline">{p.id}</Link></td>
        <td className="p-3 text-foreground">{p.nameTebra ?? p.nameIntakeq}</td>
        <td className="p-3 text-foreground">{p.dobTebra ?? p.dobIntakeq}</td>
        <td className="p-3 text-foreground">{p.currentProvider}</td>
        <td className="p-3 text-foreground">{p.referralType}</td>
        <td className="p-3 text-muted-foreground">{p.lastCommunication ?? '—'}</td>
      </tr>
    ))}
  </tbody>
</table>
<p className="mt-3 text-xs text-muted-foreground">{patients.length} total record{patients.length === 1 ? '' : 's'}</p>
```

Also change the page's `<h1>` (find `className="text-lg font-semibold"`) to `className="text-2xl font-bold text-foreground"` to match the real product's bold black page-title convention, and wrap the header row in `className="mb-6 flex items-center justify-between"` (was `mb-4`) for more breathing room matching the reference screenshots' generous spacing.

- [ ] **Step 2: Restyle the Trials list page**

In `src/app/(dashboard)/trials/page.tsx`, change the `<h1>` to `className="mb-6 text-2xl font-bold text-foreground"`, and replace each trial card's className (find `className="block rounded-lg border p-4 hover:bg-slate-50"`) with:

```typescript
className="block rounded-lg border border-border bg-card p-5 transition-colors hover:border-primary"
```

And inside each card, change the trial name `<p>`'s className to `className="text-base font-semibold text-foreground"` and the metadata line's className to `className="mt-1 text-sm text-muted-foreground"`.

- [ ] **Step 3: Restyle the Trial Detail page**

In `src/app/(dashboard)/trials/[trialId]/page.tsx`, change the `<h1>` to `className="text-2xl font-bold text-foreground"`, and each `<h2>` section heading to `className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"` (matches the ALL-CAPS gray convention used everywhere else), and each `<ul>`'s className to `className="space-y-1.5 text-sm text-foreground"`.

- [ ] **Step 4: Manual verification**

Run `npm run dev`, visit `/patients`, confirm: zebra striping alternates correctly, the trial filter renders as a pill-tab group (not plain boxes), the Export button is coral, clicking a trial filter still correctly scopes the table (this is unchanged logic, just restyled). Visit `/trials` and a trial detail page, confirm the same typographic conventions.

- [ ] **Step 5: Run the full suite and build**

Run: `npm test` and `npm run build` — both must be clean. These pages have no dedicated component tests (per the existing "deferred minor" from Task 11's review), so a clean build plus manual verification is the verification bar for this task.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "redesign: zebra-striped Patients table, pill-tab trial filter, restyled Trials screens"
```

---

## Task 4: Patient Detail page + EvidenceCard

**Files:**
- Modify: `src/app/(dashboard)/patients/[anonId]/page.tsx`
- Modify: `src/components/EvidenceCard.tsx`

**Interfaces:**
- No data/prop changes — `EvidenceCard`'s `{ criterion }` prop shape is unchanged.

- [ ] **Step 1: Restyle EvidenceCard**

Replace `src/components/EvidenceCard.tsx`:

```typescript
import { StatusChip } from './StatusChip'

export function EvidenceCard({ criterion }: { criterion: { criterionText: string; verdict: 'green' | 'yellow' | 'red'; evidenceQuote: string | null; evidenceSourceDoc: string | null; evidenceSourceDate: string | null } }) {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-semibold text-foreground">{criterion.criterionText}</span>
        <StatusChip status={criterion.verdict} />
      </div>
      <blockquote className="rounded-md border-l-4 border-primary bg-secondary p-3 font-mono text-xs leading-relaxed text-foreground">
        {criterion.evidenceQuote ?? 'No evidence available — defaults to Needs Verification.'}
      </blockquote>
      <p className="mt-2 text-xs text-muted-foreground">{criterion.evidenceSourceDoc} · {criterion.evidenceSourceDate}</p>
    </div>
  )
}
```

(The evidence quote now has a teal left-border accent — a citation/footnote treatment — instead of a plain gray box, making it read more clearly as a sourced quotation, per the spec's original intent that this be "the visual centerpiece.")

- [ ] **Step 2: Restyle the Patient Detail page**

In `src/app/(dashboard)/patients/[anonId]/page.tsx`:

Change the page header (find `className="flex items-center justify-between"` wrapping the `<h1>`) — update the `<h1>`'s className to `className="text-2xl font-bold text-foreground"`.

Change every section `<h2>` className from `"mb-2 text-sm font-semibold uppercase text-slate-500"` to `"mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground"`.

Update `ComparisonRow`'s function body:

```typescript
function ComparisonRow({ label, intakeq, tebra, merged }: { label: string; intakeq: string | null; tebra: string | null; merged: string | null }) {
  const mismatch = intakeq && tebra && intakeq !== tebra
  return (
    <div className="grid grid-cols-4 gap-2 border-b border-border py-3 text-sm">
      <span className="font-medium text-muted-foreground">{label}</span>
      <span className="text-foreground">{intakeq ?? '—'}</span>
      <span className="text-foreground">{tebra ?? '—'}</span>
      <span className={mismatch ? 'rounded bg-amber-100 px-2 py-0.5 font-medium text-amber-800' : 'text-foreground'}>{merged ?? '—'}</span>
    </div>
  )
}
```

Change the "Dual-Sourced Fields" column-label row's className from `"grid grid-cols-4 gap-2 border-b pb-1 text-xs font-semibold text-slate-400"` to `"grid grid-cols-4 gap-2 border-b border-border pb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"`.

Change the "Diagnoses & Medications" `<ul>` className to `"space-y-1.5 text-sm text-foreground"`.

- [ ] **Step 3: Manual verification**

Run `npm run dev`, visit `/patients/RD-0002` (red/excluded-medication case) and `/patients/RD-0006` (dual-source mismatch case). Confirm the evidence quote block now has a visible teal left-border accent, and the mismatch row still highlights in amber.

- [ ] **Step 4: Run the full suite and build**

Run: `npm test` and `npm run build` — both must be clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "redesign: citation-style evidence cards, restyled Patient Detail page"
```

---

## Task 5: Identity Matching + Audit Log + Settings

**Files:**
- Modify: `src/app/(dashboard)/identity-matching/page.tsx`
- Modify: `src/app/(dashboard)/audit-log/page.tsx`
- Modify: `src/app/(dashboard)/settings/page.tsx`

**Interfaces:**
- No data/prop/behavior changes — the Confirm/Reject `<form>` actions, their target URLs, and the audit-log/settings data fetching are all unchanged. This task only touches className strings and heading levels.

- [ ] **Step 1: Restyle the Identity Matching Queue**

In `src/app/(dashboard)/identity-matching/page.tsx`, change the `<h1>` to `className="mb-6 text-2xl font-bold text-foreground"`. Replace each match card's className (find `className="grid grid-cols-2 gap-4 rounded-lg border p-4"`) with:

```typescript
className="grid grid-cols-2 gap-4 rounded-lg border border-border bg-card p-5"
```

Change the "IntakeQ Referral" label className from `"text-xs font-semibold uppercase text-blue-700"` to `"text-xs font-semibold uppercase tracking-wide text-sky-700"`, and the "Candidate Tebra Chart" label from `"text-xs font-semibold uppercase text-purple-700"` to `"text-xs font-semibold uppercase tracking-wide text-teal-700"` (aligning the source colors with `SourceTag`'s palette from Task 1 — sky for IntakeQ, teal for Tebra, rather than blue/purple which don't match anything else in the app).

Replace the Confirm button's className (`"rounded-md bg-green-700 px-3 py-1 text-sm text-white"`) with `"rounded-md bg-accent px-4 py-1.5 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90"` (this is the screen's one primary action — coral, matching Task 1's rule of one coral button per screen). Replace the Reject button's className (`"rounded-md border px-3 py-1 text-sm"`) with `"rounded-md border border-border px-4 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-secondary"`.

- [ ] **Step 2: Restyle the Audit Log table**

In `src/app/(dashboard)/audit-log/page.tsx`, change the `<h1>` to `className="mb-6 text-2xl font-bold text-foreground"`. Replace the `<table>` header row className from `"border-b text-left"` to `"border-b border-border text-left"`, and each `<th>`'s className to `"p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground"`. Add zebra striping to the body rows:

```typescript
{entries.map((e, i) => (
  <tr key={e.id} className={`border-b border-border ${i % 2 === 1 ? 'bg-muted/40' : ''}`}>
    <td className="p-3 font-mono text-xs text-muted-foreground">{new Date(e.timestamp).toLocaleString()}</td>
    <td className="p-3 text-foreground">{e.userName}</td>
    <td className="p-3 text-foreground">{e.role}</td>
    <td className="p-3 text-foreground">{e.action}</td>
    <td className="p-3 font-mono text-xs text-muted-foreground">{e.patientId ?? '—'}</td>
  </tr>
))}
```

- [ ] **Step 3: Restyle the Settings page**

In `src/app/(dashboard)/settings/page.tsx`, change the `<h1>` to `className="mb-6 text-2xl font-bold text-foreground"`. Replace each `<section>`'s className (`"rounded-lg border p-4"`) with `"rounded-lg border border-border bg-card p-5"`, and each section `<h2>`'s className to `"mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground"`.

- [ ] **Step 4: Manual verification**

Run `npm run dev`, visit `/identity-matching` (confirm the Confirm button is coral, Reject is a plain outline button), `/audit-log` (confirm zebra striping), `/settings` (confirm consistent card styling with the rest of the app).

- [ ] **Step 5: Run the full suite and build**

Run: `npm test` and `npm run build` — both must be clean.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "redesign: restyle Identity Matching, Audit Log, and Settings screens"
```

---

## Final QA pass

After all 5 tasks: manually walk through every screen (`/login`, `/patients`, `/patients/[anonId]`, `/identity-matching`, `/trials`, `/trials/[trialId]`, `/audit-log`, `/settings`) and confirm:
- No Lucide icon appears anywhere except where a real functional need remains (there should be none left after Task 1 — grep `grep -rn "lucide-react" src/` and confirm zero remaining imports, or note any legitimate exception explicitly).
- Every screen uses the teal/coral/warm-white palette consistently — no leftover `bg-slate-900`, `bg-green-700`, `text-blue-700`, or other hardcoded colors from the old palette (grep for these).
- The PILOT/DEMO amber banner is still present and unchanged on every screen.
- `npm test` and `npm run build` both clean at the very end, matching the state after Task 5.
