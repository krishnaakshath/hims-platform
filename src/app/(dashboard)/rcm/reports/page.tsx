// /rcm/reports?from&to: ageing by payer, denial analysis, payer performance and the claim register
// CSV (RCM_ROLES). Default range: the current IST month.
import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { RCM_ROLES } from '@/lib/role-policy'
import { formatIsoDate, todayIsoIn } from '@/lib/india-time'
import { agingByPayer, denialAnalysis, payerPerformance, rangeProblem } from '@/lib/queries/rcm-reports'
import { AgingByPayerTable, DenialAnalysisTable, PayerPerformanceTable } from '@/components/rcm/ReportTables'

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export default async function RcmReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSessionOrRedirect()
  if (!RCM_ROLES.includes(session.role)) redirect('/')

  const sp = await searchParams
  const today = todayIsoIn()
  let from = one(sp.from) ?? `${today.slice(0, 8)}01`
  let to = one(sp.to) ?? today
  const problem = rangeProblem(from, to)
  if (problem) { from = `${today.slice(0, 8)}01`; to = today }
  const range = { from, to }
  const [aging, denials, performance] = await Promise.all([agingByPayer(), denialAnalysis(range), payerPerformance(range)])
  await logAudit(session, 'rcm: viewed RCM reports', null, `from=${from} to=${to}`)
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">RCM reports</h1>
          <p className="text-sm text-muted-foreground">Claims first submitted {formatIsoDate(from)} to {formatIsoDate(to)} (IST).</p>
          {problem && <p className="text-xs text-amber-700">{problem}; showing this month.</p>}
        </div>
        <form className="flex items-end gap-2 text-sm" action="/rcm/reports">
          <label className="text-xs">From<input type="date" name="from" defaultValue={from} className="block rounded-md border border-border bg-background px-2 py-1" /></label>
          <label className="text-xs">To<input type="date" name="to" defaultValue={to} className="block rounded-md border border-border bg-background px-2 py-1" /></label>
          <button type="submit" className="rounded-md border border-border px-3 py-1.5 hover:bg-muted">Show</button>
          <a href={`/api/rcm/reports/claims-csv?from=${from}&to=${to}`} className="rounded-md bg-primary px-3 py-1.5 font-semibold text-primary-foreground">Download claim register (CSV)</a>
        </form>
      </div>
      <section className="space-y-2"><h2 className="text-lg font-semibold">Insurer outstanding by age (all open claims)</h2><AgingByPayerTable rows={aging} /></section>
      <section className="space-y-2"><h2 className="text-lg font-semibold">Deductions and rejections</h2><DenialAnalysisTable rows={denials} /></section>
      <section className="space-y-2"><h2 className="text-lg font-semibold">Payer performance</h2><PayerPerformanceTable rows={performance} /></section>
    </div>
  )
}
