import { getDb } from '@/db/client'
import { homeCollectionVisits, labOrders, labResults, labTests, patients, providers } from '@/db/schema'
import { asc, desc, eq, inArray, sql } from 'drizzle-orm'
import type { LabQuoteStatus } from '@/lib/labs/catalog' // SP5
import { listImagingForOrders, type ImagingAttachment } from '@/lib/queries/documents'
import { PRE_RESULT_STATUSES, type LabOrderStatus } from '@/lib/labs/status' // SP5

// SP5: orders are created only as part of a requisition (createLabRequisition in
// src/lib/queries/lab-requisitions.ts); the single-order createLabOrder was removed.

// SP5: the old markCollected / enterResult / cancelOrder were replaced by the lifecycle
// transitions in src/lib/queries/lab-lifecycle.ts (collect, receive, result, verify, cancel).

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
  // SP5
  sampleId: string | null
  requisitionId: number | null
  quotedPricePaise: number | null
  quoteStatus: LabQuoteStatus
  verifiedByName: string | null
  verifiedAt: Date | null
  // end SP5
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
    // SP5
    sampleId: r.order.sampleId,
    requisitionId: r.order.requisitionId,
    quotedPricePaise: r.order.quotedPricePaise,
    quoteStatus: r.order.quoteStatus,
    verifiedByName: r.order.verifiedByName,
    verifiedAt: r.order.verifiedAt,
    // end SP5
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
  // SP5: stage data for the worklist
  sampleId: string | null
  requisitionId: number | null
  homeCollectionVisitId: number | null
  visitDate: string | null
  receivedAt: Date | null
  verifiedAt: Date | null
  patientUhid: string | null
  result: { value: string; unit: string | null; flag: 'normal' | 'abnormal' | 'critical'; resultedByName: string; amendedAt: Date | null } | null
  // end SP5
}

function mapWorklistRow(r: {
  order: typeof labOrders.$inferSelect
  test: typeof labTests.$inferSelect
  patientName: string
  patientUhid: string | null
  provider: typeof providers.$inferSelect
  visitDate: string | null
  result: typeof labResults.$inferSelect | null
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
    // SP5
    sampleId: r.order.sampleId,
    requisitionId: r.order.requisitionId,
    homeCollectionVisitId: r.order.homeCollectionVisitId,
    visitDate: r.visitDate,
    receivedAt: r.order.receivedAt,
    verifiedAt: r.order.verifiedAt,
    patientUhid: r.patientUhid,
    result: r.result
      ? { value: r.result.value, unit: r.result.unit, flag: r.result.flag, resultedByName: r.result.resultedByName, amendedAt: r.result.amendedAt }
      : null,
    // end SP5
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
      patientUhid: patients.uhid, // SP5 (named column)
      provider: providers,
      visitDate: homeCollectionVisits.visitDate, // SP5
      result: labResults, // SP5
    })
    .from(labOrders)
    .innerJoin(labTests, eq(labOrders.labTestId, labTests.id))
    .innerJoin(patients, eq(labOrders.patientId, patients.id))
    .innerJoin(providers, eq(labOrders.orderedByProviderId, providers.id))
    .leftJoin(homeCollectionVisits, eq(homeCollectionVisits.id, labOrders.homeCollectionVisitId)) // SP5
    .leftJoin(labResults, eq(labResults.labOrderId, labOrders.id)) // SP5
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

// SP5: one printable label per order (sample ID, test, container, patient name + UHID only).
export interface SampleLabelRow {
  orderId: number
  sampleId: string | null
  testName: string
  container: string | null
  patientName: string
  uhid: string | null
}

export async function listLabelsForOrders(ids: number[]): Promise<SampleLabelRow[]> {
  if (ids.length === 0) return []
  return getDb()
    .select({
      orderId: labOrders.id,
      sampleId: labOrders.sampleId,
      testName: labTests.name,
      container: labTests.container,
      patientName: sql<string>`patients.name`,
      uhid: patients.uhid,
    })
    .from(labOrders)
    .innerJoin(labTests, eq(labOrders.labTestId, labTests.id))
    .innerJoin(patients, eq(labOrders.patientId, patients.id))
    .where(inArray(labOrders.id, ids))
    .orderBy(asc(labOrders.id))
}
// end SP5
