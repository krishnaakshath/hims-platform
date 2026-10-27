import { describe, it, expect } from 'vitest'
import { computeDischargeDues, clearanceIsCurrent, type DischargeDues } from '@/lib/inpatient/dues'

// WS3 T5: dues arithmetic (spec 3.2 item 13). Pure; integer paise.
const SELF = null
const TWO_LINES = [
  { taxablePaise: 1_500_00, gstRateBp: 0, payerId: SELF },   // ₹1,500 at 0%
  { taxablePaise: 350_00, gstRateBp: 1200, payerId: SELF },  // ₹350 at 12% -> ₹392
]

describe('computeDischargeDues', () => {
  it('sums line totals with intra-state GST and nets the advance', () => {
    const d = computeDischargeDues({ lines: TWO_LINES, netAdvancesPaise: 1_000_00, receiptsPaise: 0, approvedPreauthPaise: null })
    expect(d).toEqual({
      chargesPaise: 1_50_000 + 39_200, payerChargesPaise: 0, insurerSharePaise: 0,
      paidPaise: 1_000_00, outstandingPaise: 89_200, creditPaise: 0,
    })
  })

  it('caps the insurer share at the payer-billed lines when the approved pre-auth is larger', () => {
    const d = computeDischargeDues({
      lines: [{ taxablePaise: 1_500_00, gstRateBp: 0, payerId: 7 }, { taxablePaise: 350_00, gstRateBp: 1200, payerId: SELF }],
      netAdvancesPaise: 0, receiptsPaise: 0, approvedPreauthPaise: 5_00_000_00,
    })
    expect(d.payerChargesPaise).toBe(1_50_000)
    expect(d.insurerSharePaise).toBe(1_50_000)
    expect(d.outstandingPaise).toBe(39_200)
  })

  it('takes the approved amount when it is below the payer-billed lines, and 0 without a pre-auth', () => {
    const lines = [{ taxablePaise: 1_500_00, gstRateBp: 0, payerId: 7 }]
    expect(computeDischargeDues({ lines, netAdvancesPaise: 0, receiptsPaise: 0, approvedPreauthPaise: 1_000_00 }))
      .toMatchObject({ insurerSharePaise: 1_000_00, outstandingPaise: 500_00 })
    expect(computeDischargeDues({ lines, netAdvancesPaise: 0, receiptsPaise: 0, approvedPreauthPaise: null }))
      .toMatchObject({ insurerSharePaise: 0, outstandingPaise: 1_500_00 })
  })

  it('an overpayment gives a credit and no outstanding', () => {
    const d = computeDischargeDues({ lines: TWO_LINES, netAdvancesPaise: 1_500_00, receiptsPaise: 1_000_00, approvedPreauthPaise: null })
    expect(d.paidPaise).toBe(2_500_00)
    expect(d.outstandingPaise).toBe(0)
    expect(d.creditPaise).toBe(2_500_00 - 1_89_200)
  })

  it('no lines and no money is all zero', () => {
    expect(computeDischargeDues({ lines: [], netAdvancesPaise: 0, receiptsPaise: 0, approvedPreauthPaise: null }))
      .toEqual({ chargesPaise: 0, payerChargesPaise: 0, insurerSharePaise: 0, paidPaise: 0, outstandingPaise: 0, creditPaise: 0 })
  })
})

describe('clearanceIsCurrent', () => {
  const dues = (chargesPaise: number, outstandingPaise: number): DischargeDues =>
    ({ chargesPaise, payerChargesPaise: 0, insurerSharePaise: 0, paidPaise: chargesPaise - outstandingPaise, outstandingPaise, creditPaise: 0 })

  it('is false without a clearance', () => {
    expect(clearanceIsCurrent(null, dues(1000, 1000))).toBe(false)
  })

  it('is false when charges grew after the clearance', () => {
    expect(clearanceIsCurrent({ chargesPaise: 1000, overrideReason: 'Corporate tie-up, billed monthly', outstandingPaise: 1000 }, dues(1500, 1500))).toBe(false)
  })

  it('is true when charges are unchanged and the clearance carries a reason', () => {
    expect(clearanceIsCurrent({ chargesPaise: 1000, overrideReason: 'Corporate tie-up, billed monthly', outstandingPaise: 1000 }, dues(1000, 1000))).toBe(true)
  })

  it('is true when the stored outstanding was 0 and charges are unchanged', () => {
    expect(clearanceIsCurrent({ chargesPaise: 1000, overrideReason: null, outstandingPaise: 0 }, dues(1000, 0))).toBe(true)
  })

  it('a reasonless zero clearance does not cover dues that reappeared (e.g. an advance refunded)', () => {
    expect(clearanceIsCurrent({ chargesPaise: 1000, overrideReason: null, outstandingPaise: 0 }, dues(1000, 400))).toBe(false)
  })

  it('a reasoned clearance does not cover a larger outstanding than it was given for', () => {
    expect(clearanceIsCurrent({ chargesPaise: 1000, overrideReason: 'Corporate tie-up, billed monthly', outstandingPaise: 600 }, dues(1000, 900))).toBe(false)
  })
})
