# Phase 4 cross-phase schema reconciliation

Written after merging master (Phase 2, real) and phase3-billing's tip (Phase 3, real, pending its own merge) into this branch, per `docs/superpowers/plans/2026-09-17-phase4-reports-documents.md`'s "Cross-phase dependencies" section, which required this reconciliation before Tasks 3, 5/6, 8, 9, 10, 11 run. This note is the concrete delta between what that section assumed and what actually landed — read this instead of re-deriving it from source.

## 1. `appointments` (Phase 2) — real shape differs structurally, not just cosmetically

Assumed: `apptDate` (date) + `apptTime` (text) as two separate fields, `location` (text, nullable).

Real (`src/db/schema.ts`):
```
appointments: id, patientId (text, FK), providerId (integer, FK to providers, NOT nullable),
  startsAt (timestamp), endsAt (timestamp), visitReason (text), status (enum: scheduled|completed|cancelled|no_show),
  notes (text, nullable), createdAt (timestamp)
```
- Single `startsAt`/`endsAt` timestamp pair, not separate date+time-string fields. Any report column showing date/time must derive both from `startsAt` (e.g. `startsAt.toLocaleDateString()` / `.toLocaleTimeString()`).
- No `location` field at all — drop any "Location" column from report tasks rather than rendering a permanent blank.
- `providerId` is NOT nullable (every appointment has a real provider).

## 2. `providers` (Phase 2) — real shape differs

Assumed: `id`, `name`, `specialty` (nullable).

Real: `id`, `name` (text), `credentials` (text, nullable), `specialty` (text, **not** nullable), `colorTag` (text, not nullable — used for calendar color-coding, irrelevant to Reports), `isActive` (boolean, default true), `createdAt`.

## 3. `charges` (Phase 3) — real shape differs structurally

Assumed: `providerId` (integer, nullable FK), `diagnosisCodes: {rank, code, description}[]`, `procedureCodes: {code, modifiers, units, charge, linkedDiagnoses}[]`, `placeOfService`, `visitMode`.

Real:
```
charges: id, patientId (text, FK), providerName (text, free-text — NO providerId/FK to providers at all),
  dateOfService (date), diagnosisCodes: {code, description}[] (no rank), procedureCodes: {code, description, units, chargeCents}[]
  (no modifiers/charge/linkedDiagnoses — money field is chargeCents, integer cents), amountCents (integer),
  status (enum: draft|pending_approval|approved|submitted), notes (nullable), createdAt
```
- **No `placeOfService`/`visitMode` fields exist at all.** Drop those report columns or mark them "Not tracked" rather than joining to something that doesn't exist.
- **Charges are NOT linked to `providers` by FK** — they carry a free-text `providerName` (matching `patients.currentProvider`'s existing convention, chosen deliberately in Phase 3 because Phase 2's `providers` table didn't exist yet when Phase 3's schema was written). Task 3's/Task 9's best-effort Encounters join (Cross-phase dependency item 8) must match `charges.providerName` against `providers.name` as a text comparison, not join on an FK — or simply not attempt a providers↔charges join at all and treat the two as independently reported facts about the same `patientId`/date.
- Money is in cents (`amountCents`, `procedureCodes[].chargeCents`), not the assumed `charge` field name.

## 4. `insuranceClaims` (Phase 3) — real shape differs

Assumed: `providerId` (nullable), `claimAmount` (cents), `serviceDate` + `submittedDate` (two date fields).

Real:
```
insuranceClaims: id, chargeId (integer, FK to charges — NOT nullable), patientId (text, FK), payerName (text),
  billedAmountCents (integer), paidAmountCents (integer, nullable), status (enum: rejected|denied|waiting_adjudication|needs_investigation|paid),
  submittedDate (date — the ONLY date field, no separate serviceDate), notes (nullable), updatedAt
```
- No `providerId` field at all (claims are linked to a charge, not a provider, directly).
- No `serviceDate` — use the linked charge's `dateOfService` if a report needs a "service date" for a claim.
- Money field is `billedAmountCents`/`paidAmountCents`, not `claimAmount`.
- `chargeId` is a required FK (every claim belongs to exactly one charge) — the assumed schema had this as an unlinked, independent table; the real one lets you join claim → charge → patient directly.

## 5. `DataGridToolbar.tsx` (Phase 3) — real prop interface differs from the assumed one

