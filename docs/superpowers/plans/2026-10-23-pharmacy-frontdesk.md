# Pharmacy Stock and Front Desk Implementation Plan (WS5, WS6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Batch- and expiry-aware pharmacy stock with GRN receipt, expiry alerts, reorder levels and FEFO dispensing; doctor working hours with a slot picker; and a front desk that registers, books, checks in, queues and collects at the door without free-form guesswork.

**Architecture:** Pure modules for every rule (FEFO, slots, booking date, wait estimate, map link, queue labels, handover OTP) with thin queries and routes around them. Stock keeps `medication_inventory.quantity_on_hand` as the per-drug total, written in the same transaction as batch rows, so every current reader keeps working. Slots are computed on read from a weekly template. Collector payments use the foundations payment path. Every new route: `requireSession`, inline role allowlist, strict Zod body, `logAudit`, rows in both RBAC harnesses.

**Tech Stack:** Next.js 16 App Router (read `node_modules/next/dist/docs/` before touching routing, caching, `searchParams` or route handlers; AGENTS.md: breaking changes), TypeScript, Drizzle + Postgres, Vitest + Testing Library, Zod 4, existing `qrcode`. No new packages.

**Spec:** `docs/superpowers/specs/2026-10-23-operations-portal-governance-design.md` (D1, D2, D5–D8, D21, D22). Findings: `docs/superpowers/plans/2026-10-23-gap-closure-plan.md` C5–C10, D1 (batch/expiry half), D2, D3, I15, I16, UI items 3, 6, 12.

## Ownership boundaries (read first)

- **Not in this plan** (owned by WS1/WS2, `docs/superpowers/specs/2026-10-23-doctor-workspace-billing-design.md` decisions 7–9, 14): prescription builder (multi-drug, 1-0-1, generic names, mandatory dose, print slip), allergy matcher and override, dispense pricing/GST/auto-billing, dispense dialog quantity prefill, price, allergy banner and success toast, `J3490` removal. Findings A5, B2, B3 close there.
- **This plan** adds batches, FEFO, GRN, expiry alerts, reorder and write-off, and makes WS2's dispense draw from a real batch (Task 5).

## Preconditions

- WS2's dispense change (`POST /api/pharmacy/dispense` with `batch_no`, `expiry_month`, `unit_mrp_paise` snapshot and automatic charge) merged before **Task 5**. Tasks 2–4 do not need it.
- Foundations Tasks 8–9 (notification service, branch `feat/hc-s8`: `sendNotification` in `src/lib/notify/send.ts`, `NOTIFICATION_TEMPLATE_KEYS` in `src/lib/notify/templates.ts`) merged before **Task 11**.

## Streams (each runs in its own git worktree off `feat/hospital-completion`; merge in the order listed inside a stream)

| Stream | Tasks | Notes |
|---|---|---|
| **0** | 1 | Merge first (small). Every other stream rebases on it: toasts and empty states are used everywhere. |
| **P** (pharmacy stock) | 2 → 3 → 4 → 5 | One schema family. Task 5 waits for WS2's dispense change. |
| **S** (scheduling and front desk) | 6 → 7 → 9 → 10 | 7, 9 and 10 read Task 6's schedules and `providers` columns. |
| **R** (registration) | 8 | Uses Task 6's slots route for the availability hint; if S has not merged, it shows no hint (feature check on the route response, 404 → hidden). |
| **C** (collector) | 11 → 12 | 11 needs the notification service. |

**Shared files and how to touch them without conflicts**
- `src/db/schema.ts`: append one block at the end of the file, delimited `// WS5 T<n>` … `// end WS5 T<n>` (or `WS6`). Columns added to an existing table go inside its definition, each line tagged `// WS5 T<n>`, never reordering existing columns.
- Migrations: one per task, `scripts/migrations/2026-10-24-ws5-<topic>.sql` or `2026-10-24-ws6-<topic>.sql`, `BEGIN; … COMMIT;`, every statement re-runnable (`IF NOT EXISTS`, guarded `DO $$ … $$`, `ON CONFLICT DO NOTHING`). Never edit an applied migration.
- `tests/api/rbac-route-gates.test.ts`: append rows only at the end of `API_GATES`. `tests/pages/page-gates-harness.ts`: append only at the end of `PAGE_GATES`.
- `src/lib/role-policy.ts`: append new constants at the end inside `// WS5` / `// WS6` comments.
- `src/lib/notify/templates.ts` (Task 11): append the key at the end of `NOTIFICATION_TEMPLATE_KEYS` and its entries at the end of `TemplateVars` and `PARAM_KEYS`.

## Global Constraints

