import { createHash } from 'crypto'
import { getDb } from '@/db/client'
import { insuranceEligibilityChecks, insurancePlanTypeEnum } from '@/db/schema'
import { desc, eq, sql } from 'drizzle-orm'

export type InsuranceEligibilityCheckRow = typeof insuranceEligibilityChecks.$inferSelect
export type InsurancePlanType = typeof insurancePlanTypeEnum.enumValues[number]

const STATUSES = ['verified', 'inactive', 'needs_follow_up'] as const

/**
 * Deterministic simulation, same technique as
 * src/lib/queries/broadcasts.ts's simulateBroadcastDelivery -- there is no
 * real payer/clearinghouse contract behind this (same honest-mock
 * discipline as the Tebra/IntakeQ connectors), so the result is derived
 * from a hash of the input rather than randomness, which makes it testable
 * and stable for the same patient+payer pair every time it's re-checked.
 *
 * `planType` is not derived from the hash -- it's simply echoed back so
 * callers get one consistent result shape whether or not the patient has a
 * plan type on file. The route resolves what value to pass in, not this
 * function.
 */
export function simulateEligibilityCheck(patientId: string, payerName: string, planType: InsurancePlanType | null = null): {
  status: typeof STATUSES[number]
  copayCents: number | null
  deductibleRemainingCents: number | null
  planType: InsurancePlanType | null
  coverageStartDate: string | null
} {
  const hash = createHash('sha256').update(`${patientId}:${payerName.toLowerCase().trim()}`).digest()
  const status = STATUSES[hash[0] % STATUSES.length]
  const copayCents = status === 'verified' ? (hash[1] % 10) * 500 : null // $0-$45 in $5 steps
  const deductibleRemainingCents = status === 'verified' ? (hash[2] % 20) * 10000 : null // $0-$1900 in $100 steps
  // A simulated coverage effective date, 30-364 days in the past -- not
  // meant to be clinically meaningful, just a plausible, stable date for
  // the same patient+payer pair.
  const coverageStartDate = status === 'verified'
    ? new Date(Date.now() - (30 + (hash[3] % 335)) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    : null
  return { status, copayCents, deductibleRemainingCents, planType, coverageStartDate }
}

export interface RecordEligibilityCheckInput {
  patientId: string
  payerName: string
  payerId: number | null
  status: typeof STATUSES[number]
  copayCents: number | null
  deductibleRemainingCents: number | null
  planType: InsurancePlanType | null
  coverageStartDate: string | null
  checkedByName: string
}

export async function recordEligibilityCheck(input: RecordEligibilityCheckInput): Promise<InsuranceEligibilityCheckRow> {
  const [created] = await getDb().insert(insuranceEligibilityChecks).values(input).returning()
  return created
}

export async function getLatestEligibilityCheck(patientId: string): Promise<InsuranceEligibilityCheckRow | null> {
  const [row] = await getDb()
    .select()
    .from(insuranceEligibilityChecks)
    .where(eq(insuranceEligibilityChecks.patientId, patientId))
    .orderBy(desc(insuranceEligibilityChecks.checkedAt))
    .limit(1)
  return row ?? null
}

/**
 * Counts patients whose MOST RECENT eligibility check needs follow-up -- not
 * just any row ever marked needs_follow_up, since a later re-check of the
 * same patient may have since resolved it. A raw correlated-subquery SQL
 * expression (via Drizzle's `sql` template, same technique used elsewhere in
 * this codebase for aggregate queries -- see lib/queries/dashboard.ts) is the
 * clearest way to express "latest row per patient" without a window
 * function's added complexity for a single scalar count.
 */
export async function countEligibilityFollowUps(): Promise<number> {
  const result = await getDb().execute<{ count: number }>(sql`
    SELECT COUNT(DISTINCT a.patient_id)::int AS count
    FROM insurance_eligibility_checks a
    WHERE a.status = 'needs_follow_up'
      AND a.checked_at = (
        SELECT MAX(b.checked_at)
        FROM insurance_eligibility_checks b
        WHERE b.patient_id = a.patient_id
      )
  `)
  return result.rows[0]?.count ?? 0
}
