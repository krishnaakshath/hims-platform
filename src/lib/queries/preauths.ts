// SP7: the pre-authorisation lifecycle (request with a tariff-priced estimate -> query ->
// approval with amount and validity -> enhancement -> rejection/cancellation). Every write runs
// in one transaction: the SP4 per-patient billing lock first, then the pre-auth row FOR UPDATE,
// then the event and the audit row. Audit details carry ids, numbers, statuses and paise only.
import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, ilike, inArray, ne, notInArray, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { getDb } from '@/db/client'
import { admissionCoverage, admissions, encounters, nhcxExchanges, patients, payerProfiles, payers, preauthDocuments, preauthEvents, preauths, providers, rcmQueries, rcmQueryResponses, rcmReasonCodes, roomCategories, rooms, serviceCatalog, type PreauthRow } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { lineTaxablePaise, sumPaise } from '@/lib/billing/amounts'
import { lineTax } from '@/lib/billing/gst'
import { DIAGNOSIS_CODE_KINDS, PROCEDURE_CODE_KINDS, type CodeSystemKind } from '@/lib/coding/code-systems'
import { ageOnDate, formatCalendarDate, istDateOf, todayIsoIn } from '@/lib/india-time'
import { effectiveLimits, evaluateCoverage, type CoverageLimits, type CoverageVerificationFacts } from '@/lib/insurance/coverage'
import { applyCoverageToEstimate } from '@/lib/insurance/estimate-split'
import { putPrivateBlob } from '@/lib/blob-store'
import { sha256Hex } from '@/lib/rcm/hash'
import { formatRcmNumber } from '@/lib/rcm/constants'
import { policyNotInForceMessage, rcmFail, rcmOk, type RcmWriteResult } from '@/lib/rcm/errors'
import { isUniqueViolation } from '@/lib/db-errors'
import { formatPaise } from '@/lib/format'
import { snapshotSha256 } from '@/lib/rcm/hash'
import { preauthDecisionOverdue } from '@/lib/rcm/sla'
import { NHCX_UNDELIVERED_EXCHANGE_STATES, PREAUTH_SNAPSHOT_ACTIONS, nextPreauthStatus, type PreauthStatus } from '@/lib/rcm/preauth-status'
import { buildPreauthSnapshot, type PreauthSnapshot } from '@/lib/rcm/snapshot'
import type { CodedEntry, EstimateLine } from '@/lib/rcm/snapshot'
import type { PreauthFormDefaults } from '@/lib/rcm/preauth-form'
import type { PreauthActionRequest, PreauthCreateInput, PreauthEstimateInput } from '@/lib/rcm/validation'
import { resolvePrice } from '@/lib/tariff/resolve'
import { lockPatientBilling } from './billing-lock'
import { getCodesByIds } from './code-systems'
import { currentVerification } from './coverage'
import type { WriteExecutor } from './executor'
import { loadPolicyContext, loadRcmPatient, loadSnapshotHospital, type PolicyContext } from './rcm-context'
import { getPolicyView, listPatientPolicies, type PolicyView } from './rcm-policies'
import { loadPricingContext } from './tariff'

/** Prices each service as SP4 charge capture does (payer tariff first), with GST (intra-state). */
export async function estimatePreauth(input: {
  payerId: number; onDate: string; roomCategoryCode: string | null; items: { serviceId: number; quantity: number }[]
}): Promise<RcmWriteResult<{ lines: EstimateLine[]; totalPaise: number }>> {
  const lines: EstimateLine[] = []
  for (const item of input.items) {
    const pricing = await loadPricingContext(item.serviceId)
    if (!pricing.service || !pricing.service.isActive) return rcmFail('service_not_found')
    const price = resolvePrice({ serviceId: item.serviceId, payerId: input.payerId, roomCategory: input.roomCategoryCode ?? undefined, onDate: input.onDate }, pricing)
    if (!price.ok) {
      if (price.reason === 'service_not_found' || price.reason === 'service_inactive') return rcmFail('service_not_found')
      return rcmFail('price_unresolved', `No tariff rate covers ${pricing.service.code}`)
    }
    const amountPaise = lineTax(lineTaxablePaise(price.amountPaise, item.quantity), price.gstRateBp, 'intra').totalPaise
    lines.push({ serviceId: item.serviceId, code: price.serviceCode, name: price.serviceName, quantity: item.quantity, unitPricePaise: price.amountPaise, amountPaise, priceSource: price.scope })
  }
  return rcmOk({ lines, totalPaise: sumPaise(lines.map((l) => l.amountPaise)) })
}

