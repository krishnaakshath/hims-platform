import { describe, it, expect } from 'vitest'
import {
  HOME_COLLECTION_STATUSES, RESCHEDULE_REASONS, VISIT_CANCEL_REASONS, COLLECTOR_CANCEL_REASONS, RESCHEDULE_REASON_LABEL,
  VISIT_CANCEL_REASON_LABEL, MAX_BOOKING_DAYS_AHEAD, MIN_BOOKING_LEAD_MINUTES, HHMM_PATTERN, bookingDateProblem, windowClosed,
  windowsOverlap,
} from '@/lib/home-collection/rules'

describe('home-collection rules', () => {
  it('declares the constants', () => {
    expect(HOME_COLLECTION_STATUSES).toEqual(['booked', 'collected', 'cancelled'])
    expect(MAX_BOOKING_DAYS_AHEAD).toBe(30)
    expect(MIN_BOOKING_LEAD_MINUTES).toBe(60)
    expect(Object.keys(RESCHEDULE_REASON_LABEL).sort()).toEqual([...RESCHEDULE_REASONS].sort())
    expect(Object.keys(VISIT_CANCEL_REASON_LABEL).sort()).toEqual([...VISIT_CANCEL_REASONS].sort())
    for (const r of COLLECTOR_CANCEL_REASONS) expect(VISIT_CANCEL_REASONS).toContain(r)
    expect(HHMM_PATTERN.test('07:00')).toBe(true)
    expect(HHMM_PATTERN.test('24:00')).toBe(false)
    expect(HHMM_PATTERN.test('7:00')).toBe(false)
  })

  it('bookingDateProblem rejects past and >30 days', () => {
    expect(bookingDateProblem('2099-01-09', '2099-01-10')).toMatch(/today or a later/)
    expect(bookingDateProblem('2099-02-10', '2099-01-10')).toMatch(/30 days/)
    expect(bookingDateProblem('2099-02-09', '2099-01-10')).toBeNull()
    expect(bookingDateProblem('2099-01-10', '2099-01-10')).toBeNull()
  })

  it('windowClosed uses IST and a 60-minute lead', () => {
    // 07:00 IST on 2099-01-10 is 01:30Z
    expect(windowClosed('2099-01-10', '07:00', new Date('2099-01-10T00:29:00Z'))).toBe(false)
    expect(windowClosed('2099-01-10', '07:00', new Date('2099-01-10T00:31:00Z'))).toBe(true)
    expect(windowClosed('2099-01-10', '07:00', new Date('2099-01-10T00:30:00Z'))).toBe(false)
  })

  it('windowsOverlap is touch-exclusive', () => {
    expect(windowsOverlap({ startTime: '07:00', endTime: '09:00' }, { startTime: '09:00', endTime: '11:00' })).toBe(false)
    expect(windowsOverlap({ startTime: '07:00', endTime: '09:30' }, { startTime: '09:00', endTime: '11:00' })).toBe(true)
    expect(windowsOverlap({ startTime: '09:00', endTime: '11:00' }, { startTime: '07:00', endTime: '09:30' })).toBe(true)
  })
})
