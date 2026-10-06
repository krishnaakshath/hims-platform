# Pharmacy: Medication Catalog, Inventory & Dispensing — Design Spec

**Status:** Draft for review — design spec, not yet implemented.
**Position in the larger initiative:** next item in the "complete the HIMS platform" backlog (research earlier this session identified pharmacy/medication inventory as a genuinely missing module — the app has `medicationEpisodes`, a patient's reconciled medication list, and `medicationAdministrations`, the inpatient MAR from a prior plan, but nothing tracking what medications the practice actually stocks or dispenses).

## 1. What this is, and the boundary it works within

This models the two things a real outpatient pharmacy/dispensing operation needs that this app doesn't have: **what drugs exist and how much is on hand** (a formulary catalog + stock levels), and **a record of dispensing an actual medication to a patient** (decrementing stock, tied to a patient/prescriber/date). This is inventory and dispensing tracking — it does **not** simulate a real pharmacy fulfillment network, e-prescribing to a retail pharmacy, or drug-interaction checking against a live formulary database (all of those need a real vendor relationship — Surescripts, First Databank, etc. — the same "needs a real business/regulatory step" boundary already established for e-prescribing in this codebase's own gap analysis). This is the practice's own on-site stock (samples, in-office dispensing — common in a psychiatric practice for things like Spravato/esketamine, which IPMG's own reference material already names as a service line) tracked honestly, nothing more.

This spec adds:
1. A **`medications`** catalog table — name, generic name, drug class, common dose/form, seeded with a real, recognizable starter set (the same psychiatric-medication classes already referenced throughout this codebase's seed data: SSRIs/SNRIs, atypical antidepressants, stimulants, antipsychotics).
2. A **`medicationInventory`** table — one row per catalog drug, current quantity on hand, reorder threshold, unit.
3. A **`medicationDispenses`** table — one row per dispensing event: patient, medication, quantity, dispensing staff member, date, linked optionally to a `medicationEpisodes` row (the patient's existing med list) so a dispense can (but doesn't have to) fulfill a specific prescribed episode.
4. A **Pharmacy** dashboard screen — inventory levels with a low-stock/reorder indicator, and a "Dispense medication" action that decrements stock and records the event.
5. A **Medications dispensed** history section on the patient's Medical Record page.

**Explicitly out of scope:** e-prescribing to an external pharmacy (real vendor/regulatory boundary, already documented elsewhere in this codebase as out of reach). Drug-interaction/allergy-conflict checking against a live formulary (needs a real drug database license — First Databank, Medi-Span — same boundary). Controlled-substance-specific tracking (DEA schedule logging, dual sign-off) — a real, valuable feature but its own scope, deferred rather than half-built. Purchase orders / supplier management for restocking — this spec tracks *that* stock is low, not the supply-chain workflow to fix it.

## 2. Data model changes (additive only)

```ts
export const medicationFormEnum = pgEnum('medication_form', ['tablet', 'capsule', 'liquid', 'injection', 'other'])

export const medications = pgTable('medications', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  genericName: text('generic_name'),
  medicationClass: text('medication_class').notNull(),
  commonDose: text('common_dose'),
  form: medicationFormEnum('form').default('tablet').notNull(),
})

export const medicationInventory = pgTable('medication_inventory', {
  id: serial('id').primaryKey(),
  medicationId: integer('medication_id').notNull().references(() => medications.id).unique(),
  quantityOnHand: integer('quantity_on_hand').default(0).notNull(),
  reorderThreshold: integer('reorder_threshold').default(10).notNull(),
  unit: text('unit').default('units').notNull(), // e.g. "tablets", "vials", "mL"
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export const medicationDispenses = pgTable('medication_dispenses', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  medicationId: integer('medication_id').notNull().references(() => medications.id),
  medicationEpisodeId: integer('medication_episode_id').references(() => medicationEpisodes.id),
  quantity: integer('quantity').notNull(),
  dispensedByName: text('dispensed_by_name').notNull(),
  dispensedAt: timestamp('dispensed_at').defaultNow().notNull(),
  notes: text('notes'),
})
```

**Why `medicationInventory` is a separate table from `medications`, one-to-one, rather than columns on `medications` itself:** the catalog (what a drug *is*) and its stock (a quantity that changes on every dispense) are different write-frequencies and different concerns — same reasoning this codebase already applies elsewhere (`patients` vs. `identityVerifications`, a dual-write-rate pair kept in a side table). A dispense route only ever touches `medicationInventory` and `medicationDispenses`, never `medications` itself, which stays read-only reference data after seeding — same posture as `payers` in the prior plan.

**Why `medicationDispenses.medicationEpisodeId` is nullable, not required:** a dispense in a real practice sometimes fulfills a specific prescribed episode already on the patient's med list, and sometimes is a sample/one-off (e.g., a Spravato in-office dose that isn't tracked as a standing "episode" the same way a take-home prescription is) — forcing every dispense to reference an episode would make the common in-office-dose case awkward.