/** Looks up code ids as CodedEntry snapshots; a missing id or one of the wrong kind is code_not_found. */
async function codedEntries(executor: WriteExecutor, ids: number[], kinds: readonly CodeSystemKind[]): Promise<CodedEntry[] | null> {
  const found = await getCodesByIds(ids, executor)
  const out: CodedEntry[] = []
  for (const id of ids) {
    const c = found.get(id)
    if (!c || !kinds.includes(c.kind)) return null
    out.push({ kind: c.kind, code: c.code, display: c.display, version: c.version })
  }
  return out
}

const NO_LIMITS: CoverageLimits = { sumInsuredPaise: null, balancePaise: null, copayBp: null, roomRentLimitPaise: null, icuLimitPaise: null }

/**
 * WS12 R4: a pre-auth is refused for a policy not in force on the planned admission date
 * (policy_not_in_force, with the dates) or one whose current verification says inactive
 * (coverage_inactive). Every other verdict (unverified, stale, pending, error) only warns.
 */
function coverageRefusal(ctx: PolicyContext, verification: CoverageVerificationFacts | null, plannedAdmissionDate: string, now: Date): ReturnType<typeof rcmFail> | null {
  const verdict = evaluateCoverage({
    policy: { id: ctx.row.id, status: ctx.row.status, validFrom: ctx.row.validFrom, validTo: ctx.row.validTo, insurerName: ctx.policy.insurer.name, onNhcx: false, limits: NO_LIMITS },
    verification, pendingCheck: false, context: 'preauth', now, onDate: plannedAdmissionDate,
  })
  if (verdict.state === 'policy_expired' || verdict.state === 'policy_not_started') {
    return rcmFail('policy_not_in_force', policyNotInForceMessage(formatCalendarDate(plannedAdmissionDate), formatCalendarDate(ctx.row.validFrom), formatCalendarDate(ctx.row.validTo)))
  }
  if (verdict.state === 'verified_inactive') return rcmFail('coverage_inactive')
  return null
}

export async function createPreauth(input: PreauthCreateInput, session: Session, now: Date = new Date()): Promise<RcmWriteResult<{ preauthId: number; preauthNumber: string }>> {
  const db = getDb()
  const ctx = await loadPolicyContext(db, input.policyId)
  if (!ctx || ctx.row.status !== 'active') return rcmFail('policy_not_found')
  if (!ctx.payersActive) return rcmFail('payer_inactive')
  const patientId = ctx.row.patientId
  const refusal = coverageRefusal(ctx, await currentVerification(db, ctx.row.id, now), input.plannedAdmissionDate, now)
  if (refusal) return refusal

  if (input.admissionId !== undefined) {
    const [a] = await db.select({ patientId: admissions.patientId }).from(admissions).where(eq(admissions.id, input.admissionId)).limit(1)
    if (!a || a.patientId !== patientId) return rcmFail('context_mismatch')
  }
  if (input.encounterId !== undefined) {
    const [e] = await db.select({ patientId: encounters.patientId }).from(encounters).where(eq(encounters.id, input.encounterId)).limit(1)
    if (!e || e.patientId !== patientId) return rcmFail('context_mismatch')
  }
  const [doctor] = await db.select({ id: providers.id }).from(providers).where(eq(providers.id, input.treatingProviderId)).limit(1)
  if (!doctor) return rcmFail('context_mismatch', 'That treating doctor was not found')

  const diagnoses = await codedEntries(db, input.diagnosisCodeIds, DIAGNOSIS_CODE_KINDS)
  const procedures = await codedEntries(db, input.procedureCodeIds, PROCEDURE_CODE_KINDS)
  if (!diagnoses || !procedures) return rcmFail('code_not_found')

  const estimate = await estimatePreauth({ payerId: ctx.billingPayerId, onDate: input.plannedAdmissionDate, roomCategoryCode: input.roomCategoryCode ?? null, items: input.estimate })
  if (!estimate.ok) return estimate
  const requestedPaise = input.requestedPaise ?? estimate.value.totalPaise

  return db.transaction(async (tx) => {
    await lockPatientBilling(tx, patientId)
    const seq = await tx.execute<{ n: string }>(sql`select nextval('preauth_number_seq')::text as n`)
    const preauthNumber = formatRcmNumber('PA', istDateOf(now).slice(0, 4), Number(seq.rows[0].n))
    const [row] = await tx.insert(preauths).values({
      preauthNumber, patientId, policyId: input.policyId, insurerPayerId: ctx.row.insurerPayerId, tpaPayerId: ctx.row.tpaPayerId,
      admissionId: input.admissionId ?? null, encounterId: input.encounterId ?? null, claimType: input.claimType, status: 'draft',
      plannedAdmissionDate: input.plannedAdmissionDate, expectedLengthOfStayDays: input.expectedLengthOfStayDays,
      roomCategoryCode: input.roomCategoryCode ?? null, treatingProviderId: input.treatingProviderId, diagnoses, procedures,
      provisionalDiagnosisText: input.provisionalDiagnosisText ?? null, estimateLines: estimate.value.lines,
      estimatedPaise: estimate.value.totalPaise, requestedPaise, createdByName: session.name, createdAt: now, updatedAt: now,
    }).returning({ id: preauths.id })
    await logAudit(session, 'rcm: created pre-authorisation', patientId, `preauth=${row.id} number=${preauthNumber} estimate=${estimate.value.totalPaise}`, tx)
    return rcmOk({ preauthId: row.id, preauthNumber })
  })
}

