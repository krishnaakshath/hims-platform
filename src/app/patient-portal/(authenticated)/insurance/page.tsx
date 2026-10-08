// Wave J (P1-20): read-only insurance policies (SP7) and ABHA status for the signed-in
// patient. Changes go through the front desk; the portal never edits either.
import { ShieldCheck, IdCard } from 'lucide-react'
import { requirePatientSessionOrRedirect } from '@/lib/patient-session'
import { getPortalAbhaStatus, listPortalPolicies } from '@/lib/queries/patient-portal-records'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'
import { formatPaise } from '@/lib/format'
import { formatIsoDate } from '@/lib/india-time'

const SECTION = 'rounded-xl border border-primary/10 bg-card/80 p-5 shadow-sm backdrop-blur-sm'
const HEADING = 'mb-3 border-l-2 border-primary/40 pl-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground'

const POLICY_TYPE_LABEL: Record<string, string> = { individual: 'Individual', family_floater: 'Family floater', group_corporate: 'Group / corporate', government_scheme: 'Government scheme' }
const RELATIONSHIP_LABEL: Record<string, string> = { self: 'Self', spouse: 'Spouse', child: 'Child', parent: 'Parent', sibling: 'Sibling', other: 'Other' }
const ABHA_UNAVAILABLE_LABEL: Record<string, string> = { not_created: 'Not created yet', patient_declined: 'You chose not to link one', emergency: 'Not recorded (emergency visit)', other: 'Not recorded' }

function Detail({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm font-medium text-foreground">{value ?? <span className="font-normal text-muted-foreground">Not on file</span>}</dd>
    </div>
  )
}

export default async function PatientPortalInsurancePage() {
  const session = await requirePatientSessionOrRedirect()
  const [policies, abha] = await Promise.all([listPortalPolicies(session.patientId), getPortalAbhaStatus(session.patientId)])
  await logPatientPortalAction('viewed patient portal insurance', session.patientId)
  const hasAbha = Boolean(abha?.abhaNumberMasked || abha?.abhaAddress)

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-foreground">Insurance &amp; health ID</h1>

      <section className={SECTION} aria-labelledby="policies-heading">
        <h2 id="policies-heading" className={HEADING}>Insurance policies</h2>
        {policies.length === 0 ? (
          <p className="text-sm text-muted-foreground">No insurance policy on file. Bring your policy card to the front desk to add one.</p>
        ) : (
          <ul className="space-y-3">
            {policies.map((p) => (
              <li key={p.id} className="rounded-lg border border-border bg-secondary/30 p-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />
                    {p.insurerName}{p.planName ? ` · ${p.planName}` : ''}
                  </p>
                  <span className="text-xs font-medium text-muted-foreground">
                    {p.status === 'active' ? (p.priority === 'primary' ? 'Active · primary' : 'Active · secondary') : 'Inactive'}
                  </span>
                </div>
                <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <Detail label="Policy number" value={p.policyNumber} />
                  <Detail label="Member ID" value={p.memberId} />
                  <Detail label="Type" value={POLICY_TYPE_LABEL[p.policyType] ?? p.policyType} />
                  <Detail label="Policy holder" value={`${p.holderName} (${RELATIONSHIP_LABEL[p.relationship] ?? p.relationship})`} />
                  <Detail label="Valid" value={`${formatIsoDate(p.validFrom)} – ${formatIsoDate(p.validTo)}`} />
                  <Detail label="Sum insured" value={p.sumInsuredPaise === null ? null : formatPaise(p.sumInsuredPaise)} />
                  {p.tpaName && <Detail label="TPA" value={p.tpaName} />}
                  {p.corporateName && <Detail label="Employer" value={p.corporateName} />}
                </dl>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={SECTION} aria-labelledby="abha-heading">
        <h2 id="abha-heading" className={HEADING}>ABHA (Ayushman Bharat Health Account)</h2>
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden="true">
            <IdCard className="h-5 w-5" />
          </span>
          {hasAbha ? (
            <dl className="grid flex-1 grid-cols-1 gap-3 sm:grid-cols-2">
              <Detail label="ABHA number" value={abha?.abhaNumberMasked ?? null} />
              <Detail label="ABHA address" value={abha?.abhaAddress ?? null} />
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">
              {abha?.unavailableReason ? ABHA_UNAVAILABLE_LABEL[abha.unavailableReason] : 'No ABHA linked to your hospital record.'} Ask at the front desk to link one.
            </p>
          )}
        </div>
      </section>
      <p className="text-xs text-muted-foreground">These details are read-only here. To change them, please contact the front desk.</p>
    </div>
  )
}
