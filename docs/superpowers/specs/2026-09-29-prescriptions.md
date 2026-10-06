# Prescriptions — Design Spec

**Status:** Draft for review — design spec, not yet implemented.
**Position in the larger initiative:** next item in the "complete the HIMS platform" backlog. This is the missing **write** side of the medication story: the chart has been able to *display* a medication list since the earliest schema, and the in-flight pharmacy-dashboard spec is building the *dispense* side that reads it, but nothing in this app has ever let a clinician actually write a prescription. This spec adds that, and — because a prescription is the first record in this codebase whose clinical attribution genuinely has to be right — it also closes the `pi`-session-to-provider gap that every clinical write route currently papers over with last-name string matching.

**Related, non-overlapping, in-flight work:** the pharmacy-dashboard spec (`feature/pharmacy-dashboard`) adds a patient-lookup screen that *reads* `medicationEpisodes` and never writes it; a parallel RBAC audit spec verifies that a `pi` session can actually reach the Medical Record page's existing sections. Neither is duplicated here. This spec's UI deliberately lands on the page that audit is already checking, rather than inventing a new one.

## 1. What this is, and the boundary it works within

**Read first, then designed.** Three facts about the current code set the shape of everything below:

1. **`medicationEpisodes` (`src/db/schema.ts:121-129`) cannot express a prescription.** It has `name`, `medicationClass`, a free-text nullable `dose`, `startDate`/`stopDate`, and a two-value `status`. There is no frequency, no duration, and no prescriber. It is a *medication history* table — a faithful shape for "this patient has been on sertraline since March," imported from Tebra/IntakeQ, and an inadequate shape for "I, Dr. Kunam, today wrote you sertraline 50mg, twice daily, for 30 days."

2. **Nothing in the app writes it.** `grep -rl medicationEpisodes src/app src/components` returns exactly one file — `src/app/api/patients/[anonId]/fhir/MedicationRequest/route.ts`, a read-only FHIR export. Every row in the table today comes from `src/db/seed.ts`. There is no create route, no edit route, and no form. The Medical Record page renders the list (`src/app/(dashboard)/patients/[anonId]/medical-record/page.tsx:154-186`) as static text.

3. **There is no link from an authenticated session to a `providers` row.** `Session` is `{ role, name }` (`src/lib/auth.ts:7`). Seven separate route/page files resolve "which provider is this?" by taking the last whitespace-delimited token of `session.name` and doing a case-insensitive substring match against the provider roster — `src/app/(dashboard)/doctor/page.tsx:44-53`, `src/app/api/patients/[anonId]/lab-orders/route.ts:42-43`, the two inpatient admission routes, the two telemedicine routes, and the two front-desk assignment routes. The lab-orders route's own comment calls this "a demo-appropriate simplification, not a real identity resolution."

**The two real design decisions this spec makes:**

**(a) Extend `medicationEpisodes` in place; do not create a `prescriptions` table.** A prescription and a medication episode have the same cardinality (one row per drug per patient per course), the same lifecycle (`active` → `inactive` with a `stopDate`), and — decisively — the same consumers. `medicationDispenses.medicationEpisodeId` (`src/db/schema.ts:655`) and `medicationAdministrations.medicationEpisodeId` (`src/db/schema.ts:667`) already point at this table, the FHIR `MedicationRequest` export already reads it, and the in-flight pharmacy dashboard is being built to read "the medications the doctor has prescribed" from it. A parallel `prescriptions` table would immediately owe every one of those consumers a second code path and a reconciliation story for a drug that exists in both. This matches the precedent already set in the in-flight document-assignment spec, where insurance paperwork became a `documentType` value inside the existing generic `documents` table rather than a parallel `insuranceDocuments` table, for the same reason: the existing table already had the right shape and the existing consumers already read it.

The honest cost of this choice, stated up front: the table now holds two kinds of row — *imported history* (no prescriber, no `prescribedAt`) and *prescriptions written here* (`prescribedAt` set). §2 makes that distinction a real, queryable one rather than a convention.

**(b) Fix the session-to-provider link for real, using columns that already exist.** A prescription's prescriber is not a display nicety; it is the single attribute that makes the record meaningful and the printout defensible. Attributing it by substring-matching a display name is not acceptable for this field, and the precise failure is already visible in the seed data: the `pi` login row is `users.name = 'Dr. R. Kunam'` (`src/db/seed.ts:917`) while the provider row is `providers.name = 'Dr. Rajiv Kunam'` (`src/db/seed.ts:90`). The last-name hack exists *specifically* to bridge that divergence. §3 replaces it with the real link — and the pleasant discovery from reading the schema is that **no new table or column is needed for the link itself**; `staffMembers.userId` and `staffMembers.providerId` already exist and the seed already populates them for exactly this doctor.

### Explicitly out of scope

