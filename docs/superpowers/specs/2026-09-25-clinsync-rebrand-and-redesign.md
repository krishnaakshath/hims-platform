# Clinsync Rebrand & Full-App Redesign — Design Spec

**Status:** Draft for review — design spec, not yet implemented.
**Supersedes (visually):** the token/component decisions in `docs/superpowers/specs/2026-09-17-full-platform-phases-design.md` and the incremental cleanup done in `docs/superpowers/plans/2026-09-24-visual-redesign-and-interactivity.md` — this spec is a full replacement of the visual system, not an extension of it.

---

## 1. What this is

Clinsync stops being "IPMG's pilot tool" and becomes a real, standalone, general-purpose EHR product that any practice could use — same name (**Clinsync**), same underlying data model and feature set, but:

1. **No client branding anywhere.** Every `IpmgIcon`/`IpmgWordmark` reference and the `ipmg-icon.png`/`ipmg-logo.png` asset files are removed. Clinsync gets its own wordmark.
2. **A new color and typography system**, replacing the current blue/orange token set entirely — not a tint adjustment, a real palette change.
3. **Reworked layout and data-display patterns** — how lists, tables, and cards look and breathe — informed by real reference products (Mobbin research, §3).
4. **Four distinct, purpose-built dashboards** — Patient, PI, Admin, Coordinator (CRC) — replacing today's one shared Home page with role-based tweaks.
5. **Full scope**: every screen in the app gets redesigned under this system before any of it ships (confirmed with the user — no phased partial rollout).

**Explicitly not in scope:** any backend/business-logic change, any new feature, any change to routes, data contracts, or API shapes. This is a visual and layout system replacing what's already there, screen for screen. The `fix/audit-security-a11y-bugfixes` branch's accessibility work (Dialog primitive migration) stays as the interaction foundation — this spec builds the visual skin on top of it, not around it.

---

## 2. Brand identity

- **Name:** Clinsync (unchanged).
- **Logo:** replace `ClinsyncLogo`'s placeholder stethoscope icon with a clean **typographic wordmark** — "Clinsync" set in the heading font at a fixed weight/tracking, no icon mark required. This matches the pattern of every strongest reference found (Heidi, Linear-style B2B SaaS): the wordmark *is* the logo, nothing to draw or commission.
- **Remove entirely:** `src/components/IpmgLogo.tsx`, `public/branding/ipmg-icon.png`, `public/branding/ipmg-logo.png`, and every import site (`LeftNav.tsx`, `PatientPortalSideNav.tsx`, `src/app/login/page.tsx`, `src/app/patient-portal/login/page.tsx`, `src/app/intake/[token]/page.tsx`) — all five switch to the new `ClinsyncLogo` wordmark instead.
- **Tone:** calm, confident, trustworthy — not clinical-cold, not startup-flashy. A practice's day-to-day tool, not a marketing site.

---

## 3. Reference research (Mobbin)

