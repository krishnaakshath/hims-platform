// WS12 coverage: what is known about each of a patient's policies right now (R1, R2, R7).
// Reads only; the routes that call this audit the read. Insurer references and document URLs
// stay in the facts for the server; callers decide what leaves (never logged).
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { coverageVerifications, nhcxEligibilityChecks, payerProfiles, type CoverageVerificationRow } from '@/db/schema'
import type { EligibilityStatus, NhcxResponseSummary } from '@/lib/nhcx/constants'
import {
  COVERAGE_FRESH_HOURS, effectiveLimits, evaluateCoverage,
  type CoverageContext, type CoverageLimits, type CoveragePolicyFacts, type CoverageVerdict, type CoverageVerificationFacts,
} from '@/lib/insurance/coverage'
import { payersOnNhcx } from './nhcx-eligibility'
import { listPatientPolicies, type PolicyView } from './rcm-policies'
import type { WriteExecutor } from './executor'

export interface PolicyCoverage { policyId: number; verdict: CoverageVerdict; current: CoverageVerificationFacts | null; history: CoverageVerificationFacts[]; pendingCheckId: number | null; limits: CoverageLimits }
export interface CoverageSummary { primary: PolicyCoverage | null; policies: PolicyCoverage[] }

const HISTORY_LIMIT = 5

function toFacts(r: CoverageVerificationRow): CoverageVerificationFacts {
  return {
    id: r.id, source: r.source, result: r.result, verifiedAt: r.verifiedAt, validUntil: r.validUntil,
    verifiedByName: r.verifiedByName, method: r.method, insurerReference: r.insurerReference,
    limits: { sumInsuredPaise: r.sumInsuredPaise, balancePaise: r.balancePaise, copayBp: r.copayBp, roomRentLimitPaise: r.roomRentLimitPaise, icuLimitPaise: r.icuLimitPaise },
  }
}

/**
 * The verification in force for a policy at `now` (valid_until > now): the newest answered one
 * (active or inactive); only when none is current, the newest current error. A failed re-check
 * says nothing about cover, so it never hides a current answer.
 */
export async function currentVerification(executor: WriteExecutor, policyId: number, now: Date): Promise<CoverageVerificationFacts | null> {
  const [r] = await executor.select().from(coverageVerifications)
    .where(and(eq(coverageVerifications.policyId, policyId), gt(coverageVerifications.validUntil, now)))
    .orderBy(sql`(${coverageVerifications.result} = 'error')`, desc(coverageVerifications.verifiedAt), desc(coverageVerifications.id))
    .limit(1)
  return r ? toFacts(r) : null
}

function policyLimits(p: PolicyView): CoverageLimits {
  return { sumInsuredPaise: p.sumInsuredPaise, balancePaise: null, copayBp: p.copayBp, roomRentLimitPaise: p.roomRentLimitPaise, icuLimitPaise: p.icuLimitPaise }
}

/** The primary policy: the active primary one, else the first active one; an inactive policy is never primary. */
function primaryOf(policies: readonly PolicyView[]): PolicyView | null {
  return policies.find((p) => p.status === 'active' && p.priority === 'primary') ?? policies.find((p) => p.status === 'active') ?? null
}

async function coverageOf(executor: WriteExecutor, p: PolicyView, onNhcx: boolean, context: CoverageContext, now: Date): Promise<PolicyCoverage> {
  const rows = await executor.select().from(coverageVerifications).where(eq(coverageVerifications.policyId, p.id))
    .orderBy(desc(coverageVerifications.verifiedAt), desc(coverageVerifications.id)).limit(HISTORY_LIMIT)
  const history = rows.map(toFacts)
  const latest = history[0] ?? null
  const current = await currentVerification(executor, p.id, now)
  const pendingWhere = [eq(nhcxEligibilityChecks.policyId, p.id), eq(nhcxEligibilityChecks.status, 'pending')]
  if (latest) pendingWhere.push(gt(nhcxEligibilityChecks.requestedAt, latest.verifiedAt))
  const [pending] = await executor.select({ id: nhcxEligibilityChecks.id }).from(nhcxEligibilityChecks)
    .where(and(...pendingWhere)).orderBy(desc(nhcxEligibilityChecks.requestedAt), desc(nhcxEligibilityChecks.id)).limit(1)
  const pendingCheckId = pending?.id ?? null
  const own = policyLimits(p)
  const facts: CoveragePolicyFacts = { id: p.id, status: p.status, validFrom: p.validFrom, validTo: p.validTo, insurerName: p.insurer.name, onNhcx, limits: own }
  const verdict = evaluateCoverage({ policy: facts, verification: current ?? latest, pendingCheck: pendingCheckId !== null, context, now })
  return { policyId: p.id, verdict, current, history, pendingCheckId, limits: effectiveLimits(own, current?.limits ?? null) }
}