- Tests run **only** against the isolated database: `source $SCRATCH/testenv.sh` (DB `hims_test`). Never `.env.local`, never the demo DB `hims`, never a cloud DB.
- No committed secrets, `.env*` values, `data/` or generated files.
- Never log or return a secret, OTP, password hash, UTR, provider error body, file path or blob URL. Log error class names only; audit details carry ids, counts and enum values, never names, phones or addresses.
- Money is integer paise; time is IST (`todayIsoIn`, `istDayBounds`, `startOfIstDay`); ids shown to users are UHID, never chart ids.
- Schema: `src/db/schema.ts` plus a re-runnable, checksummed migration; `npm run db:migrate` on the test DB only; `npm run db:schema-diff` must agree. Never `db:push`.
- Every new route: `requireSession()` first, inline role allowlist, strict Zod body (`.strict()`), `logAudit`, a row in both RBAC harnesses (route harness; page harness for pages).
- `ENABLE_TRIALS=true` behaviour stays intact (Vitest sets it); check new UI with it unset as well.
- Each task ends with its tests passing, `npx tsc --noEmit` and `npm run lint` clean on touched files, and one commit on the stream branch (never directly on `feat/hospital-completion`).

## Review Focus

- Two concurrent dispenses of the last units of a batch: one succeeds, the other gets 409; `SUM(batch quantity) = medication_inventory.quantity_on_hand` after every write path (GRN, dispense, write-off).
- An expired or written-off batch can never be dispensed, by FEFO or by explicit choice.
- A slot shown as free can still lose to a concurrent booking; the loser gets the existing 409, never a double booking.
- A collector cannot mark a visit collected or take payment before its IST visit date or for a visit not assigned to them; five wrong OTPs lock the code.
- The public queue display never carries a patient name, UHID or chart id.

---

### Task 1: Toast and empty-state primitives

**Files:**
- Create: `src/components/ui/toast.tsx`, `src/components/ui/empty-state.tsx`
- Modify: `src/app/(dashboard)/layout.tsx` (wrap children in `ToastProvider`)
- Test: `tests/components/ui-toast.test.tsx`, `tests/components/ui-empty-state.test.tsx`

**Interfaces:**
- Produces: `ToastProvider({ children })`; `useToast(): { show(t: { title: string; description?: string; tone?: 'success' | 'error' | 'info'; action?: { label: string; href: string } }): void }`; `EmptyState({ icon?: LucideIcon; title: string; description?: string; action?: { label: string; href?: string; onClick?: () => void } })`.
- If WS1/WS2 already merged a toast, keep theirs, re-export it from `src/components/ui/toast.tsx` with this signature (adapter only) and build `EmptyState` alone.

- [ ] **Step 1: Write failing tests**: `show({ title: 'Stock received', action: { label: 'View batches', href: '/x' } })` renders a `role="status"` region with the title and a link `View batches` → `/x`; it disappears after 6 s (fake timers) or on its close button; `tone: 'error'` uses `role="alert"`; at most 3 stacked; `useToast` outside the provider throws a clear error; `EmptyState` renders title, description and an action link or button.
- [ ] **Step 2: Run** `npx vitest run tests/components/ui-toast.test.tsx tests/components/ui-empty-state.test.tsx` → FAIL.
- [ ] **Step 3: Implement** with React context and the existing design tokens; no new dependency.
- [ ] **Step 4: Run** → PASS; run `npx vitest run tests/pages/root-layout.test.tsx` for regressions.
- [ ] **Step 5: Commit** `feat(ui): toast with next-step link and shared empty state`.

### Task 2: Medication batches and the FEFO rule

**Files:**
- Create: `scripts/migrations/2026-10-24-ws5-medication-batches.sql`, `src/lib/pharmacy/fefo.ts`, `src/lib/queries/medication-batches.ts`
- Modify: `src/db/schema.ts` (block `// WS5 T2`: `medicationBatches`; on `medicationDispenses`: `batchId`)
- Test: `tests/lib/pharmacy/fefo.test.ts`, `tests/lib/queries/medication-batches.test.ts`

