import { getDb } from '@/db/client'
import { labOrders, labResults, labTests, patients, providers } from '@/db/schema'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { listImagingForOrders, type ImagingAttachment } from '@/lib/queries/documents'
import { PRE_RESULT_STATUSES, type LabOrderStatus } from '@/lib/labs/status' // SP5

// SP5: orders are created only as part of a requisition (createLabRequisition in
// src/lib/queries/lab-requisitions.ts); the single-order createLabOrder was removed.

type LifecycleResult = { ok: true; patientId: string } | { ok: false; error: string }

/**
 * Single conditional UPDATE keyed on current status (`ordered` only) — an
 * affected-row-count of 0 means the order either doesn't exist or is
 * already past `ordered`, both of which are "not collectible right now"
 * from the caller's point of view (Review Focus #2: a second call on an
 * already-`collected` order must not re-stamp `collectedAt`).
 */
export async function markCollected(orderId: number): Promise<LifecycleResult> {
  const updated = await getDb().update(labOrders)
    .set({ status: 'collected', collectedAt: new Date() })
    .where(and(eq(labOrders.id, orderId), eq(labOrders.status, 'ordered')))
    .returning({ id: labOrders.id, patientId: labOrders.patientId })
  if (updated.length === 0) return { ok: false, error: 'Order is not in ordered status' }
  return { ok: true, patientId: updated[0].patientId }
}

export interface EnterResultInput {
  value: string
  unit?: string
  referenceRange?: string
  flag: 'normal' | 'abnormal' | 'critical'
  notes?: string
  resultedByName: string
}

/**
 * Guards the `collected -> resulted` transition in the UPDATE's WHERE
 * clause and only inserts the `labResults` row once that UPDATE has
 * actually affected a row (Review Focus #1: a result can never be entered
 * against an order that hasn't been collected — the row simply won't be
 * there to attach a result to).
 */
export interface EnterResultOptions {
  /** Webhook only: the order must belong to this patient (checked atomically in the UPDATE's WHERE). */
  expectedPatientId?: string
  /** Runs inside the same transaction after the result is stored; if it throws, everything rolls back. */
  afterEntered?: (tx: DbTx, patientId: string) => Promise<void>
}
export type DbTx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0]

export async function enterResult(orderId: number, input: EnterResultInput, opts: EnterResultOptions = {}): Promise<LifecycleResult> {
  return getDb().transaction(async (tx) => {
    const conditions = [eq(labOrders.id, orderId), eq(labOrders.status, 'collected')]
    if (opts.expectedPatientId !== undefined) conditions.push(eq(labOrders.patientId, opts.expectedPatientId))
    const updated = await tx.update(labOrders)
      .set({ status: 'resulted' })
      .where(and(...conditions))
      .returning({ id: labOrders.id, patientId: labOrders.patientId })
    if (updated.length === 0) {
      return { ok: false, error: opts.expectedPatientId !== undefined ? 'Order is not in collected status for this patient' : 'Order is not in collected status' } as const
    }

    await tx.insert(labResults).values({
      labOrderId: orderId,
      value: input.value,
      unit: input.unit ?? null,
      referenceRange: input.referenceRange ?? null,
      flag: input.flag,
      resultedByName: input.resultedByName,
      notes: input.notes ?? null,
    })

    if (opts.afterEntered) await opts.afterEntered(tx, updated[0].patientId)
    return { ok: true, patientId: updated[0].patientId } as const
  })
}

/**
 * `cancelOrder` guards `status IN ('ordered', 'collected')` — both
 * non-terminal states — in its WHERE, rejecting `resulted` and
 * `cancelled` alike (Review Focus #3: cancelling a terminal-state order,
 * whether already resulted or already cancelled, must fail).
 *
 * `reason` isn't stored on `labOrders` (no such column on this schema —
 * Task 1's approved shape has no cancel-reason field), so it's validated
 * here for defense in depth and left for the calling route to fold into
 * `logAudit`'s free-text action, the same place other unstored-but-required
 * context (e.g. discharge/transfer notes) ends up in this codebase when
 * there's no dedicated column for it.
 */
export async function cancelOrder(orderId: number, reason: string): Promise<LifecycleResult> {
  if (!reason || !reason.trim()) return { ok: false, error: 'A reason is required to cancel an order' }

  const updated = await getDb().update(labOrders)
    .set({ status: 'cancelled' })
    .where(and(eq(labOrders.id, orderId), inArray(labOrders.status, ['ordered', 'collected'])))
    .returning({ id: labOrders.id, patientId: labOrders.patientId })
  if (updated.length === 0) return { ok: false, error: 'Order is not in a cancellable status' }
  return { ok: true, patientId: updated[0].patientId }
}

export interface PatientLabOrderRow {
  id: number
  status: LabOrderStatus // SP5: widened to every lab_order_status value
  orderedAt: Date
  collectedAt: Date | null
  testId: number
  testName: string
  testCode: string
  category: 'lab' | 'imaging'
  defaultUnit: string | null
  referenceRange: string | null
  attachments: ImagingAttachment[]
  result: {
    value: string
    unit: string | null
    referenceRange: string | null
    flag: 'normal' | 'abnormal' | 'critical'
    resultedByName: string
    resultedAt: Date
    notes: string | null
  } | null
}

