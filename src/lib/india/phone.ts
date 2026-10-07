/**
 * Indian mobile -> +91XXXXXXXXXX; other country +E.164 (8-15 digits) kept; else null.
 * `+91` / `0091` / `91` numbers with the wrong digit count are rejected, not
 * passed on as generic E.164. With `allowLandline` (contact phones only), a
 * 10-digit STD landline (STD code + number, national number starting 1-5) is
 * also accepted and normalised to +91 + the 10 digits.
 */
export function normalizePhone(input: string, opts: { allowLandline?: boolean } = {}): string | null {
  let s = input.trim().replace(/[\s\-().]/g, '')
  if (s.startsWith('00')) s = `+${s.slice(2)}`
  const indian = (nsn: string): string | null => {
    if (/^[6-9]\d{9}$/.test(nsn)) return `+91${nsn}`
    if (opts.allowLandline && /^[1-5]\d{9}$/.test(nsn)) return `+91${nsn}`
    return null
  }
  if (s.startsWith('+')) {
    const digits = s.slice(1)
    if (!/^\d+$/.test(digits)) return null
    if (digits.startsWith('91')) return indian(digits.slice(2))
    if (digits.length >= 8 && digits.length <= 15 && !digits.startsWith('0')) return `+${digits}`
    return null
  }
  if (!/^\d+$/.test(s)) return null
  if (s.length === 10) return indian(s)
  if (s.length === 11 && s.startsWith('0')) return indian(s.slice(1))
  if (s.length === 12 && s.startsWith('91')) return indian(s.slice(2))
  return null
}