**Interfaces:**
- Table `medication_batches` (spec §3): `CHECK quantity_on_hand >= 0`, `CHECK mrp_per_unit_paise >= 0`, unique `(medication_id, batch_no)`, index `(medication_id, expiry_date)`; `medication_dispenses.batch_id int NULL REFERENCES medication_batches(id)`.
- `interface BatchStock { id: number; batchNo: string; expiryDate: string | null; quantityOnHand: number; mrpPerUnitPaise: number; writtenOff: boolean }`
- `pickFefo(batches: BatchStock[], quantity: number, todayIso: string): { ok: true; allocations: { batchId: number; quantity: number }[] } | { ok: false; error: 'insufficient_stock' | 'only_expired_stock' }` — skips written-off and expired (`expiryDate < todayIso`), earliest expiry first, null expiry last, tie → lower id.
- `isExpired(b: Pick<BatchStock, 'expiryDate'>, todayIso: string): boolean`; `expiresWithinDays(b, todayIso: string, days: number): boolean`; `expiryMonth(expiryDate: string | null): string | null` (`'YYYY-MM'`, the WS2 snapshot format).
- `listBatches(medicationId: number, executor?): Promise<BatchStock[]>`; `syncInventoryTotal(tx, medicationId: number): Promise<void>` (sets `medication_inventory.quantity_on_hand` to the sum of non-written-off batches).
- Migration backfill: for every `medication_inventory` row with `quantity_on_hand > 0`, insert batch `OPENING` (expiry NULL; MRP = `medications.mrp_per_unit_paise` when WS2's column exists, else 0) with `ON CONFLICT (medication_id, batch_no) DO NOTHING`.

- [ ] **Step 1: Write failing tests**: `pickFefo` takes 10 from a batch expiring 2026-11-01 before one expiring 2027-01-01; spans two batches when the first is short; never picks a batch expiring before today; `only_expired_stock` when only expired stock would cover it; `insufficient_stock` otherwise; null-expiry batch is used last; `expiryMonth('2026-11-30')` = `'2026-11'`. DB test: after the migration every drug with stock has an `OPENING` batch and `SUM(batch qty) = on hand`; a second run changes nothing.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** schema, migration, pure module, queries.
- [ ] **Step 4: Run** `npm run db:migrate` (test DB) and the tests → PASS; `npm run db:schema-diff` against a from-empty DB agrees.
- [ ] **Step 5: Commit** `feat(pharmacy): medication batches with expiry and the FEFO allocation rule`.

### Task 3: Purchase receipt (GRN)

**Files:**
- Create: `scripts/migrations/2026-10-24-ws5-pharmacy-grns.sql`, `src/lib/queries/pharmacy-grns.ts`, `src/app/api/pharmacy/grns/route.ts`, `src/components/pharmacy/ReceiveStockDialog.tsx`
- Modify: `src/db/schema.ts` (block `// WS5 T3`: `pharmacyGrns`; FK `medication_batches.grn_id`), `src/lib/role-policy.ts` (append `PHARMACY_STOCK_ROLES: readonly Role[] = ['admin', 'pharmacy']`), `src/components/dashboards/PharmacyDashboard.tsx` ("Receive stock" button for `canAddMedication`), `tests/api/rbac-route-gates.test.ts`
- Test: `tests/api/pharmacy-grns.test.ts`, `tests/components/pharmacy/ReceiveStockDialog.test.tsx`

**Interfaces:**
- `POST /api/pharmacy/grns` body `{ supplierName: string(1..120); supplierInvoiceNo: string(1..60); supplierInvoiceDate: 'YYYY-MM-DD'; lines: { medicationId: number; batchNo: string(1..40, /^[A-Za-z0-9\-\/]+$/); expiryDate: 'YYYY-MM-DD'; quantity: int 1..100000; mrpPerUnitPaise: int ≥ 0; purchaseRatePaise: int ≥ 0 }[] (1..50) }` → `201 { grnId, grnNumber }`.
- `GET /api/pharmacy/grns?limit=50` → `{ items: { id, grnNumber, supplierName, supplierInvoiceNo, receivedAt, totalPaise, lineCount }[] }`. Both roles `PHARMACY_STOCK_ROLES`.
- `receiveGrn(input, session): Promise<{ ok: true; grnId: number; grnNumber: string } | { ok: false; error: 'unknown_medication' | 'expired_on_receipt' | 'batch_conflict' }>` — one transaction: GRN row numbered `GRN/<FY>/<6 digits>` through the existing helper in `src/lib/queries/document-numbers.ts`; each line inserts its batch or adds quantity to an existing batch only when expiry and MRP match (else `batch_conflict`); `syncInventoryTotal` per drug; audit `pharmacy: received GRN` with `grn=<id> lines=<n>`.

- [ ] **Step 1: Write failing tests**: a valid GRN adds batches and raises on-hand totals; expiry on or before today → 422 `expired_on_receipt` and nothing written; same batch number with a different expiry → 409; frontdesk and billing → 403; an unknown body key → 400; `total_paise` = Σ quantity × purchase rate; the dialog adds/removes lines, shows the total in ₹, and shows a success toast "GRN/26-27/000001 received" with "View stock".
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; RBAC rows for both methods.
- [ ] **Step 5: Commit** `feat(pharmacy): goods received note adds batches and stock`.

### Task 4: Stock table with batches, expiry alerts, reorder level and write-off

**Files:**
- Create: `src/app/api/pharmacy/medications/[id]/reorder/route.ts`, `src/app/api/pharmacy/batches/[id]/write-off/route.ts`, `src/components/pharmacy/BatchList.tsx`
- Modify: `src/lib/queries/medications.ts` (`MedicationWithInventory` gains `batches: BatchStock[]`, `nearestExpiry: string | null`, `expiringSoonQty: number`, `expiredQty: number`), `src/lib/queries/hospital-kpis.ts` (`PharmacyKpi` gains `expiringIn90Days: number`, `expiredBatches: number`), `src/components/dashboards/PharmacyDashboard.tsx` (columns on hand, reorder level, nearest expiry, status chip; filters `?stock=low|out|expiring|expired`; a row expands to `BatchList`; `EmptyState` for an empty filter), `src/app/(dashboard)/pharmacy/page.tsx` (accept the two new filter values), `tests/api/rbac-route-gates.test.ts`
- Test: `tests/api/pharmacy-stock-actions.test.ts`, `tests/components/PharmacyDashboard.stock.test.tsx`

**Interfaces:**
- `PATCH /api/pharmacy/medications/[id]/reorder` body `{ reorderThreshold: int 0..100000 }` → `200 { reorderThreshold }`; audit `pharmacy: changed reorder level`.
- `POST /api/pharmacy/batches/[id]/write-off` body `{ reason: 'expired' | 'damaged' | 'recalled' | 'other'; note?: string(..200) }` → `200 { ok: true }`; sets `written_off_at` and `write_off_reason`, zeroes quantity, `syncInventoryTotal`, audit `pharmacy: wrote off batch` with `batch=<id> qty=<n> reason=<enum>` (never the note). Roles `PHARMACY_STOCK_ROLES`.
- D3 "not in catalogue" resolve: `POST /api/pharmacy/uncatalogued/link` (`PHARMACY_STOCK_ROLES`) body `{ episodeName: string(1..200); medicationId: number }` sets `medication_id` on active prescribed episodes with that exact name and null `medication_id` → `200 { linked: number }`; audit `pharmacy: linked uncatalogued prescriptions` with counts. The dashboard's "Not in catalogue" list gets "Link to drug" (picker) and "Add to catalogue" (existing `AddMedicationModal` prefilled with the name). Add `src/app/api/pharmacy/uncatalogued/link/route.ts` to Files and a test case to `tests/api/pharmacy-stock-actions.test.ts`.

- [ ] **Step 1: Write failing tests**: writing off a batch lowers the total by exactly its quantity; a second write-off → 409; reorder update persists and `?stock=low` uses it; the dashboard shows "Expires in 23 days" (IST) and an "Expired" chip; `?stock=expiring` lists only drugs with stock expiring within 90 days; an empty filter result renders `EmptyState`; pi (view-only) sees no write-off button.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS (+ `tests/components/PharmacyDashboard*.test.tsx`, `tests/pages/*pharmacy*`).
- [ ] **Step 5: Commit** `feat(pharmacy): batch and expiry columns, expiry alerts, reorder level and write-off`.

### Task 5: Dispense draws from batches (FEFO or picked)

**Precondition:** WS2's dispense change merged (snapshot columns `batch_no`, `expiry_month`, `unit_mrp_paise` and the in-transaction charge exist).

**Files:**
- Modify: `src/lib/queries/medication-dispenses.ts` (`dispenseMedication`), `src/app/api/pharmacy/dispense/route.ts` (body adds `batchId?: number`; WS2's manual `batchNo`/`expiryMonth` fields become derived when the drug has batches), `src/app/api/pharmacy/patients/[patientId]/route.ts` (each drug carries `batches: BatchStock[]` non-expired, FEFO order), `src/components/DispenseMedicationModal.tsx` (batch select defaulting to "FEFO: <batch> · exp <Mon YYYY>", expired batches listed disabled, per-batch MRP in the price line WS2 already shows)
- Test: extend `tests/api/pharmacy-dispense.test.ts`, `tests/components/DispenseMedicationModal.test.tsx`

**Interfaces:**
- `DispenseInput` adds `batchId: number | null; todayIso: string`.
- Inside WS2's dispense transaction, before its charge capture: lock the drug's batch rows `FOR UPDATE` in id order; allocate with `pickFefo` (or the chosen batch, refusing expired/written-off/other-drug); for each allocation insert **one dispense row** with `batch_id`, `batch_no`, `expiry_month = expiryMonth(batch.expiryDate)`, `unit_mrp_paise = batch.mrpPerUnitPaise` (fallback `medications.mrp_per_unit_paise` when the batch MRP is 0), decrement the batch with a guarded `UPDATE … WHERE quantity_on_hand >= n`, then WS2's charge capture per row; finally `syncInventoryTotal`. Drugs with no batch rows keep WS2's behaviour unchanged.
- Response `201 { ids: number[]; allocations: { dispenseId, batchId, batchNo, expiryMonth, quantity }[] }` (WS2 fields kept; `id` stays the first id for old callers). New refusals: `409 { code: 'batch_expired' }`, `409 { code: 'insufficient_stock' }` (existing message kept), `400 { code: 'batch_mismatch' }`.

- [ ] **Step 1: Write failing tests**: FEFO across two batches writes two dispense rows, each with its own batch and expiry and its own charge line; a chosen expired batch → 409 `batch_expired` and nothing written; another drug's batch → 400; two parallel dispenses of the last 5 units → one 201, one 409; `SUM(batches) = on hand` after each case; the dialog defaults to the FEFO batch and disables expired ones.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS (+ `tests/api/pharmacy-dispense-charge.test.ts`).
- [ ] **Step 5: Commit** `feat(pharmacy): dispensing draws from batches by FEFO with expired-batch refusal`.

### Task 6: Doctor working hours, slot length, leave and computed slots

**Files:**
- Create: `scripts/migrations/2026-10-24-ws6-provider-schedules.sql`, `src/lib/scheduling/slots.ts`, `src/lib/queries/provider-schedules.ts`, `src/app/api/providers/[id]/schedule/route.ts`, `src/app/api/providers/[id]/slots/route.ts`, `src/components/settings/ProviderSchedulePanel.tsx`
- Modify: `src/db/schema.ts` (block `// WS6 T6`: `providerSchedules`, `providerLeave`; on `providers`: `slotMinutes`, `opdRoom`, `portalBookable`), `src/lib/validation/provider-profile.ts` (`opdRoom`, `portalBookable`), `src/lib/queries/providers.ts` (`updateProviderProfile` writes them), `src/components/settings/ProviderProfilesPanel.tsx` ("Working hours" opens the panel), `tests/api/rbac-route-gates.test.ts`
- Test: `tests/lib/scheduling/slots.test.ts`, `tests/api/provider-schedule.test.ts`, `tests/components/settings/ProviderSchedulePanel.test.tsx`

**Interfaces:**
- Migration: `providers.slot_minutes int NOT NULL DEFAULT 15 CHECK (slot_minutes BETWEEN 5 AND 60)`, `opd_room text`, `portal_bookable boolean NOT NULL DEFAULT true`; the `UPDATE … SET portal_bookable = false` for providers in departments with `kind <> 'clinical'` runs inside the same `DO $$ … $$` block that adds the column only when it is missing, so a re-run never overwrites a later admin change (Plan B Task 7 uses the same guarded statement).
- `interface WeeklySession { weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6; start: string /* HH:MM */; end: string }`
- `buildSlots(i: { dateIso: string; sessions: WeeklySession[]; slotMinutes: number; onLeave: boolean; booked: { startsAt: Date; endsAt: Date }[]; now: Date }): { startsAt: Date; endsAt: Date; status: 'free' | 'booked' | 'past' }[]` (IST wall clock → instants via `startOfIstDay`; weekday of the IST date).
- `withinWorkingHours(i: { startsAt: Date; endsAt: Date; sessions: WeeklySession[]; onLeave: boolean }): boolean`.
- `GET /api/providers/[id]/schedule` (`SCHEDULING_ROLES`) → `{ slotMinutes, opdRoom, sessions, leave: { date, reason }[] }`; `PUT` (`MASTER_DATA_ADMIN_ROLES`) body `{ slotMinutes: int 5..60, multiple of 5; sessions: WeeklySession[] (..21; end > start; no overlap within a weekday); leave: { date: 'YYYY-MM-DD'; reason: string(1..120) }[] (..60) }` replaces sessions and future leave in one transaction; audit `updated provider schedule`.
- `GET /api/providers/[id]/slots?date=YYYY-MM-DD` (`SCHEDULING_ROLES`) → `{ date, slotMinutes, onLeave, slots: { startsAt, endsAt, status }[] }`; dates over 90 days ahead → 400; unknown provider → 404.

- [ ] **Step 1: Write failing tests**: Mon 09:00–13:00 at 15 min → 16 slots; a booked 09:30–09:45 marks that slot `booked`; at 10:05 IST today slots up to 10:00 are `past`; a leave day returns none with `onLeave: true`; overlapping sessions in PUT → 400; `slotMinutes: 7` → 400; frontdesk PUT → 403; the panel edits Mon–Sat sessions and saves with a toast.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; migrate + schema-diff on the test DB.
- [ ] **Step 5: Commit** `feat(scheduling): doctor working hours, slot length, leave and computed slots`.

### Task 7: Slot picker in booking; register from a booking request; no past default date

**Files:**
- Create: `src/components/scheduling/SlotPicker.tsx`, `src/lib/scheduling/default-booking-date.ts`
- Modify: `src/components/NewEventModal.tsx`, `src/components/ConfirmBookingRequestModal.tsx` (date defaults via `defaultBookingDate`, `min` = today, slot picker), `src/components/BookingRequestsQueue.tsx` ("Register from this request" when `patientId` is null), `src/components/AddClientModal.tsx` (already accepts `initial` and `onRegistered`; map request fields into `RegistrationFormState`), `src/app/api/appointments/route.ts` and `src/app/api/booking-requests/[id]/confirm/route.ts` (accept `outsideHoursConfirmed?: boolean`; a start outside working hours without it → `422 { code: 'outside_working_hours' }`)
- Test: `tests/lib/scheduling/default-booking-date.test.ts`, `tests/components/scheduling/SlotPicker.test.tsx`, extend `tests/components/NewEventModal.test.tsx`, `tests/components/ConfirmBookingRequestModal.test.tsx`, `tests/api/appointments.test.ts`, `tests/api/booking-requests-confirm.test.ts`

**Interfaces:**
- `defaultBookingDate(rangeStart: string, rangeEnd: string, todayIso: string): string` → `rangeStart` if ≥ today, else today (also when the whole range is past).
- `SlotPicker({ providerId: number; date: string; value: { startsAt: string; endsAt: string } | null; onChange(v: { startsAt: string; endsAt: string; outsideHours: boolean }): void; allowCustom: boolean })` fetches `/api/providers/[id]/slots`; "Other time" reveals the two time inputs and an "Outside working hours" confirmation checkbox when the time falls outside.
- Register flow: `BookingRequestsQueue` → `AddClientModal initial={{ …EMPTY_REGISTRATION_FORM, name, dob, phone, email }}` → `onRegistered(patientId)` opens `ConfirmBookingRequestModal` with that patient picked.

- [ ] **Step 1: Write failing tests**: range 2026-10-20..22 with today 2026-10-23 → 2026-10-23; range 2026-10-25..27 → 2026-10-25; the confirm modal's date input defaults accordingly with `min` = today; picking a free slot fills start/end; booked and past slots are disabled; POST outside hours without the flag → 422, with it → 201; "Register from this request" opens registration prefilled with name, DOB and phone and, after success, the confirm dialog shows that patient; the existing overlap 409 still holds.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS (+ `tests/pages/calendar.test.tsx`, `tests/components/booking-requests-portal.test.tsx`).
- [ ] **Step 5: Commit** `feat(scheduling): slot picker, register from booking request, no past default dates`.

### Task 8: Registration in steps with photo, referral source and doctor availability

**Files:**
- Create: `scripts/migrations/2026-10-24-ws6-referral-source.sql`, `src/components/registration/RegistrationStepper.tsx`, `src/components/registration/PhotoCapture.tsx`, `src/app/api/patients/[anonId]/photo/route.ts`
- Modify: `src/db/schema.ts` (`// WS6 T8` on `patients`: `referralSource` text `CHECK IN ('self','doctor','hospital','camp','insurer','online','other')`, `referralNote` text), `src/components/AddClientModal.tsx` (steps Identity → Contact & address → IDs & insurance → Review; progress bar "Step 2 of 4"; per-step validation with `fieldErrors`; draft in `sessionStorage` per open dialog, cleared on success, wrapped in try/catch), `src/components/registration/registration-form-state.ts` (`referralSource`, `referralNote`), `src/lib/validation/patient-registration.ts`, `src/lib/queries/patient-registration.ts` (`registerPatient` stores them), `tests/api/rbac-route-gates.test.ts`
- Test: `tests/components/registration/RegistrationStepper.test.tsx`, `tests/api/patients-photo.test.ts`, extend `tests/api/patients-register.test.ts`, `tests/lib/registration-form-state.test.ts`

**Interfaces:**
- `POST /api/patients/[anonId]/photo` (roles `REGISTRATION_ROLES` ∪ `PATIENT_PROFILE_EDIT_ROLES`), multipart `file` (JPEG/PNG/WebP ≤ 2 MB, magic bytes checked) → `putPrivateBlob`, sets the existing `patients.photo_blob_path` → `201 { ok: true }`; `GET` (`PATIENT_DIRECTORY_ROLES`) streams it through `streamPrivateBlob`, audit `viewed patient photo`. No driver → 503 `serviceUnavailableBody('blob')`.
- `PhotoCapture({ onCaptured(file: File): void })` uses `navigator.mediaDevices.getUserMedia` when available, a file input otherwise.
- Review step: "Next available: Dr Rao today 11:30 · Room 4" from `/api/providers/[id]/slots` for the chosen department's clinical doctors; hidden when that route answers 404 (stream S not merged).

- [ ] **Step 1: Write failing tests**: "Next" is disabled while step 1 has errors; Back keeps values; the progress bar reads "Step 3 of 4"; referral `doctor` requires a note; a 3 MB photo or a PDF renamed `.jpg` → 400; photo GET streams bytes and never returns a URL; register stores `referral_source`; the success toast offers "Check in now" and "Print registration slip".
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS (+ `tests/components/AddClientModal.test.tsx`, `tests/components/registration`).
- [ ] **Step 5: Commit** `feat(registration): stepped form with progress, photo, referral source and doctor availability`.

### Task 9: Check-in by department with queue length; token slip with doctor, room and wait; named assignments

**Files:**
- Create: `src/lib/front-desk/wait-estimate.ts`, `src/lib/queries/front-desk-queue.ts`, `src/app/api/front-desk/queue-summary/route.ts`
- Modify: `src/components/CheckInModal.tsx` (department select → clinical doctors of that department; each option "3 waiting · ~30 min", "On leave" or "Outside hours"; success toast "Token 12 issued" with "Print token slip"), `src/app/(dashboard)/front-desk/check-in/page.tsx` (pass departments), `src/lib/queries/print-slips.ts` (`TokenSlip` gains `roomLabel: string | null` = bed room or `providers.opd_room`, `waitingAhead: number`, `estimatedWaitMinutes: number | null`), `src/app/print/token/[encounterId]/page.tsx`, `src/lib/queries/doctor-assignments.ts` (`listAllAssignments` joins `patients`), `src/app/(dashboard)/front-desk/assignments/page.tsx` (patient column "Name · UHID", `EmptyState`), `tests/api/rbac-route-gates.test.ts`
- Test: `tests/lib/front-desk/wait-estimate.test.ts`, `tests/api/front-desk-queue-summary.test.ts`, extend `tests/components/CheckInModal.test.tsx`, `tests/pages/print-token-slip.test.tsx`, `tests/pages/front-desk-check-in-page.test.tsx`

**Interfaces:**
- `estimateWaitMinutes(waitingAhead: number, slotMinutes: number | null): number | null` (null slot length → 10; capped at 240; 0 ahead → 0).
- `GET /api/front-desk/queue-summary` (`CHECK_IN_ROLES`) → `{ providers: { providerId: number; departmentId: number | null; waiting: number; inConsultation: number; estimatedWaitMinutes: number | null; availability: 'available' | 'on_leave' | 'outside_hours' }[] }` from today's (IST) OPD encounters.
- `listAllAssignments(): Promise<(DoctorAssignmentRow & { patientName: string; uhid: string | null })[]>`.
- Inpatient check-in stays as it is here; WS3 replaces it with the admission form.

- [ ] **Step 1: Write failing tests**: a doctor in a `diagnostic` department (pathologist) is not offered; choosing General Medicine lists only its doctors; the summary counts only today's `checked_in` as waiting; the token slip shows the doctor, "Room 4" and "About 30 minutes" for 3 ahead at 10 min; the assignments page shows "Sarojamma K · UH…" and never `RD-0040`; an empty list renders `EmptyState`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS (+ `tests/api/front-desk-check-in*.test.ts`).
- [ ] **Step 5: Commit** `feat(front-desk): department-filtered check-in with queue length, fuller token slip, named assignments`.

### Task 10: Queue display "now serving", doctor and room, language; settings card with PIN and preview

**Files:**
- Create: `src/lib/queue-display-i18n.ts`, `src/app/api/settings/queue-display-pin/generate/route.ts`, `src/components/settings/QueueDisplayCard.tsx`
- Modify: `src/lib/queries/queue-display.ts` (`QueueDisplayRow` gains `providerName: string`, `room: string | null`; join `providers` and `rooms`), `src/app/display/queue/page.tsx` ("Now serving" band with the three most recent ready tokens, doctor and room; `?lang=en|hi|kn` and a toggle), `src/app/(dashboard)/settings/page.tsx` (replace the bare `QueueDisplayPinForm` with `QueueDisplayCard`), `src/components/QueueDisplayPinForm.tsx` (kept inside the card for a custom PIN), `tests/api/rbac-route-gates.test.ts`
- Test: `tests/lib/queue-display-i18n.test.ts`, extend `tests/api/queue-display.test.ts`, `tests/api/settings-queue-display-pin.test.ts`, create `tests/components/settings/QueueDisplayCard.test.tsx`, `tests/pages/queue-display-page.test.tsx`

**Interfaces:**
- `QUEUE_LABELS: Record<'en' | 'hi' | 'kn', { nowServing: string; waiting: string; ready: string; room: string; noTickets: string; urgent: string; emergency: string }>`; `queueLabels(lang: string | null)` (unknown → English).
- `POST /api/settings/queue-display-pin/generate` (admin) body `{}` strict → `200 { pin }` (6 digits from `crypto.randomInt`, stored through the existing setter in `src/lib/queries/settings.ts`, shown once; audit `generated queue display PIN` without the PIN).
- The public `GET /api/queue-display` rows add `providerName` and `room` only.

- [ ] **Step 1: Write failing tests**: rows carry doctor and room but no key containing `patient`, `uhid` or `name` other than `providerName`; "Now serving" shows the most recent ready tokens; `?lang=kn` shows Kannada labels and `?lang=xx` falls back to English; generate returns 6 digits that then unlock the display API; non-admin → 403; the card shows "Not set up", then "PIN set" with an "Open preview" link to `/display/queue?lang=en`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(queue): now-serving band with doctor and room, Hindi and Kannada labels, PIN card with preview`.

### Task 11: Collector: visit-date guard, map link, handover OTP

**Precondition:** Foundations Tasks 8–9 merged.

**Files:**
- Create: `src/lib/home-collection/maps.ts`, `src/lib/home-collection/handover-otp.ts`, `scripts/migrations/2026-10-24-ws6-home-collection-handover.sql`, `src/app/api/home-collections/[id]/otp/route.ts`
- Modify: `src/db/schema.ts` (`// WS6 T11` on `homeCollectionVisits`: `handoverOtpHash`, `handoverOtpExpiresAt`, `handoverOtpAttempts` int default 0, `handoverVerifiedAt`, `handoverWaiverReason`), `src/lib/notify/templates.ts` (append `home_collection_handover_otp`, vars `{ hospitalName: string; otp: string }`), `src/lib/queries/home-collections.ts` (`collectHomeVisit(visitId, sampleIds, session, now, handover: { otp?: string; waiverReason?: 'no_phone' | 'sms_unavailable' | 'patient_declined' })`; new errors `'not_due' | 'otp_required' | 'otp_invalid' | 'otp_expired' | 'otp_locked'`), `src/lib/labs/validation.ts` (`collectHomeVisitSchema` adds `otp?: /^\d{6}$/`, `waiverReason?`), `src/app/api/home-collections/[id]/collect/route.ts`, `src/lib/rate-limit.ts` (append `checkHandoverOtpSendRateLimit(visitId: number)`: 3 per 15 min), `src/components/home-collection/CollectorRoute.tsx` ("Open in Maps", "Send OTP", OTP field, waiver select; Collect disabled before the visit date with "Visit is on 24 Oct"), `tests/api/rbac-route-gates.test.ts`
- Test: `tests/lib/home-collection/maps.test.ts`, `tests/lib/home-collection/handover-otp.test.ts`, extend `tests/api/home-collections-collect-route.test.ts`; create `tests/components/home-collection/CollectorRoute.test.tsx`

**Interfaces:**
- `mapsUrl(a: { addressLine1: string; addressLine2?: string | null; landmark?: string | null; city: string; pinCode: string }): string` → `https://www.google.com/maps/search/?api=1&query=<encoded>`.
- `issueHandoverOtp(visitId: number, session: Session, now?: Date): Promise<{ ok: true; channelStatus: 'sent' | 'log_only' | 'skipped' } | { ok: false; error: 'not_found' | 'not_assigned' | 'not_due' | 'not_collectable' | 'no_phone' }>` (code from `crypto.randomInt`, stored with `hashPassword`, 15-minute expiry, attempts reset, sent with `sendNotification` to `contact_phone`).
- `checkHandoverOtp(row: { hash: string | null; expiresAt: Date | null; attempts: number }, code: string, now: Date): 'ok' | 'invalid' | 'expired' | 'locked'` (locked at 5).
- `POST /api/home-collections/[id]/otp` (`COLLECTOR_ROUTE_ROLES`) body `{}` strict → `200 { channelStatus }`. The OTP never appears in a response, log or audit row.

- [ ] **Step 1: Write failing tests**: collecting a visit dated tomorrow (IST) → 409 "This visit is on 24 Oct 2026. It can be collected on that day."; no OTP and no waiver → 409 `otp_required`; a wrong OTP increments attempts and the sixth try is `otp_locked`; the correct OTP collects and sets `handover_verified_at`; waiver `sms_unavailable` collects and stores the reason; another collector's visit → 403; `mapsUrl` encodes landmark and PIN; sending records one `notification_log` row for `home_collection_handover_otp` and no body.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS (+ `tests/api/home-collections-routes.test.ts`).
- [ ] **Step 5: Commit** `feat(collections): visit-date guard, map link and handover OTP for home collection`.

### Task 12: Payment at the door (cash or UPI)

**Files:**
- Create: `src/app/api/home-collections/[id]/payment/route.ts`, `src/app/api/home-collections/[id]/payment/confirm/route.ts`, `src/components/home-collection/DoorPaymentDialog.tsx`
- Modify: `src/lib/queries/home-collections.ts` (append `assertCollectorVisit(visitId: number, session: Session, todayIso: string): Promise<{ ok: true; patientId: string } | { ok: false; error: 'not_found' | 'not_assigned' | 'not_due' | 'not_collectable' }>`, shared with Task 11), `src/components/home-collection/CollectorRoute.tsx` ("Collect payment" with the amount due for the visit's lab orders), `tests/api/rbac-route-gates.test.ts`
- Test: `tests/api/home-collections-payment.test.ts`, `tests/components/home-collection/DoorPaymentDialog.test.tsx`

**Interfaces:**
- Consumes `recordPayment` (`src/lib/queries/patient-ledger.ts`), `createUpiRequest`, `confirmUpiRequest` (`src/lib/payments/manual-upi.ts`), `UPI_NOT_CONFIGURED_MESSAGE`, `normaliseUtr`.
- `POST /api/home-collections/[id]/payment` (`COLLECTOR_ROUTE_ROLES`) body `{ mode: 'cash' | 'upi'; amountPaise: int 100..10_000_000 }` → cash `201 { receiptNumber }`; UPI `201 { requestId, qrDataUrl, amountPaise }` or 503 with the UPI message. Ledger note `Home collection visit #<id>`.
- `POST /api/home-collections/[id]/payment/confirm` body `{ requestId: number; utr: string }` → `201 { receiptNumber }`; a used UTR → 409 (existing path); the request must belong to this visit's patient.
- Both refuse via `assertCollectorVisit`: 403 not assigned, 409 not due or not collectable, 404 not found.

- [ ] **Step 1: Write failing tests**: cash posts exactly one ledger row (mode `cash`, `RCT/…`); UPI returns a QR and confirm with a UTR posts one row; the same UTR again → 409 and no second row; another collector → 403; tomorrow's visit → 409; amount 0 → 400; `HOSPITAL_UPI_VPA` unset → 503 "UPI is not set up. Ask your administrator."; the dialog shows the receipt number in a toast.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; RBAC rows for both routes.
- [ ] **Step 5: Commit** `feat(collections): cash and UPI payment at the door through the one ledger`.

### Task 13 (closing, not a build task): Plan verification walkthrough

- [ ] **Step 1:** Merge streams 0, P, S, R, C into `feat/hospital-completion` in that order; resolve only delimited shared blocks. `source $SCRATCH/testenv.sh && npm run db:migrate && npx vitest run` → green; `npx tsc --noEmit`, `npm run lint` → clean.
- [ ] **Step 2:** Docker walkthrough with `ENABLE_TRIALS` unset, then `true`: GRN → batches and expiry chips → write-off → dispense by FEFO across two batches with two bill lines; set Dr Rao's hours → slot-picker booking → outside-hours confirmation; register from a booking request (date never in the past); stepped registration with photo and referral; check-in by department with queue length and the token slip; queue display in Kannada with "now serving"; collector: tomorrow's visit refused, OTP handover, cash and UPI at the door.
- [ ] **Step 3:** Tick C5–C10, D1 (batch half), D2, D3, I15, I16 in the gap-closure plan. Commit `docs: WS5/WS6 verified`.
