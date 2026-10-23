// WS1 T6: the Indian dose pattern ("1-0-1") and the prescribed quantity it implies.
import { describe, it, expect } from 'vitest'
import { parseDosePattern, prescribedQuantity } from '@/lib/prescriptions/dose-pattern'

describe('parseDosePattern', () => {
  it("'1-0-1' is twice a day (morning, night)", () => {
    expect(parseDosePattern('1-0-1')).toEqual({ slots: [1, 0, 1], perDay: 2, label: '1-0-1' })
  })

  it("'1-1-1-1' is four times a day", () => {
    expect(parseDosePattern('1-1-1-1')).toMatchObject({ slots: [1, 1, 1, 1], perDay: 4 })
  })

  it("'½-0-½' and '0.5-0-0.5' are half a tablet twice a day, labelled with ½", () => {
    expect(parseDosePattern('½-0-½')).toEqual({ slots: [0.5, 0, 0.5], perDay: 2, label: '½-0-½' })
    expect(parseDosePattern('0.5-0-0.5')).toEqual({ slots: [0.5, 0, 0.5], perDay: 2, label: '½-0-½' })
  })

  it("'2-0-2' counts slots, not tablets, for perDay", () => {
    expect(parseDosePattern('2-0-2')).toMatchObject({ slots: [2, 0, 2], perDay: 2 })
  })

  it('tolerates surrounding and inner whitespace', () => {
    expect(parseDosePattern(' 1 - 0 - 1 ')).toMatchObject({ slots: [1, 0, 1], label: '1-0-1' })
  })

  it.each(['1-0', '3-0-1', '', '1-0-1-1-1', 'a-b-c', '0-0-0', '1--1', '1-0-1-', '-1-0-1', '1.5-0-1'])('rejects %j', (raw) => {
    expect(parseDosePattern(raw)).toBeNull()
  })
})

describe('prescribedQuantity', () => {
  const base = { pattern: null, frequencyPerDay: null, durationDays: 5, form: 'tablet' as const, isSos: false }

  it("'1-0-1' for 5 days of tablets is 10", () => {
    expect(prescribedQuantity({ ...base, pattern: parseDosePattern('1-0-1') })).toBe(10)
  })

  it("'½-0-½' for 5 days is 5", () => {
    expect(prescribedQuantity({ ...base, pattern: parseDosePattern('½-0-½') })).toBe(5)
  })

  it('rounds a fractional total up', () => {
    expect(prescribedQuantity({ ...base, pattern: parseDosePattern('½-0-0'), durationDays: 3 })).toBe(2)
  })

  it('uses tablets per slot (2-0-2 for 3 days of capsules is 12)', () => {
    expect(prescribedQuantity({ ...base, form: 'capsule', pattern: parseDosePattern('2-0-2'), durationDays: 3 })).toBe(12)
  })

  it('without a pattern, frequencyPerDay × days', () => {
    expect(prescribedQuantity({ ...base, frequencyPerDay: 3, durationDays: 7 })).toBe(21)
  })

  it('with neither pattern nor frequency it is null', () => {
    expect(prescribedQuantity(base)).toBeNull()
  })

  it.each(['liquid', 'injection', 'other'] as const)('%s is null (not a countable unit)', (form) => {
    expect(prescribedQuantity({ ...base, form, pattern: parseDosePattern('1-0-1') })).toBeNull()
  })

  it('SOS is null even for tablets', () => {
    expect(prescribedQuantity({ ...base, isSos: true, frequencyPerDay: 3 })).toBeNull()
  })
})
