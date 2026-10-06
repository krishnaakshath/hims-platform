# App-Wide RBAC Audit & Billing Consolidation Check — Design Spec

**Status:** Audit complete — two genuine gaps found and spec'd here, one genuine gap confirmed but owned by another in-flight plan, and the billing half found to be already structurally satisfied (regression tests only).
**Position in the larger initiative:** a cross-cutting audit, not a feature. It was prompted by two verbatim requests: *"everything that is there should be according to the RBAC so that all the people don't get access to all the dashboards"* and *"the doctor once he searches for any patients they should be able to look at all the patients details like lab reports or prescriptions or medical history all those."* This is the third audit-shaped spec this session, after `2026-09-29-form-answer-visibility.md` (found no gap) and `2026-09-29-messaging-isolation-audit.md` (found the subject already secure). Unlike those two, this one did find real work — but it is deliberately narrow, and it does not touch anything already claimed by the three in-flight plans named in §2.3.

---

## 1. Verdict

**Two genuine gaps, both in the same underlying failure: the app declares role boundaries in the UI layer and does not enforce them on the server.**

| # | Finding | Status |
|---|---|---|
| 1 | `LeftNav.tsx` hides 9 nav sections (24 page routes) from roles that are not allowed to use them. **None of those 24 pages enforces that restriction server-side.** Typing the URL works for every authenticated role. | **Genuine gap — fixed by this spec (§7.1, §7.2)** |
| 2 | `role-capabilities.ts` — rendered to the user on the Settings page as the authoritative statement of what their role can do — has drifted from enforcement in both directions: it *underclaims* five real `pi`/`admin` clinical write capabilities and two `crc`/`frontdesk` capabilities, and it *misdescribes* one `pi` capability as narrower than it is. | **Genuine gap — fixed by this spec (§7.3)** |
| 3 | The fuzzy last-name provider match is not only an attribution mechanism — it is the **authorization decision** in four places (telemedicine join, telemedicine signalling, assignment decline, assignment schedule). Because it is a *substring* match resolved with `find` (first match wins), one `pi` can resolve to a different `pi`'s provider row. | **Genuine gap — confirmed, but owned by the in-flight prescriptions spec. Not fixed here (§5).** |
| 4 | The Billing subsystem, and whether a pharmacy-dispensed charge will reach a patient's bill. | **Not a gap. Already works. Regression test only (§6).** |
| 5 | Whether `pi` can reach the full patient chart (labs, medications, documents, medical history). | **Not a gap. Already works end to end today (§6.1).** |
| 6 | Whether the allowlist-only role-check pattern actually holds everywhere. | **Confirmed. It holds at all 103 role-check call sites (§6.4).** |

The distinction that organizes this document: **the app has no authentication hole and no patient-to-patient leak.** Every page and every API route requires a valid signed session (§6.3). What it lacks is *intra-staff* enforcement of the boundaries it already advertises. That is precisely what the user asked for, in those words.

---

## 2. Method, and what was deliberately left alone

### 2.1 What was swept

- **Every** `page.tsx` under `src/app/(dashboard)/` — 47 files — read for a role gate after `requireSessionOrRedirect()`, then cross-checked against its `LeftNav.tsx` entry. Nav-hiding was treated as a *claim*, never as enforcement.
- **Every** `route.ts` under `src/app/api/` — 100 files — read for `requireSession()` and for a role gate, and classified.
- Every bullet in `src/lib/role-capabilities.ts` traced to the specific gate that grants or denies it.
- Every use of the fuzzy provider match (`grep -rn "lastName" src/`), classified as attribution vs. authorization.
- The billing schema, the seven billing pages, `computeChargeBalances`, and the in-flight pharmacy plan's dispense→charge design, traced end to end.

### 2.2 Role list, verified fresh

`src/lib/auth.ts:6` and `src/db/schema.ts:4` both still define exactly four roles at this worktree's HEAD (`9f937a1`): `'crc' | 'pi' | 'admin' | 'frontdesk'`. The two in-flight plans that each add a `pharmacy` role have **not** landed — `roleEnum` is unchanged, and the pharmacy-dashboard worktree (`7660240`) contains a spec but no code. **Anyone executing this spec must re-check `roleEnum` and `role-capabilities.ts` before starting**, because `pharmacy` may exist by then; see §7.4 for exactly what changes if it does.

### 2.3 In-flight work this audit does not touch

Independently re-verified against this worktree's HEAD, all three are **still open** as of this audit:

| Already-flagged gap | Confirmed still open here? | Owner |
|---|---|---|
| `POST /api/form-templates`, `PUT /api/form-templates/[id]` — bare `requireSession()`, no role check | Yes, still open | forms-hub-and-embedded-consents spec |
| `PATCH /api/documents/[id]` — no role gate | Yes, still open | document-insurance-assignment plan |
| `POST /api/charges`, `PATCH /api/charges/[id]` — no role gate | Yes, still open | pharmacy-dashboard spec §3.3 |

This spec re-fixes none of them. §7.2 explains the one file-level coordination point (`/api/charges`) and hands it back rather than duplicating it.

---

## 3. Gap 1 — nav-declared role boundaries are not enforced server-side

### 3.1 The finding

