import { redirect } from 'next/navigation'
import { requirePatientSessionOrRedirect, type PatientSession } from '@/lib/patient-session'
import { hasAcceptedCurrentPolicies } from '@/lib/queries/policy-documents'

/**
 * Wave J (P1-20): the gate for the portal's full-page documents (invoice, receipt,
 * discharge summary), which render outside the (authenticated) portal layout so they print
 * cleanly. The same two checks that layout makes, in the same order and before any record
 * is read: a patient session (else the portal login), then the current NPP/ToS accepted
 * (else the consent page).
 */
export async function requirePortalDocumentSession(): Promise<PatientSession> {
  const session = await requirePatientSessionOrRedirect()
  if (!(await hasAcceptedCurrentPolicies(session.patientId))) redirect('/patient-portal/consent')
  return session
}