/** True when this pre-auth has a claim beyond draft/withdrawn linked to it. */
export async function preauthOnLiveClaim(executor: WriteExecutor, preauthId: number): Promise<boolean> {
  const r = await executor.execute<{ found: boolean }>(sql`select exists (select 1 from claims where preauth_id = ${preauthId} and status not in ('draft', 'withdrawn')) as found`)
  return Boolean(r.rows[0]?.found)
}

async function buildRequestSnapshot(executor: WriteExecutor, p: PreauthRow, kind: 'initial' | 'enhancement', requestedPaise: number, now: Date): Promise<PreauthSnapshot> {
  const [hospital, ctx, patient, doctor] = await Promise.all([
    loadSnapshotHospital(executor),
    loadPolicyContext(executor, p.policyId),
    loadRcmPatient(executor, p.patientId),
    executor.select({ name: providers.name }).from(providers).where(eq(providers.id, p.treatingProviderId)).limit(1),
  ])
  if (!ctx || !patient) throw new Error('pre-auth context missing')
  return buildPreauthSnapshot({
    preauthNumber: p.preauthNumber, kind, preparedAt: now.toISOString(), hospital,
    patient: patient.patient, includeAbha: ctx.billingProfile?.requiresAbha ?? false, patientAbhaNumber: patient.abhaNumber,
    policy: ctx.policy, claimType: p.claimType, plannedAdmissionDate: p.plannedAdmissionDate, expectedLengthOfStayDays: p.expectedLengthOfStayDays,
    treatingDoctorName: doctor[0]?.name ?? '', diagnoses: p.diagnoses, procedures: p.procedures, provisionalDiagnosisText: p.provisionalDiagnosisText,
    estimate: p.estimateLines, estimatedPaise: p.estimatedPaise, requestedPaise,
  })
}

/**
 * One lifecycle step. Lock order: the patient's billing lock, then the pre-auth row FOR UPDATE.
 * The event row is append-only; the audit carries ids, statuses and approved paise only.
 */
