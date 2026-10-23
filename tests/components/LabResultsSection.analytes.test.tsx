// WS4 T10 (spec 3.7): the patient chart's lab section expands an analyte test into a table of
// analytes with their flags; a single-value test shows as before.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import type { PatientLabOrder } from '@/components/LabResultsSection'
import { LabResultsSection } from '@/components/LabResultsSection'
import { CBC_ANALYTES } from '../lib/labs/report-fixtures'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
afterEach(cleanup)

function order(overrides: Partial<PatientLabOrder> = {}): PatientLabOrder {
  return {
    id: 1, status: 'verified', orderedAt: new Date('2099-03-01T04:00:00Z'), collectedAt: null,
    testId: 1, testName: 'Complete blood count with differential', testCode: 'CBC-DIFF', category: 'lab',
    defaultUnit: null, referenceRange: null, attachments: [],
    result: {
      value: '13 analytes', unit: null, referenceRange: null, flag: 'critical', resultedByName: 'Lab Tech',
      resultedAt: new Date('2099-03-02T08:00:00Z'), notes: null, analytes: CBC_ANALYTES,
    },
    sampleId: null, requisitionId: 1, quotedPricePaise: null, quoteStatus: 'unmapped',
    verifiedByName: 'Dr Path One', verifiedAt: new Date('2099-03-02T10:00:00Z'),
    ...overrides,
  }
}

const section = (orders: PatientLabOrder[]) => render(<LabResultsSection patientId="RD-1" canOrder={false} labTests={[]} orders={orders} />)

describe('LabResultsSection analytes', () => {
  it('starts collapsed and expands to the analyte table with flags and a red Critical chip', () => {
    section([order()])
    expect(screen.queryByRole('table')).toBeNull()
    const toggle = screen.getByRole('button', { name: 'Show 13 analytes' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: 'Hide analytes' })).toHaveAttribute('aria-expanded', 'true')

    const table = screen.getByRole('table', { name: 'Analytes of Complete blood count with differential' })
    const rows = within(table).getAllByRole('row').slice(1) // header row first
    expect(rows).toHaveLength(13)
    expect(rows.map((r) => within(r).getAllByRole('cell')[0].textContent)).toEqual(CBC_ANALYTES.map((a) => a.name))

    const hgb = rows[0]
    expect(within(hgb).getByText('6.5')).toBeInTheDocument()
    expect(within(hgb).getByText('g/dL')).toBeInTheDocument()
    expect(within(hgb).getByText('12.0-15.5 g/dL')).toBeInTheDocument()
    const chip = within(hgb).getByText('Critical')
    expect(chip.className).toMatch(/text-destructive/)
    expect(within(hgb).getByText('Low')).toBeInTheDocument()
    // Normal analytes carry no chip.
    expect(within(rows[1]).queryByText(/Critical|Abnormal/)).toBeNull()
  })

  it('a single-value test has no analyte toggle and shows its value as before', () => {
    section([order({
      testName: 'Glucose, fasting', testCode: 'GLU',
      result: { value: '92', unit: 'mg/dL', referenceRange: '70-110 mg/dL', flag: 'normal', resultedByName: 'Lab Tech', resultedAt: new Date('2099-03-02T08:00:00Z'), notes: null, analytes: [] },
    })])
    expect(screen.queryByRole('button', { name: /analytes/ })).toBeNull()
    expect(screen.getByText(/92 mg\/dL · Reference: 70-110 mg\/dL/)).toBeInTheDocument()
  })
})
