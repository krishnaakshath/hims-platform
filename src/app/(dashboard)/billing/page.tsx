import { redirect } from 'next/navigation'
import Link from 'next/link'
import { DollarSign, TrendingUp, ShieldCheck, HandCoins, Receipt, Clock, CheckCircle2, AlertTriangle, BarChart3 } from 'lucide-react'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getArDashboardData } from '@/lib/queries/ar-dashboard'
import { listCharges } from '@/lib/queries/charges'
import { listPatientCollections } from '@/lib/queries/patient-collections'
import { countEligibilityFollowUps } from '@/lib/queries/insurance-eligibility'
import { ArAgingChart } from '@/components/ArAgingChart'
import { EligibilityCheckButton } from '@/components/EligibilityCheckButton'
import { formatCents } from '@/lib/format'
import type { ChargeStatus } from '@/lib/charge-status'

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

  const [arData, charges, collections, eligibilityFollowUpCount] = await Promise.all([
    getArDashboardData(),
    listCharges(),
    listPatientCollections(),
    countEligibilityFollowUps(),
  ])

  await logAudit(session, 'viewed billing dashboard home', null)

  // KPI calculations
  const draftCharges = charges.filter((c) => c.status === 'draft')
  const submittedCharges = charges.filter((c) => c.status === 'submitted')
  const paidCharges = charges.filter((c) => c.status === 'approved')
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
        {/* Insurance verification lives entirely in billing now -- front
            desk previously ran eligibility checks at check-in. */}
        <EligibilityCheckButton />
      </div>

      {/* KPI Row — Mobbin-inspired: compact, data-dense tiles */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-md border border-border bg-card p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Outstanding A/R</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-foreground">{formatCents(arData.outstandingArCents)}</p>
        </div>
        <div className="rounded-md border border-border bg-card p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Gross Collection Rate</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-foreground">{arData.grossCollectionRate.toFixed(1)}%</p>
        </div>
        <div className="rounded-md border border-border bg-card p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Avg Days in A/R</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-foreground">{arData.avgDaysInAr.toFixed(0)} days</p>
        </div>
        <div className="rounded-md border border-border bg-card p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Total Billed</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-foreground">{formatCents(totalBilledCents)}</p>
        </div>
      </div>

      {/* Second KPI row — workflow status counts */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="flex items-center gap-3 rounded-md border border-border bg-card p-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted"><Clock className="h-4 w-4 text-muted-foreground" /></span>
          <div>
            <p className="text-lg font-bold tabular-nums text-foreground">{draftCharges.length}</p>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Draft</p>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-md border border-border bg-card p-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10"><Receipt className="h-4 w-4 text-primary" /></span>
          <div>
            <p className="text-lg font-bold tabular-nums text-foreground">{submittedCharges.length}</p>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Submitted</p>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-md border border-border bg-card p-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-success/10"><CheckCircle2 className="h-4 w-4 text-success" /></span>
          <div>
            <p className="text-lg font-bold tabular-nums text-foreground">{paidCharges.length}</p>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Approved</p>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-md border border-border bg-card p-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-warning/10"><AlertTriangle className="h-4 w-4 text-warning" /></span>
          <div>
            <p className="text-lg font-bold tabular-nums text-foreground">{pendingCharges.length}</p>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Pending Approval</p>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-md border border-border bg-card p-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-destructive/10"><ShieldCheck className="h-4 w-4 text-destructive" /></span>
          <div>
            <p className="text-lg font-bold tabular-nums text-foreground">{eligibilityFollowUpCount}</p>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Eligibility Follow-ups</p>
          </div>
        </div>
      </div>

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
              { href: '/billing/statements', icon: DollarSign, label: 'Statements', sub: 'Generate patient statements' },
              { href: '/billing/analytics', icon: BarChart3, label: 'Analytics', sub: 'Revenue trends & reports' },
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
                  <td className="p-3 text-muted-foreground">{new Date(charge.dateOfService).toLocaleDateString()}</td>
                  <td className="p-3 text-right font-medium tabular-nums text-foreground">{formatCents(charge.amountCents)}</td>
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
                      <td className="p-3 text-right font-medium tabular-nums text-destructive">{formatCents(col.balanceCents)}</td>
                      <td className="p-3 text-right tabular-nums text-muted-foreground">{formatCents(col.unappliedCents)}</td>
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
