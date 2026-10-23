// /rcm: the RCM dashboard (RCM_ROLES; the rcm role's home). Worklist counts, SLA breaches, insurer
// outstanding with ageing, this IST month's settlements and TDS, and episodes ready to claim.
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { RCM_ROLES, RCM_SETTINGS_ROLES } from '@/lib/role-policy'
import { getRcmDashboard, listClaimCandidates } from '@/lib/queries/rcm-worklist'
import { getInsuranceAttention } from '@/lib/queries/coverage-attention'
import { RcmKpis } from '@/components/rcm/RcmKpis'
import { ClaimCandidateTable } from '@/components/rcm/ClaimCandidateTable'
import { InsuranceAttentionTiles } from '@/components/rcm/InsuranceAttentionTiles'

export default async function RcmDashboardPage() {
  const session = await requireSessionOrRedirect()
  if (!RCM_ROLES.includes(session.role)) redirect('/')

  const [dashboard, candidates, attention] = await Promise.all([getRcmDashboard(), listClaimCandidates(), getInsuranceAttention()])
  await logAudit(session, 'rcm: viewed RCM dashboard', null)
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Revenue cycle</h1>
          <p className="text-sm text-muted-foreground">Cashless claims, pre-authorisations and insurer settlements.</p>
        </div>
        <div className="flex flex-wrap gap-2 text-sm">
          <Link href="/rcm/claims" className="rounded-lg border border-border px-3 py-1.5 hover:bg-muted">All claims</Link>
          <Link href="/rcm/preauths" className="rounded-lg border border-border px-3 py-1.5 hover:bg-muted">Pre-authorisations</Link>
        </div>
      </div>
      <InsuranceAttentionTiles data={attention} canEditSettings={RCM_SETTINGS_ROLES.includes(session.role)} />
      <RcmKpis data={dashboard} />
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Ready to claim ({candidates.length})</h2>
        <ClaimCandidateTable rows={candidates} />
      </section>
    </div>
  )
}
