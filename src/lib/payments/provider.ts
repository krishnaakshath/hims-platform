// Foundations T11: the payment provider seam. Every provider ends in the same ledger write
// (insertPaymentInTx in src/lib/queries/patient-ledger.ts): a receipt in patient_payments with the
// FY RCT number. `manual_upi_qr` (src/lib/payments/manual-upi.ts) shows a QR for HOSPITAL_UPI_VPA
// and records the payment when staff enter the payer's UTR; `gateway` (src/lib/payments/gateway.ts)
// is a stub that reports not configured until an integration with keys is built.

export interface PaymentProvider {
  name: string
  createRequest(i: { patientId: string; amountPaise: number; note: string }): Promise<{ requestId: number; qrPayload?: string; link?: string }>
  recordConfirmation(i: { requestId: number; utr: string }): Promise<{ receiptNo: string }>
}

export type PaymentProviderErrorCode =
  | 'not_configured' | 'patient_not_found' | 'admission_mismatch' | 'invoice_not_payable'
  | 'request_not_found' | 'already_confirmed' | 'duplicate_utr' | 'series_exhausted' | 'request_expired'

/** A refusal from a provider; `code` maps 1:1 to the route's HTTP answer. Never carries a UTR. */
export class PaymentProviderError extends Error {
  constructor(readonly code: PaymentProviderErrorCode) {
    super(`Payment provider refused: ${code}`)
    this.name = 'PaymentProviderError'
  }
}

export const UPI_NOT_CONFIGURED_MESSAGE = 'UPI is not set up. Ask your administrator.'

/** A UPI transaction reference after normaliseUtr: 6-35 letters/digits (bank UTRs are 12 digits). */
export const UTR_PATTERN = /^[A-Z0-9]{6,35}$/

/** Spaces and dashes dropped, upper-cased: "4123 4567 8901" and "412345678901" are one UTR. */
export function normaliseUtr(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase()
}
