import Link from 'next/link'
import { formatIstDateTime } from '@/lib/india-time'
import { redirect } from 'next/navigation'
import { ShieldCheck } from 'lucide-react'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { AUDIT_FILTER_KEYS, activeFilterKeys, encodeAuditCursor, listAuditLog, parseAuditLogQuery, type AuditLogEntry, type AuditLogFilters as Filters } from '@/lib/queries/audit-log'
import { AUDIT_ROLE_LABEL, AuditLogFilters } from '@/components/audit/AuditLogFilters'

const SECTION = 'rounded-md border border-border bg-card p-5 shadow-none'
const BUTTON = 'rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-secondary'

type SearchParams = Record<string, string | string[] | undefined>

/** The filters as a query string, in a fixed key order. */
function filterQuery(filters: Filters): URLSearchParams {
  const qs = new URLSearchParams()
  for (const k of AUDIT_FILTER_KEYS) {
    const v = filters[k]
    if (v !== undefined) qs.set(k, v)
  }
  return qs
}

// WS8 T12 (spec D19): filters in the URL, keyset "Next page" (50 per page) and a CSV export of the
// filtered log. Patients are shown by UHID, never by chart id.
export default async function AuditLogPage({ searchParams }: { searchParams?: Promise<SearchParams> } = {}) {
  const session = await requireSessionOrRedirect()
  // Admin-only: this page surfaces every staff action across the app,
  // including other users' activity, so it must never render for a
  // non-admin session even though the nav already hides the link.
  if (session.role !== 'admin') redirect('/')

  const parsed = parseAuditLogQuery((await searchParams) ?? {}, { allowCursor: true })
  const filters: Filters = parsed.ok ? parsed.filters : {}
  let entries: AuditLogEntry[] = []
  let nextHref: string | null = null
  if (parsed.ok) {
    const result = await listAuditLog(parsed.filters, parsed.cursor)
    entries = result.entries
    if (result.nextCursor) {
      const qs = filterQuery(parsed.filters)
      qs.set('cursor', encodeAuditCursor(result.nextCursor))
      nextHref = `/audit-log?${qs.toString()}`
    }
  }
  const keys = activeFilterKeys(filters)
  await logAudit(session, 'viewed audit log', null, keys.length > 0 ? `filters=${keys.join(',')}` : null)

  const filterQs = filterQuery(filters).toString()
  const suffix = filterQs ? `?${filterQs}` : ''
  const onLaterPage = parsed.ok && parsed.cursor !== undefined

  return (
    <div>
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden="true">
          <ShieldCheck className="h-5 w-5" />
        </span>
        <div>
          <h1 className="text-2xl font-bold text-foreground">Audit Log</h1>
          <p className="text-sm text-muted-foreground">Every recorded action across the system, most recent first, 50 per page. Times are IST.</p>
        </div>
      </div>

      <div className={`${SECTION} mb-4`}>
        <AuditLogFilters filters={filters} />
        {!parsed.ok && (
          <p role="alert" className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            Check the filters: a role, date or page link was not valid, and the From date must not be after the To date.
          </p>
        )}
      </div>

      <div className={SECTION}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">{onLaterPage ? 'Showing a later page.' : 'Showing the most recent entries.'} Exports are capped at 50,000 rows.</p>
          <a href={`/api/audit-log/export${suffix}`} className={BUTTON}>Export CSV</a>
        </div>
        {entries.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">{keys.length > 0 ? 'No entries match these filters.' : 'No activity recorded yet.'}</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border bg-secondary/40 text-left">
                  <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Time (IST)</th>
                  <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">User</th>
                  <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Role</th>
                  <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Action</th>
                  <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Patient UHID</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) => (
                  <tr key={e.id} className={`border-b border-border last:border-b-0 ${i % 2 === 1 ? 'bg-muted/40' : ''} transition-colors hover:bg-secondary`}>
                    <td className="whitespace-nowrap p-3 text-muted-foreground">{formatIstDateTime(e.timestamp)}</td>
                    <td className="p-3 font-medium text-foreground">{e.userName}</td>
                    <td className="p-3 text-foreground">{e.role ? AUDIT_ROLE_LABEL[e.role] : '—'}</td>
                    <td className="p-3 text-foreground">{e.action}</td>
                    <td className="p-3 text-muted-foreground">{e.patientUhid ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {(nextHref || onLaterPage) && (
          <nav aria-label="Audit log pages" className="mt-3 flex justify-end gap-2">
            {onLaterPage && <Link href={`/audit-log${suffix}`} className={BUTTON}>First page</Link>}
            {nextHref && <Link href={nextHref} className={BUTTON}>Next page</Link>}
          </nav>
        )}
      </div>
    </div>
  )
}
