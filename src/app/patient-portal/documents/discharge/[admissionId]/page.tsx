// Wave J (P1-20): the patient's own copy of a signed discharge summary, rendered by the same
// document as the staff print view (Wave F builder, patient copy: clinical content, masked
// ABHA, no MLC number). Another patient's admission, one not discharged or a summary the
// consultant has not signed is a 404. Every view is audited.
import { notFound } from 'next/navigation'
import { requirePortalDocumentSession } from '@/lib/patient-portal-documents'
import { parseId } from '@/lib/http'
import { getPortalDischargeSummary } from '@/lib/queries/patient-portal-records'
import { getPracticeIdentity } from '@/lib/queries/settings'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'
import { DischargeSummaryDocument } from '@/components/print/DischargeSummaryDocument'

export default async function PortalDischargeSummaryPage({ params }: { params: Promise<{ admissionId: string }> }) {
  const session = await requirePortalDocumentSession()
  const admissionId = parseId((await params).admissionId)
  if (admissionId === null) notFound()
  const now = new Date()
  const data = await getPortalDischargeSummary(session.patientId, admissionId, now)
  if (!data) notFound()
  const practice = await getPracticeIdentity()
  await logPatientPortalAction('viewed discharge summary via patient portal', session.patientId, `admission=${data.admission.id}`)

  return (
    <DischargeSummaryDocument
      data={data}
      now={now}
      backHref="/patient-portal/discharge-summaries"
      backLabel="Back to discharge summaries"
      hospitalName={practice.practiceName}
      hospitalSubline={practice.practiceSite}
      clinicalCopy={false}
      patientCopy
    />
  )
}