/**
 * Every policy of the patient (active first, primary first, newest) with its verdict in
 * `context`, its current verification, the last five verifications and a pending NHCX check
 * newer than the latest verification. `primary` is null when no policy is active.
 */
export async function getCoverageSummary(patientId: string, context: CoverageContext, now: Date = new Date(), executor: WriteExecutor = getDb()): Promise<CoverageSummary> {
  const views = await listPatientPolicies(patientId, executor)
  if (views.length === 0) return { primary: null, policies: [] }
  const payerIds = [...new Set(views.flatMap((p) => (p.tpa ? [p.insurer.payerId, p.tpa.payerId] : [p.insurer.payerId])))]
  const codes = await executor.select({ payerId: payerProfiles.payerId, code: payerProfiles.nhcxParticipantCode })
    .from(payerProfiles).where(inArray(payerProfiles.payerId, payerIds))
  const onNhcx = payersOnNhcx(views, new Map(codes.map((c) => [c.payerId, c.code])))
  const policies: PolicyCoverage[] = []
  for (const p of views) policies.push(await coverageOf(executor, p, onNhcx[p.id] ?? false, context, now))
  const primaryView = primaryOf(views)
  return { primary: primaryView ? policies.find((c) => c.policyId === primaryView.id) ?? null : null, policies }
}

const INSURER_REFERENCE_MAX = 64
const MAX_LIMIT_PAISE = 1_000_000_000_000
const amount = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= MAX_LIMIT_PAISE ? v : null)

/**
 * R1/R2/R6: the verification an answered NHCX eligibility check leaves, written inside the
 * transaction that settles the check. `eligible` -> active, `not_eligible` -> inactive; an
 * `error`, `no_response` or `pending` status writes nothing (null). Current for
 * COVERAGE_FRESH_HOURS. A second answer for the same check writes nothing (ON CONFLICT on
 * nhcx_check_id). The insurer reference is stored (≤ 64), never logged or returned.
 */
export async function recordNhcxVerificationTx(
  tx: WriteExecutor,
  i: { checkId: number; summary: NhcxResponseSummary; insurerReference: string | null; status: EligibilityStatus; isMock: boolean; now: Date },
): Promise<number | null> {
  const result = i.status === 'eligible' ? 'active' : i.status === 'not_eligible' ? 'inactive' : null
  if (!result) return null
  const [check] = await tx.select({
    patientId: nhcxEligibilityChecks.patientId, policyId: nhcxEligibilityChecks.policyId, context: nhcxEligibilityChecks.context,
    requestedByName: nhcxEligibilityChecks.requestedByName, requestedByUserId: nhcxEligibilityChecks.requestedByUserId, isMock: nhcxEligibilityChecks.isMock,
  }).from(nhcxEligibilityChecks).where(eq(nhcxEligibilityChecks.id, i.checkId)).limit(1)
  if (!check) return null
  const c = i.summary.coverage ?? null
  const reference = i.insurerReference?.trim().slice(0, INSURER_REFERENCE_MAX) || null
  const copay = c?.copayBp
  const [row] = await tx.insert(coverageVerifications).values({
    patientId: check.patientId, policyId: check.policyId,
    source: i.isMock || check.isMock ? 'nhcx_mock' : 'nhcx', result, context: check.context, nhcxCheckId: i.checkId,
    insurerReference: reference, verifiedByName: check.requestedByName, verifiedByUserId: check.requestedByUserId,
    verifiedAt: i.now, validUntil: new Date(i.now.getTime() + COVERAGE_FRESH_HOURS * 3_600_000),
    sumInsuredPaise: amount(c?.sumInsuredPaise), balancePaise: amount(c?.balancePaise),
    copayBp: typeof copay === 'number' && Number.isInteger(copay) && copay >= 0 && copay <= 10_000 ? copay : null,
    roomRentLimitPaise: amount(c?.roomRentLimitPaise), icuLimitPaise: amount(c?.icuLimitPaise),
    reportedValidTo: c?.benefitPeriodEnd && /^\d{4}-\d{2}-\d{2}$/.test(c.benefitPeriodEnd) ? c.benefitPeriodEnd : null,
  }).onConflictDoNothing({ target: coverageVerifications.nhcxCheckId }).returning({ id: coverageVerifications.id })
  return row?.id ?? null
}
