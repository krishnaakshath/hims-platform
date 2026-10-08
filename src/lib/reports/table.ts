// Wave I (P1-23): the shape every hospital report returns, and how a cell is
// shown on the page (INR, IST) and written to the CSV (plain rupees, ISO dates).
// Pure and client-safe.
import { formatPaise } from '@/lib/format'
import { formatIsoDate } from '@/lib/india-time'
import { paiseToRupeeString, toCsv, type CsvCell } from '@/lib/rcm/csv'
import type { ReportRange } from '@/lib/reports/range'

/** 'datetime' cells are IST wall-clock strings 'YYYY-MM-DD HH:MM' built in SQL. */
export type ReportColumnKind = 'text' | 'int' | 'paise' | 'date' | 'datetime' | 'decimal' | 'percent'
export interface ReportColumn { label: string; kind: ReportColumnKind }
export type ReportCell = string | number | null
export interface ReportSection {
  title: string
  columns: ReportColumn[]
  rows: ReportCell[][]
  totals?: ReportCell[]
  note?: string
  empty: string
}
export interface ReportResult { sections: ReportSection[]; note?: string }

const DASH = '—'
const oneDecimal = (n: number) => (Math.round(n * 10) / 10).toFixed(1)

export function cellText(kind: ReportColumnKind, v: ReportCell): string {
  if (v === null || v === undefined) return DASH
  switch (kind) {
    case 'paise': return formatPaise(Number(v))
    case 'date': return formatIsoDate(String(v))
    case 'datetime': { const s = String(v); return `${formatIsoDate(s.slice(0, 10))}, ${s.slice(11, 16)}` }
    case 'decimal': return oneDecimal(Number(v))
    case 'percent': return `${oneDecimal(Number(v))}%`
    default: return String(v)
  }
}

export function cellCsv(kind: ReportColumnKind, v: ReportCell): CsvCell {
  if (v === null || v === undefined) return null
  switch (kind) {
    case 'paise': return paiseToRupeeString(Number(v))
    case 'decimal':
    case 'percent': return oneDecimal(Number(v))
    case 'int': return Number(v)
    default: return String(v)
  }
}

/** All sections, each as: title row, header, rows, totals, blank line. Formula-safe (toCsv). */
export function reportCsv(label: string, range: ReportRange, result: ReportResult): string {
  const rows: CsvCell[][] = [[label, range.from, range.to], []]
  for (const s of result.sections) {
    rows.push([s.title], s.columns.map((c) => c.label))
    for (const r of s.rows) rows.push(r.map((v, i) => cellCsv(s.columns[i].kind, v)))
    if (s.totals) rows.push(s.totals.map((v, i) => cellCsv(i === 0 ? 'text' : s.columns[i].kind, v)))
    rows.push([])
  }
  return toCsv(rows)
}
