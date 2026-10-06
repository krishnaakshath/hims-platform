import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DataGridToolbar } from '@/components/DataGridToolbar'

const filterFields = [
  { key: 'status', label: 'Status', options: [{ value: 'draft', label: 'Draft' }] },
  { key: 'provider', label: 'Provider' },
]
const columns = [{ key: 'patient', label: 'Patient' }, { key: 'amount', label: 'Amount' }]

describe('DataGridToolbar', () => {
  it('calls onSearchChange as the user types', () => {
    const onSearchChange = vi.fn()
    render(
      <DataGridToolbar
        searchValue="" onSearchChange={onSearchChange} onRefresh={() => {}}
        filterFields={[]} activeFilters={{}} onFilterChange={() => {}} onClearFilters={() => {}}
        columns={columns} visibleColumnKeys={['patient', 'amount']} onToggleColumn={() => {}}
      />,
    )
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'RD-0001' } })
    expect(onSearchChange).toHaveBeenCalledWith('RD-0001')
  })

  it('shows the active-filter-count badge only when a filter is set', () => {
    const { rerender } = render(
      <DataGridToolbar
        searchValue="" onSearchChange={() => {}} onRefresh={() => {}}
        filterFields={filterFields} activeFilters={{}} onFilterChange={() => {}} onClearFilters={() => {}}
        columns={columns} visibleColumnKeys={['patient', 'amount']} onToggleColumn={() => {}}
      />,
    )
    expect(screen.queryByText('1')).not.toBeInTheDocument()
    rerender(
      <DataGridToolbar
        searchValue="" onSearchChange={() => {}} onRefresh={() => {}}
        filterFields={filterFields} activeFilters={{ status: 'draft' }} onFilterChange={() => {}} onClearFilters={() => {}}
        columns={columns} visibleColumnKeys={['patient', 'amount']} onToggleColumn={() => {}}
      />,
    )
    expect(screen.getByText('1')).toBeInTheDocument()
  })

  it('opens the filter panel and lets the user pick a filterable field, and toggles a column', () => {
    const onToggleColumn = vi.fn()
    render(
      <DataGridToolbar
        searchValue="" onSearchChange={() => {}} onRefresh={() => {}}
        filterFields={filterFields} activeFilters={{}} onFilterChange={() => {}} onClearFilters={() => {}}
        columns={columns} visibleColumnKeys={['patient']} onToggleColumn={onToggleColumn}
      />,
    )
    fireEvent.click(screen.getByText('Filter'))
    expect(screen.getByText('Add a filter')).toBeInTheDocument()
    expect(screen.getByText('Provider')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Columns'))
    fireEvent.click(screen.getByLabelText('Amount'))
    expect(onToggleColumn).toHaveBeenCalledWith('amount')
  })
})
