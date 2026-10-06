# Staff / HR Management — Design Spec

**Status:** Draft for review — design spec, not yet implemented.
**Position in the larger initiative:** next item in the "complete the HIMS platform" backlog — this app has `users` (system login accounts: role, password, MFA) and `providers` (the clinical scheduling roster: specialty, calendar color), but nothing tracking employment itself — who's actually employed, since when, in what role, and whether their clinical credentials are current.

## 1. What this is, and the boundary it works within

A real HR system needs payroll, benefits administration, PTO accrual, and performance review workflows — all of which need a real HR/payroll vendor relationship (ADP, Gusto, Rippling) to be honest rather than a toy simulation, the same "needs a real business/regulatory step" boundary already established in this codebase for e-prescribing and real insurance clearinghouse connectivity. This spec does **not** build any of that.

What it does build is the part that's genuinely useful without a vendor and genuinely missing today: **a staff directory with employment status and clinical-credential expiry tracking** — who works here, are they currently active, and is anyone's license about to lapse. This is real, bounded, and valuable on its own: a practice manager needs to know "whose DEA registration expires next month" regardless of whether payroll is ever integrated.

This spec adds:
1. A **`staffMembers`** table — one row per employee (not every employee necessarily has a `users` login — front-desk-only or housekeeping staff might not need system access; not every employee is a `providers` row — only clinical staff are), optionally linked to `users.id` and/or `providers.id` when applicable, with employment status, hire/termination dates, department, title.
2. A **`staffCredentials`** table — license/certification tracking per staff member (license type, number, expiry date), the actual clinically-relevant "is this person current" data.
3. A **Staff Directory** screen — list + detail, employment status, credential expiry with a visible warning state for anything expiring within 60 days (matching this codebase's existing "never color alone" status-pill convention).
4. A **credential-expiry summary** on the admin dashboard (or wherever admin-facing summaries currently live — read the codebase first) so an expiring license isn't something staff have to remember to check for.

**Explicitly out of scope:** payroll, benefits, PTO/time-off tracking, performance reviews, onboarding/offboarding workflows (all need a real vendor or are their own large scope), org-chart/reporting-structure modeling (not requested, no clear use yet), automated license verification against a state licensing board's API (needs a real vendor relationship, same boundary as e-prescribing).

## 2. Data model changes (additive only)

```ts
export const employmentStatusEnum = pgEnum('employment_status', ['active', 'on_leave', 'terminated'])

export const staffMembers = pgTable('staff_members', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id), // nullable -- not every staff member has system login access
  providerId: integer('provider_id').references(() => providers.id), // nullable -- only clinical staff are on the scheduling roster
  name: text('name').notNull(), // kept independently of users.name/providers.name -- a staff record can exist (and should stay readable in history) even if the linked user/provider row is later removed, and not every staff member has either link
  department: text('department').notNull(),
  title: text('title').notNull(),
  employmentStatus: employmentStatusEnum('employment_status').default('active').notNull(),
  hireDate: date('hire_date').notNull(),
  terminationDate: date('termination_date'),
})

export const staffCredentials = pgTable('staff_credentials', {
  id: serial('id').primaryKey(),
  staffMemberId: integer('staff_member_id').notNull().references(() => staffMembers.id),
  credentialType: text('credential_type').notNull(), // e.g. "State Medical License", "DEA Registration", "Board Certification" -- free text, not an enum: real credential types vary too much by state/specialty to enumerate usefully
  credentialNumber: text('credential_number'),
  expiresOn: date('expires_on'),
})
```

**Why `staffMembers.name` duplicates rather than always joining `users.name`/`providers.name`:** those two tables can be independently nullable here, and a staff record legitimately outlives either link (someone loses system access on leave, or leaves the clinical roster but stays employed in an admin role) — the same "own denormalized name field so history reads correctly regardless of what happens to the linked row" reasoning `medicationDispenses.dispensedByName` and `admissionTransfers.transferredByName` already use elsewhere in this codebase.

**Why `staffCredentials` is a separate table, one-to-many, rather than columns on `staffMembers`:** a single staff member (a physician) commonly holds multiple credentials (state license + DEA + board certification), each with its own independent expiry — a fixed set of columns can't represent that, and a side table is this codebase's established pattern for exactly this shape (`allergies` to `patients`, `medicationInventory` to `medications`).

## 3. Credential-expiry warning

"Expiring soon" = `expiresOn` is non-null and within 60 days of today (a fixed, published-instrument-style cutoff, not user-configurable — keeps this spec bounded, matching how this codebase's other threshold-based warnings, e.g. Pharmacy's reorder threshold, are per-row configurable but not globally tunable via a settings screen). "Expired" = `expiresOn` is in the past. Both are distinct visual states on the Staff Directory (never color alone — an icon/text label alongside the color, matching every prior status-pill in this codebase), and both appear together in a single admin-dashboard summary list (name, credential type, days until/since expiry), sorted soonest-first.

## 4. Staff Directory screen

New page, `/staff` (nav item + `role-capabilities.ts` entry, matching how `/pharmacy` and `/labs` were added in prior plans this session): a list of staff members (name, department, title, employment status pill, soonest-expiring-credential indicator if any), each row opening a detail view showing full employment info and every credential row. A "Add staff member" action and an "Add credential" action per staff member — write operations, admin-only (HR data is not a clinical read/write split like the rest of this app; it's an administrative function).

## 5. Testing

`tests/lib/queries/staff-members.test.ts` (create/list/get, optional user/provider linkage), `tests/lib/queries/staff-credentials.test.ts` (create, expiry-window query correctness at exact boundary — 60 days and 61 days must sort differently, an already-expired credential is its own category not lumped into "expiring soon"), `tests/api/staff-directory.test.ts` (role gating — read admin/pi/crc/frontdesk per existing precedent, write admin-only; creating a staff member with no `userId`/`providerId` succeeds, since neither is required).

## 6. Role gating summary

| Action | Allowed roles |
|---|---|
| View staff directory / credential expiry summary | admin, pi, crc, frontdesk (matches existing read-access precedent) |
| Add/edit a staff member or credential (write) | admin only (an HR/administrative function, not a clinical one — distinct from this app's usual pi+admin clinical-write split) |