export async function applyPreauthAction(preauthId: number, req: PreauthActionRequest, session: Session, now: Date = new Date()): Promise<RcmWriteResult<{ status: PreauthStatus }>> {
  const [found] = await getDb().select({ patientId: preauths.patientId }).from(preauths).where(eq(preauths.id, preauthId)).limit(1)
  if (!found) return rcmFail('preauth_not_found')
  try {
    return await getDb().transaction(async (tx) => {
      await lockPatientBilling(tx, found.patientId)
      const [p] = await tx.select().from(preauths).where(eq(preauths.id, preauthId)).for('update')
      if (!p) return rcmFail('preauth_not_found')
      const [enh] = await tx.select({ id: preauthEvents.id }).from(preauthEvents)
        .where(and(eq(preauthEvents.preauthId, preauthId), eq(preauthEvents.action, 'approve_enhancement'))).limit(1)
      const to = nextPreauthStatus(p.status, req.action, { enhancedBefore: Boolean(enh) })
      if (to === null) return rcmFail('invalid_transition')

      const set: Partial<PreauthRow> = { status: to, updatedAt: now }
      const event: typeof preauthEvents.$inferInsert = { preauthId, action: req.action, fromStatus: p.status, toStatus: to, byName: session.name, byUserId: session.userId, at: now }
      let auditAmount: number | null = null

      switch (req.action) {
        case 'request': {
          const snapshot = await buildRequestSnapshot(tx, p, 'initial', p.requestedPaise, now)
          Object.assign(event, { snapshot, snapshotSha256: snapshotSha256(snapshot) })
          Object.assign(set, { firstRequestedAt: p.firstRequestedAt ?? now, lastRequestedAt: now })
          break
        }
        case 'request_enhancement': {
          if (p.approvedPaise === null || req.requestedPaise <= p.approvedPaise) {
            return rcmFail('amounts_invalid', `The enhancement must be more than the approved ${formatPaise(p.approvedPaise ?? 0)}`)
          }
          const snapshot = await buildRequestSnapshot(tx, p, 'enhancement', req.requestedPaise, now)
          Object.assign(event, { snapshot, snapshotSha256: snapshotSha256(snapshot), amountPaise: req.requestedPaise, note: req.note })
          Object.assign(set, { requestedPaise: req.requestedPaise, firstRequestedAt: p.firstRequestedAt ?? now, lastRequestedAt: now })
          break
        }
        case 'record_query':
          await tx.insert(rcmQueries).values({ preauthId, question: req.question, raisedOn: req.raisedOn, dueOn: req.dueOn, createdByName: session.name, createdAt: now })
          break
        case 'respond_query': {
          const [q] = await tx.select().from(rcmQueries).where(eq(rcmQueries.id, req.queryId)).for('update')
          if (!q || q.preauthId !== preauthId) return rcmFail('query_not_found')
          if (q.status !== 'open') return rcmFail('query_closed')
          await tx.insert(rcmQueryResponses).values({ queryId: q.id, body: req.body, respondedOn: req.respondedOn, byName: session.name, at: now })
          await tx.update(rcmQueries).set({ status: 'answered', answeredAt: now }).where(eq(rcmQueries.id, q.id))
          Object.assign(set, { lastRequestedAt: now })
          break
        }
        case 'approve': {
          const [dup] = await tx.select({ id: preauths.id }).from(preauths).where(and(
            eq(preauths.insurerPayerId, p.insurerPayerId), ne(preauths.id, preauthId), sql`lower(${preauths.approvalReference}) = lower(${req.approvalReference})`,
          )).limit(1)
          if (dup) return rcmFail('duplicate_reference')
          Object.assign(set, { approvedPaise: req.approvedPaise, approvalReference: req.approvalReference, validUntil: req.validUntil, decidedAt: now })
          event.amountPaise = req.approvedPaise
          auditAmount = req.approvedPaise
          break
        }
        case 'approve_enhancement': {
          if (p.approvedPaise === null || req.approvedPaise <= p.approvedPaise) {
            return rcmFail('amounts_invalid', `The enhanced approval must be more than the approved ${formatPaise(p.approvedPaise ?? 0)}`)
          }
          if (req.approvalReference !== undefined) {
            const [dup] = await tx.select({ id: preauths.id }).from(preauths).where(and(
              eq(preauths.insurerPayerId, p.insurerPayerId), ne(preauths.id, preauthId), sql`lower(${preauths.approvalReference}) = lower(${req.approvalReference})`,
            )).limit(1)
            if (dup) return rcmFail('duplicate_reference')
            set.approvalReference = req.approvalReference
          }
          Object.assign(set, { approvedPaise: req.approvedPaise, validUntil: req.validUntil, decidedAt: now })
          event.amountPaise = req.approvedPaise
          auditAmount = req.approvedPaise
          break
        }
        case 'reject':
        case 'reject_enhancement': {
          const [code] = await tx.select({ category: rcmReasonCodes.category }).from(rcmReasonCodes)
            .where(and(eq(rcmReasonCodes.code, req.reasonCode), eq(rcmReasonCodes.active, true))).limit(1)
          if (!code || code.category !== 'rejection') return rcmFail('code_not_found')
          Object.assign(event, { reasonCode: req.reasonCode, note: req.note ?? null })
          set.decidedAt = now
          break
        }
        case 'cancel':
          if (await preauthOnLiveClaim(tx, preauthId)) return rcmFail('preauth_in_use')
          event.note = req.note
          break
        case 'refresh_snapshot': {
          // WS12 T7 (R10): a new snapshot of the request still with the insurer; the old event stays
          // as it was sent. Read under the pre-auth row lock, so concurrent refreshes serialise.
          const [latest] = await tx.select().from(preauthEvents)
            .where(and(eq(preauthEvents.preauthId, preauthId), inArray(preauthEvents.action, [...PREAUTH_SNAPSHOT_ACTIONS])))
            .orderBy(desc(preauthEvents.id)).limit(1)
          if (!latest?.snapshot) return rcmFail('invalid_transition')
          const [withNhcx] = await tx.select({ id: nhcxExchanges.id }).from(nhcxExchanges).where(and(
            eq(nhcxExchanges.preauthEventId, latest.id), eq(nhcxExchanges.direction, 'outbound'), notInArray(nhcxExchanges.state, [...NHCX_UNDELIVERED_EXCHANGE_STATES]),
          )).limit(1)
          if (withNhcx) return rcmFail('preauth_in_use', 'Already sent through NHCX; the insurer has this version')
          const snapshot = await buildRequestSnapshot(tx, p, latest.snapshot.kind, p.requestedPaise, now)
          // preparedAt always differs; "changed" means anything else differs.
          if (snapshotSha256({ ...snapshot, preparedAt: latest.snapshot.preparedAt }) === latest.snapshotSha256) {
            return rcmFail('not_ready', 'Nothing has changed since this request was prepared')
          }
          Object.assign(event, { snapshot, snapshotSha256: snapshotSha256(snapshot) })
          break
        }
      }

      await tx.update(preauths).set(set).where(eq(preauths.id, preauthId))
      await tx.insert(preauthEvents).values(event)
      const amount = auditAmount === null ? '' : ` amount=${auditAmount}`
      await logAudit(session, `rcm: pre-authorisation ${req.action}`, p.patientId, `preauth=${preauthId} from=${p.status} to=${to}${amount}`, tx)
      return rcmOk({ status: to })
    })
  } catch (err) {
    if (isUniqueViolation(err, 'preauths_insurer_reference_unique')) return rcmFail('duplicate_reference')
    throw err
  }
}

