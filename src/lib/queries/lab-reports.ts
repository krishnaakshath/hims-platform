// SP5 lab report release (Task 14): a versioned PDF per requisition, stored privately, with a
// stale guard and the doctor's follow-up request resolved once every test is reported.
//
// Side effects that can fail (PDF render, blob upload) run BEFORE the transaction, on an unlocked
// snapshot. The transaction then locks and re-reads; if the set of verified/reported orders or
// any result's amendedAt changed meanwhile the release is `stale` and writes nothing (the
// uploaded blob is left orphaned, the blob-before-DB precedent of the document uploads).
//
// Lock order (never reverse it; 40P01/40001 surface to the route, which maps them to 409):
//   1. lab_requisitions row, `for update`
//   2. lab_orders rows of the requisition, `for update`, by ascending id
//   3. follow_up_orders row (the open follow-up being linked), `for update`
// Notifications are sent by the route AFTER commit, never here.
import { createHash, randomUUID } from 'node:crypto'
import { and, asc, desc, eq, gte, inArray, isNull, ne, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { followUpOrders, labOrders, labReports, labRequisitions, labResults, labTests, patients, providers } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { brand } from '@/lib/brand'
import { isUniqueViolation } from '@/lib/db-errors'
import { istDateOf } from '@/lib/india-time'
import { buildLabReportData, hospitalFromBrand, type LabReportData, type LabReportSource } from '@/lib/labs/report-data'
import { renderLabReportPdf } from '@/lib/labs/report-pdf'
import { PRE_RESULT_STATUSES, type LabOrderStatus } from '@/lib/labs/status'
import { putPrivateBlob } from '@/lib/blob-store'
import { createFollowUpOrder } from './follow-ups'
import type { WriteExecutor } from './executor'
import { getPracticeIdentity } from './settings'

export type LabReportRow = typeof labReports.$inferSelect
export type LabRequisitionRow = typeof labRequisitions.$inferSelect

export interface ReleaseDeps {
  render(d: LabReportData): Promise<Uint8Array>
  putBlob(path: string, bytes: Uint8Array): Promise<{ url: string }>
  now(): Date
}

const DEFAULT_DEPS: ReleaseDeps = {
  render: renderLabReportPdf,
  putBlob: (path, bytes) => putPrivateBlob(path, bytes, 'application/pdf'),
  now: () => new Date(),
}

export type LabFollowUpOutcome = 'not_requested' | 'pending' | 'created' | 'linked' | 'failed' | 'already_resolved'
export interface LabFollowUpResult { outcome: LabFollowUpOutcome; followUpOrderId: number | null; dueDate: string | null }

export type ReleaseLabReportResult =
  | { ok: true; report: LabReportRow; followUp: LabFollowUpResult }
  | { ok: false; error: 'not_found' | 'nothing_to_report' | 'stale' }

/** Orders still before a verified result: their requisition's follow-up waits for them. */
const NOT_YET_REPORTABLE: readonly LabOrderStatus[] = [...PRE_RESULT_STATUSES, 'resulted']
const REPORTABLE: LabOrderStatus[] = ['verified', 'reported']
const MAX_TEST_SUMMARY = 500

function rowsOf<T>(res: unknown): T[] {
  return (Array.isArray(res) ? res : (res as { rows: unknown[] }).rows) as T[]
}

export async function nextLabReportNumber(now: Date, ex: Pick<WriteExecutor, 'execute'> = getDb()): Promise<string> {
  const res = await ex.execute(sql`select nextval('lab_report_seq') as n`)
  const n = Number(rowsOf<{ n: string | number }>(res)[0].n)
  return `LR-${istDateOf(now).slice(0, 4)}-${String(n).padStart(6, '0')}`
}

/** The reportable orders of a requisition (verified/reported only, filtered in SQL), ascending id. */
async function reportableOrders(ex: Pick<WriteExecutor, 'select'>, requisitionId: number) {
  return ex
    .select({
      id: labOrders.id,
      status: labOrders.status,
      sampleId: labOrders.sampleId,
      collectedAt: labOrders.collectedAt,
      receivedAt: labOrders.receivedAt,
      verifiedAt: labOrders.verifiedAt,
      verifiedByName: labOrders.verifiedByName,
      testName: labTests.name,
      testCode: labTests.code,
      testReferenceRange: labTests.referenceRange,
      value: labResults.value,
      unit: labResults.unit,
      referenceRange: labResults.referenceRange,
      flag: labResults.flag,
      amendedAt: labResults.amendedAt,
    })
    .from(labOrders)
    .innerJoin(labTests, eq(labTests.id, labOrders.labTestId))
    .innerJoin(labResults, eq(labResults.labOrderId, labOrders.id))
    .where(and(eq(labOrders.requisitionId, requisitionId), inArray(labOrders.status, REPORTABLE)))
    .orderBy(asc(labOrders.id))
}

type Fingerprint = { verified: number[]; reported: number[]; amended: string }
function fingerprint(rows: { id: number; status: LabOrderStatus; amendedAt: Date | null }[]): Fingerprint {
  return {
    verified: rows.filter((r) => r.status === 'verified').map((r) => r.id),
    reported: rows.filter((r) => r.status === 'reported').map((r) => r.id),
    amended: rows.map((r) => `${r.id}:${r.amendedAt ? r.amendedAt.getTime() : '-'}`).join(','),
  }
}
const sameFingerprint = (a: Fingerprint, b: Fingerprint) =>
  a.verified.join(',') === b.verified.join(',') && a.reported.join(',') === b.reported.join(',') && a.amended === b.amended

async function hospitalHeader(): Promise<LabReportData['hospital']> {
  let site: string | null = null
  try {
    site = (await getPracticeIdentity()).practiceSite
  } catch {
    site = null
  }
  return hospitalFromBrand(brand, site)
}

function summarize(names: string[]): string {
  const s = names.join(', ')
  return s.length <= MAX_TEST_SUMMARY ? s : `${s.slice(0, MAX_TEST_SUMMARY - 1)}…`
}

export async function releaseLabReport(requisitionId: number, session: Session, depsIn: Partial<ReleaseDeps> = {}): Promise<ReleaseLabReportResult> {
  const deps: ReleaseDeps = { ...DEFAULT_DEPS, ...depsIn }
  const db = getDb()
  const now = deps.now()

  // 1. Snapshot (no lock). Named columns only: no Aadhaar, ABHA, phone or address.
  const [req] = await db.select().from(labRequisitions).where(eq(labRequisitions.id, requisitionId))
  if (!req) return { ok: false, error: 'not_found' }
  const [patient] = await db
    .select({ id: patients.id, name: patients.name, dob: patients.dob, uhid: patients.uhid, gender: patients.gender })
    .from(patients)
    .where(eq(patients.id, req.patientId))
  const [provider] = await db
    .select({ name: providers.name, registrationCouncil: providers.registrationCouncil, registrationStateCode: providers.registrationStateCode, registrationNumber: providers.registrationNumber })
    .from(providers)
    .where(eq(providers.id, req.orderedByProviderId))
  if (!patient || !provider) return { ok: false, error: 'not_found' }
  const snapshot = await reportableOrders(db, requisitionId)
  const before = fingerprint(snapshot)
  if (before.verified.length === 0) return { ok: false, error: 'nothing_to_report' }

  // 2. Number and version.
  const reportNumber = await nextLabReportNumber(now)
  const [{ maxVersion }] = await db
    .select({ maxVersion: sql<number | null>`max(${labReports.version})` })
    .from(labReports)
    .where(eq(labReports.requisitionId, requisitionId))
  const version = Number(maxVersion ?? 0) + 1

  // 3. Render and store, before any lock.
  const source: LabReportSource = {
    hospital: await hospitalHeader(),
    reportNumber,
    version,
    patient,
    provider,
    orders: snapshot.map((o) => ({
      testName: o.testName,
      testCode: o.testCode,
      sampleId: o.sampleId,
      testReferenceRange: o.testReferenceRange,
      collectedAt: o.collectedAt,
      receivedAt: o.receivedAt,
      verifiedAt: o.verifiedAt,
      verifiedByName: o.verifiedByName,
      result: { value: o.value, unit: o.unit, referenceRange: o.referenceRange, flag: o.flag },
    })),
  }
  const bytes = await deps.render(buildLabReportData(source, now))
  const { url } = await deps.putBlob(`lab-reports/${requisitionId}/${reportNumber}-${randomUUID()}.pdf`, bytes)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const orderIds = snapshot.map((o) => o.id)

  // 4. One transaction: lock, re-check, write, audit, follow-up.
  try {
    return await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(labRequisitions).where(eq(labRequisitions.id, requisitionId)).for('update')
      if (!locked) return { ok: false, error: 'stale' } as const
      const all = await tx
        .select({ id: labOrders.id, status: labOrders.status })
        .from(labOrders)
        .where(eq(labOrders.requisitionId, requisitionId))
        .orderBy(asc(labOrders.id))
        .for('update')
      const current = await reportableOrders(tx, requisitionId)
      if (!sameFingerprint(before, fingerprint(current))) return { ok: false, error: 'stale' } as const

      const [report] = await tx.insert(labReports).values({
        reportNumber,
        requisitionId,
        patientId: req.patientId,
        version,
        orderIds,
        testSummary: summarize(snapshot.map((o) => o.testName)),
        blobUrl: url,
        byteSize: bytes.byteLength,
        sha256,
        releasedByName: session.name,
        releasedByUserId: session.userId,
        releasedAt: now,
      }).returning()
      await tx
        .update(labReports)
        .set({ supersededAt: now })
        .where(and(eq(labReports.requisitionId, requisitionId), ne(labReports.id, report.id), isNull(labReports.supersededAt)))
      await tx
        .update(labOrders)
        .set({ status: 'reported', reportedAt: now, statusChangedAt: now })
        .where(inArray(labOrders.id, before.verified))
      await logAudit(session, 'released lab report', req.patientId, `report=${report.id} requisition=${requisitionId} version=${version} orders=${orderIds.join(',')}`, tx)

      let followUp: LabFollowUpResult
      if (!locked.followUpRequested) followUp = { outcome: 'not_requested', followUpOrderId: null, dueDate: null }
      else if (locked.followUpResolvedAt !== null) followUp = { outcome: 'already_resolved', followUpOrderId: null, dueDate: null }
      else if (all.some((o) => NOT_YET_REPORTABLE.includes(o.status))) followUp = { outcome: 'pending', followUpOrderId: null, dueDate: null }
      else followUp = await resolveLabFollowUp(tx, locked, orderIds[orderIds.length - 1], session, istDateOf(now), now)

      return { ok: true, report, followUp } as const
    })
  } catch (err) {
    // A concurrent release that took the same version number first.
    if (isUniqueViolation(err, 'lab_reports_requisition_version_unique')) return { ok: false, error: 'stale' }
    throw err
  }
}

