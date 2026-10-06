import { getDb } from '@/db/client'
import { charges, insuranceClaims, mockPayments } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { getOrSetCache, arDashboardCacheKey } from '@/lib/cache'
import { computeChargeBalances } from '@/lib/billing-calculations'

export interface AgingBucket { label: string; outstandingCents: number }

const BUCKETS = [
  { label: '0-30', min: 0, max: 30 },
  { label: '31-60', min: 31, max: 60 },
  { label: '61-90', min: 61, max: 90 },
  { label: '91-120', min: 91, max: 120 },
  { label: '121+', min: 121, max: Infinity },
]

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24))
}

async function computeArDashboardData(now: Date) {
  const db = getDb()
  const submittedCharges = await db.select().from(charges).where(eq(charges.status, 'submitted'))
  const claims = await db.select().from(insuranceClaims)
  const payments = await db.select().from(mockPayments)
  const balances = computeChargeBalances(submittedCharges, claims, payments)

  let outstandingCents = 0
  let totalBilledCents = 0
  let totalCollectedCents = 0
  let ageWeightedDaysSum = 0
  let outstandingWeightSum = 0
  const buckets: AgingBucket[] = BUCKETS.map((b) => ({ label: b.label, outstandingCents: 0 }))

  for (const charge of submittedCharges) {
    const { collectedCents, outstandingCents: outstanding } = balances.get(charge.id)!

    totalBilledCents += charge.amountCents
    totalCollectedCents += collectedCents
    outstandingCents += outstanding

    if (outstanding > 0) {
      const age = daysBetween(new Date(charge.dateOfService), now)
      // A charge dated in the future (age < 0) has no matching bucket --
      // clamp it into the youngest bucket rather than silently dropping
      // it, so agingBuckets always sums to outstandingArCents.
      const bucketIndex = age < 0 ? 0 : BUCKETS.findIndex((b) => age >= b.min && age <= b.max)
      if (bucketIndex >= 0) buckets[bucketIndex].outstandingCents += outstanding
      ageWeightedDaysSum += age * outstanding
      outstandingWeightSum += outstanding
    }
  }

  const grossCollectionRate = totalBilledCents > 0 ? (totalCollectedCents / totalBilledCents) * 100 : 0
  const avgDaysInAr = outstandingWeightSum > 0 ? ageWeightedDaysSum / outstandingWeightSum : 0

  return {
    outstandingArCents: outstandingCents,
    grossCollectionRate,
    avgDaysInAr,
    agingBuckets: buckets,
  }
}

export async function getArDashboardData(now?: Date) {
  // The 15s cache is keyed on nothing but the query result, so it can only
  // safely serve the real-clock call. A caller (currently only tests) that
  // injects an explicit `now` needs a result computed against THAT clock,
  // not whatever a concurrent real-clock call cached a moment ago -- so an
  // explicit `now` bypasses the cache entirely rather than risking a stale
  // cross-clock hit.
  if (now) return computeArDashboardData(now)
  return getOrSetCache(arDashboardCacheKey(), 15, () => computeArDashboardData(new Date()))
}
