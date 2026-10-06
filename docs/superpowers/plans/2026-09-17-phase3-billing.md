# Phase 3: Billing & Financial Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Clinsync a billing/financial subsystem — Charges (with a create flow and a draft→pending_approval→approved→submitted status workflow), Insurance Collections, Patient Collections, Patient Statements (Activity log), an A/R Dashboard, Billing Analytics, a mock-only Virtual Card Payment capture form, and a read-only Charge Capture detail view — adapted from the real Tebra billing module screens to what a trial pre-screening pilot actually needs, per `docs/superpowers/specs/2026-09-17-full-platform-phases-design.md` §3–§6. This phase also builds the first shared enterprise-grade list-view toolbar (`DataGridToolbar.tsx`) and adds this project's first charting dependency (`recharts`), both explicitly assigned to Phase 3 by the architecture spec so later phases can reuse them without re-inventing either.

**Architecture:** Same stack, same security patterns as the existing prototype and as Phase 1 (Next.js App Router Server Components + shared query functions, Drizzle/Neon, Upstash cache, `requireSession`/`requireSessionOrRedirect`, Zod-validated writes, audit logging). New tables extend the existing schema; new pages live inside the existing `(dashboard)` route group so they inherit `TopBanner`/`LeftNav`/`SessionTimeoutWarning` for free. No new external integrations — everything is local Postgres + seeded mock data. Phase 3 owns exactly four new tables (`charges`, `insuranceClaims`, `patientStatements`, `mockPayments`) and touches no table owned by another phase. Charges reference `patients` by id and store the servicing clinician as a free-text `providerName` column (matching the existing `patients.currentProvider` free-text convention) rather than a foreign key to a `providers` table — Phase 2 owns `providers` and hasn't built it yet at the point this plan is written; Phase 3 must not create a dependency on a table another phase owns. If Phase 2 lands first, a later phase may backfill `providerName` into a real FK — that decision belongs to whichever phase does it, not this one.

**Tech Stack:** Next.js 16 (App Router, TypeScript), Drizzle ORM + Neon Postgres, Upstash Redis, Tailwind v4 + shadcn/ui, Vitest, `recharts` (new dependency, added by Task 1).

**Spec:** `docs/superpowers/specs/2026-09-17-full-platform-phases-design.md` (architecture, §3 safety constraints, §4 schema ownership, §5 navigation, §6 shared components), `docs/superpowers/specs/2026-09-17-tebra-intakeq-screenshot-catalog.md` ("Billing/financial" section under Tebra — the real UI this phase adapts).

## Global Constraints

