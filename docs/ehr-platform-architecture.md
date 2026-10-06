# Building an In-House EHR/Practice-Management Product

**Status:** Draft for review — architecture & feasibility analysis, not yet implemented.
**Ask this answers:** "Add a Tebra-like product — functionally equivalent, but a completely
different, originally-designed product — and explain how it connects to our backend and
frontend, whether the wiring holds together, and what else we'd need."

---

## 1. What Tebra actually is

Tebra is a **practice-management + EHR + billing platform**. Stripped of its own branding
and UI, the product category is four functional modules:

1. **Scheduling** — provider calendars, appointment booking/rescheduling, visit types.
2. **Charting (EHR)** — patient demographics, diagnoses, medications, encounter notes,
   allergies, one longitudinal chart per patient.
3. **Revenue Cycle Management (billing)** — charge entry, insurance claims submission and
   adjudication tracking, patient statements, payment posting.
4. **Patient engagement** — a patient-facing portal (forms, messages, appointment view).

None of that is copyrightable. Copyright protects Tebra's *specific expression* — its logo,
its exact screen layouts, its literal UI copy, its color system, its marketing pages — not
the idea of "a scheduling calendar" or "a claims table." A product that does the same *job*
with its own name, palette, typography, copy, and layout decisions is not a copyright
problem. That's the standard the rest of this doc builds toward: same functional job,
zero shared expression.

**What to explicitly avoid regardless of how this is built:** Tebra's name or logo anywhere
in code, UI copy, or comments; screenshots or scraped markup from Tebra's real product used
as a design reference; any UI that could be mistaken for Tebra's own software if screenshotted
out of context. This is the same discipline already enforced elsewhere in this codebase for
the two UI/UX reference sites used during Clinsync's own design pass — same rule, same reason.

## 2. What Clinsync already has (this is the real headline)

Clinsync wasn't built as "a pre-screening tool that happens to reference an EHR." Large
parts of the four modules above already exist, because the pre-screening workflow needed
real chart and billing data to reconcile against. Concretely, in `src/db/schema.ts`:

| Tebra module | Already-built Clinsync tables | Notes |
|---|---|---|
| Scheduling | `providers`, `appointments` | Provider roster with specialty/credentials; appointments with status, visit reason, start/end times. Rendered today in `/calendar` and the Home dashboard's appointments table. |
| Charting | `patients` (30+ fields), `diagnoses`, `medicationEpisodes`, `allergies`, `identityVerifications` | Dual-sourced (IntakeQ/Tebra) demographic model already exists — see the "Merged (used)" comparison on the Medical Record page. |
| Billing / RCM | `charges`, `insuranceClaims`, `patientStatements`, `mockPayments` | Full charge → claim → statement → payment lifecycle, with every claim status Tebra's own billing module tracks (rejected/denied/waiting-adjudication/needs-investigation/paid). |
| Patient engagement | `formSubmissions`, `messages`, `broadcasts`, `reviews`, patient-portal auth (`patients.portalPasswordHash`) | A working patient portal already exists at `/patient-portal`. |
| Connectors | `src/connectors/tebra.mock.ts`, `intakeq.mock.ts`, `src/lib/ehr-sync.ts` | The mock EHR boundary and the reconciliation pipeline that pulls from it — this is the seam a real product would plug into. |

**The honest framing:** this isn't "build a Tebra clone from scratch." It's "take the EHR/
practice-management functionality Clinsync already has as its *data model*, and give it a
first-class, originally-branded front door instead of treating it as Tebra's mirror."

## 3. The architectural fork: module vs. separate product

Two real options, and this is a decision only you can make — it changes the rest of the
plan:

**Option A — A new section inside Clinsync.** New nav items (e.g. "Charts", "Scheduling",
"Billing" as top-level areas instead of sub-features), reusing the existing schema, auth,
and design system as-is. Fastest to build, zero new infrastructure, but it's still
"Clinsync" as one product with an EHR-shaped area inside it.

**Option B — A separate, distinctly-branded product** (own name, own logo, own login,
possibly its own subdomain), sharing the same Postgres database and possibly the same
Next.js monorepo (a second `app/` route group, or a second deployable app) so it reads/writes
the same `patients`/`appointments`/`charges` tables Clinsync already reconciles against.
This is what "make it like a whole product" most likely means, and it's the direction the
rest of this doc assumes — flag if that's wrong.

Recommendation: **Option B, same database, same monorepo.** A second product with its own
identity, but not a second copy of the data — Clinsync's whole value proposition is
reconciling *one* patient record across systems, so forking the data model would recreate
the exact problem Clinsync exists to solve.

## 4. Backend integration plan

1. **Schema**: no destructive changes needed. The core tables (`patients`, `appointments`,
   `providers`, `diagnoses`, `medicationEpisodes`, `charges`, `insuranceClaims`,
   `patientStatements`) already model this domain. Additive-only changes would be needed for
   anything genuinely new (e.g. encounter/visit notes as free text tied to an appointment —
   there's no `encounter_notes` table today, only appointment `notes`). Any such addition
   follows the project's standing rule: hand-written additive SQL via a throwaway script,
   never `drizzle-kit push` against the shared dev database.
2. **System of record flips.** Today, `patients.nameTebra`/`dobTebra`/etc. are *mirrored*
   from an external Tebra via `src/lib/ehr-sync.ts` and `tebra.mock.ts`. If this new product
   becomes the practice's actual EHR, it **is** the Tebra-equivalent system — so the new
   product's own write paths (its scheduling screen creating an appointment, its charting
   screen adding a diagnosis) write directly into the same `appointments`/`diagnoses`
   tables Clinsync already reads. `tebra.mock.ts` either becomes unnecessary for
   already-covered fields, or stays as the seam for whichever *external* systems (real
   Tebra, real IntakeQ) the practice still uses alongside it — that's a per-field decision,
   not all-or-nothing.
