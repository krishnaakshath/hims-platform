'use client'
import { ReportTable, type ReportColumn } from '@/components/ReportTable'
import type { DataGridFilterField } from '@/components/DataGridToolbar'

export interface AppointmentReportRow {
  id: number
  apptDate: string
  apptTime: string
  status: 'scheduled' | 'completed' | 'cancelled' | 'no_show'
  patientId: string
  patientName: string
  dob: string
  homePhone: string
  mobilePhone: string
  providerName: string
}

const STATUS_LABELS: Record<AppointmentReportRow['status'], string> = {
  scheduled: 'Scheduled', completed: 'Completed', cancelled: 'Cancelled', no_show: 'No Show',
}

const STATUS_DOT: Record<AppointmentReportRow['status'], string> = {
  scheduled: 'bg-primary', completed: 'bg-success', cancelled: 'bg-muted-foreground', no_show: 'bg-destructive',
}

const FILTER_FIELDS: DataGridFilterField[] = [
  { key: 'patientName', label: 'Patient' },
  { key: 'status', label: 'Status', options: Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })) },
  { key: 'providerName', label: 'Provider' },
  { key: 'apptDate', label: 'Appt Date', inputType: 'date' },
  { key: 'homePhone', label: 'Home Phone' },
  { key: 'mobilePhone', label: 'Mobile Phone' },
]

const COLUMNS: ReportColumn<AppointmentReportRow>[] = [
  { key: 'id', label: 'Appt ID', render: (r) => r.id },
  // apptDate/apptTime are already formatted display strings (see
  // reports.ts's formatDate/formatTime) -- never re-wrap in `new Date()`
  // here, which would re-parse a plain YYYY-MM-DD string at UTC midnight
  // and could shift the displayed day depending on the browser's local
  // timezone (the exact bug class already found and fixed once in Task 3).
  { key: 'apptDate', label: 'Appt Date', render: (r) => r.apptDate },
  { key: 'apptTime', label: 'Time', render: (r) => r.apptTime },
  {
    key: 'status',
    label: 'Status',
    render: (r) => (
      <span className="inline-flex items-center gap-1.5 text-foreground">
        <span className={`h-2 w-2 rounded-full ${STATUS_DOT[r.status]}`} aria-hidden="true" />
        {STATUS_LABELS[r.status]}
      </span>
    ),
  },
  { key: 'patientName', label: 'Patient', render: (r) => r.patientName },
  { key: 'dob', label: 'DOB', render: (r) => r.dob },
  { key: 'homePhone', label: 'Home Phone', render: (r) => r.homePhone },
  { key: 'mobilePhone', label: 'Mobile Phone', render: (r) => r.mobilePhone },
]

function matchesFilters(row: AppointmentReportRow, filters: Record<string, string>): boolean {
  if (filters.patientName && !row.patientName.toLowerCase().includes(filters.patientName.toLowerCase())) return false
  if (filters.status && row.status !== filters.status) return false
  if (filters.providerName && !row.providerName.toLowerCase().includes(filters.providerName.toLowerCase())) return false
  if (filters.apptDate && row.apptDate !== filters.apptDate) return false
  if (filters.homePhone && !row.homePhone.toLowerCase().includes(filters.homePhone.toLowerCase())) return false
  if (filters.mobilePhone && !row.mobilePhone.toLowerCase().includes(filters.mobilePhone.toLowerCase())) return false
  return true
}

export function AllAppointmentsReportTable({ rows }: { rows: AppointmentReportRow[] }) {
  return (
    <ReportTable
      rows={rows}
      columns={COLUMNS}
      filterFields={FILTER_FIELDS}
      matchesFilters={matchesFilters}
      searchFields={['patientName', 'homePhone', 'mobilePhone']}
      rowKey={(r) => r.id}
      getRowHref={(r) => `/patients/${r.patientId}`}
    />
  )
}
