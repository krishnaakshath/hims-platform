import { describe, it, expect } from 'vitest'
import { REPORT_MAX_RANGE_DAYS, parseReportRange, resolveReportRange } from '@/lib/reports/range'

// Wave I (P1-23): report date ranges are inclusive IST calendar dates, at most
// REPORT_MAX_RANGE_DAYS long; the page falls back to the current IST month.
describe('parseReportRange', () => {
  it('accepts a valid inclusive range', () => {
    expect(parseReportRange('2026-10-01', '2026-10-08')).toEqual({ ok: true, range: { from: '2026-10-01', to: '2026-10-08' } })
  })

  it('accepts a single day', () => {
    expect(parseReportRange('2026-10-08', '2026-10-08').ok).toBe(true)
  })

  it.each([
    ['', '2026-10-08'],
    ['2026-10-01', ''],
    ['2026-13-01', '2026-10-08'],
    ['2026-02-30', '2026-03-01'],
    ['01-10-2026', '2026-10-08'],
    ['2026-10-09', '2026-10-08'],
  ])('rejects %s .. %s', (from, to) => {
    expect(parseReportRange(from, to)).toEqual({ ok: false, error: 'Choose a valid date range' })
  })

  it('caps the range length', () => {
    expect(REPORT_MAX_RANGE_DAYS).toBe(366)
    expect(parseReportRange('2025-10-08', '2026-10-08').ok).toBe(true) // 365 days
    expect(parseReportRange('2024-10-08', '2026-10-08')).toEqual({ ok: false, error: 'Choose at most 366 days' })
  })
})

describe('resolveReportRange (page search params)', () => {
  it('defaults to the first of the IST month through today', () => {
    expect(resolveReportRange({}, '2026-10-08')).toEqual({ range: { from: '2026-10-01', to: '2026-10-08' }, problem: null })
  })

  it('uses the given range, first value of a repeated param', () => {
    expect(resolveReportRange({ from: ['2026-09-01', 'x'], to: '2026-09-30' }, '2026-10-08')).toEqual({ range: { from: '2026-09-01', to: '2026-09-30' }, problem: null })
  })

  it('falls back to the default with the problem named for a bad range', () => {
    expect(resolveReportRange({ from: '2026-10-09', to: '2026-10-01' }, '2026-10-08')).toEqual({ range: { from: '2026-10-01', to: '2026-10-08' }, problem: 'Choose a valid date range' })
  })
})
