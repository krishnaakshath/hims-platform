// /rcm/claims: claim worklists (RCM_ROLES), 50 per page. A list of claims (name and UHID only).
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { RCM_ROLES } from '@/lib/role-policy'
import { CLAIM_STATUSES, CLAIM_WORKLISTS, CLAIM_WORKLIST_LABEL, type ClaimStatus, type ClaimWorklist } from '@/lib/rcm/claim-status'
import { listClaims } from '@/lib/queries/rcm-worklist'
import { ClaimWorklistTable } from '@/components/rcm/ClaimWorklistTable'

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export default async function ClaimsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSessionOrRedirect()
  if (!RCM_ROLES.includes(session.role)) redirect('/')

  const sp = await searchParams
  const tabRaw = one(sp.tab)
  const tab = (CLAIM_WORKLISTS as readonly string[]).includes(tabRaw ?? '') ? (tabRaw as ClaimWorklist) : undefined
  const statusRaw = one(sp.status)
  const status = (CLAIM_STATUSES as readonly string[]).includes(statusRaw ?? '') ? (statusRaw as ClaimStatus) : undefined
  const payerId = /^\d{1,9}$/.test(one(sp.payerId) ?? '') ? Number(one(sp.payerId)) : undefined
  const q = (one(sp.q) ?? '').slice(0, 40)
  const page = /^\d{1,4}$/.test(one(sp.page) ?? '') ? Math.max(1, Number(one(sp.page))) : 1

  const { rows, total } = await listClaims({ tab, status, payerId, q: q || undefined, page })
  await logAudit(session, 'rcm: viewed claim worklist', null, `tab=${tab ?? 'all'}`)
  const from = total === 0 ? 0 : (page - 1) * 50 + 1
  const to = Math.min(total, page * 50)
  const href = (p: Record<string, string | undefined>) => `/rcm/claims?${new URLSearchParams(Object.entries({ tab, q: q || undefined, ...p }).filter((e): e is [string, string] => e[1] !== undefined)).toString()}`
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-foreground">Claims</h1>
      <nav className="flex flex-wrap gap-2 text-sm" aria-label="Worklists">
        {CLAIM_WORKLISTS.map((w) => <Link key={w} href={`/rcm/claims?tab=${w}`} className={`rounded-md border px-3 py-1 ${tab === w ? 'border-primary bg-primary/10' : 'border-border'}`}>{CLAIM_WORKLIST_LABEL[w]}</Link>)}
        <Link href="/rcm/claims" className={`rounded-md border px-3 py-1 ${tab === undefined ? 'border-primary bg-primary/10' : 'border-border'}`}>All</Link>
      </nav>
      <form className="flex gap-2" action="/rcm/claims">
        {tab && <input type="hidden" name="tab" value={tab} />}
        <input name="q" defaultValue={q} placeholder="Claim number or UHID" className="w-64 rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
        <button type="submit" className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted">Search</button>
      </form>
      <ClaimWorklistTable rows={rows} />
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>Showing {from}–{to} of {total}</span>
        <span className="flex gap-2">
          {page > 1 && <Link href={href({ page: String(page - 1) })} className="hover:underline">Previous</Link>}
          {to < total && <Link href={href({ page: String(page + 1) })} className="hover:underline">Next</Link>}
        </span>
      </div>
    </div>
  )
}
