export const CURRENCY = 'INR' as const

// Pure formatting (no Intl/toLocale*): the server and every browser produce the
// identical string, so a ₹ amount rendered by a client component can never
// cause a hydration mismatch. en-IN grouping: last 3 digits, then pairs
// (12,34,56,789).
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits
  const last3 = digits.slice(-3)
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')
  return `${rest},${last3}`
}

/** Format integer paise as ₹ with Indian digit grouping, e.g. 123456789 -> "₹12,34,567.89". */
export function formatPaise(paise: number): string {
  const p = Math.round(paise)
  const abs = Math.abs(p)
  const rupees = Math.floor(abs / 100)
  const frac = String(abs % 100).padStart(2, '0')
  return `${p < 0 ? '-' : ''}₹${groupIndian(String(rupees))}.${frac}`
}

/** Whole rupees (no paise) with Indian grouping, for chart axes/tooltips: 123456 -> "₹1,23,456". */
export function formatRupeesWhole(rupees: number): string {
  const r = Math.round(rupees)
  return `${r < 0 ? '-' : ''}₹${groupIndian(String(Math.abs(r)))}`
}

/** Parse a rupee string ("1234", "1,234.5", "₹ 1,23,456.78") to integer paise, or null if invalid. */
export function parseRupeesToPaise(input: string): number | null {
  const cleaned = input.replace(/[₹\s,]/g, '')
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned)
  if (!m) return null
  const paise = BigInt(m[1]) * BigInt(100) + BigInt((m[2] ?? '').padEnd(2, '0'))
  if (paise > BigInt(Number.MAX_SAFE_INTEGER)) return null
  return Number(paise)
}