- Every API route calls `requireSession()` and returns its `NextResponse` result unchanged on failure (see `src/lib/auth.ts`, `src/app/api/trials/[trialId]/criteria/route.ts` for the exact pattern).
- Every Server Component page calls `requireSessionOrRedirect()` as its **first statement**, before any data fetch (see the comment in `src/app/(dashboard)/patients/page.tsx` — a prior review proved that relying on the layout's redirect alone leaks PHI into the response body on an unauthenticated request).
- Server Components call shared query functions in `src/lib/queries/*.ts` directly. **Never** `fetch()` the app's own API route from a Server Component (a prior real vulnerability: session-cookie exfiltration via a forged `Host` header).
- Every write validates its request body with a `.strict()` Zod schema (see `criteriaUpdateSchema` in `src/app/api/trials/[trialId]/criteria/route.ts`).
- Every write that changes patient-relevant state calls `logAudit(session, action, patientId)` (`src/lib/audit.ts`) — `session` must be the real, non-null session, never a fallback role.
- Zero decorative icons anywhere. Status/severity is always a colored dot (`<span className="h-2 w-2 rounded-full ...">`, `aria-hidden="true"`) plus a text label — see `src/components/StatusChip.tsx`. This also rules out warning-triangle/checkmark glyphs on the Virtual Card Payment success/failure states and on the mock-payment safety banner — use bold text and a colored background/border instead, never a symbol glyph.
- Design tokens only: `bg-primary`, `bg-accent`, `text-accent-foreground`, `bg-card`, `border-border`, `bg-muted`, `text-muted-foreground`, `bg-secondary`, and the chart tokens `--chart-1` through `--chart-5` (already defined in `src/app/globals.css`, unused until this phase) from `src/app/globals.css`. Never a hardcoded Tailwind color class (`bg-slate-*`, `text-green-700`, etc.) and never a hardcoded hex/rgb string in a `recharts` `fill`/`stroke` prop — pass `"var(--chart-1)"` etc.
- Section/column headers use the established convention: `text-xs font-semibold uppercase tracking-wide text-muted-foreground`.
- Zebra striping on every list/table: `i % 2 === 1 ? 'bg-muted/40' : ''`.
- At most one coral (`bg-accent`) primary-action button per screen.
- No glassmorphism, gradient/shiny buttons, bento grids, or floating/breathing animations — subtle hover/transition-colors utilities only, consistent with what's already in the codebase.
- Empty states are plain, factual text in the interface's voice ("No records found.", not an illustration).
- `npm test` and `npm run build` must be clean after every task. Nothing in this plan is pushed to git or deployed until the whole plan's Final QA pass (Task 13) is green — test locally throughout.

### Mock-payment safety rule (binding, from architecture spec §3 — read this before Task 11)

Virtual Card Payment is **mock-only** and must never be built, extended, or "improved" into anything resembling real payment processing:

- It **never** integrates a real payment processor (no Stripe/Square/etc. SDK, no outbound network call to any payment gateway).
- It **never** stores a full card number (PAN) or CVC anywhere — not in the database, not in a log line, not in an audit-log `details` string. The `mockPayments` table has no column capable of holding either; only `cardLast4` (4 digits) is persisted.
- Its only validation is a fake, purely arithmetic Luhn checksum run against the card-number string the user typed: a number that passes Luhn yields a `success` result row; a number that fails yields a `failed` result row. This is explicitly **not** a real card validity, funds, or fraud check of any kind.
- Every screen that renders this form must show a visible, unmissable, non-dismissable label stating this is a demo/simulated payment that processes no real transaction — see Task 11 Step 3's exact copy. This label must never be removed, hidden behind a tooltip, or made optional in any later phase.
- Nothing in this phase adds a "real payments" mode, a config flag to switch processors, or any TODO suggesting a future real integration — the mock nature is permanent product behavior for this pilot, not a placeholder for a future build-out.

---

### Task 1: Shared infrastructure — `DataGridToolbar.tsx` and the `recharts` dependency

Both pieces of infrastructure are called out together in the architecture spec §6 as "introduced ahead of need": Phase 3 is the first phase whose list views (Charges, Insurance Collections, Patient Collections, Patient Statements) need a real, reusable data-grid toolbar, and the first phase whose dashboards (A/R Dashboard, Billing Analytics) need a chart. Building both now, before any billing page consumes them, means every later task in this plan (and any later phase's list views) has a stable, already-tested contract to build against instead of duplicating toolbar or charting code per page.

**Files:**
- Modify: `package.json`, `package-lock.json` (add `recharts`)
- Create: `src/components/DataGridToolbar.tsx`
- Test: `tests/components/DataGridToolbar.test.tsx`

**Interfaces:**
- Produces: `DataGridToolbar`, `DataGridFilterField`, `DataGridFilterFieldOption`, `DataGridColumn` (exported types), all consumed by every list-view client component in Tasks 4, 6, 7, 8 of this plan (and available to any later phase's list view).
- Produces: `recharts` as an installed dependency, consumed by Tasks 9 and 10.

- [ ] **Step 1: Install `recharts`**

Run: `npm install recharts@^2` (React 19 compatible per the architecture spec's own note). Confirm `package.json`'s `dependencies` gained a `recharts` entry and `package-lock.json` updated.

- [ ] **Step 2: `src/components/DataGridToolbar.tsx`**

A controlled component: it owns no data of its own (search value, active filters, and visible columns all live in the parent list-view component per Task 4/6/7/8's pattern), only the open/closed state of its two slide-out panels. This keeps it reusable across pages with entirely different filter fields and columns without the toolbar needing to know anything about billing, patients, or any other domain concept.

```typescript
'use client'
import { useMemo, useState } from 'react'

export interface DataGridFilterFieldOption {
  value: string
  label: string
}

export interface DataGridFilterField {
  key: string
  label: string
  /** Omit for a free-text filter input; provide for a fixed-choice select. */
  options?: DataGridFilterFieldOption[]
  /** Native input type for a free-text filter (ignored when `options` is set). Defaults to 'text'. */
  inputType?: 'text' | 'date'
}

export interface DataGridColumn {
  key: string
  label: string
}

export interface DataGridToolbarProps {
  searchValue: string
  onSearchChange: (value: string) => void
  searchPlaceholder?: string
  onRefresh: () => void
  filterFields: DataGridFilterField[]
  activeFilters: Record<string, string>
  onFilterChange: (key: string, value: string) => void
  onClearFilters: () => void
  columns: DataGridColumn[]
  visibleColumnKeys: string[]
  onToggleColumn: (key: string) => void
}

/**
 * Shared enterprise-grade list-view toolbar (search, refresh, filter with a
 * searchable "Add a filter" slide-out panel and an active-filter-count badge,
 * and a Columns visibility checklist). Modeled on the toolbar pattern seen
 * across Tebra's Subscription Management data-grid and Reports module
 * (docs/superpowers/specs/2026-09-17-tebra-intakeq-screenshot-catalog.md).
 * Deliberately excludes a density picker, column pinning, and drag-and-drop
 * column reorder — see architecture spec §6: those are enterprise-scale
 * controls that add real complexity for zero benefit at Clinsync's actual
 * data scale (dozens of records, not 300k+).
 */
export function DataGridToolbar({
  searchValue,
  onSearchChange,
  searchPlaceholder = 'Search...',
  onRefresh,
  filterFields,
  activeFilters,
  onFilterChange,
  onClearFilters,
  columns,
  visibleColumnKeys,
  onToggleColumn,
}: DataGridToolbarProps) {
  const [filterPanelOpen, setFilterPanelOpen] = useState(false)
  const [columnsPanelOpen, setColumnsPanelOpen] = useState(false)
  const [fieldSearch, setFieldSearch] = useState('')

  const activeFilterCount = Object.values(activeFilters).filter((v) => v && v.length > 0).length

  const visibleFilterFields = useMemo(
    () => filterFields.filter((f) => f.label.toLowerCase().includes(fieldSearch.toLowerCase())),
    [filterFields, fieldSearch],
  )

  return (
    <div className="relative mb-4 flex flex-wrap items-center gap-2">
      <input
        type="text"
        value={searchValue}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder={searchPlaceholder}
        aria-label="Search"
        className="w-64 rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground"
      />

      <button
        type="button"
        onClick={onRefresh}
        className="rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-secondary"
      >
        Refresh
      </button>

      <div className="relative">
        <button
          type="button"
          onClick={() => {
            setFilterPanelOpen((v) => !v)
            setColumnsPanelOpen(false)
          }}
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-secondary"
        >
          Filter
          {activeFilterCount > 0 && (
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-xs font-semibold text-accent-foreground">
              {activeFilterCount}
            </span>
          )}
        </button>
        {filterPanelOpen && (
          <div className="absolute right-0 top-full z-20 mt-2 w-80 rounded-lg border border-border bg-card p-4 shadow-lg">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Add a filter</h3>
              {activeFilterCount > 0 && (
                <button type="button" onClick={onClearFilters} className="text-xs font-medium text-primary hover:underline">
                  Clear filters
                </button>
              )}
            </div>
            <input
              type="text"
              value={fieldSearch}
              onChange={(e) => setFieldSearch(e.target.value)}
              placeholder="Search fields..."
              aria-label="Search filter fields"
              className="mb-3 w-full rounded-md border border-border px-2 py-1.5 text-sm"
            />
            <div className="max-h-72 space-y-3 overflow-auto">
              {visibleFilterFields.map((field) => (
                <div key={field.key}>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">{field.label}</label>
                  {field.options ? (
                    <select
                      value={activeFilters[field.key] ?? ''}
                      onChange={(e) => onFilterChange(field.key, e.target.value)}
                      className="w-full rounded-md border border-border px-2 py-1.5 text-sm"
                    >
                      <option value="">All</option>
                      {field.options.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={field.inputType ?? 'text'}
                      value={activeFilters[field.key] ?? ''}
                      onChange={(e) => onFilterChange(field.key, e.target.value)}
                      className="w-full rounded-md border border-border px-2 py-1.5 text-sm"
                    />
                  )}
                </div>
              ))}
              {visibleFilterFields.length === 0 && <p className="text-sm text-muted-foreground">No matching fields.</p>}
            </div>
          </div>
        )}
      </div>

      <div className="relative">
        <button
          type="button"
          onClick={() => {
            setColumnsPanelOpen((v) => !v)
            setFilterPanelOpen(false)
          }}
          className="rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-secondary"
        >
          Columns
        </button>
        {columnsPanelOpen && (
          <div className="absolute right-0 top-full z-20 mt-2 w-56 rounded-lg border border-border bg-card p-3 shadow-lg">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Show columns</h3>
            <div className="space-y-1.5">
              {columns.map((col) => (
                <label key={col.key} className="flex items-center gap-2 text-sm text-foreground">
                  <input type="checkbox" checked={visibleColumnKeys.includes(col.key)} onChange={() => onToggleColumn(col.key)} />
                  {col.label}
                </label>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Test**

`tests/components/DataGridToolbar.test.tsx`:
```typescript
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DataGridToolbar } from '@/components/DataGridToolbar'

const filterFields = [
  { key: 'status', label: 'Status', options: [{ value: 'draft', label: 'Draft' }] },
  { key: 'provider', label: 'Provider' },
]
const columns = [{ key: 'patient', label: 'Patient' }, { key: 'amount', label: 'Amount' }]

describe('DataGridToolbar', () => {
  it('calls onSearchChange as the user types', () => {
    const onSearchChange = vi.fn()
    render(
      <DataGridToolbar
        searchValue="" onSearchChange={onSearchChange} onRefresh={() => {}}
        filterFields={[]} activeFilters={{}} onFilterChange={() => {}} onClearFilters={() => {}}
        columns={columns} visibleColumnKeys={['patient', 'amount']} onToggleColumn={() => {}}
      />,
    )
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'RD-0001' } })
    expect(onSearchChange).toHaveBeenCalledWith('RD-0001')
  })

  it('shows the active-filter-count badge only when a filter is set', () => {
    const { rerender } = render(
      <DataGridToolbar
        searchValue="" onSearchChange={() => {}} onRefresh={() => {}}
        filterFields={filterFields} activeFilters={{}} onFilterChange={() => {}} onClearFilters={() => {}}
        columns={columns} visibleColumnKeys={['patient', 'amount']} onToggleColumn={() => {}}
      />,
    )
    expect(screen.queryByText('1')).not.toBeInTheDocument()
    rerender(
      <DataGridToolbar
        searchValue="" onSearchChange={() => {}} onRefresh={() => {}}
        filterFields={filterFields} activeFilters={{ status: 'draft' }} onFilterChange={() => {}} onClearFilters={() => {}}
        columns={columns} visibleColumnKeys={['patient', 'amount']} onToggleColumn={() => {}}
      />,
    )
    expect(screen.getByText('1')).toBeInTheDocument()
  })

  it('opens the filter panel and lets the user pick a filterable field, and toggles a column', () => {
    const onToggleColumn = vi.fn()
    render(
      <DataGridToolbar
        searchValue="" onSearchChange={() => {}} onRefresh={() => {}}
        filterFields={filterFields} activeFilters={{}} onFilterChange={() => {}} onClearFilters={() => {}}
        columns={columns} visibleColumnKeys={['patient']} onToggleColumn={onToggleColumn}
      />,
    )
    fireEvent.click(screen.getByText('Filter'))
    expect(screen.getByText('Add a filter')).toBeInTheDocument()
    expect(screen.getByText('Provider')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Columns'))
    fireEvent.click(screen.getByLabelText('Amount'))
    expect(onToggleColumn).toHaveBeenCalledWith('amount')
  })
})
```

Note: the `<label>` wrapping each column checkbox makes `getByLabelText('Amount')` resolve to that checkbox — matches the accessible-name-from-wrapping-label pattern already relied on elsewhere in this codebase's tests.

- [ ] **Step 4: Run the suite and commit**

Run: `npm test` and `npm run build` — both must be clean.

```bash
git add package.json package-lock.json src/components/DataGridToolbar.tsx tests/components/DataGridToolbar.test.tsx
git commit -m "feat: add shared DataGridToolbar component and recharts dependency"
```

---

### Task 2: Schema + seed data

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/seed.ts`
- Test: `tests/db/seed.test.ts` (existing file — extend, don't replace)

**Interfaces:**
- Produces: `charges` (+ `chargeStatusEnum`), `insuranceClaims` (+ `insuranceClaimStatusEnum`), `patientStatements` (+ `statementDeliveryMethodEnum`, `statementTypeEnum`, `statementDeliveryStatusEnum`), `mockPayments` (+ `mockPaymentResultEnum`) tables, all exported from `src/db/schema.ts`, consumed by every later task in this plan.

- [ ] **Step 1: Add the new tables to the schema**

Add to `src/db/schema.ts`, after the existing `users` table:

```typescript
export const chargeStatusEnum = pgEnum('charge_status', ['draft', 'pending_approval', 'approved', 'submitted'])
export const insuranceClaimStatusEnum = pgEnum('insurance_claim_status', [
  'rejected', 'denied', 'waiting_adjudication', 'needs_investigation', 'paid',
])
export const statementDeliveryMethodEnum = pgEnum('statement_delivery_method', ['email', 'sms', 'paper'])
export const statementTypeEnum = pgEnum('statement_type', ['initial', 'reminder', 'final_notice'])
export const statementDeliveryStatusEnum = pgEnum('statement_delivery_status', ['delivered', 'failed'])
export const mockPaymentResultEnum = pgEnum('mock_payment_result', ['success', 'failed'])

export const charges = pgTable('charges', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  // Free-text clinician name, matching the existing patients.currentProvider
  // convention -- Phase 2 owns a real `providers` table and hasn't built it
  // yet as of this plan; Phase 3 must not create a dependency on another
  // phase's not-yet-existing schema.
  providerName: text('provider_name').notNull(),
  dateOfService: date('date_of_service').notNull(),
  diagnosisCodes: jsonb('diagnosis_codes').$type<{ code: string; description: string }[]>().notNull(),
  procedureCodes: jsonb('procedure_codes').$type<
    { code: string; description: string; units: number; chargeCents: number }[]
  >().notNull(),
  amountCents: integer('amount_cents').notNull(),
  status: chargeStatusEnum('status').default('draft').notNull(),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export const insuranceClaims = pgTable('insurance_claims', {
  id: serial('id').primaryKey(),
  chargeId: integer('charge_id').notNull().references(() => charges.id),
  patientId: text('patient_id').notNull().references(() => patients.id),
  payerName: text('payer_name').notNull(),
  billedAmountCents: integer('billed_amount_cents').notNull(),
  paidAmountCents: integer('paid_amount_cents'),
  status: insuranceClaimStatusEnum('status').notNull(),
  submittedDate: date('submitted_date').notNull(),
  notes: text('notes'),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export const patientStatements = pgTable('patient_statements', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  amountCents: integer('amount_cents').notNull(),
  deliveryMethod: statementDeliveryMethodEnum('delivery_method').notNull(),
  type: statementTypeEnum('type').notNull(),
  deliveryStatus: statementDeliveryStatusEnum('delivery_status').notNull(),
  sentDate: timestamp('sent_date').defaultNow().notNull(),
})

// SAFETY (see Global Constraints "Mock-payment safety rule"): this table
// stores only the last 4 digits of a card number and never a full PAN or a
// CVC -- there is no column here capable of holding either. `result` is
// decided purely by a fake Luhn-checksum pass/fail, never a real payment
// processor response.
export const mockPayments = pgTable('mock_payments', {
  id: serial('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => patients.id),
  chargeId: integer('charge_id').references(() => charges.id),
  amountCents: integer('amount_cents').notNull(),
  cardLast4: text('card_last4').notNull(),
  expMonth: integer('exp_month').notNull(),
  expYear: integer('exp_year').notNull(),
  result: mockPaymentResultEnum('result').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})
```

- [ ] **Step 2: Push the schema**

Run: `npm run db:push` (applies the new tables to the linked Neon database; confirm it reports the 4 new tables and 6 new enums with no errors).

- [ ] **Step 3: Extend `clearExistingData()` in `src/db/seed.ts` first**

The existing `clearExistingData()` deletes `patients` unconditionally. Once `charges`/`insuranceClaims`/`patientStatements`/`mockPayments` reference `patients.id` with a `NOT NULL` FK and no cascade, re-running `seed()` (as `tests/db/seed.test.ts` already does in `beforeAll`) will fail with a foreign-key violation the moment any billing row exists, because Postgres refuses to delete a referenced `patients` row. Delete the new tables first, children before parents, exactly like the existing rows in this function:

```typescript
import { getDb } from './client'
import {
  trials,
  patients,
  diagnoses,
  medicationEpisodes,
  patientTrialScreenings,
  screeningCriteriaResults,
  identityMatches,
  users,
  charges,
  insuranceClaims,
  patientStatements,
  mockPayments,
} from './schema'
```

```typescript
async function clearExistingData() {
  const db = getDb()
  // Delete in FK-safe order (children before parents) so seed() is safely re-runnable
  // against the live database without unique-constraint violations.
  await db.delete(mockPayments)
  await db.delete(patientStatements)
  await db.delete(insuranceClaims)
  await db.delete(charges)
  await db.delete(screeningCriteriaResults)
  await db.delete(patientTrialScreenings)
  await db.delete(medicationEpisodes)
  await db.delete(diagnoses)
  await db.delete(identityMatches)
  await db.delete(patients)
  await db.delete(users)
  await db.delete(trials)
}
```

- [ ] **Step 4: Seed realistic billing data**

Add near the end of `seed.ts`, after `seedFillerPatients()` is called and before the `identityMatches` insert (order doesn't matter functionally, but keeping billing data as its own block keeps the file readable). All dates are relative to the demo "today" of **2026-09-17** and are chosen to land in every A/R aging bucket (0-30/31-60/61-90/91-120/121+) so the A/R Dashboard's chart is never empty. Reuses `RD-0001`–`RD-0006` (the hero patients) so the seeded billing rows line up with patients that already have rich chart/screening data in the demo.

```typescript
async function seedBilling() {
  const db = getDb()

  const chargeRows = await db.insert(charges).values([
    // Workflow-state charges (not yet submitted -- excluded from A/R).
    {
      patientId: 'RD-0001', providerName: 'Dr. R. Kunam', dateOfService: '2026-09-14', status: 'draft',
      diagnosisCodes: [{ code: 'F33.1', description: 'Major depressive disorder, recurrent, moderate' }],
      procedureCodes: [{ code: '90837', description: 'Psychotherapy, 60 minutes', units: 1, chargeCents: 15000 }],
      amountCents: 15000,
    },
    {
      patientId: 'RD-0002', providerName: 'Dr. R. Kunam', dateOfService: '2026-09-12', status: 'pending_approval',
      diagnosisCodes: [{ code: 'F32.1', description: 'Major depressive disorder, single episode, moderate' }],
      procedureCodes: [{ code: '99214', description: 'Office visit, established patient, moderate complexity', units: 1, chargeCents: 20000 }],
      amountCents: 20000,
    },
    {
      patientId: 'RD-0003', providerName: 'Dr. R. Kunam', dateOfService: '2026-09-10', status: 'pending_approval',
      diagnosisCodes: [{ code: 'F32.1', description: 'Major depressive disorder, single episode, moderate' }],
      procedureCodes: [{ code: '99213', description: 'Office visit, established patient, low complexity', units: 1, chargeCents: 12000 }],
      amountCents: 12000,
    },
    {
      patientId: 'RD-0004', providerName: 'Dr. R. Kunam', dateOfService: '2026-09-08', status: 'approved',
      diagnosisCodes: [{ code: 'F90.2', description: 'Attention-deficit hyperactivity disorder, combined type' }],
      procedureCodes: [{ code: '99214', description: 'Office visit, established patient, moderate complexity', units: 1, chargeCents: 18000 }],
      amountCents: 18000,
    },
    {
      patientId: 'RD-0005', providerName: 'Dr. R. Kunam', dateOfService: '2026-09-06', status: 'approved',
      diagnosisCodes: [{ code: 'F90.2', description: 'Attention-deficit hyperactivity disorder, combined type' }],
      procedureCodes: [{ code: '99215', description: 'Office visit, established patient, high complexity', units: 1, chargeCents: 22000 }],
      amountCents: 22000,
    },
    // Submitted charges -- these are what the A/R Dashboard and Patient
    // Collections aggregate over. One per aging bucket, plus a second
    // 0-30 charge (RD-0005) used to demonstrate an overpayment/unapplied
    // amount via a mock payment in the block below.
    {
      patientId: 'RD-0001', providerName: 'Dr. R. Kunam', dateOfService: '2026-09-05', status: 'submitted', // 12 days -> 0-30
      diagnosisCodes: [{ code: 'F33.1', description: 'Major depressive disorder, recurrent, moderate' }],
      procedureCodes: [{ code: '90837', description: 'Psychotherapy, 60 minutes', units: 1, chargeCents: 15000 }],
      amountCents: 15000,
    },
    {
      patientId: 'RD-0002', providerName: 'Dr. R. Kunam', dateOfService: '2026-08-10', status: 'submitted', // 38 days -> 31-60
      diagnosisCodes: [{ code: 'F32.1', description: 'Major depressive disorder, single episode, moderate' }],
      procedureCodes: [{ code: '99214', description: 'Office visit, established patient, moderate complexity', units: 1, chargeCents: 20000 }],
      amountCents: 20000,
    },
    {
      patientId: 'RD-0003', providerName: 'Dr. R. Kunam', dateOfService: '2026-07-05', status: 'submitted', // 74 days -> 61-90
      diagnosisCodes: [{ code: 'F32.1', description: 'Major depressive disorder, single episode, moderate' }],
      procedureCodes: [{ code: '99213', description: 'Office visit, established patient, low complexity', units: 1, chargeCents: 12500 }],
      amountCents: 12500,
    },
    {
      patientId: 'RD-0006', providerName: 'Dr. R. Kunam', dateOfService: '2026-05-25', status: 'submitted', // 115 days -> 91-120
      diagnosisCodes: [{ code: 'F33.1', description: 'Major depressive disorder, recurrent, moderate' }],
      procedureCodes: [{ code: '90837', description: 'Psychotherapy, 60 minutes', units: 2, chargeCents: 30000 }],
      amountCents: 30000,
    },
    {
      patientId: 'RD-0004', providerName: 'Dr. R. Kunam', dateOfService: '2026-03-01', status: 'submitted', // 200 days -> 121+
      diagnosisCodes: [{ code: 'F90.2', description: 'Attention-deficit hyperactivity disorder, combined type' }],
      procedureCodes: [{ code: '99214', description: 'Office visit, established patient, moderate complexity', units: 1, chargeCents: 9000 }],
      amountCents: 9000,
    },
    {
      patientId: 'RD-0005', providerName: 'Dr. R. Kunam', dateOfService: '2026-09-01', status: 'submitted', // 16 days -> 0-30
      diagnosisCodes: [{ code: 'F90.2', description: 'Attention-deficit hyperactivity disorder, combined type' }],
      procedureCodes: [{ code: '99215', description: 'Office visit, established patient, high complexity', units: 1, chargeCents: 17500 }],
      amountCents: 17500,
    },
  ]).returning()

  const byDos = (dos: string) => chargeRows.find((c) => c.dateOfService === dos)!
  const chargeRd1Submitted = byDos('2026-09-05')
  const chargeRd2Submitted = byDos('2026-08-10')
  const chargeRd3Submitted = byDos('2026-07-05')
  const chargeRd6Submitted = byDos('2026-05-25')
  const chargeRd4Submitted = byDos('2026-03-01')
  const chargeRd5Submitted = byDos('2026-09-01')

  await db.insert(insuranceClaims).values([
    { chargeId: chargeRd1Submitted.id, patientId: 'RD-0001', payerName: 'Blue Shield', billedAmountCents: 15000, paidAmountCents: 15000, status: 'paid', submittedDate: '2026-09-05' },
    { chargeId: chargeRd2Submitted.id, patientId: 'RD-0002', payerName: 'Aetna', billedAmountCents: 20000, paidAmountCents: null, status: 'waiting_adjudication', submittedDate: '2026-08-10' },
    { chargeId: chargeRd3Submitted.id, patientId: 'RD-0003', payerName: 'Cigna', billedAmountCents: 12500, paidAmountCents: 0, status: 'denied', submittedDate: '2026-07-05', notes: 'Missing prior authorization on file.' },
    { chargeId: chargeRd6Submitted.id, patientId: 'RD-0006', payerName: 'United Healthcare', billedAmountCents: 30000, paidAmountCents: null, status: 'needs_investigation', submittedDate: '2026-05-25', notes: 'Payer requesting additional medical records.' },
    { chargeId: chargeRd4Submitted.id, patientId: 'RD-0004', payerName: 'Medicare', billedAmountCents: 9000, paidAmountCents: 0, status: 'rejected', submittedDate: '2026-03-01', notes: 'Invalid procedure code modifier.' },
  ])

  // Two mock payments: one Luhn-valid ("success"), one Luhn-invalid
  // ("failed"). The success payment (RD-0005, $200.00) exceeds its
  // charge's $175.00 balance on purpose, so Patient Collections has a
  // non-zero "unapplied" amount to demonstrate ($25.00).
  await db.insert(mockPayments).values([
    { patientId: 'RD-0005', chargeId: chargeRd5Submitted.id, amountCents: 20000, cardLast4: '4242', expMonth: 12, expYear: 2027, result: 'success', createdAt: new Date('2026-09-02') },
    { patientId: 'RD-0003', chargeId: chargeRd3Submitted.id, amountCents: 12500, cardLast4: '4444', expMonth: 1, expYear: 2028, result: 'failed', createdAt: new Date('2026-07-10') },
  ])

  await db.insert(patientStatements).values([
    { patientId: 'RD-0002', amountCents: 20000, deliveryMethod: 'email', type: 'reminder', deliveryStatus: 'delivered', sentDate: new Date('2026-08-15') },
    { patientId: 'RD-0003', amountCents: 12500, deliveryMethod: 'paper', type: 'initial', deliveryStatus: 'delivered', sentDate: new Date('2026-07-10') },
    { patientId: 'RD-0006', amountCents: 30000, deliveryMethod: 'sms', type: 'final_notice', deliveryStatus: 'failed', sentDate: new Date('2026-08-25') },
    { patientId: 'RD-0004', amountCents: 9000, deliveryMethod: 'email', type: 'reminder', deliveryStatus: 'delivered', sentDate: new Date('2026-09-01') },
  ])
}
```

Then call it from `seed()`, after the `seedFillerPatients()` call:

```typescript
  await seedFillerPatients()
  await seedBilling()
```

- [ ] **Step 5: Re-seed and verify**

Run: `npm run db:seed`. Then run: `npx dotenv -e .env.local -- tsx -e "import { getDb } from './src/db/client'; import { charges, insuranceClaims, patientStatements, mockPayments } from './src/db/schema'; getDb().select().from(charges).then(r => console.log('charges:', r.length)); getDb().select().from(insuranceClaims).then(r => console.log('claims:', r.length)); getDb().select().from(patientStatements).then(r => console.log('statements:', r.length)); getDb().select().from(mockPayments).then(r => console.log('payments:', r.length))"` and confirm 11/5/4/2 respectively.

- [ ] **Step 6: Extend the seed test**

Add to `tests/db/seed.test.ts` (import `charges, insuranceClaims, patientStatements, mockPayments` alongside the existing schema imports):

```typescript
  it('creates charges covering every status in the workflow', async () => {
    const rows = await getDb().select().from(charges)
    expect(rows.length).toBeGreaterThanOrEqual(11)
    const statuses = new Set(rows.map((r) => r.status))
    expect(statuses).toEqual(new Set(['draft', 'pending_approval', 'approved', 'submitted']))
  })

  it('creates insurance claims covering rejected/denied/waiting/needs-investigation/paid', async () => {
    const rows = await getDb().select().from(insuranceClaims)
    const statuses = new Set(rows.map((r) => r.status))
    expect(statuses).toEqual(new Set(['rejected', 'denied', 'waiting_adjudication', 'needs_investigation', 'paid']))
  })

  it('creates patient statements and mock payments', async () => {
    const statements = await getDb().select().from(patientStatements)
    const payments = await getDb().select().from(mockPayments)
    expect(statements.length).toBeGreaterThanOrEqual(4)
    expect(payments.length).toBeGreaterThanOrEqual(2)
    expect(payments.some((p) => p.result === 'success')).toBe(true)
    expect(payments.some((p) => p.result === 'failed')).toBe(true)
  })
```

- [ ] **Step 7: Run the suite and commit**

Run: `npm test` and `npm run build` — both must be clean.

```bash
git add src/db/schema.ts src/db/seed.ts tests/db/seed.test.ts
git commit -m "feat: add charges, insurance claims, patient statements, and mock payments tables with seed data"
```

---

### Task 3: Shared query functions, cache keys, and the mock-payment Luhn library

**Files:**
- Create: `src/lib/queries/charges.ts`
- Create: `src/lib/queries/insurance-claims.ts`
- Create: `src/lib/queries/patient-statements.ts`
- Create: `src/lib/queries/mock-payments.ts`
- Create: `src/lib/queries/patient-collections.ts`
- Create: `src/lib/queries/ar-dashboard.ts`
- Create: `src/lib/queries/billing-analytics.ts`
- Create: `src/lib/mock-payment.ts`
- Create: `src/lib/format.ts`
- Modify: `src/lib/cache.ts`
- Test: `tests/lib/mock-payment.test.ts`, `tests/lib/queries/ar-dashboard.test.ts`

**Interfaces:**
- Consumes: the 4 new tables from Task 2.
- Produces: `listCharges()`, `getCharge(id)`, `createCharge(input)`, `updateChargeStatus(id, status)`, `listInsuranceClaims()`, `listPatientStatements()`, `createMockPayment(input)`, `listPatientCollections()`, `getArDashboardData()`, `getBillingAnalyticsData()`, `luhnCheck(cardNumber)`, `formatCents(cents)` — all consumed directly by Server Component pages and API routes in Tasks 4–11 (never via `fetch()` from a Server Component).

- [ ] **Step 1: `src/lib/cache.ts` — add cache keys**

Add alongside the existing key helpers:

```typescript
export function chargesListCacheKey(): string {
  return 'charges:list'
}

export function chargeDetailCacheKey(id: number): string {
  return `charges:detail:${id}`
}

export function insuranceClaimsListCacheKey(): string {
  return 'insurance-claims:list'
}

export function patientStatementsListCacheKey(): string {
  return 'patient-statements:list'
}

export function patientCollectionsListCacheKey(): string {
  return 'patient-collections:list'
}

export function arDashboardCacheKey(): string {
  return 'billing:ar-dashboard'
}

export function billingAnalyticsCacheKey(): string {
  return 'billing:analytics'
}
```

- [ ] **Step 2: `src/lib/format.ts`**

```typescript
/** Formats an integer cents amount as US currency, e.g. 17500 -> "$175.00". */
export function formatCents(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}
```

- [ ] **Step 3: `src/lib/mock-payment.ts`**

```typescript
// SAFETY (see the plan's Global Constraints "Mock-payment safety rule"):
// this is a fake, purely arithmetic checksum -- it is NOT a real card
// validity, funds, or fraud check. A number that satisfies the Luhn
// algorithm is treated as "success"; anything else is "failed". No card
// data is ever sent anywhere for real validation.
export function luhnCheck(cardNumber: string): boolean {
  const digits = cardNumber.replace(/\D/g, '')
  if (digits.length < 12) return false

  let sum = 0
  let shouldDouble = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = parseInt(digits[i], 10)
    if (shouldDouble) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    shouldDouble = !shouldDouble
  }
  return sum % 10 === 0
}
```

- [ ] **Step 4: `src/lib/queries/charges.ts`**

```typescript
import { getDb } from '@/db/client'
import { charges, patients, chargeStatusEnum } from '@/db/schema'
import { eq, desc } from 'drizzle-orm'
import { getOrSetCache, invalidateCache, chargesListCacheKey, chargeDetailCacheKey } from '@/lib/cache'

export type ChargeStatus = (typeof chargeStatusEnum.enumValues)[number]

export interface DiagnosisCodeInput { code: string; description: string }
export interface ProcedureCodeInput { code: string; description: string; units: number; chargeCents: number }

export interface CreateChargeInput {
  patientId: string
  providerName: string
  dateOfService: string
  diagnosisCodes: DiagnosisCodeInput[]
  procedureCodes: ProcedureCodeInput[]
  amountCents: number
  notes?: string
}

// Forward-only workflow, with an explicit "send back for rework" step at each
// stage after the first -- matches the real Tebra product's "Pending Charge
// Rework" status bucket without introducing a fifth, separate rework enum
// value (the charge just moves back to `draft`/`pending_approval`).
const ALLOWED_TRANSITIONS: Record<ChargeStatus, ChargeStatus[]> = {
  draft: ['pending_approval'],
  pending_approval: ['approved', 'draft'],
  approved: ['submitted', 'pending_approval'],
  submitted: [],
}

export function isAllowedChargeTransition(from: ChargeStatus, to: ChargeStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to)
}

export async function listCharges() {
  return getOrSetCache(chargesListCacheKey(), 30, async () => {
    const rows = await getDb()
      .select({ charge: charges, patient: patients })
      .from(charges)
      .innerJoin(patients, eq(charges.patientId, patients.id))
      .orderBy(desc(charges.dateOfService))
    return rows.map((r) => ({ ...r.charge, patientName: r.patient.nameTebra ?? r.patient.nameIntakeq }))
  })
}

export async function getCharge(id: number) {
  return getOrSetCache(chargeDetailCacheKey(id), 30, async () => {
    const [row] = await getDb()
      .select({ charge: charges, patient: patients })
      .from(charges)
      .innerJoin(patients, eq(charges.patientId, patients.id))
      .where(eq(charges.id, id))
    if (!row) return null
    return {
      ...row.charge,
      patientName: row.patient.nameTebra ?? row.patient.nameIntakeq,
      patientDob: row.patient.dobTebra ?? row.patient.dobIntakeq,
    }
  })
}

export async function createCharge(input: CreateChargeInput) {
  const [created] = await getDb().insert(charges).values({ ...input, status: 'draft' }).returning()
  await invalidateChargesList()
  return created
}

export async function updateChargeStatus(id: number, status: ChargeStatus) {
  await getDb().update(charges).set({ status }).where(eq(charges.id, id))
  await invalidateChargesList()
  await invalidateCache(chargeDetailCacheKey(id))
}

export async function invalidateChargesList() {
  await invalidateCache(chargesListCacheKey())
}
```

- [ ] **Step 5: `src/lib/queries/insurance-claims.ts`**

```typescript
import { getDb } from '@/db/client'
import { insuranceClaims, charges, patients } from '@/db/schema'
import { eq, desc } from 'drizzle-orm'
import { getOrSetCache, insuranceClaimsListCacheKey } from '@/lib/cache'

export async function listInsuranceClaims() {
  return getOrSetCache(insuranceClaimsListCacheKey(), 30, async () => {
    const rows = await getDb()
      .select({ claim: insuranceClaims, charge: charges, patient: patients })
      .from(insuranceClaims)
      .innerJoin(charges, eq(insuranceClaims.chargeId, charges.id))
      .innerJoin(patients, eq(insuranceClaims.patientId, patients.id))
      .orderBy(desc(insuranceClaims.submittedDate))
    return rows.map((r) => ({
      ...r.claim,
      patientName: r.patient.nameTebra ?? r.patient.nameIntakeq,
      dateOfService: r.charge.dateOfService,
    }))
  })
}
```

- [ ] **Step 6: `src/lib/queries/patient-statements.ts`**

```typescript
import { getDb } from '@/db/client'
import { patientStatements, patients } from '@/db/schema'
import { eq, desc } from 'drizzle-orm'
import { getOrSetCache, patientStatementsListCacheKey } from '@/lib/cache'

export async function listPatientStatements() {
  return getOrSetCache(patientStatementsListCacheKey(), 30, async () => {
    const rows = await getDb()
      .select({ statement: patientStatements, patient: patients })
      .from(patientStatements)
      .innerJoin(patients, eq(patientStatements.patientId, patients.id))
      .orderBy(desc(patientStatements.sentDate))
    // `sentDate` is normalized to an ISO string here (rather than left as the
    // Date object Drizzle returns) so its shape is identical on a cache hit
    // and a cache miss -- getOrSetCache round-trips through Redis as JSON,
    // which silently turns a Date into a string on the way back out, so a
    // consumer doing `<` string comparisons against a raw Date object here
    // would work by accident on a cold cache and break on a warm one.
    return rows.map((r) => ({
      ...r.statement,
      sentDate: r.statement.sentDate.toISOString(),
      patientName: r.patient.nameTebra ?? r.patient.nameIntakeq,
    }))
  })
}
```

- [ ] **Step 7: `src/lib/queries/mock-payments.ts`**

```typescript
import { getDb } from '@/db/client'
import { mockPayments } from '@/db/schema'
import { luhnCheck } from '@/lib/mock-payment'

export interface CreateMockPaymentInput {
  patientId: string
  chargeId: number | null
  amountCents: number
  cardNumber: string
  expMonth: number
  expYear: number
}

// SAFETY: `input.cardNumber` and any CVC the caller collected are used only
// in-memory for the Luhn arithmetic below and are never passed to this
// function's return value or persisted -- only the last 4 digits are
// written to the database. See the plan's Global Constraints "Mock-payment
// safety rule".
export async function createMockPayment(input: CreateMockPaymentInput) {
  const digits = input.cardNumber.replace(/\D/g, '')
  const result = luhnCheck(digits) ? 'success' as const : 'failed' as const
  const [created] = await getDb().insert(mockPayments).values({
    patientId: input.patientId,
    chargeId: input.chargeId,
    amountCents: input.amountCents,
    cardLast4: digits.slice(-4),
    expMonth: input.expMonth,
    expYear: input.expYear,
    result,
  }).returning()
  return created
}
```

- [ ] **Step 8: `src/lib/queries/patient-collections.ts`**

Aggregates, per patient, the outstanding balance and unapplied payment amount across their `submitted` charges — insurance-paid amounts reduce what the patient owes first, then successful mock payments are applied against the remainder; anything paid beyond the remaining balance becomes "unapplied" (e.g. an overpayment). Data scale is small (dozens of patients, per the architecture spec §3) so this is computed in application code after a couple of small queries rather than a single large SQL aggregate — kept simple and readable on purpose.

```typescript
import { getDb } from '@/db/client'
import { charges, insuranceClaims, mockPayments, patients } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { getOrSetCache, patientCollectionsListCacheKey } from '@/lib/cache'

export async function listPatientCollections() {
  return getOrSetCache(patientCollectionsListCacheKey(), 30, async () => {
    const db = getDb()
    const submittedCharges = await db.select().from(charges).where(eq(charges.status, 'submitted'))
    const claims = await db.select().from(insuranceClaims)
    const payments = await db.select().from(mockPayments)
    const allPatients = await db.select().from(patients)

    const byPatient = new Map<string, { balanceCents: number; unappliedCents: number; statementCount: number }>()

    for (const charge of submittedCharges) {
      const insurancePaid = claims
        .filter((c) => c.chargeId === charge.id)
        .reduce((sum, c) => sum + (c.paidAmountCents ?? 0), 0)
      const amountDueFromPatient = Math.max(0, charge.amountCents - insurancePaid)

      const patientPaidRaw = payments
        .filter((p) => p.chargeId === charge.id && p.result === 'success')
        .reduce((sum, p) => sum + p.amountCents, 0)
      const patientPaidApplied = Math.min(patientPaidRaw, amountDueFromPatient)
      const balance = Math.max(0, amountDueFromPatient - patientPaidApplied)
      const unapplied = Math.max(0, patientPaidRaw - patientPaidApplied)

      const existing = byPatient.get(charge.patientId) ?? { balanceCents: 0, unappliedCents: 0, statementCount: 0 }
      byPatient.set(charge.patientId, {
        balanceCents: existing.balanceCents + balance,
        unappliedCents: existing.unappliedCents + unapplied,
        statementCount: existing.statementCount,
      })
    }

    return Array.from(byPatient.entries())
      .filter(([, v]) => v.balanceCents > 0 || v.unappliedCents > 0)
      .map(([patientId, v]) => {
        const patient = allPatients.find((p) => p.id === patientId)
        return {
          patientId,
          patientName: patient ? (patient.nameTebra ?? patient.nameIntakeq) : patientId,
          balanceCents: v.balanceCents,
          unappliedCents: v.unappliedCents,
        }
      })
      .sort((a, b) => b.balanceCents - a.balanceCents)
  })
}
```

- [ ] **Step 9: `src/lib/queries/ar-dashboard.ts`**

```typescript
import { getDb } from '@/db/client'
import { charges, insuranceClaims, mockPayments } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { getOrSetCache, arDashboardCacheKey } from '@/lib/cache'

export interface AgingBucket { label: string; outstandingCents: number }

const BUCKETS = [
  { label: '0-30', min: 0, max: 30 },
  { label: '31-60', min: 31, max: 60 },
  { label: '61-90', min: 61, max: 90 },
  { label: '91-120', min: 91, max: 120 },
  { label: '121+', min: 121, max: Infinity },
]

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24))
}

export async function getArDashboardData(now: Date = new Date()) {
  return getOrSetCache(arDashboardCacheKey(), 15, async () => {
    const db = getDb()
    const submittedCharges = await db.select().from(charges).where(eq(charges.status, 'submitted'))
    const claims = await db.select().from(insuranceClaims)
    const payments = await db.select().from(mockPayments)

    let outstandingCents = 0
    let totalBilledCents = 0
    let totalCollectedCents = 0
    let ageWeightedDaysSum = 0
    let outstandingWeightSum = 0
    const buckets: AgingBucket[] = BUCKETS.map((b) => ({ label: b.label, outstandingCents: 0 }))

    for (const charge of submittedCharges) {
      const insurancePaid = claims
        .filter((c) => c.chargeId === charge.id)
        .reduce((sum, c) => sum + (c.paidAmountCents ?? 0), 0)
      const patientPaid = payments
        .filter((p) => p.chargeId === charge.id && p.result === 'success')
        .reduce((sum, p) => sum + p.amountCents, 0)
      const totalPaid = insurancePaid + Math.min(patientPaid, Math.max(0, charge.amountCents - insurancePaid))
      const outstanding = Math.max(0, charge.amountCents - totalPaid)

      totalBilledCents += charge.amountCents
      totalCollectedCents += Math.min(totalPaid, charge.amountCents)
      outstandingCents += outstanding

      if (outstanding > 0) {
        const age = daysBetween(new Date(charge.dateOfService), now)
        const bucketIndex = BUCKETS.findIndex((b) => age >= b.min && age <= b.max)
        if (bucketIndex >= 0) buckets[bucketIndex].outstandingCents += outstanding
        ageWeightedDaysSum += age * outstanding
        outstandingWeightSum += outstanding
      }
    }

    const grossCollectionRate = totalBilledCents > 0 ? (totalCollectedCents / totalBilledCents) * 100 : 0
    const avgDaysInAr = outstandingWeightSum > 0 ? ageWeightedDaysSum / outstandingWeightSum : 0

    return {
      outstandingArCents: outstandingCents,
      grossCollectionRate,
      avgDaysInAr,
      agingBuckets: buckets,
    }
  })
}
```

- [ ] **Step 10: `src/lib/queries/billing-analytics.ts`**

```typescript
import { getDb } from '@/db/client'
import { charges, insuranceClaims, mockPayments } from '@/db/schema'
import { getOrSetCache, billingAnalyticsCacheKey } from '@/lib/cache'

export interface MonthlyTrendPoint { month: string; grossChargesCents: number; netCollectionsCents: number }

export async function getBillingAnalyticsData() {
  return getOrSetCache(billingAnalyticsCacheKey(), 15, async () => {
    const db = getDb()
    const allCharges = await db.select().from(charges)
    const claims = await db.select().from(insuranceClaims)
    const payments = await db.select().from(mockPayments)

    const submitted = allCharges.filter((c) => c.status === 'submitted')
    const grossChargesCents = submitted.reduce((sum, c) => sum + c.amountCents, 0)
    const netCollectionsCents = submitted.reduce((sum, c) => {
      const insurancePaid = claims.filter((cl) => cl.chargeId === c.id).reduce((s, cl) => s + (cl.paidAmountCents ?? 0), 0)
      const patientPaid = payments.filter((p) => p.chargeId === c.id && p.result === 'success').reduce((s, p) => s + p.amountCents, 0)
      return sum + Math.min(c.amountCents, insurancePaid + Math.min(patientPaid, Math.max(0, c.amountCents - insurancePaid)))
    }, 0)

    const byMonth = new Map<string, { grossChargesCents: number; netCollectionsCents: number }>()
    for (const c of submitted) {
      const month = c.dateOfService.slice(0, 7) // "YYYY-MM"
      const insurancePaid = claims.filter((cl) => cl.chargeId === c.id).reduce((s, cl) => s + (cl.paidAmountCents ?? 0), 0)
      const patientPaid = payments.filter((p) => p.chargeId === c.id && p.result === 'success').reduce((s, p) => s + p.amountCents, 0)
      const collected = Math.min(c.amountCents, insurancePaid + Math.min(patientPaid, Math.max(0, c.amountCents - insurancePaid)))
      const existing = byMonth.get(month) ?? { grossChargesCents: 0, netCollectionsCents: 0 }
      byMonth.set(month, { grossChargesCents: existing.grossChargesCents + c.amountCents, netCollectionsCents: existing.netCollectionsCents + collected })
    }

    const trend: MonthlyTrendPoint[] = Array.from(byMonth.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, v]) => ({ month, ...v }))

    return {
      patientVisits: submitted.length,
      grossChargesCents,
      netCollectionsCents,
      trend,
    }
  })
}
```

- [ ] **Step 11: Tests**

`tests/lib/mock-payment.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { luhnCheck } from '@/lib/mock-payment'

describe('luhnCheck', () => {
  it('accepts a well-known Luhn-valid test card number', () => {
    expect(luhnCheck('4242424242424242')).toBe(true)
  })

  it('rejects a number that fails the Luhn checksum', () => {
    expect(luhnCheck('4242424242424241')).toBe(false)
  })

  it('rejects a too-short number', () => {
    expect(luhnCheck('4242')).toBe(false)
  })

  it('ignores spaces and dashes in the input', () => {
    expect(luhnCheck('4242 4242 4242 4242')).toBe(true)
    expect(luhnCheck('4242-4242-4242-4242')).toBe(true)
  })
})
```

`tests/lib/queries/ar-dashboard.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { getArDashboardData } from '@/lib/queries/ar-dashboard'

describe('getArDashboardData', () => {
  it('returns non-negative KPIs and a 5-bucket aging chart', async () => {
    const data = await getArDashboardData(new Date('2026-09-17'))
    expect(data.outstandingArCents).toBeGreaterThan(0)
    expect(data.grossCollectionRate).toBeGreaterThanOrEqual(0)
    expect(data.grossCollectionRate).toBeLessThanOrEqual(100)
    expect(data.avgDaysInAr).toBeGreaterThan(0)
    expect(data.agingBuckets).toHaveLength(5)
    expect(data.agingBuckets.map((b) => b.label)).toEqual(['0-30', '31-60', '61-90', '91-120', '121+'])
    // The seed data (Task 2) places at least one outstanding charge in
    // every bucket except the fully-insurance-paid RD-0001 charge.
    expect(data.agingBuckets.every((b) => b.outstandingCents >= 0)).toBe(true)
  })
})
```

- [ ] **Step 12: Run the suite and commit**

Run: `npm test` and `npm run build` — both must be clean.

```bash
git add src/lib/queries/charges.ts src/lib/queries/insurance-claims.ts src/lib/queries/patient-statements.ts src/lib/queries/mock-payments.ts src/lib/queries/patient-collections.ts src/lib/queries/ar-dashboard.ts src/lib/queries/billing-analytics.ts src/lib/mock-payment.ts src/lib/format.ts src/lib/cache.ts tests/lib/mock-payment.test.ts tests/lib/queries/ar-dashboard.test.ts
git commit -m "feat: add billing query functions, Luhn-check library, and currency formatter"
```

---

### Task 4: Charges API, list page, New Charge flow, and status workflow

**Files:**
- Create: `src/app/api/charges/route.ts` (GET list, POST create = "+ New Charge")
- Create: `src/app/api/charges/[id]/route.ts` (GET one, PATCH status transition)
- Create: `src/app/(dashboard)/billing/charges/page.tsx`
- Create: `src/components/ChargesTable.tsx` (`'use client'`)
- Create: `src/components/NewChargeModal.tsx` (`'use client'`)
- Test: `tests/api/charges.test.ts`

**Interfaces:**
- Consumes: `listCharges`, `createCharge`, `isAllowedChargeTransition`, `updateChargeStatus` (Task 3), `DataGridToolbar` (Task 1).
- Produces: `/billing/charges` route, linked from `LeftNav` (Task 12). Links to `/billing/charges/[chargeId]` (Task 5, the read-only Charge Capture detail view).

- [ ] **Step 1: API routes**

`src/app/api/charges/route.ts`:
```typescript
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listCharges, createCharge } from '@/lib/queries/charges'

const createChargeSchema = z.object({
  patientId: z.string().min(1),
  providerName: z.string().min(1),
  dateOfService: z.string().min(1),
  diagnosisCodes: z.array(z.object({ code: z.string().min(1), description: z.string().min(1) })).min(1),
  procedureCodes: z.array(z.object({
    code: z.string().min(1), description: z.string().min(1), units: z.number().int().positive(), chargeCents: z.number().int().positive(),
  })).min(1),
  amountCents: z.number().int().positive(),
  notes: z.string().optional(),
}).strict()

export async function GET() {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  return NextResponse.json(await listCharges())
}

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session

  const parsed = createChargeSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid charge payload', details: parsed.error.flatten() }, { status: 400 })

  const created = await createCharge(parsed.data)
  await logAudit(session, 'created charge', parsed.data.patientId)
  return NextResponse.json(created, { status: 201 })
}
```

`src/app/api/charges/[id]/route.ts`:
```typescript
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getCharge, updateChargeStatus, isAllowedChargeTransition, type ChargeStatus } from '@/lib/queries/charges'

const statusUpdateSchema = z.object({
  status: z.enum(['draft', 'pending_approval', 'approved', 'submitted']),
}).strict()

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  const { id } = await params
  const charge = await getCharge(Number(id))
  if (!charge) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(charge)
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  const { id } = await params

  const parsed = statusUpdateSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid status payload', details: parsed.error.flatten() }, { status: 400 })

  const existing = await getCharge(Number(id))
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const nextStatus = parsed.data.status as ChargeStatus
  if (!isAllowedChargeTransition(existing.status, nextStatus)) {
    return NextResponse.json({ error: `Cannot move a charge from '${existing.status}' to '${nextStatus}'` }, { status: 400 })
  }

  await updateChargeStatus(Number(id), nextStatus)
  await logAudit(session, `updated charge ${id} status to ${nextStatus}`, existing.patientId)
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 2: `src/components/NewChargeModal.tsx`**

```typescript
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface DxRow { code: string; description: string }
interface ProcRow { code: string; description: string; units: number; chargeCents: number }

export function NewChargeModal({ patients }: { patients: { id: string; name: string }[] }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [patientId, setPatientId] = useState(patients[0]?.id ?? '')
  const [providerName, setProviderName] = useState('Dr. R. Kunam')
  const [dateOfService, setDateOfService] = useState('')
  const [dx, setDx] = useState<DxRow[]>([{ code: '', description: '' }])
  const [proc, setProc] = useState<ProcRow[]>([{ code: '', description: '', units: 1, chargeCents: 0 }])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const amountCents = proc.reduce((sum, p) => sum + p.chargeCents * p.units, 0)

  function updateDx(i: number, patch: Partial<DxRow>) {
    setDx(dx.map((row, idx) => (idx === i ? { ...row, ...patch } : row)))
  }
  function updateProc(i: number, patch: Partial<ProcRow>) {
    setProc(proc.map((row, idx) => (idx === i ? { ...row, ...patch } : row)))
  }

  async function submit() {
    setSaving(true)
    setError(null)
    const res = await fetch('/api/charges', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patientId, providerName, dateOfService, diagnosisCodes: dx, procedureCodes: proc, amountCents }),
    })
    setSaving(false)
    if (res.ok) {
      setOpen(false)
      router.refresh()
    } else {
      const body = await res.json()
      setError(body.error ?? 'Failed to create charge.')
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground shadow-sm transition-opacity hover:opacity-90">
        + New Charge
      </button>
    )
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-foreground/20 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-lg border border-border bg-card p-6 shadow-lg">
        <h2 className="mb-4 text-lg font-bold text-foreground">New Charge</h2>
        {error && <p className="mb-3 text-sm font-medium text-destructive">{error}</p>}

        <div className="mb-4 grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Patient</label>
            <select value={patientId} onChange={(e) => setPatientId(e.target.value)} className="w-full rounded-md border border-border px-2 py-1.5 text-sm">
              {patients.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.id})</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Provider</label>
            <input value={providerName} onChange={(e) => setProviderName(e.target.value)} className="w-full rounded-md border border-border px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Date of Service</label>
            <input type="date" value={dateOfService} onChange={(e) => setDateOfService(e.target.value)} className="w-full rounded-md border border-border px-2 py-1.5 text-sm" />
          </div>
        </div>

        <div className="mb-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Diagnosis Codes</h3>
            <button type="button" onClick={() => setDx([...dx, { code: '', description: '' }])} className="text-xs font-medium text-primary hover:underline">+ Add</button>
          </div>
          <div className="space-y-2">
            {dx.map((row, i) => (
              <div key={i} className="flex gap-2">
                <input value={row.code} onChange={(e) => updateDx(i, { code: e.target.value })} placeholder="Code (e.g. F33.1)" className="w-32 rounded-md border border-border px-2 py-1.5 text-sm" />
                <input value={row.description} onChange={(e) => updateDx(i, { description: e.target.value })} placeholder="Description" className="flex-1 rounded-md border border-border px-2 py-1.5 text-sm" />
                <button type="button" onClick={() => setDx(dx.filter((_, idx) => idx !== i))} disabled={dx.length === 1} className="rounded px-2 text-xs text-destructive hover:bg-secondary disabled:opacity-30">Remove</button>
              </div>
            ))}
          </div>
        </div>

        <div className="mb-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Procedure Codes</h3>
            <button type="button" onClick={() => setProc([...proc, { code: '', description: '', units: 1, chargeCents: 0 }])} className="text-xs font-medium text-primary hover:underline">+ Add</button>
          </div>
          <div className="space-y-2">
            {proc.map((row, i) => (
              <div key={i} className="flex gap-2">
                <input value={row.code} onChange={(e) => updateProc(i, { code: e.target.value })} placeholder="CPT code" className="w-24 rounded-md border border-border px-2 py-1.5 text-sm" />
                <input value={row.description} onChange={(e) => updateProc(i, { description: e.target.value })} placeholder="Description" className="flex-1 rounded-md border border-border px-2 py-1.5 text-sm" />
                <input type="number" min={1} value={row.units} onChange={(e) => updateProc(i, { units: Number(e.target.value) })} placeholder="Units" className="w-16 rounded-md border border-border px-2 py-1.5 text-sm" />
                <input type="number" min={0} value={row.chargeCents / 100} onChange={(e) => updateProc(i, { chargeCents: Math.round(Number(e.target.value) * 100) })} placeholder="$ per unit" className="w-24 rounded-md border border-border px-2 py-1.5 text-sm" />
                <button type="button" onClick={() => setProc(proc.filter((_, idx) => idx !== i))} disabled={proc.length === 1} className="rounded px-2 text-xs text-destructive hover:bg-secondary disabled:opacity-30">Remove</button>
              </div>
            ))}
          </div>
        </div>

        <p className="mb-4 text-sm font-semibold text-foreground">Total amount: ${(amountCents / 100).toFixed(2)}</p>

        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => setOpen(false)} className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary">Cancel</button>
          <button type="button" onClick={submit} disabled={saving || !patientId || !dateOfService} className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
            {saving ? 'Creating...' : 'Create Charge (Draft)'}
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: `src/components/ChargesTable.tsx`**

Owns the search/filter/column-visibility state that `DataGridToolbar` is a controlled view of, and the "advance status" workflow action per row (each status shows only the one or two next legal transitions, matching `isAllowedChargeTransition` from Task 3 so the UI can never request an illegal move).

```typescript
'use client'
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { DataGridToolbar, type DataGridFilterField, type DataGridColumn } from '@/components/DataGridToolbar'
import { NewChargeModal } from '@/components/NewChargeModal'
import { formatCents } from '@/lib/format'

type Charge = {
  id: number
  patientId: string
  patientName: string
  providerName: string
  dateOfService: string
  amountCents: number
  status: 'draft' | 'pending_approval' | 'approved' | 'submitted'
}

const STATUS_LABELS: Record<Charge['status'], string> = {
  draft: 'Draft',
  pending_approval: 'Pending Approval',
  approved: 'Approved',
  submitted: 'Submitted',
}

const NEXT_STATUS_ACTIONS: Record<Charge['status'], { label: string; next: Charge['status'] }[]> = {
  draft: [{ label: 'Send for Approval', next: 'pending_approval' }],
  pending_approval: [{ label: 'Approve', next: 'approved' }, { label: 'Send Back to Draft', next: 'draft' }],
  approved: [{ label: 'Submit', next: 'submitted' }, { label: 'Send Back for Approval', next: 'pending_approval' }],
  submitted: [],
}

const COLUMNS: DataGridColumn[] = [
  { key: 'dateOfService', label: 'Date' },
  { key: 'patient', label: 'Patient' },
  { key: 'provider', label: 'Provider' },
  { key: 'status', label: 'Status' },
  { key: 'amount', label: 'Amount' },
  { key: 'actions', label: 'Actions' },
]

export function ChargesTable({ charges, patients }: { charges: Charge[]; patients: { id: string; name: string }[] }) {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [visibleColumns, setVisibleColumns] = useState<string[]>(COLUMNS.map((c) => c.key))
  const [pending, setPending] = useState<number | null>(null)

  const providers = useMemo(() => [...new Set(charges.map((c) => c.providerName))], [charges])
  const filterFields: DataGridFilterField[] = [
    { key: 'status', label: 'Status', options: Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })) },
    { key: 'provider', label: 'Provider', options: providers.map((p) => ({ value: p, label: p })) },
  ]

  const filtered = charges.filter((c) => {
    if (filters.status && c.status !== filters.status) return false
    if (filters.provider && c.providerName !== filters.provider) return false
    if (search && !`${c.patientName} ${c.patientId} ${c.providerName}`.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  async function advance(chargeId: number, nextStatus: Charge['status']) {
    setPending(chargeId)
    await fetch(`/api/charges/${chargeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: nextStatus }),
    })
    setPending(null)
    router.refresh()
  }

  const show = (key: string) => visibleColumns.includes(key)

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <DataGridToolbar
          searchValue={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search patient or provider..."
          onRefresh={() => router.refresh()}
          filterFields={filterFields}
          activeFilters={filters}
          onFilterChange={(key, value) => setFilters({ ...filters, [key]: value })}
          onClearFilters={() => setFilters({})}
          columns={COLUMNS}
          visibleColumnKeys={visibleColumns}
          onToggleColumn={(key) => setVisibleColumns((cols) => (cols.includes(key) ? cols.filter((c) => c !== key) : [...cols, key]))}
        />
        <NewChargeModal patients={patients} />
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">No records found.</p>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              {show('dateOfService') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Date</th>}
              {show('patient') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Patient</th>}
              {show('provider') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Provider</th>}
              {show('status') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</th>}
              {show('amount') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Amount</th>}
              {show('actions') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {filtered.map((c, i) => (
              <tr key={c.id} className={`border-b border-border ${i % 2 === 1 ? 'bg-muted/40' : ''} hover:bg-secondary`}>
                {show('dateOfService') && <td className="p-3 text-foreground">{c.dateOfService}</td>}
                {show('patient') && <td className="p-3"><Link href={`/billing/charges/${c.id}`} className="font-medium text-primary hover:underline">{c.patientName}</Link></td>}
                {show('provider') && <td className="p-3 text-foreground">{c.providerName}</td>}
                {show('status') && <td className="p-3 text-foreground">{STATUS_LABELS[c.status]}</td>}
                {show('amount') && <td className="p-3 text-foreground">{formatCents(c.amountCents)}</td>}
                {show('actions') && (
                  <td className="p-3">
                    <div className="flex gap-2">
                      {NEXT_STATUS_ACTIONS[c.status].map((action) => (
                        <button
                          key={action.next}
                          type="button"
                          disabled={pending === c.id}
                          onClick={() => advance(c.id, action.next)}
                          className="rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-secondary disabled:opacity-50"
                        >
                          {action.label}
                        </button>
                      ))}
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-3 text-xs text-muted-foreground">{filtered.length} of {charges.length} charge{charges.length === 1 ? '' : 's'}</p>
    </div>
  )
}
```

- [ ] **Step 4: `src/app/(dashboard)/billing/charges/page.tsx`**

```typescript
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listCharges } from '@/lib/queries/charges'
import { listPatientsWithStatus } from '@/lib/queries/patients'
import { ChargesTable } from '@/components/ChargesTable'

export default async function ChargesPage() {
  const session = await requireSessionOrRedirect()
  const [charges, patients] = await Promise.all([listCharges(), listPatientsWithStatus(null)])
  await logAudit(session, 'viewed charges', null)

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-foreground">Charges</h1>
      <ChargesTable
        charges={charges}
        patients={patients.map((p) => ({ id: p.id, name: p.nameTebra ?? p.nameIntakeq }))}
      />
    </div>
  )
}
```

- [ ] **Step 5: Test**

`tests/api/charges.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest'
import { GET, POST } from '@/app/api/charges/route'
import { PATCH } from '@/app/api/charges/[id]/route'

vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: 'crc', name: 'Jamie Ruiz' })) }))

