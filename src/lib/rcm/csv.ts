// SP7 (pure): RFC 4180 CSV with CRLF lines. A text cell that a spreadsheet would read as a formula
// (starting =, +, -, @, tab or CR) is prefixed with an apostrophe (formula injection).
export type CsvCell = string | number | null

function cell(v: CsvCell): string {
  if (v === null) return ''
  let s = typeof v === 'number' ? String(v) : v
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(rows: CsvCell[][]): string {
  return rows.map((r) => `${r.map(cell).join(',')}\r\n`).join('')
}

/** Paise as a plain rupee string with two decimals ('12345.67'), exact for any safe integer. */
export function paiseToRupeeString(paise: number): string {
  const b = BigInt(paise)
  const neg = b < BigInt(0)
  const abs = neg ? -b : b
  return `${neg ? '-' : ''}${abs / BigInt(100)}.${String(abs % BigInt(100)).padStart(2, '0')}`
}
