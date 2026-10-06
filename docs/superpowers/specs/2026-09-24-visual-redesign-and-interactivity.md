# Sitewide Visual Redesign: Color System, Sidebar, Table Consistency, Interactivity

**Status:** design approved in conversation (color direction + sidebar approach confirmed; table-consistency and interactivity scope grounded in real screenshots of the live app), spec drafted for review before planning.

## 0. Why this exists

The user reviewed the live deployed app (post-MFA-push) and found it still reads as unpolished: a dominant dark green sidebar, several pages that are still plain unstyled tables (the same problem the 4 billing tables had before an earlier fix this session), and rows/cards that don't navigate anywhere when a user would reasonably expect them to. This spec covers all of it as one coordinated pass, since the root cause (color tokens) and the pattern to extend (the `SECTION` card convention already used successfully in ~7 places) are shared across every part of it.

## 1. Color system

**Root cause:** `src/app/globals.css`'s `:root` block defines `--primary`, `--secondary-foreground`, `--ring`, `--sidebar`, `--sidebar-accent`, `--sidebar-border`, and `--chart-3` all on OKLCH hue `165°` (teal, reads as green — confirmed directly in the user's screenshots: the sidebar background is a dark forest green across every page). This is a small, centralized set of CSS custom properties, not scattered hardcoded colors — changing them recolors the whole app in one place, since every component already consumes these tokens (`bg-primary`, `text-primary`, `bg-sidebar`, `border-sidebar-ring`, etc.) rather than hardcoded hex/oklch values.

**Change:** shift the hue-165 family to a professional blue, roughly hue `250°` (close to what this codebase's own `.dark` mode already uses for `--sidebar-primary: oklch(0.488 0.243 264.376)`, so it's a proven-workable hue for this palette, not a guess). Keep lightness/chroma values close to their current numbers so contrast ratios and the overall light/airy feel of the app don't change — only the hue shifts. Specifically:

| Token | Current | New (hue → ~250) |
|---|---|---|
| `--primary` | `oklch(0.42 0.1 165)` | `oklch(0.42 0.1 250)` |
| `--secondary-foreground` | `oklch(0.42 0.1 165)` | `oklch(0.42 0.1 250)` |
| `--ring` | `oklch(0.42 0.1 165)` | `oklch(0.42 0.1 250)` |
| `--chart-3` | `oklch(0.58 0.14 165)` | `oklch(0.58 0.14 250)` |
| `--sidebar` | `oklch(0.32 0.09 165)` | `oklch(0.32 0.09 250)` |
| `--sidebar-accent` | `oklch(0.28 0.08 165)` | `oklch(0.28 0.08 250)` |
| `--sidebar-border` | `oklch(0.28 0.08 165)` | `oklch(0.28 0.08 250)` |

**Unchanged, deliberately:** `--accent` (coral, hue 40) stays — the user called out green specifically, not the coral highlight color, and the coral/blue pairing is a reasonable two-color system (matches the "restrained accent" pattern in the Mobbin references reviewed). `--sidebar-ring` (coral, hue 40, used for the active-nav-item indicator) also stays, so the active state still pops against the new blue sidebar exactly as it does against the current green one.

