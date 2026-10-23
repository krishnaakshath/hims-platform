// /rcm/preauths/new?q=&patientId=&admissionId=&encounterId=: find the patient, then their active
// policies and the pre-auth form (RCM_ROLES). WS12 T8: the form starts from the admission or visit
// (preauthDefaultsFor) and the page shows the policy's coverage badge in the pre-auth context, on
// the planned admission date.
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { RCM_ROLES } from '@/lib/role-policy'
import { findPatientsForRcm, listPatientPolicies } from '@/lib/queries/rcm-policies'
import { listPatientEpisodes, preauthDefaultsFor } from '@/lib/queries/preauths'
import { getCoverageSummary } from '@/lib/queries/coverage'
import { CoverageBadge } from '@/components/insurance/CoverageBadge'
import { listActiveProviders } from '@/lib/queries/providers'
import { PreauthForm } from '@/components/rcm/PreauthForm'
import { formatIsoDate } from '@/lib/india-time'

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
/** A positive integer id from a search param, else undefined (a bad value is ignored, not an error). */
const idParam = (v: string | string[] | undefined): number | undefined => {
  const s = one(v) ?? ''
  if (!/^\d{1,9}$/.test(s)) return undefined
  const n = Number(s)
  return n > 0 ? n : undefined
}

export default async function NewPreauthPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSessionOrRedirect()
  if (!RCM_ROLES.includes(session.role)) redirect('/')

  const sp = await searchParams
  const q = (one(sp.q) ?? '').slice(0, 60)
  const patientId = (one(sp.patientId) ?? '').slice(0, 40)
  const hits = q.trim().length >= 2 ? await findPatientsForRcm(q) : []
  let form: React.ReactNode = null
  if (patientId) {
    const now = new Date()
    const [policies, episodes, doctors, defaults] = await Promise.all([
      listPatientPolicies(patientId), listPatientEpisodes(patientId), listActiveProviders(),
      preauthDefaultsFor(patientId, { admissionId: idParam(sp.admissionId), encounterId: idParam(sp.encounterId) }, now),
    ])
    const active = policies.filter((p) => p.status === 'active')
    const coverage = active.length === 0 ? null : await getCoverageSummary(patientId, 'preauth', now, undefined, defaults.plannedAdmissionDate ?? undefined)
    const verdict = coverage ? (coverage.policies.find((c) => c.policyId === defaults.policyId) ?? coverage.primary)?.verdict ?? null : null
    await logAudit(session, 'rcm: viewed patient policies', patientId, 'context=preauth')
    form = active.length === 0
      ? <p className="text-sm text-muted-foreground">This patient has no active policy. <Link className="text-primary hover:underline" href={`/rcm/policies?patientId=${encodeURIComponent(patientId)}`}>Add a policy</Link> first.</p>
      : (
        <div className="space-y-3">
          {verdict && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">Coverage{defaults.plannedAdmissionDate ? ` on ${formatIsoDate(defaults.plannedAdmissionDate)}` : ''}:</span>
              <CoverageBadge verdict={verdict} />
              {verdict.detail && <span className="text-xs text-muted-foreground">{verdict.detail}</span>}
            </div>
          )}
          <PreauthForm policies={active.map((p) => ({ id: p.id, label: `${p.insurer.name}${p.tpa ? ` via ${p.tpa.name}` : ''} · ${p.policyNumber} (${p.priority})` }))}
            admissions={episodes.admissions} encounters={episodes.encounters} doctors={doctors.map((d) => ({ id: d.id, name: d.name }))} defaults={defaults} />
        </div>
      )
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
