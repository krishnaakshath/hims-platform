// Foundations T11: pure UPI helpers (no DB), shared by manual-upi.ts and the cash desk page.

const VPA_PATTERN = /^[A-Za-z0-9._-]{1,256}@[A-Za-z][A-Za-z0-9]{1,63}$/
export const NOTE_MAX = 50

/**
 * A standards-compliant UPI deep link: `upi://pay?pa=…&pn=…&am=…&cu=INR&tn=…`. The amount is
 * rupees with exactly two decimals, computed from integer paise (no floats). Payee name and note
 * are percent-encoded; the VPA must match the UPI address shape, so it is passed through as is.
 */
export function upiUri(vpa: string, payeeName: string, amountPaise: number, note: string): string {
  if (!VPA_PATTERN.test(vpa)) throw new Error('Invalid UPI id')
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) throw new Error('Amount must be a positive whole number of paise')
  const am = `${Math.floor(amountPaise / 100)}.${String(amountPaise % 100).padStart(2, '0')}`
  return `upi://pay?pa=${vpa}&pn=${encodeURIComponent(payeeName)}&am=${am}&cu=INR&tn=${encodeURIComponent(note)}`
}

/** HOSPITAL_UPI_VPA (required, a valid UPI id) and HOSPITAL_UPI_PAYEE; null when UPI is not set up. */
export function upiConfig(): { vpa: string; payeeName: string } | null {
  const vpa = (process.env.HOSPITAL_UPI_VPA ?? '').trim()
  if (!VPA_PATTERN.test(vpa)) return null
  const payeeName = (process.env.HOSPITAL_UPI_PAYEE ?? '').trim().slice(0, 99) || 'Hospital'
  return { vpa, payeeName }
}

// WS7 T8: a UTR shown to staff is masked to its last four characters ("••••1234"); the full
// UTR is typed by the cashier from the bank statement, never sent to a browser.
export function maskUtr(utr: string): string {
  return `••••${utr.slice(-4)}`
}
// end WS7 T8
