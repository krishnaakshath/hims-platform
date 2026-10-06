import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { requirePatientSessionOrRedirect } from '@/lib/patient-session'
import { getPatientPortalData } from '@/lib/queries/patient-portal'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'
import { SignConsentFormAction } from '@/components/SignConsentFormAction'

const SECTION = 'rounded-xl border border-primary/10 bg-card/80 p-5 shadow-sm backdrop-blur-sm'
const HEADING = 'mb-3 border-l-2 border-primary/40 pl-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground'

const FORM_STATUS_STYLE: Record<string, string> = {
  sent: 'bg-amber-500/10 text-amber-700',
  partial: 'bg-sky-500/10 text-sky-700',
  completed: 'bg-emerald-500/10 text-emerald-700',
}

const FORM_STATUS_LABEL: Record<string, string> = {
  sent: 'Needs your response',
  partial: 'In progress',
  completed: 'Completed',
}

export default async function PatientPortalFormsPage() {
  const session = await requirePatientSessionOrRedirect()
  const data = await getPatientPortalData(session.patientId)
  if (!data) notFound()

  await logPatientPortalAction('viewed patient portal forms', session.patientId)

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-foreground">Forms</h1>
      <section className={SECTION}>
        <h2 className={HEADING}>Your forms</h2>
        {data.forms.length === 0 ? (
          <p className="text-sm text-muted-foreground">No forms have been sent to you yet.</p>
        ) : (
          <ul className="space-y-2 text-sm text-foreground">
            {data.forms.map((f) => (
              <li key={f.id} className="space-y-3 border-b border-border pb-3 last:border-0 last:pb-0">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{f.templateName}</p>
                    <p className="text-xs text-muted-foreground">Sent {new Date(f.sentDate).toLocaleDateString()}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${FORM_STATUS_STYLE[f.status]}`}>{FORM_STATUS_LABEL[f.status]}</span>
                    {f.status !== 'completed' && f.accessToken && (
                      <Link href={`/intake/${f.accessToken}`} className="flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                        {f.status === 'sent' ? 'Start' : 'Continue'}
                        <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                      </Link>
                    )}
                  </div>
                </div>
                {/* Only offer signing once the patient has actually opened/started this
                    form (status 'partial' -- there are real answers on file). A 'sent'
                    submission has never been opened and has no answers yet; signing it
                    here would attest to content the patient never saw, and would
                    permanently kill the token (via isSubmissionTokenValid) before they
                    ever got to answer the form's real questions. The sign route enforces
                    this same rule independently -- this client-side gate is UX, not the
                    security boundary. Also suppressed when the submission has attached
                    consents: those are signed inside the form itself (the Continue link
                    above), and the sign route 409s for them. */}
                {f.category === 'Consent Forms' && f.status === 'partial' && !f.hasAttachedConsents && (
                  <SignConsentFormAction patientId={session.patientId} formSubmissionId={f.id} />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
