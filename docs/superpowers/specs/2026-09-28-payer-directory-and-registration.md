# Payer Directory, Patient Insurance & Registration, ID Verification — Design Spec

**Status:** Draft for review — design spec, not yet implemented.
**Position in the larger initiative:** next sub-project after encounter notes + nursing/MAR, requested directly by the user: registration, ID verification, and "insurance claims... with actual insurances that exist."

## 1. What this is, and the hard boundary it works within

Today, every insurance-related field in this codebase (`insuranceClaims.payerName`, `insuranceEligibilityChecks.payerName`) is free text — there is no real payer directory, no patient insurance/subscriber fields at all (`patients` has zero insurance columns), and no insurance card capture (Vercel Blob is provisioned but has never been wired to a real upload flow, per the product architecture doc). ID verification already exists and is reasonably complete (`identityVerifications`: driver's license / state ID / passport, encrypted ID number, staff-verified workflow) — this spec extends its ID type coverage slightly but doesn't rebuild it.

**The hard boundary, stated once and binding for every section below:** this spec uses real US payer names and realistic payer ID formats as reference data (exactly how every real practice-management product — Tebra, IntakeQ, Availity — does it), and builds a complete, realistic claims/eligibility *workflow*. It does **not** submit anything to a real insurer. Live claim submission requires a real clearinghouse contract (Availity, Change Healthcare, Waystar) and per-payer credentialing — a business/legal step, not an engineering one, already flagged as out of reach in `docs/product-review-and-gap-analysis.md`. This spec follows the exact same "simulate the outcome deterministically, never claim a real transaction happened" pattern already established for `mockPayments` and broadcast delivery.

This spec adds:
1. A **`payers`** reference table — real major US insurance companies (commercial + Medicare + Medicaid) with realistic payer IDs, replacing every free-text `payerName` field.
2. **Patient insurance/subscriber fields** — member ID, group number, plan type, subscriber name/relationship-to-patient, for primary and secondary insurance — captured at registration.
3. **Insurance card image capture** — front/back upload via Vercel Blob (the first real use of it in this codebase).
4. A richer **eligibility check** response (deductible remaining, plan type, coverage dates — not just copay).
5. **ID type coverage**: add `military_id` and `green_card` to the existing `idTypeEnum` (currently driver's license/state ID/passport only) — the only genuinely missing piece of ID verification.

**Explicitly out of scope:** real clearinghouse submission (per the hard boundary above). Real ID-document OCR/liveness verification (Persona/Jumio-class services — same "needs a real vendor contract" boundary, staff-verified stays the model). A second/tertiary insurance slot beyond primary+secondary (real-world practices handle tertiary rarely enough that YAGNI applies — additive if ever needed). Insurance card OCR/auto-fill from the uploaded image (the image is for staff reference/audit, not parsed — a real OCR pipeline is its own vendor-contract boundary again).

## 2. Data model changes (additive only)

```ts
export const payerTypeEnum = pgEnum('payer_type', ['commercial', 'medicare', 'medicaid', 'tricare', 'other'])

export const payers = pgTable('payers', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  payerId: text('payer_id').notNull(), // realistic EDI-style payer ID, e.g. Aetna "60054"
  payerType: payerTypeEnum('payer_type').default('commercial').notNull(),
})

export const insuranceRelationshipEnum = pgEnum('insurance_relationship', ['self', 'spouse', 'child', 'other'])
export const insurancePlanTypeEnum = pgEnum('insurance_plan_type', ['ppo', 'hmo', 'epo', 'pos', 'medicare', 'medicaid'])
```

Insurance fields are embedded directly on `patients` as nullable columns, not a separate `patientInsurancePolicies` table — the same reason `patients` already embeds dual-sourced demographic fields directly rather than a side table: every existing patient query already does `select * from patients`, and a side table would mean every one of those call sites needs a new join just to show "does this patient have insurance on file." Additive columns on `patients` (primary insurance, all nullable -- most patients in this pilot's seed data have none today, and that must stay a valid state):

```ts
  primaryPayerId: integer('primary_payer_id').references(() => payers.id),
  primaryMemberId: text('primary_member_id'),
  primaryGroupNumber: text('primary_group_number'),
  primaryPlanType: insurancePlanTypeEnum('primary_plan_type'),
  primarySubscriberName: text('primary_subscriber_name'),
  primarySubscriberRelationship: insuranceRelationshipEnum('primary_subscriber_relationship'),
  primaryCardFrontUrl: text('primary_card_front_url'), // Vercel Blob URL
  primaryCardBackUrl: text('primary_card_back_url'),
  secondaryPayerId: integer('secondary_payer_id').references(() => payers.id),
  secondaryMemberId: text('secondary_member_id'),
  secondaryGroupNumber: text('secondary_group_number'),
  secondaryPlanType: insurancePlanTypeEnum('secondary_plan_type'),
  secondarySubscriberName: text('secondary_subscriber_name'),
  secondarySubscriberRelationship: insuranceRelationshipEnum('secondary_subscriber_relationship'),
```

**Why prefixed `primary`/`secondary` flat columns instead of a `patientInsurancePolicies` side table with a `rank` column:** this codebase's own established convention for "a fixed, small number of typed slots" is flat prefixed columns, not a side table — see `nameIntakeq`/`nameTebra` (exactly 2 sources, prefixed) rather than a `patientNameSources` table. Insurance here is the same shape: exactly primary + optionally secondary, never an arbitrary list. A side table would be the right call only if a third+ slot were a real requirement, which §1 explicitly rules out.

`insuranceClaims.payerName` and `insuranceEligibilityChecks.payerName` (both currently free text) become `payerId: integer('payer_id').notNull().references(() => payers.id)` — additive-safe as a column *addition* alongside the existing text column, not a destructive rename, since existing rows have real free-text payer names already written (seed data): add `payerId` nullable at the schema level, backfill via the migration script by matching existing `payerName` strings against the new `payers.name` (best-effort `ILIKE`), leave `payerName` in place as a fallback display value for any row that doesn't match. New writes always set `payerId`; `payerName` becomes read-only/derived going forward (computed from the joined payer's name), not accepted on new inserts.

`insuranceEligibilityChecks` gains: `deductibleRemainingCents: integer('deductible_remaining_cents')`, `planType: insurancePlanTypeEnum('plan_type')`, `coverageStartDate: date('coverage_start_date')`.

`idTypeEnum` widens: `pgEnum('id_type', ['drivers_license', 'state_id', 'passport', 'military_id', 'green_card'])`.

## 3. Payer directory (reference data, seeded not user-editable)

A fixed, seeded list — not a CRUD screen (real payer directories are maintained by clearinghouses, not typed in by staff; a practice picks from a known list, it doesn't invent payers). Seeded via the migration script, ~25 rows covering the payers a real US outpatient psychiatric practice actually bills:

**Commercial:** Aetna (60054), UnitedHealthcare (87726), Cigna (62308), Humana (61101), Blue Cross Blue Shield (varies by state — seed the 3 the seed data's "Redlands" California setting actually needs: Anthem Blue Cross of California (47198), Blue Shield of California (47163)), Kaiser Permanente (94134), Molina Healthcare (38333), Centene/Ambetter (68069), Oscar Health (72187), Health Net (95567).

**Government:** Medicare (00590 — the California Part B MAC, Noridian), Medi-Cal (California's Medicaid, payer ID 12X0), TRICARE (99726).

**Type field:** `commercial` for the first group, `medicare`/`medicaid`/`tricare` respectively for the second.

Every payer ID above is a well-known, commonly-published payer ID for that carrier, not an invented placeholder pattern like "PAYER-001" — this is what makes the directory *realistic* reference data rather than placeholder text, even though nothing in this app ever transmits to them. Exact payer IDs vary by clearinghouse in the real world (Availity, Office Ally, and a given payer's own portal don't always agree on one canonical ID), so these are representative, not a guarantee of matching any one specific clearinghouse's current list — immaterial here since nothing is ever actually submitted, but worth stating plainly rather than overclaiming precision this spec didn't verify against a live clearinghouse feed.

## 4. Registration: capturing insurance at patient intake

Two entry points already exist for adding a patient — the staff-facing "Add Client" flow and the patient-facing intake portal (`/intake/[token]`). Insurance capture is added to **both**, since a real registration can happen at either desk or self-service:

- **Add Client modal** (staff-facing): after the existing demographic fields, a new "Insurance" section — payer dropdown (from `payers`, grouped by type), member ID, group number, plan type, subscriber name/relationship (defaulting subscriber name to the patient's own name and relationship to `self`, only expanding if staff indicates the patient isn't the subscriber). Secondary insurance is a collapsed "+ Add secondary insurance" toggle, not shown by default (most patients have one payer).
- **Intake portal** (`/intake/[token]`, patient-facing): a new question type, `insurance`, addable to a form template the same way existing question types are — rendering the same payer-dropdown + member/group/subscriber fields, plus the two file-upload fields for card front/back (see §5). Only asked when a form template's author includes it, matching how every other intake question is opt-in per template.

`POST /api/patients` (Add Client) and the intake submission route both gain the new optional fields, validated by the same `.strict()` Zod pattern — every new field optional, since "no insurance on file yet" must remain valid (self-pay patients are real).

## 5. Insurance card image capture (first real use of Vercel Blob)

`POST /api/patients/[anonId]/insurance-card` — body: `multipart/form-data` with `side: 'front' | 'back'` and the image file. Validates: real image content-type (`image/jpeg`, `image/png`, `image/webp` only), max 8MB. Uploads via `@vercel/blob`'s `put()`, stores the returned URL on `patients.primaryCardFrontUrl`/`primaryCardBackUrl`. Gated to the roles that already write patient demographic data (`admin`, `crc`, `frontdesk`) plus the patient themselves via a separate patient-portal-scoped variant of the same route (matching how `logAudit` vs. `logPatientPortalAction` already split staff vs. patient-initiated writes elsewhere in this codebase).

**UI:** on the Add Client modal and the intake portal's insurance question, a simple file-input-styled upload control per side (front/back), showing a thumbnail once uploaded. On Patient Detail / Medical Record, the Insurance section (§6) shows both images if present, click-to-enlarge.

## 6. Displaying insurance on Patient Detail / Medical Record

New "Insurance" section on `src/app/(dashboard)/patients/[anonId]/medical-record/page.tsx` (same page Task 2's Notes section landed on, same `SECTION`/`SECTION_HEADING` pattern): primary insurance card (payer name + logo-free badge showing payer type, member ID, group number, subscriber, plan type, card images if present) and secondary if present, or an empty state ("No insurance on file") with an "Add insurance" action for staff roles.

## 7. Eligibility check: richer response, wired to the real payer directory

`POST /api/front-desk/eligibility-check` (existing route) changes its payer input from free text to `payerId` (dropdown sourced from `payers`, defaulting to the patient's own `primaryPayerId` if set). The simulated response generator (already deterministic/mock per the existing `insuranceEligibilityChecks` pattern) gains `deductibleRemainingCents`, `planType` (copied from the patient's own `primaryPlanType` if set, else a plausible simulated value), `coverageStartDate`. Front Desk's eligibility check UI displays all of these, not just copay.

## 8. Testing

`tests/lib/queries/payers.test.ts` (payer directory lookup/list), `tests/api/patients-insurance.test.ts` (Add Client with insurance fields, insurance-card upload route, patient-portal variant), `tests/api/intake-insurance-question.test.ts` (intake portal insurance question submission), `tests/api/front-desk-eligibility-check.test.ts` (extend existing file for the richer response + payerId-based lookup).

## 9. Role gating summary

| Action | Allowed roles |
|---|---|
| View a patient's insurance info | admin, pi, crc, frontdesk (matches existing Patient Detail gating) |
| Add/edit insurance info, upload card images (staff-initiated) | admin, crc, frontdesk (matches existing Add Client gating — not pi-restricted, since front desk/coordinators are who actually register patients) |
| Upload own insurance card (patient-initiated) | the patient themselves, via patient-portal session, on their own record only |
| Run an eligibility check | admin, crc, frontdesk (matches existing eligibility-check gating) |
