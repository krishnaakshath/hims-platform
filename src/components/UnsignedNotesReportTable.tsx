'use client'
import { ReportTable, type ReportColumn } from '@/components/ReportTable'
import type { DataGridFilterField } from '@/components/DataGridToolbar'

export interface UnsignedNoteRow {
  noteId: number
  patientId: string
  patientName: string
  visitDate: string | null
  noteType: string
  status: string
  assignedUser: string
}

const FILTER_FIELDS: DataGridFilterField[] = [
  { key: 'patientName', label: 'Patient' },
  { key: 'noteType', label: 'Note Type' },
  { key: 'visitDate', label: 'Visit Date', inputType: 'date' },
]

const COLUMNS: ReportColumn<UnsignedNoteRow>[] = [
  { key: 'assignedUser', label: 'Assigned User', render: (r) => r.assignedUser },
  { key: 'patientName', label: 'Patient', render: (r) => r.patientName },
  { key: 'visitDate', label: 'Visit Date', render: (r) => (r.visitDate ? new Date(r.visitDate).toLocaleDateString() : '—') },
  { key: 'status', label: 'Status', render: (r) => r.status },
  { key: 'noteType', label: 'Note Type', render: (r) => r.noteType },
  { key: 'noteId', label: 'Note ID', render: (r) => r.noteId },
]

function matchesFilters(row: UnsignedNoteRow, filters: Record<string, string>): boolean {
  if (filters.patientName && !row.patientName.toLowerCase().includes(filters.patientName.toLowerCase())) return false
  if (filters.noteType && !row.noteType.toLowerCase().includes(filters.noteType.toLowerCase())) return false
  if (filters.visitDate && (!row.visitDate || new Date(row.visitDate).toDateString() !== new Date(filters.visitDate).toDateString())) return false
  return true
}

export function UnsignedNotesReportTable({ rows }: { rows: UnsignedNoteRow[] }) {
  return (
    <ReportTable
      rows={rows}
      columns={COLUMNS}
      filterFields={FILTER_FIELDS}
      matchesFilters={matchesFilters}
      searchFields={['patientName', 'noteType']}
      rowKey={(r) => r.noteId}
      getRowHref={(r) => `/patients/${r.patientId}`}
    />
  )
}
