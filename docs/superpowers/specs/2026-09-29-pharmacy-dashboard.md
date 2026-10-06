# Pharmacy Staff Role & Patient-First Dispensing Dashboard — Design Spec

**Status:** Draft for review — design spec, not yet implemented.
**Position in the larger initiative:** a direct follow-on to `2026-09-28-pharmacy-medication-inventory.md`, which built the catalog, stock levels and dispense event. That spec treated pharmacy as *an action clinical staff perform*; this one treats pharmacy as *a job someone at this practice holds*. It is the first spec in this backlog to add a role to `roleEnum` since the Front Desk plan added `frontdesk`, and that — not the screen — is its substantive decision.

**Depends on:** the in-flight patient-demographics single-sourcing spec, which collapses `patients.nameTebra`/`nameIntakeq` and `dobTebra`/`dobIntakeq` into single `patients.name`/`patients.dob` columns. This spec is written against that post-collapse shape and references `patient.name`/`patient.dob` throughout. If that spec has not landed when this one is implemented, every `patient.name` here reads `patient.nameTebra ?? patient.nameIntakeq` instead, matching the coalescing convention still in `queries/charges.ts` today — a mechanical substitution, not a design change.

## 1. What this is, and the boundary it works within

Today `/pharmacy` is an **inventory-first** screen: a table of every stocked drug, with a per-row Dispense modal that searches for a patient as its *second* step. That shape is correct for the question "what do we have and is anything low." It is the wrong shape for the question a person standing at a dispensing counter actually asks, which is **"this patient is in front of me — what were they prescribed, give it to them, bill it."** Those are different jobs, and right now one of them has no screen and the other has no owner.