`LeftNav.tsx` filters its entries by role (`items.filter(...)`, line 96; `showBilling`, line 98) and its own header comment (lines 17-28) states the intent plainly: a PI gets *"no Workbook, Identity Matching, Form Templates …, Billing, or the Operations group (Reports/Documents/Broadcasts/Experience Surveys/Pipeline Dashboard)."*

That is nav rendering. It is not enforcement. `(dashboard)/layout.tsx:8-9` checks only that *a* session exists, and `src/proxy.ts` likewise only checks session validity (and excludes `/api` from its matcher entirely). **No layer between the URL and the page component looks at `session.role`.** So the restriction holds exactly as far as the user's willingness to type a URL.

Six pages *do* enforce their nav restriction, using a consistent house idiom — `if (!['…'].includes(session.role)) redirect('/')` — placed immediately after `requireSessionOrRedirect()`:

- `audit-log/page.tsx:20`, `doctor/page.tsx:38`, `labs/page.tsx:11`, `inpatient/beds/page.tsx:9`, `front-desk/check-in/page.tsx:15` (and `assignments/page.tsx:10`), `booking-requests/page.tsx:10`.

The 24 pages below do not. They call `requireSessionOrRedirect()` and then render, for any role.

### 3.2 Cross-check table: every nav entry vs. its actual server-side gate

| Nav entry | `LeftNav` declares | Page enforces | |
|---|---|---|---|
| Home `/` | all | all (role-branches to the right dashboard) | OK |
| My Patients `/doctor` | `pi` | `page.tsx:38` — `pi` only | OK |
| Patients `/patients`, `/patients/[anonId]`, `…/medical-record` | all | all | OK — intentional, see §6.1 |
| Workbook `/workbook` | `admin`, `crc` | **none** (`page.tsx:7`) | **GAP** |
| Identity Matching `/identity-matching` | `admin`, `crc` | **none** (`page.tsx:8`) | **GAP** |
| Trials `/trials`, `/trials/[trialId]` | all | all | OK |
| Calendar `/calendar` | all | all | OK |
| Form Templates `/forms`, `/forms/[templateId]` | `admin`, `crc` | **none** (`:8`, `:8`) | **GAP** |
| Client Forms `/client-forms`, `/client-forms/[id]` | all | all | OK — confirmed intentional by the form-answer-visibility spec |
| Check-In `/front-desk/check-in` | `frontdesk`, `admin`, `crc` | `:15` | OK |
| Assignments `/front-desk/assignments` | `frontdesk`, `admin`, `crc` | `:10` | OK |
| Beds `/inpatient/beds` | `frontdesk`, `admin`, `crc`, `pi` | `:9` | OK |
| Pharmacy `/pharmacy` | all | all (write gated: `canDispense`, `:14`) | OK |
| Labs `/labs` | `frontdesk`, `admin`, `crc`, `pi` | `:11` | OK |
| Staff `/staff`, `/staff/[id]` | all | all (write gated: `canWrite`, `:27` / `:38`) | OK |
| Booking Requests `/booking-requests` | `frontdesk`, `admin`, `crc`, `pi` | `:10` (+ `canResolve` excludes `pi`, `:21`) | OK |
| Messages `/messages` | all | all | OK — confirmed intentional by the messaging-isolation audit §4 |
| **Billing** (group, `showBilling`, `:98`) | `admin`, `crc`, `frontdesk` | **none on any of 8 pages** | **GAP** |
| — `/billing/charges` `:8`, `/billing/charges/[chargeId]` `:20`, `/billing/insurance-collections` `:7`, `/billing/patient-collections` `:7`, `/billing/statements` `:7`, `/billing/ar-dashboard` `:17`, `/billing/analytics` `:17`, `/billing/pay` `:12` | | | |
| Reports `/reports/*` | `admin`, `crc` | **none on any of 5 leaves** | **GAP** |
| — `/reports/patients` `:8`, `/reports/appointments/all` `:7`, `/reports/claims/insurance-collections` `:7`, `/reports/encounters/all` `:7`, `/reports/notes/unsigned` `:7` | | | |
| Documents `/documents`, `/documents/fax-history` | `admin`, `crc` | **none** (`:7`, `:7`) | **GAP** |
| Broadcasts `/broadcasts`, `/broadcasts/[id]` | `admin`, `crc` | **none** (`:9`, `:8`) | **GAP** |
| Experience Surveys `/experience-surveys`, `/experience-surveys/[id]` | `admin`, `crc` | **none** (`:14`, `:11`) | **GAP** |
| Pipeline Dashboard `/pipeline-dashboard` | `admin`, `crc` | **none** (`:59`) | **GAP** |
| Audit Log `/audit-log` | `admin` | `:20` | OK |
| Settings `/settings` | all | all (admin-only sub-panels gated individually, `:30`) | OK |

`(dashboard)/reports/page.tsx` is a bare `redirect('/reports/patients')` with no session read at all; it needs no gate of its own once the five leaves are gated.

**24 content-rendering pages across 9 nav sections.**

### 3.3 The same boundary is also open at the API layer

Gating the page and leaving the route that backs it open would be cosmetic. For the nav sections above, these backing routes have `requireSession()` but **no role gate**:

