import { redirect } from 'next/navigation'
import { requirePatientSessionOrRedirect } from '@/lib/patient-session'
import { getLatestPolicyDocument, hasAcceptedCurrentPolicies } from '@/lib/queries/policy-documents'
import { PatientConsentForm } from '@/components/PatientConsentForm'

// Deliberately outside the (authenticated) route group -- it must be
// reachable by a patient who has NOT yet accepted policies, so it can't
// itself sit behind the layout gate that gets patients here in the first
// place (that would be a redirect loop).
export default async function PatientConsentPage() {
  const session = await requirePatientSessionOrRedirect()

  // Already accepted (e.g. revisited this URL directly) -- send them on,
  // don't re-show the gate.
  if (await hasAcceptedCurrentPolicies(session.patientId)) redirect('/patient-portal')

  const [npp, tos] = await Promise.all([getLatestPolicyDocument('npp'), getLatestPolicyDocument('tos')])
  if (!npp || !tos) {
    // No policy documents seeded yet -- fail open here specifically, since
    // blocking every patient because ops hasn't seeded a policy row yet
    // would be worse than the gap itself. hasAcceptedCurrentPolicies()
    // still fails closed everywhere else.
    redirect('/patient-portal')
  }

  return <PatientConsentForm nppBody={npp.bodyMarkdown} tosBody={tos.bodyMarkdown} />
}