const EXTENSION: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' }

/** Stores an approval letter / query reply / other document; hash and blob put happen before the transaction. */
export async function uploadPreauthDocument(
  preauthId: number, input: { kind: 'preauth_approval' | 'query_response' | 'other'; title: string; queryResponseId?: number },
  file: { bytes: Uint8Array; contentType: string }, session: Session,
): Promise<RcmWriteResult<{ documentId: number }>> {
  const [found] = await getDb().select({ patientId: preauths.patientId }).from(preauths).where(eq(preauths.id, preauthId)).limit(1)
  if (!found) return rcmFail('preauth_not_found')
  const ext = EXTENSION[file.contentType]
  if (!ext) return rcmFail('upload_invalid')
  if (input.queryResponseId !== undefined) {
    const [r] = await getDb().select({ preauthId: rcmQueries.preauthId }).from(rcmQueryResponses)
      .innerJoin(rcmQueries, eq(rcmQueries.id, rcmQueryResponses.queryId)).where(eq(rcmQueryResponses.id, input.queryResponseId)).limit(1)
    if (!r || r.preauthId !== preauthId) return rcmFail('query_not_found')
  }
  const sha256 = sha256Hex(file.bytes)
  const { url } = await putPrivateBlob(`rcm/preauths/${preauthId}/${randomUUID()}.${ext}`, file.bytes, file.contentType)
  return getDb().transaction(async (tx) => {
    await lockPatientBilling(tx, found.patientId)
    const [locked] = await tx.select({ id: preauths.id }).from(preauths).where(eq(preauths.id, preauthId)).for('update')
    if (!locked) return rcmFail('preauth_not_found')
    const [row] = await tx.insert(preauthDocuments).values({
      preauthId, kind: input.kind, title: input.title, blobUrl: url, contentType: file.contentType, byteSize: file.bytes.byteLength, sha256,
      queryResponseId: input.queryResponseId ?? null, uploadedByName: session.name,
    }).returning({ id: preauthDocuments.id })
    await logAudit(session, 'rcm: uploaded pre-authorisation document', found.patientId, `preauth=${preauthId} document=${row.id} kind=${input.kind}`, tx)
    return rcmOk({ documentId: row.id })
  })
}

/** Server-side only: a pre-auth document's blob (never returned in JSON). */
export async function getPreauthDocumentBlob(documentId: number): Promise<{ url: string; preauthId: number; patientId: string; contentType: string; title: string } | null> {
  const [r] = await getDb().select({ url: preauthDocuments.blobUrl, preauthId: preauthDocuments.preauthId, patientId: preauths.patientId, contentType: preauthDocuments.contentType, title: preauthDocuments.title })
    .from(preauthDocuments).innerJoin(preauths, eq(preauths.id, preauthDocuments.preauthId)).where(eq(preauthDocuments.id, documentId)).limit(1)
  return r ?? null
}

export interface RcmPatientMinimum { id: string; name: string; uhid: string | null; gender: string | null; dob: string | null; ageYears: number | null }

