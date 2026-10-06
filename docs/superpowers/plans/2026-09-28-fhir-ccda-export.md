# FHIR / C-CDA Export API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Clinsync a read-only, single-patient, staff-authenticated export of the app's real structured chart data as FHIR R4 JSON (per-resource-type routes plus one combined Bundle) and as a C-CDA XML document, built from the same mapping functions so the two formats can never silently drift apart.

**Architecture:** Six pure mapping functions in `src/lib/fhir/` (one per resource type: Patient, AllergyIntolerance, Condition, MedicationRequest, MedicationDispense, Observation), each `DB row(s) → FHIR JSON`, tested field-by-field against real inserted fixture rows. A `gather.ts` function does the one round of DB reads per patient; both the FHIR API routes and the C-CDA composer call the same gather function and the same six mapping functions, so the two export formats are two renderings of one set of already-mapped facts, not two independent implementations.

**Tech Stack:** Next.js 16 App Router (Route Handlers) + Drizzle ORM over a `pg` Pool + Zod `.strict()` (not needed here — every route in this plan is a `GET`, no request body) + vitest. No schema changes, no new dependencies — C-CDA XML is built with template strings (no XML-builder library is currently a dependency — confirmed against `package.json` — and the spec explicitly says none is needed for this fixed, known document shape); well-formedness in tests is checked with `DOMParser` (available globally under vitest's `jsdom` environment, already a devDependency), not a new parser library.

**Spec:** `docs/superpowers/specs/2026-09-28-fhir-ccda-export.md`

**Working directory note:** this plan is executed in an isolated git worktree at `/Users/k2a/Desktop/clinsync/.worktrees/fhir-export` on branch `feature/fhir-export`. This worktree has its own `.env.local` and `node_modules` already set up. Every implementer/reviewer dispatch for this plan must work from this exact directory, not the main checkout — the main checkout and other worktrees (`.worktrees/lab-orders-results`, `.worktrees/pharmacy-med-inventory`, etc.) have their own concurrent work in flight; do not touch them.

## Global Constraints

- **This plan makes NO database changes.** It is a pure read/transform layer over tables that already exist (`patients`, `allergies`, `diagnoses`, `medicationEpisodes`, `medicationDispenses`, `medications`, `labOrders`, `labResults`, `labTests`). There is no schema task, no migration script, and none of the "single shared Neon Postgres database across every branch/worktree" migration-safety warnings other plans in this session carry apply here — every task in this plan only ever runs `SELECT`s (via the existing query layer or new read-only query functions) against tables other branches' migrations already created. Stating this explicitly rather than omitting the section, per this plan's own instructions.
- Every export route is a `GET` gated by `requireSession()` (API routes) as its first statement — no `.strict()` Zod body validation is needed anywhere in this plan since no route takes a body.
- Role gating (spec §7): `admin`, `pi`, `crc`, `frontdesk` may export a patient's FHIR bundle or C-CDA document — this is the same set that already has chart read-access everywhere else in this app (e.g. the Medical Record page's own `requireSessionOrRedirect()`, with no extra per-role branching inside the page). No new role tier.
- Every export call is audit-logged. Per spec §5's exact action strings: `logAudit(session, 'exported FHIR bundle', anonId)` for every route under `/fhir/...` (Patient, AllergyIntolerance, Condition, MedicationRequest, MedicationDispense, Observation, and the combined Bundle — one consistent action string across all seven, not seven different strings), and `logAudit(session, 'exported C-CDA document', anonId)` for the C-CDA route.
- "Honest text, not fabricated codes" discipline (spec §3): AllergyIntolerance and MedicationRequest/MedicationDispense carry `code.text`/`medicationCodeableConcept.text` as free text only — no `system` URI is ever set on those resources' codings, because this app has never coded allergens or medications against RxNorm/SNOMED. Observation is the one exception — `labTests.code` is included as a real `coding[].code` value, but every place that surfaces it (the mapping function's own code comment, and its test) must carry forward the exact caveat already on that column in `src/db/schema.ts`: reference data, LOINC-style, never verified against the real LOINC database. See Task 1's Condition step for the one additional judgment call this plan makes on the same principle for `diagnoses.code`.
- Commit messages end with no attribution trailer.
- UI verification discipline: verify via a real running dev server hit with real HTTP requests (mint a session cookie the way `src/lib/auth.ts` actually does it — `buildSessionCookieValue(role, name)` under cookie `clinsync_demo_session`, secret from `SESSION_SECRET`), with actual commands and actual output pasted in the report. Never a narrated, unreproduced claim — this session has already caught one fabricated UI-verification claim.
- Vitest invocation: `npx dotenv -e .env.local -- npx vitest run <path>` (`fileParallelism: false` — the suite shares one live DB).

## Review Focus

1. **A patient with zero allergies, diagnoses, active medications, dispenses, and resulted labs** must still produce a valid, well-formed, empty `Bundle` (`entry: []`, `total: 0`) from every per-type route and from `/fhir/Bundle`, not a 404, a 500, or a malformed body — spec §6's own explicit review item. (Task 2)
2. **Two patients' exports never cross** — every gather/mapping/route call keyed strictly off the one requested `anonId`, no shared cache or query bleed between two patients' FHIR or C-CDA output — spec §6's own explicit review item, matching this session's established cross-patient review-focus pattern from the Lab Orders and Pharmacy plans. (Task 2, Task 3)
3. **A non-numeric lab result value** (`labResults.value` is `text`, not numeric — e.g. a Urine Drug Screen result of `"Negative"`) must map to FHIR `valueString`, not silently become `NaN`/`0` in a fabricated `valueQuantity`. Not called out explicitly in the spec's prose, but directly implied by `labResults.value`'s actual column type and the "don't fabricate structured data the source doesn't support" discipline spec §3 states for every other resource. (Task 1)
4. **The C-CDA document and the FHIR Bundle must not drift** for the same patient — spec §6 requires a cross-check test proving the XML reflects the same underlying facts as the JSON, not just independent well-formedness validation of each format on its own. (Task 3)
5. **An unauthenticated or wrong-role request to any of the eight export routes** (six per-resource-type, one Bundle, one C-CDA) must get a 401/403 and no patient data in the body — a new set of routes that serialize a patient's full structured chart into a single downloadable JSON/XML payload is exactly the kind of surface a missed `requireSession()` call turns into a real PHI leak, and this codebase's own `auth.ts` comment records that a prior review found 3 of 3 routes independently "forgot" this check. (Task 2, Task 3)

