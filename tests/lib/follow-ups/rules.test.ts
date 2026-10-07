import { describe, it, expect } from 'vitest'
import {
  addMonthsIso, addDaysIso, resolveFollowUpDates, dueDateProblem, deriveFollowUpStatus, recallBucket,
  followUpVisitReason, istSlotString, isOpenFollowUp, FOLLOW_UP_STATUS_LABEL, PORTAL_FOLLOW_UP_LABEL,
} from '@/lib/follow-ups/rules'
import { VISIT_REASON_MAX_LENGTH } from '@/lib/notification-templates'

describe('follow-up rules', () => {
  it('addDaysIso crosses month and year ends', () => {
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01'); expect(addDaysIso('2026-03-01', -1)).toBe('2026-02-28')
  })
  it('addMonthsIso clamps to month end', () => {
    expect(addMonthsIso('2026-01-31', 1)).toBe('2026-02-28'); expect(addMonthsIso('2028-01-31', 1)).toBe('2028-02-29')
    expect(addMonthsIso('2026-12-15', 2)).toBe('2027-02-15')
  })
  it('resolves an interval due date and default window', () => {
    expect(resolveFollowUpDates({ kind: 'interval', interval: { value: 2, unit: 'weeks' } }, '2026-10-07'))
      .toEqual({ dueDate: '2026-10-21', windowStart: '2026-10-18', windowEnd: '2026-10-28', interval: { value: 2, unit: 'weeks' } })
  })
  it('resolves days and months intervals', () => {
    expect(resolveFollowUpDates({ kind: 'interval', interval: { value: 10, unit: 'days' } }, '2026-10-07').dueDate).toBe('2026-10-17')
    expect(resolveFollowUpDates({ kind: 'interval', interval: { value: 1, unit: 'months' } }, '2026-01-31').dueDate).toBe('2026-02-28')
  })
  it('window crosses the year boundary', () => {
    const r = resolveFollowUpDates({ kind: 'date', dueDate: '2027-01-02' }, '2026-12-01', 5, 3)
    expect(r).toMatchObject({ windowStart: '2026-12-28', windowEnd: '2027-01-05', interval: null })
  })
  it('dueDateProblem rejects past and >2y dates', () => {
    expect(dueDateProblem('2026-10-06', '2026-10-07')).toMatch(/past/); expect(dueDateProblem('2026-10-07', '2026-10-07')).toBeNull()
    expect(dueDateProblem('2028-10-08', '2026-10-07')).toMatch(/2 years/)
    expect(dueDateProblem('2028-10-06', '2026-10-07')).toBeNull()
  })
  const base = { status: 'scheduled' as const, windowEnd: '2026-10-28' }
  it('scheduled with a cancelled appointment derives planned', () => {
    expect(deriveFollowUpStatus({ ...base, appointment: { status: 'cancelled', startsAt: new Date('2026-10-21T04:00:00Z') } }, '2026-10-22')).toBe('planned')
  })
  it('no_show derives missed; completed appointment derives completed', () => {
    expect(deriveFollowUpStatus({ ...base, appointment: { status: 'no_show', startsAt: new Date('2026-10-21T04:00:00Z') } }, '2026-10-21')).toBe('missed')
    expect(deriveFollowUpStatus({ ...base, appointment: { status: 'completed', startsAt: new Date('2026-10-21T04:00:00Z') } }, '2026-10-21')).toBe('completed')
  })
  it('planned turns missed only after window end + 14 days', () => {
    const p = { status: 'planned' as const, windowEnd: '2026-10-28', appointment: null }
    expect(deriveFollowUpStatus(p, '2026-11-11')).toBe('planned'); expect(deriveFollowUpStatus(p, '2026-11-12')).toBe('missed')
  })
  it('a stale scheduled appointment turns missed after max(apptDay, windowEnd) + grace', () => {
    const s = { ...base, appointment: { status: 'scheduled' as const, startsAt: new Date('2026-11-05T04:00:00Z') } }
    expect(deriveFollowUpStatus(s, '2026-11-19')).toBe('scheduled'); expect(deriveFollowUpStatus(s, '2026-11-20')).toBe('missed')
  })
  it('uses the IST day of the appointment (19:00Z is the next IST day)', () => {
    const s = { ...base, appointment: { status: 'scheduled' as const, startsAt: new Date('2026-11-04T19:00:00Z') } }
    expect(deriveFollowUpStatus(s, '2026-11-19')).toBe('scheduled'); expect(deriveFollowUpStatus(s, '2026-11-20')).toBe('missed')
  })
  it('stored cancelled/completed/missed win over the appointment', () => {
    expect(deriveFollowUpStatus({ status: 'cancelled', windowEnd: '2026-10-28', appointment: { status: 'completed', startsAt: new Date() } }, '2026-10-21')).toBe('cancelled')
    expect(deriveFollowUpStatus({ status: 'completed', windowEnd: '2026-10-28', appointment: null }, '2026-10-21')).toBe('completed')
    expect(deriveFollowUpStatus({ status: 'missed', windowEnd: '2026-10-28', appointment: null }, '2026-10-21')).toBe('missed')
  })
  it.each([['2026-10-17', 'upcoming'], ['2026-10-18', 'due'], ['2026-10-28', 'due'], ['2026-10-29', 'overdue']])('recallBucket planned on %s is %s', (today, b) => {
    expect(recallBucket('planned', '2026-10-18', '2026-10-28', today)).toBe(b)
  })
  it('recallBucket maps other statuses', () => {
    expect(recallBucket('completed', 'a', 'b', 'c')).toBe('closed'); expect(recallBucket('cancelled', 'a', 'b', 'c')).toBe('closed')
    expect(recallBucket('missed', 'a', 'b', 'c')).toBe('missed'); expect(recallBucket('scheduled', 'a', 'b', 'c')).toBe('scheduled')
  })
  it('isOpenFollowUp and labels', () => {
    expect(isOpenFollowUp('planned')).toBe(true); expect(isOpenFollowUp('scheduled')).toBe(true); expect(isOpenFollowUp('missed')).toBe(true)
    expect(isOpenFollowUp('completed')).toBe(false); expect(isOpenFollowUp('cancelled')).toBe(false)
    expect(FOLLOW_UP_STATUS_LABEL.planned).toBe('Not booked'); expect(PORTAL_FOLLOW_UP_LABEL.missed).toBe('Missed, please contact us')
  })
  it('followUpVisitReason caps at the visit-reason limit', () => { expect(followUpVisitReason('x'.repeat(300)).length).toBeLessThanOrEqual(VISIT_REASON_MAX_LENGTH) })
  it('followUpVisitReason prefixes', () => { expect(followUpVisitReason('BP review')).toBe('Follow-up: BP review') })
  it('istSlotString carries +05:30', () => { expect(istSlotString('2026-10-21', '09:30')).toBe('2026-10-21T09:30:00+05:30') })
})

import { daysBetweenIso as sharedDaysBetween } from '@/lib/follow-ups/rules'
describe('daysBetweenIso (M3: the one shared calendar-day difference)', () => {
  it('counts whole calendar days, across month and year ends, either direction', () => {
    expect(sharedDaysBetween('2026-01-31', '2026-03-01')).toBe(29)
    expect(sharedDaysBetween('2026-12-30', '2027-01-02')).toBe(3)
    expect(sharedDaysBetween('2026-10-21', '2026-10-18')).toBe(-3)
    expect(sharedDaysBetween('2026-10-21', '2026-10-21')).toBe(0)
  })
})
