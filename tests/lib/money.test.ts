import { describe, it, expect } from 'vitest'
import { formatPaise, parseRupeesToPaise, CURRENCY } from '@/lib/money'

describe('money', () => {
  it('has INR currency', () => { expect(CURRENCY).toBe('INR') })
  it('formats paise in Indian grouping', () => {
    expect(formatPaise(123456789)).toBe('₹12,34,567.89'); expect(formatPaise(5)).toBe('₹0.05'); expect(formatPaise(0)).toBe('₹0.00')
  })
  it.each([['1234', 123400], ['1,234.5', 123450], ['₹ 1,23,456.78', 12345678], ['0', 0]])('parses %s', (s, p) => expect(parseRupeesToPaise(s)).toBe(p))
  it.each(['-1', '1.234', '', 'abc', '1e3', '   ', '99999999999999999'])('rejects %s', (s) => expect(parseRupeesToPaise(s)).toBeNull())
})
