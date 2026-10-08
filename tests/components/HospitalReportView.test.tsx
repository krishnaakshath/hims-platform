import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { HospitalReportView } from '@/components/reports/HospitalReportView'
import { hospitalReport } from '@/lib/reports/catalog'

// Wave I (P1-23): the report body shows INR and IST, totals, the empty text and an audited CSV link for the same range.
describe('HospitalReportView', () => {
  const result = {
    note: 'Finalised invoices only.',
    sections: [
      { title: 'By department', columns: [{ label: 'Department', kind: 'text' as const }, { label: 'Total', kind: 'paise' as const }], rows: [['Cardiology', 12345600]], totals: ['Total', 12345600], empty: 'None' },
      { title: 'By day', columns: [{ label: 'Date', kind: 'date' as const }, { label: 'Total', kind: 'paise' as const }], rows: [], empty: 'No finalised invoices in this period.' },
    ],
  }

  it('renders sections with INR amounts, IST dates and a CSV link for the range', () => {
    render(<HospitalReportView def={hospitalReport('department-revenue')!} range={{ from: '2026-10-01', to: '2026-10-08' }} problem={null} result={result} />)
    expect(screen.getByRole('heading', { name: 'Department revenue' })).toBeInTheDocument()
    expect(screen.getByText('1 Oct 2026 to 8 Oct 2026 (IST).')).toBeInTheDocument()
    const table = screen.getByRole('table')
    expect(within(table).getAllByText('₹1,23,456.00')).toHaveLength(2)
    expect(screen.getByText('No finalised invoices in this period.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Download CSV' })).toHaveAttribute('href', '/api/reports/department-revenue/csv?from=2026-10-01&to=2026-10-08')
  })

  it('names a bad range and offers a single date for the tariff', () => {
    render(<HospitalReportView def={hospitalReport('tariff')!} range={{ from: '2026-10-08', to: '2026-10-08' }} problem="Choose a valid date range" result={{ sections: [] }} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a valid date range; showing today.')
    expect(screen.getByLabelText('As of')).toHaveValue('2026-10-08')
    expect(screen.queryByLabelText('From')).not.toBeInTheDocument()
  })
})
