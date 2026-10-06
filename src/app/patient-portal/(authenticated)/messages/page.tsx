import { notFound } from 'next/navigation'
import { requirePatientSessionOrRedirect } from '@/lib/patient-session'
import { getPatientPortalIdentity } from '@/lib/queries/patient-portal'
import { listPatientVisibleMessages, markReadByPatient } from '@/lib/queries/messages'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'
import { MessageThreadView } from '@/components/MessageThreadView'
import { MessageComposer } from '@/components/MessageComposer'

const SECTION = 'rounded-xl border border-primary/10 bg-card/80 p-5 shadow-sm backdrop-blur-sm'
const HEADING = 'mb-3 border-l-2 border-primary/40 pl-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground'

export default async function PatientPortalMessagesPage() {
  const session = await requirePatientSessionOrRedirect()
  const identity = await getPatientPortalIdentity(session.patientId)
  if (!identity) notFound()

  await logPatientPortalAction('viewed patient portal messages', session.patientId)

  const messages = await listPatientVisibleMessages(session.patientId)
  await markReadByPatient(session.patientId)

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-foreground">Messages</h1>
      <section className={`${SECTION} flex min-h-[420px] flex-col`}>
        <h2 className={HEADING}>Messages with your care team</h2>
        <div className="flex-1 overflow-y-auto pr-1">
          <MessageThreadView messages={messages} viewerRole="patient" />
        </div>
        <div className="mt-4 border-t border-border pt-4">
          <MessageComposer patientId={identity.id} viewerRole="patient" />
        </div>
      </section>
    </div>
  )
}