Assumed (Global Constraints' placeholder):
```typescript
interface DataGridToolbarProps {
  searchValue: string; onSearchChange: (v: string) => void; onRefresh: () => void
  filterCount: number; onOpenFilters: () => void
  columns: { key: string; label: string; visible: boolean }[]; onToggleColumn: (key: string) => void
}
```

Real (`src/components/DataGridToolbar.tsx`):
```typescript
export interface DataGridFilterFieldOption { value: string; label: string }
export interface DataGridFilterField { key: string; label: string; options?: DataGridFilterFieldOption[]; inputType?: 'text' | 'date' }
export interface DataGridColumn { key: string; label: string }
export interface DataGridToolbarProps {
  searchValue: string; onSearchChange: (value: string) => void; searchPlaceholder?: string; onRefresh: () => void
  filterFields: DataGridFilterField[]; activeFilters: Record<string, string>; onFilterChange: (key: string, value: string) => void; onClearFilters: () => void
  columns: DataGridColumn[]; visibleColumnKeys: string[]; onToggleColumn: (key: string) => void
}
```
The toolbar owns the filter panel's open/close state and its active-filter-count badge internally — callers don't manage `filterCount`/`onOpenFilters` themselves, they declare `filterFields` (the available filter definitions) and pass back `activeFilters`/`onFilterChange`/`onClearFilters` as a controlled key→value map. Columns are plain `{key, label}` with a separate `visibleColumnKeys: string[]` array, not a combined `{..., visible}` shape.

**Per the plan's own note, this only affects `ReportTable.tsx` (Task 5/6)'s single call site** — write it against the real interface above, not the assumed placeholder. No other file in this plan touches `DataGridToolbar` directly.

**Consequence for Task 4 (`FilterPanel.tsx`): drop it entirely.** The plan's Task 4 builds a separate slide-out `FilterPanel` component (with per-field operators: contains/equals/on/before/after) because it assumed `DataGridToolbar` was a thin toolbar with only a `filterCount`/`onOpenFilters` pair, requiring some *other* component to actually render the filter UI. The real `DataGridToolbar` already renders its own complete "Add a filter" slide-out internally (search-a-field, text/date/select inputs, a "Clear filters" link, an active-count badge) — every Phase 3 table (`ChargesTable`, `InsuranceClaimsTable`, `PatientCollectionsTable`, `PatientStatementsTable`) uses this real panel directly and none of them use, or need, a second filter-UI component. Building `FilterPanel.tsx` anyway would ship two visually and behaviorally different filter UIs side by side in the same app (Billing's tables use one, Reports' tables would use the other) — a real, user-visible inconsistency, not just extra code. Task 4 was implemented against the plan's assumption, caught in review while starting Task 5, and reverted (commit 77ecb5c). `ReportTable.tsx` (Task 5) passes `filterFields`/`activeFilters`/`onFilterChange`/`onClearFilters` straight through to `DataGridToolbar`, exactly like every Phase 3 table does — there is no operator concept (`contains`/`before`/`after`) in the real filter model; a "before/after" need is expressed as two separate filter field keys (see `PatientStatementsTable`'s "Sent after"/"Sent before"), not one field with an operator switch.

## 6. Phase 3's Charges list already links to Charge Capture

Cross-phase dependency item 7 asked Phase 3's (not-yet-written-at-plan-time) Charges list to link each row to `/reports/charge-capture/[chargeId]`. **Phase 3's actual `ChargesTable.tsx` does not do this** — it links each row's patient name to `/billing/charges/[chargeId]`, Phase 3's own read-only Charge Capture detail view (`src/app/(dashboard)/billing/charges/[chargeId]/page.tsx`), built in Phase 3's own Task 5. Phase 4's Task 11 (`/reports/charge-capture/[chargeId]`) would therefore be a near-duplicate of an already-shipped page. **Recommend dropping Phase 4's Task 11 entirely** and, if Reports needs a Charge Capture entry point, linking to Phase 3's existing `/billing/charges/[chargeId]` instead of building a second one.

## Net effect on execution order

Tasks 1, 2, 4, 5, 7, 12, 13, 14 are unaffected by the above (they don't touch the differing fields). Tasks 3, 6, 8, 9, 10 need to be written against the real shapes documented here, not the plan's original assumed code blocks — treat the plan's code blocks for those tasks as a starting sketch, not literal code to transcribe. Task 11 is likely unnecessary (see §6) — flag this to the user before building it.
