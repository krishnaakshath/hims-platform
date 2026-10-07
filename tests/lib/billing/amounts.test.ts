import { describe, expect, it } from 'vitest'
import { INT4_MAX, MAX_DOCUMENT_PAISE, MAX_LINE_QUANTITY, lineTaxablePaise, paiseFromDb, sumPaise } from '@/lib/billing/amounts'

describe('billing amounts', () => {
  it('exposes the limits', () => {
    expect(MAX_LINE_QUANTITY).toBe(1000)
    expect(MAX_DOCUMENT_PAISE).toBe(1_000_000_000_000)
    expect(INT4_MAX).toBe(2_147_483_647)
  })
  it('line of ₹1 crore × 3 is exact', () => { expect(lineTaxablePaise(1_000_000_000, 3)).toBe(3_000_000_000) })
  it('crosses 2^31 exactly on a single line', () => { expect(lineTaxablePaise(1_073_741_824, 2)).toBe(2_147_483_648) })
  it('refuses zero, fractional, negative and over-limit quantities', () => {
    for (const q of [0, 1.5, -1, 1001, NaN]) expect(() => lineTaxablePaise(100, q)).toThrow(RangeError)
  })
  it('refuses a bad unit price', () => {
    for (const p of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) expect(() => lineTaxablePaise(p, 1)).toThrow(RangeError)
    expect(lineTaxablePaise(0, 1)).toBe(0)
  })
  it('refuses a product beyond the safe integer range', () => {
    expect(() => lineTaxablePaise(Number.MAX_SAFE_INTEGER, 2)).toThrow(RangeError)
  })
  it('sums across 2^31 exactly and refuses past MAX_SAFE_INTEGER', () => {
    expect(sumPaise([2_147_483_647, 1])).toBe(2_147_483_648)
    expect(sumPaise([])).toBe(0)
    expect(() => sumPaise([Number.MAX_SAFE_INTEGER, 1])).toThrow(RangeError)
  })
  it('sum refuses non-integers', () => { expect(() => sumPaise([1.5])).toThrow(RangeError) })
  it('sum allows negatives that net down', () => { expect(sumPaise([5, -7])).toBe(-2) })
  it('paiseFromDb reads node-postgres numeric strings', () => {
    expect(paiseFromDb('3000000000')).toBe(3_000_000_000); expect(paiseFromDb(null)).toBe(0)
    expect(paiseFromDb(42)).toBe(42); expect(paiseFromDb(BigInt(7))).toBe(7); expect(paiseFromDb('-15')).toBe(-15)
    expect(() => paiseFromDb('12.50')).toThrow(RangeError); expect(() => paiseFromDb('99999999999999999')).toThrow(RangeError)
    expect(() => paiseFromDb('abc')).toThrow(RangeError); expect(() => paiseFromDb(1.5)).toThrow(RangeError)
    expect(() => paiseFromDb(BigInt('99999999999999999'))).toThrow(RangeError)
  })
})
