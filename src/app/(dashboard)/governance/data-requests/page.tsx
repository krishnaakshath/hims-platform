import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ScrollText } from 'lucide-react'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { formatCalendarDate, todayIsoIn } from '@/lib/india-time'
import { RETENTION_SCHEDULE, RETENTION_STATUS_LABEL } from '@/lib/governance/retention'
import { DUE_DAYS, KIND_LABEL, STATUS_LABEL, VIA_LABEL, listDataPrincipalRequests } from '@/lib/queries/data-principal-requests'
import { DataRequestCreateForm } from '@/components/governance/DataRequestCreateForm'

const SECTION = 'rounded-md border border-border bg-card p-5 shadow-none'
const TH = 'p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground'

// WS8 T14 (spec D18): the DPDP data-principal request register and the retention schedule.
// Admin only. Patients are shown by UHID.
export default async function DataRequestsPage() {
  const session = await requireSessionOrRedirect()
  if (session.role !== 'admin') redirect('/')

  const todayIso = todayIsoIn()
  const requests = await listDataPrincipalRequests(todayIso)
  await logAudit(session, 'viewed data-principal requests', null, `count=${requests.length}`)
  const overdue = requests.filter((r) => r.overdue).length

  return (
    <div className="space-y-4">
      <div className="mb-2 flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden="true">
          <ScrollText className="h-5 w-5" />
        </span>
        <div>
          <h1 className="text-2xl font-bold text-foreground">Data requests</h1>
          <p className="text-sm text-muted-foreground">
            Requests from patients under the Digital Personal Data Protection Act, 2023: access, correction, erasure and grievances.
            Each is due {DUE_DAYS} days after it was received.
          </p>
        </div>
      </div>

      <div className={SECTION}>
        <h2 className="mb-3 text-base font-semibold text-foreground">Log a request</h2>
        <DataRequestCreateForm todayIso={todayIso} />
      </div>

      <div className={SECTION}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-foreground">Register</h2>
          {overdue > 0 && <p className="text-sm font-medium text-destructive">{overdue} overdue</p>}
        </div>
        {requests.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No requests logged yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border bg-secondary/40 text-left">
                  <th className={TH}>Reference</th>
                  <th className={TH}>Patient UHID</th>
                  <th className={TH}>Request</th>
                  <th className={TH}>Received</th>
                  <th className={TH}>Due by</th>
                  <th className={TH}>Status</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => (
                  <tr key={r.id} className="border-b border-border last:border-b-0 transition-colors hover:bg-secondary">
                    <td className="p-3 font-medium">
                      <Link href={`/governance/data-requests/${r.id}`} className="text-primary underline-offset-4 hover:underline">{r.reference}</Link>
                    </td>
                    <td className="p-3 text-muted-foreground">{r.patientId ? (r.patientUhid ?? '—') : 'Chart erased'}</td>
                    <td className="p-3 text-foreground">{KIND_LABEL[r.kind]}</td>
                    <td className="whitespace-nowrap p-3 text-muted-foreground">{formatCalendarDate(r.receivedAt)} ({VIA_LABEL[r.receivedVia]})</td>
                    <td className="whitespace-nowrap p-3 text-foreground">
                      {formatCalendarDate(r.dueBy)}
                      {r.overdue && <span className="ml-2 rounded bg-destructive/10 px-1.5 py-0.5 text-xs font-medium text-destructive">Overdue</span>}
                    </td>
                    <td className="p-3 text-foreground">{STATUS_LABEL[r.status]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className={SECTION}>
        <h2 className="text-base font-semibold text-foreground">Retention schedule</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          These periods are the software&apos;s defaults, <strong className="font-medium text-foreground">pending legal review</strong> by the
          hospital. An erasure request never deletes financial or medico-legal records: while any record must be kept, the chart is
          archived and its contact details removed instead.
        </p>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-secondary/40 text-left">
                <th className={TH}>Records</th>
                <th className={TH}>Kept for</th>
                <th className={TH}>Basis</th>
                <th className={TH}>Status</th>
              </tr>
            </thead>
            <tbody>
              {RETENTION_SCHEDULE.map((r) => (
                <tr key={r.category} className="border-b border-border last:border-b-0">
                  <td className="p-3 font-medium text-foreground">{r.label}</td>
                  <td className="whitespace-nowrap p-3 text-foreground">{r.years} years</td>
                  <td className="p-3 text-muted-foreground">{r.basis}</td>
                  <td className="whitespace-nowrap p-3 text-muted-foreground">{RETENTION_STATUS_LABEL}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
