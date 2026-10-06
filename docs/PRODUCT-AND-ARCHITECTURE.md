# Clinsync — Product & Architecture Overview

**What this document is:** a single place that explains what Clinsync is, why it exists, how it's built, and how the pieces fit together — for anyone picking this up who wasn't in the room while it was designed.

---

## 1. What Clinsync is

Clinsync is a **research pre-screening workbook** built for Inland Psychiatric Medical Group (IPMG) as a pilot for clinical trial **NCT06911112**. Its job is to take patients referred into a trial, pull together everything a Clinical Research Coordinator (CRC) or Principal Investigator (PI) needs to decide if that patient is eligible, and produce a defensible, exportable record of that decision.

It is built by Symbiosys Technologies as a **standalone product**. It was designed by studying how two categories of existing healthcare software behave — a patient-intake/scheduling tool and a clinical/EHR system — and combining the best of both into one purpose-built tool for trial pre-screening. It is **not** a live integration with either of those systems, and it never names them anywhere in its own interface: every screen, label, and export in Clinsync is its own product, using its own generic language for where data comes from ("Intake Form" vs. "Clinical Record"), never a third-party brand name.

### The core idea

A referred patient's information genuinely comes from two different places in the real world: what they (or an intake coordinator) entered when they were referred, and what the clinic's own chart already has on file about them. Those two records don't always agree — a patient's name might be spelled differently, a DOB might be a typo, a chart might not exist yet at all. Clinsync's entire reason to exist is:

1. **Hold both versions of the truth** for every dual-sourced field (name, DOB, email, etc.), never silently picking one.
2. **Surface where they disagree** via an Identity Matching Queue, so a human confirms or rejects a match rather than software guessing.
3. **Score trial eligibility from real evidence** — an explicit rule engine evaluates each protocol's criteria (age, diagnosis, medication exclusions, washout periods) against the merged record and returns a red/yellow/green verdict *per criterion*, quoting the source data it used.
4. **Never go green or red on missing evidence.** If a criterion can't be evaluated (no data yet), the verdict is yellow — "needs verification" — never a false pass or false exclusion. This is the single load-bearing safety property of the whole system.
5. **Produce the verification workbook** — a downloadable Excel export combining every patient's dual-sourced fields, match status, and screening verdicts into one auditable document. This is the client's most-valued deliverable and the reason the product exists: turning scattered referral and chart data into one workbook a CRC can act on and a PI can sign off on.

### Who uses it

- **CRC (Clinical Research Coordinator):** day-to-day user — adds patients, sends intake forms, reviews the identity-matching queue, tracks pending work.
- **PI (Principal Investigator):** reviews screening verdicts and evidence to make enrollment decisions.
- **Admin:** manages settings, oversees the audit log, is currently the only role that can actually log in (see §4).
- **The patient**, indirectly, through the intake portal (§3.5) — the one part of Clinsync a non-staff person ever touches.

---

## 2. Architecture at a glance

```
Next.js 16 (App Router, TypeScript)
    │
    ├── Server Components ──► shared query functions (src/lib/queries/*.ts) ──► Drizzle ORM ──► Neon Postgres
    │        (never fetch() the app's own API from a Server Component — a closed real vulnerability, see §4)
    │
    ├── API routes (src/app/api/**) ──► same query functions, gated by requireSession()
    │
    ├── Client Components ──► fetch() the API routes for interactivity (forms, toggles, live search)
    │
    └── Upstash Redis ──► read-through cache for expensive list/detail queries (30s–60s TTL)

Deployment: Vercel (serverless functions, not containers)
Storage: Neon Postgres (via Vercel Marketplace) + Upstash Redis (via Vercel Marketplace) + Vercel Blob (provisioned, not yet wired to a real upload flow)
```

**Why this stack:** Vercel + Neon + Upstash was chosen because it's the fastest path to a real, working pilot with zero infrastructure to manage, and because Vercel's Marketplace integrations provision both databases with working credentials in minutes. Next.js's App Router lets Server Components query Postgres directly (no separate backend API layer to keep in sync) while still supporting real client-side interactivity where it's needed (modals, live search, forms).

### Data model, in brief

- **`patients`** — the anchor table. One row per patient, with **paired columns per dual-sourced field** (`nameIntakeq`/`nameTebra`, `dobIntakeq`/`dobTebra`, etc.) — the "intake" side and the "clinical" side of the same fact, kept separate until reconciled.
- **`identityMatches`** — the queue of ambiguous referral-to-chart matches awaiting a CRC's confirm/reject decision.
- **`trials`** — protocol definitions: diagnosis codes, age range, excluded medication classes, washout rules.
- **`patientTrialScreenings`** + **`screeningCriteriaResults`** — one screening per patient-trial pair, with a per-criterion verdict (green/yellow/red), the evidence quote that produced it, and its source.
- **`diagnoses`**, **`medicationEpisodes`**, **`allergies`** — clinical facts pulled into the merged record.
- **`formTemplates`** + **`formSubmissions`** — the intake-form system (§3.4/§3.5).
- **`identityVerifications`** — ID-document verification status, with the ID number itself stored AES-256-GCM encrypted, never in plaintext.
- **`auditLog`** — every view and every write, attributed to a real staff session (or, for the one deliberate exception, to "Patient (self-service)" — see §3.5).

