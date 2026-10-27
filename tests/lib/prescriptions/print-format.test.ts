import { describe, it, expect } from 'vitest'
import { formatDoseLine } from '@/lib/prescriptions/print-format'

const base = { dosePattern: null, isSos: false, frequencyPerDay: null, durationDays: null, foodTiming: null }
describe('formatDoseLine', () => {
  it('pattern with slot names, days and food', () => {
    expect(formatDoseLine({ ...base, dosePattern: '1-0-1', durationDays: 5, foodTiming: 'after_food' })).toBe('1-0-1 (morning, night) × 5 days, after food')
  })
  it('four slots name the evening', () => {
    expect(formatDoseLine({ ...base, dosePattern: '1-1-1-1', durationDays: 1 })).toBe('1-1-1-1 (morning, afternoon, evening, night) × 1 day')
  })
  it('SOS and legacy rows', () => {
    expect(formatDoseLine({ ...base, isSos: true, durationDays: 3 })).toBe('SOS (when needed) × 3 days')
    expect(formatDoseLine({ ...base, frequencyPerDay: 2, durationDays: 10 })).toBe('2 times daily × 10 days')
    expect(formatDoseLine({ ...base, foodTiming: 'any' })).toBe('')
  })
})
