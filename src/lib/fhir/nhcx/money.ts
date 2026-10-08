import { parseRupeesToPaise } from '@/lib/money'
import { MAX_DOCUMENT_PAISE } from '@/lib/billing/amounts'

// FHIR Money is in rupees; the HIMS keeps integer paise. The conversion goes
// through strings, never float arithmetic, so 1,23,45,678.89 stays exact.

export function paiseToFhirMoney(p: number): { value: number; currency: 'INR' } {
  if (!Number.isSafeInteger(p) || p < 0) throw new RangeError('paise must be a non-negative safe integer')
  const rupees = Math.floor(p / 100)
  const rest = String(p % 100).padStart(2, '0')
  return { value: Number(`${rupees}.${rest}`), currency: 'INR' }
}

/** Paise from a FHIR Money, or null when it is not INR, negative, over the cap or has more than two decimals. */
export function fhirMoneyToPaise(m: unknown): number | null {
  if (!m || typeof m !== 'object') return null
  const { value, currency } = m as { value?: unknown; currency?: unknown }
  if (currency !== undefined && currency !== 'INR') return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  const p = parseRupeesToPaise(String(value))
  return p === null || p > MAX_DOCUMENT_PAISE ? null : p
}
