import type { charges, insuranceClaims, mockPayments } from '@/db/schema'

type Charge = typeof charges.$inferSelect
type InsuranceClaim = typeof insuranceClaims.$inferSelect
type MockPayment = typeof mockPayments.$inferSelect

export interface ChargeBalance {
  insurancePaidCents: number
  patientPaidCents: number
  unappliedPatientPaymentCents: number
  collectedCents: number
  outstandingCents: number
}

// The one place "insurance paid, then patient payment applied against the
// remainder, capped at the charge amount" is computed -- the AR dashboard,
// the billing-analytics trend, and the patient-collections list all need
// this exact math and must never compute it independently, since a future
// change (a rounding tweak, an overpayment-handling rule) applied to only
// one copy would silently produce inconsistent numbers across those three
// screens.
export function computeChargeBalance(charge: Charge, claims: InsuranceClaim[], payments: MockPayment[]): ChargeBalance {
  const insurancePaidCents = claims
    .filter((c) => c.chargeId === charge.id)
    .reduce((sum, c) => sum + (c.paidAmountCents ?? 0), 0)

  const amountDueFromPatientCents = Math.max(0, charge.amountCents - insurancePaidCents)

  const patientPaidRawCents = payments
    .filter((p) => p.chargeId === charge.id && p.result === 'success')
    .reduce((sum, p) => sum + p.amountCents, 0)

  const patientPaidCents = Math.min(patientPaidRawCents, amountDueFromPatientCents)
  const unappliedPatientPaymentCents = Math.max(0, patientPaidRawCents - patientPaidCents)
  const collectedCents = Math.min(charge.amountCents, insurancePaidCents + patientPaidCents)
  const outstandingCents = Math.max(0, charge.amountCents - collectedCents)

  return { insurancePaidCents, patientPaidCents, unappliedPatientPaymentCents, collectedCents, outstandingCents }
}

// The Virtual Card Payment form (Patient Collections' "Collect Payment" flow)
// only ever knows a patient and an aggregate amount, never a specific
// charge -- every payment it creates has chargeId: null. Left unhandled,
// computeChargeBalance()'s per-charge, chargeId-matched lookup would make
// those payments invisible to every screen (Patient Collections, the A/R
// Dashboard, Billing Analytics), so a payment made through the app's own
// UI would provably change nothing anywhere. This wraps computeChargeBalance
// for a whole charge set and, per patient, applies that patient's
// unattributed (chargeId === null) successful payments against their own
// still-outstanding charges, oldest dateOfService first -- the same
// "pay down the oldest debt first" rule a real biller would apply. Any
// leftover (the payment exceeded everything owed) is surfaced as unapplied
// on the patient's most recent charge, mirroring how a chargeId-matched
// overpayment already surfaces via unappliedPatientPaymentCents.
export function computeChargeBalances(chargeList: Charge[], claims: InsuranceClaim[], payments: MockPayment[]): Map<number, ChargeBalance> {
  const balances = new Map<number, ChargeBalance>()
  for (const charge of chargeList) balances.set(charge.id, computeChargeBalance(charge, claims, payments))

  const byPatient = new Map<string, Charge[]>()
  for (const charge of chargeList) {
    const list = byPatient.get(charge.patientId) ?? []
    list.push(charge)
    byPatient.set(charge.patientId, list)
  }

  for (const [patientId, patientCharges] of byPatient) {
    let pool = payments
      .filter((p) => p.patientId === patientId && p.chargeId === null && p.result === 'success')
      .reduce((sum, p) => sum + p.amountCents, 0)
    if (pool <= 0) continue

    const sorted = [...patientCharges].sort((a, b) => a.dateOfService.localeCompare(b.dateOfService))
    for (const charge of sorted) {
      if (pool <= 0) break
      const balance = balances.get(charge.id)!
      if (balance.outstandingCents <= 0) continue
      const applied = Math.min(pool, balance.outstandingCents)
      balances.set(charge.id, {
        ...balance,
        patientPaidCents: balance.patientPaidCents + applied,
        collectedCents: balance.collectedCents + applied,
        outstandingCents: balance.outstandingCents - applied,
      })
      pool -= applied
    }

    if (pool > 0) {
      const last = sorted[sorted.length - 1]
      const balance = balances.get(last.id)!
      balances.set(last.id, { ...balance, unappliedPatientPaymentCents: balance.unappliedPatientPaymentCents + pool })
    }
  }

  return balances
}
