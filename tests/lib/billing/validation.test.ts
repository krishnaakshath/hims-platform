import { describe, expect, it } from 'vitest'
import {
  billingSettingsSchema, cancelInvoiceSchema, chargeCaptureSchema, chargePreviewSchema, draftInvoiceSchema, payerBillingFlagsSchema,
  paymentReferenceProblem, paymentSchema, refundSchema, roomRentPostSchema, ruleConfigSchema, voidLineSchema, PAYMENT_MODES,
} from '@/lib/billing/validation'

const capture = { context: { encounterId: 1 }, serviceId: 1, quantity: 1, serviceDate: '2026-10-20', billTo: 'patient' }
const settings = {
  legalName: 'Sunrise Hospital', gstin: '29AAGCB7383J1Z4', stateCode: 'IN-KA', address: null, placeOfSupplyMode: 'location_of_service',
  consultationWindowDays: 30, ipdDepositThresholdPaise: 0, roomRentServiceId: null, pharmacyGstRateBp: 1200, pharmacyHsn: '3004',
}
const msgs = (r: { success: boolean; error?: { issues: { message: string }[] } }) => (r.success ? [] : r.error!.issues.map((i) => i.message))

describe('payment references', () => {
  it('rejects a Luhn-valid card number, accepts a 12-digit UTR', () => {
    expect(paymentReferenceProblem('card', '4111 1111 1111 1111')).toBe('Do not enter card numbers; record the approval code or the last 4 digits')
    expect(paymentReferenceProblem('upi', '412345678901')).toBeNull()
    expect(paymentReferenceProblem('neft', '')).toBe('Enter the transaction reference for this payment mode')
    expect(paymentReferenceProblem('cash', null)).toBeNull()
  })
  it('ignores spaces and dashes, 13 to 19 digits, and every mode including cash', () => {
    expect(paymentReferenceProblem('card', '4111-1111-1111-1111')).toMatch(/^Do not enter card numbers/)
    expect(paymentReferenceProblem('cash', '4111111111111111')).toMatch(/^Do not enter card numbers/)
    expect(paymentReferenceProblem('card', 'ref 4111111111111111 x')).toMatch(/^Do not enter card numbers/)
    expect(paymentReferenceProblem('card', '378282246310005')).toMatch(/^Do not enter card numbers/) // 15-digit Amex test number
    expect(paymentReferenceProblem('card', '4111111111111112')).toBeNull() // fails Luhn
    expect(paymentReferenceProblem('card', '411111111111')).toBeNull() // 12 digits: too short to be a card
    expect(paymentReferenceProblem('card', 'APPR 123456')).toBeNull()
    expect(paymentReferenceProblem('card', '1234')).toBeNull()
  })
  it('blank is blank after trimming, and the blank rule comes first', () => {
    expect(paymentReferenceProblem('cheque', '   ')).toBe('Enter the transaction reference for this payment mode')
    expect(paymentReferenceProblem('cheque', null)).toBe('Enter the transaction reference for this payment mode')
    expect(paymentReferenceProblem('cash', '   ')).toBeNull()
  })
  it('has the six modes', () => { expect([...PAYMENT_MODES]).toEqual(['cash', 'upi', 'card', 'cheque', 'neft', 'other']) })
})

