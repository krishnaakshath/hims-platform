import { randomUUID, createHash } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { nhcxEligibilityChecks, nhcxExchanges, payers, providers, type NhcxExchangeRow } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { todayIsoIn } from '@/lib/india-time'
import { readNhcxConfig } from '@/lib/integrations/config'
import { rcmFail, rcmOk, type RcmWriteResult } from '@/lib/rcm/errors'
import type { SnapshotPatient } from '@/lib/rcm/snapshot'
import { formatAbhaNumber, normalizeAbhaNumber } from '@/lib/india/abha'
import { buildEligibilityBundle, type EligibilityInput } from '@/lib/fhir/nhcx/eligibility'
import { NHCX_BUILD_ERROR_COPY, NhcxBuildError } from '@/lib/fhir/nhcx/resources'
import { validateNhcxBundle } from '@/lib/fhir/nhcx/validate'
import { recipientCodeFor } from '@/lib/nhcx/claim-gateway'
import type { EligibilityContext, EligibilityPurpose, EligibilityStatus } from '@/lib/nhcx/constants'
import { registrationOf } from './claim-submissions'
import { defaultSchedule, dispatchExchange, senderCode, type OutboundBuild } from './nhcx-exchanges'
import { loadPolicyContext, loadRcmPatient, loadSnapshotHospital } from './rcm-context'
import type { WriteExecutor } from './executor'

// SP8 NHCX coverage eligibility (Task 14), replacing the simulated check. A
// check and its outbound exchange are written in one transaction; the send
// happens after commit. The insurer's answer (callback) sets the check's
// status; nothing else changes.

type Prepared = { ok: true; input: Omit<EligibilityInput, 'requestId' | 'created'>; recipient: string; patientId: string; payerId: number } | { ok: false; error: RcmWriteResult<never> & { ok: false } }

async function prepare(executor: WriteExecutor, policyId: number, providerId: number, purpose: EligibilityPurpose, today: string): Promise<Prepared> {
  const ctx = await loadPolicyContext(executor, policyId)
  if (!ctx) return { ok: false, error: rcmFail('policy_not_found') }
  if (ctx.row.status !== 'active' || ctx.row.validFrom > today || ctx.row.validTo < today) return { ok: false, error: rcmFail('payer_inactive', 'This policy is not active today') }
  const recipient = recipientCodeFor(ctx.policy)
  if (!recipient) return { ok: false, error: rcmFail('gateway_not_configured', NHCX_BUILD_ERROR_COPY.payer_not_on_nhcx) }
  const [doc] = await executor.select({ name: providers.name, council: providers.registrationCouncil, state: providers.registrationStateCode, number: providers.registrationNumber })
    .from(providers).where(eq(providers.id, providerId)).limit(1)
  if (!doc) return { ok: false, error: rcmFail('not_ready', 'Choose the treating doctor') }
  const registrationNumber = registrationOf(doc)
  if (!registrationNumber) return { ok: false, error: rcmFail('not_ready', NHCX_BUILD_ERROR_COPY.practitioner_registration_missing) }
  const hospital = await loadSnapshotHospital(executor)
  if (!hospital.hfrId && !hospital.rohiniId) return { ok: false, error: rcmFail('not_ready', NHCX_BUILD_ERROR_COPY.hospital_ids_missing) }
  const p = await loadRcmPatient(executor, ctx.row.patientId)
  if (!p) return { ok: false, error: rcmFail('patient_not_found') }
  if (!p.patient.uhid) return { ok: false, error: rcmFail('not_ready', NHCX_BUILD_ERROR_COPY.patient_uhid_missing) }
  const includeAbha = ctx.billingProfile?.requiresAbha === true
  const patient: SnapshotPatient = { ...p.patient, abhaNumber: includeAbha && p.abhaNumber ? formatAbhaNumber(normalizeAbhaNumber(p.abhaNumber)) : null }
  const insurer = ctx.policy.tpa?.nhcxParticipantCode ? ctx.policy.tpa : ctx.policy.insurer
  return {
    ok: true, recipient, patientId: ctx.row.patientId, payerId: insurer.payerId,
    input: { purpose, patient, hospital, insurer, policy: ctx.policy, practitioner: { name: doc.name, registrationNumber }, serviceDate: today },
  }
}

export interface EligibilityDeps { now?: () => Date; schedule?: (fn: () => Promise<unknown>) => void; dispatch?: (id: number) => Promise<unknown> }

