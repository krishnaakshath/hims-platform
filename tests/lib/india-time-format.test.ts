// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  formatIstDate, formatIstDateTime, formatIstTime, formatIstLongDate, formatIstMonthYear, formatIstWeekdayDay,
  istSlotString, istLocalToOffsetString, parseIstLocalDateTime, hasExplicitUtcOffset, istDateOf, IST_OFFSET,
} from '@/lib/india-time'

// Prove independence from the process zone: run as if the server were in Los Angeles.
const ORIGINAL_TZ = process.env.TZ
beforeAll(() => { process.env.TZ = 'America/Los_Angeles' })
afterAll(() => { if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ })

// 2026-10-08T03:30:00Z = 09:00 IST on Thu 8 Oct 2026.
const NINE_IST = new Date('2026-10-08T03:30:00Z')

describe('IST display formatters (pure, deterministic)', () => {
  it('formats a calendar date in IST', () => {
    expect(formatIstDate(NINE_IST)).toBe('8 Oct 2026')
    // 20:00Z on 7 Oct is already 8 Oct in IST.
    expect(formatIstDate(new Date('2026-10-07T20:00:00Z'))).toBe('8 Oct 2026')
    expect(formatIstDate('2026-10-07T20:00:00.000Z')).toBe('8 Oct 2026')
  })
  it('formats times as 12-hour IST', () => {
    expect(formatIstTime(NINE_IST)).toBe('9:00 am')
    expect(formatIstTime(new Date('2026-10-07T18:30:00Z'))).toBe('12:00 am')
    expect(formatIstTime(new Date('2026-10-08T06:45:00Z'))).toBe('12:15 pm')
    expect(formatIstTime(NINE_IST, { label: true })).toBe('9:00 am IST')
  })
  it('formats date-times', () => {
    expect(formatIstDateTime(NINE_IST)).toBe('8 Oct 2026, 9:00 am')
    expect(formatIstDateTime(NINE_IST, { label: true })).toBe('8 Oct 2026, 9:00 am IST')
  })
  it('long, month and weekday forms', () => {
    expect(formatIstLongDate(NINE_IST)).toBe('Thursday, 8 October 2026')
    expect(formatIstMonthYear(NINE_IST)).toBe('October 2026')
    expect(formatIstWeekdayDay(NINE_IST)).toBe('Thu 8')
  })
  it('renders an em dash for missing or invalid input', () => {
    expect(formatIstDate(null)).toBe('—')
    expect(formatIstDateTime(undefined)).toBe('—')
    expect(formatIstTime('not a date')).toBe('—')
  })
  it('agrees with istDateOf near IST midnight', () => {
    const justAfter = new Date('2026-10-07T18:31:00Z')
    expect(istDateOf(justAfter)).toBe('2026-10-08')
    expect(formatIstDate(justAfter)).toBe('8 Oct 2026')
  })
})

describe('IST input parsing', () => {
  it('builds an explicit +05:30 slot string', () => {
    expect(IST_OFFSET).toBe('+05:30')
    expect(istSlotString('2026-10-08', '09:00')).toBe('2026-10-08T09:00:00+05:30')
  })
  it('turns a datetime-local value into an offset string and an instant', () => {
    expect(istLocalToOffsetString('2026-10-08T09:00')).toBe('2026-10-08T09:00:00+05:30')
    expect(istLocalToOffsetString('2026-10-08T09:00:30')).toBe('2026-10-08T09:00:30+05:30')
    expect(parseIstLocalDateTime('2026-10-08T09:00')!.toISOString()).toBe('2026-10-08T03:30:00.000Z')
  })
  it('rejects malformed or impossible datetime-local values', () => {
    expect(parseIstLocalDateTime('')).toBeNull()
    expect(parseIstLocalDateTime('2026-02-30T09:00')).toBeNull()
    expect(parseIstLocalDateTime('2026-10-08T25:00')).toBeNull()
    expect(istLocalToOffsetString('2026-10-08T09:00Z')).toBeNull()
  })
  it('detects an explicit UTC offset', () => {
    expect(hasExplicitUtcOffset('2026-10-08T09:00:00+05:30')).toBe(true)
    expect(hasExplicitUtcOffset('2026-10-08T03:30:00.000Z')).toBe(true)
    expect(hasExplicitUtcOffset('2026-10-08T09:00:00')).toBe(false)
    expect(hasExplicitUtcOffset('2026-10-08')).toBe(false)
  })
})