**Verify during implementation:** grep the codebase for any hardcoded `teal`/`emerald`/`green`-family Tailwind utility classes or raw hex/oklch values that bypass the token system (the plan's own review-focus should include this check) — the token change only cascades automatically for code that already uses `bg-primary`/`bg-sidebar`/etc.; anything hardcoded needs an individual fix.

## 2. Sidebar

Structure stays — role-scoped nav items, grouped sections (Workspace/Billing/Operations), the collapsible Billing group, and the left-border active-state indicator are all sound and already match how established references (Zoho CRM, Google Workspace Admin) build sidebars. Only refine, don't rebuild:

- Active-state treatment: currently a left border + `bg-sidebar-accent` fill. Keep the fill, consider a filled rounded-corner highlight (matching the reference screenshots' pill-style active states) instead of/in addition to the border, for a slightly more "designed" feel.
- Group separators: `GroupLabel` already renders uppercase small labels with `mt-4` spacing — check whether a subtle divider line reads better than pure whitespace once the new blue is in place (visual call, decide during implementation by looking at it rendered).
- No change to the role-based item filtering logic (`ITEMS`/`BILLING_ITEMS`/`TRAILING_ITEMS` role arrays) — that's access-control logic, out of scope for a visual pass.

## 3. Table/list page consistency

The `SECTION` constant (`'rounded-xl border border-primary/10 bg-card/80 p-5 shadow-sm backdrop-blur-sm'`) is already used in ~7+ places across the app (home dashboard, patient list, settings tabs, experience-surveys, and — as of this session — the 4 redesigned billing tables). Client Forms is confirmed still using a bare, unstyled `<table>` (visible directly in the reviewed screenshot — plain white background, no card, no elevation). Apply the same treatment to every remaining plain-table page:

- `src/app/(dashboard)/client-forms/page.tsx` (confirmed flat via screenshot)
- `src/app/(dashboard)/reports/*` — audit, apply if flat
- `src/app/(dashboard)/documents/page.tsx` + `src/components/DocumentsReportTable.tsx` — audit, apply if flat
- `src/app/(dashboard)/broadcasts/page.tsx` — audit, apply if flat
- `src/app/(dashboard)/workbook/page.tsx` + `src/components/WorkbookTable.tsx` — audit, apply if flat
- `src/app/(dashboard)/identity-matching/page.tsx` — audit, apply if flat

`src/app/(dashboard)/experience-surveys/*` already uses `SECTION` — leave alone. Each page: confirm current state by reading the file first (don't assume), apply `SECTION` (or extract a shared constant if this makes it an 8th+ duplicate — implementer's judgment, matching how the billing-table redesign handled this same question) only where genuinely still flat.

## 4. Interactivity — every record row navigates to its detail view

Concrete rule: **a table/list row or card that represents one specific record (a patient, a form submission, an appointment, a trial, a document, a broadcast, an identity-match candidate) must be clickable and navigate to that record's detail page, wherever a detail page exists or reasonably should.** Purely aggregate/summary rows (a stat count, a "Everything's been classified" empty state) are not in scope — only rows that represent one real entity.

Audit every list/table page during implementation against this rule:
- Confirmed already correct: Patients cards (→ patient detail), patient list "Medical Record" links, Client Forms' patient-name links (→ patient detail — confirmed clickable in the reviewed screenshot, styled as a link).
- Confirmed needing work: the Home dashboard's Appointments table (screenshot shows plain rows, no visible link/arrow) — each row should navigate to that appointment or the patient's record. "Latest Forms Received" already shows a trailing arrow icon (likely already a link — verify) while "Pending Forms" does not (verify and fix if not).
- Audit during implementation, not pre-specified here: Trials list, Reports rows, Documents rows, Broadcasts rows, Workbook rows, Identity Matching candidate rows — for each, confirm whether a detail view exists (many likely already do, per the `[id]`/`[trialId]`/`[chargeId]` dynamic routes already present in this codebase) and wire navigation if a row currently renders as static text/a `<tr>` with no link.

Where no detail page exists yet for a given entity type, do NOT invent a new page as part of this pass — flag it and leave the row non-interactive, since building new detail views is separate scope from making existing ones reachable.

## 5. Explicitly out of scope

- Any change to role/access-control logic (who can see which nav items, which pages) — this is a visual and navigation pass only.
- Building new detail pages where none exist (see §4).
- Auth architecture (confirmed in conversation: staying on the current custom TOTP + `jose` session system, not migrating to Better Auth).
- The patient portal's own visual language (soft/centered/calm) — already validated against real references (Hims/Hers) as the right direction for that audience; it inherits the new blue token automatically and needs no structural change.
- Anything already redesigned this session: the 4 billing tables, both login pages, all Settings tabs (already confirmed polished in a prior audit this session).
