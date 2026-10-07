import { verhoeffCheckDigit, verhoeffValidate } from '@/lib/india/verhoeff'

// UHID = prefix + 8-digit zero-padded sequence + Verhoeff check digit.
// Deliberately takes no patient data, so a UHID carries no PHI.
export const UHID_PREFIX_PATTERN = /^[A-Z][A-Z0-9]{0,5}$/
export const UHID_SEQ_DIGITS = 8
const MAX_SEQ = 10 ** UHID_SEQ_DIGITS - 1

export function isValidUhidPrefix(p: string): boolean {
  return UHID_PREFIX_PATTERN.test(p)
}

export function formatUhid(prefix: string, seq: number): string {
  if (!isValidUhidPrefix(prefix)) throw new Error('Invalid UHID prefix')
  if (!Number.isInteger(seq) || seq < 1 || seq > MAX_SEQ) throw new Error('Invalid UHID sequence')
  const digits = String(seq).padStart(UHID_SEQ_DIGITS, '0')
  return `${prefix}${digits}${verhoeffCheckDigit(digits)}`
}

export function parseUhid(uhid: string): { prefix: string; seq: number } | null {
  const m = /^([A-Z][A-Z0-9]*?)(\d{8})(\d)$/.exec(uhid)
  if (!m) return null
  const [, prefix, digits, check] = m
  if (!isValidUhidPrefix(prefix)) return null
  if (!verhoeffValidate(digits + check)) return null
  return { prefix, seq: Number(digits) }
}
