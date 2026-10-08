// /rcm/payers: the insurer/TPA master (RCM_ROLES). No PHI, so not audited on view.
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { RCM_ROLES } from '@/lib/role-policy'
import { CHANNEL_LABEL, PAYER_KIND_LABEL } from '@/lib/rcm/constants'
import { listRcmPayers } from '@/lib/queries/rcm-payers'
import { PayerProfileForm } from '@/components/rcm/PayerProfileForm'
import { EMPTY_PROFILE } from '@/components/rcm/payer-profile-values'

export default async function PayersPage() {
  const session = await requireSessionOrRedirect()
  if (!RCM_ROLES.includes(session.role)) redirect('/')

  const rows = await listRcmPayers({ includeInactive: true })
  const profiled = rows.filter((r) => r.profile !== null)
  const legacy = rows.filter((r) => r.profile === null)
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-foreground">Insurers &amp; TPAs</h1>
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground"><tr><th className="px-3 py-2">Name</th><th className="px-3 py-2">Kind</th><th className="px-3 py-2">Empanelment</th><th className="px-3 py-2">Channel</th><th className="px-3 py-2">SLA</th><th className="px-3 py-2">Active</th></tr></thead>
          <tbody>
            {profiled.map((r) => (
              <tr key={r.payerId} className="border-t border-border">
                <td className="px-3 py-2"><Link href={`/rcm/payers/${r.payerId}`} className="text-primary hover:underline">{r.name}</Link> <span className="text-xs text-muted-foreground">{r.code}</span></td>
                <td className="px-3 py-2">{PAYER_KIND_LABEL[r.profile!.kind]}</td>
                <td className="px-3 py-2">{r.profile!.empanelmentStatus.replace('_', ' ')}</td>
                <td className="px-3 py-2">{CHANNEL_LABEL[r.profile!.defaultChannel]}</td>
                <td className="px-3 py-2">{r.profile!.preauthSlaHours} h / {r.profile!.claimSettlementSlaDays} d</td>
                <td className="px-3 py-2">{r.profile!.active ? 'Yes' : 'No'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {legacy.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Needs a profile</h2>
          <ul className="rounded-lg border border-border bg-card text-sm">{legacy.map((r) => <li key={r.payerId} className="border-t border-border px-3 py-2 first:border-t-0"><Link href={`/rcm/payers/${r.payerId}`} className="text-primary hover:underline">{r.name}</Link> <span className="text-xs text-muted-foreground">{r.code}</span></li>)}</ul>
        </section>
      )}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Add insurer or TPA</h2>
        <PayerProfileForm payerId={null} initial={EMPTY_PROFILE} />
      </section>
    </div>
  )
}