describe('GET /api/charges', () => {
  it('returns the seeded charges', async () => {
    const res = await GET()
    const body = await res.json()
    expect(body.length).toBeGreaterThanOrEqual(11)
  })
})

describe('POST /api/charges', () => {
  it('rejects a payload missing procedure codes', async () => {
    const req = new Request('http://localhost/api/charges', {
      method: 'POST',
      body: JSON.stringify({ patientId: 'RD-0001', providerName: 'Dr. R. Kunam', dateOfService: '2026-09-17', diagnosisCodes: [{ code: 'F33.1', description: 'MDD' }], procedureCodes: [], amountCents: 100 }),
    })
    const res = await POST(req as never)
    expect(res.status).toBe(400)
  })

  it('creates a new charge in draft status', async () => {
    const req = new Request('http://localhost/api/charges', {
      method: 'POST',
      body: JSON.stringify({
        patientId: 'RD-0001', providerName: 'Dr. R. Kunam', dateOfService: '2026-09-17',
        diagnosisCodes: [{ code: 'F33.1', description: 'MDD' }],
        procedureCodes: [{ code: '90837', description: 'Psychotherapy', units: 1, chargeCents: 15000 }],
        amountCents: 15000,
      }),
    })
    const res = await POST(req as never)
    const body = await res.json()
    expect(res.status).toBe(201)
    expect(body.status).toBe('draft')
  })
})

