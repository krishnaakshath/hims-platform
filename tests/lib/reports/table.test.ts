import { describe, it, expect } from 'vitest'
import { cellCsv, cellText, reportCsv, type ReportResult } from '@/lib/reports/table'

// Wave I (P1-23): one report shape drives both the page table and the CSV.
describe('report cells', () => {
  it('shows money in INR on the page and as plain rupees in the CSV', () => {
    expect(cellText('paise', 1234567)).toBe('₹12,345.67')
    expect(cellCsv('paise', 1234567)).toBe('12345.67')
    expect(cellCsv('paise', -50)).toBe('-0.50')
  })

  it('shows IST dates and date-times without any zone shift', () => {
    expect(cellText('date', '2026-10-08')).toBe('8 Oct 2026')
    expect(cellCsv('date', '2026-10-08')).toBe('2026-10-08')
    expect(cellText('datetime', '2026-10-08 14:05')).toBe('8 Oct 2026, 14:05')
    expect(cellCsv('datetime', '2026-10-08 14:05')).toBe('2026-10-08 14:05')
  })

  it('shows one decimal for decimals and percentages, and a dash for null', () => {
    expect(cellText('decimal', 2.25)).toBe('2.3')
    expect(cellCsv('decimal', 2)).toBe('2.0')
    expect(cellText('percent', 66.666)).toBe('66.7%')
    expect(cellCsv('percent', 66.666)).toBe('66.7')
    expect(cellText('int', null)).toBe('—')
    expect(cellCsv('int', null)).toBeNull()
    expect(cellText('int', 42)).toBe('42')
    expect(cellText('text', 'General Medicine')).toBe('General Medicine')
  })
})

describe('reportCsv', () => {
  const result: ReportResult = {
    sections: [
      {
        title: 'By department',
        columns: [{ label: 'Department', kind: 'text' }, { label: 'Visits', kind: 'int' }, { label: 'Revenue', kind: 'paise' }],
        rows: [['=HYPERLINK("x")', 3, 150000]],
        totals: ['Total', 3, 150000],
        empty: 'None',
      },
      { title: 'By day', columns: [{ label: 'Date', kind: 'date' }, { label: 'Visits', kind: 'int' }], rows: [], empty: 'None' },
    ],
  }

  it('writes every section with its title row, header, rows and totals; formula-safe', () => {
    expect(reportCsv('OPD statistics', { from: '2026-10-01', to: '2026-10-08' }, result)).toBe([
      'OPD statistics,2026-10-01,2026-10-08',
      '',
      'By department',
      'Department,Visits,Revenue',
      `"'=HYPERLINK(""x"")",3,1500.00`,
      'Total,3,1500.00',
      '',
      'By day',
      'Date,Visits',
      '',
    ].map((l) => `${l}\r\n`).join(''))
  })
})