describe('charge capture schema', () => {
  it('accepts a minimal capture and the preview schema is the same shape', () => {
    expect(chargeCaptureSchema.safeParse(capture).success).toBe(true)
    expect(chargePreviewSchema.safeParse(capture).success).toBe(true)
    expect(chargePreviewSchema.safeParse({ ...capture, quantity: 0 }).success).toBe(false)
  })
  it('a manual price needs a reason', () => {
    const r = chargeCaptureSchema.safeParse({ ...capture, manualUnitPricePaise: 100 })
    expect(r.success).toBe(false); expect(r.error!.issues[0].message).toBe('Give a reason for the manual price (at least 5 characters)')
    expect(r.error!.issues[0].path).toEqual(['priceOverrideReason'])
    expect(chargeCaptureSchema.safeParse({ ...capture, manualUnitPricePaise: 100, priceOverrideReason: '  ab  ' }).success).toBe(false)
    expect(chargeCaptureSchema.safeParse({ ...capture, manualUnitPricePaise: 100, priceOverrideReason: 'quoted by phone' }).success).toBe(true)
    expect(chargeCaptureSchema.safeParse({ ...capture, manualUnitPricePaise: 0, priceOverrideReason: 'free of charge' }).success).toBe(true)
  })
  it('context is exactly one of encounter or admission', () => {
    expect(chargeCaptureSchema.safeParse({ ...capture, context: { encounterId: 1, admissionId: 2 } }).success).toBe(false)
    expect(chargeCaptureSchema.safeParse({ ...capture, context: { admissionId: 2 } }).success).toBe(true)
    expect(chargeCaptureSchema.safeParse({ ...capture, context: {} }).success).toBe(false)
  })
  it('limits quantity, price, lists and rejects unknown keys', () => {
    expect(chargeCaptureSchema.safeParse({ ...capture, quantity: 1001 }).success).toBe(false)
    expect(chargeCaptureSchema.safeParse({ ...capture, quantity: 1000 }).success).toBe(true)
    expect(chargeCaptureSchema.safeParse({ ...capture, manualUnitPricePaise: 1_000_000_001, priceOverrideReason: 'enough reason' }).success).toBe(false)
    expect(chargeCaptureSchema.safeParse({ ...capture, manualUnitPricePaise: 1_000_000_000, priceOverrideReason: 'enough reason' }).success).toBe(true)
    expect(chargeCaptureSchema.safeParse({ ...capture, serviceDate: '2026-02-30' }).success).toBe(false)
    expect(chargeCaptureSchema.safeParse({ ...capture, billTo: 'other' }).success).toBe(false)
    expect(chargeCaptureSchema.safeParse({ ...capture, extra: 1 }).success).toBe(false)
    const codes = Array.from({ length: 6 }, (_, i) => ({ kind: 'hbp', code: `C${i}` }))
    expect(chargeCaptureSchema.safeParse({ ...capture, procedureCodes: codes.slice(0, 5) }).success).toBe(true)
    expect(chargeCaptureSchema.safeParse({ ...capture, procedureCodes: codes }).success).toBe(false)
    expect(chargeCaptureSchema.safeParse({ ...capture, procedureCodes: [{ kind: 'HBP', code: 'X' }] }).success).toBe(false)
    expect(chargeCaptureSchema.safeParse({ ...capture, overrides: [{ code: 'duplicate_charge', reason: 'second dressing' }] }).success).toBe(true)
    expect(chargeCaptureSchema.safeParse({ ...capture, overrides: [{ code: 'nope', reason: 'second dressing' }] }).success).toBe(false)
    expect(chargeCaptureSchema.safeParse({ ...capture, preAuthReference: '  PA-1 ' }).data?.preAuthReference).toBe('PA-1')
    expect(chargeCaptureSchema.safeParse({ ...capture, preAuthReference: 'x'.repeat(41) }).success).toBe(false)
  })
})

describe('small request schemas', () => {
  it('void, room rent, draft and cancel', () => {
    expect(voidLineSchema.safeParse({ reason: 'abcd' }).success).toBe(false)
    expect(voidLineSchema.safeParse({ reason: ' wrong code ' }).data).toEqual({ reason: 'wrong code' })
    expect(voidLineSchema.safeParse({ reason: 'x'.repeat(301) }).success).toBe(false)
    expect(roomRentPostSchema.safeParse({}).success).toBe(true)
    expect(roomRentPostSchema.safeParse({ throughDate: '2026-10-20' }).success).toBe(true)
    expect(roomRentPostSchema.safeParse({ throughDate: 'x' }).success).toBe(false)
    expect(draftInvoiceSchema.safeParse({ lineIds: [1, 2] }).success).toBe(true)
    expect(draftInvoiceSchema.safeParse({ lineIds: [] }).success).toBe(false)
    expect(draftInvoiceSchema.safeParse({ lineIds: [1, 1] }).success).toBe(false)
    expect(draftInvoiceSchema.safeParse({ lineIds: Array.from({ length: 501 }, (_, i) => i + 1) }).success).toBe(false)
    expect(cancelInvoiceSchema.safeParse({ reason: 'wrong patient' }).success).toBe(true)
    expect(cancelInvoiceSchema.safeParse({ reason: 'no' }).success).toBe(false)
  })
  it('rule config and payer flags', () => {
    expect(ruleConfigSchema.safeParse({ enabled: true, severity: null }).success).toBe(true)
    expect(ruleConfigSchema.safeParse({ enabled: true, severity: 'info' }).success).toBe(false)
    expect(payerBillingFlagsSchema.safeParse({ requiresPreauth: true, gstin: null, stateCode: null }).success).toBe(true)
    expect(payerBillingFlagsSchema.safeParse({ requiresPreauth: true, gstin: '27AAPFU0939F1ZV', stateCode: 'IN-MH' }).success).toBe(true)
    expect(payerBillingFlagsSchema.safeParse({ requiresPreauth: true, gstin: '27AAPFU0939F1ZW', stateCode: null }).success).toBe(false)
    expect(payerBillingFlagsSchema.safeParse({ requiresPreauth: true, gstin: null, stateCode: 'IN-XX' }).success).toBe(false)
  })
})

