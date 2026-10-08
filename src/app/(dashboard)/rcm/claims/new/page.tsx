// /rcm/claims/new?admissionId=|encounterId=&policyId=: build a draft claim (RCM_ROLES).
import { notFound, redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { RCM_ROLES } from '@/lib/role-policy'
import { parseId } from '@/lib/http'
import { getNewClaimContext } from '@/lib/queries/claims'
import { NewClaimForm } from '@/components/rcm/NewClaimForm'

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export default async function NewClaimPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSessionOrRedirect()
  if (!RCM_ROLES.includes(session.role)) redirect('/')

  const sp = await searchParams
  const admissionId = parseId(one(sp.admissionId))
  const encounterId = parseId(one(sp.encounterId))
  const policyId = parseId(one(sp.policyId))
  if (policyId === null || (admissionId === null) === (encounterId === null)) notFound()
  const ctx = await getNewClaimContext(admissionId !== null ? { admissionId } : { encounterId: encounterId! }, policyId)
  if (!ctx) notFound()
  await logAudit(session, 'rcm: viewed new claim', ctx.patient.id, `policy=${policyId}`)
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-foreground">New claim</h1>
        <p className="text-sm text-muted-foreground">{ctx.patient.name} · {ctx.patient.uhid ?? '—'} · {ctx.admissionId !== null ? `Admission ${ctx.admissionId}` : `Visit ${ctx.encounterId}`}</p>
      </div>
      {ctx.invoices.length === 0 ? <p className="text-sm text-muted-foreground">No finalised bill of this visit or stay is left to claim from this payer.</p> : <NewClaimForm ctx={ctx} />}
    </div>
  )
}
