import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getBillingAnalyticsData } from '@/lib/queries/billing-analytics'
import { formatCents } from '@/lib/format'
import { BillingTrendChart } from '@/components/BillingTrendChart'

function KpiCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-bold text-foreground">{value}</p>
    </div>
  )
}

export default async function BillingAnalyticsPage() {
  const session = await requireSessionOrRedirect()
  // LeftNav.tsx:98 — the Billing group is rendered for admin/crc/frontdesk only.
  if (!['admin', 'crc', 'billing'].includes(session.role)) redirect('/')
  const data = await getBillingAnalyticsData()
  await logAudit(session, 'viewed billing analytics', null)

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-foreground">Billing Analytics</h1>

      <div className="grid grid-cols-3 gap-4">
        <KpiCard label="Patient Visits" value={String(data.patientVisits)} />
        <KpiCard label="Gross Charges" value={formatCents(data.grossChargesCents)} />
        <KpiCard label="Net Collections" value={formatCents(data.netCollectionsCents)} />
      </div>

      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Gross Charges vs. Net Collections</h2>
        {data.trend.length === 0 ? (
          <p className="text-sm text-muted-foreground">No records found.</p>
        ) : (
          <BillingTrendChart trend={data.trend} />
        )}
      </section>
    </div>
  )
}