- **Real e-prescribing.** Nothing in this spec transmits a prescription anywhere. There is no pharmacy-integration vendor in this app, no Surescripts or equivalent, and no DEA/EPCS identity infrastructure — inventing a "Send to pharmacy" button that only writes a database row would be exactly the kind of fake external transaction this codebase has consistently refused to build (see the `faxes` table's own schema disclosure at `src/db/schema.ts:708-710`, and the pharmacy spec's refusal to pretend a `charges` row reaches a payer). The print view in §6 is the honest deliverable: a paper prescription the doctor hands to the patient, carrying an explicit footer saying it was not electronically transmitted.
- **Controlled-substance handling.** No DEA number, no schedule classification, no EPCS. This follows directly from the above — a printed controlled-substance prescription has real regulatory requirements this app cannot meet, and a field that *looked* like DEA compliance without being it would be worse than its absence.
- **Drug-interaction and dosing-safety checking.** Requires a licensed clinical decision-support data source. This is the same vendor/regulatory boundary the original pharmacy-medication-inventory spec drew and the in-flight pharmacy-dashboard spec re-affirmed; this spec does not reopen it. No warning, no contraindication check, no maximum-dose validation beyond the structural bounds in §5.
- **Refill workflows.** No refill count on the prescription, no patient-initiated refill request, no pharmacy-initiated renewal. A new course of a drug is a new `medicationEpisodes` row written by the prescriber, which is what the model already supports.
- **Migrating the other six fuzzy-match call sites.** §3 introduces the resolver and adopts it in two places (the new prescribe route, and `doctor/page.tsx`). The inpatient, telemedicine, and front-desk-assignment routes keep their current behavior untouched. Each has its own fail-open/fail-closed policy and its own tests, and rewriting six clinical routes inside a prescriptions spec is scope creep, not thoroughness. §12 records this as the follow-up it is.
- **Any change to the pharmacy dispense flow.** `dispenseMedication()`, `POST /api/pharmacy/dispense`, and `DispenseMedicationModal` are untouched. The in-flight pharmacy spec owns them.
- **The RBAC audit of whether `pi` can reach the Medical Record page at all.** Owned by the parallel audit spec. This spec assumes that audit's answer and puts its new UI on that same existing page.
- **Tebra/IntakeQ integration and the patient-demographics single-sourcing work.** This spec reads patient identity with the current coalescing convention (`nameTebra ?? nameIntakeq`, `dobTebra ?? dobIntakeq`). If the in-flight demographics spec lands first, those become `patient.name`/`patient.dob` — a mechanical substitution, not a design change.

## 2. Data model changes to `medicationEpisodes` (additive only)

```ts
export const medicationEpisodes = pgTable('medication_episodes', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  name: text('name').notNull(),
  medicationClass: text('medication_class').notNull(),
  dose: text('dose'),
  startDate: date('start_date').notNull(),
  stopDate: date('stop_date'),
  status: text('status', { enum: ['active', 'inactive'] }).notNull(),

  // --- new in this spec, all nullable ---
  medicationId: integer('medication_id').references(() => medications.id),
  frequencyPerDay: integer('frequency_per_day'),
  durationDays: integer('duration_days'),
  instructions: text('instructions'),
  prescribedByProviderId: integer('prescribed_by_provider_id').references(() => providers.id),
  enteredByName: text('entered_by_name'),
  prescribedAt: timestamp('prescribed_at'),
})
```

Every new column is nullable with no backfill. The seeded and imported history rows keep exactly the meaning they have today: a medication the patient is on, with no claim about who prescribed it or on what terms. Fabricating a retroactive prescriber for those rows would be inventing clinical attribution, which is the precise failure this spec exists to prevent.

**`prescribedAt` is the discriminator, and that is deliberate.** `prescribedAt IS NOT NULL` means "this prescription was written in Clinsync." That single predicate drives three behaviors: only such a row is printable (§6), only such a row shows prescriber attribution in the UI (§4), and `authoredOn` in the FHIR export prefers it (§8). A separate `source` enum column was considered and rejected — it would be a second field asserting the same fact as the presence of `prescribedByProviderId`/`prescribedAt`, with no way to stop the two from disagreeing. This is the same reasoning the eligibility spec used to reject an `isAutomated` boolean alongside `senderRole`.

**`frequencyPerDay: integer`, not free text.** The request is literally "how many times a day" — a count. An integer is checkable (§5 bounds it 1–6), renderable without parsing ("3 times daily"), groupable, and directly usable by a future MAR-schedule generator, which is the one downstream consumer that would otherwise have to parse "TID". The cost is that this column cannot express `PRN`, `q48h`, alternate-day dosing, or a taper. That is a real limitation of a deliberately small first version, recorded in §12 rather than hidden — and `instructions` is the escape hatch for the narrative part of a sig in the meantime.

**`durationDays: integer`, not an end date.** "For how long" is what the prescriber says and what the patient reads; a computed end date is derivable (`startDate + durationDays`) and storing both would let them drift. `stopDate` already exists and means something different — when the course *actually* ended, which may be earlier than planned if the drug was discontinued (§5).

**`instructions: text`, nullable.** The one field here beyond the literal request. A prescription slip that a patient carries out of the building with no room for "take with food" or "take at bedtime" is not a usable artifact, and every other alternative (a `withFood` boolean, a `timeOfDay` enum) is a worse, more arbitrary version of the same thing.

