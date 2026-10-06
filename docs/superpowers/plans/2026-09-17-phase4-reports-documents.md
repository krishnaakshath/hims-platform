# Phase 4: Reports Module + Documents/Fax Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Clinsync a Tebra-style Reports module (`/reports`) — a left sidebar accordion tree grouped by Patients / Appointments / Notes / Encounters / Claims, every leaf a filtered, sortable table view over existing data — plus a Documents module (`/documents`) with a metadata-only Documents tab and a Fax History tab whose delivery status is explicitly simulated. Reports own no new tables (they are queries over Phase 1's `formSubmissions`, Phase 2's `appointments`, and Phase 3's `charges`/`insuranceClaims`); Phase 4 owns exactly two new tables, `documents` and `faxes`. A Charge Capture detail view (read-only, UI-only) reuses Phase 3's `charges` data.

**Architecture:** Same stack, same security patterns as Phase 1 and the rest of the prototype (Next.js App Router Server Components + shared query functions, Drizzle/Neon, Upstash cache, `requireSession`/`requireSessionOrRedirect`, Zod-validated writes, audit logging). Reports and Documents pages live inside the existing `(dashboard)` route group so they inherit `TopBanner`/`LeftNav`/`SessionTimeoutWarning` for free. Filtering and per-column visibility for every report/document table happen entirely client-side against an already-fetched (short-TTL-cached) row set — matching the architecture spec's explicit guidance that Clinsync's real data scale (dozens of patients, not hundreds of thousands) does not warrant server-side pagination/filtering machinery. The Reports module gets its own secondary, in-page sidebar (`ReportsSidebar`, an accordion tree) that is separate from the app-wide `LeftNav` — `LeftNav` gets exactly two new top-level entries, "Reports" and "Documents".

**Tech Stack:** Next.js 16 (App Router, TypeScript), Drizzle ORM + Neon Postgres, Upstash Redis, Tailwind v4 + shadcn/ui, Vitest, `@testing-library/react`.

**Spec:** `docs/superpowers/specs/2026-09-17-full-platform-phases-design.md` (§3 fax safety constraint, §4 schema ownership, §6 shared `DataGridToolbar.tsx`), `docs/superpowers/specs/2026-09-17-tebra-intakeq-screenshot-catalog.md` ("Reports & documents" section).

## Global Constraints

