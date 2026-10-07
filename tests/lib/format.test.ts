// @vitest-environment node
import { describe, it, expect } from 'vitest'
import * as format from '@/lib/format'
import { formatPaise, formatRupeesWhole } from '@/lib/format'

// Wave A: one money path. Every legacy *Cents column is integer minor units of
// the hospital's only currency (INR), i.e. paise -- displayed as ₹ with Indian
// grouping, never as US dollars.
describe('lib/format money (INR)', () => {
  it('formats integer paise as ₹ with en-IN lakh/crore grouping', () => {
    expect(formatPaise(17500)).toBe('₹175.00')
    expect(formatPaise(123456789)).toBe('₹12,34,567.89')
    expect(formatPaise(1234567890123)).toBe('₹12,34,56,78,901.23')
    expect(formatPaise(0)).toBe('₹0.00')
    expect(formatPaise(5)).toBe('₹0.05')
    expect(formatPaise(99999)).toBe('₹999.99')
    expect(formatPaise(100000)).toBe('₹1,000.00')
  })
  it('formats negatives with a leading minus', () => {
    expect(formatPaise(-123456)).toBe('-₹1,234.56')
  })
  it('rounds a non-integer paise value instead of printing fractions of a paisa', () => {
    expect(formatPaise(1234.6)).toBe('₹12.35')
  })
  it('formats whole rupees for chart axes/tooltips', () => {
    expect(formatRupeesWhole(0)).toBe('₹0')
    expect(formatRupeesWhole(123456)).toBe('₹1,23,456')
    expect(formatRupeesWhole(-1500)).toBe('-₹1,500')
  })
  it('no longer exports the US-dollar formatCents', () => {
    expect('formatCents' in format).toBe(false)
  })
})
