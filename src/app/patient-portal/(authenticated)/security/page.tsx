import { requirePatientSessionOrRedirect } from '@/lib/patient-session'
import { getPatientMfaState } from '@/lib/queries/patient-portal'
import { PatientPortalSecurityPanel } from '@/components/PatientPortalSecurityPanel'

export default async function PatientPortalSecurityPage() {
  const session = await requirePatientSessionOrRedirect()
  const mfaState = await getPatientMfaState(session.patientId)

  return (
    <div className="max-w-lg">
      <PatientPortalSecurityPanel initialMfaEnabled={mfaState?.mfaEnabled ?? false} />
    </div>
  )
}
