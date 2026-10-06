'use client'
import { useState } from 'react'
import { ReportTable, type ReportColumn } from '@/components/ReportTable'
import type { DataGridFilterField } from '@/components/DataGridToolbar'
import { ReceiveDocumentModal } from '@/components/ReceiveDocumentModal'
import { AssignDocumentPatientControl } from '@/components/AssignDocumentPatientControl'
import { DocumentRowActions } from '@/components/DocumentRowActions'
import { DOCUMENT_TYPE_TEXT, type DocumentType } from '@/lib/document-types'

export interface DocumentReportRow {
  id: number
  name: string
  documentDate: string
  status: 'new' | 'processed'
  receivedFrom: string
  documentType: DocumentType
  patientId: string | null
  patientName: string | null
  patientDob: string | null
  fileType: string
  fileUrl: string | null
  admissionId: number | null
  filedByName: string | null
  filedAt: string | null
}

export { DOCUMENT_TYPE_TEXT }
const STATUS_TEXT: Record<DocumentReportRow['status'], string> = { new: 'New', processed: 'Processed' }
const STATUS_DOT: Record<DocumentReportRow['status'], string> = { new: 'bg-warning', processed: 'bg-success' }

const FILTER_FIELDS: DataGridFilterField[] = [
  { key: 'name', label: 'Name' },
  { key: 'status', label: 'Status', options: Object.entries(STATUS_TEXT).map(([value, label]) => ({ value, label })) },
  { key: 'receivedFrom', label: 'Received From' },
  { key: 'documentType', label: 'Document Type', options: Object.entries(DOCUMENT_TYPE_TEXT).map(([value, label]) => ({ value, label })) },
  { key: 'fileType', label: 'File Type' },
  { key: 'patientName', label: 'Patient' },
]

function matchesFilters(row: DocumentReportRow, filters: Record<string, string>): boolean {
  if (filters.name && !row.name.toLowerCase().includes(filters.name.toLowerCase())) return false
  if (filters.status && row.status !== filters.status) return false
  if (filters.receivedFrom && !row.receivedFrom.toLowerCase().includes(filters.receivedFrom.toLowerCase())) return false
  if (filters.documentType && row.documentType !== filters.documentType) return false
  if (filters.fileType && !row.fileType.toLowerCase().includes(filters.fileType.toLowerCase())) return false
  if (filters.patientName && !(row.patientName ?? '').toLowerCase().includes(filters.patientName.toLowerCase())) return false
  return true
}

interface PatientOption { id: string; name: string }
interface ActiveAdmissionOption { admissionId: number; patientId: string; roomLabel: string | null; admittedAt: string }

type Tab = 'unfiled' | 'unprocessed' | 'all'

export function DocumentsReportTable({ rows, patientOptions, activeAdmissions, canWrite, canDelete }: {
  rows: DocumentReportRow[]
  patientOptions: PatientOption[]
  activeAdmissions: ActiveAdmissionOption[]
  canWrite: boolean
  canDelete: boolean
}) {
  const [tab, setTab] = useState<Tab>('unfiled')
  const [showReceiveModal, setShowReceiveModal] = useState(false)

  const unfiledCount = rows.filter((r) => r.patientId === null).length
  const unprocessedCount = rows.filter((r) => r.status === 'new').length

  const tabs: { key: Tab; label: string }[] = [
    { key: 'unfiled', label: `Unfiled (${unfiledCount})` },
    { key: 'unprocessed', label: `Unprocessed (${unprocessedCount})` },
    { key: 'all', label: `Everything (${rows.length})` },
  ]

  const tabRows = rows.filter((r) => {
    if (tab === 'unfiled') return r.patientId === null
    if (tab === 'unprocessed') return r.status === 'new'
    return true
  })

  const columns: ReportColumn<DocumentReportRow>[] = [
    { key: 'name', label: 'Name', render: (d) => d.name },
    { key: 'documentDate', label: 'Document Date', render: (d) => d.documentDate },
    {
      key: 'status',
      label: 'Status',
      render: (d) => (
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground">
          <span className={`h-2 w-2 rounded-full ${STATUS_DOT[d.status]}`} aria-hidden="true" />
          {STATUS_TEXT[d.status]}
        </span>
      ),
    },
    { key: 'receivedFrom', label: 'Received From', render: (d) => d.receivedFrom },
    { key: 'documentType', label: 'Document Type', render: (d) => DOCUMENT_TYPE_TEXT[d.documentType] },
    {
      key: 'patientName',
      label: 'Patient',
      render: (d) =>
        canWrite ? (
          <AssignDocumentPatientControl documentId={d.id} patientId={d.patientId} patientName={d.patientName} patientDob={d.patientDob} patientOptions={patientOptions} />
        ) : (
          d.patientName ? `${d.patientName}${d.patientDob ? ` (DOB ${d.patientDob})` : ''}` : '—'
        ),
    },
    { key: 'fileType', label: 'File Type', render: (d) => d.fileType },
    {
      key: 'filedBy',
      label: 'Filed By',
      render: (d) => {
        if (d.patientId === null) return null
        return d.filedByName ? d.filedByName : <span className="text-muted-foreground">Filed before filing history was tracked</span>
      },
    },
    {
      key: 'actions',
      label: 'Actions',
      render: (d) => <DocumentRowActions documentId={d.id} documentName={d.name} status={d.status} fileUrl={d.fileUrl} canWrite={canWrite} canDelete={canDelete} />,
    },
  ]

  return (
    <div className="space-y-3">
      {canWrite && (
        <div className="flex justify-end">
          <button
            onClick={() => setShowReceiveModal(true)}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Receive Document
          </button>
        </div>
      )}

      <div className="flex gap-1 border-b border-border">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            aria-current={tab === t.key ? 'page' : undefined}
            className={`border-b-2 px-4 py-2 text-sm font-medium transition-colors ${tab === t.key ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <ReportTable
        rows={tabRows}
        columns={columns}
        filterFields={FILTER_FIELDS}
        matchesFilters={matchesFilters}
        searchFields={['name', 'receivedFrom']}
        rowKey={(d) => d.id}
      />

      {showReceiveModal && (
        <ReceiveDocumentModal
          patientOptions={patientOptions}
          activeAdmissions={activeAdmissions}
          onClose={() => setShowReceiveModal(false)}
        />
      )}
    </div>
  )
}
