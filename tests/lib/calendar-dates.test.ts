import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest'
import {
  addDays, addMonths, formatDateParam, getMonthGridDays, getViewRange, getWeekDays, isSameDay, istDayOfMonth, istMonthIndex,
  parseDateParam, startOfWeek,
} from '@/lib/calendar-dates'

// Wave A: calendar days are Asia/Kolkata days. A "day" Date is the instant its
// IST day starts (18:30Z the previous UTC day); nothing reads the process zone.
// Prove independence from the process zone: run as if the server were in Los Angeles.
const ORIGINAL_TZ = process.env.TZ
beforeAll(() => { process.env.TZ = 'America/Los_Angeles' })
afterAll(() => { if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ })
afterEach(() => { vi.useRealTimers() })

describe('calendar-dates (IST day boundaries)', () => {
  it('parseDateParam gives the instant the IST day starts', () => {
    expect(parseDateParam('2026-09-17').toISOString()).toBe('2026-09-16T18:30:00.000Z')
  })

  it('parseDateParam falls back to the IST today for a missing or invalid value', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-16T20:00:00Z')) // 01:30 IST on 17 Sep
    expect(formatDateParam(parseDateParam(undefined))).toBe('2026-09-17')
    expect(formatDateParam(parseDateParam('2026-02-30'))).toBe('2026-09-17')
    expect(formatDateParam(parseDateParam('nonsense'))).toBe('2026-09-17')
  })

  it('formatDateParam round-trips and uses the IST date', () => {
    expect(formatDateParam(parseDateParam('2026-09-17'))).toBe('2026-09-17')
    expect(formatDateParam(new Date('2026-09-16T19:00:00Z'))).toBe('2026-09-17')
  })

  it('startOfWeek returns the preceding (or same) Sunday', () => {
    expect(formatDateParam(startOfWeek(parseDateParam('2026-09-17')))).toBe('2026-09-13')
    expect(formatDateParam(startOfWeek(parseDateParam('2026-09-13')))).toBe('2026-09-13')
  })

  it('getWeekDays returns 7 consecutive IST days from Sunday', () => {
    const days = getWeekDays(parseDateParam('2026-09-17')).map(formatDateParam)
    expect(days).toEqual(['2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19'])
  })

  it('getMonthGridDays returns a 42-day grid starting on the Sunday on/before the 1st', () => {
    const days = getMonthGridDays(parseDateParam('2026-09-17'))
    expect(days).toHaveLength(42)
    expect(formatDateParam(days[0])).toBe('2026-08-30')
    expect(formatDateParam(days[41])).toBe('2026-10-10')
  })

  it('getViewRange("day") is the IST day [18:30Z, next 18:30Z)', () => {
    const { start, end } = getViewRange('day', parseDateParam('2026-09-17'))
    expect(start.toISOString()).toBe('2026-09-16T18:30:00.000Z')
    expect(end.toISOString()).toBe('2026-09-17T18:29:59.999Z')
  })

  it('getViewRange("week") spans Sunday 00:00 IST to Saturday 23:59:59.999 IST', () => {
    const { start, end } = getViewRange('week', parseDateParam('2026-09-17'))
    expect(start.toISOString()).toBe('2026-09-12T18:30:00.000Z')
    expect(end.toISOString()).toBe('2026-09-19T18:29:59.999Z')
  })

  it('groups an appointment by its IST day, not its UTC day', () => {
    const day = parseDateParam('2026-09-17')
    expect(isSameDay(new Date('2026-09-16T19:00:00Z'), day)).toBe(true) // 00:30 IST 17 Sep
    expect(isSameDay(new Date('2026-09-17T18:45:00Z'), day)).toBe(false) // 00:15 IST 18 Sep
  })

  it('exposes IST day-of-month / month and adds months on IST dates', () => {
    const d = parseDateParam('2026-01-31')
    expect(istDayOfMonth(d)).toBe(31)
    expect(istMonthIndex(d)).toBe(0)
    expect(formatDateParam(addMonths(d, 1))).toBe('2026-02-01')
    expect(formatDateParam(addMonths(parseDateParam('2026-01-15'), -1))).toBe('2025-12-01')
    expect(formatDateParam(addDays(d, 1))).toBe('2026-02-01')
  })
})
