import { describe, it, expect } from 'vitest'
import { addDays, formatDateParam, getMonthGridDays, getViewRange, getWeekDays, isSameDay, parseDateParam, startOfWeek } from '@/lib/calendar-dates'

describe('calendar-dates', () => {
  it('parseDateParam parses a YYYY-MM-DD string as local midnight', () => {
    const d = parseDateParam('2026-09-17')
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(8) // 0-indexed: September
    expect(d.getDate()).toBe(17)
    expect(d.getHours()).toBe(0)
  })

  it('parseDateParam falls back to today for an invalid or missing value', () => {
    const d = parseDateParam(undefined)
    expect(isSameDay(d, new Date())).toBe(true)
  })

  it('formatDateParam round-trips with parseDateParam', () => {
    const original = parseDateParam('2026-09-17')
    expect(formatDateParam(original)).toBe('2026-09-17')
  })

  it('startOfWeek returns the preceding (or same) Sunday', () => {
    const thursday = parseDateParam('2026-09-17') // a Thursday
    const sunday = startOfWeek(thursday)
    expect(sunday.getDay()).toBe(0)
    expect(formatDateParam(sunday)).toBe('2026-09-13')
  })

  it('getWeekDays returns exactly 7 consecutive days starting on Sunday', () => {
    const days = getWeekDays(parseDateParam('2026-09-17'))
    expect(days.length).toBe(7)
    expect(days[0].getDay()).toBe(0)
    expect(formatDateParam(days[6])).toBe(formatDateParam(addDays(days[0], 6)))
  })

  it('getMonthGridDays returns a fixed 42-day grid starting on a Sunday', () => {
    const days = getMonthGridDays(parseDateParam('2026-09-17'))
    expect(days.length).toBe(42)
    expect(days[0].getDay()).toBe(0)
  })

  it('getViewRange for "day" spans exactly one calendar day', () => {
    const { start, end } = getViewRange('day', parseDateParam('2026-09-17'))
    expect(isSameDay(start, end)).toBe(true)
    expect(start.getHours()).toBe(0)
    expect(end.getHours()).toBe(23)
  })

  it('getViewRange for "week" spans Sunday through Saturday', () => {
    const { start, end } = getViewRange('week', parseDateParam('2026-09-17'))
    expect(start.getDay()).toBe(0)
    expect(end.getDay()).toBe(6)
  })
})