Primary anchor: **[Heidi](https://mobbin.com/apps/heidi)**, an AI clinical-documentation product for clinicians — the only genuinely healthcare-category result across every search, and it appeared consistently for dashboard, list, sidebar-nav, and detail-view queries alike. Its visual language: warm off-white backgrounds (never stark white or cold gray), confident near-black primary actions instead of a loud brand color, soft rounded cards with subtle shadows, colored pill badges for status/tags, avatar-initial chips, generous line-height and whitespace.

Secondary references for patterns Heidi doesn't have screens for:
- **[Copilot](https://mobbin.com/screens/60a88319-4009-4fe6-9e1e-c534dd92676b)** (client portal) — clean record/detail-with-tabs pattern → informs Patient Detail, Medical Record.
- **[Fresha](https://mobbin.com/screens/1b3c5a4b-5f4e-4825-a1c1-a3534bdeeec8)** — provider-column day/week calendar grid → informs `/calendar`.
- **[Zoho CRM Workqueue](https://mobbin.com/screens/7b9c0b21-4d7a-4b14-a46b-ecfc31672c82)** and **[Linear](https://mobbin.com/screens/212fda35-366e-4dc0-a1d1-3b679659d6ab)** — task-queue-first three-pane layouts → informs the Coordinator dashboard.
- **[Deel](https://mobbin.com/screens/25d42744-d70a-435f-bb25-f3601c96b240)** — clean stat/chart card grids → informs the Admin dashboard.
- **[Aboard](https://mobbin.com/screens/cb9fecf9-7bac-4677-9510-0125393cce8a)** — personalized greeting + widget-grid home → informs the Patient and PI dashboards' top-of-page treatment.
- **[Hims](https://mobbin.com/screens/4e65a1f8-25a1-4145-b5a2-302945590316)** ("Action Items" modal) — patient-facing nudge pattern → informs the Patient dashboard's "things to do" section.

Every reference is used for its *layout and interaction pattern only* — no reference's own color palette, logo, or literal copy is reused, consistent with the project's existing discipline around design-reference sites.

---

## 4. Design tokens

All tokens live in `src/app/globals.css` under the existing `@theme inline` / `:root` / `.dark` structure — same architecture, new values. Concrete starting values below; expect minor visual tuning once real screens are up (that's normal for any token pass and doesn't require a second spec).

| Token | Current | New | Rationale |
|---|---|---|---|
| `--background` | `oklch(0.99 0.004 75)` | `oklch(0.985 0.006 80)` | Slightly warmer, softer off-white — Heidi's canvas, not clinical white. |
| `--foreground` | `oklch(0.22 0.02 230)` (cool navy-black) | `oklch(0.2 0.01 60)` (warm near-black) | Warm neutral text instead of cool navy-tinted. |
| `--primary` | `oklch(0.42 0.1 250)` (deep blue) | `oklch(0.18 0.01 60)` (near-black) | Heidi's confident black-button convention — replaces "brand blue" with "ink," so primary actions read as decisive, not decoratively colored. |
| `--primary-foreground` | `oklch(0.985 0 0)` | `oklch(0.99 0 0)` | Unchanged in spirit (white on primary). |
| `--secondary` | `oklch(0.96 0.006 75)` | `oklch(0.95 0.008 75)` | Same role, slightly warmer to match new background. |
| `--accent` | `oklch(0.56 0.16 40)` (orange) | `oklch(0.62 0.1 45)` (muted clay/terracotta) | One sparing accent color for links/highlights only — used far less often than today; most emphasis comes from the near-black primary and from status pills, not from a saturated accent. |
| `--success` / `--warning` / `--destructive` | existing | **unchanged** | Already confirmed correct in the earlier codebase audit (`StatusChip`'s dot+label pattern) — this redesign doesn't touch verdict semantics. |
| `--border` / `--input` | `oklch(0.9 0.006 70)` | `oklch(0.91 0.008 75)` | Slightly warmer, matches new neutral family. |
| `--chart-1..5` | existing blue/orange/teal/etc. | re-derive from the new neutral+accent family, keeping each chart color perceptually distinct (re-run the same collision check the recent `chart-3`/`chart-1` fix already established as necessary) | Charts must stay distinguishable from each other and from status colors — this is a mechanical re-derivation, not a new design decision. |
| `--radius` | existing | **unchanged** (or evaluated for a slightly larger base radius to match Heidi's softer card corners — final value picked during implementation, not a spec-blocking decision) | Radius scale (`sm`/`md`/`lg`/`xl`/`2xl`) already cascades correctly; only the base value might shift slightly. |

**Typography:** keep the existing Geist Sans/Mono font stack (already a clean, modern sans — no reference product's font is being copied, and Geist already reads close to Heidi's own type feel). No font-family change; only weight/tracking/scale adjustments where the current hierarchy is too flat (e.g. dashboard stat numbers should read larger and bolder than they do today).

**Dark mode:** tokens already exist in `.dark` but there's no UI toggle anywhere (a prior audit finding). This spec does not add one — out of scope unless requested separately. The `.dark` tokens should still be updated to match the new palette's dark equivalent so they're not left stale, but no reachability work.

---

## 5. Core component patterns (apply everywhere)

- **Sidebar nav** (`LeftNav`, `PatientPortalSideNav`): icon + label rows, soft filled-pill highlight on the active item (rounded-full background, not a left border bar), generous vertical padding between items. Wordmark at the top replaces the current logo lockup.
- **Lists/tables** (`PatientsTable`, `ReportTable` and its variants, `ChargesTable`, `InsuranceClaimsTable`, `PatientStatementsTable`, `WorkbookTable`, `DataGridToolbar`): more row height and padding than today, avatar+name pairing as the leading column wherever a person is the row subject, status always as a colored pill (already-correct `StatusChip` pattern extended to every table, not just screening verdicts). Column headers in small uppercase muted text, matching Heidi/Copilot's convention.
- **Cards/panels**: consistent white-on-off-white surface, soft shadow, border radius from the token scale above — this already exists as `bg-card` throughout; this is enforcement, not a new primitive.
- **Status pills**: every place currently rendering ad hoc colored text (the 61 raw Tailwind color classes flagged in the earlier codebase audit — `trials/[trialId]/page.tsx`, `patients/[anonId]/page.tsx`, `DiscrepancyList.tsx`, etc.) is migrated to either the existing `StatusChip`/`AppointmentStatusChip` components or a new equivalent pill component for non-verdict statuses (form status, delivery status, claim status). This redesign is what finally resolves that audit finding — it was correctly deferred to "the frontend pass," and this is that pass.
- **Modals**: already migrated to the accessible `Dialog` primitive on the bugfix branch — this spec only restyles their content (spacing, typography) to match the new token set, not their interaction behavior.
- **Calendar** (`/calendar`): provider-column grid restyled per the Fresha reference — cleaner grid lines, softer appointment blocks, provider avatar+color-dot in the column header instead of today's denser treatment.

---

## 6. The four role-specific dashboards

Each role gets a dedicated page (not one shared `Home` with conditional sections). Server Components already know the session role (`requireSessionOrRedirect()`), so routing to the right dashboard is a session-role check at `src/app/(dashboard)/page.tsx`, same pattern already used for `/doctor`.

**Content-parity rule (applies to every dashboard below):** nothing currently visible to a role is dropped. Today, `admin` and `crc` both see the exact same shared Home page (`src/app/(dashboard)/page.tsx`, backed by `getDashboardData()`); `pi` sees `/doctor`; patients see the patient-portal overview. Every widget enumerated below for a dashboard already exists in the current code — this section is a reorganization spec, not a reduction. Anything genuinely new is called out explicitly as "(new)".

### 6.1 Admin dashboard
**Pattern:** Deel-style stat/chart card grid — an admin wants a full operational picture, so this keeps every widget from today's shared Home page, laid out with larger/bolder stat numbers and tighter card grouping:
- Greeting header + Add Client / Send Form actions (`DashboardHomeClient`)
- Stat row: Peak Scheduling Hours, Total Patients (screened/unscreened split), Avg. Patient Experience (+ completed survey count)
- Patients Added (by month) chart, Screening Status Breakdown chart
- Appointments table (±30 day range)
- Mini stat tiles: Pending Forms, Pending Classifications, Form Templates count, Total Patients
- Latest Forms Received, Pending Forms, Pending Classifications, Latest Account Events lists
- **(new)** Staff-roster-at-a-glance card (count by role) and a direct link into the Audit Log (admin-only, matches the already-shipped Task 1 RBAC fix)

### 6.2 Coordinator (CRC) dashboard
**Pattern:** Zoho CRM Workqueue / Linear-style task-queue-first layout — a CRC's job is triage, not analytics, so the same underlying data as Admin's is kept but re-primaried: the four list widgets that are actually queues (Pending Forms, Pending Classifications, Identity Matching preview, Latest Account Events) move to the top as the main content; the stat row and both charts move below, as secondary reference info, not removed. The appointments table and mini stat tiles stay. This is a structurally different emphasis from Admin's, built from the identical data set — not a subset of it.

### 6.3 PI dashboard
**Pattern:** Heidi/Aboard-style personalized "My Patients" view — keeps every widget from today's `/doctor` page: the avatar+greeting header card, all four stat tiles (Total assigned, Meets, Needs verification, Potential exclusion), and the full `PatientsTable` scoped to the PI's assigned patients. Restyled with the new tokens, plus per-criterion evidence made more visible inline (not just the overall status pill) per the Heidi clinician-context reference — an enhancement to the existing table, not a replacement of it.

### 6.4 Patient dashboard
**Pattern:** Hims' "Action Items" pattern surfaces the two conditional nudge cards (next visit, forms needing attention) more prominently at the top — keeps every widget from today's patient-portal overview: all six summary tiles (Care team, Current meds, Forms to complete, Upcoming visits, New messages, Announcements), the "Your care team" section, and the "Diagnoses on file" list. Calm, reassuring tone; minimal clinical jargon. This is the one dashboard where warmth and simplicity matter most — a patient is not a power user — but still shows everything it shows today.

---

## 7. Full page inventory (every screen gets this treatment)

Staff app (`src/app/(dashboard)/*`): Home→role dashboards (§6), My Patients (folded into PI dashboard), Patients, Patient Detail, Medical Record, Workbook, Identity Matching, Trials & Protocols (list + detail), Calendar, Form Templates (list + editor), Client Forms (list + detail), Messages, Billing (charges, charge detail, AR dashboard, analytics, insurance collections, patient collections, statements, pay), Broadcasts (list + detail + wizard), Experience Surveys (list + detail), Documents (list + fax history), Reports (all five report tables), Pipeline Dashboard, Settings.

Patient Portal (`src/app/patient-portal/*`): Home→Patient dashboard (§6.4), Forms, Medications, Appointments, Messages, Security.

Public: Login, Patient Portal Login, Intake token page (`/intake/[token]`) — these keep their "no staff chrome" simplicity but adopt the new wordmark/token set.

This list is the implementation plan's task inventory — every entry above becomes one or more tasks in the plan that follows this spec.

---

## 8. Risks / open items carried into implementation

- **Chart color re-derivation** (§4) needs the same collision-check discipline as the prior `chart-3`/`chart-1` fix — the plan should include an explicit verification step, not just "pick new hex-equivalents."
- **61 raw-color-class migration** (§5) touches 17 files found in the earlier audit — the plan should enumerate them explicitly rather than relying on a global find/replace, since several of those instances are decorative/categorical (avatar colors, role badges) rather than status semantics and need per-instance judgment, not a blanket swap.
- **IPMG asset removal** (§2) must be paired with confirming no other file references `ipmg-icon.png`/`ipmg-logo.png` by path (not just the two component files) before deleting the assets, to avoid a broken `<img>` src somewhere unaudited.
- **Full-scope rollout** (confirmed with the user: redesign everything before shipping anything) means this will be a large plan — likely worth its own sub-decomposition into per-area plans (tokens+components first, then dashboards, then remaining pages) rather than one enormous task list, decided at planning time.
