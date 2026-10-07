// Client-safe zod request schemas for billing (SP4). Pure: no DB imports.
import { z } from 'zod'
import { isIndianStateCode } from '@/lib/india/reference'
import { isoDate, GST_RATES_BP, MAX_AMOUNT_PAISE } from '@/lib/tariff/validation'
import { MAX_DOCUMENT_PAISE, MAX_LINE_QUANTITY } from './amounts'
import { CHARGE_RULE_CODES, OVERRIDE_REASON_MIN } from './charge-rules'
import { isValidGstin, stateCodeOfGstin } from './gst'

const positiveInt = z.number().int().positive()
const reason = (min: number) => z.string().trim().min(min).max(300)

export const procedureCodeRef = z.object({ kind: z.string().regex(/^[a-z0-9]{2,12}$/), code: z.string().trim().min(1).max(20) }).strict()

export const chargeContextRef = z.union([
  z.object({ encounterId: positiveInt }).strict(),
  z.object({ admissionId: positiveInt }).strict(),
])

export const chargeCaptureSchema = z.object({
  context: chargeContextRef,
  serviceId: positiveInt,
  quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY),
  serviceDate: isoDate,
  billTo: z.enum(['patient', 'payer']),
  preAuthReference: z.string().trim().min(1).max(40).optional(),
  procedureCodes: z.array(procedureCodeRef).max(5).optional(),
  performingProviderId: positiveInt.optional(),
  manualUnitPricePaise: z.number().int().min(0).max(MAX_AMOUNT_PAISE).optional(),
  priceOverrideReason: z.string().trim().max(300).optional(),
  overrides: z.array(z.object({ code: z.enum(CHARGE_RULE_CODES), reason: z.string().trim().max(300) }).strict()).max(11).optional(),
}).strict().superRefine((v, ctx) => {
  if (v.manualUnitPricePaise !== undefined && (v.priceOverrideReason ?? '').trim().length < OVERRIDE_REASON_MIN) {
    ctx.addIssue({ code: 'custom', path: ['priceOverrideReason'], message: 'Give a reason for the manual price (at least 5 characters)' })
  }
})
export const chargePreviewSchema = chargeCaptureSchema

export const voidLineSchema = z.object({ reason: reason(5) }).strict()
export const roomRentPostSchema = z.object({ throughDate: isoDate.optional() }).strict()
export const draftInvoiceSchema = z.object({
  lineIds: z.array(positiveInt).min(1).max(500).refine((ids) => new Set(ids).size === ids.length, 'Each line can be listed only once'),
}).strict()
export const cancelInvoiceSchema = z.object({ reason: reason(5) }).strict()

export const PAYMENT_MODES = ['cash', 'upi', 'card', 'cheque', 'neft', 'other'] as const
export type PaymentMode = (typeof PAYMENT_MODES)[number]

const CARD_MESSAGE = 'Do not enter card numbers; record the approval code or the last 4 digits'
const BLANK_MESSAGE = 'Enter the transaction reference for this payment mode'

function luhn(digits: string): boolean {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9 }
    sum += d
  }
  return sum % 10 === 0
}

/** Null when the reference is acceptable for the mode, otherwise a plain message. */
export function paymentReferenceProblem(mode: PaymentMode, reference: string | null): string | null {
  const ref = (reference ?? '').trim()
  if (mode !== 'cash' && ref === '') return BLANK_MESSAGE
  // Spaces and dashes are ignored, so "4111 1111 1111 1111" is one run of digits.
  const runs = ref.replace(/[\s-]/g, '').match(/\d+/g) ?? []
  if (runs.some((run) => run.length >= 13 && run.length <= 19 && luhn(run))) return CARD_MESSAGE
  return null
}

const referenceField = z.string().trim().max(40).optional()

export const paymentSchema = z.object({
  patientId: z.string().min(1).max(40),
  kind: z.enum(['advance', 'receipt']),
  admissionId: positiveInt.optional(),
  invoiceId: positiveInt.optional(),
  mode: z.enum(PAYMENT_MODES),
  reference: referenceField,
  amountPaise: z.number().int().min(1).max(MAX_DOCUMENT_PAISE),
}).strict().superRefine((v, ctx) => {
  const problem = paymentReferenceProblem(v.mode, v.reference ?? null)
  if (problem) ctx.addIssue({ code: 'custom', path: ['reference'], message: problem })
})

export const refundSchema = z.object({
  patientId: z.string().min(1).max(40),
  admissionId: positiveInt.optional(),
  againstPaymentId: positiveInt.optional(),
  mode: z.enum(PAYMENT_MODES),
  reference: referenceField,
  amountPaise: z.number().int().min(1).max(MAX_DOCUMENT_PAISE),
  reason: reason(5),
}).strict().superRefine((v, ctx) => {
  const problem = paymentReferenceProblem(v.mode, v.reference ?? null)
  if (problem) ctx.addIssue({ code: 'custom', path: ['reference'], message: problem })
})

const GSTIN_MESSAGE = 'Enter a valid 15-character GSTIN'
// Ruling: a lowercase or padded GSTIN is accepted and stored trimmed and uppercase.
const gstinField = z.string().trim().toUpperCase().refine(isValidGstin, GSTIN_MESSAGE)
const stateCodeField = z.string().refine(isIndianStateCode, 'Choose a state')

export const billingSettingsSchema = z.object({
  legalName: z.string().trim().min(2).max(200),
  gstin: gstinField.nullable(),
  stateCode: stateCodeField,
  address: z.string().trim().max(500).nullable(),
  placeOfSupplyMode: z.enum(['location_of_service', 'recipient_state']),
  consultationWindowDays: z.number().int().min(1).max(365),
  ipdDepositThresholdPaise: z.number().int().min(0).max(MAX_AMOUNT_PAISE),
  roomRentServiceId: positiveInt.nullable(),
  pharmacyGstRateBp: z.number().refine((v) => (GST_RATES_BP as readonly number[]).includes(v), 'Choose a valid GST rate'),
  pharmacyHsn: z.string().regex(/^\d{4,8}$/, 'HSN must be 4 to 8 digits'),
}).strict().superRefine((v, ctx) => {
  if (v.gstin !== null && stateCodeOfGstin(v.gstin) !== v.stateCode) {
    ctx.addIssue({ code: 'custom', path: ['gstin'], message: 'The GSTIN does not belong to the selected state' })
  }
})

export const ruleConfigSchema = z.object({ enabled: z.boolean(), severity: z.enum(['block', 'warn']).nullable() }).strict()

export const payerBillingFlagsSchema = z.object({
  requiresPreauth: z.boolean(),
  gstin: gstinField.nullable(),
  stateCode: stateCodeField.nullable(),
}).strict()

export type ChargeCaptureInput = z.infer<typeof chargeCaptureSchema>
export type PaymentInput = z.infer<typeof paymentSchema>
export type RefundInput = z.infer<typeof refundSchema>
export type BillingSettingsInput = z.infer<typeof billingSettingsSchema>
