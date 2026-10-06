# Sitewide Visual Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recolor the app from its current teal/green palette to a professional blue, polish the sidebar's active-state treatment, extend the existing elevated-card table convention to the remaining flat/unstyled list pages, and wire up navigation on every table/list row that represents one record but currently doesn't link anywhere.

**Architecture:** A centralized CSS-variable change in `globals.css` cascades the color shift across the whole app automatically, since every component already consumes tokens (`bg-primary`, `bg-sidebar`, etc.) rather than hardcoded colors. The sidebar, table-treatment, and interactivity work are then independent, sequential passes on top of that recolored foundation, each verified by `tsc`/`eslint`/`build` plus manual trace (this app has no component-level automated test suite — the existing vitest suite covers API routes and lib functions, not React component rendering).

**Tech Stack:** Next.js App Router, Tailwind CSS v4 (`@theme inline` token system), TypeScript.

**Spec:** `docs/superpowers/specs/2026-09-24-visual-redesign-and-interactivity.md`

## Global Constraints

- Only the OKLCH **hue** of the teal-family tokens changes (165° → 250°); lightness/chroma values stay as close to current as possible so contrast ratios and the app's light/airy feel are preserved.
- `--accent` (coral, hue 40) and `--sidebar-ring` (coral, hue 40) do NOT change — the user called out green specifically, not the coral highlight.
- No change to role/access-control logic anywhere (`LeftNav.tsx`'s `ITEMS`/`BILLING_ITEMS`/`TRAILING_ITEMS` role-filtering arrays, or any `requireSession`/role check) — this is a visual and navigation pass only.
- Do not invent new detail pages for entities that don't have one yet — if a row has nothing to link to, leave it non-interactive and note it in the task report.
- Already redesigned this session, do not re-touch: the 4 billing tables (`ChargesTable.tsx`, `InsuranceClaimsTable.tsx`, `PatientCollectionsTable.tsx`, `PatientStatementsTable.tsx`), both login pages, all Settings tabs, `experience-surveys` (already uses the `SECTION` card convention).
- No automated component tests exist in this codebase for page-level UI — verification is `npx tsc --noEmit` + `npx eslint <files>` + (if available) browser check, else careful manual JSX trace. State clearly in each task's report which method was used.

## Review Focus

- **Hardcoded (non-token) color classes elsewhere in the app.** The token change only cascades for code already using `bg-primary`/`bg-sidebar`/etc. — a component using a raw Tailwind color class (e.g. `bg-teal-900`, `text-emerald-600`) or a literal oklch/hex value would stay green after this plan ships. Task 5 exists specifically to catch this.
- **Contrast after the hue shift.** `--sidebar-foreground` is unchanged (still near-white) against the new `--sidebar` background — confirm text is still clearly readable, not just technically different, once rendered.
- **Nested/conflicting links from the interactivity task.** Some rows (e.g. Client Forms' patient-name cell) already contain a working inner link. Wrapping the whole row in a new `<Link>` around an existing `<Link>` produces invalid nested-anchor HTML and broken click behavior — Task 4 must check for and avoid this per row, not blanket-wrap everything.
- **Existing working links/handlers surviving the table-treatment pass.** Task 3 changes markup (wrapping in card styling) on pages that likely already have some working links inside cells (e.g. Client Forms' patient names) — those must still work identically after the wrap, not just look different.
- **Sidebar polish accidentally touching role-filtering.** Task 2 only touches className strings and possibly the active-state JSX structure — the `ITEMS.filter(...)`/`role` logic must be byte-identical before and after.

---

### Task 1: Color token system

**Files:**
- Modify: `src/app/globals.css:62-91` (the `:root` block's teal-hue-165 tokens)

**Interfaces:**
- Produces: no new interfaces — this is a values-only CSS change. Every component already consumes `--primary`/`--sidebar`/etc. via Tailwind's token system; nothing downstream needs to change to pick up the new color.

- [ ] **Step 1: Read the current file to confirm exact values before editing**

Read `src/app/globals.css` in full. Confirm these exact current lines exist (the plan was written against this state — if any differ, STOP and report BLOCKED rather than editing blind):

```css
--primary: oklch(0.42 0.1 165);
--secondary-foreground: oklch(0.42 0.1 165);
--ring: oklch(0.42 0.1 165);
--chart-3: oklch(0.58 0.14 165);
--sidebar: oklch(0.32 0.09 165);
--sidebar-accent: oklch(0.28 0.08 165);
--sidebar-border: oklch(0.28 0.08 165);
```

- [ ] **Step 2: Change the hue on each of the 7 tokens**

Change only the trailing hue number (`165` → `250`) on each of the 7 lines above — lightness and chroma (the first two numbers) stay exactly as they are:

```css
--primary: oklch(0.42 0.1 250);
--secondary-foreground: oklch(0.42 0.1 250);
--ring: oklch(0.42 0.1 250);
--chart-3: oklch(0.58 0.14 250);
--sidebar: oklch(0.32 0.09 250);
--sidebar-accent: oklch(0.28 0.08 250);
--sidebar-border: oklch(0.28 0.08 250);
```

Do NOT change `--accent` (`oklch(0.56 0.16 40)`), `--sidebar-ring` (`oklch(0.7 0.16 40)`), or anything in the `.dark { ... }` block — this app's staff/patient-facing pages don't currently use a dark-mode toggle in practice, but leave that block untouched regardless, out of scope.

- [ ] **Step 3: Verify with a build**

Run: `npx tsc --noEmit` (expect: no new errors) then `npm run build` (expect: exit 0, same route manifest as before — this is a CSS-only change, so the build should succeed identically to the last known-good build).

- [ ] **Step 4: Visual check**

If browser automation tools are available: run `npm run dev`, open `/` (staff home) and `/patient-portal` (after logging in as a seeded demo user — check `src/db/seed.ts` or existing docs for demo credentials if needed), confirm the sidebar and primary buttons/links now read blue, not green, and text is still legible. If no browser tools available, note that in the report and rely on the `oklch()` hue math plus the build succeeding as verification — flag this as lower-confidence in the report.

- [ ] **Step 5: Commit**

```bash
git add src/app/globals.css
git commit -m "feat: recolor primary/sidebar tokens from teal to professional blue"
```

---

### Task 2: Sidebar polish

**Files:**
- Modify: `src/components/LeftNav.tsx` (the `NavLink` and `GroupLabel` components' className strings only)

**Interfaces:**
- Consumes: the new blue tokens from Task 1 (no code reference needed — `bg-sidebar-accent`/`border-sidebar-ring`/etc. class names are unchanged, only their underlying color values changed).
- Produces: nothing new consumed elsewhere — this is a self-contained visual refinement of one existing component.

- [ ] **Step 1: Read the current file**

Read `src/components/LeftNav.tsx` in full (it's short, ~148 lines). Confirm the `NavLink` component (lines ~68-83) and `GroupLabel` component (lines ~64-66) match what's described below before editing.

- [ ] **Step 2: Refine the active-state treatment**

`NavLink`'s active state currently reads:

```tsx
active
  ? 'border-sidebar-ring bg-sidebar-accent text-sidebar-accent-foreground'
  : 'border-transparent text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
```

Change to a filled, rounded-corner highlight in place of the plain left-border treatment (matching the pill-style active states in the Google Workspace Admin / Zoho CRM references reviewed during design) — keep the left border as a secondary accent, add a slightly more pronounced background and a subtle shadow on the active item so it reads as clearly "selected," not just "hovered":

```tsx
active
  ? 'border-sidebar-ring bg-sidebar-accent text-sidebar-accent-foreground shadow-sm'
  : 'border-transparent text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground'
```

(This is a starting point — if, once rendered, a different specific Tailwind adjustment reads better against the new blue, the implementer may adjust the exact values, but must keep the same structural approach: `border-sidebar-ring` + `bg-sidebar-accent` for active, transparent border + reduced-opacity hover for inactive. Do not remove the left-border accent entirely.)

Apply the identical active/inactive className logic to the `Billing` group toggle button (lines ~115-119), which duplicates the same conditional — keep both in sync.

- [ ] **Step 3: Confirm role-filtering logic is untouched**

Read the diff before committing: `ITEMS.filter((item) => !item.roles || item.roles.includes(role))` (and the equivalent for `trailingItems`, `showBilling`) must appear byte-identical to before your edit. This is the Review Focus item for this task — if a code-formatting tool or an editing mistake touched these lines, revert and redo without touching them.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit` and `npx eslint src/components/LeftNav.tsx` — expect no errors. If browser tools available, check the sidebar renders correctly for at least two different roles (e.g. admin sees Billing group, pi does not) to confirm the filtering logic still works exactly as before.

- [ ] **Step 5: Commit**

```bash
git add src/components/LeftNav.tsx
git commit -m "polish: refine sidebar active-state treatment for the new color system"
```

---

### Task 3: Extend card treatment to remaining flat table pages

**Files:**
- Modify: `src/app/(dashboard)/client-forms/page.tsx`
- Modify: `src/app/(dashboard)/reports/**` (audit; apply only where flat)
- Modify: `src/app/(dashboard)/documents/page.tsx`, `src/components/DocumentsReportTable.tsx` (audit; apply only where flat)
- Modify: `src/app/(dashboard)/broadcasts/page.tsx` (audit; apply only where flat)
- Modify: `src/app/(dashboard)/workbook/page.tsx`, `src/components/WorkbookTable.tsx` (audit; apply only where flat)
- Modify: `src/app/(dashboard)/identity-matching/page.tsx` (audit; apply only where flat)

**Interfaces:**
- Consumes: the `SECTION` card-treatment pattern already established in this codebase: `'rounded-xl border border-primary/10 bg-card/80 p-5 shadow-sm backdrop-blur-sm'` (exact string, copy verbatim — see `src/app/(dashboard)/experience-surveys/page.tsx:8` or `src/app/(dashboard)/settings/page.tsx` for a live example of this constant already in use).
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Read every file in scope first**

Read all six page/component files listed above in full before changing anything. For each, determine: does it already wrap its table/list content in the `SECTION`-style card treatment (rounded-xl, border, shadow, backdrop-blur), or is it a bare `<table>`/`<div>` with no elevation (matching how `ChargesTable.tsx` etc. looked *before* this session's earlier billing-table redesign — plain background, flat borders, zebra striping with no card wrapper)? `client-forms/page.tsx` is confirmed flat (verified directly against a live screenshot of the deployed app during design). The other five are unverified — read them and record what you find in the report; do not assume they need changing.

- [ ] **Step 2: Apply the SECTION treatment to whichever files are genuinely flat**

For each file found flat in Step 1, wrap its table/list content the same way the earlier billing-table redesign did (`git show 068e4ef` is a real, already-shipped reference for the exact transformation this session applied to `ChargesTable.tsx` et al. — read that commit's diff for the precise before/after pattern: card wrapper, bordered/rounded table container, `bg-secondary/40` header row, `last:border-b-0` on rows, `transition-colors` hover, dashed empty-state box). Match each file's existing column/data structure — this task changes wrapper markup and className strings, not what data is displayed or how it's fetched.

If a file is a client component receiving props from a server component page, keep that boundary intact — only add styling, don't refactor data flow.

- [ ] **Step 3: Confirm every existing link/interactive element inside each changed file still works identically**

Before this step, list every `<Link>`, `onClick`, or interactive element already present in each file you touched in Step 2 (e.g. Client Forms' patient-name cells are already links — confirmed in the reviewed screenshot). After applying the card-wrapper styling, re-read the file and confirm each one is still present, still wraps the same content, and wasn't accidentally dropped, duplicated, or broken by the markup change. This is a pure styling pass — zero existing click behavior should change. Note the before/after list in the task report as explicit evidence, not just a general "looks fine."

Run: `npx tsc --noEmit` and `npx eslint <each changed file>` after all edits — expect no new errors (pre-existing unrelated errors, if any, are out of scope; confirm via `git status`/`git stash` comparison against the base commit the same way earlier tasks this session did, per this codebase's now-established verification habit).

- [ ] **Step 5: Manual/visual trace**

If browser tools available, visit each changed page, confirm it now renders with the card treatment and no broken layout, AND click every link identified in Step 3 to confirm it still navigates correctly. If not available, rely on the Step 3 written before/after list as the primary evidence, plus a careful read-through of the final JSX for each file confirming the wrapper structure is well-formed (no unclosed tags, no duplicate keys) — note in the report that this was the verification method used.

- [ ] **Step 6: Commit**

One commit per page, or one combined commit if that reads better — implementer's call, matching how the billing-table redesign handled this same decision:

```bash
git add <changed files>
git commit -m "polish: extend the card-based table treatment to remaining flat list pages"
```

---

### Task 4: Wire up record-row navigation

**Files:**
- Modify: whichever files from Tasks 1-3's scope, plus any other list/table page in the app, are found during audit to have a record row with no working navigation. Likely candidates based on the spec's screenshot review: the Home dashboard's Appointments table (`src/app/(dashboard)/page.tsx` or a component it renders) and its "Pending Forms" list (verify whether it already has the same trailing-arrow link treatment "Latest Forms Received" shows).
- Test: none (no automated coverage for this kind of navigation wiring in this codebase's current test suite) — manual/browser verification only.

**Interfaces:**
- Consumes: existing Next.js dynamic routes already present in this codebase for detail views (e.g. `/patients/[anonId]`, `/patients/[anonId]/medical-record`, `/trials/[trialId]`, `/client-forms/[id]`, `/billing/charges/[chargeId]`) — use `next/link`'s `<Link href="...">`, matching how every other navigable row in this app already works (e.g. `PatientsTable.tsx`'s cards).

- [ ] **Step 1: Audit every list/table page against the spec's rule**

The rule (from the spec, §4): a row/card representing ONE record (a patient, a form submission, an appointment, a trial, a document, a broadcast, an identity-match candidate) must navigate to that record's detail view if one exists. Read through every page under `src/app/(dashboard)/` that renders a table or card list (this includes but is not limited to: the Home dashboard, Trials list, Reports pages, Documents, Broadcasts, Workbook, Identity Matching — the same set Task 3 touched, plus the Home dashboard which Task 3 does not touch). For each, determine: is the row already a `<Link>`/clickable element? If not, does a detail route exist for that record type (check `src/app/(dashboard)/**/[id]/page.tsx`-style folders for the matching entity)?

Record findings in the report as a table: page | row type | currently clickable? | detail route exists? | action taken.

- [ ] **Step 2: Wire navigation where a detail route exists and the row isn't already linked**

For each row identified in Step 1 as "not clickable, detail route exists": wrap the row (or its primary content) in a `<Link href={...}>` from `next/link`, following the exact pattern already used elsewhere in this codebase (e.g. how `PatientsTable.tsx`'s cards or `ChargesTable.tsx`'s rows link to their detail pages — read one of those as the reference pattern for click-target sizing and hover-state styling, don't invent a new interaction pattern).

**Critical: check for nested links first.** If a row already contains an inner `<Link>` (e.g. Client Forms' patient-name cell, confirmed clickable in the reviewed screenshot), do NOT wrap the whole row in another `<Link>` — that produces invalid nested-anchor HTML. Instead, either make only the non-linked parts of the row clickable via a click handler with `router.push()`, or leave that specific row as-is if the existing inner link already satisfies the record-navigates-somewhere intent (a row where the primary identifying field is already a link arguably already meets the spec's rule — use judgment, and say which choice was made and why in the report).

- [ ] **Step 3: Leave non-actionable rows alone, and say so**

For each row identified in Step 1 as "not clickable, no detail route exists": do not build a new page. Note it in the report as an explicit finding (e.g. "Broadcasts list rows have no detail view to link to — out of scope per the spec's §5").

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit` and `npx eslint <every changed file>`. If browser tools available, click through every newly-wired row to confirm it navigates correctly and that no row produces a React nested-anchor console warning/error. If not available, do a careful manual trace of each changed row's JSX, explicitly checking for the nested-link issue described in Step 2, and say so in the report.

- [ ] **Step 5: Commit**

```bash
git add <changed files>
git commit -m "feat: wire up navigation for table/list rows missing links to their detail views"
```

---

### Task 5: Hardcoded-color consistency audit

**Files:**
- Modify: whichever files are found to use hardcoded (non-token) green/teal-family colors.

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing consumed by later tasks — this is the final consistency pass.

- [ ] **Step 1: Search for hardcoded color classes**

Run:
```bash
grep -rniE "bg-(teal|emerald|green)-[0-9]|text-(teal|emerald|green)-[0-9]|border-(teal|emerald|green)-[0-9]" src/ --include="*.tsx"
```
and separately search for any raw `oklch(` or hex color literals inline in `.tsx`/`.css` files outside `globals.css` (a component styling itself directly instead of via the token system):
```bash
grep -rn "oklch(" src/ --include="*.tsx" --include="*.css" | grep -v "src/app/globals.css"
```

- [ ] **Step 2: Fix each genuine finding**

For each match that's actually a green/teal color being used for general UI theming (not a deliberate semantic use — e.g. `bg-success`/`text-success` token usage is fine and expected to stay green-ish for a "success" state semantically, that's not the "brand color reads as green" problem this plan fixes; a hardcoded `bg-emerald-600` on a button or header IS the problem), replace it with the equivalent token class (`bg-primary`, `text-primary`, etc.) so it inherits the new blue and stays consistent going forward. If a match is a legitimate semantic-color use (success/warning/destructive states), leave it — note it in the report as "checked, correctly semantic, not touched."

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit`, `npx eslint <every changed file>`, and `npm run build` (final full-app build check, since this task may touch several unrelated files across the codebase).

- [ ] **Step 4: Commit**

```bash
git add <changed files>
git commit -m "fix: replace remaining hardcoded teal/green colors with the new brand token"
```

---

## Final branch review

After all 5 tasks are complete, run `npm run build` once more on the final state (catches anything the individual tasks' local checks might have missed in combination) and confirm it succeeds, then do a whole-branch review per the chosen execution skill (subagent-driven-development's final review pass) before this is considered ready.
