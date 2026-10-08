import { formatIstDate } from '@/lib/india-time'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { IndianRupee, TrendingUp, ShieldCheck, HandCoins, Receipt, Clock, CheckCircle2, AlertTriangle, BarChart3, Tags, Percent, CalendarDays, Pill, FileText, ClipboardPlus, Banknote } from 'lucide-react'
import { TARIFF_MANAGE_ROLES } from '@/lib/role-policy'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getArDashboardData } from '@/lib/queries/ar-dashboard'
import { listCharges } from '@/lib/queries/charges'
import { listPatientCollections } from '@/lib/queries/patient-collections'
import { ArAgingChart } from '@/components/ArAgingChart'
import { formatPaise } from '@/lib/format'
import type { ChargeStatus } from '@/lib/charge-status'
// Wave E P1-19: every tile drills into the list it counts.
import { getBillingQueue, getCollectionsToday } from '@/lib/queries/hospital-kpis'
import { KpiTile } from '@/components/dashboards/KpiTile'
import { CASH_DESK_ROLES } from '@/lib/role-policy'

const SECTION = 'overflow-hidden rounded-md border border-border bg-card'
const SECTION_HEADER = 'flex items-center justify-between border-b border-border px-5 py-3'
const SECTION_TITLE = 'text-sm font-semibold text-foreground'

// Matches ChargesTable.tsx's STATUS_DOT -- the real 4-state charge_status
// enum (src/lib/charge-status.ts), not an imagined denied/paid/written_off
// workflow that charges never actually enter.
const CHARGE_STATUS_BADGE: Record<ChargeStatus, string> = {
  draft: 'bg-muted text-muted-foreground',
  pending_approval: 'bg-warning/10 text-warning',
  approved: 'bg-primary/10 text-primary',
  submitted: 'bg-success/10 text-success',
}