function mapPatientOrderRow(r: {
  order: typeof labOrders.$inferSelect
  test: typeof labTests.$inferSelect
  result: typeof labResults.$inferSelect | null
}): Omit<PatientLabOrderRow, 'attachments'> {
  return {
    id: r.order.id,
    status: r.order.status,
    orderedAt: r.order.orderedAt,
    collectedAt: r.order.collectedAt,
    testId: r.test.id,
    testName: r.test.name,
    testCode: r.test.code,
    category: r.test.category,
    defaultUnit: r.test.defaultUnit,
    referenceRange: r.test.referenceRange,
    result: r.result ? {
      value: r.result.value,
      unit: r.result.unit,
      referenceRange: r.result.referenceRange,
      flag: r.result.flag,
      resultedByName: r.result.resultedByName,
      resultedAt: r.result.resultedAt,
      notes: r.result.notes,
    } : null,
  }
}

/** A single patient's lab history, newest order first — independent of any other patient's (see the patient-scoping test). */
export async function listOrdersForPatient(patientId: string): Promise<PatientLabOrderRow[]> {
  const rows = await getDb()
    .select({ order: labOrders, test: labTests, result: labResults })
    .from(labOrders)
    .innerJoin(labTests, eq(labOrders.labTestId, labTests.id))
    .leftJoin(labResults, eq(labResults.labOrderId, labOrders.id))
    .where(eq(labOrders.patientId, patientId))
    .orderBy(desc(labOrders.orderedAt))

  const mapped = rows.map(mapPatientOrderRow)
  const byOrder = await listImagingForOrders(mapped.map((r) => r.id))
  return mapped.map((r) => ({ ...r, attachments: byOrder.get(r.id) ?? [] }))
}

export interface WorklistRow {
  id: number
  status: LabOrderStatus // SP5: widened to every lab_order_status value
  orderedAt: Date
  collectedAt: Date | null
  patientId: string
  patientName: string
  testId: number
  testName: string
  testCode: string
  category: 'lab' | 'imaging'
  attachments: ImagingAttachment[]
  orderedByProviderId: number
  orderedByProviderName: string
}

function mapWorklistRow(r: {
  order: typeof labOrders.$inferSelect
  test: typeof labTests.$inferSelect
  patientName: string
  provider: typeof providers.$inferSelect
}): Omit<WorklistRow, 'attachments'> {
  return {
    id: r.order.id,
    status: r.order.status,
    orderedAt: r.order.orderedAt,
    collectedAt: r.order.collectedAt,
    patientId: r.order.patientId,
    patientName: r.patientName,
    testId: r.test.id,
    testName: r.test.name,
    testCode: r.test.code,
    category: r.test.category,
    orderedByProviderId: r.order.orderedByProviderId,
    orderedByProviderName: r.provider.name,
  }
}

/** All orders across all patients, newest first, joined for display on the worklist screen. */
export async function listWorklist(): Promise<WorklistRow[]> {
  const rows = await getDb()
    .select({
      order: labOrders,
      test: labTests,
      // Narrow, raw-`sql` patient column, NOT `patient: patients` --
      // schema.ts here still declares patients' pre-unification
      // `nameTebra`/`nameIntakeq`/`dobTebra`/`dobIntakeq` columns, but a
      // separate, concurrently-running worktree's migration
      // (`feature/unified-patient-record`) has already collapsed the live
      // shared Neon DB's `patients` table down to single `name`/`dob`
      // columns (the same standing cross-worktree drift Task 1's report on
      // this plan diagnosed). A bare `patient: patients` select spreads
      // every column schema.ts declares and 42703s against the real DB.
      // See src/lib/queries/documents.ts:26-40 for the same pattern.
      patientName: sql<string>`patients.name`,
      provider: providers,
    })
    .from(labOrders)
    .innerJoin(labTests, eq(labOrders.labTestId, labTests.id))
    .innerJoin(patients, eq(labOrders.patientId, patients.id))
    .innerJoin(providers, eq(labOrders.orderedByProviderId, providers.id))
    .orderBy(desc(labOrders.orderedAt))

  const mapped = rows.map(mapWorklistRow)
  const byOrder = await listImagingForOrders(mapped.map((r) => r.id))
  return mapped.map((r) => ({ ...r, attachments: byOrder.get(r.id) ?? [] }))
}

export interface LabPatientRosterRow {
  id: string
  name: string
  resultedCount: number
  pendingCount: number
}

/**
 * Every patient with at least one lab order, for the Labs role's
 * patient-first landing view -- click a patient, see their reports as
 * cards (listOrdersForPatient already has everything a card needs: result
 * value/flag, reference range, and any imaging attachments).
 */
// SP5: statuses in which the order carries a result.
const RESULTED_STATUSES: readonly LabOrderStatus[] = ['resulted', 'verified', 'reported']

export async function listPatientsWithLabOrders(): Promise<LabPatientRosterRow[]> {
  const rows = await getDb()
    .select({
      patientId: labOrders.patientId,
      patientName: sql<string>`patients.name`,
      status: labOrders.status,
    })
    .from(labOrders)
    .innerJoin(patients, eq(labOrders.patientId, patients.id))

  const byPatient = new Map<string, LabPatientRosterRow>()
  for (const r of rows) {
    const existing = byPatient.get(r.patientId) ?? { id: r.patientId, name: r.patientName, resultedCount: 0, pendingCount: 0 }
    // SP5: a result exists from `resulted` on; everything before it is pending.
    if (RESULTED_STATUSES.includes(r.status)) existing.resultedCount += 1
    else if ((PRE_RESULT_STATUSES as readonly LabOrderStatus[]).includes(r.status)) existing.pendingCount += 1
    byPatient.set(r.patientId, existing)
  }
  return [...byPatient.values()].sort((a, b) => a.name.localeCompare(b.name))
}
