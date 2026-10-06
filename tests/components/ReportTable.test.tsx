import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ReportTable, type ReportColumn } from '@/components/ReportTable'
import type { DataGridFilterField } from '@/components/DataGridToolbar'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

// Mocks the REAL DataGridToolbar interface (searchValue/onSearchChange plus
// a filter select) rather than the plan's originally-assumed
// filterCount/onOpenFilters shape -- see the schema-reconciliation doc.
vi.mock('@/components/DataGridToolbar', () => ({
  DataGridToolbar: ({
    searchValue, onSearchChange, filterFields, activeFilters, onFilterChange,
  }: {
    searchValue: string
    onSearchChange: (v: string) => void
    filterFields: { key: string; label: string }[]
    activeFilters: Record<string, string>
    onFilterChange: (key: string, value: string) => void
  }) => (
    <div>
      <input aria-label="toolbar-search" value={searchValue} onChange={(e) => onSearchChange(e.target.value)} />
      {filterFields.map((f) => (
        <input
          key={f.key}
          aria-label={`filter-${f.key}`}
          value={activeFilters[f.key] ?? ''}
          onChange={(e) => onFilterChange(f.key, e.target.value)}
        />
      ))}
    </div>
  ),
}))

interface Row { id: number; name: string; status: 'active' | 'inactive' }

const ROWS: Row[] = [
  { id: 1, name: 'Alpha', status: 'active' },
  { id: 2, name: 'Beta', status: 'inactive' },
]
const COLUMNS: ReportColumn<Row>[] = [{ key: 'name', label: 'Name', render: (r) => r.name }]
const FILTER_FIELDS: DataGridFilterField[] = [{ key: 'status', label: 'Status', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }] }]

describe('ReportTable', () => {
  it('renders all rows with no search or filter applied', () => {
    render(<ReportTable rows={ROWS} columns={COLUMNS} filterFields={FILTER_FIELDS} searchFields={['name']} rowKey={(r) => r.id} />)
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
  })

  it('filters rows down via the search box', () => {
    render(<ReportTable rows={ROWS} columns={COLUMNS} filterFields={FILTER_FIELDS} searchFields={['name']} rowKey={(r) => r.id} />)
    fireEvent.change(screen.getByLabelText('toolbar-search'), { target: { value: 'Alpha' } })
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.queryByText('Beta')).not.toBeInTheDocument()
  })

  it('filters rows down via a caller-supplied matchesFilters predicate against DataGridToolbar-shaped activeFilters', () => {
    render(
      <ReportTable
        rows={ROWS}
        columns={COLUMNS}
        filterFields={FILTER_FIELDS}
        matchesFilters={(row, filters) => !filters.status || row.status === filters.status}
        searchFields={['name']}
        rowKey={(r) => r.id}
      />
    )
    fireEvent.change(screen.getByLabelText('filter-status'), { target: { value: 'active' } })
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.queryByText('Beta')).not.toBeInTheDocument()
  })

  it('shows the plain-text empty state when nothing matches', () => {
    render(<ReportTable rows={ROWS} columns={COLUMNS} filterFields={FILTER_FIELDS} searchFields={['name']} rowKey={(r) => r.id} />)
    fireEvent.change(screen.getByLabelText('toolbar-search'), { target: { value: 'zzz' } })
    expect(screen.getByText('No results found.')).toBeInTheDocument()
  })
})