3. **Auth**: reuse `src/lib/auth.ts`'s existing `users` table and `admin/pi/crc` roles
   rather than building a second account system. If the new product needs a role Clinsync's
   staff roles don't cover (e.g. front-desk scheduling-only), extend the `roleEnum`
   additively — same migration discipline as above.
4. **New route handlers**, not a new backend. This stays one Next.js app (or one monorepo)
   with a new set of `src/app/api/...` routes for whatever new writes the new product
   needs (e.g. `POST /api/charts/[patientId]/encounter-notes`), following the exact
   `requireSession()` + Zod `.strict()` + audit-log pattern every existing route already
   uses.

## 5. Frontend integration plan

1. **New route group**, e.g. `src/app/(charts)/...` or a fully separate Next.js app in the
   monorepo if it needs its own domain — either way, a new top-level nav shell (its own
   `LeftNav`-equivalent), not bolted onto Clinsync's existing sidebar.
2. **Original visual identity**: its own name, wordmark, and accent color — distinct from
   both Clinsync's IPMG-green identity *and* anything resembling Tebra's real branding.
   This satisfies the copyright-safety goal directly: the surest way to guarantee zero
   shared expression with Tebra is to make the new product look like neither Tebra nor a
   copy of anything — its own thing.
3. **Shared design system underneath.** Same Tailwind v4 token approach already in
   `globals.css` (oklch-based `--primary`/`--accent`/`--card` tokens), same component
   primitives (`Tabs`, `PatientAvatar`, status-pill conventions) — new *values* for the
   tokens (new brand palette), same *system*. This is also how to resolve the other request
   in this message: match the *quality bar and structural conventions* of the main
   dashboard (card surfaces, avatar+pill rows, real charts) without literally reusing
   Clinsync's IPMG-branded palette, since these are two distinct products.
4. **No new UI kit, no new component library.** Reusing `shadcn`, `recharts`, and the
   existing card/table/modal patterns keeps this from ballooning into a second design
   system to maintain.

## 6. Will the wiring hold together?

Checked against what's actually in the repo today:

- ✅ **Data model** — already there, already used by three separate features (pre-screening,
  billing, patient portal). No structural risk.
- ✅ **Auth/session model** — `requireSession()`/role checks are reusable as-is.
- ✅ **Caching** — `src/lib/cache.ts`'s Redis helpers generalize to any new list/detail
  queries the new product needs.
- ✅ **Audit logging** — `logAudit()` already covers arbitrary actions against a `patientId`;
  new chart-write actions slot in with zero changes.
- ⚠️ **Real-time-ish scheduling conflicts** (double-booking a provider) — `appointments`
  has no overlap constraint today; a real scheduling module needs that validated in the
  route handler, not just assumed.
- ⚠️ **Encounter documentation** — there's no structured visit-note table yet (see §4.1).
  Needs one additive migration before a real charting screen can save notes.
- ❌ **e-Prescribing** — genuinely out of scope for a product like this without real DEA
  EPCS certification, controlled-substance handling, and pharmacy network integration.
  Recommend explicitly *not* building this; a "Medications" chart view (already exists) is
  the honest ceiling here.
- ❌ **Real insurance clearinghouse connectivity** — `insuranceClaims`/`charges` already
  model the *data shape* of a claim, but actually submitting one to a payer requires a real
  clearinghouse contract (e.g. Availity, Change Healthcare) — a business/legal step, not an
  engineering one. The existing mock-payment pattern (`src/lib/queries/broadcasts.ts`'s
  `simulateBroadcastDelivery`, `mockPayments`' Luhn-check-only design) is the right template:
  simulate the outcome deterministically, never claim a real submission happened.

## 7. Open questions that need your decision before implementation starts

1. **Option A vs. B** (§3) — module inside Clinsync, or a separate branded product sharing
   the database?
2. **Name and visual identity** for the new product — needs an actual name before any UI
   work starts.
3. **Scope of the MVP** — all four modules at once, or scheduling + charting first, billing
   second (billing is the most-built already, so it could ship first cheaply)?
4. **Who uses it** — same three staff roles (admin/PI/CRC), or a new front-desk/scheduler
   role?

## 8. Suggested phased roadmap (once the above is answered)

1. **Phase 1 — Identity + shell.** Name, palette, new route group/nav shell, no new data.
2. **Phase 2 — Charting.** Encounter notes table (additive migration) + a real chart-entry
   UI writing into `diagnoses`/`medicationEpisodes`/the new notes table.
3. **Phase 3 — Scheduling.** A real booking UI over `appointments`/`providers`, with
   double-booking validation.
4. **Phase 4 — Billing front door.** A "create charge → claim → statement" workflow UI over
   the already-existing billing tables (the data model is done; this is the thinnest phase).
5. **Phase 5 — Reconciliation cutover.** Decide, field by field, whether `ehr-sync.ts` keeps
   treating this new product as internal (no sync needed — it *is* the data) or as another
   external system to reconcile against (if the practice keeps using real Tebra for some
   patients in parallel).

---

*Next step: answer §7, then this doc gets a companion implementation plan with exact file
paths and migration scripts, the same way every other feature this session was scoped
before code was written.*
