import { describe, it, expect } from 'vitest'
import {
  bookFollowUpSchema, createFollowUpSchema, updateFollowUpPlanSchema, reasonOnlySchema, contactAttemptSchema,
  isoDateSchema, offsetDateTimeSchema, followUpIntervalSchema, followUpPlanFieldsSchema,
} from '@/lib/follow-ups/validation'

describe('follow-up validation', () => {
  it('bookFollowUpSchema requires an explicit offset', () => {
    expect(bookFollowUpSchema.safeParse({ providerId: 1, startsAt: '2026-10-21T09:30:00', endsAt: '2026-10-21T09:45:00' }).success).toBe(false)
    expect(bookFollowUpSchema.safeParse({ providerId: 1, startsAt: '2026-10-21T09:30:00+05:30', endsAt: '2026-10-21T09:45:00+05:30' }).success).toBe(true)
    expect(bookFollowUpSchema.safeParse({ providerId: 1, startsAt: '2026-10-21T09:30:00+05:30', endsAt: '2026-10-21T09:30:00+05:30' }).success).toBe(false)
  })
  it('bookFollowUpSchema caps duration at 240 minutes', () => {
    expect(bookFollowUpSchema.safeParse({ providerId: 1, startsAt: '2026-10-21T09:00:00+05:30', endsAt: '2026-10-21T13:00:00+05:30' }).success).toBe(true)
    expect(bookFollowUpSchema.safeParse({ providerId: 1, startsAt: '2026-10-21T09:00:00+05:30', endsAt: '2026-10-21T13:01:00+05:30' }).success).toBe(false)
  })
  it('isoDateSchema and offsetDateTimeSchema', () => {
    expect(isoDateSchema.safeParse('2026-02-30').success).toBe(false); expect(isoDateSchema.safeParse('2026-02-28').success).toBe(true)
    expect(offsetDateTimeSchema.safeParse('2026-10-21T09:30Z').success).toBe(true); expect(offsetDateTimeSchema.safeParse('2026-13-21T09:30:00Z').success).toBe(false)
  })
  it('interval total days at most 731', () => {
    expect(followUpIntervalSchema.safeParse({ value: 24, unit: 'months' }).success).toBe(true)
    expect(followUpIntervalSchema.safeParse({ value: 30, unit: 'months' }).success).toBe(false)
    expect(followUpIntervalSchema.safeParse({ value: 0, unit: 'days' }).success).toBe(false)
    expect(followUpIntervalSchema.safeParse({ value: 2, unit: 'weeks', x: 1 }).success).toBe(false)
  })
  it('createFollowUpSchema is strict and validates timing', () => {
    const ok = { patientId: 'RD-0001', timing: { kind: 'interval', interval: { value: 2, unit: 'weeks' } }, reason: 'BP review' }
    expect(createFollowUpSchema.safeParse(ok).success).toBe(true)
    expect(createFollowUpSchema.safeParse({ ...ok, status: 'completed' }).success).toBe(false)
    expect(createFollowUpSchema.safeParse({ ...ok, timing: { kind: 'date', dueDate: '2026-02-30' } }).success).toBe(false)
    expect(createFollowUpSchema.safeParse({ ...ok, timing: { kind: 'interval', interval: { value: 30, unit: 'months' } } }).success).toBe(false)
    expect(createFollowUpSchema.safeParse({ ...ok, timing: { kind: 'date', dueDate: '2026-12-01', interval: {} } }).success).toBe(false)
    expect(createFollowUpSchema.safeParse({ ...ok, patientId: '' }).success).toBe(false)
    expect(createFollowUpSchema.safeParse({ ...ok, windowDaysBefore: 31 }).success).toBe(false)
    expect(createFollowUpSchema.safeParse({ ...ok, windowDaysAfter: 60, departmentId: 2, prescribedByProviderId: 3, originatingEncounterId: 4 }).success).toBe(true)
  })
  it('plan fields schema is strict', () => {
    expect(followUpPlanFieldsSchema.safeParse({ timing: { kind: 'date', dueDate: '2026-12-01' }, reason: 'x', planNotes: 'n' }).success).toBe(true)
    expect(followUpPlanFieldsSchema.safeParse({ timing: { kind: 'date', dueDate: '2026-12-01' }, reason: 'x', patientId: 'p' }).success).toBe(false)
  })
  it('updateFollowUpPlanSchema rejects an empty patch and unknown keys', () => {
    expect(updateFollowUpPlanSchema.safeParse({}).success).toBe(false)
    expect(updateFollowUpPlanSchema.safeParse({ appointmentId: 4 }).success).toBe(false)
    expect(updateFollowUpPlanSchema.safeParse({ planNotes: null }).success).toBe(true)
    expect(updateFollowUpPlanSchema.safeParse({ departmentId: null }).success).toBe(true)
    expect(updateFollowUpPlanSchema.safeParse({ prescribedByProviderId: null }).success).toBe(false)
  })
  it('reasonOnlySchema and contactAttemptSchema', () => {
    expect(reasonOnlySchema.safeParse({ reason: ' ' }).success).toBe(false); expect(reasonOnlySchema.safeParse({ reason: 'moved' }).success).toBe(true)
    expect(contactAttemptSchema.safeParse({ channel: 'phone', outcome: 'no_answer' }).success).toBe(true)
    expect(contactAttemptSchema.safeParse({ channel: 'fax', outcome: 'no_answer' }).success).toBe(false)
    expect(contactAttemptSchema.safeParse({ channel: 'phone', outcome: 'no_answer', note: 'x'.repeat(501) }).success).toBe(false)
  })
})
