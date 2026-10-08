// /rcm/preauths/new?q=&patientId=: find the patient, then their active policies and the pre-auth form (RCM_ROLES).
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { RCM_ROLES } from '@/lib/role-policy'
import { findPatientsForRcm, listPatientPolicies } from '@/lib/queries/rcm-policies'
import { listPatientEpisodes } from '@/lib/queries/preauths'
import { listActiveProviders } from '@/lib/queries/providers'
import { PreauthForm } from '@/components/rcm/PreauthForm'

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export default async function NewPreauthPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSessionOrRedirect()
  if (!RCM_ROLES.includes(session.role)) redirect('/')

  const sp = await searchParams
  const q = (one(sp.q) ?? '').slice(0, 60)
  const patientId = (one(sp.patientId) ?? '').slice(0, 40)
  const hits = q.trim().length >= 2 ? await findPatientsForRcm(q) : []
  let form: React.ReactNode = null
  if (patientId) {
    const [policies, episodes, doctors] = await Promise.all([listPatientPolicies(patientId), listPatientEpisodes(patientId), listActiveProviders()])
    const active = policies.filter((p) => p.status === 'active')
    await logAudit(session, 'rcm: viewed patient policies', patientId, 'context=preauth')
    form = active.length === 0
      ? <p className="text-sm text-muted-foreground">This patient has no active policy. <Link className="text-primary hover:underline" href={`/rcm/policies?patientId=${encodeURIComponent(patientId)}`}>Add a policy</Link> first.</p>
      : <PreauthForm policies={active.map((p) => ({ id: p.id, label: `${p.insurer.name}${p.tpa ? ` via ${p.tpa.name}` : ''} · ${p.policyNumber} (${p.priority})` }))}
          admissions={episodes.admissions} encounters={episodes.encounters} doctors={doctors.map((d) => ({ id: d.id, name: d.name }))} />
  }
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-foreground">New pre-authorisation</h1>
      <form className="flex gap-2" action="/rcm/preauths/new">
        <input name="q" defaultValue={q} placeholder="Patient name, UHID or ID" className="w-72 rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
        <button type="submit" className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted">Find patient</button>
      </form>
      {hits.length > 0 && (
        <ul className="rounded-lg border border-border bg-card text-sm">
          {hits.map((h) => <li key={h.id} className="border-t border-border px-3 py-2 first:border-t-0"><Link className="text-primary hover:underline" href={`/rcm/preauths/new?patientId=${encodeURIComponent(h.id)}`}>{h.name}</Link> · {h.uhid ?? '—'} · {h.gender ?? '—'} · {h.ageYears ?? '—'} y</li>)}
        </ul>
      )}
      {form}
    </div>
  )
}
