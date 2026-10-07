'use client'
import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { DataGridToolbar, type DataGridColumn } from '@/components/DataGridToolbar'
import { formatCents } from '@/lib/format'

type Row = { patientId: string; patientName: string; balanceCents: number; unappliedCents: number }

// Same elevated-card treatment ReportTable.tsx and the rest of the app's
// data surfaces already use.
const SECTION = 'rounded-xl border border-primary/10 bg-card/80 p-5 shadow-sm backdrop-blur-sm'

const COLUMNS: DataGridColumn[] = [
  { key: 'patient', label: 'Patient' },
  { key: 'balance', label: 'Balance' },
  { key: 'unapplied', label: 'Unapplied' },
  { key: 'actions', label: 'Actions' },
]

// showCollectPayment (Wave B P1-21): the action opens the demo card form, so
// the page passes demoFeaturesEnabled().
export function PatientCollectionsTable({ rows, linkPatients = true, showCollectPayment = true }: { rows: Row[]; linkPatients?: boolean; showCollectPayment?: boolean }) {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [visibleColumns, setVisibleColumns] = useState<string[]>(COLUMNS.map((c) => c.key))

  const filtered = rows.filter((r) => !search || `${r.patientName} ${r.patientId}`.toLowerCase().includes(search.toLowerCase()))
  const show = (key: string) => visibleColumns.includes(key)

  return (
    <div className={SECTION}>
      <DataGridToolbar
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search patient..."
        onRefresh={() => router.refresh()}
        filterFields={[]}
        activeFilters={{}}
        onFilterChange={() => {}}
        onClearFilters={() => {}}
        columns={COLUMNS}
        visibleColumnKeys={visibleColumns}
        onToggleColumn={(key) => setVisibleColumns((cols) => (cols.includes(key) ? cols.filter((c) => c !== key) : [...cols, key]))}
      />

      {filtered.length === 0 ? (
        <p className="mt-6 rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No records found.</p>
      ) : (
        <div className="mt-4 overflow-hidden rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-secondary/40 text-left">
                {show('patient') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Patient</th>}
                {show('balance') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Balance</th>}
                {show('unapplied') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Unapplied</th>}
                {show('actions') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => (
                <tr key={r.patientId} className={`border-b border-border last:border-b-0 ${i % 2 === 1 ? 'bg-muted/40' : ''} transition-colors hover:bg-secondary`}>
                  {show('patient') && <td className="p-3">{linkPatients ? <Link href={`/patients/${r.patientId}`} className="font-medium text-primary hover:underline">{r.patientName} ({r.patientId})</Link> : <span className="font-medium text-foreground">{r.patientName} ({r.patientId})</span>}</td>}
                  {show('balance') && <td className="p-3 text-foreground">{formatCents(r.balanceCents)}</td>}
                  {show('unapplied') && <td className="p-3 text-foreground">{r.unappliedCents > 0 ? formatCents(r.unappliedCents) : '—'}</td>}
                  {show('actions') && (
                    <td className="p-3">
                      {showCollectPayment && r.balanceCents > 0 ? (
                        <Link
                          href={`/billing/pay?patientId=${r.patientId}&amountCents=${r.balanceCents}`}
                          className="rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-secondary"
                        >
                          Collect Payment
                        </Link>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-muted-foreground">{filtered.length} patient{filtered.length === 1 ? '' : 's'} with an outstanding balance or unapplied credit</p>
    </div>
  )
}
