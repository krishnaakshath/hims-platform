// Pure document numbering. Format INV/26-27/000123 (GST Rule 46: at most 16 characters, unique per FY).
export const DOCUMENT_SERIES = ['invoice', 'receipt', 'credit_note', 'refund'] as const
export type DocumentSeries = (typeof DOCUMENT_SERIES)[number]

export const SERIES_PREFIX: Record<DocumentSeries, string> = { invoice: 'INV', receipt: 'RCT', credit_note: 'CRN', refund: 'RFD' }

export const MAX_SERIES_VALUE = 999_999

/** Indian financial year (April to March) of an IST calendar date: '2026-04-01' → '2026-27', '2099-06-01' → '2099-00'. */
export function financialYearOf(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(isoDate)
  if (!m) throw new RangeError('Date must be YYYY-MM-DD')
  const year = Number(m[1])
  const start = Number(m[2]) >= 4 ? year : year - 1
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`
}

export function formatDocumentNumber(series: DocumentSeries, financialYear: string, value: number): string {
  if (!Number.isInteger(value) || value < 1 || value > MAX_SERIES_VALUE) throw new RangeError('Document series exhausted')
  const m = /^\d{2}(\d{2})-(\d{2})$/.exec(financialYear)
  if (!m) throw new RangeError('Financial year must look like 2026-27')
  return `${SERIES_PREFIX[series]}/${m[1]}-${m[2]}/${String(value).padStart(6, '0')}`
}
