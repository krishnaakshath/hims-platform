// SP7: the pre-authorisation lifecycle (request with a tariff-priced estimate -> query ->
// approval with amount and validity -> enhancement -> rejection/cancellation). Every write runs
// in one transaction: the SP4 per-patient billing lock first, then the pre-auth row FOR UPDATE,
// then the event and the audit row. Audit details carry ids, numbers, statuses and paise only.
import { eq, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { admissions, encounters, preauths, providers } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { lineTaxablePaise, sumPaise } from '@/lib/billing/amounts'
import { lineTax } from '@/lib/billing/gst'
import { DIAGNOSIS_CODE_KINDS, PROCEDURE_CODE_KINDS, type CodeSystemKind } from '@/lib/coding/code-systems'
import { istDateOf } from '@/lib/india-time'
import { formatRcmNumber } from '@/lib/rcm/constants'
import { rcmFail, rcmOk, type RcmWriteResult } from '@/lib/rcm/errors'
import type { CodedEntry, EstimateLine } from '@/lib/rcm/snapshot'
import type { PreauthCreateInput } from '@/lib/rcm/validation'
import { resolvePrice } from '@/lib/tariff/resolve'
import { lockPatientBilling } from './billing-lock'
import { getCodesByIds } from './code-systems'
import type { WriteExecutor } from './executor'
import { loadPolicyContext } from './rcm-context'
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