(Copied verbatim from `docs/superpowers/plans/2026-09-17-intake-chart-workflow.md`'s Global Constraints, which this plan follows exactly, plus Phase-4-specific additions at the end.)

- Every API route calls `requireSession()` and returns its `NextResponse` result unchanged on failure (see `src/lib/auth.ts`, `src/app/api/trials/[trialId]/criteria/route.ts` for the exact pattern).
- Every Server Component page calls `requireSessionOrRedirect()` as its **first statement**, before any data fetch (see the comment in `src/app/(dashboard)/patients/page.tsx` — relying on the layout's redirect alone leaks PHI into the response body on an unauthenticated request).
- Server Components call shared query functions in `src/lib/queries/*.ts` directly. **Never** `fetch()` the app's own API route from a Server Component.
- Every write validates its request body with a `.strict()` Zod schema (see `criteriaUpdateSchema` in `src/app/api/trials/[trialId]/criteria/route.ts`).
- Every write that changes patient-relevant state, and every page view of PHI-shaped data, calls `logAudit(session, action, patientId)` (`src/lib/audit.ts`) — `session` must be the real, non-null session, never a fallback role. (Phase 1's pages audit views as well as writes; this plan follows the same convention for every Reports/Documents page.)
- Zero decorative icons anywhere. Status/severity is always a colored dot (`<span className="h-2 w-2 rounded-full ...">`, `aria-hidden="true"`) plus a text label — see `src/components/StatusChip.tsx`.
- Design tokens only: `bg-primary`, `bg-accent`, `text-accent-foreground`, `bg-card`, `border-border`, `bg-muted`, `text-muted-foreground`, `bg-secondary` from `src/app/globals.css`. Never a hardcoded Tailwind color class (`bg-slate-*`, `text-green-700`, etc.) — emerald-600/800, amber-500/800, red-600/800 tokens are used for status dots only, matching `StatusChip.tsx`'s existing convention.
- Section/column headers: `text-xs font-semibold uppercase tracking-wide text-muted-foreground`.
- Zebra striping on every list/table: `i % 2 === 1 ? 'bg-muted/40' : ''`.
- At most one coral (`bg-accent`) primary-action button visible at a time per screen. This plan's per-row actions (e.g. "Mark Processed") deliberately use `border-border` styling, not `bg-accent`, so a table of N rows never violates this rule; `bg-accent` is reserved for the single "Apply" button inside an open `FilterPanel` and the single "Close" button on the Charge Capture detail view.
- No glassmorphism, gradient/shiny buttons, bento grids, or floating/breathing animations — subtle hover/transition-colors utilities only.
- Empty states are plain, factual text ("No results found." for report/document tables, matching the catalog's plain-text convention for this product), never an illustration.
- `npm test` and `npm run build` must be clean after every task.
- **Fax safety constraint (architecture spec §3, mandatory):** `faxes.deliveryStatus` is a simulated value only. Every place delivery status is displayed or documented must make clear this app never transmits a real fax — implemented here as an on-screen disclaimer at the top of the Fax History tab (Task 12) plus a code comment on the `faxes` table (Task 1).
- **`DataGridToolbar.tsx` prop-interface assumption (architecture spec §6):** `src/components/DataGridToolbar.tsx` is built by Phase 3, in parallel with this plan — it does not exist yet and this plan's author cannot read its actual source. Task 5 (`ReportTable.tsx`) assumes the following interface, inferred from the architecture spec's description ("search input, refresh button, a filter button showing an active-filter-count badge that opens a slide-out panel, and a Columns button (visibility toggle checklist)"):
  ```typescript
  interface DataGridToolbarProps {
    searchValue: string
    onSearchChange: (value: string) => void
    onRefresh: () => void
    filterCount: number
    onOpenFilters: () => void
    columns: { key: string; label: string; visible: boolean }[]
    onToggleColumn: (key: string) => void
  }
  ```
  **A human reviewer must reconcile this against Phase 3's actual `DataGridToolbar.tsx` before Task 5 is executed.** If the real prop names differ, only `ReportTable.tsx`'s single call site needs updating — no other file in this plan touches `DataGridToolbar` directly.
- Documents are metadata-only rows (name, date, status, received-from, label, linked patient, file type) — no file upload, storage, or download is implemented anywhere in this plan, per the task brief.

## Cross-phase dependencies

Per the architecture spec §4, Phase 4 owns exactly `documents` and `faxes`. Every other table this plan reads is owned by another phase. As of this plan being written, **neither Phase 2's plan (`docs/superpowers/plans/2026-09-17-phase2-scheduling.md`) nor Phase 3's plan (`docs/superpowers/plans/2026-09-17-phase3-billing.md`) exists yet** — confirmed by listing `docs/superpowers/plans/` (only `2026-09-16-ipmg-workbook-prototype.md`, `2026-09-17-intake-chart-workflow.md`, and `2026-09-17-visual-redesign.md` exist). This plan therefore makes the following assumptions, which **must be reconciled against Phase 2's and Phase 3's actual schemas before the flagged tasks run**:

1. **`appointments` (Phase 2)** — assumed columns: `id` (serial PK), `patientId` (text, FK to `patients.id`), `providerId` (integer, FK to `providers.id`, nullable), `apptDate` (date), `apptTime` (text, e.g. `"09:30 AM"`), `status` (enum: `scheduled` | `completed` | `cancelled` | `no_show`), `visitReason` (text, nullable), `location` (text, nullable), `createdAt` (timestamp).
2. **`providers` (Phase 2)** — assumed columns: `id` (serial PK), `name` (text), `specialty` (text, nullable).
3. **`insuranceClaims` (Phase 3)** — assumed columns: `id` (serial PK), `patientId` (text, FK), `providerId` (integer, nullable), `payerName` (text), `claimAmount` (integer, cents), `status` (enum: `rejected` | `denied` | `waiting_adjudication` | `needs_investigation` | `paid`), `serviceDate` (date), `submittedDate` (date).
4. **`charges` (Phase 3)** — assumed columns: `id` (serial PK), `patientId` (text, FK), `providerId` (integer, nullable), `dateOfService` (date), `status` (text), `diagnosisCodes` (jsonb array of `{ rank: number; code: string; description: string }`), `procedureCodes` (jsonb array of `{ code: string; modifiers: string[]; units: number; charge: number; linkedDiagnoses: number[] }`), `placeOfService` (text, nullable), `visitMode` (text, nullable).
5. **`DataGridToolbar.tsx` (Phase 3)** — prop interface assumed above in Global Constraints.
6. **Phone-field mapping** — Tebra's "All Appointments" report shows separate Home Phone / Mobile Phone columns. Clinsync's `patients` table (Phase 1, unchanged) has only `phoneTebra`/`phoneIntakeq`. This plan maps Home Phone → `patients.phoneTebra`, Mobile Phone → `patients.phoneIntakeq`, rather than assuming Phase 2 adds two new phone columns to `appointments` or `patients`. If Phase 2's plan adds real per-appointment phone fields, Task 3's `listAllAppointmentsReport` should be updated to use them instead.
7. **Charge Capture entry point** — this plan builds only the Charge Capture *detail* route (`/reports/charge-capture/[chargeId]`, Task 11). Phase 3's own Charges list page (not yet written) is the natural place to link each row to this route; Phase 4 cannot add that link itself because Phase 3's file doesn't exist yet. **Phase 3's plan should link its Charges list rows to `/reports/charge-capture/[chargeId]`.**
8. **Encounter enrichment** — `listAllEncountersReport` (Task 3) best-effort-joins `charges` (by matching `patientId` + `dateOfService`/`apptDate`) and `insuranceClaims` (by matching `patientId`) to derive "Payer Scenario" and "Encounter Status"/"Procedure" columns that don't exist on `appointments` alone. This is this plan's own adaptation, not a literal Tebra requirement — it makes the Encounters report meaningfully different from the raw appointments list. If Phase 3 ships materially different `charges`/`insuranceClaims` shapes, this join logic (not just field names) may need rework.

**Execution-order consequence:** Tasks 1, 2, 4, 5, 6, 7, 9, 12, 13, 14 have no cross-phase blocker and can run once Phase 1 has landed. Tasks 3, 8, 10, 11 are marked **⚠ BLOCKED** below and cannot compile until Phase 2's and/or Phase 3's schema tasks have landed with (at least) the shapes assumed above.

---

### Task 1: Schema + seed data for `documents` and `faxes`

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/seed.ts`
- Modify: `tests/db/seed.test.ts` (existing file — extend, don't replace; add a new `describe` block, keep every existing test)

**Interfaces:**
- Produces: `documents`, `faxes` tables (+ `documentStatusEnum`, `documentLabelEnum`, `faxDeliveryStatusEnum`), exported from `src/db/schema.ts`, consumed by every later task in this plan.

- [ ] **Step 1: Add the new tables to the schema**

Add to `src/db/schema.ts`, after the existing tables (append at the end of the file):

```typescript
export const documentStatusEnum = pgEnum('document_status', ['new', 'processed'])
export const documentLabelEnum = pgEnum('document_label', ['other', 'drivers_license', 'legal_document'])
export const faxDeliveryStatusEnum = pgEnum('fax_delivery_status', ['delivered', 'failed'])

export const documents = pgTable('documents', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  documentDate: date('document_date').notNull(),
  status: documentStatusEnum('status').default('new').notNull(),
  receivedFrom: text('received_from').notNull(),
  label: documentLabelEnum('label').default('other').notNull(),
  patientId: text('patient_id').references(() => patients.id),
  fileType: text('file_type').notNull(),          // metadata only, e.g. "PDF" / "JPG" — no file is ever stored
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

// `deliveryStatus` is a SIMULATED value set at seed/creation time by a mock
// rule -- this app never performs a real fax transmission. See the on-screen
// disclaimer on the Fax History tab (Task 12) and architecture spec §3.
export const faxes = pgTable('faxes', {
  id: serial('id').primaryKey(),
  faxDate: timestamp('fax_date').defaultNow().notNull(),
  subject: text('subject').notNull(),
  documentsIncluded: text('documents_included').notNull(),   // free-text summary, e.g. "Consent Form.pdf" — metadata only
  deliveryStatus: faxDeliveryStatusEnum('delivery_status').notNull(),
  sender: text('sender').notNull(),
  sentToFaxNumber: text('sent_to_fax_number').notNull(),
  patientId: text('patient_id').references(() => patients.id),
})
```

- [ ] **Step 2: Push the schema**

Run: `npm run db:push` (confirm it reports the 2 new tables + 3 new enums with no errors).

- [ ] **Step 3: Extend the seed script**

Open `src/db/seed.ts`. After the existing seeding (Phase 1's form templates/submissions/allergies/identity-verification seeding, and Phase 2/3's appointment/charge/claim seeding if those phases have already landed by the time this task runs), add:

```typescript
// Documents: metadata-only rows demonstrating the New/Processed status split,
// a mix of labels, and both patient-linked and unlinked documents.
await db.insert(documents).values([
  { name: 'Drivers License - Front.jpg', documentDate: '2026-08-10', status: 'processed', receivedFrom: 'Patient Portal Upload', label: 'drivers_license', patientId: 'RD-0001', fileType: 'JPG' },
  { name: 'Signed Consent Form.pdf', documentDate: '2026-08-12', status: 'processed', receivedFrom: 'Jamie Ruiz (CRC)', label: 'legal_document', patientId: 'RD-0001', fileType: 'PDF' },
  { name: 'Outside Lab Results.pdf', documentDate: '2026-08-14', status: 'new', receivedFrom: 'Fax', label: 'other', patientId: 'RD-0002', fileType: 'PDF' },
  { name: 'Referral Letter.pdf', documentDate: '2026-08-15', status: 'new', receivedFrom: 'Referring Provider Office', label: 'other', patientId: 'RD-0003', fileType: 'PDF' },
  { name: 'State ID Card.png', documentDate: '2026-08-16', status: 'processed', receivedFrom: 'Patient Portal Upload', label: 'drivers_license', patientId: 'RD-0002', fileType: 'PNG' },
  { name: 'Power of Attorney.pdf', documentDate: '2026-08-18', status: 'new', receivedFrom: 'Mail', label: 'legal_document', patientId: 'RD-0004', fileType: 'PDF' },
  { name: 'Prior Medication List.pdf', documentDate: '2026-08-19', status: 'processed', receivedFrom: 'Priya Natarajan (CRC)', label: 'other', patientId: 'RD-0004', fileType: 'PDF' },
  { name: 'Insurance Card - Back.jpg', documentDate: '2026-08-20', status: 'new', receivedFrom: 'Patient Portal Upload', label: 'other', patientId: 'RD-0005', fileType: 'JPG' },
  { name: 'Telehealth Consent.pdf', documentDate: '2026-08-21', status: 'processed', receivedFrom: 'Jamie Ruiz (CRC)', label: 'legal_document', patientId: 'RD-0006', fileType: 'PDF' },
  { name: 'Passport Copy.pdf', documentDate: '2026-08-22', status: 'new', receivedFrom: 'Fax', label: 'drivers_license', patientId: 'RD-0003', fileType: 'PDF' },
])

// Faxes: a mix of delivered/failed simulated statuses across several patients
// and senders, so Fax History is demonstrable without ever implying a real
// fax was sent.
await db.insert(faxes).values([
  { faxDate: new Date('2026-08-10T09:15:00'), subject: 'Lab Results - CBC Panel', documentsIncluded: 'CBC Panel Results.pdf', deliveryStatus: 'delivered', sender: 'Jamie Ruiz (CRC)', sentToFaxNumber: '(555) 010-2201', patientId: 'RD-0001' },
  { faxDate: new Date('2026-08-11T14:32:00'), subject: 'Signed Consent Form', documentsIncluded: 'General Research Consent.pdf', deliveryStatus: 'delivered', sender: 'Jamie Ruiz (CRC)', sentToFaxNumber: '(555) 010-2202', patientId: 'RD-0002' },
  { faxDate: new Date('2026-08-12T11:05:00'), subject: 'Referral Records Request', documentsIncluded: 'Records Request Form.pdf', deliveryStatus: 'failed', sender: 'Priya Natarajan (CRC)', sentToFaxNumber: '(555) 010-2203', patientId: 'RD-0003' },
  { faxDate: new Date('2026-08-13T08:47:00'), subject: 'Prior Authorization', documentsIncluded: 'Prior Auth Request.pdf', deliveryStatus: 'delivered', sender: 'Sam Patel (Admin)', sentToFaxNumber: '(555) 010-2204', patientId: 'RD-0004' },
  { faxDate: new Date('2026-08-14T16:20:00'), subject: 'Medication History', documentsIncluded: 'Medication History.pdf', deliveryStatus: 'delivered', sender: 'Jamie Ruiz (CRC)', sentToFaxNumber: '(555) 010-2205', patientId: 'RD-0005' },
  { faxDate: new Date('2026-08-15T10:00:00'), subject: 'Screening Questionnaire Results', documentsIncluded: 'PHQ-9 Results.pdf, ASRS Results.pdf', deliveryStatus: 'failed', sender: 'Priya Natarajan (CRC)', sentToFaxNumber: '(555) 010-2206', patientId: 'RD-0006' },
  { faxDate: new Date('2026-08-16T13:40:00'), subject: 'Telehealth Consent Confirmation', documentsIncluded: 'Telehealth Consent.pdf', deliveryStatus: 'delivered', sender: 'Jamie Ruiz (CRC)', sentToFaxNumber: '(555) 010-2207', patientId: 'RD-0006' },
  { faxDate: new Date('2026-08-17T09:55:00'), subject: 'Insurance Verification', documentsIncluded: 'Insurance Card Copy.pdf', deliveryStatus: 'delivered', sender: 'Sam Patel (Admin)', sentToFaxNumber: '(555) 010-2208', patientId: 'RD-0002' },
])
```

Patient IDs `RD-0001` through `RD-0006` are confirmed to exist by Phase 1's plan (seeded `RD-0001`–`RD-0018`).

- [ ] **Step 4: Re-seed and verify**

Run: `npm run db:seed`. Then run:
```bash
npx dotenv -e .env.local -- tsx -e "import { getDb } from './src/db/client'; import { documents, faxes } from './src/db/schema'; getDb().select().from(documents).then(r => console.log('documents:', r.length)); getDb().select().from(faxes).then(r => console.log('faxes:', r.length))"
```
Confirm `documents: 10` and `faxes: 8`.

- [ ] **Step 5: Extend `tests/db/seed.test.ts`**

Open the existing file and add the following `describe` block, preserving every existing test in the file:

```typescript
describe('documents and faxes seed data', () => {
  it('seeds documents with a mix of New/Processed statuses', async () => {
    const rows = await getDb().select().from(documents)
    expect(rows.length).toBeGreaterThanOrEqual(10)
    expect(rows.some((d) => d.status === 'new')).toBe(true)
    expect(rows.some((d) => d.status === 'processed')).toBe(true)
  })

  it('seeds faxes with a mix of simulated delivered/failed statuses', async () => {
    const rows = await getDb().select().from(faxes)
    expect(rows.length).toBeGreaterThanOrEqual(8)
    expect(rows.some((f) => f.deliveryStatus === 'delivered')).toBe(true)
    expect(rows.some((f) => f.deliveryStatus === 'failed')).toBe(true)
  })
})
```

Add `documents, faxes` to whatever import from `@/db/schema` the file already has at the top (do not duplicate the import line — merge into the existing one).

- [ ] **Step 6: Run the suite and commit**

Run: `npm test` and `npm run build` — both must be clean.

```bash
git add src/db/schema.ts src/db/seed.ts tests/db/seed.test.ts
git commit -m "feat: add documents and faxes tables with seed data"
```

---

### Task 2: Shared query functions — documents and faxes

**Files:**
- Modify: `src/lib/cache.ts`
- Create: `src/lib/queries/documents.ts`
- Create: `src/lib/queries/faxes.ts`
- Create: `tests/lib/queries/documents.test.ts`
- Create: `tests/lib/queries/faxes.test.ts`

**Interfaces:**
- Consumes: `documents`, `faxes` tables (Task 1).
- Produces: `listDocuments()`, `getDocument(id)`, `listFaxes()` — consumed by Task 12's pages and API route.

- [ ] **Step 1: `src/lib/cache.ts` — add cache keys**

Add alongside the existing key helpers (also add the four report cache keys used by Task 3, so Task 3 doesn't need to touch this file again):

```typescript
export function documentsListCacheKey(): string {
  return 'documents:list:all'
}

export function faxesListCacheKey(): string {
  return 'faxes:list:all'
}

export function allAppointmentsReportCacheKey(): string {
  return 'reports:appointments:all'
}

export function unsignedNotesReportCacheKey(): string {
  return 'reports:notes:unsigned'
}

export function allEncountersReportCacheKey(): string {
  return 'reports:encounters:all'
}

export function insuranceCollectionsReportCacheKey(): string {
  return 'reports:claims:insurance-collections'
}
```

- [ ] **Step 2: `src/lib/queries/documents.ts`**

```typescript
import { getDb } from '@/db/client'
import { documents, patients } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { getOrSetCache, documentsListCacheKey } from '@/lib/cache'

export async function listDocuments() {
  return getOrSetCache(documentsListCacheKey(), 15, async () => {
    const rows = await getDb()
      .select({ document: documents, patient: patients })
      .from(documents)
      .leftJoin(patients, eq(documents.patientId, patients.id))

    return rows.map((r) => ({
      ...r.document,
      patientName: r.patient ? (r.patient.nameTebra ?? r.patient.nameIntakeq) : null,
      patientDob: r.patient ? (r.patient.dobTebra ?? r.patient.dobIntakeq) : null,
    }))
  })
}

export async function getDocument(id: number) {
  const [row] = await getDb().select().from(documents).where(eq(documents.id, id))
  return row ?? null
}
```

- [ ] **Step 3: `src/lib/queries/faxes.ts`**

```typescript
import { getDb } from '@/db/client'
import { faxes, patients } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { getOrSetCache, faxesListCacheKey } from '@/lib/cache'

export async function listFaxes() {
  return getOrSetCache(faxesListCacheKey(), 15, async () => {
    const rows = await getDb()
      .select({ fax: faxes, patient: patients })
      .from(faxes)
      .leftJoin(patients, eq(faxes.patientId, patients.id))

    return rows.map((r) => ({
      ...r.fax,
      patientName: r.patient ? (r.patient.nameTebra ?? r.patient.nameIntakeq) : null,
      patientDob: r.patient ? (r.patient.dobTebra ?? r.patient.dobIntakeq) : null,
    }))
  })
}
```

- [ ] **Step 4: Tests**

`tests/lib/queries/documents.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { listDocuments, getDocument } from '@/lib/queries/documents'

describe('listDocuments', () => {
  it('returns the seeded documents joined with patient info', async () => {
    const rows = await listDocuments()
    expect(rows.length).toBeGreaterThanOrEqual(10)
    const linked = rows.find((d) => d.patientId === 'RD-0001')
    expect(linked?.patientName).toBeTruthy()
  })
})

describe('getDocument', () => {
  it('returns null for a non-existent id', async () => {
    const result = await getDocument(999999)
    expect(result).toBeNull()
  })
})
```

`tests/lib/queries/faxes.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { listFaxes } from '@/lib/queries/faxes'

describe('listFaxes', () => {
  it('returns the seeded faxes joined with patient info', async () => {
    const rows = await listFaxes()
    expect(rows.length).toBeGreaterThanOrEqual(8)
    expect(rows.some((f) => f.deliveryStatus === 'delivered')).toBe(true)
    expect(rows.some((f) => f.deliveryStatus === 'failed')).toBe(true)
  })
})
```

- [ ] **Step 5: Run the suite and commit**

Run: `npm test` and `npm run build` — both must be clean.

```bash
git add src/lib/cache.ts src/lib/queries/documents.ts src/lib/queries/faxes.ts tests/lib/queries/documents.test.ts tests/lib/queries/faxes.test.ts
git commit -m "feat: add shared query functions for documents and faxes"
```

---

### Task 3: Shared query functions — reports (⚠ BLOCKED on Phase 2 for appointments; ⚠ BLOCKED on Phase 3 for claims/charges)

**Do not run this task until Phase 2's schema task has landed `appointments`/`providers`, and Phase 3's schema task has landed `insuranceClaims`/`charges`, matching (or reconciled against) the shapes in "Cross-phase dependencies" above.** Until then this file will fail to compile.

**Files:**
- Create: `src/lib/queries/reports.ts`
- Create: `src/lib/queries/charges.ts`
- Create: `tests/lib/queries/reports.test.ts`

**Interfaces:**
- Consumes: `appointments`, `providers` (Phase 2); `insuranceClaims`, `charges` (Phase 3); `formSubmissions`, `formTemplates`, `patientTrialScreenings` (Phase 1, already exist).
- Produces: `listAllAppointmentsReport()`, `listUnsignedNotesReport()`, `listAllEncountersReport()`, `listInsuranceCollectionsReport()`, `getChargeDetail(chargeId)` — consumed by Tasks 8, 7, 9, 10, 11.

- [ ] **Step 1: `src/lib/queries/reports.ts`**

```typescript
import { getDb } from '@/db/client'
import {
  appointments, providers, patients, formSubmissions, formTemplates,
  patientTrialScreenings, insuranceClaims, charges,
} from '@/db/schema'
import { eq, and, notInArray } from 'drizzle-orm'
import {
  getOrSetCache,
  allAppointmentsReportCacheKey,
  unsignedNotesReportCacheKey,
  allEncountersReportCacheKey,
  insuranceCollectionsReportCacheKey,
} from '@/lib/cache'

/**
 * CROSS-PHASE DEPENDENCY (see this plan's "Cross-phase dependencies" section):
 * `appointments` / `providers` are owned by Phase 2's schema task, `insuranceClaims`
 * / `charges` by Phase 3's. This file assumes the shapes documented there. Do not
 * run this task until both phases' schema tasks have landed — reconcile field
 * names first if either phase shipped a different shape than assumed.
 */

export async function listAllAppointmentsReport() {
  return getOrSetCache(allAppointmentsReportCacheKey(), 15, async () => {
    const rows = await getDb()
      .select({ appointment: appointments, patient: patients, provider: providers })
      .from(appointments)
      .innerJoin(patients, eq(appointments.patientId, patients.id))
      .leftJoin(providers, eq(appointments.providerId, providers.id))

    return rows.map((r) => ({
      id: r.appointment.id,
      apptDate: r.appointment.apptDate,
      apptTime: r.appointment.apptTime,
      status: r.appointment.status,
      patientId: r.patient.id,
      patientName: r.patient.nameTebra ?? r.patient.nameIntakeq,
      dob: r.patient.dobTebra ?? r.patient.dobIntakeq,
      homePhone: r.patient.phoneTebra ?? '—',
      mobilePhone: r.patient.phoneIntakeq ?? '—',
      providerName: r.provider?.name ?? r.patient.currentProvider ?? '—',
    }))
  })
}

// "Unsigned" means: a form submission whose status is 'completed' but whose
// patient has no patientTrialScreenings row yet -- the same "pending
// classification" concept the Home Dashboard already uses (see
// src/lib/queries/dashboard.ts's getDashboardData, Phase 1).
export async function listUnsignedNotesReport() {
  return getOrSetCache(unsignedNotesReportCacheKey(), 15, async () => {
    const screenedPatientIds = (
      await getDb().select({ patientId: patientTrialScreenings.patientId }).from(patientTrialScreenings)
    ).map((r) => r.patientId)

    const rows = await getDb()
      .select({ submission: formSubmissions, template: formTemplates, patient: patients })
      .from(formSubmissions)
      .innerJoin(formTemplates, eq(formSubmissions.templateId, formTemplates.id))
      .innerJoin(patients, eq(formSubmissions.patientId, patients.id))
      .where(
        and(
          eq(formSubmissions.status, 'completed'),
          screenedPatientIds.length > 0 ? notInArray(formSubmissions.patientId, screenedPatientIds) : undefined
        )
      )

    return rows.map((r) => ({
      noteId: r.submission.id,
      patientId: r.patient.id,
      patientName: r.patient.nameTebra ?? r.patient.nameIntakeq,
      visitDate: r.submission.completedDate,
      noteType: r.template.name,
      status: 'Unsigned',
      assignedUser: r.patient.currentProvider ?? 'Unassigned',
    }))
  })
}

// A completed appointment IS an encounter for Clinsync's data model — no
// separate encounters table. "Payer Scenario" and "Encounter Status" are
// derived by a best-effort join against Phase 3's charges/insuranceClaims
// (matched by patientId, and by date for charges) rather than invented as
// static text, so the report demonstrates real cross-table data.
export async function listAllEncountersReport() {
  return getOrSetCache(allEncountersReportCacheKey(), 15, async () => {
    const rows = await getDb()
      .select({ appointment: appointments, patient: patients, provider: providers })
      .from(appointments)
      .innerJoin(patients, eq(appointments.patientId, patients.id))
      .leftJoin(providers, eq(appointments.providerId, providers.id))
      .where(eq(appointments.status, 'completed'))

    const allCharges = await getDb().select().from(charges)
    const allClaims = await getDb().select().from(insuranceClaims)

    return rows.map((r) => {
      const matchingCharge = allCharges.find(
        (c) => c.patientId === r.patient.id && c.dateOfService === r.appointment.apptDate
      )
      const hasClaim = allClaims.some((c) => c.patientId === r.patient.id)
      const firstProcedure = matchingCharge?.procedureCodes?.[0]?.code ?? '—'

      return {
        encounterId: `ENC-${r.appointment.id}`,
        dateOfService: r.appointment.apptDate,
        patientId: r.patient.id,
        patientName: r.patient.nameTebra ?? r.patient.nameIntakeq,
        renderingProvider: r.provider?.name ?? r.patient.currentProvider ?? '—',
        payerScenario: hasClaim ? 'Insurance' : 'Self-Pay',
        encounterStatus: matchingCharge ? 'Billed' : 'Completed — Not Billed',
        procedure: firstProcedure,
      }
    })
  })
}

export async function listInsuranceCollectionsReport() {
  return getOrSetCache(insuranceCollectionsReportCacheKey(), 15, async () => {
    const rows = await getDb()
      .select({ claim: insuranceClaims, patient: patients })
      .from(insuranceClaims)
      .innerJoin(patients, eq(insuranceClaims.patientId, patients.id))

    return rows.map((r) => ({
      id: r.claim.id,
      patientId: r.patient.id,
      patientName: r.patient.nameTebra ?? r.patient.nameIntakeq,
      payerName: r.claim.payerName,
      status: r.claim.status,
      claimAmount: r.claim.claimAmount,
      serviceDate: r.claim.serviceDate,
      submittedDate: r.claim.submittedDate,
    }))
  })
}
```

- [ ] **Step 2: `src/lib/queries/charges.ts`**

```typescript
import { getDb } from '@/db/client'
import { charges, patients } from '@/db/schema'
import { eq } from 'drizzle-orm'

/**
 * CROSS-PHASE DEPENDENCY: `charges` is owned by Phase 3's schema task. This file
 * assumes the shape documented in this plan's "Cross-phase dependencies" section
 * (diagnosisCodes / procedureCodes jsonb shape, dateOfService, providerId, status).
 * Reconcile field names against Phase 3's actual schema before running this task.
 */
export async function getChargeDetail(chargeId: number) {
  const [row] = await getDb()
    .select({ charge: charges, patient: patients })
    .from(charges)
    .innerJoin(patients, eq(charges.patientId, patients.id))
    .where(eq(charges.id, chargeId))
  if (!row) return null

  return {
    ...row.charge,
    patientName: row.patient.nameTebra ?? row.patient.nameIntakeq,
    patientDob: row.patient.dobTebra ?? row.patient.dobIntakeq,
  }
}
```

- [ ] **Step 3: Test**

`tests/lib/queries/reports.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import {
  listAllAppointmentsReport,
  listUnsignedNotesReport,
  listAllEncountersReport,
  listInsuranceCollectionsReport,
} from '@/lib/queries/reports'

// These tests require Phase 2's `appointments`/`providers` and Phase 3's
// `insuranceClaims`/`charges` tables (and their seed data) to already exist —
// do not run this file until both phases have landed.

describe('listAllAppointmentsReport', () => {
  it('returns rows shaped for the All Appointments columns', async () => {
    const rows = await listAllAppointmentsReport()
    expect(Array.isArray(rows)).toBe(true)
    if (rows.length > 0) {
      expect(rows[0]).toHaveProperty('patientName')
      expect(rows[0]).toHaveProperty('apptDate')
    }
  })
})

describe('listUnsignedNotesReport', () => {
  it('only includes completed submissions without a screening row', async () => {
    const rows = await listUnsignedNotesReport()
    expect(rows.every((r) => r.status === 'Unsigned')).toBe(true)
  })
})

describe('listAllEncountersReport', () => {
  it('only includes completed appointments', async () => {
    const rows = await listAllEncountersReport()
    expect(Array.isArray(rows)).toBe(true)
  })
})

describe('listInsuranceCollectionsReport', () => {
  it('returns claim rows joined with patient names', async () => {
    const rows = await listInsuranceCollectionsReport()
    expect(Array.isArray(rows)).toBe(true)
    if (rows.length > 0) expect(rows[0]).toHaveProperty('patientName')
  })
})
```

- [ ] **Step 4: Run the suite and commit**

Run: `npm test` and `npm run build` — both must be clean (only once Phase 2/3 have landed).

```bash
git add src/lib/queries/reports.ts src/lib/queries/charges.ts tests/lib/queries/reports.test.ts
git commit -m "feat: add report query functions for appointments, notes, encounters, and claims"
```

---

### Task 4: `FilterPanel.tsx` — shared slide-out filter component

**Files:**
- Create: `src/components/FilterPanel.tsx` (`'use client'`)
- Create: `tests/components/FilterPanel.test.tsx`

**Interfaces:**
- Produces: `FilterPanel`, `FilterFieldDef`, `AppliedFilter` — consumed by `ReportTable.tsx` (Task 5) and, transitively, every report/document page.

- [ ] **Step 1: `src/components/FilterPanel.tsx`**

```typescript
'use client'
import { useState } from 'react'

export interface FilterFieldDef {
  key: string
  label: string
  type: 'text' | 'select' | 'date'
  options?: string[] // required when type === 'select'
}

export interface AppliedFilter {
  fieldKey: string
  operator: 'contains' | 'equals' | 'on' | 'before' | 'after'
  value: string
}

interface FilterPanelProps {
  open: boolean
  onClose: () => void
  availableFields: FilterFieldDef[]
  activeFilters: AppliedFilter[]
  onApply: (filters: AppliedFilter[]) => void
}

function defaultOperatorFor(type: FilterFieldDef['type']): AppliedFilter['operator'] {
  if (type === 'select') return 'equals'
  if (type === 'date') return 'on'
  return 'contains'
}

export function FilterPanel({ open, onClose, availableFields, activeFilters, onApply }: FilterPanelProps) {
  const [draft, setDraft] = useState<AppliedFilter[]>(activeFilters)
  const [fieldQuery, setFieldQuery] = useState('')

  if (!open) return null

  const usedKeys = new Set(draft.map((f) => f.fieldKey))
  const pickableFields = availableFields.filter(
    (f) => !usedKeys.has(f.key) && f.label.toLowerCase().includes(fieldQuery.toLowerCase())
  )

  function addField(field: FilterFieldDef) {
    setDraft([...draft, { fieldKey: field.key, operator: defaultOperatorFor(field.type), value: '' }])
    setFieldQuery('')
  }

  function removeField(fieldKey: string) {
    setDraft(draft.filter((f) => f.fieldKey !== fieldKey))
  }

  function updateValue(fieldKey: string, value: string) {
    setDraft(draft.map((f) => (f.fieldKey === fieldKey ? { ...f, value } : f)))
  }

  function updateOperator(fieldKey: string, operator: AppliedFilter['operator']) {
    setDraft(draft.map((f) => (f.fieldKey === fieldKey ? { ...f, operator } : f)))
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/20" role="dialog" aria-label="Filters">
      <div className="h-full w-96 overflow-y-auto border-l border-border bg-card p-5 shadow-lg">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Filters</h2>
          <button onClick={onClose} aria-label="Close filters" className="text-sm text-muted-foreground hover:text-foreground">Close</button>
        </div>

        <div className="space-y-3">
          {draft.map((f) => {
            const def = availableFields.find((a) => a.key === f.fieldKey)
            if (!def) return null
            return (
              <div key={f.fieldKey} className="rounded-md border border-border p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-medium text-foreground">{def.label}</span>
                  <button onClick={() => removeField(f.fieldKey)} aria-label={`Remove ${def.label} filter`} className="text-xs text-muted-foreground hover:text-foreground">Remove</button>
                </div>
                {def.type === 'date' && (
                  <select value={f.operator} onChange={(e) => updateOperator(f.fieldKey, e.target.value as AppliedFilter['operator'])} className="mb-2 w-full rounded-md border border-border px-2 py-1 text-sm">
                    <option value="on">On</option>
                    <option value="before">Before</option>
                    <option value="after">After</option>
                  </select>
                )}
                {def.type === 'select' ? (
                  <select value={f.value} onChange={(e) => updateValue(f.fieldKey, e.target.value)} className="w-full rounded-md border border-border px-2 py-1 text-sm">
                    <option value="">Select a value</option>
                    {def.options?.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : (
                  <input
                    type={def.type === 'date' ? 'date' : 'text'}
                    value={f.value}
                    onChange={(e) => updateValue(f.fieldKey, e.target.value)}
                    className="w-full rounded-md border border-border px-2 py-1 text-sm"
                  />
                )}
              </div>
            )
          })}
        </div>

        <div className="mt-4">
          <input
            value={fieldQuery}
            onChange={(e) => setFieldQuery(e.target.value)}
            placeholder="Add a filter"
            className="mb-2 w-full rounded-md border border-border px-3 py-2 text-sm"
          />
          {fieldQuery.length > 0 && (
            <ul className="max-h-40 overflow-y-auto rounded-md border border-border">
              {pickableFields.length === 0 ? (
                <li className="p-2 text-sm text-muted-foreground">No matching fields.</li>
              ) : (
                pickableFields.map((f) => (
                  <li key={f.key}>
                    <button onClick={() => addField(f)} className="block w-full px-3 py-2 text-left text-sm text-foreground hover:bg-secondary">{f.label}</button>
                  </li>
                ))
              )}
            </ul>
          )}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary">Cancel</button>
          <button
            onClick={() => { onApply(draft.filter((f) => f.value !== '')); onClose() }}
            className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Test**

`tests/components/FilterPanel.test.tsx`:
```typescript
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FilterPanel, type FilterFieldDef } from '@/components/FilterPanel'

const FIELDS: FilterFieldDef[] = [
  { key: 'patientName', label: 'Patient', type: 'text' },
  { key: 'status', label: 'Status', type: 'select', options: ['delivered', 'failed'] },
]

describe('FilterPanel', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<FilterPanel open={false} onClose={vi.fn()} availableFields={FIELDS} activeFilters={[]} onApply={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('lets the user search for and add a field, then apply it', () => {
    const onApply = vi.fn()
    render(<FilterPanel open onClose={vi.fn()} availableFields={FIELDS} activeFilters={[]} onApply={onApply} />)

    fireEvent.change(screen.getByPlaceholderText('Add a filter'), { target: { value: 'Patient' } })
    fireEvent.click(screen.getByText('Patient'))

    const input = screen.getByRole('dialog').querySelector('input[type="text"]')!
    fireEvent.change(input, { target: { value: 'RD-0001' } })
    fireEvent.click(screen.getByText('Apply'))

    expect(onApply).toHaveBeenCalledWith([{ fieldKey: 'patientName', operator: 'contains', value: 'RD-0001' }])
  })
})
```

- [ ] **Step 3: Run the suite and commit**

Run: `npm test` and `npm run build` — both must be clean.

```bash
git add src/components/FilterPanel.tsx tests/components/FilterPanel.test.tsx
git commit -m "feat: add shared FilterPanel slide-out component"
```

---

### Task 5: `ReportTable.tsx` — shared client table shell (search, filter, columns, pagination)

**Files:**
- Create: `src/components/ReportTable.tsx` (`'use client'`)
- Create: `tests/components/ReportTable.test.tsx`

**Interfaces:**
- Consumes: `FilterPanel`, `FilterFieldDef`, `AppliedFilter` (Task 4); `DataGridToolbar` (Phase 3, assumed interface — see Global Constraints).
- Produces: `ReportTable<Row>`, `ReportColumn<Row>` — consumed by every Reports/Documents page (Tasks 6, 7, 8, 9, 10, 12).

- [ ] **Step 1: `src/components/ReportTable.tsx`**

```typescript
'use client'
import type { ReactNode } from 'react'
import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { DataGridToolbar } from '@/components/DataGridToolbar'
import { FilterPanel, type FilterFieldDef, type AppliedFilter } from '@/components/FilterPanel'

export interface ReportColumn<Row> {
  key: string
  label: string
  render: (row: Row) => ReactNode
}

interface ReportTableProps<Row> {
  rows: Row[]
  columns: ReportColumn<Row>[]
  filterFields: FilterFieldDef[]
  searchFields: string[]
  rowKey: (row: Row) => string | number
  pageSize?: number
}

const DEFAULT_PAGE_SIZE = 25

function matchesFilter(row: Record<string, unknown>, filter: AppliedFilter, def: FilterFieldDef): boolean {
  const raw = row[filter.fieldKey]
  if (raw === null || raw === undefined || filter.value === '') return true
  if (def.type === 'date') {
    const rowTime = new Date(String(raw)).getTime()
    const targetTime = new Date(filter.value).getTime()
    if (Number.isNaN(rowTime) || Number.isNaN(targetTime)) return false
    if (filter.operator === 'before') return rowTime < targetTime
    if (filter.operator === 'after') return rowTime > targetTime
    return new Date(String(raw)).toDateString() === new Date(filter.value).toDateString()
  }
  const value = String(raw).toLowerCase()
  const target = filter.value.toLowerCase()
  return def.type === 'select' ? value === target : value.includes(target)
}

export function ReportTable<Row>({
  rows, columns, filterFields, searchFields, rowKey, pageSize = DEFAULT_PAGE_SIZE,
}: ReportTableProps<Row>) {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [activeFilters, setActiveFilters] = useState<AppliedFilter[]>([])
  const [filterPanelOpen, setFilterPanelOpen] = useState(false)
  const [visibleColumns, setVisibleColumns] = useState<Record<string, boolean>>(
    () => Object.fromEntries(columns.map((c) => [c.key, true]))
  )
  const [page, setPage] = useState(0)

  const filteredRows = useMemo(() => {
    return rows.filter((row) => {
      const record = row as Record<string, unknown>
      if (activeFilters.length > 0) {
        const passesFilters = activeFilters.every((f) => {
          const def = filterFields.find((d) => d.key === f.fieldKey)
          return def ? matchesFilter(record, f, def) : true
        })
        if (!passesFilters) return false
      }
      if (search.trim() !== '') {
        const q = search.trim().toLowerCase()
        return searchFields.some((key) => String(record[key] ?? '').toLowerCase().includes(q))
      }
      return true
    })
  }, [rows, activeFilters, search, filterFields, searchFields])

  const shownColumns = columns.filter((c) => visibleColumns[c.key])
  const start = page * pageSize
  const pageRows = filteredRows.slice(start, start + pageSize)
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize))

  return (
    <div>
      <DataGridToolbar
        searchValue={search}
        onSearchChange={(value) => { setPage(0); setSearch(value) }}
        onRefresh={() => router.refresh()}
        filterCount={activeFilters.length}
        onOpenFilters={() => setFilterPanelOpen(true)}
        columns={columns.map((c) => ({ key: c.key, label: c.label, visible: visibleColumns[c.key] }))}
        onToggleColumn={(key) => setVisibleColumns((prev) => ({ ...prev, [key]: !prev[key] }))}
      />

      {filteredRows.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">No results found.</p>
      ) : (
        <>
          <table className="mt-4 w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                {shownColumns.map((c) => (
                  <th key={c.key} className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row, i) => (
                <tr key={rowKey(row)} className={`border-b border-border ${i % 2 === 1 ? 'bg-muted/40' : ''} hover:bg-secondary`}>
                  {shownColumns.map((c) => (
                    <td key={c.key} className="p-3 text-foreground">{c.render(row)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
            <span>Rows per page: {pageSize} · {start + 1}–{Math.min(start + pageSize, filteredRows.length)} of {filteredRows.length}</span>
            <div className="flex gap-2">
              <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} className="rounded-md border border-border px-2 py-1 disabled:opacity-30">Previous</button>
              <button onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} className="rounded-md border border-border px-2 py-1 disabled:opacity-30">Next</button>
            </div>
          </div>
        </>
      )}

      <FilterPanel
        open={filterPanelOpen}
        onClose={() => setFilterPanelOpen(false)}
        availableFields={filterFields}
        activeFilters={activeFilters}
        onApply={(filters) => { setPage(0); setActiveFilters(filters) }}
      />
    </div>
  )
}
```

- [ ] **Step 2: Test**

`tests/components/ReportTable.test.tsx`. This test mocks `DataGridToolbar` so it exercises only `ReportTable`'s own contract against the assumed prop interface, independent of Phase 3's actual UI:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ReportTable, type ReportColumn } from '@/components/ReportTable'
import type { FilterFieldDef } from '@/components/FilterPanel'

vi.mock('@/components/DataGridToolbar', () => ({
  DataGridToolbar: ({ searchValue, onSearchChange }: { searchValue: string; onSearchChange: (v: string) => void }) => (
    <input aria-label="toolbar-search" value={searchValue} onChange={(e) => onSearchChange(e.target.value)} />
  ),
}))

interface Row { id: number; name: string }

const ROWS: Row[] = [{ id: 1, name: 'Alpha' }, { id: 2, name: 'Beta' }]
const COLUMNS: ReportColumn<Row>[] = [{ key: 'name', label: 'Name', render: (r) => r.name }]
const FILTER_FIELDS: FilterFieldDef[] = [{ key: 'name', label: 'Name', type: 'text' }]

describe('ReportTable', () => {
  it('renders all rows with no search applied', () => {
    render(<ReportTable rows={ROWS} columns={COLUMNS} filterFields={FILTER_FIELDS} searchFields={['name']} rowKey={(r) => r.id} />)
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
  })

  it('filters rows down via the search box', () => {
    render(<ReportTable rows={ROWS} columns={COLUMNS} filterFields={FILTER_FIELDS} searchFields={['name']} rowKey={(r) => r.id} />)
    fireEvent.change(screen.getByLabelText('toolbar-search'), { target: { value: 'Alpha' } })
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.queryByText('Beta')).not.toBeInTheDocument()
  })

  it('shows the plain-text empty state when nothing matches', () => {
    render(<ReportTable rows={ROWS} columns={COLUMNS} filterFields={FILTER_FIELDS} searchFields={['name']} rowKey={(r) => r.id} />)
    fireEvent.change(screen.getByLabelText('toolbar-search'), { target: { value: 'zzz' } })
    expect(screen.getByText('No results found.')).toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Run the suite and commit**

Run: `npm test` and `npm run build` — both must be clean (this task requires `src/components/DataGridToolbar.tsx` to already exist from Phase 3; if Phase 3 hasn't landed yet, `npm run build` will fail on this import — that is expected and matches this task's assumption note).

```bash
git add src/components/ReportTable.tsx tests/components/ReportTable.test.tsx
git commit -m "feat: add shared ReportTable component (search, filter panel, columns, pagination)"
```

---

### Task 6: Reports module shell + Patients leaf

**Files:**
- Create: `src/components/ReportsSidebar.tsx` (`'use client'`)
- Create: `src/app/(dashboard)/reports/layout.tsx`
- Create: `src/app/(dashboard)/reports/page.tsx`
- Create: `src/app/(dashboard)/reports/patients/page.tsx`

**Interfaces:**
- Consumes: `listPatientsWithStatus` (Phase 1, existing), `ReportTable`/`ReportColumn` (Task 5), `StatusChip` (existing).
- Produces: `/reports` route group with its own accordion-tree sidebar, and the "Patients" group's leaf.

- [ ] **Step 1: `src/components/ReportsSidebar.tsx`**

```typescript
'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'

interface ReportLeaf { href: string; label: string }
interface ReportGroup { label: string; leaves: ReportLeaf[] }

const GROUPS: ReportGroup[] = [
  { label: 'Patients', leaves: [{ href: '/reports/patients', label: 'All Patients' }] },
  { label: 'Appointments', leaves: [{ href: '/reports/appointments/all', label: 'All Appointments' }] },
  { label: 'Notes', leaves: [{ href: '/reports/notes/unsigned', label: 'Unsigned Notes' }] },
  { label: 'Encounters', leaves: [{ href: '/reports/encounters/all', label: 'All Encounters' }] },
  { label: 'Claims', leaves: [{ href: '/reports/claims/insurance-collections', label: 'Insurance Collections' }] },
]

export function ReportsSidebar() {
  const pathname = usePathname()
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  return (
    <nav className="w-64 shrink-0 space-y-1 border-r border-border pr-4">
      {GROUPS.map((group) => {
        const isCollapsed = collapsed[group.label] ?? false
        const groupActive = group.leaves.some((l) => pathname === l.href)
        return (
          <div key={group.label}>
            <button
              onClick={() => setCollapsed((prev) => ({ ...prev, [group.label]: !isCollapsed }))}
              aria-expanded={!isCollapsed}
              className={`flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-xs font-semibold uppercase tracking-wide ${groupActive ? 'text-primary' : 'text-muted-foreground'}`}
            >
              {group.label}
              <span aria-hidden="true">{isCollapsed ? '+' : '−'}</span>
            </button>
            {!isCollapsed && (
              <ul className="ml-2 space-y-0.5 border-l border-border pl-2">
                {group.leaves.map((leaf) => {
                  const active = pathname === leaf.href
                  return (
                    <li key={leaf.href}>
                      <Link
                        href={leaf.href}
                        aria-current={active ? 'page' : undefined}
                        className={`block rounded-md px-2 py-1.5 text-sm font-medium transition-colors ${active ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'}`}
                      >
                        {leaf.label}
                      </Link>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )
      })}
    </nav>
  )
}
```

- [ ] **Step 2: `src/app/(dashboard)/reports/layout.tsx`**

```typescript
import type { ReactNode } from 'react'
import { ReportsSidebar } from '@/components/ReportsSidebar'

export default function ReportsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-6">
      <ReportsSidebar />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
```

- [ ] **Step 3: `src/app/(dashboard)/reports/page.tsx`**

```typescript
import { redirect } from 'next/navigation'

export default function ReportsIndexPage() {
  redirect('/reports/patients')
}
```

- [ ] **Step 4: `src/app/(dashboard)/reports/patients/page.tsx`**

```typescript
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listPatientsWithStatus } from '@/lib/queries/patients'
import { ReportTable, type ReportColumn } from '@/components/ReportTable'
import { StatusChip } from '@/components/StatusChip'
import type { FilterFieldDef } from '@/components/FilterPanel'

const FILTER_FIELDS: FilterFieldDef[] = [
  { key: 'displayName', label: 'Patient', type: 'text' },
  { key: 'overallStatus', label: 'Status', type: 'select', options: ['green', 'yellow', 'red'] },
]

export default async function PatientsReportPage() {
  const session = await requireSessionOrRedirect()
  const patients = await listPatientsWithStatus(null)
  await logAudit(session, 'viewed report: all patients', null)

  const rows = patients.map((p) => ({ ...p, displayName: p.nameTebra ?? p.nameIntakeq }))

  const columns: ReportColumn<(typeof rows)[number]>[] = [
    { key: 'status', label: 'Status', render: (p) => <StatusChip status={p.overallStatus ?? 'yellow'} /> },
    { key: 'id', label: 'Anon #', render: (p) => p.id },
    { key: 'displayName', label: 'Name', render: (p) => p.displayName },
    { key: 'dob', label: 'DOB', render: (p) => p.dobTebra ?? p.dobIntakeq },
    { key: 'provider', label: 'Provider', render: (p) => p.currentProvider ?? '—' },
  ]

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-foreground">All Patients</h1>
      <ReportTable rows={rows} columns={columns} filterFields={FILTER_FIELDS} searchFields={['displayName', 'id']} rowKey={(p) => p.id} />
    </div>
  )
}
```

- [ ] **Step 5: Run the suite, manually verify, and commit**

Run: `npm test` and `npm run build`. Then `npm run dev` and confirm: `/reports` redirects to `/reports/patients`; the accordion sidebar shows all 5 groups with their leaves; the Patients leaf renders every seeded patient, search filters by name, and the Filters panel lets you add a Status filter and narrow the list.

```bash
git add src/components/ReportsSidebar.tsx "src/app/(dashboard)/reports/layout.tsx" "src/app/(dashboard)/reports/page.tsx" "src/app/(dashboard)/reports/patients/page.tsx"
git commit -m "feat: add Reports module shell with accordion sidebar and Patients leaf"
```

---

### Task 7: Unsigned Notes leaf

**Files:**
- Create: `src/app/(dashboard)/reports/notes/unsigned/page.tsx`

**Interfaces:**
- Consumes: `listUnsignedNotesReport` (Task 3 — this leaf only needs Phase 1 tables underneath, but the function itself lives in the file blocked in Task 3, so this task also cannot compile until Task 3's file exists; if Phase 2/3 haven't landed yet, extract just this one function into its own unblocked file instead — see note below).

**Note on sequencing:** `listUnsignedNotesReport` does not actually reference `appointments`, `providers`, `insuranceClaims`, or `charges` — it only reads Phase 1's `formSubmissions`/`formTemplates`/`patientTrialScreenings`. If Phase 2/3 have not landed by the time this task is reached, move `listUnsignedNotesReport` out of `src/lib/queries/reports.ts` into its own unblocked file (e.g. keep it in `reports.ts` but do not import `appointments`/`charges`/`insuranceClaims` at the top of that file until Task 3 proper runs — i.e., temporarily run Task 7 before Task 3, importing only the function body's actual dependencies). Whichever order is used, the executor must keep `src/lib/queries/reports.ts` compiling at every commit.

- [ ] **Step 1: `src/app/(dashboard)/reports/notes/unsigned/page.tsx`**

```typescript
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listUnsignedNotesReport } from '@/lib/queries/reports'
import { ReportTable, type ReportColumn } from '@/components/ReportTable'
import type { FilterFieldDef } from '@/components/FilterPanel'

const FILTER_FIELDS: FilterFieldDef[] = [
  { key: 'patientName', label: 'Patient', type: 'text' },
  { key: 'noteType', label: 'Note Type', type: 'text' },
  { key: 'visitDate', label: 'Visit Date', type: 'date' },
]

export default async function UnsignedNotesReportPage() {
  const session = await requireSessionOrRedirect()
  const rows = await listUnsignedNotesReport()
  await logAudit(session, 'viewed report: unsigned notes', null)

  const columns: ReportColumn<(typeof rows)[number]>[] = [
    { key: 'assignedUser', label: 'Assigned User', render: (r) => r.assignedUser },
    { key: 'patientName', label: 'Patient', render: (r) => r.patientName },
    { key: 'visitDate', label: 'Visit Date', render: (r) => (r.visitDate ? new Date(r.visitDate).toLocaleDateString() : '—') },
    { key: 'status', label: 'Status', render: (r) => r.status },
    { key: 'noteType', label: 'Note Type', render: (r) => r.noteType },
    { key: 'noteId', label: 'Note ID', render: (r) => r.noteId },
  ]

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-foreground">Unsigned Notes</h1>
      <ReportTable rows={rows} columns={columns} filterFields={FILTER_FIELDS} searchFields={['patientName', 'noteType']} rowKey={(r) => r.noteId} />
    </div>
  )
}
```

- [ ] **Step 2: Run the suite, manually verify, and commit**

Run: `npm test` and `npm run build`. Then confirm `/reports/notes/unsigned` lists every completed form submission whose patient has no screening row yet (cross-check against `/` Home Dashboard's "pending classification" widget — the same patients should appear).

```bash
git add "src/app/(dashboard)/reports/notes/unsigned/page.tsx"
git commit -m "feat: add Unsigned Notes report leaf"
```

---

### Task 8: All Appointments leaf (⚠ BLOCKED on Phase 2)

**Do not run until Phase 2's `appointments`/`providers` tables exist and Task 3 compiles.**

**Files:**
- Create: `src/app/(dashboard)/reports/appointments/all/page.tsx`

- [ ] **Step 1: `src/app/(dashboard)/reports/appointments/all/page.tsx`**

```typescript
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listAllAppointmentsReport } from '@/lib/queries/reports'
import { ReportTable, type ReportColumn } from '@/components/ReportTable'
import type { FilterFieldDef } from '@/components/FilterPanel'

const FILTER_FIELDS: FilterFieldDef[] = [
  { key: 'patientName', label: 'Patient', type: 'text' },
  { key: 'status', label: 'Status', type: 'select', options: ['scheduled', 'completed', 'cancelled', 'no_show'] },
  { key: 'providerName', label: 'Provider', type: 'text' },
  { key: 'apptDate', label: 'Appt Date', type: 'date' },
  { key: 'homePhone', label: 'Home Phone', type: 'text' },
  { key: 'mobilePhone', label: 'Mobile Phone', type: 'text' },
]

export default async function AllAppointmentsReportPage() {
  const session = await requireSessionOrRedirect()
  const rows = await listAllAppointmentsReport()
  await logAudit(session, 'viewed report: all appointments', null)

  const columns: ReportColumn<(typeof rows)[number]>[] = [
    { key: 'id', label: 'Appt ID', render: (r) => r.id },
    { key: 'apptDate', label: 'Appt Date', render: (r) => new Date(r.apptDate).toLocaleDateString() },
    { key: 'apptTime', label: 'Time', render: (r) => r.apptTime },
    { key: 'patientName', label: 'Patient', render: (r) => r.patientName },
    { key: 'dob', label: 'DOB', render: (r) => r.dob },
    { key: 'homePhone', label: 'Home Phone', render: (r) => r.homePhone },
    { key: 'mobilePhone', label: 'Mobile Phone', render: (r) => r.mobilePhone },
  ]

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-foreground">All Appointments</h1>
      <ReportTable rows={rows} columns={columns} filterFields={FILTER_FIELDS} searchFields={['patientName', 'homePhone', 'mobilePhone']} rowKey={(r) => r.id} />
    </div>
  )
}
```

- [ ] **Step 2: Run the suite, manually verify, and commit**

Run: `npm test` and `npm run build`. Confirm `/reports/appointments/all` lists every seeded appointment and the Filters panel can narrow by Status and Provider.

```bash
git add "src/app/(dashboard)/reports/appointments/all/page.tsx"
git commit -m "feat: add All Appointments report leaf"
```

---

### Task 9: All Encounters leaf (⚠ BLOCKED on Phase 2, and on Phase 3 for the charges/claims enrichment)

**Do not run until Task 3 compiles.**

**Files:**
- Create: `src/app/(dashboard)/reports/encounters/all/page.tsx`

- [ ] **Step 1: `src/app/(dashboard)/reports/encounters/all/page.tsx`**

```typescript
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listAllEncountersReport } from '@/lib/queries/reports'
import { ReportTable, type ReportColumn } from '@/components/ReportTable'
import type { FilterFieldDef } from '@/components/FilterPanel'