export default async function BillingHomePage() {
  const session = await requireSessionOrRedirect()
  if (!['admin', 'crc', 'billing'].includes(session.role)) redirect('/')

  const [arData, charges, collections, queue, today] = await Promise.all([
    getArDashboardData(),
    listCharges(),
    listPatientCollections(),
    getBillingQueue(),
    getCollectionsToday(),
  ])

  await logAudit(session, 'viewed billing dashboard home', null)

  // KPI calculations
  const draftCharges = charges.filter((c) => c.status === 'draft')
  const submittedCharges = charges.filter((c) => c.status === 'submitted')
  const approvedCharges = charges.filter((c) => c.status === 'approved')
  const pendingCharges = charges.filter((c) => c.status === 'pending_approval')

  const totalBilledCents = charges.filter(c => c.status !== 'draft').reduce((s, c) => s + c.amountCents, 0)
  const outstandingCollections = collections.filter((c) => c.balanceCents > 0)

  return (
    <div>
      {/* Page Header */}
      <div className="mb-6 flex items-center justify-between border-b border-border pb-5">
        <div>
          <h1 className="text-xl font-bold text-foreground">Billing Dashboard</h1>
          <p className="text-sm text-muted-foreground">Revenue cycle — from registration to discharge</p>
        </div>
        {/* SP8: the simulated eligibility check is retired; coverage is checked through NHCX on the patient's policy. */}
      </div>

      {/* Wave E P1-19: KPI tiles, each linking to the list it counts. */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiTile label="Outstanding A/R" value={formatPaise(arData.outstandingArCents)} href="/billing/ar-dashboard" icon={TrendingUp} />
        <KpiTile label="Gross Collection Rate" value={`${arData.grossCollectionRate.toFixed(1)}%`} href="/billing/analytics" icon={Percent} tone="muted" />
        <KpiTile label="Avg Days in A/R" value={`${arData.avgDaysInAr.toFixed(0)} days`} href="/billing/ar-dashboard" icon={CalendarDays} tone="muted" />
        <KpiTile label="Total Billed" value={formatPaise(totalBilledCents)} href="/billing/charges" icon={IndianRupee} tone="muted" />
      </div>

      {/* SP4 work queue and the day's takings. */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiTile label="Draft invoices" value={queue.draftInvoices} sub="Waiting to be finalised" href="/billing/invoices?status=draft" icon={FileText} tone={queue.draftInvoices > 0 ? 'warning' : 'primary'} />
        <KpiTile label="Lines to invoice" value={queue.uninvoicedLines} sub={`${formatPaise(queue.uninvoicedPaise)} captured, not invoiced`} href="/billing/capture" icon={ClipboardPlus} />
        <KpiTile label="Pharmacy drafts to review" value={queue.pharmacyDraftCharges} sub="Bills raised at the pharmacy" href="/billing/charges?status=draft&source=pharmacy" icon={Pill} tone={queue.pharmacyDraftCharges > 0 ? 'warning' : 'primary'} />
        {CASH_DESK_ROLES.includes(session.role) && (
          <KpiTile label="Collected today" value={formatPaise(today.netPaise)} sub={`${today.receiptCount} receipt${today.receiptCount === 1 ? '' : 's'}`} href="/cash-desk" icon={Banknote} tone="success" />
        )}
      </div>

      {/* Charge workflow by status: each opens /billing/charges on that status. */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiTile label="Draft" value={draftCharges.length} href="/billing/charges?status=draft" icon={Clock} tone="muted" />
        <KpiTile label="Pending Approval" value={pendingCharges.length} href="/billing/charges?status=pending_approval" icon={AlertTriangle} tone="warning" />
        <KpiTile label="Approved" value={approvedCharges.length} href="/billing/charges?status=approved" icon={CheckCircle2} tone="success" />
        <KpiTile label="Submitted" value={submittedCharges.length} href="/billing/charges?status=submitted" icon={Receipt} />
      </div>
      {/* SP8: the simulated eligibility checks (and their demo follow-up count) are retired; coverage is checked through NHCX. */}

      {/* Two column: AR Aging + Quick Nav */}
      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        {/* AR Aging Chart */}
        <div className={`lg:col-span-2 ${SECTION}`}>
          <div className={SECTION_HEADER}>
            <span className={SECTION_TITLE}>A/R Aging Breakdown</span>
            <Link href="/billing/ar-dashboard" className="text-xs font-medium text-primary hover:underline">Full A/R →</Link>
          </div>
          <div className="p-5">
            <ArAgingChart buckets={arData.agingBuckets} />
          </div>
        </div>

        {/* Quick Navigation */}
        <div className={SECTION}>
          <div className={SECTION_HEADER}>
            <span className={SECTION_TITLE}>Billing Modules</span>
          </div>
          <nav className="divide-y divide-border">
            {[
              { href: '/billing/charges', icon: Receipt, label: 'Charges', sub: 'Manage & approve charges' },
              { href: '/billing/insurance-collections', icon: ShieldCheck, label: 'Insurance Collections', sub: 'Claims & EOBs' },
              { href: '/billing/patient-collections', icon: HandCoins, label: 'Patient Collections', sub: 'Balances & statements' },
              { href: '/billing/statements', icon: IndianRupee, label: 'Statements', sub: 'Generate patient statements' },
              { href: '/billing/analytics', icon: BarChart3, label: 'Analytics', sub: 'Revenue trends & reports' },
              // Wave B P0-01: Tariffs only for the roles its page admits (TARIFF_MANAGE_ROLES).
              ...(TARIFF_MANAGE_ROLES.includes(session.role) ? [{ href: '/tariffs', icon: Tags, label: 'Tariffs', sub: 'Service catalogue & price lists' }] : []),
            ].map(({ href, icon: Icon, label, sub }) => (
              <Link key={href} href={href} className="flex items-center gap-3 px-5 py-3.5 hover:bg-muted/40">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <Icon className="h-4 w-4" />
                </span>
                <div>
                  <p className="text-sm font-medium text-foreground">{label}</p>
                  <p className="text-xs text-muted-foreground">{sub}</p>
                </div>
              </Link>
            ))}
          </nav>
        </div>
      </div>

      {/* Recent Charges Table */}
      <div className={SECTION}>
        <div className={SECTION_HEADER}>
          <span className={SECTION_TITLE}>Recent Charges</span>
          <Link href="/billing/charges" className="text-xs font-medium text-primary hover:underline">View all →</Link>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="p-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Patient</th>
                <th className="p-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Provider</th>
                <th className="p-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Date of Service</th>
                <th className="p-3 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">Amount</th>
                <th className="p-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</th>
              </tr>
            </thead>
            <tbody>
              {charges.slice(0, 10).map((charge) => (
                <tr key={charge.id} className="border-b border-border last:border-0 hover:bg-muted/20">
                  <td className="p-3 font-medium text-foreground">
                    <Link href={`/billing/charges/${charge.id}`} className="hover:underline">{charge.patientName}</Link>
                  </td>
                  <td className="p-3 text-muted-foreground">{charge.providerName}</td>
                  <td className="p-3 text-muted-foreground">{formatIstDate(charge.dateOfService)}</td>
                  <td className="p-3 text-right font-medium tabular-nums text-foreground">{formatPaise(charge.amountCents)}</td>
                  <td className="p-3">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize ${CHARGE_STATUS_BADGE[charge.status] ?? 'bg-muted text-muted-foreground'}`}>
                      {charge.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Outstanding Collections */}
        {outstandingCollections.length > 0 && (
          <>
            <div className="border-t border-border px-5 py-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Patient Balances Requiring Attention</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/40">
                    <th className="p-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Patient</th>
                    <th className="p-3 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">Balance Due</th>
                    <th className="p-3 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">Unapplied Payments</th>
                  </tr>
                </thead>
                <tbody>
                  {outstandingCollections.slice(0, 5).map((col) => (
                    <tr key={col.patientId} className="border-b border-border last:border-0 hover:bg-muted/20">
                      <td className="p-3 font-medium text-foreground">{col.patientName}</td>
                      <td className="p-3 text-right font-medium tabular-nums text-destructive">{formatPaise(col.balanceCents)}</td>
                      <td className="p-3 text-right tabular-nums text-muted-foreground">{formatPaise(col.unappliedCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
