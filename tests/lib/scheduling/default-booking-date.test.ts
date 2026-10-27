import { describe, it, expect } from 'vitest'
import { defaultBookingDate } from '@/lib/scheduling/default-booking-date'

describe('defaultBookingDate', () => {
  it('is today when the whole requested range is past', () => {
    expect(defaultBookingDate('2026-10-20', '2026-10-22', '2026-10-23')).toBe('2026-10-23')
  })

  it('is today when the range started earlier but runs on', () => {
    expect(defaultBookingDate('2026-10-20', '2026-10-27', '2026-10-23')).toBe('2026-10-23')
  })

  it('is the range start when it is today or later', () => {
    expect(defaultBookingDate('2026-10-25', '2026-10-27', '2026-10-23')).toBe('2026-10-25')
    expect(defaultBookingDate('2026-10-23', '2026-10-27', '2026-10-23')).toBe('2026-10-23')
  })
})
