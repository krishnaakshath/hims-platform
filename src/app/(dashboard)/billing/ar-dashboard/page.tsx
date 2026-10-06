import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getArDashboardData } from '@/lib/queries/ar-dashboard'
import { formatCents } from '@/lib/format'
import { ArAgingChart } from '@/components/ArAgingChart'

function KpiCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-bold text-foreground">{value}</p>
    </div>
  )
}

export default async function ArDashboardPage() {
  const session = await requireSessionOrRedirect()
  // LeftNav.tsx:98 — the Billing group is rendered for admin/crc/frontdesk only.
  if (!['admin', 'crc', 'billing'].includes(session.role)) redirect('/')
  const data = await getArDashboardData()
  await logAudit(session, 'viewed A/R dashboard', null)

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-foreground">A/R Dashboard</h1>

      <div className="grid grid-cols-3 gap-4">
        <KpiCard label="Outstanding A/R" value={formatCents(data.outstandingArCents)} />
        <KpiCard label="Gross Collection Rate" value={`${data.grossCollectionRate.toFixed(1)}%`} />
        <KpiCard label="Avg Days in A/R" value={data.avgDaysInAr.toFixed(0)} />
      </div>

      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">A/R Aging</h2>
        <ArAgingChart buckets={data.agingBuckets} />
      </section>
    </div>
  )
}
