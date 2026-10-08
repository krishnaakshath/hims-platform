import Link from 'next/link'
import { redirect } from 'next/navigation'
import { RCM_ROLES } from '@/lib/role-policy' // SP7
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listInsuranceClaims } from '@/lib/queries/insurance-claims'
import { InsuranceClaimsTable } from '@/components/InsuranceClaimsTable'

export default async function InsuranceCollectionsPage() {
  const session = await requireSessionOrRedirect()
  // LeftNav.tsx:98 — the Billing group is rendered for admin/crc/frontdesk only.
  if (!['admin', 'crc', 'billing'].includes(session.role)) redirect('/')
  const claims = await listInsuranceClaims()
  await logAudit(session, 'viewed insurance collections', null)

  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold text-foreground">Insurance Collections (legacy demo data)</h1>
      {/* SP7 (ruling 6): this page shows the legacy demo claims; real claims live under RCM. */}
      <p className="mb-6 text-sm text-muted-foreground">Insurance claims are managed under {RCM_ROLES.includes(session.role) ? <Link href="/rcm" className="text-primary hover:underline">RCM</Link> : 'RCM'}.</p>
      <InsuranceClaimsTable claims={claims} linkPatients={session.role !== 'billing'} />
    </div>
  )
}
