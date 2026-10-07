// SP4: server-only response helpers for the /api/billing routes. The role gate is NOT here:
// every handler checks its allowlist inline, right after requireSession(), before any body read.
import { NextResponse } from 'next/server'
import { RETRY_MESSAGE, isRetryableConflict, pgConstraint, pgErrorCode } from '@/lib/db-errors'

export { readJsonBody } from '@/lib/follow-ups/route-responses'
export { parseId, invalid } from '@/lib/tariff/route-responses'

export function billingError(status: number, error: string) {
  return NextResponse.json({ error }, { status })
}

/**
 * A thrown error: a deadlock or serialization failure (nothing was written) is a 409 asking to try
 * again; anything else a generic 500. Logs only the pg code and constraint, never the message or input.
 */
export function billingServerError(tag: string, err: unknown, message: string) {
  if (isRetryableConflict(err)) return billingError(409, RETRY_MESSAGE)
  console.error(`[billing] ${tag} failed (code ${pgErrorCode(err) ?? 'unknown'}, constraint ${pgConstraint(err) ?? 'none'})`)
  return billingError(500, message)
}

export type CaptureErrorCode = 'context_not_found' | 'context_cancelled' | 'no_payer' | 'price_override_forbidden' | 'blocked'

/** The exact HTTP mapping of a charge preview/capture refusal (plan Task 8). */
export function captureErrorResponse(error: CaptureErrorCode, violations?: unknown[]) {
  switch (error) {
    case 'context_not_found': return billingError(404, 'Visit or admission not found')
    case 'context_cancelled': return billingError(409, 'This visit was cancelled; charges cannot be added')
    case 'no_payer': return billingError(400, 'This patient has no primary payer on file')
    case 'price_override_forbidden': return billingError(403, 'Only billing or admin staff can override a price')
    case 'blocked': return NextResponse.json({ error: 'This charge breaks billing rules', violations: violations ?? [] }, { status: 422 })
  }
}

export type InvoiceErrorCode =
  | 'lines_not_found' | 'lines_not_available' | 'mixed_lines' | 'not_found' | 'not_draft' | 'empty'
  | 'settings_incomplete' | 'taxable_without_gstin' | 'series_exhausted' | 'not_finalised'

const INVOICE_ERRORS: Record<InvoiceErrorCode, [number, string]> = {
  lines_not_found: [404, 'Charge lines not found'],
  lines_not_available: [409, 'Some lines are already invoiced or voided'],
  mixed_lines: [400, 'Lines on one invoice must share the patient, the visit or stay, and the payer'],
  not_found: [404, 'Invoice not found'],
  not_draft: [409, 'Only a draft invoice can be changed'],
  empty: [409, 'This draft has no lines'],
  settings_incomplete: [409, 'Set the hospital legal name and state in Billing rules & settings before finalising'],
  taxable_without_gstin: [409, 'This bill has taxable lines but no hospital GSTIN is set'],
  series_exhausted: [409, 'The invoice number series for this financial year is full'],
  not_finalised: [409, 'Only a finalised invoice can be cancelled'],
}

/** The exact HTTP mapping of an invoice lifecycle refusal (plan Task 11). */
export function invoiceErrorResponse(error: InvoiceErrorCode) {
  const [status, message] = INVOICE_ERRORS[error]
  return billingError(status, message)
}
