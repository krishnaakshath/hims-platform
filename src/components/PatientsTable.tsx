'use client'
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Search, FileText } from 'lucide-react'
import { StatusChip } from '@/components/StatusChip'
import { formatPhoneForDisplay, matchesDirectoryQuery } from '@/lib/patient-directory'
import { PatientAvatar } from '@/components/PatientAvatar'

export interface CriteriaSummaryLike {
  inclusionMet: number
  inclusionTotal: number
  exclusionMet: number
  exclusionTotal: number
}

export interface PatientRow {
  id: string
  overallStatus?: 'green' | 'yellow' | 'red' | null
  name: string
  dob: string
  currentProvider: string | null
  referralType: string | null
  lastCommunication: string | null
  criteriaSummary?: CriteriaSummaryLike
  // Wave B P1-08 -- every PATIENT_DIRECTORY_ROLES role may see both (SP1 profile).
  uhid?: string | null
  phone?: string | null
}

/** Server-driven mode (/patients): the page filtered and paged already; the
 *  search box becomes a GET form and Prev/Next links keep `params` + `q`. */
export interface DirectoryPaging {
  query: string
  page: number
  pageSize: number
  total: number
  params: Record<string, string>
}

function directoryHref(d: DirectoryPaging, page: number): string {
  const sp = new URLSearchParams(d.params)
  if (d.query) sp.set('q', d.query)
  sp.set('page', String(page))
  return `/patients?${sp.toString()}`
}

const STATUS_ACCENT: Record<'green' | 'yellow' | 'red', string> = {
  green: 'border-l-success',
  yellow: 'border-l-warning',
  red: 'border-l-destructive',
}

const STATUS_TRACK: Record<'green' | 'yellow' | 'red', string> = {
  green: 'bg-success',
  yellow: 'bg-warning',
  red: 'bg-destructive',
}