describe('payment and refund schemas', () => {
  const pay = { patientId: 'p1', kind: 'advance', mode: 'upi', reference: '412345678901', amountPaise: 5000 }
  it('accept a normal payment and refuse a card number in the reference', () => {
    expect(paymentSchema.safeParse(pay).success).toBe(true)
    const r = paymentSchema.safeParse({ ...pay, mode: 'card', reference: '4111 1111 1111 1111' })
    expect(r.success).toBe(false); expect(r.error!.issues[0].path).toEqual(['reference'])
    expect(msgs(r)).toEqual(['Do not enter card numbers; record the approval code or the last 4 digits'])
    expect(msgs(paymentSchema.safeParse({ ...pay, reference: undefined }))).toEqual(['Enter the transaction reference for this payment mode'])
    expect(paymentSchema.safeParse({ ...pay, mode: 'cash', reference: undefined }).success).toBe(true)
  })
  it('limit the amount and the kind', () => {
    expect(paymentSchema.safeParse({ ...pay, amountPaise: 0 }).success).toBe(false)
    expect(paymentSchema.safeParse({ ...pay, amountPaise: 1_000_000_000_000 }).success).toBe(true)
    expect(paymentSchema.safeParse({ ...pay, amountPaise: 1_000_000_000_001 }).success).toBe(false)
    expect(paymentSchema.safeParse({ ...pay, kind: 'refund' }).success).toBe(false)
    expect(paymentSchema.safeParse({ ...pay, admissionId: 3, invoiceId: 4 }).success).toBe(true)
  })
  it('refund needs a reason and applies the same reference rule', () => {
    const ref = { patientId: 'p1', mode: 'card', reference: 'APPR1', amountPaise: 100, reason: 'duplicate payment' }
    expect(refundSchema.safeParse(ref).success).toBe(true)
    expect(refundSchema.safeParse({ ...ref, reason: 'x' }).success).toBe(false)
    expect(refundSchema.safeParse({ ...ref, reference: '4111111111111111' }).success).toBe(false)
    expect(refundSchema.safeParse({ ...ref, againstPaymentId: 4, admissionId: 2 }).success).toBe(true)
  })
})

describe('billing settings schema', () => {
  it('accepts valid settings, with or without a GSTIN', () => {
    expect(billingSettingsSchema.safeParse(settings).success).toBe(true)
    expect(billingSettingsSchema.safeParse({ ...settings, gstin: null }).success).toBe(true)
  })
  it('settings refuse a GSTIN from another state', () => {
    const r = billingSettingsSchema.safeParse({ ...settings, stateCode: 'IN-TN' })
    expect(r.success).toBe(false); expect(msgs(r)).toEqual(['The GSTIN does not belong to the selected state'])
  })
  it('accepts a lowercase or padded GSTIN and stores it uppercase', () => {
    const r = billingSettingsSchema.safeParse({ ...settings, gstin: ' 29aagcb7383j1z4 ' })
    expect(r.success && r.data.gstin).toBe('29AAGCB7383J1Z4')
    const p = payerBillingFlagsSchema.safeParse({ requiresPreauth: false, gstin: '27aapfu0939f1zv', stateCode: null })
    expect(p.success && p.data.gstin).toBe('27AAPFU0939F1ZV')
  })
  it('refuses a bad GSTIN, bad state, rate and HSN', () => {
    expect(msgs(billingSettingsSchema.safeParse({ ...settings, gstin: '29AAGCB7383J1Z5' }))).toEqual(['Enter a valid 15-character GSTIN'])
    // Ruling: a lowercase GSTIN is accepted and stored uppercase (see the next test).
    expect(billingSettingsSchema.safeParse({ ...settings, stateCode: 'KA' }).success).toBe(false)
    expect(billingSettingsSchema.safeParse({ ...settings, pharmacyGstRateBp: 700 }).success).toBe(false)
    expect(billingSettingsSchema.safeParse({ ...settings, pharmacyHsn: '123' }).success).toBe(false)
    expect(billingSettingsSchema.safeParse({ ...settings, consultationWindowDays: 0 }).success).toBe(false)
    expect(billingSettingsSchema.safeParse({ ...settings, consultationWindowDays: 366 }).success).toBe(false)
    expect(billingSettingsSchema.safeParse({ ...settings, ipdDepositThresholdPaise: 1_000_000_001 }).success).toBe(false)
    expect(billingSettingsSchema.safeParse({ ...settings, placeOfSupplyMode: 'recipient_state', roomRentServiceId: 5, address: 'MG Road' }).success).toBe(true)
    expect(billingSettingsSchema.safeParse({ ...settings, legalName: 'A' }).success).toBe(false)
    expect(billingSettingsSchema.safeParse({ ...settings, extra: 1 }).success).toBe(false)
  })
})