export async function requestEligibility(
  input: { policyId: number; purpose: EligibilityPurpose; context: EligibilityContext; providerId: number },
  session: Session, deps: EligibilityDeps = {},
): Promise<RcmWriteResult<{ checkId: number; exchangeId: number }>> {
  const cfg = readNhcxConfig()
  if (cfg.state === 'not_configured') return rcmFail('gateway_not_configured', 'NHCX is not configured')
  const now = (deps.now ?? (() => new Date()))()
  const today = todayIsoIn(undefined, now)
  const db = getDb()
  const prep = await prepare(db, input.policyId, input.providerId, input.purpose, today)
  if (!prep.ok) return prep.error
  let bundle
  try {
    bundle = buildEligibilityBundle({ ...prep.input, requestId: randomUUID(), created: now })
  } catch (e) {
    if (e instanceof NhcxBuildError) return rcmFail('not_ready', NHCX_BUILD_ERROR_COPY[e.code])
    throw e
  }
  if (validateNhcxBundle(bundle, 'CoverageEligibilityRequestBundle').length > 0) return rcmFail('not_ready', 'The eligibility check could not be prepared for NHCX')
  const isMock = cfg.state === 'mock'
  const result = await db.transaction(async (tx) => {
    const [check] = await tx.insert(nhcxEligibilityChecks).values({
      patientId: prep.patientId, policyId: input.policyId, payerId: prep.payerId, providerId: input.providerId, purpose: input.purpose, context: input.context,
      requestedByName: session.name, requestedByUserId: session.userId, requestedAt: now, isMock,
    }).returning({ id: nhcxEligibilityChecks.id })
    const [ex] = await tx.insert(nhcxExchanges).values({
      entityType: 'coverageeligibility', direction: 'outbound', action: 'coverageeligibility/check', correlationId: randomUUID(), apiCallId: randomUUID(),
      senderCode: senderCode(), recipientCode: prep.recipient, state: 'pending_send', patientId: prep.patientId, policyId: input.policyId, eligibilityCheckId: check.id,
      nextAttemptAt: now, bodySha256: createHash('sha256').update(JSON.stringify(bundle)).digest('hex'), isMock, createdAt: now, updatedAt: now,
    }).returning({ id: nhcxExchanges.id })
    await logAudit(session, 'nhcx: requested eligibility', prep.patientId, `check=${check.id} policy=${input.policyId} purpose=${input.purpose} context=${input.context}`, tx)
    return { checkId: check.id, exchangeId: ex.id }
  })
  ;(deps.schedule ?? defaultSchedule)(() => (deps.dispatch ?? dispatchExchange)(result.exchangeId))
  return rcmOk(result)
}

/** Rebuilds the eligibility bundle at dispatch time (outbound bundles are not stored). */
export async function buildEligibilityOutbound(row: NhcxExchangeRow, now: Date): Promise<OutboundBuild> {
  if (!row.eligibilityCheckId || !row.policyId) return { ok: false, code: 'snapshot_missing' }
  const db = getDb()
  const [check] = await db.select().from(nhcxEligibilityChecks).where(eq(nhcxEligibilityChecks.id, row.eligibilityCheckId)).limit(1)
  if (!check?.providerId) return { ok: false, code: 'snapshot_missing' }
  const prep = await prepare(db, row.policyId, check.providerId, check.purpose, todayIsoIn(undefined, check.requestedAt))
  if (!prep.ok) return { ok: false, code: 'build_invalid' }
  try {
    return { ok: true, profile: 'CoverageEligibilityRequestBundle', abhaId: prep.input.patient.abhaNumber, fhir: buildEligibilityBundle({ ...prep.input, requestId: row.correlationId, created: now }) }
  } catch (e) {
    if (e instanceof NhcxBuildError) return { ok: false, code: e.code }
    throw e
  }
}

export interface EligibilityView { id: number; status: EligibilityStatus; inforce: boolean | null; requestedAt: string; respondedAt: string | null; payerName: string; isMock: boolean; patientId: string }

const viewColumns = {
  id: nhcxEligibilityChecks.id, status: nhcxEligibilityChecks.status, inforce: nhcxEligibilityChecks.inforce, requestedAt: nhcxEligibilityChecks.requestedAt,
  respondedAt: nhcxEligibilityChecks.respondedAt, payerName: payers.name, isMock: nhcxEligibilityChecks.isMock, patientId: nhcxEligibilityChecks.patientId,
}
const toView = (r: { id: number; status: EligibilityStatus; inforce: boolean | null; requestedAt: Date; respondedAt: Date | null; payerName: string; isMock: boolean; patientId: string }): EligibilityView => ({
  ...r, requestedAt: r.requestedAt.toISOString(), respondedAt: r.respondedAt ? r.respondedAt.toISOString() : null,
})

export async function getEligibilityCheck(id: number): Promise<EligibilityView | null> {
  const [r] = await getDb().select(viewColumns).from(nhcxEligibilityChecks).innerJoin(payers, eq(payers.id, nhcxEligibilityChecks.payerId)).where(eq(nhcxEligibilityChecks.id, id)).limit(1)
  return r ? toView(r) : null
}

export async function latestEligibilityForPolicy(policyId: number): Promise<EligibilityView | null> {
  const [r] = await getDb().select(viewColumns).from(nhcxEligibilityChecks).innerJoin(payers, eq(payers.id, nhcxEligibilityChecks.payerId))
    .where(eq(nhcxEligibilityChecks.policyId, policyId)).orderBy(desc(nhcxEligibilityChecks.id)).limit(1)
  return r ? toView(r) : null
}

/** Whether the NHCX eligibility button can work at all (configured, or the labelled mock). No config values leave here. */
export function nhcxEligibilityAvailable(): boolean {
  return readNhcxConfig().state !== 'not_configured'
}

/** Policy id -> whether its recipient (TPA with a code, else insurer) is on NHCX. */
export function payersOnNhcx(policies: readonly { id: number; insurer: { payerId: number }; tpa: { payerId: number } | null }[], payerCodes: Map<number, string | null>): Record<number, boolean> {
  return Object.fromEntries(policies.map((p) => [p.id, Boolean((p.tpa && payerCodes.get(p.tpa.payerId)) || payerCodes.get(p.insurer.payerId))]))
}