- `GET /api/workbook/full` — the full 30-column pre-screening workbook, as a downloadable `.xlsx`. The Workbook page's own "Download Full Workbook" button (`workbook/page.tsx:19-24`) links straight to it.
- `GET /api/workbook/export` — the same data via `getPatientDetail` per patient (allergies, identity verification, diagnoses, medications, criteria).
- `GET /api/identity-matches`, `POST /api/identity-matches/[id]/confirm`, `POST /api/identity-matches/[id]/reject` — confirm/reject **merge or split two patient identity records**.
- `GET`/`POST /api/broadcasts`, `GET /api/broadcasts/[id]`, `GET /api/broadcasts/recipients` — `POST` sends a (simulated) broadcast to a patient cohort.
- `GET`/`POST /api/reviews`, `GET`/`PUT /api/reviews/[id]` — sending and recording patient experience surveys.
- `POST /api/mock-payments` — records a (mock) card payment against a patient's charge.

### 3.4 Why this matters, stated proportionately

This is **not** an authentication hole, and it is not the same class of finding as an unauthenticated PHI leak. Every one of these routes and pages requires a valid, signed, `httpOnly` staff JWT (§6.3). And this codebase has a deliberate, documented baseline that broad clinical data is visible to all staff roles (`patients/page.tsx`, `messages/page.tsx` — see the messaging-isolation audit §4 for why that is intentional and should stay). A `pi` reading `/billing/analytics` is close to harmless.

It matters for three specific reasons:

1. **`frontdesk` is the role this actually exposes.** `role-capabilities.ts:59` describes Front Desk as explicitly *"not the clinical evidence-review or practice-administration tools used by other roles."* Today a `frontdesk` session can download the complete 30-column pre-screening workbook for every patient, confirm or reject identity merges, send a patient broadcast, and read the Pipeline Dashboard — by typing a URL. Front-of-house is the highest-turnover, lowest-trust staff tier in a clinic; it is the one place where the difference between "hidden" and "denied" is real.
2. **The incoming `pharmacy` role inherits all of it on day one.** The pharmacy-dashboard spec's §3.2 reasons that a new enum member is *"denied by default at every one of those 50 sites, with no edit and no audit sweep required."* That reasoning is sound **for the sites that have a gate**, and this audit confirms it (§6.4). But it does not cover the 24 pages and ~12 routes that have *no* gate — a `pharmacy` session would reach all of them immediately. That plan's summary table row reading "billing screens, reports … unchanged — pharmacy is denied by default" is, strictly, not true today. Closing Gap 1 is what makes it true. This is the strongest argument for doing this work *before* either pharmacy plan merges.
3. **A capability statement the app shows the user should be accurate.** See Gap 2.

---

## 4. Gap 2 — `role-capabilities.ts` has drifted from enforcement

`ROLE_CAPABILITIES` is not internal documentation. `(dashboard)/settings/page.tsx:31` reads `ROLE_CAPABILITIES[session.role]` and renders it to the signed-in user as the statement of what their role can do. Its own header comment (lines 3-9) promises it is *"Sourced only from role-gated behavior that actually exists in the code today… Not aspirational, doesn't describe a permission the app doesn't enforce."* Three kinds of drift break that promise:

### 4.1 Underclaims — real, enforced capabilities the document never mentions

Each of these is a capability the server explicitly grants to that role, with a citation:

| Role | Capability actually granted | Enforced at | In `role-capabilities.ts`? |
|---|---|---|---|
| `pi`, `admin` | Write and sign encounter notes (SOAP) on a patient's chart | `api/patients/[anonId]/notes/route.ts:22`; `…/notes/[id]/sign/route.ts:9`; UI `medical-record/page.tsx:306` | **No** |
| `pi`, `admin` | Create and update care plans and care-plan goals | `api/patients/[anonId]/care-plans/route.ts:19`; `api/care-plan-goals/[id]/route.ts:14`; UI `medical-record/page.tsx:189` | **No** |
| `pi`, `admin` | Discharge an inpatient, including signing the discharge summary | `api/inpatient/admissions/[id]/discharge/route.ts:26`; UI `patients/[anonId]/page.tsx:154` | **No** |
| `pi`, `admin`, `crc`, `frontdesk` | Transfer an inpatient between rooms | `api/inpatient/admissions/[id]/transfer/route.ts:13`; UI `patients/[anonId]/page.tsx:153` | **No** |
| `pi`, `admin` | Order inpatient medications and record administrations (MAR) | `api/inpatient/admissions/[id]/medications/route.ts:37`; `…/[medId]/administer/route.ts:16`; UI `patients/[anonId]/page.tsx:155` | **No** |
| `crc`, `frontdesk`, `admin` | Register a new patient | `api/patients/route.ts:53`; UI `AddClientModal.tsx:67` | **No** |

The `pi` omissions are the serious ones. Five of a Principal Investigator's core clinical write capabilities — notes, care plans, discharge, transfer, inpatient medications — are absent from the document that tells a PI what they can do, in an application whose clinical authority model is the point.

### 4.2 A misdescription — narrower in the document than in the code

`role-capabilities.ts:34` tells a `pi`: *"View the live bed/ward status board **for their admitted patients**."* There is no such scoping. `inpatient/beds/page.tsx:9-21` gates the page to four roles and passes the **entire** board to `BedBoard`; nothing filters by provider. A `pi` sees every room and every occupant, exactly as `admin`, `crc` and `frontdesk` do. The qualifier is false and must be dropped — not implemented. (Implementing it would require the same provider link §5 shows is currently unreliable, and nobody has asked for the board to be narrowed.)

