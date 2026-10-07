import { describe, it, expect } from 'vitest'
import { todayIsoIn, ageOnDate, DEFAULT_TIMEZONE } from '@/lib/india-time'

describe('india-time', () => {
  it('defaults to Asia/Kolkata', () => { expect(DEFAULT_TIMEZONE).toBe('Asia/Kolkata') })
  it('uses the Kolkata calendar date, not UTC', () => { expect(todayIsoIn('Asia/Kolkata', new Date('2026-10-06T19:00:00Z'))).toBe('2026-10-07') })
  it('computes age in whole years across a birthday', () => { expect(ageOnDate('2008-10-08', '2026-10-07')).toBe(17); expect(ageOnDate('2008-10-07', '2026-10-07')).toBe(18) })
})