**`prescribedByProviderId: integer` FK to `providers.id`, with no accompanying name snapshot.** This diverges on purpose from the `dispensedByName` / `resultedByName` / `checkedByName` / `filedByName` convention used elsewhere in this schema. Those columns snapshot a session name because there is *no provider row behind the actor* — a pharmacist or a front-desk coordinator logging a dispense or an eligibility check is not on the `providers` roster, so a text snapshot is the only available truth. Here there genuinely is a row, and a real FK is strictly better: it joins to `credentials` and `specialty` (which the print view and the specialty grouping in §5 both need), it survives a rename, and it cannot silently point at a clinician who does not exist. Adding a `prescribedByName` snapshot alongside it would create two sources of truth for one fact — and `updateProviderName()` (`src/lib/queries/providers.ts:18`) exists precisely so an admin can *correct* a misspelled provider name, a case where you want the reprint to show the corrected name, not the typo that was frozen at write time.

**`enteredByName: text` is a genuinely different fact, not a redundant snapshot.** It records who *typed* the prescription, which differs from who prescribed it in the on-behalf-of case (§5). It has no FK to hang on — the env-based admin account (`src/app/api/login/route.ts:65`) has no `users` row at all — so a text snapshot is the only representation available, exactly as for `dispensedByName`. It is not served by the audit log: `auditLog` is append-only event history, and every other clinical-write table in this schema (`labResults`, `medicationDispenses`, `insuranceEligibilityChecks`, `carePlans`) stores its own actor name on the row rather than relying on it.

**`medicationId: integer` FK to `medications.id`, nullable.** Two reasons, one of which is forced. The forced one: `medicationClass` is `.notNull()`, so the form must supply it, and the only non-arbitrary source is the `medications` catalog, which already carries `medicationClass`, `genericName`, `commonDose`, and `form`. Once the prescriber has picked a catalog row, storing its id costs one integer and removes a string-matching hazard downstream — the in-flight pharmacy spec currently has to preselect a catalog drug by case-insensitive name match against `medicationEpisodes.name`, explicitly noting that "dispensing the wrong drug because two names looked similar is exactly the failure this should not have." An exact FK makes that match unnecessary for anything prescribed here. It stays **nullable** because the catalog is seed-only today for every role (the pharmacy spec adds catalog creation, and has not landed), so a doctor must still be able to prescribe a drug that is not stocked — see §4's off-catalog path. Imported history rows keep `medicationId: null` and pharmacy's name-match continues to serve them unchanged. This spec does not modify any pharmacy code; §12 records the coordination point.

**Deliberately absent: `quantity` and `refills`.** Quantity dispensed is already `medicationDispenses.quantity` and belongs to the dispensing event, not the order. Refills are out of scope (§1).

**Forward references are fine here.** `medicationEpisodes` sits at `src/db/schema.ts:121`, above `providers` (`:445`) and `medications` (`:625`). Drizzle's `references()` takes a thunk that is resolved lazily, and this file already relies on that: `patients.primaryPayerId` / `secondaryPayerId` (`src/db/schema.ts:96,104`) forward-reference `payers` (`:221`). No table needs to be moved, and the migration diff stays small.

## 3. The `pi`-session-to-provider link

### 3.1 What already exists

`staffMembers` (`src/db/schema.ts:785-795`) has both `userId` (→ `users.id`) and `providerId` (→ `providers.id`), nullable, with a schema comment that describes exactly this three-way linkage: *"some rows are both a system `users` login AND a clinical `providers` row (e.g. a prescribing psychiatrist who also logs into the app)."* The seed already populates it — `src/db/seed.ts:532` links staff member `Dr. Rajiv Kunam` to user `rkunam.demo@example.com` **and** to provider `Dr. Rajiv Kunam`, and `src/db/seed.ts:917` is the `pi` demo login at that same email.

So the data path `users.id → staffMembers.userId → staffMembers.providerId → providers.id` is already complete and already correct, including across the `Dr. R. Kunam` / `Dr. Rajiv Kunam` name divergence that defeats the substring match. **The only thing missing is that the session cookie does not carry `users.id`.**

### 3.2 The fix: one claim on the staff session JWT

`src/lib/auth.ts`:

```ts
export interface Session { role: Role; name: string; userId: number | null }
```

- `buildSessionCookieValue(role, name, userId)` adds `userId` to the signed JWT claims, alongside the existing `kind: 'staff'`, `role`, and `name`.
- `parseSessionCookie` validates it as `number | null`, and **treats a missing claim as `null`**. This is required, not optional: staff cookies live up to 8 hours (`SESSION_MAX_AGE_SECONDS`), so cookies minted before this change will still be presented after deploy. They must keep working as valid sessions that simply cannot resolve a provider, not become unparseable — which, given `parseSessionCookie` returns `null` on any validation failure, would silently log every staff user out.
- `setSessionCookie(role, name, userId)` threads it through.

**All four `setSessionCookie` call sites already have the value in hand.** No new lookups:

| Call site | Value |
|---|---|
| `src/app/api/login/mfa/route.ts:64` | `pending.userId` — already on `PendingStaffMfaSession` (`src/lib/mfa-pending-session.ts:25`), already `number \| null`, already carried through the MFA round-trip for rate-limit identity |
| `src/app/api/login/route.ts:84` (`completeLoginWithoutMfa`, the `DISABLE_STAFF_MFA` path) | `user.id`, or `null` for the env-admin branch — both already in scope at `:65` and `:71` |
| `src/app/api/auth/google/callback/route.ts:64` | `null` (env admin) |
| `src/app/api/auth/google/callback/route.ts:92` | `user.id` |

