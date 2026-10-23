// WS2 T8 (spec ruling 7): the pharmacy line price is the taxable value backed out of a GST-inclusive
// MRP. Selling above MRP is unlawful, so taxable + GST never exceeds MRP × quantity under either
// supply type, and the unit price is the largest whole-paise value that keeps it so.
import { describe, it, expect } from 'vitest'
import { lineTax } from '@/lib/billing/gst'
import { expiryLabel, isExpiredMonth, medicationPriceSchema, pharmacyLinePrice } from '@/lib/billing/pharmacy-price'

const SLABS = [0, 500, 1200, 1800, 2800, 4000] as const
const worstTotal = (taxable: number, r: number) => Math.max(lineTax(taxable, r, 'intra').totalPaise, lineTax(taxable, r, 'inter').totalPaise)

describe('pharmacyLinePrice', () => {
  it('₹3.50 MRP × 15 at 12%: within 17 paise of ₹52.50 and never above it', () => {
    const p = pharmacyLinePrice({ mrpPerUnitPaise: 350, quantity: 15, gstRateBp: 1200 })
    expect(p.totalPaise).toBeLessThanOrEqual(5250)
    expect(p.totalPaise).toBeGreaterThan(5250 - 17)
    expect(p).toEqual({ unitPricePaise: 312, taxablePaise: 4680, gstPaise: 562, totalPaise: 5242 })
  })

  it('0% GST charges exactly MRP × quantity', () => {
    expect(pharmacyLinePrice({ mrpPerUnitPaise: 275, quantity: 4, gstRateBp: 0 })).toEqual({ unitPricePaise: 275, taxablePaise: 1100, gstPaise: 0, totalPaise: 1100 })
  })

  it('a free (₹0 MRP) item is ₹0', () => {
    expect(pharmacyLinePrice({ mrpPerUnitPaise: 0, quantity: 3, gstRateBp: 1200 })).toEqual({ unitPricePaise: 0, taxablePaise: 0, gstPaise: 0, totalPaise: 0 })
  })

  it('handles the largest MRP and quantity without losing precision', () => {
    const p = pharmacyLinePrice({ mrpPerUnitPaise: 1_000_000_000, quantity: 1000, gstRateBp: 2800 })
    expect(p.totalPaise).toBeLessThanOrEqual(1_000_000_000 * 1000)
    expect(worstTotal((p.unitPricePaise + 1) * 1000, 2800)).toBeGreaterThan(1_000_000_000 * 1000)
  })

  it('property: never above MRP × q under intra or inter supply; unit price is the largest that fits; shortfall < one unit step + 2', () => {
    for (const r of SLABS) {
      for (let q = 1; q <= 50; q++) {
        for (let mrp = 1; mrp <= 2000; mrp++) {
          const cap = mrp * q
          const p = pharmacyLinePrice({ mrpPerUnitPaise: mrp, quantity: q, gstRateBp: r })
          if (p.taxablePaise !== p.unitPricePaise * q || p.totalPaise !== p.taxablePaise + p.gstPaise) throw new Error(`inconsistent at ${mrp}/${q}/${r}`)
          if (worstTotal(p.taxablePaise, r) !== p.totalPaise) throw new Error(`gst is not the worst case at ${mrp}/${q}/${r}`)
          if (p.totalPaise > cap) throw new Error(`above MRP at ${mrp}/${q}/${r}`)
          if (worstTotal((p.unitPricePaise + 1) * q, r) <= cap) throw new Error(`not the largest unit price at ${mrp}/${q}/${r}`)
          // The brief's "< q + 2" holds only at 0% (one whole-paise unit step adds q × (1 + rate) to
          // the total); the provable bound is one unit step plus 2 paise of rounding.
          const bound = r === 0 ? q + 2 : q + Math.ceil((q * r) / 10000) + 2
          if (cap - p.totalPaise >= bound) throw new Error(`shortfall ${cap - p.totalPaise} at ${mrp}/${q}/${r}`)
        }
      }
    }
  })

  it('refuses a quantity outside 1..1000, a negative MRP and a rate outside the slabs', () => {
    expect(() => pharmacyLinePrice({ mrpPerUnitPaise: 100, quantity: 0, gstRateBp: 500 })).toThrow(RangeError)
    expect(() => pharmacyLinePrice({ mrpPerUnitPaise: 100, quantity: 1001, gstRateBp: 500 })).toThrow(RangeError)
    expect(() => pharmacyLinePrice({ mrpPerUnitPaise: -1, quantity: 1, gstRateBp: 500 })).toThrow(RangeError)
    expect(() => pharmacyLinePrice({ mrpPerUnitPaise: 100, quantity: 1, gstRateBp: 700 })).toThrow(RangeError)
  })
})

describe('expiry month', () => {
  it('a month before the IST current month is expired; the current month is not', () => {
    // 2026-10-31T19:00Z is already 1 November in IST.
    const now = new Date('2026-10-31T19:00:00Z')
    expect(isExpiredMonth('2026-10', now)).toBe(true)
    expect(isExpiredMonth('2026-11', now)).toBe(false)
    expect(isExpiredMonth('2027-01', now)).toBe(false)
    expect(isExpiredMonth('2025-12', now)).toBe(true)
  })

  it('labels YYYY-MM as MM/YYYY', () => {
    expect(expiryLabel('2027-03')).toBe('03/2027')
  })
})

describe('medicationPriceSchema', () => {
  it('accepts an MRP with an optional slab and HSN, and is strict', () => {
    expect(medicationPriceSchema.safeParse({ mrpPerUnitPaise: 350 }).success).toBe(true)
    expect(medicationPriceSchema.safeParse({ mrpPerUnitPaise: 350, gstRateBp: 1200, hsn: '3004' }).success).toBe(true)
    expect(medicationPriceSchema.safeParse({ mrpPerUnitPaise: 350, gstRateBp: null, hsn: null }).success).toBe(true)
    expect(medicationPriceSchema.safeParse({ mrpPerUnitPaise: 350, gstRateBp: 700 }).success).toBe(false)
    expect(medicationPriceSchema.safeParse({ mrpPerUnitPaise: 350, hsn: '30A4' }).success).toBe(false)
    expect(medicationPriceSchema.safeParse({ mrpPerUnitPaise: 1_000_000_001 }).success).toBe(false)
    expect(medicationPriceSchema.safeParse({ mrpPerUnitPaise: 350, extra: 1 }).success).toBe(false)
  })
})
