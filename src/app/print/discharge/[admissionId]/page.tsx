import { notFound, redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { CLINICAL_ROLES, DISCHARGE_SUMMARY_PRINT_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { parseId } from '@/lib/http'
import { getDischargeSummaryData } from '@/lib/queries/discharge-summary'
import { getPracticeIdentity } from '@/lib/queries/settings'
import { DischargeSummaryDocument } from '@/components/print/DischargeSummaryDocument'

// Wave F P1-13: the printable A4 discharge summary (SP3 promised it; the data
// loader and builder had no consumer). Gated right after the session check,
// before any query, to DISCHARGE_SUMMARY_PRINT_ROLES. The builder decides the
// clinical content by role: clinical roles get the five Ds, coded diagnoses,
// stay medicines, labs, ABHA and the MLC number; the front desk gets the
// administrative copy. Only DISCHARGED admissions have a summary (404
// otherwise). Every render is an audited read. No national ID of any kind.

export default async function DischargeSummaryPrintPage({ params }: { params: Promise<{ admissionId: string }> }) {
  const session = await requireSessionOrRedirect()
  if (!DISCHARGE_SUMMARY_PRINT_ROLES.includes(session.role)) redirect('/')

  const { admissionId: raw } = await params
  const admissionId = parseId(raw)
  if (admissionId === null) notFound()

  const now = new Date()
  const data = await getDischargeSummaryData(admissionId, { now, viewerRole: session.role })
  if (!data) notFound()
  const practice = await getPracticeIdentity()
  await logAudit(session, 'printed discharge summary', data.patient.id, `admission=${data.admission.id}`)

  return (
    <DischargeSummaryDocument
      data={data}
      now={now}
      backHref={`/patients/${data.patient.id}`}
      backLabel="Back to patient"
      hospitalName={practice.practiceName}
      hospitalSubline={practice.practiceSite}
      clinicalCopy={CLINICAL_ROLES.includes(session.role)}
    />
  )
}
