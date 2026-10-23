// WS12 T10 (spec R7, R8): the policy limits and the insured running total a payer charge line
// is checked against (room_rent_over_limit, sum_insured_exceeded). Reads only, on the caller's
// executor (inside capture's transaction, after the patient billing lock).
import { and, eq, ne, sql } from 'drizzle-orm'
import { admissionCoverage, chargeLines, patientPolicies } from '@/db/schema'
import type { ChargeRuleInput } from '@/lib/billing/charge-rules'
import { effectiveLimits } from '@/lib/insurance/coverage'
import { paiseFromDb } from '@/lib/billing/amounts'
import { currentVerification } from './coverage'
import { billingPayerOf } from './rcm-policies'
import type { WriteExecutor } from './executor'

export type CoverageLimitsForCharge = Omit<NonNullable<ChargeRuleInput['coverage']>, 'roomCategoryCode' | 'lineTaxablePaise'>

type PolicyRow = typeof patientPolicies.$inferSelect

/**
 * The policy behind a payer line: the admission's cashless policy (admission_coverage) when it
 * is billed to this payer, else the patient's active primary policy whose billing payer is
 * `payerId`. Limits are the current verification's where given, else the policy's own (R7);
 * the balance falls back to the sum insured. The running total is the admission's non-void
 * lines billed to the same payer (0 outside an admission). Null when no policy matches.
 */
export async function coverageLimitsForCharge(
  executor: WriteExecutor, i: { patientId: string; admissionId: number | null; payerId: number; now: Date },
): Promise<CoverageLimitsForCharge | null> {
  let policy: PolicyRow | null = null
  if (i.admissionId !== null) {
    const [ac] = await executor.select({ policyId: admissionCoverage.policyId }).from(admissionCoverage)
      .where(and(eq(admissionCoverage.admissionId, i.admissionId), eq(admissionCoverage.mode, 'cashless'))).limit(1)
    if (ac?.policyId != null) {
      const [p] = await executor.select().from(patientPolicies)
        .where(and(eq(patientPolicies.id, ac.policyId), eq(patientPolicies.patientId, i.patientId))).limit(1)
      if (p && billingPayerOf(p) === i.payerId) policy = p
    }
  }
  if (policy === null) {
    const [p] = await executor.select().from(patientPolicies).where(and(
      eq(patientPolicies.patientId, i.patientId), eq(patientPolicies.status, 'active'), eq(patientPolicies.priority, 'primary'),
    )).limit(1)
    if (p && billingPayerOf(p) === i.payerId) policy = p
  }
  if (policy === null) return null

  const current = await currentVerification(executor, policy.id, i.now)
  const limits = effectiveLimits({
    sumInsuredPaise: policy.sumInsuredPaise, balancePaise: null, copayBp: policy.copayBp,
    roomRentLimitPaise: policy.roomRentLimitPaise, icuLimitPaise: policy.icuLimitPaise,
  }, current?.limits ?? null)

  let insuredRunningPaise = 0
  if (i.admissionId !== null) {
    const [r] = await executor.select({ total: sql<string | null>`sum(${chargeLines.taxablePaise})` }).from(chargeLines).where(and(
      eq(chargeLines.admissionId, i.admissionId), eq(chargeLines.payerId, i.payerId), ne(chargeLines.status, 'void'),
    ))
    insuredRunningPaise = paiseFromDb(r?.total ?? null)
  }
  return {
    roomRentLimitPaise: limits.roomRentLimitPaise,
    icuLimitPaise: limits.icuLimitPaise,
    balancePaise: limits.balancePaise ?? limits.sumInsuredPaise,
    insuredRunningPaise,
  }
}
