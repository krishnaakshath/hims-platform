import Link from 'next/link'
import { redirect } from 'next/navigation'
import { NotebookTabs, Download } from 'lucide-react'
import { requireSessionOrRedirect } from '@/lib/auth'
import { ENCOUNTER_REGISTER_EXPORT_ROLES, ENCOUNTER_REGISTER_ROLES } from '@/lib/role-policy'
import { formatIsoDate, formatIstTime, todayIsoIn } from '@/lib/india-time'
import {
  ENCOUNTER_STATUS_LABEL, ENCOUNTER_TYPE_LABEL, VISIT_TYPE_LABEL, genderLabel, parseRegisterFilters, registerQueryString,
  type RegisterFilters,
} from '@/lib/encounters/register'
import { ENCOUNTER_STATUSES, ENCOUNTER_TYPES, type EncounterStatus } from '@/lib/encounters/status'
import { listEncounterRegister } from '@/lib/queries/encounter-register'
import { listDepartments } from '@/lib/queries/departments'
import { listActiveProviders } from '@/lib/queries/providers'
import { FIELD_CLASS } from '@/components/tariff/api'

// Wave F P1-04: the OPD register -- every encounter (SP3 `encounters`, not
// appointments) in a date range, filterable by department, doctor, status
// and type. ENCOUNTER_REGISTER_ROLES, gated right after the session check,
// before any query; the CSV export link is shown only to
// ENCOUNTER_REGISTER_EXPORT_ROLES (the route enforces the same gate). Plain
// GET form: filtering works without JavaScript. IST throughout.

const STATUS_CLASS: Record<EncounterStatus, string> = {
  checked_in: 'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200',
  in_consultation: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  completed: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  cancelled: 'bg-muted text-muted-foreground',
}

type SearchParams = Record<string, string | string[] | undefined>

function rawValue(sp: SearchParams, key: string): string {
  const v = sp[key]
  return (Array.isArray(v) ? v[0] : v) ?? ''
}

