import { redirect } from 'next/navigation'
import { DollarSign, Clock, Receipt } from 'lucide-react'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listAllDispensesWithBilling } from '@/lib/queries/medication-dispenses'
import { PharmacyBillingTable } from '@/components/PharmacyBillingTable'
import { formatCents } from '@/lib/format'

function StatTile({ value, label, icon: Icon, tone }: { value: string; label: string; icon: React.ComponentType<{ className?: string }>; tone: string }) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-border bg-card p-4">
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tone}`} aria-hidden="true">
        <Icon className="h-4.5 w-4.5" />
      </span>
      <div>
        <p className="text-2xl font-bold tabular-nums text-foreground">{value}</p>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      </div>
    </div>
  )
}

// Pharmacy's own billing -- deliberately separate from the Billing role's
// revenue-cycle dashboard, which covers the whole practice's charges
// (visits, procedures, everything). This page shows only the charges that
// came from a medication dispense: what pharmacy actually generates.
export default async function PharmacyBillingPage() {
  const session = await requireSessionOrRedirect()
  if (!['pharmacy', 'admin'].includes(session.role)) redirect('/')

  const dispenses = await listAllDispensesWithBilling()
  await logAudit(session, 'viewed pharmacy billing', null)

  const unbilled = dispenses.filter((d) => d.charge === null)
  const billedCents = dispenses.reduce((sum, d) => sum + (d.charge?.amountCents ?? 0), 0)

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">Pharmacy Billing</h1>
        <p className="mt-1 text-sm text-muted-foreground">Charges generated from dispensed medications only -- not the practice&apos;s general revenue cycle.</p>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile value={formatCents(billedCents)} label="Total Billed" icon={DollarSign} tone="bg-success/10 text-success" />
        <StatTile value={String(unbilled.length)} label="Awaiting Billing" icon={Clock} tone="bg-warning/10 text-warning" />
        <StatTile value={String(dispenses.length)} label="Total Dispenses" icon={Receipt} tone="bg-primary/10 text-primary" />
      </div>

      {dispenses.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No dispenses on file.</p>
      ) : (
        <PharmacyBillingTable rows={dispenses.map((d) => ({
          dispenseId: d.dispenseId,
          patientId: d.patientId,
          patientName: d.patientName,
          medicationName: d.medicationName,
          quantity: d.quantity,
          dispensedByName: d.dispensedByName,
          dispensedAt: d.dispensedAt.toISOString(),
          charge: d.charge,
        }))} />
      )}
    </div>
  )
}