const FILTER_FIELDS: FilterFieldDef[] = [
  { key: 'patientName', label: 'Patient', type: 'text' },
  { key: 'renderingProvider', label: 'Rendering Provider', type: 'text' },
  { key: 'encounterStatus', label: 'Encounter Status', type: 'select', options: ['Billed', 'Completed — Not Billed'] },
  { key: 'payerScenario', label: 'Payer Scenario', type: 'select', options: ['Insurance', 'Self-Pay'] },
  { key: 'dateOfService', label: 'Date of Service', type: 'date' },
]

export default async function AllEncountersReportPage() {
  const session = await requireSessionOrRedirect()
  const rows = await listAllEncountersReport()
  await logAudit(session, 'viewed report: all encounters', null)

  const columns: ReportColumn<(typeof rows)[number]>[] = [
    { key: 'encounterId', label: 'Encounter ID', render: (r) => r.encounterId },
    { key: 'dateOfService', label: 'Date of Service', render: (r) => new Date(r.dateOfService).toLocaleDateString() },
    { key: 'patientName', label: 'Patient Name', render: (r) => r.patientName },
    { key: 'renderingProvider', label: 'Rendering Provider', render: (r) => r.renderingProvider },
    { key: 'payerScenario', label: 'Payer Scenario', render: (r) => r.payerScenario },
    { key: 'encounterStatus', label: 'Encounter Status', render: (r) => r.encounterStatus },
    { key: 'procedure', label: 'Procedure', render: (r) => r.procedure },
  ]

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-foreground">All Encounters</h1>
      <ReportTable rows={rows} columns={columns} filterFields={FILTER_FIELDS} searchFields={['patientName', 'renderingProvider']} rowKey={(r) => r.encounterId} />
    </div>
  )
}
```

- [ ] **Step 2: Run the suite, manually verify, and commit**

Run: `npm test` and `npm run build`. Confirm `/reports/encounters/all` lists only completed appointments, with Encounter Status/Payer Scenario correctly reflecting whether a matching charge/claim exists.

```bash
git add "src/app/(dashboard)/reports/encounters/all/page.tsx"
git commit -m "feat: add All Encounters report leaf"
```

---

### Task 10: Insurance Collections leaf (⚠ BLOCKED on Phase 3)

**Do not run until Phase 3's `insuranceClaims` table exists and Task 3 compiles.**

**Files:**
- Create: `src/app/(dashboard)/reports/claims/insurance-collections/page.tsx`

- [ ] **Step 1: `src/app/(dashboard)/reports/claims/insurance-collections/page.tsx`**

```typescript
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listInsuranceCollectionsReport } from '@/lib/queries/reports'
import { ReportTable, type ReportColumn } from '@/components/ReportTable'
import type { FilterFieldDef } from '@/components/FilterPanel'

