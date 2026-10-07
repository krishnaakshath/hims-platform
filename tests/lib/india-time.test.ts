import { describe, it, expect } from 'vitest'
import { todayIsoIn, ageOnDate, DEFAULT_TIMEZONE } from '@/lib/india-time'

describe('india-time', () => {
  it('defaults to Asia/Kolkata', () => { expect(DEFAULT_TIMEZONE).toBe('Asia/Kolkata') })
  it('uses the Kolkata calendar date, not UTC', () => { expect(todayIsoIn('Asia/Kolkata', new Date('2026-10-06T19:00:00Z'))).toBe('2026-10-07') })
  it('computes age in whole years across a birthday', () => { expect(ageOnDate('2008-10-08', '2026-10-07')).toBe(17); expect(ageOnDate('2008-10-07', '2026-10-07')).toBe(18) })
})

import { istDateOf, startOfIstDay, formatIsoDate, formatDateTimeIn } from '@/lib/india-time'
describe('india-time SP3 helpers', () => {
  it('istDateOf puts 19:00Z on the next IST day', () => { expect(istDateOf(new Date('2026-10-21T19:00:00Z'))).toBe('2026-10-22') })
  it('startOfIstDay is 18:30Z the day before', () => { expect(startOfIstDay('2026-10-22').toISOString()).toBe('2026-10-21T18:30:00.000Z') })
  it('formats dates and IST times', () => {
    expect(formatIsoDate('2026-10-21')).toMatch(/21 Oct 2026/)
    expect(formatDateTimeIn(new Date('2026-10-21T19:00:00Z'))).toMatch(/22 Oct 2026.*12:30/i)
  })
})
