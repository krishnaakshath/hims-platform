import { describe, it, expect } from 'vitest'
import { computeChargeBalance, computeChargeBalances } from '@/lib/billing-calculations'

function charge(amountCents: number, id = 1) {
  return { id, amountCents } as Parameters<typeof computeChargeBalance>[0]
}
function claim(chargeId: number, paidAmountCents: number | null) {
  return { chargeId, paidAmountCents } as Parameters<typeof computeChargeBalance>[1][number]
}
function payment(chargeId: number, amountCents: number, result: 'success' | 'failed' = 'success') {
  return { chargeId, amountCents, result } as Parameters<typeof computeChargeBalance>[2][number]
}
function fullCharge(id: number, patientId: string, dateOfService: string, amountCents: number) {
  return { id, patientId, dateOfService, amountCents } as Parameters<typeof computeChargeBalances>[0][number]
}
function patientPayment(patientId: string, amountCents: number, result: 'success' | 'failed' = 'success') {
  return { patientId, chargeId: null, amountCents, result } as Parameters<typeof computeChargeBalances>[2][number]
}

describe('computeChargeBalance', () => {
  it('applies insurance first, then patient payment against the remainder', () => {
    const c = charge(10000)
    const result = computeChargeBalance(c, [claim(1, 6000)], [payment(1, 4000)])
    expect(result.insurancePaidCents).toBe(6000)
    expect(result.patientPaidCents).toBe(4000)
    expect(result.collectedCents).toBe(10000)
    expect(result.outstandingCents).toBe(0)
    expect(result.unappliedPatientPaymentCents).toBe(0)
  })

  it('caps applied patient payment at the amount still owed, tracking the rest as unapplied', () => {
    const c = charge(10000)
    const result = computeChargeBalance(c, [claim(1, 8000)], [payment(1, 5000)])
    // Only $20 is owed after insurance; the patient paid $50.
    expect(result.patientPaidCents).toBe(2000)
    expect(result.unappliedPatientPaymentCents).toBe(3000)
    expect(result.outstandingCents).toBe(0)
  })

  it('ignores a failed payment entirely', () => {
    const c = charge(10000)
    const result = computeChargeBalance(c, [], [payment(1, 10000, 'failed')])
    expect(result.patientPaidCents).toBe(0)
    expect(result.outstandingCents).toBe(10000)
  })

  it('treats a null paidAmountCents on a claim as zero', () => {
    const c = charge(5000)
    const result = computeChargeBalance(c, [claim(1, null)], [])
    expect(result.insurancePaidCents).toBe(0)
    expect(result.outstandingCents).toBe(5000)
  })

  it('never lets collectedCents exceed the charge amount even if insurance overpays', () => {
    const c = charge(5000)
    const result = computeChargeBalance(c, [claim(1, 8000)], [payment(1, 1000)])
    expect(result.collectedCents).toBe(5000)
    expect(result.outstandingCents).toBe(0)
    expect(result.patientPaidCents).toBe(0)
    expect(result.unappliedPatientPaymentCents).toBe(1000)
  })

  it('ignores claims/payments belonging to a different charge', () => {
    const c = charge(5000, 1)
    const result = computeChargeBalance(c, [claim(2, 5000)], [payment(2, 5000)])
    expect(result.insurancePaidCents).toBe(0)
    expect(result.outstandingCents).toBe(5000)
  })
})

describe('computeChargeBalances', () => {
  it('applies an unattributed (chargeId: null) patient payment to the patient\'s only outstanding charge', () => {
    const charges = [fullCharge(1, 'RD-0001', '2026-09-01', 10000)]
    const balances = computeChargeBalances(charges, [], [patientPayment('RD-0001', 10000)])
    expect(balances.get(1)!.patientPaidCents).toBe(10000)
    expect(balances.get(1)!.collectedCents).toBe(10000)
    expect(balances.get(1)!.outstandingCents).toBe(0)
  })

  it('applies an unattributed payment to a patient\'s multiple charges oldest dateOfService first', () => {
    const charges = [
      fullCharge(1, 'RD-0001', '2026-08-01', 5000),
      fullCharge(2, 'RD-0001', '2026-07-01', 5000), // older, should be paid down first
    ]
    const balances = computeChargeBalances(charges, [], [patientPayment('RD-0001', 6000)])
    expect(balances.get(2)!.outstandingCents).toBe(0) // older charge fully paid
    expect(balances.get(1)!.outstandingCents).toBe(4000) // remaining 1000 applied here
  })

  it('surfaces a leftover unattributed payment as unapplied on the patient\'s most recent charge once every charge is paid off', () => {
    const charges = [fullCharge(1, 'RD-0001', '2026-09-01', 5000)]
    const balances = computeChargeBalances(charges, [], [patientPayment('RD-0001', 8000)])
    expect(balances.get(1)!.outstandingCents).toBe(0)
    expect(balances.get(1)!.unappliedPatientPaymentCents).toBe(3000)
  })

  it('never applies one patient\'s unattributed payment against a different patient\'s charge', () => {
    const charges = [fullCharge(1, 'RD-0001', '2026-09-01', 5000), fullCharge(2, 'RD-0002', '2026-09-01', 5000)]
    const balances = computeChargeBalances(charges, [], [patientPayment('RD-0002', 5000)])
    expect(balances.get(1)!.outstandingCents).toBe(5000) // untouched
    expect(balances.get(2)!.outstandingCents).toBe(0)
  })

  it('ignores a failed unattributed payment', () => {
    const charges = [fullCharge(1, 'RD-0001', '2026-09-01', 5000)]
    const balances = computeChargeBalances(charges, [], [patientPayment('RD-0001', 5000, 'failed')])
    expect(balances.get(1)!.outstandingCents).toBe(5000)
  })

  it('matches computeChargeBalance exactly when there are no unattributed payments', () => {
    const charges = [fullCharge(1, 'RD-0001', '2026-09-01', 10000)]
    const claims = [claim(1, 6000)]
    const payments = [payment(1, 4000)]
    const balances = computeChargeBalances(charges, claims, payments)
    expect(balances.get(1)!).toEqual(computeChargeBalance(charges[0], claims, payments))
  })
})
