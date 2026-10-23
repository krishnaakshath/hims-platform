import { describe, it, expect } from 'vitest'
import { pickFefo, isExpired, expiresWithinDays, expiryMonth, expiryMonthLabel, type BatchStock } from '@/lib/pharmacy/fefo'

const TODAY = '2026-10-23'

function batch(id: number, expiryDate: string | null, quantityOnHand: number, extra: Partial<BatchStock> = {}): BatchStock {
  return { id, batchNo: `B${id}`, expiryDate, quantityOnHand, mrpPerUnitPaise: 1000, writtenOff: false, ...extra }
}

describe('pickFefo', () => {
  it('takes 10 from the batch expiring 2026-11-01 before the one expiring 2027-01-01', () => {
    const r = pickFefo([batch(1, '2027-01-01', 50), batch(2, '2026-11-01', 50)], 10, TODAY)
    expect(r).toEqual({ ok: true, allocations: [{ batchId: 2, quantity: 10 }] })
  })

  it('spans two batches when the first is short', () => {
    const r = pickFefo([batch(1, '2027-01-01', 50), batch(2, '2026-11-01', 4)], 10, TODAY)
    expect(r).toEqual({ ok: true, allocations: [{ batchId: 2, quantity: 4 }, { batchId: 1, quantity: 6 }] })
  })

  it('never picks a batch expiring before today', () => {
    const r = pickFefo([batch(1, '2026-10-22', 100), batch(2, '2027-01-01', 20)], 10, TODAY)
    expect(r).toEqual({ ok: true, allocations: [{ batchId: 2, quantity: 10 }] })
  })

  it('a batch expiring today is still usable', () => {
    const r = pickFefo([batch(1, TODAY, 10)], 10, TODAY)
    expect(r).toEqual({ ok: true, allocations: [{ batchId: 1, quantity: 10 }] })
  })

  it('skips written-off batches', () => {
    const r = pickFefo([batch(1, '2026-11-01', 100, { writtenOff: true }), batch(2, '2027-01-01', 20)], 10, TODAY)
    expect(r).toEqual({ ok: true, allocations: [{ batchId: 2, quantity: 10 }] })
  })

  it('only_expired_stock when only expired stock would cover the quantity', () => {
    const r = pickFefo([batch(1, '2026-10-01', 100), batch(2, '2027-01-01', 5)], 10, TODAY)
    expect(r).toEqual({ ok: false, error: 'only_expired_stock' })
  })

  it('insufficient_stock otherwise', () => {
    expect(pickFefo([batch(1, '2026-10-01', 3), batch(2, '2027-01-01', 5)], 10, TODAY)).toEqual({ ok: false, error: 'insufficient_stock' })
    expect(pickFefo([], 1, TODAY)).toEqual({ ok: false, error: 'insufficient_stock' })
  })

  it('uses the null-expiry batch last', () => {
    const r = pickFefo([batch(1, null, 100), batch(2, '2027-06-01', 5), batch(3, '2027-01-01', 3)], 10, TODAY)
    expect(r).toEqual({ ok: true, allocations: [{ batchId: 3, quantity: 3 }, { batchId: 2, quantity: 5 }, { batchId: 1, quantity: 2 }] })
  })

  it('breaks an expiry tie by the lower id', () => {
    const r = pickFefo([batch(9, '2027-01-01', 5), batch(4, '2027-01-01', 5)], 7, TODAY)
    expect(r).toEqual({ ok: true, allocations: [{ batchId: 4, quantity: 5 }, { batchId: 9, quantity: 2 }] })
  })

  it('skips empty batches', () => {
    const r = pickFefo([batch(1, '2026-11-01', 0), batch(2, '2027-01-01', 10)], 10, TODAY)
    expect(r).toEqual({ ok: true, allocations: [{ batchId: 2, quantity: 10 }] })
  })
})

describe('expiry helpers', () => {
  it('isExpired: strictly before today', () => {
    expect(isExpired({ expiryDate: '2026-10-22' }, TODAY)).toBe(true)
    expect(isExpired({ expiryDate: TODAY }, TODAY)).toBe(false)
    expect(isExpired({ expiryDate: null }, TODAY)).toBe(false)
  })

  it('expiresWithinDays: not yet expired and on or before today + days', () => {
    expect(expiresWithinDays({ expiryDate: '2026-11-22' }, TODAY, 30)).toBe(true)
    expect(expiresWithinDays({ expiryDate: '2026-11-23' }, TODAY, 30)).toBe(false)
    expect(expiresWithinDays({ expiryDate: '2026-10-22' }, TODAY, 30)).toBe(false)
    expect(expiresWithinDays({ expiryDate: null }, TODAY, 30)).toBe(false)
  })

  it("expiryMonth('2026-11-30') is '2026-11'", () => {
    expect(expiryMonth('2026-11-30')).toBe('2026-11')
    expect(expiryMonth(null)).toBeNull()
  })
})

// WS5 T5
describe('pickFefo quantity guard and expiryMonthLabel', () => {
  it('throws on a zero, negative or fractional quantity', () => {
    for (const q of [0, -1, 1.5]) expect(() => pickFefo([batch(1, null, 10)], q, TODAY)).toThrow(RangeError)
  })

  it('labels an expiry as Mon YYYY, or no expiry', () => {
    expect(expiryMonthLabel('2030-12-31')).toBe('Dec 2030')
    expect(expiryMonthLabel('2027-01-01')).toBe('Jan 2027')
    expect(expiryMonthLabel(null)).toBe('no expiry')
  })
})
