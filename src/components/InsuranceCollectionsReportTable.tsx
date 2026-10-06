'use client'
import { ReportTable, type ReportColumn } from '@/components/ReportTable'
import type { DataGridFilterField } from '@/components/DataGridToolbar'
import { formatCents } from '@/lib/format'

export interface InsuranceCollectionsRow {
  id: number
  patientId: string
  patientName: string
  payerName: string
  status: 'rejected' | 'denied' | 'waiting_adjudication' | 'needs_investigation' | 'paid'
  billedAmountCents: number
  paidAmountCents: number | null
  serviceDate: string
  submittedDate: string
}

const STATUS_LABEL: Record<InsuranceCollectionsRow['status'], string> = {
  rejected: 'Rejected',
  denied: 'Denied',
  waiting_adjudication: 'Waiting for Adjudication',
  needs_investigation: 'Needs Investigation',
  paid: 'Paid',
}

const FILTER_FIELDS: DataGridFilterField[] = [
  { key: 'patientName', label: 'Patient' },
  { key: 'payerName', label: 'Payer' },
  { key: 'status', label: 'Status', options: Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label })) },
  { key: 'serviceDate', label: 'Service Date', inputType: 'date' },
]

const COLUMNS: ReportColumn<InsuranceCollectionsRow>[] = [
  { key: 'patientName', label: 'Patient', render: (r) => r.patientName },
  { key: 'payerName', label: 'Payer', render: (r) => r.payerName },
  { key: 'status', label: 'Status', render: (r) => STATUS_LABEL[r.status] ?? r.status },
  { key: 'billedAmountCents', label: 'Billed Amount', render: (r) => formatCents(r.billedAmountCents) },
  { key: 'paidAmountCents', label: 'Paid Amount', render: (r) => (r.paidAmountCents != null ? formatCents(r.paidAmountCents) : '—') },
  // serviceDate/submittedDate are Drizzle `date` columns (plain strings, not
  // timestamps) -- no Date/string cache-shape hazard here, but still render
  // directly rather than re-parsing through `new Date()` for the same
  // display-consistency reason as the appointments/encounters leaves.
  { key: 'serviceDate', label: 'Service Date', render: (r) => r.serviceDate },
  { key: 'submittedDate', label: 'Submitted', render: (r) => r.submittedDate },
]

function matchesFilters(row: InsuranceCollectionsRow, filters: Record<string, string>): boolean {
  if (filters.patientName && !row.patientName.toLowerCase().includes(filters.patientName.toLowerCase())) return false
  if (filters.payerName && !row.payerName.toLowerCase().includes(filters.payerName.toLowerCase())) return false
  if (filters.status && row.status !== filters.status) return false
  if (filters.serviceDate && row.serviceDate !== filters.serviceDate) return false
  return true
}

export function InsuranceCollectionsReportTable({ rows }: { rows: InsuranceCollectionsRow[] }) {
  const statusCounts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1
    return acc
  }, {})

  return (
    <div>
      <p className="mb-6 text-xs text-muted-foreground">
        {Object.entries(statusCounts).map(([status, count]) => `${STATUS_LABEL[status as InsuranceCollectionsRow['status']] ?? status}: ${count}`).join(' · ') || 'No claims.'}
      </p>
      <ReportTable
        rows={rows}
        columns={COLUMNS}
        filterFields={FILTER_FIELDS}
        matchesFilters={matchesFilters}
        searchFields={['patientName', 'payerName']}
        rowKey={(r) => r.id}
        getRowHref={(r) => `/patients/${r.patientId}`}
      />
    </div>
  )
}