### 4.3 Claims that Gap 1's fix makes true, rather than requiring an edit

Two statements are currently true *of the nav only*, and read to a user as permission statements:

- `pi.summary` (`:27`): *"practice operations (billing, forms administration, broadcasts, reports) are the coordinator's and admin's tools, **not shown here**."*
- `frontdesk.summary` (`:59`): *"…not the clinical evidence-review or practice-administration tools used by other roles."*

The careful phrasing "not shown here" is literally accurate about the sidebar and inaccurate about access. **These need no wording change** — §7.1 makes them true as written. Noted here so a future reader does not "fix" the wording and thereby document the gap instead of closing it.

### 4.4 Overclaims found: none

Every capability the document asserts was traced to a gate that grants it. Spot-checked in full: `crc`'s eight bullets, `pi`'s ten, `admin`'s ten, `frontdesk`'s eight. Notably correct and worth recording so nobody "fixes" them:

- `pi` *"View the public booking requests queue (read-only — confirming/declining is a registration-staff action)"* is exactly right: `booking-requests/page.tsx:10` admits `pi`, `:21` withholds `canResolve` from `pi`, and both `…/confirm/route.ts:21` and `…/decline/route.ts:14` 403 a `pi`. Page, UI and API agree — this is the pattern the rest of the app should look like.
- `frontdesk` *"View the Lab worklist and mark samples collected"* — and **not** enter results or cancel: `lab-orders/route.ts:9` admits `frontdesk` for read, `…/collect/route.ts:12` admits it, `…/result/route.ts:18` and `…/cancel/route.ts:14` do not. Correct to the verb.
- `admin` *"Issue and revoke Patient Portal access credentials"* — `patients/[anonId]/portal-password/route.ts:42,55`, admin-only on both `POST` and `DELETE`. Correct.

---

## 5. Gap 3 — the fuzzy provider match is an authorization decision, not just attribution (confirmed; not fixed here)

A separate in-flight prescriptions spec is replacing the fuzzy session→provider resolution with a real link, framed there as a **prescription-attribution** problem. This audit was asked to determine independently whether the same fuzzy matching causes actual over- or under-exposure of data elsewhere. **It does, and the security consequence does not appear to be part of how the other spec frames the work.** Recording it here so it is not lost.

The identical seven-line idiom appears at nine sites. At five of them it only decides *whose name goes on a record* (attribution): `patients/[anonId]/lab-orders/route.ts:42-52`, `inpatient/admissions/[id]/transfer/route.ts:30-32`, `…/discharge/route.ts:50-52`, and `doctor/page.tsx:46-54` (a display filter). At the other four it **is the 403**:

- `(dashboard)/telemedicine/[sessionId]/page.tsx:33-38` — renders the provider call screen only if the match equals the session's provider.
- `api/telemedicine/[sessionId]/signal/route.ts:27-34` (`resolveOwnedSession`, used by both `POST` and `GET`) — the WebRTC signalling channel for a live video visit.
- `api/telemedicine/[sessionId]/end/route.ts:20-24`.
- `api/front-desk/assignments/[id]/decline/route.ts:31-35` and `…/schedule/route.ts:44-46` — acting on another provider's patient assignment.

The mechanism fails in both directions:

```ts
const lastName = session.name.trim().split(/\s+/).pop() ?? session.name
const providerMatch = providersList.find((p) => p.name.toLowerCase().includes(lastName.toLowerCase()))
```

- **Over-exposure.** `.includes()` is a substring test and `.find()` returns the *first* row that passes. A session for "Dr. Ann Lee" matches a provider named "Dr. Bill Leeson" if that row sorts first. Short surnames make this near-certain rather than hypothetical: a `pi` named "Dr. Jin Li" matches "Dr. Maria Collins", "Dr. Kelly Ortiz" or "Dr. Alice Brand". The consequence at the four sites above is that one `pi` can join another `pi`'s live patient video visit, read and write its signalling channel, end it, and decline or reschedule that provider's patient assignments. That is genuine cross-clinician exposure, and it is distinct from the attribution concern.
- **Under-exposure.** If no provider name contains the surname, `providerMatch` is `undefined` and the code fails closed — `redirect('/')` or `403`. A `pi` whose `users.name` does not substring-match a `providers` row cannot join **their own** video visit, cannot act on **their own** assignments, and cannot order a lab at all (`lab-orders/route.ts:52` returns `403 Could not resolve your provider identity for this session`; only `admin` has the `activeProviders[0]` fallback on line 50). This is the "doctor cannot see their own patient's data" half of the user's second request, and it is real — it just isn't caused by a role gate.

**This spec does not fix it.** A real session→provider foreign key resolves both directions at once, that FK is the prescriptions spec's deliverable, and two specs writing the same schema change would collide. §9.3 specs the regression test that should land *with* that fix, and states plainly that it fails against today's code.

---

## 6. What already checks out — no work needed

### 6.1 A `pi` can already reach the entire patient chart