export interface PreauthDetail {
  preauth: Omit<PreauthRow, never>
  events: { id: number; action: string; fromStatus: PreauthStatus | null; toStatus: PreauthStatus; amountPaise: number | null; reasonCode: string | null; note: string | null; hasSnapshot: boolean; byName: string; at: Date }[]
  queries: { id: number; question: string; raisedOn: string; dueOn: string; status: string; responses: { id: number; body: string; respondedOn: string; byName: string; at: Date }[] }[]
  documents: { id: number; kind: string; title: string; contentType: string; byteSize: number; sha256: string; queryResponseId: number | null; uploadedByName: string; uploadedAt: Date }[]
  patient: RcmPatientMinimum
  policy: PolicyView | null
  preauthSlaHours: number
}

async function slaHoursFor(insurerPayerId: number, tpaPayerId: number | null): Promise<number> {
  const [r] = await getDb().select({ h: payerProfiles.preauthSlaHours }).from(payerProfiles).where(eq(payerProfiles.payerId, tpaPayerId ?? insurerPayerId)).limit(1)
  return r?.h ?? 1
}

export async function getPreauthDetail(id: number, now: Date = new Date()): Promise<PreauthDetail | null> {
  const db = getDb()
  const [p] = await db.select().from(preauths).where(eq(preauths.id, id)).limit(1)
  if (!p) return null
  const [events, queries, docs, patient, policy, sla] = await Promise.all([
    db.select({
      id: preauthEvents.id, action: preauthEvents.action, fromStatus: preauthEvents.fromStatus, toStatus: preauthEvents.toStatus, amountPaise: preauthEvents.amountPaise,
      reasonCode: preauthEvents.reasonCode, note: preauthEvents.note, hasSnapshot: sql<boolean>`${preauthEvents.snapshotSha256} is not null`, byName: preauthEvents.byName, at: preauthEvents.at,
    }).from(preauthEvents).where(eq(preauthEvents.preauthId, id)).orderBy(asc(preauthEvents.at), asc(preauthEvents.id)),
    db.select().from(rcmQueries).where(eq(rcmQueries.preauthId, id)).orderBy(asc(rcmQueries.id)),
    db.select({
      id: preauthDocuments.id, kind: preauthDocuments.kind, title: preauthDocuments.title, contentType: preauthDocuments.contentType, byteSize: preauthDocuments.byteSize,
      sha256: preauthDocuments.sha256, queryResponseId: preauthDocuments.queryResponseId, uploadedByName: preauthDocuments.uploadedByName, uploadedAt: preauthDocuments.uploadedAt,
    }).from(preauthDocuments).where(eq(preauthDocuments.preauthId, id)).orderBy(asc(preauthDocuments.id)),
    db.select({ id: patients.id, name: patients.name, uhid: patients.uhid, gender: patients.gender, dob: patients.dob }).from(patients).where(eq(patients.id, p.patientId)).limit(1),
    getPolicyView(p.policyId),
    slaHoursFor(p.insurerPayerId, p.tpaPayerId),
  ])
  const queryIds = queries.map((q) => q.id)
  const responses = queryIds.length === 0 ? [] : await db.select().from(rcmQueryResponses).where(inArray(rcmQueryResponses.queryId, queryIds)).orderBy(asc(rcmQueryResponses.id))
  const pt = patient[0]
  return {
    preauth: p,
    events: events.map((e) => ({ ...e, hasSnapshot: Boolean(e.hasSnapshot) })),
    queries: queries.map((q) => ({
      id: q.id, question: q.question, raisedOn: q.raisedOn, dueOn: q.dueOn, status: q.status,
      responses: responses.filter((r) => r.queryId === q.id).map((r) => ({ id: r.id, body: r.body, respondedOn: r.respondedOn, byName: r.byName, at: r.at })),
    })),
    documents: docs,
    patient: { id: pt.id, name: pt.name, uhid: pt.uhid, gender: pt.gender, dob: pt.dob, ageYears: pt.dob ? ageOnDate(pt.dob, todayIsoIn(undefined, now)) : null },
    policy,
    preauthSlaHours: sla,
  }
}

export interface PreauthListRow {
  id: number; preauthNumber: string; status: PreauthStatus; claimType: string; patientId: string; patientName: string; uhid: string | null
  insurerName: string; requestedPaise: number; approvedPaise: number | null; validUntil: string | null; plannedAdmissionDate: string
  lastRequestedAt: Date | null; decisionOverdue: boolean
}

const PAGE_SIZE = 50
const insurerPayer = alias(payers, 'preauth_insurer')
const billingProfile = alias(payerProfiles, 'preauth_billing_profile')

