'use client'
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { DataGridToolbar, type DataGridFilterField, type DataGridColumn } from '@/components/DataGridToolbar'
import { NewChargeModal } from '@/components/NewChargeModal'
import { formatCents } from '@/lib/format'
import { CHARGE_STATUS_LABELS, nextStatusActions, type ChargeStatus } from '@/lib/charge-status'

type Charge = {
  id: number
  patientId: string
  patientName: string
  providerName: string
  dateOfService: string
  amountCents: number
  status: ChargeStatus
}

const STATUS_LABELS = CHARGE_STATUS_LABELS

const STATUS_DOT: Record<ChargeStatus, string> = {
  draft: 'bg-muted-foreground',
  pending_approval: 'bg-warning',
  approved: 'bg-primary',
  submitted: 'bg-success',
}

// Same elevated-card treatment ReportTable.tsx and the rest of the app's
// data surfaces already use -- this table predates that convention and
// never got the same card/border wrapper, leaving it looking flat next to
// every other page.
const SECTION = 'rounded-xl border border-primary/10 bg-card/80 p-5 shadow-sm backdrop-blur-sm'

const COLUMNS: DataGridColumn[] = [
  { key: 'dateOfService', label: 'Date' },
  { key: 'patient', label: 'Patient' },
  { key: 'provider', label: 'Provider' },
  { key: 'status', label: 'Status' },
  { key: 'amount', label: 'Amount' },
  { key: 'actions', label: 'Actions' },
]

export function ChargesTable({ charges, patients }: { charges: Charge[]; patients: { id: string; name: string }[] }) {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [visibleColumns, setVisibleColumns] = useState<string[]>(COLUMNS.map((c) => c.key))
  const [pending, setPending] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const providers = useMemo(() => [...new Set(charges.map((c) => c.providerName))], [charges])
  const filterFields: DataGridFilterField[] = [
    { key: 'status', label: 'Status', options: Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })) },
    { key: 'provider', label: 'Provider', options: providers.map((p) => ({ value: p, label: p })) },
  ]

  const filtered = charges.filter((c) => {
    if (filters.status && c.status !== filters.status) return false
    if (filters.provider && c.providerName !== filters.provider) return false
    if (search && !`${c.patientName} ${c.patientId} ${c.providerName}`.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  async function advance(chargeId: number, nextStatus: Charge['status']) {
    setPending(chargeId)
    setError(null)
    const res = await fetch(`/api/charges/${chargeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: nextStatus }),
    })
    setPending(null)
    if (res.ok) {
      router.refresh()
    } else {
      const body = await res.json()
      setError(body.error ?? 'Could not update this charge.')
    }
  }

  const show = (key: string) => visibleColumns.includes(key)

  return (
    <div className={SECTION}>
      <div className="mb-4 flex items-center justify-between">
        <DataGridToolbar
          searchValue={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search patient or provider..."
          onRefresh={() => router.refresh()}
          filterFields={filterFields}
          activeFilters={filters}
          onFilterChange={(key, value) => setFilters({ ...filters, [key]: value })}
          onClearFilters={() => setFilters({})}
          columns={COLUMNS}
          visibleColumnKeys={visibleColumns}
          onToggleColumn={(key) => setVisibleColumns((cols) => (cols.includes(key) ? cols.filter((c) => c !== key) : [...cols, key]))}
        />
        <NewChargeModal patients={patients} />
      </div>

      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}

      {filtered.length === 0 ? (
        <p className="mt-6 rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No records found.</p>
      ) : (
        <div className="mt-4 overflow-hidden rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-secondary/40 text-left">
                {show('dateOfService') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Date</th>}
                {show('patient') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Patient</th>}
                {show('provider') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Provider</th>}
                {show('status') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</th>}
                {show('amount') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Amount</th>}
                {show('actions') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((c, i) => (
                <tr key={c.id} className={`border-b border-border last:border-b-0 ${i % 2 === 1 ? 'bg-muted/40' : ''} transition-colors hover:bg-secondary`}>
                  {show('dateOfService') && <td className="p-3 text-foreground">{c.dateOfService}</td>}
                  {show('patient') && <td className="p-3"><Link href={`/billing/charges/${c.id}`} className="font-medium text-primary hover:underline">{c.patientName}</Link></td>}
                  {show('provider') && <td className="p-3 text-foreground">{c.providerName}</td>}
                  {show('status') && (
                    <td className="p-3">
                      <span className="inline-flex items-center gap-1.5 text-foreground">
                        <span className={`h-2 w-2 rounded-full ${STATUS_DOT[c.status]}`} aria-hidden="true" />
                        {STATUS_LABELS[c.status]}
                      </span>
                    </td>
                  )}
                  {show('amount') && <td className="p-3 text-foreground">{formatCents(c.amountCents)}</td>}
                  {show('actions') && (
                    <td className="p-3">
                      <div className="flex gap-2">
                        {nextStatusActions(c.status).map((action) => (
                          <button
                            key={action.next}
                            type="button"
                            disabled={pending === c.id}
                            onClick={() => advance(c.id, action.next)}
                            className="rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-secondary disabled:opacity-50"
                          >
                            {action.label}
                          </button>
                        ))}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-muted-foreground">{filtered.length} of {charges.length} charge{charges.length === 1 ? '' : 's'}</p>
    </div>
  )
}