/**
 * Resolves the requisition's follow-up request on the caller's transaction (the requisition row
 * is already locked): links the patient's open follow-up from the same doctor (soonest due), or
 * creates a `lab_report` follow-up. A creation failure is recorded, never thrown, so the report
 * release still commits. Always stamps the outcome on the requisition.
 */
export async function resolveLabFollowUp(
  ex: WriteExecutor,
  req: LabRequisitionRow,
  originatingLabOrderId: number,
  session: Session,
  todayIso: string,
  now: Date = new Date(),
): Promise<{ outcome: 'created' | 'linked' | 'failed'; followUpOrderId: number | null; dueDate: string | null }> {
  let result: { outcome: 'created' | 'linked' | 'failed'; followUpOrderId: number | null; dueDate: string | null }
  const [open] = await ex
    .select({ id: followUpOrders.id, dueDate: followUpOrders.dueDate, originatingLabOrderId: followUpOrders.originatingLabOrderId })
    .from(followUpOrders)
    .where(and(
      eq(followUpOrders.patientId, req.patientId),
      eq(followUpOrders.prescribedByProviderId, req.orderedByProviderId),
      inArray(followUpOrders.status, ['planned', 'scheduled']),
      gte(followUpOrders.windowEnd, todayIso),
    ))
    .orderBy(asc(followUpOrders.dueDate), asc(followUpOrders.id))
    .limit(1)
    .for('update')
  if (open) {
    if (open.originatingLabOrderId === null) {
      await ex.update(followUpOrders).set({ originatingLabOrderId, updatedAt: now }).where(eq(followUpOrders.id, open.id))
    }
    await logAudit(session, 'linked lab report to follow-up', req.patientId, `followUp=${open.id} requisition=${req.id}`, ex)
    result = { outcome: 'linked', followUpOrderId: open.id, dueDate: open.dueDate }
  } else {
    const created = await createFollowUpOrder({
      patientId: req.patientId,
      source: 'lab_report',
      prescribedByProviderId: req.orderedByProviderId,
      departmentId: null,
      timing: { kind: 'interval', interval: { value: req.followUpIntervalValue ?? 1, unit: req.followUpIntervalUnit ?? 'weeks' } },
      reason: req.followUpReason ?? 'Review of lab results',
      planNotes: null,
      originatingEncounterId: null,
      originatingAdmissionId: null,
      originatingLabOrderId,
    }, session, { executor: ex, today: todayIso })
    if (created.ok) {
      result = { outcome: 'created', followUpOrderId: created.order.id, dueDate: created.order.dueDate }
    } else {
      await logAudit(session, 'lab follow-up not created', req.patientId, `requisition=${req.id} error=${created.error}`, ex)
      result = { outcome: 'failed', followUpOrderId: null, dueDate: null }
    }
  }
  await ex
    .update(labRequisitions)
    .set({ followUpResolvedAt: now, followUpOutcome: result.outcome, followUpOrderId: result.followUpOrderId })
    .where(eq(labRequisitions.id, req.id))
  return result
}

