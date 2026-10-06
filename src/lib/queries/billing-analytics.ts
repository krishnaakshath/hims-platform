import { getDb } from '@/db/client'
import { charges, insuranceClaims, mockPayments } from '@/db/schema'
import { getOrSetCache, billingAnalyticsCacheKey } from '@/lib/cache'
import { computeChargeBalances } from '@/lib/billing-calculations'

export interface MonthlyTrendPoint { month: string; grossChargesCents: number; netCollectionsCents: number }

export async function getBillingAnalyticsData() {
  return getOrSetCache(billingAnalyticsCacheKey(), 15, async () => {
    const db = getDb()
    const allCharges = await db.select().from(charges)
    const claims = await db.select().from(insuranceClaims)
    const payments = await db.select().from(mockPayments)

    const submitted = allCharges.filter((c) => c.status === 'submitted')
    const balances = computeChargeBalances(submitted, claims, payments)
    const grossChargesCents = submitted.reduce((sum, c) => sum + c.amountCents, 0)
    const netCollectionsCents = submitted.reduce((sum, c) => sum + balances.get(c.id)!.collectedCents, 0)

    const byMonth = new Map<string, { grossChargesCents: number; netCollectionsCents: number }>()
    for (const c of submitted) {
      const month = c.dateOfService.slice(0, 7) // "YYYY-MM"
      const collected = balances.get(c.id)!.collectedCents
      const existing = byMonth.get(month) ?? { grossChargesCents: 0, netCollectionsCents: 0 }
      byMonth.set(month, { grossChargesCents: existing.grossChargesCents + c.amountCents, netCollectionsCents: existing.netCollectionsCents + collected })
    }

    const trend: MonthlyTrendPoint[] = Array.from(byMonth.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, v]) => ({ month, ...v }))

    return {
      patientVisits: submitted.length,
      grossChargesCents,
      netCollectionsCents,
      trend,
    }
  })
}
