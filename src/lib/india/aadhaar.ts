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