### Non-negotiable security patterns (established in Phase 1, enforced in every phase since)

- **`requireSession()`** gates every API route; **`requireSessionOrRedirect()`** is the *first statement* of every Server Component page — checking after data has already been fetched was a real vulnerability once (PHI could stream into the response body before the redirect took effect).
- Server Components call the shared query layer **directly** — never `fetch()` their own API routes. (A prior real vulnerability: a forged `Host` header could be used to exfiltrate the session cookie via that self-fetch.)
- Every write validates its body with a `.strict()` Zod schema (rejects unknown fields — closes mass-assignment).
- Every write that changes patient-relevant state calls `logAudit(session, action, patientId)` with a real, non-null session — never a fallback role.
- Status/severity is always a colored dot **plus** a text label, never color or an icon alone.

---

## 3. What's built, phase by phase

Clinsync is being built as a sequence of phases, each executed as its own git branch with a fresh implementer + independent reviewer per task, so nothing ships without a second set of eyes. See the live [build dashboard](https://claude.ai/artifact/9PTigXgjtSWXTQWzB68ebf) for current task-by-task status.

### 3.1 Phase 1 — Core Workbook *(done, merged, live)*

The foundation: patients, trials, identity matching, the rule engine, the Excel workbook export, form templates, audit logging, identity verification. This is what makes Clinsync a screening tool at all — everything else extends it.

### 3.2 Phase 2 — Scheduling *(in progress)*

Providers, appointments, a Day/Week/Month calendar, a mini-calendar + provider-filter sidebar (modeled on a real scheduling-dashboard layout), and an "Upcoming Appointments" widget on the Home Dashboard.

### 3.3 Phase 3 — Billing *(in progress)*

Charges, insurance claims, patient statements, and a **mock-only** virtual card payment flow — deliberately never a real payment processor, by design, for a pilot that must never touch real financial transactions. An AR aging dashboard and billing analytics trend chart round it out.

### 3.4 Phase 5 — Engagement *(in progress)*

Patient broadcasts (bulk SMS/email-style notifications, simulated delivery only — no real provider is ever called) filtered by trial/screening-status/form-status, plus a post-visit experience survey (reviews) and a pipeline-performance dashboard.

### 3.5 Patient Intake Portal *(done, merged, live)*

The feature that answers "how does this look from the patient's side?" Until this shipped, every form in Clinsync was something *staff* filled in on the patient's behalf. This portal is the one place a referred patient — with no staff account, no login — interacts with the system directly:

- When a CRC sends an intake form, the system generates a cryptographically random 256-bit access token and a 30-day expiry, stored on that one `formSubmissions` row.
- The patient visits `/intake/<token>` — a plain, unbranded page with no staff navigation chrome, reachable without authentication (a deliberate, documented exception to "every route requires a session," carved out of the staff-session proxy check specifically for this one path).
- The page shows a **live progress bar** ("3 of 7 questions answered") and pre-fills any question tagged to autofill from known patient data (name, DOB, email, phone) — editable, never locked, since the patient is the authority on their own current contact info.
- The response the token can ever see is hand-built field-by-field from exactly what that form's questions need — structurally incapable of exposing diagnoses, medications, allergies, screening verdicts, or the encrypted ID number, because those fields are never part of the query in the first place.
- Submitting is a token-gated write (its own `.strict()` Zod schema), and a second submission to an already-completed link is rejected — the write itself re-checks completion status in the same database statement as the update, closing a race where two near-simultaneous submits could otherwise both succeed.
- A patient's own action gets its own narrow audit path — `logPatientPortalAction()` — the one sanctioned place in the codebase that writes an audit row with no real staff session behind it, precisely because this is the one legitimate case where there isn't one.

### 3.6 Phase 4 — Reports & Documents, Phase 6 — Practice Settings *(queued)*

Deliberately built last: both depend on data models Phases 2 and 3 are still finalizing (appointments, charges), so starting them early risked building against assumptions that would need to be redone.

---

## 4. Known gaps and deliberate deferrals

Being direct about what *isn't* done, and why, matters as much as what is:

- **Login is real but minimal.** There's a genuine email/password form backed by a scrypt-hashed credential (no more one-click role picker) — but only a single admin account exists right now. CRC/PI accounts, and real SSO against IPMG's own identity provider, are the next step before any real patient data flows through the system.
- **No per-branch database isolation yet.** All in-progress phases share one live Neon database. This caused a real, confirmed data-corruption incident mid-build (a destructive reseed cycle colliding with sibling branches' foreign keys) — now fixed at the source (seeding is guarded against re-running on an already-populated database), but proper isolation (a Neon branch per worktree) is still a one-time setup step away, pending the right Neon account access.
- **File storage is provisioned, not wired.** Vercel Blob is set up but no real upload flow uses it yet.
- **Mock-only by design, not by accident:** payments (Phase 3) and broadcast delivery (Phase 5) are permanently simulated. This is a pre-screening pilot, not a billing or messaging platform — real money and real SMS/email integrations are explicitly out of scope.

---

## 5. Where the name of the game is verification

If there's one sentence that explains what makes Clinsync Clinsync rather than a generic patient list: **every piece of dual-sourced data stays visibly dual-sourced until a human confirms it, every eligibility verdict names the exact evidence it's based on, and the workbook that comes out the other end is built to be handed to a PI who wasn't in the room when any of it happened.**