export async function listPreauths(opts: { status?: PreauthStatus; q?: string; page?: number; now?: Date } = {}): Promise<{ rows: PreauthListRow[]; total: number }> {
  const now = opts.now ?? new Date()
  const page = Math.max(1, opts.page ?? 1)
  const term = opts.q?.trim()
  const escaped = term ? term.replace(/[\\%_]/g, (c) => `\\${c}`) : ''
  const where = and(
    opts.status ? eq(preauths.status, opts.status) : undefined,
    term ? or(ilike(preauths.preauthNumber, `%${escaped}%`), ilike(patients.name, `%${escaped}%`), sql`upper(${patients.uhid}) = upper(${term})`) : undefined,
  )
  const db = getDb()
  const [rows, count] = await Promise.all([
    db.select({
      id: preauths.id, preauthNumber: preauths.preauthNumber, status: preauths.status, claimType: preauths.claimType, patientId: preauths.patientId,
      patientName: patients.name, uhid: patients.uhid, insurerName: insurerPayer.name, requestedPaise: preauths.requestedPaise, approvedPaise: preauths.approvedPaise,
      validUntil: preauths.validUntil, plannedAdmissionDate: preauths.plannedAdmissionDate, lastRequestedAt: preauths.lastRequestedAt, slaHours: billingProfile.preauthSlaHours,
    }).from(preauths)
      .innerJoin(patients, eq(patients.id, preauths.patientId))
      .innerJoin(insurerPayer, eq(insurerPayer.id, preauths.insurerPayerId))
      .leftJoin(billingProfile, eq(billingProfile.payerId, sql`coalesce(${preauths.tpaPayerId}, ${preauths.insurerPayerId})`))
      .where(where).orderBy(desc(preauths.updatedAt), desc(preauths.id)).limit(PAGE_SIZE).offset((page - 1) * PAGE_SIZE),
    db.select({ n: sql<number>`count(*)::int` }).from(preauths).innerJoin(patients, eq(patients.id, preauths.patientId)).where(where),
  ])
  return {
    rows: rows.map(({ slaHours, ...r }) => ({ ...r, decisionOverdue: preauthDecisionOverdue({ status: r.status, lastRequestedAt: r.lastRequestedAt, now, preauthSlaHours: slaHours ?? 1 }) })),
    total: count[0]?.n ?? 0,
  }
}

export interface EstimateCoverage { insurerPaise: number; patientPaise: number; warnings: string[] }

/**
 * The pre-auth estimate for a policy (priced with its billing payer's tariff), with the WS12 R8
 * indicative insurer/patient split from the effective limits (the current verification's values,
 * else the policy's own). `coverage` is null when no limit is known, or when the policy is not in
 * force on the planned date or its current verification says inactive (the create is refused
 * then). Not audited; writes nothing.
 */
export async function estimateForPolicy(input: PreauthEstimateInput, now: Date = new Date()): Promise<RcmWriteResult<{ lines: EstimateLine[]; totalPaise: number; coverage: EstimateCoverage | null }>> {
  const db = getDb()
  const ctx = await loadPolicyContext(db, input.policyId)
  if (!ctx || ctx.row.status !== 'active') return rcmFail('policy_not_found')
  const roomCategoryCode = input.roomCategoryCode ?? null
  const priced = await estimatePreauth({ payerId: ctx.billingPayerId, onDate: input.plannedAdmissionDate, roomCategoryCode, items: input.estimate })
  if (!priced.ok) return priced
  const { lines, totalPaise } = priced.value
  const [view, current] = await Promise.all([getPolicyView(input.policyId, db), currentVerification(db, input.policyId, now)])
  if (!view || coverageRefusal(ctx, current, input.plannedAdmissionDate, now)) return rcmOk({ lines, totalPaise, coverage: null })
  const limits = effectiveLimits(
    { sumInsuredPaise: view.sumInsuredPaise, balancePaise: null, copayBp: view.copayBp, roomRentLimitPaise: view.roomRentLimitPaise, icuLimitPaise: view.icuLimitPaise },
    current?.limits ?? null,
  )
  if (Object.values(limits).every((v) => v === null)) return rcmOk({ lines, totalPaise, coverage: null })
  const ids = [...new Set(lines.map((l) => l.serviceId))]
  const categories = new Map((await db.select({ id: serviceCatalog.id, category: serviceCatalog.category }).from(serviceCatalog).where(inArray(serviceCatalog.id, ids))).map((r) => [r.id, r.category]))
  const split = applyCoverageToEstimate({
    lines: lines.map((l) => ({ amountPaise: l.amountPaise, category: categories.get(l.serviceId) ?? null, unitPricePaise: l.unitPricePaise, quantity: l.quantity })),
    limits, roomCategoryCode, lengthOfStayDays: input.expectedLengthOfStayDays ?? 0,
  })
  return rcmOk({ lines, totalPaise, coverage: { insurerPaise: split.insurerPaise, patientPaise: split.patientPaise, warnings: split.warnings } })
}