The user's second request is already satisfied end to end. Neither `patients/page.tsx` (the searchable list), `patients/[anonId]/page.tsx` (the chart), nor `patients/[anonId]/medical-record/page.tsx` (the full record) has any role gate — they call `requireSessionOrRedirect()` and render. `GET /api/patients` and `GET /api/patients/[anonId]` likewise have no role gate (only `POST` and `DELETE` do). So a `pi` searching for any patient reaches, on one page (`medical-record/page.tsx:85-95`):

allergies and conditions; encounter notes (`listNotesForPatient`, and `pi` can *write* them); dispensed medications (`listDispensesForPatient`) plus the medication catalogue; **lab orders and results** (`listOrdersForPatient` + `listLabTests`, rendered by `LabResultsSection`, with `canOrder` true for `pi` at `:101`); completed screening submissions with their scoring bands; care plans (writable by `pi`, `:189`); and insurance/payer detail. The inpatient history, admissions and discharge summaries are on `patients/[anonId]/page.tsx`.

**No access gap exists here.** The only thing standing between a `pi` and a chart is nothing at all. What §5 describes is a *scoping* problem — which patients land in the `/doctor` "My Patients" shortcut list — not an access problem; a `pi` can always reach any patient through `/patients`. Keeping those two straight is the point: `/doctor` is a convenience filter, not a permission boundary, and this spec proposes no change to it.

One honest observation, filed as a question rather than work: **scanned/faxed documents are not surfaced on the patient chart at all, for any role.** `documents` rows carry a `patientId` (`schema.ts:704`), but `/documents` is a flat practice-wide list and the chart never queries it. That is a missing *feature* (a per-patient documents section), identical for `admin` and `pi`, not an RBAC gap — and the in-flight document-insurance-assignment plan is already working in that file's territory. See §11.

### 6.2 Billing is already a real, consolidated subsystem — and a pharmacy charge will flow through it correctly

The request for "a separate billing dashboard" is **already structurally satisfied** and needs nothing built. Five tables (`charges`, `payers`, `insuranceClaims`, `patientStatements`, `mockPayments`, `schema.ts:202-267`) back seven pages under a grouped **Billing** section (`LeftNav.tsx:49-57`, `:116-143`), scoped to `admin`/`crc`/`frontdesk`. Patient Collections is genuinely patient-consolidated: `listPatientCollections` aggregates every submitted charge's outstanding balance and unapplied credit **per patient** via `computeChargeBalances`, and each row links out to that patient's chart and to a prefilled payment (`PatientCollectionsTable.tsx:61,67-72`).

On the specific question of whether a pharmacy-dispensed-medication charge will show up correctly once the pharmacy-dashboard plan merges: **yes, and no integration work is needed.** That plan (its §5, §3.3) creates an ordinary `charges` row inside a transaction and stores the FK on `medicationDispenses.chargeId`. Nothing in the billing read path filters by origin — `listCharges` selects all charges, and `listPatientCollections`, `getArDashboardData` and the statements/analytics queries all filter on `charges.status`, never on where a charge came from. A pharmacy charge is simply a charge.

There is one behaviour worth writing down so nobody later mistakes it for a bug and "fixes" it: a dispense-created charge lands in `draft`, and `listPatientCollections` / `getArDashboardData` both filter to `eq(charges.status, 'submitted')`. So a pharmacy charge does **not** move a patient's balance until billing staff walk it through `draft → pending_approval → approved → submitted`. That is the lifecycle every charge in this system follows, and it is exactly the separation of duties the pharmacy spec designed on purpose ("Pharmacy records that a billable thing happened; billing decides what to do about it"). **Auto-submitting pharmacy charges to make them appear on the A/R dashboard sooner would be a regression, not a fix.** §9.2 pins this.

What does **not** exist is a per-patient bill *drill-down* — a chart tab listing that one patient's charges, claims, payments and statements. The Charges list has a free-text search box (`ChargesTable.tsx:61`) but no patient-scoped route, and the chart has no billing section. This is a missing surface, not a broken integration, and no one has asked for it. §11 raises it as a product question; this spec does not build it.

### 6.3 Authentication is closed everywhere

Seven `route.ts` files have no session check: the five login/logout/MFA endpoints for the two session kinds, and the two Google OAuth endpoints. Every other one of the 100 API routes calls `requireSession()`, `requirePatientSession…`, or a token/PIN gate appropriate to its public surface (intake token, telemedicine join token, queue-display PIN, public booking). `src/proxy.ts` redirects any unauthenticated page request to `/login`, with a set of exclusions each carrying a written justification, and every `(dashboard)` page additionally calls `requireSessionOrRedirect()` itself — the belt-and-braces the auth-hardening spec established after proving the layout redirect alone still streamed PHI into the response body (`auth.ts:98-110`).

### 6.4 The allowlist-only pattern holds — verified exhaustively, not sampled

Every place `session.role` is consulted across `src/` was read: 53 sites of the form `[…].includes(session.role)`, plus 50 single-role equality sites (`session.role !== 'admin'` → 403, `session.role === 'admin'` → grant, `canBlock={session.role === 'admin'}`, and so on — a mix of route gates, page redirects, UI capability props and one data-branch in `settings/page.tsx:45`). **Every site that decides access is an allowlist**; a single-role `!==` check is an allowlist of one. There is no site anywhere — not one — that enumerates roles in order to *deny* them, so no role is ever granted access by virtue of not being named. This is the structural property the pharmacy-dashboard spec depends on, and it is confirmed: a new enum member is denied by default at every one of them. The gap in that reasoning is not the gates — it is the 24 pages and ~12 routes that have no gate to be denied by (§3.4).

