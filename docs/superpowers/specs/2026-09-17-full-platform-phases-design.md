# Full-Platform Phases: Architecture & Scope

**Status:** approved for planning. Covers Phases 2–6, building on Phase 1 (`docs/superpowers/plans/2026-09-17-intake-chart-workflow.md`, in progress in worktree `intake-chart-workflow`).

## 1. Why this document exists

The client asked for everything visible in the 78-screenshot catalog (`docs/superpowers/specs/2026-09-17-tebra-intakeq-screenshot-catalog.md`) to exist in Clinsync, built to a professional EHR-grade standard, with the combined pre-screening workbook (Phase 1, Task 9) remaining the product's centerpiece. This document sets the cross-phase boundaries so five phases built by five different planning passes don't collide on schema, routes, or navigation, and it records the few places where a real Tebra/IntakeQ feature is deliberately adapted or dropped rather than cloned verbatim — because the literal feature would be unsafe, meaningless, or out of place in this product.

## 2. Phase map

| Phase | Covers | Plan file (to be written) |
|---|---|---|
| 1 (in progress) | Intake forms/templates, form submissions, chart additions (meds/allergies/identity), Home Dashboard, classification workflow, comprehensive Excel export | `docs/superpowers/plans/2026-09-17-intake-chart-workflow.md` |
| 2 | Scheduling & Calendar | `docs/superpowers/plans/2026-09-17-phase2-scheduling.md` |
| 3 | Billing & Financial (charges, insurance collections, patient collections, statements, A/R dashboard, billing analytics, mock payment capture) | `docs/superpowers/plans/2026-09-17-phase3-billing.md` |
| 4 | Reports module + Documents/Fax + Charge Capture detail | `docs/superpowers/plans/2026-09-17-phase4-reports-documents.md` |
| 5 | Engagement/Marketing (broadcasts, surveys & reviews, online presence, performance dashboard) | `docs/superpowers/plans/2026-09-17-phase5-engagement.md` |
| 6 | Practice/Account Settings expansion (Provider Profiles, deep settings nav, My Account) | `docs/superpowers/plans/2026-09-17-phase6-practice-settings.md` |

Each phase plan follows the same conventions as Phase 1's plan (Global Constraints block, task-by-task with complete code, `requireSession`/`requireSessionOrRedirect`, shared query functions, Zod validation, audit logging, zero decorative icons, teal/coral tokens, zebra striping). Phase plans are executed via subagent-driven-development the same way Phase 1 is being executed.

## 3. Explicit adaptations and exclusions (read before planning any phase)

Real Tebra/IntakeQ features that are either unsafe, meaningless, or out of place to clone literally in a trial pre-screening pilot:

