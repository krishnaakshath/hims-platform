export const CURRENCY = 'INR' as const

const fmt = new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: CURRENCY, minimumFractionDigits: 2, maximumFractionDigits: 2,
})

/** Format integer paise as ₹ with Indian digit grouping. */
export function formatPaise(paise: number): string {
  return fmt.format(paise / 100)
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
