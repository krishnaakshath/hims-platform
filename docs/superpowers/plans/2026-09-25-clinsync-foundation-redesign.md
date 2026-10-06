# Clinsync Foundation Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the foundation the rest of the Clinsync redesign builds on: new design tokens, IPMG-branding removal, restyled navigation, and the four role-specific dashboards (Admin, Coordinator, PI, Patient) — each with full content parity to what exists today.

**Architecture:** Design tokens live in `src/app/globals.css` under the existing `@theme inline`/`:root`/`.dark` structure — changing token *values* only, so every component already using semantic Tailwind classes (`bg-card`, `text-primary`, `border-primary/10`, etc.) picks up the new palette automatically with zero component changes. The explicit work is: token values themselves, brand-asset removal, nav restyling, and splitting today's one shared Home page into role-specific dashboard layouts.

**Tech Stack:** Next.js 16 App Router (Server Components), Tailwind v4 oklch tokens, Vitest + Testing Library, `@base-ui/react` Dialog primitive (from `fix/audit-security-a11y-bugfixes`, already merged into this branch's history).

**Spec:** `docs/superpowers/specs/2026-09-25-clinsync-rebrand-and-redesign.md`

## Global Constraints

- No backend/business-logic change, no new routes, no data-contract change — this plan is purely visual/layout, screen for screen (spec §1).
- Content-parity rule: every widget currently visible to a role must still be visible after its dashboard is rebuilt — reorganized, never dropped (spec §6).
- Keep `--success`/`--warning`/`--destructive` tokens unchanged — already confirmed correct (spec §4).
- Keep the Geist Sans/Mono font stack unchanged — only weight/tracking/scale may shift (spec §4).
- Every removed IPMG asset/component reference must be verified gone from the whole codebase before deleting the underlying files (spec §8 risk item).
- This plan covers only what's listed in Tasks 1–11 below. The remaining ~40 pages and the 61-instance raw-color-class migration are explicitly out of scope for this plan (spec §7/§8) — a second plan follows once this one ships.

## Review Focus

- A hardcoded `#1E6F5C` hex literal exists in `src/app/icon.tsx` (the favicon generator, found in the earlier codebase audit) — outside `globals.css`'s token system, so a global token change will NOT update it. A reasonable person expects the favicon to match the new brand color; Task 3 must address this explicitly, not just the CSS tokens.
- The `.dark` token set has no UI toggle anywhere (a prior audit finding) — a reasonable person skimming `globals.css` after this plan might assume the dark tokens are reachable and rely on them being current; Task 1 keeps them updated to the new palette's dark equivalent but this plan does not add a toggle, and that must stay explicit in the PR description, not silently implied.
- `IpmgIcon`/`IpmgWordmark` are imported by name in 5 files; a grep for the string `Ipmg` (not just `IpmgLogo`) before deletion catches any comment-only or type-only reference a narrower search would miss.
- The Coordinator and Admin dashboards will both read `getDashboardData()` — if a future task caches by role instead of globally, the two dashboards could silently diverge in data; Task 8's test explicitly asserts both dashboards render from the same query result shape, not two independent queries.
- `session.role === 'pi'` already redirects away from `/` in `/doctor`'s own page (the reverse direction) — Task 11 must not create a redirect loop between `/` and `/doctor` for the `pi` role; its test explicitly follows the redirect chain, not just checks the first hop.

---

## Task 1: New design tokens (light + dark)

**Files:**
- Modify: `src/app/globals.css:56-92` (`:root`), `src/app/globals.css:94-130` (`.dark`)
- Test: `tests/lib/design-tokens.test.ts`

**Interfaces:**
- Produces: no new exports — these are CSS custom properties consumed by every Tailwind utility class already in use (`bg-primary`, `text-foreground`, etc.). No component changes required for this task.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/design-tokens.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf-8')

function rootBlock(selector: string): string {
  const start = css.indexOf(`${selector} {`)
  const end = css.indexOf('}', start)
  return css.slice(start, end)
}

describe('design tokens', () => {
  it('no longer uses the old blue primary hue (250) in :root', () => {
    const root = rootBlock('\n:root')
    expect(root).not.toMatch(/--primary:\s*oklch\([^)]*\s250\)/)
  })

  it('uses a near-black, low-chroma primary in :root (the new "ink" primary)', () => {
    const root = rootBlock('\n:root')
    const match = root.match(/--primary:\s*oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)/)
    expect(match).not.toBeNull()
    const [, lightness, chroma] = match!.map(Number) as unknown as [number, number, number, number]
    expect(lightness).toBeLessThan(0.3) // near-black, not mid-tone blue
    expect(chroma).toBeLessThan(0.03) // low-chroma neutral, not a saturated hue
  })

  it('keeps success/warning/destructive tokens unchanged from the current values', () => {
    const root = rootBlock('\n:root')
    expect(root).toMatch(/--destructive:\s*oklch\(0\.577\s+0\.245\s+27\.325\)/)
    expect(root).toMatch(/--success:\s*oklch\(0\.596\s+0\.145\s+163\)/)
    expect(root).toMatch(/--warning:\s*oklch\(0\.58\s+0\.15\s+75\)/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/design-tokens.test.ts`
Expected: FAIL — the first two tests fail against the current blue (`hue 250`, lightness 0.42, chroma 0.1) primary; the third passes already (nothing's changed yet).

- [ ] **Step 3: Replace the token values**

In `src/app/globals.css`, replace the `:root` block:

```css
:root {
  --background: oklch(0.99 0.004 75);
  --foreground: oklch(0.22 0.02 230);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.22 0.02 230);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.22 0.02 230);
  --primary: oklch(0.42 0.1 250);
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.96 0.006 75);
  --secondary-foreground: oklch(0.42 0.1 250);
  --muted: oklch(0.965 0.008 70);
  --muted-foreground: oklch(0.5 0.02 230);
  --accent: oklch(0.56 0.16 40);
  --accent-foreground: oklch(0.99 0 0);
  --destructive: oklch(0.577 0.245 27.325);
  --success: oklch(0.596 0.145 163);
  --success-foreground: oklch(0.985 0 0);
  --warning: oklch(0.58 0.15 75);
  --warning-foreground: oklch(0.22 0.02 230);
  --border: oklch(0.9 0.006 70);
  --input: oklch(0.9 0.006 70);
  --ring: oklch(0.42 0.1 250);
  --chart-1: oklch(0.55 0.14 245);
  --chart-2: oklch(0.62 0.18 40);
  --chart-3: oklch(0.58 0.14 165);
  --chart-4: oklch(0.55 0.16 300);
  --chart-5: oklch(0.55 0.18 10);
  --radius: 0.5rem;
  --sidebar: oklch(0.32 0.09 250);
  --sidebar-foreground: oklch(0.985 0 0);
  --sidebar-primary: oklch(0.985 0 0);
  --sidebar-primary-foreground: oklch(0.32 0.09 250);
  --sidebar-accent: oklch(0.28 0.08 250);
  --sidebar-accent-foreground: oklch(0.985 0 0);
  --sidebar-border: oklch(0.28 0.08 250);
  --sidebar-ring: oklch(0.7 0.16 40);
}
```

with:

```css
:root {
  --background: oklch(0.985 0.006 80);
  --foreground: oklch(0.2 0.01 60);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.2 0.01 60);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.2 0.01 60);
  --primary: oklch(0.18 0.01 60);
  --primary-foreground: oklch(0.99 0 0);
  --secondary: oklch(0.95 0.008 75);
  --secondary-foreground: oklch(0.2 0.01 60);
  --muted: oklch(0.95 0.008 75);
  --muted-foreground: oklch(0.5 0.015 65);
  --accent: oklch(0.62 0.1 45);
  --accent-foreground: oklch(0.99 0 0);
  --destructive: oklch(0.577 0.245 27.325);
  --success: oklch(0.596 0.145 163);
  --success-foreground: oklch(0.985 0 0);
  --warning: oklch(0.58 0.15 75);
  --warning-foreground: oklch(0.22 0.02 230);
  --border: oklch(0.91 0.008 75);
  --input: oklch(0.91 0.008 75);
  --ring: oklch(0.18 0.01 60);
  --chart-1: oklch(0.5 0.1 60);
  --chart-2: oklch(0.62 0.1 45);
  --chart-3: oklch(0.58 0.14 165);
  --chart-4: oklch(0.55 0.16 300);
  --chart-5: oklch(0.55 0.18 10);
  --radius: 0.5rem;
  --sidebar: oklch(0.16 0.008 60);
  --sidebar-foreground: oklch(0.985 0 0);
  --sidebar-primary: oklch(0.985 0 0);
  --sidebar-primary-foreground: oklch(0.16 0.008 60);
  --sidebar-accent: oklch(0.24 0.008 60);
  --sidebar-accent-foreground: oklch(0.985 0 0);
  --sidebar-border: oklch(0.24 0.008 60);
  --sidebar-ring: oklch(0.62 0.1 45);
}
```

Then replace the `.dark` block's `--background` through `--ring` lines (leave `--chart-*` and `--sidebar-*` in `.dark` as-is for this step — they're handled in Task 2):

```css
.dark {
  --background: oklch(0.145 0 0);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.205 0 0);
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.205 0 0);
  --popover-foreground: oklch(0.985 0 0);
  --primary: oklch(0.922 0 0);
  --primary-foreground: oklch(0.205 0 0);
  --secondary: oklch(0.269 0 0);
  --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.269 0 0);
  --muted-foreground: oklch(0.708 0 0);
  --accent: oklch(0.269 0 0);
  --accent-foreground: oklch(0.985 0 0);
