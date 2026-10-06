'use client'
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Search, Trash2 } from 'lucide-react'
import type { WorkbookRow } from '@/lib/queries/workbook'
import { DeletePatientDialog, type DeleteTarget } from '@/components/DeletePatientDialog'

// Same elevated-card treatment ReportTable.tsx and the rest of the app's
// data surfaces already use.
const SECTION = 'rounded-xl border border-primary/10 bg-card/80 p-5 shadow-sm backdrop-blur-sm'

// Columns match the source workbook in order (see src/lib/queries/workbook.ts;
// originally 30 headings, now 29 -- 'Link Tebra'/tebraChartUrl was dropped
// entirely since Task 1 of the unified-patient-record plan removed that
// column with no single-sourced replacement). This is an internal,
// staff-only operational grid meant to replicate a document coordinators
// already use day to day. The underlying field keys (intakeqEmail,
// patientEmail, etc.) still name the external systems the app
// integrates with -- accurate internal naming, never rendered -- but every
// column LABEL below is genericized: the app's own UI never names a
// third-party product.
const COLUMNS: { key: keyof WorkbookRow | 'name'; label: string }[] = [
  { key: 'id', label: 'Anonymous Number' },
  { key: 'dateAdded', label: 'Date Added to Tab' },
  { key: 'patientName', label: 'Patient Name' },
  { key: 'currentProvider', label: 'Current Provider' },
  { key: 'ratingScales', label: 'Rating Scales' },
  { key: 'dob', label: 'DOB' },
  { key: 'age', label: 'Age' },
  { key: 'city', label: 'City' },
  { key: 'zip', label: 'Zip' },
  { key: 'phone', label: 'Phone' },
  { key: 'dxCodes', label: 'Dx Codes' },
  { key: 'lastCommunication', label: 'Last Communication' },
  { key: 'referralType', label: 'Referral Type' },
  { key: 'availability', label: 'Availability' },
  { key: 'apptDates', label: 'Past & Future Appt Date' },
  { key: 'commConsent', label: 'Comm Consent Signed/Pref/Intake' },
  { key: 'formNotes', label: 'Form Notes' },
  { key: 'reviewerNotes', label: 'Reviewer Notes' },
  { key: 'clinicianReviewerNotes', label: 'Clinician Reviewer Notes' },
  { key: 'piRecommendation', label: 'PI Recommendation' },
  { key: 'activeMeds', label: 'Active Meds' },
  { key: 'inactiveMeds', label: 'Inactive Meds' },
  { key: 'oldNotes', label: 'Old Notes' },
  { key: 'oldRecs', label: 'Old Recs' },
  { key: 'intakeqEmail', label: 'Intake Email' },
  { key: 'patientEmail', label: 'Patient Email' },
  { key: 'outsideMedsConfirmation', label: 'Meds List from Pharmacy (Outside Confirmation)' },
  { key: 'templateDocUrl', label: 'Template Word Doc in SharePoint' },
  { key: 'prescreeningSentDate', label: 'Research Depression Prescreening Sent Date' },
]

function cellValue(row: WorkbookRow, key: string): string {
  const value = (row as unknown as Record<string, unknown>)[key]
  if (value === null || value === undefined || value === '') return '—'
  return String(value)
}

export function WorkbookTable({ rows, isAdmin }: { rows: WorkbookRow[]; isAdmin: boolean }) {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [visibleColumns, setVisibleColumns] = useState<string[]>(COLUMNS.map((c) => c.key as string))
  const [columnsPanelOpen, setColumnsPanelOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) => r.patientName.toLowerCase().includes(q) || r.id.toLowerCase().includes(q))
  }, [search, rows])

  const show = (key: string) => visibleColumns.includes(key)

  return (
    <div className={SECTION}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="relative max-w-sm flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or anon #…"
            aria-label="Search workbook"
            className="w-full rounded-lg border border-border bg-card px-3 py-2 pl-9 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary/40 focus:outline-none"
          />
        </div>
        <div className="relative">
          <button
            type="button"
            onClick={() => setColumnsPanelOpen((v) => !v)}
            aria-expanded={columnsPanelOpen}
            className="rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-secondary"
          >
            Columns ({visibleColumns.length}/{COLUMNS.length})
          </button>
          {columnsPanelOpen && (
            <div className="absolute right-0 top-full z-50 mt-2 max-h-96 w-72 overflow-y-auto rounded-lg border border-border bg-card p-3 shadow-lg">
              <div className="mb-2 flex justify-between">
                <button type="button" onClick={() => setVisibleColumns(COLUMNS.map((c) => c.key as string))} className="text-xs font-medium text-primary hover:underline">Show all</button>
                <button type="button" onClick={() => setVisibleColumns(['id', 'patientName'])} className="text-xs font-medium text-primary hover:underline">Hide all</button>
              </div>
              <ul className="space-y-1.5">
                {COLUMNS.map((c) => (
                  <li key={c.key}>
                    <label className="flex items-center gap-2 text-sm text-foreground">
                      <input
                        type="checkbox"
                        checked={show(c.key as string)}
                        onChange={() => setVisibleColumns((cols) => (cols.includes(c.key as string) ? cols.filter((k) => k !== c.key) : [...cols, c.key as string]))}
                      />
                      {c.label}
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="mt-6 rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No records found.</p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-secondary/40 text-left">
                {COLUMNS.filter((c) => show(c.key as string)).map((c) => (
                  <th key={c.key} className="whitespace-nowrap p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => (
                <tr
                  key={r.id}
                  className={`border-b border-border last:border-b-0 ${i % 2 === 1 ? 'bg-muted/40' : ''} transition-colors hover:bg-secondary`}
                >
                  {COLUMNS.filter((c) => show(c.key as string)).map((c) =>
                    c.key === 'id' ? (
                      <td key={c.key} className="whitespace-nowrap p-3"><Link href={`/patients/${r.id}`} className="font-medium text-primary hover:underline">{r.id}</Link></td>
                    ) : c.key === 'patientName' ? (
                      <td key={c.key} className="min-w-[10rem] max-w-xs p-3 text-foreground">
                        <div className="flex items-center gap-2">
                          <span className="truncate">{cellValue(r, c.key as string)}</span>
                          {isAdmin && (
                            <button
                              type="button"
                              onClick={() => setDeleteTarget({ id: r.id, name: r.patientName })}
                              aria-label={`Delete ${r.patientName}`}
                              title="Delete patient"
                              className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                            >
                              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                          )}
                        </div>
                      </td>
                    ) : (
                      <td key={c.key} className="min-w-[10rem] max-w-xs p-3 text-foreground">{cellValue(r, c.key as string)}</td>
                    )
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-muted-foreground">{filtered.length} of {rows.length} patient{rows.length === 1 ? '' : 's'}</p>

      <DeletePatientDialog
        target={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onDeleted={() => router.refresh()}
      />
    </div>
  )
}
