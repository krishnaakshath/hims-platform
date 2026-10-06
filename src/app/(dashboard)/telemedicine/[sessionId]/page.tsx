import { notFound, redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getSessionById } from '@/lib/queries/telemedicine-sessions'
import { resolveDoctorQueueProvider } from '@/lib/doctor-queue-provider'
import { TelemedicineCallScreen } from '@/components/TelemedicineCallScreen'

export default async function TelemedicineCallPage({ params }: { params: Promise<{ sessionId: string }> }) {
  // Must be the first statement -- see src/lib/auth.ts's comment on
  // requireSessionOrRedirect for why this can't be skipped.
  const session = await requireSessionOrRedirect()
  // Role gate first: a denied role must never trigger a session lookup.
  if (!['admin', 'pi'].includes(session.role)) redirect('/')

  const { sessionId } = await params
  const id = Number(sessionId)
  if (!Number.isInteger(id)) notFound()

  const telemedicineSession = await getSessionById(id)
  if (!telemedicineSession) notFound()

  // Same role + ownership rule as resolveOwnedSession in
  // src/app/api/telemedicine/[sessionId]/signal/route.ts and .../end/route.ts:
  // spec §6 gates "provider joins a call" to admin/pi, and for pi
  // specifically, only the session's own provider. Without this, any staff
  // session (crc, frontdesk, or a pi who isn't this session's provider)
  // could reach this page, activate their camera, and have this page write
  // a false "joined telemedicine call as provider" audit entry for a call
  // that isn't theirs -- the underlying signal routes already 403 for them,
  // but the page itself should never render. Uses redirect('/'), matching
  // this codebase's page-level role-gate house style (see doctor/page.tsx's
  // `if (session.role !== 'pi') redirect('/')`), rather than the API
  // routes' 403 JSON response, which doesn't apply to a page component.
  if (session.role === 'pi') {
    const providerMatch = await resolveDoctorQueueProvider(session)
    if (!providerMatch || telemedicineSession.appointmentProviderId !== providerMatch.id) redirect('/')
  }

  await logAudit(session, 'joined telemedicine call as provider', telemedicineSession.appointmentPatientId)

  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold text-foreground">Video visit</h1>
      <TelemedicineCallScreen
        role="provider"
        pollUrl={`/api/telemedicine/${telemedicineSession.id}/signal`}
        initialStatus={telemedicineSession.status}
      />
    </div>
  )
}
