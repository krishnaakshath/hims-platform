import { describe, it, expect } from 'vitest'
import { agingBucketLabel, daysBetweenIso, claimSlaFlags, preauthDecisionOverdue } from '@/lib/rcm/sla'

describe('RCM ageing and SLA', () => {
  it('buckets ages', () => {
    expect(agingBucketLabel(30)).toBe('0-30'); expect(agingBucketLabel(91)).toBe('91-180'); expect(agingBucketLabel(-2)).toBe('0-30'); expect(daysBetweenIso('2026-03-31', '2026-04-01')).toBe(1)
    expect(agingBucketLabel(181)).toBe('181+'); expect(agingBucketLabel(31)).toBe('31-60'); expect(daysBetweenIso('2026-10-10', '2026-10-01')).toBe(-9)
  })
  it('flags submission, query and settlement deadlines', () => {
    const p = { submissionWindowDays: 15, claimSettlementSlaDays: 30 }
    expect(claimSlaFlags({ status: 'draft', episodeEndDate: '2026-10-01', firstSubmittedOn: null, openQueryDueDates: [], today: '2026-10-17', payer: p })).toEqual(['submission_overdue'])
    expect(claimSlaFlags({ status: 'draft', episodeEndDate: '2026-10-01', firstSubmittedOn: null, openQueryDueDates: [], today: '2026-10-14', payer: p })).toEqual(['submission_due_soon'])
    expect(claimSlaFlags({ status: 'draft', episodeEndDate: '2026-10-01', firstSubmittedOn: null, openQueryDueDates: [], today: '2026-10-13', payer: p })).toEqual([])
    expect(claimSlaFlags({ status: 'queried', episodeEndDate: null, firstSubmittedOn: '2026-09-01', openQueryDueDates: ['2026-10-16'], today: '2026-10-17', payer: p })).toEqual(['query_overdue', 'settlement_overdue'])
    expect(claimSlaFlags({ status: 'submitted', episodeEndDate: null, firstSubmittedOn: '2026-10-01', openQueryDueDates: ['2026-10-19'], today: '2026-10-17', payer: p })).toEqual(['query_due_soon'])
    expect(claimSlaFlags({ status: 'settled', episodeEndDate: null, firstSubmittedOn: '2026-01-01', openQueryDueDates: [], today: '2026-10-17', payer: p })).toEqual([])
  })
  it('pre-auth decision overdue after the SLA hours', () => {
    expect(preauthDecisionOverdue({ status: 'requested', lastRequestedAt: new Date('2026-10-20T05:00:00Z'), now: new Date('2026-10-20T06:01:00Z'), preauthSlaHours: 1 })).toBe(true)
    expect(preauthDecisionOverdue({ status: 'requested', lastRequestedAt: new Date('2026-10-20T05:00:00Z'), now: new Date('2026-10-20T05:59:00Z'), preauthSlaHours: 1 })).toBe(false)
    expect(preauthDecisionOverdue({ status: 'approved', lastRequestedAt: new Date('2026-10-20T05:00:00Z'), now: new Date('2026-10-21T06:01:00Z'), preauthSlaHours: 1 })).toBe(false)
    expect(preauthDecisionOverdue({ status: 'enhancement_requested', lastRequestedAt: null, now: new Date(), preauthSlaHours: 1 })).toBe(false)
  })
})