`null` means "this session has no `users` row" and is the correct, honest value for the env-based admin account, which authenticates against `ADMIN_EMAIL`/`ADMIN_PASSWORD_HASH` and deliberately has no DB row.

**Why a session claim and not a per-request DB lookup by name:** the claim is what removes the ambiguity. Looking up a provider by `session.name` at request time is the fuzzy match, just relocated. The `userId` is the one unambiguous identifier the login flow already resolved and then threw away.

**Why `staffMembers` and not a new `users.providerId` column:** adding `users.providerId` would create a second link that can disagree with `staffMembers.providerId`, and `staffMembers` is the table whose entire stated purpose (per its own schema comment) is holding this relationship. It is also already editable through a real admin UI (`AddStaffMemberModal`, and `createStaffMember()` at `src/lib/queries/staff-members.ts:35` already FK-validates both ids before insert), which means linking a newly provisioned doctor to their provider row is an existing supported action rather than something this spec must build.

### 3.3 The resolver

New file `src/lib/provider-identity.ts`:

```ts
export interface SessionProvider {
  id: number
  name: string
  credentials: string | null
  specialty: string
}

/** Resolves the `providers` row this session *is*, via the real
 *  users -> staffMembers -> providers link. Returns null when the session
 *  has no userId (env admin), no staff_members row, no providerId on it,
 *  the staff member is not `active`, or the provider row is not `isActive`. */
export async function resolveSessionProvider(session: Session): Promise<SessionProvider | null>
```

Backed by a new `getProviderForUserId(userId)` in `src/lib/queries/staff-members.ts` (an inner join `staffMembers → providers`, filtered to `staffMembers.employmentStatus = 'active'` and `providers.isActive = true`). A terminated staff member must not be able to prescribe on a still-live cookie; an inactive provider must not be attributed a new prescription.

**No fuzzy fallback inside the resolver.** It returns the real link or nothing. A caller that wants a best-effort fallback does so visibly, at the call site, where the fail-open decision is readable.

### 3.4 Adoption in this spec

Exactly two call sites change:

1. **`POST /api/patients/[anonId]/prescriptions`** (§5) — strict. No resolvable provider, no prescription; there is no fallback path for this field.
2. **`src/app/(dashboard)/doctor/page.tsx:44-53`** — `resolveSessionProvider(session)` first; if it returns null, the existing last-name match runs unchanged as a fallback. This is a page that scopes a read-only dashboard (a patient list, an appointment list, an assignment queue), not an attribution write, and three of the five seeded providers have no linked login at all — failing it closed would regress the demo for a display concern. The fallback keeps its existing comment, updated to say it is now a fallback rather than the only mechanism.

The other six sites listed in §1 are untouched (§1, out of scope).

## 4. Where the UI lives

**The existing Medical Record page, in the section that already shows this data.** `src/app/(dashboard)/patients/[anonId]/medical-record/page.tsx` already renders **Medication History** (`:154-187`), **Medications Dispensed** (`:193`), **Lab Results** (`:337`), diagnoses, allergies, encounter notes, care plans, and insurance. The request "the doctor once he searches for any patients they should be able to look at all the patients details like lab reports or prescriptions or medical history" is already satisfied by this page; what is missing is only the ability to *add* to it. No new page, no new tab, no new route for viewing.

**Refactor: extract Medication History into `src/components/MedicationHistorySection.tsx`.** The section is currently inline JSX in a Server Component, and it now needs a modal trigger and per-row print links. This mirrors the shape `LabResultsSection` and `CarePlanSection` already have on the same page — a client component taking the rows plus a boolean capability prop:

```tsx
<MedicationHistorySection
  patientId={anonId}
  episodes={patient.medications}
  prescriberById={prescriberById}
  catalog={medicationCatalog}
  specialties={specialties}
  canPrescribe={canPrescribe}
/>
```

This is a targeted improvement to code this spec is already changing, not an unrelated refactor: the existing inline markup renders unchanged for every existing row.

**What the section renders per row.** The existing grouping into "Currently Taking" / "Past Medications" is kept. Each row gains, when the fields are present:

- the sig line — `50mg · 2 times daily · 30 days` — assembled from `dose`, `frequencyPerDay`, `durationDays`, omitting whatever is null, so an imported row still reads `Dose not recorded · started 12 Mar 2026` exactly as it does today;
- `instructions` on its own line when set;
- a prescriber line, **only when `prescribedAt` is set**: `Prescribed by Dr. Rajiv Kunam, MD · Psychiatry · 29 Sep 2026`, with `Entered by {enteredByName}` appended when that differs from the provider name;
- a **Print** link, **only when `prescribedAt` is set** (§6);
- a **Stop** action for `active` rows, gated as in §7.

An imported history row shows no prescriber line and no Print link. The chart must not offer to print, as a prescription from this clinic, a medication whose origin was an EHR import.

**The Add Prescription button** sits in the section heading row (the pattern `LabResultsSection` uses for "Order test"), rendered only when `canPrescribe` — not disabled, not rendered, matching `InsuranceCardUpload`'s established convention on this same page.

**The modal** (`src/components/AddPrescriptionModal.tsx`, built on the existing `ui/dialog`):

