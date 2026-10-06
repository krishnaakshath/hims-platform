import { notFound } from 'next/navigation'
import { Megaphone, Mail, MessageCircle } from 'lucide-react'
import { requirePatientSessionOrRedirect } from '@/lib/patient-session'
import { getPatientPortalData } from '@/lib/queries/patient-portal'
import { listBroadcastsForPatient } from '@/lib/queries/broadcasts'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'

const SECTION = 'rounded-xl border border-primary/10 bg-card/80 p-5 shadow-sm backdrop-blur-sm'
const HEADING = 'mb-3 border-l-2 border-primary/40 pl-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground'

const CHANNEL_ICON = { sms: MessageCircle, email: Mail, both: Megaphone } as const

/**
 * View-only -- a broadcast is a one-way announcement from the practice
 * (appointment reminders, trial updates), unlike Forms which need a patient
 * response. No reply affordance here on purpose.
 */
export default async function PatientPortalBroadcastsPage() {
  const session = await requirePatientSessionOrRedirect()
  const data = await getPatientPortalData(session.patientId)
  if (!data) notFound()

  const broadcasts = await listBroadcastsForPatient(session.patientId)
  await logPatientPortalAction('viewed patient portal broadcasts', session.patientId)

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-foreground">Announcements</h1>

      <section className={SECTION}>
        <h2 className={HEADING}>From your care team</h2>
        {broadcasts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No announcements yet.</p>
        ) : (
          <ul className="space-y-3">
            {broadcasts.map((b) => {
              const Icon = CHANNEL_ICON[b.channel]
              return (
                <li key={b.id} className="flex items-start gap-3 rounded-lg border border-border bg-secondary/30 px-4 py-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary" aria-hidden="true">
                    <Icon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    {b.subject && <p className="text-sm font-semibold text-foreground">{b.subject}</p>}
                    <p className="text-sm text-foreground">{b.message}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{new Date(b.sentAt).toLocaleString()}</p>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
