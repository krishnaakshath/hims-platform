'use client'
import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { DataGridToolbar, type DataGridFilterField, type DataGridColumn } from '@/components/DataGridToolbar'
import { formatCents } from '@/lib/format'

type Statement = {
  id: number
  patientId: string
  patientName: string
  amountCents: number
  deliveryMethod: 'email' | 'sms' | 'paper'
  type: 'initial' | 'reminder' | 'final_notice'
  deliveryStatus: 'delivered' | 'failed'
  sentDate: string
}

const DELIVERY_LABELS: Record<Statement['deliveryMethod'], string> = { email: 'Email', sms: 'SMS', paper: 'Paper' }
const TYPE_LABELS: Record<Statement['type'], string> = { initial: 'Initial', reminder: 'Reminder', final_notice: 'Final Notice' }
const STATUS_LABELS: Record<Statement['deliveryStatus'], string> = { delivered: 'Delivered', failed: 'Failed' }
const STATUS_DOT: Record<Statement['deliveryStatus'], string> = { delivered: 'bg-success', failed: 'bg-destructive' }

// Same elevated-card treatment ReportTable.tsx and the rest of the app's
// data surfaces already use.
const SECTION = 'rounded-xl border border-primary/10 bg-card/80 p-5 shadow-sm backdrop-blur-sm'

const COLUMNS: DataGridColumn[] = [
  { key: 'sentDate', label: 'Sent' },
  { key: 'patient', label: 'Patient' },
  { key: 'amount', label: 'Amount' },
  { key: 'delivery', label: 'Delivery' },
  { key: 'type', label: 'Type' },
  { key: 'status', label: 'Status' },
]

const FILTER_FIELDS: DataGridFilterField[] = [
  { key: 'delivery', label: 'Delivery', options: Object.entries(DELIVERY_LABELS).map(([value, label]) => ({ value, label })) },
  { key: 'type', label: 'Type', options: Object.entries(TYPE_LABELS).map(([value, label]) => ({ value, label })) },
  { key: 'sentAfter', label: 'Sent after', inputType: 'date' },
  { key: 'sentBefore', label: 'Sent before', inputType: 'date' },
]

export function PatientStatementsTable({ statements, linkPatients = true }: { statements: Statement[]; linkPatients?: boolean }) {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [visibleColumns, setVisibleColumns] = useState<string[]>(COLUMNS.map((c) => c.key))

  const filtered = statements.filter((s) => {
    if (filters.delivery && s.deliveryMethod !== filters.delivery) return false
    if (filters.type && s.type !== filters.type) return false
    if (filters.sentAfter && s.sentDate < filters.sentAfter) return false
    if (filters.sentBefore && s.sentDate > filters.sentBefore) return false
    if (search && !s.patientName.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const show = (key: string) => visibleColumns.includes(key)

  return (
    <div className={SECTION}>
      <DataGridToolbar
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search patient..."
        onRefresh={() => router.refresh()}
        filterFields={FILTER_FIELDS}
        activeFilters={filters}
        onFilterChange={(key, value) => setFilters({ ...filters, [key]: value })}
        onClearFilters={() => setFilters({})}
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
                {show('sentDate') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sent</th>}
                {show('patient') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Patient</th>}
                {show('amount') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Amount</th>}
                {show('delivery') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Delivery</th>}
                {show('type') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Type</th>}
                {show('status') && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((s, i) => (
                <tr key={s.id} className={`border-b border-border last:border-b-0 ${i % 2 === 1 ? 'bg-muted/40' : ''} transition-colors hover:bg-secondary`}>
                  {show('sentDate') && <td className="p-3 text-foreground">{new Date(s.sentDate).toLocaleDateString()}</td>}
                  {show('patient') && <td className="p-3">{linkPatients ? <Link href={`/patients/${s.patientId}`} className="font-medium text-primary hover:underline">{s.patientName}</Link> : <span className="font-medium text-foreground">{s.patientName}</span>}</td>}
                  {show('amount') && <td className="p-3 text-foreground">{formatCents(s.amountCents)}</td>}
                  {show('delivery') && <td className="p-3 text-foreground">{DELIVERY_LABELS[s.deliveryMethod]}</td>}
                  {show('type') && <td className="p-3 text-foreground">{TYPE_LABELS[s.type]}</td>}
                  {show('status') && (
                    <td className="p-3">
                      <span className="inline-flex items-center gap-1.5 text-foreground">
                        <span className={`h-2 w-2 rounded-full ${STATUS_DOT[s.deliveryStatus]}`} aria-hidden="true" />
                        {STATUS_LABELS[s.deliveryStatus]}
                      </span>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-muted-foreground">{filtered.length} of {statements.length} statement{statements.length === 1 ? '' : 's'}</p>
    </div>
  )
}
