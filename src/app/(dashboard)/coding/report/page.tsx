// /coding/report: coding productivity per coder over an IST date range, and the current backlog by
// status and age (CODING_ROLES). Aggregates only, no patient rows; audited without a patient.
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { CODING_ROLES } from '@/lib/role-policy'
import { CODING_STATUS_LABEL, ENCOUNTER_CODING_STATUSES } from '@/lib/coding/status'
import { BACKLOG_AGE_BUCKETS, BACKLOG_AGE_LABEL } from '@/lib/coding/worklist'
import { isoDateSchema } from '@/lib/follow-ups/validation'
import { DEFAULT_TIMEZONE, formatIsoDate, todayIsoIn } from '@/lib/india-time'
import { getCodingProductivity } from '@/lib/queries/coding-worklist'

type SearchParams = Record<string, string | string[] | undefined>

const dateParam = (v: string | string[] | undefined): string | null => {
  const s = Array.isArray(v) ? v[0] : v
  return s !== undefined && isoDateSchema.safeParse(s).success ? s : null
}

const fieldClass = 'h-8 rounded-lg border border-input bg-background px-2 text-sm'
const th = 'px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground'
const td = 'px-3 py-2'

export default async function CodingReportPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const session = await requireSessionOrRedirect()
  if (!CODING_ROLES.includes(session.role)) redirect('/')

  const sp = await searchParams
  const today = todayIsoIn(DEFAULT_TIMEZONE, new Date())
  let from = dateParam(sp.from) ?? `${today.slice(0, 8)}01`
  let to = dateParam(sp.to) ?? today
  if (from > to) [from, to] = [to, from]

  const report = await getCodingProductivity({ from, to })
  await logAudit(session, 'coding: viewed productivity report', null, `from=${from} to=${to}`)
  const backlogTotal = ENCOUNTER_CODING_STATUSES.reduce((n, s) => n + report.backlog.byStatus[s], 0)

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Coding productivity</h1>
          <p className="text-sm text-muted-foreground">
            {`Coding work from ${formatIsoDate(report.from)} to ${formatIsoDate(report.to)} (IST), and the backlog as of now.`}
          </p>
        </div>
        <Link href="/coding" className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted">Back to the worklist</Link>
      </div>

      <form method="get" action="/coding/report" className="flex flex-wrap items-end gap-3 rounded-lg border border-border p-3" aria-label="Report dates">
        <label className="flex flex-col gap-1 text-xs font-medium">
          From
          <input type="date" name="from" defaultValue={from} className={fieldClass} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          To
          <input type="date" name="to" defaultValue={to} className={fieldClass} />
        </label>
        <button type="submit" className="h-8 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/80">Show</button>
      </form>

      <section aria-labelledby="per-coder" className="space-y-2">
        <h2 id="per-coder" className="text-lg font-semibold">By coder</h2>
        {report.perCoder.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">No coding activity in this period.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[720px] text-sm">
              <caption className="sr-only">Coding actions per coder in the selected period</caption>
              <thead className="bg-secondary/40">
                <tr>
                  <th scope="col" className={th}>Coder</th>
                  <th scope="col" className={th}>Claimed</th>
                  <th scope="col" className={th}>Marked coded</th>
                  <th scope="col" className={th}>Finalised</th>
                  <th scope="col" className={th}>Queries raised</th>
                  <th scope="col" className={th}>Reopened</th>
                  <th scope="col" className={th}>Median hours to finalise</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {report.perCoder.map((c) => (
                  <tr key={c.name}>
                    <td className={`${td} font-medium`}>{c.name}</td>
                    <td className={td}>{c.claimed}</td>
                    <td className={td}>{c.coded}</td>
                    <td className={td}>{c.finalised}</td>
                    <td className={td}>{c.queriesRaised}</td>
                    <td className={td}>{c.reopened}</td>
                    <td className={td}>{c.medianHoursToFinalise === null ? '—' : String(c.medianHoursToFinalise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="backlog" className="space-y-3">
        <h2 id="backlog" className="text-lg font-semibold">Backlog</h2>
        <p className="text-sm text-muted-foreground">
          {backlogTotal === 0
            ? 'No completed visit is waiting for coding.'
            : `${backlogTotal} completed ${backlogTotal === 1 ? 'visit is' : 'visits are'} not yet finalised.${report.backlog.oldestCompletedDate ? ` The oldest was completed on ${formatIsoDate(report.backlog.oldestCompletedDate)}.` : ''}`}
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <caption className="px-3 pt-2 text-left text-sm font-medium">By status</caption>
              <thead className="bg-secondary/40"><tr><th scope="col" className={th}>Status</th><th scope="col" className={th}>Visits</th></tr></thead>
              <tbody className="divide-y divide-border">
                {ENCOUNTER_CODING_STATUSES.filter((s) => s !== 'finalised').map((s) => (
                  <tr key={s}><td className={td}>{CODING_STATUS_LABEL[s]}</td><td className={td}>{report.backlog.byStatus[s]}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <caption className="px-3 pt-2 text-left text-sm font-medium">By time since completion</caption>
              <thead className="bg-secondary/40"><tr><th scope="col" className={th}>Waiting</th><th scope="col" className={th}>Visits</th></tr></thead>
              <tbody className="divide-y divide-border">
                {BACKLOG_AGE_BUCKETS.map((b) => (
                  <tr key={b}><td className={td}>{BACKLOG_AGE_LABEL[b]}</td><td className={td}>{report.backlog.byAge[b]}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  )
}