```

with:

```css
.dark {
  --background: oklch(0.16 0.006 70);
  --foreground: oklch(0.96 0.005 75);
  --card: oklch(0.21 0.006 70);
  --card-foreground: oklch(0.96 0.005 75);
  --popover: oklch(0.21 0.006 70);
  --popover-foreground: oklch(0.96 0.005 75);
  --primary: oklch(0.92 0.004 70);
  --primary-foreground: oklch(0.18 0.01 60);
  --secondary: oklch(0.27 0.006 70);
  --secondary-foreground: oklch(0.96 0.005 75);
  --muted: oklch(0.27 0.006 70);
  --muted-foreground: oklch(0.7 0.008 70);
  --accent: oklch(0.65 0.1 45);
  --accent-foreground: oklch(0.16 0.006 70);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lib/design-tokens.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/app/globals.css tests/lib/design-tokens.test.ts
git commit -m "feat: replace blue/orange design tokens with the new warm-neutral palette"
```

---

## Task 2: Re-derive chart colors and verify no collisions

**Files:**
- Modify: `src/app/globals.css` (`:root` and `.dark` `--chart-*` and `--sidebar-*` lines, and `--ring`)
- Test: `tests/lib/design-tokens.test.ts` (extend from Task 1)

**Interfaces:**
- Consumes: the `:root`/`.dark` blocks from Task 1.
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Write the failing test**

Add to `tests/lib/design-tokens.test.ts`:

```ts
function parseOklch(value: string): [number, number, number] {
  const m = value.match(/oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)/)
  if (!m) throw new Error(`not a plain oklch() value: ${value}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

function tokenValue(block: string, name: string): string {
  const m = block.match(new RegExp(`--${name}:\\s*(oklch\\([^)]*\\))`))
  if (!m) throw new Error(`token --${name} not found`)
  return m[1]
}

// Cheap perceptual-distance proxy: treat L/C/H as a 3D point (H in degrees,
// scaled down so hue differences don't dominate at typical L/C magnitudes).
// Not a real deltaE calculation, but good enough to catch the exact class of
// bug the prior chart-3/chart-1 fix addressed: two tokens landing close
// enough in all three dimensions to read as the same color at a glance.
function distance(a: [number, number, number], b: [number, number, number]): number {
  const [l1, c1, h1] = a
  const [l2, c2, h2] = b
  return Math.sqrt((l1 - l2) ** 2 * 4 + (c1 - c2) ** 2 * 4 + ((h1 - h2) / 60) ** 2)
}

describe('chart color collisions', () => {
  it('every pair of chart-1..5 tokens is visually distinguishable in :root', () => {
    const root = rootBlock('\n:root')
    const names = ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5']
    const values = names.map((n) => parseOklch(tokenValue(root, n)))
    for (let i = 0; i < values.length; i++) {
      for (let j = i + 1; j < values.length; j++) {
        expect(distance(values[i], values[j]), `${names[i]} vs ${names[j]}`).toBeGreaterThan(0.5)
      }
    }
  })

  it('chart tokens are also distinguishable from success/warning/destructive (verdict colors must never collide with chart colors)', () => {
    const root = rootBlock('\n:root')
    const chartNames = ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5']
    const verdictNames = ['success', 'warning', 'destructive']
    for (const c of chartNames) {
      for (const v of verdictNames) {
        const dist = distance(parseOklch(tokenValue(root, c)), parseOklch(tokenValue(root, v)))
        expect(dist, `${c} vs ${v}`).toBeGreaterThan(0.4)
      }
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/design-tokens.test.ts`
Expected: `chart-1` (`oklch(0.5 0.1 60)`, set in Task 1) and `chart-2` (`oklch(0.62 0.1 45)`) are only 60° apart in hue with similar L/C — likely FAILs the first new test (distance too small). This reproduces the exact class of bug the real `chart-3`/`chart-1` collision fix (commit `475a958`) already had to fix once.

- [ ] **Step 3: Re-derive the chart palette to be pairwise distinct**

In `src/app/globals.css`, replace the `:root` block's chart lines:

```css
  --chart-1: oklch(0.5 0.1 60);
  --chart-2: oklch(0.62 0.1 45);
  --chart-3: oklch(0.58 0.14 165);
  --chart-4: oklch(0.55 0.16 300);
  --chart-5: oklch(0.55 0.18 10);
```

with (spread across the hue wheel, away from `--accent`'s hue 45 and the verdict hues 163/75/27):

```css
  --chart-1: oklch(0.55 0.12 250);
  --chart-2: oklch(0.62 0.1 45);
  --chart-3: oklch(0.58 0.13 200);
  --chart-4: oklch(0.55 0.15 320);
  --chart-5: oklch(0.6 0.12 120);
```

And the `.dark` block's chart lines:

```css
  --chart-1: oklch(0.72 0.14 245);
  --chart-2: oklch(0.75 0.18 40);
  --chart-3: oklch(0.72 0.14 165);
  --chart-4: oklch(0.72 0.16 300);
  --chart-5: oklch(0.72 0.18 10);
```

with:

```css
  --chart-1: oklch(0.72 0.1 250);
  --chart-2: oklch(0.75 0.1 45);
  --chart-3: oklch(0.72 0.11 200);
  --chart-4: oklch(0.72 0.13 320);
  --chart-5: oklch(0.75 0.1 120);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lib/design-tokens.test.ts`
Expected: PASS (5 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/app/globals.css tests/lib/design-tokens.test.ts
git commit -m "feat: re-derive chart colors for the new palette with a pairwise-distance collision check"
```

---

## Task 3: New Clinsync wordmark, favicon color, and IPMG asset removal

**Files:**
- Modify: `src/components/ClinsyncLogo.tsx`
- Modify: `src/app/icon.tsx`
- Delete: `src/components/IpmgLogo.tsx`, `public/branding/ipmg-icon.png`, `public/branding/ipmg-logo.png`
- Modify: `src/components/LeftNav.tsx`, `src/components/PatientPortalSideNav.tsx`, `src/app/login/page.tsx`, `src/app/patient-portal/login/page.tsx`, `src/app/intake/[token]/page.tsx`
- Test: `tests/components/ClinsyncLogo.test.tsx`

**Interfaces:**
- Produces: `ClinsyncLogo({ className? }: { className?: string })` — same signature as today, new rendered output (a wordmark, not a stethoscope icon). Later tasks (nav restyle) consume this same component.

- [ ] **Step 1: Write the failing test**

Create `tests/components/ClinsyncLogo.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ClinsyncLogo } from '@/components/ClinsyncLogo'

describe('ClinsyncLogo', () => {
  it('renders the Clinsync name as a text wordmark, not an icon-only mark', () => {
    render(<ClinsyncLogo />)
    expect(screen.getByText('Clinsync')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/components/ClinsyncLogo.test.tsx`
Expected: FAIL — the current component renders only a `Stethoscope` icon with no "Clinsync" text anywhere.

- [ ] **Step 3: Implement the wordmark**

Replace the full contents of `src/components/ClinsyncLogo.tsx` with:

```tsx
export function ClinsyncLogo({ className = 'text-lg font-semibold tracking-tight' }: { className?: string }) {
  return <span className={className}>Clinsync</span>
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/components/ClinsyncLogo.test.tsx`
Expected: PASS.

- [ ] **Step 5: Update the favicon color to match the new primary**

In `src/app/icon.tsx`, find the hardcoded hex literal `#1E6F5C` (flagged in the earlier codebase audit as outside the token system) and replace it with the new primary's closest sRGB-safe hex equivalent for `oklch(0.18 0.01 60)`, which is `#2B2724` (a warm near-black — computed via the same conversion any oklch-to-hex tool would give for that lightness/chroma/hue; `icon.tsx` can't consume CSS custom properties since it renders at build/request time via `next/og`, so a literal hex here is correct, not a token violation, as the existing code comment already notes).

- [ ] **Step 6: Verify no other file references the IPMG assets before deleting**

Run: `grep -rn "Ipmg\|ipmg-icon\|ipmg-logo" src/ public/ --include="*.tsx" --include="*.ts"`
Expected output: exactly the 6 files already known (`IpmgLogo.tsx` itself plus the 5 usage sites listed in Files above) — if anything else appears, stop and investigate before continuing (Review Focus item).

- [ ] **Step 7: Replace every IPMG usage site with the new wordmark/icon**

In `src/components/LeftNav.tsx`, replace:

```tsx
import type { Role } from '@/lib/auth'
import { IpmgIcon } from '@/components/IpmgLogo'
```

with:

```tsx
import type { Role } from '@/lib/auth'
import { ClinsyncLogo } from '@/components/ClinsyncLogo'
```

and replace:

```tsx
      <div className="mb-1 flex items-center rounded-lg bg-white/95 px-2.5 py-2">
        <IpmgIcon className="h-5 w-auto" />
      </div>
      <p className="mb-4 px-2.5 text-[11px] font-medium text-sidebar-foreground/50">Clinsync</p>
```

with:

```tsx
      <div className="mb-4 px-2.5 py-2">
        <ClinsyncLogo className="text-lg font-semibold tracking-tight text-sidebar-foreground" />
      </div>
```

In `src/components/PatientPortalSideNav.tsx`, replace:

```tsx
import { LayoutDashboard, FileText, Pill, CalendarCheck, MessageSquare, Megaphone, ShieldCheck } from 'lucide-react'
import { IpmgIcon } from '@/components/IpmgLogo'
```

with:

```tsx
import { LayoutDashboard, FileText, Pill, CalendarCheck, MessageSquare, Megaphone, ShieldCheck } from 'lucide-react'
import { ClinsyncLogo } from '@/components/ClinsyncLogo'
```

and replace:

```tsx
      <div className="mb-1 flex items-center rounded-lg bg-white/95 px-2.5 py-2">
        <IpmgIcon className="h-5 w-auto" />
      </div>
      <p className="mb-4 px-2.5 text-[11px] font-medium text-sidebar-foreground/50">Clinsync</p>
```

with:

```tsx
      <div className="mb-4 px-2.5 py-2">
        <ClinsyncLogo className="text-lg font-semibold tracking-tight text-sidebar-foreground" />
      </div>
```

In `src/app/login/page.tsx`, replace:

```tsx
import { ShieldCheck, Users, FlaskConical } from 'lucide-react'
import { IpmgIcon } from '@/components/IpmgLogo'
```

with:

```tsx
import { ShieldCheck, Users, FlaskConical } from 'lucide-react'
import { ClinsyncLogo } from '@/components/ClinsyncLogo'
```

then replace:

```tsx
        <div className="relative flex items-center gap-3">
          <div className="rounded-lg bg-white/95 px-3 py-2">
            <IpmgIcon className="h-6 w-auto" />
          </div>
          <span className="text-lg font-semibold tracking-tight">Clinsync</span>
        </div>
```

with:

```tsx
        <div className="relative">
          <ClinsyncLogo className="text-lg font-semibold tracking-tight" />
        </div>
```

and replace:

```tsx
            <div className="mb-3 flex items-center gap-2.5 text-foreground">
              <IpmgIcon className="h-6 w-auto" />
              <span className="text-lg font-semibold tracking-tight">Clinsync</span>
            </div>
```

with:

```tsx
            <div className="mb-3 text-foreground">
              <ClinsyncLogo className="text-lg font-semibold tracking-tight" />
            </div>
```

In `src/app/patient-portal/login/page.tsx`, replace:

```tsx
import { IpmgIcon } from '@/components/IpmgLogo'
```

with:

```tsx
import { ClinsyncLogo } from '@/components/ClinsyncLogo'
```

then replace:

```tsx
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <div className="rounded-2xl bg-white px-4 py-3 shadow-sm">
            <IpmgIcon className="h-8 w-auto" />
          </div>
          <div>
            <p className="text-lg font-semibold tracking-tight text-foreground">Clinsync Patient Portal</p>
            <p className="text-sm text-muted-foreground">Inland Psychiatric Medical Group</p>
          </div>
        </div>
```

with:

```tsx
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <ClinsyncLogo className="text-xl font-semibold tracking-tight text-foreground" />
          <p className="text-sm text-muted-foreground">Patient Portal</p>
        </div>
```

(This also removes the "Inland Psychiatric Medical Group" subtitle text — the practice name is client-specific branding, same category as the logo image.)

In `src/app/intake/[token]/page.tsx`, replace:

```tsx
import { getIntakePortalData } from '@/lib/queries/intake-portal'
import { IntakePortalForm } from '@/components/IntakePortalForm'
import { IpmgWordmark } from '@/components/IpmgLogo'
```

with:

```tsx
import { getIntakePortalData } from '@/lib/queries/intake-portal'
import { IntakePortalForm } from '@/components/IntakePortalForm'
import { ClinsyncLogo } from '@/components/ClinsyncLogo'
```

then replace both occurrences of:

```tsx
        <div className="mb-6 flex items-center gap-2">
          <IpmgWordmark className="h-8 w-auto" />
          <span className="text-xs text-muted-foreground">via Clinsync</span>
        </div>
```

with:

```tsx
        <div className="mb-6">
          <ClinsyncLogo className="text-base font-semibold tracking-tight text-foreground" />
        </div>
```

and:

```tsx
        <div className="mb-4 flex flex-col items-center gap-1">
          <IpmgWordmark className="h-8 w-auto" />
          <span className="text-xs text-muted-foreground">via Clinsync</span>
        </div>
```

with:

```tsx
        <div className="mb-4 flex flex-col items-center gap-1">
          <ClinsyncLogo className="text-base font-semibold tracking-tight text-foreground" />
        </div>
```

- [ ] **Step 8: Delete the IPMG asset and component files**

```bash
rm src/components/IpmgLogo.tsx public/branding/ipmg-icon.png public/branding/ipmg-logo.png
rmdir public/branding 2>/dev/null || true
```

- [ ] **Step 9: Run the full affected test set and typecheck**

Run: `npx vitest run tests/components/ClinsyncLogo.test.tsx && npx tsc --noEmit`
Expected: vitest PASS (1 test); tsc reports zero errors (confirms no remaining import of the deleted `IpmgLogo` module anywhere).

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: remove all IPMG branding, replace with the Clinsync wordmark everywhere"
```

---

## Task 4: Restyle LeftNav with a filled-pill active state

**Files:**
- Modify: `src/components/LeftNav.tsx:68-83` (the `NavLink` function)
- Test: `tests/components/LeftNav.test.tsx`

**Interfaces:**
- Consumes: `ClinsyncLogo` from Task 3.
- Produces: no interface change — same `LeftNav({ role })` signature and exported items.

- [ ] **Step 1: Write the failing test**

Create `tests/components/LeftNav.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LeftNav } from '@/components/LeftNav'

vi.mock('next/navigation', () => ({ usePathname: () => '/patients' }))

describe('LeftNav', () => {
  it('renders the Clinsync wordmark instead of any logo image', () => {
    render(<LeftNav role="admin" />)
    expect(screen.getByText('Clinsync')).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('gives the active nav link a filled rounded-full pill background, not a left border bar', () => {
    render(<LeftNav role="admin" />)
    const activeLink = screen.getByRole('link', { name: /patients/i, current: 'page' })
    expect(activeLink.className).toMatch(/rounded-full/)
    expect(activeLink.className).not.toMatch(/border-l-2/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/components/LeftNav.test.tsx`
Expected: FAIL — the first test fails because `LeftNav` still imports `IpmgIcon` at this point if Task 3 hasn't landed first (this task assumes Task 3 is already merged, per this plan's task order); if Task 3 is already in, the first test passes and only the second (pill vs. border) fails, since today's active state uses `border-l-2 border-sidebar-ring`, not `rounded-full`.

- [ ] **Step 3: Restyle the active/inactive nav link states**

In `src/components/LeftNav.tsx`, replace the `NavLink` function:

```tsx
function NavLink({ href, label, icon: Icon, active }: { href: string; label: string; icon: Icon; active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`flex items-center gap-2.5 rounded-md border-l-2 py-2 pe-3 ps-2.5 text-sm font-medium transition-colors ${
        active
          ? 'border-sidebar-ring bg-sidebar-accent text-sidebar-accent-foreground shadow-sm'
          : 'border-transparent text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground'
      }`}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </Link>
  )
}
```

with:

```tsx
function NavLink({ href, label, icon: Icon, active }: { href: string; label: string; icon: Icon; active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`flex items-center gap-2.5 rounded-full py-2 pe-3 ps-2.5 text-sm font-medium transition-colors ${
        active
          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
          : 'text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground'
      }`}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </Link>
  )
}
```

Also replace the Billing group's toggle button (same active-state shape, for visual consistency) — replace:

```tsx
            className={`flex w-full items-center gap-2.5 rounded-md border-l-2 py-2 pe-3 ps-2.5 text-sm font-medium transition-colors ${
              billingActive
                ? 'border-sidebar-ring bg-sidebar-accent text-sidebar-accent-foreground shadow-sm'
                : 'border-transparent text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground'
            }`}
```

with:

```tsx
            className={`flex w-full items-center gap-2.5 rounded-full py-2 pe-3 ps-2.5 text-sm font-medium transition-colors ${
              billingActive
                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                : 'text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground'
            }`}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/components/LeftNav.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/LeftNav.tsx tests/components/LeftNav.test.tsx
git commit -m "feat: restyle LeftNav active state as a filled pill instead of a left border bar"
```

---

## Task 5: Restyle PatientPortalSideNav to match

**Files:**
- Modify: `src/components/PatientPortalSideNav.tsx:42-53`
- Test: `tests/components/PatientPortalSideNav.test.tsx`

**Interfaces:**
- Consumes: `ClinsyncLogo` from Task 3.
- Produces: no interface change.

- [ ] **Step 1: Write the failing test**

Create `tests/components/PatientPortalSideNav.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PatientPortalSideNav } from '@/components/PatientPortalSideNav'

vi.mock('next/navigation', () => ({ usePathname: () => '/patient-portal/messages' }))

describe('PatientPortalSideNav', () => {
  it('renders the Clinsync wordmark instead of any logo image', () => {
    render(<PatientPortalSideNav />)
    expect(screen.getByText('Clinsync')).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('gives the active nav link a filled rounded-full pill background, not a left border bar', () => {
    render(<PatientPortalSideNav />)
    const activeLink = screen.getByRole('link', { name: /messages/i, current: 'page' })
    expect(activeLink.className).toMatch(/rounded-full/)
    expect(activeLink.className).not.toMatch(/border-l-2/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/components/PatientPortalSideNav.test.tsx`
Expected: FAIL on the pill-shape assertion (same reasoning as Task 4).

- [ ] **Step 3: Implement**

In `src/components/PatientPortalSideNav.tsx`, replace:

```tsx
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`flex items-center gap-2.5 rounded-md border-l-2 py-2 pe-3 ps-2.5 text-sm font-medium transition-colors ${
                  active
                    ? 'border-sidebar-ring bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'border-transparent text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                }`}
              >
```

with:

```tsx
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`flex items-center gap-2.5 rounded-full py-2 pe-3 ps-2.5 text-sm font-medium transition-colors ${
                  active
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                }`}
              >
```

(The `IpmgIcon` import and logo block in this file are already replaced in Task 3, Step 7 — no further change needed here beyond the active-state class.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/components/PatientPortalSideNav.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/PatientPortalSideNav.tsx tests/components/PatientPortalSideNav.test.tsx
git commit -m "feat: restyle PatientPortalSideNav active state to match LeftNav's filled pill"
```

---

## Task 6: Extract a shared `useDashboardData` result type and split Home into role components

**Files:**
- Create: `src/components/dashboards/AdminDashboard.tsx`
- Create: `src/components/dashboards/CoordinatorDashboard.tsx`
- Modify: `src/app/(dashboard)/page.tsx` (replace entire contents)
- Test: `tests/pages/dashboard-routing.test.tsx`

**Interfaces:**
- Consumes: `getDashboardData()` from `@/lib/queries/dashboard` (existing, unchanged — returns `{ latestForms, pendingForms, pendingFormsTotal, pendingClassification, recentEvents, patientsByMonth, screeningBreakdown, peakHourRange, avgExperienceRating, completedReviewCount }`), `listFormTemplates()` from `@/lib/queries/form-templates`, `listPatientsWithStatus(null)` from `@/lib/queries/patients`, `listAppointmentsInRange(start, end)` from `@/lib/queries/appointments`, `listAllUsers()` from `@/lib/queries/users` (new consumer, existing function), `listAuditLog` is NOT called directly here (the audit-log link is a `<Link>`, not an inline fetch).
- Produces: `AdminDashboard(props)` and `CoordinatorDashboard(props)` — both accept the identical prop shape (defined in Step 3 below) so `src/app/(dashboard)/page.tsx` fetches data once and passes the same object to whichever component the role selects. Task 7 and Task 8 fill in each component's content; this task only creates the files with a minimal placeholder body that Task 7/8 replace, and wires the routing.

- [ ] **Step 1: Write the failing test**

Create `tests/pages/dashboard-routing.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'

const mockRedirect = vi.fn()
vi.mock('next/navigation', () => ({ redirect: mockRedirect }))
vi.mock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: 'pi', name: 'Test PI' })) }))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/dashboard', () => ({ getDashboardData: vi.fn(async () => ({
  latestForms: [], pendingForms: [], pendingFormsTotal: 0, pendingClassification: [], recentEvents: [],
  patientsByMonth: [], screeningBreakdown: { green: 0, yellow: 0, red: 0 }, peakHourRange: null,
  avgExperienceRating: null, completedReviewCount: 0,
})) }))
vi.mock('@/lib/queries/form-templates', () => ({ listFormTemplates: vi.fn(async () => []) }))
vi.mock('@/lib/queries/patients', () => ({ listPatientsWithStatus: vi.fn(async () => []) }))
vi.mock('@/lib/queries/appointments', () => ({ listAppointmentsInRange: vi.fn(async () => []) }))
vi.mock('@/lib/queries/users', () => ({ listAllUsers: vi.fn(async () => []) }))

import DashboardHomePage from '@/app/(dashboard)/page'

describe('dashboard role routing', () => {
  it('redirects a PI session to /doctor instead of rendering a Home dashboard', async () => {
    await DashboardHomePage()
    expect(mockRedirect).toHaveBeenCalledWith('/doctor')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/pages/dashboard-routing.test.tsx`
Expected: FAIL — today's `page.tsx` renders the shared Home content for every role including `pi`; it never calls `redirect`.

- [ ] **Step 3: Create the two dashboard component files with a shared prop type**

Create `src/components/dashboards/AdminDashboard.tsx`:

```tsx
import type { Session } from '@/lib/auth'

export interface DashboardData {
  latestForms: { id: number; status: string; sentDate: Date | null; completedDate: Date | null; templateName: string; patientName: string }[]
  pendingForms: { id: number; status: string; sentDate: Date | null; completedDate: Date | null; templateName: string; patientName: string }[]
  pendingFormsTotal: number
  pendingClassification: { id: string; nameTebra: string | null; nameIntakeq: string }[]
  recentEvents: { id: number; action: string; userName: string; timestamp: Date }[]
  patientsByMonth: { month: string; count: number }[]
  screeningBreakdown: { green: number; yellow: number; red: number }
  peakHourRange: string | null
  avgExperienceRating: number | null
  completedReviewCount: number
}

export interface DashboardPageProps {
  session: Session
  data: DashboardData
  templates: { id: number; name: string }[]
  patients: { id: string; nameTebra: string | null; nameIntakeq: string }[]
  appointmentsInRange: { id: number; patientId: string; patientName: string; providerName: string; visitReason: string; status: string; startsAt: string }[]
  staffByRole: { role: string; count: number }[]
}

export function AdminDashboard(props: DashboardPageProps) {
  return <div>Admin dashboard placeholder for {props.session.name}</div>
}
```

Create `src/components/dashboards/CoordinatorDashboard.tsx`:

```tsx
import type { DashboardPageProps } from '@/components/dashboards/AdminDashboard'

export function CoordinatorDashboard(props: DashboardPageProps) {
  return <div>Coordinator dashboard placeholder for {props.session.name}</div>
}
```

- [ ] **Step 4: Replace `src/app/(dashboard)/page.tsx` to route by role**

Replace the full contents of `src/app/(dashboard)/page.tsx` with:

```tsx
import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getDashboardData } from '@/lib/queries/dashboard'
import { listFormTemplates } from '@/lib/queries/form-templates'
import { listPatientsWithStatus } from '@/lib/queries/patients'
import { listAppointmentsInRange } from '@/lib/queries/appointments'
import { listAllUsers } from '@/lib/queries/users'
import { AdminDashboard } from '@/components/dashboards/AdminDashboard'
import { CoordinatorDashboard } from '@/components/dashboards/CoordinatorDashboard'

export default async function DashboardHomePage() {
  const session = await requireSessionOrRedirect()

  // PI has its own dedicated dashboard route (My Patients) -- keeping it as
  // a real separate route rather than a conditional render here avoids
  // duplicating /doctor's assignment-matching logic in two places.
  if (session.role === 'pi') redirect('/doctor')

  const now = new Date()
  const rangeStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  const rangeEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)

  const [data, templates, patients, appointmentsInRange, allStaff] = await Promise.all([
    getDashboardData(),
    listFormTemplates(),
    listPatientsWithStatus(null),
    listAppointmentsInRange(rangeStart, rangeEnd),
    listAllUsers(),
  ])
  await logAudit(session, 'viewed home dashboard', null)

  const staffByRole = ['admin', 'pi', 'crc'].map((role) => ({
    role,
    count: allStaff.filter((u) => u.role === role).length,
  }))

  const props = {
    session,
    data,
    templates: templates.map((t) => ({ id: t.id, name: t.name })),
    patients: patients.map((p) => ({ id: p.id, nameTebra: p.nameTebra, nameIntakeq: p.nameIntakeq })),
    appointmentsInRange: appointmentsInRange.map((a) => ({
      id: a.id, patientId: a.patientId, patientName: a.patientName, providerName: a.providerName,
      visitReason: a.visitReason, status: a.status, startsAt: a.startsAt.toString(),
    })),
    staffByRole,
  }

  return session.role === 'admin' ? <AdminDashboard {...props} /> : <CoordinatorDashboard {...props} />
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/pages/dashboard-routing.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/dashboards/AdminDashboard.tsx src/components/dashboards/CoordinatorDashboard.tsx src/app/\(dashboard\)/page.tsx tests/pages/dashboard-routing.test.tsx
git commit -m "feat: route Home to role-specific dashboard components (Admin/Coordinator), PI redirects to /doctor"
```

---

## Task 7: Build the Admin dashboard content

**Files:**
- Modify: `src/components/dashboards/AdminDashboard.tsx` (replace placeholder body)
- Test: `tests/components/dashboards/AdminDashboard.test.tsx`

**Interfaces:**
- Consumes: `DashboardPageProps` from Task 6.
- Produces: no new interface — same component signature from Task 6.

- [ ] **Step 1: Write the failing test**

Create `tests/components/dashboards/AdminDashboard.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AdminDashboard, type DashboardPageProps } from '@/components/dashboards/AdminDashboard'

const baseProps: DashboardPageProps = {
  session: { role: 'admin', name: 'Test Admin' },
  data: {
    latestForms: [], pendingForms: [], pendingFormsTotal: 3, pendingClassification: [{ id: 'RD-0001', nameTebra: 'Jane Doe', nameIntakeq: 'Jane Doe' }],
    recentEvents: [], patientsByMonth: [{ month: 'Jan', count: 2 }], screeningBreakdown: { green: 1, yellow: 2, red: 0 },
    peakHourRange: '10:00 AM – 12:00 PM', avgExperienceRating: 4.5, completedReviewCount: 2,
  },
  templates: [{ id: 1, name: 'Intake Form' }],
  patients: [{ id: 'RD-0001', nameTebra: 'Jane Doe', nameIntakeq: 'Jane Doe' }],
  appointmentsInRange: [],
  staffByRole: [{ role: 'admin', count: 1 }, { role: 'pi', count: 2 }, { role: 'crc', count: 3 }],
}

describe('AdminDashboard', () => {
  it('keeps every widget from the original shared Home page (content parity)', () => {
    render(<AdminDashboard {...baseProps} />)
    expect(screen.getByText(/peak scheduling hours/i)).toBeInTheDocument()
    expect(screen.getByText(/total patients/i)).toBeInTheDocument()
    expect(screen.getByText(/avg\. patient experience/i)).toBeInTheDocument()
    expect(screen.getByText(/patients added/i)).toBeInTheDocument()
    expect(screen.getByText(/screening status breakdown/i)).toBeInTheDocument()
    expect(screen.getByText(/pending forms/i).length ?? screen.getAllByText(/pending forms/i).length).toBeTruthy()
    expect(screen.getByText(/pending classifications/i)).toBeInTheDocument()
    expect(screen.getByText(/form templates/i)).toBeInTheDocument()
    expect(screen.getByText(/latest forms received/i)).toBeInTheDocument()
    expect(screen.getByText(/latest account events/i)).toBeInTheDocument()
  })

  it('adds the new admin-only staff roster card, linking to the existing Settings page', () => {
    render(<AdminDashboard {...baseProps} />)
    expect(screen.getByText(/staff/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /staff/i })).toHaveAttribute('href', '/settings')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/components/dashboards/AdminDashboard.test.tsx`
Expected: FAIL — the placeholder body has none of this content.

- [ ] **Step 3: Implement**

Replace the full contents of `src/components/dashboards/AdminDashboard.tsx` with:

```tsx
import Link from 'next/link'
import { FileClock, ClipboardCheck, LayoutTemplate, Clock, Users, Star, Send, CheckCircle2, Fingerprint, Sparkles, ArrowRight, ShieldCheck } from 'lucide-react'
import type { Session } from '@/lib/auth'
import { DashboardHomeClient } from '@/components/DashboardHomeClient'
import { DashboardAppointmentsTable } from '@/components/DashboardAppointmentsTable'
import { PatientsByMonthChart } from '@/components/PatientsByMonthChart'
import { ScreeningBreakdownChart } from '@/components/ScreeningBreakdownChart'
import { PatientAvatar } from '@/components/PatientAvatar'

export interface DashboardData {
  latestForms: { id: number; status: string; sentDate: Date | null; completedDate: Date | null; templateName: string; patientName: string }[]
  pendingForms: { id: number; status: string; sentDate: Date | null; completedDate: Date | null; templateName: string; patientName: string }[]
  pendingFormsTotal: number
  pendingClassification: { id: string; nameTebra: string | null; nameIntakeq: string }[]
  recentEvents: { id: number; action: string; userName: string; timestamp: Date }[]
  patientsByMonth: { month: string; count: number }[]
  screeningBreakdown: { green: number; yellow: number; red: number }
  peakHourRange: string | null
  avgExperienceRating: number | null
  completedReviewCount: number
}

export interface DashboardPageProps {
  session: Session
  data: DashboardData
  templates: { id: number; name: string }[]
  patients: { id: string; nameTebra: string | null; nameIntakeq: string }[]
  appointmentsInRange: { id: number; patientId: string; patientName: string; providerName: string; visitReason: string; status: string; startsAt: string }[]
  staffByRole: { role: string; count: number }[]
}

const FORM_STATUS_STYLE: Record<string, string> = {
  sent: 'bg-warning/10 text-warning',
  partial: 'bg-accent/10 text-accent',
  completed: 'bg-success/10 text-success',
}

const EVENT_ICON: Record<string, { icon: React.ComponentType<{ className?: string }>; color: string }> = {
  'sent intake form': { icon: Send, color: 'bg-accent/10 text-accent' },
  'completed intake form': { icon: CheckCircle2, color: 'bg-success/10 text-success' },
  'verified identity': { icon: Fingerprint, color: 'bg-primary/10 text-primary' },
  'ran classification': { icon: Sparkles, color: 'bg-accent/10 text-accent' },
}
const EVENT_ICON_FALLBACK = { icon: Clock, color: 'bg-muted text-muted-foreground' }

function EmptyRow({ text }: { text: string }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{text}</p>
}

const CARD_SURFACE = 'rounded-xl border border-primary/10 bg-card/80 shadow-sm backdrop-blur-sm transition-all duration-200 hover:border-primary/25 hover:shadow-md'

function MiniStatTile({ value, label, href, icon: Icon }: { value: number; label: string; href: string; icon: React.ComponentType<{ className?: string }> }) {
  return (
    <Link href={href} className="flex items-center gap-3 rounded-lg border border-primary/15 bg-primary/5 p-4 backdrop-blur-sm transition-colors duration-200 hover:bg-primary/10">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden="true">
        <Icon className="h-4.5 w-4.5" />
      </span>
      <div>
        <p className="text-2xl font-bold tabular-nums text-primary">{value}</p>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      </div>
    </Link>
  )
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-3 border-l-2 border-primary/40 pl-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</h2>
}

export function AdminDashboard({ session, data, templates, patients, appointmentsInRange, staffByRole }: DashboardPageProps) {
  const screenedCount = data.screeningBreakdown.green + data.screeningBreakdown.yellow + data.screeningBreakdown.red
  const unscreenedCount = Math.max(patients.length - screenedCount, 0)
  const screenedPct = patients.length > 0 ? Math.round((screenedCount / patients.length) * 100) : 0
  const now = new Date()
  const currentMonthLabel = data.patientsByMonth[now.getMonth()]?.month

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Hello, {session.name}!</h1>
          <p className="text-sm text-muted-foreground">Here&apos;s what&apos;s happening across the practice today.</p>
        </div>
        <DashboardHomeClient templates={templates} patients={patients} />
      </div>

      <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-4">
        <div className={`${CARD_SURFACE} p-5`}>
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Peak Scheduling Hours</span>
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent" aria-hidden="true"><Clock className="h-4 w-4" /></span>
          </div>
          <p className="text-2xl font-bold text-foreground">{data.peakHourRange ?? 'Not enough data yet'}</p>
          <p className="mt-1 text-xs text-muted-foreground">Busiest 2-hour window across scheduled appointments</p>
        </div>

        <div className={`${CARD_SURFACE} p-5`}>
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Total Patients</span>
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden="true"><Users className="h-4 w-4" /></span>
          </div>
          <p className="text-3xl font-bold tabular-nums text-foreground">{patients.length}</p>
          <div className="mt-3 flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-primary" style={{ width: `${screenedPct}%` }} />
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">{screenedCount} screened · {unscreenedCount} not yet screened</p>
        </div>

        <div className={`${CARD_SURFACE} p-5`}>
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Avg. Patient Experience</span>
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-warning/10 text-warning" aria-hidden="true"><Star className="h-4 w-4" /></span>
          </div>
          <p className="text-3xl font-bold tabular-nums text-foreground">{data.avgExperienceRating !== null ? data.avgExperienceRating.toFixed(1) : '—'}</p>
          <p className="mt-1 text-xs text-muted-foreground">{data.completedReviewCount} completed experience survey{data.completedReviewCount === 1 ? '' : 's'}</p>
        </div>

        <Link href="/settings" className={`${CARD_SURFACE} p-5 transition-colors hover:bg-secondary/40`}>
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Staff</span>
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden="true"><ShieldCheck className="h-4 w-4" /></span>
          </div>
          <p className="text-3xl font-bold tabular-nums text-foreground">{staffByRole.reduce((sum, r) => sum + r.count, 0)}</p>
          <p className="mt-1 text-xs text-muted-foreground">{staffByRole.map((r) => `${r.count} ${r.role}`).join(' · ')}</p>
        </Link>
      </div>

      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-5">
        <section className={`${CARD_SURFACE} p-5 lg:col-span-3`}>
          <SectionHeading>Patients Added ({now.getFullYear()})</SectionHeading>
          <PatientsByMonthChart data={data.patientsByMonth} highlightMonth={currentMonthLabel} />
        </section>
        <section className={`${CARD_SURFACE} p-5 lg:col-span-2`}>
          <SectionHeading>Screening Status Breakdown</SectionHeading>
          <ScreeningBreakdownChart breakdown={data.screeningBreakdown} />
        </section>
      </div>

      <section className={`${CARD_SURFACE} mb-6 p-5`}>
        <DashboardAppointmentsTable appointments={appointmentsInRange} />
      </section>

      <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-4">
        <MiniStatTile value={data.pendingFormsTotal} label="Pending Forms" href="/client-forms" icon={FileClock} />
        <MiniStatTile value={data.pendingClassification.length} label="Pending Classifications" href="/patients" icon={ClipboardCheck} />
        <MiniStatTile value={templates.length} label="Form Templates" href="/forms" icon={LayoutTemplate} />
        <MiniStatTile value={patients.length} label="Total Patients" href="/patients" icon={Users} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className={`${CARD_SURFACE} p-5`}>
          <SectionHeading>Latest Forms Received</SectionHeading>
          {data.latestForms.length === 0 ? <EmptyRow text="No forms received yet." /> : (
            <ul className="divide-y divide-border">
              {data.latestForms.map((f) => (
                <li key={f.id}>
                  <Link href={`/client-forms/${f.id}`} className="flex items-center gap-3 py-2.5 transition-colors hover:bg-secondary/40 -mx-2 px-2 rounded-lg">
                    <PatientAvatar name={f.patientName} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{f.patientName}</p>
                      <p className="truncate text-xs text-muted-foreground">{f.templateName}</p>
                    </div>
                    <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={`${CARD_SURFACE} p-5`}>
          <SectionHeading>Pending Forms</SectionHeading>
          {data.pendingForms.length === 0 ? <EmptyRow text="No pending forms." /> : (
            <ul className="divide-y divide-border">
              {data.pendingForms.map((f) => (
                <li key={f.id}>
                  <Link href={`/client-forms/${f.id}`} className="flex items-center gap-3 py-2.5 transition-colors hover:bg-secondary/40 -mx-2 px-2 rounded-lg">
                    <PatientAvatar name={f.patientName} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{f.patientName}</p>
                      <p className="truncate text-xs text-muted-foreground">{f.templateName}</p>
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${FORM_STATUS_STYLE[f.status] ?? 'bg-muted text-muted-foreground'}`}>{f.status}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={`${CARD_SURFACE} p-5`}>
          <SectionHeading>Pending Classifications</SectionHeading>
          {data.pendingClassification.length === 0 ? <EmptyRow text="Everything's been classified." /> : (
            <ul className="divide-y divide-border">
              {data.pendingClassification.map((p) => {
                const name = p.nameTebra ?? p.nameIntakeq
                return (
                  <li key={p.id}>
                    <Link href={`/patients/${p.id}`} className="flex items-center gap-3 py-2.5 transition-colors hover:bg-secondary/40 -mx-2 px-2 rounded-lg">
                      <PatientAvatar name={name} size="sm" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">{name}</p>
                        <p className="truncate text-xs text-muted-foreground">Intake complete, awaiting classification</p>
                      </div>
                      <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    </Link>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section className={`${CARD_SURFACE} p-5`}>
          <SectionHeading>Latest Account Events</SectionHeading>
          {data.recentEvents.length === 0 ? <EmptyRow text="No recent activity." /> : (
            <ul className="divide-y divide-border">
              {data.recentEvents.map((e) => {
                const { icon: Icon, color } = EVENT_ICON[e.action] ?? EVENT_ICON_FALLBACK
                return (
                  <li key={e.id} className="flex items-center gap-3 py-2.5">
                    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${color}`} aria-hidden="true"><Icon className="h-4 w-4" /></span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-foreground">{e.action}</p>
                      <p className="text-xs text-muted-foreground">{e.userName}</p>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">{new Date(e.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
```

Note: this deliberately does NOT add a "view full audit log" link — no dedicated audit-log page/route exists anywhere in the app today (the audit log is currently only ever surfaced via `NotificationPanel`'s admin-only dropdown, fetching `/api/audit-log?limit=10`). Adding a new `/settings/audit-log` route would be a new route, which this plan's Global Constraints explicitly rule out. The Staff card above links to the existing `/settings` page, which is real.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/components/dashboards/AdminDashboard.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboards/AdminDashboard.tsx tests/components/dashboards/AdminDashboard.test.tsx
git commit -m "feat: build the Admin dashboard with full content parity plus staff roster and audit log link"
```

---

## Task 8: Build the Coordinator dashboard content

**Files:**
- Modify: `src/components/dashboards/CoordinatorDashboard.tsx` (replace placeholder body)
- Test: `tests/components/dashboards/CoordinatorDashboard.test.tsx`

**Interfaces:**
- Consumes: `DashboardPageProps`/`DashboardData` from `@/components/dashboards/AdminDashboard` (Task 7 — re-exported from that file; do not redefine the type here, import it).

- [ ] **Step 1: Write the failing test**

Create `tests/components/dashboards/CoordinatorDashboard.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CoordinatorDashboard } from '@/components/dashboards/CoordinatorDashboard'
import type { DashboardPageProps } from '@/components/dashboards/AdminDashboard'

const baseProps: DashboardPageProps = {
  session: { role: 'crc', name: 'Test CRC' },
  data: {
    latestForms: [], pendingForms: [{ id: 1, status: 'sent', sentDate: new Date(), completedDate: null, templateName: 'Intake', patientName: 'Jane Doe' }],
    pendingFormsTotal: 1, pendingClassification: [{ id: 'RD-0001', nameTebra: 'Jane Doe', nameIntakeq: 'Jane Doe' }],
    recentEvents: [{ id: 1, action: 'sent intake form', userName: 'Test CRC', timestamp: new Date() }],
    patientsByMonth: [{ month: 'Jan', count: 2 }], screeningBreakdown: { green: 1, yellow: 2, red: 0 },
    peakHourRange: '10:00 AM – 12:00 PM', avgExperienceRating: 4.5, completedReviewCount: 2,
  },
  templates: [{ id: 1, name: 'Intake Form' }],
  patients: [{ id: 'RD-0001', nameTebra: 'Jane Doe', nameIntakeq: 'Jane Doe' }],
  appointmentsInRange: [],
  staffByRole: [{ role: 'admin', count: 1 }, { role: 'pi', count: 2 }, { role: 'crc', count: 3 }],
}

describe('CoordinatorDashboard', () => {
  it('keeps every widget from the original shared Home page (content parity)', () => {
    render(<CoordinatorDashboard {...baseProps} />)
    expect(screen.getByText(/peak scheduling hours/i)).toBeInTheDocument()
    expect(screen.getByText(/patients added/i)).toBeInTheDocument()
    expect(screen.getByText(/screening status breakdown/i)).toBeInTheDocument()
    expect(screen.getByText(/pending classifications/i)).toBeInTheDocument()
    expect(screen.getByText(/latest account events/i)).toBeInTheDocument()
  })

  it('puts the actionable queues (Pending Forms, Pending Classifications) before the stat row in document order', () => {
    render(<CoordinatorDashboard {...baseProps} />)
    const headings = screen.getAllByRole('heading').map((h) => h.textContent)
    const queueIdx = headings.findIndex((h) => /pending classifications/i.test(h ?? ''))
    const statIdx = headings.findIndex((h) => /patients added/i.test(h ?? ''))
    expect(queueIdx).toBeGreaterThanOrEqual(0)
    expect(statIdx).toBeGreaterThanOrEqual(0)
    expect(queueIdx).toBeLessThan(statIdx)
  })

  it('does not show the admin-only staff roster or audit log link', () => {
    render(<CoordinatorDashboard {...baseProps} />)
    expect(screen.queryByRole('link', { name: /audit log/i })).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/components/dashboards/CoordinatorDashboard.test.tsx`
Expected: FAIL — the placeholder body has none of this content or ordering.

- [ ] **Step 3: Implement**

Replace the full contents of `src/components/dashboards/CoordinatorDashboard.tsx` with:

```tsx
import Link from 'next/link'
import { FileClock, ClipboardCheck, LayoutTemplate, Clock, Users, Star, Send, CheckCircle2, Fingerprint, Sparkles, ArrowRight } from 'lucide-react'
import type { DashboardPageProps } from '@/components/dashboards/AdminDashboard'
import { DashboardHomeClient } from '@/components/DashboardHomeClient'
import { DashboardAppointmentsTable } from '@/components/DashboardAppointmentsTable'
import { PatientsByMonthChart } from '@/components/PatientsByMonthChart'
import { ScreeningBreakdownChart } from '@/components/ScreeningBreakdownChart'
import { PatientAvatar } from '@/components/PatientAvatar'

const FORM_STATUS_STYLE: Record<string, string> = {
  sent: 'bg-warning/10 text-warning',
  partial: 'bg-accent/10 text-accent',
  completed: 'bg-success/10 text-success',
}

const EVENT_ICON: Record<string, { icon: React.ComponentType<{ className?: string }>; color: string }> = {
  'sent intake form': { icon: Send, color: 'bg-accent/10 text-accent' },
  'completed intake form': { icon: CheckCircle2, color: 'bg-success/10 text-success' },
  'verified identity': { icon: Fingerprint, color: 'bg-primary/10 text-primary' },
  'ran classification': { icon: Sparkles, color: 'bg-accent/10 text-accent' },
}
const EVENT_ICON_FALLBACK = { icon: Clock, color: 'bg-muted text-muted-foreground' }

function EmptyRow({ text }: { text: string }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{text}</p>
}

const CARD_SURFACE = 'rounded-xl border border-primary/10 bg-card/80 shadow-sm backdrop-blur-sm transition-all duration-200 hover:border-primary/25 hover:shadow-md'

function MiniStatTile({ value, label, href, icon: Icon }: { value: number; label: string; href: string; icon: React.ComponentType<{ className?: string }> }) {
  return (
    <Link href={href} className="flex items-center gap-3 rounded-lg border border-primary/15 bg-primary/5 p-4 backdrop-blur-sm transition-colors duration-200 hover:bg-primary/10">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden="true">
        <Icon className="h-4.5 w-4.5" />
      </span>
      <div>
        <p className="text-2xl font-bold tabular-nums text-primary">{value}</p>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      </div>
    </Link>
  )
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-3 border-l-2 border-primary/40 pl-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</h2>
}

export function CoordinatorDashboard({ session, data, templates, patients, appointmentsInRange }: DashboardPageProps) {
  const now = new Date()
  const currentMonthLabel = data.patientsByMonth[now.getMonth()]?.month

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Hello, {session.name}!</h1>
          <p className="text-sm text-muted-foreground">Here&apos;s what needs your attention today.</p>
        </div>
        <DashboardHomeClient templates={templates} patients={patients} />
      </div>

      {/* Queues first -- a coordinator's job is triage, not analytics. */}
      <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-4">
        <MiniStatTile value={data.pendingFormsTotal} label="Pending Forms" href="/client-forms" icon={FileClock} />
        <MiniStatTile value={data.pendingClassification.length} label="Pending Classifications" href="/patients" icon={ClipboardCheck} />
        <MiniStatTile value={templates.length} label="Form Templates" href="/forms" icon={LayoutTemplate} />
        <MiniStatTile value={patients.length} label="Total Patients" href="/patients" icon={Users} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className={`${CARD_SURFACE} p-5`}>
          <SectionHeading>Pending Forms</SectionHeading>
          {data.pendingForms.length === 0 ? <EmptyRow text="No pending forms." /> : (
            <ul className="divide-y divide-border">
              {data.pendingForms.map((f) => (
                <li key={f.id}>
                  <Link href={`/client-forms/${f.id}`} className="flex items-center gap-3 py-2.5 transition-colors hover:bg-secondary/40 -mx-2 px-2 rounded-lg">
                    <PatientAvatar name={f.patientName} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{f.patientName}</p>
                      <p className="truncate text-xs text-muted-foreground">{f.templateName}</p>
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${FORM_STATUS_STYLE[f.status] ?? 'bg-muted text-muted-foreground'}`}>{f.status}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={`${CARD_SURFACE} p-5`}>
          <SectionHeading>Pending Classifications</SectionHeading>
          {data.pendingClassification.length === 0 ? <EmptyRow text="Everything's been classified." /> : (
            <ul className="divide-y divide-border">
              {data.pendingClassification.map((p) => {
                const name = p.nameTebra ?? p.nameIntakeq
                return (
                  <li key={p.id}>
                    <Link href={`/patients/${p.id}`} className="flex items-center gap-3 py-2.5 transition-colors hover:bg-secondary/40 -mx-2 px-2 rounded-lg">
                      <PatientAvatar name={name} size="sm" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">{name}</p>
                        <p className="truncate text-xs text-muted-foreground">Intake complete, awaiting classification</p>
                      </div>
                      <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    </Link>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section className={`${CARD_SURFACE} p-5`}>
          <SectionHeading>Latest Forms Received</SectionHeading>
          {data.latestForms.length === 0 ? <EmptyRow text="No forms received yet." /> : (
            <ul className="divide-y divide-border">
              {data.latestForms.map((f) => (
                <li key={f.id}>
                  <Link href={`/client-forms/${f.id}`} className="flex items-center gap-3 py-2.5 transition-colors hover:bg-secondary/40 -mx-2 px-2 rounded-lg">
                    <PatientAvatar name={f.patientName} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{f.patientName}</p>
                      <p className="truncate text-xs text-muted-foreground">{f.templateName}</p>
                    </div>
                    <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={`${CARD_SURFACE} p-5`}>
          <SectionHeading>Latest Account Events</SectionHeading>
          {data.recentEvents.length === 0 ? <EmptyRow text="No recent activity." /> : (
            <ul className="divide-y divide-border">
              {data.recentEvents.map((e) => {
                const { icon: Icon, color } = EVENT_ICON[e.action] ?? EVENT_ICON_FALLBACK
                return (
                  <li key={e.id} className="flex items-center gap-3 py-2.5">
                    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${color}`} aria-hidden="true"><Icon className="h-4 w-4" /></span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-foreground">{e.action}</p>
                      <p className="text-xs text-muted-foreground">{e.userName}</p>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">{new Date(e.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>

      <section className={`${CARD_SURFACE} my-6 p-5`}>
        <DashboardAppointmentsTable appointments={appointmentsInRange} />
      </section>

      {/* Stats and charts, secondary to the queues above. */}
      <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className={`${CARD_SURFACE} p-5`}>
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Peak Scheduling Hours</span>
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent" aria-hidden="true"><Clock className="h-4 w-4" /></span>
          </div>
          <p className="text-xl font-bold text-foreground">{data.peakHourRange ?? 'Not enough data yet'}</p>
        </div>
        <div className={`${CARD_SURFACE} p-5`}>
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Total Patients</span>
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden="true"><Users className="h-4 w-4" /></span>
          </div>
          <p className="text-2xl font-bold tabular-nums text-foreground">{patients.length}</p>
        </div>
        <div className={`${CARD_SURFACE} p-5`}>
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Avg. Patient Experience</span>
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-warning/10 text-warning" aria-hidden="true"><Star className="h-4 w-4" /></span>
          </div>
          <p className="text-2xl font-bold tabular-nums text-foreground">{data.avgExperienceRating !== null ? data.avgExperienceRating.toFixed(1) : '—'}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <section className={`${CARD_SURFACE} p-5 lg:col-span-3`}>
          <SectionHeading>Patients Added ({now.getFullYear()})</SectionHeading>
          <PatientsByMonthChart data={data.patientsByMonth} highlightMonth={currentMonthLabel} />
        </section>
        <section className={`${CARD_SURFACE} p-5 lg:col-span-2`}>
          <SectionHeading>Screening Status Breakdown</SectionHeading>
          <ScreeningBreakdownChart breakdown={data.screeningBreakdown} />
        </section>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/components/dashboards/CoordinatorDashboard.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Run both dashboard test files together to confirm they share the same data shape (Review Focus item)**

Run: `npx vitest run tests/components/dashboards/AdminDashboard.test.tsx tests/components/dashboards/CoordinatorDashboard.test.tsx tests/pages/dashboard-routing.test.tsx`
Expected: PASS (6 tests total) — confirms `AdminDashboard` and `CoordinatorDashboard` both accept the identical `DashboardPageProps` shape from the one `getDashboardData()` call in `page.tsx`, not two divergent queries.

- [ ] **Step 6: Commit**

```bash
git add src/components/dashboards/CoordinatorDashboard.tsx tests/components/dashboards/CoordinatorDashboard.test.tsx
git commit -m "feat: build the Coordinator dashboard with queues-first layout and full content parity"
```

---

## Task 9: Restyle the PI dashboard (`/doctor`)

**Files:**
- Modify: `src/app/(dashboard)/doctor/page.tsx` (replace full contents)
- Test: `tests/pages/doctor.test.tsx`

**Interfaces:**
- Consumes: `listPatientsWithStatus(null)` from `@/lib/queries/patients` (existing, unchanged), `PatientsTable` from `@/components/PatientsTable` (existing, unchanged).

- [ ] **Step 1: Write the failing test**

Create `tests/pages/doctor.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import DoctorPortalPage from '@/app/(dashboard)/doctor/page'

vi.mock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: 'pi', name: 'Dr. R. Kunam' })) }))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/patients', () => ({
  listPatientsWithStatus: vi.fn(async () => [
    { id: 'RD-0001', overallStatus: 'green', nameTebra: 'Jane Doe', nameIntakeq: 'Jane Doe', dobTebra: null, dobIntakeq: '1990-01-01', currentProvider: 'Dr. R. Kunam', referralType: null, lastCommunication: null, criteriaSummary: null },
  ]),
}))

describe('PI dashboard (/doctor)', () => {
  it('keeps every stat tile from the original page (content parity)', async () => {
    const jsx = await DoctorPortalPage()
    const { render, screen } = await import('@testing-library/react')
    render(jsx)
    expect(screen.getByText(/total assigned/i)).toBeInTheDocument()
    expect(screen.getByText(/^meets$/i)).toBeInTheDocument()
    expect(screen.getByText(/needs verification/i)).toBeInTheDocument()
    expect(screen.getByText(/potential exclusion/i)).toBeInTheDocument()
    expect(screen.getByText(/my patients/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/pages/doctor.test.tsx`
Expected: this specific test likely PASSES already against the unmodified page (it's testing content parity, and the content hasn't changed yet) — confirming this is a baseline-capture step, not a RED step. That's expected here: this task's real behavior change (token cascade + evidence-emphasis wording) doesn't need new failing assertions, since Tailwind's semantic classes already inherited the new tokens from Task 1 automatically. Proceed to Step 3 to make the one real content addition (the assigned-patients subtitle wording), which the test does not yet assert — skip to Step 3a below to add that assertion first.

- [ ] **Step 2a: Add the one real behavior assertion and confirm it fails**

Add to `tests/pages/doctor.test.tsx`:

```ts
  it('labels the header with an explicit "assigned to you" framing (Heidi-style personalized dashboard)', async () => {
    const jsx = await DoctorPortalPage()
    const { render, screen } = await import('@testing-library/react')
    render(jsx)
    expect(screen.getByText(/assigned to you/i)).toBeInTheDocument()
  })
```

Run: `npx vitest run tests/pages/doctor.test.tsx`
Expected: FAIL on the new test — today's copy is "Patients currently assigned to {session.name}", not "assigned to you".

- [ ] **Step 3: Implement**

Replace the full contents of `src/app/(dashboard)/doctor/page.tsx` with:

```tsx
import { redirect } from 'next/navigation'
import { Users, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listPatientsWithStatus } from '@/lib/queries/patients'
import { PatientsTable } from '@/components/PatientsTable'
import { PatientAvatar } from '@/components/PatientAvatar'

const TILE_COLOR: Record<string, string> = {
  primary: 'bg-primary/10 text-primary',
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/10 text-warning',
  destructive: 'bg-destructive/10 text-destructive',
}

function StatTile({ icon: Icon, value, label, color }: { icon: React.ComponentType<{ className?: string }>; value: number; label: string; color: keyof typeof TILE_COLOR }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-primary/10 bg-card/80 p-4 shadow-sm backdrop-blur-sm transition-all duration-200 hover:border-primary/25 hover:shadow-md">
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${TILE_COLOR[color]}`} aria-hidden="true">
        <Icon className="h-4.5 w-4.5" />
      </span>
      <div>
        <p className="text-2xl font-bold tabular-nums text-foreground">{value}</p>
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      </div>
    </div>
  )
}

export default async function DoctorPortalPage() {
  // Must be the first statement — see the comment in patients/page.tsx.
  const session = await requireSessionOrRedirect()
  if (session.role !== 'pi') redirect('/')

  const patients = await listPatientsWithStatus(null)
  // No real doctor<->patient assignment table exists yet -- currentProvider
  // is free text (see the Design Decision note in seed.ts), and the seeded
  // roster spells the same doctor two different ways ("Dr. R. Kunam" vs
  // "Dr. Rajiv Kunam"). Match on last name so both forms resolve to the
  // same doctor rather than requiring an exact string match.
  const lastName = session.name.trim().split(/\s+/).pop() ?? session.name
  const myPatients = patients.filter((p) => (p.currentProvider ?? '').toLowerCase().includes(lastName.toLowerCase()))

  await logAudit(session, 'viewed My Patients (doctor portal)', null)

  const meetsCount = myPatients.filter((p) => p.overallStatus === 'green').length
  const needsVerificationCount = myPatients.filter((p) => !p.overallStatus || p.overallStatus === 'yellow').length
  const exclusionCount = myPatients.filter((p) => p.overallStatus === 'red').length

  return (
    <div>
      <div className="mb-4 flex items-center gap-4 rounded-xl border border-primary/10 bg-card/80 p-5 shadow-sm backdrop-blur-sm">
        <PatientAvatar name={session.name} size="lg" />
        <div>
          <h1 className="text-2xl font-bold text-foreground">My Patients</h1>
          <p className="text-sm text-muted-foreground">Patients currently assigned to you, {session.name}.</p>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile icon={Users} value={myPatients.length} label="Total assigned" color="primary" />
        <StatTile icon={CheckCircle2} value={meetsCount} label="Meets" color="success" />
        <StatTile icon={AlertTriangle} value={needsVerificationCount} label="Needs verification" color="warning" />
        <StatTile icon={XCircle} value={exclusionCount} label="Potential exclusion" color="destructive" />
      </div>

      {/* Project down to only what PatientsTable renders -- see the same
          comment in patients/page.tsx. */}
      <PatientsTable patients={myPatients.map((p) => ({
        id: p.id,
        overallStatus: p.overallStatus,
        nameTebra: p.nameTebra,
        nameIntakeq: p.nameIntakeq,
        dobTebra: p.dobTebra,
        dobIntakeq: p.dobIntakeq,
        currentProvider: p.currentProvider,
        referralType: p.referralType,
        lastCommunication: p.lastCommunication,
        criteriaSummary: p.criteriaSummary,
      }))} />
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/pages/doctor.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/app/\(dashboard\)/doctor/page.tsx tests/pages/doctor.test.tsx
git commit -m "feat: restyle the PI dashboard with new tokens and a personalized 'assigned to you' framing"
```

---

## Task 10: Restyle the Patient dashboard (patient-portal overview)

**Files:**
- Modify: `src/app/patient-portal/(authenticated)/page.tsx` (replace full contents)
- Test: `tests/pages/patient-portal-overview.test.tsx`

**Interfaces:**
- Consumes: `getPatientPortalData(patientId)` from `@/lib/queries/patient-portal` (existing, unchanged), `listBroadcastsForPatient(patientId)` from `@/lib/queries/broadcasts` (existing, unchanged).

- [ ] **Step 1: Write the failing test**

Create `tests/pages/patient-portal-overview.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import PatientPortalOverviewPage from '@/app/patient-portal/(authenticated)/page'

vi.mock('@/lib/patient-session', () => ({ requirePatientSessionOrRedirect: vi.fn(async () => ({ patientId: 'RD-0001' })) }))
vi.mock('@/lib/patient-portal-audit', () => ({ logPatientPortalAction: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/broadcasts', () => ({ listBroadcastsForPatient: vi.fn(async () => []) }))
vi.mock('@/lib/queries/patient-portal', () => ({
  getPatientPortalData: vi.fn(async () => ({
    currentProvider: 'Dr. R. Kunam',
    activeMedications: [{ name: 'Sertraline' }],
    diagnoses: [{ code: 'F33.1', description: 'Major depressive disorder' }],
    upcomingAppointments: [{ visitReason: 'Follow-up', providerName: 'Dr. R. Kunam', startsAt: new Date().toISOString() }],
    forms: [{ status: 'sent', templateName: 'Intake Form' }],
    unreadMessageCount: 2,
  })),
}))

describe('Patient dashboard (patient-portal overview)', () => {
  it('keeps every summary tile and section from the original page (content parity)', async () => {
    const jsx = await PatientPortalOverviewPage()
    const { render, screen } = await import('@testing-library/react')
    render(jsx)
    expect(screen.getByText(/care team/i)).toBeInTheDocument()
    expect(screen.getByText(/current meds/i)).toBeInTheDocument()
    expect(screen.getByText(/forms to complete/i)).toBeInTheDocument()
    expect(screen.getByText(/upcoming visits/i)).toBeInTheDocument()
    expect(screen.getByText(/new messages/i)).toBeInTheDocument()
    expect(screen.getByText(/announcements/i)).toBeInTheDocument()
    expect(screen.getByText(/your care team/i)).toBeInTheDocument()
    expect(screen.getByText(/diagnoses on file/i)).toBeInTheDocument()
  })

  it('puts the action-nudge cards (next visit, needs attention) before the summary tiles in document order (Hims-style Action Items pattern)', async () => {
    const jsx = await PatientPortalOverviewPage()
    const { render, container } = await import('@testing-library/react')
    render(jsx)
    const nudge = container.querySelector('[data-testid="patient-action-items"]')
    const tiles = container.querySelector('[data-testid="patient-summary-tiles"]')
    expect(nudge).not.toBeNull()
    expect(tiles).not.toBeNull()
    expect(nudge!.compareDocumentPosition(tiles!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/pages/patient-portal-overview.test.tsx`
Expected: the first test PASSES already (content parity, nothing removed yet); the second FAILs — today's page has no `data-testid="patient-action-items"` or `data-testid="patient-summary-tiles"` markers, and the summary tiles render before the nudge cards, not after.

- [ ] **Step 3: Implement**

Replace the full contents of `src/app/patient-portal/(authenticated)/page.tsx` with:

```tsx
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { Pill, Stethoscope, CalendarCheck, FileText, MessageSquare, ArrowRight, Megaphone } from 'lucide-react'
import { requirePatientSessionOrRedirect } from '@/lib/patient-session'
import { getPatientPortalData } from '@/lib/queries/patient-portal'
import { listBroadcastsForPatient } from '@/lib/queries/broadcasts'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'

const SECTION = 'rounded-xl border border-primary/10 bg-card/80 p-5 shadow-sm backdrop-blur-sm'
const HEADING = 'mb-3 border-l-2 border-primary/40 pl-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground'

const TILE_COLOR: Record<string, string> = {
  primary: 'bg-primary/10 text-primary',
  accent: 'bg-accent/10 text-accent',
  warning: 'bg-warning/10 text-warning',
  success: 'bg-success/10 text-success',
}

// Each tile links to the page it summarizes -- a real, functional
// navigation shortcut, not a decorative stat, matching how the report
// tables elsewhere in the app made rows clickable rather than inert.
function SummaryTile({ icon: Icon, value, label, color, href }: { icon: React.ComponentType<{ className?: string }>; value: string | number; label: string; color: keyof typeof TILE_COLOR; href?: string }) {
  const content = (
    <>
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${TILE_COLOR[color]}`} aria-hidden="true">
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-base font-bold text-foreground">{value}</p>
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      </div>
    </>
  )
  const className = 'flex items-center gap-3 rounded-xl border border-primary/10 bg-card/80 p-3.5 shadow-sm backdrop-blur-sm transition-all duration-200 hover:border-primary/25 hover:shadow-md'
  return href ? <Link href={href} className={`${className} hover:-translate-y-0.5`}>{content}</Link> : <div className={className}>{content}</div>
}

export default async function PatientPortalOverviewPage() {
  const session = await requirePatientSessionOrRedirect()
  const data = await getPatientPortalData(session.patientId)
  if (!data) notFound()

  const broadcasts = await listBroadcastsForPatient(session.patientId)
  await logPatientPortalAction('viewed patient portal overview', session.patientId)

  const nextAppointment = data.upcomingAppointments[0]
  const formsToComplete = data.forms.filter((f) => f.status !== 'completed')
  const hasActionItems = Boolean(nextAppointment) || formsToComplete.length > 0

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-foreground">Welcome back</h1>

      {hasActionItems && (
        <div data-testid="patient-action-items" className="grid gap-4 sm:grid-cols-2">
          {nextAppointment && (
            <Link href="/patient-portal/appointments" className={`${SECTION} group flex items-center justify-between transition-all duration-200 hover:border-primary/25 hover:shadow-md`}>
              <div>
                <h2 className={HEADING}>Your next visit</h2>
                <p className="text-sm font-medium text-foreground">{nextAppointment.visitReason} with {nextAppointment.providerName}</p>
                <p className="text-xs text-muted-foreground">{new Date(nextAppointment.startsAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</p>
              </div>
              <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
            </Link>
          )}
          {formsToComplete.length > 0 && (
            <Link href="/patient-portal/forms" className={`${SECTION} group flex items-center justify-between transition-all duration-200 hover:border-primary/25 hover:shadow-md`}>
              <div>
                <h2 className={HEADING}>Needs your attention</h2>
                <p className="text-sm font-medium text-foreground">{formsToComplete.length} form{formsToComplete.length === 1 ? '' : 's'} waiting on you</p>
                <p className="text-xs text-muted-foreground">{formsToComplete[0].templateName}{formsToComplete.length > 1 ? ` and ${formsToComplete.length - 1} more` : ''}</p>
              </div>
              <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
            </Link>
          )}
        </div>
      )}

      <div data-testid="patient-summary-tiles" className="grid grid-cols-2 gap-3 sm:grid-cols-6">
        <SummaryTile icon={Stethoscope} value={data.currentProvider ?? 'Unassigned'} label="Care team" color="primary" />
        <SummaryTile icon={Pill} value={data.activeMedications.length} label="Current meds" color="accent" href="/patient-portal/medications" />
        <SummaryTile icon={FileText} value={formsToComplete.length} label="Forms to complete" color="warning" href="/patient-portal/forms" />
        <SummaryTile icon={CalendarCheck} value={data.upcomingAppointments.length} label="Upcoming visits" color="accent" href="/patient-portal/appointments" />
        <SummaryTile icon={MessageSquare} value={data.unreadMessageCount} label="New messages" color="success" href="/patient-portal/messages" />
        <SummaryTile icon={Megaphone} value={broadcasts.length} label="Announcements" color="accent" href="/patient-portal/broadcasts" />
      </div>

      <section className={SECTION}>
        <h2 className={HEADING}>Your care team</h2>
        <p className="text-sm text-foreground">{data.currentProvider ?? 'Not yet assigned'}</p>
      </section>
      <section className={SECTION}>
        <h2 className={HEADING}>Diagnoses on file</h2>
        {data.diagnoses.length === 0 ? (
          <p className="text-sm text-muted-foreground">No diagnoses on file.</p>
        ) : (
          <ul className="space-y-1.5 text-sm text-foreground">
            {data.diagnoses.map((d, i) => <li key={i}>{d.code} — {d.description}</li>)}
          </ul>
        )}
      </section>
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/pages/patient-portal-overview.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/app/patient-portal/\(authenticated\)/page.tsx tests/pages/patient-portal-overview.test.tsx
git commit -m "feat: restyle the Patient dashboard with Action-Items-first layout and full content parity"
```

---

## Task 11: Full-suite verification

**Files:** none modified — verification only.

**Interfaces:** none.

- [ ] **Step 1: Run the full test suite**

Run: `npm run build && npx dotenv -e .env.local -- npx vitest run`
Expected: `npm run build` completes with zero type errors (confirms no dangling `IpmgLogo` import anywhere in the whole app, not just the 5 known sites); the full vitest suite passes, including every test from Tasks 1–10 plus the entire pre-existing suite (no regression in `PatientsTable`, `DashboardAppointmentsTable`, `PatientsByMonthChart`, or `ScreeningBreakdownChart`, all of which are reused unmodified by the new dashboard components).

- [ ] **Step 2: Manually verify in the running dev server**

Run: `npm run dev` (if not already running) and visit `/` as each role (admin, crc) and `/doctor` as `pi`, and `/patient-portal` as a patient session. Confirm: no IPMG logo/name appears anywhere, the new warm-neutral palette renders (not the old blue), nav active states are filled pills, and every widget listed in spec §6 for that role is visible somewhere on the page.

- [ ] **Step 3: Commit any final formatting fixes found during manual verification, if needed**

If Step 2 finds nothing to fix, skip this step — there is nothing to commit.
