import { describe, it, expect } from 'vitest'
import { getArDashboardData } from '@/lib/queries/ar-dashboard'

describe('getArDashboardData', () => {
  it('returns non-negative KPIs and a 5-bucket aging chart', async () => {
    const data = await getArDashboardData(new Date('2026-09-17'))
    expect(data.outstandingArCents).toBeGreaterThan(0)
    expect(data.grossCollectionRate).toBeGreaterThanOrEqual(0)
    expect(data.grossCollectionRate).toBeLessThanOrEqual(100)
    expect(data.avgDaysInAr).toBeGreaterThan(0)
    expect(data.agingBuckets).toHaveLength(5)
    expect(data.agingBuckets.map((b) => b.label)).toEqual(['0-30', '31-60', '61-90', '91-120', '121+'])
    // Bucket totals must always reconcile to the headline figure -- this is
    // a real invariant (unlike an exact per-bucket dollar assertion, which
    // would be brittle against this shared, mutable dev database: any
    // unattributed payment collected through the app, seeded or manual,
    // legitimately changes which buckets are nonzero via computeChargeBalances'
    // patient-level pooling).
    const bucketSum = data.agingBuckets.reduce((sum, b) => sum + b.outstandingCents, 0)
    expect(bucketSum).toBe(data.outstandingArCents)
  })
})