---

### Task 1: FHIR resource mapping functions

**Files:**
- Create: `src/lib/fhir/types.ts`
- Create: `src/lib/fhir/patient.ts`
- Create: `src/lib/fhir/allergy.ts`
- Create: `src/lib/fhir/condition.ts`
- Create: `src/lib/fhir/medication-request.ts`
- Create: `src/lib/fhir/medication-dispense.ts`
- Create: `src/lib/fhir/observation.ts`
- Test: `tests/lib/fhir/patient-mapping.test.ts`, `tests/lib/fhir/allergy-mapping.test.ts`, `tests/lib/fhir/condition-mapping.test.ts`, `tests/lib/fhir/medication-request-mapping.test.ts`, `tests/lib/fhir/medication-dispense-mapping.test.ts`, `tests/lib/fhir/observation-mapping.test.ts`

**Interfaces:**
- Consumes: `patients`, `allergies`, `diagnoses`, `medicationEpisodes`, `medicationDispenses` from `@/db/schema` (existing); `PatientLabOrderRow`/`listOrdersForPatient` from `@/lib/queries/lab-orders` (existing, already joins `labOrders`+`labTests`+`labResults` for one patient — see its exact shape below; the Observation mapping test in Step 15 calls `listOrdersForPatient` directly against real inserted fixture rows, not hand-built literals).
- Produces (consumed by Task 2 and Task 3):
  - `patientToFhir(patient: typeof patients.$inferSelect): FhirPatient`
  - `allergyToFhir(allergy: typeof allergies.$inferSelect): FhirAllergyIntolerance` and `allergiesToFhir(rows: (typeof allergies.$inferSelect)[]): FhirAllergyIntolerance[]`
  - `conditionToFhir(diagnosis: typeof diagnoses.$inferSelect): FhirCondition` and `conditionsToFhir(rows: (typeof diagnoses.$inferSelect)[]): FhirCondition[]`
  - `medicationEpisodeToFhir(episode: typeof medicationEpisodes.$inferSelect): FhirMedicationRequest | null` (returns `null` for a non-`active` episode — see Step 9) and `medicationEpisodesToFhir(rows: (typeof medicationEpisodes.$inferSelect)[]): FhirMedicationRequest[]` (filters out the `null`s)
  - `export interface DispenseWithMedicationName { dispense: typeof medicationDispenses.$inferSelect; medicationName: string }`, `medicationDispenseToFhir(row: DispenseWithMedicationName): FhirMedicationDispense`, `medicationDispensesToFhir(rows: DispenseWithMedicationName[]): FhirMedicationDispense[]`
  - `observationsToFhir(patientId: string, orders: PatientLabOrderRow[]): FhirObservation[]` (filters to `orders` whose `.result` is non-null — a `resulted`-status order is expected to have one, but the mapping function trusts the join, not the status field, so a data anomaly can't silently fabricate an Observation)

`PatientLabOrderRow` (already defined in `src/lib/queries/lab-orders.ts` — do not redefine it): `{ id, status, orderedAt, collectedAt, testId, testName, testCode, defaultUnit, referenceRange, result: { value, unit, referenceRange, flag, resultedByName, resultedAt, notes } | null }`.

- [ ] **Step 1: Read the exact source row shapes**

Read `src/db/schema.ts` for the full `patients`, `allergies`, `diagnoses`, `medicationEpisodes`, `medicationDispenses`, `medications` table definitions, and `src/lib/queries/lab-orders.ts` for `PatientLabOrderRow` and `listOrdersForPatient`. Confirm your local checkout matches the field names used throughout this task (they were read directly from this worktree while writing this plan, but re-confirm before writing code against them).

- [ ] **Step 2: Create the shared FHIR type definitions**

Create `src/lib/fhir/types.ts` — not exhaustive FHIR R4, just the shapes this plan's six resources need:

```ts
export interface FhirReference { reference: string }
export interface FhirCoding { system?: string; code: string; display?: string }
export interface FhirCodeableConcept { text?: string; coding?: FhirCoding[] }
```

- [ ] **Step 3: Write the failing test — Patient mapping**

Create `tests/lib/fhir/patient-mapping.test.ts`. Insert a fixture patient directly (matching this codebase's established insert-fixture-then-clean-up-in-afterEach convention from `tests/db/lab-schema.test.ts`/`tests/db/pharmacy-schema.test.ts`), with known values for every field the mapping touches:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients } from '@/db/schema'
import { patientToFhir } from '@/lib/fhir/patient'

const createdIds: string[] = []
afterEach(async () => {
  while (createdIds.length > 0) await getDb().delete(patients).where(eq(patients.id, createdIds.pop()!))
})

describe('patientToFhir', () => {
  it('maps identifier, name, and Tebra-preferred DOB', async () => {
    const [patient] = await getDb().insert(patients).values({
      id: 'RD-FHIR-P1', intakeqClientIdRef: 'test-ref', nameIntakeq: 'Intake Name', nameTebra: 'Tebra Name',
      dobIntakeq: '1985-03-01', dobTebra: '1985-03-02',
    }).returning()
    createdIds.push(patient.id)

    const fhir = patientToFhir(patient)
    expect(fhir.resourceType).toBe('Patient')
    expect(fhir.id).toBe('RD-FHIR-P1')
    expect(fhir.identifier).toEqual([{ value: 'RD-FHIR-P1' }])
    expect(fhir.name).toEqual([{ text: 'Tebra Name' }])
    expect(fhir.birthDate).toBe('1985-03-02') // dobTebra wins over dobIntakeq — Dual-Sourced Fields precedence
  })

  it('falls back to IntakeQ name and DOB when Tebra fields are null', async () => {
    const [patient] = await getDb().insert(patients).values({
      id: 'RD-FHIR-P2', intakeqClientIdRef: 'test-ref-2', nameIntakeq: 'Only Intake Name', dobIntakeq: '1990-06-15',
    }).returning()
    createdIds.push(patient.id)

    const fhir = patientToFhir(patient)
    expect(fhir.name).toEqual([{ text: 'Only Intake Name' }])
    expect(fhir.birthDate).toBe('1990-06-15')
    expect(fhir).not.toHaveProperty('gender') // this app tracks no gender/sex field on `patients` — never fabricate one
  })
})
```

- [ ] **Step 4: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/fhir/patient-mapping.test.ts`
Expected: FAIL — `@/lib/fhir/patient` doesn't exist.

- [ ] **Step 5: Implement `src/lib/fhir/patient.ts`**

```ts
import type { patients } from '@/db/schema'

export interface FhirPatient {
  resourceType: 'Patient'
  id: string
  identifier: { value: string }[]
  name: { text: string }[]
  birthDate: string
}

// No `gender` field: `patients` has no gender/sex column in this app's schema
// today, and FHIR's `gender` is optional -- omitting it is honest, a
// fabricated value would not be.
export function patientToFhir(patient: typeof patients.$inferSelect): FhirPatient {
  return {
    resourceType: 'Patient',
    id: patient.id,
    identifier: [{ value: patient.id }],
    name: [{ text: patient.nameTebra ?? patient.nameIntakeq }],
    birthDate: patient.dobTebra ?? patient.dobIntakeq,
  }
}
```

- [ ] **Step 6: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/fhir/patient-mapping.test.ts`
Expected: PASS.

- [ ] **Step 7: Write the failing test — AllergyIntolerance mapping**

Create `tests/lib/fhir/allergy-mapping.test.ts`, inserting one patient + two allergy fixture rows (one with a `reaction`, one without — the `null`-reaction case is a real branch), asserting:
- `resourceType: 'AllergyIntolerance'`, `id` derived from the row's own `id` (e.g. `` `allergy-${row.id}` ``), `patient.reference === 'Patient/RD-...'`.
- `code` is exactly `{ text: allergen }` — **no `coding` key present at all** (assert `expect(fhir.code.coding).toBeUndefined()` — this is the "no fabricated RxNorm/SNOMED" discipline, pinned as a real assertion, not just a comment).
- `reaction` is always a one-element array carrying `severity` (`allergies.severity` is `notNull`, so this is always derivable); `reaction[0].manifestation` is `[{ text: reaction ?? 'Not specified' }]` when the row's `reaction` column is `null`, and `[{ text: <actual reaction text> }]` otherwise.

- [ ] **Step 8: Run it, confirm it fails, implement `src/lib/fhir/allergy.ts`, run again to confirm it passes**

```ts
import type { allergies } from '@/db/schema'
import type { FhirCodeableConcept, FhirReference } from './types'

export interface FhirAllergyIntolerance {
  resourceType: 'AllergyIntolerance'
  id: string
  patient: FhirReference
  code: FhirCodeableConcept
  reaction: { manifestation: FhirCodeableConcept[]; severity: 'mild' | 'moderate' | 'severe' }[]
}

// `code.text` only -- this app has no coded (RxNorm/SNOMED) allergen data,
// so a `coding` array here would fabricate a terminology binding that was
// never actually made (spec §3).
export function allergyToFhir(allergy: typeof allergies.$inferSelect): FhirAllergyIntolerance {
  return {
    resourceType: 'AllergyIntolerance',
    id: `allergy-${allergy.id}`,
    patient: { reference: `Patient/${allergy.patientId}` },
    code: { text: allergy.allergen },
    reaction: [{ manifestation: [{ text: allergy.reaction ?? 'Not specified' }], severity: allergy.severity }],
  }
}

export function allergiesToFhir(rows: (typeof allergies.$inferSelect)[]): FhirAllergyIntolerance[] {
  return rows.map(allergyToFhir)
}
```

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/fhir/allergy-mapping.test.ts`

- [ ] **Step 9: Write the failing test — Condition mapping**

Create `tests/lib/fhir/condition-mapping.test.ts`, inserting one patient + one `diagnoses` fixture row (`code: 'F32.9'`, `description: 'Major depressive disorder, single episode, unspecified'`, `source: 'tebra'`, `date: '2026-01-15'`), asserting:
- `resourceType: 'Condition'`, `id` derived from the row's own `id`, `subject.reference === 'Patient/RD-...'`.
- `code.text === description`, `code.coding === [{ code: 'F32.9', display: description }]`.
- **`code.coding[0]` has no `system` key** — judgment call, documented here: unlike `labTests.code` (explicitly commented in `src/db/schema.ts` as "reference data only, not verified against the real LOINC database"), `diagnoses.code` carries no such caveat anywhere in this codebase, but it also has no positive confirmation of being verified against a real ICD-10-CM code set (it's seed/demo data shaped like a diagnosis code). Per spec §3's own stated principle — "a FHIR resource claiming a coded system+code when the underlying data was never actually coded against that terminology is worse than honest free text" — this mapping includes the code *value* (useful, low-risk) but never asserts a `system` URI (e.g. `http://hl7.org/fhir/sid/icd-10-cm`), since this app has never verified the code format against a specific terminology version. Assert `expect(fhir.code.coding[0]).not.toHaveProperty('system')`.
- `recordedDate === '2026-01-15'`; a second fixture row with `date: null` maps to `recordedDate: null`.

- [ ] **Step 10: Run it, confirm it fails, implement `src/lib/fhir/condition.ts`, run again to confirm it passes**

```ts
import type { diagnoses } from '@/db/schema'
import type { FhirCodeableConcept, FhirReference } from './types'

export interface FhirCondition {
  resourceType: 'Condition'
  id: string
  subject: FhirReference
  code: FhirCodeableConcept
  recordedDate: string | null
}

export function conditionToFhir(diagnosis: typeof diagnoses.$inferSelect): FhirCondition {
  return {
    resourceType: 'Condition',
    id: `condition-${diagnosis.id}`,
    subject: { reference: `Patient/${diagnosis.patientId}` },
    // `system` deliberately omitted -- see this task's Step 9 comment.
    code: { text: diagnosis.description, coding: [{ code: diagnosis.code, display: diagnosis.description }] },
    recordedDate: diagnosis.date,
  }
}

export function conditionsToFhir(rows: (typeof diagnoses.$inferSelect)[]): FhirCondition[] {
  return rows.map(conditionToFhir)
}
```

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/fhir/condition-mapping.test.ts`

- [ ] **Step 11: Write the failing test — MedicationRequest mapping**

Create `tests/lib/fhir/medication-request-mapping.test.ts`, inserting one patient + two `medicationEpisodes` fixture rows: one `status: 'active'` (`name: 'Sertraline'`, `medicationClass: 'SSRI'`, `dose: '100mg daily'`, `startDate: '2026-01-01'`), one `status: 'inactive'` (`stopDate` set). Assert:
- `medicationEpisodeToFhir(activeRow)` returns a resource: `resourceType: 'MedicationRequest'`, `status: 'active'`, `subject.reference`, `medicationCodeableConcept: { text: 'Sertraline (SSRI)' }` (no `coding` — no RxNorm data), `dosageInstruction: [{ text: '100mg daily' }]`, `authoredOn: '2026-01-01'`.
- `medicationEpisodeToFhir(inactiveRow)` returns `null` — **judgment call, documented here**: spec §3 says "one resource per *active* episode" (its own words); this plan takes that literally rather than reading it as "one resource per episode row regardless of status," so a discontinued medication produces no MedicationRequest. `medicationEpisodesToFhir([activeRow, inactiveRow])` returns an array of length 1.
- A row with `dose: null` omits `dosageInstruction` entirely (not `[{ text: null }]` or `[]` — assert `expect(fhir.dosageInstruction).toBeUndefined()`).

- [ ] **Step 12: Run it, confirm it fails, implement `src/lib/fhir/medication-request.ts`, run again to confirm it passes**

```ts
import type { medicationEpisodes } from '@/db/schema'
import type { FhirReference } from './types'

export interface FhirMedicationRequest {
  resourceType: 'MedicationRequest'
  id: string
  status: 'active'
  subject: FhirReference
  medicationCodeableConcept: { text: string }
  dosageInstruction?: { text: string }[]
  authoredOn: string
}

// Only `status === 'active'` episodes produce a resource -- spec §3 says
// "one resource per active episode." A stopped episode returns `null`.
export function medicationEpisodeToFhir(episode: typeof medicationEpisodes.$inferSelect): FhirMedicationRequest | null {
  if (episode.status !== 'active') return null
  return {
    resourceType: 'MedicationRequest',
    id: `medication-request-${episode.id}`,
    status: 'active',
    subject: { reference: `Patient/${episode.patientId}` },
    medicationCodeableConcept: { text: `${episode.name} (${episode.medicationClass})` },
    ...(episode.dose ? { dosageInstruction: [{ text: episode.dose }] } : {}),
    authoredOn: episode.startDate,
  }
}

export function medicationEpisodesToFhir(rows: (typeof medicationEpisodes.$inferSelect)[]): FhirMedicationRequest[] {
  return rows.map(medicationEpisodeToFhir).filter((r): r is FhirMedicationRequest => r !== null)
}
```

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/fhir/medication-request-mapping.test.ts`

- [ ] **Step 13: Write the failing test — MedicationDispense mapping**

Create `tests/lib/fhir/medication-dispense-mapping.test.ts`, inserting one patient + one `medications` row (`name` must be a collision-safe, test-only value — `medications.name` has a live UNIQUE constraint and the shared dev DB already has seeded rows like `'Lorazepam'` from the Pharmacy plan; use `` `Test Dispense Med ${Date.now()}` ``, matching the exact collision-avoidance pattern already established in `tests/lib/queries/medication-dispenses.test.ts`) + one `medicationDispenses` fixture row (`quantity: 10`). Assert `medicationDispenseToFhir({ dispense, medicationName: med.name })` returns `resourceType: 'MedicationDispense'`, `status: 'completed'`, `subject.reference`, `medicationCodeableConcept: { text: med.name }` (no `coding`), `quantity: { value: 10 }`, `whenHandedOver` equal to the row's `dispensedAt` (as an ISO string).

- [ ] **Step 14: Run it, confirm it fails, implement `src/lib/fhir/medication-dispense.ts`, run again to confirm it passes**

```ts
import type { medicationDispenses } from '@/db/schema'
import type { FhirReference } from './types'

export interface DispenseWithMedicationName {
  dispense: typeof medicationDispenses.$inferSelect
  medicationName: string
}

export interface FhirMedicationDispense {
  resourceType: 'MedicationDispense'
  id: string
  status: 'completed'
  subject: FhirReference
  medicationCodeableConcept: { text: string }
  quantity: { value: number }
  whenHandedOver: string
}

export function medicationDispenseToFhir({ dispense, medicationName }: DispenseWithMedicationName): FhirMedicationDispense {
  return {
    resourceType: 'MedicationDispense',
    id: `medication-dispense-${dispense.id}`,
    status: 'completed',
    subject: { reference: `Patient/${dispense.patientId}` },
    medicationCodeableConcept: { text: medicationName },
    quantity: { value: dispense.quantity },
    whenHandedOver: dispense.dispensedAt.toISOString(),
  }
}

export function medicationDispensesToFhir(rows: DispenseWithMedicationName[]): FhirMedicationDispense[] {
  return rows.map(medicationDispenseToFhir)
}
```

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/fhir/medication-dispense-mapping.test.ts`

- [ ] **Step 15: Write the failing test — Observation mapping**

Create `tests/lib/fhir/observation-mapping.test.ts`. Insert one fixture patient, one `providers` row lookup (`db.select().from(providers).limit(1)`, matching `tests/db/lab-schema.test.ts`'s convention), and three fresh `labTests` rows (a fresh insert per test, same as `tests/db/lab-schema.test.ts` — `labTests` has no unique constraint on `code`, so this is collision-safe against the shared dev DB). Build three real `labOrders` + `labResults` rows (insert-then-cleanup, same convention): one resulted numeric lab (`testCode: 'TSH'`, `result.value: '2.5'`, `result.unit: 'mIU/L'`, `result.flag: 'normal'`), one resulted non-numeric lab (`testCode: 'UDS'`, `result.value: 'Negative'`, `result.unit: null`, `result.flag: 'normal'`), and one still-`ordered` row with no `labResults` row at all. Call the real `listOrdersForPatient(fixturePatientId)` (from `@/lib/queries/lab-orders`, Task 1's existing dependency) to get real, joined `PatientLabOrderRow[]` — not hand-built literals — so this test also catches a real mismatch between the join's actual shape and what the mapping function expects, not just the mapping logic in isolation. Assert:
- `observationsToFhir(fixturePatientId, orders)` returns exactly 2 resources (the still-`ordered` row with `result: null` is dropped — Review Focus #3's sibling case: no result yet, not a mapping bug).
- The numeric one: `valueQuantity: { value: 2.5, unit: 'mIU/L' }`, no `valueString` key.
- The non-numeric one (Review Focus #3): `valueString: 'Negative'`, no `valueQuantity` key, and no `NaN` anywhere in the object (`expect(JSON.stringify(fhir)).not.toContain('NaN')`).
- Both: `code.coding === [{ code: testCode, display: testName }]` (the one exception to "no coding" — carrying the LOINC caveat forward, per Global Constraints) and `interpretation === [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation', code: 'N' }] }]` for `flag: 'normal'` (also assert the mapping for `'abnormal'` → `'A'` and `'critical'` → `'AA'` with one more fixture row each).

- [ ] **Step 16: Run it, confirm it fails, implement `src/lib/fhir/observation.ts`, run again to confirm it passes**

```ts
import type { PatientLabOrderRow } from '@/lib/queries/lab-orders'
import type { FhirCodeableConcept, FhirReference } from './types'

export interface FhirObservation {
  resourceType: 'Observation'
  id: string
  status: 'final'
  subject: FhirReference
  code: FhirCodeableConcept
  valueQuantity?: { value: number; unit: string }
  valueString?: string
  referenceRange?: { text: string }[]
  interpretation: FhirCodeableConcept[]
  effectiveDateTime: string
}

const INTERPRETATION_CODE: Record<'normal' | 'abnormal' | 'critical', string> = { normal: 'N', abnormal: 'A', critical: 'AA' }

// `code.coding` is the one place this plan includes a real `system`+`code`
// pair (spec §3's stated exception) -- `labTests.code` is seeded LOINC-style
// reference data, explicitly commented in src/db/schema.ts as "not verified
// against the real LOINC database." That caveat travels with this mapping:
// it's why `system` is left off the `coding` entry below even here (only the
// bare code+display, not a claimed LOINC system URI) -- carrying the same
// caveat forward rather than upgrading its confidence by asserting a system.
export function observationToFhir(patientId: string, order: PatientLabOrderRow): FhirObservation | null {
  if (!order.result) return null
  const { result } = order
  const numeric = Number(result.value)
  const isNumeric = result.value.trim() !== '' && !Number.isNaN(numeric)

  return {
    resourceType: 'Observation',
    id: `observation-${order.id}`,
    status: 'final',
    subject: { reference: `Patient/${patientId}` },
    code: { text: order.testName, coding: [{ code: order.testCode, display: order.testName }] },
    ...(isNumeric ? { valueQuantity: { value: numeric, unit: result.unit ?? '' } } : { valueString: result.value }),
    ...(result.referenceRange ? { referenceRange: [{ text: result.referenceRange }] } : {}),
    interpretation: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation', code: INTERPRETATION_CODE[result.flag] }] }],
    effectiveDateTime: result.resultedAt.toISOString(),
  }
}

export function observationsToFhir(patientId: string, orders: PatientLabOrderRow[]): FhirObservation[] {
  return orders.map((o) => observationToFhir(patientId, o)).filter((o): o is FhirObservation => o !== null)
}
```

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/fhir/observation-mapping.test.ts`

- [ ] **Step 17: Run all of this task's tests together**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/fhir/patient-mapping.test.ts tests/lib/fhir/allergy-mapping.test.ts tests/lib/fhir/condition-mapping.test.ts tests/lib/fhir/medication-request-mapping.test.ts tests/lib/fhir/medication-dispense-mapping.test.ts tests/lib/fhir/observation-mapping.test.ts`
Expected: PASS.

- [ ] **Step 18: Commit**

```bash
git add src/lib/fhir/types.ts src/lib/fhir/patient.ts src/lib/fhir/allergy.ts src/lib/fhir/condition.ts src/lib/fhir/medication-request.ts src/lib/fhir/medication-dispense.ts src/lib/fhir/observation.ts tests/lib/fhir/patient-mapping.test.ts tests/lib/fhir/allergy-mapping.test.ts tests/lib/fhir/condition-mapping.test.ts tests/lib/fhir/medication-request-mapping.test.ts tests/lib/fhir/medication-dispense-mapping.test.ts tests/lib/fhir/observation-mapping.test.ts
git commit -m "feat: add pure FHIR R4 resource mapping functions for Patient, AllergyIntolerance, Condition, MedicationRequest, MedicationDispense, Observation

"```

---

### Task 2: Bundle assembly + FHIR API routes

**Files:**
- Create: `src/lib/fhir/gather.ts`
- Create: `src/lib/fhir/bundle.ts`
- Create: `src/app/api/patients/[anonId]/fhir/Patient/route.ts`
- Create: `src/app/api/patients/[anonId]/fhir/AllergyIntolerance/route.ts`
- Create: `src/app/api/patients/[anonId]/fhir/Condition/route.ts`
- Create: `src/app/api/patients/[anonId]/fhir/MedicationRequest/route.ts`
- Create: `src/app/api/patients/[anonId]/fhir/MedicationDispense/route.ts`
- Create: `src/app/api/patients/[anonId]/fhir/Observation/route.ts`
- Create: `src/app/api/patients/[anonId]/fhir/Bundle/route.ts`
- Test: `tests/lib/fhir/gather.test.ts`, `tests/api/fhir-export-routes.test.ts`

**Interfaces:**
- Consumes: all six mapping functions + `DispenseWithMedicationName` from Task 1; `patients`, `allergies`, `diagnoses`, `medicationEpisodes`, `medications` from `@/db/schema`; `listDispensesForPatient` from `@/lib/queries/medication-dispenses` (existing); `listOrdersForPatient` from `@/lib/queries/lab-orders` (existing); `requireSession` from `@/lib/auth`; `logAudit` from `@/lib/audit`.
- Produces (consumed by Task 3): `export interface PatientFhirData { patient: typeof patients.$inferSelect; allergyRows: (typeof allergies.$inferSelect)[]; diagnosisRows: (typeof diagnoses.$inferSelect)[]; medicationEpisodeRows: (typeof medicationEpisodes.$inferSelect)[]; dispenseRows: DispenseWithMedicationName[]; labOrderRows: PatientLabOrderRow[] }` and `gatherPatientFhirData(anonId: string): Promise<PatientFhirData | null>` in `src/lib/fhir/gather.ts`; `buildBundle<T>(resources: T[]): FhirBundle<T>` and `buildFullBundle(data: PatientFhirData): FhirBundle<unknown>` in `src/lib/fhir/bundle.ts`.

- [ ] **Step 1: Write the failing test — gather function**

Create `tests/lib/fhir/gather.test.ts`: insert one fixture patient with one allergy row and one diagnosis row (reuse the insert-then-cleanup convention from Task 1's tests). Assert `gatherPatientFhirData(fixtureId)` returns an object whose `patient.id` matches, `allergyRows` contains exactly the one inserted allergy, `diagnosisRows` contains exactly the one inserted diagnosis, and `medicationEpisodeRows`/`dispenseRows`/`labOrderRows` are all empty arrays (not `undefined`, not an error) for this data-free-on-those-tables fixture patient. Assert `gatherPatientFhirData('RD-DOES-NOT-EXIST')` returns `null`.

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/fhir/gather.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `src/lib/fhir/gather.ts`**

One round of already-patient-scoped reads, reusing the existing per-table query functions where they exist (`listDispensesForPatient`, `listOrdersForPatient`) and direct `eq(table.patientId, anonId)` selects for the three tables with no dedicated query function yet (`allergies`, `diagnoses`, `medicationEpisodes` — matching how `getPatientDetail` in `src/lib/queries/patients.ts` already reads these same three tables, but without going through its cache, since this reads only what's needed for export, not the full wide patient-detail object). Build `dispenseRows: DispenseWithMedicationName[]` by joining each `listDispensesForPatient` row to a medication name via one `db.select().from(medications).where(inArray(medications.id, ...))` lookup (a Map keyed by id), not an N+1 query per dispense.

```ts
export async function gatherPatientFhirData(anonId: string): Promise<PatientFhirData | null> {
  const db = getDb()
  const [patient] = await db.select().from(patients).where(eq(patients.id, anonId))
  if (!patient) return null

  const [allergyRows, diagnosisRows, medicationEpisodeRows, dispenses, labOrderRows] = await Promise.all([
    db.select().from(allergies).where(eq(allergies.patientId, anonId)),
    db.select().from(diagnoses).where(eq(diagnoses.patientId, anonId)),
    db.select().from(medicationEpisodes).where(eq(medicationEpisodes.patientId, anonId)),
    listDispensesForPatient(anonId),
    listOrdersForPatient(anonId),
  ])

  const medicationIds = [...new Set(dispenses.map((d) => d.medicationId))]
  const medicationNameById = new Map(
    medicationIds.length > 0
      ? (await db.select({ id: medications.id, name: medications.name }).from(medications).where(inArray(medications.id, medicationIds))).map((m) => [m.id, m.name])
      : []
  )
  const dispenseRows: DispenseWithMedicationName[] = dispenses.map((dispense) => ({
    dispense,
    medicationName: medicationNameById.get(dispense.medicationId) ?? 'Unknown medication',
  }))

  return { patient, allergyRows, diagnosisRows, medicationEpisodeRows, dispenseRows, labOrderRows }
}
```

- [ ] **Step 4: Run the gather test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/fhir/gather.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement `src/lib/fhir/bundle.ts`** (no test of its own — exercised end-to-end by the route tests below)

```ts
export interface FhirBundleEntry<T> { resource: T }
export interface FhirBundle<T> { resourceType: 'Bundle'; type: 'collection'; total: number; entry: FhirBundleEntry<T>[] }

export function buildBundle<T>(resources: T[]): FhirBundle<T> {
  return { resourceType: 'Bundle', type: 'collection', total: resources.length, entry: resources.map((resource) => ({ resource })) }
}

export function buildFullBundle(data: PatientFhirData): FhirBundle<unknown> {
  return buildBundle<unknown>([
    patientToFhir(data.patient),
    ...allergiesToFhir(data.allergyRows),
    ...conditionsToFhir(data.diagnosisRows),
    ...medicationEpisodesToFhir(data.medicationEpisodeRows),
    ...medicationDispensesToFhir(data.dispenseRows),
    ...observationsToFhir(data.patient.id, data.labOrderRows),
  ])
}
```

- [ ] **Step 6: Write the failing tests — API routes**

Create `tests/api/fhir-export-routes.test.ts`. Follow the `vi.mock('@/lib/auth', ...)` session-mocking pattern already established in `tests/api/pharmacy-dispense.test.ts` (mutable `sessionRole` variable, reset in `afterEach`). Insert two fixture patients (`patientA` with one allergy + one diagnosis, `patientB` with a different allergen and diagnosis) plus a third, data-free fixture patient (`patientEmpty`) in a `beforeAll`/cleaned up in `afterAll`. Cover, importing each route's `GET` directly and calling it with a `Request`/`params` the way `tests/api/pharmacy-dispense.test.ts` calls its route:

- **Role/session gating (Review Focus #5):** an unauthenticated session (mock `requireSession` to return a `NextResponse` the way the real one does on no cookie) gets 401 from every one of the 7 `/fhir/...` routes; a `crc` session (in the allowed set) gets 200 from all 7.
- **Two patients' exports never cross (Review Focus #2):** `GET .../fhir/AllergyIntolerance` for `patientA` contains `patientA`'s allergen text and not `patientB`'s; same check for `.../fhir/Condition` with each patient's diagnosis description; same check for `.../fhir/Bundle`.
- **Empty Bundle, not an error (Review Focus #1):** every one of the 5 Bundle-returning routes (`AllergyIntolerance`, `Condition`, `MedicationRequest`, `MedicationDispense`, `Observation`) called for `patientEmpty` returns 200 with `{ resourceType: 'Bundle', type: 'collection', total: 0, entry: [] }`; `.../fhir/Bundle` for `patientEmpty` returns 200 with `total: 1` (the `Patient` resource itself is always present) and every other entry absent.
- **404 for an unknown `anonId`** on every route (not a 500 from `gatherPatientFhirData` returning `null` and a mapping function crashing on `undefined`).
- **`/fhir/Patient` returns a bare resource, not a Bundle:** `body.resourceType === 'Patient'`, no `entry` key.

- [ ] **Step 7: Run them to confirm they fail**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/fhir-export-routes.test.ts`
Expected: FAIL — routes don't exist.

- [ ] **Step 8: Implement the 7 route handlers**

Each follows the same shape (shown for `AllergyIntolerance`; `Condition`/`MedicationRequest`/`MedicationDispense`/`Observation` are the same shape with their own mapping function and row field; `Patient` returns the bare resource, no `buildBundle`; `Bundle` calls `buildFullBundle`):

```ts
// src/app/api/patients/[anonId]/fhir/AllergyIntolerance/route.ts
import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { gatherPatientFhirData } from '@/lib/fhir/gather'
import { allergiesToFhir } from '@/lib/fhir/allergy'
import { buildBundle } from '@/lib/fhir/bundle'

export async function GET(_request: Request, { params }: { params: Promise<{ anonId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['admin', 'pi', 'crc', 'frontdesk'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { anonId } = await params
  const data = await gatherPatientFhirData(anonId)
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await logAudit(session, 'exported FHIR bundle', anonId)
  return NextResponse.json(buildBundle(allergiesToFhir(data.allergyRows)))
}
```

`/fhir/Patient/route.ts` differs only in its body: `return NextResponse.json(patientToFhir(data.patient))` (no `buildBundle`). `/fhir/Bundle/route.ts` differs only in its body: `return NextResponse.json(buildFullBundle(data))`.

- [ ] **Step 9: Run this task's tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/fhir/gather.test.ts tests/api/fhir-export-routes.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/lib/fhir/gather.ts src/lib/fhir/bundle.ts src/app/api/patients/\[anonId\]/fhir tests/lib/fhir/gather.test.ts tests/api/fhir-export-routes.test.ts
git commit -m "feat: add FHIR Bundle assembly and per-resource-type export API routes

"```

---

### Task 3: C-CDA XML export

**Files:**
- Create: `src/lib/fhir/ccda.ts`
- Create: `src/app/api/patients/[anonId]/ccda/route.ts`
- Test: `tests/lib/fhir/ccda-export.test.ts`
- Modify: `tests/api/fhir-export-routes.test.ts` (extend with the C-CDA route's role/session-gating cases — spec §6 names one API test file covering every export route, not a separate file per format)

**Interfaces:**
- Consumes: `PatientFhirData`, `gatherPatientFhirData` (Task 2); `patientToFhir`, `allergiesToFhir`, `conditionsToFhir`, `medicationEpisodesToFhir`, `observationsToFhir` (Task 1 — MedicationDispense is intentionally not in the CCD sections this task covers; see Step 3).
- Produces: `toCcdaXml(data: PatientFhirData): string` in `src/lib/fhir/ccda.ts`, consumed by the new route.

- [ ] **Step 1: Write the failing test — well-formedness**

Create `tests/lib/fhir/ccda-export.test.ts`. Insert a fixture patient with one allergy, one diagnosis, one active medication episode, and one resulted lab (an order + a result row, matching the insert pattern from `tests/db/lab-schema.test.ts`). Build `PatientFhirData` for it via `gatherPatientFhirData`. Assert:

```ts
import { describe, it, expect } from 'vitest'
// ... fixture setup producing `data: PatientFhirData` ...

describe('toCcdaXml', () => {
  it('produces well-formed XML', () => {
    const xml = toCcdaXml(data)
    const parsed = new DOMParser().parseFromString(xml, 'application/xml')
    expect(parsed.getElementsByTagName('parsererror').length).toBe(0)
  })

  it('escapes XML special characters in patient data', () => {
    // reuse `data` but with an allergen/name containing `&`, `<`, or `"` in a
    // second fixture, or mutate the in-memory `data.allergyRows[0].allergen`
    // to `Penicillin & "shellfish" <severe>` before calling toCcdaXml --
    // confirm the result still parses cleanly (Review Focus-adjacent: this
    // plan's own escaping, not spec-named, but the same "don't ship a
    // sometimes-malformed export" discipline the well-formedness test above
    // is there for).
    const xml = toCcdaXml({ ...data, allergyRows: [{ ...data.allergyRows[0], allergen: 'Penicillin & "shellfish" <severe>' }] })
    const parsed = new DOMParser().parseFromString(xml, 'application/xml')
    expect(parsed.getElementsByTagName('parsererror').length).toBe(0)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/fhir/ccda-export.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `src/lib/fhir/ccda.ts`**

A CCD-shaped document: an XML declaration, a `<ClinicalDocument>` root with a header (patient demographics from `patientToFhir(data.patient)`, a document title/date), and one `<section>` per CCD section this app has real data for, per spec §4: Allergies (from `allergiesToFhir`), Medications (from `medicationEpisodesToFhir`), Problems (from `conditionsToFhir`), Results (from `observationsToFhir`). MedicationDispense has no standard CCD section counterpart in this fixed four-section scope (spec §4 names exactly Allergies/Medications/Results/Problems) — dispense history is FHIR-only in this plan; note this in a code comment so a future reader doesn't read the omission as a bug.

Composes the *already-mapped* FHIR objects from Task 1 — reads their fields (e.g. `allergy.code.text`, `allergy.reaction[0].severity`) to build each `<section>`'s narrative text, rather than re-deriving anything from the raw DB rows a second time. This is the mechanism that makes Review Focus #4 (C-CDA/FHIR non-drift) true by construction: there is exactly one place each fact is computed.

```ts
function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

export function toCcdaXml(data: PatientFhirData): string {
  const patient = patientToFhir(data.patient)
  const allergies = allergiesToFhir(data.allergyRows)
  const conditions = conditionsToFhir(data.diagnosisRows)
  const medicationRequests = medicationEpisodesToFhir(data.medicationEpisodeRows)
  const observations = observationsToFhir(data.patient.id, data.labOrderRows)

  // ... build <ClinicalDocument> string, one section per resource array
  // above, escaping every interpolated text value with escapeXml().
}
```

The implementer determines the exact tag names/nesting (this is template-string composition, not a validated-against-a-real-CCD-schema document — spec §4 asks for "the CCD template structure," not conformance to the real HL7 XSD); the two things pinned by this plan are: (1) one `<section>` per resource array above, containing one entry per mapped resource with its already-computed fields, and (2) every interpolated string passed through `escapeXml`.

- [ ] **Step 4: Run the test again to confirm it passes**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/fhir/ccda-export.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Write the failing test — cross-check against the FHIR Bundle (Review Focus #4)**

Add to `tests/lib/fhir/ccda-export.test.ts`:

```ts
it('reflects the same facts as the FHIR Bundle for the same patient', () => {
  const bundle = buildFullBundle(data)
  const xml = toCcdaXml(data)

  const allergyResource = bundle.entry.map((e) => e.resource).find((r): r is FhirAllergyIntolerance => (r as { resourceType: string }).resourceType === 'AllergyIntolerance')
  expect(xml).toContain(allergyResource!.code.text) // the allergen text appears in both formats

  const conditionResource = bundle.entry.map((e) => e.resource).find((r): r is FhirCondition => (r as { resourceType: string }).resourceType === 'Condition')
  expect(xml).toContain(conditionResource!.code.text!) // the diagnosis description appears in both formats

  const observationResource = bundle.entry.map((e) => e.resource).find((r): r is FhirObservation => (r as { resourceType: string }).resourceType === 'Observation')
  const observedValue = 'valueQuantity' in observationResource! ? String(observationResource.valueQuantity!.value) : observationResource!.valueString!
  expect(xml).toContain(observedValue) // the lab value appears in both formats
})
```

- [ ] **Step 6: Run it to confirm it fails, then confirm it passes** (it should pass immediately given Step 3's implementation — if it doesn't, the composition isn't actually sharing Task 1's mapped objects; fix `toCcdaXml` to read from the mapped resources, not re-derive text independently)

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/fhir/ccda-export.test.ts`

- [ ] **Step 7: Write the failing test — C-CDA route**

Extend `tests/api/fhir-export-routes.test.ts` with: unauthenticated → 401 from `GET .../ccda`; unknown `anonId` → 404; `patientA` vs `patientB` → each patient's C-CDA XML contains only its own allergen/diagnosis text (Review Focus #2, applied to this route too); response headers include `'Content-Type': 'application/xml'` (or `'text/xml'`) and a `Content-Disposition: attachment; filename="..."` header (matching the convention read from `src/app/api/workbook/full/route.ts`/`src/app/api/patient-portal/medications-export/route.ts`).

- [ ] **Step 8: Run it to confirm it fails**

Run: `npx dotenv -e .env.local -- npx vitest run tests/api/fhir-export-routes.test.ts`
Expected: FAIL — route doesn't exist.

- [ ] **Step 9: Implement `src/app/api/patients/[anonId]/ccda/route.ts`**

```ts
import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { gatherPatientFhirData } from '@/lib/fhir/gather'
import { toCcdaXml } from '@/lib/fhir/ccda'

export async function GET(_request: Request, { params }: { params: Promise<{ anonId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['admin', 'pi', 'crc', 'frontdesk'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { anonId } = await params
  const data = await gatherPatientFhirData(anonId)
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await logAudit(session, 'exported C-CDA document', anonId)

  return new NextResponse(toCcdaXml(data), {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Disposition': `attachment; filename="${anonId}-ccda.xml"`,
    },
  })
}
```

- [ ] **Step 10: Run this task's tests to confirm they pass**

Run: `npx dotenv -e .env.local -- npx vitest run tests/lib/fhir/ccda-export.test.ts tests/api/fhir-export-routes.test.ts`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/lib/fhir/ccda.ts src/app/api/patients/\[anonId\]/ccda tests/lib/fhir/ccda-export.test.ts tests/api/fhir-export-routes.test.ts
git commit -m "feat: add C-CDA XML export composed from the same FHIR mapping functions

"```

---

### Task 4: Export Record UI on the Medical Record page

**Files:**
- Modify: `src/app/(dashboard)/patients/[anonId]/medical-record/page.tsx`
- Test: none new — UI wiring over already-tested routes, verified per this plan's UI verification discipline.

**Interfaces:**
- Consumes: `GET /api/patients/[anonId]/fhir/Bundle`, `GET /api/patients/[anonId]/ccda` (Task 2, Task 3 — plain browser-navigated `GET`s, not `fetch()`).

- [ ] **Step 1: Read the current state of the Medical Record page and the existing download-link convention**

Read `src/app/(dashboard)/patients/[anonId]/medical-record/page.tsx` in its current, already-merged state (it has Diagnoses, Medication History, Medications Dispensed, Allergies, Insurance, Notes, and a Lab Results section from prior plans in this session's history — read the real file, don't assume a version without them). Read `src/app/(dashboard)/patients/page.tsx`'s `<a href="/api/workbook/export">Download Verification Workbook</a>` and `src/app/patient-portal/(authenticated)/medications/page.tsx`'s equivalent link — this app's established convention for a downloadable export is a plain `<a href="...">` to a `GET` route that sets `Content-Disposition: attachment`, not a client component with `fetch()`+blob handling.

- [ ] **Step 2: Add the "Export Record" action**

In the page's header section (the `<div className={SECTION}>` block with the patient name/avatar, alongside `BackLink`), add two plain links following the exact convention from Step 1:

```tsx
<div className="mt-4 flex items-center gap-3">
  <a href={`/api/patients/${anonId}/fhir/Bundle`} className="rounded-md border border-primary/20 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/5">Download as FHIR (JSON)</a>
  <a href={`/api/patients/${anonId}/ccda`} className="rounded-md border border-primary/20 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/5">Download as C-CDA (XML)</a>
</div>
```

No role conditional needed — spec §7's export role list (`admin`, `pi`, `crc`, `frontdesk`) is exactly the set of roles that can already reach this page via `requireSessionOrRedirect()` with no further per-role gating on the page itself.

- [ ] **Step 3: Verify via a real running dev server, not narration**

Start the dev server, mint two session cookies for two different roles the way `buildSessionCookieValue(role, name)` actually builds them, and for a real seeded patient with actual chart data:
- Real `GET` of the medical-record page, confirm both links render with the correct `href`s.
- Real `curl` (with the session cookie) of `/api/patients/<anonId>/fhir/Bundle` — confirm `Content-Type: application/json`, a `Bundle` body containing that patient's real allergy/diagnosis/medication/lab facts.
- Real `curl` of `/api/patients/<anonId>/ccda` — confirm `Content-Disposition: attachment`, and that the XML body parses and contains the same real facts.
- Real `curl` of both routes for a **second**, different patient — confirm neither response contains the first patient's data (Review Focus #2, exercised here against the real dev server and real seeded rows, not just the unit-test fixtures).
- Real `curl` with no session cookie — confirm 401 on both routes.

Paste the actual commands and actual output in the report.

- [ ] **Step 4: Run the full suite once**

Run: `npx dotenv -e .env.local -- npx vitest run`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/patients/[anonId]/medical-record/page.tsx"
git commit -m "feat: add Export Record action (FHIR JSON / C-CDA XML) to Medical Record page

"```