## 3. Seed data (reference catalog, not user-editable in this pass)

Seeded via `src/db/seed.ts` (idempotent, matching this codebase's established `payers`-seeding pattern from the prior plan — check by name before inserting), ~15 medications spanning the classes already referenced throughout this codebase's own trial/seed data (SSRI/SNRI, atypical antidepressant, stimulant, antipsychotic, benzodiazepine) plus Spravato (esketamine) given IPMG's own referenced service line: Sertraline, Escitalopram, Venlafaxine, Bupropion, Trazodone, Mirtazapine, Aripiprazole, Quetiapine, Risperidone, Lorazepam, Clonazepam, Methylphenidate ER, Amphetamine/dextroamphetamine, Lithium, Esketamine (Spravato). Each gets a starting `medicationInventory` row (a plausible quantity — 20-200 units depending on form — and a reorder threshold of 10-20).

## 4. Pharmacy dashboard

New page, `/pharmacy` (nav item + `role-capabilities.ts` entry, matching how `/inpatient/beds` was added in the earlier ADT plan): a table of every medication with current `quantityOnHand`, `reorderThreshold`, and a status pill — `ok` (green) when above threshold, `low stock` (amber) when at or below threshold and above zero, `out of stock` (red) when zero — never color alone, matching this codebase's established `StatusChip`-adjacent convention. Each row has a "Dispense" action opening a modal: select patient (reuse the existing patient-search/autocomplete pattern already used elsewhere, e.g. Front Desk's patient lookup), quantity, optional linked medication episode (a dropdown of that patient's active `medicationEpisodes` rows matching this drug's name, if any), notes. Submitting decrements `quantityOnHand` (rejecting if the requested quantity exceeds what's on hand — a dispense can't create negative stock) and inserts the `medicationDispenses` row.

## 5. Medical Record: dispensing history

New "Medications Dispensed" section on the Medical Record page (alongside the Notes and Insurance sections from prior plans — same `SECTION`/`SECTION_HEADING` convention), listing this patient's dispense history newest-first: medication name, quantity, date, dispensed by. Read-only display — dispensing itself always happens from the Pharmacy dashboard (§4), not from this page, so there's one front door for the write action.

## 6. Testing

`tests/lib/queries/medications.test.ts` (catalog + inventory queries), `tests/api/pharmacy-dispense.test.ts` (the dispense route — happy path decrementing stock, rejecting a quantity exceeding stock, rejecting a nonexistent medicationId, rejecting a role without dispense access), `tests/lib/queries/medication-dispenses.test.ts` (dispense history query, patient-scoping — two patients' dispense histories must stay independent, matching this session's established review-focus pattern).

## 7. Role gating summary

| Action | Allowed roles |
|---|---|
| View pharmacy inventory / dispense history | admin, pi, crc, frontdesk (matches existing read-access precedent) |
| Dispense a medication (write) | admin, pi (clinical action — matches encounter-notes/MAR precedent of pi+admin for clinical writes, distinct from the frontdesk-inclusive registration/insurance write set) |

## 8. Post-implementation deferral (final review)

1. **[Added post-implementation, final review]: §4's optional `medicationEpisodeId` dropdown was never built.** §4 describes the Dispense modal offering "optional linked medication episode (a dropdown of that patient's active `medicationEpisodes` rows matching this drug's name, if any)." The implementation plan's Task 3 (Dispense modal + route) never scoped this dropdown into its task list, and it was never built. The rest of the `medicationEpisodeId` path is real and fully wired end-to-end — the `medicationDispenses.medicationEpisodeId` column, the query-layer validation in `dispenseMedication` (rejecting an episode id that doesn't belong to the given patient), the route's optional field, and dedicated tests all exist and pass — but there is no UI control that can ever set it, so it is always `null` in practice today. Ruling from the controller: this is an explicit deferral, not a bug to fix now, since no other shipped part of this feature depends on the dropdown existing. A follow-up pass can add the dropdown to `DispenseMedicationModal` whenever prioritized; the schema/query/route groundwork it would build on is already in place.
