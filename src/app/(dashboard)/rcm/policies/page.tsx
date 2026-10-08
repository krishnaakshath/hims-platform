// /rcm/policies?q=&patientId=: find a patient and keep their insurance policies (RCM_ROLES).
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { POLICY_WRITE_ROLES, RCM_ROLES } from '@/lib/role-policy'
import { todayIsoIn } from '@/lib/india-time'
import { findPatientsForRcm, legacyPolicyPrefill, listPatientPolicies } from '@/lib/queries/rcm-policies'
import { listRcmPayers } from '@/lib/queries/rcm-payers'
import { PatientPoliciesPanel } from '@/components/rcm/PatientPoliciesPanel'

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export default async function RcmPoliciesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSessionOrRedirect()
  if (!RCM_ROLES.includes(session.role)) redirect('/')

  const sp = await searchParams
  const q = (one(sp.q) ?? '').slice(0, 60)
  const patientId = (one(sp.patientId) ?? '').slice(0, 40)
  const hits = q.trim().length >= 2 ? await findPatientsForRcm(q) : []
  let panel: React.ReactNode = null
  if (patientId) {
    const [match] = await findPatientsForRcm(patientId)
    if (match && match.id === patientId) {
      const [policies, payers, legacy] = await Promise.all([listPatientPolicies(patientId), listRcmPayers(), legacyPolicyPrefill(patientId)])
      await logAudit(session, 'rcm: viewed patient policies', patientId)
      panel = (
        <div className="space-y-2">
          <p className="text-sm">{match.name} · {match.uhid ?? '—'} · {match.gender ?? '—'} · {match.ageYears ?? '—'} y</p>
          <PatientPoliciesPanel patientId={patientId} policies={policies} todayIso={todayIsoIn()} canEdit={POLICY_WRITE_ROLES.includes(session.role)} legacyPrefill={legacy}
            payers={payers.filter((p) => p.profile?.active).map((p) => ({ payerId: p.payerId, name: p.name, kind: p.profile!.kind }))} />
        </div>
      )
    } else {
      panel = <p className="text-sm text-muted-foreground">Patient not found.</p>
    }
  }
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-foreground">Policies</h1>
      <form className="flex gap-2" action="/rcm/policies">
        <input name="q" defaultValue={q} placeholder="Patient name, UHID or ID" className="w-72 rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
        <button type="submit" className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted">Find patient</button>
      </form>
      {hits.length > 0 && (
        <ul className="rounded-lg border border-border bg-card text-sm">
          {hits.map((h) => <li key={h.id} className="border-t border-border px-3 py-2 first:border-t-0"><Link className="text-primary hover:underline" href={`/rcm/policies?patientId=${encodeURIComponent(h.id)}`}>{h.name}</Link> · {h.uhid ?? '—'}</li>)}
        </ul>
      )}
      {panel}
    </div>
  )
}