// ── Reads ───────────────────────────────────────────────────────────────────

export interface StaffLabReport { id: number; reportNumber: string; version: number; releasedAt: Date; testSummary: string; supersededAt: Date | null }

/** Every version of every report of the patient, newest first (staff chart). */
export async function listReportsForPatient(patientId: string): Promise<StaffLabReport[]> {
  return getDb()
    .select({ id: labReports.id, reportNumber: labReports.reportNumber, version: labReports.version, releasedAt: labReports.releasedAt, testSummary: labReports.testSummary, supersededAt: labReports.supersededAt })
    .from(labReports)
    .where(eq(labReports.patientId, patientId))
    .orderBy(desc(labReports.releasedAt), desc(labReports.id))
}

/** The fields a download route needs; the blob URL never leaves the server. */
export async function getLabReportForDownload(id: number): Promise<{ id: number; patientId: string; reportNumber: string; blobUrl: string; supersededAt: Date | null } | null> {
  const [row] = await getDb()
    .select({ id: labReports.id, patientId: labReports.patientId, reportNumber: labReports.reportNumber, blobUrl: labReports.blobUrl, supersededAt: labReports.supersededAt })
    .from(labReports)
    .where(eq(labReports.id, id))
  return row ?? null
}

export interface PortalLabReport { id: number; reportNumber: string; releasedAt: Date; testSummary: string }

/** The patient's current (non-superseded) reports, newest first. */
export async function listPortalLabReports(patientId: string): Promise<PortalLabReport[]> {
  return getDb()
    .select({ id: labReports.id, reportNumber: labReports.reportNumber, releasedAt: labReports.releasedAt, testSummary: labReports.testSummary })
    .from(labReports)
    .where(and(eq(labReports.patientId, patientId), isNull(labReports.supersededAt)))
    .orderBy(desc(labReports.releasedAt), desc(labReports.id))
}
