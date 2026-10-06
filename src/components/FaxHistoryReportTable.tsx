'use client'
import { ReportTable, type ReportColumn } from '@/components/ReportTable'
import type { DataGridFilterField } from '@/components/DataGridToolbar'

export interface FaxReportRow {
  id: number
  faxDate: string
  subject: string
  documentsIncluded: string
  deliveryStatus: 'delivered' | 'failed'
  sender: string
  sentToFaxNumber: string
  patientId: string | null
  patientName: string | null
  patientDob: string | null
}

const STATUS_TEXT: Record<FaxReportRow['deliveryStatus'], string> = { delivered: 'Delivered', failed: 'Failed' }
const STATUS_DOT: Record<FaxReportRow['deliveryStatus'], string> = { delivered: 'bg-success', failed: 'bg-destructive' }

const FILTER_FIELDS: DataGridFilterField[] = [
  { key: 'subject', label: 'Subject' },
  { key: 'deliveryStatus', label: 'Delivery Status', options: Object.entries(STATUS_TEXT).map(([value, label]) => ({ value, label })) },
  { key: 'sender', label: 'Sender' },
  { key: 'sentToFaxNumber', label: 'Sent To' },
  { key: 'patientName', label: 'Patient' },
]

const COLUMNS: ReportColumn<FaxReportRow>[] = [
  { key: 'faxDate', label: 'Date', render: (f) => new Date(f.faxDate).toLocaleString() },
  { key: 'subject', label: 'Message Subject', render: (f) => f.subject },
  { key: 'documentsIncluded', label: 'Document(s) Included', render: (f) => f.documentsIncluded },
  {
    key: 'deliveryStatus',
    label: 'Delivery Status',
    render: (f) => (
      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground">
        <span className={`h-2 w-2 rounded-full ${STATUS_DOT[f.deliveryStatus]}`} aria-hidden="true" />
        {STATUS_TEXT[f.deliveryStatus]}
      </span>
    ),
  },
  { key: 'sender', label: 'Sender', render: (f) => f.sender },
  { key: 'sentToFaxNumber', label: 'Sent To', render: (f) => f.sentToFaxNumber },
  { key: 'patientName', label: 'Patient', render: (f) => (f.patientName ? `${f.patientName}${f.patientDob ? ` (DOB ${f.patientDob})` : ''}` : '—') },
]

function matchesFilters(row: FaxReportRow, filters: Record<string, string>): boolean {
  if (filters.subject && !row.subject.toLowerCase().includes(filters.subject.toLowerCase())) return false
  if (filters.deliveryStatus && row.deliveryStatus !== filters.deliveryStatus) return false
  if (filters.sender && !row.sender.toLowerCase().includes(filters.sender.toLowerCase())) return false
  if (filters.sentToFaxNumber && !row.sentToFaxNumber.toLowerCase().includes(filters.sentToFaxNumber.toLowerCase())) return false
  if (filters.patientName && !(row.patientName ?? '').toLowerCase().includes(filters.patientName.toLowerCase())) return false
  return true
}

export function FaxHistoryReportTable({ rows }: { rows: FaxReportRow[] }) {
  return (
    <div>
      <p className="mb-4 text-xs text-muted-foreground">
        Delivery status shown here is simulated for demonstration purposes only — this application does not transmit real faxes.
      </p>
      <ReportTable
        rows={rows}
        columns={COLUMNS}
        filterFields={FILTER_FIELDS}
        matchesFilters={matchesFilters}
        searchFields={['subject', 'sender']}
        rowKey={(f) => f.id}
      />
    </div>
  )
}
