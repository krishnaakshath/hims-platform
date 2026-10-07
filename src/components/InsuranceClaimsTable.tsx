'use client'
import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { DataGridToolbar, type DataGridFilterField, type DataGridColumn } from '@/components/DataGridToolbar'
import { formatPaise } from '@/lib/format'

type Claim = {
  id: number
  patientId: string
  patientName: string
  payerName: string
  billedAmountCents: number
  paidAmountCents: number | null
  status: 'rejected' | 'denied' | 'waiting_adjudication' | 'needs_investigation' | 'paid'
  submittedDate: string
  dateOfService: string
}

const STATUS_LABELS: Record<Claim['status'], string> = {
  rejected: 'Rejected',
  denied: 'Denied',
  waiting_adjudication: 'Waiting for Adjudication',
  needs_investigation: 'Needs Investigation',
  paid: 'Paid',
}

// Design-token dots only -- same --success/--warning/--destructive token
// classes ChargesTable's STATUS_DOT uses, never hardcoded emerald/amber/red.
const STATUS_DOT: Record<Claim['status'], string> = {
  rejected: 'bg-destructive',
  denied: 'bg-destructive',
  waiting_adjudication: 'bg-warning',
  needs_investigation: 'bg-warning',
  paid: 'bg-success',
}

// Same elevated-card treatment ReportTable.tsx and the rest of the app's
// data surfaces already use.
const SECTION = 'rounded-xl border border-primary/10 bg-card/80 p-5 shadow-sm backdrop-blur-sm'

const TABS: { key: 'all' | Claim['status']; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'denied', label: 'Denied' },
  { key: 'waiting_adjudication', label: 'Waiting for Adjudication' },
  { key: 'needs_investigation', label: 'Needs Investigation' },
]

const COLUMNS: DataGridColumn[] = [
  { key: 'dateOfService', label: 'Date of Service' },
  { key: 'patient', label: 'Patient' },
  { key: 'payer', label: 'Payer' },
  { key: 'status', label: 'Status' },
  { key: 'billed', label: 'Billed' },
  { key: 'paid', label: 'Paid' },
]

export function InsuranceClaimsTable({ claims, linkPatients = true }: { claims: Claim[]; linkPatients?: boolean }) {
  const router = useRouter()
  const [tab, setTab] = useState<'all' | Claim['status']>('all')
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [visibleColumns, setVisibleColumns] = useState<string[]>(COLUMNS.map((c) => c.key))

  const payers = [...new Set(claims.map((c) => c.payerName))]
  const filterFields: DataGridFilterField[] = [
    { key: 'payer', label: 'Payer', options: payers.map((p) => ({ value: p, label: p })) },
  ]

  // `paid` claims are intentionally excluded from every tab except "All" --
  // a paid claim has left the collections workflow. TABS above never
  // includes a 'paid' entry, so this filter is the only place that matters.
  const visibleClaims = (tab === 'all' ? claims : claims.filter((c) => c.status === tab)).filter((c) => {
    if (filters.payer && c.payerName !== filters.payer) return false
    if (search && !`${c.patientName} ${c.patientId} ${c.payerName}`.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const show = (key: string) => visibleColumns.includes(key)

  return (
    <div className={SECTION}>
      <div className="mb-4 flex gap-1 rounded-lg bg-secondary p-1 text-sm">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`rounded-md px-3 py-1.5 font-medium transition-colors ${tab === t.key ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <DataGridToolbar
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search patient or payer..."
        onRefresh={() => router.refresh()}
        filterFields={filterFields}
        activeFilters={filters}
        onFilterChange={(key, value) => setFilters({ ...filters, [key]: value })}
        onClearFilters={() => setFilters({})}
        columns={COLUMNS}
        visibleColumnKeys={visibleColumns}
        onToggleColumn={(key) => setVisibleColumns((cols) => (cols.includes(key) ? cols.filter((c) => c !== key) : [...cols, key]))}
      />

      {visibleClaims.length === 0 ? (
        <p className="mt-6 rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No records found.</p>
      ) : (
        <div className="mt-4 overflow-hidden rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-secondary/40 text-left">
                {show('dateOfService') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Date of Service</th>}
                {show('patient') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Patient</th>}
                {show('payer') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Payer</th>}
                {show('status') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</th>}
                {show('billed') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Billed</th>}
                {show('paid') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Paid</th>}
              </tr>
            </thead>
            <tbody>
              {visibleClaims.map((c, i) => (
                <tr key={c.id} className={`border-b border-border last:border-b-0 ${i % 2 === 1 ? 'bg-muted/40' : ''} transition-colors hover:bg-secondary`}>
                  {show('dateOfService') && <td className="p-3 text-foreground">{c.dateOfService}</td>}
                  {show('patient') && <td className="p-3">{linkPatients ? <Link href={`/patients/${c.patientId}`} className="font-medium text-primary hover:underline">{c.patientName}</Link> : <span className="font-medium text-foreground">{c.patientName}</span>}</td>}
                  {show('payer') && <td className="p-3 text-foreground">{c.payerName}</td>}
                  {show('status') && (
                    <td className="p-3">
                      <span className="inline-flex items-center gap-1.5 text-foreground">
                        <span className={`h-2 w-2 rounded-full ${STATUS_DOT[c.status]}`} aria-hidden="true" />
                        {STATUS_LABELS[c.status]}
                      </span>
                    </td>
                  )}
                  {show('billed') && <td className="p-3 text-foreground">{formatPaise(c.billedAmountCents)}</td>}
                  {show('paid') && <td className="p-3 text-foreground">{c.paidAmountCents === null ? '—' : formatPaise(c.paidAmountCents)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-muted-foreground">{visibleClaims.length} record{visibleClaims.length === 1 ? '' : 's'}</p>
    </div>
  )
}