---

## 7. The fix

### 7.1 Page gates (24 files)

Insert the existing house idiom as the statement immediately following `requireSessionOrRedirect()` — the same shape and the same `redirect('/')` target as `audit-log/page.tsx:20` and `labs/page.tsx:11`. No new helper, no new abstraction: a one-line inline check is what every already-gated page in this codebase uses, it is greppable, and a shared `requireRole()` wrapper would be a second thing to keep in sync with `LeftNav`.

```ts
const session = await requireSessionOrRedirect()
if (!['admin', 'crc'].includes(session.role)) redirect('/')
```

`['admin', 'crc']` for: `workbook`, `identity-matching`, `forms`, `forms/[templateId]`, `reports/patients`, `reports/appointments/all`, `reports/claims/insurance-collections`, `reports/encounters/all`, `reports/notes/unsigned`, `documents`, `documents/fax-history`, `broadcasts`, `broadcasts/[id]`, `experience-surveys`, `experience-surveys/[id]`, `pipeline-dashboard`.

`['admin', 'crc', 'frontdesk']` for the eight `billing/*` pages, matching `LeftNav.tsx:98` exactly.

Two mechanical notes: `redirect()` must be imported from `next/navigation` where a file does not already import it, and in pages that currently write `await requireSessionOrRedirect()` without binding the result, bind it first.

**The role lists are copied from `LeftNav.tsx`, deliberately.** This spec proposes no new policy — it makes the existing, already-reviewed nav policy real. Any argument about whether `pi` *should* see Reports is a separate product conversation (§11), and settling it here would smuggle a policy change into a consistency fix.

### 7.2 API gates

Same lists, as `403` rather than `redirect`, matching `booking-requests/[id]/confirm/route.ts:21`:

```ts
if (!['admin', 'crc'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
```

`['admin', 'crc']`: `GET /api/workbook/full`; `GET /api/workbook/export`; `GET /api/identity-matches`; `POST /api/identity-matches/[id]/confirm`; `POST /api/identity-matches/[id]/reject`; `GET`+`POST /api/broadcasts`; `GET /api/broadcasts/[id]`; `GET /api/broadcasts/recipients`; `GET`+`POST /api/reviews`; `GET`+`PUT /api/reviews/[id]`.

`['admin', 'crc', 'frontdesk']`: `POST /api/mock-payments`.

All eleven are staff-only routes behind `requireSession()` today; none is reachable from the patient portal or from an intake/join token, so gating them cannot break a patient-facing flow. (Checked specifically for `/api/reviews`, where a patient-submitted survey would have made this unsafe: `PUT /api/reviews/[id]` is staff recording a response, guarded by `requireSession()`, not a patient endpoint.)

**Deliberately excluded, and why:**

- `GET /api/charges` and `GET /api/charges/[id]` — ungated today, and they belong with the billing gates. But they live in the two files (`api/charges/route.ts`, `api/charges/[id]/route.ts`) that the pharmacy-dashboard spec §3.3 is already editing to gate `POST` and `PATCH` to `['admin','crc','frontdesk']`. **Recommendation: that plan extends its gate to cover the `GET` handlers in the same two files.** Doing it here would guarantee a merge conflict for zero benefit.
- `GET /api/payers` — ungated, and Billing-adjacent, but it is *not* billing-only: payer data is read by the insurance section of the patient chart, which `pi` legitimately uses. Restricting it to billing roles could break clinical UI. Left alone; raised in §11.
- `GET /api/search`, `GET /api/appointments`, `GET /api/form-submissions`, `GET /api/trials` and the other broadly-readable routes — these back surfaces with **no** nav restriction, so there is no declared boundary to enforce. Narrowing them would be inventing policy, which this audit will not do.

### 7.3 `role-capabilities.ts` corrections

Bring the document back to its own stated contract — describe enforcement, nothing more, nothing less.

1. **`pi`, remove the false qualifier** (`:34`): *"View the live bed/ward status board for their admitted patients"* → *"View the live bed/ward status board."*
2. **`pi`, add the five missing clinical capabilities**, each phrased to the verb the gate actually grants — write and sign encounter notes; create and manage care plans and goals; order inpatient medications and record administrations on the MAR; transfer an admitted patient between rooms; discharge an admitted patient and sign the discharge summary.
3. **`admin`, add the same five.** `admin`'s list already leads with *"Everything a Research Coordinator can do"*, but `crc` has none of these either, so inheritance does not cover them; they must be stated.
4. **`crc` and `frontdesk`, add** *"Register a new patient"* (`api/patients/route.ts:53`) and *"Transfer an admitted patient between rooms"* (`transfer/route.ts:13`). Neither role's existing bed-board bullet covers the transfer: the action lives on the Patient Detail page (`patients/[anonId]/page.tsx:153`), not on the board.
5. **Leave both summary paragraphs exactly as written** — §7.1 makes them true (§4.3).

### 7.4 If the `pharmacy` role already exists at execution time