function CriteriaReadout({ summary, status }: { summary?: CriteriaSummaryLike; status: 'green' | 'yellow' | 'red' }) {
  if (!summary || (summary.inclusionTotal === 0 && summary.exclusionTotal === 0)) {
    return <p className="text-xs text-muted-foreground">No screening evidence yet</p>
  }
  const total = summary.inclusionTotal + summary.exclusionTotal
  const met = summary.inclusionMet + summary.exclusionMet
  const pct = total > 0 ? Math.round((met / total) * 100) : 0
  return (
    <div>
      <div className="mb-1.5 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
        <div className={`h-full rounded-full ${STATUS_TRACK[status]}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{summary.inclusionMet}/{summary.inclusionTotal}</span> inclusion
        {summary.exclusionTotal > 0 && (
          <>
            {' · '}
            <span className="font-medium text-foreground">{summary.exclusionMet}/{summary.exclusionTotal}</span> exclusion
          </>
        )}
      </p>
    </div>
  )
}

// Name + status dominate, everything else stays a single supporting line so
// the card reads as one clear hierarchy. A left accent stripe keyed to the
// overall verdict makes scanning a full grid for red/yellow cases fast
// without relying on the status chip's color alone (the chip's text label
// still carries the accessible meaning). The card body navigates to the
// patient detail page via a "stretched link" (an absolutely-positioned Link
// filling the card) so the whole surface is clickable; "Medical Record" is a
// separate, real sibling Link stacked above it (never nested inside another
// anchor) that opens a dedicated page for that one action.
// showScreening=false (front desk) drops the status chip, the criteria
// readout and the verdict-colored accent stripe -- the card is then just a
// directory entry.
function PatientCard({ patient, showMedicalRecordLink, showScreening }: { patient: PatientRow; showMedicalRecordLink: boolean; showScreening: boolean }) {
  const name = patient.name
  const dob = patient.dob
  const status = patient.overallStatus ?? 'yellow'

  return (
    <div className={`group relative flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-sm backdrop-blur-sm transition-all duration-200 hover:border-primary/25 hover:shadow-md ${showScreening ? `border-l-4 ${STATUS_ACCENT[status]}` : ''}`}>
      <Link href={`/patients/${patient.id}`} className="absolute inset-0 rounded-xl" aria-label={`View ${name}`}>
        <span className="sr-only">View {name}</span>
      </Link>

      <div className="relative flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <PatientAvatar name={name} />
          <div className="min-w-0">
            <p className="truncate font-semibold text-foreground group-hover:text-primary">{name}</p>
            <p className="truncate text-xs text-muted-foreground">{patient.uhid ? `${patient.uhid} · ` : ''}{patient.id} · {dob}</p>
            {patient.phone && <p className="truncate text-xs text-muted-foreground">{formatPhoneForDisplay(patient.phone)}</p>}
          </div>
        </div>
        {showScreening && <StatusChip status={status} />}
      </div>

      {showScreening && (
        <div className="relative">
          <CriteriaReadout summary={patient.criteriaSummary} status={status} />
        </div>
      )}

      <div className="relative flex items-center justify-between gap-2 border-t border-border pt-3">
        <p className="truncate text-xs text-muted-foreground">{patient.currentProvider ?? 'Unassigned'}</p>
        {showMedicalRecordLink && (
          <Link
            href={`/patients/${patient.id}/medical-record`}
            className="relative inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10"
          >
            <FileText className="h-3.5 w-3.5" aria-hidden="true" />
            Medical Record
          </Link>
        )}
      </div>
    </div>
  )
}

export function PatientsTable({ patients, showMedicalRecordLink = true, showScreening = true, directory }: { patients: PatientRow[]; showMedicalRecordLink?: boolean; showScreening?: boolean; directory?: DirectoryPaging }) {
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    if (directory) return patients
    const q = search.trim()
    if (!q) return patients
    return patients.filter((p) => matchesDirectoryQuery(p, q))
  }, [search, patients, directory])

  const activeQuery = directory ? directory.query : search
  const pageCount = directory ? Math.max(1, Math.ceil(directory.total / directory.pageSize)) : 1
  const first = directory && directory.total > 0 ? (directory.page - 1) * directory.pageSize + 1 : 0
  const last = directory ? first + patients.length - (patients.length > 0 ? 1 : 0) : 0

  return (
    <div>
      <div className="mb-4">
        {directory ? (
          <form role="search" action="/patients" method="get" className="flex max-w-md items-center gap-2">
            {Object.entries(directory.params).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <input
                type="search"
                name="q"
                defaultValue={directory.query}
                placeholder="Name, UHID, mobile or anon #…"
                aria-label="Search patients"
                className="w-full rounded-lg border border-border bg-card py-2 pl-9 pr-3 text-sm text-foreground transition-colors placeholder:text-muted-foreground focus:border-primary/40 focus:outline-none"
              />
            </div>
            <button type="submit" className="rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-secondary">Search</button>
            {directory.query && (
              <Link href={directoryHref({ ...directory, query: '' }, 1)} className="text-xs font-medium text-muted-foreground hover:text-foreground">Clear</Link>
            )}
          </form>
        ) : (
          <div className="relative max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, UHID, mobile or anon #…"
              aria-label="Search patients"
              className="w-full rounded-lg border border-border bg-card py-2 pl-9 pr-3 text-sm text-foreground transition-colors placeholder:text-muted-foreground focus:border-primary/40 focus:outline-none"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                Clear
              </button>
            )}
          </div>
        )}
      </div>

      {filtered.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          {activeQuery ? <>No patients match &quot;{activeQuery}&quot;.</> : 'No patients yet.'}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((p) => <PatientCard key={p.id} patient={p} showMedicalRecordLink={showMedicalRecordLink} showScreening={showScreening} />)}
        </div>
      )}

      {directory ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {directory.total === 0 ? '0 records' : `Showing ${first}–${last} of ${directory.total} record${directory.total === 1 ? '' : 's'}`}
          </p>
          {pageCount > 1 && (
            <nav aria-label="Pagination" className="flex items-center gap-2 text-sm">
              {directory.page > 1 ? (
                <Link rel="prev" href={directoryHref(directory, directory.page - 1)} className="rounded-md border border-border px-3 py-1.5 font-medium text-foreground hover:bg-secondary">Previous</Link>
              ) : (
                <span aria-disabled="true" className="rounded-md border border-border px-3 py-1.5 font-medium text-muted-foreground opacity-50">Previous</span>
              )}
              <span className="text-xs text-muted-foreground">Page {directory.page} of {pageCount}</span>
              {directory.page < pageCount ? (
                <Link rel="next" href={directoryHref(directory, directory.page + 1)} className="rounded-md border border-border px-3 py-1.5 font-medium text-foreground hover:bg-secondary">Next</Link>
              ) : (
                <span aria-disabled="true" className="rounded-md border border-border px-3 py-1.5 font-medium text-muted-foreground opacity-50">Next</span>
              )}
            </nav>
          )}
        </div>
      ) : (
        <p className="mt-4 text-xs text-muted-foreground">
          {filtered.length} of {patients.length} record{patients.length === 1 ? '' : 's'}{search ? ' shown' : ''}
        </p>
      )}
    </div>
  )
}
