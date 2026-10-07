/** Indian mobile -> +91XXXXXXXXXX; other +E.164 (8-15 digits) kept; else null. */
export function normalizePhone(input: string): string | null {
  const s = input.trim()
  if (s.startsWith('+')) {
    const digits = s.slice(1).replace(/[\s\-().]/g, '')
    if (!/^\d+$/.test(digits)) return null
    if (digits.startsWith('91') && digits.length === 12 && /^[6-9]/.test(digits[2])) return `+${digits}`
    if (digits.length >= 8 && digits.length <= 15 && !digits.startsWith('0')) return `+${digits}`
    return null
  }
  const digits = s.replace(/[\s\-().]/g, '')
  if (!/^\d+$/.test(digits)) return null
  let local: string | null = null
  if (digits.length === 10) local = digits
  else if (digits.length === 11 && digits.startsWith('0')) local = digits.slice(1)
  else if (digits.length === 12 && digits.startsWith('91')) local = digits.slice(2)
  return local && /^[6-9]\d{9}$/.test(local) ? `+91${local}` : null
}
