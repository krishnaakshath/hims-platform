// The coding worklist (/coding): status tabs with counts, a GET filter form, the table and paging.
// Every field arrives mapped and pre-formatted by the server page (IST dates via the pure
// formatters), so this renders the same on the server and in the browser. Coder minimum PHI:
// a row carries the patient's name and UHID only.
import Link from 'next/link'
import { CODING_STATUS_LABEL, ENCOUNTER_CODING_STATUSES, type EncounterCodingStatus } from '@/lib/coding/status'
import {
  WORKLIST_ASSIGNEE_FILTERS, WORKLIST_ASSIGNEE_FILTER_LABEL, WORKLIST_PAGE_SIZE, type CodingWorklistFilters,
  type WorklistStatusFilter,
} from '@/lib/coding/worklist'
import { CodingStatusBadge } from './CodingStatusBadge'
import { ClaimButton } from './ClaimButton'

export interface CodingWorklistRowView {
  encounterId: number
  patientName: string
  uhid: string | null
  encounterTypeLabel: string
  encounterDateLabel: string
  completedLabel: string
  departmentName: string | null
  providerName: string
  codingStatus: EncounterCodingStatus
  assignedToName: string | null
  uncodedCount: number
  proposedCount: number
  openQueryCount: number
  ageLabel: string
  canClaim: boolean
}

export interface CodingWorklistProps {
  rows: CodingWorklistRowView[]
  total: number
  counts: Record<EncounterCodingStatus, number>
  filters: CodingWorklistFilters
  departments: { id: number; name: string }[]
}

const TAB_LABEL = (s: WorklistStatusFilter) => (s === 'pending' ? 'All pending' : CODING_STATUS_LABEL[s])
const TABS: WorklistStatusFilter[] = ['pending', ...ENCOUNTER_CODING_STATUSES]

