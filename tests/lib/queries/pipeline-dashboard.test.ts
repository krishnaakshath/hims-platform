import { describe, it, expect } from 'vitest'
import { getPipelinePerformance, getPipelineTrend } from '@/lib/queries/pipeline-dashboard'

describe('getPipelinePerformance', () => {
  it('returns all four KPIs for a wide date range', async () => {
    const performance = await getPipelinePerformance({ from: new Date('2000-01-01'), to: new Date() })
    expect(performance.referralsReceived).toBeGreaterThan(0)
    expect(performance.formsCompleted).toBeGreaterThan(0)
    expect(performance.patientsClassified).toBeGreaterThanOrEqual(0)
  })

  it('returns zero referrals for a date range with no data', async () => {
    const performance = await getPipelinePerformance({ from: new Date('1990-01-01'), to: new Date('1990-01-02') })
    expect(performance.referralsReceived).toBe(0)
    expect(performance.avgDaysToClassify).toBeNull()
  })
})

describe('getPipelineTrend', () => {
  it('buckets referrals/forms-completed/classified by calendar day for a wide date range', async () => {
    const trend = await getPipelineTrend({ from: new Date('2000-01-01'), to: new Date() })
    expect(Array.isArray(trend)).toBe(true)
    expect(trend.length).toBeGreaterThan(0)
    for (const point of trend) {
      expect(point.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(point.referrals).toBeGreaterThanOrEqual(0)
      expect(point.formsCompleted).toBeGreaterThanOrEqual(0)
      expect(point.classified).toBeGreaterThanOrEqual(0)
    }
    // Days are sorted ascending and unique -- no duplicate bucket per day.
    const dates = trend.map((p) => p.date)
    expect(dates).toEqual([...dates].sort())
    expect(new Set(dates).size).toBe(dates.length)
    // Cross-check against the aggregate KPI this same window reports.
    const performance = await getPipelinePerformance({ from: new Date('2000-01-01'), to: new Date() })
    const totalReferrals = trend.reduce((sum, p) => sum + p.referrals, 0)
    expect(totalReferrals).toBe(performance.referralsReceived)
  })

  it('returns an empty trend for a date range with no data', async () => {
    const trend = await getPipelineTrend({ from: new Date('1990-01-01'), to: new Date('1990-01-02') })
    expect(trend).toEqual([])
  })
})
