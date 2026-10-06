/** Formats an integer cents amount as US currency, e.g. 17500 -> "$175.00". */
export function formatCents(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}