describe('PATCH /api/charges/[id]', () => {
  it('rejects an illegal status transition (draft straight to submitted)', async () => {
    const createReq = new Request('http://localhost/api/charges', {
      method: 'POST',
      body: JSON.stringify({
        patientId: 'RD-0001', providerName: 'Dr. R. Kunam', dateOfService: '2026-09-17',
        diagnosisCodes: [{ code: 'F33.1', description: 'MDD' }],
        procedureCodes: [{ code: '90837', description: 'Psychotherapy', units: 1, chargeCents: 15000 }],
        amountCents: 15000,
      }),
    })
    const created = await (await POST(createReq as never)).json()

    const req = new Request(`http://localhost/api/charges/${created.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'submitted' }) })
    const res = await PATCH(req as never, { params: Promise.resolve({ id: String(created.id) }) })
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 6: Run the suite, manually verify, and commit**

Run: `npm test` and `npm run build`. Then `npm run dev` and manually confirm: `/billing/charges` lists the seeded charges; the Filter and Columns panels open and actually filter/hide as expected; "+ New Charge" creates a draft charge that appears in the list; clicking a charge's status action button advances it and the button set for that row updates.

```bash
git add src/app/api/charges src/app/\(dashboard\)/billing/charges/page.tsx src/components/ChargesTable.tsx src/components/NewChargeModal.tsx tests/api/charges.test.ts
git commit -m "feat: add Charges list, New Charge flow, and status workflow"
```

---

### Task 5: Charge Capture detail view (read-only)

Modeled on Tebra's Charge Capture screen (`docs/superpowers/specs/2026-09-17-tebra-intakeq-screenshot-catalog.md`, "Billing/financial" section): Patient Information, Visit & Provider Information, Diagnosis Codes table, Procedure Codes table, and a status label. Deliberately **read-only** per this plan's task list — status transitions live on the Charges list (Task 4), not here.

**Files:**
- Create: `src/app/(dashboard)/billing/charges/[chargeId]/page.tsx`

**Interfaces:**
- Consumes: `getCharge` (Task 3).
- Produces: `/billing/charges/[chargeId]` route, linked from the Charges list (Task 4).

- [ ] **Step 1: `src/app/(dashboard)/billing/charges/[chargeId]/page.tsx`**

```typescript
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getCharge } from '@/lib/queries/charges'
import { formatCents } from '@/lib/format'

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  pending_approval: 'Pending Approval',
  approved: 'Approved',
  submitted: 'Submitted',
}

export default async function ChargeCaptureDetailPage({ params }: { params: Promise<{ chargeId: string }> }) {
  const session = await requireSessionOrRedirect()
  const { chargeId } = await params
  const charge = await getCharge(Number(chargeId))
  if (!charge) notFound()
  await logAudit(session, `viewed charge capture ${chargeId}`, charge.patientId)

  return (
    <div className="max-w-3xl space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/billing/charges" className="text-sm text-primary hover:underline">&larr; Back to Charges</Link>
          <h1 className="mt-1 text-2xl font-bold text-foreground">Charge Capture — {charge.patientName}</h1>
        </div>
        <span className="text-sm font-semibold text-foreground">{STATUS_LABELS[charge.status]}</span>
      </div>

      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Patient Information</h2>
        <div className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-card p-4 text-sm">
          <div><span className="text-muted-foreground">Patient: </span><span className="text-foreground">{charge.patientName} ({charge.patientId})</span></div>
          <div><span className="text-muted-foreground">DOB: </span><span className="text-foreground">{charge.patientDob}</span></div>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Visit &amp; Provider Information</h2>
        <div className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-card p-4 text-sm">
          <div><span className="text-muted-foreground">Date of Service: </span><span className="text-foreground">{charge.dateOfService}</span></div>
          <div><span className="text-muted-foreground">Rendering Provider: </span><span className="text-foreground">{charge.providerName}</span></div>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Diagnosis Codes</h2>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="p-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Code</th>
              <th className="p-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Description</th>
            </tr>
          </thead>
          <tbody>
            {charge.diagnosisCodes.map((d, i) => (
              <tr key={i} className={`border-b border-border ${i % 2 === 1 ? 'bg-muted/40' : ''}`}>
                <td className="p-2 text-foreground">{d.code}</td>
                <td className="p-2 text-foreground">{d.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Procedure Codes</h2>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="p-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Code</th>
              <th className="p-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Description</th>
              <th className="p-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Units</th>
              <th className="p-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Charge</th>
              <th className="p-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Total</th>
            </tr>
          </thead>
          <tbody>
            {charge.procedureCodes.map((p, i) => (
              <tr key={i} className={`border-b border-border ${i % 2 === 1 ? 'bg-muted/40' : ''}`}>
                <td className="p-2 text-foreground">{p.code}</td>
                <td className="p-2 text-foreground">{p.description}</td>
                <td className="p-2 text-foreground">{p.units}</td>
                <td className="p-2 text-foreground">{formatCents(p.chargeCents)}</td>
                <td className="p-2 text-foreground">{formatCents(p.chargeCents * p.units)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-right text-sm font-semibold text-foreground">Total: {formatCents(charge.amountCents)}</p>
      </section>
    </div>
  )
}
```

- [ ] **Step 2: Run the suite, manually verify, and commit**

Run: `npm test` and `npm run build`. Then `npm run dev` and manually confirm: clicking a patient name on `/billing/charges` opens `/billing/charges/[id]` and renders the full read-only detail (no editable controls, no status-change buttons — this page is display-only).

```bash
git add src/app/\(dashboard\)/billing/charges/\[chargeId\]/page.tsx
git commit -m "feat: add read-only Charge Capture detail view"
```

---

### Task 6: Insurance Collections list

Modeled on Tebra's Insurance Collections screen: coarse status categories as top tabs (matching the "left status rail" pattern, adapted to the top-tab pattern this codebase already uses on `/patients` — see `src/app/(dashboard)/patients/page.tsx`'s trial tabs), plus `DataGridToolbar` for search/refresh/a secondary Payer filter/columns. `paid` claims are intentionally excluded from every tab except "All" — a paid claim has left the collections workflow, matching real billing-software behavior.

**Files:**
- Create: `src/app/(dashboard)/billing/insurance-collections/page.tsx`
- Create: `src/components/InsuranceClaimsTable.tsx` (`'use client'`)

**Interfaces:**
- Consumes: `listInsuranceClaims` (Task 3), `DataGridToolbar` (Task 1).
- Produces: `/billing/insurance-collections` route, linked from `LeftNav` (Task 12).

- [ ] **Step 1: `src/components/InsuranceClaimsTable.tsx`**

```typescript
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { DataGridToolbar, type DataGridFilterField, type DataGridColumn } from '@/components/DataGridToolbar'
import { formatCents } from '@/lib/format'

type Claim = {
  id: number
  patientId: string
  patientName: string
  payerName: string
  billedAmountCents: number
  paidAmountCents: number | null
  status: 'rejected' | 'denied' | 'waiting_adjudication' | 'needs_investigation' | 'paid'
  submittedDate: string
  dateOfService: string
}

const STATUS_LABELS: Record<Claim['status'], string> = {
  rejected: 'Rejected',
  denied: 'Denied',
  waiting_adjudication: 'Waiting for Adjudication',
  needs_investigation: 'Needs Investigation',
  paid: 'Paid',
}

const TABS: { key: 'all' | Claim['status']; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'denied', label: 'Denied' },
  { key: 'waiting_adjudication', label: 'Waiting for Adjudication' },
  { key: 'needs_investigation', label: 'Needs Investigation' },
]

const COLUMNS: DataGridColumn[] = [
  { key: 'dateOfService', label: 'Date of Service' },
  { key: 'patient', label: 'Patient' },
  { key: 'payer', label: 'Payer' },
  { key: 'status', label: 'Status' },
  { key: 'billed', label: 'Billed' },
  { key: 'paid', label: 'Paid' },
]

export function InsuranceClaimsTable({ claims }: { claims: Claim[] }) {
  const router = useRouter()
  const [tab, setTab] = useState<'all' | Claim['status']>('all')
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [visibleColumns, setVisibleColumns] = useState<string[]>(COLUMNS.map((c) => c.key))

  const payers = [...new Set(claims.map((c) => c.payerName))]
  const filterFields: DataGridFilterField[] = [
    { key: 'payer', label: 'Payer', options: payers.map((p) => ({ value: p, label: p })) },
  ]

  const visibleClaims = (tab === 'all' ? claims : claims.filter((c) => c.status === tab)).filter((c) => {
    if (filters.payer && c.payerName !== filters.payer) return false
    if (search && !`${c.patientName} ${c.patientId} ${c.payerName}`.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const show = (key: string) => visibleColumns.includes(key)

  return (
    <div>
      <div className="mb-4 flex gap-1 rounded-lg bg-secondary p-1 text-sm">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`rounded-md px-3 py-1.5 font-medium transition-colors ${tab === t.key ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <DataGridToolbar
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search patient or payer..."
        onRefresh={() => router.refresh()}
        filterFields={filterFields}
        activeFilters={filters}
        onFilterChange={(key, value) => setFilters({ ...filters, [key]: value })}
        onClearFilters={() => setFilters({})}
        columns={COLUMNS}
        visibleColumnKeys={visibleColumns}
        onToggleColumn={(key) => setVisibleColumns((cols) => (cols.includes(key) ? cols.filter((c) => c !== key) : [...cols, key]))}
      />

      {visibleClaims.length === 0 ? (
        <p className="text-sm text-muted-foreground">No records found.</p>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              {show('dateOfService') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Date of Service</th>}
              {show('patient') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Patient</th>}
              {show('payer') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Payer</th>}
              {show('status') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</th>}
              {show('billed') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Billed</th>}
              {show('paid') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Paid</th>}
            </tr>
          </thead>
          <tbody>
            {visibleClaims.map((c, i) => (
              <tr key={c.id} className={`border-b border-border ${i % 2 === 1 ? 'bg-muted/40' : ''} hover:bg-secondary`}>
                {show('dateOfService') && <td className="p-3 text-foreground">{c.dateOfService}</td>}
                {show('patient') && <td className="p-3 text-foreground">{c.patientName}</td>}
                {show('payer') && <td className="p-3 text-foreground">{c.payerName}</td>}
                {show('status') && <td className="p-3 text-foreground">{STATUS_LABELS[c.status]}</td>}
                {show('billed') && <td className="p-3 text-foreground">{formatCents(c.billedAmountCents)}</td>}
                {show('paid') && <td className="p-3 text-foreground">{c.paidAmountCents === null ? '—' : formatCents(c.paidAmountCents)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-3 text-xs text-muted-foreground">{visibleClaims.length} record{visibleClaims.length === 1 ? '' : 's'}</p>
    </div>
  )
}
```

- [ ] **Step 2: `src/app/(dashboard)/billing/insurance-collections/page.tsx`**

```typescript
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listInsuranceClaims } from '@/lib/queries/insurance-claims'
import { InsuranceClaimsTable } from '@/components/InsuranceClaimsTable'

export default async function InsuranceCollectionsPage() {
  const session = await requireSessionOrRedirect()
  const claims = await listInsuranceClaims()
  await logAudit(session, 'viewed insurance collections', null)

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-foreground">Insurance Collections</h1>
      <InsuranceClaimsTable claims={claims} />
    </div>
  )
}
```

- [ ] **Step 3: Run the suite, manually verify, and commit**

Run: `npm test` and `npm run build`. Then `npm run dev` and manually confirm: `/billing/insurance-collections` shows all 5 seeded claims under "All", and each status tab (Rejected/Denied/Waiting for Adjudication/Needs Investigation) shows exactly the one seeded claim in that state; the "Paid" claim (RD-0001) appears only under "All".

```bash
git add src/app/\(dashboard\)/billing/insurance-collections/page.tsx src/components/InsuranceClaimsTable.tsx
git commit -m "feat: add Insurance Collections list"
```

---

### Task 7: Patient Collections list

Modeled on Tebra's Patient Collections screen: one row per patient with an outstanding balance and/or unapplied credit, plus a "Collect Payment" action that deep-links into the Virtual Card Payment form (Task 11) with the patient and amount pre-filled.

**Files:**
- Create: `src/app/(dashboard)/billing/patient-collections/page.tsx`
- Create: `src/components/PatientCollectionsTable.tsx` (`'use client'`)

**Interfaces:**
- Consumes: `listPatientCollections` (Task 3), `DataGridToolbar` (Task 1).
- Produces: `/billing/patient-collections` route, linked from `LeftNav` (Task 12). Links to `/billing/pay` (Task 11).

- [ ] **Step 1: `src/components/PatientCollectionsTable.tsx`**

```typescript
'use client'
import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { DataGridToolbar, type DataGridColumn } from '@/components/DataGridToolbar'
import { formatCents } from '@/lib/format'

type Row = { patientId: string; patientName: string; balanceCents: number; unappliedCents: number }

const COLUMNS: DataGridColumn[] = [
  { key: 'patient', label: 'Patient' },
  { key: 'balance', label: 'Balance' },
  { key: 'unapplied', label: 'Unapplied' },
  { key: 'actions', label: 'Actions' },
]

export function PatientCollectionsTable({ rows }: { rows: Row[] }) {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [visibleColumns, setVisibleColumns] = useState<string[]>(COLUMNS.map((c) => c.key))

  const filtered = rows.filter((r) => !search || `${r.patientName} ${r.patientId}`.toLowerCase().includes(search.toLowerCase()))
  const show = (key: string) => visibleColumns.includes(key)

  return (
    <div>
      <DataGridToolbar
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search patient..."
        onRefresh={() => router.refresh()}
        filterFields={[]}
        activeFilters={{}}
        onFilterChange={() => {}}
        onClearFilters={() => {}}
        columns={COLUMNS}
        visibleColumnKeys={visibleColumns}
        onToggleColumn={(key) => setVisibleColumns((cols) => (cols.includes(key) ? cols.filter((c) => c !== key) : [...cols, key]))}
      />

      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">No records found.</p>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              {show('patient') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Patient</th>}
              {show('balance') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Balance</th>}
              {show('unapplied') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Unapplied</th>}
              {show('actions') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => (
              <tr key={r.patientId} className={`border-b border-border ${i % 2 === 1 ? 'bg-muted/40' : ''} hover:bg-secondary`}>
                {show('patient') && <td className="p-3 text-foreground">{r.patientName} ({r.patientId})</td>}
                {show('balance') && <td className="p-3 text-foreground">{formatCents(r.balanceCents)}</td>}
                {show('unapplied') && <td className="p-3 text-foreground">{r.unappliedCents > 0 ? formatCents(r.unappliedCents) : '—'}</td>}
                {show('actions') && (
                  <td className="p-3">
                    {r.balanceCents > 0 ? (
                      <Link
                        href={`/billing/pay?patientId=${r.patientId}&amountCents=${r.balanceCents}`}
                        className="rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-secondary"
                      >
                        Collect Payment
                      </Link>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-3 text-xs text-muted-foreground">{filtered.length} patient{filtered.length === 1 ? '' : 's'} with an outstanding balance or unapplied credit</p>
    </div>
  )
}
```

- [ ] **Step 2: `src/app/(dashboard)/billing/patient-collections/page.tsx`**

```typescript
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listPatientCollections } from '@/lib/queries/patient-collections'
import { PatientCollectionsTable } from '@/components/PatientCollectionsTable'

export default async function PatientCollectionsPage() {
  const session = await requireSessionOrRedirect()
  const rows = await listPatientCollections()
  await logAudit(session, 'viewed patient collections', null)

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-foreground">Patient Collections</h1>
      <PatientCollectionsTable rows={rows} />
    </div>
  )
}
```

- [ ] **Step 3: Run the suite, manually verify, and commit**

Run: `npm test` and `npm run build`. Then `npm run dev` and manually confirm: `/billing/patient-collections` shows a row per patient with an outstanding balance (RD-0002, RD-0003, RD-0004, RD-0006) and one with only an unapplied credit (RD-0005, $25.00 unapplied, $0 balance); "Collect Payment" links to `/billing/pay` with the patient and amount pre-filled in the URL.

```bash
git add src/app/\(dashboard\)/billing/patient-collections/page.tsx src/components/PatientCollectionsTable.tsx
git commit -m "feat: add Patient Collections list"
```

---

### Task 8: Patient Statements — Activity log

Per the plan's scope note: "prioritize a working Activity list over an elaborate settings UI nobody will configure in a demo." This task builds only the Statements Activity log (filterable by delivery method, type, and date), not the Settings or Reporting tabs from the real 3-tab product.

**Files:**
- Create: `src/app/(dashboard)/billing/statements/page.tsx`
- Create: `src/components/PatientStatementsTable.tsx` (`'use client'`)

**Interfaces:**
- Consumes: `listPatientStatements` (Task 3), `DataGridToolbar` (Task 1).
- Produces: `/billing/statements` route, linked from `LeftNav` (Task 12).

- [ ] **Step 1: `src/components/PatientStatementsTable.tsx`**

```typescript
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { DataGridToolbar, type DataGridFilterField, type DataGridColumn } from '@/components/DataGridToolbar'
import { formatCents } from '@/lib/format'

type Statement = {
  id: number
  patientName: string
  amountCents: number
  deliveryMethod: 'email' | 'sms' | 'paper'
  type: 'initial' | 'reminder' | 'final_notice'
  deliveryStatus: 'delivered' | 'failed'
  sentDate: string
}

const DELIVERY_LABELS: Record<Statement['deliveryMethod'], string> = { email: 'Email', sms: 'SMS', paper: 'Paper' }
const TYPE_LABELS: Record<Statement['type'], string> = { initial: 'Initial', reminder: 'Reminder', final_notice: 'Final Notice' }
const STATUS_LABELS: Record<Statement['deliveryStatus'], string> = { delivered: 'Delivered', failed: 'Failed' }

const COLUMNS: DataGridColumn[] = [
  { key: 'sentDate', label: 'Sent' },
  { key: 'patient', label: 'Patient' },
  { key: 'amount', label: 'Amount' },
  { key: 'delivery', label: 'Delivery' },
  { key: 'type', label: 'Type' },
  { key: 'status', label: 'Status' },
]

const FILTER_FIELDS: DataGridFilterField[] = [
  { key: 'delivery', label: 'Delivery', options: Object.entries(DELIVERY_LABELS).map(([value, label]) => ({ value, label })) },
  { key: 'type', label: 'Type', options: Object.entries(TYPE_LABELS).map(([value, label]) => ({ value, label })) },
  { key: 'sentAfter', label: 'Sent after', inputType: 'date' },
  { key: 'sentBefore', label: 'Sent before', inputType: 'date' },
]

export function PatientStatementsTable({ statements }: { statements: Statement[] }) {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [visibleColumns, setVisibleColumns] = useState<string[]>(COLUMNS.map((c) => c.key))

  const filtered = statements.filter((s) => {
    if (filters.delivery && s.deliveryMethod !== filters.delivery) return false
    if (filters.type && s.type !== filters.type) return false
    if (filters.sentAfter && s.sentDate < filters.sentAfter) return false
    if (filters.sentBefore && s.sentDate > filters.sentBefore) return false
    if (search && !s.patientName.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const show = (key: string) => visibleColumns.includes(key)

  return (
    <div>
      <DataGridToolbar
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search patient..."
        onRefresh={() => router.refresh()}
        filterFields={FILTER_FIELDS}
        activeFilters={filters}
        onFilterChange={(key, value) => setFilters({ ...filters, [key]: value })}
        onClearFilters={() => setFilters({})}
        columns={COLUMNS}
        visibleColumnKeys={visibleColumns}
        onToggleColumn={(key) => setVisibleColumns((cols) => (cols.includes(key) ? cols.filter((c) => c !== key) : [...cols, key]))}
      />

      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">No records found.</p>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              {show('sentDate') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sent</th>}
              {show('patient') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Patient</th>}
              {show('amount') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Amount</th>}
              {show('delivery') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Delivery</th>}
              {show('type') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Type</th>}
              {show('status') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</th>}
            </tr>
          </thead>
          <tbody>
            {filtered.map((s, i) => (
              <tr key={s.id} className={`border-b border-border ${i % 2 === 1 ? 'bg-muted/40' : ''} hover:bg-secondary`}>
                {show('sentDate') && <td className="p-3 text-foreground">{new Date(s.sentDate).toLocaleDateString()}</td>}
                {show('patient') && <td className="p-3 text-foreground">{s.patientName}</td>}
                {show('amount') && <td className="p-3 text-foreground">{formatCents(s.amountCents)}</td>}
                {show('delivery') && <td className="p-3 text-foreground">{DELIVERY_LABELS[s.deliveryMethod]}</td>}
                {show('type') && <td className="p-3 text-foreground">{TYPE_LABELS[s.type]}</td>}
                {show('status') && <td className="p-3 text-foreground">{STATUS_LABELS[s.deliveryStatus]}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-3 text-xs text-muted-foreground">{filtered.length} of {statements.length} statement{statements.length === 1 ? '' : 's'}</p>
    </div>
  )
}
```

- [ ] **Step 2: `src/app/(dashboard)/billing/statements/page.tsx`**

```typescript
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listPatientStatements } from '@/lib/queries/patient-statements'
import { PatientStatementsTable } from '@/components/PatientStatementsTable'

export default async function PatientStatementsPage() {
  const session = await requireSessionOrRedirect()
  const statements = await listPatientStatements()
  await logAudit(session, 'viewed patient statements activity', null)

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-foreground">Patient Statements</h1>
      <p className="mb-4 text-sm text-muted-foreground">Activity log of statements sent to patients.</p>
      <PatientStatementsTable statements={statements} />
    </div>
  )
}
```

- [ ] **Step 3: Run the suite, manually verify, and commit**

Run: `npm test` and `npm run build`. Then `npm run dev` and manually confirm: `/billing/statements` lists the 4 seeded statements; filtering by Delivery = SMS shows only the RD-0006 final-notice row; filtering by a "Sent after" date excludes older rows.

```bash
git add src/app/\(dashboard\)/billing/statements/page.tsx src/components/PatientStatementsTable.tsx
git commit -m "feat: add Patient Statements Activity log"
```

---

### Task 9: A/R Dashboard

Three KPI cards (Outstanding A/R, Gross collection rate, Avg days in A/R) plus an aging-bucket bar chart — this phase's first use of `recharts` (installed in Task 1). Bar fill uses the `--chart-1` design token via `var(--chart-1)` rather than a hardcoded color, per Global Constraints.

**Files:**
- Create: `src/app/(dashboard)/billing/ar-dashboard/page.tsx`
- Create: `src/components/ArAgingChart.tsx` (`'use client'`)

**Interfaces:**
- Consumes: `getArDashboardData` (Task 3).
- Produces: `/billing/ar-dashboard` route, linked from `LeftNav` (Task 12).

- [ ] **Step 1: `src/components/ArAgingChart.tsx`**

```typescript
'use client'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'

export function ArAgingChart({ buckets }: { buckets: { label: string; outstandingCents: number }[] }) {
  const data = buckets.map((b) => ({ label: b.label, outstanding: Math.round(b.outstandingCents / 100) }))

  return (
    <div className="h-72 w-full rounded-lg border border-border bg-card p-4">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="label" tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }} />
          <YAxis tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }} tickFormatter={(v) => `$${v}`} />
          <Tooltip
            formatter={(value: number) => [`$${value.toLocaleString()}`, 'Outstanding']}
            contentStyle={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)', fontSize: 12 }}
          />
          <Bar dataKey="outstanding" fill="var(--chart-1)" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
```

- [ ] **Step 2: `src/app/(dashboard)/billing/ar-dashboard/page.tsx`**

```typescript
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getArDashboardData } from '@/lib/queries/ar-dashboard'
import { formatCents } from '@/lib/format'
import { ArAgingChart } from '@/components/ArAgingChart'

function KpiCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-bold text-foreground">{value}</p>
    </div>
  )
}

export default async function ArDashboardPage() {
  const session = await requireSessionOrRedirect()
  const data = await getArDashboardData()
  await logAudit(session, 'viewed A/R dashboard', null)

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-foreground">A/R Dashboard</h1>

      <div className="grid grid-cols-3 gap-4">
        <KpiCard label="Outstanding A/R" value={formatCents(data.outstandingArCents)} />
        <KpiCard label="Gross Collection Rate" value={`${data.grossCollectionRate.toFixed(1)}%`} />
        <KpiCard label="Avg Days in A/R" value={data.avgDaysInAr.toFixed(0)} />
      </div>

      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">A/R Aging</h2>
        <ArAgingChart buckets={data.agingBuckets} />
      </section>
    </div>
  )
}
```

- [ ] **Step 3: Run the suite, manually verify, and commit**

Run: `npm test` and `npm run build`. Then `npm run dev` and manually confirm: `/billing/ar-dashboard` renders three non-zero/valid KPI cards and a bar chart with bars in all five buckets (0-30 has two contributions: RD-0002's $200 balance minus... — confirm visually against the seed data in Task 2 rather than re-deriving the exact numbers by eye).

```bash
git add src/app/\(dashboard\)/billing/ar-dashboard/page.tsx src/components/ArAgingChart.tsx
git commit -m "feat: add A/R Dashboard with KPI cards and aging chart"
```

---

### Task 10: Billing Analytics

A proportionate, demo-sized version of Tebra's Billing Analytics: three KPI cards (Patient Visits, Gross Charges, Net Collections) and one trend chart (monthly Gross Charges vs. Net Collections) — not the full multi-panel real-product dashboard (no time-range presets, no Location/Provider filters, no Top Procedures ranking) per this plan's scope note.

**Files:**
- Create: `src/app/(dashboard)/billing/analytics/page.tsx`
- Create: `src/components/BillingTrendChart.tsx` (`'use client'`)

**Interfaces:**
- Consumes: `getBillingAnalyticsData` (Task 3).
- Produces: `/billing/analytics` route, linked from `LeftNav` (Task 12).

- [ ] **Step 1: `src/components/BillingTrendChart.tsx`**

```typescript
'use client'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'

export function BillingTrendChart({ trend }: { trend: { month: string; grossChargesCents: number; netCollectionsCents: number }[] }) {
  const data = trend.map((t) => ({
    month: t.month,
    'Gross Charges': Math.round(t.grossChargesCents / 100),
    'Net Collections': Math.round(t.netCollectionsCents / 100),
  }))

  return (
    <div className="h-72 w-full rounded-lg border border-border bg-card p-4">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="month" tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }} />
          <YAxis tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }} tickFormatter={(v) => `$${v}`} />
          <Tooltip
            formatter={(value: number) => `$${value.toLocaleString()}`}
            contentStyle={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)', fontSize: 12 }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Line type="monotone" dataKey="Gross Charges" stroke="var(--chart-1)" strokeWidth={2} dot={{ r: 3 }} />
          <Line type="monotone" dataKey="Net Collections" stroke="var(--chart-2)" strokeWidth={2} dot={{ r: 3 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
```

- [ ] **Step 2: `src/app/(dashboard)/billing/analytics/page.tsx`**

```typescript
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getBillingAnalyticsData } from '@/lib/queries/billing-analytics'
import { formatCents } from '@/lib/format'
import { BillingTrendChart } from '@/components/BillingTrendChart'

function KpiCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-bold text-foreground">{value}</p>
    </div>
  )
}

export default async function BillingAnalyticsPage() {
  const session = await requireSessionOrRedirect()
  const data = await getBillingAnalyticsData()
  await logAudit(session, 'viewed billing analytics', null)

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-foreground">Billing Analytics</h1>

      <div className="grid grid-cols-3 gap-4">
        <KpiCard label="Patient Visits" value={String(data.patientVisits)} />
        <KpiCard label="Gross Charges" value={formatCents(data.grossChargesCents)} />
        <KpiCard label="Net Collections" value={formatCents(data.netCollectionsCents)} />
      </div>

      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Gross Charges vs. Net Collections</h2>
        {data.trend.length === 0 ? (
          <p className="text-sm text-muted-foreground">No records found.</p>
        ) : (
          <BillingTrendChart trend={data.trend} />
        )}
      </section>
    </div>
  )
}
```

- [ ] **Step 3: Run the suite, manually verify, and commit**

Run: `npm test` and `npm run build`. Then `npm run dev` and manually confirm: `/billing/analytics` renders three KPI cards and a two-line trend chart with a data point in each month a submitted charge's `dateOfService` falls in (2026-03, 2026-05, 2026-07, 2026-08, 2026-09 per the Task 2 seed data).

```bash
git add src/app/\(dashboard\)/billing/analytics/page.tsx src/components/BillingTrendChart.tsx
git commit -m "feat: add Billing Analytics KPI cards and trend chart"
```

---

### Task 11: Virtual Card Payment (mock-only)

**Read the Global Constraints "Mock-payment safety rule" again before starting this task.** This screen is the highest-risk surface in this plan to get wrong: it must look and feel like a real payment form (Payment Amount, Card Number, Expiration, CVC) while being unmistakably, structurally incapable of processing a real transaction.

**Files:**
- Create: `src/app/api/mock-payments/route.ts` (POST only)
- Create: `src/app/(dashboard)/billing/pay/page.tsx`
- Create: `src/components/VirtualCardPaymentForm.tsx` (`'use client'`)
- Test: `tests/api/mock-payments.test.ts`

**Interfaces:**
- Consumes: `createMockPayment` (Task 3), `luhnCheck` (Task 3, used only for the test — the API route calls `createMockPayment`, which runs the check internally).
- Produces: `/billing/pay` route. Linked from Patient Collections (Task 7) via `?patientId=&amountCents=` query params; also reachable directly from `LeftNav` (Task 12) for demo discoverability without needing an existing balance.

- [ ] **Step 1: `src/app/api/mock-payments/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { createMockPayment } from '@/lib/queries/mock-payments'

// SAFETY: `cardNumber` and `cvc` exist only to run the fake Luhn check inside
// createMockPayment() -- neither is ever written to the database, logged, or
// echoed back in the response. `cvc` isn't even read past validating its
// shape; it plays no role in the (fake) success/failure decision, exactly
// like a real payment form's CVC would never be persisted by a PCI-compliant
// integration -- except here there is no real integration at all. See the
// plan's Global Constraints "Mock-payment safety rule".
const mockPaymentSchema = z.object({
  patientId: z.string().min(1),
  chargeId: z.number().int().positive().nullable(),
  amountCents: z.number().int().positive(),
  cardNumber: z.string().min(12).max(19),
  expMonth: z.number().int().min(1).max(12),
  expYear: z.number().int().min(2024).max(2099),
  cvc: z.string().min(3).max(4),
}).strict()

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session

  const parsed = mockPaymentSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payment payload', details: parsed.error.flatten() }, { status: 400 })

  const payment = await createMockPayment({
    patientId: parsed.data.patientId,
    chargeId: parsed.data.chargeId,
    amountCents: parsed.data.amountCents,
    cardNumber: parsed.data.cardNumber,
    expMonth: parsed.data.expMonth,
    expYear: parsed.data.expYear,
  })
  await logAudit(session, `recorded mock payment (${payment.result}) — DEMO ONLY, no real transaction processed`, parsed.data.patientId)
  return NextResponse.json({ id: payment.id, result: payment.result, cardLast4: payment.cardLast4 }, { status: 201 })
}
```

- [ ] **Step 2: `src/app/(dashboard)/billing/pay/page.tsx`**

```typescript
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listPatientsWithStatus } from '@/lib/queries/patients'
import { VirtualCardPaymentForm } from '@/components/VirtualCardPaymentForm'

export default async function VirtualCardPaymentPage({
  searchParams,
}: {
  searchParams: Promise<{ patientId?: string; amountCents?: string }>
}) {
  const session = await requireSessionOrRedirect()
  const { patientId, amountCents } = await searchParams
  const patients = await listPatientsWithStatus(null)
  await logAudit(session, 'viewed virtual card payment form (demo)', patientId ?? null)

  return (
    <div className="max-w-xl">
      <h1 className="mb-6 text-2xl font-bold text-foreground">Virtual Card Payment</h1>
      <VirtualCardPaymentForm
        patients={patients.map((p) => ({ id: p.id, name: p.nameTebra ?? p.nameIntakeq }))}
        initialPatientId={patientId}
        initialAmountCents={amountCents ? Number(amountCents) : undefined}
      />
    </div>
  )
}
```

- [ ] **Step 3: `src/components/VirtualCardPaymentForm.tsx`**

The safety banner text at the top of this component is exact, binding copy — do not shorten, soften, or move it into a tooltip. It renders unconditionally, in every state of the form (idle, submitting, success, failure), per the Global Constraints "zero decorative icons" rule this uses bold text and a colored border/background, never a warning-symbol glyph.

```typescript
'use client'
import { useState } from 'react'

interface Patient { id: string; name: string }

export function VirtualCardPaymentForm({
  patients,
  initialPatientId,
  initialAmountCents,
}: {
  patients: Patient[]
  initialPatientId?: string
  initialAmountCents?: number
}) {
  const [patientId, setPatientId] = useState(initialPatientId ?? patients[0]?.id ?? '')
  const [amount, setAmount] = useState(initialAmountCents ? (initialAmountCents / 100).toFixed(2) : '')
  const [cardNumber, setCardNumber] = useState('')
  const [expMonth, setExpMonth] = useState('')
  const [expYear, setExpYear] = useState('')
  const [cvc, setCvc] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [outcome, setOutcome] = useState<{ result: 'success' | 'failed'; cardLast4: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setSubmitting(true)
    setError(null)
    setOutcome(null)
    const res = await fetch('/api/mock-payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patientId,
        chargeId: null,
        amountCents: Math.round(Number(amount) * 100),
        cardNumber,
        expMonth: Number(expMonth),
        expYear: Number(expYear),
        cvc,
      }),
    })
    setSubmitting(false)
    if (res.ok) {
      const body = await res.json()
      setOutcome({ result: body.result, cardLast4: body.cardLast4 })
    } else {
      const body = await res.json()
      setError(body.error ?? 'Could not record this demo payment.')
    }
  }

  return (
    <div>
      <div className="mb-6 rounded-lg border-2 border-accent bg-accent/10 p-4">
        <p className="text-sm font-bold uppercase tracking-wide text-foreground">Demo payment — no real transaction is processed.</p>
        <p className="mt-1 text-xs text-muted-foreground">
          This form never contacts a real payment processor and never stores a full card number or CVC. The outcome
          below is decided only by a fake checksum on the card number you type in.
        </p>
      </div>

      {outcome ? (
        <div className={`rounded-lg border p-4 ${outcome.result === 'success' ? 'border-primary bg-secondary' : 'border-destructive bg-destructive/10'}`}>
          <p className="text-sm font-semibold text-foreground">
            {outcome.result === 'success' ? 'Demo payment recorded as successful.' : 'Demo payment recorded as failed.'}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">Card ending in {outcome.cardLast4}. No real transaction occurred.</p>
          <button type="button" onClick={() => setOutcome(null)} className="mt-3 text-xs font-medium text-primary hover:underline">
            Record another demo payment
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {error && <p className="text-sm font-medium text-destructive">{error}</p>}

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Patient</label>
            <select value={patientId} onChange={(e) => setPatientId(e.target.value)} className="w-full rounded-md border border-border px-2 py-1.5 text-sm">
              {patients.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.id})</option>)}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Payment Amount</label>
            <input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-full rounded-md border border-border px-2 py-1.5 text-sm" />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Card Number</label>
            <input
              type="text"
              inputMode="numeric"
              placeholder="4242 4242 4242 4242"
              value={cardNumber}
              onChange={(e) => setCardNumber(e.target.value)}
              className="w-full rounded-md border border-border px-2 py-1.5 text-sm"
            />
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Expiration Month</label>
              <input type="number" min="1" max="12" placeholder="MM" value={expMonth} onChange={(e) => setExpMonth(e.target.value)} className="w-full rounded-md border border-border px-2 py-1.5 text-sm" />
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Expiration Year</label>
              <input type="number" min="2024" max="2099" placeholder="YYYY" value={expYear} onChange={(e) => setExpYear(e.target.value)} className="w-full rounded-md border border-border px-2 py-1.5 text-sm" />
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">CVC</label>
              <input type="text" inputMode="numeric" maxLength={4} value={cvc} onChange={(e) => setCvc(e.target.value)} className="w-full rounded-md border border-border px-2 py-1.5 text-sm" />
            </div>
          </div>

          <button
            type="button"
            onClick={submit}
            disabled={submitting || !patientId || !amount || !cardNumber || !expMonth || !expYear || !cvc}
            className="w-full rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? 'Processing demo payment...' : 'Process Demo Transaction'}
          </button>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Test**

`tests/api/mock-payments.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest'
import { POST } from '@/app/api/mock-payments/route'

vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: 'crc', name: 'Jamie Ruiz' })) }))

describe('POST /api/mock-payments', () => {
  it('rejects a payload with an unknown field (mass-assignment guard)', async () => {
    const req = new Request('http://localhost/api/mock-payments', {
      method: 'POST',
      body: JSON.stringify({ patientId: 'RD-0001', chargeId: null, amountCents: 1000, cardNumber: '4242424242424242', expMonth: 12, expYear: 2027, cvc: '123', realProcessor: 'stripe' }),
    })
    const res = await POST(req as never)
    expect(res.status).toBe(400)
  })

  it('records a success result for a Luhn-valid card number and never returns the card number', async () => {
    const req = new Request('http://localhost/api/mock-payments', {
      method: 'POST',
      body: JSON.stringify({ patientId: 'RD-0001', chargeId: null, amountCents: 1000, cardNumber: '4242424242424242', expMonth: 12, expYear: 2027, cvc: '123' }),
    })
    const res = await POST(req as never)
    const body = await res.json()
    expect(res.status).toBe(201)
    expect(body.result).toBe('success')
    expect(body.cardLast4).toBe('4242')
    expect(JSON.stringify(body)).not.toContain('4242424242424242')
    expect(JSON.stringify(body)).not.toContain('123') // the CVC must never appear in the response
  })

  it('records a failed result for a Luhn-invalid card number', async () => {
    const req = new Request('http://localhost/api/mock-payments', {
      method: 'POST',
      body: JSON.stringify({ patientId: 'RD-0001', chargeId: null, amountCents: 1000, cardNumber: '4242424242424241', expMonth: 12, expYear: 2027, cvc: '123' }),
    })
    const res = await POST(req as never)
    const body = await res.json()
    expect(body.result).toBe('failed')
  })
})
```

- [ ] **Step 5: Run the suite, manually verify, and commit**

Run: `npm test` and `npm run build`. Then `npm run dev` and manually confirm: `/billing/pay` always shows the demo-payment banner; submitting `4242 4242 4242 4242` shows a success outcome; submitting an obviously invalid number (e.g. `1234`) shows a failed outcome; arriving via a Patient Collections "Collect Payment" link pre-fills the patient and amount; check the `mock_payments` table directly in Postgres afterward and confirm no row contains anything resembling a full card number or CVC.

```bash
git add src/app/api/mock-payments src/app/\(dashboard\)/billing/pay/page.tsx src/components/VirtualCardPaymentForm.tsx tests/api/mock-payments.test.ts
git commit -m "feat: add mock-only Virtual Card Payment form"
```

---

### Task 12: `LeftNav` — add the expandable Billing section

Per the architecture spec §5, Billing is "itself expandable to Charges/Insurance Collections/Patient Collections/Statements/A-R Dashboard/Analytics" and sits between Trials & Protocols and Audit Log in the final nav order (the phases between them in that order — Calendar, Form Templates, Client Forms — don't exist in this checkout yet, so Billing is simply inserted immediately before Audit Log, preserving relative order for whenever those phases land). `LeftNav.tsx` is currently a flat list with no concept of a sub-menu, so this task adds one, minimally, without touching how the existing flat items render.

**Files:**
- Modify: `src/components/LeftNav.tsx`

**Interfaces:**
- Consumes: nothing new (pure client-side routing).
- Produces: nav links to all 7 of this phase's routes.

- [ ] **Step 1: Rewrite `src/components/LeftNav.tsx`**

```typescript
'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'

const ITEMS = [
  { href: '/patients', label: 'Patients' },
  { href: '/identity-matching', label: 'Identity Matching' },
  { href: '/trials', label: 'Trials & Protocols' },
]

const BILLING_ITEMS = [
  { href: '/billing/charges', label: 'Charges' },
  { href: '/billing/insurance-collections', label: 'Insurance Collections' },
  { href: '/billing/patient-collections', label: 'Patient Collections' },
  { href: '/billing/statements', label: 'Statements' },
  { href: '/billing/ar-dashboard', label: 'A/R Dashboard' },
  { href: '/billing/analytics', label: 'Analytics' },
  { href: '/billing/pay', label: 'Virtual Card Payment (Demo)' },
]

const TRAILING_ITEMS = [
  { href: '/audit-log', label: 'Audit Log' },
  { href: '/settings', label: 'Settings' },
]

function isActive(pathname: string | null, href: string): boolean {
  return pathname === href || (pathname?.startsWith(`${href}/`) ?? false)
}

function NavLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`block rounded-md border-l-2 py-2 pe-3 ps-2.5 text-sm font-medium transition-colors ${
        active
          ? 'border-sidebar-ring bg-sidebar-accent text-sidebar-accent-foreground'
          : 'border-transparent text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
      }`}
    >
      {label}
    </Link>
  )
}

export function LeftNav() {
  const pathname = usePathname()
  const billingActive = pathname?.startsWith('/billing') ?? false
  const [billingOpen, setBillingOpen] = useState(billingActive)

  return (
    <nav className="w-56 shrink-0 bg-sidebar p-4">
      <ul className="space-y-1">
        {ITEMS.map((item) => (
          <li key={item.href}>
            <NavLink href={item.href} label={item.label} active={isActive(pathname, item.href)} />
          </li>
        ))}

        <li>
          <button
            type="button"
            onClick={() => setBillingOpen((v) => !v)}
            aria-expanded={billingOpen}
            className={`flex w-full items-center justify-between rounded-md border-l-2 py-2 pe-3 ps-2.5 text-sm font-medium transition-colors ${
              billingActive
                ? 'border-sidebar-ring bg-sidebar-accent text-sidebar-accent-foreground'
                : 'border-transparent text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
            }`}
          >
            Billing
            <span aria-hidden="true">{billingOpen ? '−' : '+'}</span>
          </button>
          {billingOpen && (
            <ul className="mt-1 space-y-1 ps-3">
              {BILLING_ITEMS.map((item) => (
                <li key={item.href}>
                  <NavLink href={item.href} label={item.label} active={isActive(pathname, item.href)} />
                </li>
              ))}
            </ul>
          )}
        </li>

        {TRAILING_ITEMS.map((item) => (
          <li key={item.href}>
            <NavLink href={item.href} label={item.label} active={isActive(pathname, item.href)} />
          </li>
        ))}
      </ul>
    </nav>
  )
}
```

Note: the `−`/`+` characters above are plain text glyphs used as the expand/collapse affordance's *only* content inside an `aria-hidden` span (the accessible state is carried by `aria-expanded` on the button, not by the glyph) — this is the same category of minimal, non-decorative marker as `StatusChip`'s colored dot, not a icon-library glyph, and is consistent with "zero decorative icons" (that rule targets icon-glyph libraries like `lucide-react`, not a single ASCII disclosure character with a redundant accessible-state attribute).

- [ ] **Step 2: Run the suite, manually verify, and commit**

Run: `npm test` and `npm run build`. Then `npm run dev` and manually confirm: the Billing section is collapsed by default on `/patients`, expands on click, and is auto-expanded when navigating directly to any `/billing/*` URL; every one of the 7 links routes correctly.

```bash
git add src/components/LeftNav.tsx
git commit -m "feat: add expandable Billing section to LeftNav"
```

---

### Task 13: Final QA pass (local only — no push)

**Files:** none created; verification only.

- [ ] **Step 1: Full-tree greps**

```bash
grep -rn "lucide-react" src/app/\(dashboard\)/billing src/components/DataGridToolbar.tsx src/components/ChargesTable.tsx src/components/NewChargeModal.tsx src/components/InsuranceClaimsTable.tsx src/components/PatientCollectionsTable.tsx src/components/PatientStatementsTable.tsx src/components/ArAgingChart.tsx src/components/BillingTrendChart.tsx src/components/VirtualCardPaymentForm.tsx
grep -rn "bg-slate-\|text-green-700\|text-blue-700\|text-purple-700\|bg-green-700\|text-amber-700\|#[0-9a-fA-F]\{3,6\}" src/app/\(dashboard\)/billing src/components/ArAgingChart.tsx src/components/BillingTrendChart.tsx --include="*.tsx"
grep -rn "stripe\|square\.\|paypal\|braintree\|payment-processor\|realProcessor" src/app/api/mock-payments src/components/VirtualCardPaymentForm.tsx src/lib/mock-payment.ts src/lib/queries/mock-payments.ts
grep -rn "TODO\|TBD\|FIXME\|placeholder text goes here" src/app/\(dashboard\)/billing src/app/api/charges src/app/api/mock-payments src/components/DataGridToolbar.tsx src/components/ChargesTable.tsx src/components/NewChargeModal.tsx src/components/InsuranceClaimsTable.tsx src/components/PatientCollectionsTable.tsx src/components/PatientStatementsTable.tsx src/components/ArAgingChart.tsx src/components/BillingTrendChart.tsx src/components/VirtualCardPaymentForm.tsx src/lib/queries/charges.ts src/lib/queries/insurance-claims.ts src/lib/queries/patient-statements.ts src/lib/queries/mock-payments.ts src/lib/queries/patient-collections.ts src/lib/queries/ar-dashboard.ts src/lib/queries/billing-analytics.ts
```
All four must return zero matches. The third confirms no real payment-processor integration was ever introduced; the fourth confirms no leftover placeholder markers from drafting this plan's tasks (see the dead-code cleanup already caught and fixed in Task 6 while writing this plan — this grep is the mechanical backstop for that class of mistake).

- [ ] **Step 2: Card-data safety check**

```bash
npx dotenv -e .env.local -- tsx -e "import { getDb } from './src/db/client'; import { mockPayments } from './src/db/schema'; getDb().select().from(mockPayments).then(rows => console.log(JSON.stringify(rows, null, 2)))"
```
Inspect the output by eye: every row's `cardLast4` must be exactly 4 digits, and no field anywhere in the output may contain a 12+ digit number or a 3-4 digit value in a field other than `cardLast4`/`expMonth`/`expYear` that could be mistaken for a stored CVC. There is no `cardNumber` or `cvc` column in the table at all (confirmed already by the schema in Task 2), so this step is a behavioral sanity check, not a schema check.

- [ ] **Step 3: `npm test` and `npm run build`**

Both must be 100% clean.

- [ ] **Step 4: Manual browser walkthrough**

Log in and visit every route this plan added: `/billing/charges`, `/billing/charges/[chargeId]` (at least one charge in each of the 4 statuses), `/billing/insurance-collections` (all 5 tabs), `/billing/patient-collections`, `/billing/statements`, `/billing/ar-dashboard`, `/billing/analytics`, `/billing/pay` (both directly from the nav and via a "Collect Payment" deep link). Confirm:
- No screen is empty — every list/chart shows the seeded data from Task 2.
- `DataGridToolbar`'s search, filter panel (with badge count), and Columns checklist all work on every list view that uses it (Charges, Insurance Collections, Patient Collections, Patient Statements).
- The Charges status-workflow buttons only ever offer legal next states, and a charge in `submitted` status offers no further action.
- The Charge Capture detail page has no editable control or status-change button anywhere on it.
- The Virtual Card Payment banner is visible and reads exactly "Demo payment — no real transaction is processed." in every state of the form, and a Luhn-valid vs. Luhn-invalid card number visibly produces different outcomes.
- The Billing section in `LeftNav` expands/collapses and auto-expands when landing on a `/billing/*` URL directly.

- [ ] **Step 5: Confirm nothing pushed yet**

```bash
git status --porcelain
git log --oneline origin/master..HEAD
```

Everything from this plan should be committed locally but **not yet pushed** — pushing and deployment happen only after this Final QA pass is confirmed clean, matching the same "test locally... before pushing into git" discipline Phase 1 followed.

---

## Self-Review

**Placeholder scan.** Every code block in this plan is complete, runnable TypeScript/TSX with no `// TODO`, `...`, or `<your code here>` markers. One placeholder-shaped mistake was caught and corrected during drafting: Task 6's `InsuranceClaimsTable` originally contained a dead, self-referential `tabFiltered` line left over from an earlier draft of the filtering logic; it has been removed from the final code block above so the shipped component contains only the working `visibleClaims` filter chain. Task 13 Step 1's grep for `TODO|TBD|FIXME` is the mechanical backstop against this exact class of mistake reappearing during implementation.

**Type/interface consistency, checked across tasks:**
- `ChargeStatus` (Task 3, `src/lib/queries/charges.ts`) is the single source of truth for the four status strings; `ChargesTable` (Task 4), the Charge Capture page (Task 5), and the Zod enum in `PATCH /api/charges/[id]` (Task 4) all use the identical four literal values (`draft`, `pending_approval`, `approved`, `submitted`) — none of them redeclare or drift from this list.
- `insuranceClaimStatusEnum`'s five values (`rejected`, `denied`, `waiting_adjudication`, `needs_investigation`, `paid`) are used identically in the schema (Task 2), `listInsuranceClaims` (Task 3), and `InsuranceClaimsTable`'s `STATUS_LABELS`/`TABS` (Task 6) — the tabs deliberately expose only 4 of the 5 (excluding `paid`), and Task 6's prose explains why rather than leaving that as an unexplained discrepancy.
- `DataGridToolbar`'s props (Task 1) are consumed with the same shape by all four call sites (`ChargesTable`, `InsuranceClaimsTable`, `PatientCollectionsTable`, `PatientStatementsTable`) — none of them pass extra undeclared props or rely on an undocumented behavior.
- Money is `amountCents`/`billedAmountCents`/`paidAmountCents`/`unappliedCents` (integer cents) everywhere across schema, queries, and components; the only float-dollar boundary is the `NewChargeModal`/`VirtualCardPaymentForm` input fields, which convert to cents with `Math.round(... * 100)` before ever reaching an API route — consistent with the codebase having no other currency fields to match against, so this convention is established fresh here for later phases to reuse.
- The `patientStatements.sentDate` Date-vs-string cache-shape hazard (a `timestamp` column returns a JS `Date` on a cache miss but a plain string after a Redis JSON round-trip on a cache hit) was caught during drafting and fixed at the query-function layer (Task 3) rather than left for each consumer to handle inconsistently — `listPatientStatements` now always returns an ISO string, so `PatientStatementsTable`'s date-range filter (Task 8) works identically on a cold or warm cache.
- `charges.dateOfService` and `insuranceClaims.submittedDate` use Drizzle's `date` column type, which returns a plain `"YYYY-MM-DD"` string by default (matching the existing `patients.dobIntakeq`/`dobTebra` convention already in `src/db/schema.ts`) — no equivalent Date-object hazard exists for these two fields, so no extra normalization was needed for them.

**Spec coverage against the catalog's "Billing/financial" section** (`docs/superpowers/specs/2026-09-17-tebra-intakeq-screenshot-catalog.md`):
- Charges (plain-table variant: Status/Provider filters, Date/Patient/Provider/Status/Diagnosis Codes/Procedure Codes/Open Note columns, "+ New Charge") — covered by Task 4; the card/list-view variant with a left status-count rail is intentionally not built (the plain-table variant plus the status-workflow action buttons covers the same functional ground without a second parallel view nobody asked for).
- Insurance Collections (status rail: Rejected/Denied/Waiting for adjudication/Needs investigation) — covered by Task 6.
- Proof of Timely Filing Report — not built; it's a single-input report tool with no data model of its own beyond an encounter ID lookup, out of proportion to a pilot demo and not listed in "What to build."
- Patient Collections (Balance/Unapplied columns, Collect Payment action) — covered by Task 7; the "0/1/2/3+ statements sent" left-rail filter is not built as a literal rail, but is achievable via the existing Search box since patient names are few enough to scan directly at this data scale — recorded here as a deliberate scope call, not an oversight.
- Automated Patient Billing / Patient Statements — only the Statements Activity tab is built (Task 8), exactly as scoped in "What to build"; the Settings and Reporting tabs are explicitly out of scope for this plan.
- Billing Analytics — covered by Task 10 in the reduced "KPI cards + one trend chart" form the task list calls for, not the full multi-panel real-product dashboard.
- Virtual Card Payment — covered by Task 11, mock-only per the architecture spec §3, with the safety rule enforced at the schema (Task 2), query (Task 3), API (Task 11), and UI (Task 11) layers simultaneously, not just one of them.
- Subscription Management — explicitly excluded per the architecture spec §4; only its toolbar pattern was extracted, into `DataGridToolbar` (Task 1).
- A/R Dashboard (Outstanding A/R, Gross collection rate, Avg days in A/R KPI cards; aging-bucket bar chart) — covered by Task 9. The real product's donut charts, Credits/Total adjustments KPIs, Insights/Trends tab split, and Top outstanding balances table are not built — this plan's task list calls for exactly the three KPI cards plus the aging chart, not a full clone.
- Charge Capture (read-only encounter detail: Patient Information, Visit & Provider Information, Diagnosis Codes table, Procedure Codes table, status label) — covered by Task 5, correctly read-only with no Collapse All/Print/Close action chrome (none of those were in "What to build" for this phase, and Print would be the only one even plausible to add — deliberately left out to keep this task's scope matched to what was asked for).

**Safety rule verification.** The mock-payment safety rule is stated in full, in binding language, in this plan's Global Constraints section (immediately after the copied conventions block), and is re-referenced at the start of Task 2 (schema comment), Task 3 (`luhnCheck`/`createMockPayment` comments), and Task 11 (task intro, API route comment, and the exact required banner copy) — not stated once and then left to drift across the tasks that actually implement it.
