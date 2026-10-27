import { requirePatientSessionOrRedirect } from '@/lib/patient-session'
import { getPatientMfaState } from '@/lib/queries/patient-portal'
import { PatientPortalSecurityPanel } from '@/components/PatientPortalSecurityPanel'

export default async function PatientPortalSecurityPage() {
  const session = await requirePatientSessionOrRedirect()
  const mfaState = await getPatientMfaState(session.patientId)

  return (
    <div className="max-w-lg space-y-3">
      {/* WS7 T7 (spec D13): offered and recommended, not required; OTP sign-in stays. */}
      <p className="text-sm text-muted-foreground">
        <span className="font-semibold text-foreground">Recommended.</span> Two-factor authentication adds a code from an authenticator app to your sign-in. It is optional: you can still sign in with a one-time code sent by SMS.
      </p>
      <PatientPortalSecurityPanel initialMfaEnabled={mfaState?.mfaEnabled ?? false} />
    </div>
  )
}
