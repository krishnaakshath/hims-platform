'use client'
import { ReportTable, type ReportColumn } from '@/components/ReportTable'
import type { DataGridFilterField } from '@/components/DataGridToolbar'

export interface EncounterReportRow {
  encounterId: string
  dateOfService: string
  patientId: string
  patientName: string
  renderingProvider: string
  // listAllEncountersReport (reports.ts) computes these via ternaries without
  // a literal-type annotation, so they infer as `string`, not a narrow union
  // -- matched here rather than asserting a type the query function doesn't
  // actually guarantee.
  payerScenario: string
  encounterStatus: string
  procedure: string
}

const FILTER_FIELDS: DataGridFilterField[] = [
  { key: 'patientName', label: 'Patient' },
  { key: 'renderingProvider', label: 'Rendering Provider' },
  { key: 'encounterStatus', label: 'Encounter Status', options: [{ value: 'Billed', label: 'Billed' }, { value: 'Completed — Not Billed', label: 'Completed — Not Billed' }] },
  { key: 'payerScenario', label: 'Payer Scenario', options: [{ value: 'Insurance', label: 'Insurance' }, { value: 'Self-Pay', label: 'Self-Pay' }] },
  { key: 'dateOfService', label: 'Date of Service', inputType: 'date' },
]

const COLUMNS: ReportColumn<EncounterReportRow>[] = [
  { key: 'encounterId', label: 'Encounter ID', render: (r) => r.encounterId },
  // dateOfService is already a formatted YYYY-MM-DD string -- never re-wrap
  // in `new Date()` here (see AllAppointmentsReportTable's comment).
  { key: 'dateOfService', label: 'Date of Service', render: (r) => r.dateOfService },
  { key: 'patientName', label: 'Patient Name', render: (r) => r.patientName },
  { key: 'renderingProvider', label: 'Rendering Provider', render: (r) => r.renderingProvider },
  { key: 'payerScenario', label: 'Payer Scenario', render: (r) => r.payerScenario },
  { key: 'encounterStatus', label: 'Encounter Status', render: (r) => r.encounterStatus },
  { key: 'procedure', label: 'Procedure', render: (r) => r.procedure },
]

function matchesFilters(row: EncounterReportRow, filters: Record<string, string>): boolean {
  if (filters.patientName && !row.patientName.toLowerCase().includes(filters.patientName.toLowerCase())) return false
  if (filters.renderingProvider && !row.renderingProvider.toLowerCase().includes(filters.renderingProvider.toLowerCase())) return false
  if (filters.encounterStatus && row.encounterStatus !== filters.encounterStatus) return false
  if (filters.payerScenario && row.payerScenario !== filters.payerScenario) return false
  if (filters.dateOfService && row.dateOfService !== filters.dateOfService) return false
  return true
}

export function AllEncountersReportTable({ rows }: { rows: EncounterReportRow[] }) {
  return (
    <ReportTable
      rows={rows}
      columns={COLUMNS}
      filterFields={FILTER_FIELDS}
      matchesFilters={matchesFilters}
      searchFields={['patientName', 'renderingProvider']}
      rowKey={(r) => r.encounterId}
      getRowHref={(r) => `/patients/${r.patientId}`}
    />
  )
}
