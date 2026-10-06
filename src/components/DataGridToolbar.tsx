'use client'
import { useMemo, useState } from 'react'

export interface DataGridFilterFieldOption {
  value: string
  label: string
}

export interface DataGridFilterField {
  key: string
  label: string
  /** Omit for a free-text filter input; provide for a fixed-choice select. */
  options?: DataGridFilterFieldOption[]
  /** Native input type for a free-text filter (ignored when `options` is set). Defaults to 'text'. */
  inputType?: 'text' | 'date'
}

export interface DataGridColumn {
  key: string
  label: string
}

export interface DataGridToolbarProps {
  searchValue: string
  onSearchChange: (value: string) => void
  searchPlaceholder?: string
  onRefresh: () => void
  filterFields: DataGridFilterField[]
  activeFilters: Record<string, string>
  onFilterChange: (key: string, value: string) => void
  onClearFilters: () => void
  columns: DataGridColumn[]
  visibleColumnKeys: string[]
  onToggleColumn: (key: string) => void
}

/**
 * Shared enterprise-grade list-view toolbar (search, refresh, filter with a
 * searchable "Add a filter" slide-out panel and an active-filter-count badge,
 * and a Columns visibility checklist). Modeled on the toolbar pattern common
 * to enterprise data-grid and reporting modules.
 * Deliberately excludes a density picker, column pinning, and drag-and-drop
 * column reorder — see architecture spec §6: those are enterprise-scale
 * controls that add real complexity for zero benefit at this app's actual
 * data scale (dozens of records, not 300k+).
 */
export function DataGridToolbar({
  searchValue,
  onSearchChange,
  searchPlaceholder = 'Search...',
  onRefresh,
  filterFields,
  activeFilters,
  onFilterChange,
  onClearFilters,
  columns,
  visibleColumnKeys,
  onToggleColumn,
}: DataGridToolbarProps) {
  const [filterPanelOpen, setFilterPanelOpen] = useState(false)
  const [columnsPanelOpen, setColumnsPanelOpen] = useState(false)
  const [fieldSearch, setFieldSearch] = useState('')

  const activeFilterCount = Object.values(activeFilters).filter((v) => v && v.length > 0).length

  const visibleFilterFields = useMemo(
    () => filterFields.filter((f) => f.label.toLowerCase().includes(fieldSearch.toLowerCase())),
    [filterFields, fieldSearch],
  )

  return (
    <div className="relative mb-4 flex flex-wrap items-center gap-2">
      <div className="relative">
        <input
          type="text"
          value={searchValue}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={searchPlaceholder}
          aria-label="Search"
          className="w-64 rounded-md border border-border bg-card px-3 py-2 pr-8 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
        />
        {searchValue.length > 0 && (
          <button
            type="button"
            onClick={() => onSearchChange('')}
            aria-label="Clear search"
            className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            ×
          </button>
        )}
      </div>

      <button
        type="button"
        onClick={onRefresh}
        className="rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-secondary active:bg-secondary/80 focus:outline-none focus:ring-2 focus:ring-ring"
      >
        Refresh
      </button>

      <div className="relative">
        <button
          type="button"
          onClick={() => {
            setFilterPanelOpen((v) => !v)
            setColumnsPanelOpen(false)
          }}
          aria-expanded={filterPanelOpen}
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-secondary active:bg-secondary/80 focus:outline-none focus:ring-2 focus:ring-ring"
        >
          Filter
          {activeFilterCount > 0 && (
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-xs font-semibold text-accent-foreground">
              {activeFilterCount}
            </span>
          )}
        </button>
        {filterPanelOpen && (
          <div className="absolute right-0 top-full z-20 mt-2 w-80 rounded-lg border border-border bg-card p-4 shadow-lg">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Add a filter</h3>
              {activeFilterCount > 0 && (
                <button
                  type="button"
                  onClick={onClearFilters}
                  className="text-xs font-medium text-primary transition-colors hover:underline focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  Clear filters
                </button>
              )}
            </div>
            <input
              type="text"
              value={fieldSearch}
              onChange={(e) => setFieldSearch(e.target.value)}
              placeholder="Search fields..."
              aria-label="Search filter fields"
              className="mb-3 w-full rounded-md border border-border px-2 py-1.5 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="max-h-72 space-y-3 overflow-auto">
              {visibleFilterFields.map((field) => (
                <div key={field.key}>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">{field.label}</label>
                  {field.options ? (
                    <select
                      value={activeFilters[field.key] ?? ''}
                      onChange={(e) => onFilterChange(field.key, e.target.value)}
                      className="w-full rounded-md border border-border px-2 py-1.5 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
                    >
                      <option value="">All</option>
                      {field.options.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={field.inputType ?? 'text'}
                      value={activeFilters[field.key] ?? ''}
                      onChange={(e) => onFilterChange(field.key, e.target.value)}
                      className="w-full rounded-md border border-border px-2 py-1.5 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  )}
                </div>
              ))}
              {visibleFilterFields.length === 0 && <p className="text-sm text-muted-foreground">No matching fields.</p>}
            </div>
          </div>
        )}
      </div>

      <div className="relative">
        <button
          type="button"
          onClick={() => {
            setColumnsPanelOpen((v) => !v)
            setFilterPanelOpen(false)
          }}
          aria-expanded={columnsPanelOpen}
          className="rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-secondary active:bg-secondary/80 focus:outline-none focus:ring-2 focus:ring-ring"
        >
          Columns
        </button>
        {columnsPanelOpen && (
          <div className="absolute right-0 top-full z-20 mt-2 w-56 rounded-lg border border-border bg-card p-3 shadow-lg">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Show columns</h3>
            <div className="space-y-1.5">
              {columns.map((col) => (
                <label
                  key={col.key}
                  className="flex items-center gap-2 rounded px-1 py-0.5 text-sm text-foreground transition-colors hover:bg-secondary"
                >
                  <input type="checkbox" checked={visibleColumnKeys.includes(col.key)} onChange={() => onToggleColumn(col.key)} />
                  {col.label}
                </label>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