/** The patient's admissions and visits a pre-auth may be for (newest first, at most 20 each). */
export async function listPatientEpisodes(patientId: string): Promise<{ admissions: { id: number; admittedOn: string; status: string }[]; encounters: { id: number; date: string; type: string }[] }> {
  const db = getDb()
  const [a, e] = await Promise.all([
    db.select({ id: admissions.id, admittedAt: admissions.admittedAt, status: admissions.status }).from(admissions).where(eq(admissions.patientId, patientId)).orderBy(desc(admissions.admittedAt)).limit(20),
    db.select({ id: encounters.id, date: encounters.encounterDate, type: encounters.encounterType }).from(encounters).where(and(eq(encounters.patientId, patientId), eq(encounters.encounterType, 'opd'))).orderBy(desc(encounters.encounterDate)).limit(20),
  ])
  return { admissions: a.map((r) => ({ id: r.id, admittedOn: istDateOf(r.admittedAt), status: r.status })), encounters: e }
}

export type { PreauthFormDefaults } from '@/lib/rcm/preauth-form'

/**
 * WS12 T8: what a new pre-auth starts with. From an admission (the given one, else the
 * patient's only active admission): IPD, the IST date of admission, the attending doctor, the
 * current room's category and the admission's coverage policy (admission_coverage.policy_id).
 * From a visit: OPD, the visit date and its doctor. The policy otherwise is the primary active
 * policy (preferring one in force on the planned date, else today). An id that is not this
 * patient's is ignored. Reads only.
 */
export async function preauthDefaultsFor(patientId: string, opts: { admissionId?: number; encounterId?: number }, now: Date = new Date()): Promise<PreauthFormDefaults> {
  const db = getDb()
  const out: PreauthFormDefaults = { admissionId: null, encounterId: null, claimType: 'ipd', plannedAdmissionDate: null, treatingProviderId: null, policyId: null, roomCategoryCode: null }
  let coveragePolicyId: number | null = null

  const admissionCols = {
    id: admissions.id, admittedAt: admissions.admittedAt, providerId: admissions.attendingProviderId, roomCategoryCode: roomCategories.code, policyId: admissionCoverage.policyId,
  }
  const admissionQuery = () => db.select(admissionCols).from(admissions)
    .leftJoin(rooms, eq(rooms.id, admissions.currentRoomId))
    .leftJoin(roomCategories, eq(roomCategories.id, rooms.roomCategoryId))
    .leftJoin(admissionCoverage, eq(admissionCoverage.admissionId, admissions.id))
  let admission: { id: number; admittedAt: Date; providerId: number; roomCategoryCode: string | null; policyId: number | null } | undefined
  if (opts.admissionId !== undefined) {
    ;[admission] = await admissionQuery().where(and(eq(admissions.id, opts.admissionId), eq(admissions.patientId, patientId))).limit(1)
  }
  const encounter = !admission && opts.encounterId !== undefined
    ? (await db.select({ id: encounters.id, date: encounters.encounterDate, providerId: encounters.providerId }).from(encounters)
      .where(and(eq(encounters.id, opts.encounterId), eq(encounters.patientId, patientId))).limit(1))[0]
    : undefined
  if (!admission && !encounter) {
    const active = await admissionQuery().where(and(eq(admissions.patientId, patientId), eq(admissions.status, 'admitted'))).limit(2)
    if (active.length === 1) admission = active[0]
  }
  if (admission) {
    Object.assign(out, { admissionId: admission.id, plannedAdmissionDate: istDateOf(admission.admittedAt), treatingProviderId: admission.providerId, roomCategoryCode: admission.roomCategoryCode ?? null })
    coveragePolicyId = admission.policyId
  } else if (encounter) {
    Object.assign(out, { encounterId: encounter.id, claimType: 'opd', plannedAdmissionDate: encounter.date, treatingProviderId: encounter.providerId })
  }

  const policies = (await listPatientPolicies(patientId, db)).filter((p) => p.status === 'active')
  const onDate = out.plannedAdmissionDate ?? todayIsoIn(undefined, now)
  const inForce = (p: PolicyView) => p.validFrom <= onDate && onDate <= p.validTo
  const chosen = policies.find((p) => p.id === coveragePolicyId)
    ?? policies.find((p) => p.priority === 'primary' && inForce(p)) ?? policies.find(inForce)
    ?? policies.find((p) => p.priority === 'primary') ?? policies[0]
  out.policyId = chosen?.id ?? null
  return out
}
