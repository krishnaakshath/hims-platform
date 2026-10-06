# Lab Orders & Results — Design Spec

**Status:** Draft for review — design spec, not yet implemented.
**Position in the larger initiative:** next item in the "complete the HIMS platform" backlog (research earlier this session identified lab orders/results tracking as a genuinely missing module — this app's own gap analysis explicitly lists "no orders table, no lab-results table" as a real, structural gap, distinct from CPOE/e-prescribing which are out of reach for regulatory reasons).

## 1. What this is, and the boundary it works within

This tracks the *record-keeping* half of ordering a lab test and receiving its result — a provider orders a test, the order moves through a real lifecycle (ordered → collected → resulted), and the result (value, unit, reference range, abnormal flag) attaches to the patient's chart. This does **not** simulate a real lab interface (HL7/FHIR order transmission to Quest/LabCorp, or receiving a real electronic result feed) — that needs a real lab-network integration contract, the same "needs a real business/regulatory step" boundary already established for e-prescribing and real insurance clearinghouse connectivity in this codebase. Results are entered by staff (as if transcribing a faxed/PDF report, which is how a lot of real small-practice lab workflows already work today) — this is honest about being a record-keeping layer, not a lab-interface simulation, matching the "simulate the outcome deterministically, never claim a real transaction happened" discipline already established for billing/broadcasts elsewhere in this codebase (the one place this spec *does* simulate an outcome — §4 below — follows that exact precedent).

This spec adds:
1. A **`labTests`** catalog — real, recognizable test names/codes (the standard panels a psychiatric practice actually orders: CBC, CMP, TSH, lipid panel, HbA1c, lithium level, valproate level, urine drug screen, etc.).
2. A **`labOrders`** table — patient, ordering provider, test, status (ordered/collected/resulted/cancelled), order date.
3. A **`labResults`** table — one row per resulted order, value, unit, reference range, abnormal flag (staff-entered, not computed — see §4).
4. A **"Order labs"** action from the patient chart, and a **Lab worklist** screen (mirrors the existing Front Desk / Inpatient queue-and-status-board pattern already established in this codebase).
5. A **Lab Results** section on the Medical Record page.

**Explicitly out of scope:** real lab-network order transmission or result feeds (regulatory/business boundary, see above). Automated abnormal-flag computation from arbitrary reference ranges (a real clinical-decision-support feature; this spec has staff mark abnormal at result-entry time, the same "a human confirms, software never silently decides" principle this codebase already applies to identity matching and trial eligibility verdicts). Trending/graphing a value over time — real value, but its own scope; this spec's chart section lists results, it doesn't chart them.

## 2. Data model changes (additive only)

```ts
export const labOrderStatusEnum = pgEnum('lab_order_status', ['ordered', 'collected', 'resulted', 'cancelled'])
export const labResultFlagEnum = pgEnum('lab_result_flag', ['normal', 'abnormal', 'critical'])

export const labTests = pgTable('lab_tests', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  code: text('code').notNull(), // a real, recognizable test code (LOINC-style), reference data only -- see spec Task 3 of the payer-directory plan's own precedent for "realistic but not transmitted anywhere"
  defaultUnit: text('default_unit'),
  referenceRange: text('reference_range'), // free text, e.g. "0.6-1.2 mEq/L" -- ranges vary by lab/method in reality, this is a display default, not a computed threshold
})

export const labOrders = pgTable('lab_orders', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  labTestId: integer('lab_test_id').notNull().references(() => labTests.id),
  orderedByProviderId: integer('ordered_by_provider_id').notNull().references(() => providers.id),
  status: labOrderStatusEnum('status').default('ordered').notNull(),
  orderedAt: timestamp('ordered_at').defaultNow().notNull(),
  collectedAt: timestamp('collected_at'),
})

export const labResults = pgTable('lab_results', {
  id: serial('id').primaryKey(),
  labOrderId: integer('lab_order_id').notNull().references(() => labOrders.id).unique(),
  value: text('value').notNull(), // free text -- lab values are sometimes qualitative ("Negative", "Trace"), not always numeric
  unit: text('unit'),
  referenceRange: text('reference_range'), // copied from labTests at result-entry time, editable -- a specific result's range can differ from the catalog default (different collection method, etc.)
  flag: labResultFlagEnum('flag').default('normal').notNull(),
  resultedByName: text('resulted_by_name').notNull(),
  resultedAt: timestamp('resulted_at').defaultNow().notNull(),
  notes: text('notes'),
})
```

**Why `labResults` is a separate table from `labOrders` (one-to-one via a unique FK) rather than result columns bolted onto `labOrders`:** an order and its result have different lifecycles and different authors (a provider orders, staff or the provider results later, possibly days apart) — same one-to-one-side-table reasoning as `medicationInventory`/`medications` in the sibling Pharmacy spec, and as `identityVerifications` elsewhere in this codebase. It also means "does this order have a result yet" is a simple existence check, not a null-column check on a wide table.

**Why `referenceRange` lives on both `labTests` (a default) and `labResults` (the actual value used):** copying the default at result-entry time, editable per-result, is honest about the fact that reference ranges genuinely vary by lab and collection method in real practice — the catalog's range is a sane starting point, not a hardcoded truth every result must match.

## 3. Seed data (reference catalog)

Seeded via `src/db/seed.ts` (idempotent, matching the established `payers` pattern), ~10 real, recognizable psychiatric-practice-relevant tests: CBC with differential, Comprehensive Metabolic Panel (CMP), TSH, Lipid Panel, HbA1c, Lithium level, Valproic acid level, Urine drug screen, Prolactin, Vitamin D, 25-OH — each with a real default unit and a real, recognizable (if simplified) reference range.

## 4. Order lifecycle

`POST /api/patients/[anonId]/lab-orders` — body `{ labTestId: number }`. Looks up the ordering provider from the session the same way other clinical-write routes in this codebase resolve "the calling provider" (matching the pattern already established for `pi`-role provider-ownership checks elsewhere — e.g. the inpatient discharge route's own-attending-provider check) or, simpler and consistent with how encounter notes handle authorship, just record `session.name`-derived provider lookup; creates a `labOrders` row with `status: 'ordered'`.

`POST /api/lab-orders/[id]/collect` — no body, transitions `ordered → collected` (rejects if not currently `ordered`, same conditional-transition-guard pattern already established by the MAR's `administerMedication` and the ADT admission/discharge routes).

`POST /api/lab-orders/[id]/result` — body `{ value: string, unit?: string, referenceRange?: string, flag: 'normal'|'abnormal'|'critical', notes?: string }`. Transitions `collected → resulted` (rejects if not currently `collected` — a result can't be entered before collection, matching real workflow), inserts the `labResults` row.

`POST /api/lab-orders/[id]/cancel` — transitions any non-terminal status to `cancelled` with a required reason in `notes`.

Every transition calls `logAudit(session, <action>, patientId)`.

## 5. Lab worklist screen

New page, `/labs`, mirroring the queue-and-status-board pattern already established by Front Desk's assignment queue and the Inpatient bed board: a list of orders grouped by status (Ordered / Collected / Resulted), each row showing patient, test, ordering provider, order date, and the next available action (Mark collected / Enter result / Cancel) gated by role. A status pill per row (never color alone, same established convention).

## 6. Medical Record: lab results

New "Lab Results" section on the Medical Record page (alongside Notes/Insurance/Medications Dispensed from this and prior plans), listing this patient's resulted orders newest-first: test name, value + unit, reference range, a flag pill (normal/abnormal/critical — critical rendered with the same destructive-tone treatment as other critical states elsewhere in this codebase), resulted date. Orders still in `ordered`/`collected` status show in a lighter "Pending" sub-list so staff can see what's outstanding without it being mistaken for a result.

## 7. Testing

`tests/lib/queries/lab-tests.test.ts` (catalog queries), `tests/api/lab-orders.test.ts` (order creation, collect/result/cancel transitions including the conditional-guard rejections — collecting an already-collected order, resulting an order that hasn't been collected, cancelling an already-resulted order), `tests/lib/queries/lab-results.test.ts` (patient-scoping — two patients' lab histories must stay independent, matching this session's established review-focus pattern).

## 8. Role gating summary

| Action | Allowed roles |
|---|---|
| View lab worklist / results | admin, pi, crc, frontdesk (matches existing read-access precedent) |
| Order a lab test (write) | admin, pi (clinical action) |
| Mark collected (write) | admin, pi, frontdesk (a front-desk/nursing-adjacent logistics step, not itself a clinical judgment — matches this codebase's existing distinction between "who can order/interpret" vs. "who can log a logistics event," e.g. Front Desk check-in vs. clinical assignment) |
| Enter a result (write) | admin, pi (clinical interpretation) |
| Cancel an order (write) | admin, pi |