| Field | Control | Notes |
|---|---|---|
| Medication | select over `listMedicationsWithInventory()` | selecting a row fills `medicationId`, `name`, `medicationClass`, and prefills `dose` from `commonDose` |
| — *or* — | "Not in our catalog" toggle | reveals free-text `name` + `medicationClass`; `medicationId` stays null |
| Dose | text | prefilled, editable; optional (`dose` is nullable) |
| Times per day | number, 1–6 | required |
| Duration (days) | number, 1–365 | required |
| Start date | date, defaults to today | required |
| Instructions | textarea, ≤500 chars | optional |
| Prescribing as | select over active providers | **rendered only for `admin` whose session has no resolvable provider** (§5) |

On success the modal shows a confirmation with a **Print prescription** link to the new row, then closes and reloads. Closing without printing is fine — the Print link is permanently available on the row.

## 5. The write API

### `POST /api/patients/[anonId]/prescriptions`

```ts
const createPrescriptionSchema = z.object({
  medicationId: z.number().int().positive().nullable().optional(),
  name: z.string().trim().min(1).max(200),
  medicationClass: z.string().trim().min(1).max(100),
  dose: z.string().trim().min(1).max(100).nullable().optional(),
  frequencyPerDay: z.number().int().min(1).max(6),
  durationDays: z.number().int().min(1).max(365),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  instructions: z.string().trim().max(500).nullable().optional(),
  onBehalfOfProviderId: z.number().int().positive().optional(),
}).strict()
```

`.strict()` per this codebase's mass-assignment convention. **`prescribedByProviderId`, `enteredByName`, `prescribedAt`, and `status` are never accepted from the client** — the server sets all four, matching the "server sets who/when, client never does" rule already applied to `admissions.dischargedAt`, `bookingRequests.reviewedAt`, and `documents.filedAt`.

**Bounds, and what they are not.** `frequencyPerDay ≤ 6` and `durationDays ≤ 365` are structural sanity bounds on an integer field, in the same spirit as `instructions`' length cap. They are explicitly **not** dosing-safety validation — this route does not know or check whether the dose is safe for this patient (§1, out of scope). The bounds exist so a typo'd `300` times daily is rejected as malformed input, not so the app can claim it validated a regimen.

**Prescriber resolution, in order:**

1. `resolveSessionProvider(session)` (§3.3). If it returns a provider, that is `prescribedByProviderId`. This is the `pi` path and the path for any admin who is also a clinician.
2. If it returns null **and** `session.role === 'admin'`, `onBehalfOfProviderId` is required. The route validates it against `listActiveProviders()` and uses it. `enteredByName` is `session.name`, which is how the record stays honest about the two different people involved.
3. If it returns null and the role is `pi`, **403** — `{ error: 'Could not resolve your provider identity. Ask an admin to link your account to a provider in the Staff Directory.' }`.

**There is no "fall back to the first active provider."** The lab-orders route does that for admin (`src/app/api/patients/[anonId]/lab-orders/route.ts:49`), and the explicit on-behalf-of picker is this spec's deliberate replacement for it. Silently attributing a prescription to whichever provider happens to sort first is a fabricated clinical fact on the one field where that is least acceptable; an explicit picker gets the same job done and records what actually happened. The error message in case 3 is actionable because the remedy — linking a `users` row to a `providers` row via the Staff Directory — is an existing admin capability, not something an implementer would have to build.

**On success:** inserts the `medicationEpisodes` row with `status: 'active'`, `prescribedAt: now()`, `enteredByName: session.name`; invalidates `patientDetailCacheKey(anonId)` (`getPatientDetail` is cached and includes `medications`); calls `logAudit(session, 'prescribed ${name}', anonId)`; returns the created row with `201`.

`onBehalfOfProviderId` sent by a session that *did* resolve a provider is ignored rather than rejected — a doctor cannot prescribe under someone else's name by adding a field, and the resolved identity always wins.

### `PATCH /api/patients/[anonId]/prescriptions/[id]`

```ts
const stopPrescriptionSchema = z.object({
  stopDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict()
```

Discontinues a prescription: sets `status: 'inactive'` and `stopDate` (defaulting to today). This is the only mutation offered — there is no edit-the-drug-or-dose path, because changing a written prescription in place would rewrite a record another party may already be holding on paper; the correct action is to stop it and write a new one.

Guards: **404** if the row does not exist or does not belong to `anonId` (the ownership check `dispenseMedication` already performs for `medicationEpisodeId`); **409** if `status` is already `inactive`, matching this codebase's convention of rejecting a re-submitted state transition rather than silently re-applying it. Same cache invalidation and `logAudit`.

Including a stop action is not scope creep: without it `status: 'inactive'` and `stopDate` would be unreachable from the UI, which is exactly the write-once dead end the staff-HR spec had to go back and fix for `staffMembers` (`src/lib/queries/staff-members.ts`, "Fix B").

**Stopping applies to prescriptions written here and to imported episodes alike.** An imported active episode that the doctor is discontinuing is a real clinical event, and refusing to let the chart record it would be worse than the small inconsistency of allowing a mutation on a row this app did not create. §12 records this as a point a reviewer may want to revisit.

## 6. The print view

**This is the first print pattern in the codebase.** `grep -rn "window.print\|@media print" src` returns zero hits. Everything below is being established, not followed.