/** `/coding?…` with only the non-default params, in a stable order. */
export function worklistHref(f: CodingWorklistFilters): string {
  const p = new URLSearchParams()
  if (f.status !== 'pending') p.set('status', f.status)
  if (f.assignee !== 'all') p.set('assignee', f.assignee)
  if (f.encounterType) p.set('type', f.encounterType)
  if (f.departmentId !== null) p.set('department', String(f.departmentId))
  if (f.fromDate) p.set('from', f.fromDate)
  if (f.toDate) p.set('to', f.toDate)
  if (f.page > 1) p.set('page', String(f.page))
  const qs = p.toString()
  return qs ? `/coding?${qs}` : '/coding'
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const fieldClass = 'h-8 rounded-lg border border-input bg-background px-2 text-sm'

export function CodingWorklist({ rows, total, counts, filters, departments }: CodingWorklistProps) {
  const tabCount = (s: WorklistStatusFilter) =>
    s === 'pending' ? ENCOUNTER_CODING_STATUSES.filter((x) => x !== 'finalised').reduce((n, x) => n + counts[x], 0) : counts[s]
  const firstIndex = (filters.page - 1) * WORKLIST_PAGE_SIZE
  const lastPage = Math.max(1, Math.ceil(total / WORKLIST_PAGE_SIZE))

  return (
    <div className="space-y-4">
      <nav aria-label="Coding status" className="flex flex-wrap gap-2">
        {TABS.map((s) => {
          const active = filters.status === s
          return (
            <Link
              key={s}
              href={worklistHref({ ...filters, status: s, page: 1 })}
              aria-current={active ? 'page' : undefined}
              className={`rounded-full border px-3 py-1 text-sm ${active ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-muted'}`}
            >
              {`${TAB_LABEL(s)} (${tabCount(s)})`}
            </Link>
          )
        })}
      </nav>

      <form method="get" action="/coding" className="flex flex-wrap items-end gap-3 rounded-lg border border-border p-3" aria-label="Filter the worklist">
        {filters.status !== 'pending' && <input type="hidden" name="status" value={filters.status} />}
        <label className="flex flex-col gap-1 text-xs font-medium">
          Assignee
          <select name="assignee" defaultValue={filters.assignee} className={fieldClass}>
            {WORKLIST_ASSIGNEE_FILTERS.map((a) => <option key={a} value={a}>{WORKLIST_ASSIGNEE_FILTER_LABEL[a]}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          Visit type
          <select name="type" defaultValue={filters.encounterType ?? ''} className={fieldClass}>
            <option value="">OPD and IPD</option>
            <option value="opd">OPD</option>
            <option value="ipd">IPD</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          Department
          <select name="department" defaultValue={filters.departmentId === null ? '' : String(filters.departmentId)} className={fieldClass}>
            <option value="">All departments</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          Completed from
          <input type="date" name="from" defaultValue={filters.fromDate ?? ''} className={fieldClass} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          Completed to
          <input type="date" name="to" defaultValue={filters.toDate ?? ''} className={fieldClass} />
        </label>
        <button type="submit" className="h-8 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/80">Apply</button>
        <Link href="/coding" className="h-8 px-2 text-sm leading-8 text-muted-foreground underline-offset-4 hover:underline">Clear</Link>
      </form>

      {total === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">Nothing is waiting for coding.</p>
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          This page is past the end of the list. <Link className="underline" href={worklistHref({ ...filters, page: 1 })}>Go to the first page</Link>.
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {`Showing ${firstIndex + 1}–${firstIndex + rows.length} of ${total}`}
          </p>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[960px] text-sm">
              <caption className="sr-only">Completed visits awaiting coding, oldest completion first</caption>
              <thead className="bg-secondary/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2">UHID</th>
                  <th scope="col" className="px-3 py-2">Patient</th>
                  <th scope="col" className="px-3 py-2">Visit</th>
                  <th scope="col" className="px-3 py-2">Completed</th>
                  <th scope="col" className="px-3 py-2">Department</th>
                  <th scope="col" className="px-3 py-2">Doctor</th>
                  <th scope="col" className="px-3 py-2">Status</th>
                  <th scope="col" className="px-3 py-2">Assignee</th>
                  <th scope="col" className="px-3 py-2">Work</th>
                  <th scope="col" className="px-3 py-2">Waiting</th>
                  <th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.encounterId} className="align-top">
                    <td className="px-3 py-2 font-mono text-xs">{r.uhid ?? '—'}</td>
                    <td className="px-3 py-2">
                      <Link href={`/coding/encounters/${r.encounterId}`} className="font-medium text-primary underline-offset-4 hover:underline">{r.patientName}</Link>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">{`${r.encounterTypeLabel} · ${r.encounterDateLabel}`}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{r.completedLabel}</td>
                    <td className="px-3 py-2">{r.departmentName ?? '—'}</td>
                    <td className="px-3 py-2">{r.providerName}</td>
                    <td className="px-3 py-2"><CodingStatusBadge status={r.codingStatus} /></td>
                    <td className="px-3 py-2">{r.assignedToName ?? <span className="text-muted-foreground">Unclaimed</span>}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-xs">
                      {`${r.uncodedCount} uncoded · ${r.proposedCount} proposed · ${plural(r.openQueryCount, 'query', 'queries')}`}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">{r.ageLabel}</td>
                    <td className="px-3 py-2">{r.canClaim && <ClaimButton encounterId={r.encounterId} patientName={r.patientName} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {total > WORKLIST_PAGE_SIZE && (
        <nav aria-label="Worklist pages" className="flex items-center gap-4 text-sm">
          {filters.page > 1 && <Link className="underline" href={worklistHref({ ...filters, page: Math.min(filters.page - 1, lastPage) })}>Previous page</Link>}
          <span className="text-muted-foreground">{`Page ${filters.page} of ${lastPage}`}</span>
          {filters.page < lastPage && <Link className="underline" href={worklistHref({ ...filters, page: filters.page + 1 })}>Next page</Link>}
        </nav>
      )}
    </div>
  )
}