**The one real design decision this spec makes, and why:** pharmacy becomes a **fifth role in `roleEnum`** — `pharmacy` — rather than a fifth permission bolted onto `crc`. This codebase already draws role boundaries around *job functions*, not around *feature lists*: `frontdesk` exists because reception is a real desk with a real person at it, and `pi` exists with a deliberately trimmed nav (see `LeftNav.tsx`'s own header comment) because an investigator's job is clinical calls, not practice operations. A dispensing pharmacist is the same kind of fact about how this practice is staffed. The alternative — letting a coordinator check a "can dispense" box — would mean a pharmacy user logs in and sees Trials & Protocols, Identity Matching and the Pipeline Dashboard, which is both confusing and a PHI-surface expansion for no benefit. A real role gets a real nav, and a real nav is the whole point.

This spec adds:
1. **`pharmacy`** added to `roleEnum` and the `Role` union, provisioned through the existing staff login and the existing Staff Management panel — **no new login mechanism, no new session shape, no new cookie.**
2. **`/pharmacy/patient-lookup`** — a new child route under the existing `/pharmacy` section: enter a patient ID, get that patient's identity summary, their doctor-prescribed active medications (read-only), a dispense action, and a bill-logging action.
3. **`POST /api/pharmacy/dispenses/[dispenseId]/charge`** — turns a dispense event into a real `charges` row in the **existing** billing system, entering the existing draft → approved → submitted workflow.
4. **A practice-wide "currently prescribed" section** on the existing `/pharmacy` inventory board, plus the ability for admin and pharmacy to **add a medication to the catalog** (today the catalog is seed-only for everyone, including admin).
5. A **`pharmacy` entry in `ROLE_CAPABILITIES`** and a pharmacy-scoped `LeftNav`.

**Explicitly out of scope:** redesigning the dispense workflow itself — `dispenseMedication()`, its conditional-UPDATE race safety, its transaction, and `POST /api/pharmacy/dispense` are reused verbatim; the only change to that route is one role added to its allowlist. Inventory ordering/restocking beyond what the prior spec built. Any change to Tebra/IntakeQ patient fields (the separate spec above owns that). Insurance claim submission for a logged bill — a `charges` row in this codebase has never been submitted to a real payer, and a pharmacy-created one is no different; the honest boundary from the original Charges work holds unchanged. Controlled-substance logging and drug-interaction checking, both still deferred at the original Pharmacy spec's vendor/regulatory boundary. Pharmacy staff prescribing or editing a prescription — pharmacy reads `medicationEpisodes` and never writes them (§6).

## 2. What exists today, precisely

Confirmed by reading the code, because the gap this spec fills is only meaningful against what's actually there:

| Thing | Today |
|---|---|
| `Role` (`src/lib/auth.ts:6`) | `'crc' \| 'pi' \| 'admin' \| 'frontdesk'` — no `pharmacy` |
| `VALID_ROLES` (`auth.ts:9`) | same four; `parseSessionCookie` rejects a JWT whose `role` isn't in this list |
| `roleEnum` (`src/db/schema.ts:4`) | `pgEnum('role', ['crc','pi','admin','frontdesk'])`, used by `users.role`, `auditLog.role`, `encounterNotes.authorRole` |
| `/pharmacy` page gate | **`requireSessionOrRedirect()` only** — every authenticated staff role can view it |
| `GET /api/pharmacy/medications` | `requireSession()` only — no role check |
| `POST /api/pharmacy/dispense` | `['admin','pi']` |
| `PharmacyDashboard` | `canDispense={['admin','pi'].includes(session.role)}` |
| `/pharmacy` nav entry | no `roles` array → visible to all four roles |
| Patient-ID lookup | **does not exist.** `/api/front-desk/patient-lookup` is a *name + DOB duplicate search* (`findLikelyDuplicatePatients`), not a by-ID fetch. The by-ID convention in this codebase is `getPatientDetail(anonId)` against `patients.id` (text, `RD-0001` shape). |
| Dispense → prescription link | `medicationDispenses.medicationEpisodeId` exists, is FK-validated to belong to the patient, and **is always `null` in practice** — the original spec's §8 records that the modal dropdown that would set it was never built |
| Dispense → bill link | does not exist in any form |
| Adding to the medication catalog | not possible for anyone; `medications` is seed-only reference data by design (original spec §2) |

So: `/pharmacy` today is readable by pharmacy staff the moment the role exists (no grant needed), dispensing needs one explicit grant, and everything patient-first and everything billing-related is genuinely new.

## 3. The role

### 3.1 Schema and type changes

```ts
// src/db/schema.ts
export const roleEnum = pgEnum('role', ['crc', 'pi', 'admin', 'frontdesk', 'pharmacy'])
```

Appended last, never reordered — a Postgres enum's stored values are ordinal, and existing `users.role`/`auditLog.role`/`encounterNotes.authorRole` rows must keep meaning what they mean. The generated migration is a single `ALTER TYPE "role" ADD VALUE 'pharmacy';`, which must be its own statement (Postgres will not let a newly-added enum value be *used* in the same transaction that adds it), so the seed's pharmacy user insert (§3.4) lands in a later statement than the migration, which it naturally does.

```ts
// src/lib/auth.ts
export type Role = 'crc' | 'pi' | 'admin' | 'frontdesk' | 'pharmacy'
const VALID_ROLES: readonly Role[] = ['crc', 'pi', 'admin', 'frontdesk', 'pharmacy']
```

`VALID_ROLES` is load-bearing and easy to miss: `parseSessionCookie` checks membership before trusting the JWT's `role` claim, and the comment there records that an unvalidated role once crashed every audited request with a Postgres enum violation. A `pharmacy` user could authenticate successfully and then have their session silently rejected on every request if this list isn't updated alongside the type.

Three other places carry a hand-written copy of the four-role union and must widen, all caught by `tsc` because they are typed against `Role` or against `roleEnum`'s values:
- `src/lib/queries/encounter-notes.ts:13` — `authorRole` (pharmacy never authors a note; the type widens because the column is `roleEnum`, not because the capability is granted)
- `src/components/settings/StaffManagementPanel.tsx:10` — this is what lets an admin actually *provision* a pharmacy login
- `src/app/(dashboard)/page.tsx:44` — the `staffByRole` headcount tiles

`ROLE_CAPABILITIES` in `src/lib/role-capabilities.ts` is `Record<Role, ...>`, so TypeScript **forces** a `pharmacy` entry the moment the union widens. That's the desired failure mode and the reason not to loosen that type.

### 3.2 Why no existing role gate needs editing

Every role check in this app is an **allowlist** — 50 call sites, all of the shape `['admin','pi'].includes(session.role)`, across 8 distinct sets. There is no denylist and no `!== 'x'` gate anywhere. A new enum member is therefore **denied by default at every one of those 50 sites**, with no edit and no audit sweep required. This is the single most important structural property of adding a fifth role here, and it is why this spec can name the three gates it opens (§6) and be confident about everything it doesn't name.

### 3.3 Two ungated write paths this exposes (must be closed)

Default-deny covers every `.includes(session.role)` gate, but two billing routes have **no role gate at all** beyond `requireSession()`, so a `pharmacy` session would reach them the moment it exists:

- `POST /api/charges` — could create an arbitrary charge for any patient with any code and amount, outside the dispense path this spec designs.
- `PATCH /api/charges/[id]` — could drive a charge through `draft → pending_approval → approved → submitted`, which is the billing team's approval authority.

Both gain `if (!['admin','crc','frontdesk'].includes(session.role)) return 403` — the same registration/billing-staff tier already used by `/billing`'s nav visibility (`LeftNav.tsx:98`) and by the booking-request confirm route. This is not scope creep: pharmacy's whole bill-logging design (§5) depends on pharmacy having exactly one narrow, server-derived way to create a charge and **no** ability to approve one. Leaving these open would make that design a fiction. Note this also newly (and correctly) closes both routes to `pi`, which had incidental access via the missing gate.

### 3.4 Login and provisioning

Unchanged mechanism, end to end. `POST /api/login` already reads `user.role` straight out of the `users` row and passes it to `startStaffMfaChallenge` / `completeLoginWithoutMfa`, both of which are typed `Role` and need no edit. MFA, rate limiting, the signed `kind: 'staff'` JWT, and the 8-hour absolute lifetime all apply identically. An admin creates a pharmacy user through the existing Staff Management panel once §3.1's union widens.

`src/db/seed.ts` gains one demo row alongside the existing four, matching their exact shape:

```ts
{ name: 'Robin Shah', email: 'rshah.demo@example.com', role: 'pharmacy', passwordHash: hashPassword('PharmacyDemo123!') },
```

### 3.5 Navigation

A pharmacy user must see a pharmacy nav, not the clinical nav. The mechanism is the existing per-item `roles?: Role[]` allowlist in `LeftNav.tsx` — **not** a second parallel mechanism in the same component, because that file's own header comment commits it to staying consistent with one source of truth. The consequence is that the currently-unannotated `ITEMS` (Home, Patients, Trials & Protocols, Calendar, Client Forms, Staff, Messages) must each gain an explicit four-role array so pharmacy is excluded; `Settings` in `TRAILING_ITEMS` stays unannotated, since every role needs its own Account tab. The trade-off is real — every future role repeats this annotation pass — and is accepted over introducing an `excludeRoles` escape hatch that would leave two competing ways to express the same thing.

Pharmacy's resulting nav is exactly three entries:

| Entry | Route | Notes |
|---|---|---|
| Pharmacy | `/pharmacy` | existing inventory board; gains `roles: [...all five]` explicitly rather than staying unannotated, so the file reads uniformly |
| Patient Lookup | `/pharmacy/patient-lookup` | new (§4); `roles: ['pharmacy','admin']` |
| Settings | `/settings` | Account tab only — `isAdmin` is already `false` for any non-admin, so the Practice/EHR/Providers/Staff tabs are already withheld with no change |

Two small consequences:
- `src/app/(dashboard)/page.tsx` gains `if (session.role === 'pharmacy') redirect('/pharmacy/patient-lookup')`, immediately alongside the existing `if (session.role === 'pi') redirect('/doctor')` and for the identical reason recorded in that file's comment — a role with a genuinely different landing screen gets a real route, not a conditional render inside the shared home page.
- `ROLE_LABEL` in `src/app/(dashboard)/settings/page.tsx:22` gains `pharmacy: 'Pharmacy'`. That map is already missing `frontdesk` and silently falls back to the raw role string; fixing that omission in the same edit is a one-line freebie, not a separate change.

### 3.6 `ROLE_CAPABILITIES` entry

Written to the file's own standard — sourced only from behavior this spec actually enforces, never aspirational:

```ts
pharmacy: {
  label: 'Pharmacy',
  summary: 'Works the dispensing counter: looks a patient up by ID, reads what their doctor prescribed, dispenses from practice stock, and logs the bill — never prescribes, never edits a prescription, and never approves a charge.',
  bullets: [
    'Look up any patient by their patient ID to see their prescribed medications',
    'View a patient\'s active medication episodes as the prescriber entered them (read-only)',
    'Dispense a medication from practice stock against a specific prescription',
    'Log a bill for a dispense as a draft charge for the billing team to review',
    'View the medication catalog, stock levels, and what the practice is currently prescribing',
    'Add a medication to the practice catalog',
  ],
}
```

`admin`'s existing entry leads with "Everything a Research Coordinator can do" — that file's established convention for admin's superset. Admin gets every pharmacy capability (§6), expressed there by adding one bullet: *"Look up a patient at the pharmacy counter, dispense, and log a dispense bill."* Admin already carries a "Dispense medications from the Pharmacy dashboard" bullet, which stays.

## 4. `/pharmacy/patient-lookup`

### 4.1 Why a child route, not a new top-level route and not a tab on `/pharmacy`

**Not a second top-level route** (`/pharmacy-dashboard` next to `/pharmacy`): two sibling top-level URLs for one domain, both fairly describable as "the pharmacy dashboard," is a naming trap. This codebase has no such pair; it consistently nests a domain's several screens under one prefix — `/front-desk/check-in` + `/front-desk/assignments`, `/inpatient/beds`, `/billing/*`.

**Not a tab on the existing `/pharmacy/page.tsx`:** that page would then serve two very different data loads (the whole catalog vs. one patient's PHI) behind one `logAudit(session, 'viewed pharmacy dashboard', null)` call, which would stop being a truthful audit record the moment a patient chart is on screen. A patient-scoped PHI view needs its own route so it can emit its own `logAudit(session, 'viewed pharmacy patient record', patientId)` with a real `patientId` attached.

**So: `/pharmacy/patient-lookup`.** Nesting also means `LeftNav`'s existing `isActive` helper (`pathname === href || pathname.startsWith(href + '/')`) lights the Pharmacy section up correctly with no change, and the existing `/pharmacy` URL, its nav entry and its tests all keep working untouched.

### 4.2 Lookup

`GET /api/pharmacy/patients/[patientId]`, gated `['pharmacy','admin']`, `logAudit(session, 'looked up a patient at the pharmacy counter', patientId)`.

An **exact match** on `patients.id` after trimming whitespace, case-insensitively (ids are `RD-0001`-shaped and a person typing one at a counter shouldn't be defeated by capitalisation). No fuzzy or partial matching: front desk's name+DOB search is fuzzy because its job is *finding candidate duplicates*; a dispensing counter's job is *confirming one specific chart*, and a near-miss there is a dispensing error, not a convenience. No match → `404 { error: 'No patient with that ID' }`.

### 4.3 What it returns — a deliberately narrow projection

A new `getPatientPharmacyView(patientId)` in `src/lib/queries/patients.ts`, **not** the existing `getPatientDetail()`. That function returns screening criteria with evidence quotes, identity-verification records, data discrepancies and portal-credential state — none of which a pharmacist needs, all of which is PHI. The projection is:

```ts
{
  id, name, dob, currentProvider,                 // identity summary
  diagnoses: { id, code, description }[],         // needed for §5's bill
  activeMedications: MedicationEpisode[],         // status = 'active'
  dispenses: {                                    // history, newest first
    ...medicationDispenses, medicationName,
    charge: { id, status, amountCents } | null,   // null until §5 logs a bill
  }[],
}
```

`activeMedications` is `medicationEpisodes` filtered to `status = 'active'` — literally what the prescribing doctor entered, rendered read-only (name, class, dose, start date). Inactive/stopped episodes are shown in a collapsed "Past medications" group rather than hidden, since "they were on that until last month" is a real thing a pharmacist needs to see.

### 4.4 Dispense, entered from the prescription

Each active episode row carries a **Dispense** button that opens the **existing** `DispenseMedicationModal`, pre-filled with this patient and — the point of entering from here — with `medicationEpisodeId` set to that row. The modal calls the **existing, unchanged** `POST /api/pharmacy/dispense`.

This resolves the original spec's §8 deferral as a side effect rather than as a feature: that spec wanted an episode-picker dropdown inside an inventory-first modal and never built one; a patient-first entry point makes the dropdown unnecessary, because the episode *is* the row you clicked. The whole `medicationEpisodeId` path — column, patient-ownership validation in `dispenseMedication`, route field, tests — already exists and has never had a caller.

Matching an episode to a catalog `medicationId`: `medicationEpisodes.name` is free text and `medications.name` is a seeded catalog name, so the modal preselects the catalog row on a case-insensitive name match and otherwise leaves the medication field for the user to pick, with a visible "not matched to a catalog drug" note. No fuzzy matching and no silent guess — dispensing the wrong drug because two names looked similar is exactly the failure this should not have.

A **"Not stocked"** marker appears on any active episode with no catalog match at all, which is genuinely useful counter information (the patient is on something this practice doesn't dispense) and feeds the same signal §7 surfaces practice-wide.

## 5. Logging the bill

### 5.1 Data model change (additive only)

```ts
// added to the existing medicationDispenses table
chargeId: integer('charge_id').references(() => charges.id).unique(),
```

**Why the link lives on `medicationDispenses`, not as a `medicationDispenseId` column on `charges`:** `charges` is the general billing table, shared by every service line; putting a pharmacy-specific FK on it would make one feature's concern permanent in the schema every other billing feature reads. `medicationDispenses` is the table the pharmacy screen actually queries, and "is this dispense billed yet" is a property of the dispense. The `.unique()` is the real work here — it makes double-billing a single dispense a database-level impossibility rather than a check the route has to remember, while still permitting unlimited `NULL`s (Postgres does not treat NULLs as equal) for the many dispenses that are samples or in-office doses and are never billed.

No change to `charges` itself. A pharmacy-logged bill is an ordinary charge in every respect.

### 5.2 `POST /api/pharmacy/dispenses/[dispenseId]/charge`

Gated `['pharmacy','admin']`. Body, `.strict()`:

```ts
{
  diagnosisId: number,          // must be one of THIS patient's diagnoses rows
  procedureCode: string,        // HCPCS/NDC-style, defaulted in the UI, editable
  procedureDescription: string,
  unitChargeCents: number,      // positive int
}
```

Everything else is **derived server-side from the dispense row**, never accepted from the client:

| `charges` field | Source |
|---|---|
| `patientId` | `dispense.patientId` |
| `dateOfService` | `dispense.dispensedAt`, as a date |
| `providerName` | `patient.currentProvider`, falling back to `dispense.dispensedByName` |
| `diagnosisCodes` | the one `diagnoses` row named by `diagnosisId`, as `[{ code, description }]` |
| `procedureCodes` | `[{ code, description, units: dispense.quantity, chargeCents: unitChargeCents }]` |
| `amountCents` | `dispense.quantity * unitChargeCents` |
| `status` | `'draft'` (the existing column default) |

`units` comes from the dispense quantity and `amountCents` is computed here, extending the existing `POST /api/charges` rule — *"amountCents is never trusted from the client — it's derived here from procedureCodes so a charge's stored total can never drift from its own line items"* — one step further: for a dispense-derived charge, the line items themselves can't drift from the dispensing event either.

**`providerName` uses `patients.currentProvider` because `medicationEpisodes` has no prescriber column.** That is an honest limitation of the current model, not an oversight to paper over: the treating clinician on file is the best available answer, and the dispensing staff member's own name is a visibly wrong-but-attributable fallback rather than an empty required field. Adding a real prescriber FK to `medicationEpisodes` is a separate change with its own blast radius.

**`diagnosisId` must reference one of the patient's own `diagnoses` rows** — validated exactly the way `dispenseMedication` already validates `medicationEpisodeId` ownership, and returning the same kind of clean 400. Pharmacy never types a free-text ICD code: assigning a diagnosis is the clinician's act, and a pharmacist selecting from what's already on the chart is the correct division. If the patient has **no** diagnosis rows at all, the bill action is disabled with "No coded diagnosis on file — billing needs one" rather than the route inventing a placeholder code. `charges.diagnosisCodes` is `.min(1)` today and stays that way; a spec that relaxed it to let pharmacy through would be weakening real billing data to route around a data-quality problem.

**Billing code honesty:** `charges.procedureCodes[].code` is free text today and has never been validated against a real code set. The UI defaults to `J3490` ("Unclassified drugs", the standard HCPCS code for an in-office dispensed drug with no specific J-code) with the medication's name as the description, and lets the user override. Validating against a real NDC/HCPCS code set needs a licensed code file — the same vendor boundary the original Pharmacy spec drew around drug-interaction checking, and the same one this codebase already accepts for CPT codes elsewhere.

**Write shape:** the charge insert and the `medicationDispenses.chargeId` update run in one `db.transaction()`, so a dispense is never left pointing at a charge that rolled back and a charge is never orphaned from its dispense — the same coupling reason given for the decrement/insert pair in `dispenseMedication`. On success, `logAudit(session, 'logged a bill for a dispensed medication', patientId)` and `invalidateChargesList()` (the charges list is cached for 30s and would otherwise not show the new row).

**Conflicts:** `409` if `dispense.chargeId` is already set (checked in the route for a clean message; enforced by the unique index regardless). `404` for an unknown `dispenseId`.

### 5.3 What pharmacy can't do with the charge

The charge lands in `draft` and pharmacy has no route to move it. `PATCH /api/charges/[id]` is gated to `['admin','crc','frontdesk']` by §3.3, so the existing `draft → pending_approval → approved → submitted` workflow stays entirely with billing staff. Pharmacy records that a billable thing happened; billing decides what to do about it — the same "software surfaces a fact, a human decides" split this codebase already applies to eligibility verdicts, lab flags and public booking requests. The patient-lookup screen shows each dispense's charge status read-only, so the counter can answer "was that billed?" without being able to change the answer.

## 6. Read-only prescriptions, and the practice-wide medication picture

### 6.1 Pharmacy never writes a prescription

`medicationEpisodes` has no write route reachable by pharmacy, and none is added. Default-deny (§3.2) covers this with no code; §4.3's projection renders episodes as static text with no edit affordance. Worth stating explicitly because the user's request sits one short step away from it: "see the medications the doctor has prescribed" is a read, and the dispense event is the pharmacy's own record, written to `medicationDispenses` — the prescription itself is never touched.

### 6.2 "Look at the medications preferred or being used right now, so everything is classified"

Two halves, and only one of them exists today.

**Viewing — read access needs no grant.** `/pharmacy/page.tsx` calls only `requireSessionOrRedirect()` and `GET /api/pharmacy/medications` calls only `requireSession()`, so a pharmacy user can see the full catalog, class, common dose, form, stock level and reorder status the moment the role exists. Admin already has the same access. No explicit grant is required for the existing board; §3.5 just adds the nav entry that makes it reachable.

**What that board doesn't show is what's actually being prescribed.** It shows what the practice *stocks*, which is not the same picture. A new read-only section on `/pharmacy`, **"Currently prescribed across the practice"**, backed by a new `listActiveMedicationEpisodeSummary()` query: every distinct `medicationEpisodes.name` with `status = 'active'`, grouped by `medicationClass` (which is what "so that everything is classified" asks for), with a count of active episodes per drug and a flag for any name with no matching `medications` catalog row. That flag is the genuinely useful output — "17 patients are on this and it isn't in our catalog" is an actionable gap, and it's the practice-wide version of §4.4's per-patient "Not stocked" marker.

This section contains **counts and drug names only, no patient identities** — an aggregate, not a roster. That keeps a screen a pharmacist leaves open at a counter free of PHI it doesn't need, and it means the section needs no per-patient audit entry.

### 6.3 "And also add medication"

**Admin cannot do this today** — contrary to what one might assume, the original spec made `medications` seed-only reference data on purpose ("stays read-only reference data after seeding — same posture as `payers`"). The user's request makes that posture wrong: a catalog that can't absorb the drug 17 patients are already on isn't a catalog.

`POST /api/pharmacy/medications` (a new handler on the existing route file, which today has only a `GET`), gated `['admin','pharmacy']`. Body `.strict()`: `{ name, genericName?, medicationClass, commonDose?, form, quantityOnHand, reorderThreshold, unit }`. Inserts the `medications` row and its 1:1 `medicationInventory` row **in one transaction** — the 1:1 relationship is enforced by a `.unique()` FK and `listMedicationsWithInventory()` uses an `innerJoin`, so a catalog row created without its inventory row would be invisible on the very screen that created it. Rejects a case-insensitive duplicate `name` with a 409, following the seed's own check-by-name-before-insert idempotency convention. The existing `GET` stays open to all authenticated roles, unchanged.

The "Add medication" action appears on `/pharmacy` for admin and pharmacy only, and is pre-fillable directly from an unmatched drug name in §6.2's list, which is the workflow that makes the whole thing worth building.

## 7. Testing

Following this codebase's real-DB-backed API-test convention exactly as `tests/api/pharmacy-dispense.test.ts` establishes it: `vi.mock('@/lib/auth')` returning a mutable module-level `sessionRole`, real `getDb()` writes, and an `afterEach` that resets the role and pops created ids in children-before-parents order. New test files declare the widened union `'admin' | 'pi' | 'crc' | 'frontdesk' | 'pharmacy'`; existing files keep their four-role unions unless they assert pharmacy behavior.

- **`tests/api/pharmacy-dispense.test.ts`** (extend): a `pharmacy` session dispenses successfully (201); a `crc` session is still rejected (403). The existing five cases are untouched.
- **`tests/api/pharmacy-patient-lookup.test.ts`**: exact-ID hit returns the narrow projection; unknown ID is a clean 404; lookup is case-insensitive and whitespace-tolerant; `crc`/`pi`/`frontdesk` are 403 and `admin` is 200; **the response body never contains a screening criterion, an evidence quote, an identity-verification record or a portal hash** — an explicit assertion on the projection's exact key set, matching the queue-display spec's precedent of asserting on what a payload must *not* contain; only `status = 'active'` episodes appear in `activeMedications`.
- **`tests/api/pharmacy-dispense-charge.test.ts`**: happy path creates a real `charges` row with `status = 'draft'` and sets `medicationDispenses.chargeId`; `amountCents` equals `dispense.quantity * unitChargeCents` and ignores any `amountCents` a client tries to send (rejected by `.strict()`); a second call for the same dispense is 409 and creates no second charge; a `diagnosisId` belonging to a *different* patient is rejected 400 and creates nothing; a patient with no diagnoses cannot be billed; unknown `dispenseId` is 404; `crc`/`pi`/`frontdesk` are 403.
- **`tests/api/pharmacy-medications-create.test.ts`**: creates both the catalog and inventory rows and the new drug appears in `listMedicationsWithInventory()`; a case-insensitive duplicate name is 409; a failed inventory insert leaves no orphan catalog row; `pi`/`crc`/`frontdesk` are 403, `admin` and `pharmacy` are 201.
- **`tests/api/charges.test.ts`** (extend): a `pharmacy` session is rejected 403 by both `POST /api/charges` and `PATCH /api/charges/[id]` — the §3.3 closure, asserted rather than assumed.
- **`tests/lib/queries/medications.test.ts`** (extend): `listActiveMedicationEpisodeSummary()` groups by class, counts only active episodes, and flags names absent from the catalog.
- **`tests/lib/auth.test.ts`** (extend): a signed JWT carrying `role: 'pharmacy'` parses to a valid session — the §3.1 `VALID_ROLES` trap, caught by a test rather than in production.

## 8. Role gating summary

| Action | Allowed roles |
|---|---|
| View `/pharmacy` inventory board + catalog + "currently prescribed" summary | admin, pi, crc, frontdesk, **pharmacy** (unchanged open-read posture of the existing page; pharmacy needs no grant) |
| Add a medication to the catalog (`POST /api/pharmacy/medications`) | admin, **pharmacy** (new capability — nobody had it before) |
| View `/pharmacy/patient-lookup` and look a patient up by ID | **pharmacy**, admin |
| View a patient's prescribed medication episodes (read-only) | **pharmacy**, admin (via the lookup screen; other roles keep their existing chart access, which is unchanged) |
| Dispense a medication (`POST /api/pharmacy/dispense`) | admin, pi, **pharmacy** (one role added to the existing allowlist) |
| Log a bill for a dispense (`POST /api/pharmacy/dispenses/[id]/charge`) | **pharmacy**, admin |
| Create an arbitrary charge (`POST /api/charges`) | admin, crc, frontdesk — **not pharmacy**, and no longer pi (§3.3) |
| Advance a charge's status (`PATCH /api/charges/[id]`) | admin, crc, frontdesk — **not pharmacy** (§5.3) |
| Prescribe or edit a `medicationEpisodes` row | unchanged — **never pharmacy** (§6.1) |
| Everything else in the app (patients, workbook, trials, labs, beds, billing screens, reports, audit log, settings beyond Account) | unchanged — **pharmacy is denied by default** at all 50 existing allowlist gates (§3.2) |

Admin can do everything pharmacy can, matching `role-capabilities.ts`'s established admin-superset convention.