Re-read `roleEnum` and `role-capabilities.ts` first. If `pharmacy` has landed, the only change to this spec is that `pharmacy` is **absent from every allowlist above** — it is denied from all 24 pages and all eleven routes, which is what both pharmacy plans intend (the pharmacy spec's own summary table says billing screens, reports, workbook and the audit log are "unchanged" for that role). No list in §7.1 or §7.2 gains `pharmacy`. Add nothing to `ROLE_CAPABILITIES.pharmacy` either; that entry belongs to whichever plan introduces the role.

---

## 8. Role-gating summary — the gates this spec adds

| Surface | `admin` | `crc` | `pi` | `frontdesk` | Enforced at |
|---|---|---|---|---|---|
| Workbook page + `GET /api/workbook/full` + `GET /api/workbook/export` | Yes | Yes | **No (new)** | **No (new)** | page `redirect('/')`, route `403` |
| Identity Matching page + `GET /api/identity-matches` + confirm/reject | Yes | Yes | **No (new)** | **No (new)** | page `redirect('/')`, route `403` |
| Form Templates pages (`/forms`, `/forms/[templateId]`) | Yes | Yes | **No (new)** | **No (new)** | page `redirect('/')` |
| Reports (5 pages) | Yes | Yes | **No (new)** | **No (new)** | page `redirect('/')` |
| Documents (2 pages) | Yes | Yes | **No (new)** | **No (new)** | page `redirect('/')` |
| Broadcasts (2 pages) + `/api/broadcasts*` | Yes | Yes | **No (new)** | **No (new)** | page `redirect('/')`, route `403` |
| Experience Surveys (2 pages) + `/api/reviews*` | Yes | Yes | **No (new)** | **No (new)** | page `redirect('/')`, route `403` |
| Pipeline Dashboard page | Yes | Yes | **No (new)** | **No (new)** | page `redirect('/')` |
| Billing (8 pages) + `POST /api/mock-payments` | Yes | Yes | **No (new)** | Yes | page `redirect('/')`, route `403` |

Every "No (new)" cell already reads as denied in `LeftNav.tsx`; this table is what the server will finally agree with. No role gains access it did not already have.

---

## 9. Tests

### 9.1 For Gap 1 — `tests/pages/nav-role-enforcement.test.tsx` (new)

One file, table-driven, following `tests/pages/audit-log.test.tsx` exactly: `vi.hoisted` a `mockRedirect`, `vi.mock('next/navigation', () => ({ redirect: mockRedirect }))`, `vi.doMock('@/lib/auth', …)` per role with `vi.resetModules()` between cases, and `vi.doMock` the page's query modules so nothing touches the DB.

The table should be **derived from `LeftNav.tsx`'s own `ITEMS` / `TRAILING_ITEMS` / `showBilling`, not hand-copied**, so a future nav-only restriction cannot be added without the test demanding enforcement for it. For each `(route → allowed roles)` pair: assert `redirect('/')` is called for every role *not* in the list, and is *not* called for every role in it. This is the one test that makes Gap 1 unable to recur, and it is worth more than the 24 individual gates.

Also extend `tests/components/LeftNav.test.tsx` with a `pi` case mirroring the existing `frontdesk` one (Billing, Workbook, Reports, Broadcasts hidden), so the nav side of the contract is pinned too.

### 9.2 For Gap 1 (API) and the billing behaviour

- **`tests/api/rbac-route-gates.test.ts`** (new) — for each of the eleven routes in §7.2, assert `403` for each disallowed role and a non-`403` for one allowed role, using the module-scope `vi.mock('@/lib/auth', …)` + per-test `mockResolvedValueOnce` pattern already used by `tests/api/patients.test.ts`.
- **Extend `tests/api/charges.test.ts` or add `tests/lib/queries/patient-collections.test.ts`** — seed a `draft` charge and a `submitted` charge for the same patient and assert `listPatientCollections` counts only the submitted one. This pins §6.2's lifecycle: it documents in test form that a freshly-created (including pharmacy-created) charge is correctly invisible to A/R until submitted, so no future change auto-submits charges to "fix" a non-bug.

### 9.3 For Gap 3 — to land with the prescriptions spec, not with this one

Add to `tests/api/telemedicine-signal.test.ts` (or a new `tests/api/telemedicine-provider-ownership.test.ts`): seed two active providers whose names share a substring — "Dr. Ann Lee" and "Dr. Bill Leeson" — and a telemedicine session owned by Leeson. Assert a `pi` session named "Dr. Ann Lee" receives `403` from `GET`/`POST /api/telemedicine/[sessionId]/signal`, and that "Dr. Bill Leeson" receives `200`. Mirror it for `POST /api/front-desk/assignments/[id]/decline`.

**This test fails against today's code** — that is the point; it reproduces §5's over-exposure. It should be written by, or handed to, whoever lands the session→provider foreign key. Adding it to this branch would leave a red suite for work this spec does not do.

---

## 10. Explicitly out of scope

- **Re-fixing the three in-flight gaps** in §2.3 (`form-templates` writes, `PATCH /api/documents/[id]`, `charges` writes). Verified still open; left to their owners.
- **Fixing the fuzzy provider match** (§5). Confirmed as a genuine RBAC concern, owned by the prescriptions spec. Only the regression test is specified, and only for that branch.
- **Narrowing `/patients`, `/patients/[anonId]`, `/messages`, `/client-forms`, `/trials`, `/calendar`, `/staff`, `/pharmacy` or `/search`.** These have no nav restriction, and the broad-staff-access baseline is deliberate and documented (messaging-isolation audit §4; form-answer-visibility §1). Restricting them would be new policy, not enforcement of existing policy.
- **Scoping `/doctor`'s "My Patients" list**, or any change to which patients a `pi` sees. That is the prescriptions spec's scope, and §6.1 shows it is a convenience filter, not a permission boundary.
- **Building a per-patient bill view** on the chart, or any new billing surface, table, query or page. §6.2 found no integration gap; building one would be inventing work.
- **Any change to the charge status lifecycle**, including auto-submitting pharmacy charges.
- **Introducing a `requireRole()` helper, middleware-based role routing, or a declarative route→role map.** Tempting, and wrong for this change: the value here is making 24 pages match a policy that already exists, using the idiom the other six already use. A new abstraction would make this diff a refactor and would need its own review.
- **Adding, renaming or removing any role**, including `pharmacy`.
- **Patient-portal authorization.** Separate session mechanism, separately audited.

---

## 11. Open questions

1. **Should `pi` see Reports and the Pipeline Dashboard?** §7.1 enforces the current nav policy (no). That policy was set when the nav was designed, and a PI arguably has a clinical interest in "unsigned notes" (`/reports/notes/unsigned`) in particular. If the answer is yes, the change is one string in `LeftNav.tsx` plus the matching page gate — but it is a product decision and this spec will not make it silently.
2. **Should the patient chart have a Billing tab?** A per-patient roll-up of charges, claims, payments and statements does not exist (§6.2). Everything needed to build it is already in `computeChargeBalances`. Not proposed here because nobody asked and because it would need its own role decision (`pi` currently has no billing access at all).
3. **Should the patient chart surface that patient's documents?** `documents.patientId` exists but nothing on the chart reads it (§6.1). Overlaps the in-flight document-insurance-assignment plan's territory — that plan should probably answer it.
4. **`GET /api/payers` is ungated and shared** between billing and the clinical insurance UI (§7.2). If the insurance section of the chart is confirmed to be the only clinical consumer, it could be gated to `['admin','crc','frontdesk','pi']`; leaving it fully open is also defensible since a payer directory is not PHI.
5. **`PUT /api/trials/[trialId]/criteria` is ungated**, and trial eligibility criteria drive every verdict in the app. `/trials` has no nav restriction, so there is no declared boundary for this audit to enforce — but "any authenticated staff can rewrite eligibility criteria" deserves a deliberate answer rather than an accident.
6. **Should the `LeftNav`-derived test in §9.1 be a lint rule instead?** A test is the cheap version. If nav sections keep being added, a build-time assertion that every `roles`-restricted nav entry has a matching page gate would be stronger.

---

## 12. Self-review

- **No placeholders, no invented names.** Every file, symbol, table, route and line number above was read from source in this worktree at `9f937a1`. The 24-page and 11-route lists are exhaustive enumerations of `find … -name page.tsx` / `-name route.ts`, not samples.
- **Did I invent work to look thorough?** Checked deliberately, per the precedent specs' posture. Gap 1 is 24 pages because there are 24 such pages, not because a bigger number is more impressive — and the *most* valuable deliverable in §9.1 is one test file, not the 24 one-line edits. The billing half, which the request framed as likely-a-gap, is written up as **not a gap** (§6.2) and yields one regression test. §6.1's answer to the user's second request is "this already works." Three things I could plausibly have spec'd — the per-patient bill view, `/api/payers`, the `requireRole()` helper — are explicitly declined in §10 and §11.
- **Did I duplicate another plan's work?** No. §2.3 re-verifies all three in-flight gaps as still open and hands each back. §7.2 declines `GET /api/charges` specifically to avoid a merge conflict, and names who should take it. §5 and §9.3 document a real security consequence of the fuzzy match without writing the fix.
- **Internally consistent?** §1's verdict table, §3.2's cross-check, §7's file lists and §8's summary table all enumerate the same 9 nav sections and the same role lists, copied from `LeftNav.tsx:29-67, 98`. §4.3 and §7.3.5 agree that the two summary paragraphs are not edited. §6.4's "no work needed" does not contradict §3.4's "this weakens the pharmacy plan's reasoning": the gates are sound; the ungated routes are the gap.
- **Severity honestly stated?** §3.4 says outright that this is not an authentication hole, names `frontdesk` as the role genuinely exposed rather than implying a breach, and gives the concrete reason it should be fixed before the `pharmacy` role lands. §5 distinguishes a demonstrable substring collision from a speculative one.
- **Policy vs. consistency kept separate?** Yes, and stated twice (§7.1, §11.1): every role list is copied from the existing nav, so no role loses access it has today in the UI, and every "should this policy be different" question is in §11 rather than in the diff.
- **Ambiguity check.** §5 and §9.3 both state explicitly that the fuzzy-match fix and its test are *not* this branch's work and that the test fails today, so neither can be mistaken for an unfinished TODO here. §6.2 states explicitly that auto-submitting pharmacy charges would be a regression, so the observed behaviour cannot be mistaken for a bug.
