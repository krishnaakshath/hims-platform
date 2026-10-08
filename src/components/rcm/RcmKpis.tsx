import Link from 'next/link'
import { formatPaise } from '@/lib/format'
import { CLAIM_WORKLISTS, CLAIM_WORKLIST_LABEL } from '@/lib/rcm/claim-status'
import { SLA_FLAGS, SLA_FLAG_LABEL } from '@/lib/rcm/sla'
import type { RcmDashboard } from '@/lib/queries/rcm-worklist'

export function RcmKpis({ data }: { data: RcmDashboard }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {CLAIM_WORKLISTS.map((w) => (
          <Link key={w} href={`/rcm/claims?tab=${w}`} className="rounded-lg border border-border bg-card p-3 hover:bg-muted">
            <p className="text-xs text-muted-foreground">{CLAIM_WORKLIST_LABEL[w]}</p>
            <p className="text-2xl font-semibold tabular-nums">{data.counts[w]}</p>
          </Link>
        ))}
        <Link href="/rcm/preauths?status=requested" className="rounded-lg border border-border bg-card p-3 hover:bg-muted">
          <p className="text-xs text-muted-foreground">Pre-auth decisions overdue</p>
          <p className="text-2xl font-semibold tabular-nums">{data.counts.preauthsOverdue}</p>
        </Link>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">Money</h2>
          <dl className="mt-2 space-y-1 text-sm">
            <div className="flex justify-between"><dt>Insurer outstanding</dt><dd className="tabular-nums">{formatPaise(data.insurerOutstandingPaise)}</dd></div>
            <div className="flex justify-between"><dt>Settled this month</dt><dd className="tabular-nums">{formatPaise(data.settledThisMonthPaise)}</dd></div>
            <div className="flex justify-between"><dt>TDS this month</dt><dd className="tabular-nums">{formatPaise(data.tdsThisMonthPaise)}</dd></div>
          </dl>
        </section>
        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">Ageing of insurer outstanding (days since first submission)</h2>
          <table className="mt-2 w-full text-sm">
            <tbody>{data.aging.map((a) => <tr key={a.label}><td>{a.label}</td><td className="text-right tabular-nums">{formatPaise(a.paise)}</td></tr>)}</tbody>
          </table>
        </section>
        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">SLA breaches</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {SLA_FLAGS.map((f) => <li key={f} className="flex justify-between"><span>{SLA_FLAG_LABEL[f]}</span><span className="tabular-nums">{data.slaBreaches[f]}</span></li>)}
          </ul>
        </section>
      </div>
    </div>
  )
}