export default async function EncountersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const session = await requireSessionOrRedirect()
  if (!ENCOUNTER_REGISTER_ROLES.includes(session.role)) redirect('/')

  const sp = await searchParams
  const today = todayIsoIn()
  const parsed = parseRegisterFilters(sp, today)
  const [departments, doctors, register] = await Promise.all([
    listDepartments(),
    listActiveProviders(),
    parsed.ok ? listEncounterRegister(parsed.filters) : Promise.resolve(null),
  ])
  const canExport = ENCOUNTER_REGISTER_EXPORT_ROLES.includes(session.role)

  // The form shows what was asked for (even when invalid), defaulting to today's OPD.
  const form = parsed.ok
    ? { from: parsed.filters.from, to: parsed.filters.to, type: parsed.filters.type ?? 'all', status: parsed.filters.status ?? '', department: parsed.filters.departmentId?.toString() ?? '', doctor: parsed.filters.providerId?.toString() ?? '' }
    : { from: rawValue(sp, 'from'), to: rawValue(sp, 'to'), type: rawValue(sp, 'type') || 'opd', status: rawValue(sp, 'status'), department: rawValue(sp, 'department'), doctor: rawValue(sp, 'doctor') }
  const statusHref = (f: RegisterFilters, status: EncounterStatus | null) => `/encounters?${registerQueryString({ ...f, status })}`
  const rangeLabel = parsed.ok
    ? (parsed.filters.from === parsed.filters.to ? formatIsoDate(parsed.filters.from) : `${formatIsoDate(parsed.filters.from)} – ${formatIsoDate(parsed.filters.to)}`)
    : ''

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden="true"><NotebookTabs className="h-5 w-5" /></span>
          <div>
            <h1 className="text-2xl font-bold text-foreground">OPD Register</h1>
            <p className="text-sm text-muted-foreground">Every visit checked in, by date, department, doctor and status. Times are IST.</p>
          </div>
        </div>
        {canExport && parsed.ok && (
          <a
            href={`/api/encounters/register/export?${registerQueryString(parsed.filters)}`}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-sm font-medium text-foreground hover:bg-muted"
          >
            <Download className="h-4 w-4" aria-hidden="true" />
            Export CSV
          </a>
        )}
      </div>

      <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="reg-from" className="mb-1 block text-xs font-medium text-muted-foreground">From</label>
          <input id="reg-from" name="from" type="date" defaultValue={form.from || today} className={`${FIELD_CLASS} w-40`} />
        </div>
        <div>
          <label htmlFor="reg-to" className="mb-1 block text-xs font-medium text-muted-foreground">To</label>
          <input id="reg-to" name="to" type="date" defaultValue={form.to || today} className={`${FIELD_CLASS} w-40`} />
        </div>
        <div>
          <label htmlFor="reg-dept" className="mb-1 block text-xs font-medium text-muted-foreground">Department</label>
          <select id="reg-dept" name="department" defaultValue={form.department} className={`${FIELD_CLASS} w-48`}>
            <option value="">All departments</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}{d.isActive ? '' : ' (inactive)'}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="reg-doctor" className="mb-1 block text-xs font-medium text-muted-foreground">Doctor</label>
          <select id="reg-doctor" name="doctor" defaultValue={form.doctor} className={`${FIELD_CLASS} w-48`}>
            <option value="">All doctors</option>
            {[...doctors].sort((a, b) => a.name.localeCompare(b.name, 'en-IN')).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="reg-status" className="mb-1 block text-xs font-medium text-muted-foreground">Status</label>
          <select id="reg-status" name="status" defaultValue={form.status} className={`${FIELD_CLASS} w-40`}>
            <option value="">All statuses</option>
            {ENCOUNTER_STATUSES.map((s) => <option key={s} value={s}>{ENCOUNTER_STATUS_LABEL[s]}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="reg-type" className="mb-1 block text-xs font-medium text-muted-foreground">Type</label>
          <select id="reg-type" name="type" defaultValue={form.type} className={`${FIELD_CLASS} w-32`}>
            {ENCOUNTER_TYPES.map((t) => <option key={t} value={t}>{ENCOUNTER_TYPE_LABEL[t]}</option>)}
            <option value="all">All types</option>
          </select>
        </div>
        <button type="submit" className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground">Show</button>
      </form>

      {!parsed.ok && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">{parsed.error}</p>
      )}

      {parsed.ok && register && (
        <>
          <nav aria-label="Filter by status" className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">{rangeLabel}:</span>
            <Link href={statusHref(parsed.filters, null)} aria-current={parsed.filters.status === null ? 'true' : undefined} className={`rounded-full border px-3 py-0.5 ${parsed.filters.status === null ? 'border-primary bg-primary/10 font-semibold text-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}>
              All {Object.values(register.statusCounts).reduce((a, b) => a + b, 0)}
            </Link>
            {ENCOUNTER_STATUSES.map((s) => (
              <Link key={s} href={statusHref(parsed.filters, s)} aria-current={parsed.filters.status === s ? 'true' : undefined} className={`rounded-full border px-3 py-0.5 ${parsed.filters.status === s ? 'border-primary bg-primary/10 font-semibold text-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}>
                {ENCOUNTER_STATUS_LABEL[s]} {register.statusCounts[s]}
              </Link>
            ))}
          </nav>

          {register.truncated && (
            <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
              Showing the first {register.rows.length} of {register.total} visits. Narrow the dates or filters to see the rest.
            </p>
          )}

          {register.rows.length === 0 ? (
            <p className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No visits match these filters.</p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <table aria-label="OPD register" className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2 text-right">Token</th>
                    <th className="px-3 py-2">Patient</th>
                    <th className="px-3 py-2">Age / Sex</th>
                    <th className="px-3 py-2">Visit</th>
                    <th className="px-3 py-2">Department</th>
                    <th className="px-3 py-2">Doctor</th>
                    <th className="px-3 py-2">Checked in</th>
                    <th className="px-3 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {register.rows.map((r) => (
                    <tr key={r.id} className="border-t border-border">
                      <td className="whitespace-nowrap px-3 py-2">{formatIsoDate(r.encounterDate)}</td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums">{r.opdToken ?? '—'}</td>
                      <td className="px-3 py-2">
                        <Link href={`/patients/${r.patientId}`} className="font-medium text-primary hover:underline">{r.patientName}</Link>
                        <span className="block font-mono text-xs text-muted-foreground">{r.uhid ?? `Chart ${r.patientId}`}</span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">{`${r.ageYears} y / ${genderLabel(r.gender) || '—'}`}</td>
                      <td className="px-3 py-2">
                        {VISIT_TYPE_LABEL[r.visitType]}
                        {r.encounterType !== 'opd' && <span className="ml-1 rounded bg-secondary px-1 text-[10px] font-semibold uppercase">{ENCOUNTER_TYPE_LABEL[r.encounterType]}</span>}
                      </td>
                      <td className="px-3 py-2">{r.departmentName ?? '—'}</td>
                      <td className="px-3 py-2">{r.doctorName}</td>
                      <td className="whitespace-nowrap px-3 py-2 tabular-nums">{formatIstTime(r.checkedInAt)}</td>
                      <td className="px-3 py-2"><span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[r.status]}`}>{ENCOUNTER_STATUS_LABEL[r.status]}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
