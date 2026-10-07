import { verhoeffValidate } from './verhoeff'

export function normalizeAadhaar(input: string): string {
  return input.replace(/[\s-]/g, '')
}

export function isValidAadhaar(input: string): boolean {
  const n = normalizeAadhaar(input)
  return /^[2-9]\d{11}$/.test(n) && verhoeffValidate(n)
}

export function aadhaarLast4(normalized: string): string {
  return normalized.slice(-4)
}

export function maskAadhaarLast4(last4: string): string {
  return `XXXX XXXX ${last4}`
}

// Free-text detector for an Aadhaar number embedded in text (notes, audit
// strings): 12 digits starting 2-9, grouped 4-4-4 with any mix/repeat of
// whitespace, '.', '/' or '-' between groups, not part of a longer digit run,
// with a valid Verhoeff checksum. Known false positive: any other
// Verhoeff-valid 12-digit number starting 2-9 (e.g. ~1 in 10 phone numbers
// written as 91XXXXXXXXXX) is also treated as Aadhaar.
const AADHAAR_IN_TEXT = /(?<!\d)[2-9]\d{3}[\s./-]*\d{4}[\s./-]*\d{4}(?!\d)/g

function isAadhaarMatch(m: string): boolean {
  return isValidAadhaar(m.replace(/\D/g, ''))
}

export function containsAadhaarLike(text: string): boolean {
  for (const m of text.matchAll(AADHAAR_IN_TEXT)) if (isAadhaarMatch(m[0])) return true
  return false
}

export function redactAadhaarLike(text: string): string {
  return text.replace(AADHAAR_IN_TEXT, (m) => (isAadhaarMatch(m) ? '[redacted]' : m))
}
