// SP7: the pre-authorisation lifecycle (request with a tariff-priced estimate -> query ->
// approval with amount and validity -> enhancement -> rejection/cancellation). Every write runs
// in one transaction: the SP4 per-patient billing lock first, then the pre-auth row FOR UPDATE,
// then the event and the audit row. Audit details carry ids, numbers, statuses and paise only.
import { and, eq, ne, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { admissions, encounters, preauthEvents, preauths, providers, rcmQueries, rcmQueryResponses, rcmReasonCodes, type PreauthRow } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { lineTaxablePaise, sumPaise } from '@/lib/billing/amounts'
import { lineTax } from '@/lib/billing/gst'
import { DIAGNOSIS_CODE_KINDS, PROCEDURE_CODE_KINDS, type CodeSystemKind } from '@/lib/coding/code-systems'
import { istDateOf } from '@/lib/india-time'
import { formatRcmNumber } from '@/lib/rcm/constants'
import { rcmFail, rcmOk, type RcmWriteResult } from '@/lib/rcm/errors'
import { isUniqueViolation } from '@/lib/db-errors'
import { formatPaise } from '@/lib/format'
import { snapshotSha256 } from '@/lib/rcm/hash'
import { nextPreauthStatus, type PreauthStatus } from '@/lib/rcm/preauth-status'
import { buildPreauthSnapshot, type PreauthSnapshot } from '@/lib/rcm/snapshot'
import type { CodedEntry, EstimateLine } from '@/lib/rcm/snapshot'
import type { PreauthActionRequest, PreauthCreateInput } from '@/lib/rcm/validation'
import { resolvePrice } from '@/lib/tariff/resolve'
import { lockPatientBilling } from './billing-lock'
import { getCodesByIds } from './code-systems'
import type { WriteExecutor } from './executor'
import { loadPolicyContext, loadRcmPatient, loadSnapshotHospital } from './rcm-context'
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

export async function createPreauth(input: PreauthCreateInput, session: Session, now: Date = new Date()): Promise<RcmWriteResult<{ preauthId: number; preauthNumber: string }>> {
  const db = getDb()
  const ctx = await loadPolicyContext(db, input.policyId)
  if (!ctx || ctx.row.status !== 'active') return rcmFail('policy_not_found')
  if (!ctx.payersActive) return rcmFail('payer_inactive')
  const patientId = ctx.row.patientId

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