- **Virtual Card Payment (Phase 3):** built as a **mock-only** payment capture form — it records a `mockPayments` row and shows a success/failure state against fake validation rules (e.g., a card number failing Luhn check fails; anything passing succeeds). It **never** integrates a real payment processor, never handles real card data, and is clearly a simulated flow for demo purposes. Attempting genuine PCI-scope payment processing in a pilot demo would be a real compliance liability, not a feature.
- **Fax (Phase 4):** `faxes` are database rows with a simulated `deliveryStatus` (Delivered/Failed set by a mock random-ish rule, not a real fax transmission) — there is no real telephony/fax integration.
- **Patient Broadcast SMS/Email delivery (Phase 5):** broadcasts are recorded with a status, no real SMS/email provider is integrated (mirrors the existing project-wide pattern: Tebra/IntakeQ connectors are already mocks per `src/connectors/*.mock.ts`, established in the original prototype build).
- **"Patient Experience upsell/quote" page:** **dropped entirely.** This page is Tebra marketing an add-on subscription to itself — there is nothing for Clinsync to adapt it into, since Clinsync isn't selling itself a module.
- **MIPS/Quality Measures incentive reporting, Surveys-&-Reviews AI-response promo banners, "Tebra Community"/"Customer Care" links:** dropped — these are vendor-specific ecosystem features (Tebra promoting its own community/support surfaces, or a government incentive-program specific to Tebra's own billing customers) with no equivalent meaning inside Clinsync.
- **300k-patient-scale pagination/enterprise chrome:** Clinsync has dozens of patients, not hundreds of thousands. Every phase implements the *pattern* (a real toolbar with search/filter/columns, real pagination controls) without over-building for a scale that will never occur — e.g., no need for virtualized rendering.

## 4. Schema ownership per phase (avoiding collisions)

Each phase owns entirely new tables — no phase modifies another phase's tables, and no two phases define a table with the same name:

- **Phase 1** (already in its own plan): `formTemplates`, `formSubmissions`, `allergies`, `identityVerifications`, `appSettings`.
- **Phase 2:** `appointments`, `providers` (a real table now, distinct from the informal `currentProvider` free-text field already on `patients` — Phase 2's plan must decide whether to backfill `providers` from distinct `currentProvider` values in seed data or keep them independent; record that decision in Phase 2's plan, don't leave it ambiguous).
- **Phase 3:** `charges`, `insuranceClaims`, `patientStatements`, `mockPayments`. (No `subscriptions`/`plans` tables — Subscription Management's Enroll-Patients/Plans concept is skipped as a distinct feature; its most valuable **pattern** — the enterprise data-grid toolbar — is extracted into a shared component, `src/components/DataGridToolbar.tsx`, reused by Phase 3's charge/claim tables and any later phase's list view that wants it. Building the grid toolbar once as a shared component, rather than once per phase, is a deliberate architectural decision Phase 3's plan should make explicit since it's the first phase to need it.)
- **Phase 4:** `documents`, `faxes`. (Reports themselves are queries over existing/other-phase tables — appointments, formSubmissions, charges — not new tables. Charge Capture reuses Phase 3's `charges`/related tables and is UI-only for Phase 4.)
- **Phase 5:** `broadcasts`, `reviews`.
- **Phase 6:** no new tables — `providers` (Phase 2) becomes the backing data for a Provider Profiles management UI; a practice-info settings row can live in the existing `appSettings` table (Phase 1) if narrow, or a new `practiceSettings` single-row table if the field count grows enough to warrant separating it from the auto-classify toggle (Phase 6's plan decides which, and records why).

## 5. Navigation

`src/components/LeftNav.tsx` grows across phases. Final nav order (Phase 6 finalizes this; earlier phases append their own items in the position given here so no phase collides on ordering):

Home, Patients, Identity Matching, Trials & Protocols, Calendar (Phase 2), Form Templates (Phase 1), Client Forms (Phase 1), Billing (Phase 3, itself expandable to Charges/Insurance Collections/Patient Collections/Statements/A-R Dashboard/Analytics), Reports (Phase 4), Documents (Phase 4), Engagement (Phase 5), Audit Log, Settings (Phase 6 expands into sub-sections).

Each phase's plan adds only its own nav entries and must not re-list or reorder entries from a phase that isn't itself — the phase 6 plan does the final consolidation pass if entries need regrouping under collapsible sections.

## 6. Shared components introduced ahead of need

- **`DataGridToolbar.tsx`** (built in Phase 3, reused by Phase 3/4/5's list views): search input, refresh button, a filter button showing an active-filter-count badge that opens a slide-out panel (searchable field picker, "Add a filter" pattern from the Reports module), and a Columns button (visibility toggle checklist). No density picker, no column pinning, no drag-and-drop column reorder — those are enterprise-scale features (Tebra's 300k-patient grids) that add real complexity for zero benefit at Clinsync's actual data scale; the toolbar's job is to make filtering/searching/column-choice genuinely functional, not to visually replicate every control Tebra ships.
- **Chart library:** none of the existing dependencies render charts. Phase 3 (A/R Dashboard, Billing Analytics) is the first phase that needs one — add `recharts` (React 19 compatible, no heavy runtime cost, common enough that a reviewer/future maintainer will recognize it immediately) as a new dependency in Phase 3's plan. No other phase should introduce a second charting library.

## 7. Testing & delivery (unchanged from Phase 1)

Same standard as Phase 1: `npm test` and `npm run build` clean after every task, full local manual verification before anything is pushed to git, mock/seeded data expanded per phase so every new screen is demonstrable (not empty) for the client walkthrough. Nothing from any phase is pushed until the user reviews and approves.