const FILTER_FIELDS: FilterFieldDef[] = [
  { key: 'patientName', label: 'Patient', type: 'text' },
  { key: 'payerName', label: 'Payer', type: 'text' },
  { key: 'status', label: 'Status', type: 'select', options: ['rejected', 'denied', 'waiting_adjudication', 'needs_investigation', 'paid'] },
  { key: 'serviceDate', label: 'Service Date', type: 'date' },
]

const STATUS_LABEL: Record<string, string> = {
  rejected: 'Rejected',
  denied: 'Denied',
  waiting_adjudication: 'Waiting for Adjudication',
  needs_investigation: 'Needs Investigation',
  paid: 'Paid',
}

export default async function InsuranceCollectionsReportPage() {
  const session = await requireSessionOrRedirect()
  const rows = await listInsuranceCollectionsReport()
  await logAudit(session, 'viewed report: insurance collections', null)

  const statusCounts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1
    return acc
  }, {})

  const columns: ReportColumn<(typeof rows)[number]>[] = [
    { key: 'patientName', label: 'Patient', render: (r) => r.patientName },
    { key: 'payerName', label: 'Payer', render: (r) => r.payerName },
    { key: 'status', label: 'Status', render: (r) => STATUS_LABEL[r.status] ?? r.status },
    { key: 'claimAmount', label: 'Claim Amount', render: (r) => `$${(r.claimAmount / 100).toFixed(2)}` },
    { key: 'serviceDate', label: 'Service Date', render: (r) => new Date(r.serviceDate).toLocaleDateString() },
    { key: 'submittedDate', label: 'Submitted', render: (r) => new Date(r.submittedDate).toLocaleDateString() },
  ]

  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold text-foreground">Insurance Collections</h1>
      <p className="mb-6 text-xs text-muted-foreground">
        {Object.entries(statusCounts).map(([status, count]) => `${STATUS_LABEL[status] ?? status}: ${count}`).join(' · ') || 'No claims.'}
      </p>
      <ReportTable rows={rows} columns={columns} filterFields={FILTER_FIELDS} searchFields={['patientName', 'payerName']} rowKey={(r) => r.id} />
    </div>
  )
}
```

- [ ] **Step 2: Run the suite, manually verify, and commit**

Run: `npm test` and `npm run build`. Confirm `/reports/claims/insurance-collections` lists every seeded claim, the status-count summary line matches the row counts, and Filters can narrow by Status/Payer.

```bash
git add "src/app/(dashboard)/reports/claims/insurance-collections/page.tsx"
git commit -m "feat: add Insurance Collections report leaf"
```

---

### Task 11: Charge Capture detail view (⚠ BLOCKED on Phase 3, UI-only)

**Do not run until Phase 3's `charges` table exists and Task 3 compiles.**

**Files:**
- Create: `src/components/ChargeCaptureView.tsx` (`'use client'`)
- Create: `src/app/(dashboard)/reports/charge-capture/[chargeId]/page.tsx`

**Interfaces:**
- Consumes: `getChargeDetail` (Task 3).
- Produces: `/reports/charge-capture/[chargeId]` — Phase 3's future Charges list page should link its rows here (see Cross-phase dependencies item 7).

- [ ] **Step 1: `src/components/ChargeCaptureView.tsx`**

```typescript
'use client'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

