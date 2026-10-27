// WS8 T14 (spec D18): the DPDP data-principal request register. SERVER ONLY.
// - A request is due 30 days after it was received; one that is past due and not closed is overdue.
// - The export bundle (the chart's FHIR Bundle plus a manifest) is stored in the private blob store;
//   its URL stays in the row and never reaches a client or a log line.
// - Erasure archives the chart and scrubs contact fields when the retention schedule keeps records
//   (financial, medico-legal or recent medical records); otherwise the erase route deletes the
//   chart. Financial and medico-legal records are never deleted.
// Audit details carry ids, enum values and counts only, never names, contact data or note text.
import { and, asc, desc, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import { getDb } from '@/db/client'
import {
  DATA_PRINCIPAL_CHECKLIST_KEYS,
  dataPrincipalRequests,
  patients,
  type DataPrincipalChecklist,
  type DataPrincipalChecklistKey,
} from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { deletePrivateBlob, putPrivateBlob, safeBlobSegment } from '@/lib/blob-store'
import { dashboardCacheKey, invalidateCache, invalidateCacheByPrefix, patientDetailCacheKey, patientListCachePrefix } from '@/lib/cache'
import { buildFullBundle } from '@/lib/fhir/bundle'
import { gatherPatientFhirData } from '@/lib/fhir/gather'
import { retentionBlocksErasure } from '@/lib/governance/retention'
import { todayIsoIn } from '@/lib/india-time'
import { archivePatient } from '@/lib/queries/patient-archive'
import { resetPatientMfa, revokePatientPortalAccess } from '@/lib/queries/patient-portal'

export type DataPrincipalRequestKind = (typeof dataPrincipalRequests.kind.enumValues)[number]
export type DataPrincipalRequestVia = (typeof dataPrincipalRequests.receivedVia.enumValues)[number]
export type DataPrincipalRequestStatus = (typeof dataPrincipalRequests.status.enumValues)[number]
export { DATA_PRINCIPAL_CHECKLIST_KEYS, type DataPrincipalChecklist, type DataPrincipalChecklistKey }

export const DUE_DAYS = 30
export const CLOSED_STATUSES: readonly DataPrincipalRequestStatus[] = ['completed', 'rejected']

export const KIND_LABEL: Record<DataPrincipalRequestKind, string> = {
  access: 'Access',
  correction: 'Correction',
  erasure: 'Erasure',
  grievance: 'Grievance',
}
export const VIA_LABEL: Record<DataPrincipalRequestVia, string> = {
  email: 'Email',
  portal_message: 'Portal message',
  letter: 'Letter',
  in_person: 'In person',
}
export const STATUS_LABEL: Record<DataPrincipalRequestStatus, string> = {
  received: 'Received',
  in_progress: 'In progress',
  completed: 'Completed',
  rejected: 'Rejected',
}
export const CHECKLIST_LABEL: Record<DataPrincipalChecklistKey, string> = {
  identity_verified: 'Identity of the requester verified',
  scope_confirmed: 'Scope of the request confirmed',
  export_prepared: 'Export bundle prepared',
  export_delivered: 'Export delivered to the patient',
  erasure_reviewed: 'Erasure reviewed against the retention schedule',
  response_sent: 'Response sent to the patient',
}

/** `dateIso` (YYYY-MM-DD) plus `days`, as YYYY-MM-DD. */
export function addDaysIso(dateIso: string, days: number): string {
  const d = new Date(`${dateIso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** What the register shows. Never carries the export blob URL (only whether an export exists). */
export interface DataPrincipalRequestView {
  id: number
  reference: string
  patientId: string | null
  patientUhid: string | null
  patientName: string | null
  patientArchived: boolean
  kind: DataPrincipalRequestKind
  receivedVia: DataPrincipalRequestVia
  receivedAt: string
  dueBy: string
  status: DataPrincipalRequestStatus
  checklist: DataPrincipalChecklist
  note: string | null
  decisionNote: string | null
  handledByName: string | null
  createdAt: Date
  closedAt: Date | null
  hasExport: boolean
  overdue: boolean
}

const viewColumns = {
  id: dataPrincipalRequests.id,
  reference: dataPrincipalRequests.reference,
  patientId: dataPrincipalRequests.patientId,
  patientUhid: patients.uhid,
  patientName: patients.name,
  patientArchivedAt: patients.archivedAt,
  kind: dataPrincipalRequests.kind,
  receivedVia: dataPrincipalRequests.receivedVia,
  receivedAt: dataPrincipalRequests.receivedAt,
  dueBy: dataPrincipalRequests.dueBy,
  status: dataPrincipalRequests.status,
  checklist: dataPrincipalRequests.checklist,
  note: dataPrincipalRequests.note,
  decisionNote: dataPrincipalRequests.decisionNote,
  handledByName: dataPrincipalRequests.handledByName,
  createdAt: dataPrincipalRequests.createdAt,
  closedAt: dataPrincipalRequests.closedAt,
  hasExport: sql<boolean>`${dataPrincipalRequests.exportBlobUrl} IS NOT NULL`,
}
type ViewRow = Awaited<ReturnType<typeof baseQuery>>[number]

function toView(r: ViewRow, todayIso: string): DataPrincipalRequestView {
  const { patientArchivedAt, ...rest } = r
  return {
    ...rest,
    patientArchived: patientArchivedAt !== null,
    hasExport: Boolean(r.hasExport),
    checklist: r.checklist ?? {},
    overdue: r.closedAt === null && r.dueBy < todayIso,
  }
}

function baseQuery() {
  return getDb().select(viewColumns).from(dataPrincipalRequests).leftJoin(patients, eq(patients.id, dataPrincipalRequests.patientId))
}

/** Open requests first (earliest due first), then closed ones (most recent first). */
export async function listDataPrincipalRequests(todayIso: string = todayIsoIn()): Promise<DataPrincipalRequestView[]> {
  const rows = await baseQuery()
    .orderBy(sql`${dataPrincipalRequests.closedAt} IS NOT NULL`, asc(dataPrincipalRequests.dueBy), desc(dataPrincipalRequests.closedAt), desc(dataPrincipalRequests.id))
    .limit(500)
  return rows.map((r) => toView(r, todayIso))
}

export async function getDataPrincipalRequest(id: number, todayIso: string = todayIsoIn()): Promise<DataPrincipalRequestView | null> {
  const [row] = await baseQuery().where(eq(dataPrincipalRequests.id, id))
  return row ? toView(row, todayIso) : null
}

/** Requests past due and not closed (the governance strip on the dashboard). */
export async function countOverdueDataPrincipalRequests(todayIso: string = todayIsoIn()): Promise<number> {
  const [row] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(dataPrincipalRequests)
    .where(and(isNull(dataPrincipalRequests.closedAt), lt(dataPrincipalRequests.dueBy, todayIso)))
  return row?.n ?? 0
}

/** The chart a patient reference names: a UHID (any case) or a chart id. Archived charts included. */
async function resolvePatient(ref: string): Promise<{ id: string } | null> {
  const trimmed = ref.trim()
  const rows = await getDb()
    .select({ id: patients.id })
    .from(patients)
    .where(sql`${patients.id} = ${trimmed} OR upper(${patients.uhid}) = upper(${trimmed})`)
    .limit(2)
  return rows.find((r) => r.id === trimmed) ?? rows[0] ?? null
}

export type CreateResult = { ok: true; id: number; reference: string; dueBy: string } | { ok: false; error: 'patient_not_found' }

export async function createDataPrincipalRequest(
  input: { patientRef: string; kind: DataPrincipalRequestKind; receivedVia: DataPrincipalRequestVia; receivedAt: string; note?: string },
  session: Session,
): Promise<CreateResult> {
  const patient = await resolvePatient(input.patientRef)
  if (!patient) return { ok: false, error: 'patient_not_found' }
  const dueBy = addDaysIso(input.receivedAt, DUE_DAYS)
  return getDb().transaction(async (tx) => {
    const seq = await tx.execute<{ id: number }>(sql`select nextval(pg_get_serial_sequence('data_principal_requests', 'id'))::int as id`)
    const id = Number(seq.rows[0].id)
    const reference = `DPR-${input.receivedAt.slice(0, 4)}-${String(id).padStart(6, '0')}`
    await tx.insert(dataPrincipalRequests).values({
      id,
      reference,
      patientId: patient.id,
      kind: input.kind,
      receivedVia: input.receivedVia,
      receivedAt: input.receivedAt,
      dueBy,
      note: input.note?.trim() || null,
      handledByName: session.name,
    })
    await logAudit(session, 'created data-principal request', patient.id, `request=${id} kind=${input.kind}`, tx)
    return { ok: true as const, id, reference, dueBy }
  })
}

export type UpdateResult = { ok: true } | { ok: false; error: 'not_found' }

export async function updateDataPrincipalRequest(
  id: number,
  patch: { status?: DataPrincipalRequestStatus; checklist?: DataPrincipalChecklist; decisionNote?: string },
  session: Session,
): Promise<UpdateResult> {
  return getDb().transaction(async (tx) => {
    const [row] = await tx
      .select({ patientId: dataPrincipalRequests.patientId, closedAt: dataPrincipalRequests.closedAt })
      .from(dataPrincipalRequests)
      .where(eq(dataPrincipalRequests.id, id))
      .for('update')
    if (!row) return { ok: false as const, error: 'not_found' as const }
    const set: PgUpdateSetSource<typeof dataPrincipalRequests> = { handledByName: session.name }
    if (patch.status !== undefined) {
      set.status = patch.status
      set.closedAt = CLOSED_STATUSES.includes(patch.status) ? (row.closedAt ?? new Date()) : null
    }
    if (patch.checklist !== undefined) {
      set.checklist = sql`${dataPrincipalRequests.checklist} || ${JSON.stringify(patch.checklist)}::jsonb`
    }
    if (patch.decisionNote !== undefined) set.decisionNote = patch.decisionNote.trim() || null
    await tx.update(dataPrincipalRequests).set(set).where(eq(dataPrincipalRequests.id, id))
    const details = [
      `request=${id}`,
      patch.status !== undefined ? `status=${patch.status}` : null,
      patch.checklist !== undefined ? `checklist=${Object.keys(patch.checklist).sort().join(',')}` : null,
      patch.decisionNote !== undefined ? `decision_note_length=${patch.decisionNote.trim().length}` : null,
    ].filter(Boolean).join(' ')
    await logAudit(session, 'updated data-principal request', row.patientId, details, tx)
    return { ok: true as const }
  })
}

export type ExportResult = { ok: true } | { ok: false; error: 'not_found' | 'no_patient' }

/**
 * Builds `{ manifest, fhir }` for the request's patient, stores it as JSON in the private blob store
 * and records its URL on the row (replacing and removing any earlier export). Ticks export_prepared.
 */
export async function prepareDataPrincipalExport(id: number, session: Session): Promise<ExportResult> {
  const db = getDb()
  const [req] = await db
    .select({ reference: dataPrincipalRequests.reference, patientId: dataPrincipalRequests.patientId, exportBlobUrl: dataPrincipalRequests.exportBlobUrl })
    .from(dataPrincipalRequests)
    .where(eq(dataPrincipalRequests.id, id))
  if (!req) return { ok: false, error: 'not_found' }
  if (!req.patientId) return { ok: false, error: 'no_patient' }
  const data = await gatherPatientFhirData(req.patientId)
  if (!data) return { ok: false, error: 'no_patient' }

  const fhir = buildFullBundle(data)
  const counts = new Map<string, number>()
  for (const e of fhir.entry) {
    const type = (e.resource as { resourceType?: string }).resourceType ?? 'Unknown'
    counts.set(type, (counts.get(type) ?? 0) + 1)
  }
  const manifest = {
    reference: req.reference,
    generatedAt: new Date().toISOString(),
    patientUhid: data.patient.uhid ?? null,
    sections: [...counts].map(([resourceType, count]) => ({ resourceType, count })),
  }
  const bytes = new TextEncoder().encode(JSON.stringify({ manifest, fhir }, null, 2))
  const { url } = await putPrivateBlob(`data-requests/${safeBlobSegment(req.reference)}/export-${Date.now()}.json`, bytes, 'application/json')

  await db.transaction(async (tx) => {
    await tx
      .update(dataPrincipalRequests)
      .set({ exportBlobUrl: url, checklist: sql`${dataPrincipalRequests.checklist} || '{"export_prepared": true}'::jsonb`, handledByName: session.name })
      .where(eq(dataPrincipalRequests.id, id))
    await logAudit(session, 'prepared data-principal export', req.patientId, `request=${id} resources=${fhir.total}`, tx)
  })
  if (req.exportBlobUrl && req.exportBlobUrl !== url) await deletePrivateBlob(req.exportBlobUrl)
  return { ok: true }
}

/** The stored export for the download route (server only): never send `url` to a client. */
export async function getDataPrincipalExport(id: number): Promise<{ url: string; reference: string; patientId: string | null } | null> {
  const [row] = await getDb()
    .select({ url: dataPrincipalRequests.exportBlobUrl, reference: dataPrincipalRequests.reference, patientId: dataPrincipalRequests.patientId })
    .from(dataPrincipalRequests)
    .where(and(eq(dataPrincipalRequests.id, id), isNotNull(dataPrincipalRequests.exportBlobUrl)))
  return row?.url ? { url: row.url, reference: row.reference, patientId: row.patientId } : null
}

// ---- Erasure -------------------------------------------------------------------------------

export type ErasureCheck =
  | { ok: true; requestId: number; reference: string; patientId: string; confirmUhid: string; archived: boolean; reasons: string[]; photoBlobPath: string | null }
  | { ok: false; error: 'not_found' | 'not_erasure' | 'closed' | 'no_patient' | 'uhid_mismatch' }

/** Facts for the retention schedule: any financial record, the MLC flag, the last visit date (IST). */
async function retentionFacts(patientId: string): Promise<{ hasFinancial: boolean; hasMlc: boolean; lastEncounterDate: string | null }> {
  const result = await getDb().execute<{ has_financial: boolean; has_mlc: boolean; last_date: string | null }>(sql`
    select
      (exists (select 1 from invoices where patient_id = ${patientId})
        or exists (select 1 from charge_lines where patient_id = ${patientId})
        or exists (select 1 from patient_payments where patient_id = ${patientId})
        or exists (select 1 from refunds where patient_id = ${patientId})
        or exists (select 1 from payment_requests where patient_id = ${patientId} and status = 'confirmed')
        or exists (select 1 from claims where patient_id = ${patientId} and status not in ('draft', 'withdrawn'))
        or exists (select 1 from claim_submissions s join claims c on c.id = s.claim_id where c.patient_id = ${patientId})
        or exists (select 1 from preauths where patient_id = ${patientId} and status not in ('draft', 'cancelled'))
        or exists (select 1 from nhcx_exchanges where patient_id = ${patientId})) as has_financial,
      coalesce((select is_mlc from patients where id = ${patientId}), false) as has_mlc,
      (select max(d)::text from (
        select max(encounter_date) as d from encounters where patient_id = ${patientId}
        union all
        select max((coalesce(discharged_at, admitted_at) + interval '5 hours 30 minutes')::date) from admissions where patient_id = ${patientId}
      ) visits) as last_date`)
  const r = result.rows[0]
  return { hasFinancial: Boolean(r?.has_financial), hasMlc: Boolean(r?.has_mlc), lastEncounterDate: r?.last_date ?? null }
}

/**
 * Validates an erasure (an open erasure request with a chart, and the typed UHID or, for a legacy
 * chart, the chart id) and works out what the retention schedule keeps. Writes nothing.
 */
export async function checkErasure(id: number, confirmUhid: string, todayIso: string = todayIsoIn()): Promise<ErasureCheck> {
  const [row] = await getDb()
    .select({
      kind: dataPrincipalRequests.kind,
      reference: dataPrincipalRequests.reference,
      closedAt: dataPrincipalRequests.closedAt,
      patientId: dataPrincipalRequests.patientId,
      uhid: patients.uhid,
      archivedAt: patients.archivedAt,
      photoBlobPath: patients.photoBlobPath,
    })
    .from(dataPrincipalRequests)
    .leftJoin(patients, eq(patients.id, dataPrincipalRequests.patientId))
    .where(eq(dataPrincipalRequests.id, id))
  if (!row) return { ok: false, error: 'not_found' }
  if (row.kind !== 'erasure') return { ok: false, error: 'not_erasure' }
  if (row.closedAt) return { ok: false, error: 'closed' }
  if (!row.patientId) return { ok: false, error: 'no_patient' }
  const expected = (row.uhid ?? row.patientId).trim().toUpperCase()
  if (confirmUhid.trim().toUpperCase() !== expected) return { ok: false, error: 'uhid_mismatch' }
  const reasons = retentionBlocksErasure(await retentionFacts(row.patientId), todayIso)
  return { ok: true, requestId: id, reference: row.reference, patientId: row.patientId, confirmUhid, archived: row.archivedAt !== null, reasons, photoBlobPath: row.photoBlobPath }
}

export type RestrictResult = { ok: true } | { ok: false; error: 'active_admission' | 'not_found' }

/**
 * Retention applies: archive the chart (Task 13; an already-archived chart stays archived) and scrub
 * its contact fields, photo and portal credentials. Every clinical, financial and medico-legal
 * record is kept. Re-running after a partial failure is safe.
 */
export async function restrictPatientForErasure(check: Extract<ErasureCheck, { ok: true }>, session: Session): Promise<RestrictResult> {
  if (!check.archived) {
    const archived = await archivePatient(
      check.patientId,
      { reason: `DPDP erasure request ${check.reference}: records kept under the retention schedule`, confirmUhid: check.confirmUhid },
      session,
    )
    if (!archived.ok && archived.error !== 'already_archived') {
      return { ok: false, error: archived.error === 'active_admission' ? 'active_admission' : 'not_found' }
    }
  }
  // The portal credential helpers own those columns (tests/lib/no-credential-leak.test.ts). The
  // chart is already archived, which alone blocks portal sign-in.
  await revokePatientPortalAccess(check.patientId)
  await resetPatientMfa(check.patientId)
  const photo = await getDb().transaction(async (tx) => {
    const [p] = await tx.select({ photo: patients.photoBlobPath }).from(patients).where(eq(patients.id, check.patientId)).for('update')
    await tx
      .update(patients)
      .set({ phone: null, email: null, addressLine1: null, addressLine2: null, photoBlobPath: null })
      .where(eq(patients.id, check.patientId))
    await tx
      .update(dataPrincipalRequests)
      .set({ checklist: sql`${dataPrincipalRequests.checklist} || '{"erasure_reviewed": true}'::jsonb`, handledByName: session.name })
      .where(eq(dataPrincipalRequests.id, check.requestId))
    await logAudit(session, 'restricted patient data (DPDP erasure)', check.patientId, `request=${check.requestId} reasons=${check.reasons.length}`, tx)
    return p?.photo ?? null
  })
  if (photo) await deletePrivateBlob(photo)
  await invalidateCache(patientDetailCacheKey(check.patientId))
  await invalidateCacheByPrefix(patientListCachePrefix())
  await invalidateCache(dashboardCacheKey())
  return { ok: true }
}

/**
 * After the erase route deleted the chart (deletePatient cleared this row's patient_id): tick
 * erasure_reviewed, drop the export bundle (it held the erased chart) and the photo, and audit.
 */
export async function recordErasedChart(check: Extract<ErasureCheck, { ok: true }>, session: Session): Promise<void> {
  const exportUrl = await getDb().transaction(async (tx) => {
    const [row] = await tx
      .select({ url: dataPrincipalRequests.exportBlobUrl })
      .from(dataPrincipalRequests)
      .where(eq(dataPrincipalRequests.id, check.requestId))
      .for('update')
    await tx
      .update(dataPrincipalRequests)
      .set({ exportBlobUrl: null, checklist: sql`${dataPrincipalRequests.checklist} || '{"erasure_reviewed": true}'::jsonb`, handledByName: session.name })
      .where(eq(dataPrincipalRequests.id, check.requestId))
    await logAudit(session, 'completed data-principal erasure', check.patientId, `request=${check.requestId} outcome=erased`, tx)
    return row?.url ?? null
  })
  if (exportUrl) await deletePrivateBlob(exportUrl)
  if (check.photoBlobPath) await deletePrivateBlob(check.photoBlobPath)
}
