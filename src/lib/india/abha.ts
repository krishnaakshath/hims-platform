export function normalizeAbhaNumber(input: string): string {
  return input.replace(/[\s-]/g, '')
}

export function isValidAbhaNumber(input: string): boolean {
  return /^\d{14}$/.test(normalizeAbhaNumber(input))
}

export function formatAbhaNumber(digits14: string): string {
  return `${digits14.slice(0, 2)}-${digits14.slice(2, 6)}-${digits14.slice(6, 10)}-${digits14.slice(10, 14)}`
}

export function normalizeAbhaAddress(input: string): string {
  return input.trim().toLowerCase()
}

export function isValidAbhaAddress(input: string): boolean {
  const m = /^([a-z0-9._]{8,18})@(abdm|sbx)$/.exec(normalizeAbhaAddress(input))
  if (!m) return false
  const local = m[1]
  if (/^[._]|[._]$/.test(local)) return false
  if ((local.match(/\./g) ?? []).length > 1) return false
  if ((local.match(/_/g) ?? []).length > 1) return false
  return true
}