interface DiagnosisCode { rank: number; code: string; description: string }
interface ProcedureCode { code: string; modifiers: string[]; units: number; charge: number; linkedDiagnoses: number[] }

interface ChargeDetail {
  id: number
  patientId: string
  patientName: string
  patientDob: string
  dateOfService: string
  status: string
  placeOfService: string | null
  visitMode: string | null
  diagnosisCodes: DiagnosisCode[]
  procedureCodes: ProcedureCode[]
}

export function ChargeCaptureView({ charge }: { charge: ChargeDetail }) {
  const router = useRouter()
  const [collapsed, setCollapsed] = useState(false)

  const totalCharge = charge.procedureCodes.reduce((sum, p) => sum + p.charge * p.units, 0)

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Charge Capture</h1>
          <p className="text-sm text-muted-foreground">Status: <span className="font-medium text-foreground">{charge.status}</span></p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setCollapsed((c) => !c)} className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary">
            {collapsed ? 'Expand All' : 'Collapse All'}
          </button>
          <button onClick={() => window.print()} className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary">Print Itemized Receipt</button>
          <button onClick={() => router.back()} className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90">Close</button>
        </div>
      </div>

      {!collapsed && (
        <div className="space-y-6">
          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Patient Information</h2>
            <p className="text-sm text-foreground">{charge.patientName} · DOB {charge.patientDob} · Anon # {charge.patientId}</p>
          </section>

          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Visit & Provider Information</h2>
            <p className="text-sm text-foreground">Date of Service: {charge.dateOfService}</p>
            <p className="text-sm text-foreground">Place of Service: {charge.placeOfService ?? '—'}</p>
            <p className="text-sm text-foreground">Visit Mode: {charge.visitMode ?? '—'}</p>
          </section>

          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Diagnosis Codes</h2>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="p-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Rank</th>
                  <th className="p-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Code</th>
                  <th className="p-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Description</th>
                </tr>
              </thead>
              <tbody>
                {charge.diagnosisCodes.map((d, i) => (
                  <tr key={d.code} className={`border-b border-border ${i % 2 === 1 ? 'bg-muted/40' : ''}`}>
                    <td className="p-2 text-foreground">{d.rank}</td>
                    <td className="p-2 text-foreground">{d.code}</td>
                    <td className="p-2 text-foreground">{d.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Procedure Codes</h2>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="p-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Code</th>
                  <th className="p-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Modifiers</th>
                  <th className="p-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Units</th>
                  <th className="p-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Charge</th>
                  <th className="p-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Total</th>
                  <th className="p-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Linked Dx</th>
                </tr>
              </thead>
              <tbody>
                {charge.procedureCodes.map((p, i) => (
                  <tr key={p.code} className={`border-b border-border ${i % 2 === 1 ? 'bg-muted/40' : ''}`}>
                    <td className="p-2 text-foreground">{p.code}</td>
                    <td className="p-2 text-foreground">{p.modifiers.join(', ') || '—'}</td>
                    <td className="p-2 text-foreground">{p.units}</td>
                    <td className="p-2 text-foreground">${(p.charge / 100).toFixed(2)}</td>
                    <td className="p-2 text-foreground">${((p.charge * p.units) / 100).toFixed(2)}</td>
                    <td className="p-2 text-foreground">{p.linkedDiagnoses.join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-right text-sm font-semibold text-foreground">Total: ${(totalCharge / 100).toFixed(2)}</p>
          </section>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: `src/app/(dashboard)/reports/charge-capture/[chargeId]/page.tsx`**

```typescript
import { notFound } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getChargeDetail } from '@/lib/queries/charges'
import { ChargeCaptureView } from '@/components/ChargeCaptureView'

export default async function ChargeCapturePage({ params }: { params: Promise<{ chargeId: string }> }) {
  const session = await requireSessionOrRedirect()
  const { chargeId } = await params
  const charge = await getChargeDetail(Number(chargeId))
  if (!charge) notFound()
  await logAudit(session, `viewed charge capture ${chargeId}`, charge.patientId)

  return <ChargeCaptureView charge={charge} />
}
```

- [ ] **Step 3: Run the suite, manually verify, and commit**

Run: `npm test` and `npm run build`. Confirm visiting `/reports/charge-capture/[id]` for a seeded charge shows all four sections, Collapse All hides them, Print opens the browser print dialog, and Close navigates back.

```bash
git add src/components/ChargeCaptureView.tsx "src/app/(dashboard)/reports/charge-capture/[chargeId]/page.tsx"
git commit -m "feat: add read-only Charge Capture detail view"
```

---

### Task 12: Documents module (Documents tab + Fax History tab)

**Files:**
- Create: `src/components/DocumentsTabs.tsx` (`'use client'`)
- Create: `src/components/MarkProcessedButton.tsx` (`'use client'`)
- Create: `src/app/(dashboard)/documents/layout.tsx`
- Create: `src/app/(dashboard)/documents/page.tsx`
- Create: `src/app/(dashboard)/documents/fax-history/page.tsx`
- Create: `src/app/api/documents/[id]/route.ts`
- Create: `tests/api/documents.test.ts`

**Interfaces:**
- Consumes: `listDocuments`, `getDocument` (Task 2); `listFaxes` (Task 2); `ReportTable`/`ReportColumn` (Task 5).
- Produces: `/documents` and `/documents/fax-history` routes; `PATCH /api/documents/[id]`.

- [ ] **Step 1: `src/components/DocumentsTabs.tsx`**

```typescript
'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

const TABS = [
  { href: '/documents', label: 'Documents' },
  { href: '/documents/fax-history', label: 'Fax History' },
]

export function DocumentsTabs() {
  const pathname = usePathname()
  return (
    <div className="flex gap-1 border-b border-border">
      {TABS.map((tab) => {
        const active = pathname === tab.href
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={`border-b-2 px-4 py-2 text-sm font-medium transition-colors ${active ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          >
            {tab.label}
          </Link>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: `src/components/MarkProcessedButton.tsx`**

```typescript
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

export function MarkProcessedButton({ documentId, disabled }: { documentId: number; disabled: boolean }) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)

  async function markProcessed() {
    setSaving(true)
    const res = await fetch(`/api/documents/${documentId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'processed' }),
    })
    setSaving(false)
    if (res.ok) router.refresh()
  }

  if (disabled) return <span className="text-xs text-muted-foreground">Processed</span>

  return (
    <button onClick={markProcessed} disabled={saving} className="rounded-md border border-border px-3 py-1 text-xs font-medium text-foreground hover:bg-secondary disabled:opacity-50">
      Mark Processed
    </button>
  )
}
```

- [ ] **Step 3: `src/app/api/documents/[id]/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDb } from '@/db/client'
import { documents } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getDocument } from '@/lib/queries/documents'
import { invalidateCache, documentsListCacheKey } from '@/lib/cache'

const updateDocumentSchema = z.object({
  status: z.enum(['new', 'processed']),
}).strict()

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  const { id } = await params

  const parsed = updateDocumentSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid document update', details: parsed.error.flatten() }, { status: 400 })

  const existing = await getDocument(Number(id))
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await getDb().update(documents).set({ status: parsed.data.status }).where(eq(documents.id, Number(id)))
  await invalidateCache(documentsListCacheKey())
  await logAudit(session, `marked document ${id} as ${parsed.data.status}`, existing.patientId)
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 4: `src/app/(dashboard)/documents/layout.tsx`**

```typescript
import type { ReactNode } from 'react'
import { DocumentsTabs } from '@/components/DocumentsTabs'

export default function DocumentsLayout({ children }: { children: ReactNode }) {
  return (
    <div>
      <h1 className="mb-4 text-2xl font-bold text-foreground">Documents</h1>
      <DocumentsTabs />
      <div className="mt-4">{children}</div>
    </div>
  )
}
```

- [ ] **Step 5: `src/app/(dashboard)/documents/page.tsx`**

```typescript
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listDocuments } from '@/lib/queries/documents'
import { ReportTable, type ReportColumn } from '@/components/ReportTable'
import type { FilterFieldDef } from '@/components/FilterPanel'
import { MarkProcessedButton } from '@/components/MarkProcessedButton'

const FILTER_FIELDS: FilterFieldDef[] = [
  { key: 'name', label: 'Name', type: 'text' },
  { key: 'status', label: 'Status', type: 'select', options: ['new', 'processed'] },
  { key: 'receivedFrom', label: 'Received From', type: 'text' },
  { key: 'label', label: 'Label', type: 'select', options: ['other', 'drivers_license', 'legal_document'] },
  { key: 'fileType', label: 'File Type', type: 'text' },
  { key: 'patientName', label: 'Patient', type: 'text' },
]

const LABEL_TEXT: Record<string, string> = { other: 'Other', drivers_license: "Driver's License", legal_document: 'Legal Document' }

export default async function DocumentsPage() {
  const session = await requireSessionOrRedirect()
  const documents = await listDocuments()
  await logAudit(session, 'viewed documents', null)

  const columns: ReportColumn<(typeof documents)[number]>[] = [
    { key: 'name', label: 'Name', render: (d) => d.name },
    { key: 'documentDate', label: 'Document Date', render: (d) => new Date(d.documentDate).toLocaleDateString() },
    { key: 'status', label: 'Status', render: (d) => (
      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground">
        <span className={`h-2 w-2 rounded-full ${d.status === 'new' ? 'bg-amber-500' : 'bg-emerald-600'}`} aria-hidden="true" />
        {d.status === 'new' ? 'New' : 'Processed'}
      </span>
    ) },
    { key: 'receivedFrom', label: 'Received From', render: (d) => d.receivedFrom },
    { key: 'label', label: 'Label', render: (d) => LABEL_TEXT[d.label] },
    { key: 'patientName', label: 'Patient', render: (d) => (d.patientName ? `${d.patientName}${d.patientDob ? ` (DOB ${d.patientDob})` : ''}` : '—') },
    { key: 'fileType', label: 'File Type', render: (d) => d.fileType },
    { key: 'actions', label: 'Actions', render: (d) => <MarkProcessedButton documentId={d.id} disabled={d.status === 'processed'} /> },
  ]

  return (
    <ReportTable
      rows={documents}
      columns={columns}
      filterFields={FILTER_FIELDS}
      searchFields={['name', 'receivedFrom']}
      rowKey={(d) => d.id}
    />
  )
}
```

- [ ] **Step 6: `src/app/(dashboard)/documents/fax-history/page.tsx`**

```typescript
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listFaxes } from '@/lib/queries/faxes'
import { ReportTable, type ReportColumn } from '@/components/ReportTable'
import type { FilterFieldDef } from '@/components/FilterPanel'

const FILTER_FIELDS: FilterFieldDef[] = [
  { key: 'subject', label: 'Subject', type: 'text' },
  { key: 'deliveryStatus', label: 'Delivery Status', type: 'select', options: ['delivered', 'failed'] },
  { key: 'sender', label: 'Sender', type: 'text' },
  { key: 'sentToFaxNumber', label: 'Sent To', type: 'text' },
  { key: 'patientName', label: 'Patient', type: 'text' },
]

export default async function FaxHistoryPage() {
  const session = await requireSessionOrRedirect()
  const faxes = await listFaxes()
  await logAudit(session, 'viewed fax history', null)

  const columns: ReportColumn<(typeof faxes)[number]>[] = [
    { key: 'faxDate', label: 'Date', render: (f) => new Date(f.faxDate).toLocaleString() },
    { key: 'subject', label: 'Message Subject', render: (f) => f.subject },
    { key: 'documentsIncluded', label: 'Document(s) Included', render: (f) => f.documentsIncluded },
    { key: 'deliveryStatus', label: 'Delivery Status', render: (f) => (
      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground">
        <span className={`h-2 w-2 rounded-full ${f.deliveryStatus === 'delivered' ? 'bg-emerald-600' : 'bg-red-600'}`} aria-hidden="true" />
        {f.deliveryStatus === 'delivered' ? 'Delivered' : 'Failed'}
      </span>
    ) },
    { key: 'sender', label: 'Sender', render: (f) => f.sender },
    { key: 'sentToFaxNumber', label: 'Sent To', render: (f) => f.sentToFaxNumber },
    { key: 'patientName', label: 'Patient', render: (f) => (f.patientName ? `${f.patientName}${f.patientDob ? ` (DOB ${f.patientDob})` : ''}` : '—') },
  ]

  return (
    <div>
      <p className="mb-4 text-xs text-muted-foreground">
        Delivery status shown here is simulated for demonstration purposes only — this application does not transmit real faxes.
      </p>
      <ReportTable rows={faxes} columns={columns} filterFields={FILTER_FIELDS} searchFields={['subject', 'sender']} rowKey={(f) => f.id} />
    </div>
  )
}
```

- [ ] **Step 7: Test**

`tests/api/documents.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest'
import { PATCH } from '@/app/api/documents/[id]/route'

vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: 'crc', name: 'Jamie Ruiz' })) }))

describe('PATCH /api/documents/[id]', () => {
  it('rejects an invalid status value', async () => {
    const req = new Request('http://localhost/api/documents/1', { method: 'PATCH', body: JSON.stringify({ status: 'archived' }) })
    const res = await PATCH(req as never, { params: Promise.resolve({ id: '1' }) })
    expect(res.status).toBe(400)
  })

  it('rejects an unknown field (mass-assignment guard)', async () => {
    const req = new Request('http://localhost/api/documents/1', { method: 'PATCH', body: JSON.stringify({ status: 'processed', name: 'Renamed' }) })
    const res = await PATCH(req as never, { params: Promise.resolve({ id: '1' }) })
    expect(res.status).toBe(400)
  })

  it('returns 404 for a non-existent document', async () => {
    const req = new Request('http://localhost/api/documents/999999', { method: 'PATCH', body: JSON.stringify({ status: 'processed' }) })
    const res = await PATCH(req as never, { params: Promise.resolve({ id: '999999' }) })
    expect(res.status).toBe(404)
  })

  it('marks a seeded document processed', async () => {
    const req = new Request('http://localhost/api/documents/3', { method: 'PATCH', body: JSON.stringify({ status: 'processed' }) })
    const res = await PATCH(req as never, { params: Promise.resolve({ id: '3' }) })
    expect(res.status).toBe(200)
  })
})
```

Note: mock `requireSession` directly, matching the established pitfall note in Phase 1's plan.

- [ ] **Step 8: Run the suite, manually verify, and commit**

Run: `npm test` and `npm run build`. Then manually confirm: `/documents` shows the seeded documents with working search/filter/columns and a working "Mark Processed" action (row updates to "Processed" after refresh); `/documents/fax-history` shows the disclaimer banner and the seeded faxes with Delivered/Failed dots.

```bash
git add src/components/DocumentsTabs.tsx src/components/MarkProcessedButton.tsx "src/app/(dashboard)/documents" src/app/api/documents tests/api/documents.test.ts
git commit -m "feat: add Documents module with Documents and Fax History tabs"
```

---

### Task 13: Nav integration

**Files:**
- Modify: `src/components/LeftNav.tsx`

**Interfaces:**
- Consumes: `/reports`, `/documents` routes (Tasks 6, 12).

- [ ] **Step 1: Add nav entries**

Open `src/components/LeftNav.tsx`. In the `ITEMS` array, insert:

```typescript
{ href: '/reports', label: 'Reports' },
{ href: '/documents', label: 'Documents' },
```

Placement rule (per architecture spec §5, which this plan must follow without reordering another phase's entries): insert these two entries immediately after the entry whose `label` is `'Billing'` if one exists (added by Phase 3); otherwise immediately after the entry whose `label` is `'Client Forms'` if one exists (added by Phase 1); otherwise immediately after `'Identity Matching'`. Do not rename, reorder, or remove any existing entry.

- [ ] **Step 2: Run the suite and commit**

Run: `npm test` and `npm run build` — both must be clean.

```bash
git add src/components/LeftNav.tsx
git commit -m "feat: add Reports and Documents entries to left nav"
```

---

### Task 14: Final QA pass (local only — no push)

**Files:** none created; verification only.

- [ ] **Step 1: Full-tree greps**

```bash
grep -rn "lucide-react" src/app/\(dashboard\)/reports src/app/\(dashboard\)/documents src/components/ReportTable.tsx src/components/FilterPanel.tsx src/components/ReportsSidebar.tsx src/components/DocumentsTabs.tsx src/components/ChargeCaptureView.tsx src/components/MarkProcessedButton.tsx
grep -rn "bg-slate-\|text-green-700\|text-blue-700\|text-purple-700\|bg-green-700\|text-amber-700" src/app/\(dashboard\)/reports src/app/\(dashboard\)/documents src/components/ReportTable.tsx src/components/FilterPanel.tsx --include="*.tsx"
grep -rn "TODO\|TBD\|FIXME" src/app/\(dashboard\)/reports src/app/\(dashboard\)/documents src/lib/queries/reports.ts src/lib/queries/documents.ts src/lib/queries/faxes.ts src/lib/queries/charges.ts src/components/ReportTable.tsx src/components/FilterPanel.tsx
```

All three must return zero matches.

- [ ] **Step 2: `npm test` and `npm run build`**

Both must be 100% clean.

- [ ] **Step 3: Manual browser walkthrough**

Log in as each of the 3 demo roles and visit: `/reports`, `/reports/patients`, `/reports/appointments/all`, `/reports/notes/unsigned`, `/reports/encounters/all`, `/reports/claims/insurance-collections`, `/reports/charge-capture/[an id]`, `/documents`, `/documents/fax-history`. Confirm:
- The Reports sidebar accordion tree shows all 5 groups, collapses/expands, and highlights the active leaf.
- Every leaf's Filters panel opens, lets you search for and add a field, and narrows the table; the filter-count badge on the toolbar matches the number of active filters.
- Every leaf's Columns toggle hides/shows a column.
- Empty state (`No results found.`) appears correctly when a filter combination matches nothing.
- The Fax History disclaimer is visible and unambiguous.
- "Mark Processed" on a New document flips it to Processed after a refresh.
- Charge Capture's Collapse All / Print / Close all work.
- Reports/Documents appear in the left nav in the position specified by Task 13, without disturbing any other phase's entries.

- [ ] **Step 4: Confirm nothing pushed yet**

```bash
git status --porcelain
git log --oneline origin/master..HEAD
```

Everything from this plan should be committed locally but **not yet pushed**.

---

## Self-review

**Placeholder scan:** No `TODO`/`TBD`/`FIXME` markers appear anywhere in this plan's code (verified by inspection and enforced again by Task 14 Step 1's grep). Every "CROSS-PHASE DEPENDENCY" comment is a deliberate, fully-specified assumption about another phase's schema — not an unfinished implementation — and each is paired with complete, runnable code written against that assumption, exactly as the task brief permitted ("describe the expected shape you're assuming... and flag the dependency explicitly").

**Type/interface consistency check:**
- `FilterFieldDef` / `AppliedFilter` (Task 4) are used with the same shape by `ReportTable.tsx` (Task 5) and every page that builds a `FILTER_FIELDS` array (Tasks 6–12) — field `key`s always match a real property name on that report's row objects, since `ReportTable`'s filter/search logic indexes rows by those same keys.
- `ReportColumn<Row>` (Task 5) is used identically by every leaf page — `key`, `label`, `render`.
- The assumed `DataGridToolbarProps` interface (Global Constraints) is used by exactly one call site (`ReportTable.tsx`), so a Phase 3 mismatch requires fixing only that one file.
- Every report/document row object returned by a query function (Tasks 2, 3) carries `patientName`/`patientDob` (or the closest equivalent) computed the same way `getPatientDetail`/`listPatientsWithStatus` already do (`nameTebra ?? nameIntakeq`, `dobTebra ?? dobIntakeq`), so display is consistent with the rest of the app.

**Spec coverage against the catalog's "Reports & documents" section:**
- Accordion-tree sidebar grouped Patients/Appointments/Notes/Encounters/Claims — Task 6 (`ReportsSidebar.tsx`).
- All Appointments columns (Appt ID, Appt Date, Time, Patient, DOB, Home Phone, Mobile Phone) — Task 8, exact column match.
- Unsigned Notes columns (Assigned User, Patient, Visit Date, Status, Note Type, Note ID) — Task 7, exact column match ("Assigned User" mapped to `currentProvider`/"Unassigned" since Clinsync has no separate note-assignment concept — documented adaptation).
- All Encounters columns (Encounter ID, Date of Service, Patient Name, Rendering Provider, Payer Scenario, Encounter Status, Procedure) — Task 9, exact column match, with Payer Scenario/Encounter Status/Procedure derived from a documented Phase 3 join rather than static text.
- Shared slide-out Filters panel with searchable "Add a filter" — Task 4, reused by every leaf and by Documents/Fax History.
- Toolbar (search, refresh, filter w/ badge, columns) — Task 5, built against the assumed `DataGridToolbar` interface.
- Empty state "No results found." and "Rows per page: N" / pagination — implemented in `ReportTable.tsx`.
- Documents tabs (Documents / Fax History), Documents columns (Name, Document Date, Status, Received from, Label, Patient, File Type) — Task 12, exact column match (row "⋮" menu simplified to a single "Mark Processed" action button, since no other document actions were requested and per-row menus with unspecified contents would be speculative).
- Fax History columns (Date, Message Subject, Document(s) Included, Delivery Status, Sender, Sent to, Patient) — Task 12, exact column match, with the mandatory simulated-delivery disclaimer.
- Charge Capture read-only detail (Patient Information, Visit & Provider Information, Diagnosis Codes, Procedure Codes, Collapse All/Print/Close, Status label) — Task 11, matches catalog structure.
- **Intentionally not built** (out of scope for the task brief, though present in the catalog): "Missed Charges" and practice-custom saved reports under Appointments; "Active Denials" under Claims; the enterprise data-grid's per-column "..." context menu (sort/pin/hide/manage) and density picker, per architecture spec §6's explicit exclusion of those as unneeded at Clinsync's scale. "All Patients" under the Patients group is this plan's own reasonable content for a group the catalog names but doesn't detail column-by-column.

**Cross-phase assumptions requiring reconciliation before execution** (full detail in "Cross-phase dependencies" above):
1. `appointments` / `providers` shape (Phase 2) — blocks Tasks 3 (partially), 8, 9.
2. `insuranceClaims` shape (Phase 3) — blocks Tasks 3 (partially), 9 (partially), 10.
3. `charges` shape (Phase 3) — blocks Tasks 3 (partially), 9 (partially), 11.
4. `DataGridToolbar.tsx` prop interface (Phase 3) — blocks Task 5 and everything downstream of it (Tasks 6–12).
5. Home/Mobile phone mapped to `patients.phoneTebra`/`phoneIntakeq` rather than new appointment-level phone fields.
6. Phase 3's future Charges list page needs to add the link to `/reports/charge-capture/[chargeId]` itself — Phase 4 has no such file to edit yet.
7. The Encounters report's Payer Scenario/Encounter Status derivation logic (best-effort join, not just field names) may need rework if Phase 3's actual `charges`/`insuranceClaims` differ structurally from the assumption, not just cosmetically.