**Route: `src/app/prescriptions/print/page.tsx`** — a top-level route, deliberately **outside** the `(dashboard)` route group. That group's layout (`src/app/(dashboard)/layout.tsx:18`) wraps everything in `h-screen overflow-hidden` with a fixed top banner and left nav, which is actively wrong for a printed page. A top-level route inherits only the root layout, which is the same chrome-free arrangement `src/app/display/queue/page.tsx` already uses. It is a Server Component whose first statement is `requireSessionOrRedirect()` (per that helper's own documented requirement), followed by the §7 role check.

**Query: `?ids=12` or `?ids=12,13,14`.** The route accepts N ids and renders them as one slip, because a prescription a patient carries out is per-visit, not per-drug — one sheet with three lines is what a doctor actually hands over, and supporting it now costs nothing later. **This spec wires only the single-id entry points** (the per-row Print link and the modal's post-save Print link). A "print this visit's whole list" control is not built here; the route simply will not need to change when it is.

**Validation, all failing to `notFound()`:** every id must exist, every id must belong to the same patient, and every id must have `prescribedAt` set. The same-patient rule is the important one — a URL that could interleave two patients' medications onto one printed sheet is a PHI-disclosure bug, not a rendering quirk.

**What the page shows:**

| Block | Source |
|---|---|
| Clinic identity | `appSettings.practiceName` / `practiceSite` via `getAppSettings()` (`src/lib/queries/settings.ts:7`), falling back to `Clinsync` when null — both columns are nullable (`src/db/schema.ts:407-408`) |
| Patient identity | `nameTebra ?? nameIntakeq`, patient id (`RD-0001`), `dobTebra ?? dobIntakeq` |
| Date written | `prescribedAt`, formatted long |
| Rx body, one block per id | drug name and `medicationClass`; `dose`; `{frequencyPerDay} times daily`; `for {durationDays} days`; `instructions` when present |
| Prescriber | `providers.name`, `credentials`, `specialty`, joined from `prescribedByProviderId`; a ruled signature line beneath |
| Entered by | `enteredByName`, shown only when it differs from the provider's name |
| Footer | `This printout is a record of a prescription entered in Clinsync. It was not transmitted electronically to a pharmacy.` |

The footer is not boilerplate. It is the visible edge of the §1 out-of-scope boundary, on the one artifact that leaves the building — the same disclosure discipline the `faxes` and mock-payment simulations already carry inside the app.

**Mechanics.** A `Print` button and a `Back` link render on screen inside a `no-print` wrapper; a small `@media print` block in `src/app/globals.css` hides `.no-print`, forces a white background and black text regardless of the active theme, and sets a page margin. No auto-`window.print()` on mount — an authenticated PHI page that fires a print dialog before the reader has confirmed it is the right patient is a mis-print waiting to happen. `logAudit(session, 'printed prescription(s) ${ids}', patientId)` runs on render, so every print is an audited PHI access, consistent with the document-download route's reasoning in the in-flight document spec.

## 7. Departments and specialties

**First, a correction that matters, from reading the seed rather than the column names.** There are two "department"-shaped columns and they mean different things:

| Column | Seeded values | What it actually is |
|---|---|---|
| `providers.specialty` (`src/db/schema.ts:449`) | `Psychiatry`, `Psychiatric Nurse Practitioner` (`src/db/seed.ts:90-94`) | the **clinical** specialty — the axis "psychiatric, neurology and all that" maps to |
| `staffMembers.department` (`src/db/schema.ts:790`) | `Clinical`, `Research`, `Administration`, `Front Desk`, `Facilities` (`src/db/seed.ts:532-540`) | the **organizational** department — an HR grouping |

Only `providers.specialty` is the clinical-department axis. Using `staffMembers.department` for anything prescription-related would group every doctor in the practice under `Clinical` and would be wrong.

**Decision: specialty is purely a display, grouping, and attribution concern. The prescribing form is byte-for-byte identical for a psychiatrist and a neurologist.**

Three reasons:

1. **Nothing in the data model differs.** A psychiatry prescription and a neurology prescription have the same shape: drug, dose, frequency, duration, instructions. There is no field one needs and the other does not.
2. **A specialty-conditional form would be clinical policy this app cannot source.** A per-specialty formulary, or a rule that a neurologist may not prescribe an antipsychotic, is decision support — the same licensed-data-source boundary that puts interaction checking out of scope (§1). Inventing that policy in application code would mean the app enforcing a clinical restriction nobody clinically authored, which is worse than not enforcing one. This follows the "software surfaces a fact, a human decides" principle this codebase has applied repeatedly.
3. **No `department` column is added to `medicationEpisodes`.** The prescriber's specialty is always derived by joining `prescribedByProviderId → providers.specialty`. Storing a copy would be a denormalized field that drifts the moment a provider's specialty is corrected — the same reasoning the document spec used to refuse an inpatient/outpatient boolean alongside `admissions.status`.

**Where specialty then actually appears:**

- **On the printout** (§6), under the prescriber's name. This is the most important surface: whoever receives the slip should see `Dr. Rajiv Kunam, MD — Psychiatry`, not a bare name.
- **As a filter facet on the Medication History section**, when the patient has prescriptions from more than one specialty. On a patient seen by both a psychiatrist and a neurologist, "show me what neurology has them on" is the real question, and it is a read the current chart cannot answer at all.
- **The facet list is derived, never hardcoded:** `SELECT DISTINCT specialty FROM providers WHERE is_active`. This is the concrete answer to "based on all the depts the hospital actually has" — the practice's specialty list is whatever its provider roster says it is. Adding a neurologist to the roster makes Neurology appear in the filter with no code change, no enum edit, and no migration. The seed today contains only psychiatry specialties; that is a property of this pilot's roster, not of the feature.

No new schema. `providers.specialty` is already `.notNull()`, so every provider already has one.

## 8. FHIR export

`src/lib/fhir/medication-request.ts` gains two small, mechanical improvements, because it is the one existing consumer of these columns and leaving it unaware of them would make the export quietly less accurate than the chart:

- `dosageInstruction[0].text` is composed from `dose`, `frequencyPerDay`, `durationDays`, and `instructions` when any are present, falling back to today's `dose`-only behavior when they are not. An imported history row's output is unchanged, byte for byte.
- `authoredOn` prefers `prescribedAt` (as a date) when set, falling back to `startDate`. For a prescription written here, "when it was authored" is a fact the row now actually carries; `startDate` was always a stand-in.

`status`, the `active`-only filter, and the absence of RxNorm `coding` are all unchanged. Adding a `requester` reference to the prescriber is *not* done here: a FHIR `Practitioner` resource does not exist in this app's export and creating one is a separate piece of work with its own bundle-shape decisions.

## 9. Testing

Following this codebase's real-DB-backed conventions (`vi.mock('@/lib/auth', ...)`, shared seeded rows, `afterEach`/`afterAll` cleanup of created ids), matching `tests/api/lab-orders.test.ts` and `tests/api/documents.test.ts`:

- **`tests/lib/auth.test.ts`** (extend): a session cookie round-trips `userId`; a cookie minted **without** a `userId` claim parses successfully with `userId: null` (the deploy-compatibility case from §3.2, and the one that would otherwise log every staff user out); a forged cookie is still rejected.
- **`tests/lib/provider-identity.test.ts`** (new): `resolveSessionProvider` resolves the seeded `pi` (`Dr. R. Kunam` → provider `Dr. Rajiv Kunam`), proving the name divergence no longer matters; returns null for `userId: null`; returns null for a user with a `staffMembers` row whose `providerId` is null; returns null when the staff member is `terminated`; returns null when the provider is `isActive: false`.
- **`tests/lib/queries/prescriptions.test.ts`** (new): `createPrescription` writes all new columns and `status: 'active'`; `stopPrescription` sets `inactive` + `stopDate` and a second call reports failure rather than re-applying; the patient-ownership check rejects an id belonging to another patient; `listEpisodesForPatient` returns imported and prescribed rows together with prescriber details joined only for the latter.
- **`tests/api/patients-prescriptions.test.ts`** (new): `pi` with a linked provider gets 201 and a row whose `prescribedByProviderId` is that provider; `pi` with **no** link gets 403 and writes nothing; `admin` with no link and no `onBehalfOfProviderId` gets 400; `admin` with a valid `onBehalfOfProviderId` gets 201 with `prescribedByProviderId` set to the chosen provider and `enteredByName` set to the admin's name; `crc` and `frontdesk` get 403; an unknown field is rejected (mass-assignment guard); a client-supplied `prescribedByProviderId` is rejected by `.strict()`; `frequencyPerDay: 0` and `durationDays: 400` are 400; PATCH on an already-inactive row is 409; PATCH on another patient's episode is 404.
- **`tests/lib/fhir/medication-request.test.ts`** (extend): a prescribed row's `dosageInstruction` text includes frequency and duration and its `authoredOn` is `prescribedAt`'s date; an imported row's output is unchanged from today.
- **`tests/api/prescriptions-print.test.ts`** (new): mixed-patient `ids` is a 404; an id with `prescribedAt: null` is a 404; a valid single id renders and writes an audit row; `crc`/`frontdesk` can print, matching §10's table.

Existing `tests/api/pharmacy-dispense.test.ts` and the medication-administration tests must continue to pass untouched — every new column is nullable, so no existing insert path changes.

## 10. Role gating summary

| Action | Allowed roles |
|---|---|
| View Medication History on the Medical Record page | admin, pi, crc, frontdesk — **unchanged**; this spec adds no read restriction and removes none (the parallel RBAC audit owns verifying this is correct today) |
| Add a prescription (`POST .../prescriptions`) | **admin, pi** — identical to `POST /api/patients/[anonId]/lab-orders`'s gate (`src/app/api/patients/[anonId]/lab-orders/route.ts:15`) and to `CarePlanSection`'s `canWrite` on this same page (`medical-record/page.tsx:189`). Ordering and prescribing are the clinical tier; crc and frontdesk are coordination and registration roles |
| …**additionally**, for `pi` | requires a resolvable `providers` row (§3.3); otherwise 403, no fallback |
| …**additionally**, for `admin` | uses its own resolved provider if it has one; otherwise must name an `onBehalfOfProviderId` explicitly |
| Stop / discontinue a prescription (`PATCH`) | admin, pi — same clinical tier as writing one |
| Print a prescription (`/prescriptions/print`) | admin, pi, crc, frontdesk — printing is a **read** of data all four roles already see on the chart, and it is audited on every render. Restricting reprints to the prescriber would mean the doctor has to be standing at the printer; who physically hands the slip to the patient is a clinic process, not an app permission |
| Prescribe or edit a prescription as pharmacy (in-flight role) | **never** — honors the in-flight pharmacy spec's §6.1, and requires no code: every role gate in this app is an allowlist, so a new enum member is denied by default |
| Link a `users` account to a `providers` row (Staff Directory) | admin — **unchanged**; this is the existing remedy for the 403 above |

## 11. Migration notes

Seven nullable columns added to `medication_episodes`, no backfill, no data rewrite, no enum changes, no renames. Every existing row keeps exactly its current meaning. `medicationDispenses`, `medicationAdministrations`, and the FHIR gather path all read this table today and none of them selects `*` into a fixed shape that a new column would break.

One non-schema deploy consideration, already handled in §3.2: staff session cookies minted before the `userId` claim exists remain valid until they expire (≤8 hours), and `parseSessionCookie` must treat the absent claim as `null` rather than as a validation failure. Getting this wrong logs out every signed-in staff member at deploy.

`src/db/seed.ts` gains two or three example prescribed episodes for the seeded `pi`'s patients — with `prescribedByProviderId`, `frequencyPerDay`, `durationDays`, and `prescribedAt` set — so the print view and the prescriber attribution are demonstrable without first writing one by hand. The existing imported-history episodes are left exactly as they are, which is also the regression check that a null-prescriber row still renders correctly.

## 12. Open questions

Deliberately unresolved, each with this spec's current answer and why a reviewer might change it:

1. **`frequencyPerDay` as an integer cannot express PRN, every-other-day, or a taper.** This spec accepts that limit for a first version and routes the narrative part into `instructions`. A reviewer closer to real prescribing may want a small `frequencyCode` enum (`QD`/`BID`/`TID`/`QID`/`PRN`/`OTHER`) alongside or instead of the count. Changing this later is additive; changing it after prescriptions exist in production data is not free.
2. **Should `admin` be able to prescribe at all?** This spec keeps admin in the gate (matching lab-orders) and makes the on-behalf-of attribution explicit. The stricter alternative — `pi` only, with admin able to prescribe solely when their own session resolves to a provider — is defensible and would simplify §5's branch 2 out of existence. It would also mean the seeded env-admin cannot demonstrate the feature.
3. **Should `medicationId` become required once the pharmacy spec lands catalog creation?** It must stay nullable today because the catalog is seed-only. Once any clinician can add a catalog entry, requiring it would guarantee an exact dispense match for everything prescribed — at the cost of forcing a catalog write into the prescribing flow.
4. **Coordination with the pharmacy dashboard's case-insensitive name match.** That spec's §4.4 preselects a catalog drug by matching `medicationEpisodes.name` against `medications.name`. Once `medicationId` exists it should prefer the FK and fall back to the name match for imported rows. This spec changes no pharmacy code; whichever branch merges second owns that one-line preference.
5. **Should the other six fuzzy-match call sites adopt `resolveSessionProvider`?** They should, and each will then need its own decision about failing closed. Deferred (§1) because that is six routes with six different existing policies.
6. **Should an imported (non-`prescribedAt`) episode be stoppable?** §5 says yes, on the grounds that discontinuing a drug is a real clinical event regardless of where the row came from. A reviewer who wants imported history to be strictly immutable would say no and require the doctor to write a superseding prescription instead.

---

## Self-review

- **Placeholder scan:** no `TODO`/`TBD`/bracketed placeholders. Every column name and type, route path, Zod field, role list, file path, and line reference is concrete. §12's open questions each state this spec's chosen answer, so an implementer is never blocked waiting on one.
- **Internal consistency:** `prescribedAt IS NOT NULL` is used as the "written here" discriminator identically in §2, §4 (prescriber line and Print link), §6 (print validation), and §8 (`authoredOn`) — nowhere does a section gate on `prescribedByProviderId` instead. The role table in §10 matches every prose gate in §4–§7, including the deliberate asymmetry that printing is open to the read tier while writing is not. §3.4 says exactly two call sites adopt the resolver, and §1's out-of-scope list names the six that do not; no later section quietly migrates a seventh. The "no fabricated attribution" principle is applied consistently: no first-active-provider fallback (§5), no backfilled prescriber on imported rows (§2), no printable imported row (§6).
- **Scope check:** one implementation plan's worth of work — seven nullable columns on one table, one session claim plus one resolver, two API routes, one component extraction plus one modal, one print page, one FHIR function touched. Everything the request implied but does not need (e-prescribing, interaction checking, refills, DEA/controlled substances, the six legacy call sites, the RBAC audit, pharmacy's own code) is named in §1's out-of-scope list and honored throughout — no later section reintroduces any of them.
- **Ambiguity check:** the two requirements most open to double reading are resolved explicitly. "How many times a day" is an integer field with stated bounds and a stated limitation, not a free-text sig. "Based on all the depts the hospital actually has" is resolved in §7 to `providers.specialty` (clinical) rather than `staffMembers.department` (organizational) — a distinction the column names actively invite getting backwards — and is decided as a display/grouping concern with three reasons, rather than left as "maybe the form differs per specialty." The print route's multi-id support is stated as capability-now / wiring-later so an implementer does not build a bulk-print UI this spec did not ask for.
