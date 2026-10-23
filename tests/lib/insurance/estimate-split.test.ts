import { describe, it, expect } from 'vitest'
import { applyCoverageToEstimate } from '@/lib/insurance/estimate-split'
import type { CoverageLimits } from '@/lib/insurance/coverage'

const NO_LIMITS: CoverageLimits = { sumInsuredPaise: null, balancePaise: null, copayBp: null, roomRentLimitPaise: null, icuLimitPaise: null }
const line = (category: string | null, unitPricePaise: number, quantity: number) => ({ category, unitPricePaise, quantity, amountPaise: unitPricePaise * quantity })
const integers = (r: { totalPaise: number; insurerPaise: number; patientPaise: number }) => {
  for (const v of [r.totalPaise, r.insurerPaise, r.patientPaise]) expect(Number.isInteger(v)).toBe(true)
  expect(r.insurerPaise + r.patientPaise).toBe(r.totalPaise)
}

describe('applyCoverageToEstimate', () => {
  it('no limits: the insurer pays everything, no warnings', () => {
    const r = applyCoverageToEstimate({ lines: [line('procedure', 50_000_00, 1)], limits: NO_LIMITS, roomCategoryCode: 'GEN', lengthOfStayDays: 2 })
    expect(r).toEqual({ totalPaise: 50_000_00, insurerPaise: 50_000_00, patientPaise: 0, warnings: [] })
  })

  it('room rent over the limit: the excess per day times days goes to the patient, then co-pay on the rest', () => {
    const r = applyCoverageToEstimate({
      lines: [line('room_rent', 5_000_00, 3), line('procedure', 20_000_00, 1)],
      limits: { ...NO_LIMITS, roomRentLimitPaise: 3_000_00, copayBp: 1000 }, roomCategoryCode: 'PVT', lengthOfStayDays: 3,
    })
    // total 35,000; room excess 6,000; co-pay 10% of 29,000 = 2,900.
    expect(r.totalPaise).toBe(35_000_00)
    expect(r.patientPaise).toBe(6_000_00 + 2_900_00)
    expect(r.insurerPaise).toBe(26_100_00)
    integers(r)
    expect(r.warnings.join(' ')).toContain('₹6,000.00')
    expect(r.warnings.join(' ')).toContain('₹3,000.00')
  })

  it('co-pay 10% on ₹1,00,000 -> patient ₹10,000', () => {
    const r = applyCoverageToEstimate({ lines: [line('procedure', 1_00_000_00, 1)], limits: { ...NO_LIMITS, copayBp: 1000 }, roomCategoryCode: null, lengthOfStayDays: 0 })
    expect(r.patientPaise).toBe(10_000_00); expect(r.insurerPaise).toBe(90_000_00)
    expect(r.warnings.join(' ')).toContain('₹10,000.00')
    integers(r)
  })

  it('balance ₹50,000 against ₹80,000: the patient gets the ₹30,000 excess', () => {
    const r = applyCoverageToEstimate({ lines: [line('procedure', 80_000_00, 1)], limits: { ...NO_LIMITS, balancePaise: 50_000_00, sumInsuredPaise: 5_00_000_00 }, roomCategoryCode: null, lengthOfStayDays: 0 })
    expect(r.insurerPaise).toBe(50_000_00); expect(r.patientPaise).toBe(30_000_00)
    expect(r.warnings.join(' ')).toContain('₹30,000.00')
    integers(r)
  })

  it('falls back to the sum insured when no balance is known', () => {
    const r = applyCoverageToEstimate({ lines: [line('procedure', 80_000_00, 1)], limits: { ...NO_LIMITS, sumInsuredPaise: 60_000_00 }, roomCategoryCode: null, lengthOfStayDays: 0 })
    expect(r.insurerPaise).toBe(60_000_00); expect(r.patientPaise).toBe(20_000_00)
  })

  it('an ICU room uses the ICU limit, not the room-rent limit', () => {
    const limits = { ...NO_LIMITS, roomRentLimitPaise: 3_000_00, icuLimitPaise: 8_000_00 }
    const icu = applyCoverageToEstimate({ lines: [line('room_rent', 10_000_00, 2)], limits, roomCategoryCode: 'ICU', lengthOfStayDays: 2 })
    expect(icu.patientPaise).toBe(4_000_00)
    const nicu = applyCoverageToEstimate({ lines: [line('room_rent', 10_000_00, 2)], limits, roomCategoryCode: 'nicu', lengthOfStayDays: 2 })
    expect(nicu.patientPaise).toBe(4_000_00)
    const ward = applyCoverageToEstimate({ lines: [line('room_rent', 10_000_00, 2)], limits, roomCategoryCode: 'GEN', lengthOfStayDays: 2 })
    expect(ward.patientPaise).toBe(14_000_00)
    // ICU with no ICU limit: no room excess, even though a room-rent limit exists.
    const noIcuLimit = applyCoverageToEstimate({ lines: [line('room_rent', 10_000_00, 2)], limits: { ...NO_LIMITS, roomRentLimitPaise: 3_000_00 }, roomCategoryCode: 'ICU', lengthOfStayDays: 2 })
    expect(noIcuLimit.patientPaise).toBe(0)
  })

  it('rounds co-pay to whole paise and keeps every amount an integer', () => {
    const r = applyCoverageToEstimate({ lines: [line('procedure', 333, 1), line(null, 1, 1)], limits: { ...NO_LIMITS, copayBp: 333 }, roomCategoryCode: null, lengthOfStayDays: 0 })
    integers(r)
    expect(r.patientPaise).toBe(11)
  })

  it('all three together, in order: room excess, co-pay, then the cap', () => {
    const r = applyCoverageToEstimate({
      lines: [line('room_rent', 5_000_00, 4), line('procedure', 80_000_00, 1)],
      limits: { ...NO_LIMITS, roomRentLimitPaise: 4_000_00, copayBp: 1000, balancePaise: 50_000_00 }, roomCategoryCode: 'PVT', lengthOfStayDays: 4,
    })
    // total 1,00,000; room excess 4,000; co-pay 9,600 of 96,000; insurer 86,400 capped at 50,000.
    expect(r.insurerPaise).toBe(50_000_00); expect(r.patientPaise).toBe(50_000_00)
    expect(r.warnings).toHaveLength(3)
    integers(r)
  })
})
